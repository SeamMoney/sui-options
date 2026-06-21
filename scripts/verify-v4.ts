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
 * Settlement mirror: `decide_settlement` in `move/sources/segment_market_v4.move`,
 * full precedence — RUG routing (v4.26) → TOUCH_WIN(1) on either barrier →
 * EXPIRED_LOSS(3) if the round closed first → CASHOUT(2); ABORTED_REFUND(4) is
 * taken from the chain. The rug segment is re-derived deterministically from
 * each segment's on-chain key (same prune-proof, no-event basis as the candles
 * — see `rollRugFires`), and applied with the chain's close-time rule. The
 * ride's live window is bounded by `recorded_at_ms <= closed_at_ms` (no event
 * lookup), so the touch scan matches the chain's `[entry, next_segment_index@close)`.
 */
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import {
  expandSegment,
  newState,
  type WalkState,
} from "../sdk/src/seededPath.js";

const DEFAULT_RPC = "https://sui-testnet-rpc.publicnode.com";
const DEFAULT_VOL_REGIME_INIT = 1_000_000n;
const DEFAULT_WINDOW = 32;

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
  // Synthetic modes synthesize a market id, so --market is optional there.
  const synthetic = (out.rpc ?? "").startsWith("mock://");
  if (!synthetic && !out.market) usage();
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
    // value is `string` for primitive keys (u64) and `number[]` for byte-vector
    // keys (vector<u8>, e.g. the b"rug_config" RugConfig field).
    name: { type: string; value: string | number[] };
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
  marketId: string;
  packageId: string;
  collateralType: string;
  segmentsTableId: string;
  deadbandBps: bigint;
  roundDurationSegments: bigint;
  nextSegmentIndex: bigint;
  /** v4.26 rug-pull house edge — read from the market's RugConfig dynamic field. */
  rugEnabled: boolean;
  rugChanceBps: bigint;
}

const RUG_CONFIG_KEY_BYTES = Array.from(
  new TextEncoder().encode("rug_config"),
);

/**
 * Re-derive the on-chain `roll_rug` (segment_market_v4.move) for one segment,
 * deterministically from its key — NO event lookup, prune-proof like the rest
 * of this verifier. The rug fires for the round's FIRST segment whose roll
 * passes the threshold:
 *   roll = LE-u64(keccak256(segment_key || market_id_bytes || bcs_u64(round)))
 *   fires iff (roll % 10000) < rug_chance_bps
 * `bcs_u64` is little-endian (Sui BCS) and the first 8 bytes are read LE
 * (matching Move `bcs::peel_u64`).
 */
