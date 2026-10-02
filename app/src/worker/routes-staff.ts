import { Hono } from "hono";
import { SITES } from "../shared/protocol";
import { createApiKey, requireStaff, type AppEnv, type StaffRole } from "./auth";
import { findEvent, read, relay } from "./chain";
import {
  currency,
  loadRequest,
  releaseDue,
  requireValidPass,
  resolvePayCode,
  tokenOf,
  validPassOf,
} from "./service";
import { ascii32, bad, chainErrorMessage, docHash, int, now, ref32 } from "./util";

export const staff = new Hono<AppEnv>();

const wrap = async <T>(f: () => Promise<T>) => {
  try {
    return await f();
  } catch (err) {
    if (err && typeof err === "object" && "status" in err) throw err;
    throw bad(chainErrorMessage(err), 409);
  }
};

// ------------------------------------------------------------------ bootstrap

staff.post("/admin/keys", async (c) => {
  if (!c.env.BOOTSTRAP_SECRET || c.req.header("x-bootstrap") !== c.env.BOOTSTRAP_SECRET) throw bad("Forbidden.", 403);
  const b = await c.req.json<{ role: StaffRole; label: string; siteIds?: string[] }>();
  if (!["issuer", "gate", "operator"].includes(b.role)) throw bad("Unknown role.");
  return c.json({ key: await createApiKey(c.env, b.role, b.label, b.siteIds ?? []) });
});

staff.get("/staff/whoami", requireStaff("issuer", "gate", "operator"), (c) => c.json(c.var.staff));

// ------------------------------------------------------------------ immigration (SPEC §3)

staff.get("/issuer/resolve/:code", requireStaff("issuer", "operator"), async (c) => {
  const address = await resolvePayCode(c.env, c.req.param("code"));
  const passId = await validPassOf(c.env, address);
  return c.json({ address, passId });
});

staff.post("/issuer/passes", requireStaff("issuer"), async (c) => {
  const b = await c.req.json<{ code: string; category: "Visitor" | "Resident"; documentNumber: string; validDays?: number }>();
  const holder = await resolvePayCode(c.env, b.code);
  const category = b.category === "Resident" ? 2 : 1;
  const validUntil = category === 2 ? 0n : BigInt(now() + int(b.validDays ?? 30, "validDays") * 86400);
  const hash = await docHash(c.env.ISSUER_SECRET, b.documentNumber ?? "");
  return c.json(
    await wrap(async () => {
      const res = await relay(c.env, "NokorPass", "issue", [holder, category, hash, validUntil]);
      const e = findEvent(res, "NokorPass", "PassIssued");
      const passId = Number(e.passId as bigint);
      const previous = Number(e.previousPassId as bigint);
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO passes (pass_id, holder, category, previous_pass_id, issued_at, valid_until, tx_hash)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        ).bind(passId, holder, b.category === "Resident" ? "Resident" : "Visitor", previous, res.blockTimestamp, Number(validUntil), res.hash),
        ...(previous
          ? [c.env.DB.prepare("UPDATE passes SET closed_at = COALESCE(closed_at, ?2) WHERE pass_id = ?1").bind(previous, res.blockTimestamp)]
          : []),
      ]);
      return { passId, returning: previous > 0, previousPassId: previous, txHash: res.hash };
    }),
  );
});

staff.post("/issuer/close", requireStaff("issuer"), async (c) => {
  const { code } = await c.req.json<{ code: string }>();
  const holder = await resolvePayCode(c.env, code);
  const passId = await requireValidPass(c.env, holder);
  return c.json(
    await wrap(async () => {
      const res = await relay(c.env, "NokorPass", "close", [BigInt(passId)]);
      await c.env.DB.prepare("UPDATE passes SET closed_at = ?2 WHERE pass_id = ?1").bind(passId, res.blockTimestamp).run();
      return { passId, txHash: res.hash };
    }),
  );
});

// ------------------------------------------------------------------ gates (SPEC §6.3)

