/**
 * SDK surface for the v4 touch-either segment-market arcade (doc 25).
 *
 * Mirrors the on-chain entry points in `move/sources/segment_market_v4.move`
 * (being built in parallel on `claude/v4-touch-either-move`) + the entry
 * re-exports planned for `wick.move`. Designed against:
 *   - docs/design/v2/25_touch_either_laser_v3.md §4 (Move-side spec)
 *
 * V4 vs V3 — what changed at the ABI surface:
 *   - `open_segment_ride_v4` no longer takes a `barrier_index: u8`. Press
 *     anywhere → ride opens against BOTH barriers. Touch EITHER wins.
 *   - No `open_window_segments` — bootstrap drops it; every segment is open.
 *   - `max_payout_per_barrier` is renamed `max_payout_per_round` (one
 *     shared bucket — vault doesn't care which side touches).
 *   - `SegmentMarketV4` aggregates merged into `either_*` (no upper/lower
 *     split).
 *   - `SegmentRidePositionV4` snapshots BOTH barriers (`upper_barrier_price`,
 *     `lower_barrier_price`) — no `barrier_index`/`barrier_price` field.
 *   - New events: `RideOpenedV4`, `RideClosedV4` (the latter adds
 *     `touched_side: u8` for telemetry).
 *
 * Two sub-surfaces (parallel to segmentMarket.ts):
 *   1. PTB builders — `buildBootstrapSegmentMarketV4Tx`,
 *      `buildRecordSegmentV4Tx`, `buildOpenSegmentRideV4Tx`,
 *      `buildCloseSegmentRideV4Tx`, `buildCrankExpiredSegmentRideV4Tx`,
 *      `buildAbortSegmentRideV4Tx`.
 *   2. Read helpers + event types — `fetchSegmentMarketV4`,
 *      `fetchSegmentRidePositionV4`, parsers for `RideOpenedV4`,
 *      `RideClosedV4`, `RoundStartedV4`, `SegmentRecordedV4`.
 *
 * BigInt is used end-to-end for u64 fields to avoid JS Number truncation
 * past 2^53.
 *
 * IMPORTANT: until the v4 Move module ships to testnet, the builders' Move
 * calls will revert at runtime (entry function doesn't exist yet). That's
 * fine — the frontend uses these helpers only when a v4 market is present
 * in `deployments/testnet.json` under `segment_markets_v4`. With no v4
 * market the frontend falls back to v3 cleanly.
 */

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";

// ── Constants from the V4 Move module ───────────────────────────────────────

/**
 * V4 RideClosed event surfaces which side actually touched first (for
 * UI/telemetry only — payout is the same either way).
 *  0 = upper barrier touched, 1 = lower barrier touched, 2 = neither
 *  (cashout / expired_loss / aborted_refund).
 */
export const TOUCHED_UPPER = 0 as const;
export const TOUCHED_LOWER = 1 as const;
export const TOUCHED_NONE = 2 as const;
export type TouchedSide = typeof TOUCHED_UPPER | typeof TOUCHED_LOWER | typeof TOUCHED_NONE;

/** Settlement-kind values — mirror the v3 module so callers can share parsers. */
export const SETTLEMENT_OPEN_V4 = 0 as const;
export const SETTLEMENT_TOUCH_WIN_V4 = 1 as const;
export const SETTLEMENT_CASHOUT_V4 = 2 as const;
/**
 * Also fires for rug-pulls (doc 26 §3.4): when a ride was open at the moment a
 * `RugFiredV4` event fired in its round, `close_segment_ride_v4` routes the
 * settlement to `EXPIRED_LOSS`. The frontend distinguishes a rug-loss from an
 * expire-loss by correlating the close with a `RugFiredV4` event on the same
 * (market_id, round_index) — see `subscribeRugFiredV4` below.
 */
export const SETTLEMENT_EXPIRED_LOSS_V4 = 3 as const;
export const SETTLEMENT_ABORTED_REFUND_V4 = 4 as const;

export const SETTLEMENT_NAME_V4 = {
  0: "OPEN",
  1: "TOUCH_WIN",
  2: "CASHOUT",
  3: "EXPIRED_LOSS",
  4: "ABORTED_REFUND",
} as const;

/** Same 400ms segment cadence as v3 (doc 17 §10). */
export const DEFAULT_SEGMENT_MS_V4 = 400n;
/** 50 bps of stake_paid → cranker, same as v3. */
export const CRANK_BOUNTY_BPS_V4 = 50n;

// ── Common base ─────────────────────────────────────────────────────────────

export interface BuildSegmentTxBaseV4 {
  /** Wick package id — current `package_id` from deployments JSON. */
  packageId: string;
  /** Collateral type tag, e.g. "0x2::sui::SUI". */
  collateralType: string;
  /** Tx sender address. */
  sender: string;
}

// ── bootstrap_segment_market_v4 (admin) ─────────────────────────────────────

