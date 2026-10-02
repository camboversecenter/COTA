import { Hono } from "hono";
import type { Hex } from "viem";
import type { Currency } from "../shared/protocol";
import { createChallenge, requireHolder, verifyChallenge, type AppEnv } from "./auth";
import { findEvent, read, relay } from "./chain";
import {
  awardPoints,
  createPaymentRequest,
  currency,
  issuePayCode,
  loadRequest,
  pendingFor,
  pointsForPayment,
  recordPayment,
  requireValidPass,
  setting,
  settleRequest,
  tokenOf,
  validPassOf,
} from "./service";
import { addr, ascii32, bad, chainErrorMessage, hex, int, now, payCode, ref32 } from "./util";

export const holder = new Hono<AppEnv>();

// ------------------------------------------------------------------ vault (SPEC §8)

holder.get("/vault/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM vaults WHERE id = ?1").bind(c.req.param("id")).first<Record<string, string | null>>();
  if (!row) throw bad("No wallet with that id.", 404);
  return c.json({
    record: {
      pinSalt: row.pin_salt,
      pinEnvelope: row.pin_envelope,
      passkeyEnvelope: row.passkey_envelope,
      passkeyId: row.passkey_id,
      walletEnvelope: row.wallet_envelope,
    },
    argon2: JSON.parse(row.argon2_params as string),
    address: row.address,
  });
});

/** Create, or update before an address is bound. Every field in one statement (atomic). */
holder.put("/vault/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/.test(id)) throw bad("Bad wallet id.");
  const { record, argon2 } = await c.req.json<{ record: Record<string, string | null>; argon2: unknown }>();
  for (const k of ["pinSalt", "pinEnvelope", "walletEnvelope"]) {
    if (typeof record?.[k] !== "string" || !record[k]) throw bad(`Missing ${k}.`);
  }
  const existing = await c.env.DB.prepare("SELECT address FROM vaults WHERE id = ?1").bind(id).first<{ address: string | null }>();
  if (existing?.address) throw bad("This wallet is bound; change it from a signed-in session.", 403);
  await c.env.DB.prepare(
    `INSERT INTO vaults (id, pin_salt, pin_envelope, passkey_envelope, passkey_id, wallet_envelope, argon2_params, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
     ON CONFLICT(id) DO UPDATE SET pin_salt = ?2, pin_envelope = ?3, passkey_envelope = ?4, passkey_id = ?5,
       wallet_envelope = ?6, argon2_params = ?7, updated_at = ?8`,
  )
    .bind(id, record.pinSalt, record.pinEnvelope, record.passkeyEnvelope ?? null, record.passkeyId ?? null, record.walletEnvelope, JSON.stringify(argon2), now())
    .run();
  return c.json({ ok: true });
});

