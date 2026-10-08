import { useEffect, useState } from "react";
import { Dashboard } from "./Dashboard";
import { Gate, Immigration, Operator } from "./Staff";
import { Icon, TopBar, type IconName } from "./ui";
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

const CONSOLES: { href: string; icon: IconName; title: string; text: string }[] = [
  { href: "#/immigration", icon: "immigration", title: "Immigration", text: "Issue a pass on arrival, close it on departure." },
  { href: "#/gate", icon: "gate", title: "Site gate", text: "Check a visitor's access and record the entry." },
  { href: "#/operator", icon: "operator", title: "Operator", text: "Top-ups, merchants, site access, fares and disputes." },
  { href: "#/dashboard", icon: "dashboard", title: "Indicators", text: "Repeat visits, word of mouth and reach beyond Angkor." },
];

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
        <a className="btn cta" href="#/wallet">
          <Icon name="pass" size={20} />
          Open my wallet
        </a>
        <nav className="stack" aria-label="Other consoles">
          <h2 className="eyebrow">For staff and partners</h2>
          <div className="roles">
            {CONSOLES.map((c) => (
              <a className="role" href={c.href} key={c.href}>
                <span className="tile">
                  <Icon name={c.icon} size={22} />
                </span>
                <span className="grow">
                  <strong>{c.title}</strong>
                  <span className="muted small">{c.text}</span>
                </span>
                <Icon name="chevron" size={18} />
              </a>
            ))}
          </div>
        </nav>
        <p className="muted small">
          Prototype of the open-source COTA reference implementation. Test network only; balances have no value.
        </p>
      </div>
    </div>
  );
}
