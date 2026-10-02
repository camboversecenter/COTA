import { Hono } from "hono";
import { requireMerchant, type AppEnv } from "./auth";
import { read, relay } from "./chain";
import { createPaymentRequest, currency, loadRequest, releaseDue, requireValidPass, resolvePayCode, tokenOf } from "./service";
import { bad, chainErrorMessage, hex, int, now } from "./util";

export const merchant = new Hono<AppEnv>();
merchant.use("*", requireMerchant);

/** The payee starts the payment (SPEC §5.1): the holder's code identifies the payer. */
merchant.post("/requests", async (c) => {
  const b = await c.req.json<{ code: string; amount: number; currency: string; description?: string; route?: string }>();
  const holder = await resolvePayCode(c.env, b.code);
  if (holder === c.var.address) throw bad("You cannot charge yourself.");
  await requireValidPass(c.env, holder);
  const req = await createPaymentRequest(c.env, {
    kind: "payment",
    holder,
    merchant: c.var.address,
    currency: currency(b.currency),
    amount: int(b.amount, "amount") || (() => { throw bad("Amount must be above zero."); })(),
    description: (b.description || "Payment").trim(),
    route: b.route?.trim() || null,
  });
  return c.json(req);
});

merchant.get("/requests/:id", async (c) => {
  const r = await loadRequest(c.env, c.req.param("id"));
  if (r.merchant !== c.var.address) throw bad("Not your request.", 403);
  const status = r.status === "pending" && (r.expires_at as number) < now() ? "expired" : r.status;
  return c.json({ status, error: r.error, paymentId: r.payment_id, txHash: r.tx_hash, flagged: !!r.flagged });
});

merchant.get("/summary", async (c) => {
  const a = c.var.address;
  await releaseDue(c.env, 5).catch(() => 0); // opportunistic; the cron also does this
  const m = await c.env.DB.prepare("SELECT * FROM merchants WHERE address = ?1").bind(a).first();
  const [usd, khr] = await Promise.all([read<bigint>(c.env, "kUSD", "balanceOf", [a]), read<bigint>(c.env, "kRIEL", "balanceOf", [a])]);
  const recent = await c.env.DB.prepare(
    "SELECT currency, payment_id, amount, status, release_at, created_at FROM payments WHERE merchant = ?1 ORDER BY created_at DESC LIMIT 30",
  )
    .bind(a)
    .all();
  const held = await c.env.DB.prepare(
    "SELECT currency, SUM(amount) AS amount FROM payments WHERE merchant = ?1 AND status IN ('Escrowed','Disputed') GROUP BY currency",
  )
    .bind(a)
    .all<{ currency: string; amount: number }>();
  return c.json({
    merchant: m,
    available: { USD: Number(usd), KHR: Number(khr) },
    held: Object.fromEntries(held.results.map((h) => [h.currency, h.amount])),
    recent: recent.results,
  });
});

/** Cash-out signed on the merchant's phone; the operator settles to the bank (SPEC §5.8). */
merchant.post("/cashout", async (c) => {
  const b = await c.req.json<{ currency: string; amount: number; bankRef: string; signature: string; deadline: number }>();
  const cur = currency(b.currency);
  try {
    const res = await relay(c.env, tokenOf(cur), "cashOutWithSig", [
      c.var.address,
      BigInt(int(b.amount, "amount")),
      hex(b.bankRef, "bankRef"),
      BigInt(int(b.deadline, "deadline")),
      hex(b.signature, "signature"),
    ]);
    await c.env.DB.prepare("INSERT INTO exits (kind, account, currency, amount, ref, at, tx_hash) VALUES ('cashout', ?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(c.var.address, cur, b.amount, b.bankRef, res.blockTimestamp, res.hash)
      .run();
    return c.json({ ok: true, txHash: res.hash });
  } catch (err) {
    throw bad(chainErrorMessage(err), 409);
  }
});
