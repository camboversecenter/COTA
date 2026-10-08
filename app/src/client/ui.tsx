import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";


const ICONS = {
  pass: "M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4V7zM14 5v14",
  activity: "M7 3h10a1 1 0 0 1 1 1v17l-3-2-3 2-3-2-3 2V4a1 1 0 0 1 1-1zM9 8h6M9 12h6",
  sites: "M3 20h18M5 20V11M19 20V11M4 11l8-6 8 6M9 20v-5M15 20v-5M12 5V3",
  points: "M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.5 6.6 19.5l1.2-6L3.3 9.3l6.1-.7L12 3z",
  charge: "M4 7h16v10H4zM12 9.5v5M9.5 12h5M7 7V5M17 7V5",
  earnings: "M4 8a2 2 0 0 1 2-2h12v3M4 8v9a2 2 0 0 0 2 2h14V9H6a2 2 0 0 1-2-2zM16 14h2",
  lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  fingerprint: "M12 4a7 7 0 0 0-7 7v1M12 8a3 3 0 0 0-3 3c0 3 1 5 2 7M12 12v1c0 2 .5 4 1.5 6M19 11a7 7 0 0 0-2-4.9M16 12c0 3 .5 5 1.5 7",
  immigration: "M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM12 8a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8.5 17h7",
  gate: "M5 21V5a2 2 0 0 1 2-2h8l4 3v15M5 21h14M12 12h.01M9 7v14",
  operator: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4",
  dashboard: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  topup: "M12 8v8M8 12h8M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  merchants: "M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0A2.7 2.7 0 0 0 20 9M10 20v-5h4v5",
  fares: "M3 12V4h8l10 10-8 8L3 12zM7.5 8h.01",
  disputes: "M5 21V4M5 4h11l-1.5 4L16 12H5",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.6a7 7 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7 7 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z",
  keys: "M14 10a4 4 0 1 0-3.4 4L11 14.5 12 16h2v2h2v2h3v-3l-6-6.5M7.5 8h.01",
  chevron: "M9 6l6 6-6 6",
  check: "M5 12.5l4.5 4.5L19 7.5",
  alert: "M12 4l9 16H3L12 4zM12 10v4M12 17h.01",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8h.01",
  x: "M6 6l12 12M18 6L6 18",
  logout: "M10 4H5v16h5M15 8l4 4-4 4M19 12H9",
  share: "M12 3v12M8 7l4-4 4 4M5 12v8h14v-8",
  gift: "M4 10h16v10H4zM3 7h18v3H3zM12 7v13M12 7C10 7 8 6 8 4.5S10 3 12 7c2-4 4-3.5 4-2S14 7 12 7z",
  cash: "M3 6h18v12H3zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM6.5 9.5h.01M17.5 14.5h.01",
  plus: "M12 5v14M5 12h14",
  trash: "M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  wallet: "M3 7a2 2 0 0 1 2-2h13v4M3 7v11a2 2 0 0 0 2 2h16V9H5a2 2 0 0 1-2-2zM17 14.5h.01",
  refresh: "M20 11a8 8 0 0 0-14.5-3.5L4 9M4 4v5h5M4 13a8 8 0 0 0 14.5 3.5L20 15M20 20v-5h-5",
} as const;

export type IconName = keyof typeof ICONS;

/** Stroke icon on a 24px grid; inherits colour from the text around it. */
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

export function BrandMark() {
  return (
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
  );
}

export function Brand() {
  return (
    <a className="brand" href="#/">
      <BrandMark />
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

const NOTICE_ICON = { info: "info", warn: "alert", error: "alert", ok: "check" } as const;

export function Notice({
  kind = "info",
  onClose,
  children,
}: {
  kind?: "info" | "warn" | "error" | "ok";
  onClose?: () => void;
  children: ReactNode;
}) {
  if (!children) return null;
  return (
    <div className={`notice ${kind}`} role={kind === "error" ? "alert" : "status"}>
      <Icon name={NOTICE_ICON[kind]} size={18} />
      <div className="grow">{children}</div>
      {onClose && (
        <button className="notice-close" onClick={onClose} aria-label="Dismiss">
          <Icon name="x" size={16} />
        </button>
      )}
    </div>
  );
}

/** Ongoing status: a small spinner beside a live line of text. */
export function Pending({ children }: { children: ReactNode }) {
  return (
    <p className="pending" role="status">
      <span className="spinner" aria-hidden="true" />
      {children}
    </p>
  );
}

/** Empty state: a quiet icon, a short title, one line on what to do. */
export function Empty({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} size={30} />
      <p className="empty-title">{title}</p>
      {children && <p className="muted small">{children}</p>}
    </div>
  );
}

export function Field({ label, hint, invalid, children }: { label: string; hint?: string | null; invalid?: boolean; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small className={invalid ? "hint bad" : "hint"}>{hint}</small>}
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
