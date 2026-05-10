import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Transaction } from "@mysten/sui/transactions";
import type { BotsConfig } from "./config.js";

export function makeClient(cfg: BotsConfig): SuiJsonRpcClient {
  return new SuiJsonRpcClient({ url: cfg.rpcUrl, network: cfg.network });
}

export async function totalSuiMist(
  client: SuiJsonRpcClient,
  address: string,
): Promise<bigint> {
  const balance = await client.getBalance({ owner: address, coinType: "0x2::sui::SUI" });
  return BigInt(balance.totalBalance);
}

export interface SignAndExecuteOpts {
  /** Override gas budget. */
  gasBudget?: bigint;
}

export async function signAndExecute(
  client: SuiJsonRpcClient,
  signer: Ed25519Keypair,
  tx: Transaction,
  cfg: BotsConfig,
  opts?: SignAndExecuteOpts,
): Promise<{ digest: string; objectChanges: unknown[] }> {
  tx.setGasBudget(opts?.gasBudget ?? cfg.gasBudget);
  const result = await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    options: { showEffects: true, showObjectChanges: true },
  });
  if (result.effects?.status.status !== "success") {
    throw new Error(
      `tx ${result.digest} failed: ${result.effects?.status.error ?? "unknown"}`,
    );
  }
  return { digest: result.digest, objectChanges: result.objectChanges ?? [] };
}

export function jitter(baseMs: number, jitterMs: number): number {
  const lo = Math.max(0, baseMs - jitterMs);
  const hi = baseMs + jitterMs;
  return Math.floor(lo + Math.random() * (hi - lo));
}

export function randomBigintBetween(lo: bigint, hi: bigint): bigint {
  if (hi <= lo) return lo;
  const span = hi - lo;
  const r = BigInt(Math.floor(Math.random() * Number(span)));
  return lo + r;
}

export function randomNumberBetween(lo: number, hi: number): number {
  return Math.floor(lo + Math.random() * (hi - lo));
}

export function pickRandom<T>(arr: readonly T[]): T {
  if (arr.length === 0) throw new Error("pickRandom: empty array");
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
