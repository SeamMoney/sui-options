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
import { Transaction } from "@mysten/sui/transactions";
// ── Constants from the Move module ──────────────────────────────────────────
/** `barrier_index = 0` → upper barrier (touch from below). */
export const BARRIER_UPPER = 0;
/** `barrier_index = 1` → lower barrier (touch from above). */
export const BARRIER_LOWER = 1;
export const SETTLEMENT_OPEN = 0;
export const SETTLEMENT_TOUCH_WIN = 1;
export const SETTLEMENT_CASHOUT = 2;
export const SETTLEMENT_EXPIRED_LOSS = 3;
export const SETTLEMENT_ABORTED_REFUND = 4;
export const SETTLEMENT_NAME = {
    0: "OPEN",
    1: "TOUCH_WIN",
    2: "CASHOUT",
    3: "EXPIRED_LOSS",
    4: "ABORTED_REFUND",
};
/** Per doc 17 §10 — segment cadence is 400 ms. */
export const DEFAULT_SEGMENT_MS = 400n;
/** 50 bps of stake_paid paid to the cranker on `crank_expired_segment_ride`. */
export const CRANK_BOUNTY_BPS = 50n;
/**
 * Admin: construct + share a SegmentMarket<C>. Market id is in the emitted
 * `SegmentMarketCreated` event — read via `parseSegmentMarketCreatedEvent`.
 */
