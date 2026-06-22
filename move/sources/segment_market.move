// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// segment_market — the provably-fair arcade with round-based shared barriers.
/// Design: docs/design/v2/18_segment_market_design.md + 19_round_shared_grid_design.md.
///
/// One chart per market. Every `round_duration_segments` (default 75 ≈ 30s at
/// 400ms/segment), two shared barriers materialise at ±`barrier_offset_bps`
/// from the current walk price. For the first `open_window_segments`
/// (default 13 ≈ 5s), riders pick a barrier (upper=0 / lower=1) and stake;
/// after that, no new opens. The round plays out the remaining segments;
/// open rides settle (TOUCH_WIN / CASHOUT / EXPIRED_LOSS / ABORTED_REFUND).
///
/// Architectural decisions (doc 18 §1 + doc 19):
///   - Parallel module — `wick::ride_position` is untouched, the legacy arcade
///     coexists. (doc 18 §1.1)
///   - Consolidated — `SegmentMarket`, `SegmentRecord`, `SegmentRidePosition`
///     all live here; no separate caps module. (doc 18 §1.3)
///   - Round-based shared grid (NOT entry-relative per doc 18 §1.2) —
///     barriers are shared across all riders in a round; selection is closed
///     by the short open-window mechanic, not per-rider barriers. (doc 19 §2)
///   - Settlement scan in-module — `path_observation` is NOT reused (it
///     records ticks; segments have extremes). Deadband math is lifted from
///     `path_observation::apply_deadband_*`. (doc 18 §1.4)
///   - Cashout via `ride_pricing::bachelier_cashout_factor` with a
///     segments→seconds conversion. (doc 18 §1.5)
///
/// FAIRNESS: `record_segment` is `entry` (never `public`), draws a single
/// `u256` from `sui::random` per call, and runs the walk via
/// `seeded_path::expand_segment` whose control flow is independent of the
/// drawn key. The PTB-command rule (only TransferObjects/MergeCoins after a
/// Random MoveCall) plus the constant-gas walk closes the test-and-abort
/// grinding attack at the protocol layer. See doc 17a §6 for the proof.
#[allow(deprecated_usage)]
module wick::segment_market;

use std::type_name::{Self, TypeName};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::random::{Self as random, Random};
use sui::table::{Self, Table};
use wick::bot_registry::{Self as br, BotRegistry};
use wick::martingaler_vault::{Self as mv, MartingalerVault};
use wick::ride_pricing;
use wick::seeded_path::{Self as sp, WalkState};
use wick::usd_price_oracle::{Self as upo, UsdPriceOracle};
use wick::wick_staking::{Self as ws, WickStakingPool};
use wick::wick_token::{Self as wt, WickTokenState};

// === Errors ===
const EAlreadyClosed: u64 = 1;
const EWrongMarket: u64 = 2;
const EMarketAborted: u64 = 3;
const EInvalidBarrierIndex: u64 = 4;
const EOpenWindowClosed: u64 = 5;
const EStakeOutOfRange: u64 = 6;
const EInsufficientEscrow: u64 = 7;
const EZeroEscrow: u64 = 8;
const EConcurrentRideLimit: u64 = 9;
const EPerUserRideLimit: u64 = 10;
const EBarrierCapExceeded: u64 = 11;
const ENotExpired: u64 = 12;
const ETouchedMustSelfClose: u64 = 13;
const ENoActiveRides: u64 = 14;
const EInvalidConfig: u64 = 15;
const ENotPastAbortDeadline: u64 = 16;
const ESegmentAlreadyRecorded: u64 = 17;
/// SEV-1 guard preserved from ride_position.move:362-369. Crank refuses if
/// treasury can't cover (user_refund + bounty) without queue routing, which
/// would otherwise queue the shortfall under the keeper's address.
const EInsufficientTreasuryForCrank: u64 = 18;

// === Settlement kinds (mirror ride_position values; redefined locally to
//     keep modules decoupled per doc 18 §5) ===
const SETTLEMENT_OPEN: u8 = 0;
const SETTLEMENT_TOUCH_WIN: u8 = 1;
const SETTLEMENT_CASHOUT: u8 = 2;
const SETTLEMENT_EXPIRED_LOSS: u8 = 3;
const SETTLEMENT_ABORTED_REFUND: u8 = 4;

// === Barrier indices ===
const BARRIER_UPPER: u8 = 0;
const BARRIER_LOWER: u8 = 1;

// === Constants ===
const BPS_DENOMINATOR: u64 = 10_000;
const BPS_DENOM_128: u128 = 10_000;
/// 50 bps of stake_paid goes to whoever cranks an expired ride.
const CRANK_BOUNTY_BPS: u64 = 50;
/// Segment cadence baked in per doc 17 §10 — converts segment counts to
/// seconds for the Bachelier cashout factor.
const DEFAULT_SEGMENT_MS: u64 = 400;
const SECONDS_PER_MS: u64 = 1_000;

// === Types ===

/// One recorded segment — the on-chain ledger entry for `record_segment(k)`.
/// `state_after` is recomputable off-chain from key + state_before, but
/// storing it on-chain means settlement scans don't re-run `expand_segment`.
public struct SegmentRecord has store, copy, drop {
    /// 32-byte segment_key drawn from sui::random.
    key: vector<u8>,
    /// Walk state checkpoint after this segment.
    state_after: WalkState,
    /// Segment min — for the below-touch scan.
    min_price: u64,
    /// Segment max — for the above-touch scan.
    max_price: u64,
    /// For the per-ride abort-deadline check (B5 / doc 18 §6.6).
    recorded_at_ms: u64,
}

/// The arcade market — one shared object per (collateral, market) instance.
/// All round state, the segment ledger, and per-barrier per-round
/// aggregates live here.
public struct SegmentMarket<phantom C> has key {
    id: UID,

    // ── Walk (carried across segments) ──────────────────────────────────────
    walk: WalkState,

    // ── Segment ledger ──────────────────────────────────────────────────────
    next_segment_index: u64,
    segments: Table<u64, SegmentRecord>,

    // ── Wake/sleep gate — record_segment aborts when active==0 ──────────────
    active_ride_count: u64,

    // ── Round + shared grid configuration (immutable post-bootstrap) ────────
    round_duration_segments: u64,
    open_window_segments: u64,
    barrier_offset_bps: u64,
    multiplier_bps: u64,
    max_payout_per_barrier: u64,

    // ── Cached current-round state (lazy-rolled by ensure_round_current) ────
    cached_round_index: u64,
    cached_round_started_at_segment: u64,
    cached_upper_barrier: u64,
    cached_lower_barrier: u64,

    // ── Per-barrier per-round trackers (reset on round roll) ────────────────
    upper_aggregate_stake: u64,
    lower_aggregate_stake: u64,
    upper_aggregate_max_payout: u64,
    lower_aggregate_max_payout: u64,
    upper_rider_count: u64,
    lower_rider_count: u64,

    // ── Caps + scan/cashout knobs (immutable post-bootstrap) ────────────────
    deadband_bps: u64,
    sigma_bps_per_sqrt_sec: u64,
    cashout_spread_bps: u64,
    abort_segment_deadline_ms: u64,
    min_stake_per_segment: u64,
    max_stake_per_segment: u64,
    max_concurrent_rides: u64,
    max_rides_per_user: u64,
    per_user_open_count: Table<address, u64>,

    // ── Vault binding (immutable post-bootstrap) ────────────────────────────
    vault_id: ID,

    // ── Telemetry ───────────────────────────────────────────────────────────
    created_at_ms: u64,
}

/// A user's open ride against a specific round + barrier in a SegmentMarket.
public struct SegmentRidePosition has key, store {
    id: UID,
    user: address,
    market_id: ID,

    // ── Round binding (replaces doc 18's entry-relative fields per doc 19 §6)
    round_index: u64,
    /// = market.next_segment_index AT OPEN. The touch scan starts here.
    entry_segment_index: u64,
    /// 0 = upper, 1 = lower.
    barrier_index: u8,
    /// Barrier price snapshotted from market.cached_*_barrier at open.
    /// Kept on the ride (not looked up from the market) so settlement is
    /// stable if the market's round rolls between the ride's round end and
    /// the user's close call — the cached_*_barrier fields reflect the
    /// CURRENT round, not necessarily the ride's bound round.
    barrier_price: u64,
    /// Captured from market.multiplier_bps at open — immutable for the
    /// lifetime of the ride.
    multiplier_bps: u64,

    // ── Stake ───────────────────────────────────────────────────────────────
    stake_per_segment: u64,
    /// ≥ stake_per_segment × round_duration_segments — full escrow up-front.
    escrowed: u64,
    /// Captured from BotRegistry at open. Bot-ineligible riders skip WICK mint.
    is_bot_eligible: bool,

    // ── Settlement ──────────────────────────────────────────────────────────
    /// For the per-ride abort-deadline check (doc 18 §6.6).
    opened_at_ms: u64,
    closed: bool,
    closed_at_ms: u64,
    settlement_kind: u8,
    collateral: TypeName,
}

// === Events ===

public struct SegmentMarketCreated has copy, drop {
    market_id: ID,
    vault_id: ID,
    home_price: u64,
    round_duration_segments: u64,
    open_window_segments: u64,
    barrier_offset_bps: u64,
    multiplier_bps: u64,
    max_payout_per_barrier: u64,
    created_at_ms: u64,
}

public struct RoundStarted has copy, drop {
    market_id: ID,
    round_index: u64,
    upper_barrier: u64,
    lower_barrier: u64,
    started_at_segment: u64,
    spot_at_roll: u64,
}

public struct SegmentRecorded has copy, drop {
    market_id: ID,
    k: u64,
    key: vector<u8>,
    min_price: u64,
    max_price: u64,
    recorded_at_ms: u64,
}

public struct RideOpened has copy, drop {
    ride_id: ID,
    user: address,
    market_id: ID,
    round_index: u64,
    barrier_index: u8,
    /// The actual barrier price at open — clients render from this without
    /// re-reading market state.
    barrier_price: u64,
    stake_per_segment: u64,
    escrowed: u64,
    multiplier_bps: u64,
    entry_segment_index: u64,
    opened_at_ms: u64,
}

