// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// Keeper config — reads the canonical deployments/testnet.json + env-var
// overrides. Post-C.3 ABI: lock_and_settle / crank_expired_ride / pull
// oracle pushes / random-walk ticks. Shared registry / risk-config / etc.
// object IDs come from env vars (the seed scripts don't yet record them).

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

export type Network = "testnet" | "mainnet" | "devnet" | "localnet";

/// One arcade market record as written by `scripts/seed-arcade-markets.sh`.
export interface ArcadeMarketRecord {
  name: string;
  market: string;
  oracle: string;
  path: string;
  random_walk: string;
  barrier: number;
  direction: number;
  expiry_ms: number;
}

/// Pull-oracle market record. NOTE: not yet written by any seed script —
/// keeper reads from `WICK_KEEPER_PULL_MARKETS_PATH` (or `pull_markets`
/// field) if present. Each entry binds an external feed (Coinbase) to a
/// Wick market.
export interface PullMarketRecord {
  name: string;
  market: string;
  oracle: string;
  path: string;
  feed: string;            // PullFeed shared object id
  upstream: "coinbase:BTC-USD" | "coinbase:SUI-USD" | string;
  /// Number of decimals the on-chain oracle expects. Coinbase returns USD
  /// dollars as a string; we scale to `10^decimals` micro-units. 6 by
  /// default to match Wick's `micro_usd` convention.
  decimals?: number;
  /// Optional explicit collateral type — defaults to global `collateralType`.
  collateral?: string;
  barrier?: number;
  direction?: number;
  expiry_ms?: number;
}

/// Segment-market entry as written by `scripts/bootstrap-segment-market.sh`.
/// Read by the v3.6 sentinel runner to resolve the per-market vault id —
/// many segment markets may share `vault_sui` but the script records each
/// binding explicitly so the keeper can pick the right one per market.
export interface SegmentMarketRecord {
  name?: string;
  market: string;
  vault: string;
  collateral?: string;
  min_stake_per_segment?: number;
  // …other fields are present in the JSON but the keeper doesn't need them.
}

export interface Deployment {
  network: Network;
  package_id: string;
  original_id?: string;
  publisher?: string;
  history?: { package_id: string }[];
  // Optional fields populated by seed scripts / manual edits:
  vault_sui?: string;
  vault_admin_cap_sui?: string;
  arcade_markets?: ArcadeMarketRecord[];
  pull_markets?: PullMarketRecord[];
  segment_markets?: SegmentMarketRecord[];
  /// v4 segment markets (touch-either + rug) — the live module. Same record
  /// shape (market / vault / collateral). Used by the keeper's v4 auto-crank.
  segment_markets_v4?: SegmentMarketRecord[];
  // Shared singletons — required for redeem / crank paths but not for
  // lock_and_settle. Threaded via env vars if absent here.
  registry?: string;            // GlobalExposureRegistry (legacy key)
  global_exposure_registry?: string; // GlobalExposureRegistry (canonical
                                     // key written by deploy/bootstrap)
  risk_config?: string;         // RiskConfig
  bot_registry?: string;        // BotRegistry
  fee_router_sui?: string;      // FeeRouter<SUI>
  wick_token_state?: string;    // WickTokenState
  staking_pool?: string;        // WickStakingPool
  usd_price_oracle?: string;    // UsdPriceOracle
  keeper_cap?: string;          // pull_oracle_driver::KeeperCap
}

export interface Config {
  network: Network;
  rpcUrl: string;
  packageId: string;
  originalId: string | undefined;
  historicalPackageIds: string[];
  collateralType: string;

  // Loop tuning.
  pollIntervalMs: number;             // 2_000 testnet default
  iterationTimeoutMs: number;         // 60_000
  rpcBackoffInitialMs: number;        // 500
  rpcBackoffMaxMs: number;            // 30_000

  // Gas budgets.
  gasBudgetTick: bigint;              // 50_000_000
  gasBudgetSettle: bigint;            // 300_000_000
  gasBudgetCrank: bigint;             // 300_000_000

  // Health endpoint.
  healthPort: number;

  // Signer.
  keeperPrivateKeyHex: string | undefined;
  keeperKeyPath: string;              // fallback (.keeper-key.json)

  // Deployment + markets.
  deployment: Deployment;
  arcadeMarkets: ArcadeMarketRecord[];
  pullMarkets: PullMarketRecord[];

  // Shared object ids (env or manifest).
  vaultId: string | undefined;
  registryId: string | undefined;
  riskConfigId: string | undefined;
  botRegistryId: string | undefined;
  feeRouterId: string | undefined;
  wickTokenStateId: string | undefined;
  stakingPoolId: string | undefined;
  usdPriceOracleId: string | undefined;
  keeperCapId: string | undefined;

  // Optional filter: only act on these market ids.
  onlyMarkets: string[];
  // If true, skip random_walk_driver::tick calls (useful when bots tick).
  disableRandomWalkTicks: boolean;
  // If true, skip pull-oracle pushes.
  disablePullPushes: boolean;
  // If true, skip ride cranking.
  disableRideCranks: boolean;
}

