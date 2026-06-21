/**
 * SDK surface for the segment-market arcade.
 *
 * Mirrors the on-chain entry points in `move/sources/segment_market.move`
 * + the entry re-exports in `wick.move`. Designed against:
 *   - docs/design/v2/18_segment_market_design.md (module layout)
 *   - docs/design/v2/19_round_shared_grid_design.md (round + barrier grid)
 *
 * Two sub-surfaces:
 *   1. PTB builders — `buildBootstrapSegmentMarketTx`, `buildRecordSegmentTx`,
 *      `buildOpenSegmentRideTx`, `buildCloseSegmentRideTx`,
 *      `buildCrankExpiredSegmentRideTx`, `buildAbortSegmentRideTx`.
 *   2. Read helpers + event types — `fetchSegmentMarket`, `fetchSegments`,
 *      `fetchSegmentRidePosition`, plus typed wrappers for `RoundStarted`,
 *      `RideOpened`, `RideClosed`, `SegmentRecorded`.
 *
 * BigInt is used end-to-end for u64 fields to avoid JS Number truncation
 * past 2^53.
 */
import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
/** `barrier_index = 0` → upper barrier (touch from below). */
export declare const BARRIER_UPPER: 0;
/** `barrier_index = 1` → lower barrier (touch from above). */
export declare const BARRIER_LOWER: 1;
export type BarrierIndex = typeof BARRIER_UPPER | typeof BARRIER_LOWER;
export declare const SETTLEMENT_OPEN: 0;
export declare const SETTLEMENT_TOUCH_WIN: 1;
export declare const SETTLEMENT_CASHOUT: 2;
export declare const SETTLEMENT_EXPIRED_LOSS: 3;
export declare const SETTLEMENT_ABORTED_REFUND: 4;
export declare const SETTLEMENT_NAME: {
    readonly 0: "OPEN";
    readonly 1: "TOUCH_WIN";
    readonly 2: "CASHOUT";
    readonly 3: "EXPIRED_LOSS";
    readonly 4: "ABORTED_REFUND";
};
/** Per doc 17 §10 — segment cadence is 400 ms. */
export declare const DEFAULT_SEGMENT_MS = 400n;
/** 50 bps of stake_paid paid to the cranker on `crank_expired_segment_ride`. */
export declare const CRANK_BOUNTY_BPS = 50n;
export interface BuildSegmentTxBase {
    /** Wick package id — current `package_id` from deployments JSON. */
    packageId: string;
    /** Collateral type tag, e.g. "0x2::sui::SUI". */
    collateralType: string;
    /** Tx sender address. */
    sender: string;
}
export interface BuildBootstrapSegmentMarketArgs extends BuildSegmentTxBase {
    /** ID of the shared MartingalerVault<C> this market binds to. */
    vaultId: string;
    /** Walk home price in micro-USD (the mean-reversion target). */
    homePrice: bigint;
    /** Initial vol_regime (1.0 in 1e6 fixed-point = 1_000_000). */
    volRegimeInit: bigint;
    /** Segments per round — 75 = 30 s at 400 ms/seg (doc 19 §4). */
    roundDurationSegments: bigint;
    /** Open-window segments — 13 ≈ 5.2 s (doc 19 §4). */
    openWindowSegments: bigint;
    /** Distance of each barrier from the round's open spot, in bps. 500 = ±5%. */
    barrierOffsetBps: bigint;
    /** Touch-payoff multiplier in bps. 20_000 = 2× (doc 19 §4). */
    multiplierBps: bigint;
    /** Per-barrier liability cap (sum of `escrow × multiplier / 10_000`). */
    maxPayoutPerBarrier: bigint;
    /** Anti-jitter margin around the barrier for the scan. */
    deadbandBps: bigint;
    /** Vol model parameter for the cashout factor. */
    sigmaBpsPerSqrtSec: bigint;
    /** Spread shaved off the cashout factor (lender keeps it). */
    cashoutSpreadBps: bigint;
    /** Wall-time after `opened_at_ms` past which `abort_segment_ride` is callable. */
    abortSegmentDeadlineMs: bigint;
    minStakePerSegment: bigint;
    maxStakePerSegment: bigint;
    maxConcurrentRides: bigint;
    maxRidesPerUser: bigint;
}
/**
 * Admin: construct + share a SegmentMarket<C>. Market id is in the emitted
 * `SegmentMarketCreated` event — read via `parseSegmentMarketCreatedEvent`.
 */