export interface BuildBootstrapSegmentMarketV4Args extends BuildSegmentTxBaseV4 {
  /** ID of the shared MartingalerVault<C> this market binds to. */
  vaultId: string;
  /** Walk home price in micro-USD (the mean-reversion target). */
  homePrice: bigint;
  /** Initial vol_regime (1.0 in 1e6 fixed-point = 1_000_000). */
  volRegimeInit: bigint;
  /** Segments per round — 75 = 30 s at 400 ms/seg. */
  roundDurationSegments: bigint;
  /**
   * Distance of each barrier from the round's open spot, in bps.
   * 1000 = ±10% (B7 calibration).
   */
  barrierOffsetBps: bigint;
  /** Touch-payoff multiplier in bps. 17500 = 1.75× (B7 calibration). */
  multiplierBps: bigint;
  /**
   * Per-round liability cap (sum of `escrow × multiplier / 10_000`).
   * V4 renames v3's `max_payout_per_barrier` to one shared bucket — vault
   * doesn't care which side touches.
   */
  maxPayoutPerRound: bigint;
  /** Anti-jitter margin around the barrier for the scan. */
  deadbandBps: bigint;
  /** Vol model parameter for the cashout factor. */
  sigmaBpsPerSqrtSec: bigint;
  /** Spread shaved off the cashout factor (lender keeps it). */
  cashoutSpreadBps: bigint;
  /** Wall-time after `opened_at_ms` past which `abort_segment_ride_v4` is callable. */
  abortSegmentDeadlineMs: bigint;
  minStakePerSegment: bigint;
  maxStakePerSegment: bigint;
  maxConcurrentRides: bigint;
  maxRidesPerUser: bigint;
}

/**
 * Admin: construct + share a SegmentMarketV4<C>. Market id is in the
 * emitted `SegmentMarketV4Created` event — read via
 * `parseSegmentMarketV4CreatedEvent`.
 *
 * NOTE: NO `open_window_segments` argument — v4 drops the open window.
 */
export function buildBootstrapSegmentMarketV4Tx(
  a: BuildBootstrapSegmentMarketV4Args,
): Transaction {
  const tx = new Transaction();
  tx.setSender(a.sender);
  tx.moveCall({
    target: `${a.packageId}::wick::bootstrap_segment_market_v4`,
    typeArguments: [a.collateralType],
    arguments: [
      tx.pure.u64(a.homePrice),
      tx.pure.u64(a.volRegimeInit),
      tx.pure.u64(a.roundDurationSegments),
      tx.pure.u64(a.barrierOffsetBps),
      tx.pure.u64(a.multiplierBps),
      tx.pure.u64(a.maxPayoutPerRound),
      tx.pure.u64(a.deadbandBps),
      tx.pure.u64(a.sigmaBpsPerSqrtSec),
      tx.pure.u64(a.cashoutSpreadBps),
      tx.pure.u64(a.abortSegmentDeadlineMs),
      tx.pure.u64(a.minStakePerSegment),
      tx.pure.u64(a.maxStakePerSegment),
      tx.pure.u64(a.maxConcurrentRides),
      tx.pure.u64(a.maxRidesPerUser),
      tx.object(a.vaultId),
      tx.object.clock(),
    ],
  });
  return tx;
}

// ── record_segment_v4 (permissionless cranker) ──────────────────────────────

export interface BuildRecordSegmentV4Args extends BuildSegmentTxBaseV4 {
  /** Shared SegmentMarketV4<C> object id. */
  marketId: string;
}

/**
 * Record one segment. The CRANKER (keeper or any rider) submits this as
 * the SOLE MoveCall in its PTB (Sui's PTB-command rule for Random:
 * `&Random`-consuming entries cannot have additional logic after them).
 */
export function buildRecordSegmentV4Tx(a: BuildRecordSegmentV4Args): Transaction {
  const tx = new Transaction();
  tx.setSender(a.sender);
  tx.moveCall({
    target: `${a.packageId}::wick::record_segment_v4`,
    typeArguments: [a.collateralType],
    arguments: [
      tx.object(a.marketId),
      tx.object.random(),
      tx.object.clock(),
    ],
  });
  return tx;
}

// ── open_segment_ride_v4 ────────────────────────────────────────────────────

export interface BuildOpenSegmentRideV4Args extends BuildSegmentTxBaseV4 {
  marketId: string;
  vaultId: string;
  /** Shared BotRegistry id (for the WICK-mint anti-bot snapshot). */
  botRegistryId: string;
  /**
   * V4: NO `barrierIndex` argument. The ride is direction-neutral; touch
   * either side wins the jackpot.
   */
  stakePerSegment: bigint;
  /** Total escrow to lock — must be ≥ stakePerSegment × roundDurationSegments. */
  escrowMist: bigint;
  /**
   * v4.24 — when the market's collateral is NOT 0x2::sui::SUI (e.g. TUSD),
   * pass the sender's coin object ID to split the escrow from. If omitted
   * (SUI markets), the escrow is split from gas.
   */
  escrowSourceCoinId?: string;
  /**
   * v4.31c — extra coins of the same collateral type to MERGE into
   * `escrowSourceCoinId` before splitting. Solves the field-reported
   * case where a user has e.g. 39 TUSD spread across 4-5 small drip
   * coins (each below the per-ride escrow), so no SINGLE coin can
   * source the split — but the TOTAL is plenty. The PTB merges them
   * first, then splits, so the user never has to think about coin
   * objects. Ignored when collateralType is SUI (gas merges itself).
   */
  additionalCoinIds?: ReadonlyArray<string>;
}

