// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// segment_market_v3 — the production v3.4 arcade module.
///
/// This is a CLONE of `wick::segment_market` (v2) with the v3 additions
/// from `docs/design/v2/23_storage_rebate_pruning_v3.md` and
/// `docs/design/v2/24_walrus_archive_v3.md`:
///
///   1. Per-round unsettled-rides counter (`unsettled_rides_per_round`)
///      that is bumped on `open_segment_ride_v3` and decremented on
///      `close_segment_ride_v3` / `crank_expired_segment_ride_v3` /
///      `abort_segment_ride_v3`. This is the precondition gate for
///      pruning a round's segment ledger entries.
///
///   2. `record_walrus_archive<C>` — permissionless. Records the 32-byte
///      Walrus blob ID for a round's segment archive. Doc 24 §5: this
///      must land BEFORE pruning that round, so the on-chain archive
///      index is always populated when the SegmentRecord rows go away.
///
///   3. `prune_settled_segments<C>` — permissionless. Deletes every
///      SegmentRecord in a round's [from, to) range once:
///         (a) the round is older than `SETTLEMENT_LAG_ROUNDS`;
///         (b) `unsettled_rides_per_round[round] == 0`;
///         (c) the round has not already been pruned;
///         (d) a Walrus archive entry exists for the round (v3.1
///             invariant per doc 24 §8 — archive-before-prune).
///      The caller pockets the storage rebate (~74M MIST/round at
///      round_duration=20). Idempotency-guard `pruned_rounds[round] =
///      true` is set ONLY when records were actually deleted, so an
///      empty-round prune doesn't waste a Table entry (SEV-2 #A fix
///      from /tmp/review-prune-proto.md).
///
/// v2's `wick::segment_market` is preserved unchanged so existing
/// testnet markets and their tests keep working.
///
/// Design docs:
///   - docs/design/v2/18_segment_market_design.md (base v2 design)
///   - docs/design/v2/19_round_shared_grid_design.md (round-shared grid)
///   - docs/design/v2/23_storage_rebate_pruning_v3.md (prune mechanism)
///   - docs/design/v2/24_walrus_archive_v3.md (Walrus archive)
module wick::segment_market_v3;

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
/// treasury can't cover (user_refund + bounty) without queue routing.
const EInsufficientTreasuryForCrank: u64 = 18;
// v3 errors (doc 23 §3.2 + doc 24 §5)
const ETooSoonToPrune: u64 = 19;
const EUnsettledRidesRemain: u64 = 20;
const EAlreadyPruned: u64 = 21;
const ENoWalrusArchive: u64 = 22;
const EInvalidBlobId: u64 = 23;
const EArchiveAlreadyRecorded: u64 = 24;

// === Settlement kinds ===
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
/// Doc 23 §3.1 — wait this many rounds AFTER a round settles before
/// allowing `prune_settled_segments` on it. Absorbs late aborts, settle
/// races, and reconciliation reads. 3 rounds ≈ 24 s at 8s/round.
const SETTLEMENT_LAG_ROUNDS: u64 = 3;
/// Doc 24 §5 — Walrus blob IDs are 32 bytes (Sui object-ID convention).
const WALRUS_BLOB_ID_LEN: u64 = 32;

// === Types ===

/// One recorded segment — same shape as v2 SegmentRecord so the BCS
/// schema in doc 24 §3 (which the v3.5 Walrus archiver depends on) is
/// preserved bit-for-bit.
public struct SegmentRecord has store, copy, drop {
    key: vector<u8>,
    state_after: WalkState,
    min_price: u64,
    max_price: u64,
    recorded_at_ms: u64,
}

/// v3 arcade market. Clone of v2's `SegmentMarket<C>` with three new
/// fields wired in for storage-rebate pruning + Walrus archival:
///
///   - `unsettled_rides_per_round` — `round_index → open ride count`.
///     Bumped on open, decremented on close/crank/abort. The pruner gate
///     reads `*table::borrow_with_default(&this, round, &0u64) == 0`.
///
///   - `pruned_rounds` — `round_index → true`. Set ONLY when records
///     were actually deleted (see prune_settled_segments — SEV-2 #A fix
///     from the prototype: empty-round prune is a no-op, not a write).
///
///   - `archive_index` — `round_index → Walrus blob_id (32B)`. Written
///     by `record_walrus_archive` before pruning is allowed. The v3.1
///     `ENoWalrusArchive` gate in `prune_settled_segments` reads this.
public struct SegmentMarketV3<phantom C> has key {
    id: UID,

