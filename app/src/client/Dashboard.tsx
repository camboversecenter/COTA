// Public indicators (SPEC §10). Counts and shares only; no personal data.

import { useState } from "react";
import { formatAmount, SITES, type Currency } from "../shared/protocol";
import { Empty, fmtDate, Notice, TopBar, usePoll } from "./ui";

interface Indicators {
  asOf: number;
  repeatVisitorRate: number | null;
  returnValueRate: number | null;
  spreadRate: number | null;
  reachBeyondAngkor: number | null;
  disputesPerThousand: number | null;
  totals: Record<string, number>;
  spendingByPlace: { province: string; category: string; currency: Currency; payments: number; amount: number; disputes: number }[];
  visitsBySite: { site_id: string; visits: number }[];
}

const pct = (v: number | null) => (v == null ? "No data yet" : `${(v * 100).toFixed(1)}%`);

export function Dashboard() {
  const [d, setD] = useState<Indicators | null>(null);
  const [error, setError] = useState<string | null>(null);
  usePoll(() => {
    fetch("/api/indicators")
      .then((r) => r.json())
      .then((x) => {
        setD(x);
        setError(null);
      })
      .catch(() => setError("Cannot load the indicators."));
  }, 20000);

  const maxVisits = Math.max(1, ...(d?.visitsBySite.map((v) => v.visits) ?? [1]));
  return (
    <div className="shell wide">
      <TopBar />
      <div className="stack-lg">
        <div className="stack">
          <h1>Are visitors coming back?</h1>
          <p className="muted">
            Measured from Nokor Pass and Nokor Point records. Counts and shares only; nothing here identifies a person.
          </p>
        </div>
        <Notice kind="error">{error}</Notice>
        {d && (
          <>
            <div className="kpis">
              <Kpi v={pct(d.repeatVisitorRate)} label="Repeat visitor rate" note="Visitor passes linked to an earlier pass" />
              <Kpi v={pct(d.returnValueRate)} label="Points used on a return trip" note="Redeemed on a later pass than they were earned on" />
              <Kpi v={pct(d.spreadRate)} label="Word of mouth" note="Points redeemed by someone other than who earned them" />
              <Kpi v={pct(d.reachBeyondAngkor)} label="Visits beyond Angkor" note="Site entries outside the Angkor park" />
              <Kpi
                v={d.disputesPerThousand == null ? "No data yet" : d.disputesPerThousand.toFixed(1)}
                label="Disputes per 1,000 payments"
                note="A proxy for overcharging and bad service"
              />
              <Kpi v={String(d.totals.visitorPasses)} label="Visitor passes issued" note={`${d.totals.returningVisitors} returning, ${d.totals.residentPasses} resident passes`} />
            </div>

            <section className="stack">
              <h2>Site entries</h2>
              {d.visitsBySite.length === 0 ? (
                <Empty icon="sites" title="No entries yet" />
              ) : (
                <table className="data">
                  <tbody>
                    {d.visitsBySite.map((v) => (
                      <tr key={v.site_id}>
                        <td style={{ width: "40%" }}>
                          {SITES[v.site_id]?.name ?? v.site_id}
                          {SITES[v.site_id] && !SITES[v.site_id].angkor ? <span className="muted small"> beyond Angkor</span> : null}
                        </td>
                        <td>
                          <div className="bar" style={{ width: `${(v.visits / maxVisits) * 100}%` }} />
                        </td>
                        <td className="num">{v.visits}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="stack">
              <h2>Where the money goes</h2>
              {d.spendingByPlace.length === 0 ? (
                <Empty icon="cash" title="No payments yet" />
              ) : (
                <table className="data">
                  <thead>
                    <tr>
                      <th>Province</th>
                      <th>Category</th>
                      <th className="num">Payments</th>
                      <th className="num">Amount</th>
                      <th className="num">Disputes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.spendingByPlace.map((s, i) => (
                      <tr key={i}>
                        <td>{s.province}</td>
                        <td>{s.category}</td>
                        <td className="num">{s.payments}</td>
                        <td className="num">{formatAmount(s.amount, s.currency)}</td>
                        <td className="num">{s.disputes ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <p className="muted small">
              {d.totals.payments} payments, {d.totals.visits} entries, {d.totals.pointsAwarded} points awarded, {d.totals.pointsGifted} gifted,{" "}
              {d.totals.pointsRedeemed} redeemed. Updated {fmtDate(d.asOf)}.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function Kpi({ v, label, note }: { v: string; label: string; note: string }) {
  return (
    <div className="kpi">
      <div className={v === "No data yet" ? "v none" : "v"}>{v}</div>
      <div>{label}</div>
      <div className="note">{note}</div>
    </div>
  );
}
