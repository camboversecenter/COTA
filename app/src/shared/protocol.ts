// Shared between the Worker and the client: currencies, EIP-712 types and the
// shapes of API responses.

export type Currency = "USD" | "KHR";

export const CURRENCIES: Record<Currency, { token: "kUSD" | "kRIEL"; decimals: number; symbol: string }> = {
  USD: { token: "kUSD", decimals: 2, symbol: "$" },
  KHR: { token: "kRIEL", decimals: 0, symbol: "៛" },
};

/** Format minor units for display, always with the ISO code (SPEC §5.1). */
export function formatAmount(minor: number | bigint, currency: Currency): string {
  const d = CURRENCIES[currency].decimals;
  const n = Number(minor) / 10 ** d;
  return `${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })} ${currency}`;
}

export function toMinor(major: string, currency: Currency): number {
  const d = CURRENCIES[currency].decimals;
  const v = Math.round(Number(major) * 10 ** d);
  if (!Number.isFinite(v) || v <= 0) throw new Error("Enter an amount above zero.");
  return v;
}

/** EIP-712 type definitions; must match the TYPEHASH strings in the contracts. */
export const TYPES = {
  Pay: [
    { name: "payer", type: "address" },
    { name: "merchant", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "ref", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Dispute: [
    { name: "payer", type: "address" },
    { name: "paymentId", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Redeem: [
    { name: "holder", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "payoutRef", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  CashOut: [
    { name: "merchant", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "bankRef", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Enter: [
    { name: "holder", type: "address" },
    { name: "productId", type: "uint256" },
    { name: "siteId", type: "bytes32" },
    { name: "gateRef", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Gift: [
    { name: "giver", type: "address" },
    { name: "earnedOnPass", type: "uint256" },
    { name: "amount", type: "uint256" },
    { name: "claimKey", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Claim: [
    { name: "giftId", type: "uint256" },
    { name: "recipient", type: "address" },
  ],
  RedeemPoints: [
    { name: "holder", type: "address" },
    { name: "earnedOnPass", type: "uint256" },
    { name: "amount", type: "uint256" },
    { name: "offerRef", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** EIP-712 domain names, as passed to each contract's EIP712 constructor. */
export const DOMAIN_NAMES = {
  kUSD: "Khmer USD",
  kRIEL: "Khmer Riel",
  NokorAccess: "Nokor Access",
  NokorPoint: "Nokor Point",
} as const;

export interface ChainConfig {
  chainId: number;
  explorer: string | null;
  contracts: {
    NokorPass: `0x${string}`;
    NokorRegistry: `0x${string}`;
    kUSD: `0x${string}`;
    kRIEL: `0x${string}`;
    NokorAccess: `0x${string}`;
    NokorPoint: `0x${string}`;
  };
  disputeWindowSeconds: number;
}

export interface PendingRequest {
  id: `0x${string}`;
  kind: "payment" | "purchase" | "entry";
  merchant: `0x${string}` | null;
  merchantName: string | null;
  merchantCategory: string | null;
  currency: Currency | null;
  amount: number | null;
  description: string | null;
  route: string | null;
  reference: number | null;
  flagged: boolean;
  productId: number | null;
  productName: string | null;
  siteId: string | null;
  gateLabel: string | null;
  expiresAt: number;
  nonce: string; // the holder's current nonce on the contract to sign against
}

/** Site ids are bytes32 strings on chain; these are the human names. */
export const SITES: Record<string, { name: string; province: string; angkor: boolean }> = {
  "angkor-wat": { name: "Angkor Wat", province: "Siem Reap", angkor: true },
  bayon: { name: "Bayon", province: "Siem Reap", angkor: true },
  "ta-prohm": { name: "Ta Prohm", province: "Siem Reap", angkor: true },
  "banteay-srei": { name: "Banteay Srei", province: "Siem Reap", angkor: true },
  "beng-mealea": { name: "Beng Mealea", province: "Siem Reap", angkor: false },
  "koh-ker": { name: "Koh Ker", province: "Preah Vihear", angkor: false },
  "preah-vihear": { name: "Preah Vihear", province: "Preah Vihear", angkor: false },
  "sambor-prei-kuk": { name: "Sambor Prei Kuk", province: "Kampong Thom", angkor: false },
  "banteay-chhmar": { name: "Banteay Chhmar", province: "Banteay Meanchey", angkor: false },
  "royal-palace": { name: "Royal Palace", province: "Phnom Penh", angkor: false },
};