export declare function buildBootstrapSegmentMarketTx(a: BuildBootstrapSegmentMarketArgs): Transaction;
export interface BuildRecordSegmentArgs extends BuildSegmentTxBase {
    /** Shared SegmentMarket<C> object id. */
    marketId: string;
}
/**
 * Record one segment. The CRANKER (keeper or any rider) submits this as
 * the SOLE MoveCall in its PTB. Per doc 17a §6.2 R1 + Sui's PTB-command
 * rule (only TransferObjects / MergeCoins may follow a Random MoveCall),
 * no additional logic command can be tacked on after this — that
 * structural protection is what closes the test-and-abort grinder.
 */
export declare function buildRecordSegmentTx(a: BuildRecordSegmentArgs): Transaction;
export interface BuildOpenSegmentRideArgs extends BuildSegmentTxBase {
    marketId: string;
    vaultId: string;
    /** Shared BotRegistry id (for the WICK-mint anti-bot snapshot). */
    botRegistryId: string;
    barrierIndex: BarrierIndex;
    stakePerSegment: bigint;
    /** Total escrow to lock — must be ≥ stakePerSegment × roundDurationSegments. */
    escrowMist: bigint;
}
/**
 * Open a ride against the current round's chosen barrier. The PTB splits
 * gas → escrow coin, opens the ride, transfers the position to the
 * sender. Optimistic UI per doc 17 §14.5.
 */
