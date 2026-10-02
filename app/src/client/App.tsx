import { useEffect, useState } from "react";
import { Dashboard } from "./Dashboard";
import { Gate, Immigration, Operator } from "./Staff";
import { TopBar } from "./ui";
import { WalletApp } from "./WalletApp";

function useHash() {
  const [hash, setHash] = useState(() => window.location.hash || "#/");
  useEffect(() => {
    const on = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

export function App() {
  const hash = useHash();
  const claim = hash.match(/^#\/claim\/(\d+)\/(0x[0-9a-fA-F]{64})$/);
  if (claim) return <WalletApp claim={{ giftId: Number(claim[1]), key: claim[2] }} />;
  switch (hash) {
    case "#/wallet":
      return <WalletApp />;
    case "#/immigration":
      return <Immigration />;
    case "#/gate":
      return <Gate />;
    case "#/operator":
      return <Operator />;
    case "#/dashboard":
      return <Dashboard />;
    default:
      return <Home />;
  }
}

function Home() {
  return (
    <div className="shell">
      <TopBar />
      <div className="stack-lg">
        <div className="home-hero stack">
          <h1>One pass for Cambodia</h1>
          <p className="muted">
            Issued when you arrive. Pay in riel or dollars, enter heritage sites, and earn Nokor Points you can give to a friend who
            comes next.
          </p>
        </div>
        <a className="btn" href="#/wallet">
          Open my wallet
        </a>
        <nav className="roles stack" aria-label="Other consoles">
          <a className="role" href="#/immigration">
            <strong>Immigration</strong>
            Issue a pass on arrival, close it on departure.
          </a>
          <a className="role" href="#/gate">
            <strong>Site gate</strong>
            Check a visitor's access and record the entry.
          </a>
          <a className="role" href="#/operator">
            <strong>Operator</strong>
            Top-ups, merchants, site access, fares and disputes.
          </a>
          <a className="role" href="#/dashboard">
            <strong>Indicators</strong>
            Repeat visits, word of mouth and reach beyond Angkor.
          </a>
        </nav>
        <p className="muted small">
          Prototype of the open-source COTA reference implementation. Test network only; balances have no value.
        </p>
      </div>
    </div>
  );
}