public struct RideClosed has copy, drop {
    ride_id: ID,
    user: address,
    market_id: ID,
    round_index: u64,
    barrier_index: u8,
    settlement_kind: u8,
    stake_paid: u64,
    payout: u64,
    forfeit: u64,
    bounty: u64,
    closed_at_ms: u64,
}

// === Read accessors ===

public fun market_id_of_ride(r: &SegmentRidePosition): ID { r.market_id }
public fun user(r: &SegmentRidePosition): address { r.user }
public fun round_index(r: &SegmentRidePosition): u64 { r.round_index }
public fun barrier_index(r: &SegmentRidePosition): u8 { r.barrier_index }
public fun barrier_price(r: &SegmentRidePosition): u64 { r.barrier_price }
public fun entry_segment_index(r: &SegmentRidePosition): u64 { r.entry_segment_index }
public fun multiplier_bps_of_ride(r: &SegmentRidePosition): u64 { r.multiplier_bps }
public fun stake_per_segment(r: &SegmentRidePosition): u64 { r.stake_per_segment }
public fun escrowed(r: &SegmentRidePosition): u64 { r.escrowed }
public fun is_bot_eligible(r: &SegmentRidePosition): bool { r.is_bot_eligible }
public fun opened_at_ms(r: &SegmentRidePosition): u64 { r.opened_at_ms }
public fun is_closed(r: &SegmentRidePosition): bool { r.closed }
public fun closed_at_ms(r: &SegmentRidePosition): u64 { r.closed_at_ms }
public fun settlement_kind(r: &SegmentRidePosition): u8 { r.settlement_kind }
public fun collateral(r: &SegmentRidePosition): &TypeName { &r.collateral }

public fun settlement_open(): u8 { SETTLEMENT_OPEN }
public fun settlement_touch_win(): u8 { SETTLEMENT_TOUCH_WIN }
public fun settlement_cashout(): u8 { SETTLEMENT_CASHOUT }
public fun settlement_expired_loss(): u8 { SETTLEMENT_EXPIRED_LOSS }
public fun settlement_aborted_refund(): u8 { SETTLEMENT_ABORTED_REFUND }
public fun barrier_upper(): u8 { BARRIER_UPPER }
public fun barrier_lower(): u8 { BARRIER_LOWER }
public fun default_segment_ms(): u64 { DEFAULT_SEGMENT_MS }
public fun crank_bounty_bps(): u64 { CRANK_BOUNTY_BPS }

public fun next_segment_index<C>(m: &SegmentMarket<C>): u64 { m.next_segment_index }
public fun active_ride_count<C>(m: &SegmentMarket<C>): u64 { m.active_ride_count }
public fun cached_round_index<C>(m: &SegmentMarket<C>): u64 { m.cached_round_index }
public fun cached_upper_barrier<C>(m: &SegmentMarket<C>): u64 { m.cached_upper_barrier }
public fun cached_lower_barrier<C>(m: &SegmentMarket<C>): u64 { m.cached_lower_barrier }
public fun cached_round_started_at_segment<C>(m: &SegmentMarket<C>): u64 {
    m.cached_round_started_at_segment
}
public fun upper_aggregate_stake<C>(m: &SegmentMarket<C>): u64 { m.upper_aggregate_stake }
public fun lower_aggregate_stake<C>(m: &SegmentMarket<C>): u64 { m.lower_aggregate_stake }
public fun upper_aggregate_max_payout<C>(m: &SegmentMarket<C>): u64 { m.upper_aggregate_max_payout }
public fun lower_aggregate_max_payout<C>(m: &SegmentMarket<C>): u64 { m.lower_aggregate_max_payout }
public fun upper_rider_count<C>(m: &SegmentMarket<C>): u64 { m.upper_rider_count }
public fun lower_rider_count<C>(m: &SegmentMarket<C>): u64 { m.lower_rider_count }
public fun vault_id<C>(m: &SegmentMarket<C>): ID { m.vault_id }
public fun round_duration_segments<C>(m: &SegmentMarket<C>): u64 { m.round_duration_segments }
public fun open_window_segments<C>(m: &SegmentMarket<C>): u64 { m.open_window_segments }
public fun barrier_offset_bps<C>(m: &SegmentMarket<C>): u64 { m.barrier_offset_bps }
public fun multiplier_bps<C>(m: &SegmentMarket<C>): u64 { m.multiplier_bps }
public fun max_payout_per_barrier<C>(m: &SegmentMarket<C>): u64 { m.max_payout_per_barrier }
public fun deadband_bps<C>(m: &SegmentMarket<C>): u64 { m.deadband_bps }
public fun walk_price<C>(m: &SegmentMarket<C>): u64 { sp::state_price(&m.walk) }

public fun has_segment<C>(m: &SegmentMarket<C>, k: u64): bool {
    table::contains(&m.segments, k)
}

public fun segment_min<C>(m: &SegmentMarket<C>, k: u64): u64 {
    table::borrow(&m.segments, k).min_price
}

public fun segment_max<C>(m: &SegmentMarket<C>, k: u64): u64 {
    table::borrow(&m.segments, k).max_price
}

public fun segment_recorded_at_ms<C>(m: &SegmentMarket<C>, k: u64): u64 {
    table::borrow(&m.segments, k).recorded_at_ms
}

public fun segment_key<C>(m: &SegmentMarket<C>, k: u64): vector<u8> {
    table::borrow(&m.segments, k).key
}

// === Constructor + share ===

/// Construct a new SegmentMarket. Validates parameters and seeds the initial
/// round state (round 0 from the home price). The market is returned by
/// value — `share_segment_market` shares it.
public fun new_segment_market<C>(
    vault: &MartingalerVault<C>,
    home_price: u64,
    vol_regime_init: u64,
    round_duration_segments: u64,
    open_window_segments: u64,
    barrier_offset_bps: u64,
    multiplier_bps: u64,
    max_payout_per_barrier: u64,
    deadband_bps: u64,
    sigma_bps_per_sqrt_sec: u64,
    cashout_spread_bps: u64,
    abort_segment_deadline_ms: u64,
    min_stake_per_segment: u64,
    max_stake_per_segment: u64,
    max_concurrent_rides: u64,
    max_rides_per_user: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): SegmentMarket<C> {
    // Parameter validation
    assert!(home_price > 0, EInvalidConfig);
    assert!(round_duration_segments > 0, EInvalidConfig);
    assert!(open_window_segments > 0, EInvalidConfig);
    assert!(open_window_segments <= round_duration_segments, EInvalidConfig);
    assert!(barrier_offset_bps > 0 && barrier_offset_bps <= BPS_DENOMINATOR, EInvalidConfig);
    assert!(multiplier_bps > BPS_DENOMINATOR, EInvalidConfig);
    assert!(deadband_bps <= BPS_DENOMINATOR, EInvalidConfig);
    assert!(cashout_spread_bps <= BPS_DENOMINATOR, EInvalidConfig);
    assert!(sigma_bps_per_sqrt_sec > 0, EInvalidConfig);
    assert!(min_stake_per_segment > 0, EInvalidConfig);
    assert!(max_stake_per_segment >= min_stake_per_segment, EInvalidConfig);
    assert!(max_concurrent_rides > 0, EInvalidConfig);
    assert!(max_rides_per_user > 0, EInvalidConfig);
    assert!(max_payout_per_barrier > 0, EInvalidConfig);
    assert!(vol_regime_init > 0, EInvalidConfig);

    let walk = sp::new_state(home_price, vol_regime_init, home_price);

    // Pre-compute round 0 barriers from the home price so the first
    // open_segment_ride sees a valid grid without needing record_segment first.
    let offset = ((home_price as u128) * (barrier_offset_bps as u128) / BPS_DENOM_128) as u64;
    let upper = home_price + offset;
    let lower = if (home_price > offset) home_price - offset else 1;

    let now = clock.timestamp_ms();
    let vault_id = object::id(vault);

    let market = SegmentMarket<C> {
        id: object::new(ctx),
        walk,
        next_segment_index: 0,
        segments: table::new(ctx),
        active_ride_count: 0,
        round_duration_segments,
        open_window_segments,
        barrier_offset_bps,
        multiplier_bps,
        max_payout_per_barrier,
        cached_round_index: 0,
        cached_round_started_at_segment: 0,
        cached_upper_barrier: upper,
        cached_lower_barrier: lower,
        upper_aggregate_stake: 0,
        lower_aggregate_stake: 0,
        upper_aggregate_max_payout: 0,
        lower_aggregate_max_payout: 0,
        upper_rider_count: 0,
        lower_rider_count: 0,
        deadband_bps,
        sigma_bps_per_sqrt_sec,
        cashout_spread_bps,
        abort_segment_deadline_ms,
        min_stake_per_segment,
        max_stake_per_segment,
        max_concurrent_rides,
        max_rides_per_user,
        per_user_open_count: table::new(ctx),
        vault_id,
        created_at_ms: now,
    };

    sui::event::emit(SegmentMarketCreated {
        market_id: object::id(&market),
        vault_id,
        home_price,
        round_duration_segments,
        open_window_segments,
        barrier_offset_bps,
        multiplier_bps,
        max_payout_per_barrier,
        created_at_ms: now,
    });

    market
}

/// Share a freshly-constructed SegmentMarket. Called by the admin
/// bootstrap entry in `wick.move`.
public entry fun share_segment_market<C>(market: SegmentMarket<C>) {
    transfer::share_object(market);
}

// === ensure_round_current — lazy round roll ===

