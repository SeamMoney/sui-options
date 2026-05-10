import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

export type Network = "testnet" | "mainnet" | "devnet" | "localnet";

export interface Deployment {
  network: Network;
  package_id: string;
  original_id: string;
  history?: { package_id: string }[];
}

export interface BotsConfig {
  network: Network;
  rpcUrl: string;
  packageId: string;
  originalId: string;
  historicalPackageIds: string[];
  collateralType: string;          // "0x2::sui::SUI"
  pollIntervalMs: number;          // per-bot wait between actions
  jitterMs: number;                // ± jitter on the wait
  riskMistMin: bigint;
  riskMistMax: bigint;
  gasBudget: bigint;
  fundPerBotMist: bigint;          // initial funding from alice per bot
  fundFloorMist: bigint;           // top-up if a bot falls below this
  createMarketEveryNTicks: number; // how often the creator bot opens a fresh market
  expiryMinSeconds: number;
  expiryMaxSeconds: number;
  seedMistMin: bigint;
  seedMistMax: bigint;
  feeBps: bigint;
  keyDir: string;
}

function rpcFor(network: Network): string {
  switch (network) {
    case "mainnet": return "https://fullnode.mainnet.sui.io:443";
    case "testnet": return "https://fullnode.testnet.sui.io:443";
    case "devnet":  return "https://fullnode.devnet.sui.io:443";
    case "localnet":return "http://127.0.0.1:9000";
  }
}

function envBigint(name: string, fallback: bigint): bigint {
  const v = process.env[name];
  return v ? BigInt(v) : fallback;
}

function envNumber(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? Number(v) : fallback;
}

export function loadConfig(): BotsConfig {
  const deploymentPath = resolve(repoRoot, "deployments", "testnet.json");
  if (!existsSync(deploymentPath)) {
    throw new Error(`deployment manifest not found at ${deploymentPath}`);
  }
  const dep: Deployment = JSON.parse(readFileSync(deploymentPath, "utf8"));
  const historicalPackageIds = (dep.history ?? [])
    .map((h) => h.package_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  return {
    network: dep.network,
    rpcUrl: process.env.WICK_BOTS_RPC ?? rpcFor(dep.network),
    packageId: dep.package_id,
    originalId: dep.original_id,
    historicalPackageIds,
    collateralType: process.env.WICK_BOTS_COLLATERAL ?? "0x2::sui::SUI",
    pollIntervalMs: envNumber("WICK_BOTS_POLL_MS", 4_000),
    jitterMs: envNumber("WICK_BOTS_JITTER_MS", 2_000),
    riskMistMin: envBigint("WICK_BOTS_RISK_MIN", 30_000n),
    riskMistMax: envBigint("WICK_BOTS_RISK_MAX", 120_000n),
    gasBudget: envBigint("WICK_BOTS_GAS_BUDGET", 100_000_000n),
    fundPerBotMist: envBigint("WICK_BOTS_FUND_PER_BOT", 500_000_000n),  // 0.5 SUI
    fundFloorMist: envBigint("WICK_BOTS_FUND_FLOOR", 50_000_000n),       // 0.05 SUI
    createMarketEveryNTicks: envNumber("WICK_BOTS_CREATE_EVERY", 25),
    expiryMinSeconds: envNumber("WICK_BOTS_EXPIRY_MIN_S", 240),
    expiryMaxSeconds: envNumber("WICK_BOTS_EXPIRY_MAX_S", 1_800),
    seedMistMin: envBigint("WICK_BOTS_SEED_MIN", 200_000n),
    seedMistMax: envBigint("WICK_BOTS_SEED_MAX", 500_000n),
    feeBps: envBigint("WICK_BOTS_FEE_BPS", 30n),
    keyDir: process.env.WICK_BOTS_KEY_DIR ?? resolve(here, "..", ".bot-keys"),
  };
}
