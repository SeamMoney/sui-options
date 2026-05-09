import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import {
  WickClient,
  buildMarkHitTx,
  buildSettleExpiredTx,
  type Deployment,
} from "@wick/sdk";
import type { Config } from "./config.js";

interface Action {
  marketId: string;
  collateralType: string;
  kind: "mark_hit" | "settle_expired";
  oracleId?: string;
  reason: string;
}

function shouldMarkHit(direction: "ABOVE" | "BELOW", barrier: number, oraclePrice: number): boolean {
  if (direction === "ABOVE") return oraclePrice >= barrier;
  if (direction === "BELOW") return oraclePrice <= barrier;
  return false;
}

export async function planActions(
  client: SuiJsonRpcClient,
  cfg: Config,
  signerAddress: string,
  nowMs: number,
): Promise<Action[]> {
  const wick = new WickClient({
    sui: client,
    deployment: {
      network: cfg.network,
      package_id: cfg.packageId,
      original_id: cfg.originalId,
      history: cfg.historicalPackageIds.map((id) => ({ package_id: id })),
    } as Deployment,
  });
  const wanted = cfg.onlyMarkets.length > 0
    ? new Set(cfg.onlyMarkets.map((s) => normalizeSuiAddress(s)))
    : null;

  const markets = await wick.listMarkets();
  const actions: Action[] = [];
  for (const m of markets) {
    if (wanted && !wanted.has(normalizeSuiAddress(m.id))) continue;
    if (m.status !== "ACTIVE") continue;

    if (nowMs >= m.expiryMs) {
      actions.push({
        marketId: m.id,
        collateralType: m.collateralType,
        kind: "settle_expired",
        reason: `expired ${nowMs - m.expiryMs}ms ago`,
      });
      continue;
    }

    const oracle = await wick.findOracleForAsset(m.asset);
    if (!oracle) continue;

    if (shouldMarkHit(m.direction, m.barrier, oracle.price)) {
      actions.push({
        marketId: m.id,
        collateralType: m.collateralType,
        kind: "mark_hit",
        oracleId: oracle.id,
        reason: `oracle=${oracle.price} crossed barrier=${m.barrier} dir=${m.direction}`,
      });
    }
  }
  void signerAddress;
  return actions;
}

export async function executeAction(
  client: SuiJsonRpcClient,
  signer: Ed25519Keypair,
  cfg: Config,
  action: Action,
): Promise<string> {
  const sender = signer.getPublicKey().toSuiAddress();
  const tx =
    action.kind === "mark_hit" && action.oracleId
      ? buildMarkHitTx({
          packageId: cfg.packageId,
          collateralType: action.collateralType,
          sender,
          marketId: action.marketId,
          oracleId: action.oracleId,
        })
      : buildSettleExpiredTx({
          packageId: cfg.packageId,
          collateralType: action.collateralType,
          sender,
          marketId: action.marketId,
        });
  tx.setGasBudget(cfg.gasBudget);
  const result = await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    options: { showEffects: true, showEvents: true },
  });
  if (result.effects?.status.status !== "success") {
    throw new Error(
      `tx ${result.digest} failed: ${result.effects?.status.error ?? "unknown"}`,
    );
  }
  return result.digest;
}

export async function tickOnce(
  client: SuiJsonRpcClient,
  signer: Ed25519Keypair,
  cfg: Config,
): Promise<{ planned: number; succeeded: number; failed: number; details: string[] }> {
  const sender = signer.getPublicKey().toSuiAddress();
  const actions = await planActions(client, cfg, sender, Date.now());
  const details: string[] = [];
  let succeeded = 0;
  let failed = 0;
  for (const a of actions) {
    try {
      const digest = await executeAction(client, signer, cfg, a);
      details.push(`${a.kind} market=${a.marketId} ok digest=${digest} (${a.reason})`);
      succeeded++;
    } catch (err) {
      details.push(`${a.kind} market=${a.marketId} FAIL: ${(err as Error).message}`);
      failed++;
    }
  }
  return { planned: actions.length, succeeded, failed, details };
}