/// Lazy-roll the round if `next_segment_index` has crossed into a new
/// round. Cheap no-op if the cached round is already current. Called by
/// every entry point that needs round state.
///
/// Per doc 19 §7.1: barriers are computed from the CURRENT walk price
/// (post-most-recent-segment), so the grid always reflects where price
/// actually is at the moment of the roll — not stale state.
fun ensure_round_current<C>(market: &mut SegmentMarket<C>) {
    let next_idx = market.next_segment_index;
    let current_round = next_idx / market.round_duration_segments;
    if (current_round <= market.cached_round_index) return;

    market.cached_round_index = current_round;
    market.cached_round_started_at_segment = current_round * market.round_duration_segments;

    let spot = sp::state_price(&market.walk);
    let offset = ((spot as u128) * (market.barrier_offset_bps as u128) / BPS_DENOM_128) as u64;
    market.cached_upper_barrier = spot + offset;
    market.cached_lower_barrier = if (spot > offset) spot - offset else 1;

    // Reset per-barrier per-round trackers
    market.upper_aggregate_stake = 0;
    market.lower_aggregate_stake = 0;
    market.upper_aggregate_max_payout = 0;
    market.lower_aggregate_max_payout = 0;
    market.upper_rider_count = 0;
    market.lower_rider_count = 0;

    sui::event::emit(RoundStarted {
        market_id: object::id(market),
        round_index: current_round,
        upper_barrier: market.cached_upper_barrier,
        lower_barrier: market.cached_lower_barrier,
        started_at_segment: market.cached_round_started_at_segment,
        spot_at_roll: spot,
    });
}

// === record_segment — the load-bearing constant-gas entry ===

/// Record one segment. Constant-gas obligation per doc 17a §4: no
/// value-dependent control flow at this level. The walk itself
/// (`seeded_path::expand_segment`) is also constant-gas by spec.
///
/// MUST be `entry` (not `public`) per doc 17a §1.4 + §6.2 R1: a
/// `&Random`-consuming function cannot be `public`. The PTB-command rule
/// (only TransferObjects/MergeCoins after a Random MoveCall) plus this
/// constraint closes the test-and-abort grinder.
///
/// Wake/sleep gate: aborts if `active_ride_count == 0` so a dormant
/// market doesn't burn keeper gas.
///
/// `public(package) entry` (NOT `public entry`) — the verifier forbids
/// `public entry` on functions taking `&Random`. `public(package)`
/// permits the `wick.move` router to re-export this as its own entry;
/// other packages cannot call it.
public(package) entry fun record_segment<C>(
    market: &mut SegmentMarket<C>,
    r: &Random,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    // R3: value-independent asserts only.
    assert!(market.active_ride_count > 0, ENoActiveRides);

    // Lazy-roll the round if needed BEFORE recording (per doc 19 §7.1).
    // Cheap no-op if already current. This keeps the cached round in sync
    // with `next_segment_index` for any reader that doesn't call open.
    ensure_round_current(market);

    // R5: single wide draw, deterministic expansion. One generate_bytes(32)
    // per call — no _in_range / shuffle / rejection sampling.
    let mut gen = random::new_generator(r, ctx);
    let key = random::generate_bytes(&mut gen, 32);

    // R2: the walk is constant-gas per seeded_path's spec — 6 candles ×
    // 6 ticks × 7 draws, fixed shape, no key-dependent loop bound.
    let (_candles, new_walk, smin, smax) = sp::expand_segment(market.walk, key);

    let k = market.next_segment_index;
    // Defensive: should be impossible since k == next_segment_index and
    // next_segment_index is only ever incremented here, but assert anyway.
    assert!(!table::contains(&market.segments, k), ESegmentAlreadyRecorded);

    let recorded_at = clock.timestamp_ms();
    let record = SegmentRecord {
        key,
        state_after: new_walk,
        min_price: smin,
        max_price: smax,
        recorded_at_ms: recorded_at,
    };
    table::add(&mut market.segments, k, record);
    market.walk = new_walk;
    market.next_segment_index = k + 1;

    sui::event::emit(SegmentRecorded {
        market_id: object::id(market),
        k,
        key,
        min_price: smin,
        max_price: smax,
        recorded_at_ms: recorded_at,
    });
}

// === open_segment_ride ===

/// Open a ride against one of the round's two shared barriers.
/// Assertion order per doc 19 §8:
///   1. Vault binding
///   2. Valid barrier_index
///   3. Lazy-roll the round
///   4. Open-window assertion
///   5. Stake range check
///   6. Escrow capacity check
///   7. Global concurrency cap
///   8. Per-user cap
///   9. Vault-aborted check
///  10. Per-barrier cap check (max_payout)
public fun open_segment_ride<C>(
    market: &mut SegmentMarket<C>,
    vault: &mut MartingalerVault<C>,
    bot_registry: &BotRegistry,
    barrier_index: u8,
    stake_per_segment: u64,
    escrow: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): SegmentRidePosition {
    // 1. Vault binding
    assert!(market.vault_id == object::id(vault), EWrongMarket);
    // 2. Valid barrier_index
    assert!(
        barrier_index == BARRIER_UPPER || barrier_index == BARRIER_LOWER,
        EInvalidBarrierIndex,
    );
    // 3. Lazy-roll the round if needed
    ensure_round_current(market);

    // 4. Open-window assertion — must be within first
    //    `open_window_segments` of the current round.
    let segments_into_round =
        market.next_segment_index - market.cached_round_started_at_segment;
    assert!(segments_into_round < market.open_window_segments, EOpenWindowClosed);

    // 5. Stake range
    assert!(
        stake_per_segment >= market.min_stake_per_segment
            && stake_per_segment <= market.max_stake_per_segment,
        EStakeOutOfRange,
    );

    // 6. Escrow capacity — must cover stake_per_segment × round_duration_segments
    let escrow_amount = coin::value(&escrow);
    assert!(escrow_amount > 0, EZeroEscrow);
    let required_escrow =
        ((stake_per_segment as u128) * (market.round_duration_segments as u128)) as u128;
    assert!((escrow_amount as u128) >= required_escrow, EInsufficientEscrow);

    // 7. Global concurrency cap
    assert!(market.active_ride_count < market.max_concurrent_rides, EConcurrentRideLimit);

    // 8. Per-user cap
    let user = ctx.sender();
    let prior_user_open_count = if (table::contains(&market.per_user_open_count, user)) {
        *table::borrow(&market.per_user_open_count, user)
    } else { 0 };
    assert!(prior_user_open_count < market.max_rides_per_user, EPerUserRideLimit);

    // 9. Vault-aborted check
    let market_id = object::id(market);
    assert!(!mv::is_market_aborted(vault, market_id), EMarketAborted);

    // 10. Per-barrier cap check — incremental max_payout for this ride
    //     must not push the chosen barrier's aggregate over the cap.
    let this_ride_max_payout =
        (((escrow_amount as u128) * (market.multiplier_bps as u128)) / BPS_DENOM_128) as u64;
    if (barrier_index == BARRIER_UPPER) {
        assert!(
            market.upper_aggregate_max_payout + this_ride_max_payout
                <= market.max_payout_per_barrier,
            EBarrierCapExceeded,
        );
    } else {
        assert!(
            market.lower_aggregate_max_payout + this_ride_max_payout
                <= market.max_payout_per_barrier,
            EBarrierCapExceeded,
        );
    };

    // 11. Bump per-barrier trackers
    if (barrier_index == BARRIER_UPPER) {
        market.upper_aggregate_stake = market.upper_aggregate_stake + escrow_amount;
        market.upper_aggregate_max_payout =
            market.upper_aggregate_max_payout + this_ride_max_payout;
        market.upper_rider_count = market.upper_rider_count + 1;
    } else {
        market.lower_aggregate_stake = market.lower_aggregate_stake + escrow_amount;
        market.lower_aggregate_max_payout =
            market.lower_aggregate_max_payout + this_ride_max_payout;
        market.lower_rider_count = market.lower_rider_count + 1;
    };

    // 12. Bump active_ride_count + per-user open count
    market.active_ride_count = market.active_ride_count + 1;
    if (table::contains(&market.per_user_open_count, user)) {
        let v = table::borrow_mut(&mut market.per_user_open_count, user);
        *v = *v + 1;
    } else {
        table::add(&mut market.per_user_open_count, user, 1);
    };

    // 13. Escrow into the vault's treasury
    mv::deposit_ride_escrow<C>(vault, escrow);

    // 14. Snapshot bot eligibility for the WICK-mint gate (matches the
    //     legacy ride_position pattern).
    let is_bot_eligible = br::is_eligible_for_wick(bot_registry, user);

    let now = clock.timestamp_ms();
    // Snapshot the barrier price for the event so clients render off-event.
    let barrier_price = if (barrier_index == BARRIER_UPPER) {
        market.cached_upper_barrier
    } else {
        market.cached_lower_barrier
    };

    let ride = SegmentRidePosition {
        id: object::new(ctx),
        user,
        market_id,
        round_index: market.cached_round_index,
        entry_segment_index: market.next_segment_index,
        barrier_index,
        barrier_price,
        multiplier_bps: market.multiplier_bps,
        stake_per_segment,
        escrowed: escrow_amount,
        is_bot_eligible,
        opened_at_ms: now,
        closed: false,
        closed_at_ms: 0,
        settlement_kind: SETTLEMENT_OPEN,
        collateral: type_name::with_defining_ids<C>(),
    };

    sui::event::emit(RideOpened {
        ride_id: object::id(&ride),
        user,
        market_id,
        round_index: market.cached_round_index,
        barrier_index,
        barrier_price,
        stake_per_segment,
        escrowed: escrow_amount,
        multiplier_bps: market.multiplier_bps,
        entry_segment_index: market.next_segment_index,
        opened_at_ms: now,
    });

    ride
}

// === close_segment_ride ===