function rpcFor(n: Network): string {
  switch (n) {
    case "mainnet": return "https://fullnode.mainnet.sui.io:443";
    // testnet defaults to PublicNode, not the Mysten public fullnode. The
    // keeper is the heaviest RPC user in the system (a record_segment crank
    // ~1 tx/sec plus event polling), and the Mysten testnet endpoint throttles
    // under exactly that load — the same v4.29 finding that moved the frontend
    // off it (see frontend/src/lib/sui.ts). PublicNode sustains ~10× the rate.
    // Override with WICK_KEEPER_RPC to point at your own infra.
    case "testnet": return "https://sui-testnet-rpc.publicnode.com";
    case "devnet":  return "https://fullnode.devnet.sui.io:443";
    case "localnet":return "http://127.0.0.1:9000";
  }
}

function envNumber(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? Number(v) : fallback;
}
function envBigint(name: string, fallback: bigint): bigint {
  const v = process.env[name];
  return v ? BigInt(v) : fallback;
}
function envBool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v == null) return fallback;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

export function loadConfig(): Config {
  const deploymentPath =
    process.env.WICK_KEEPER_DEPLOYMENT_PATH ??
    resolve(repoRoot, "deployments", "testnet.json");
  if (!existsSync(deploymentPath)) {
    throw new Error(`deployment manifest not found at ${deploymentPath}`);
  }
  const dep: Deployment = JSON.parse(readFileSync(deploymentPath, "utf8"));

  // Optional sidecar list of pull markets (e.g. when seed script doesn't
  // record them). JSON file with an array of PullMarketRecord.
  let extraPull: PullMarketRecord[] = [];
  const pullPath = process.env.WICK_KEEPER_PULL_MARKETS_PATH;
  if (pullPath && existsSync(pullPath)) {
    extraPull = JSON.parse(readFileSync(pullPath, "utf8"));
  }
  const pullMarkets = [...(dep.pull_markets ?? []), ...extraPull];

  const historicalPackageIds = (dep.history ?? [])
    .map((h) => h.package_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  const onlyMarkets =
    (process.env.WICK_KEEPER_MARKETS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  return {
    network: dep.network,
    rpcUrl: process.env.WICK_KEEPER_RPC ?? rpcFor(dep.network),
    packageId: dep.package_id,
    originalId: dep.original_id,
    historicalPackageIds,
    collateralType: process.env.WICK_KEEPER_COLLATERAL ?? "0x2::sui::SUI",

    pollIntervalMs: envNumber("WICK_KEEPER_POLL_MS", 2_000),
    iterationTimeoutMs: envNumber("WICK_KEEPER_ITERATION_TIMEOUT_MS", 60_000),
    rpcBackoffInitialMs: envNumber("WICK_KEEPER_BACKOFF_INITIAL_MS", 500),
    rpcBackoffMaxMs: envNumber("WICK_KEEPER_BACKOFF_MAX_MS", 30_000),

    gasBudgetTick: envBigint("WICK_KEEPER_GAS_TICK", 50_000_000n),
    gasBudgetSettle: envBigint("WICK_KEEPER_GAS_SETTLE", 300_000_000n),
    gasBudgetCrank: envBigint("WICK_KEEPER_GAS_CRANK", 300_000_000n),

    healthPort: envNumber("WICK_KEEPER_HEALTH_PORT", 8080),

    keeperPrivateKeyHex: process.env.KEEPER_PRIVATE_KEY_HEX,
    keeperKeyPath:
      process.env.WICK_KEEPER_KEY_PATH ??
      resolve(here, "..", ".keeper-key.json"),

    deployment: dep,
    arcadeMarkets: dep.arcade_markets ?? [],
    pullMarkets,

    vaultId: process.env.WICK_KEEPER_VAULT ?? dep.vault_sui,
    registryId:
      process.env.WICK_KEEPER_REGISTRY ??
      dep.registry ??
      dep.global_exposure_registry,
    riskConfigId: process.env.WICK_KEEPER_RISK_CONFIG ?? dep.risk_config,
    botRegistryId: process.env.WICK_KEEPER_BOT_REGISTRY ?? dep.bot_registry,
    feeRouterId: process.env.WICK_KEEPER_FEE_ROUTER ?? dep.fee_router_sui,
    wickTokenStateId: process.env.WICK_KEEPER_WICK_STATE ?? dep.wick_token_state,
    stakingPoolId: process.env.WICK_KEEPER_STAKING_POOL ?? dep.staking_pool,
    usdPriceOracleId:
      process.env.WICK_KEEPER_USD_PRICE_ORACLE ?? dep.usd_price_oracle,
    keeperCapId: process.env.WICK_KEEPER_CAP ?? dep.keeper_cap,

    onlyMarkets,
    disableRandomWalkTicks: envBool("WICK_KEEPER_DISABLE_RW_TICKS"),
    disablePullPushes: envBool("WICK_KEEPER_DISABLE_PULL_PUSHES"),
    disableRideCranks: envBool("WICK_KEEPER_DISABLE_RIDE_CRANKS"),
  };
}