export function buildBootstrapSegmentMarketTx(a) {
    const tx = new Transaction();
    tx.setSender(a.sender);
    tx.moveCall({
        target: `${a.packageId}::wick::bootstrap_segment_market`,
        typeArguments: [a.collateralType],
        arguments: [
            tx.pure.u64(a.homePrice),
            tx.pure.u64(a.volRegimeInit),
            tx.pure.u64(a.roundDurationSegments),
            tx.pure.u64(a.openWindowSegments),
            tx.pure.u64(a.barrierOffsetBps),
            tx.pure.u64(a.multiplierBps),
            tx.pure.u64(a.maxPayoutPerBarrier),
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
/**
 * Record one segment. The CRANKER (keeper or any rider) submits this as
 * the SOLE MoveCall in its PTB. Per doc 17a §6.2 R1 + Sui's PTB-command
 * rule (only TransferObjects / MergeCoins may follow a Random MoveCall),
 * no additional logic command can be tacked on after this — that
 * structural protection is what closes the test-and-abort grinder.
 */
export function buildRecordSegmentTx(a) {
    const tx = new Transaction();
    tx.setSender(a.sender);
    tx.moveCall({
        target: `${a.packageId}::wick::record_segment`,
        typeArguments: [a.collateralType],
        arguments: [
            tx.object(a.marketId),
            tx.object.random(),
            tx.object.clock(),
        ],
    });
    return tx;
}
/**
 * Open a ride against the current round's chosen barrier. The PTB splits
 * gas → escrow coin, opens the ride, transfers the position to the
 * sender. Optimistic UI per doc 17 §14.5.
 */
export function buildOpenSegmentRideTx(a) {
    if (a.escrowMist <= 0n)
        throw new Error("escrowMist must be > 0");
    if (a.stakePerSegment <= 0n)
        throw new Error("stakePerSegment must be > 0");
    const tx = new Transaction();
    tx.setSender(a.sender);
    const [escrow] = tx.splitCoins(tx.gas, [tx.pure.u64(a.escrowMist)]);
    const ride = tx.moveCall({
        target: `${a.packageId}::wick::open_segment_ride`,
        typeArguments: [a.collateralType],
        arguments: [
            tx.object(a.marketId),
            tx.object(a.vaultId),
            tx.object(a.botRegistryId),
            tx.pure.u8(a.barrierIndex),
            tx.pure.u64(a.stakePerSegment),
            escrow,
            tx.object.clock(),
        ],
    });
    tx.transferObjects([ride], tx.pure.address(a.sender));
    return tx;
}
/** Voluntary close. Settlement kind decided on-chain (see Move §9). */
export function buildCloseSegmentRideTx(a) {
    const tx = new Transaction();
    tx.setSender(a.sender);
    const payout = tx.moveCall({
        target: `${a.packageId}::wick::close_segment_ride`,
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
/**
 * Crank a ride past its round end (no touch). Returns the bounty coin to
 * the cranker; pushes the user's refund directly to the user. The SEV-1
 * treasury-cover guard on the Move side refuses the call if the vault
 * can't cover (user_refund + bounty) — the user must self-close in that case.
 */
export function buildCrankExpiredSegmentRideTx(a) {
    const tx = new Transaction();
    tx.setSender(a.sender);
    const bounty = tx.moveCall({
        target: `${a.packageId}::wick::crank_expired_segment_ride`,
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
/**
 * Past `abort_segment_deadline_ms` with no segment progress → 1:1 refund.
 * No WICK mint (no loss). Returns the Coin which we transfer to the
 * refundRecipient. Callable by anyone.
 */
export function buildAbortSegmentRideTx(a) {
    const tx = new Transaction();
    tx.setSender(a.sender);
    const refund = tx.moveCall({
        target: `${a.packageId}::wick::abort_segment_ride`,
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
// ── Event type tags (for queryEvents / subscribe) ───────────────────────────
export function segmentMarketCreatedEventType(packageId) {
    return `${packageId}::segment_market::SegmentMarketCreated`;
}
export function roundStartedEventType(packageId) {
    return `${packageId}::segment_market::RoundStarted`;
}
export function segmentRecordedEventType(packageId) {
    return `${packageId}::segment_market::SegmentRecorded`;
}
export function rideOpenedEventType(packageId) {
    return `${packageId}::segment_market::RideOpened`;
}
export function rideClosedEventType(packageId) {
    return `${packageId}::segment_market::RideClosed`;
}
// ── Event parsers ───────────────────────────────────────────────────────────
function asBigInt(v) {
    if (typeof v === "bigint")
        return v;
    if (typeof v === "number")
        return BigInt(v);
    if (typeof v === "string")
        return BigInt(v);
    return 0n;
}
function asNumber(v) {
    if (typeof v === "number")
        return v;
    if (typeof v === "string")
        return Number(v);
    if (typeof v === "bigint")
        return Number(v);
    return 0;
}
function asString(v) {
    return typeof v === "string" ? v : String(v);
}
function asBarrierIndex(v) {
    const n = asNumber(v);
    return n === 0 ? BARRIER_UPPER : BARRIER_LOWER;
}
function asKeyBytes(v) {
    if (v instanceof Uint8Array)
        return v;
    if (Array.isArray(v))
        return new Uint8Array(v);
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
export function parseSegmentMarketCreatedEvent(json) {
    return {
        marketId: asString(json.market_id),
        vaultId: asString(json.vault_id),
        homePrice: asBigInt(json.home_price),
        roundDurationSegments: asBigInt(json.round_duration_segments),
        openWindowSegments: asBigInt(json.open_window_segments),
        barrierOffsetBps: asBigInt(json.barrier_offset_bps),
        multiplierBps: asBigInt(json.multiplier_bps),
        maxPayoutPerBarrier: asBigInt(json.max_payout_per_barrier),
        createdAtMs: asBigInt(json.created_at_ms),
    };
}
export function parseRoundStartedEvent(json) {
    return {
        marketId: asString(json.market_id),
        roundIndex: asBigInt(json.round_index),
        upperBarrier: asBigInt(json.upper_barrier),
        lowerBarrier: asBigInt(json.lower_barrier),
        startedAtSegment: asBigInt(json.started_at_segment),
        spotAtRoll: asBigInt(json.spot_at_roll),
    };
}
export function parseSegmentRecordedEvent(json) {
    return {
        marketId: asString(json.market_id),
        k: asBigInt(json.k),
        key: asKeyBytes(json.key),
        minPrice: asBigInt(json.min_price),
        maxPrice: asBigInt(json.max_price),
        recordedAtMs: asBigInt(json.recorded_at_ms),
    };
}
export function parseRideOpenedEvent(json) {
    return {
        rideId: asString(json.ride_id),
        user: asString(json.user),
        marketId: asString(json.market_id),
        roundIndex: asBigInt(json.round_index),
        barrierIndex: asBarrierIndex(json.barrier_index),
        barrierPrice: asBigInt(json.barrier_price),
        stakePerSegment: asBigInt(json.stake_per_segment),
        escrowed: asBigInt(json.escrowed),
        multiplierBps: asBigInt(json.multiplier_bps),
        entrySegmentIndex: asBigInt(json.entry_segment_index),
        openedAtMs: asBigInt(json.opened_at_ms),
    };
}
export function parseRideClosedEvent(json) {
    return {
        rideId: asString(json.ride_id),
        user: asString(json.user),
        marketId: asString(json.market_id),
        roundIndex: asBigInt(json.round_index),
        barrierIndex: asBarrierIndex(json.barrier_index),
        settlementKind: asNumber(json.settlement_kind),
        stakePaid: asBigInt(json.stake_paid),
        payout: asBigInt(json.payout),
        forfeit: asBigInt(json.forfeit),
        bounty: asBigInt(json.bounty),
        closedAtMs: asBigInt(json.closed_at_ms),
    };
}
/** Extract the type argument from a v2/v3 SegmentMarket type string. */
function extractCollateralFromMarketType(type) {
    const m = /::(?:segment_market::SegmentMarket|segment_market_v3::SegmentMarketV3)<(.+)>$/.exec(type);
    return m && m[1] ? m[1] : null;
}
function extractCollateralFromRideType(_type) {
    // SegmentRidePosition has no type arg; the collateral lives in a field.
    return "";
}
/**
 * Read a SegmentMarket<C>'s on-chain state. Returns null if the object id
 * is missing or doesn't match the expected struct.
 */
export async function fetchSegmentMarket(client, marketId) {
    const o = await client.getObject({
        id: marketId,
        options: { showContent: true, showType: true },
    });
    if (!o.data || o.data.content?.dataType !== "moveObject")
        return null;
    const content = o.data.content;
    const collateralType = extractCollateralFromMarketType(content.type);
    if (!collateralType)
        return null;
    const f = content.fields;
    const walk = f.walk;
    const walkFields = walk && walk.fields;
    const walkPrice = walkFields ? asBigInt(walkFields.price) : 0n;
    return {
        id: o.data.objectId,
        collateralType,
        vaultId: asString(f.vault_id),
        walkPrice,
        nextSegmentIndex: asBigInt(f.next_segment_index),
        activeRideCount: asBigInt(f.active_ride_count),
        roundDurationSegments: asBigInt(f.round_duration_segments),
        openWindowSegments: asBigInt(f.open_window_segments),
        barrierOffsetBps: asBigInt(f.barrier_offset_bps),
        multiplierBps: asBigInt(f.multiplier_bps),
        maxPayoutPerBarrier: asBigInt(f.max_payout_per_barrier),
        cachedRoundIndex: asBigInt(f.cached_round_index),
        cachedRoundStartedAtSegment: asBigInt(f.cached_round_started_at_segment),
        cachedUpperBarrier: asBigInt(f.cached_upper_barrier),
        cachedLowerBarrier: asBigInt(f.cached_lower_barrier),
        upperAggregateStake: asBigInt(f.upper_aggregate_stake),
        lowerAggregateStake: asBigInt(f.lower_aggregate_stake),
        upperAggregateMaxPayout: asBigInt(f.upper_aggregate_max_payout),
        lowerAggregateMaxPayout: asBigInt(f.lower_aggregate_max_payout),
        upperRiderCount: asBigInt(f.upper_rider_count),
        lowerRiderCount: asBigInt(f.lower_rider_count),
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
 * Read SegmentRecorded events for a market in [fromK, toK). Each event
 * carries the segment key + extremes — the chart code replays them
 * through `seededPath.expandSegment` to render candles client-side.
 *
 * Events are scoped to the package and filtered client-side by
 * `marketId`. For wide ranges, consider paging via `cursor`.
 */
export async function fetchSegments(client, opts) {
    if (opts.toK <= opts.fromK)
        return [];
    const out = [];
    const wanted = new Set();
    let k = opts.fromK;
    while (k < opts.toK) {
        wanted.add(k.toString());
        k = k + 1n;
    }
    const pageLimit = opts.pageLimit ?? 50;
    const maxPages = opts.maxPages ?? 100;
    let cursor = null;
    for (let p = 0; p < maxPages; p++) {
        const page = await client.queryEvents({
            query: { MoveEventType: segmentRecordedEventType(opts.packageId) },
            cursor,
            limit: pageLimit,
            order: "descending",
        });
        for (const ev of page.data) {
            const j = ev.parsedJson;
            const mid = asString(j.market_id);
            if (mid !== opts.marketId)
                continue;
            const kStr = asString(j.k);
            if (!wanted.has(kStr))
                continue;
            out.push({
                k: asBigInt(j.k),
                key: asKeyBytes(j.key),
                minPrice: asBigInt(j.min_price),
                maxPrice: asBigInt(j.max_price),
                recordedAtMs: asBigInt(j.recorded_at_ms),
                // walkPriceAfter is NOT in the event — fill 0 here; callers that
                // need it can read the on-chain SegmentMarket.segments table.
                walkPriceAfter: 0n,
            });
            wanted.delete(kStr);
        }
        if (wanted.size === 0)
            break;
        if (!page.hasNextPage || !page.nextCursor)
            break;
        cursor = page.nextCursor;
    }
    return out.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
}
/** Read a SegmentRidePosition by id. Returns null if missing or wrong type. */
export async function fetchSegmentRidePosition(client, rideId) {
    const o = await client.getObject({
        id: rideId,
        options: { showContent: true, showType: true },
    });
    if (!o.data || o.data.content?.dataType !== "moveObject")
        return null;
    const content = o.data.content;
    if (!/::segment_market::SegmentRidePosition$/.test(content.type))
        return null;
    const f = content.fields;
    const collateralField = f.collateral;
    const collateralFields = collateralField && collateralField.fields;
    const collateralName = collateralFields ? asString(collateralFields.name) : "";
    return {
        id: o.data.objectId,
        user: asString(f.user),
        marketId: asString(f.market_id),
        collateralType: collateralName,
        roundIndex: asBigInt(f.round_index),
        entrySegmentIndex: asBigInt(f.entry_segment_index),
        barrierIndex: asBarrierIndex(f.barrier_index),
        barrierPrice: asBigInt(f.barrier_price),
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
// Reference an unused import name to silence noUnusedLocals when callers
// don't need every helper. (extractCollateralFromRideType is a placeholder
// for future schema work.)
void extractCollateralFromRideType;
//# sourceMappingURL=segmentMarket.js.map