/** Bind a vault to the signed-in address, after which only that session may change it. */
holder.post("/vault/:id/bind", requireHolder, async (c) => {
  const r = await c.env.DB.prepare("UPDATE vaults SET address = ?2, updated_at = ?3 WHERE id = ?1 AND (address IS NULL OR address = ?2)")
    .bind(c.req.param("id"), c.var.address, now())
    .run();
  if (!r.meta.changes) throw bad("Wallet not found or bound to another address.", 409);
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ sign-in

holder.post("/auth/challenge", async (c) => {
  const { address } = await c.req.json<{ address: string }>();
  return c.json({ challenge: await createChallenge(c.env, address) });
});

holder.post("/auth/verify", async (c) => {
  const { address, signature } = await c.req.json<{ address: string; signature: string }>();
  return c.json(await verifyChallenge(c.env, address, signature));
});

// ------------------------------------------------------------------ me

holder.get("/me", requireHolder, async (c) => {
  const a = c.var.address;
  const env = c.env;
  const passId = Number(await read<bigint>(env, "NokorPass", "passOf", [a]));
  let pass = null;
  if (passId) {
    const info = await read<{
      category: number;
      issuedAt: bigint;
      validUntil: bigint;
      closedAt: bigint;
      revoked: boolean;
      previousPassId: bigint;
    }>(env, "NokorPass", "passInfo", [BigInt(passId)]);
    pass = {
      id: passId,
      valid: await read<boolean>(env, "NokorPass", "isValid", [BigInt(passId)]),
      category: info.category === 1 ? "Visitor" : "Resident",
      issuedAt: Number(info.issuedAt),
      validUntil: Number(info.validUntil),
      closedAt: Number(info.closedAt),
      revoked: info.revoked,
      returning: info.previousPassId > 0n,
    };
  }
  const [usd, khr] = await Promise.all([
    read<bigint>(env, "kUSD", "balanceOf", [a]),
    read<bigint>(env, "kRIEL", "balanceOf", [a]),
  ]);

  // Point balances, by the pass they were earned on (SPEC §7.2).
  const ids = await env.DB.prepare(
    `SELECT DISTINCT earned_on_pass FROM point_events WHERE account = ?1
     UNION SELECT DISTINCT earned_on_pass FROM gifts WHERE recipient = ?1 OR giver = ?1`,
  )
    .bind(a)
    .all<{ earned_on_pass: number }>();
  const points: { earnedOnPass: number; balance: number }[] = [];
  if (ids.results.length) {
    const bal = await read<bigint[]>(env, "NokorPoint", "balanceOfBatch", [
      ids.results.map(() => a),
      ids.results.map((r) => BigInt(r.earned_on_pass)),
    ]);
    ids.results.forEach((r, i) => {
      if (bal[i] > 0n) points.push({ earnedOnPass: r.earned_on_pass, balance: Number(bal[i]) });
    });
  }

  const payments = await env.DB.prepare(
    `SELECT p.*, m.name AS merchant_name FROM payments p LEFT JOIN merchants m ON m.address = p.merchant
      WHERE p.payer = ?1 ORDER BY p.created_at DESC LIMIT 30`,
  )
    .bind(a)
    .all();
  const grants = await env.DB.prepare(
    `SELECT g.product_id, g.expires_at, p.name, p.sites FROM grants g JOIN products p ON p.product_id = g.product_id
      WHERE g.holder = ?1 AND g.expires_at > ?2 ORDER BY g.expires_at DESC`,
  )
    .bind(a, now())
    .all();
  const visits = await env.DB.prepare("SELECT site_id, at FROM visits WHERE holder = ?1 ORDER BY at DESC LIMIT 20").bind(a).all();
  const merchant = await env.DB.prepare("SELECT name, category, province FROM merchants WHERE address = ?1").bind(a).first();

  return c.json({
    address: a,
    pass,
    balances: { USD: Number(usd), KHR: Number(khr) },
    points,
    payments: payments.results,
    access: grants.results.map((g) => ({ ...g, sites: JSON.parse(g.sites as string) })),
    visits: visits.results,
    merchant,
    disputeWindowSeconds: Number(c.env.DISPUTE_WINDOW_SECONDS),
  });
});

holder.post("/paycode", requireHolder, async (c) => c.json(await issuePayCode(c.env, c.var.address)));

holder.get("/nonce/:contract", requireHolder, async (c) => {
  const name = c.req.param("contract");
  if (!["kUSD", "kRIEL", "NokorAccess", "NokorPoint"].includes(name)) throw bad("Unknown contract.");
  const n = await read<bigint>(c.env, name as "kUSD", "nonces", [c.var.address]);
  return c.json({ nonce: n.toString() });
});

// ------------------------------------------------------------------ approvals

holder.get("/requests/pending", requireHolder, async (c) => c.json({ requests: await pendingFor(c.env, c.var.address) }));

holder.post("/requests/:id/decline", requireHolder, async (c) => {
  const res = await c.env.DB.prepare("UPDATE requests SET status = 'declined' WHERE id = ?1 AND holder = ?2 AND status = 'pending'")
    .bind(c.req.param("id"), c.var.address)
    .run();
  if (!res.meta.changes) throw bad("Nothing to decline.", 409);
  return c.json({ ok: true });
});

/** The holder approved on the phone; relay the signed intent (SPEC §5.1, §6.3). */
holder.post("/requests/:id/approve", requireHolder, async (c) => {
  const env = c.env;
  const r = await loadRequest(env, c.req.param("id"));
  if (r.holder !== c.var.address) throw bad("Not your request.", 403);
  const body = await c.req.json<{ signature: string; deadline: number }>();
  const signature = hex(body.signature, "signature");
  const deadline = BigInt(int(body.deadline, "deadline"));
  const id = r.id as Hex;

  // Claim the request atomically, so a double tap cannot submit it twice or
  // overwrite a successful result with the second attempt's failure.
  const claimed = await env.DB.prepare(
    "UPDATE requests SET status = 'submitting' WHERE id = ?1 AND status = 'pending' AND expires_at >= ?2",
  )
    .bind(id, now())
    .run();
  if (!claimed.meta.changes) {
    const cur = await loadRequest(env, id);
    if (cur.status === "pending") {
      await settleRequest(env, id, { status: "expired" });
      throw bad("This request expired. Ask for a new one.", 409);
    }
    throw bad(`This request is ${cur.status === "submitting" ? "already being approved" : cur.status}.`, 409);
  }

  // Step 1: the signed intent itself. Only a failure here marks the request failed.
  let res: Awaited<ReturnType<typeof relay>>;
  try {
    res =
      r.kind === "entry"
        ? await relay(env, "NokorAccess", "enterWithSig", [
            c.var.address,
            BigInt(r.product_id as number),
            ascii32(r.site_id as string),
            id,
            deadline,
            signature,
          ])
        : await relay(env, tokenOf(r.currency as Currency), "payWithSig", [
            c.var.address,
            r.merchant,
            BigInt(r.amount as number),
            id,
            deadline,
            signature,
          ]);
  } catch (err) {
    const msg = chainErrorMessage(err);
    await env.DB.prepare("UPDATE requests SET status = 'failed', error = ?2 WHERE id = ?1 AND status = 'submitting'").bind(id, msg).run();
    throw bad(msg, 409);
  }

  // Step 2: record and follow up. The payment or entry has happened, so the
  // request is approved whatever happens next; follow-up errors are reported.
  const notes: string[] = [];
  const attempt = async (label: string, f: () => Promise<unknown>) => {
    try {
      return await f();
    } catch (err) {
      console.error(label, err);
      notes.push(`${label}: ${chainErrorMessage(err)}`);
      return undefined;
    }
  };

  if (r.kind === "entry") {
    await settleRequest(env, id, { status: "approved", tx_hash: res.hash });
    await attempt("visit record", async () => {
      const v = findEvent(res, "NokorAccess", "Visit");
      await env.DB.prepare("INSERT INTO visits (pass_id, holder, site_id, product_id, at, tx_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
        .bind(Number(v.passId as bigint), c.var.address, r.site_id, r.product_id, res.blockTimestamp, res.hash)
        .run();
    });
    const pts = await attempt("points", async () => awardPoints(env, c.var.address, await setting(env, "points_per_entry"), `entry:${id}`));
    return c.json({ ok: true, txHash: res.hash, points: (pts as number | null) ?? 0, warnings: notes });
  }

  const cur = r.currency as Currency;
  const paymentId = (await attempt("payment record", () => recordPayment(env, cur, res))) as number | undefined;
  await settleRequest(env, id, { status: "approved", tx_hash: res.hash, payment_id: paymentId ?? null });

  let grant: { expiresAt: number } | null = null;
  if (r.kind === "purchase") {
    await attempt("site access", async () => {
      const g = await relay(env, "NokorAccess", "claim", [BigInt(r.product_id as number), env_addr(env, tokenOf(cur)), id]);
      const e = findEvent(g, "NokorAccess", "Granted");
      await env.DB.prepare("INSERT INTO grants (holder, product_id, pass_id, ref, expires_at, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
        .bind(c.var.address, r.product_id, Number(e.passId as bigint), id, Number(e.expiresAt as bigint), g.blockTimestamp)
        .run();
      grant = { expiresAt: Number(e.expiresAt as bigint) };
    });
  }
  const pts = await attempt("points", async () =>
    awardPoints(env, c.var.address, await pointsForPayment(env, cur, r.amount as number), `payment:${id}`),
  );
  if (notes.length) await settleRequest(env, id, { error: notes.join("; ") });
  return c.json({ ok: true, txHash: res.hash, paymentId, grant, points: (pts as number | null) ?? 0, warnings: notes });
});

function env_addr(env: AppEnv["Bindings"], name: "kUSD" | "kRIEL") {
  return (JSON.parse(env.CONTRACTS) as Record<string, string>)[name];
}

// ------------------------------------------------------------------ disputes (SPEC §5.4)

holder.post("/payments/:currency/:id/dispute", requireHolder, async (c) => {
  const cur = currency(c.req.param("currency"));
  const paymentId = int(c.req.param("id"), "payment id");
  const body = await c.req.json<{ signature: string; deadline: number }>();
  try {
    const res = await relay(c.env, tokenOf(cur), "disputeWithSig", [
      c.var.address,
      BigInt(paymentId),
      BigInt(int(body.deadline, "deadline")),
      hex(body.signature, "signature"),
    ]);
    await c.env.DB.prepare("UPDATE payments SET status = 'Disputed', disputed = 1 WHERE currency = ?1 AND payment_id = ?2")
      .bind(cur, paymentId)
      .run();
    return c.json({ ok: true, txHash: res.hash });
  } catch (err) {
    throw bad(chainErrorMessage(err), 409);
  }
});

// ------------------------------------------------------------------ site access (SPEC §6)

holder.post("/products/:id/buy", requireHolder, async (c) => {
  const productId = int(c.req.param("id"), "product id");
  const { currency: curRaw } = await c.req.json<{ currency: string }>();
  const cur = currency(curRaw);
  await requireValidPass(c.env, c.var.address);
  const p = await c.env.DB.prepare("SELECT * FROM products WHERE product_id = ?1").bind(productId).first<Record<string, unknown>>();
  if (!p) throw bad("No such product.", 404);
  const amount = (cur === "USD" ? p.price_usd : p.price_khr) as number;
  const req = await createPaymentRequest(c.env, {
    kind: "purchase",
    holder: c.var.address,
    merchant: p.payee as string,
    currency: cur,
    amount,
    description: p.name as string,
    productId,
  });
  return c.json(req);
});

// ------------------------------------------------------------------ Nokor Point (SPEC §7)

holder.post("/points/gift", requireHolder, async (c) => {
  const b = await c.req.json<{ earnedOnPass: number; amount: number; claimKey: string; signature: string; deadline: number }>();
  try {
    const res = await relay(c.env, "NokorPoint", "createGiftWithSig", [
      c.var.address,
      BigInt(int(b.earnedOnPass, "earnedOnPass")),
      BigInt(int(b.amount, "amount")),
      addr(b.claimKey, "claimKey"),
      BigInt(int(b.deadline, "deadline")),
      hex(b.signature, "signature"),
    ]);
    const e = findEvent(res, "NokorPoint", "GiftCreated");
    const giftId = Number(e.giftId as bigint);
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO gifts (gift_id, giver, earned_on_pass, amount, status, created_at) VALUES (?1, ?2, ?3, ?4, 'open', ?5)")
        .bind(giftId, c.var.address, b.earnedOnPass, b.amount, res.blockTimestamp),
      c.env.DB.prepare(
        "INSERT INTO point_events (kind, account, earned_on_pass, amount, gift_id, at, tx_hash) VALUES ('gift', ?1, ?2, ?3, ?4, ?5, ?6)",
      ).bind(c.var.address, b.earnedOnPass, b.amount, giftId, res.blockTimestamp, res.hash),
    ]);
    return c.json({ giftId, txHash: res.hash });
  } catch (err) {
    throw bad(chainErrorMessage(err), 409);
  }
});

holder.get("/gifts/:id", async (c) => {
  const g = await c.env.DB.prepare("SELECT gift_id, earned_on_pass, amount, status, created_at FROM gifts WHERE gift_id = ?1")
    .bind(int(c.req.param("id"), "gift id"))
    .first();
  if (!g) throw bad("Gift not found.", 404);
  return c.json(g);
});

holder.post("/points/claim", requireHolder, async (c) => {
  const b = await c.req.json<{ giftId: number; claimSignature: string }>();
  const giftId = int(b.giftId, "giftId");
  await requireValidPass(c.env, c.var.address);
  try {
    const res = await relay(c.env, "NokorPoint", "claimGift", [BigInt(giftId), c.var.address, hex(b.claimSignature, "claimSignature")]);
    const e = findEvent(res, "NokorPoint", "GiftClaimed");
    const g = await c.env.DB.prepare("SELECT earned_on_pass, amount FROM gifts WHERE gift_id = ?1")
      .bind(giftId)
      .first<{ earned_on_pass: number; amount: number }>();
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE gifts SET status = 'claimed', recipient = ?2 WHERE gift_id = ?1").bind(giftId, c.var.address),
      c.env.DB.prepare(
        "INSERT INTO point_events (kind, account, pass_id, earned_on_pass, amount, gift_id, at, tx_hash) VALUES ('claim', ?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      ).bind(c.var.address, Number(e.recipientPass as bigint), g?.earned_on_pass ?? 0, g?.amount ?? 0, giftId, res.blockTimestamp, res.hash),
    ]);
    return c.json({ ok: true, amount: g?.amount, txHash: res.hash });
  } catch (err) {
    throw bad(chainErrorMessage(err), 409);
  }
});

holder.post("/points/redeem", requireHolder, async (c) => {
  const b = await c.req.json<{ offerId: string; earnedOnPass: number; offerRef: string; signature: string; deadline: number }>();
  const offer = await c.env.DB.prepare("SELECT * FROM offers WHERE id = ?1").bind(b.offerId).first<{ points: number; title: string }>();
  if (!offer) throw bad("No such offer.", 404);
  try {
    const res = await relay(c.env, "NokorPoint", "redeemWithSig", [
      c.var.address,
      BigInt(int(b.earnedOnPass, "earnedOnPass")),
      BigInt(offer.points),
      hex(b.offerRef, "offerRef"),
      BigInt(int(b.deadline, "deadline")),
      hex(b.signature, "signature"),
    ]);
    const e = findEvent(res, "NokorPoint", "PointsRedeemed");
    const voucher = payCode() + payCode().slice(0, 2);
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO point_events (kind, account, pass_id, earned_on_pass, amount, return_trip, spread, ref, at, tx_hash)
         VALUES ('redeem', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      ).bind(
        c.var.address,
        Number(e.redeemerPass as bigint),
        b.earnedOnPass,
        offer.points,
        e.returning ? 1 : 0,
        e.spread ? 1 : 0,
        b.offerId,
        res.blockTimestamp,
        res.hash,
      ),
      c.env.DB.prepare("INSERT INTO vouchers (code, offer_id, holder, points, at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(
        voucher,
        b.offerId,
        c.var.address,
        offer.points,
        res.blockTimestamp,
      ),
    ]);
    return c.json({ voucher, offer: offer.title, returning: !!e.returning, spread: !!e.spread, txHash: res.hash });
  } catch (err) {
    throw bad(chainErrorMessage(err), 409);
  }
});

// ------------------------------------------------------------------ departure (SPEC §5.10)

holder.post("/redeem", requireHolder, async (c) => {
  const isMerchant = await c.env.DB.prepare("SELECT 1 FROM merchants WHERE address = ?1").bind(c.var.address).first();
  if (isMerchant) throw bad("Merchant balances are paid out with Cash out, within the daily limit.", 403);
  const b = await c.req.json<{ currency: string; amount: number; payoutRef: string; signature: string; deadline: number }>();
  const cur = currency(b.currency);
  try {
    const res = await relay(c.env, tokenOf(cur), "redeemWithSig", [
      c.var.address,
      BigInt(int(b.amount, "amount")),
      hex(b.payoutRef, "payoutRef"),
      BigInt(int(b.deadline, "deadline")),
      hex(b.signature, "signature"),
    ]);
    await c.env.DB.prepare("INSERT INTO exits (kind, account, currency, amount, ref, at, tx_hash) VALUES ('redeem', ?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(c.var.address, cur, b.amount, b.payoutRef, res.blockTimestamp, res.hash)
      .run();
    return c.json({ ok: true, txHash: res.hash });
  } catch (err) {
    throw bad(chainErrorMessage(err), 409);
  }
});

