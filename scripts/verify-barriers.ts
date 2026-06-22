#!/usr/bin/env tsx
/**
 * verify-barriers — prove a round's TOUCH barriers were not cherry-picked.
 *
 * The README's anti-cherry-pick claim ("the barrier for round N is locked at
 * round N's start") is verifiable: Move `ensure_round_current` sets, at each
 * round-roll, from the walk price `spot` and the public `barrier_offset_bps`:
 *
 *   spot   = state_price(walk)  // the walk price AT the round-roll, i.e. the
 *                               // carried `state_after` of segment (round·dur − 1)
 *   offset = spot · barrier_offset_bps / 10_000
 *   upper  = spot + offset
 *   lower  = max(spot − offset, 1)
 *
 * The walk price itself is `expand_segment`'d from the on-chain `sui::random`
 * keys (verify-v4 proves that), so the barriers are deterministic from the
 * chain's randomness — the house can't move them to a level the price won't
 * reach. This re-derives them from the segment table and compares to the ride's
 * snapshotted barriers (= the round's barriers at open).
 *
 *   npx tsx scripts/verify-barriers.ts --market <id> --ride <id> [--rpc <url>]
 *   npx tsx scripts/verify-barriers.ts --market <id> --round <N>   # check a round directly
 *
 * Read-only. Exit 0 iff the barriers reproduce from the chain's own walk.
 */
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const FALLBACK_RPCS = [
  "https://sui-testnet-rpc.publicnode.com",
  "https://fullnode.testnet.sui.io:443",
];
const RPC_TIMEOUT_MS = 20_000;

/** Reject if a call hasn't settled in `ms` — a hanging node becomes a thrown
 *  timeout so ResilientClient falls back instead of appearing stuck (matches
 *  verify-v4 / verify-payout). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`RPC timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

interface Args { market?: string; ride?: string; round?: bigint; rpc?: string }

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = argv[i + 1];
    if (a === "--market" && next) { out.market = next; i++; }
    else if (a === "--ride" && next) { out.ride = next; i++; }
    else if (a === "--round" && next) { out.round = BigInt(next); i++; }
    else if (a === "--rpc" && next) { out.rpc = next; i++; }
    else if (a === "-h" || a === "--help") {
      console.error("usage: npx tsx scripts/verify-barriers.ts --market <id> (--ride <id> | --round <N>) [--rpc <url>]");
      process.exit(2);
    } else throw new Error(`unknown or incomplete argument: ${a}`);
  }
  if (!out.market) { console.error("--market is required"); process.exit(2); }
  return out;
}

class ResilientClient {
  private readonly clients: SuiJsonRpcClient[];
  constructor(urls: string[]) {
    const seen = new Set<string>();
    this.clients = urls.filter((u) => u && !seen.has(u) && seen.add(u))
      .map((url) => new SuiJsonRpcClient({ url, network: "testnet" }));
  }
  private async tryAll<T>(fn: (c: SuiJsonRpcClient) => Promise<T>): Promise<T> {
    let last: unknown;
    for (const c of this.clients) { try { return await withTimeout(fn(c), RPC_TIMEOUT_MS); } catch (e) { last = e; } }
    throw last instanceof Error ? last : new Error(String(last));
  }
  getObject(a: unknown) { return this.tryAll((c) => c.getObject(a as never)); }
  getDynamicFieldObject(a: unknown) { return this.tryAll((c) => c.getDynamicFieldObject(a as never)); }
}

function asObj(v: unknown): Record<string, unknown> { return v && typeof v === "object" ? (v as Record<string, unknown>) : {}; }
function asStr(v: unknown): string { return typeof v === "string" ? v : String(v); }
function big(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string" && v.trim() !== "") return BigInt(v);
  return 0n;
}
function fmt(v: bigint): string {
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  return `${whole}.${frac}`;
}

interface MarketInfo { tableId: string; roundDur: bigint; offsetBps: bigint }

async function readMarket(client: ResilientClient, marketId: string): Promise<MarketInfo> {
  const o = asObj(await client.getObject({ id: marketId, options: { showContent: true, showType: true } }));
  const content = asObj(asObj(o.data).content);
  const type = asStr(content.type);
  if (!/::segment_market_v4::SegmentMarketV4</.test(type)) {
    throw new Error(`object ${marketId} is not a SegmentMarketV4 (type: ${type})`);
  }
  const f = asObj(content.fields);
  const tableId = asStr(asObj(asObj(asObj(f.segments).fields).id).id);
  return { tableId, roundDur: big(f.round_duration_segments), offsetBps: big(f.barrier_offset_bps) };
}

/** `state_after` of a recorded segment: {price, home}. Null if not recorded. */
async function readState(client: ResilientClient, tableId: string, k: bigint): Promise<{ price: bigint; home: bigint } | null> {
  const d = asObj(await client.getDynamicFieldObject({ parentId: tableId, name: { type: "u64", value: k.toString() } }));
  const content = asObj(asObj(d.data).content);
  if (!content.fields) return null;
  const sa = asObj(asObj(asObj(asObj(content.fields).value).fields).state_after).fields;
  if (!sa) return null;
  const s = asObj(sa);
  return { price: big(s.price), home: big(s.home) };
}