/**
 * Open a direction-neutral ride against the current round. The PTB splits
 * the escrow coin (from gas for SUI, from a user-owned coin for other
 * collaterals), opens the ride, transfers the position to the sender.
 *
 * V4 vs v3: no barrier_index argument; both barriers are snapshotted
 * into the position object.
 */
export function buildOpenSegmentRideV4Tx(
  a: BuildOpenSegmentRideV4Args,
): Transaction {
  if (a.escrowMist <= 0n) throw new Error("escrowMist must be > 0");
  if (a.stakePerSegment <= 0n) throw new Error("stakePerSegment must be > 0");
  const tx = new Transaction();
  tx.setSender(a.sender);
  // v4.24 — coin-source dispatch. Gas is always Coin<SUI>; non-SUI
  // collaterals must split from a user-owned coin object of the right
  // type. Otherwise the Move type check fails with arg_idx 4 / TypeMismatch.
  const isSui = a.collateralType === "0x2::sui::SUI";
  let escrowSource;
  if (isSui) {
    escrowSource = tx.gas;
  } else {
    if (!a.escrowSourceCoinId) {
      throw new Error(
        `escrowSourceCoinId required for non-SUI collateral (${a.collateralType})`,
      );
    }
    escrowSource = tx.object(a.escrowSourceCoinId);
    // v4.31c — merge any additional coins of the same type into the
    // primary BEFORE splitting. Without this, a user with e.g. 39
    // TUSD spread across 4 small drip coins can't open a $12 ride
    // because no single coin is big enough. With this, the PTB
    // consolidates them on the fly. Filters out the primary id from
    // the merge list so we never try to merge a coin into itself.
    const extras = (a.additionalCoinIds ?? []).filter(
      (id) => id !== a.escrowSourceCoinId,
    );
    if (extras.length > 0) {
      tx.mergeCoins(
        escrowSource,
        extras.map((id) => tx.object(id)),
      );
    }
  }
  const [escrow] = tx.splitCoins(escrowSource, [tx.pure.u64(a.escrowMist)]);
  const ride = tx.moveCall({
    target: `${a.packageId}::wick::open_segment_ride_v4`,
    typeArguments: [a.collateralType],
    arguments: [
      tx.object(a.marketId),
      tx.object(a.vaultId),
      tx.object(a.botRegistryId),
      tx.pure.u64(a.stakePerSegment),
      escrow,
      tx.object.clock(),
    ],
  });
  tx.transferObjects([ride], tx.pure.address(a.sender));
  return tx;
}

// ── close_segment_ride_v4 ───────────────────────────────────────────────────

export interface BuildCloseSegmentRideV4Args extends BuildSegmentTxBaseV4 {
  rideId: string;
  marketId: string;
  vaultId: string;
  /** Shared UsdPriceOracle id. */
  priceOracleId: string;
  /** Shared WickTokenState id. */
  tokenStateId: string;
  /** Shared WickStakingPool id. */
  stakingPoolId: string;
}

/** Voluntary close. Settlement kind decided on-chain. */
export function buildCloseSegmentRideV4Tx(
  a: BuildCloseSegmentRideV4Args,
): Transaction {
  const tx = new Transaction();
  tx.setSender(a.sender);
  // v4.31f — REVERTED the v4.31e atomic-crank-then-close: Sui's PTB
  // structural rule says "commands following a command that consumes
  // sui::random can only be TransferObjects or MergeCoins" — my
  // chained `record_segment_v4` (uses Random) → `close_segment_ride_v4`
  // (a moveCall) is rejected at submission with
  //   "Error checking transaction input objects: Commands following a
  //    command with Random can only be TransferObjects or MergeCoins."
  // Every close after v4.31e shipped would fail. Reverted.
  //
  // The original concern (segments not advancing → stake_paid=0) is
  // now handled by the sentinel cranker running from the sponsor
  // wallet, which records a segment every 2 seconds. By the time the
  // user releases, next_segment_index has typically advanced 1-20+
  // segments past entry, so segments_held > 0 and the settlement math
  // returns real stake_paid / payout values.
  const payout = tx.moveCall({
    target: `${a.packageId}::wick::close_segment_ride_v4`,
    typeArguments: [a.collateralType],
    arguments: [
      tx.object(a.rideId),
      tx.object(a.marketId),
      tx.object(a.vaultId),
      tx.object(a.priceOracleId),
      tx.object(a.tokenStateId),
      tx.object(a.stakingPoolId),
      tx.object.clock(),
    ],
  });
  tx.transferObjects([payout], tx.pure.address(a.sender));
  return tx;
}

// ── crank_expired_segment_ride_v4 (permissionless) ──────────────────────────

export interface BuildCrankExpiredSegmentRideV4Args extends BuildSegmentTxBaseV4 {
  rideId: string;
  marketId: string;
  vaultId: string;
  priceOracleId: string;
  tokenStateId: string;
  stakingPoolId: string;
}

/**
 * Crank a ride past its round end (no touch). Returns the bounty coin to
 * the cranker; pushes the user's refund directly to the user.
 */