/// Voluntary close. Settlement decision order per doc 19 §9:
///   1. Aborted → ABORTED_REFUND (1:1)
///   2. Touch scan over held segments → TOUCH_WIN
///   3. Round-end and no touch → EXPIRED_LOSS
///   4. Otherwise → CASHOUT at Bachelier factor
///
/// Returns the Coin<C> to deliver to the caller (payout + escrow refund).
public fun close_segment_ride<C>(
    ride: &mut SegmentRidePosition,
    market: &mut SegmentMarket<C>,
    vault: &mut MartingalerVault<C>,
    price_oracle: &UsdPriceOracle,
    token_state: &mut WickTokenState,
    staking_pool: &mut WickStakingPool,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    assert!(!ride.closed, EAlreadyClosed);
    assert!(ride.market_id == object::id(market), EWrongMarket);
    assert!(market.vault_id == object::id(vault), EWrongMarket);

    // Lazy-roll so cached round + barriers reflect the latest segment
    // (matters for the round-end check). Cheap no-op when current.
    ensure_round_current(market);

    let now = clock.timestamp_ms();
    let market_id = object::id(market);

    let (stake_paid, payout, forfeit, kind) =
        decide_settlement<C>(ride, market, vault);

    let total_to_user = payout + (ride.escrowed - stake_paid);
    let payout_coin = if (total_to_user > 0) {
        mv::withdraw_for_ride_settlement<C>(vault, total_to_user, ctx)
    } else {
        coin::zero<C>(ctx)
    };

    if (forfeit > 0 && kind != SETTLEMENT_ABORTED_REFUND) {
        let loss_micro_usd = upo::loss_micro_usd<C>(
            price_oracle, forfeit, clock, upo::default_max_staleness_ms(),
        );
        ws::record_loss(staking_pool, ride.user, loss_micro_usd);
        let _wick_minted = wt::mint_to_loser(
            token_state,
            ride.user,
            loss_micro_usd,
            ride.is_bot_eligible,
            clock,
            ctx,
        );
    };

    // Decrement per-barrier trackers (regardless of settlement kind).
    let this_ride_max_payout =
        (((ride.escrowed as u128) * (ride.multiplier_bps as u128)) / BPS_DENOM_128) as u64;
    decrement_barrier_trackers(market, ride, this_ride_max_payout);

    // Decrement global concurrency + per-user count.
    market.active_ride_count = market.active_ride_count - 1;
    if (table::contains(&market.per_user_open_count, ride.user)) {
        let v = table::borrow_mut(&mut market.per_user_open_count, ride.user);
        if (*v > 0) { *v = *v - 1; };
    };

    ride.closed = true;
    ride.closed_at_ms = now;
    ride.settlement_kind = kind;

    sui::event::emit(RideClosed {
        ride_id: object::id(ride),
        user: ride.user,
        market_id,
        round_index: ride.round_index,
        barrier_index: ride.barrier_index,
        settlement_kind: kind,
        stake_paid,
        payout,
        forfeit,
        bounty: 0,
        closed_at_ms: now,
    });

    payout_coin
}

// === crank_expired_segment_ride (permissionless) ===

/// Crank an expired ride that the user hasn't closed. Pays a 50bps bounty
/// of stake_paid to the caller and the residual refund to the user via
/// transfer. ONLY handles the EXPIRED_LOSS branch — if a touch fired
/// in-window, the user must self-close (`close_segment_ride`).
///
/// Preserves the SEV-1 treasury-cover guard from `ride_position.move`
/// :362-369 — if treasury < (user_refund + bounty), refuses to run rather
/// than routing the user's refund queue entry under the cranker's ctx.
public fun crank_expired_segment_ride<C>(
    ride: &mut SegmentRidePosition,
    market: &mut SegmentMarket<C>,
    vault: &mut MartingalerVault<C>,
    price_oracle: &UsdPriceOracle,
    token_state: &mut WickTokenState,
    staking_pool: &mut WickStakingPool,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    assert!(!ride.closed, EAlreadyClosed);
    assert!(ride.market_id == object::id(market), EWrongMarket);
    assert!(market.vault_id == object::id(vault), EWrongMarket);

    ensure_round_current(market);

    // Round end = (current segment - round start) >= round_duration_segments,
    // i.e. the ride's round has fully played out.
    let ride_round_end_segment =
        (ride.round_index + 1) * market.round_duration_segments;
    assert!(
        market.next_segment_index >= ride_round_end_segment,
        ENotExpired,
    );

    // Forbid crank if barrier fired during the held window — user must
    // self-close (otherwise queue routing credits the keeper's address).
    let direction_above = direction_for_barrier(ride.barrier_index);
    let touched = scan_for_touch(
        market,
        ride.entry_segment_index,
        ride_round_end_segment,
        ride.barrier_price,
        direction_above,
    );
    assert!(!touched, ETouchedMustSelfClose);

    // stake_paid identical to close path: min(segments_held × rate, escrowed)
    let segments_held = compute_segments_held(
        market.next_segment_index,
        ride.entry_segment_index,
        market.round_duration_segments,
    );
    let stake_paid = compute_stake_paid(
        ride.stake_per_segment, segments_held, ride.escrowed,
    );

    let bounty = (
        ((stake_paid as u128) * (CRANK_BOUNTY_BPS as u128)) / (BPS_DENOMINATOR as u128)
    ) as u64;
    let forfeit_after_bounty = stake_paid - bounty;
    let user_refund = ride.escrowed - stake_paid;

    // SEV-1 fix per ride_position.move:362-369 — refuse to crank if the
    // vault treasury can't cover both legs without queue routing. Otherwise
    // `withdraw_for_ride_settlement` would enqueue the shortfall under the
    // cranker's ctx, mis-attributing the user's refund. User must self-close.
    assert!(
        mv::treasury_value(vault) >= user_refund + bounty,
        EInsufficientTreasuryForCrank,
    );

    // Pay user from vault directly (guaranteed cash by the check above).
    if (user_refund > 0) {
        let user_coin = mv::withdraw_for_ride_settlement<C>(vault, user_refund, ctx);
        transfer::public_transfer(user_coin, ride.user);
    };

    // WICK mint on the forfeit_after_bounty portion.
    if (forfeit_after_bounty > 0) {
        let loss_micro_usd = upo::loss_micro_usd<C>(
            price_oracle, forfeit_after_bounty, clock, upo::default_max_staleness_ms(),
        );
        ws::record_loss(staking_pool, ride.user, loss_micro_usd);
        let _wick_minted = wt::mint_to_loser(
            token_state,
            ride.user,
            loss_micro_usd,
            ride.is_bot_eligible,
            clock,
            ctx,
        );
    };

    // Pay cranker their bounty.
    let bounty_coin = if (bounty > 0) {
        mv::withdraw_for_ride_settlement<C>(vault, bounty, ctx)
    } else {
        coin::zero<C>(ctx)
    };

    // Decrement per-barrier trackers + counts.
    let this_ride_max_payout =
        (((ride.escrowed as u128) * (ride.multiplier_bps as u128)) / BPS_DENOM_128) as u64;
    decrement_barrier_trackers(market, ride, this_ride_max_payout);

    market.active_ride_count = market.active_ride_count - 1;
    if (table::contains(&market.per_user_open_count, ride.user)) {
        let v = table::borrow_mut(&mut market.per_user_open_count, ride.user);
        if (*v > 0) { *v = *v - 1; };
    };

    let now = clock.timestamp_ms();
    ride.closed = true;
    ride.closed_at_ms = now;
    ride.settlement_kind = SETTLEMENT_EXPIRED_LOSS;

    sui::event::emit(RideClosed {
        ride_id: object::id(ride),
        user: ride.user,
        market_id: object::id(market),
        round_index: ride.round_index,
        barrier_index: ride.barrier_index,
        settlement_kind: SETTLEMENT_EXPIRED_LOSS,
        stake_paid,
        payout: 0,
        forfeit: forfeit_after_bounty,
        bounty,
        closed_at_ms: now,
    });

    bounty_coin
}

// === abort_segment_ride (B5) ===

/// Permissionless. Past `abort_segment_deadline_ms` from `opened_at_ms`
/// without any new segment recorded → 1:1 refund. No WICK mint (no loss).
/// Guards against a keeper stall locking the rider's escrow.
public fun abort_segment_ride<C>(
    ride: &mut SegmentRidePosition,
    market: &mut SegmentMarket<C>,
    vault: &mut MartingalerVault<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    assert!(!ride.closed, EAlreadyClosed);
    assert!(ride.market_id == object::id(market), EWrongMarket);
    assert!(market.vault_id == object::id(vault), EWrongMarket);

    let now = clock.timestamp_ms();
    assert!(
        now >= ride.opened_at_ms + market.abort_segment_deadline_ms,
        ENotPastAbortDeadline,
    );
    // No segment has progressed since open — the chain truly has not moved.
    assert!(
        market.next_segment_index == ride.entry_segment_index,
        ENotPastAbortDeadline,
    );

    // Refund 1:1.
    let refund_coin = mv::withdraw_for_ride_settlement<C>(vault, ride.escrowed, ctx);

    // Decrement trackers + counts.
    let this_ride_max_payout =
        (((ride.escrowed as u128) * (ride.multiplier_bps as u128)) / BPS_DENOM_128) as u64;
    decrement_barrier_trackers(market, ride, this_ride_max_payout);

    market.active_ride_count = market.active_ride_count - 1;
    if (table::contains(&market.per_user_open_count, ride.user)) {
        let v = table::borrow_mut(&mut market.per_user_open_count, ride.user);
        if (*v > 0) { *v = *v - 1; };
    };

    ride.closed = true;
    ride.closed_at_ms = now;
    ride.settlement_kind = SETTLEMENT_ABORTED_REFUND;

    sui::event::emit(RideClosed {
        ride_id: object::id(ride),
        user: ride.user,
        market_id: object::id(market),
        round_index: ride.round_index,
        barrier_index: ride.barrier_index,
        settlement_kind: SETTLEMENT_ABORTED_REFUND,
        stake_paid: 0,
        payout: 0,
        forfeit: 0,
        bounty: 0,
        closed_at_ms: now,
    });

    refund_coin
}

// === Internal: settlement decision ===

