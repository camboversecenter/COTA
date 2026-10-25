// Merchant side of the wallet (SPEC §5.1, §5.8). A merchant is an ordinary
// wallet whose address the operator registered. It charges by typing the
// holder's code; it never shows a QR for the payer to scan.

import { useEffect, useState } from "react";
import { keccak256, stringToHex } from "viem";
import { CURRENCIES, formatAmount, toMinor, type Currency } from "../shared/protocol";
import { api } from "./api";
import type { Me } from "./HolderTabs";
import { Empty, Field, fmtDate, fmtDuration, Icon, Notice, Pending, useAction, useNow, usePoll } from "./ui";
import { deadlineIn, useWallet } from "./wallet";

interface Fare {
  category: string;
  route: string;
  currency: Currency;
  amount: number;
}

type RequestStatus = { status: string; error: string | null; paymentId: number | null; txHash: string | null; flagged: boolean };

// ------------------------------------------------------------------ charge

export function ChargeTab({ merchant }: { merchant: NonNullable<Me["merchant"]> }) {
  const [code, setCode] = useState("");
  const [cur, setCur] = useState<Currency>("USD");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [route, setRoute] = useState("");
  const [fares, setFares] = useState<Fare[]>([]);
  const [sent, setSent] = useState<{ id: string; reference: number | null; flagged: boolean; at: number } | null>(null);
  const [status, setStatus] = useState<RequestStatus | null>(null);
  const { busy, error, run } = useAction();
  const now = useNow();

  const usesFares = merchant.category === "tuktuk" || merchant.category === "boat";
  useEffect(() => {
    if (!usesFares) return;
    api
      .get<Fare[]>("/fares")
      .then((all) => setFares(all.filter((f) => f.category === merchant.category)))
      .catch(() => undefined);
  }, [usesFares, merchant.category]);

  const routes = [...new Set(fares.map((f) => f.route))];
  const reference = fares.find((f) => f.route === route && f.currency === cur);
  const aboveReference = (() => {
    try {
      return !!reference && !!amount && toMinor(amount, cur) > reference.amount;
    } catch {
      return false;
    }
  })();

  const pending = sent && (!status || status.status === "pending" || status.status === "submitting");
  usePoll(
    () => {
      if (!sent) return;
      api
        .get<RequestStatus>(`/merchant/requests/${sent.id}`)
        .then(setStatus)
        .catch(() => undefined);
    },
    2000,
    !!pending,
  );

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const minor = toMinor(amount, cur);
      const res = await api.post<{ id: string; reference: number | null; flagged: boolean }>("/merchant/requests", {
        code: code.trim().toUpperCase(),
        amount: minor,
        currency: cur,
        description: description.trim() || undefined,
        route: route || undefined,
      });
      setStatus(null);
      setSent({ ...res, at: now });
    });
  };

  const reset = () => {
    setSent(null);
    setStatus(null);
    setCode("");
    setAmount("");
    setDescription("");
  };

  if (sent) {
    const st = status?.status === "submitting" ? "pending" : (status?.status ?? "pending");
    return (
      <div className="stack-lg">
        {st !== "pending" && (
          <span className={`result-icon ${st === "approved" ? "ok" : "bad"}`}>
            <Icon name={st === "approved" ? "check" : "x"} size={28} />
          </span>
        )}
        <h1>{st === "approved" ? "Paid" : st === "declined" ? "Declined" : st === "failed" || st === "expired" ? "Not paid" : "Waiting for the customer"}</h1>
        <div className="charge" aria-label={`${amount} ${cur}`}>
          <span className="figure">{formatAmount(toMinor(amount, cur), cur).split(" ")[0]}</span>
          <span className={`iso ${cur === "KHR" ? "khr" : ""}`}>{cur}</span>
        </div>
        {st === "pending" && <Pending>Waiting for approval · sent {fmtDuration(now - sent.at)} ago</Pending>}
        {st === "pending" ? (
          <Notice>The request is on the customer's phone. They see your registered name, the amount and the currency, then approve it.</Notice>
        ) : st === "approved" ? (
          <Notice kind="ok">
            The payment is held for the dispute window, then released to your earnings. Payment #{status?.paymentId}.
          </Notice>
        ) : st === "declined" ? (
          <Notice kind="warn">The customer declined. Nothing was paid.</Notice>
        ) : (
          <Notice kind="error">{status?.error ?? "The request expired before it was approved."}</Notice>
        )}
        {sent.flagged && sent.reference != null && (
          <Notice kind="warn">
            This is above the reference fare of {formatAmount(sent.reference, cur)} for {route}. The customer was told.
          </Notice>
        )}
        <button className={st === "pending" ? "btn secondary" : "btn"} onClick={reset}>
          <Icon name="plus" size={18} />
          {st === "pending" ? "Start a new charge" : "New charge"}
        </button>

      </div>
    );
  }

  return (
    <form className="stack-lg" onSubmit={send}>
      <div className="stack">
        <h1>Charge a customer</h1>
        <p className="muted">
          {merchant.name}. Ask for the six-character code on their phone. They approve the amount on their own screen.
        </p>
      </div>
      <Field label="Customer's code">
        <input
          className="mono code-input"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          maxLength={6}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          placeholder="K7P2QD"
        />
      </Field>
      <div className="segmented" role="group" aria-label="Currency">
        {(["USD", "KHR"] as Currency[]).map((c) => (
          <button type="button" key={c} aria-pressed={cur === c} onClick={() => setCur(c)}>
            {c === "USD" ? "US dollars (USD)" : "Riel (KHR)"}
          </button>
        ))}
      </div>
      {usesFares && routes.length > 0 && (
        <Field label="Route">
          <select
            value={route}
            onChange={(e) => {
              setRoute(e.target.value);
              const f = fares.find((x) => x.route === e.target.value && x.currency === cur);
              if (f && !amount) setAmount(String(f.amount / 10 ** CURRENCIES[cur].decimals));
            }}
          >
            <option value="">No set route</option>
            {routes.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label={`Amount in ${cur}`}>
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={cur === "USD" ? "5.00" : "20000"} />
      </Field>
      {reference && (
        <p className={aboveReference ? "hint warn" : "hint"}>
          {aboveReference
            ? `Above the reference fare of ${formatAmount(reference.amount, cur)}. The customer will see a warning.`
            : `Reference fare for this route: ${formatAmount(reference.amount, cur)}.`}
        </p>
      )}
      <Field label="What is it for (optional)">
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={80} />
      </Field>
      <Notice kind="error">{error}</Notice>
      <button className="btn" disabled={busy || code.trim().length < 6 || !amount}>
        <Icon name="charge" size={18} />
        {busy ? "Sending…" : "Send to customer's phone"}
      </button>
    </form>
  );
}

// ------------------------------------------------------------------ earnings

interface Summary {
  merchant: { name: string; category: string; province: string; risk_class: number } | null;
  available: Record<Currency, number>;
  held: Partial<Record<Currency, number>>;
  recent: { currency: Currency; payment_id: number; amount: number; status: string; release_at: number; created_at: number }[];
}

export function EarningsTab() {
  const w = useWallet();
  const [s, setS] = useState<Summary | null>(null);
  const { error, run } = useAction();
  const now = useNow(5000);
  const load = () => run(async () => setS(await api.get<Summary>("/merchant/summary")));
  usePoll(() => void load(), 15000);

  if (!s) return <Notice kind={error ? "error" : "info"}>{error ?? "Loading your earnings…"}</Notice>;
  return (
    <div className="stack-lg">
      <h1>Earnings</h1>
      <section className="stack">
        <h2 className="eyebrow">Ready to cash out</h2>
        <div className="balances">
          {(["USD", "KHR"] as Currency[]).map((c) => (
            <div className="balance" key={c}>
              <p className="muted small">{c === "USD" ? "US dollars" : "Riel"}</p>
              <p className="amount mono">{formatAmount(s.available[c], c)}</p>
              {!!s.held[c] && <p className="muted small">+ {formatAmount(s.held[c]!, c)} held</p>}
            </div>
          ))}
        </div>
      </section>
      <p className="muted small">
        Payments are held for the dispute window, plus a longer hold for new merchants. After that they are released here
        automatically.
      </p>

      <CashOut available={s.available} onDone={load} address={w.address} />

      <section className="stack">
        <h2>Recent payments</h2>
        {s.recent.length === 0 ? (
          <Empty icon="earnings" title="No payments yet">Charge a customer from the Charge tab.</Empty>
        ) : (
          <ul className="list panel">
            {s.recent.map((p) => (
              <li key={`${p.currency}-${p.payment_id}`} className="row">
                <div className="grow">
                  <p className="mono">{formatAmount(p.amount, p.currency)}</p>
                  <p className="muted small">
                    {fmtDate(p.created_at)}
                    {p.status === "Escrowed" && p.release_at > now ? `, released in ${fmtDuration(p.release_at - now)}` : ""}
                  </p>
                </div>
                <span className={`status ${p.status}`}>{p.status === "Escrowed" ? "Held" : p.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <Notice kind="error">{error}</Notice>
    </div>
  );
}

function CashOut({ available, onDone, address }: { available: Record<Currency, number>; onDone: () => void; address: string | null }) {
  const w = useWallet();
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState<Currency>("USD");
  const [amount, setAmount] = useState("");
  const [bank, setBank] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  if (!open)
    return (
      <button className="btn secondary" onClick={() => setOpen(true)} disabled={!available.USD && !available.KHR}>
        <Icon name="cash" size={18} />
        Cash out to my bank
      </button>
    );

  const over = (() => {
    try {
      return !!amount && toMinor(amount, cur) > available[cur];
    } catch {
      return false;
    }
  })();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const minor = toMinor(amount, cur);
      if (minor > available[cur]) throw new Error(`You have ${formatAmount(available[cur], cur)} ready to cash out.`);
      if (!bank.trim()) throw new Error("Enter the bank account to pay into.");
      const token = CURRENCIES[cur].token;
      const bankRef = keccak256(stringToHex(`bank:${bank.trim()}:${crypto.randomUUID()}`));
      const deadline = deadlineIn(300);
      const { nonce } = await api.get<{ nonce: string }>(`/nonce/${token}`);
      const signature = await w.sign(token, "CashOut", {
        merchant: address,
        amount: BigInt(minor),
        bankRef,
        nonce: BigInt(nonce),
        deadline: BigInt(deadline),
      });
      await api.post("/merchant/cashout", { currency: cur, amount: minor, bankRef, signature, deadline });
      setDone(`${formatAmount(minor, cur)} is on its way to ${bank.trim()}.`);
      setAmount("");
      onDone();
    });
  };

  return (
    <form className="panel stack" onSubmit={submit}>
      <h2>Cash out</h2>
      <div className="segmented" role="group" aria-label="Currency">
        {(["USD", "KHR"] as Currency[]).map((c) => (
          <button type="button" key={c} aria-pressed={cur === c} onClick={() => setCur(c)}>
            {c}
          </button>
        ))}
      </div>
      <Field
        label={`Amount in ${cur}`}
        hint={over ? `You have ${formatAmount(available[cur], cur)} ready to cash out.` : `Up to ${formatAmount(available[cur], cur)}.`}
        invalid={over}
      >
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={over} />
      </Field>
      <Field label="Bank account">
        <input value={bank} onChange={(e) => setBank(e.target.value)} placeholder="Bank name and account number" />
      </Field>
      <p className="muted small">Only a fingerprint of the account goes on chain. There is a daily limit, set by your merchant class.</p>
      <Notice kind="error">{error}</Notice>
      <Notice kind="ok">{done}</Notice>
      <button className="btn" disabled={busy || over || !amount || !bank.trim()}>
        {busy ? "Signing…" : "Sign and cash out"}
      </button>
    </form>
  );
}
