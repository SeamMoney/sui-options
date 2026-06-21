#!/usr/bin/env tsx
/**
 * verify-v4.ts — cold-start, on-chain provable-fairness verifier for the
 * LIVE v4 segment-market demo path (`wick::segment_market_v4`, doc 25).
 *
 * The claim Wick makes to a trader is: "the price path you rode was the
 * deterministic result of an on-chain committed random seed — the house
 * could not have cherry-picked the wick that knocked you out." This script
 * proves exactly that, against real testnet state, with zero trust in our
 * server.
 *
 * How it works (no genesis replay required → robust to event pruning):
 *
 *   Each `record_segment_v4` call writes a `SegmentRecord` into the market's
 *   `segments` Table with FOUR committed fields:
 *       key          — 32 bytes drawn from `sui::random` (on-chain entropy)
 *       state_after  — the full WalkState AFTER this segment
 *       min_price    — the low the chain claims for this segment
 *       max_price    — the high the chain claims for this segment
 *
 *   For every segment k we independently recompute, off-chain:
 *       expand_segment(record[k-1].state_after, record[k].key)
 *   and assert that
 *       (a) replayed min/max == record[k].{min,max}_price   (no cherry-picked wick)
 *       (b) replayed newState == record[k].state_after       (the chain links honestly)
 *
 *   Because (b) chains each segment to the previous one, a contiguous run of
 *   passing segments is a single tamper-evident proof: changing any segment's
 *   seed, extreme, or carried state breaks the very next link.
 *
 *   When segment 0 is in range we additionally anchor it to genesis —
 *   newState(home_price, vol_regime_init, home_price) — closing the chain all
 *   the way back to bootstrap. When it isn't (old rounds pruned), we verify
 *   the available suffix and say so plainly.
 *
 * Reads come from the `segments` Table via `getDynamicFieldObject`, NOT from
 * events, so a fullnode that has pruned old `SegmentRecordedV4` events can
 * still serve the proof for every un-pruned round.
 *
 * Usage:
 *   npx tsx scripts/verify-v4.ts                       # latest market in deployments, last full round
 *   npx tsx scripts/verify-v4.ts --market 0x…          # explicit market
 *   npx tsx scripts/verify-v4.ts --round 6             # a specific round
 *   npx tsx scripts/verify-v4.ts --from 380 --to 456   # an explicit segment range
 *   npx tsx scripts/verify-v4.ts --all                 # try the whole un-pruned history
 *   npx tsx scripts/verify-v4.ts --tamper              # self-test: flip a byte, watch it FAIL
 *   npx tsx scripts/verify-v4.ts --rpc https://…       # override the fullnode
 *
 * Pure read-only. Submits no transaction, spends no gas.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import {
  expandSegment,
  newState,
  type WalkState,
  type Signed,
} from "../sdk/src/seededPath.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const DEFAULT_RPC = "https://sui-testnet-rpc.publicnode.com";
/** The bootstrap default `vol_regime_init` (1.0 in 1e6 fixed-point). */
const DEFAULT_VOL_REGIME_INIT = 1_000_000n;
const TYPE_MARKER = "::segment_market_v4::SegmentMarketV4";

// ── CLI ─────────────────────────────────────────────────────────────────────

interface Args {
  market?: string;
  rpc: string;
  round?: bigint;
  from?: bigint;
  to?: bigint;
  all: boolean;
  tamper: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { rpc: DEFAULT_RPC, all: false, tamper: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--market": out.market = next(); break;
      case "--rpc": out.rpc = next() ?? DEFAULT_RPC; break;
      case "--round": out.round = BigInt(next() ?? "0"); break;
      case "--from": out.from = BigInt(next() ?? "0"); break;
      case "--to": out.to = BigInt(next() ?? "0"); break;
      case "--all": out.all = true; break;
      case "--tamper": out.tamper = true; break;
      case "--help": case "-h": usage(); process.exit(0);
      default:
        if (a.startsWith("--")) { console.error(`unknown flag: ${a}`); usage(); process.exit(2); }
    }
  }
  return out;
}