fun decide_settlement<C>(
    ride: &SegmentRidePosition,
    market: &SegmentMarket<C>,
    vault: &MartingalerVault<C>,
): (u64, u64, u64, u8) {
    let market_id = object::id(market);
    let segments_held = compute_segments_held(
        market.next_segment_index,
        ride.entry_segment_index,
        market.round_duration_segments,
    );
    let stake_paid = compute_stake_paid(
        ride.stake_per_segment, segments_held, ride.escrowed,
    );

    // 1. Aborted check — 1:1 refund. Use stake_paid=0 / payout=0 so
    //    total_to_user = 0 + (escrowed - 0) = escrowed (matches ride_position
    //    fix — Reviewer E's caught bug: refund 1:1, NOT 2:1).
    if (mv::is_market_aborted(vault, market_id)) {
        return (0u64, 0u64, 0u64, SETTLEMENT_ABORTED_REFUND)
    };

    // 2. Touch scan — held segments are [entry_segment_index, scan_to), bounded
    //    to the ride's OWN round. Without the bound, a LATER round's segment that
    //    crosses the ride's snapshotted barrier_price would fabricate a TOUCH_WIN
    //    and pay a jackpot for a touch that never happened in the ride's round —
    //    draining the vault (the cross-round escape fixed for v4 in #683;
    //    crank_expired above already bounds this exact way).
    let ride_round_end_segment =
        (ride.round_index + 1) * market.round_duration_segments;
    let scan_to = if (market.next_segment_index < ride_round_end_segment) {
        market.next_segment_index
    } else {
        ride_round_end_segment
    };
    let direction_above = direction_for_barrier(ride.barrier_index);
    if (scan_for_touch(
        market,
        ride.entry_segment_index,
        scan_to,
        ride.barrier_price,
        direction_above,
    )) {
        let p = (((stake_paid as u128) * (ride.multiplier_bps as u128))
            / BPS_DENOM_128) as u64;
        return (stake_paid, p, 0u64, SETTLEMENT_TOUCH_WIN)
    };

    // 3. Round-end check — if the ride's round has fully played out with no
    //    touch, this is an EXPIRED_LOSS (stake forfeit).
    let ride_round_end_segment =
        (ride.round_index + 1) * market.round_duration_segments;
    if (market.next_segment_index >= ride_round_end_segment) {
        return (stake_paid, 0u64, stake_paid, SETTLEMENT_EXPIRED_LOSS)
    };

    // 4. Cashout at Bachelier factor — segments_remaining → seconds via
    //    DEFAULT_SEGMENT_MS / 1000 (doc 18 §1.5).
    let segments_remaining = ride_round_end_segment - market.next_segment_index;
    let seconds_remaining =
        (segments_remaining * DEFAULT_SEGMENT_MS) / SECONDS_PER_MS;
    let spot = sp::state_price(&market.walk);
    let factor = ride_pricing::bachelier_cashout_factor(
        spot, ride.barrier_price, market.sigma_bps_per_sqrt_sec, seconds_remaining,
    );
    let raw_payout = (
        ((stake_paid as u128) * (factor as u128))
            / (ride_pricing::factor_scale() as u128)
    ) as u64;
    let after_spread = (
        ((raw_payout as u128) * ((BPS_DENOMINATOR - market.cashout_spread_bps) as u128))
            / (BPS_DENOMINATOR as u128)
    ) as u64;
    // Bachelier factor ≤ 1; cashout cannot profit. Clamp defensively.
    let payout = if (after_spread > stake_paid) stake_paid else after_spread;
    let forfeit = stake_paid - payout;
    (stake_paid, payout, forfeit, SETTLEMENT_CASHOUT)
}

// === Internal: scan_for_touch ===

/// Walk the segment ledger from `from_idx` (inclusive) to `to_idx`
/// (exclusive) and check whether any recorded segment crossed the
/// deadbanded barrier in the chosen direction. Missing segments are
/// skipped (cannot have touched what wasn't recorded).
fun scan_for_touch<C>(
    market: &SegmentMarket<C>,
    from_idx: u64,
    to_idx: u64,
    barrier: u64,
    direction_above: bool,
): bool {
    let mut k = from_idx;
    while (k < to_idx) {
        if (table::contains(&market.segments, k)) {
            let seg = table::borrow(&market.segments, k);
            if (direction_above) {
                let eff = add_deadband_up(barrier, market.deadband_bps);
                if (seg.max_price >= eff) return true;
            } else {
                let eff = sub_deadband_down(barrier, market.deadband_bps);
                if (seg.min_price <= eff) return true;
            };
        };
        k = k + 1;
    };
    false
}

// === Internal: deadband helpers (lifted from path_observation §613-625) ===

/// `barrier + barrier × deadband_bps / 10_000`, clamped to u64::MAX.
fun add_deadband_up(barrier: u64, deadband_bps: u64): u64 {
    if (deadband_bps == 0) return barrier;
    let margin = (barrier as u128) * (deadband_bps as u128) / BPS_DENOM_128;
    let scaled = (barrier as u128) + margin;
    if (scaled > 18_446_744_073_709_551_615u128) 18_446_744_073_709_551_615u64
    else scaled as u64
}

/// `barrier - barrier × deadband_bps / 10_000`, floored at 0.
fun sub_deadband_down(barrier: u64, deadband_bps: u64): u64 {
    if (deadband_bps == 0) return barrier;
    let margin = (barrier as u128) * (deadband_bps as u128) / BPS_DENOM_128;
    if (margin >= (barrier as u128)) 0
    else ((barrier as u128) - margin) as u64
}

// === Internal: helpers ===

/// `direction_above` for a ride's barrier_index. The barrier_price itself
/// is snapshotted on the ride at open (see SegmentRidePosition.barrier_price).
fun direction_for_barrier(barrier_index: u8): bool {
    barrier_index == BARRIER_UPPER
}

/// `segments_held = min(next_segment_index - entry_segment_index,
///                       round_duration_segments)`. Clamped so a ride that
/// outlived its round doesn't have stake_paid inflated past the escrow cap.
fun compute_segments_held(
    next_segment_index: u64,
    entry_segment_index: u64,
    round_duration_segments: u64,
): u64 {
    let raw = if (next_segment_index > entry_segment_index) {
        next_segment_index - entry_segment_index
    } else { 0 };
    if (raw > round_duration_segments) round_duration_segments else raw
}

/// `stake_paid = min(segments_held × rate, escrowed)`.
fun compute_stake_paid(
    rate_per_segment: u64,
    segments_held: u64,
    escrowed_cap: u64,
): u64 {
    let raw = (rate_per_segment as u128) * (segments_held as u128);
    if (raw > (escrowed_cap as u128)) escrowed_cap else (raw as u64)
}

/// Decrement the per-barrier trackers when a ride settles. Saturates at 0
/// in case of rounding drift (shouldn't happen if open/close arithmetic is
/// symmetric, but be defensive).
fun decrement_barrier_trackers<C>(
    market: &mut SegmentMarket<C>,
    ride: &SegmentRidePosition,
    ride_max_payout: u64,
) {
    if (ride.barrier_index == BARRIER_UPPER) {
        market.upper_aggregate_stake =
            saturating_sub(market.upper_aggregate_stake, ride.escrowed);
        market.upper_aggregate_max_payout =
            saturating_sub(market.upper_aggregate_max_payout, ride_max_payout);
        if (market.upper_rider_count > 0) {
            market.upper_rider_count = market.upper_rider_count - 1;
        };
    } else {
        market.lower_aggregate_stake =
            saturating_sub(market.lower_aggregate_stake, ride.escrowed);
        market.lower_aggregate_max_payout =
            saturating_sub(market.lower_aggregate_max_payout, ride_max_payout);
        if (market.lower_rider_count > 0) {
            market.lower_rider_count = market.lower_rider_count - 1;
        };
    }
}

fun saturating_sub(a: u64, b: u64): u64 {
    if (a > b) a - b else 0
}

// === Test-only helpers ===

#[test_only]
public fun test_only_destroy_market<C>(m: SegmentMarket<C>) {
    let SegmentMarket {
        id, walk: _, next_segment_index: _, segments,
        active_ride_count: _,
        round_duration_segments: _, open_window_segments: _,
        barrier_offset_bps: _, multiplier_bps: _, max_payout_per_barrier: _,
        cached_round_index: _, cached_round_started_at_segment: _,
        cached_upper_barrier: _, cached_lower_barrier: _,
        upper_aggregate_stake: _, lower_aggregate_stake: _,
        upper_aggregate_max_payout: _, lower_aggregate_max_payout: _,
        upper_rider_count: _, lower_rider_count: _,
        deadband_bps: _, sigma_bps_per_sqrt_sec: _, cashout_spread_bps: _,
        abort_segment_deadline_ms: _, min_stake_per_segment: _,
        max_stake_per_segment: _, max_concurrent_rides: _,
        max_rides_per_user: _, per_user_open_count,
        vault_id: _, created_at_ms: _,
    } = m;
    object::delete(id);
    table::drop(segments);
    table::drop(per_user_open_count);
}

#[test_only]
public fun test_only_destroy_ride(r: SegmentRidePosition) {
    let SegmentRidePosition {
        id, user: _, market_id: _, round_index: _, entry_segment_index: _,
        barrier_index: _, barrier_price: _, multiplier_bps: _, stake_per_segment: _,
        escrowed: _, is_bot_eligible: _, opened_at_ms: _, closed: _,
        closed_at_ms: _, settlement_kind: _, collateral: _,
    } = r;
    object::delete(id);
}

/// Test-only: stuff a hand-crafted segment record into the ledger.
/// Bypasses sui::random / the wake gate. Bumps next_segment_index.
#[test_only]
public fun test_only_record_segment<C>(
    market: &mut SegmentMarket<C>,
    key: vector<u8>,
    state_after: WalkState,
    min_price: u64,
    max_price: u64,
    recorded_at_ms: u64,
) {
    let k = market.next_segment_index;
    table::add(&mut market.segments, k, SegmentRecord {
        key, state_after, min_price, max_price, recorded_at_ms,
    });
    market.walk = state_after;
    market.next_segment_index = k + 1;
}

/// Test-only: advance next_segment_index without recording (simulates the
/// keeper having recorded segments off-window for round-end testing).
#[test_only]
public fun test_only_bump_segment_index<C>(market: &mut SegmentMarket<C>, n: u64) {
    market.next_segment_index = market.next_segment_index + n;
}

#[test_only]
public fun test_only_force_round_current<C>(market: &mut SegmentMarket<C>) {
    ensure_round_current(market);
}

#[test_only]
public fun test_scan_for_touch<C>(
    market: &SegmentMarket<C>,
    from_idx: u64,
    to_idx: u64,
    barrier: u64,
    direction_above: bool,
): bool {
    scan_for_touch(market, from_idx, to_idx, barrier, direction_above)
}