interface RideBarriers { marketId: string; round: bigint; upper: bigint; lower: bigint }

/** Compare Sui object ids tolerant of 0x-prefix / case / leading-zero noise. */
function sameId(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/^0x/, "").replace(/^0+/, "").toLowerCase();
  return norm(a) === norm(b);
}

async function readRide(client: ResilientClient, rideId: string): Promise<RideBarriers> {
  const o = asObj(await client.getObject({ id: rideId, options: { showContent: true, showType: true } }));
  const content = asObj(asObj(o.data).content);
  if (!/::segment_market_v4::SegmentRidePositionV4$/.test(asStr(content.type))) {
    throw new Error(`object ${rideId} is not a SegmentRidePositionV4`);
  }
  const f = asObj(content.fields);
  return {
    marketId: asStr(f.market_id),
    round: big(f.round_index),
    upper: big(f.upper_barrier_price),
    lower: big(f.lower_barrier_price),
  };
}

/**
 * The pure barrier formula, byte-identical to Move `ensure_round_current`:
 *   offset = spot · barrier_offset_bps / 10_000
 *   upper  = spot + offset ; lower = max(spot − offset, 1)
 */
export function barriersFromSpot(spot: bigint, offsetBps: bigint): { upper: bigint; lower: bigint } {
  const offset = (spot * offsetBps) / 10_000n;
  return { upper: spot + offset, lower: spot > offset ? spot - offset : 1n };
}

/**
 * Which on-chain value is the round-roll spot for `round`? Move's
 * `ensure_round_current` rolls when `next_segment_index` reaches `round·dur`, so
 * the walk price at that moment is `state_after(round·dur − 1).price`. Round 0 is
 * seeded at bootstrap from the home price instead (no prior roll), carried as the
 * `home` field of every segment's `state_after`. Pure so the segment-index choice
 * (the subtle part of the #335 derivation) is unit-testable without the chain.
 */
export function roundRollSpotSource(
  round: bigint,
  roundDur: bigint,
): { segment: bigint; field: "home" | "price" } {
  return round === 0n
    ? { segment: 0n, field: "home" }
    : { segment: round * roundDur - 1n, field: "price" };
}

/** Re-derive a round's (upper, lower) barriers from the chain's own walk. */
async function deriveBarriers(client: ResilientClient, m: MarketInfo, round: bigint): Promise<{ spot: bigint; upper: bigint; lower: bigint }> {
  const src = roundRollSpotSource(round, m.roundDur);
  const s = await readState(client, m.tableId, src.segment);
  if (!s) {
    throw new Error(
      round === 0n
        ? "segment 0 not recorded; cannot derive round-0 barriers"
        : `segment ${src.segment} (round-roll spot for round ${round}) not recorded`,
    );
  }
  const spot = src.field === "home" ? s.home : s.price;
  const { upper, lower } = barriersFromSpot(spot, m.offsetBps);
  return { spot, upper, lower };
}

async function verify(args: Args): Promise<boolean> {
  const client = new ResilientClient([args.rpc ?? "", ...FALLBACK_RPCS]);
  const market = await readMarket(client, args.market!);

  let round: bigint;
  let actual: { upper: bigint; lower: bigint } | null = null;
  if (args.ride) {
    const r = await readRide(client, args.ride);
    // Reject a mismatched --market/--ride pair: deriving this market's barriers
    // and comparing them to another ride's would print a bogus "the house moved
    // the barrier". That's user error, not a dishonest chain.
    if (!sameId(r.marketId, args.market!)) {
      console.log(`ride ${args.ride} belongs to market ${r.marketId}, not ${args.market}.`);
      console.log("FAIL — mismatched --market/--ride pair (not a dishonest chain). Pass the ride's own market.");
      return false;
    }
    round = r.round; actual = { upper: r.upper, lower: r.lower };
  } else if (args.round !== undefined) {
    round = args.round;
  } else {
    throw new Error("provide --ride <id> or --round <N>");
  }

  const d = await deriveBarriers(client, market, round);

  console.log(`market:   ${args.market}`);
  console.log(`round:    ${round} · offset ${market.offsetBps}bps · round-roll spot ${fmt(d.spot)}`);
  console.log(`derived:  upper ${fmt(d.upper)} / lower ${fmt(d.lower)}  (spot ± ${market.offsetBps}bps)`);

  if (actual) {
    const ok = actual.upper === d.upper && actual.lower === d.lower;
    console.log(`on-chain: upper ${fmt(actual.upper)} / lower ${fmt(actual.lower)}`);
    console.log("");
    if (ok) {
      console.log("PASS — the round's barriers reproduce from the chain's own walk price.");
      console.log("       Not house-chosen: barriers ⟸ spot ⟸ sui::random keys. No cherry-pick.");
      return true;
    }
    console.log("FAIL — the on-chain barriers do NOT match spot ± offset. The house moved the barrier.");
    return false;
  }
  console.log("");
  console.log("(no --ride to compare against; derived the round's honest barriers above.)");
  return true;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  verify(parseArgs(process.argv.slice(2)))
    .then((ok) => { process.exitCode = ok ? 0 : 1; })
    .catch((err: unknown) => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1; });
}

export { verify, deriveBarriers, readMarket, readRide };