    // ── Walk (carried across segments) ──────────────────────────────────────
    walk: WalkState,

    // ── Segment ledger ──────────────────────────────────────────────────────
    next_segment_index: u64,
    segments: Table<u64, SegmentRecord>,

    // ── Wake/sleep gate ─────────────────────────────────────────────────────
    active_ride_count: u64,

    // ── Round + shared grid configuration (immutable post-bootstrap) ────────
    round_duration_segments: u64,
    open_window_segments: u64,
    barrier_offset_bps: u64,
    multiplier_bps: u64,
    max_payout_per_barrier: u64,

    // ── Cached current-round state ──────────────────────────────────────────
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

    // ── v3 additions (doc 23 + doc 24) ──────────────────────────────────────
    /// `round_index → open-ride-count for that round`. Bumped on
    /// `open_segment_ride_v3`, decremented on close / crank / abort.
    /// Read by `prune_settled_segments` as the
    /// "all rides settled in this round" gate.
    unsettled_rides_per_round: Table<u64, u64>,
    /// `round_index → true` once that round has been pruned. Set ONLY
    /// when records were actually deleted (SEV-2 #A fix). Idempotency
    /// guard for `prune_settled_segments`.
    pruned_rounds: Table<u64, bool>,
    /// `round_index → Walrus blob_id (32 bytes)`. Written by
    /// `record_walrus_archive`. The `ENoWalrusArchive` gate in
    /// `prune_settled_segments` reads this — pruning a round whose
    /// archive entry is missing is rejected (v3.1 archive-before-prune
    /// invariant per doc 24 §8).
    archive_index: Table<u64, vector<u8>>,
}

/// A user's open ride against a specific round + barrier in a
/// SegmentMarketV3. Distinct type from v2's `SegmentRidePosition` so
/// callers can't accidentally route a v2 ride into a v3 market or vice
/// versa.
public struct SegmentRidePositionV3 has key, store {
    id: UID,
    user: address,
    market_id: ID,

    // ── Round binding ──────────────────────────────────────────────────────
    round_index: u64,
    entry_segment_index: u64,
    barrier_index: u8,
    barrier_price: u64,
    multiplier_bps: u64,

    // ── Stake ───────────────────────────────────────────────────────────────
    stake_per_segment: u64,
    escrowed: u64,
    is_bot_eligible: bool,

    // ── Settlement ──────────────────────────────────────────────────────────
    opened_at_ms: u64,
    closed: bool,
    closed_at_ms: u64,
    settlement_kind: u8,
    collateral: TypeName,
}

// === Events ===