export function buildCrankExpiredSegmentRideV4Tx(
  a: BuildCrankExpiredSegmentRideV4Args,
): Transaction {
  const tx = new Transaction();
  tx.setSender(a.sender);
  const bounty = tx.moveCall({
    target: `${a.packageId}::wick::crank_expired_segment_ride_v4`,
    typeArguments: [a.collateralType],
    arguments: [
      tx.object(a.rideId),
      tx.object(a.marketId),
      tx.object(a.vaultId),
      tx.object(a.priceOracleId),
      tx.object(a.tokenStateId),
      tx.object(a.stakingPoolId),
      tx.object.clock(),
    ],
  });
  tx.transferObjects([bounty], tx.pure.address(a.sender));
  return tx;
}

// ── abort_segment_ride_v4 (permissionless, past deadline) ───────────────────

export interface BuildAbortSegmentRideV4Args extends BuildSegmentTxBaseV4 {
  rideId: string;
  marketId: string;
  vaultId: string;
  /** Address to receive the 1:1 escrow refund (the ride's `user` field). */
  refundRecipient: string;
}

/** Past `abort_segment_deadline_ms` with no segment progress → 1:1 refund. */
export function buildAbortSegmentRideV4Tx(
  a: BuildAbortSegmentRideV4Args,
): Transaction {
  const tx = new Transaction();
  tx.setSender(a.sender);
  const refund = tx.moveCall({
    target: `${a.packageId}::wick::abort_segment_ride_v4`,
    typeArguments: [a.collateralType],
    arguments: [
      tx.object(a.rideId),
      tx.object(a.marketId),
      tx.object(a.vaultId),
      tx.object.clock(),
    ],
  });
  tx.transferObjects([refund], tx.pure.address(a.refundRecipient));
  return tx;
}

// ── Event payload types (parsed from Move emit) ─────────────────────────────

export interface SegmentMarketV4CreatedEvent {
  marketId: string;
  vaultId: string;
  homePrice: bigint;
  roundDurationSegments: bigint;
  barrierOffsetBps: bigint;
  multiplierBps: bigint;
  maxPayoutPerRound: bigint;
  createdAtMs: bigint;
}

export interface RoundStartedV4Event {
  marketId: string;
  roundIndex: bigint;
  upperBarrier: bigint;
  lowerBarrier: bigint;
  startedAtSegment: bigint;
  spotAtRoll: bigint;
}

export interface SegmentRecordedV4Event {
  marketId: string;
  k: bigint;
  /** 32-byte segment key drawn from sui::random. */
  key: Uint8Array;
  minPrice: bigint;
  maxPrice: bigint;
  recordedAtMs: bigint;
}

export interface RideOpenedV4Event {
  rideId: string;
  user: string;
  marketId: string;
  roundIndex: bigint;
  entrySegmentIndex: bigint;
  /** BOTH barriers snapshotted at open. */
  upperBarrierPrice: bigint;
  lowerBarrierPrice: bigint;
  stakePerSegment: bigint;
  /** Total micro-USD escrowed up front (= stake_per_segment × round_duration). */
  escrowed: bigint;
  multiplierBps: bigint;
  openedAtMs: bigint;
}

export interface RideClosedV4Event {
  rideId: string;
  user: string;
  marketId: string;
  roundIndex: bigint;
  settlementKind: number;
  closedAtMs: bigint;
  /** Settlement breakdown (micro-USD): stake spent, jackpot paid, stake forfeited, keeper bounty. */
  stakePaid: bigint;
  payout: bigint;
  forfeit: bigint;
  bounty: bigint;
  /** 0 = upper, 1 = lower, 2 = none. UI/telemetry only. */
  touchedSide: TouchedSide;
}

/**
 * doc 26 §3.6 — emitted by `record_segment_v4` the first time a per-segment
 * rug roll passes the `rug_chance_bps` threshold in the current round. Open
 * rides on this market with `entry_segment_index <= segment_index` settle as
 * `SETTLEMENT_EXPIRED_LOSS_V4` when next closed; the frontend correlates this
 * event with the close to render a "MARKET HALT" overlay distinct from a
 * normal time-expiry loss.
 */
export interface RugFiredV4Event {
  marketId: string;
  roundIndex: bigint;
  segmentIndex: bigint;
  /** Tx digest that emitted the event (for /verify deep-links). */
  digest: string;
  /** Chain wall-clock timestamp of the emitting tx, in ms. */
  timestampMs: number;
}

// ── Event type tags (for queryEvents / subscribe) ───────────────────────────

export function segmentMarketV4CreatedEventType(packageId: string): string {
  return `${packageId}::segment_market_v4::SegmentMarketV4Created`;
}
export function roundStartedV4EventType(packageId: string): string {
  return `${packageId}::segment_market_v4::RoundStartedV4`;
}
export function segmentRecordedV4EventType(packageId: string): string {
  return `${packageId}::segment_market_v4::SegmentRecordedV4`;
}
export function rideOpenedV4EventType(packageId: string): string {
  return `${packageId}::segment_market_v4::RideOpenedV4`;
}
export function rideClosedV4EventType(packageId: string): string {
  return `${packageId}::segment_market_v4::RideClosedV4`;
}
export function rugFiredV4EventType(packageId: string): string {
  return `${packageId}::segment_market_v4::RugFiredV4`;
}

