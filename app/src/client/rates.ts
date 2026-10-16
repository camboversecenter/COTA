// Indicative rates for showing a visitor the amount in their home currency
// (SPEC §5.1). Display only; the payment is always in USD or KHR. A deployment
// would take these from the central bank's daily reference rate.
export const HOME_CURRENCIES: Record<string, { perUsd: number; name: string; symbol: string }> = {
  USD: { perUsd: 1, name: "US dollar", symbol: "$" },
  EUR: { perUsd: 0.92, name: "Euro", symbol: "€" },
  GBP: { perUsd: 0.78, name: "British pound", symbol: "£" },
  AUD: { perUsd: 1.52, name: "Australian dollar", symbol: "A$" },
  CNY: { perUsd: 7.2, name: "Chinese yuan", symbol: "¥" },
  KRW: { perUsd: 1380, name: "South Korean won", symbol: "₩" },
  JPY: { perUsd: 148, name: "Japanese yen", symbol: "¥" },
  THB: { perUsd: 33, name: "Thai baht", symbol: "฿" },
  VND: { perUsd: 25400, name: "Vietnamese dong", symbol: "₫" },
  INR: { perUsd: 84, name: "Indian rupee", symbol: "₹" },
};
export const KHR_PER_USD = 4000;

const KEY = "nokor.home";
export const homeCurrency = {
  get: () => {
    try {
      return localStorage.getItem(KEY) ?? "USD";
    } catch {
      return "USD";
    }
  },
  set: (c: string) => {
    try {
      localStorage.setItem(KEY, c);
    } catch {
      /* ignore */
    }
  },
};

export function inHome(minor: number, currency: "USD" | "KHR", home: string): string | null {
  const usd = currency === "USD" ? minor / 100 : minor / KHR_PER_USD;
  const r = HOME_CURRENCIES[home];
  if (!r) return null;
  const v = usd * r.perUsd;
  const digits = r.perUsd >= 100 ? 0 : 2;
  return `about ${v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits })} ${home}`;
}