#[test_only]
public fun test_add_deadband_up(barrier: u64, deadband_bps: u64): u64 {
    add_deadband_up(barrier, deadband_bps)
}

#[test_only]
public fun test_sub_deadband_down(barrier: u64, deadband_bps: u64): u64 {
    sub_deadband_down(barrier, deadband_bps)
}

// === Inline tests ===

#[test_only]
use sui::sui::SUI;
#[test_only]
use sui::test_scenario as ts;
#[test_only]
use sui::test_utils;
#[test_only]
use sui::clock;

#[test_only]
const ALICE: address = @0xA;
#[test_only]
const BOB: address = @0xB;
#[test_only]
const KEEPER: address = @0xC;

#[test_only]
const HOME_PRICE: u64 = 1_000_000_000;          // $1000 in micro-USD
#[test_only]
const VOL_REGIME_INIT: u64 = 1_000_000;          // 1.0 in 1e6 fixed
#[test_only]
const ROUND_DURATION: u64 = 75;                  // 30s @ 400ms
#[test_only]
const OPEN_WINDOW: u64 = 13;                     // ~5.2s
#[test_only]
const BARRIER_OFFSET_BPS: u64 = 500;             // ±5%
#[test_only]
const MULTIPLIER_BPS: u64 = 20_000;              // 2×
#[test_only]
/// Sized so a single ride at MAX_STAKE × ROUND_DURATION × MULTIPLIER_BPS
/// fills the barrier and the next open buts the cap.
/// MAX_STAKE=10_000_000, ROUND_DURATION=75 → escrow_max = 750_000_000
/// × multiplier 2× = 1_500_000_000.
const MAX_PAYOUT_PER_BARRIER: u64 = 1_500_000_000;
#[test_only]
const DEADBAND_BPS: u64 = 20;
#[test_only]
const SIGMA_BPS: u64 = 50;
#[test_only]
const CASHOUT_SPREAD_BPS: u64 = 500;
#[test_only]
const ABORT_DEADLINE_MS: u64 = 30_000;
#[test_only]
const MIN_STAKE: u64 = 100;
#[test_only]
const MAX_STAKE: u64 = 10_000_000;
#[test_only]
const MAX_CONCURRENT: u64 = 100;
#[test_only]
const MAX_PER_USER: u64 = 5;

#[test_only]
fun mint_sui(amount: u64, sc: &mut ts::Scenario): Coin<SUI> {
    coin::mint_for_testing<SUI>(amount, sc.ctx())
}

#[test_only]
fun mk_market(
    vault: &MartingalerVault<SUI>,
    sc: &mut ts::Scenario,
    clk: &Clock,
): SegmentMarket<SUI> {
    new_segment_market<SUI>(
        vault,
        HOME_PRICE,
        VOL_REGIME_INIT,
        ROUND_DURATION,
        OPEN_WINDOW,
        BARRIER_OFFSET_BPS,
        MULTIPLIER_BPS,
        MAX_PAYOUT_PER_BARRIER,
        DEADBAND_BPS,
        SIGMA_BPS,
        CASHOUT_SPREAD_BPS,
        ABORT_DEADLINE_MS,
        MIN_STAKE,
        MAX_STAKE,
        MAX_CONCURRENT,
        MAX_PER_USER,
        clk,
        sc.ctx(),
    )
}

#[test_only]
fun mk_full_world(sc: &mut ts::Scenario): (
    MartingalerVault<SUI>,
    mv::VaultAdminCap,
    SegmentMarket<SUI>,
    br::BotRegistry,
    br::BotAdminCap,
    upo::UsdPriceOracle,
    upo::PriceAdminCap,
    wt::WickTokenState,
    wt::WickAdminCap,
    ws::WickStakingPool,
    ws::StakingAdminCap,
    clock::Clock,
) {
    let mut clk = clock::create_for_testing(sc.ctx());
    clk.set_for_testing(1_000);
    let (vault, vcap) = mv::init_for_testing<SUI>(sc.ctx());
    let market = mk_market(&vault, sc, &clk);
    let (bots, bcap) = br::init_for_testing(sc.ctx());
    let (mut upo_obj, pcap) = upo::init_for_testing(sc.ctx());
    upo::set_price<SUI>(&pcap, &mut upo_obj, 1_000_000, 9, &clk);
    let (wts, wcap) = wt::init_for_testing(sc.ctx());
    let (pool, scap) = ws::init_for_testing(sc.ctx());
    (vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk)
}

#[test_only]
fun teardown_world(
    vault: MartingalerVault<SUI>,
    vcap: mv::VaultAdminCap,
    market: SegmentMarket<SUI>,
    bots: br::BotRegistry,
    bcap: br::BotAdminCap,
    upo_obj: upo::UsdPriceOracle,
    pcap: upo::PriceAdminCap,
    wts: wt::WickTokenState,
    wcap: wt::WickAdminCap,
    pool: ws::WickStakingPool,
    scap: ws::StakingAdminCap,
    clk: clock::Clock,
) {
    test_utils::destroy(vault);
    test_utils::destroy(vcap);
    test_only_destroy_market(market);
    test_utils::destroy(bots);
    test_utils::destroy(bcap);
    test_utils::destroy(upo_obj);
    test_utils::destroy(pcap);
    test_utils::destroy(wts);
    test_utils::destroy(wcap);
    test_utils::destroy(pool);
    test_utils::destroy(scap);
    clk.destroy_for_testing();
}

// === doc 18 §15.1 + doc 19 §16.1 test cases ===

#[test]
fun bootstrap_emits_initial_state() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    assert!(next_segment_index<SUI>(&market) == 0, 0);
    assert!(active_ride_count<SUI>(&market) == 0, 1);
    assert!(cached_round_index<SUI>(&market) == 0, 2);
    // upper = home + 5%, lower = home - 5%
    let expected_upper = HOME_PRICE + HOME_PRICE * 500 / 10_000;
    let expected_lower = HOME_PRICE - HOME_PRICE * 500 / 10_000;
    assert!(cached_upper_barrier<SUI>(&market) == expected_upper, 3);
    assert!(cached_lower_barrier<SUI>(&market) == expected_lower, 4);
    assert!(walk_price<SUI>(&market) == HOME_PRICE, 5);
    assert!(upper_aggregate_stake<SUI>(&market) == 0, 6);
    assert!(lower_aggregate_stake<SUI>(&market) == 0, 7);

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
fun scan_for_touch_above_with_deadband() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    // Hand-craft a segment whose max == barrier exactly.
    let barrier = 1_050_000_000u64;
    let st = sp::new_state(1_000_000_000, VOL_REGIME_INIT, 1_000_000_000);

    // Segment 0: max just below barrier (no deadband would still NOT trigger,
    // because we require max >= barrier + deadband_margin).
    let margin = barrier * DEADBAND_BPS / 10_000;
    test_only_record_segment<SUI>(
        &mut market,
        x"00",
        st,
        900_000_000,
        barrier + margin - 1,  // 1 short of effective trigger
        1_000,
    );
    let touched_short = test_scan_for_touch<SUI>(&market, 0, 1, barrier, true);
    assert!(!touched_short, 0);

    // Segment 1: max exactly meets effective trigger.
    test_only_record_segment<SUI>(
        &mut market,
        x"01",
        st,
        900_000_000,
        barrier + margin,
        2_000,
    );
    let touched_eq = test_scan_for_touch<SUI>(&market, 0, 2, barrier, true);
    assert!(touched_eq, 1);

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
fun scan_for_touch_below_with_deadband() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    let barrier = 950_000_000u64;
    let st = sp::new_state(1_000_000_000, VOL_REGIME_INIT, 1_000_000_000);
    let margin = barrier * DEADBAND_BPS / 10_000;

    // Segment 0: min just above effective trigger → no touch.
    test_only_record_segment<SUI>(
        &mut market,
        x"00",
        st,
        (barrier - margin) + 1,
        1_100_000_000,
        1_000,
    );
    assert!(!test_scan_for_touch<SUI>(&market, 0, 1, barrier, false), 0);

    // Segment 1: min exactly meets effective trigger.
    test_only_record_segment<SUI>(
        &mut market,
        x"01",
        st,
        barrier - margin,
        1_100_000_000,
        2_000,
    );
    assert!(test_scan_for_touch<SUI>(&market, 0, 2, barrier, false), 1);

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
fun open_segment_ride_basics() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    // Pre-fund vault treasury so close paths can be exercised later in
    // other tests (here we just open).
    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;
    let escrow = mint_sui(escrow_amt, &mut sc);

    let ride = open_segment_ride<SUI>(
        &mut market, &mut vault, &bots,
        BARRIER_UPPER, stake, escrow, &clk, sc.ctx(),
    );

    assert!(user(&ride) == ALICE, 0);
    assert!(round_index(&ride) == 0, 1);
    assert!(entry_segment_index(&ride) == 0, 2);
    assert!(barrier_index(&ride) == BARRIER_UPPER, 3);
    assert!(stake_per_segment(&ride) == stake, 4);
    assert!(escrowed(&ride) == escrow_amt, 5);
    assert!(multiplier_bps_of_ride(&ride) == MULTIPLIER_BPS, 6);
    assert!(active_ride_count<SUI>(&market) == 1, 7);
    assert!(upper_rider_count<SUI>(&market) == 1, 8);
    assert!(upper_aggregate_stake<SUI>(&market) == escrow_amt, 9);

    test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
#[expected_failure(abort_code = EInvalidBarrierIndex)]
fun barrier_index_validates() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    let stake = 1_000u64;
    let escrow = mint_sui(stake * ROUND_DURATION, &mut sc);
    let ride = open_segment_ride<SUI>(
        &mut market, &mut vault, &bots,
        7,  // invalid
        stake, escrow, &clk, sc.ctx(),
    );
    test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
