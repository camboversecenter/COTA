// Indicative rates for showing a visitor the amount in their home currency
// (SPEC §5.1). Display only; the payment is always in USD or KHR. A deployment
// would take these from the central bank's daily reference rate.
export const HOME_CURRENCIES: Record<string, { perUsd: number; name: string }> = {
  USD: { perUsd: 1, name: "US dollar" },
  EUR: { perUsd: 0.92, name: "Euro" },
  GBP: { perUsd: 0.78, name: "Pound" },
  AUD: { perUsd: 1.52, name: "Australian dollar" },
  CNY: { perUsd: 7.2, name: "Yuan" },
  KRW: { perUsd: 1380, name: "Won" },
  JPY: { perUsd: 148, name: "Yen" },
  THB: { perUsd: 33, name: "Baht" },
  VND: { perUsd: 25400, name: "Dong" },
  INR: { perUsd: 84, name: "Rupee" },
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