staff.post("/gate/requests", requireStaff("gate"), async (c) => {
  const b = await c.req.json<{ code: string; siteId: string }>();
  const st = c.var.staff;
  if (!SITES[b.siteId]) throw bad("Unknown site.");
  if (st.siteIds.length && !st.siteIds.includes(b.siteId)) throw bad("This gate is not set up for that site.", 403);
  const holder = await resolvePayCode(c.env, b.code);
  await requireValidPass(c.env, holder);

  // Find an entitlement that covers this site and still has entries.
  const grants = await c.env.DB.prepare(
    `SELECT g.product_id, p.sites FROM grants g JOIN products p ON p.product_id = g.product_id
      WHERE g.holder = ?1 AND g.expires_at > ?2 ORDER BY g.expires_at`,
  )
    .bind(holder, now())
    .all<{ product_id: number; sites: string }>();
  let productId: number | null = null;
  for (const g of grants.results) {
    if (!(JSON.parse(g.sites) as string[]).includes(b.siteId)) continue;
    const e = await read<{ expiresAt: bigint; entriesLeft: number }>(c.env, "NokorAccess", "entitlementOf", [holder, BigInt(g.product_id)]);
    if (e.entriesLeft > 0 && Number(e.expiresAt) > now()) {
      productId = g.product_id;
      break;
    }
  }
  if (!productId) throw bad(`No valid access for ${SITES[b.siteId].name}. The visitor can buy one in the app.`, 409);

  const id = ref32(`entry:${crypto.randomUUID()}`);
  await c.env.DB.prepare(
    `INSERT INTO requests (id, kind, holder, product_id, site_id, gate_label, status, created_at, expires_at)
     VALUES (?1, 'entry', ?2, ?3, ?4, ?5, 'pending', ?6, ?7)`,
  )
    .bind(id, holder, productId, b.siteId, st.label, now(), now() + 180)
    .run();
  return c.json({ id, productId });
});

staff.get("/gate/requests/:id", requireStaff("gate"), async (c) => {
  const r = await loadRequest(c.env, c.req.param("id"));
  if (r.kind !== "entry" || r.gate_label !== c.var.staff.label) throw bad("Not a request from this gate.", 403);
  const status = r.status === "pending" && (r.expires_at as number) < now() ? "expired" : r.status;
  return c.json({ status, error: r.error, txHash: r.tx_hash });
});

// ------------------------------------------------------------------ operator

