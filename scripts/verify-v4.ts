#!/usr/bin/env tsx
/**
 * verify-v4 — the provably-fair audit for the LIVE v4 arcade (`segment_market_v4`).
 *
 * This is the v4 twin of `scripts/verify.ts`. The shipped `/ride` game opens
 * `open_segment_ride_v4` rides, so a judge who wants to check the chain's honesty
 * from the terminal needs a v4-aware verifier — the v2/v3 `verify.ts` reads the
 * wrong object types.
 *
 * WHAT IT PROVES (no trust, no indexer, no event replay):
 *   For every segment the chain recorded, re-run the SAME byte-identical seeded
 *   walk the Move package runs (`@wick/sdk seededPath.expandSegment`, checked
 *   against 10k vectors in CI) starting from the chain's OWN claimed
 *   carried-state of the previous segment, and confirm the recomputed
 *   (min, max, state_after) equal what the chain published. Tamper any key or
 *   extremum and the recomputation diverges → FAIL.
 *
 * WHY IT'S ROBUST: every `SegmentRecord` stores `key`, `min_price`, `max_price`
 * AND `state_after` inside the market's on-chain `Table`. So each segment is
 * verifiable INDEPENDENTLY from its predecessor's carried state — read straight
 * from dynamic fields. No event pagination (public nodes prune old tx events),
 * no "replay from genesis", no archive. Works cold against a market with
 * thousands of segments.
 *
 * MODES:
 *   1. Market audit — verify a contiguous segment range:
 *        npx tsx scripts/verify-v4.ts --market <SegmentMarketV4 id> [--from K --to K]
 *      Default range: the most recent `--window` (32) segments.
 *
 *   2. Ride settlement — verify one closed ride's path AND that the chain's
 *      settlement verdict is the one the path implies (either-barrier touch,
 *      cashout, expiry):
 *        npx tsx scripts/verify-v4.ts --market <id> --ride <SegmentRidePositionV4 id>
 *
 *   3. Synthetic (offline, deterministic — for CI + the tamper demo):
 *        npx tsx scripts/verify-v4.ts --rpc mock://synthetic-v4 --ride 0xmock
 *        npx tsx scripts/verify-v4.ts --rpc mock://tamper-v4   --ride 0xmock   # FAILs
 *
 * Settlement mirror: `decide_settlement` in `move/sources/segment_market_v4.move`
 * — rug (MARKET HALT) → TOUCH_WIN(1) on either barrier → EXPIRED_LOSS(3) on
 * round-expiry → CASHOUT(2); ABORTED_REFUND(4) is taken from the chain. The
 * ride's live window is bounded by `recorded_at_ms <= closed_at_ms` (no event
 * lookup), so the touch scan matches the chain's `[entry, next_segment_index@close)`.
 *
 * Cross-round closes (the ride was held PAST its entry round before closing):
 * Move reads `rugged_at_segment` for the round the market is in AT CLOSE
 * (`ensure_round_current` clears it on every round-roll, and the rug roll's
 * keccak preimage includes the round index). So the scan runs THROUGH close
 * (not capped at the entry round's end) and the halt is attributed to the CLOSE
 * round (`= scanEnd / round_duration`). For the common in-round close this
 * reduces to "entry round, scan to round end" exactly. (Fixed in #299; before
 * it, late-closed rides false-FAILed "the chain lied".)
 *
 * v4.27 DEPLOY-SAFETY (Move PRs #683 bounded-scan + #694 durable per-round rug):
 * those fixes change ONLY cross-round verdicts, and ONLY by turning a previously
 * escaping TOUCH_WIN into the EXPIRED_LOSS the round actually dealt. Within-round
 * settlement is byte-identical, so the strict in-round check is unaffected. And
 * every cross-round v4.27 verdict is EXPIRED_LOSS, which the `crossRoundClose`
 * softening below already accepts as honest-but-not-re-derivable (`chain
 * EXPIRED_LOSS && derived != EXPIRED_LOSS`). => THIS VERIFIER NEEDS NO CHANGE to
 * stay correct across the v4.27 upgrade: it passes both the deployed v4.26 chain
 * and a v4.27 chain. (An OPTIONAL future enhancement could tighten the softening
 * to a strict check under v4.27 — bound the touch scan to the ride's round here
 * and read the rug by `ride.roundIndex` — but that is a stronger /verify, not a
 * correctness requirement. Same conclusion for the recent-rides MARKET-HALT
 * label, which keys on the ride's own `round_index`.)
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import {
  expandSegment,
  newState,
  type WalkState,
} from "../sdk/src/seededPath.js";
import { rollRugFired } from "./rugRoll.js";

const DEFAULT_RPC = "https://sui-testnet-rpc.publicnode.com";
// Tried in order after the chosen --rpc, so a transient throttle/hiccup on the
// default public node falls through to the archival fullnode instead of
// hard-failing the headline verify:fairness:live (matches verify-payout /
// audit-rugs / verify-barriers). Dedup handles the default already being here.
const FALLBACK_RPCS = [
  "https://sui-testnet-rpc.publicnode.com",
  "https://fullnode.testnet.sui.io:443",
];
const DEFAULT_VOL_REGIME_INIT = 1_000_000n;
const RPC_TIMEOUT_MS = 20_000;

/** Reject if a promise hasn't settled in `ms` — turns a HANGING node (not an
 *  error, just a non-responding socket) into a thrown timeout so the resilient
 *  client falls back to the next endpoint instead of appearing stuck. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`RPC timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * An RpcClient that tries several endpoints in order, falling back on a THROWN
 * error (RPC down / throttled) OR a per-call timeout (a hanging node). A
 * successful `{ data: null }` (a segment that genuinely isn't recorded) is
 * returned as-is — no fallback — so the fail-closed gap detection is preserved;
 * only real RPC failures/hangs retry.
 */
