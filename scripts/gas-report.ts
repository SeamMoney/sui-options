#!/usr/bin/env tsx
/**
 * gas-report — what a provably-fair ride actually costs on-chain, from REAL
 * testnet transactions (not estimates). Reads the gas a live `record_segment_v4`
 * crank and a live `close_segment_ride_v4` settlement actually burned, and
 * frames the Sui-native economics: storage rebates + crank amortization.
 *
 *   npx tsx scripts/gas-report.ts                 # or: npm run gas:report
 *   npx tsx scripts/gas-report.ts --ride <SegmentRidePositionV4 id>
 *
 * How it stays honest + robust: it reads each object's `previousTransaction`
 * (the last tx that touched it) and pulls `effects.gasUsed` — no estimation, no
 * faucet, no event scan. The market's last tx is a crank; a closed ride's last
 * tx is its settlement. Defaults to the Mysten fullnode because PublicNode
 * prunes historic tx bodies (override with --rpc / WICK_API_RPC).
 *
 * `net = computationCost + storageCost − storageRebate` — the SUI actually
 * spent. The crank cost is shared: one `record_segment_v4` advances the candle
 * for EVERY open ride on the market at once, so per-rider tick cost is
 * net_crank / concurrent_riders.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
// PublicNode prunes tx bodies; the Mysten fullnode keeps them. Default there.
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("usage: npx tsx scripts/gas-report.ts [--rpc <url>]   (or: npm run gas:report)");
  console.log("  Reports the real on-chain gas cost of each v4 ride operation (open/crank/close). Read-only.");
  process.exit(0);
}
const RPC = arg("--rpc") ?? process.env.WICK_API_RPC ?? "https://fullnode.testnet.sui.io";
// USD-per-SUI for the USD line (the SUI figures are the on-chain truth). When
// not pinned with --sui-usd we use the live DeepBook SUI/USDC mid — the same
// mark Wick Pro prices against — so the dollar figures track the real market.
const SUI_USD_OVERRIDE = arg("--sui-usd") ? Number(arg("--sui-usd")) : null;
const SUI_USD_FALLBACK = 0.71;
const DEEPBOOK_INDEXER =
  process.env.DEEPBOOK_INDEXER_URL ?? "https://deepbook-indexer.mainnet.mystenlabs.com";

const MIST_PER_SUI = 1_000_000_000;

// Resolved in main(): override → live DeepBook mid → fallback constant.
let suiUsd = SUI_USD_FALLBACK;
let suiUsdSource = "reference";

/**
 * Mid = (best bid + best ask) / 2 from a DeepBook level-1 orderbook payload.
 * Returns null on a missing/empty book or non-positive prices. Pure so the
 * parse that sets the report's USD figures is unit-testable.
 */
export function midFromOrderbook(j: unknown): number | null {
  const o = (j ?? {}) as { bids?: [string, string][]; asks?: [string, string][] };
  const bid = Number(o.bids?.[0]?.[0]);
  const ask = Number(o.asks?.[0]?.[0]);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
  return (bid + ask) / 2;
}

async function fetchSuiUsd(): Promise<number | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const res = await fetch(`${DEEPBOOK_INDEXER}/orderbook/SUI_USDC?level=1`, { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return midFromOrderbook(await res.json());
  } catch {
    return null;
  }
}

interface GasLine {
  fn: string;
  computation: bigint;
  storage: bigint;
  rebate: bigint;
  net: bigint;
  digest: string;
}

function readBusiestMarket(): string {
  const dep = JSON.parse(readFileSync(join(REPO_ROOT, "deployments", "testnet.json"), "utf8")) as {
    segment_markets_v4?: Array<{ market: string }>;
  };
  const first = (dep.segment_markets_v4 ?? [])[0]?.market;
  if (!first) throw new Error("no segment_markets_v4 in deployments/testnet.json");
  return first;
}

async function gasOfPreviousTx(
  client: SuiJsonRpcClient,
  objectId: string,
): Promise<GasLine | null> {
  const o = await client.getObject({ id: objectId, options: { showPreviousTransaction: true } });
  const digest = o.data?.previousTransaction;
  if (!digest) return null;
  const tb = await client.getTransactionBlock({
    digest,
    options: { showEffects: true, showInput: true },
  });
  const g = tb.effects?.gasUsed;
  if (!g) return null;
  const cmds = (tb.transaction?.data?.transaction as { transactions?: Array<Record<string, unknown>> } | undefined)
    ?.transactions;
  const mc = (cmds ?? []).find((t) => (t as { MoveCall?: unknown }).MoveCall) as
    | { MoveCall?: { function?: string } }
    | undefined;
  const computation = BigInt(g.computationCost);
  const storage = BigInt(g.storageCost);
  const rebate = BigInt(g.storageRebate);
  return {
    fn: mc?.MoveCall?.function ?? "(unknown)",
    computation,
    storage,
    rebate,
    net: computation + storage - rebate,
    digest,
  };
}