staff.post("/operator/topup", requireStaff("operator"), async (c) => {
  const b = await c.req.json<{ code: string; currency: string; amount: number; method: string }>();
  const holder = await resolvePayCode(c.env, b.code);
  const cur = currency(b.currency);
  const amount = int(b.amount, "amount");
  return c.json(
    await wrap(async () => {
      const res = await relay(c.env, tokenOf(cur), "mint", [holder, BigInt(amount), ref32(`topup:${crypto.randomUUID()}`)]);
      await c.env.DB.prepare("INSERT INTO topups (holder, currency, amount, method, at, tx_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
        .bind(holder, cur, amount, (b.method || "cash").slice(0, 20), res.blockTimestamp, res.hash)
        .run();
      return { ok: true, holder, txHash: res.hash };
    }),
  );
});

staff.get("/operator/merchants", requireStaff("operator"), async (c) =>
  c.json((await c.env.DB.prepare("SELECT * FROM merchants ORDER BY created_at DESC").all()).results),
);

staff.post("/operator/merchants", requireStaff("operator"), async (c) => {
  const b = await c.req.json<{ code: string; name: string; category: string; province: string; riskClass: number }>();
  const address = await resolvePayCode(c.env, b.code);
  const rc = int(b.riskClass ?? 2, "riskClass");
  if (rc > 2) throw bad("Risk class is 0, 1 or 2.");
  if (!b.name?.trim()) throw bad("Merchant name is required.");
  return c.json(
    await wrap(async () => {
      const res = await relay(c.env, "NokorRegistry", "register", [address, ascii32(b.category), ascii32(b.province), rc]);
      await c.env.DB.prepare(
        "INSERT INTO merchants (address, name, category, province, risk_class, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      )
        .bind(address, b.name.trim(), b.category, b.province, rc, res.blockTimestamp)
        .run();
      return { address, txHash: res.hash };
    }),
  );
});

staff.post("/operator/products", requireStaff("operator"), async (c) => {
  const b = await c.req.json<{
    name: string;
    payee: string;
    priceUsd: number;
    priceKhr: number;
    validityDays: number;
    entries: number; // 0 = unlimited
    sites: string[];
    description?: string;
  }>();
  if (!b.sites?.length || b.sites.some((s) => !SITES[s])) throw bad("Choose known sites.");
  const payee = b.payee.toLowerCase();
  const isPayee = await c.env.DB.prepare("SELECT 1 FROM merchants WHERE address = ?1").bind(payee).first();
  if (!isPayee) throw bad("The payee must be a registered merchant (the site authority).");
  const entries = int(b.entries, "entries") || 0xffffffff;
  return c.json(
    await wrap(async () => {
      const res = await relay(c.env, "NokorAccess", "createProduct", [
        ascii32(b.name.slice(0, 31)),
        payee,
        BigInt(int(b.priceUsd, "priceUsd")),
        BigInt(int(b.priceKhr, "priceKhr")),
        BigInt(int(b.validityDays, "validityDays") * 86400),
        entries,
        b.sites.map(ascii32),
      ]);
      const productId = Number(findEvent(res, "NokorAccess", "ProductCreated").productId as bigint);
      await c.env.DB.prepare(
        `INSERT INTO products (product_id, name, payee, price_usd, price_khr, validity_seconds, entries, sites, description)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
        .bind(productId, b.name, payee, b.priceUsd, b.priceKhr, b.validityDays * 86400, entries, JSON.stringify(b.sites), b.description ?? null)
        .run();
      return { productId, txHash: res.hash };
    }),
  );
});

staff.post("/operator/fares", requireStaff("operator"), async (c) => {
  const b = await c.req.json<{ category: string; route: string; currency: string; amount: number }>();
  await c.env.DB.prepare(
    "INSERT INTO fares (category, route, currency, amount) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO UPDATE SET amount = ?4",
  )
    .bind(b.category, b.route.trim(), currency(b.currency), int(b.amount, "amount"))
    .run();
  return c.json({ ok: true });
});

staff.get("/operator/disputes", requireStaff("operator"), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT p.*, m.name AS merchant_name, r.description, r.route, r.reference, r.flagged
       FROM payments p LEFT JOIN merchants m ON m.address = p.merchant LEFT JOIN requests r ON r.id = p.ref
      WHERE p.status = 'Disputed' ORDER BY p.created_at`,
  ).all();
  return c.json(rows.results);
});

staff.post("/operator/resolve", requireStaff("operator"), async (c) => {
  const b = await c.req.json<{ currency: string; paymentId: number; refund: boolean }>();
  const cur = currency(b.currency);
  const id = int(b.paymentId, "paymentId");
  return c.json(
    await wrap(async () => {
      const res = await relay(c.env, tokenOf(cur), "resolve", [BigInt(id), !!b.refund]);
      await c.env.DB.prepare("UPDATE payments SET status = ?3 WHERE currency = ?1 AND payment_id = ?2")
        .bind(cur, id, b.refund ? "Refunded" : "Released")
        .run();
      // A refunded site-access purchase no longer pays for the access it bought (SPEC §6.2).
      let accessRevoked = false;
      if (b.refund) {
        const g = await c.env.DB.prepare(
          "SELECT g.holder, g.product_id, g.ref FROM grants g JOIN payments p ON p.ref = g.ref WHERE p.currency = ?1 AND p.payment_id = ?2",
        )
          .bind(cur, id)
          .first<{ holder: string; product_id: number; ref: string }>();
        if (g) {
          await relay(c.env, "NokorAccess", "revokeEntitlement", [g.holder, BigInt(g.product_id)]);
          await c.env.DB.prepare("DELETE FROM grants WHERE ref = ?1").bind(g.ref).run();
          accessRevoked = true;
        }
      }
      return { ok: true, txHash: res.hash, accessRevoked };
    }),
  );
});

staff.post("/operator/release", requireStaff("operator"), async (c) => c.json({ released: await releaseDue(c.env, 50) }));

staff.post("/operator/settings", requireStaff("operator"), async (c) => {
  const b = await c.req.json<Record<string, number>>();
  for (const k of ["points_per_usd", "points_per_entry", "khr_per_usd"]) {
    if (b[k] != null) {
      await c.env.DB.prepare("UPDATE settings SET value = ?2 WHERE key = ?1").bind(k, String(int(b[k], k))).run();
    }
  }
  return c.json({ ok: true });
});

staff.get("/operator/settings", requireStaff("operator"), async (c) => {
  const rows = await c.env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  return c.json(Object.fromEntries(rows.results.map((r) => [r.key, Number(r.value)])));
});