function makeResilientClient(urls: string[]): RpcClient {
  const seen = new Set<string>();
  const clients = urls
    .filter((u) => u && !seen.has(u) && seen.add(u))
    .map((url) => new SuiJsonRpcClient({ url, network: "testnet" }));
  async function tryAll<T>(fn: (c: SuiJsonRpcClient) => Promise<T>): Promise<T> {
    let last: unknown;
    for (const c of clients) {
      try {
        return await withTimeout(fn(c), RPC_TIMEOUT_MS);
      } catch (e) {
        last = e;
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }
  return {
    getObject: (a) => tryAll((c) => c.getObject(a as never)),
    getDynamicFieldObject: (a) => tryAll((c) => c.getDynamicFieldObject(a as never)),
  };
}
const DEFAULT_WINDOW = 32;

/** SuiScan explorer link so a judge can cross-check the audited object on the
 *  public explorer (the "don't trust us, look yourself" half of the proof).
 *  Same format the smoke scripts use. */
const suiscan = (kind: "object" | "tx", id: string): string =>
  `https://suiscan.xyz/testnet/${kind}/${id}`;

// v4 settlement enum — `segment_market_v4.move` SETTLEMENT_* constants.
const SETTLEMENT_OPEN = 0;
const SETTLEMENT_TOUCH_WIN = 1;
const SETTLEMENT_CASHOUT = 2;
const SETTLEMENT_EXPIRED_LOSS = 3;
const SETTLEMENT_ABORTED_REFUND = 4;
const SETTLEMENT_NAME: Readonly<Record<number, string>> = {
  [SETTLEMENT_OPEN]: "OPEN",
  [SETTLEMENT_TOUCH_WIN]: "TOUCH_WIN",
  [SETTLEMENT_CASHOUT]: "CASHOUT",
  [SETTLEMENT_EXPIRED_LOSS]: "EXPIRED_LOSS",
  [SETTLEMENT_ABORTED_REFUND]: "ABORTED_REFUND",
};

interface Args {
  rpc: string;
  market?: string;
  ride?: string;
  from?: bigint;
  to?: bigint;
  window: number;
  home?: bigint;
}

function usage(): never {
  console.error(
    "usage: npx tsx scripts/verify-v4.ts --market <SegmentMarketV4 id> [--ride <id>] [--from K --to K] [--rpc <url>]",
  );
  console.error(
    "  market audit:  npx tsx scripts/verify-v4.ts --market 0x… --window 32",
  );
  console.error(
    "  ride verify:   npx tsx scripts/verify-v4.ts --market 0x… --ride 0x…",
  );
  console.error(
    "  synthetic:     npx tsx scripts/verify-v4.ts --rpc mock://synthetic-v4 --ride 0xmock",
  );
  console.error(
    "  tamper demo:   npx tsx scripts/verify-v4.ts --rpc mock://tamper-v4 --ride 0xmock   (FAILs)",
  );
  console.error(
    "  rug demo:      npx tsx scripts/verify-v4.ts --rpc mock://rug-v4 --ride 0xmock --home 1000000000   (MARKET HALT → EXPIRED_LOSS)",
  );
  console.error(
    "  need a real ride? 'npm run rides:recent' lists closed rides + a ready-to-run command; 'npm run audit:latest' audits the newest with no args.",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { rpc: DEFAULT_RPC, window: DEFAULT_WINDOW };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--market" && next) {
      out.market = next;
      i++;
    } else if (arg === "--ride" && next) {
      out.ride = next;
      i++;
    } else if (arg === "--rpc" && next) {
      out.rpc = next;
      i++;
    } else if (arg === "--from" && next) {
      out.from = BigInt(next);
      i++;
    } else if (arg === "--to" && next) {
      out.to = BigInt(next);
      i++;
    } else if (arg === "--window" && next) {
      out.window = Number(next);
      i++;
    } else if (arg === "--home" && next) {
      out.home = BigInt(next);
      i++;
    } else if (arg === "-h" || arg === "--help") {
      usage();
    } else {
      throw new Error(`unknown or incomplete argument: ${arg}`);
    }
  }
  // Synthetic modes synthesize a market id; market-audit mode can auto-discover
  // a live market from deployments. Only ride mode strictly needs --market (the
  // market must match the ride).
  const synthetic = (out.rpc ?? "").startsWith("mock://");
  if (!synthetic && out.ride && !out.market) {
    console.error("--ride requires --market (the market the ride belongs to)");
    usage();
  }
  return out as Args;
}

// ── Minimal RPC surface (real + mock share this) ────────────────────────────

interface RpcClient {
  getObject(args: {
    id: string;
    options?: { showContent?: boolean; showType?: boolean };
  }): Promise<unknown>;
  getDynamicFieldObject(args: {
    parentId: string;
    name: { type: string; value: string };
  }): Promise<unknown>;
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function asString(v: unknown): string {
  return typeof v === "string" ? v : String(v);
}
function asBig(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string" && v.trim() !== "") return BigInt(v);
  return 0n;
}
function asBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return new Uint8Array(v as number[]);
  if (typeof v === "string") {
    const hex = v.startsWith("0x") ? v.slice(2) : v;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  return new Uint8Array();
}

/** Decode an on-chain WalkState struct (`fields` of a `SegmentRecord.state_after`). */
function decodeWalkState(fields: Record<string, unknown>): WalkState {
  const mom = asObject(asObject(fields.momentum).fields);
  return {
    price: asBig(fields.price),
    momentum: { neg: Boolean(mom.neg), mag: asBig(mom.mag) },
    volRegime: asBig(fields.vol_regime),
    home: asBig(fields.home),
    patternId: asBig(fields.pattern_id),
    candlesRemaining: asBig(fields.candles_remaining),
  };
}

interface SegmentRecord {
  k: bigint;
  key: Uint8Array;
  min: bigint;
  max: bigint;
  stateAfter: WalkState;
  recordedAtMs: bigint;
}

interface MarketInfo {
  packageId: string;
  collateralType: string;
  segmentsTableId: string;
  deadbandBps: bigint;
  roundDurationSegments: bigint;
  nextSegmentIndex: bigint;
  cachedRoundIndex: bigint;
}

/** v4.26 rug (MARKET HALT) config — a `RugConfig` dynamic field on the market. */
interface RugConfig {
  rugChanceBps: bigint;
  /** Set only for the market's CURRENT round (reset on round roll); null if none. */
  ruggedAtSegment: bigint | null;
}

interface RideInfo {
  marketId: string;
  entrySegmentIndex: bigint;
  roundIndex: bigint;
  upperBarrier: bigint;
  lowerBarrier: bigint;
  closed: boolean;
  closedAtMs: bigint;
  settlementKind: number;
}

/** Compare Sui object ids tolerant of 0x-prefix / case / leading-zero noise. */
function sameId(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/^0x/, "").replace(/^0+/, "").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Zero-arg convenience: pick a live v4 market to audit from
 * `deployments/testnet.json`. Probes each `segment_markets_v4` entry and
 * returns the one with the most segments recorded (the busiest = best demo),
 * so `npx tsx scripts/verify-v4.ts` with no `--market` audits the live chain.
 */
async function discoverLiveMarket(client: RpcClient): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "..", "deployments", "testnet.json");
  let markets: string[];
  try {
    const dep = JSON.parse(readFileSync(path, "utf8")) as {
      segment_markets_v4?: Array<{ market?: string }>;
    };
    markets = (dep.segment_markets_v4 ?? [])
      .map((m) => m.market)
      .filter((m): m is string => typeof m === "string");
  } catch (e) {
    throw new Error(
      `pass --market <SegmentMarketV4 id> (could not read ${path}: ${
        e instanceof Error ? e.message : String(e)
      })`,
    );
  }
  if (markets.length === 0) {
    throw new Error("no segment_markets_v4 in deployments/testnet.json — pass --market <id>");
  }
  let best: { id: string; segs: bigint } | null = null;
  for (const id of markets) {
    try {
      const m = await readMarket(client, id);
      if (!best || m.nextSegmentIndex > best.segs) {
        best = { id, segs: m.nextSegmentIndex };
      }
    } catch {
      // skip unreachable / wrong-type entries
    }
  }
  if (!best || best.segs < 2n) {
    throw new Error("no live v4 market with recorded segments found — pass --market <id>");
  }
  console.log(`(auto-selected live market with ${best.segs} segments from deployments/testnet.json)`);
  return best.id;
}