function usage(): void {
  console.log(
    [
      "usage: npx tsx scripts/verify-v4.ts [options]",
      "  --market <id>     SegmentMarketV4 object id (default: latest in deployments/testnet.json)",
      "  --round <n>       verify round n only",
      "  --from <k> --to <k>   verify segments [from, to)",
      "  --all             verify the whole un-pruned history",
      "  --tamper          self-test: corrupt one segment locally and prove the verifier catches it",
      "  --rpc <url>       fullnode RPC (default: PublicNode testnet)",
      "(no range flags → verifies the latest complete round)",
    ].join("\n"),
  );
}

// ── chain reads ───────────────────────────────────────────────────────────

interface SegmentRecord {
  k: bigint;
  key: Uint8Array;
  min: bigint;
  max: bigint;
  recordedAtMs: bigint;
  stateAfter: WalkState;
}

interface MarketInfo {
  /** Type-origin package (where SegmentMarketV4 was defined) — the correct */
  /** address for event tags and the proof's provenance. */
  typePackage: string;
  segmentsTableId: string;
  nextSegmentIndex: bigint;
  roundDurationSegments: bigint;
  homePrice: bigint;
  type: string;
}

function asBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string") return BigInt(v);
  throw new Error(`not a numeric field: ${JSON.stringify(v)}`);
}

function parseSigned(s: any): Signed {
  const f = s?.fields ?? s;
  return { neg: Boolean(f.neg), mag: asBigInt(f.mag) };
}

function parseWalk(w: any): WalkState {
  const f = w?.fields ?? w;
  return {
    price: asBigInt(f.price),
    momentum: parseSigned(f.momentum),
    volRegime: asBigInt(f.vol_regime),
    home: asBigInt(f.home),
    patternId: asBigInt(f.pattern_id),
    candlesRemaining: asBigInt(f.candles_remaining),
  };
}

async function fetchMarketInfo(
  client: SuiJsonRpcClient,
  marketId: string,
): Promise<MarketInfo> {
  const raw: any = await client.getObject({
    id: marketId,
    options: { showContent: true, showType: true },
  });
  const data = raw?.data;
  if (!data || data.content?.dataType !== "moveObject") {
    throw new Error(`object ${marketId} not found or not a Move object`);
  }
  const type: string = data.content.type ?? data.type;
  const idx = type.indexOf(TYPE_MARKER);
  if (idx < 0) {
    throw new Error(`object ${marketId} is not a SegmentMarketV4; type=${type}`);
  }
  const typePackage = type.slice(0, idx);
  const f = data.content.fields;
  const segments = f.segments;
  const segmentsTableId: string = segments?.fields?.id?.id ?? segments?.fields?.id;
  if (!segmentsTableId) throw new Error("could not locate segments Table id on market");
  // home_price is not a top-level field; the genesis `home` lives inside the
  // walk state (constant across the walk). Use it as the genesis anchor price.
  const homePrice = asBigInt(parseWalk(f.walk).home);
  return {
    typePackage,
    segmentsTableId,
    nextSegmentIndex: asBigInt(f.next_segment_index),
    roundDurationSegments: asBigInt(f.round_duration_segments),
    homePrice,
    type,
  };
}

async function fetchRecord(
  client: SuiJsonRpcClient,
  tableId: string,
  k: bigint,
): Promise<SegmentRecord | null> {
  const df: any = await client.getDynamicFieldObject({
    parentId: tableId,
    name: { type: "u64", value: k.toString() },
  });
  if (df?.error || !df?.data) return null; // pruned or never recorded
  const v = df.data.content?.fields?.value?.fields;
  if (!v) return null;
  return {
    k,
    key: Uint8Array.from(v.key as number[]),
    min: asBigInt(v.min_price),
    max: asBigInt(v.max_price),
    recordedAtMs: asBigInt(v.recorded_at_ms),
    stateAfter: parseWalk(v.state_after),
  };
}

// ── verification ────────────────────────────────────────────────────────────

interface Row {
  k: bigint;
  replayMin: bigint;
  replayMax: bigint;
  recMin: bigint;
  recMax: bigint;
  extremaMatch: boolean;
  stateMatch: boolean;
}