// ── Event parsers ───────────────────────────────────────────────────────────

function asBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string") return BigInt(v);
  return 0n;
}

function asNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  if (typeof v === "bigint") return Number(v);
  return 0;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : String(v);
}

function asTouchedSide(v: unknown): TouchedSide {
  const n = asNumber(v);
  if (n === 0) return TOUCHED_UPPER;
  if (n === 1) return TOUCHED_LOWER;
  return TOUCHED_NONE;
}

function asKeyBytes(v: unknown): Uint8Array {
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

export function parseSegmentMarketV4CreatedEvent(
  json: Record<string, unknown>,
): SegmentMarketV4CreatedEvent {
  return {
    marketId: asString(json.market_id),
    vaultId: asString(json.vault_id),
    homePrice: asBigInt(json.home_price),
    roundDurationSegments: asBigInt(json.round_duration_segments),
    barrierOffsetBps: asBigInt(json.barrier_offset_bps),
    multiplierBps: asBigInt(json.multiplier_bps),
    maxPayoutPerRound: asBigInt(json.max_payout_per_round),
    createdAtMs: asBigInt(json.created_at_ms),
  };
}

export function parseRoundStartedV4Event(
  json: Record<string, unknown>,
): RoundStartedV4Event {
  return {
    marketId: asString(json.market_id),
    roundIndex: asBigInt(json.round_index),
    upperBarrier: asBigInt(json.upper_barrier),
    lowerBarrier: asBigInt(json.lower_barrier),
    startedAtSegment: asBigInt(json.started_at_segment),
    spotAtRoll: asBigInt(json.spot_at_roll),
  };
}

export function parseSegmentRecordedV4Event(
  json: Record<string, unknown>,
): SegmentRecordedV4Event {
  return {
    marketId: asString(json.market_id),
    k: asBigInt(json.k),
    key: asKeyBytes(json.key),
    minPrice: asBigInt(json.min_price),
    maxPrice: asBigInt(json.max_price),
    recordedAtMs: asBigInt(json.recorded_at_ms),
  };
}

export function parseRideOpenedV4Event(
  json: Record<string, unknown>,
): RideOpenedV4Event {
  return {
    rideId: asString(json.ride_id),
    user: asString(json.user),
    marketId: asString(json.market_id),
    roundIndex: asBigInt(json.round_index),
    entrySegmentIndex: asBigInt(json.entry_segment_index),
    upperBarrierPrice: asBigInt(json.upper_barrier_price),
    lowerBarrierPrice: asBigInt(json.lower_barrier_price),
    stakePerSegment: asBigInt(json.stake_per_segment),
    escrowed: asBigInt(json.escrowed),
    multiplierBps: asBigInt(json.multiplier_bps),
    openedAtMs: asBigInt(json.opened_at_ms),
  };
}

export function parseRideClosedV4Event(
  json: Record<string, unknown>,
): RideClosedV4Event {
  return {
    rideId: asString(json.ride_id),
    user: asString(json.user),
    marketId: asString(json.market_id),
    roundIndex: asBigInt(json.round_index),
    settlementKind: asNumber(json.settlement_kind),
    closedAtMs: asBigInt(json.closed_at_ms),
    stakePaid: asBigInt(json.stake_paid),
    payout: asBigInt(json.payout),
    forfeit: asBigInt(json.forfeit),
    bounty: asBigInt(json.bounty),
    touchedSide: asTouchedSide(json.touched_side),
  };
}

/**
 * Parse just the `parsedJson` payload of a `RugFiredV4` event. The wrapping
 * `digest` + `timestampMs` fields come from the SuiEvent envelope and are
 * filled in by `subscribeRugFiredV4` — this helper only handles the on-chain
 * fields, so it can be reused by replay/verify code paths.
 */
export function parseRugFiredV4EventJson(
  json: Record<string, unknown>,
): Pick<RugFiredV4Event, "marketId" | "roundIndex" | "segmentIndex"> {
  return {
    marketId: asString(json.market_id),
    roundIndex: asBigInt(json.round_index),
    segmentIndex: asBigInt(json.segment_index),
  };
}

// ── Read helpers — on-chain object snapshots ────────────────────────────────

/**
 * Snapshot of a V4 segment market. Compared to V3:
 *   - No `openWindowSegments` field.
 *   - `maxPayoutPerRound` replaces `maxPayoutPerBarrier`.
 *   - `eitherAggregateStake`, `eitherAggregateMaxPayout`, `eitherRiderCount`
 *     replace the per-barrier upper/lower split.
 */
export interface SegmentMarketV4Snapshot {
  id: string;
  collateralType: string;
  /**
   * Type-origin package of `segment_market_v4` for THIS market — use it to key
   * RideOpenedV4 / RideClosedV4 / SegmentRecordedV4 / RoundStartedV4 event
   * queries and the SegmentRidePositionV4 `getOwnedObjects` filter. NOT the
   * latest `package_id` (Move types keep their origin across upgrades), so
   * passing the deployment's `package_id` to those queries returns zero rows.
   * (RugFiredV4 is the exception — keyed on the latest pkg, see rugFiredV4EventType.)
   */
  typeOriginPackage: string;
  vaultId: string;
  walkPrice: bigint;
  nextSegmentIndex: bigint;
  activeRideCount: bigint;
  roundDurationSegments: bigint;
  barrierOffsetBps: bigint;
  multiplierBps: bigint;
  maxPayoutPerRound: bigint;
  cachedRoundIndex: bigint;
  cachedRoundStartedAtSegment: bigint;
  cachedUpperBarrier: bigint;
  cachedLowerBarrier: bigint;
  /** Merged per-round bucket (no upper/lower split). */
  eitherAggregateStake: bigint;
  eitherAggregateMaxPayout: bigint;
  eitherRiderCount: bigint;
  deadbandBps: bigint;
  sigmaBpsPerSqrtSec: bigint;
  cashoutSpreadBps: bigint;
  abortSegmentDeadlineMs: bigint;
  minStakePerSegment: bigint;
  maxStakePerSegment: bigint;
  maxConcurrentRides: bigint;
  maxRidesPerUser: bigint;
  createdAtMs: bigint;
}

export interface SegmentRidePositionV4Snapshot {
  id: string;
  user: string;
  marketId: string;
  collateralType: string;
  roundIndex: bigint;
  entrySegmentIndex: bigint;
  /** BOTH barriers — no `barrierIndex` field on v4. */
  upperBarrierPrice: bigint;
  lowerBarrierPrice: bigint;
  multiplierBps: bigint;
  stakePerSegment: bigint;
  escrowed: bigint;
  isBotEligible: boolean;
  openedAtMs: bigint;
  closed: boolean;
  closedAtMs: bigint;
  settlementKind: number;
}

/** Extract the type argument from a `…::segment_market_v4::SegmentMarketV4<…>` string. */
function extractCollateralFromMarketV4Type(type: string): string | null {
  const m = /::segment_market_v4::SegmentMarketV4<(.+)>$/.exec(type);
  return m && m[1] ? m[1] : null;
}

/**
 * Extract the **type-origin package** from a `SegmentMarketV4<C>` object type —
 * the address that DEFINED the `segment_market_v4` module. This is the package
 * that `RideOpenedV4` / `RideClosedV4` / `SegmentRecordedV4` / `RoundStartedV4`
 * events and the `SegmentRidePositionV4` struct are keyed on, and it is NOT
 * generally the latest upgraded `package_id` (Move type tags keep their origin
 * across upgrades). Pass THIS to the `*EventType` builders / `getOwnedObjects`
 * StructType filters, or queries silently return zero rows after an upgrade.
 *
 * Exception: `RugFiredV4` was introduced in a LATER upgrade (v4.26), so its
 * events are keyed on the latest `package_id`, not this — see `rugFiredV4EventType`.
 */
export function segmentMarketV4TypeOriginPackage(type: string): string | null {
  const idx = type.indexOf("::segment_market_v4::");
  return idx > 0 ? type.slice(0, idx) : null;
}

/**
 * Read a SegmentMarketV4<C>'s on-chain state. Returns null if the object id
 * is missing or doesn't match the expected struct.
 */
export async function fetchSegmentMarketV4(
  client: SuiJsonRpcClient,
  marketId: string,
): Promise<SegmentMarketV4Snapshot | null> {
  const o = await client.getObject({
    id: marketId,
    options: { showContent: true, showType: true },
  });
  if (!o.data || o.data.content?.dataType !== "moveObject") return null;
  const content = o.data.content as { fields: Record<string, unknown>; type: string };
  const collateralType = extractCollateralFromMarketV4Type(content.type);
  if (!collateralType) return null;
  const f = content.fields;
  const walk = f.walk as Record<string, unknown> | undefined;
  const walkFields = walk && (walk.fields as Record<string, unknown> | undefined);
  const walkPrice = walkFields ? asBigInt(walkFields.price) : 0n;
  return {
    id: o.data.objectId,
    collateralType,
    typeOriginPackage:
      segmentMarketV4TypeOriginPackage(content.type) ?? content.type.split("::")[0]!,
    vaultId: asString(f.vault_id),
    walkPrice,
    nextSegmentIndex: asBigInt(f.next_segment_index),
    activeRideCount: asBigInt(f.active_ride_count),
    roundDurationSegments: asBigInt(f.round_duration_segments),
    barrierOffsetBps: asBigInt(f.barrier_offset_bps),
    multiplierBps: asBigInt(f.multiplier_bps),
    maxPayoutPerRound: asBigInt(f.max_payout_per_round),
    cachedRoundIndex: asBigInt(f.cached_round_index),
    cachedRoundStartedAtSegment: asBigInt(f.cached_round_started_at_segment),
    cachedUpperBarrier: asBigInt(f.cached_upper_barrier),
    cachedLowerBarrier: asBigInt(f.cached_lower_barrier),
    eitherAggregateStake: asBigInt(f.either_aggregate_stake),
    eitherAggregateMaxPayout: asBigInt(f.either_aggregate_max_payout),
    eitherRiderCount: asBigInt(f.either_rider_count),
    deadbandBps: asBigInt(f.deadband_bps),
    sigmaBpsPerSqrtSec: asBigInt(f.sigma_bps_per_sqrt_sec),
    cashoutSpreadBps: asBigInt(f.cashout_spread_bps),
    abortSegmentDeadlineMs: asBigInt(f.abort_segment_deadline_ms),
    minStakePerSegment: asBigInt(f.min_stake_per_segment),
    maxStakePerSegment: asBigInt(f.max_stake_per_segment),
    maxConcurrentRides: asBigInt(f.max_concurrent_rides),
    maxRidesPerUser: asBigInt(f.max_rides_per_user),
    createdAtMs: asBigInt(f.created_at_ms),
  };
}

/**
 * Read SegmentRecordedV4 events for a market in [fromK, toK). Each event
 * carries the segment key + extremes — the chart code replays them
 * through `seededPath.expandSegment` to render candles client-side.
 *
 * Mirrors `fetchSegments` from segmentMarket.ts but for the V4 event tag.
 */
export async function fetchSegmentsV4(
  client: SuiJsonRpcClient,
  opts: {
    packageId: string;
    marketId: string;
    fromK: bigint;
    toK: bigint;
    /** Max events per RPC page. Defaults to 50. */
    pageLimit?: number;
    /** Max pages to scan before giving up. Defaults to 100. */
    maxPages?: number;
  },
): Promise<Array<{
  k: bigint;
  key: Uint8Array;
  minPrice: bigint;
  maxPrice: bigint;
  recordedAtMs: bigint;
}>> {
  if (opts.toK <= opts.fromK) return [];
  const out: Array<{
    k: bigint;
    key: Uint8Array;
    minPrice: bigint;
    maxPrice: bigint;
    recordedAtMs: bigint;
  }> = [];
  const wanted = new Set<string>();
  let k = opts.fromK;
  while (k < opts.toK) {
    wanted.add(k.toString());
    k = k + 1n;
  }

  const pageLimit = opts.pageLimit ?? 50;
  const maxPages = opts.maxPages ?? 100;
  let cursor: { txDigest: string; eventSeq: string } | null = null;
  for (let p = 0; p < maxPages; p++) {
    const page = await client.queryEvents({
      query: { MoveEventType: segmentRecordedV4EventType(opts.packageId) },
      cursor,
      limit: pageLimit,
      order: "descending",
    });
    for (const ev of page.data) {
      const j = ev.parsedJson as Record<string, unknown>;
      const mid = asString(j.market_id);
      if (mid !== opts.marketId) continue;
      const kStr = asString(j.k);
      if (!wanted.has(kStr)) continue;
      out.push({
        k: asBigInt(j.k),
        key: asKeyBytes(j.key),
        minPrice: asBigInt(j.min_price),
        maxPrice: asBigInt(j.max_price),
        recordedAtMs: asBigInt(j.recorded_at_ms),
      });
      wanted.delete(kStr);
    }
    if (wanted.size === 0) break;
    if (!page.hasNextPage || !page.nextCursor) break;
    cursor = page.nextCursor as { txDigest: string; eventSeq: string };
  }
  return out.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
}

/** Read a SegmentRidePositionV4 by id. Returns null if missing or wrong type. */
export async function fetchSegmentRidePositionV4(
  client: SuiJsonRpcClient,
  rideId: string,
): Promise<SegmentRidePositionV4Snapshot | null> {
  const o = await client.getObject({
    id: rideId,
    options: { showContent: true, showType: true },
  });
  if (!o.data || o.data.content?.dataType !== "moveObject") return null;
  const content = o.data.content as { fields: Record<string, unknown>; type: string };
  if (!/::segment_market_v4::SegmentRidePositionV4$/.test(content.type)) return null;
  const f = content.fields;
  const collateralField = f.collateral as Record<string, unknown> | undefined;
  const collateralFields =
    collateralField && (collateralField.fields as Record<string, unknown> | undefined);
  const collateralName = collateralFields ? asString(collateralFields.name) : "";
  return {
    id: o.data.objectId,
    user: asString(f.user),
    marketId: asString(f.market_id),
    collateralType: collateralName,
    roundIndex: asBigInt(f.round_index),
    entrySegmentIndex: asBigInt(f.entry_segment_index),
    upperBarrierPrice: asBigInt(f.upper_barrier_price),
    lowerBarrierPrice: asBigInt(f.lower_barrier_price),
    multiplierBps: asBigInt(f.multiplier_bps),
    stakePerSegment: asBigInt(f.stake_per_segment),
    escrowed: asBigInt(f.escrowed),
    isBotEligible: Boolean(f.is_bot_eligible),
    openedAtMs: asBigInt(f.opened_at_ms),
    closed: Boolean(f.closed),
    closedAtMs: asBigInt(f.closed_at_ms),
    settlementKind: asNumber(f.settlement_kind),
  };
}

// ── RugFiredV4 subscriber (doc 26 §4.1) ─────────────────────────────────────

/**
 * Default cadence for the rug subscriber's `queryEvents` polling loop, in ms.
 * Mirrors `EVENT_POLL_MS` in `frontend/src/hooks/useSegmentRideV4.ts` — sits
 * just under the 400ms segment tick so a rug event is visible to the UI on
 * the same animation frame as the segment that fired it.
 */
export const DEFAULT_RUG_POLL_MS = 350;

/**
 * Subscribe to `RugFiredV4` events for a single market. Returns an
 * unsubscribe function that stops the polling loop and ignores any in-flight
 * RPC reply.
 *
 * Sui's JSON-RPC doesn't expose a push subscription channel for Move events
 * from the standard HTTP endpoint, so this is a polling loop over
 * `queryEvents` — same approach taken by `fetchSegmentsV4` and the in-app
 * `useSegmentRideV4` poller. Each tick scans the most recent page of
 * `RugFiredV4` events and filters on `market_id == marketId` in `parsedJson`;
 * events whose digest has already been seen are skipped, so the callback
 * fires at most once per on-chain emit even across overlapping pages.
 *
 * The callback receives `digest` and `timestampMs` lifted from the SuiEvent
 * envelope so the frontend can deep-link `/verify` and time the visual halt
 * overlay against the chain clock rather than the wall clock.
 *
 * @returns unsubscribe — call to stop polling. Idempotent.
 */
export function subscribeRugFiredV4(
  client: SuiJsonRpcClient,
  marketId: string,
  packageId: string,
  onEvent: (event: RugFiredV4Event) => void,
  options?: {
    pollIntervalMs?: number;
    archivalRpcUrl?: string | null;
    /** Inject a pre-built archival client (tests / custom transports). Takes
     *  precedence over `archivalRpcUrl`. */
    archivalClient?: SuiJsonRpcClient;
  },
): () => void {
  const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_RUG_POLL_MS;
  const eventType = rugFiredV4EventType(packageId);
  const seenDigests = new Set<string>();
  let cancelled = false;
  let inFlight = false;

  // Archival fallback. PublicNode (the repo's default testnet RPC) prunes old
  // tx events and reliably ERRORS the descending RugFiredV4 scan ("Could not
  // find the referenced transaction events") — so without a fallback the live
  // MARKET HALT feed silently shows "no rugs" forever even while rugs fire on
  // chain. The Mysten fullnode retains history; query it when the primary
  // throws. Pass `archivalRpcUrl: null` to disable. (Same fix recent-rides.ts
  // and verify-payout.ts already apply.)
  const archivalUrl =
    options?.archivalRpcUrl === undefined
      ? getJsonRpcFullnodeUrl("testnet")
      : options.archivalRpcUrl;
  let archival: SuiJsonRpcClient | null = options?.archivalClient ?? null;
  const queryRugPage = async () => {
    const q = {
      query: { MoveEventType: eventType },
      limit: 50,
      order: "descending" as const,
    };
    try {
      return await client.queryEvents(q);
    } catch (primaryErr) {
      if (!archival && !archivalUrl) throw primaryErr;
      if (!archival) archival = new SuiJsonRpcClient({ url: archivalUrl!, network: "testnet" });
      return await archival.queryEvents(q);
    }
  };

  const pollOnce = async (): Promise<void> => {
    if (cancelled || inFlight) return;
    inFlight = true;
    try {
      const page = await queryRugPage();
      if (cancelled) return;
      // Iterate oldest-first so callbacks fire in chain order even though
      // the query returns descending.
      const fresh: RugFiredV4Event[] = [];
      for (const ev of page.data) {
        const json = ev.parsedJson as Record<string, unknown> | undefined;
        if (!json) continue;
        if (asString(json.market_id) !== marketId) continue;
        const txDigest = ev.id?.txDigest ?? "";
        const eventSeq = ev.id?.eventSeq ?? "";
        const dedupeKey = `${txDigest}:${eventSeq}`;
        if (seenDigests.has(dedupeKey)) continue;
        seenDigests.add(dedupeKey);
        const parsedFields = parseRugFiredV4EventJson(json);
        fresh.push({
          marketId: parsedFields.marketId,
          roundIndex: parsedFields.roundIndex,
          segmentIndex: parsedFields.segmentIndex,
          digest: txDigest,
          timestampMs: ev.timestampMs ? Number(ev.timestampMs) : Date.now(),
        });
      }
      fresh.sort((a, b) =>
        a.segmentIndex < b.segmentIndex ? -1 : a.segmentIndex > b.segmentIndex ? 1 : 0,
      );
      for (const e of fresh) {
        if (cancelled) return;
        try {
          onEvent(e);
        } catch {
          // Swallow callback errors so a single bad handler doesn't kill the
          // polling loop. Subscribers are responsible for their own logging.
        }
      }
      // Bound memory growth on the dedupe set — keep it slightly bigger than
      // the per-tick page so we don't re-emit, but don't grow unbounded.
      if (seenDigests.size > 500) {
        const toDrop = seenDigests.size - 250;
        let i = 0;
        for (const k of seenDigests) {
          if (i++ >= toDrop) break;
          seenDigests.delete(k);
        }
      }
    } catch {
      // Network blips are expected; retry on the next interval tick.
    } finally {
      inFlight = false;
    }
  };

  void pollOnce();
  const intervalId = setInterval(() => {
    void pollOnce();
  }, pollIntervalMs);

  return () => {
    if (cancelled) return;
    cancelled = true;
    clearInterval(intervalId);
  };
}