async function readMarket(client: RpcClient, marketId: string): Promise<MarketInfo> {
  const o = asObject(await client.getObject({ id: marketId, options: { showContent: true, showType: true } }));
  if (o.data == null) {
    throw new Error(
      `object ${marketId} was not found on-chain. Check the --market id — it must be the exact 0x-prefixed id of a live SegmentMarketV4 (copy it from deployments/testnet.json or SuiScan).`,
    );
  }
  const data = asObject(o.data);
  const content = asObject(data.content);
  if (content.dataType !== "moveObject") {
    throw new Error(`object ${marketId} is not a Move object`);
  }
  const type = asString(content.type);
  const m = /::segment_market_v4::SegmentMarketV4<(.+)>$/.exec(type);
  if (!m) {
    throw new Error(
      `object ${marketId} is not a SegmentMarketV4 (type: ${type}).\n` +
        "Looking for a v2/v3 ride? Use scripts/verify.ts instead.",
    );
  }
  const f = asObject(content.fields);
  const segments = asObject(asObject(f.segments).fields);
  const tableId = asString(asObject(segments.id).id);
  return {
    packageId: type.split("::")[0]!,
    collateralType: m[1]!,
    segmentsTableId: tableId,
    deadbandBps: asBig(f.deadband_bps),
    roundDurationSegments: asBig(f.round_duration_segments),
    nextSegmentIndex: asBig(f.next_segment_index),
    cachedRoundIndex: asBig(f.cached_round_index),
  };
}

/**
 * Read the market's v4.26 `RugConfig` dynamic field (key = b"rug_config").
 * Returns null when rug was never enabled on this market (the common case) —
 * that's not a failure, it just means there's no MARKET HALT to audit.
 */
async function readRugConfig(
  client: RpcClient,
  marketId: string,
): Promise<RugConfig | null> {
  try {
    const d = asObject(
      await client.getDynamicFieldObject({
        parentId: marketId,
        // b"rug_config" as a vector<u8> dynamic-field name — the RPC wants the
        // raw byte array (not the ASCII string) as the BCS value.
        name: {
          type: "vector<u8>",
          value: Array.from(new TextEncoder().encode("rug_config")) as unknown as string,
        },
      }),
    );
    const data = asObject(d.data);
    if (!data.content) return null;
    const content = asObject(data.content);
    const value = asObject(asObject(content.fields).value);
    const cf = asObject(value.fields);
    if (cf.rug_chance_bps == null) return null;
    // `rugged_at_segment` is `Option<u64>` → RPC renders Some(x) as { fields: { vec: [x] } }
    // or a bare value, and None as null/empty.
    const ruggedRaw = cf.rugged_at_segment;
    let rugged: bigint | null = null;
    if (ruggedRaw != null) {
      const inner = asObject(asObject(ruggedRaw).fields).vec;
      if (Array.isArray(inner) && inner.length > 0) rugged = asBig(inner[0]);
      else if (typeof ruggedRaw === "string" || typeof ruggedRaw === "number")
        rugged = asBig(ruggedRaw);
    }
    return { rugChanceBps: asBig(cf.rug_chance_bps), ruggedAtSegment: rugged };
  } catch {
    return null;
  }
}


async function readRide(client: RpcClient, rideId: string): Promise<RideInfo> {
  const o = asObject(await client.getObject({ id: rideId, options: { showContent: true, showType: true } }));
  if (o.data == null) {
    throw new Error(
      `object ${rideId} was not found on-chain. Check the --ride id — it must be the exact 0x-prefixed id of a closed SegmentRidePositionV4 (e.g. from a RideClosedV4 event or 'npm run rides:recent').`,
    );
  }
  const data = asObject(o.data);
  const content = asObject(data.content);
  if (content.dataType !== "moveObject") {
    throw new Error(`object ${rideId} is not a Move object`);
  }
  const type = asString(content.type);
  if (!/::segment_market_v4::SegmentRidePositionV4$/.test(type)) {
    throw new Error(
      `object ${rideId} is not a SegmentRidePositionV4 (type: ${type}).`,
    );
  }
  const f = asObject(content.fields);
  return {
    marketId: asString(f.market_id),
    entrySegmentIndex: asBig(f.entry_segment_index),
    roundIndex: asBig(f.round_index),
    upperBarrier: asBig(f.upper_barrier_price),
    lowerBarrier: asBig(f.lower_barrier_price),
    closed: Boolean(f.closed),
    closedAtMs: asBig(f.closed_at_ms),
    settlementKind: Number(asBig(f.settlement_kind)),
  };
}

/** Read one SegmentRecord from the market's Table<u64, SegmentRecord>. */
async function readSegment(
  client: RpcClient,
  tableId: string,
  k: bigint,
): Promise<SegmentRecord | null> {
  const d = asObject(
    await client.getDynamicFieldObject({
      parentId: tableId,
      name: { type: "u64", value: k.toString() },
    }),
  );
  const data = asObject(d.data);
  if (!data.content) return null;
  const content = asObject(data.content);
  const value = asObject(asObject(content.fields).value);
  const sf = asObject(value.fields);
  return {
    k,
    key: asBytes(sf.key),
    min: asBig(sf.min_price),
    max: asBig(sf.max_price),
    stateAfter: decodeWalkState(asObject(asObject(sf.state_after).fields)),
    recordedAtMs: asBig(sf.recorded_at_ms),
  };
}