function walkEq(a: WalkState, b: WalkState): boolean {
  return (
    a.price === b.price &&
    a.volRegime === b.volRegime &&
    a.home === b.home &&
    a.patternId === b.patternId &&
    a.candlesRemaining === b.candlesRemaining &&
    a.momentum.mag === b.momentum.mag &&
    a.momentum.neg === b.momentum.neg
  );
}

function fmt(n: bigint): string {
  // micro-USD → human (6dp collateral); show 2dp for the table.
  return (Number(n) / 1e6).toFixed(2);
}

function deployment(): any {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, "deployments/testnet.json"), "utf8"),
  );
}

function defaultMarketId(): string {
  const d = deployment();
  const last = d.segment_markets_v4?.at(-1);
  if (!last?.market) {
    throw new Error(
      "no segment_markets_v4 in deployments/testnet.json — pass --market <id>",
    );
  }
  return last.market;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const marketId = args.market ?? defaultMarketId();
  const client = new SuiJsonRpcClient({ url: args.rpc, network: "testnet" });

  console.log("─".repeat(72));
  console.log("Wick — v4 on-chain provable-fairness verifier");
  console.log("─".repeat(72));
  console.log(`market: ${marketId}`);
  console.log(`rpc:    ${args.rpc}`);

  const info = await fetchMarketInfo(client, marketId);
  console.log(`type-origin package: ${info.typePackage}`);
  console.log(
    `segments recorded: ${info.nextSegmentIndex}  (round size = ${info.roundDurationSegments})`,
  );

  // Resolve the [from, to) range to verify.
  let from: bigint;
  let to: bigint;
  if (args.all) {
    from = 0n;
    to = info.nextSegmentIndex;
  } else if (args.from !== undefined || args.to !== undefined) {
    from = args.from ?? 0n;
    to = args.to ?? info.nextSegmentIndex;
  } else {
    const round =
      args.round ??
      // latest *complete* round
      (info.nextSegmentIndex / info.roundDurationSegments > 0n
        ? info.nextSegmentIndex / info.roundDurationSegments - 1n
        : 0n);
    from = round * info.roundDurationSegments;
    to = from + info.roundDurationSegments;
    if (to > info.nextSegmentIndex) to = info.nextSegmentIndex;
    console.log(`round:  ${round}  → segments [${from}, ${to})`);
  }
  if (to <= from) {
    console.log("\nnothing to verify (empty range).");
    return;
  }
  console.log(`range:  [${from}, ${to})`);
  console.log("");

  // To verify segment k we need record[k-1] (the state going in). For k=from
  // (when from>0) we read the predecessor as the seed; for from==0 we anchor
  // to genesis.
  const records = new Map<string, SegmentRecord | null>();
  const need = new Set<bigint>();
  for (let k = from > 0n ? from - 1n : 0n; k < to; k++) need.add(k);
  // bounded concurrency so we don't hammer the RPC
  const ks = [...need].sort((a, b) => (a < b ? -1 : 1));
  const CONC = 8;
  for (let i = 0; i < ks.length; i += CONC) {
    const batch = ks.slice(i, i + CONC);
    const got = await Promise.all(
      batch.map((k) => fetchRecord(client, info.segmentsTableId, k)),
    );
    batch.forEach((k, j) => records.set(k.toString(), got[j]!));
  }

  const rows: Row[] = [];
  let allMatch = true;
  let verifiedFrom: bigint | null = null;
  let verifiedTo: bigint | null = null;
  let genesisAnchored = false;
  let prunedHead = 0n;

  for (let k = from; k < to; k++) {
    const cur = records.get(k.toString()) ?? null;
    if (!cur) {
      // segment pruned/missing — skip but record the gap
      prunedHead++;
      continue;
    }

    // resolve the state going into segment k
    let stateIn: WalkState;
    if (k === 0n) {
      const d = deployment();
      const m = d.segment_markets_v4?.find((x: any) => x.market === marketId);
      const vol = m?.vol_regime_init
        ? BigInt(m.vol_regime_init)
        : DEFAULT_VOL_REGIME_INIT;
      stateIn = newState(info.homePrice, vol, info.homePrice);
      genesisAnchored = true;
    } else {
      const prev = records.get((k - 1n).toString()) ?? null;
      if (!prev) {
        // predecessor pruned: this segment can't be independently re-seeded.
        prunedHead++;
        continue;
      }
      stateIn = prev.stateAfter;
    }

    // ── TAMPER self-test: flip one byte in the FIRST verifiable segment so a
    // judge can watch a dishonest record get caught. ──
    let key = cur.key;
    if (args.tamper && verifiedFrom === null) {
      key = Uint8Array.from(cur.key);
      key[0] = key[0] ^ 0x01;
      console.log(
        `⚠️  --tamper: flipped 1 bit of segment ${k}'s committed seed to simulate a dishonest house\n`,
      );
    }

    const r = expandSegment(stateIn, key);
    const extremaMatch = r.min === cur.min && r.max === cur.max;
    const stateMatch = walkEq(r.newState, cur.stateAfter);
    const ok = extremaMatch && stateMatch;
    allMatch = allMatch && ok;
    if (verifiedFrom === null) verifiedFrom = k;
    verifiedTo = k;
    rows.push({
      k,
      replayMin: r.min,
      replayMax: r.max,
      recMin: cur.min,
      recMax: cur.max,
      extremaMatch,
      stateMatch,
    });
  }

  // ── report ─────────────────────────────────────────────────────────────
  if (rows.length === 0) {
    console.log(
      "No verifiable segments in range — every record in this window has been pruned\n" +
        "(prune_settled_segments reclaims storage for settled rounds, doc 23).\n" +
        "Try a more recent --round, or pass --market for an active market.",
    );
    process.exit(2);
  }

  // print a compact table (head + tail if long)
  const header =
    "  k       replayLow  replayHigh   chainLow  chainHigh   extrema  state";
  console.log(header);
  console.log("  " + "-".repeat(header.length - 2));
  const printRow = (row: Row) => {
    console.log(
      "  " +
        [
          row.k.toString().padStart(5),
          fmt(row.replayMin).padStart(10),
          fmt(row.replayMax).padStart(11),
          fmt(row.recMin).padStart(10),
          fmt(row.recMax).padStart(10),
          (row.extremaMatch ? "  match" : "  DIFF ").padStart(8),
          (row.stateMatch ? " match" : " DIFF ").padStart(6),
        ].join(" "),
    );
  };
  const SHOW = 6;
  if (rows.length <= SHOW * 2) {
    rows.forEach(printRow);
  } else {
    rows.slice(0, SHOW).forEach(printRow);
    console.log(`  …  (${rows.length - SHOW * 2} more segments, all checked)`);
    rows.slice(-SHOW).forEach(printRow);
  }

  console.log("");
  const failed = rows.filter((r) => !r.extremaMatch || !r.stateMatch);
  console.log(`verified segments: ${rows.length}  (${verifiedFrom}..${verifiedTo})`);
  console.log(`genesis anchored:  ${genesisAnchored ? "yes — chained to bootstrap" : "no (segment 0 outside range / pruned)"}`);
  if (prunedHead > 0n) {
    console.log(`skipped (pruned):  ${prunedHead} segment(s) with no on-chain record`);
  }
  console.log("");

  if (args.tamper) {
    if (failed.length > 0) {
      console.log(
        `✓ TAMPER CAUGHT — the verifier flagged ${failed.length} segment(s) ` +
          `(first: k=${failed[0]!.k}). A dishonest path cannot pass.`,
      );
      console.log("PASS (tamper detection works)");
      return;
    }
    console.log("✗ tamper NOT caught — this is a verifier bug. FAIL");
    process.exit(1);
  }

  if (allMatch) {
    console.log(
      "✓ PASS — every segment's price range is the deterministic result of the\n" +
        "  previous committed state and this segment's on-chain random seed.\n" +
        "  The house did not — and could not — cherry-pick the wick.",
    );
    return;
  }

  console.log(
    `✗ FAIL — ${failed.length} segment(s) do not match the deterministic replay:`,
  );
  for (const r of failed.slice(0, 10)) {
    console.log(
      `    k=${r.k}  extrema=${r.extremaMatch ? "ok" : "MISMATCH"}  state=${r.stateMatch ? "ok" : "MISMATCH"}`,
    );
  }
  process.exit(1);
}

main().catch((e) => {
  console.error("verify-v4 error:", e?.message ?? e);
  process.exit(1);
});
