// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// Main keeper loop. One tick:
//   1. For each arcade market still in-window: random_walk::tick + path::record (one PTB).
//   2. For each pull market still in-window: fetch coinbase price → pull::push_price + path::record (one PTB).
//   3. For each market past expiry+drain: wick::lock_and_settle<C> (idempotent).
//   4. For each known open RidePosition past expiry & untouched: wick::crank_expired_ride<C>.
//
// All steps log structured JSON. RPC errors are caught + exponential
// backoff. Per-iteration deadline = `cfg.iterationTimeoutMs`.

import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Config, ArcadeMarketRecord, PullMarketRecord } from "./config.js";
import {
  addRandomWalkTick,
  addPathRecord,
  addPathRecordDuringDrain,
  addPullPush,
  addLockAndSettle,
} from "./abi.js";
import { fetchPrice, scalePrice } from "./price-source.js";
import {
  buildCrankRideTx,
  rideCrankability,
  type RideRecord,
} from "./ride.js";

// Substrings used to detect on-chain "already done, skip me" errors. The
// Move side `lock_and_settle` early-returns silently (so it lands as a
// true success), but if a future ABI change makes it abort, this catches
// both the rust-side abort code names and the substring patterns we hit
// during testing on devnet.
const IDEMPOTENT_ABORT_PATTERNS = [
  "EAlreadySettled",
  "EAlreadyClosed",
  "EBadStatus",
  "ENotReadyToSettle",
  "ENotInDrainWindow",
  "EDrainWindowOpen",
  "EStillActive",
];

export interface TickAction {
  kind:
    | "rw-tick+record"
    | "pull-push+record"
    | "lock-and-settle"
    | "crank-ride"
    | "drain-record";
  marketId?: string;
  rideId?: string;
}

export interface TickResult {
  startedAtMs: number;
  finishedAtMs: number;
  durationMs: number;
  actions: number;
  succeeded: number;
  skippedIdempotent: number;
  failed: number;
  events: LogEntry[];
}

export interface LogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  action: string;
  market_id?: string;
  ride_id?: string;
  tx_digest?: string;
  gas_used?: string;
  duration_ms?: number;
  msg?: string;
  error?: string;
  reason?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function classifyError(err: Error): "idempotent" | "fatal" {
  const msg = err.message ?? "";
  for (const p of IDEMPOTENT_ABORT_PATTERNS) {
    if (msg.includes(p)) return "idempotent";
  }
  return "fatal";
}

async function executeTx(
  client: SuiJsonRpcClient,
  signer: Ed25519Keypair,
  tx: Transaction,
): Promise<{ digest: string; gasUsedMist: bigint }> {
  const res = await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    options: { showEffects: true, showEvents: false },
  });
  const status = res.effects?.status?.status;
  if (status !== "success") {
    const err = res.effects?.status?.error ?? "unknown failure";
    throw new Error(`tx ${res.digest} failed: ${err}`);
  }
  const gas = res.effects?.gasUsed;
  let used = 0n;
  if (gas) {
    used =
      BigInt(gas.computationCost ?? "0") +
      BigInt(gas.storageCost ?? "0") -
      BigInt(gas.storageRebate ?? "0");
  }
  return { digest: res.digest, gasUsedMist: used };
}

// ---------- per-market action builders ----------

export function isArcadeInWindow(m: ArcadeMarketRecord, nowMs: number): boolean {
  return nowMs < m.expiry_ms;
}

export function isReadyForSettle(
  expiryMs: number | undefined,
  drainMs: number,
  nowMs: number,
): boolean {
  if (!expiryMs) return false;
  return nowMs >= expiryMs + drainMs;
}

export function isInDrainWindow(
  expiryMs: number | undefined,
  drainMs: number,
  nowMs: number,
): boolean {
  if (!expiryMs) return false;
  return nowMs >= expiryMs && nowMs < expiryMs + drainMs;
}

function buildRandomWalkTickTx(cfg: Config, m: ArcadeMarketRecord): Transaction {
  const tx = new Transaction();
  addRandomWalkTick(tx, {
    packageId: cfg.packageId,
    randomWalkId: m.random_walk,
    oracleId: m.oracle,
  });
  addPathRecord(tx, {
    packageId: cfg.packageId,
    pathId: m.path,
    oracleId: m.oracle,
  });
  tx.setGasBudget(cfg.gasBudgetTick);
  return tx;
}

