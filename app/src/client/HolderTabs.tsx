import { useEffect, useRef, useState } from "react";
import { keccak256, stringToHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CURRENCIES, DOMAIN_NAMES, formatAmount, SITES, TYPES, toMinor, type Currency } from "../shared/protocol";
import { api } from "./api";
import { HOME_CURRENCIES, homeCurrency, inHome } from "./rates";
import { BrandMark, Empty, Field, fmtDate, fmtDuration, Icon, Notice, useAction, useNow } from "./ui";
import { deadlineIn, useWallet } from "./wallet";

export interface Me {
  address: string;
  pass: {
    id: number;
    valid: boolean;
    category: "Visitor" | "Resident";
    issuedAt: number;
    validUntil: number;
    closedAt: number;
    revoked: boolean;
    returning: boolean;
  } | null;
  balances: Record<Currency, number>;
  points: { earnedOnPass: number; balance: number }[];
  payments: {
    currency: Currency;
    payment_id: number;
    merchant_name: string | null;
    amount: number;
    status: string;
    release_at: number;
    created_at: number;
  }[];
  access: { product_id: number; name: string; expires_at: number; sites: string[] }[];
  visits: { site_id: string; at: number }[];
  merchant: { name: string; category: string; province: string } | null;
  disputeWindowSeconds: number;
}

type Props = { me: Me; onChanged: () => void };

async function nonceOf(contract: string) {
  return BigInt((await api.get<{ nonce: string }>(`/nonce/${contract}`)).nonce);
}

// ------------------------------------------------------------------ pass

