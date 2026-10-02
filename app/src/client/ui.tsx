import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export function Brand() {
  return (
    <a className="brand" href="#/">
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <rect width="64" height="64" rx="14" fill="#0e4a3f" />
        <circle cx="48" cy="16" r="10" fill="#c8416d" />
        <path
          d="M14 50h36M18 50V34m28 16V34M22 34l10-14 10 14H22zm10-14v-6"
          stroke="#f2f6f2"
          strokeWidth="3.5"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      Nokor Pass
    </a>
  );
}

export function TopBar({ right }: { right?: ReactNode }) {
  return (
    <header className="topbar">
      <Brand />
      {right}
    </header>
  );
}

export function Notice({ kind = "info", children }: { kind?: "info" | "warn" | "error" | "ok"; children: ReactNode }) {
  if (!children) return null;
  return (
    <div className={`notice ${kind}`} role={kind === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

/** Run an async action with busy and error state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(f: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await f();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}

/** Poll while mounted. */
export function usePoll(f: () => void, ms: number, active = true) {
  const ref = useRef(f);
  ref.current = f;
  useEffect(() => {
    if (!active) return;
    ref.current();
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [ms, active]);
}

export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export const fmtDate = (s: number) =>
  new Date(s * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export const fmtDuration = (s: number) => {
  if (s <= 0) return "now";
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
};