public struct SegmentMarketV3Created has copy, drop {
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

/// v3 — emitted by `prune_settled_segments` after a round's records are
/// deleted. Indexers + pruner bots key off this for accounting.
public struct SegmentsPruned has copy, drop {
    market_id: ID,
    round_index: u64,
    deleted_count: u64,
    pruner: address,
}

/// v3 — emitted by `record_walrus_archive`. Indexers persist the
/// `walrus_blob_id` so `/verify` can fall back to Walrus once the
/// on-chain SegmentRecord rows are pruned.
public struct RoundArchived has copy, drop {
    market_id: ID,
    round_index: u64,
    walrus_blob_id: vector<u8>,
    archiver: address,
}

// === Read accessors ===

public fun market_id_of_ride(r: &SegmentRidePositionV3): ID { r.market_id }
public fun user(r: &SegmentRidePositionV3): address { r.user }
public fun round_index(r: &SegmentRidePositionV3): u64 { r.round_index }
public fun barrier_index(r: &SegmentRidePositionV3): u8 { r.barrier_index }
public fun barrier_price(r: &SegmentRidePositionV3): u64 { r.barrier_price }
public fun entry_segment_index(r: &SegmentRidePositionV3): u64 { r.entry_segment_index }
public fun multiplier_bps_of_ride(r: &SegmentRidePositionV3): u64 { r.multiplier_bps }
public fun stake_per_segment(r: &SegmentRidePositionV3): u64 { r.stake_per_segment }
public fun escrowed(r: &SegmentRidePositionV3): u64 { r.escrowed }
public fun is_bot_eligible(r: &SegmentRidePositionV3): bool { r.is_bot_eligible }
public fun opened_at_ms(r: &SegmentRidePositionV3): u64 { r.opened_at_ms }
public fun is_closed(r: &SegmentRidePositionV3): bool { r.closed }
public fun closed_at_ms(r: &SegmentRidePositionV3): u64 { r.closed_at_ms }
public fun settlement_kind(r: &SegmentRidePositionV3): u8 { r.settlement_kind }
public fun collateral(r: &SegmentRidePositionV3): &TypeName { &r.collateral }

public fun settlement_open(): u8 { SETTLEMENT_OPEN }
public fun settlement_touch_win(): u8 { SETTLEMENT_TOUCH_WIN }
public fun settlement_cashout(): u8 { SETTLEMENT_CASHOUT }
public fun settlement_expired_loss(): u8 { SETTLEMENT_EXPIRED_LOSS }
public fun settlement_aborted_refund(): u8 { SETTLEMENT_ABORTED_REFUND }
public fun barrier_upper(): u8 { BARRIER_UPPER }
public fun barrier_lower(): u8 { BARRIER_LOWER }
public fun default_segment_ms(): u64 { DEFAULT_SEGMENT_MS }
public fun crank_bounty_bps(): u64 { CRANK_BOUNTY_BPS }
public fun settlement_lag_rounds(): u64 { SETTLEMENT_LAG_ROUNDS }
public fun walrus_blob_id_len(): u64 { WALRUS_BLOB_ID_LEN }

public fun next_segment_index<C>(m: &SegmentMarketV3<C>): u64 { m.next_segment_index }
public fun active_ride_count<C>(m: &SegmentMarketV3<C>): u64 { m.active_ride_count }
public fun cached_round_index<C>(m: &SegmentMarketV3<C>): u64 { m.cached_round_index }
public fun cached_upper_barrier<C>(m: &SegmentMarketV3<C>): u64 { m.cached_upper_barrier }
public fun cached_lower_barrier<C>(m: &SegmentMarketV3<C>): u64 { m.cached_lower_barrier }
public fun cached_round_started_at_segment<C>(m: &SegmentMarketV3<C>): u64 {
    m.cached_round_started_at_segment
}
public fun upper_aggregate_stake<C>(m: &SegmentMarketV3<C>): u64 { m.upper_aggregate_stake }
public fun lower_aggregate_stake<C>(m: &SegmentMarketV3<C>): u64 { m.lower_aggregate_stake }
public fun upper_aggregate_max_payout<C>(m: &SegmentMarketV3<C>): u64 { m.upper_aggregate_max_payout }
public fun lower_aggregate_max_payout<C>(m: &SegmentMarketV3<C>): u64 { m.lower_aggregate_max_payout }
public fun upper_rider_count<C>(m: &SegmentMarketV3<C>): u64 { m.upper_rider_count }
public fun lower_rider_count<C>(m: &SegmentMarketV3<C>): u64 { m.lower_rider_count }
public fun vault_id<C>(m: &SegmentMarketV3<C>): ID { m.vault_id }
public fun round_duration_segments<C>(m: &SegmentMarketV3<C>): u64 { m.round_duration_segments }
public fun open_window_segments<C>(m: &SegmentMarketV3<C>): u64 { m.open_window_segments }
public fun barrier_offset_bps<C>(m: &SegmentMarketV3<C>): u64 { m.barrier_offset_bps }
public fun multiplier_bps<C>(m: &SegmentMarketV3<C>): u64 { m.multiplier_bps }
public fun max_payout_per_barrier<C>(m: &SegmentMarketV3<C>): u64 { m.max_payout_per_barrier }
public fun deadband_bps<C>(m: &SegmentMarketV3<C>): u64 { m.deadband_bps }
public fun walk_price<C>(m: &SegmentMarketV3<C>): u64 { sp::state_price(&m.walk) }

public fun has_segment<C>(m: &SegmentMarketV3<C>, k: u64): bool {
    table::contains(&m.segments, k)
}

public fun segment_min<C>(m: &SegmentMarketV3<C>, k: u64): u64 {
    table::borrow(&m.segments, k).min_price
}

public fun segment_max<C>(m: &SegmentMarketV3<C>, k: u64): u64 {
    table::borrow(&m.segments, k).max_price
}

public fun segment_recorded_at_ms<C>(m: &SegmentMarketV3<C>, k: u64): u64 {
    table::borrow(&m.segments, k).recorded_at_ms
}

public fun segment_key<C>(m: &SegmentMarketV3<C>, k: u64): vector<u8> {
    table::borrow(&m.segments, k).key
}

/// v3 read accessor — how many open rides remain in the given round.
/// Returns 0 if the round has no entry (no rides ever opened against it).
public fun unsettled_rides_for_round<C>(m: &SegmentMarketV3<C>, round: u64): u64 {
    if (table::contains(&m.unsettled_rides_per_round, round)) {
        *table::borrow(&m.unsettled_rides_per_round, round)
    } else {
        0
    }
}

/// v3 read accessor — true once `prune_settled_segments` succeeded for
/// the round. Idempotency for repeat-prune attempts and for indexers
/// detecting which rounds have already had their on-chain SegmentRecord
/// rows deleted (look to Walrus instead).
public fun is_round_pruned<C>(m: &SegmentMarketV3<C>, round: u64): bool {
    table::contains(&m.pruned_rounds, round)
}

/// v3 read accessor — true once `record_walrus_archive` succeeded.
public fun has_walrus_archive<C>(m: &SegmentMarketV3<C>, round: u64): bool {
    table::contains(&m.archive_index, round)
}

/// v3 read accessor — Walrus blob ID for the given round's archive.
/// Aborts via the underlying `table::borrow` if no archive was recorded
/// (use `has_walrus_archive` first for a polite check).
public fun walrus_blob_id<C>(m: &SegmentMarketV3<C>, round: u64): vector<u8> {
    *table::borrow(&m.archive_index, round)
}

// === Constructor + share ===

/// Construct a new SegmentMarketV3. Same parameter contract as v2; the
/// extra v3 fields are initialized to empty Tables and play no role in
/// market-creation semantics.
public fun new_segment_market_v3<C>(
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
): SegmentMarketV3<C> {
    // Parameter validation — same as v2.
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

    let offset = ((home_price as u128) * (barrier_offset_bps as u128) / BPS_DENOM_128) as u64;
    let upper = home_price + offset;
    let lower = if (home_price > offset) home_price - offset else 1;

    let now = clock.timestamp_ms();
    let vault_id = object::id(vault);

    let market = SegmentMarketV3<C> {
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
        // v3 additions
        unsettled_rides_per_round: table::new(ctx),
        pruned_rounds: table::new(ctx),
        archive_index: table::new(ctx),
    };

    sui::event::emit(SegmentMarketV3Created {
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

/// Share a freshly-constructed SegmentMarketV3. Called by the admin
/// bootstrap entry in `wick.move`.
public entry fun share_segment_market_v3<C>(market: SegmentMarketV3<C>) {
    transfer::share_object(market);
}

// === ensure_round_current ===

fun ensure_round_current<C>(market: &mut SegmentMarketV3<C>) {
    let next_idx = market.next_segment_index;
    let current_round = next_idx / market.round_duration_segments;
    if (current_round <= market.cached_round_index) return;

    market.cached_round_index = current_round;
    market.cached_round_started_at_segment = current_round * market.round_duration_segments;

    let spot = sp::state_price(&market.walk);
    let offset = ((spot as u128) * (market.barrier_offset_bps as u128) / BPS_DENOM_128) as u64;
    market.cached_upper_barrier = spot + offset;
    market.cached_lower_barrier = if (spot > offset) spot - offset else 1;

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

// === record_segment ===

/// Same shape as v2: `entry` (not `public`), single 32-byte random draw,
/// constant-gas walk. Routes through `wick::wick::record_segment_v3` so
/// other packages cannot call it directly.
public(package) entry fun record_segment<C>(
    market: &mut SegmentMarketV3<C>,
    r: &Random,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(market.active_ride_count > 0, ENoActiveRides);

    ensure_round_current(market);

    let mut gen = random::new_generator(r, ctx);
    let key = random::generate_bytes(&mut gen, 32);

    let (_candles, new_walk, smin, smax) = sp::expand_segment(market.walk, key);

    let k = market.next_segment_index;
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

// === open_segment_ride_v3 ===

/// Open a ride against one of the round's two shared barriers. v3:
/// also bumps `unsettled_rides_per_round[round_index]` so the round
/// can be considered for pruning only when every open ride in it has
/// been settled.
public fun open_segment_ride_v3<C>(
    market: &mut SegmentMarketV3<C>,
    vault: &mut MartingalerVault<C>,
    bot_registry: &BotRegistry,
    barrier_index: u8,
    stake_per_segment: u64,
    escrow: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): SegmentRidePositionV3 {
    // 1. Vault binding
    assert!(market.vault_id == object::id(vault), EWrongMarket);
    // 2. Valid barrier_index
    assert!(
        barrier_index == BARRIER_UPPER || barrier_index == BARRIER_LOWER,
        EInvalidBarrierIndex,
    );
    // 3. Lazy-roll the round if needed
    ensure_round_current(market);

    // 4. Open-window assertion
    let segments_into_round =
        market.next_segment_index - market.cached_round_started_at_segment;
    assert!(segments_into_round < market.open_window_segments, EOpenWindowClosed);

    // 5. Stake range
    assert!(
        stake_per_segment >= market.min_stake_per_segment
            && stake_per_segment <= market.max_stake_per_segment,
        EStakeOutOfRange,
    );

    // 6. Escrow capacity
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

    // 10. Per-barrier cap check
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

    // 13. v3 — bump unsettled_rides_per_round for the current round.
    //     The pruner's gate is `*borrow_with_default(...) == 0`; we need
    //     to leave this counter strictly positive while any ride opened
    //     against the round remains unsettled.
    let round = market.cached_round_index;
    bump_unsettled_rides(market, round);

    // 14. Escrow into the vault's treasury
    mv::deposit_ride_escrow<C>(vault, escrow);

    // 15. Snapshot bot eligibility
    let is_bot_eligible = br::is_eligible_for_wick(bot_registry, user);

    let now = clock.timestamp_ms();
    let barrier_price = if (barrier_index == BARRIER_UPPER) {
        market.cached_upper_barrier
    } else {
        market.cached_lower_barrier
    };

    let ride = SegmentRidePositionV3 {
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

// === close_segment_ride_v3 ===

public fun close_segment_ride_v3<C>(
    ride: &mut SegmentRidePositionV3,
    market: &mut SegmentMarketV3<C>,
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

    let this_ride_max_payout =
        (((ride.escrowed as u128) * (ride.multiplier_bps as u128)) / BPS_DENOM_128) as u64;
    decrement_barrier_trackers(market, ride, this_ride_max_payout);

    market.active_ride_count = market.active_ride_count - 1;
    if (table::contains(&market.per_user_open_count, ride.user)) {
        let v = table::borrow_mut(&mut market.per_user_open_count, ride.user);
        if (*v > 0) { *v = *v - 1; };
    };

    // v3 — decrement the round's unsettled counter so the pruner gate
    // unblocks once every ride opened in this round has settled.
    decrement_unsettled_rides(market, ride.round_index);

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

// === crank_expired_segment_ride_v3 ===

public fun crank_expired_segment_ride_v3<C>(
    ride: &mut SegmentRidePositionV3,
    market: &mut SegmentMarketV3<C>,
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

    let ride_round_end_segment =
        (ride.round_index + 1) * market.round_duration_segments;
    assert!(
        market.next_segment_index >= ride_round_end_segment,
        ENotExpired,
    );

    let direction_above = direction_for_barrier(ride.barrier_index);
    let touched = scan_for_touch(
        market,
        ride.entry_segment_index,
        ride_round_end_segment,
        ride.barrier_price,
        direction_above,
    );
    assert!(!touched, ETouchedMustSelfClose);

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

    assert!(
        mv::treasury_value(vault) >= user_refund + bounty,
        EInsufficientTreasuryForCrank,
    );

    if (user_refund > 0) {
        let user_coin = mv::withdraw_for_ride_settlement<C>(vault, user_refund, ctx);
        transfer::public_transfer(user_coin, ride.user);
    };

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

    let bounty_coin = if (bounty > 0) {
        mv::withdraw_for_ride_settlement<C>(vault, bounty, ctx)
    } else {
        coin::zero<C>(ctx)
    };

    let this_ride_max_payout =
        (((ride.escrowed as u128) * (ride.multiplier_bps as u128)) / BPS_DENOM_128) as u64;
    decrement_barrier_trackers(market, ride, this_ride_max_payout);

    market.active_ride_count = market.active_ride_count - 1;
    if (table::contains(&market.per_user_open_count, ride.user)) {
        let v = table::borrow_mut(&mut market.per_user_open_count, ride.user);
        if (*v > 0) { *v = *v - 1; };
    };

    // v3 — decrement the round's unsettled counter.
    decrement_unsettled_rides(market, ride.round_index);

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

// === abort_segment_ride_v3 ===

public fun abort_segment_ride_v3<C>(
    ride: &mut SegmentRidePositionV3,
    market: &mut SegmentMarketV3<C>,
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
    assert!(
        market.next_segment_index == ride.entry_segment_index,
        ENotPastAbortDeadline,
    );

    let refund_coin = mv::withdraw_for_ride_settlement<C>(vault, ride.escrowed, ctx);

    let this_ride_max_payout =
        (((ride.escrowed as u128) * (ride.multiplier_bps as u128)) / BPS_DENOM_128) as u64;
    decrement_barrier_trackers(market, ride, this_ride_max_payout);

    market.active_ride_count = market.active_ride_count - 1;
    if (table::contains(&market.per_user_open_count, ride.user)) {
        let v = table::borrow_mut(&mut market.per_user_open_count, ride.user);
        if (*v > 0) { *v = *v - 1; };
    };

    // v3 — decrement the round's unsettled counter.
    decrement_unsettled_rides(market, ride.round_index);

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

// === v3 — record_walrus_archive ===

/// Permissionless. Records the Walrus blob ID for a round's archive
/// after the archiver bot uploads it. MUST land BEFORE
/// `prune_settled_segments` for that round (v3.1 invariant per doc 24
/// §8 — the on-chain archive index is always populated when the
/// SegmentRecord rows go away).
///
/// Doc 24 §5 surface:
///   - `EInvalidBlobId` — blob ID length != 32 bytes.
///   - `EArchiveAlreadyRecorded` — round already has an archive entry.
///
/// Emits `RoundArchived { market_id, round_index, walrus_blob_id, archiver }`.
public entry fun record_walrus_archive<C>(
    market: &mut SegmentMarketV3<C>,
    round_index: u64,
    walrus_blob_id: vector<u8>,
    ctx: &mut TxContext,
) {
    // v3.5 archiver decodes the Walrus publisher's base64url response to
    // exactly 32 bytes before invoking us (doc 24 §10a). Assert that
    // contract holds so a malformed blob ID can never enter the index.
    assert!(vector::length(&walrus_blob_id) == WALRUS_BLOB_ID_LEN, EInvalidBlobId);
    // Idempotency — refuse to overwrite an existing entry.
    assert!(
        !table::contains(&market.archive_index, round_index),
        EArchiveAlreadyRecorded,
    );

    table::add(&mut market.archive_index, round_index, walrus_blob_id);

    sui::event::emit(RoundArchived {
        market_id: object::id(market),
        round_index,
        walrus_blob_id,
        archiver: ctx.sender(),
    });
}

// === v3 — prune_settled_segments ===

/// Permissionless. Deletes every SegmentRecord in the round's
/// `[round_index × round_duration_segments,
///  (round_index + 1) × round_duration_segments)` range once the round
/// is fully settled. The caller receives the storage rebate.
///
/// Gates (in order, per doc 23 §3.2 + doc 24 §8):
///   1. `ETooSoonToPrune` — round must be `SETTLEMENT_LAG_ROUNDS` rounds
///      old (`round_index + LAG <= cached_round_index`).
///   2. `EUnsettledRidesRemain` — `unsettled_rides_per_round[round]` must
///      be 0 (every ride opened in this round has been closed / cranked /
///      aborted).
///   3. `EAlreadyPruned` — idempotency, refuse if `pruned_rounds[round]`
///      already exists.
///   4. `ENoWalrusArchive` — v3.1 archive-before-prune invariant; refuse
///      if `archive_index[round]` doesn't exist.
///
/// SEV-2 #A fix from /tmp/review-prune-proto.md: only mark
/// `pruned_rounds[round] = true` when records were actually deleted.
/// An "empty round" (no segments ever recorded — possible if the keeper
/// stalled and no segments fired) would otherwise pay storage for a
/// `pruned_rounds` entry while reclaiming nothing.
///
/// Emits `SegmentsPruned { market_id, round_index, deleted_count, pruner }`.
public entry fun prune_settled_segments<C>(
    market: &mut SegmentMarketV3<C>,
    round_index: u64,
    ctx: &mut TxContext,
) {
    // 1. Lag gate.
    assert!(
        round_index + SETTLEMENT_LAG_ROUNDS <= market.cached_round_index,
        ETooSoonToPrune,
    );

    // 2. Unsettled-rides gate.
    let unsettled = unsettled_rides_for_round(market, round_index);
    assert!(unsettled == 0, EUnsettledRidesRemain);

    // 3. Idempotency gate.
    assert!(
        !table::contains(&market.pruned_rounds, round_index),
        EAlreadyPruned,
    );

    // 4. Walrus archive precondition (v3.1).
    assert!(
        table::contains(&market.archive_index, round_index),
        ENoWalrusArchive,
    );

    // 5. Compute segment range and delete.
    let from = round_index * market.round_duration_segments;
    let to = from + market.round_duration_segments;
    let mut k = from;
    let mut deleted_count = 0;
    while (k < to) {
        if (table::contains(&market.segments, k)) {
            // `SegmentRecord` is `drop` so the runtime auto-releases the
            // storage. Sui credits the rebate to ctx.sender().
            let _record = table::remove(&mut market.segments, k);
            deleted_count = deleted_count + 1;
        };
        k = k + 1;
    };

    // 6. SEV-2 #A fix — only mark pruned if we actually deleted anything.
    //    Round-level marker so an empty-round prune is a clean no-op
    //    (no Table::add write, no negative-EV self-grief).
    if (deleted_count > 0) {
        table::add(&mut market.pruned_rounds, round_index, true);
    };

    // 7. Emit event for indexers and pruner bots.
    sui::event::emit(SegmentsPruned {
        market_id: object::id(market),
        round_index,
        deleted_count,
        pruner: ctx.sender(),
    });
}

// === Internal helpers — bump/decrement unsettled-rides table ===

fun bump_unsettled_rides<C>(market: &mut SegmentMarketV3<C>, round: u64) {
    if (table::contains(&market.unsettled_rides_per_round, round)) {
        let v = table::borrow_mut(&mut market.unsettled_rides_per_round, round);
        *v = *v + 1;
    } else {
        table::add(&mut market.unsettled_rides_per_round, round, 1);
    }
}

fun decrement_unsettled_rides<C>(market: &mut SegmentMarketV3<C>, round: u64) {
    if (table::contains(&market.unsettled_rides_per_round, round)) {
        let v = table::borrow_mut(&mut market.unsettled_rides_per_round, round);
        if (*v > 0) {
            *v = *v - 1;
        };
        // We intentionally do NOT remove the row even when *v hits 0 —
        // leaving a zero-valued entry is cheap (~16 B) and the
        // `prune_settled_segments` gate reads it as the explicit
        // "all rides settled" signal. Removing it would conflate
        // "round had zero opens" with "round had opens that all
        // settled" which is harmless for the gate but unhelpful for
        // explorers + indexer joins.
    };
}

// === Internal: settlement decision ===

fun decide_settlement<C>(
    ride: &SegmentRidePositionV3,
    market: &SegmentMarketV3<C>,
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

    if (mv::is_market_aborted(vault, market_id)) {
        return (0u64, 0u64, 0u64, SETTLEMENT_ABORTED_REFUND)
    };

    let direction_above = direction_for_barrier(ride.barrier_index);
    if (scan_for_touch(
        market,
        ride.entry_segment_index,
        market.next_segment_index,
        ride.barrier_price,
        direction_above,
    )) {
        let p = (((stake_paid as u128) * (ride.multiplier_bps as u128))
            / BPS_DENOM_128) as u64;
        return (stake_paid, p, 0u64, SETTLEMENT_TOUCH_WIN)
    };

    let ride_round_end_segment =
        (ride.round_index + 1) * market.round_duration_segments;
    if (market.next_segment_index >= ride_round_end_segment) {
        return (stake_paid, 0u64, stake_paid, SETTLEMENT_EXPIRED_LOSS)
    };

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
    let payout = if (after_spread > stake_paid) stake_paid else after_spread;
    let forfeit = stake_paid - payout;
    (stake_paid, payout, forfeit, SETTLEMENT_CASHOUT)
}

// === Internal: scan_for_touch ===

fun scan_for_touch<C>(
    market: &SegmentMarketV3<C>,
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

// === Internal: deadband helpers ===

fun add_deadband_up(barrier: u64, deadband_bps: u64): u64 {
    if (deadband_bps == 0) return barrier;
    let margin = (barrier as u128) * (deadband_bps as u128) / BPS_DENOM_128;
    let scaled = (barrier as u128) + margin;
    if (scaled > 18_446_744_073_709_551_615u128) 18_446_744_073_709_551_615u64
    else scaled as u64
}

fun sub_deadband_down(barrier: u64, deadband_bps: u64): u64 {
    if (deadband_bps == 0) return barrier;
    let margin = (barrier as u128) * (deadband_bps as u128) / BPS_DENOM_128;
    if (margin >= (barrier as u128)) 0
    else ((barrier as u128) - margin) as u64
}

// === Internal: helpers ===

fun direction_for_barrier(barrier_index: u8): bool {
    barrier_index == BARRIER_UPPER
}

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

fun compute_stake_paid(
    rate_per_segment: u64,
    segments_held: u64,
    escrowed_cap: u64,
): u64 {
    let raw = (rate_per_segment as u128) * (segments_held as u128);
    if (raw > (escrowed_cap as u128)) escrowed_cap else (raw as u64)
}

fun decrement_barrier_trackers<C>(
    market: &mut SegmentMarketV3<C>,
    ride: &SegmentRidePositionV3,
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
public fun test_only_destroy_market<C>(m: SegmentMarketV3<C>) {
    let SegmentMarketV3 {
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
        unsettled_rides_per_round, pruned_rounds, archive_index,
    } = m;
    object::delete(id);
    table::drop(segments);
    table::drop(per_user_open_count);
    table::drop(unsettled_rides_per_round);
    table::drop(pruned_rounds);
    table::drop(archive_index);
}

#[test_only]
public fun test_only_destroy_ride(r: SegmentRidePositionV3) {
    let SegmentRidePositionV3 {
        id, user: _, market_id: _, round_index: _, entry_segment_index: _,
        barrier_index: _, barrier_price: _, multiplier_bps: _, stake_per_segment: _,
        escrowed: _, is_bot_eligible: _, opened_at_ms: _, closed: _,
        closed_at_ms: _, settlement_kind: _, collateral: _,
    } = r;
    object::delete(id);
}

#[test_only]
public fun test_only_record_segment<C>(
    market: &mut SegmentMarketV3<C>,
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

#[test_only]
public fun test_only_bump_segment_index<C>(market: &mut SegmentMarketV3<C>, n: u64) {
    market.next_segment_index = market.next_segment_index + n;
}

#[test_only]
public fun test_only_force_round_current<C>(market: &mut SegmentMarketV3<C>) {
    ensure_round_current(market);
}

#[test_only]
public fun test_scan_for_touch<C>(
    market: &SegmentMarketV3<C>,
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

/// Test-only: force-set `cached_round_index` so prune-lag assertions can
/// be exercised without recording 3+ rounds of synthetic segments.
/// Production never calls this — `cached_round_index` is bumped only by
/// `ensure_round_current` which keys off `next_segment_index`.
#[test_only]
public fun test_only_set_cached_round_index<C>(market: &mut SegmentMarketV3<C>, r: u64) {
    market.cached_round_index = r;
}

/// Test-only: stuff a fake SegmentRecord at an arbitrary key, used to
/// seed a specific round's segment range for prune tests without
/// progressing `next_segment_index`.
#[test_only]
public fun test_only_insert_segment_at<C>(
    market: &mut SegmentMarketV3<C>,
    k: u64,
    key: vector<u8>,
    state_after: WalkState,
    min_price: u64,
    max_price: u64,
    recorded_at_ms: u64,
) {
    table::add(&mut market.segments, k, SegmentRecord {
        key, state_after, min_price, max_price, recorded_at_ms,
    });
}

/// Test-only: peek at the raw unsettled-rides counter without going
/// through the public accessor (handy for asserting writes happened in
/// open/close paths regardless of which round was current at the time).
#[test_only]
public fun test_only_unsettled_rides_raw<C>(market: &SegmentMarketV3<C>, round: u64): u64 {
    unsettled_rides_for_round(market, round)
}
