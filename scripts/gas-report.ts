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
import { fileURLToPath } from "node:url";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
// PublicNode prunes tx bodies; the Mysten fullnode keeps them. Default there.
const RPC = arg("--rpc") ?? process.env.WICK_API_RPC ?? "https://fullnode.testnet.sui.io";
// Reference SUI price for the USD line (the SUI figures are the on-chain truth).
const SUI_USD = Number(arg("--sui-usd") ?? "0.71");

const MIST_PER_SUI = 1_000_000_000;

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

function sui(mist: bigint): string {
  return (Number(mist) / MIST_PER_SUI).toFixed(6);
}
function usd(mist: bigint): string {
  return `$${((Number(mist) / MIST_PER_SUI) * SUI_USD).toFixed(5)}`;
}
const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

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

  console.log(`gas report — real on-chain costs @ ${RPC}`);
  console.log(dim(`market ${marketId} · USD at $${SUI_USD}/SUI (SUI figures are the on-chain truth)`));
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

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
