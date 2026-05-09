import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

interface Deployment {
  network: "testnet" | "mainnet" | "devnet" | "localnet";
  package_id: string;
  original_id: string;
  history?: { package_id: string }[];
}

interface Config {
  network: Deployment["network"];
  rpcUrl: string;
  packageId: string;
  originalId: string;
  historicalPackageIds: string[];   // every prior package_id, for filter exhaustion
  marketCreatedEventType: string;
  pollIntervalMs: number;
  gasBudget: bigint;
  keeperKeyPath: string;
  // If non-empty, only act on markets with these IDs (useful for demos / dry runs).
  onlyMarkets: string[];
}

function rpcFor(network: Deployment["network"]): string {
  switch (network) {
    case "mainnet": return "https://fullnode.mainnet.sui.io:443";
    case "testnet": return "https://fullnode.testnet.sui.io:443";
    case "devnet":  return "https://fullnode.devnet.sui.io:443";
    case "localnet":return "http://127.0.0.1:9000";
  }
}

export function loadConfig(): Config {
  const deploymentPath = resolve(repoRoot, "deployments", "testnet.json");
  if (!existsSync(deploymentPath)) {
    throw new Error(`deployment manifest not found at ${deploymentPath}`);
  }
  const dep: Deployment = JSON.parse(readFileSync(deploymentPath, "utf8"));

  // Events are emitted under the package_id of the runtime call site (the
  // latest upgrade), not the original_id. To capture events across multiple
  // package versions we'd query a Set of types — but pre-events versions
  // emit nothing, so the latest package_id is the only one with events.
  const marketCreatedEventType = `${dep.package_id}::wick::MarketCreated`;

  const pollIntervalMs = Number(process.env.WICK_KEEPER_POLL_MS ?? 5_000);
  const gasBudget = BigInt(process.env.WICK_KEEPER_GAS_BUDGET ?? "100000000");
  const keeperKeyPath =
    process.env.WICK_KEEPER_KEY_PATH ?? resolve(here, "..", ".keeper-key.json");
  const onlyMarkets =
    (process.env.WICK_KEEPER_MARKETS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  const historicalPackageIds = (dep.history ?? [])
    .map((h) => h.package_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  return {
    network: dep.network,
    rpcUrl: process.env.WICK_KEEPER_RPC ?? rpcFor(dep.network),
    packageId: dep.package_id,
    originalId: dep.original_id,
    historicalPackageIds,
    marketCreatedEventType,
    pollIntervalMs,
    gasBudget,
    keeperKeyPath,
    onlyMarkets,
  };
}

export type { Config };