// ── Touch + settlement (mirror of segment_market_v4.move) ───────────────────

export function effectiveBarriers(
  upper: bigint,
  lower: bigint,
  deadbandBps: bigint,
): { upEff: bigint; loEff: bigint } {
  const upMargin = (upper * deadbandBps) / 10_000n;
  const loMargin = (lower * deadbandBps) / 10_000n;
  return {
    upEff: upper + upMargin,
    loEff: loMargin >= lower ? 0n : lower - loMargin,
  };
}

/** Either-barrier touch over a single segment's recomputed extrema. The boundary
 *  is INCLUSIVE — a high/low exactly AT the effective barrier counts as a touch
 *  (max >= upEff, min <= loEff) — which decides a borderline win vs loss. */
export function segmentTouches(
  min: bigint,
  max: bigint,
  upEff: bigint,
  loEff: bigint,
): boolean {
  return max >= upEff || min <= loEff;
}

// ── Pretty-printing ──────────────────────────────────────────────────────────

function fmtPrice(v: bigint): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

function table(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cols: string[]) =>
    cols.map((c, i) => c.padStart(widths[i]!)).join("  ");
  console.log(line(headers));
  console.log(line(headers.map((h, i) => "-".repeat(widths[i] ?? h.length))));
  for (const r of rows) console.log(line(r));
}

// ── Core verify ──────────────────────────────────────────────────────────────

interface SegRow {
  k: bigint;
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  chainMin: bigint;
  chainMax: bigint;
  integrity: boolean;
  inWindow: boolean;
  touched: boolean;
}

/**
 * Verify segments [from, to). For each k we read the predecessor's carried
 * state from the chain (record[k-1].state_after, or genesis for k=0) and
 * confirm `expandSegment` reproduces the chain's (min, max, state_after).
 *
 * When `ride` is supplied, segments with `recorded_at_ms <= ride.closedAtMs`
 * are flagged in-window and run through the either-barrier touch predicate.
 */
async function verifySegments(
  client: RpcClient,
  market: MarketInfo,
  from: bigint,
  to: bigint,
  ride: RideInfo | null,
  genesis: WalkState | null,
): Promise<{ rows: SegRow[]; allIntegrityOk: boolean; touchedInWindow: boolean; maxInWindowK: bigint | null }> {
  const rows: SegRow[] = [];
  let allIntegrityOk = true;
  let touchedInWindow = false;
  let maxInWindowK: bigint | null = null;

  const eff = ride
    ? effectiveBarriers(ride.upperBarrier, ride.lowerBarrier, market.deadbandBps)
    : null;
  const rideRoundEnd = ride
    ? (ride.roundIndex + 1n) * market.roundDurationSegments
    : 0n;

  // Carried state going into segment `from`.
  let prevState: WalkState;
  if (from === 0n) {
    if (!genesis) {
      throw new Error(
        "verifying from segment 0 needs the genesis price — pass --home <micro-usd> " +
          "(the market's bootstrap home_price; default vol_regime is 1_000_000).",
      );
    }
    prevState = genesis;
  } else {
    const pred = await readSegment(client, market.segmentsTableId, from - 1n);
    if (!pred) {
      throw new Error(
        `predecessor segment ${from - 1n} not found in the market table; cannot ` +
          "establish the carried walk state. Pick a --from where k-1 exists.",
      );
    }
    prevState = pred.stateAfter;
  }

  for (let k = from; k < to; k++) {
    const rec = await readSegment(client, market.segmentsTableId, k);
    if (!rec) {
      // A missing segment AT OR ABOVE the recorded head is just the end of
      // history — stop. But a missing segment BELOW the head
      // (k < next_segment_index) is impossible on an honest chain:
      // record_segment_v4 assigns contiguous indices, so a hole here means the
      // chain dropped a segment it claims exists (tampering, or a prune trying
      // to hide a touch). Fail CLOSED rather than silently truncating the scan.
      if (k < market.nextSegmentIndex) {
        console.error(
          `\n  segment ${k} is missing although the market reports ` +
            `next_segment_index=${market.nextSegmentIndex} — a gap below the recorded head. ` +
            `The chain dropped a segment it claims exists; the audit cannot pass.`,
        );
        allIntegrityOk = false;
      }
      break; // can't carry the walk state across a gap either way
    }
    // Bound the scan. We integrity-check at least the entry round (so a tampered
    // candle anywhere in it is caught), then keep going while segments are still
    // in the ride's window (`recorded_at_ms <= closed_at_ms`, monotonic) so a
    // ride HELD ACROSS A ROUND BOUNDARY is covered through its close — without
    // walking the whole market. Stop once we're past BOTH the entry round and
    // the close window.
    if (ride && k >= rideRoundEnd && rec.recordedAtMs > ride.closedAtMs) {
      break;
    }
    const r = expandSegment(prevState, rec.key);
    const integrity =
      r.min === rec.min &&
      r.max === rec.max &&
      r.newState.price === rec.stateAfter.price &&
      r.newState.volRegime === rec.stateAfter.volRegime &&
      r.newState.momentum.mag === rec.stateAfter.momentum.mag &&
      r.newState.momentum.neg === rec.stateAfter.momentum.neg &&
      r.newState.patternId === rec.stateAfter.patternId &&
      r.newState.candlesRemaining === rec.stateAfter.candlesRemaining;
    allIntegrityOk = allIntegrityOk && integrity;

    let inWindow = false;
    let touched = false;
    if (ride && eff) {
      inWindow = k >= ride.entrySegmentIndex && rec.recordedAtMs <= ride.closedAtMs;
      if (inWindow) {
        maxInWindowK = k;
        touched = segmentTouches(r.min, r.max, eff.upEff, eff.loEff);
        touchedInWindow = touchedInWindow || touched;
      }
    }

    rows.push({
      k,
      open: r.candles[0]?.open ?? prevState.price,
      high: r.max,
      low: r.min,
      close: r.candles[r.candles.length - 1]?.close ?? r.newState.price,
      chainMin: rec.min,
      chainMax: rec.max,
      integrity,
      inWindow,
      touched,
    });
    prevState = r.newState;
  }

  return { rows, allIntegrityOk, touchedInWindow, maxInWindowK };
}

/**
 * Mirror `decide_settlement`'s ordering: ABORTED_REFUND (handled by caller) >
 * rug→EXPIRED_LOSS > TOUCH_WIN > round-expiry EXPIRED_LOSS > CASHOUT. The rug
 * beats a later touch — a ride open when the halt fired loses, full stop.
 */