#[expected_failure(abort_code = EOpenWindowClosed)]
fun open_after_window_fails() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    // Bump segment index past the open window without crossing into next round
    test_only_bump_segment_index<SUI>(&mut market, OPEN_WINDOW);

    let stake = 1_000u64;
    let escrow = mint_sui(stake * ROUND_DURATION, &mut sc);
    let ride = open_segment_ride<SUI>(
        &mut market, &mut vault, &bots,
        BARRIER_UPPER, stake, escrow, &clk, sc.ctx(),
    );
    test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
fun open_in_window_succeeds_at_last_segment() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    test_only_bump_segment_index<SUI>(&mut market, OPEN_WINDOW - 1);

    let stake = 1_000u64;
    let escrow = mint_sui(stake * ROUND_DURATION, &mut sc);
    let ride = open_segment_ride<SUI>(
        &mut market, &mut vault, &bots,
        BARRIER_LOWER, stake, escrow, &clk, sc.ctx(),
    );
    assert!(barrier_index(&ride) == BARRIER_LOWER, 0);
    assert!(entry_segment_index(&ride) == OPEN_WINDOW - 1, 1);

    test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
#[expected_failure(abort_code = EInsufficientEscrow)]
fun open_segment_ride_insufficient_escrow_aborts() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    let stake = 1_000u64;
    let escrow = mint_sui(stake * ROUND_DURATION - 1, &mut sc);  // 1 short
    let ride = open_segment_ride<SUI>(
        &mut market, &mut vault, &bots,
        BARRIER_UPPER, stake, escrow, &clk, sc.ctx(),
    );
    test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
#[expected_failure(abort_code = EStakeOutOfRange)]
fun open_segment_ride_stake_below_min_aborts() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    let stake = MIN_STAKE - 1;
    let escrow = mint_sui(stake * ROUND_DURATION, &mut sc);
    let ride = open_segment_ride<SUI>(
        &mut market, &mut vault, &bots,
        BARRIER_UPPER, stake, escrow, &clk, sc.ctx(),
    );
    test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
#[expected_failure(abort_code = EBarrierCapExceeded)]
fun barrier_full_rejects_open() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    // First open uses the maximum legal stake → max_payout = cap exactly.
    // escrow = MAX_STAKE × ROUND_DURATION; max_payout = escrow × MULTIPLIER/10_000
    // With MAX_STAKE=10_000_000 and ROUND_DURATION=75 → escrow=750_000_000;
    // × multiplier 2× = 1_500_000_000 = MAX_PAYOUT_PER_BARRIER.
    let stake = MAX_STAKE;
    let escrow1 = mint_sui(stake * ROUND_DURATION, &mut sc);
    let ride1 = open_segment_ride<SUI>(
        &mut market, &mut vault, &bots,
        BARRIER_UPPER, stake, escrow1, &clk, sc.ctx(),
    );

    // Open another small ride on the same barrier — must bust the cap.
    let small_stake = MIN_STAKE;
    let small_escrow = mint_sui(small_stake * ROUND_DURATION, &mut sc);
    let ride2 = open_segment_ride<SUI>(
        &mut market, &mut vault, &bots,
        BARRIER_UPPER, small_stake, small_escrow, &clk, sc.ctx(),
    );
    test_only_destroy_ride(ride1);
    test_only_destroy_ride(ride2);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
fun round_rolls_at_boundary() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    assert!(cached_round_index<SUI>(&market) == 0, 0);

    // Advance segment index past the round boundary.
    test_only_bump_segment_index<SUI>(&mut market, ROUND_DURATION);
    test_only_force_round_current<SUI>(&mut market);

    assert!(cached_round_index<SUI>(&market) == 1, 1);
    assert!(cached_round_started_at_segment<SUI>(&market) == ROUND_DURATION, 2);
    // Barriers were recomputed (still from HOME_PRICE since walk didn't move).
    let expected_upper = HOME_PRICE + HOME_PRICE * 500 / 10_000;
    assert!(cached_upper_barrier<SUI>(&market) == expected_upper, 3);

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
fun per_barrier_trackers_reset_on_roll() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    // Open a ride in round 0 to bump trackers.
    let stake = 1_000u64;
    let escrow = mint_sui(stake * ROUND_DURATION, &mut sc);
    let ride = open_segment_ride<SUI>(
        &mut market, &mut vault, &bots,
        BARRIER_UPPER, stake, escrow, &clk, sc.ctx(),
    );
    assert!(upper_aggregate_stake<SUI>(&market) > 0, 0);

    // Roll into round 1.
    test_only_bump_segment_index<SUI>(&mut market, ROUND_DURATION);
    test_only_force_round_current<SUI>(&mut market);

    assert!(upper_aggregate_stake<SUI>(&market) == 0, 1);
    assert!(upper_aggregate_max_payout<SUI>(&market) == 0, 2);
    assert!(upper_rider_count<SUI>(&market) == 0, 3);

    test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
fun close_segment_ride_touch_win() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) =
        mk_full_world(&mut sc);

    // Pre-fund vault so close can pay out without queuing.
    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;
    let escrow = mint_sui(escrow_amt, &mut sc);

    let mut ride = open_segment_ride<SUI>(
        &mut market, &mut vault, &bots,
        BARRIER_UPPER, stake, escrow, &clk, sc.ctx(),
    );

    // Hand-craft a touching segment past the upper barrier (with deadband).
    let upper = cached_upper_barrier<SUI>(&market);
    let margin = upper * DEADBAND_BPS / 10_000;
    let st = sp::state_with(upper + margin, false, 0, VOL_REGIME_INIT, HOME_PRICE);
    test_only_record_segment<SUI>(
        &mut market,
        x"deadbeef",
        st,
        HOME_PRICE,
        upper + margin + 1,
        2_000,
    );

    clk.increment_for_testing(1_000);
    let payout = close_segment_ride<SUI>(
        &mut ride, &mut market, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );

    assert!(settlement_kind(&ride) == SETTLEMENT_TOUCH_WIN, 0);
    // stake_paid = 1 segment × 1_000 = 1_000; payout = stake_paid × 2 = 2_000;
    // total_to_user = 2_000 + (escrow_amt - 1_000)
    assert!(payout.value() == 2_000 + (escrow_amt - 1_000), 1);
    assert!(active_ride_count<SUI>(&market) == 0, 2);
    assert!(upper_rider_count<SUI>(&market) == 0, 3);

    test_utils::destroy(payout);
    test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
fun close_segment_ride_cashout_no_touch_in_window() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;
    let escrow = mint_sui(escrow_amt, &mut sc);
    let mut ride = open_segment_ride<SUI>(
        &mut market, &mut vault, &bots,
        BARRIER_LOWER, stake, escrow, &clk, sc.ctx(),
    );

    // Record a few non-touching segments (spot stays near HOME_PRICE).
    let st = sp::state_with(HOME_PRICE, false, 0, VOL_REGIME_INIT, HOME_PRICE);
    test_only_record_segment<SUI>(&mut market, x"01", st, 999_000_000, 1_001_000_000, 1_500);
    test_only_record_segment<SUI>(&mut market, x"02", st, 998_000_000, 1_002_000_000, 1_900);

    clk.increment_for_testing(1_000);
    let payout = close_segment_ride<SUI>(
        &mut ride, &mut market, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );

    assert!(settlement_kind(&ride) == SETTLEMENT_CASHOUT, 0);
    // Cashout total ≤ escrowed (Bachelier factor ≤ 1).
    assert!(payout.value() <= escrow_amt, 1);
    // And > 0 since some escrow is refunded.
    assert!(payout.value() > 0, 2);

    test_utils::destroy(payout);
    test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
fun close_segment_ride_expired_at_round_end_no_touch() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;
    let escrow = mint_sui(escrow_amt, &mut sc);
    let mut ride = open_segment_ride<SUI>(
        &mut market, &mut vault, &bots,
        BARRIER_UPPER, stake, escrow, &clk, sc.ctx(),
    );

    // Bump the segment index past the round end without crafting touches.
    test_only_bump_segment_index<SUI>(&mut market, ROUND_DURATION + 1);
    clk.increment_for_testing(1_000);

    let payout = close_segment_ride<SUI>(
        &mut ride, &mut market, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );

    assert!(settlement_kind(&ride) == SETTLEMENT_EXPIRED_LOSS, 0);
    // stake_paid clamped to ROUND_DURATION segments → forfeit = escrow_amt;
    // total_to_user = 0 + (escrow_amt - escrow_amt) = 0.
    assert!(payout.value() == 0, 1);

    test_utils::destroy(payout);
    test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
fun close_segment_ride_aborted_refund_one_to_one() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;
    let escrow = mint_sui(escrow_amt, &mut sc);
    let mut ride = open_segment_ride<SUI>(
        &mut market, &mut vault, &bots,
        BARRIER_UPPER, stake, escrow, &clk, sc.ctx(),
    );

    // Force market into Aborted state.
    let market_id = object::id(&market);
    mv::test_mark_market_aborted<SUI>(&mut vault, market_id);

    clk.increment_for_testing(1_000);
    let payout = close_segment_ride<SUI>(
        &mut ride, &mut market, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );

    assert!(settlement_kind(&ride) == SETTLEMENT_ABORTED_REFUND, 0);
    // 1:1 refund — exactly escrowed, NOT 2× (the SEV-1 bug fixed in ride_position).
    assert!(payout.value() == escrow_amt, 1);

    test_utils::destroy(payout);
    test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
fun per_barrier_trackers_decrement_on_close() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;
    let escrow = mint_sui(escrow_amt, &mut sc);
    let mut ride = open_segment_ride<SUI>(
        &mut market, &mut vault, &bots,
        BARRIER_LOWER, stake, escrow, &clk, sc.ctx(),
    );

    assert!(lower_aggregate_stake<SUI>(&market) == escrow_amt, 0);
    assert!(lower_rider_count<SUI>(&market) == 1, 1);

    // Force aborted to take the simplest path; close.
    let mid = object::id(&market);
    mv::test_mark_market_aborted<SUI>(&mut vault, mid);
    clk.increment_for_testing(1_000);
    let payout = close_segment_ride<SUI>(
        &mut ride, &mut market, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );

    assert!(lower_aggregate_stake<SUI>(&market) == 0, 2);
    assert!(lower_rider_count<SUI>(&market) == 0, 3);
    assert!(lower_aggregate_max_payout<SUI>(&market) == 0, 4);

    test_utils::destroy(payout);
    test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
