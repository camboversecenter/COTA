// Staff consoles: immigration (issue and close passes), site gates, and the
// operator (top-ups, merchants, products, fares, disputes). Staff sign in with
// an API key; the chain transactions are relayed by the operator key (SPEC §11).

import { useEffect, useState, type ReactNode } from "react";
import { formatAmount, SITES, toMinor, type Currency } from "../shared/protocol";
import { staffApi, staffKey } from "./api";
import { Field, fmtDate, Notice, TopBar, useAction, usePoll } from "./ui";

type Role = "issuer" | "gate" | "operator";
type StaffRole = Role;
interface Staff {
  role: Role;
  label: string;
  siteIds: string[];
}

const roleName: Record<Role, string> = { issuer: "Immigration", gate: "Site gate", operator: "Operator" };

/** Wraps a console: asks for the staff key until one with the right role is entered. */
export function StaffGate({ role, children }: { role: Role; children: (s: Staff) => ReactNode }) {
  const [me, setMe] = useState<Staff | null>(null);
  const [key, setKey] = useState("");
  const { busy, error, run, setError } = useAction();

  const check = () =>
    run(async () => {
      const s = await staffApi.get<Staff>("/staff/whoami");
      if (s.role !== role && !(role === "issuer" && s.role === "operator")) {
        throw new Error(`This key is for ${roleName[s.role]}, not ${roleName[role]}.`);
      }
      setMe(s);
    });

  useEffect(() => {
    if (staffKey.get()) void check().then(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signOut = () => {
    staffKey.set(null);
    setMe(null);
    setError(null);
  };

  return (
    <div className="shell wide">
      <TopBar
        right={
          me ? (
            <button className="btn secondary inline" onClick={signOut}>
              Sign out
            </button>
          ) : undefined
        }
      />
      {me ? (
        <div className="stack-lg">
          <p className="muted small">
            {roleName[me.role]}, {me.label}
          </p>
          {children(me)}
        </div>
      ) : (
        <form
          className="stack-lg"
          onSubmit={(e) => {
            e.preventDefault();
            staffKey.set(key.trim());
            void check();
          }}
        >
          <div className="stack">
            <h1>{roleName[role]} console</h1>
            <p className="muted">Enter the staff key issued to this desk or device.</p>
          </div>
          <Field label="Staff key">
            <input className="mono" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" placeholder="npk_…" />
          </Field>
          <Notice kind="error">{error}</Notice>
          <button className="btn" disabled={busy || !key.trim()}>
            Sign in
          </button>
        </form>
      )}
    </div>
  );
}

function CodeInput({ value, onChange, label = "Holder's code" }: { value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <Field label={label}>
      <input
        className="mono"
        value={value}
        onChange={(e) => onChange(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
        maxLength={6}
        autoComplete="off"
        spellCheck={false}
        placeholder="K7P2QD"
      />
    </Field>
  );
}

// ------------------------------------------------------------------ immigration

export function Immigration() {
  return <StaffGate role="issuer">{() => <IssuerDesk />}</StaffGate>;
}

function IssuerDesk() {
  const [mode, setMode] = useState<"arrive" | "depart">("arrive");
  const [code, setCode] = useState("");
  const [category, setCategory] = useState<"Visitor" | "Resident">("Visitor");
  const [doc, setDoc] = useState("");
  const [days, setDays] = useState("30");
  const [result, setResult] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setResult(null);
    void run(async () => {
      if (mode === "arrive") {
        if (!doc.trim()) throw new Error("Enter the passport or ID number. Only a keyed hash of it is stored.");
        const r = await staffApi.post<{ passId: number; returning: boolean; previousPassId: number }>("/issuer/passes", {
          code,
          category,
          documentNumber: doc.trim().toUpperCase(),
          validDays: Number(days),
        });
        setResult(
          `Pass #${r.passId} issued.${
            r.returning ? ` Returning visitor: previous pass #${r.previousPassId} was closed and linked.` : " First visit."
          }`,
        );
      } else {
        const r = await staffApi.post<{ passId: number }>("/issuer/close", { code });
        setResult(`Pass #${r.passId} closed. The visitor can still convert their balance back and gift points.`);
      }
      setCode("");
      setDoc("");
    });
  };

  return (
    <form className="stack-lg" onSubmit={submit}>
      <div className="segmented" role="group" aria-label="Desk">
        <button type="button" aria-pressed={mode === "arrive"} onClick={() => setMode("arrive")}>
          Arrival: issue pass
        </button>
        <button type="button" aria-pressed={mode === "depart"} onClick={() => setMode("depart")}>
          Departure: close pass
        </button>
      </div>
      <p className="muted">
        {mode === "arrive"
          ? "After the usual document check, ask for the code on the visitor's Nokor Pass app. The pass goes to that wallet."
          : "Closing the pass ends this visit. The pass stays on the wallet as the record of the trip."}
      </p>
      <CodeInput value={code} onChange={setCode} />
      {mode === "arrive" && (
        <>
          <div className="segmented" role="group" aria-label="Category">
            {(["Visitor", "Resident"] as const).map((c) => (
              <button type="button" key={c} aria-pressed={category === c} onClick={() => setCategory(c)}>
                {c}
              </button>
            ))}
          </div>
          <Field label="Passport or ID number">
            <input className="mono" value={doc} onChange={(e) => setDoc(e.target.value)} autoComplete="off" />
          </Field>
          {category === "Visitor" && (
            <Field label="Valid for (days)">
              <input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
            </Field>
          )}
        </>
      )}
      <Notice kind="error">{error}</Notice>
      <Notice kind="ok">{result}</Notice>
      <button className="btn" disabled={busy || code.length !== 6}>
        {busy ? "Writing to the chain…" : mode === "arrive" ? "Issue pass" : "Close pass"}
      </button>
    </form>
  );
}

// ------------------------------------------------------------------ gate

export function Gate() {
  return <StaffGate role="gate">{(s) => <GateDesk staff={s} />}</StaffGate>;
}

function GateDesk({ staff }: { staff: Staff }) {
  const sites = staff.siteIds.length ? staff.siteIds : Object.keys(SITES);
  const [site, setSite] = useState(sites[0]);
  const [code, setCode] = useState("");
  const [req, setReq] = useState<string | null>(null);
  const [status, setStatus] = useState<{ status: string; error: string | null } | null>(null);
  const { busy, error, run } = useAction();

  usePoll(
    () => {
      if (!req) return;
      staffApi
        .get<{ status: string; error: string | null }>(`/gate/requests/${req}`)
        .then(setStatus)
        .catch(() => undefined);
    },
    1500,
    !!req && (!status || status.status === "pending" || status.status === "submitting"),
  );

  const start = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await staffApi.post<{ id: string }>("/gate/requests", { code, siteId: site });
      setStatus(null);
      setReq(r.id);
    });
  };

  const next = () => {
    setReq(null);
    setStatus(null);
    setCode("");
  };

  const st = status?.status === "submitting" ? "pending" : (status?.status ?? "pending");
  return (
    <div className="stack-lg">
      <Field label="This gate">
        <select value={site} onChange={(e) => setSite(e.target.value)} disabled={!!req}>
          {sites.map((s) => (
            <option key={s} value={s}>
              {SITES[s]?.name ?? s}
            </option>
          ))}
        </select>
      </Field>
      {req ? (
        <section className={`panel stack gate-result ${st}`} aria-live="polite">
          <p className="big">{st === "approved" ? "Let them in" : st === "pending" ? "Waiting for the visitor…" : "Do not admit"}</p>
          <p className="muted">
            {st === "approved"
              ? "Entry is recorded on chain."
              : st === "pending"
                ? "The visitor approves the entry on their phone."
                : (status?.error ?? `The request was ${st}.`)}
          </p>
          <button className="btn" onClick={next}>
            Next visitor
          </button>
        </section>
      ) : (
        <form className="stack-lg" onSubmit={start}>
          <CodeInput value={code} onChange={setCode} label="Visitor's code" />
          <Notice kind="error">{error}</Notice>
          <button className="btn" disabled={busy || code.length !== 6}>
            Check access
          </button>
        </form>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ operator

export function Operator() {
  return <StaffGate role="operator">{() => <OperatorDesk />}</StaffGate>;
}

type OpTab = "topup" | "merchants" | "products" | "fares" | "disputes" | "settings" | "keys";

function OperatorDesk() {
  const [tab, setTab] = useState<OpTab>("topup");
  const tabs: [OpTab, string][] = [
    ["topup", "Top up"],
    ["merchants", "Merchants"],
    ["products", "Site access"],
    ["fares", "Fares"],
    ["disputes", "Disputes"],
    ["settings", "Settings"],
    ["keys", "Staff keys"],
  ];
  return (
    <div className="stack-lg">
      <nav className="segmented wrap" aria-label="Operator">
        {tabs.map(([id, label]) => (
          <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>
      {tab === "topup" && <TopUp />}
      {tab === "merchants" && <Merchants />}
      {tab === "products" && <Products />}
      {tab === "fares" && <Fares />}
      {tab === "disputes" && <Disputes />}
      {tab === "settings" && <Settings />}
      {tab === "keys" && <StaffKeys />}
    </div>
  );
}

function CurrencyPick({ value, onChange }: { value: Currency; onChange: (c: Currency) => void }) {
  return (
    <div className="segmented" role="group" aria-label="Currency">
      {(["USD", "KHR"] as Currency[]).map((c) => (
        <button type="button" key={c} aria-pressed={value === c} onClick={() => onChange(c)}>
          {c}
        </button>
      ))}
    </div>
  );
}

function TopUp() {
  const [code, setCode] = useState("");
  const [cur, setCur] = useState<Currency>("USD");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("cash");
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  return (
    <form
      className="stack-lg"
      onSubmit={(e) => {
        e.preventDefault();
        setDone(null);
        void run(async () => {
          const minor = toMinor(amount, cur);
          await staffApi.post("/operator/topup", { code, currency: cur, amount: minor, method });
          setDone(`${formatAmount(minor, cur)} added to the wallet.`);
          setCode("");
          setAmount("");
        });
      }}
    >
      <p className="muted">Take the payment (cash, card or bank), then credit the same amount to the holder's wallet.</p>
      <CodeInput value={code} onChange={setCode} />
      <CurrencyPick value={cur} onChange={setCur} />
      <Field label={`Amount in ${cur}`}>
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Field label="Paid by">
        <select value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="cash">Cash</option>
          <option value="card">Card</option>
          <option value="bank">Bank transfer</option>
        </select>
      </Field>
      <Notice kind="error">{error}</Notice>
      <Notice kind="ok">{done}</Notice>
      <button className="btn" disabled={busy || code.length !== 6 || !amount}>
        {busy ? "Minting…" : "Top up"}
      </button>
    </form>
  );
}

const CATEGORIES = ["tuktuk", "boat", "restaurant", "hotel", "shop", "guide", "site"];
const RISK = ["Established", "Standard", "New"];

interface MerchantRow {
  address: string;
  name: string;
  category: string;
  province: string;
  risk_class: number;
  created_at: number;
}

function Merchants() {
  const [list, setList] = useState<MerchantRow[]>([]);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("tuktuk");
  const [province, setProvince] = useState("Siem Reap");
  const [risk, setRisk] = useState(2);
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const load = () => staffApi.get<MerchantRow[]>("/operator/merchants").then(setList).catch(() => undefined);
  useEffect(() => void load(), []);

  return (
    <div className="stack-lg">
      <form
        className="panel stack"
        onSubmit={(e) => {
          e.preventDefault();
          setDone(null);
          void run(async () => {
            const r = await staffApi.post<{ address: string }>("/operator/merchants", { code, name, category, province, riskClass: risk });
            setDone(`${name} registered as ${r.address}.`);
            setCode("");
            setName("");
            void load();
          });
        }}
      >
        <h2>Register a merchant</h2>
        <p className="muted small">The merchant installs the app, creates a wallet and shows their code. Their wallet becomes the payee.</p>
        <CodeInput value={code} onChange={setCode} label="Merchant's code" />
        <Field label="Registered name (shown to payers)">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Category">
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="Province">
          <input value={province} onChange={(e) => setProvince(e.target.value)} />
        </Field>
        <Field label="Risk class (sets the hold and the daily cash-out limit)">
          <select value={risk} onChange={(e) => setRisk(Number(e.target.value))}>
            {RISK.map((r, i) => (
              <option key={r} value={i}>
                {r}
              </option>
            ))}
          </select>
        </Field>
        <Notice kind="error">{error}</Notice>
        <Notice kind="ok">{done}</Notice>
        <button className="btn" disabled={busy || code.length !== 6 || !name.trim()}>
          {busy ? "Registering…" : "Register merchant"}
        </button>
      </form>
      <section className="stack">
        <h2>Registered merchants</h2>
        {list.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <ul className="list">
            {list.map((m) => (
              <li key={m.address}>
                <p>
                  <strong>{m.name}</strong> <span className="muted small">{m.category}, {m.province}, {RISK[m.risk_class]}</span>
                </p>
                <p className="muted small mono break">{m.address}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

interface ProductRow {
  product_id: number;
  name: string;
  payee_name: string | null;
  price_usd: number;
  price_khr: number;
  validity_seconds: number;
  entries: number;
  sites: string[];
}

function Products() {
  const [list, setList] = useState<ProductRow[]>([]);
  const [merchants, setMerchants] = useState<MerchantRow[]>([]);
  const [name, setName] = useState("");
  const [payee, setPayee] = useState("");
  const [usd, setUsd] = useState("");
  const [khr, setKhr] = useState("");
  const [days, setDays] = useState("1");
  const [entries, setEntries] = useState("0");
  const [sites, setSites] = useState<string[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const load = () => {
    void fetch("/api/products").then((r) => r.json()).then(setList).catch(() => undefined);
    void staffApi
      .get<MerchantRow[]>("/operator/merchants")
      .then((m) => {
        const sitesOnly = m.filter((x) => x.category === "site");
        setMerchants(sitesOnly);
        setPayee((p) => p || sitesOnly[0]?.address || "");
      })
      .catch(() => undefined);
  };
  useEffect(load, []);

  return (
    <div className="stack-lg">
      <form
        className="panel stack"
        onSubmit={(e) => {
          e.preventDefault();
          setDone(null);
          void run(async () => {
            if (!sites.length) throw new Error("Choose at least one site.");
            const r = await staffApi.post<{ productId: number }>("/operator/products", {
              name: name.trim(),
              payee,
              priceUsd: toMinor(usd, "USD"),
              priceKhr: toMinor(khr, "KHR"),
              validityDays: Number(days),
              entries: Number(entries),
              sites,
            });
            setDone(`Product #${r.productId} created.`);
            load();
          });
        }}
      >
        <h2>New site access product</h2>
        {merchants.length === 0 && <Notice kind="warn">Register the site authority as a merchant with category "site" first.</Notice>}
        <Field label="Name (up to 31 characters)">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={31} placeholder="Angkor 1-day pass" />
        </Field>
        <Field label="Paid to">
          <select value={payee} onChange={(e) => setPayee(e.target.value)}>
            {merchants.map((m) => (
              <option key={m.address} value={m.address}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="row">
          <Field label="Price in USD">
            <input inputMode="decimal" value={usd} onChange={(e) => setUsd(e.target.value)} />
          </Field>
          <Field label="Price in KHR">
            <input inputMode="numeric" value={khr} onChange={(e) => setKhr(e.target.value)} />
          </Field>
        </div>
        <div className="row">
          <Field label="Valid for (days)">
            <input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
          <Field label="Entries (0 for unlimited)">
            <input inputMode="numeric" value={entries} onChange={(e) => setEntries(e.target.value)} />
          </Field>
        </div>
        <fieldset className="stack">
          <legend className="small muted">Sites covered</legend>
          {Object.entries(SITES).map(([id, s]) => (
            <label key={id} className="row small">
              <input
                type="checkbox"
                style={{ width: "auto" }}
                checked={sites.includes(id)}
                onChange={(e) => setSites((v) => (e.target.checked ? [...v, id] : v.filter((x) => x !== id)))}
              />
              <span>
                {s.name} <span className="muted">({s.province})</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Notice kind="error">{error}</Notice>
        <Notice kind="ok">{done}</Notice>
        <button className="btn" disabled={busy || !name.trim() || !payee}>
          {busy ? "Creating…" : "Create product"}
        </button>
      </form>
      <section className="stack">
        <h2>Products</h2>
        <ul className="list">
          {list.map((p) => (
            <li key={p.product_id}>
              <p>
                <strong>{p.name}</strong> <span className="muted small">#{p.product_id}, {p.payee_name}</span>
              </p>
              <p className="muted small">
                {formatAmount(p.price_usd, "USD")} or {formatAmount(p.price_khr, "KHR")}, {Math.round(p.validity_seconds / 86400)} days,{" "}
                {p.entries >= 0xffffffff ? "unlimited entries" : `${p.entries} entries`}, {p.sites.map((s) => SITES[s]?.name ?? s).join(", ")}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Fares() {
  const [list, setList] = useState<{ category: string; route: string; currency: Currency; amount: number }[]>([]);
  const [category, setCategory] = useState("tuktuk");
  const [route, setRoute] = useState("");
  const [cur, setCur] = useState<Currency>("USD");
  const [amount, setAmount] = useState("");
  const { busy, error, run } = useAction();
  const load = () => void fetch("/api/fares").then((r) => r.json()).then(setList).catch(() => undefined);
  useEffect(load, []);
  return (
    <div className="stack-lg">
      <form
        className="panel stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await staffApi.post("/operator/fares", { category, route, currency: cur, amount: toMinor(amount, cur) });
            setRoute("");
            setAmount("");
            load();
          });
        }}
      >
        <h2>Reference fares</h2>
        <p className="muted small">Payers see a warning when a driver asks more than the reference fare for the route.</p>
        <Field label="Category">
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="tuktuk">Tuk-tuk</option>
            <option value="boat">Boat</option>
          </select>
        </Field>
        <Field label="Route">
          <input value={route} onChange={(e) => setRoute(e.target.value)} placeholder="Siem Reap town to Angkor Wat" />
        </Field>
        <CurrencyPick value={cur} onChange={setCur} />
        <Field label={`Fare in ${cur}`}>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Notice kind="error">{error}</Notice>
        <button className="btn" disabled={busy || !route.trim() || !amount}>
          Save fare
        </button>
      </form>
      <ul className="list">
        {list.map((f) => (
          <li key={`${f.category}-${f.route}-${f.currency}`} className="row">
            <span className="grow">
              {f.route} <span className="muted small">({f.category})</span>
            </span>
            <span className="mono">{formatAmount(f.amount, f.currency)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface DisputeRow {
  currency: Currency;
  payment_id: number;
  amount: number;
  merchant_name: string | null;
  description: string | null;
  route: string | null;
  reference: number | null;
  flagged: number | null;
  created_at: number;
}

function Disputes() {
  const [list, setList] = useState<DisputeRow[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const load = () => void staffApi.get<DisputeRow[]>("/operator/disputes").then(setList).catch(() => undefined);
  useEffect(load, []);
  const resolve = (d: DisputeRow, refund: boolean) =>
    run(async () => {
      const r = await staffApi.post<{ accessRevoked: boolean }>("/operator/resolve", { currency: d.currency, paymentId: d.payment_id, refund });
      setMsg(
        `${formatAmount(d.amount, d.currency)} ${refund ? "refunded to the payer" : "released to the merchant"}.${r.accessRevoked ? " The site access it bought was cancelled." : ""}`,
      );
      load();
    });
  const release = () =>
    run(async () => {
      const r = await staffApi.post<{ released: number }>("/operator/release");
      setMsg(`${r.released} held payments released.`);
    });

  return (
    <div className="stack-lg">
      <Notice kind="error">{error}</Notice>
      <Notice kind="ok">{msg}</Notice>
      {list.length === 0 ? (
        <p className="muted">No open disputes.</p>
      ) : (
        <ul className="list">
          {list.map((d) => (
            <li key={`${d.currency}-${d.payment_id}`} className="stack">
              <p>
                <strong>{formatAmount(d.amount, d.currency)}</strong> to {d.merchant_name ?? "unknown merchant"}
                <span className="muted small"> on {fmtDate(d.created_at)}</span>
              </p>
              <p className="muted small">
                {d.description}
                {d.route ? `, ${d.route}` : ""}
                {d.reference != null ? `. Reference fare ${formatAmount(d.reference, d.currency)}${d.flagged ? ", charged above it" : ""}.` : ""}
              </p>
              <div className="btn-row">
                <button className="btn secondary" onClick={() => void resolve(d, false)} disabled={busy}>
                  Release to merchant
                </button>
                <button className="btn" onClick={() => void resolve(d, true)} disabled={busy}>
                  Refund payer
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <button className="btn secondary" onClick={() => void release()} disabled={busy}>
        Release all payments whose hold has passed
      </button>
    </div>
  );
}

function StaffKeys() {
  const [bootstrap, setBootstrap] = useState("");
  const [role, setRole] = useState<StaffRole>("issuer");
  const [label, setLabel] = useState("");
  const [siteIds, setSiteIds] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setCreated(null);
    void run(async () => {
      const body: Record<string, unknown> = { role, label: label.trim() };
      if (role === "gate" && siteIds.trim()) {
        body.siteIds = siteIds.split(",").map((s) => s.trim()).filter(Boolean);
      }
      const res = await fetch("/api/admin/keys", {
        method: "POST",
        headers: { "content-type": "application/json", "x-bootstrap": bootstrap },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(((await res.json()) as { error: string }).error ?? `HTTP ${res.status}`);
      const { key } = (await res.json()) as { key: string };
      setCreated(key);
      setLabel("");
    });
  };

  return (
    <form className="panel stack" onSubmit={submit}>
      <h2>Create staff key</h2>
      <p className="muted small">Requires the bootstrap secret set in Cloudflare. Each key is shown once — copy it before leaving this page.</p>
      <Field label="Bootstrap secret">
        <input type="password" value={bootstrap} onChange={(e) => setBootstrap(e.target.value)} autoComplete="off" />
      </Field>
      <Field label="Role">
        <select value={role} onChange={(e) => setRole(e.target.value as StaffRole)}>
          <option value="issuer">Issuer — immigration desk</option>
          <option value="gate">Gate — site checkpoint</option>
          <option value="operator">Operator — system admin</option>
        </select>
      </Field>
      <Field label="Label (desk or device name)">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Arrivals desk 1" />
      </Field>
      {role === "gate" && (
        <Field label="Site IDs (comma-separated, leave blank for all)">
          <input value={siteIds} onChange={(e) => setSiteIds(e.target.value)} placeholder="angkor-wat, bayon" />
        </Field>
      )}
      <Notice kind="error">{error}</Notice>
      {created && (
        <div className="panel stack">
          <p className="small muted">Key created — copy it now, it will not be shown again:</p>
          <p className="mono break">{created}</p>
        </div>
      )}
      <button className="btn" disabled={busy || !bootstrap || !label.trim()}>
        {busy ? "Creating…" : "Create key"}
      </button>
    </form>
  );
}

function Settings() {
  const [ppu, setPpu] = useState("10");
  const [ppe, setPpe] = useState("50");
  const [khr, setKhr] = useState("4000");
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  useEffect(() => {
    staffApi
      .get<Record<string, number>>("/operator/settings")
      .then((v) => {
        if (v.points_per_usd != null) setPpu(String(v.points_per_usd));
        if (v.points_per_entry != null) setPpe(String(v.points_per_entry));
        if (v.khr_per_usd != null) setKhr(String(v.khr_per_usd));
      })
      .catch(() => undefined);
  }, []);
  return (
    <form
      className="panel stack"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await staffApi.post("/operator/settings", { points_per_usd: Number(ppu), points_per_entry: Number(ppe), khr_per_usd: Number(khr) });
          setDone("Saved. New payments and entries use these values.");
        });
      }}
    >
      <h2>Point policy</h2>
      <p className="muted small">Points have no guaranteed value. These settings decide how many are awarded; merchants decide what they buy.</p>
      <Field label="Points per US dollar spent">
        <input inputMode="numeric" value={ppu} onChange={(e) => setPpu(e.target.value)} />
      </Field>
      <Field label="Points per site entry">
        <input inputMode="numeric" value={ppe} onChange={(e) => setPpe(e.target.value)} />
      </Field>
      <Field label="Riel per US dollar (for points on riel payments)">
        <input inputMode="numeric" value={khr} onChange={(e) => setKhr(e.target.value)} />
      </Field>
      <Notice kind="error">{error}</Notice>
      <Notice kind="ok">{done}</Notice>
      <button className="btn" disabled={busy}>
        Save
      </button>
    </form>
  );
}