export function deriveSettlementKind(
  rugAffectsRide: boolean,
  touchedInWindow: boolean,
  maxInWindowK: bigint | null,
  ride: RideInfo,
  roundDurationSegments: bigint,
): number {
  if (rugAffectsRide) return SETTLEMENT_EXPIRED_LOSS;
  if (touchedInWindow) return SETTLEMENT_TOUCH_WIN;
  const rideRoundEnd = (ride.roundIndex + 1n) * roundDurationSegments;
  // next_segment_index@close == (last in-window k) + 1.
  const nextAtClose = maxInWindowK === null ? ride.entrySegmentIndex : maxInWindowK + 1n;
  if (nextAtClose >= rideRoundEnd) return SETTLEMENT_EXPIRED_LOSS;
  return SETTLEMENT_CASHOUT;
}

/**
 * Find the round's MARKET HALT by RE-DERIVING the keccak rug-roll for each
 * recorded segment from the round's start up to the ride's close, returning the
 * FIRST segment that rolled a halt — exactly how Move arms `rugged_at_segment`
 * (sticky, once per round). Scans from round start (not the ride's entry) so a
 * rug that fired before the ride opened is correctly attributed: such a ride
 * "bet into an already-halted round" and is NOT re-halted (entry > ruggedSeg).
 */
async function findRoundRug(
  client: RpcClient,
  market: MarketInfo,
  marketId: string,
  ride: RideInfo,
  rug: RugConfig,
  scanEnd: bigint,
): Promise<{ ruggedSeg: bigint; roll: bigint; round: bigint } | null> {
  if (rug.rugChanceBps <= 0n) return null;
  const dur = market.roundDurationSegments;
  // `decide_settlement` reads `rugged_at_segment` for the round the market is in
  // AT CLOSE (`ensure_round_current` clears it on every round-roll), and the rug
  // roll's keccak preimage includes the round index. So the rug that can catch
  // this ride is the CLOSE round's first qualifier — NOT the entry round's. For
  // an in-round close this is the entry round, i.e. today's behaviour.
  const closeRound = dur > 0n ? scanEnd / dur : ride.roundIndex;
  const roundStart = closeRound * dur;
  for (let k = roundStart; k < scanEnd; k++) {
    const rec = await readSegment(client, market.segmentsTableId, k);
    if (!rec) continue;
    const r = rollRugFired(rec.key, marketId, closeRound, rug.rugChanceBps);
    if (r.fired) return { ruggedSeg: k, roll: r.roll, round: closeRound };
  }
  return null;
}

