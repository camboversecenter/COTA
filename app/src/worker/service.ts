// Operations shared by several routes: resolving pay codes, relaying payments,
// recording events, and the Nokor Point policy.

import type { Hex } from "viem";
import type { Currency, PendingRequest } from "../shared/protocol";
import { CURRENCIES } from "../shared/protocol";
import { findEvent, read, relay, type RelayResult } from "./chain";
import type { Env } from "./env";
import { bad, now, payCode, ref32 } from "./util";

export const tokenOf = (c: Currency) => CURRENCIES[c].token;

export function currency(v: unknown): Currency {
  if (v !== "USD" && v !== "KHR") throw bad("Currency must be USD or KHR.");
  return v;
}

// ------------------------------------------------------------------ pay codes

export async function issuePayCode(env: Env, address: string) {
  await env.DB.prepare("DELETE FROM pay_codes WHERE address = ?1 OR expires_at < ?2").bind(address, now()).run();
  for (let i = 0; i < 5; i++) {
    const code = payCode();
    const expiresAt = now() + 120;
    const r = await env.DB.prepare("INSERT OR IGNORE INTO pay_codes (code, address, expires_at) VALUES (?1, ?2, ?3)")
      .bind(code, address, expiresAt)
      .run();
    if (r.meta.changes) return { code, expiresAt };
  }
  throw new Error("Could not allocate a code.");
}

export async function resolvePayCode(env: Env, code: unknown): Promise<`0x${string}`> {
  if (typeof code !== "string") throw bad("Enter the code shown on the holder's phone.");
  const row = await env.DB.prepare("SELECT address, expires_at FROM pay_codes WHERE code = ?1")
    .bind(code.trim().toUpperCase())
    .first<{ address: `0x${string}`; expires_at: number }>();
  if (!row || row.expires_at < now()) throw bad("That code is not valid. Ask for a fresh one.", 404);
  return row.address;
}

// ------------------------------------------------------------------ holder state

export async function validPassOf(env: Env, holder: string): Promise<number> {
  return Number(await read<bigint>(env, "NokorPass", "validPassOf", [holder]));
}

export async function requireValidPass(env: Env, holder: string): Promise<number> {
  const id = await validPassOf(env, holder);
  if (!id) throw bad("This wallet has no valid Nokor Pass yet. It is issued at immigration on arrival.", 409);
  return id;
}

export async function setting(env: Env, key: string): Promise<number> {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key = ?1").bind(key).first<{ value: string }>();
  return Number(r?.value ?? 0);
}

// ------------------------------------------------------------------ requests

export async function pendingFor(env: Env, holder: string): Promise<PendingRequest[]> {
  await env.DB.prepare("UPDATE requests SET status = 'expired' WHERE status = 'pending' AND expires_at < ?1")
    .bind(now())
    .run();
  const rows = await env.DB.prepare(
    `SELECT r.*, m.name AS merchant_name, m.category AS merchant_category, p.name AS product_name
       FROM requests r
       LEFT JOIN merchants m ON m.address = r.merchant
       LEFT JOIN products p ON p.product_id = r.product_id
      WHERE r.holder = ?1 AND r.status = 'pending'
      ORDER BY r.created_at DESC`,
  )
    .bind(holder)
    .all<Record<string, unknown>>();

  const out: PendingRequest[] = [];
  for (const r of rows.results) {
    const kind = r.kind as PendingRequest["kind"];
    const contract = kind === "entry" ? "NokorAccess" : tokenOf(r.currency as Currency);
    const nonce = await read<bigint>(env, contract, "nonces", [holder]);
    out.push({
      id: r.id as Hex,
      kind,
      merchant: (r.merchant as `0x${string}`) ?? null,
      merchantName: (r.merchant_name as string) ?? null,
      merchantCategory: (r.merchant_category as string) ?? null,
      currency: (r.currency as Currency) ?? null,
      amount: (r.amount as number) ?? null,
      description: (r.description as string) ?? null,
      route: (r.route as string) ?? null,
      reference: (r.reference as number) ?? null,
      flagged: !!r.flagged,
      productId: (r.product_id as number) ?? null,
      productName: (r.product_name as string) ?? null,
      siteId: (r.site_id as string) ?? null,
      gateLabel: (r.gate_label as string) ?? null,
      expiresAt: r.expires_at as number,
      nonce: nonce.toString(),
    });
  }
  return out;
}

