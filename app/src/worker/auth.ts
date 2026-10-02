// Two kinds of caller (SPEC §9.3):
//   - holders and merchants sign in with their wallet (EIP-191 challenge) and get
//     a session token "nps_…";
//   - staff (immigration, gates, operator) use API keys "npk_…", stored hashed.

import type { Context, MiddlewareHandler } from "hono";
import { verifyMessage, type Hex } from "viem";
import type { Env } from "./env";
import { addr, bad, now, randomHex, sha256Hex } from "./util";

export type StaffRole = "issuer" | "gate" | "operator";
export interface Staff {
  role: StaffRole;
  label: string;
  siteIds: string[];
}

export type AppEnv = { Bindings: Env; Variables: { address: `0x${string}`; staff: Staff } };

const SESSION_SECONDS = 24 * 3600;

function bearer(c: Context): string | null {
  const h = c.req.header("authorization");
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

export async function createChallenge(env: Env, address: string) {
  const a = addr(address);
  const challenge = [
    "Sign in to Nokor Pass",
    `Address: ${a}`,
    `Nonce: ${randomHex(16)}`,
    `Issued: ${new Date().toISOString()}`,
  ].join("\n");
  await env.DB.prepare(
    "INSERT INTO challenges (address, challenge, expires_at) VALUES (?1, ?2, ?3) ON CONFLICT(address) DO UPDATE SET challenge = ?2, expires_at = ?3",
  )
    .bind(a, challenge, now() + 300)
    .run();
  return challenge;
}

export async function verifyChallenge(env: Env, address: string, signature: string) {
  const a = addr(address);
  const row = await env.DB.prepare("SELECT challenge, expires_at FROM challenges WHERE address = ?1")
    .bind(a)
    .first<{ challenge: string; expires_at: number }>();
  if (!row || row.expires_at < now()) throw bad("Challenge expired. Try again.", 401);
  const ok = await verifyMessage({ address: a, message: row.challenge, signature: signature as Hex });
  if (!ok) throw bad("Signature does not match.", 401);
  await env.DB.prepare("DELETE FROM challenges WHERE address = ?1").bind(a).run();
  const token = `nps_${randomHex(32).slice(2)}`;
  const expiresAt = now() + SESSION_SECONDS;
  await env.DB.prepare("INSERT INTO sessions (token_hash, address, expires_at) VALUES (?1, ?2, ?3)")
    .bind(await sha256Hex(token), a, expiresAt)
    .run();
  return { token, expiresAt };
}

/** Requires a wallet session; sets c.var.address. */
export const requireHolder: MiddlewareHandler<AppEnv> = async (c, next) => {
  const t = bearer(c);
  if (!t?.startsWith("nps_")) throw bad("Sign in with your wallet.", 401);
  const row = await c.env.DB.prepare("SELECT address, expires_at FROM sessions WHERE token_hash = ?1")
    .bind(await sha256Hex(t))
    .first<{ address: `0x${string}`; expires_at: number }>();
  if (!row || row.expires_at < now()) throw bad("Session expired. Unlock your wallet again.", 401);
  c.set("address", row.address);
  await next();
};

/** Requires a wallet session for an address registered as a merchant. */
export const requireMerchant: MiddlewareHandler<AppEnv> = async (c, next) => {
  await requireHolder(c, async () => {
    const m = await c.env.DB.prepare("SELECT address FROM merchants WHERE address = ?1")
      .bind(c.var.address)
      .first();
    if (!m) throw bad("This wallet is not registered as a merchant.", 403);
    await next();
  });
};

export function requireStaff(...roles: StaffRole[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const t = bearer(c);
    if (!t?.startsWith("npk_")) throw bad("Staff API key required.", 401);
    const row = await c.env.DB.prepare("SELECT role, label, site_ids FROM api_keys WHERE key_hash = ?1")
      .bind(await sha256Hex(t))
      .first<{ role: StaffRole; label: string; site_ids: string | null }>();
    if (!row || !roles.includes(row.role)) throw bad("This key cannot do that.", 403);
    c.set("staff", { role: row.role, label: row.label, siteIds: row.site_ids ? JSON.parse(row.site_ids) : [] });
    await next();
  };
}

export async function createApiKey(env: Env, role: StaffRole, label: string, siteIds: string[] = []) {
  const key = `npk_${randomHex(24).slice(2)}`;
  await env.DB.prepare("INSERT INTO api_keys (key_hash, role, label, site_ids, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(await sha256Hex(key), role, label, siteIds.length ? JSON.stringify(siteIds) : null, now())
    .run();
  return key;
}