async function verify(args: Args): Promise<boolean> {
  const synthetic = args.rpc.startsWith("mock://");
  const synthMode: SynthMode = args.rpc.includes("rugtouch")
    ? "rugtouch"
    : args.rpc.includes("crossloss")
    ? "crossloss"
    : args.rpc.includes("crosswin")
      ? "crosswin"
      : args.rpc.includes("rug")
        ? "rug"
        : args.rpc.includes("tamper")
          ? "tamper"
          : args.rpc.includes("gap")
            ? "gap"
            : args.rpc.includes("touchlow")
              ? "touchlow"
              : args.rpc.includes("touch")
                ? "touch"
                : args.rpc.includes("aborted")
                  ? "aborted"
                  : "honest";
  const client: RpcClient = synthetic
    ? buildSyntheticClient(synthMode)
    : makeResilientClient([args.rpc, ...FALLBACK_RPCS]);

  const marketId = synthetic
    ? SYNTH_MARKET
    : (args.market ?? (await discoverLiveMarket(client)));
  const market = await readMarket(client, marketId);

  console.log(`network:  ${synthetic ? "synthetic (offline)" : args.rpc}`);
  console.log(`market:   ${marketId}${synthetic ? "" : `  ↗ ${suiscan("object", marketId)}`}`);
  console.log(`package:  ${market.packageId}${synthetic ? "" : `  ↗ ${suiscan("object", market.packageId)}`}`);
  console.log(
    `segments: ${market.nextSegmentIndex} recorded · deadband ${market.deadbandBps}bps · round ${market.roundDurationSegments} seg`,
  );

  // ── Ride mode ──────────────────────────────────────────────────────────
  if (args.ride) {
    const rideId = synthetic ? SYNTH_RIDE : args.ride;
    const ride = await readRide(client, rideId);
    // Input guard: a mismatched --market/--ride pair (a copy-paste slip) would
    // otherwise scan this market's candles against another ride's barriers/round
    // and print a bogus "FAIL — the chain lied". Reject it as user error instead.
    if (!sameId(ride.marketId, marketId)) {
      console.error(
        `\n  ride ${rideId} belongs to market ${ride.marketId}, not ${marketId}.\n` +
          `  Pass the --market this ride was opened on (this is a mismatched pair, not a dishonest chain).`,
      );
      return false;
    }
    console.log(`ride:     ${rideId}${synthetic ? "" : `  ↗ ${suiscan("object", rideId)}`}`);
    console.log(
      `          round ${ride.roundIndex} · entry segment ${ride.entrySegmentIndex} · ` +
        `barriers [${fmtPrice(ride.lowerBarrier)}, ${fmtPrice(ride.upperBarrier)}]`,
    );

    if (!ride.closed || ride.settlementKind === SETTLEMENT_OPEN) {
      console.log("");
      console.log(`Ride ${rideId} is still OPEN — no settlement to verify yet.`);
      return true;
    }
    if (ride.settlementKind === SETTLEMENT_ABORTED_REFUND) {
      console.log("");
      console.log(
        "Ride settled ABORTED_REFUND — an abort is an external vault event, not " +
          "derivable from the price path. Refund is 1:1 by construction; nothing to replay.",
      );
      return true;
    }

    const rideRoundEnd = (ride.roundIndex + 1n) * market.roundDurationSegments;
    // Scan to the chain's head; verifySegments stops at the ride's close window
    // (recorded_at_ms > closed_at_ms). NOT capped at rideRoundEnd — a ride held
    // across a round boundary is settled against the CLOSE round, so we must see
    // the segments past its entry round to attribute the rug + touch correctly.
    const to = market.nextSegmentIndex;
    const genesis =
      ride.entrySegmentIndex === 0n && args.home !== undefined
        ? newState(args.home, DEFAULT_VOL_REGIME_INIT, args.home)
        : null;

    const { rows, allIntegrityOk, touchedInWindow, maxInWindowK } =
      await verifySegments(client, market, ride.entrySegmentIndex, to, ride, genesis);

    console.log("");
    table(
      ["k", "open", "high", "low", "close", "chainHi", "chainLo", "win?", "touch", "integ"],
      rows.map((r) => [
        r.k.toString(),
        fmtPrice(r.open),
        fmtPrice(r.high),
        fmtPrice(r.low),
        fmtPrice(r.close),
        fmtPrice(r.chainMax),
        fmtPrice(r.chainMin),
        r.inWindow ? "yes" : "—",
        r.inWindow ? (r.touched ? "TOUCH" : "no") : "—",
        r.integrity ? "ok" : "FAIL",
      ]),
    );

    // ── v4.26 MARKET HALT (rug) ──────────────────────────────────────────────
    // The chain routes a rugged ride to EXPIRED_LOSS by reading
    // `rugged_at_segment` BEFORE the touch scan (a rug beats a later touch) —
    // independent of any RugFiredV4 event (which some markets never emit). Rather
    // than skip the verdict on rug markets, we RE-DERIVE the halt from the
    // on-chain segment keys, so even the house edge is provable, not trusted.
    const scanEnd = maxInWindowK === null ? ride.entrySegmentIndex : maxInWindowK + 1n;
    const rug = await readRugConfig(client, marketId);
    let rugRollOk = true;
    let rugAffectsRide = false;
    if (rug && rug.rugChanceBps > 0n) {
      const fire = await findRoundRug(client, market, marketId, ride, rug, scanEnd);
      const ruggedSeg = fire ? fire.ruggedSeg : null;
      rugAffectsRide = ruggedSeg !== null && ride.entrySegmentIndex <= ruggedSeg;
      // Cross-check our re-derived fire against the chain's stored field (only
      // meaningful for the market's CURRENT round). Our scan is bounded by the
      // ride's close (`scanEnd`): if the chain's fire is inside that window we
      // must reproduce it; if it fired AFTER this ride closed (≥ scanEnd) our
      // window is correctly empty — that's consistent, not a mismatch.
      const closeRound = fire ? fire.round : ride.roundIndex;
      let cross = "no chain field to cross-check (re-derived from keys)";
      if (rug.ruggedAtSegment != null && closeRound === market.cachedRoundIndex) {
        const fieldSeg = rug.ruggedAtSegment;
        const expected = fieldSeg < scanEnd ? fieldSeg : null;
        const ok = expected === ruggedSeg;
        if (!ok) rugRollOk = false;
        cross =
          fieldSeg < scanEnd
            ? `chain rugged_at_segment=${fieldSeg} (${ok ? "match" : "MISMATCH"})`
            : `chain rugged_at_segment=${fieldSeg} fired after this ride closed @ ${scanEnd} (consistent)`;
      }
      console.log("");
      if (fire) {
        console.log(
          `MARKET HALT:       rug fired @ segment ${fire.ruggedSeg} (round ${fire.round}) — ` +
            `keccak roll=${fire.roll} < rug_chance_bps=${rug.rugChanceBps} (HONEST); ${cross}`,
        );
        console.log(
          `                   ${rugAffectsRide ? `ride entered @ ${ride.entrySegmentIndex} ≤ ${fire.ruggedSeg} → halt applies → EXPIRED_LOSS` : `ride entered @ ${ride.entrySegmentIndex} > ${fire.ruggedSeg} → bet into an already-halted round; halt does not re-apply`}`,
        );
      } else {
        console.log(
          `rug:               enabled (rug_chance_bps=${rug.rugChanceBps}) — no segment in this round's window rolled a halt`,
        );
      }
    }

    // Parity with the market-audit 0-segment guard (~line 983): a closed ride whose
    // window replayed ZERO candles verified NOTHING — a "trust nothing" tool must not
    // print "honest" having checked nothing. (A pruned/missing entry-round is already
    // caught fail-closed via allIntegrityOk=false → FAIL; this covers the degenerate
    // zero-candle hold or an out-of-range window where integrity stayed true.)
    if (rows.length === 0) {
      console.log("");
      console.log(
        "INCONCLUSIVE — 0 segments in this ride's window; nothing was replayed " +
          "(degenerate zero-candle hold, or an out-of-range window). This is NOT a pass.",
      );
      return false;
    }

    const derived = deriveSettlementKind(
      rugAffectsRide,
      touchedInWindow,
      maxInWindowK,
      ride,
      market.roundDurationSegments,
    );
    const verdictMatch = derived === ride.settlementKind;

    // Cross-round late close: a ride abandoned past its round end is settled
    // late by `decide_settlement`, which reads the CURRENT round's
    // `rugged_at_segment` (cleared on every round-roll) and scans for a touch
    // over `[entry, next_segment_index@close)` — a window that, for a late
    // close, spills into LATER rounds. We bound OUR scan to the ride's own
    // round, so the chain's verdict can diverge from ours in exactly two ways,
    // both unreconstructable-but-honest:
    //   • chain EXPIRED_LOSS, ours not — a LATER round's rug wiped the ride
    //     (that rug value is gone from the chain).
    //   • chain TOUCH_WIN, ours not, and we found NO touch in-round — the price
    //     touched the barrier in a LATER round, outside our bounded scan.
    // Neither is "the chain lied": the candles and the rug-roll honesty are
    // still fully verified; the verdict just isn't independently re-derivable.
    // Normal play closes a ride in its own round → derived == settlementKind →
    // this never trips; it only affects rides left open across rounds
    // (bot/crank-expired test traffic). Adversarial lies are untouched: a
    // tampered candle is an integrity FAIL, and a chain claiming a touch that
    // verify CAN reproduce in-round still matches (or FAILs if it can't and the
    // direction isn't this cross-round signature).
    const crossRoundClose =
      (ride.settlementKind === SETTLEMENT_EXPIRED_LOSS && derived !== SETTLEMENT_EXPIRED_LOSS) ||
      (ride.settlementKind === SETTLEMENT_TOUCH_WIN && derived !== SETTLEMENT_TOUCH_WIN && !touchedInWindow);
    const verdictCheckable = verdictMatch || !crossRoundClose;
    const pass = allIntegrityOk && rugRollOk && (verdictMatch || crossRoundClose);

    console.log("");
    console.log(`extrema replay:    ${allIntegrityOk ? "match (every segment)" : "MISMATCH"}`);
    console.log(`off-chain verdict: ${SETTLEMENT_NAME[derived] ?? derived}`);
    console.log(`on-chain verdict:  ${SETTLEMENT_NAME[ride.settlementKind] ?? ride.settlementKind}`);
    if (verdictMatch) {
      console.log("verdict:           match");
    } else if (crossRoundClose) {
      const why =
        ride.settlementKind === SETTLEMENT_EXPIRED_LOSS
          ? "the chain force-settled EXPIRED_LOSS against a LATER round's rug"
          : "the price touched the barrier in a LATER round, outside this ride's round";
      console.log(
        `verdict:           not independently checkable — ride opened round ${ride.roundIndex} (in-round: ${SETTLEMENT_NAME[derived] ?? derived}) but was abandoned past its round end; ${why} (later-round state is cleared on-chain, unrecoverable). Candles + rug roll verified honest.`,
      );
    } else {
      console.log("verdict:           MISMATCH");
    }
    if (pass && !verdictCheckable) {
      console.log("\nPASS — candles honest; verdict not independently checkable (cross-round late close).");
    } else {
      console.log(pass ? "\nPASS — the chain was honest." : "\nFAIL — the chain lied.");
    }
    return pass;
  }

  // ── Market-audit mode ──────────────────────────────────────────────────
  let from = args.from ?? 0n;
  let to = args.to ?? market.nextSegmentIndex;
  if (args.from === undefined && args.to === undefined) {
    // Default: the most recent `--window` segments (k-1 must exist, so from>=1).
    const w = BigInt(Math.max(1, args.window));
    from = market.nextSegmentIndex > w ? market.nextSegmentIndex - w : 1n;
    to = market.nextSegmentIndex;
  }
  if (to <= from) {
    console.log("\nNo segments in range — nothing to verify.");
    return true;
  }
  const genesis =
    from === 0n && args.home !== undefined
      ? newState(args.home, DEFAULT_VOL_REGIME_INIT, args.home)
      : null;

  const { rows, allIntegrityOk } = await verifySegments(
    client,
    market,
    from,
    to,
    null,
    genesis,
  );

  console.log("");
  console.log(`auditing segments [${from}, ${from + BigInt(rows.length)})`);
  console.log("");
  table(
    ["k", "open", "high", "low", "close", "chainHi", "chainLo", "integ"],
    rows.map((r) => [
      r.k.toString(),
      fmtPrice(r.open),
      fmtPrice(r.high),
      fmtPrice(r.low),
      fmtPrice(r.close),
      fmtPrice(r.chainMax),
      fmtPrice(r.chainMin),
      r.integrity ? "ok" : "FAIL",
    ]),
  );
  console.log("");
  // Vacuous-pass guard: `allIntegrityOk` starts true and only flips on a
  // mismatch, so a range with ZERO recorded segments (idle/empty market,
  // segments pruned, or an out-of-range --from/--to) would otherwise print
  // "the chain was honest" having verified NOTHING. Refuse to bless a
  // 0-segment audit. (Same class as the audit:deployment / audit:ride /
  // check:rugs guards — #410/#421/#423.)
  if (rows.length === 0) {
    console.log(
      "INCONCLUSIVE — 0 segments in range; nothing was verified " +
        "(market idle/empty, segments pruned, or an out-of-range --from/--to). " +
        "This is NOT a pass — pick a populated round/range and re-run.",
    );
    return false;
  }
  console.log(
    `extrema replay: ${allIntegrityOk ? `match — all ${rows.length} segments reproduce from the chain's own keys` : "MISMATCH"}`,
  );
  console.log(allIntegrityOk ? "\nPASS — the chain was honest." : "\nFAIL — the chain lied.");
  return allIntegrityOk;
}

