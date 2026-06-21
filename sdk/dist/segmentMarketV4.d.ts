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
import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
/**
 * V4 RideClosed event surfaces which side actually touched first (for
 * UI/telemetry only — payout is the same either way).
 *  0 = upper barrier touched, 1 = lower barrier touched, 2 = neither
 *  (cashout / expired_loss / aborted_refund).
 */
export declare const TOUCHED_UPPER: 0;
export declare const TOUCHED_LOWER: 1;
export declare const TOUCHED_NONE: 2;
export type TouchedSide = typeof TOUCHED_UPPER | typeof TOUCHED_LOWER | typeof TOUCHED_NONE;
/** Settlement-kind values — mirror the v3 module so callers can share parsers. */
export declare const SETTLEMENT_OPEN_V4: 0;
export declare const SETTLEMENT_TOUCH_WIN_V4: 1;
export declare const SETTLEMENT_CASHOUT_V4: 2;
/**
 * Also fires for rug-pulls (doc 26 §3.4): when a ride was open at the moment a
 * `RugFiredV4` event fired in its round, `close_segment_ride_v4` routes the
 * settlement to `EXPIRED_LOSS`. The frontend distinguishes a rug-loss from an
 * expire-loss by correlating the close with a `RugFiredV4` event on the same
 * (market_id, round_index) — see `subscribeRugFiredV4` below.
 */
export declare const SETTLEMENT_EXPIRED_LOSS_V4: 3;
export declare const SETTLEMENT_ABORTED_REFUND_V4: 4;
export declare const SETTLEMENT_NAME_V4: {
    readonly 0: "OPEN";
    readonly 1: "TOUCH_WIN";
    readonly 2: "CASHOUT";
    readonly 3: "EXPIRED_LOSS";
    readonly 4: "ABORTED_REFUND";
};
/** Same 400ms segment cadence as v3 (doc 17 §10). */
export declare const DEFAULT_SEGMENT_MS_V4 = 400n;
/** 50 bps of stake_paid → cranker, same as v3. */
export declare const CRANK_BOUNTY_BPS_V4 = 50n;
export interface BuildSegmentTxBaseV4 {
    /** Wick package id — current `package_id` from deployments JSON. */
    packageId: string;
    /** Collateral type tag, e.g. "0x2::sui::SUI". */
    collateralType: string;
    /** Tx sender address. */
    sender: string;
}
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
export declare function buildBootstrapSegmentMarketV4Tx(a: BuildBootstrapSegmentMarketV4Args): Transaction;
export interface BuildRecordSegmentV4Args extends BuildSegmentTxBaseV4 {
    /** Shared SegmentMarketV4<C> object id. */
    marketId: string;
}
/**
 * Record one segment. The CRANKER (keeper or any rider) submits this as
 * the SOLE MoveCall in its PTB (Sui's PTB-command rule for Random:
 * `&Random`-consuming entries cannot have additional logic after them).
 */
export declare function buildRecordSegmentV4Tx(a: BuildRecordSegmentV4Args): Transaction;
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
export declare function buildOpenSegmentRideV4Tx(a: BuildOpenSegmentRideV4Args): Transaction;
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
export declare function buildCloseSegmentRideV4Tx(a: BuildCloseSegmentRideV4Args): Transaction;
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
export declare function buildCrankExpiredSegmentRideV4Tx(a: BuildCrankExpiredSegmentRideV4Args): Transaction;
export interface BuildAbortSegmentRideV4Args extends BuildSegmentTxBaseV4 {
    rideId: string;
    marketId: string;
    vaultId: string;
    /** Address to receive the 1:1 escrow refund (the ride's `user` field). */
    refundRecipient: string;
}
/** Past `abort_segment_deadline_ms` with no segment progress → 1:1 refund. */
export declare function buildAbortSegmentRideV4Tx(a: BuildAbortSegmentRideV4Args): Transaction;
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
    multiplierBps: bigint;
    openedAtMs: bigint;
}
export interface RideClosedV4Event {
    rideId: string;
    marketId: string;
    roundIndex: bigint;
    settlementKind: number;
    closedAtMs: bigint;
    payout: bigint;
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
export declare function segmentMarketV4CreatedEventType(packageId: string): string;
export declare function roundStartedV4EventType(packageId: string): string;
export declare function segmentRecordedV4EventType(packageId: string): string;
export declare function rideOpenedV4EventType(packageId: string): string;
export declare function rideClosedV4EventType(packageId: string): string;
export declare function rugFiredV4EventType(packageId: string): string;
export declare function parseSegmentMarketV4CreatedEvent(json: Record<string, unknown>): SegmentMarketV4CreatedEvent;
export declare function parseRoundStartedV4Event(json: Record<string, unknown>): RoundStartedV4Event;
export declare function parseSegmentRecordedV4Event(json: Record<string, unknown>): SegmentRecordedV4Event;
export declare function parseRideOpenedV4Event(json: Record<string, unknown>): RideOpenedV4Event;
export declare function parseRideClosedV4Event(json: Record<string, unknown>): RideClosedV4Event;
/**
 * Parse just the `parsedJson` payload of a `RugFiredV4` event. The wrapping
 * `digest` + `timestampMs` fields come from the SuiEvent envelope and are
 * filled in by `subscribeRugFiredV4` — this helper only handles the on-chain
 * fields, so it can be reused by replay/verify code paths.
 */
export declare function parseRugFiredV4EventJson(json: Record<string, unknown>): Pick<RugFiredV4Event, "marketId" | "roundIndex" | "segmentIndex">;
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
export declare function segmentMarketV4TypeOriginPackage(type: string): string | null;
/**
 * Read a SegmentMarketV4<C>'s on-chain state. Returns null if the object id
 * is missing or doesn't match the expected struct.
 */
export declare function fetchSegmentMarketV4(client: SuiJsonRpcClient, marketId: string): Promise<SegmentMarketV4Snapshot | null>;
/**
 * Read SegmentRecordedV4 events for a market in [fromK, toK). Each event
 * carries the segment key + extremes — the chart code replays them
 * through `seededPath.expandSegment` to render candles client-side.
 *
 * Mirrors `fetchSegments` from segmentMarket.ts but for the V4 event tag.
 */
export declare function fetchSegmentsV4(client: SuiJsonRpcClient, opts: {
    packageId: string;
    marketId: string;
    fromK: bigint;
    toK: bigint;
    /** Max events per RPC page. Defaults to 50. */
    pageLimit?: number;
    /** Max pages to scan before giving up. Defaults to 100. */
    maxPages?: number;
}): Promise<Array<{
    k: bigint;
    key: Uint8Array;
    minPrice: bigint;
    maxPrice: bigint;
    recordedAtMs: bigint;
}>>;
/** Read a SegmentRidePositionV4 by id. Returns null if missing or wrong type. */
export declare function fetchSegmentRidePositionV4(client: SuiJsonRpcClient, rideId: string): Promise<SegmentRidePositionV4Snapshot | null>;
/**
 * Default cadence for the rug subscriber's `queryEvents` polling loop, in ms.
 * Mirrors `EVENT_POLL_MS` in `frontend/src/hooks/useSegmentRideV4.ts` — sits
 * just under the 400ms segment tick so a rug event is visible to the UI on
 * the same animation frame as the segment that fired it.
 */
export declare const DEFAULT_RUG_POLL_MS = 350;
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
export declare function subscribeRugFiredV4(client: SuiJsonRpcClient, marketId: string, packageId: string, onEvent: (event: RugFiredV4Event) => void, options?: {
    pollIntervalMs?: number;
}): () => void;
//# sourceMappingURL=segmentMarketV4.d.ts.map