fun crank_expired_no_touch_pays_user_and_bounty() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;
    let escrow = mint_sui(escrow_amt, &mut sc);
    let mut ride = open_segment_ride<SUI>(
        &mut market, &mut vault, &bots,
        BARRIER_UPPER, stake, escrow, &clk, sc.ctx(),
    );

    // Bump past round end without touch.
    test_only_bump_segment_index<SUI>(&mut market, ROUND_DURATION + 5);
    clk.increment_for_testing(2_000);

    sc.next_tx(KEEPER);
    let bounty = crank_expired_segment_ride<SUI>(
        &mut ride, &mut market, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );

    assert!(is_closed(&ride), 0);
    assert!(settlement_kind(&ride) == SETTLEMENT_EXPIRED_LOSS, 1);
    // stake_paid clamped to ROUND_DURATION segments = escrow_amt.
    // bounty = escrow_amt × 50 / 10_000.
    let expected_bounty = escrow_amt * 50 / 10_000;
    assert!(bounty.value() == expected_bounty, 2);

    test_utils::destroy(bounty);
    test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
#[expected_failure(abort_code = ETouchedMustSelfClose)]
fun crank_refuses_when_touch_in_window() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;
    let escrow = mint_sui(escrow_amt, &mut sc);
    let mut ride = open_segment_ride<SUI>(
        &mut market, &mut vault, &bots,
        BARRIER_UPPER, stake, escrow, &clk, sc.ctx(),
    );

    // Craft a touching segment within the round.
    let upper = cached_upper_barrier<SUI>(&market);
    let margin = upper * DEADBAND_BPS / 10_000;
    let st = sp::state_with(upper + margin, false, 0, VOL_REGIME_INIT, HOME_PRICE);
    test_only_record_segment<SUI>(
        &mut market, x"aa", st, HOME_PRICE, upper + margin + 1, 1_500,
    );
    // Bump past round end.
    test_only_bump_segment_index<SUI>(&mut market, ROUND_DURATION);
    clk.increment_for_testing(2_000);

    sc.next_tx(KEEPER);
    let bounty = crank_expired_segment_ride<SUI>(
        &mut ride, &mut market, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );
    test_utils::destroy(bounty);
    test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
#[expected_failure(abort_code = EInsufficientTreasuryForCrank)]
fun crank_refuses_when_treasury_short() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;
    let escrow = mint_sui(escrow_amt, &mut sc);
    let mut ride = open_segment_ride<SUI>(
        &mut market, &mut vault, &bots,
        BARRIER_UPPER, stake, escrow, &clk, sc.ctx(),
    );

    // Bump past round end without ANY additional seed in vault treasury
    // beyond the ride's own escrow. user_refund = 0 (full segments consumed)
    // so we instead need to engineer a short-treasury case: stake_paid is
    // clamped to escrow_amt at round end → user_refund = 0, bounty > 0.
    // Drain the treasury entirely so even the small bounty can't be paid.
    // We can't drain directly; instead, fund less than escrow_amt initially.
    // But escrow was already deposited (= escrow_amt). Bounty needs
    // escrow_amt × 0.5%. Treasury has escrow_amt only. To make the check
    // fail: we'd need bounty > treasury. So pull escrow back via withdraw.
    let drained = mv::test_withdraw_for_ride_settlement<SUI>(
        &mut vault, escrow_amt, sc.ctx(),
    );
    test_utils::destroy(drained);

    test_only_bump_segment_index<SUI>(&mut market, ROUND_DURATION + 1);
    clk.increment_for_testing(2_000);

    sc.next_tx(KEEPER);
    let bounty = crank_expired_segment_ride<SUI>(
        &mut ride, &mut market, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );
    test_utils::destroy(bounty);
    test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
fun abort_segment_ride_past_deadline_refunds_one_to_one() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;
    let escrow = mint_sui(escrow_amt, &mut sc);
    let mut ride = open_segment_ride<SUI>(
        &mut market, &mut vault, &bots,
        BARRIER_UPPER, stake, escrow, &clk, sc.ctx(),
    );

    // Past the abort deadline with no segments recorded.
    clk.increment_for_testing(ABORT_DEADLINE_MS + 1);
    let payout = abort_segment_ride<SUI>(
        &mut ride, &mut market, &mut vault, &clk, sc.ctx(),
    );

    assert!(settlement_kind(&ride) == SETTLEMENT_ABORTED_REFUND, 0);
    assert!(payout.value() == escrow_amt, 1);

    test_utils::destroy(payout);
    test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
#[expected_failure(abort_code = ENotPastAbortDeadline)]
fun abort_segment_ride_before_deadline_aborts() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;
    let escrow = mint_sui(escrow_amt, &mut sc);
    let mut ride = open_segment_ride<SUI>(
        &mut market, &mut vault, &bots,
        BARRIER_UPPER, stake, escrow, &clk, sc.ctx(),
    );

    clk.increment_for_testing(ABORT_DEADLINE_MS - 1);
    let payout = abort_segment_ride<SUI>(
        &mut ride, &mut market, &mut vault, &clk, sc.ctx(),
    );
    test_utils::destroy(payout);
    test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
#[expected_failure(abort_code = EPerUserRideLimit)]
fun per_user_cap_blocks_excess_opens() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;

    // MAX_PER_USER = 5 — open 5, the 6th must abort.
    let r1 = open_segment_ride<SUI>(&mut market, &mut vault, &bots, BARRIER_UPPER, stake, mint_sui(escrow_amt, &mut sc), &clk, sc.ctx());
    let r2 = open_segment_ride<SUI>(&mut market, &mut vault, &bots, BARRIER_UPPER, stake, mint_sui(escrow_amt, &mut sc), &clk, sc.ctx());
    let r3 = open_segment_ride<SUI>(&mut market, &mut vault, &bots, BARRIER_UPPER, stake, mint_sui(escrow_amt, &mut sc), &clk, sc.ctx());
    let r4 = open_segment_ride<SUI>(&mut market, &mut vault, &bots, BARRIER_LOWER, stake, mint_sui(escrow_amt, &mut sc), &clk, sc.ctx());
    let r5 = open_segment_ride<SUI>(&mut market, &mut vault, &bots, BARRIER_LOWER, stake, mint_sui(escrow_amt, &mut sc), &clk, sc.ctx());
    let r6 = open_segment_ride<SUI>(&mut market, &mut vault, &bots, BARRIER_UPPER, stake, mint_sui(escrow_amt, &mut sc), &clk, sc.ctx());

    test_only_destroy_ride(r1);
    test_only_destroy_ride(r2);
    test_only_destroy_ride(r3);
    test_only_destroy_ride(r4);
    test_only_destroy_ride(r5);
    test_only_destroy_ride(r6);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
fun close_uses_cached_barrier_per_index() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;

    // Open one ride per barrier.
    let mut upper_ride = open_segment_ride<SUI>(
        &mut market, &mut vault, &bots,
        BARRIER_UPPER, stake, mint_sui(escrow_amt, &mut sc), &clk, sc.ctx(),
    );
    sc.next_tx(BOB);
    let mut lower_ride = open_segment_ride<SUI>(
        &mut market, &mut vault, &bots,
        BARRIER_LOWER, stake, mint_sui(escrow_amt, &mut sc), &clk, sc.ctx(),
    );

    // Touch the LOWER barrier only.
    let lower = cached_lower_barrier<SUI>(&market);
    let lmargin = lower * DEADBAND_BPS / 10_000;
    let st = sp::state_with(lower - lmargin, true, 0, VOL_REGIME_INIT, HOME_PRICE);
    test_only_record_segment<SUI>(
        &mut market, x"55", st,
        if (lower > lmargin) lower - lmargin - 1 else 0,
        HOME_PRICE,
        1_500,
    );

    clk.increment_for_testing(1_000);
    sc.next_tx(BOB);
    let lower_payout = close_segment_ride<SUI>(
        &mut lower_ride, &mut market, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );
    sc.next_tx(ALICE);
    let upper_payout = close_segment_ride<SUI>(
        &mut upper_ride, &mut market, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );

    // Lower → TOUCH_WIN, upper → CASHOUT (didn't touch upper).
    assert!(settlement_kind(&lower_ride) == SETTLEMENT_TOUCH_WIN, 0);
    assert!(settlement_kind(&upper_ride) == SETTLEMENT_CASHOUT, 1);

    test_utils::destroy(upper_payout);
    test_utils::destroy(lower_payout);
    test_only_destroy_ride(upper_ride);
    test_only_destroy_ride(lower_ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
fun cashout_segments_remaining_matches_round_end() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;
    let escrow = mint_sui(escrow_amt, &mut sc);
    let mut ride = open_segment_ride<SUI>(
        &mut market, &mut vault, &bots,
        BARRIER_LOWER, stake, escrow, &clk, sc.ctx(),
    );

    // Advance 10 segments mid-round.
    let st = sp::state_with(HOME_PRICE, false, 0, VOL_REGIME_INIT, HOME_PRICE);
    let mut i = 0;
    while (i < 10) {
        test_only_record_segment<SUI>(
            &mut market, x"00", st, HOME_PRICE - 100_000, HOME_PRICE + 100_000, 1_100 + i * 100,
        );
        i = i + 1;
    };

    clk.increment_for_testing(500);
    let payout = close_segment_ride<SUI>(
        &mut ride, &mut market, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );

    assert!(settlement_kind(&ride) == SETTLEMENT_CASHOUT, 0);
    let _ = payout.value();

    test_utils::destroy(payout);
    test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
fun deadband_zero_yields_barrier_passthrough() {
    assert!(test_add_deadband_up(1_000_000, 0) == 1_000_000, 0);
    assert!(test_sub_deadband_down(1_000_000, 0) == 1_000_000, 1);
    // 100 bps = 1%
    assert!(test_add_deadband_up(1_000_000, 100) == 1_010_000, 2);
    assert!(test_sub_deadband_down(1_000_000, 100) == 990_000, 3);
}
