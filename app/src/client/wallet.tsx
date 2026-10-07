// The Nokor Pass wallet: the zk-vault-react signer (key held in a Web Worker,
// Argon2id PIN + passkey envelopes), with envelopes stored in Cloudflare D1, and
// EIP-712 signing for every intent the operator relays (SPEC §8).

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { hashTypedData, type Hex, type TypedDataDomain } from "viem";
import { useWalletSigner, type WalletStorageAdapter } from "../wallet";
import type { Argon2Params } from "../wallet/messages";
import { DOMAIN_NAMES, TYPES, type ChainConfig } from "../shared/protocol";
import { api, session } from "./api";

/** Argon2id at the OWASP baseline, so unlocking stays quick on a ~$150 phone. */
const ARGON2: Argon2Params = { memorySizeKiB: 19456, iterations: 2, parallelism: 1 };
const VAULT_ID_KEY = "nokor.vaultId";

const vaultId = {
  get: () => {
    try {
      return localStorage.getItem(VAULT_ID_KEY);
    } catch {
      return null;
    }
  },
  set: (id: string | null) => {
    try {
      if (id) localStorage.setItem(VAULT_ID_KEY, id);
      else localStorage.removeItem(VAULT_ID_KEY);
    } catch {
      /* private mode: the wallet id must then be kept by the user */
    }
  },
};

const storage: WalletStorageAdapter = {
  load: async (id) => {
    try {
      const r = await api.get<{ record: Parameters<WalletStorageAdapter["save"]>[1] }>(`/vault/${id}`);
      return r.record;
    } catch {
      return null;
    }
  },
  // One PUT writes every field in a single SQL statement (atomic, as the library requires).
  save: async (id, record) => {
    await api.put(`/vault/${id}`, { record, argon2: ARGON2 });
  },
};

type SignableType = keyof typeof TYPES;
type DomainContract = keyof typeof DOMAIN_NAMES;

interface WalletState {
  config: ChainConfig | null;
  hasWallet: boolean;
  isUnlocked: boolean;
  signedIn: boolean;
  address: `0x${string}` | null;
  error: string | null;
  busy: boolean;
  create(pin: string, withPasskey: boolean): Promise<string | null>;
  restore(mnemonic: string, pin: string, withPasskey: boolean): Promise<void>;
  unlockPin(pin: string): Promise<boolean>;
  unlockPasskey(): Promise<boolean>;
  lock(): Promise<void>;
  forget(): void;
  sign(contract: DomainContract, type: SignableType, message: Record<string, unknown>): Promise<Hex>;
  clearError(): void;
  /** Recovery words of a just-created wallet, until the holder confirms the backup. */
  backupPhrase: string | null;
  confirmBackup(): void;
}

const Ctx = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<ChainConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [hasWallet, setHasWallet] = useState(() => !!vaultId.get());
  const [backupPhrase, setBackupPhrase] = useState<string | null>(null);
  const w = useWalletSigner({ storage, argon2: ARGON2, onError: (e) => setError(e.message) });

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => setError("Cannot reach the Nokor Pass service."));
  }, []);

  /** Sign in with the wallet: EIP-191 challenge → session (SPEC §9.3). */
  const signIn = useCallback(
    async (address: string) => {
      const { challenge } = await api.post<{ challenge: string }>("/auth/challenge", { address });
      const sig = await w.personalSign(challenge);
      if (!sig) throw new Error("Could not sign in.");
      const { token } = await api.post<{ token: string }>("/auth/verify", { address, signature: sig.signatureHex });
      session.set(token);
      const id = vaultId.get();
      if (id) await api.post(`/vault/${id}/bind`).catch(() => undefined);
      setSignedIn(true);
    },
    [w],
  );

  const run = useCallback(async <T,>(f: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await f();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const create = useCallback(
    (pin: string, withPasskey: boolean) =>
      run(async () => {
        const id = crypto.randomUUID();
        const res = await w.createWallet(id, pin, { withPasskey, email: "Nokor Pass" });
        if (!res) return null;
        vaultId.set(id);
        setBackupPhrase(res.mnemonic ?? null);
        setHasWallet(true);
        await signIn(res.address);
        return res.mnemonic ?? null;
      }),
    [run, w, signIn],
  );

  const restore = useCallback(
    (mnemonic: string, pin: string, withPasskey: boolean) =>
      run(async () => {
        const id = crypto.randomUUID();
        const res = await w.importWallet(id, pin, mnemonic, { withPasskey, email: "Nokor Pass" });
        if (!res) return;
        vaultId.set(id);
        setHasWallet(true);
        await signIn(res.address);
      }),
    [run, w, signIn],
  ) as (mnemonic: string, pin: string, withPasskey: boolean) => Promise<void>;

  const unlockPin = useCallback(
    async (pin: string) =>
      (await run(async () => {
        const id = vaultId.get();
        if (!id) throw new Error("No wallet on this device.");
        const ok = await w.unlockWithPin(id, pin);
        if (!ok) throw new Error("Wrong PIN, or the wallet could not be loaded.");
        return true;
      })) ?? false,
    [run, w],
  );

  const unlockPasskey = useCallback(
    async () =>
      (await run(async () => {
        const id = vaultId.get();
        if (!id) throw new Error("No wallet on this device.");
        const ok = await w.unlockWithPasskey(id);
        if (!ok) throw new Error("Passkey unlock failed. Use your PIN.");
        return true;
      })) ?? false,
    [run, w],
  );

  // After any unlock, sign in for this tab if there is no session yet.
  useEffect(() => {
    if (w.isUnlocked && w.address && !signedIn) {
      if (session.get()) setSignedIn(true);
      else run(() => signIn(w.address!));
    }
    if (!w.isUnlocked) setSignedIn(false);
  }, [w.isUnlocked, w.address, signedIn, signIn, run]);

  const lock = useCallback(async () => {
    await w.lock();
    session.set(null);
    setSignedIn(false);
  }, [w]);

  const forget = useCallback(() => {
    vaultId.set(null);
    session.set(null);
    setHasWallet(false);
    void w.lock();
  }, [w]);

  /** Build the EIP-712 digest here; the key in the worker only ever signs digests. */
  const sign = useCallback(
    async (contract: DomainContract, type: SignableType, message: Record<string, unknown>) => {
      if (!config) throw new Error("Not connected.");
      const domain: TypedDataDomain = {
        name: DOMAIN_NAMES[contract],
        version: "1",
        chainId: config.chainId,
        verifyingContract: config.contracts[contract],
      };
      const digest = (hashTypedData as (p: unknown) => Hex)({
        domain,
        types: { [type]: TYPES[type] },
        primaryType: type,
        message,
      });
      const sig = await w.signDigest(digest);
      if (!sig) throw new Error("Signing failed.");
      return sig.signatureHex as Hex;
    },
    [config, w],
  );

  const value = useMemo<WalletState>(
    () => ({
      config,
      hasWallet,
      isUnlocked: w.isUnlocked,
      signedIn,
      address: (w.address?.toLowerCase() as `0x${string}`) ?? null,
      error,
      busy,
      create,
      restore,
      unlockPin,
      unlockPasskey,
      lock,
      forget,
      sign,
      clearError: () => setError(null),
      backupPhrase,
      confirmBackup: () => setBackupPhrase(null),
    }),
    [backupPhrase, config, hasWallet, w.isUnlocked, w.address, signedIn, error, busy, create, restore, unlockPin, unlockPasskey, lock, forget, sign],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet outside WalletProvider");
  return v;
}

export const deadlineIn = (seconds: number) => Math.floor(Date.now() / 1000) + seconds;