// ── Synthetic client (offline, deterministic) ───────────────────────────────
//
// Generates a self-consistent v4 market: a real seeded walk forward from a
// genesis price, storing each segment's key + extrema + state_after exactly as
// `record_segment` would. `tamper` corrupts one segment's max so the verifier
// catches the lie (`--rpc mock://tamper-v4`). `rug` enables a MARKET HALT at
// segment 0 (rug_chance_bps=10_000 ⇒ the keccak roll always fires) with a ride
// entered at 0, so the rug-settlement wiring is exercised offline in CI
// (`--rpc mock://rug-v4` ⇒ EXPIRED_LOSS, PASS).

// `crossloss`/`crosswin` reproduce the cross-round late-close artifact (#297,
// #303): an honest no-touch walk, but the ride's on-chain settlement_kind is
// EXPIRED_LOSS / TOUCH_WIN respectively (as if a LATER round's rug wiped it, or
// a later-round touch won it — state the verifier can't reconstruct). The
// in-round derivation is CASHOUT, so the verdict mismatches; the verifier must
// PASS with "not independently checkable", NOT cry "chain lied".
type SynthMode = "honest" | "tamper" | "rug" | "crossloss" | "crosswin" | "gap" | "touch" | "touchlow" | "aborted" | "rugtouch";

const SYNTH_MARKET = "0x" + "5e6".padEnd(64, "0");
const SYNTH_RIDE = "0x" + "47de".padEnd(64, "0");
const SYNTH_PKG = "0xabc";
const SYNTH_HOME = 1_000_000_000n; // $1000.00
const SYNTH_ROUND_DUR = 75n;
const SYNTH_DEADBAND = 20n;
const SYNTH_SEG_COUNT = 8;
const SYNTH_BARRIER_OFFSET_BPS = 1000n; // ±10%

interface SynthSeg {
  key: Uint8Array;
  min: bigint;
  max: bigint;
  stateAfter: WalkState;
  recordedAtMs: bigint;
}

