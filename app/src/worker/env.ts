import type { Relayer } from "./chain";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  RELAYER: DurableObjectNamespace<Relayer>;

  // vars (wrangler.jsonc)
  RPC_URL: string;
  CHAIN_ID: string;
  EXPLORER_URL?: string;
  /** JSON: { NokorPass, NokorRegistry, kUSD, kRIEL, NokorAccess, NokorPoint } */
  CONTRACTS: string;
  DISPUTE_WINDOW_SECONDS: string;

  // secrets (wrangler secret put / .dev.vars)
  /** Private key of the relayer that holds the operational roles. */
  OPERATOR_KEY: string;
  /** Issuer's HMAC secret for document hashes (SPEC §3.3). Never published. */
  ISSUER_SECRET: string;
  /** Lets an administrator create staff API keys. */
  BOOTSTRAP_SECRET: string;
}
