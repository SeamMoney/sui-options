import { Transaction } from "@mysten/sui/transactions";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { WickClient, type Deployment, type OracleSnapshot } from "@wick/sdk";
import type { BotsConfig } from "./config.js";
import { signAndExecute } from "./sui-helpers.js";

export function makeWickClient(client: SuiJsonRpcClient, cfg: BotsConfig): WickClient {
  return new WickClient({
    sui: client,
    deployment: {
      network: cfg.network,
      package_id: cfg.packageId,
      original_id: cfg.originalId,
      history: cfg.historicalPackageIds.map((id) => ({ package_id: id })),
    } as Deployment,
  });
}

/**
 * Find an existing MockOracle for `asset` (e.g. "BTC/USD"), or build a tx
 * that creates one and returns the new oracle id. Reusing oracles keeps
 * activity tied to one feed per symbol so the keeper has fewer to scan.
 */
export async function findOrCreateOracle(
  client: SuiJsonRpcClient,
  signer: Ed25519Keypair,
  cfg: BotsConfig,
  asset: string,
  initialPrice: bigint,
): Promise<OracleSnapshot> {
  const wick = makeWickClient(client, cfg);
  const existing = await wick.findOracleForAsset(asset);
  if (existing) return existing;

  const sender = signer.getPublicKey().toSuiAddress();
  const tx = new Transaction();
  tx.setSender(sender);
  tx.moveCall({
    target: `${cfg.packageId}::oracle_adapter::create_and_share`,
    arguments: [
      tx.pure.vector("u8", Array.from(new TextEncoder().encode(asset))),
      tx.pure.u64(initialPrice),
    ],
  });
  const { objectChanges } = await signAndExecute(client, signer, tx, cfg);
  for (const c of objectChanges as { type?: string; objectType?: string; objectId?: string }[]) {
    if (c.type === "created" && c.objectType?.endsWith("::oracle_adapter::MockOracle") && c.objectId) {
      return { id: c.objectId, asset, price: Number(initialPrice) };
    }
  }
  throw new Error(`oracle creation tx did not produce a MockOracle for ${asset}`);
}

/**
 * Nudge the oracle price by ±5% to make settlement plausible without
 * always immediately crossing. Permissionless by design (see oracle_adapter.move).
 * Used sparingly so it doesn't dominate organic activity.
 */
export async function nudgeOraclePrice(
  client: SuiJsonRpcClient,
  signer: Ed25519Keypair,
  cfg: BotsConfig,
  oracleId: string,
  currentPrice: number,
): Promise<number> {
  const drift = 1 + (Math.random() - 0.5) * 0.1;   // ±5%
  const next = Math.max(1, Math.floor(currentPrice * drift));
  const sender = signer.getPublicKey().toSuiAddress();
  const tx = new Transaction();
  tx.setSender(sender);
  tx.moveCall({
    target: `${cfg.packageId}::oracle_adapter::set_price`,
    arguments: [tx.object(oracleId), tx.pure.u64(BigInt(next))],
  });
  await signAndExecute(client, signer, tx, cfg);
  return next;
}