function rollRugFires(
  segmentKey: Uint8Array,
  marketIdBytes: Uint8Array,
  round: bigint,
  rugChanceBps: bigint,
): boolean {
  if (rugChanceBps <= 0n) return false;
  const roundBytes = new Uint8Array(8);
  let r = round;
  for (let i = 0; i < 8; i++) {
    roundBytes[i] = Number(r & 0xffn);
    r >>= 8n;
  }
  const buf = new Uint8Array(
    segmentKey.length + marketIdBytes.length + 8,
  );
  buf.set(segmentKey, 0);
  buf.set(marketIdBytes, segmentKey.length);
  buf.set(roundBytes, segmentKey.length + marketIdBytes.length);
  const h = keccak_256(buf);
  let roll = 0n;
  for (let i = 7; i >= 0; i--) roll = (roll << 8n) | BigInt(h[i]!);
  return roll % 10_000n < rugChanceBps;
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * The segment the ride's round was rugged at — the FIRST segment in
 * [roundStart, scanEnd) whose deterministic roll fires — or null if the round
 * wasn't rugged before the ride closed. Reads only segment keys from the Table
 * (no events). `scanEnd` bounds the search to "before the ride closed" so a rug
 * that fires AFTER a ride self-closes doesn't retroactively catch it.
 */
async function findRoundRugSegment(
  client: RpcClient,
  market: MarketInfo,
  roundStart: bigint,
  scanEnd: bigint,
): Promise<bigint | null> {
  if (!market.rugEnabled || market.rugChanceBps <= 0n) return null;
  const round = market.roundDurationSegments > 0n
    ? roundStart / market.roundDurationSegments
    : 0n;
  const marketIdBytes = hexToBytes(market.marketId);
  for (let k = roundStart; k < scanEnd; k++) {
    const rec = await readSegment(client, market.segmentsTableId, k);
    if (!rec) continue;
    if (rollRugFires(rec.key, marketIdBytes, round, market.rugChanceBps)) {
      return k; // fires once per round → first hit wins
    }
  }
  return null;
}

export interface RideInfo {
  entrySegmentIndex: bigint;
  roundIndex: bigint;
  upperBarrier: bigint;
  lowerBarrier: bigint;
  closed: boolean;
  closedAtMs: bigint;
  settlementKind: number;
}

async function readMarket(client: RpcClient, marketId: string): Promise<MarketInfo> {
  const o = asObject(await client.getObject({ id: marketId, options: { showContent: true, showType: true } }));
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

  // v4.26 rug-pull config lives in a `b"rug_config"` dynamic field on the
  // market (added under a COMPATIBLE upgrade). Absent on markets that never
  // called enable_rug → rug disabled. Read it once so ride settlement can
  // re-derive the deterministic rug roll (prune-proof, no events).
  let rugEnabled = false;
  let rugChanceBps = 0n;
  try {
    const rc = asObject(
      await client.getDynamicFieldObject({
        parentId: marketId,
        name: { type: "vector<u8>", value: RUG_CONFIG_KEY_BYTES },
      }),
    );
    const rcFields = asObject(asObject(asObject(asObject(rc.data).content).fields).value);
    const cfg = asObject(rcFields.fields);
    if (cfg.rug_chance_bps !== undefined) {
      rugEnabled = true;
      rugChanceBps = asBig(cfg.rug_chance_bps);
    }
  } catch {
    // No rug config (or a node that can't serve the field) → treat as disabled.
  }

  return {
    marketId,
    packageId: type.split("::")[0]!,
    collateralType: m[1]!,
    segmentsTableId: tableId,
    deadbandBps: asBig(f.deadband_bps),
    roundDurationSegments: asBig(f.round_duration_segments),
    nextSegmentIndex: asBig(f.next_segment_index),
    rugEnabled,
    rugChanceBps,
  };
}

async function readRide(client: RpcClient, rideId: string): Promise<RideInfo> {
  const o = asObject(await client.getObject({ id: rideId, options: { showContent: true, showType: true } }));
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

function effectiveBarriers(
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

/** Either-barrier touch over a single segment's recomputed extrema. */
function segmentTouches(
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
    if (!rec) break; // ran off the end of recorded history
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
 * Mirror `decide_settlement`'s precedence (ABORTED handled by the caller):
 *   rug routing → touch-either → time-expiry → cashout.
 *
 * Rug routing (v4.26) is checked FIRST and BEFORE touch — exactly as the Move
 * does — because the contract reads `rugged_at_segment` at close time and a
 * caught ride loses regardless of any barrier touch. `rugApplies` already
 * encodes the timing rule (entered at/before the rug AND still open when it
 * fired); see the caller.
 */
function deriveSettlementKind(
  rugApplies: boolean,
  touchedInWindow: boolean,
  nextAtClose: bigint,
  ride: RideInfo,
  roundDurationSegments: bigint,
): number {
  if (rugApplies) return SETTLEMENT_EXPIRED_LOSS;
  if (touchedInWindow) return SETTLEMENT_TOUCH_WIN;
  const rideRoundEnd = (ride.roundIndex + 1n) * roundDurationSegments;
  if (nextAtClose >= rideRoundEnd) return SETTLEMENT_EXPIRED_LOSS;
  return SETTLEMENT_CASHOUT;
}

async function verify(args: Args): Promise<boolean> {
  const synthetic = args.rpc.startsWith("mock://");
  const client: RpcClient = synthetic
    ? buildSyntheticClient(args.rpc.includes("tamper"))
    : (new SuiJsonRpcClient({ url: args.rpc, network: "testnet" }) as unknown as RpcClient);

  const marketId = synthetic ? SYNTH_MARKET : args.market!;
  const market = await readMarket(client, marketId);

  console.log(`network:  ${synthetic ? "synthetic (offline)" : args.rpc}`);
  console.log(`market:   ${marketId}`);
  console.log(`package:  ${market.packageId}`);
  console.log(
    `segments: ${market.nextSegmentIndex} recorded · deadband ${market.deadbandBps}bps · round ${market.roundDurationSegments} seg`,
  );

  // ── Ride mode ──────────────────────────────────────────────────────────
  if (args.ride) {
    const rideId = synthetic ? SYNTH_RIDE : args.ride;
    const ride = await readRide(client, rideId);
    console.log(`ride:     ${rideId}`);
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
    const to = rideRoundEnd < market.nextSegmentIndex ? rideRoundEnd : market.nextSegmentIndex;
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

    // next_segment_index@close == (last in-window k) + 1.
    const nextAtClose =
      maxInWindowK === null ? ride.entrySegmentIndex : maxInWindowK + 1n;

    // v4.26 rug routing — re-derive the round's rug segment from segment keys
    // (deterministic, prune-proof) and apply the chain's close-time rule: a rug
    // catches the ride only if it entered at/before the rug AND was still open
    // when it fired (rugSeg < nextAtClose). A ride that touched and self-closed
    // BEFORE the rug fired is a legitimate TOUCH_WIN even if the round later
    // rugged.
    const roundStart = ride.roundIndex * market.roundDurationSegments;
    const rugSeg = await findRoundRugSegment(client, market, roundStart, nextAtClose);
    const rugApplies =
      rugSeg !== null &&
      ride.entrySegmentIndex <= rugSeg &&
      rugSeg < nextAtClose;

    const derived = deriveSettlementKind(
      rugApplies,
      touchedInWindow,
      nextAtClose,
      ride,
      market.roundDurationSegments,
    );
    const verdictMatch = derived === ride.settlementKind;
    const pass = allIntegrityOk && verdictMatch;

    console.log("");
    if (market.rugEnabled) {
      console.log(
        `rug-pull:          ${
          rugSeg === null
            ? `none in round ${ride.roundIndex} before close (chance ${market.rugChanceBps}bps/seg)`
            : `fired @ segment ${rugSeg} — ${
                rugApplies
                  ? "ride OPEN across it → EXPIRED_LOSS"
                  : ride.entrySegmentIndex > rugSeg
                    ? "ride entered AFTER the rug"
                    : "ride CLOSED before the rug fired"
              }`
        }`,
      );
    }
    console.log(`extrema replay:    ${allIntegrityOk ? "match (every segment)" : "MISMATCH"}`);
    console.log(`off-chain verdict: ${SETTLEMENT_NAME[derived] ?? derived}`);
    console.log(`on-chain verdict:  ${SETTLEMENT_NAME[ride.settlementKind] ?? ride.settlementKind}`);
    console.log(verdictMatch ? "verdict:           match" : "verdict:           MISMATCH");
    console.log(pass ? "\nPASS — the chain was honest." : "\nFAIL — the chain lied.");
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
// catches the lie — this is the `--rpc mock://tamper-v4` demo.

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

function buildSyntheticClient(tamper: boolean): RpcClient {
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
                entry_segment_index: "2",
                round_index: "0",
                upper_barrier_price: upper.toString(),
                lower_barrier_price: lower.toString(),
                closed: true,
                closed_at_ms: rideClosedAt.toString(),
                settlement_kind: String(SETTLEMENT_CASHOUT),
              },
            },
          },
        };
      }
      return { data: null };
    },
    async getDynamicFieldObject(a) {
      if (a.parentId !== TABLE_ID) return { data: null };
      const k = Number(a.name.value);
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

// Exported for unit tests (scripts/verify-v4.test.ts). Pure, no I/O.
export { rollRugFires, deriveSettlementKind, SETTLEMENT_TOUCH_WIN, SETTLEMENT_CASHOUT, SETTLEMENT_EXPIRED_LOSS };

// CLI entrypoint — guarded so `import`ing this module (e.g. from the test) does
// NOT auto-run the verifier against the test runner's argv.
const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);
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