export declare function buildOpenSegmentRideTx(a: BuildOpenSegmentRideArgs): Transaction;
export interface BuildCloseSegmentRideArgs extends BuildSegmentTxBase {
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
/** Voluntary close. Settlement kind decided on-chain (see Move §9). */
export declare function buildCloseSegmentRideTx(a: BuildCloseSegmentRideArgs): Transaction;
export interface BuildCrankExpiredSegmentRideArgs extends BuildSegmentTxBase {
    rideId: string;
    marketId: string;
    vaultId: string;
    priceOracleId: string;
    tokenStateId: string;
    stakingPoolId: string;
}
/**
 * Crank a ride past its round end (no touch). Returns the bounty coin to
 * the cranker; pushes the user's refund directly to the user. The SEV-1
 * treasury-cover guard on the Move side refuses the call if the vault
 * can't cover (user_refund + bounty) — the user must self-close in that case.
 */
export declare function buildCrankExpiredSegmentRideTx(a: BuildCrankExpiredSegmentRideArgs): Transaction;
export interface BuildAbortSegmentRideArgs extends BuildSegmentTxBase {
    rideId: string;
    marketId: string;
    vaultId: string;
    /**
     * Address to receive the 1:1 escrow refund. Defaults to the ride's
     * `user` field — pass that here. (Move doesn't read it; only used so the
     * Coin lands in the right pocket.)
     */
    refundRecipient: string;
}
/**
 * Past `abort_segment_deadline_ms` with no segment progress → 1:1 refund.
 * No WICK mint (no loss). Returns the Coin which we transfer to the
 * refundRecipient. Callable by anyone.
 */
export declare function buildAbortSegmentRideTx(a: BuildAbortSegmentRideArgs): Transaction;
export interface SegmentMarketCreatedEvent {
    marketId: string;
    vaultId: string;
    homePrice: bigint;
    roundDurationSegments: bigint;
    openWindowSegments: bigint;
    barrierOffsetBps: bigint;
    multiplierBps: bigint;
    maxPayoutPerBarrier: bigint;
    createdAtMs: bigint;
}
export interface RoundStartedEvent {
    marketId: string;
    roundIndex: bigint;
    upperBarrier: bigint;
    lowerBarrier: bigint;
    startedAtSegment: bigint;
    spotAtRoll: bigint;
}
export interface SegmentRecordedEvent {
    marketId: string;
    k: bigint;
    /** 32-byte segment key drawn from sui::random. */
    key: Uint8Array;
    minPrice: bigint;
    maxPrice: bigint;
    recordedAtMs: bigint;
}
export interface RideOpenedEvent {
    rideId: string;
    user: string;
    marketId: string;
    roundIndex: bigint;
    barrierIndex: BarrierIndex;
    /** The barrier price snapshotted at open. */
    barrierPrice: bigint;
    stakePerSegment: bigint;
    escrowed: bigint;
    multiplierBps: bigint;
    entrySegmentIndex: bigint;
    openedAtMs: bigint;
}
export interface RideClosedEvent {
    rideId: string;
    user: string;
    marketId: string;
    roundIndex: bigint;
    barrierIndex: BarrierIndex;
    settlementKind: number;
    stakePaid: bigint;
    payout: bigint;
    forfeit: bigint;
    bounty: bigint;
    closedAtMs: bigint;
}
export declare function segmentMarketCreatedEventType(packageId: string): string;
export declare function roundStartedEventType(packageId: string): string;
export declare function segmentRecordedEventType(packageId: string): string;
export declare function rideOpenedEventType(packageId: string): string;
export declare function rideClosedEventType(packageId: string): string;
export declare function parseSegmentMarketCreatedEvent(json: Record<string, unknown>): SegmentMarketCreatedEvent;
export declare function parseRoundStartedEvent(json: Record<string, unknown>): RoundStartedEvent;
export declare function parseSegmentRecordedEvent(json: Record<string, unknown>): SegmentRecordedEvent;
export declare function parseRideOpenedEvent(json: Record<string, unknown>): RideOpenedEvent;
export declare function parseRideClosedEvent(json: Record<string, unknown>): RideClosedEvent;
export interface SegmentMarketSnapshot {
    id: string;
    collateralType: string;
    vaultId: string;
    walkPrice: bigint;
    nextSegmentIndex: bigint;
    activeRideCount: bigint;
    roundDurationSegments: bigint;
    openWindowSegments: bigint;
    barrierOffsetBps: bigint;
    multiplierBps: bigint;
    maxPayoutPerBarrier: bigint;
    cachedRoundIndex: bigint;
    cachedRoundStartedAtSegment: bigint;
    cachedUpperBarrier: bigint;
    cachedLowerBarrier: bigint;
    upperAggregateStake: bigint;
    lowerAggregateStake: bigint;
    upperAggregateMaxPayout: bigint;
    lowerAggregateMaxPayout: bigint;
    upperRiderCount: bigint;
    lowerRiderCount: bigint;
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
export interface SegmentRecordSnapshot {
    k: bigint;
    key: Uint8Array;
    minPrice: bigint;
    maxPrice: bigint;
    recordedAtMs: bigint;
    walkPriceAfter: bigint;
}
export interface SegmentRidePositionSnapshot {
    id: string;
    user: string;
    marketId: string;
    collateralType: string;
    roundIndex: bigint;
    entrySegmentIndex: bigint;
    barrierIndex: BarrierIndex;
    barrierPrice: bigint;
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
 * Read a SegmentMarket<C>'s on-chain state. Returns null if the object id
 * is missing or doesn't match the expected struct.
 */
export declare function fetchSegmentMarket(client: SuiJsonRpcClient, marketId: string): Promise<SegmentMarketSnapshot | null>;
/**
 * Read SegmentRecorded events for a market in [fromK, toK). Each event
 * carries the segment key + extremes — the chart code replays them
 * through `seededPath.expandSegment` to render candles client-side.
 *
 * Events are scoped to the package and filtered client-side by
 * `marketId`. For wide ranges, consider paging via `cursor`.
 */
export declare function fetchSegments(client: SuiJsonRpcClient, opts: {
    packageId: string;
    marketId: string;
    fromK: bigint;
    toK: bigint;
    /** Max events per RPC page. Defaults to 50. */
    pageLimit?: number;
    /** Max pages to scan before giving up. Defaults to 100. */
    maxPages?: number;
}): Promise<SegmentRecordSnapshot[]>;
/** Read a SegmentRidePosition by id. Returns null if missing or wrong type. */
export declare function fetchSegmentRidePosition(client: SuiJsonRpcClient, rideId: string): Promise<SegmentRidePositionSnapshot | null>;
//# sourceMappingURL=segmentMarket.d.ts.map