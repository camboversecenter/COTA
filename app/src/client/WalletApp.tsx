import { useCallback, useState } from "react";
import type { PendingRequest } from "../shared/protocol";
import { api } from "./api";
import { Approval } from "./Approval";
import { ActivityTab, ClaimGift, PassTab, PointsTab, SitesTab, type Me } from "./HolderTabs";
import { ChargeTab, EarningsTab } from "./MerchantTabs";
import { Field, Notice, TopBar, useAction, usePoll } from "./ui";
import { useWallet } from "./wallet";

type Tab = "pass" | "activity" | "sites" | "points" | "charge" | "earnings";

export function WalletApp({ claim }: { claim?: { giftId: number; key: string } }) {
  const w = useWallet();
  if (!w.config) return <Shell><Notice kind={w.error ? "error" : "info"}>{w.error ?? "Connecting…"}</Notice></Shell>;
  if (w.backupPhrase) return <Shell><Backup phrase={w.backupPhrase} onDone={w.confirmBackup} /></Shell>;
  if (!w.hasWallet) return <Shell><Setup /></Shell>;
  if (!w.isUnlocked) return <Shell><Unlock /></Shell>;
  if (!w.signedIn) return <Shell><Notice kind={w.error ? "error" : "info"}>{w.error ?? "Signing in…"}</Notice></Shell>;
  return <Main claim={claim} />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <TopBar />
      {children}
    </div>
  );
}

// ------------------------------------------------------------------ setup

function Backup({ phrase, onDone }: { phrase: string; onDone: () => void }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="stack-lg">
      <div className="stack">
        <h1>Write down your recovery words</h1>
        <p className="muted">
          They restore this wallet if you lose your phone. Anyone who has them can use your balance. They are shown only once.
        </p>
      </div>
      <div className="mnemonic">
        {phrase.split(" ").map((word, i) => (
          <span key={i}>
            {i + 1}. {word}
          </span>
        ))}
      </div>
      <label className="row small">
        <input type="checkbox" style={{ width: "auto" }} checked={ok} onChange={(e) => setOk(e.target.checked)} />
        <span>I have written them down somewhere safe</span>
      </label>
      <button className="btn" onClick={onDone} disabled={!ok}>
        Continue to my wallet
      </button>
    </div>
  );
}

function Setup() {
  const w = useWallet();
  const [mode, setMode] = useState<"create" | "restore">("create");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [passkey, setPasskey] = useState(true);
  const [phrase, setPhrase] = useState("");
  const [local, setLocal] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocal(null);
    if (!/^\d{6,}$/.test(pin)) return setLocal("Use at least 6 digits.");
    if (pin !== pin2) return setLocal("The two PINs do not match.");
    if (mode === "restore") {
      const words = phrase.trim().split(/\s+/);
      if (words.length !== 12 && words.length !== 24) return setLocal("Enter your 12 or 24 recovery words.");
      await w.restore(phrase.trim(), pin, passkey);
    } else {
      await w.create(pin, passkey);
    }
  };

  return (
    <form className="stack-lg" onSubmit={submit}>
      <div className="segmented" role="group" aria-label="Setup">
        <button type="button" aria-pressed={mode === "create"} onClick={() => { setMode("create"); setLocal(null); }}>
          New wallet
        </button>
        <button type="button" aria-pressed={mode === "restore"} onClick={() => { setMode("restore"); setLocal(null); }}>
          Restore wallet
        </button>
      </div>
      <div className="stack">
        <h1>{mode === "create" ? "Create your Nokor Pass wallet" : "Restore your wallet"}</h1>
        <p className="muted">
          {mode === "create"
            ? "Your wallet holds your pass, your riel and dollars, your site tickets and your Nokor Points. Its key stays on this phone; we only store it encrypted."
            : "Enter your 12 recovery words to restore your wallet on this device."}
        </p>
      </div>
      {mode === "restore" && (
        <Field label="Recovery words (12 or 24 words, separated by spaces)">
          <textarea
            rows={3}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            placeholder="word1 word2 word3 …"
          />
        </Field>
      )}
      <Field label="Choose a PIN (6 digits or more)">
        <input inputMode="numeric" type="password" autoComplete="new-password" value={pin} onChange={(e) => setPin(e.target.value)} />
      </Field>
      <Field label="Enter the PIN again">
        <input inputMode="numeric" type="password" autoComplete="new-password" value={pin2} onChange={(e) => setPin2(e.target.value)} />
      </Field>
      <label className="row small">
        <input type="checkbox" style={{ width: "auto" }} checked={passkey} onChange={(e) => setPasskey(e.target.checked)} />
        <span>Also unlock with this phone's fingerprint or face (passkey)</span>
      </label>
      <Notice kind="error">{local ?? w.error}</Notice>
      <button className="btn" disabled={w.busy}>
        {w.busy ? (mode === "create" ? "Creating your wallet…" : "Restoring…") : (mode === "create" ? "Create wallet" : "Restore wallet")}
      </button>
    </form>
  );
}