export function PassTab({ me, onChanged }: Props) {
  const p = me.pass;
  const [home, setHome] = useState(homeCurrency.get());
  return (
    <div className="stack-lg">
      {p?.valid ? (
        <section className="pass" aria-label="Your Nokor Pass">
          <div className="pass-head">
            <BrandMark />
            Nokor Pass
            <span className="pass-kind">{p.category === "Visitor" ? "Visitor" : "Resident"}</span>
          </div>
          <div>
            <p className="label">Pass number</p>
            <p className="big">#{p.id}</p>
          </div>
          <div className="pass-fields">
            <div>
              <p className="label">Valid until</p>
              <strong>
                {p.validUntil ? new Date(p.validUntil * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "No expiry"}
              </strong>
            </div>
            {p.category === "Visitor" && (
              <div>
                <p className="label">Trip</p>
                <strong>{p.returning ? "Welcome back" : "First visit"}</strong>
              </div>
            )}
          </div>
        </section>
      ) : (
        <section className="pass none" aria-label="No pass yet">
          <p className="big">No pass yet</p>
          <p className="label">
            {p && !p.valid
              ? "Your last pass is closed. A new one is issued when you arrive again."
              : "Show the code below at immigration when you arrive. Your pass is issued to this wallet."}
          </p>
        </section>
      )}

      <div className="balances">
        {(["USD", "KHR"] as Currency[]).map((c) => (
          <div className="balance" key={c}>
            <p className="muted small">{CURRENCIES[c].token}</p>
            <p className="amount mono">{formatAmount(me.balances[c], c)}</p>
          </div>
        ))}
      </div>

      <PayCode />

      {p?.valid && p.category === "Visitor" && <Departure key={p.id} me={me} onChanged={onChanged} />}

      <section>
        <div className="group">
          <CurrencyPicker
            value={home}
            onChange={(c) => {
              setHome(c);
              homeCurrency.set(c);
            }}
          />
          <WalletAddress address={me.address} />
        </div>
        <p className="group-note">
          {home === "USD"
            ? "Pick your home currency to see a rough equivalent on every request. You always pay in USD or KHR."
            : `Requests also show a rough amount in ${home}, for example 10.00 USD is ${inHome(1000, "USD", home)}. You always pay in USD or KHR.`}
        </p>
      </section>
    </div>
  );
}

/** Picker: a settings row that opens a sheet of currencies. Replaces a native <select>,
 *  whose menu the browser draws and CSS cannot style. */
function CurrencyPicker({ value, onChange }: { value: string; onChange: (code: string) => void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = useRef<HTMLButtonElement>(null);
  const current = HOME_CURRENCIES[value] ?? HOME_CURRENCIES.USD;

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    selected.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button ref={trigger} className="cell" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open}>
        <span className="cell-icon">
          <Icon name="globe" size={18} />
        </span>
        <span className="grow">Home currency</span>
        <span className="cell-value">{current.name}</span>
        <Icon name="chevron" size={16} />
      </button>
      {open && (
        <div className="sheet-backdrop" onClick={close}>
          <section
            className="sheet picker"
            role="dialog"
            aria-modal="true"
            aria-labelledby="currency-title"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="picker-head">
              <h2 id="currency-title">Home currency</h2>
              <button className="icon-btn" onClick={close} aria-label="Close">
                <Icon name="x" size={18} />
              </button>
            </header>
            <p className="muted small">See a rough equivalent on every request. You always pay in USD or KHR.</p>
            <div className="group picker-list" role="radiogroup" aria-labelledby="currency-title">
              {Object.entries(HOME_CURRENCIES).map(([code, r]) => (
                <button
                  key={code}
                  ref={code === value ? selected : undefined}
                  className="cell"
                  role="radio"
                  aria-checked={code === value}
                  onClick={() => {
                    onChange(code);
                    close();
                  }}
                >
                  <span className="symbol-tile">{r.symbol}</span>
                  <span className="grow">
                    <span>{r.name}</span>
                    <span className="muted small mono">
                      {code === "USD" ? "USD · no conversion" : `1 USD ≈ ${r.perUsd.toLocaleString("en-US")} ${code}`}
                    </span>
                  </span>
                  {code === value && <Icon name="check" size={20} />}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function WalletAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard
      .writeText(address)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  return (
    <div className="cell">
      <span className="cell-icon gray">
        <Icon name="wallet" size={18} />
      </span>
      <span className="grow">
        <span>Wallet address</span>
        <span className="muted small mono" title={address}>
          {address.slice(0, 6)}…{address.slice(-4)}
        </span>
      </span>
      <button className="btn secondary inline" onClick={copy} aria-label="Copy wallet address">
        <Icon name={copied ? "check" : "copy"} size={16} />
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** The six-character code a holder shows to be paid, admitted or issued (SPEC §9.1). */
export function PayCode() {
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const { busy, error, run } = useAction();
  const now = useNow();
  const left = code ? code.expiresAt - now : 0;
  const get = () => run(async () => setCode(await api.post("/paycode")));
  useEffect(() => {
    if (code && left <= 0) setCode(null);
  }, [code, left]);

  return (
    <section className="paycode stack" aria-live="polite">
      {code && left > 0 ? (
        <>
          <p className="muted">Show this code to the driver, shop, gate or immigration officer</p>
          <p className="code" aria-label={code.code.split("").join(" ")}>
            {code.code}
          </p>
          <div className="meter" aria-hidden="true">
            <i style={{ width: `${(left / 120) * 100}%` }} />
          </div>
          <p className="muted small">Valid for {fmtDuration(left)}. It only identifies you; it cannot take money.</p>
        </>
      ) : (
        <>
          <p className="muted">To pay or enter a site, show a code. They send the request to your phone and you approve it.</p>
          <button className="btn" onClick={get} disabled={busy}>
            <Icon name="pass" size={18} />
            Show my code
          </button>
        </>
      )}
      <Notice kind="error">{error}</Notice>
    </section>
  );
}

function Departure({ me, onChanged }: Props) {
  const w = useWallet();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState("card");
  const { busy, error, run } = useAction();
  const [done, setDone] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const total = me.balances.USD + me.balances.KHR;
  if (!open)
    return (
      <button className="btn secondary" onClick={() => setOpen(true)} disabled={!total}>
        <Icon name="cash" size={18} />
        Leaving Cambodia? Convert your balance back
      </button>
    );

  const convert = () =>
    run(async () => {
      const out: string[] = [];
      for (const c of ["USD", "KHR"] as Currency[]) {
        const amount = me.balances[c];
        if (!amount) continue;
        const payoutRef = keccak256(stringToHex(`payout:${method}:${crypto.randomUUID()}`));
        const deadline = deadlineIn(300);
        const signature = await w.sign(CURRENCIES[c].token, "Redeem", {
          holder: w.address,
          amount: BigInt(amount),
          payoutRef,
          nonce: await nonceOf(CURRENCIES[c].token),
          deadline: BigInt(deadline),
        });
        await api.post("/redeem", { currency: c, amount, payoutRef, signature, deadline });
        out.push(formatAmount(amount, c));
      }
      setDone(`${out.join(" and ")} will be paid ${method === "card" ? "back to your card" : "in cash at the airport counter"}.`);
      onChanged();
    });

  return (
    <section className="panel stack">
      <h2>Convert your balance back</h2>
      <p className="muted">Everything left in your wallet is paid out. Your pass stays as the record of your trip.</p>
      <div className="segmented" role="group" aria-label="Pay out to">
        <button aria-pressed={method === "card"} onClick={() => setMethod("card")} disabled={confirming}>
          My card
        </button>
        <button aria-pressed={method === "cash"} onClick={() => setMethod("cash")} disabled={confirming}>
          Cash at the airport
        </button>
      </div>
      <Notice kind="error">{error}</Notice>
      <Notice kind="ok">{done}</Notice>
      {!done && !confirming && (
        <div className="btn-row">
          <button className="btn secondary" onClick={() => setOpen(false)}>
            Not now
          </button>
          <button className="btn" onClick={() => setConfirming(true)}>
            Continue
          </button>
        </div>
      )}
      {!done && confirming && (
        <div className="confirm stack">
          <p className="small">
            Convert{" "}
            <strong>
              {[me.balances.USD ? formatAmount(me.balances.USD, "USD") : "", me.balances.KHR ? formatAmount(me.balances.KHR, "KHR") : ""]
                .filter(Boolean)
                .join(" and ")}
            </strong>
            , paid {method === "card" ? "back to your card" : "in cash at the airport counter"}? This cannot be undone.
          </p>
          <div className="btn-row">
            <button className="btn secondary" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </button>
            <button className="btn danger" onClick={convert} disabled={busy}>
              {busy ? "Converting…" : "Convert all"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ activity

export function ActivityTab({ me, onChanged }: Props) {
  const w = useWallet();
  const now = useNow(5000);
  const { busy, error, run } = useAction();
  const [msg, setMsg] = useState<string | null>(null);

  const dispute = (c: Currency, paymentId: number) =>
    run(async () => {
      if (!confirm("Dispute this payment? The money stays held until the operator decides.")) return;
      const deadline = deadlineIn(180);
      const signature = await w.sign(CURRENCIES[c].token, "Dispute", {
        payer: w.address,
        paymentId: BigInt(paymentId),
        nonce: await nonceOf(CURRENCIES[c].token),
        deadline: BigInt(deadline),
      });
      await api.post(`/payments/${c}/${paymentId}/dispute`, { signature, deadline });
      setMsg("Dispute opened. The merchant is not paid until it is decided.");
      onChanged();
    });

  return (
    <div className="stack-lg">
      <h1>Activity</h1>
      <Notice kind="error">{error}</Notice>
      <Notice kind="ok">{msg}</Notice>
      {me.payments.length === 0 ? (
        <Empty icon="activity" title="No payments yet">Each payment you make appears here, and you can dispute it for a short time.</Empty>
      ) : (
        <ul className="list panel">
          {me.payments.map((p) => {
            const canDispute = p.status === "Escrowed" && now < p.created_at + me.disputeWindowSeconds;
            return (
              <li key={`${p.currency}-${p.payment_id}`} className="stack">
                <div className="row spread">
                  <strong>{p.merchant_name ?? "Merchant"}</strong>
                  <span className="mono">{formatAmount(p.amount, p.currency)}</span>
                </div>
                <div className="row spread small">
                  <span className="muted">{fmtDate(p.created_at)}</span>
                  <span className={`status ${p.status}`}>{statusText(p.status)}</span>
                </div>
                {canDispute && (
                  <button className="btn danger inline" onClick={() => dispute(p.currency, p.payment_id)} disabled={busy}>
                    Dispute, {fmtDuration(p.created_at + me.disputeWindowSeconds - now)} left
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const statusText = (s: string) =>
  ({ Escrowed: "Held", Disputed: "Disputed", Released: "Paid to merchant", Refunded: "Refunded to you" })[s] ?? s;

// ------------------------------------------------------------------ sites

interface Product {
  product_id: number;
  name: string;
  payee_name: string;
  price_usd: number;
  price_khr: number;
  validity_seconds: number;
  entries: number;
  sites: string[];
  description: string | null;
}

export function SitesTab({ me }: Props) {
  const [products, setProducts] = useState<Product[]>([]);
  const [cur, setCur] = useState<Currency>("USD");
  const { busy, error, run } = useAction();
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    api.get<Product[]>("/products").then(setProducts).catch(() => undefined);
  }, []);

  const buy = (p: Product) =>
    run(async () => {
      await api.post(`/products/${p.product_id}/buy`, { currency: cur });
      setMsg("Check the request and approve it.");
    });

  return (
    <div className="stack-lg">
      <h1>Sites</h1>
      {me.access.length > 0 && (
        <section className="panel stack">
          <h2>Your access</h2>
          <ul className="list">
            {me.access.map((a) => (
              <li key={a.product_id}>
                <strong>{a.name}</strong>
                <p className="muted small">
                  {a.sites.map((s) => SITES[s]?.name ?? s).join(", ")}. Until {fmtDate(a.expires_at)}.
                </p>
              </li>
            ))}
          </ul>
          <p className="muted small">At the gate, show your code. The gate sends a request; you confirm it.</p>
        </section>
      )}
      <div className="row spread">
        <h2>Buy access</h2>
        <div className="segmented" role="group" aria-label="Pay in">
          {(["USD", "KHR"] as Currency[]).map((c) => (
            <button key={c} aria-pressed={cur === c} onClick={() => setCur(c)}>
              {c}
            </button>
          ))}
        </div>
      </div>
      <Notice kind="error">{error}</Notice>
      <Notice kind="info">{msg}</Notice>
      {!me.pass?.valid && <Notice kind="warn">You need a valid pass to buy site access.</Notice>}
      {products.length === 0 && <Empty icon="sites" title="Nothing on sale yet">Site access appears here once the site authority lists it.</Empty>}
      {products.map((p) => {
        const owned = me.access.find((a) => a.product_id === p.product_id);
        return (
          <section key={p.product_id} className="panel stack">
            <div className="row spread">
              <h3>{p.name}</h3>
              <span className="mono">{formatAmount(cur === "USD" ? p.price_usd : p.price_khr, cur)}</span>
            </div>
            <p className="muted small">
              {p.sites.map((s) => SITES[s]?.name ?? s).join(", ")}. {fmtDuration(p.validity_seconds)},{" "}
              {p.entries >= 0xffffffff ? "unlimited entries" : `${p.entries} ${p.entries === 1 ? "entry" : "entries"}`}.
            </p>
            {p.description && <p className="small">{p.description}</p>}
            {owned ? (
              <p className="muted small">✓ Active until {fmtDate(owned.expires_at)}. Show your code at the gate.</p>
            ) : (
              <button className="btn secondary" onClick={() => buy(p)} disabled={busy || !me.pass?.valid}>
                Buy for {formatAmount(cur === "USD" ? p.price_usd : p.price_khr, cur)}
              </button>
            )}
          </section>
        );
      })}
      {me.visits.length > 0 && (
        <section className="stack">
          <h2>Places you have visited</h2>
          <ul className="list panel">
            {me.visits.map((v, i) => (
              <li key={i} className="row spread">
                <span>{SITES[v.site_id]?.name ?? v.site_id}</span>
                <span className="muted small">{fmtDate(v.at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ points

interface Offer {
  id: string;
  title: string;
  points: number;
  provider: string;
  description: string | null;
}

export function PointsTab({ me, onChanged }: Props) {
  const w = useWallet();
  const total = me.points.reduce((s, p) => s + p.balance, 0);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [amount, setAmount] = useState("100");
  const [link, setLink] = useState<string | null>(null);
  const [voucher, setVoucher] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  useEffect(() => {
    api.get<Offer[]>("/offers").then(setOffers).catch(() => undefined);
  }, []);

  const gift = () =>
    run(async () => {
      const n = Number(amount);
      const lot = me.points.find((p) => p.balance >= n);
      if (!Number.isInteger(n) || n <= 0) throw new Error("Choose a whole number of points.");
      if (!lot) throw new Error("You do not have that many points from one trip.");
      const claimPk = generatePrivateKey();
      const claimKey = privateKeyToAccount(claimPk).address;
      const deadline = deadlineIn(300);
      const signature = await w.sign("NokorPoint", "Gift", {
        giver: w.address,
        earnedOnPass: BigInt(lot.earnedOnPass),
        amount: BigInt(n),
        claimKey,
        nonce: await nonceOf("NokorPoint"),
        deadline: BigInt(deadline),
      });
      const r = await api.post<{ giftId: number }>("/points/gift", {
        earnedOnPass: lot.earnedOnPass,
        amount: n,
        claimKey,
        signature,
        deadline,
      });
      setLink(`${location.origin}/#/claim/${r.giftId}/${claimPk}`);
      onChanged();
    });

  const redeem = (o: Offer) =>
    run(async () => {
      const lot = me.points.find((p) => p.balance >= o.points);
      if (!lot) throw new Error(`You need ${o.points} points from one trip.`);
      const offerRef = keccak256(stringToHex(`offer:${o.id}:${crypto.randomUUID()}`));
      const deadline = deadlineIn(300);
      const signature = await w.sign("NokorPoint", "RedeemPoints", {
        holder: w.address,
        earnedOnPass: BigInt(lot.earnedOnPass),
        amount: BigInt(o.points),
        offerRef,
        nonce: await nonceOf("NokorPoint"),
        deadline: BigInt(deadline),
      });
      const r = await api.post<{ voucher: string }>("/points/redeem", { offerId: o.id, earnedOnPass: lot.earnedOnPass, offerRef, signature, deadline });
      setVoucher(`${o.title}: show voucher ${r.voucher}`);
      onChanged();
    });

  const share = async () => {
    if (!link) return;
    const text = "I loved Cambodia. Here are some Nokor Points for your trip.";
    if (navigator.share) await navigator.share({ title: "Nokor Points", text, url: link }).catch(() => undefined);
    else await navigator.clipboard?.writeText(link);
  };

  return (
    <div className="stack-lg">
      <div className="stack">
        <h1>{total.toLocaleString()} Nokor Points</h1>
        <p className="muted">
          You earn points when you pay and when you enter a site. They have no cash value. Spend them on offers, or give them to a friend
          who is coming to Cambodia.
        </p>
      </div>
      <Notice kind="error">{error}</Notice>

      <section className="panel stack">
        <h2>Give points to a friend</h2>
        <p className="muted small">You get a link. Your friend opens it after they arrive and receive their own pass.</p>
        <div className="row">
          <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Points to give" />
          <button className="btn inline" onClick={gift} disabled={busy || total === 0 || !(Number(amount) > 0) || Number(amount) > total}>
            <Icon name="gift" size={16} />
            Create gift link
          </button>
        </div>
        {Number(amount) > total && total > 0 && <p className="hint bad">You have {total.toLocaleString()} points to give.</p>}
        {link && (
          <div className="stack">
            <Notice kind="ok">Gift created. Send this link to your friend; anyone with it can claim the points once.</Notice>
            <p className="small break">{link}</p>
            <button className="btn secondary" onClick={share}>
              <Icon name="share" size={18} />
              Share link
            </button>
          </div>
        )}
      </section>

      <section className="stack">
        <h2>Spend points</h2>
        <Notice kind="ok">{voucher}</Notice>
        {offers.map((o) => (
          <div key={o.id} className="panel stack">
            <div className="row spread">
              <h3>{o.title}</h3>
              <span className="mono">{o.points} pts</span>
            </div>
            <p className="muted small">
              {o.provider}
              {o.description ? `. ${o.description}` : ""}
            </p>
            <button className="btn secondary" onClick={() => redeem(o)} disabled={busy || total < o.points || !me.pass?.valid}>
              Use {o.points} points
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ claim a gift

export function ClaimGift({
  claim,
  me,
  onDone,
}: {
  claim: { giftId: number; key: string };
  me: Me | null;
  onDone: (m: string) => void;
}) {
  const w = useWallet();
  const [gift, setGift] = useState<{ amount: number; status: string } | null>(null);
  const { busy, error, run } = useAction();
  useEffect(() => {
    run(async () => setGift(await api.get(`/gifts/${claim.giftId}`)));
  }, [claim.giftId, run]);

  const accept = () =>
    run(async () => {
      if (!w.config || !w.address) throw new Error("Not ready.");
      const account = privateKeyToAccount(claim.key as Hex);
      const claimSignature = await account.signTypedData({
        domain: { name: DOMAIN_NAMES.NokorPoint, version: "1", chainId: w.config.chainId, verifyingContract: w.config.contracts.NokorPoint },
        types: { Claim: TYPES.Claim },
        primaryType: "Claim",
        message: { giftId: BigInt(claim.giftId), recipient: w.address },
      });
      const r = await api.post<{ amount: number }>("/points/claim", { giftId: claim.giftId, claimSignature });
      location.hash = "#/wallet";
      onDone(`You received ${r.amount} Nokor Points from a friend.`);
    });

  return (
    <section className="panel stack">
      <h1>A friend sent you Nokor Points</h1>
      {gift && <p className="muted">{gift.amount} points, earned on their trip to Cambodia.</p>}
      {gift?.status && gift.status !== "open" && <Notice kind="warn">This gift has already been {gift.status}.</Notice>}
      {!me?.pass?.valid && (
        <Notice kind="info">You can claim once you have your Nokor Pass, issued at immigration when you arrive. Keep this link.</Notice>
      )}
      <Notice kind="error">{error}</Notice>
      <button className="btn" onClick={accept} disabled={busy || !me?.pass?.valid || gift?.status !== "open"}>
        Receive the points
      </button>
      <a href="#/wallet">Not now</a>
    </section>
  );
}

export { toMinor };