function buildSyntheticClient(mode: SynthMode): RpcClient {
  const tamper = mode === "tamper";
  const rug = mode === "rug";
  const crossloss = mode === "crossloss";
  const crosswin = mode === "crosswin";
  const gap = mode === "gap"; // drop segment 5 (a hole below the recorded head)
  const touch = mode === "touch"; // upper barrier inside the up-excursion → TOUCH_WIN
  const touchlow = mode === "touchlow"; // lower barrier inside seg-0's deep dip → TOUCH_WIN
  const aborted = mode === "aborted"; // honest candles, settlement_kind = ABORTED_REFUND
  const rugtouch = mode === "rugtouch"; // rug AND touch in one segment → rug wins (EXPIRED)
  // Deterministic keys: byte i of segment k = (k*7 + i*3 + 11) mod 251.
  const segs: SynthSeg[] = [];
  let state = newState(SYNTH_HOME, DEFAULT_VOL_REGIME_INIT, SYNTH_HOME);
  const startMs = 1_700_000_000_000n;
  for (let k = 0; k < SYNTH_SEG_COUNT; k++) {
    const key = new Uint8Array(32);
    for (let i = 0; i < 32; i++) key[i] = (k * 7 + i * 3 + 11) % 251;
    const r = expandSegment(state, key);
    segs.push({
      key,
      min: r.min,
      max: r.max,
      stateAfter: r.newState,
      recordedAtMs: startMs + BigInt(k) * 400n,
    });
    state = r.newState;
  }
  // Tamper: inflate the high of segment 5 by $5 — the chain "claims" a wick
  // that the seeded path never produced.
  if (tamper) segs[5]!.max = segs[5]!.max + 5_000_000n;

  // Ride: opens at segment 2, closes at segment 4 (recorded_at <= closedAt),
  // barriers ±10% around home. With this seed no barrier is touched in-window,
  // so the honest verdict is CASHOUT.
  const upper = SYNTH_HOME + (SYNTH_HOME * SYNTH_BARRIER_OFFSET_BPS) / 10_000n;
  const lower = SYNTH_HOME - (SYNTH_HOME * SYNTH_BARRIER_OFFSET_BPS) / 10_000n;
  // Touch mode: place the upper barrier halfway between home and the walk's
  // in-window high (≈1.030×home with this seed), so the price wicks UP through
  // it (even after the +deadband) and the honest verdict is TOUCH_WIN. The
  // lower barrier stays at −10% (untouched). Locks the jackpot-verdict path.
  const winMax = [segs[2]!, segs[3]!, segs[4]!].reduce((a, s) => (s.max > a ? s.max : a), 0n);
  const touchUpper = SYNTH_HOME + (winMax - SYNTH_HOME) / 2n;
  // touchlow mode enters at segment 0 (whose low dips ~3% below home with this
  // seed), with the lower barrier halfway down that dip — so the price wicks
  // DOWN through it (past −deadband) and the honest verdict is TOUCH_WIN. This
  // exercises the lower-barrier detection (min ≤ effective_lower), a separate
  // code path from the upper touch above.
  const touchLower = SYNTH_HOME - (SYNTH_HOME - segs[0]!.min) / 2n;
  const rideClosedAt = segs[4]!.recordedAtMs;

  function walkStateJson(w: WalkState): Record<string, unknown> {
    return {
      fields: {
        price: w.price.toString(),
        momentum: { fields: { neg: w.momentum.neg, mag: w.momentum.mag.toString() } },
        vol_regime: w.volRegime.toString(),
        home: w.home.toString(),
        pattern_id: w.patternId.toString(),
        candles_remaining: w.candlesRemaining.toString(),
      },
    };
  }

  const TABLE_ID = "0x" + "7ab".padEnd(64, "0");

  return {
    async getObject(a) {
      if (a.id === SYNTH_MARKET) {
        return {
          data: {
            objectId: SYNTH_MARKET,
            content: {
              dataType: "moveObject",
              type: `${SYNTH_PKG}::segment_market_v4::SegmentMarketV4<0x2::sui::SUI>`,
              fields: {
                segments: { fields: { id: { id: TABLE_ID }, size: String(SYNTH_SEG_COUNT) } },
                deadband_bps: SYNTH_DEADBAND.toString(),
                round_duration_segments: SYNTH_ROUND_DUR.toString(),
                next_segment_index: String(SYNTH_SEG_COUNT),
                cached_round_index: "0",
              },
            },
          },
        };
      }
      if (a.id === SYNTH_RIDE) {
        return {
          data: {
            objectId: SYNTH_RIDE,
            content: {
              dataType: "moveObject",
              type: `${SYNTH_PKG}::segment_market_v4::SegmentRidePositionV4`,
              fields: {
                market_id: SYNTH_MARKET,
                // Rug mode: enter at segment 0 so the seg-0 halt applies; the
                // chain then settles EXPIRED_LOSS. Honest/tamper: enter at 2.
                entry_segment_index: rug || touchlow || rugtouch ? "0" : "2",
                round_index: "0",
                upper_barrier_price: (touch ? touchUpper : upper).toString(),
                lower_barrier_price: (touchlow || rugtouch ? touchLower : lower).toString(),
                closed: true,
                closed_at_ms: rideClosedAt.toString(),
                settlement_kind: String(
                  rug || crossloss || rugtouch
                    ? SETTLEMENT_EXPIRED_LOSS
                    : crosswin || touch || touchlow
                      ? SETTLEMENT_TOUCH_WIN
                      : aborted
                        ? SETTLEMENT_ABORTED_REFUND
                        : SETTLEMENT_CASHOUT,
                ),
              },
            },
          },
        };
      }
      return { data: null };
    },
    async getDynamicFieldObject(a) {
      // Rug config lives under the market UID (not the segments Table). Return a
      // RugConfig with an always-firing chance so the seg-0 halt is deterministic.
      if ((rug || rugtouch) && a.parentId === SYNTH_MARKET) {
        return {
          data: {
            objectId: "0x" + "c0nf16".padEnd(64, "0"),
            content: {
              fields: {
                value: {
                  fields: {
                    rug_chance_bps: "10000",
                    rugged_at_segment: { fields: { vec: ["0"] } },
                  },
                },
              },
            },
          },
        };
      }
      if (a.parentId !== TABLE_ID) return { data: null };
      const k = Number(a.name.value);
      // gap mode: segment 5 is missing even though next_segment_index=8 claims it
      // exists — the verifier must FAIL closed, not silently truncate the scan.
      if (gap && k === 5) return { data: null };
      if (k < 0 || k >= segs.length) return { data: null };
      const s = segs[k]!;
      return {
        data: {
          objectId: "0x" + `f1e1d${k}`.padEnd(64, "0"),
          content: {
            fields: {
              value: {
                fields: {
                  key: Array.from(s.key),
                  min_price: s.min.toString(),
                  max_price: s.max.toString(),
                  state_after: walkStateJson(s.stateAfter),
                  recorded_at_ms: s.recordedAtMs.toString(),
                },
              },
            },
          },
        },
      };
    },
  };
}

// Run only when invoked directly (CLI / npm script / spawned by audit-ride etc.),
// not when imported — verify-v4 was the only verifier still executing on import,
// a latent footgun for any future test/tool that imports its helpers. Matches the
// guard every sibling script already uses.
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  verify(parseArgs(process.argv.slice(2)))
    .then((ok) => {
      process.exitCode = ok ? 0 : 1;
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