async function buildPullPushTx(
  cfg: Config,
  m: PullMarketRecord,
): Promise<Transaction | null> {
  if (!cfg.keeperCapId) {
    throw new Error("pull push needs WICK_KEEPER_CAP in env or manifest");
  }
  const quote = await fetchPrice(m.upstream);
  const decimals = m.decimals ?? 6;
  const priceScaled = scalePrice(quote.price, decimals);
  const ts = BigInt(quote.fetchedAtMs);
  // Attestation: opaque bytes — encode source + raw price as UTF-8 JSON.
  const attestation = new TextEncoder().encode(
    JSON.stringify({
      source: quote.source,
      upstream: m.upstream,
      price: quote.price,
      fetched_at_ms: quote.fetchedAtMs,
    }),
  );
  const tx = new Transaction();
  addPullPush(tx, {
    packageId: cfg.packageId,
    feedId: m.feed,
    oracleId: m.oracle,
    keeperCapId: cfg.keeperCapId,
    priceScaled,
    timestampMs: ts,
    attestation,
  });
  addPathRecord(tx, {
    packageId: cfg.packageId,
    pathId: m.path,
    oracleId: m.oracle,
  });
  tx.setGasBudget(cfg.gasBudgetTick);
  return tx;
}

function buildLockAndSettleTx(
  cfg: Config,
  marketId: string,
  pathId: string,
  oracleId: string,
  collateralType: string,
): Transaction {
  if (!cfg.vaultId) {
    throw new Error("lock_and_settle needs WICK_KEEPER_VAULT in env or manifest");
  }
  if (!cfg.registryId) {
    throw new Error(
      "lock_and_settle needs WICK_KEEPER_REGISTRY (GlobalExposureRegistry id) in env or manifest",
    );
  }
  const tx = new Transaction();
  addLockAndSettle(tx, {
    packageId: cfg.packageId,
    collateralType,
    marketId,
    vaultId: cfg.vaultId,
    pathId,
    oracleId,
    registryId: cfg.registryId,
  });
  tx.setGasBudget(cfg.gasBudgetSettle);
  return tx;
}

function buildDrainRecordTx(
  cfg: Config,
  pathId: string,
  oracleId: string,
): Transaction {
  const tx = new Transaction();
  addPathRecordDuringDrain(tx, {
    packageId: cfg.packageId,
    pathId,
    oracleId,
  });
  tx.setGasBudget(cfg.gasBudgetTick);
  return tx;
}

// ---------- the loop body ----------

export interface KeeperState {
  /// Optional list of known rides to poll (e.g. owned by demo accounts).
  /// Populated by the caller — see `ride.ts::findRidesOwnedBy`.
  knownRides: RideRecord[];
}