export function sui(mist: bigint): string {
  return (Number(mist) / MIST_PER_SUI).toFixed(6);
}
function usd(mist: bigint): string {
  return `$${((Number(mist) / MIST_PER_SUI) * suiUsd).toFixed(5)}`;
}
const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const dim = (s: string) => (useColor ? `\x1b[90m${s}\x1b[0m` : s);
const bold = (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s);

function printLine(label: string, g: GasLine): void {
  const rebatePct = g.storage > 0n ? Number((g.rebate * 100n) / g.storage) : 0;
  console.log(`${bold(label)}  ${dim(`(${g.fn})`)}`);
  console.log(
    `  computation ${sui(g.computation)} + storage ${sui(g.storage)} − rebate ${sui(g.rebate)} ` +
      dim(`(${rebatePct}% of storage refunded)`),
  );
  console.log(`  → net ${bold(sui(g.net) + " SUI")}  ≈ ${usd(g.net)}   ${dim(g.digest)}`);
  console.log("");
}

async function main(): Promise<void> {
  const client = new SuiJsonRpcClient({ url: RPC, network: "testnet" });
  const marketId = arg("--market") ?? readBusiestMarket();

  // Resolve USD-per-SUI: an explicit --sui-usd wins; otherwise the live
  // DeepBook mid (what Wick Pro itself marks against); else a fallback.
  if (SUI_USD_OVERRIDE !== null && Number.isFinite(SUI_USD_OVERRIDE)) {
    suiUsd = SUI_USD_OVERRIDE;
    suiUsdSource = "pinned via --sui-usd";
  } else {
    const live = await fetchSuiUsd();
    if (live !== null) {
      suiUsd = live;
      suiUsdSource = "live DeepBook SUI/USDC mid";
    } else {
      suiUsdSource = "fallback (DeepBook unreachable)";
    }
  }

  console.log(`gas report — real on-chain costs @ ${RPC}`);
  console.log(
    dim(`market ${marketId} · USD at $${suiUsd.toFixed(4)}/SUI — ${suiUsdSource} (SUI figures are the on-chain truth)`),
  );
  console.log("");

  const crank = await gasOfPreviousTx(client, marketId);
  if (!crank) {
    throw new Error(
      "could not read the market's last transaction — try --rpc https://fullnode.testnet.sui.io (PublicNode prunes tx bodies)",
    );
  }
  printLine("per crank", crank);

  // Concurrent-rider amortization: a crank advances the candle for every open
  // ride at once, so per-rider tick cost shrinks with the crowd.
  const o = await client.getObject({ id: marketId, options: { showContent: true } });
  const f = (o.data?.content as { fields?: Record<string, unknown> } | undefined)?.fields;
  const activeRides = f ? Number(f.active_ride_count ?? 0) : 0;

  const rideId = arg("--ride");
  let close: GasLine | null = null;
  if (rideId) {
    close = await gasOfPreviousTx(client, rideId);
    if (close) printLine("per settle", close);
  }

  console.log(bold("the economics"));
  console.log(
    `  • a candle tick (record_segment_v4) costs ${bold(usd(crank.net))} and advances the chart for ` +
      `EVERY open ride at once — at ${activeRides || "N"} concurrent riders that's ${
        activeRides > 0 ? usd(crank.net / BigInt(activeRides)) : "≈ net/riders"
      } per rider per tick.`,
  );
  console.log(
    `  • ${Number((crank.rebate * 100n) / (crank.storage || 1n))}% of the crank's storage is refunded by Sui's storage rebate — ` +
      `the chain pays you back for the bytes it reclaims.`,
  );
  if (close) {
    console.log(`  • settling a ride on-chain (close_segment_ride_v4) costs ${bold(usd(close.net))}.`);
  } else {
    console.log(dim("  • pass --ride <SegmentRidePositionV4 id> to also report a real settlement's gas."));
  }
}

// Run only when invoked directly (not when imported by the test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