// ------------------------------------------------------------------ unlock

function Unlock() {
  const w = useWallet();
  const [pin, setPin] = useState("");
  return (
    <form
      className="stack-lg"
      onSubmit={(e) => {
        e.preventDefault();
        void w.unlockPin(pin);
      }}
    >
      <div className="stack">
        <h1>Unlock your wallet</h1>
        <p className="muted">Your key is decrypted on this phone only.</p>
      </div>
      <Field label="PIN">
        <input inputMode="numeric" type="password" autoComplete="current-password" value={pin} onChange={(e) => setPin(e.target.value)} autoFocus />
      </Field>
      <Notice kind="error">{w.error}</Notice>
      <button className="btn" disabled={w.busy}>
        {w.busy ? "Unlocking…" : "Unlock"}
      </button>
      <button type="button" className="btn secondary" onClick={() => void w.unlockPasskey()} disabled={w.busy}>
        Unlock with passkey
      </button>
      <button
        type="button"
        className="btn danger"
        onClick={() => {
          if (confirm("Remove this wallet from this phone? You will need your recovery words to use it again.")) w.forget();
        }}
      >
        Remove wallet from this phone
      </button>
    </form>
  );
}

// ------------------------------------------------------------------ main

function Main({ claim }: { claim?: { giftId: number; key: string } }) {
  const w = useWallet();
  const [tab, setTab] = useState<Tab | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [pending, setPending] = useState<PendingRequest[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const { error, run } = useAction();

  const refresh = useCallback(() => run(async () => setMe(await api.get<Me>("/me"))), [run]);
  usePoll(refresh, 15000);
  usePoll(() => {
    api
      .get<{ requests: PendingRequest[] }>("/requests/pending")
      .then((r) => setPending(r.requests))
      .catch(() => undefined);
  }, 2500);

  const done = (msg: string) => {
    setPending([]);
    setToast(msg);
    void refresh();
  };

  const isMerchant = !!me?.merchant;
  const tabs: [Tab, string][] = isMerchant
    ? [
        ["charge", "Charge"],
        ["earnings", "Earnings"],
        ["pass", "Pass"],
      ]
    : [
        ["pass", "Pass"],
        ["activity", "Activity"],
        ["sites", "Sites"],
        ["points", "Points"],
      ];
  const current: Tab = !tab || (isMerchant && !["charge", "earnings", "pass"].includes(tab)) ? (isMerchant ? "charge" : "pass") : tab;

  return (
    <div className="shell">
      <TopBar
        right={
          <button className="btn secondary inline" onClick={() => void w.lock()}>
            Lock
          </button>
        }
      />
      <div className="stack-lg">
        {toast && (
          <div className="row">
            <div className="grow">
              <Notice kind="ok">{toast}</Notice>
            </div>
            <button className="btn secondary inline" onClick={() => setToast(null)} aria-label="Dismiss">
              OK
            </button>
          </div>
        )}
        <Notice kind="error">{error}</Notice>
        {claim ? (
          <ClaimGift claim={claim} me={me} onDone={done} />
        ) : !me ? (
          <Notice>Loading your pass…</Notice>
        ) : current === "pass" ? (
          <PassTab me={me} onChanged={refresh} />
        ) : current === "activity" ? (
          <ActivityTab me={me} onChanged={refresh} />
        ) : current === "sites" ? (
          <SitesTab me={me} onChanged={refresh} />
        ) : current === "points" ? (
          <PointsTab me={me} onChanged={refresh} />
        ) : current === "charge" ? (
          <ChargeTab merchant={me.merchant!} />
        ) : (
          <EarningsTab />
        )}
      </div>
      {!claim && (
        <nav className="tabs" aria-label="Wallet">
          <div className="tabs-inner">
            {tabs.map(([id, label]) => (
              <button key={id} className="tab" aria-current={current === id ? "page" : undefined} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>
        </nav>
      )}
      {pending[0] && <Approval key={pending[0].id} req={pending[0]} onDone={done} />}
    </div>
  );
}