export async function createPaymentRequest(
  env: Env,
  o: {
    kind: "payment" | "purchase";
    holder: string;
    merchant: string;
    currency: Currency;
    amount: number;
    description: string;
    route?: string | null;
    productId?: number | null;
  },
) {
  let reference: number | null = null;
  if (o.route) {
    const m = await env.DB.prepare("SELECT category FROM merchants WHERE address = ?1")
      .bind(o.merchant)
      .first<{ category: string }>();
    const fare = await env.DB.prepare("SELECT amount FROM fares WHERE category = ?1 AND route = ?2 AND currency = ?3")
      .bind(m?.category ?? "", o.route, o.currency)
      .first<{ amount: number }>();
    reference = fare?.amount ?? null;
  }
  const id = ref32(`request:${crypto.randomUUID()}`);
  await env.DB.prepare(
    `INSERT INTO requests (id, kind, holder, merchant, currency, amount, description, route, reference, flagged,
                           product_id, status, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'pending', ?12, ?13)`,
  )
    .bind(
      id,
      o.kind,
      o.holder,
      o.merchant,
      o.currency,
      o.amount,
      o.description.slice(0, 120),
      o.route ?? null,
      reference,
      reference != null && o.amount > reference ? 1 : 0,
      o.productId ?? null,
      now(),
      now() + 300,
    )
    .run();
  return { id, reference, flagged: reference != null && o.amount > reference };
}

export async function loadRequest(env: Env, id: string) {
  const r = await env.DB.prepare("SELECT * FROM requests WHERE id = ?1").bind(id).first<Record<string, unknown>>();
  if (!r) throw bad("Request not found.", 404);
  return r;
}

export async function settleRequest(env: Env, id: string, patch: Record<string, unknown>) {
  const keys = Object.keys(patch);
  await env.DB.prepare(`UPDATE requests SET ${keys.map((k, i) => `${k} = ?${i + 2}`).join(", ")} WHERE id = ?1`)
    .bind(id, ...keys.map((k) => patch[k]))
    .run();
}

// ------------------------------------------------------------------ recording

export async function recordPayment(env: Env, cur: Currency, r: RelayResult) {
  const e = findEvent(r, tokenOf(cur), "PaymentEscrowed");
  const paymentId = Number(e.paymentId as bigint);
  await env.DB.prepare(
    `INSERT INTO payments (currency, payment_id, ref, payer, merchant, amount, status, release_at, created_at, tx_hash)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'Escrowed', ?7, ?8, ?9)`,
  )
    .bind(
      cur,
      paymentId,
      e.ref as string,
      (e.payer as string).toLowerCase(),
      (e.merchant as string).toLowerCase(),
      Number(e.amount as bigint),
      Number(e.releaseAt as bigint),
      r.blockTimestamp,
      r.hash,
    )
    .run();
  return paymentId;
}

/** Nokor Point policy: points per US dollar paid; riel counted at the set rate. */
export async function pointsForPayment(env: Env, cur: Currency, amount: number) {
  const perUsd = await setting(env, "points_per_usd");
  const usd = cur === "USD" ? amount / 100 : amount / (await setting(env, "khr_per_usd"));
  return Math.floor(usd * perUsd);
}

export async function awardPoints(env: Env, to: string, amount: number, reason: string) {
  if (amount <= 0) return null;
  const r = await relay(env, "NokorPoint", "award", [to, BigInt(amount), ref32(reason)]);
  const e = findEvent(r, "NokorPoint", "Awarded");
  await env.DB.prepare(
    `INSERT INTO point_events (kind, account, pass_id, earned_on_pass, amount, ref, at, tx_hash)
     VALUES ('award', ?1, ?2, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(to, Number(e.earnedOnPass as bigint), amount, reason, r.blockTimestamp, r.hash)
    .run();
  return amount;
}

/** Release every escrowed payment whose hold has passed. Anyone may call release. */
export async function releaseDue(env: Env, limit = 20) {
  const due = await env.DB.prepare(
    "SELECT currency, payment_id FROM payments WHERE status = 'Escrowed' AND release_at <= ?1 ORDER BY release_at LIMIT ?2",
  )
    .bind(now(), limit)
    .all<{ currency: Currency; payment_id: number }>();
  let released = 0;
  for (const p of due.results) {
    try {
      const r = await relay(env, tokenOf(p.currency), "release", [BigInt(p.payment_id)]);
      await env.DB.prepare("UPDATE payments SET status = 'Released' WHERE currency = ?1 AND payment_id = ?2")
        .bind(p.currency, p.payment_id)
        .run();
      void r;
      released++;
    } catch (err) {
      // A chain timestamp can lag the Worker clock by a few seconds; retry next run.
      console.warn("release failed", p, err);
    }
  }
  return released;
}
