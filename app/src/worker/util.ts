import { HTTPException } from "hono/http-exception";
import { BaseError, ContractFunctionRevertedError, keccak256, toHex, stringToHex, type Hex } from "viem";

export const now = () => Math.floor(Date.now() / 1000);

export function randomHex(bytes: number): Hex {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return toHex(b);
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return toHex(new Uint8Array(d));
}

/** Keyed hash of a document number (SPEC §3.3). Normalised: uppercase, no spaces or dashes. */
export async function docHash(secret: string, documentNumber: string): Promise<Hex> {
  const norm = documentNumber.toUpperCase().replace(/[\s-]/g, "");
  if (norm.length < 5) throw bad("Document number looks too short.");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(norm));
  return toHex(new Uint8Array(mac));
}

/** A short-ref bytes32: keccak of a label. */
export const ref32 = (label: string): Hex => keccak256(stringToHex(label));

/** bytes32 for a short ASCII id such as a site id (left-aligned, zero-padded). */
export const ascii32 = (s: string): Hex => {
  if (s.length > 31) throw bad("Identifier too long.");
  return stringToHex(s, { size: 32 });
};

// Six characters, no 0/O/1/I/L to avoid misreading.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export function payCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(b, (x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join("");
}

export const bad = (message: string, status: 400 | 401 | 403 | 404 | 409 = 400) =>
  new HTTPException(status, { message });

export function chainErrorMessage(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName ?? revert.reason ?? "reverted";
      return `Contract rejected the transaction: ${name}`;
    }
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}

export function int(v: unknown, name: string): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  if (!Number.isSafeInteger(n) || n < 0) throw bad(`${name} must be a whole number.`);
  return n;
}

export function hex(v: unknown, name: string): Hex {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]*$/.test(v)) throw bad(`${name} must be hex.`);
  return v as Hex;
}

export function addr(v: unknown, name = "address"): `0x${string}` {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw bad(`${name} must be an address.`);
  return v.toLowerCase() as `0x${string}`;
}