export async function tickOnce(
  client: SuiJsonRpcClient,
  signer: Ed25519Keypair,
  cfg: Config,
  state: KeeperState,
): Promise<TickResult> {
  const startedAtMs = Date.now();
  const events: LogEntry[] = [];
  let succeeded = 0;
  let skippedIdempotent = 0;
  let failed = 0;
  let actions = 0;
  const sender = signer.getPublicKey().toSuiAddress();
  const onlyFilter =
    cfg.onlyMarkets.length > 0 ? new Set(cfg.onlyMarkets) : null;

  // Deadline guard. We don't kill in-flight txs (Sui doesn't expose
  // cancellation), but we stop scheduling new ones once we cross.
  const deadlineAtMs = startedAtMs + cfg.iterationTimeoutMs;
  const deadlineHit = () => Date.now() >= deadlineAtMs;

  const runTx = async (
    actionKind: TickAction["kind"],
    label: { marketId?: string; rideId?: string },
    tx: Transaction,
  ) => {
    actions += 1;
    const t0 = Date.now();
    try {
      const { digest, gasUsedMist } = await executeTx(client, signer, tx);
      succeeded += 1;
      events.push({
        ts: nowIso(),
        level: "info",
        action: actionKind,
        market_id: label.marketId,
        ride_id: label.rideId,
        tx_digest: digest,
        gas_used: gasUsedMist.toString(),
        duration_ms: Date.now() - t0,
      });
    } catch (err) {
      const e = err as Error;
      const kind = classifyError(e);
      if (kind === "idempotent") {
        skippedIdempotent += 1;
        events.push({
          ts: nowIso(),
          level: "info",
          action: actionKind,
          market_id: label.marketId,
          ride_id: label.rideId,
          duration_ms: Date.now() - t0,
          msg: "idempotent skip",
          reason: e.message,
        });
      } else {
        failed += 1;
        events.push({
          ts: nowIso(),
          level: "error",
          action: actionKind,
          market_id: label.marketId,
          ride_id: label.rideId,
          duration_ms: Date.now() - t0,
          error: e.message,
        });
      }
    }
  };

  const nowMs = Date.now();
  const drainMs = 5_000; // Mirror Move default; if a future config exposes
                          // pre_lock_drain_ms per path, read it then.

  // === 1. Arcade ticks (random walk + record) ===
  if (!cfg.disableRandomWalkTicks) {
    for (const m of cfg.arcadeMarkets) {
      if (deadlineHit()) break;
      if (onlyFilter && !onlyFilter.has(m.market)) continue;
      if (!isArcadeInWindow(m, nowMs)) continue;
      const tx = buildRandomWalkTickTx(cfg, m);
      await runTx("rw-tick+record", { marketId: m.market }, tx);
    }
  }

  // === 2. Pull pushes (coinbase → push_price + record) ===
  if (!cfg.disablePullPushes) {
    for (const m of cfg.pullMarkets) {
      if (deadlineHit()) break;
      if (onlyFilter && !onlyFilter.has(m.market)) continue;
      if (m.expiry_ms && nowMs >= m.expiry_ms) continue;
      try {
        const tx = await buildPullPushTx(cfg, m);
        if (tx) await runTx("pull-push+record", { marketId: m.market }, tx);
      } catch (err) {
        failed += 1;
        events.push({
          ts: nowIso(),
          level: "error",
          action: "pull-push+record",
          market_id: m.market,
          error: (err as Error).message,
        });
      }
    }
  }

  // === 3a. Drain-window record (in [expiry, expiry+drainMs)) ===
  // Best-effort: mempool-delayed pre-expiry obs land here. Idempotent on
  // ENotInDrainWindow / ENoObservation.
  for (const m of cfg.arcadeMarkets) {
    if (deadlineHit()) break;
    if (onlyFilter && !onlyFilter.has(m.market)) continue;
    if (!isInDrainWindow(m.expiry_ms, drainMs, nowMs)) continue;
    const tx = buildDrainRecordTx(cfg, m.path, m.oracle);
    await runTx("drain-record", { marketId: m.market }, tx);
  }
  for (const m of cfg.pullMarkets) {
    if (deadlineHit()) break;
    if (onlyFilter && !onlyFilter.has(m.market)) continue;
    if (!isInDrainWindow(m.expiry_ms, drainMs, nowMs)) continue;
    const tx = buildDrainRecordTx(cfg, m.path, m.oracle);
    await runTx("drain-record", { marketId: m.market }, tx);
  }

  // === 3b. Settlement (past expiry + drain) ===
  for (const m of cfg.arcadeMarkets) {
    if (deadlineHit()) break;
    if (onlyFilter && !onlyFilter.has(m.market)) continue;
    if (!isReadyForSettle(m.expiry_ms, drainMs, nowMs)) continue;
    try {
      const tx = buildLockAndSettleTx(
        cfg, m.market, m.path, m.oracle, cfg.collateralType,
      );
      await runTx("lock-and-settle", { marketId: m.market }, tx);
    } catch (err) {
      failed += 1;
      events.push({
        ts: nowIso(),
        level: "error",
        action: "lock-and-settle",
        market_id: m.market,
        error: (err as Error).message,
      });
    }
  }
  for (const m of cfg.pullMarkets) {
    if (deadlineHit()) break;
    if (onlyFilter && !onlyFilter.has(m.market)) continue;
    if (!isReadyForSettle(m.expiry_ms, drainMs, nowMs)) continue;
    try {
      const tx = buildLockAndSettleTx(
        cfg, m.market, m.path, m.oracle, m.collateral ?? cfg.collateralType,
      );
      await runTx("lock-and-settle", { marketId: m.market }, tx);
    } catch (err) {
      failed += 1;
      events.push({
        ts: nowIso(),
        level: "error",
        action: "lock-and-settle",
        market_id: m.market,
        error: (err as Error).message,
      });
    }
  }

  // === 4. Ride cranks (best-effort for known owned rides) ===
  if (!cfg.disableRideCranks) {
    for (const ride of state.knownRides) {
      if (deadlineHit()) break;
      const decision = rideCrankability(ride, nowMs);
      if (!decision.ok) {
        events.push({
          ts: nowIso(),
          level: "info",
          action: "crank-ride",
          ride_id: ride.id,
          market_id: ride.marketId,
          msg: "skip",
          reason: decision.reason,
        });
        continue;
      }
      try {
        const tx = buildCrankRideTx(cfg, sender, ride);
        await runTx("crank-ride", { rideId: ride.id, marketId: ride.marketId }, tx);
      } catch (err) {
        failed += 1;
        events.push({
          ts: nowIso(),
          level: "error",
          action: "crank-ride",
          ride_id: ride.id,
          error: (err as Error).message,
        });
      }
    }
  }

  const finishedAtMs = Date.now();
  return {
    startedAtMs,
    finishedAtMs,
    durationMs: finishedAtMs - startedAtMs,
    actions,
    succeeded,
    skippedIdempotent,
    failed,
    events,
  };
}

/// Print a TickResult as one structured-log line per event (NDJSON).
export function emitLogs(result: TickResult): void {
  for (const e of result.events) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(e));
  }
  // Summary line per tick.
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      ts: nowIso(),
      level: "info",
      action: "tick-summary",
      duration_ms: result.durationMs,
      actions: result.actions,
      succeeded: result.succeeded,
      skipped_idempotent: result.skippedIdempotent,
      failed: result.failed,
    }),
  );
}
