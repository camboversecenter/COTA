// Chain access for the Worker: read helpers, and the Relayer Durable Object that
// submits every signed intent with the operator key, one transaction at a time.

import { DurableObject } from "cloudflare:workers";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEventLogs,
  type Abi,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia, foundry } from "viem/chains";
import { NokorAccessAbi, NokorMoneyAbi, NokorPassAbi, NokorPointAbi, NokorRegistryAbi } from "../shared/abi";
import type { ChainConfig } from "../shared/protocol";
import type { Env } from "./env";

export type ContractName = keyof ChainConfig["contracts"];

export const ABIS: Record<ContractName, Abi> = {
  NokorPass: NokorPassAbi as Abi,
  NokorRegistry: NokorRegistryAbi as Abi,
  kUSD: NokorMoneyAbi as Abi,
  kRIEL: NokorMoneyAbi as Abi,
  NokorAccess: NokorAccessAbi as Abi,
  NokorPoint: NokorPointAbi as Abi,
};

const ALL_ABIS = [NokorPassAbi, NokorRegistryAbi, NokorMoneyAbi, NokorAccessAbi, NokorPointAbi].flat() as Abi;

export function chainConfig(env: Env): ChainConfig {
  return {
    chainId: Number(env.CHAIN_ID),
    explorer: env.EXPLORER_URL || null,
    contracts: JSON.parse(env.CONTRACTS),
    disputeWindowSeconds: Number(env.DISPUTE_WINDOW_SECONDS || "86400"),
  };
}

function chainFor(env: Env): Chain {
  const id = Number(env.CHAIN_ID);
  const known = [base, baseSepolia, foundry].find((c) => c.id === id);
  if (known) return { ...known, rpcUrls: { default: { http: [env.RPC_URL] } } };
  return defineChain({
    id,
    name: `chain-${id}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [env.RPC_URL] } },
  });
}

export function publicClient(env: Env) {
  return createPublicClient({ chain: chainFor(env), transport: http(env.RPC_URL) });
}

export function address(env: Env, name: ContractName): `0x${string}` {
  return chainConfig(env).contracts[name];
}

export async function read<T = unknown>(env: Env, name: ContractName, functionName: string, args: unknown[] = []) {
  return (await publicClient(env).readContract({
    address: address(env, name),
    abi: ABIS[name],
    functionName,
    args,
  })) as T;
}

export interface RelayedEvent {
  contract: ContractName | null;
  eventName: string;
  args: Record<string, unknown>;
}

export interface RelayResult {
  hash: Hex;
  blockTimestamp: number;
  events: RelayedEvent[];
}

/** Submit a contract call through the single Relayer instance. */
export async function relay(
  env: Env,
  contract: ContractName,
  functionName: string,
  args: unknown[],
): Promise<RelayResult> {
  const stub = env.RELAYER.get(env.RELAYER.idFromName("operator"));
  return stub.send(contract, functionName, args);
}

/**
 * The operator's relayer. A Durable Object has one instance per id, so routing
 * every write through `idFromName("operator")` serialises the operator key's
 * transactions and avoids nonce collisions between concurrent requests.
 */
export class Relayer extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();

  async send(contract: ContractName, functionName: string, args: unknown[]): Promise<RelayResult> {
    const run = this.queue.then(() => this.submit(contract, functionName, args));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async submit(contract: ContractName, functionName: string, args: unknown[]): Promise<RelayResult> {
    const env = this.env;
    const account = privateKeyToAccount(env.OPERATOR_KEY as Hex);
    const chain = chainFor(env);
    const pub = publicClient(env);
    const wallet = createWalletClient({ account, chain, transport: http(env.RPC_URL) });
    const target = address(env, contract);

    // Simulate first: a revert surfaces as a readable custom error, and no gas is spent.
    const { request } = await pub.simulateContract({
      account,
      address: target,
      abi: ABIS[contract],
      functionName,
      args,
    });
    const hash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash, retryCount: 10, pollingInterval: 3000 });
    if (receipt.status !== "success") throw new Error(`Transaction reverted: ${hash}`);

    const byAddress = new Map(
      Object.entries(chainConfig(env).contracts).map(([k, v]) => [v.toLowerCase(), k as ContractName]),
    );
    const logs = parseEventLogs({ abi: ALL_ABIS, logs: receipt.logs, strict: false });
    return {
      hash,
      blockTimestamp: Math.floor(Date.now() / 1000),
      events: logs.map((l) => ({
        contract: byAddress.get(l.address.toLowerCase()) ?? null,
        eventName: l.eventName as string,
        args: (l.args ?? {}) as Record<string, unknown>,
      })),
    };
  }
}

export function findEvent(r: RelayResult, contract: ContractName, eventName: string) {
  const e = r.events.find((x) => x.contract === contract && x.eventName === eventName);
  if (!e) throw new Error(`Expected ${contract}.${eventName} in ${r.hash}`);
  return e.args;
}
