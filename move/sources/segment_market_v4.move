// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// segment_market_v4 — the touch-either + always-open-window arcade module.
///
/// This is a CLONE of `wick::segment_market_v3` with the v3.5 deltas from
/// `docs/design/v2/25_touch_either_laser_v3.md`:
///
///   1. **Touch-either** — the user does not pick a side. `open_segment_ride_v4`
///      takes NO `barrier_index` parameter; rides are direction-neutral. The
///      jackpot triggers on EITHER barrier touch in the round.
///
///   2. **Both barriers snapshotted on the ride** — `SegmentRidePositionV4`
///      carries both `upper_barrier_price` and `lower_barrier_price` (set at
///      `open` to the cached round barriers), not a single picked-barrier
///      price. The settlement scan checks both in one pass.
///
///   3. **Single per-round bucket** — the per-barrier upper/lower aggregate
///      trackers (`upper_aggregate_stake` + `lower_aggregate_stake`, etc.)
///      collapse into a single `either_aggregate_stake` /
///      `either_aggregate_max_payout` / `either_rider_count`. Likewise the
///      per-barrier exposure cap (`max_payout_per_barrier`) becomes the
///      shared `max_payout_per_round`.
///
///   4. **Always-open** — `open_window_segments` is gone. Every segment in a
///      round accepts new opens. The directional front-running concern that
///      motivated the window in v2/v3 doesn't apply here: the user is betting
///      volatility, not direction.
///
///   5. **`scan_for_either_touch`** — new internal helper. Returns true if
///      ANY segment in [from_idx, to_idx) had max_price ≥ effective_upper OR
///      min_price ≤ effective_lower. Replaces v3's directional scan_for_touch
///      everywhere in the settlement path.
///
///   6. **New events** — `RideOpenedV4` carries BOTH barrier prices.
///      `RideClosedV4` carries `touched_side: u8` (0=upper, 1=lower,
///      2=none). The both-barriers-touch-in-same-segment tie is resolved
///      UPPER WINS (see `touched_side_resolved`) per doc 25 §9.
///
/// What's UNCHANGED from v3 (inherited verbatim):
///   - The deterministic walk math (`wick::seeded_path::expand_segment`)
///   - `record_segment_v4` — same shape as `record_segment` in v3
///   - `record_walrus_archive_v4` + `prune_settled_segments_v4` — same
///     surface, same gates, same v3.1 archive-before-prune invariant
///   - Bachelier cashout against the NEARER of the two barriers
///   - Per-user concurrent ride cap (default 5)
///   - Vault binding, abort handling, deadband helpers
///   - SETTLEMENT_LAG_ROUNDS / CRANK_BOUNTY_BPS / WALRUS_BLOB_ID_LEN
///
/// v3's `wick::segment_market_v3` is preserved unchanged so existing
/// testnet markets and their tests keep working. v4 is purely additive.
///
/// Design docs:
///   - docs/design/v2/25_touch_either_laser_v3.md (v4 spec — touch-either,
///     always-open, laser overlay)
///   - docs/design/v2/19_round_shared_grid_design.md (round + shared grid
///     structure inherited from v3)
///   - docs/design/v2/23_storage_rebate_pruning_v3.md (prune mechanism
///     inherited from v3)
///   - docs/design/v2/24_walrus_archive_v3.md (Walrus archive inherited
///     from v3)
module wick::segment_market_v4;

use std::type_name::{Self, TypeName};
use sui::bcs;
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::dynamic_field;
use sui::hash;
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
// NOTE: EInvalidBarrierIndex (4) preserved as a stable error number for
// downstream tooling that already maps it, even though v4 no longer accepts
// barrier_index. Code 5 (EOpenWindowClosed) likewise reserved.
#[allow(unused_const)]
const EInvalidBarrierIndex: u64 = 4;
#[allow(unused_const)]
const EOpenWindowClosed: u64 = 5;
const EStakeOutOfRange: u64 = 6;
const EInsufficientEscrow: u64 = 7;
const EZeroEscrow: u64 = 8;
const EConcurrentRideLimit: u64 = 9;
const EPerUserRideLimit: u64 = 10;
/// v4: renamed in spirit (was per-barrier cap) but kept on the same error
/// number for downstream consumers. Now signals the shared per-round cap.
const ERoundCapExceeded: u64 = 11;
const ENotExpired: u64 = 12;
const ETouchedMustSelfClose: u64 = 13;
const ENoActiveRides: u64 = 14;
const EInvalidConfig: u64 = 15;
const ENotPastAbortDeadline: u64 = 16;
const ESegmentAlreadyRecorded: u64 = 17;
/// SEV-1 guard preserved from ride_position.move:362-369. Crank refuses if
/// treasury can't cover (user_refund + bounty) without queue routing.
const EInsufficientTreasuryForCrank: u64 = 18;
// v3 errors (doc 23 §3.2 + doc 24 §5) — preserved verbatim in v4.
const ETooSoonToPrune: u64 = 19;
const EUnsettledRidesRemain: u64 = 20;
const EAlreadyPruned: u64 = 21;
const ENoWalrusArchive: u64 = 22;
const EInvalidBlobId: u64 = 23;
const EArchiveAlreadyRecorded: u64 = 24;
/// v4.26 — `enable_rug` was called twice on the same market. Rug-config is
/// installed exactly once via `dynamic_field`; re-enabling would replace
/// the live rugged state with a fresh `option::none()` which is unsafe
/// mid-round. Re-disable would need its own entry.
const ERugAlreadyEnabled: u64 = 25;

// === Settlement kinds === (unchanged from v3)
const SETTLEMENT_OPEN: u8 = 0;
const SETTLEMENT_TOUCH_WIN: u8 = 1;
const SETTLEMENT_CASHOUT: u8 = 2;
const SETTLEMENT_EXPIRED_LOSS: u8 = 3;
const SETTLEMENT_ABORTED_REFUND: u8 = 4;

// === Touched-side encoding (v4 new) ===
/// `touched_side` byte in `RideClosedV4`:
///   - 0 = upper barrier touched (jackpot — TOUCH_WIN)
///   - 1 = lower barrier touched (jackpot — TOUCH_WIN)
///   - 2 = neither touched (CASHOUT or EXPIRED_LOSS or ABORTED_REFUND)
///
/// Doc 25 §9 tie-break: if BOTH barriers' deadbanded extremes are present in
/// the SAME segment scan, UPPER WINS. Rationale: it's a settlement-display
/// concern only (both sides settle at the same multiplier), and choosing
/// one side deterministically per-row gives indexers a single source of
/// truth without expanding the SegmentRecord wire format.
const TOUCHED_SIDE_UPPER: u8 = 0;
const TOUCHED_SIDE_LOWER: u8 = 1;
const TOUCHED_SIDE_NONE: u8 = 2;

// === Constants === (unchanged from v3 unless noted)
const BPS_DENOMINATOR: u64 = 10_000;
const BPS_DENOM_128: u128 = 10_000;
const CRANK_BOUNTY_BPS: u64 = 50;
const DEFAULT_SEGMENT_MS: u64 = 400;
const SECONDS_PER_MS: u64 = 1_000;
const SETTLEMENT_LAG_ROUNDS: u64 = 3;
const WALRUS_BLOB_ID_LEN: u64 = 32;

/// v4.26 — dynamic-field name under which the per-market `RugConfig` is
/// attached. Using a `vector<u8>` name keeps the wire format trivial and
/// avoids inventing a name-type that would itself need an upgrade.
///
/// We attach rug state via `sui::dynamic_field` (not a struct field) so
/// the rug feature can ship under Sui's COMPATIBLE upgrade policy — adding
/// fields to `SegmentMarketV4<C>` directly would break the upgrade
/// validator's struct-shape check (E01002). See header comment on
/// `RugConfig` below for the rationale in full.
const RUG_CONFIG_KEY: vector<u8> = b"rug_config";

// === Types ===

/// One recorded segment — same shape as v2/v3 SegmentRecord so the BCS
/// schema in doc 24 §3 (which the Walrus archiver depends on) is preserved
/// bit-for-bit across module versions. The v4 module shares Walrus archive
/// semantics with v3.
public struct SegmentRecord has store, copy, drop {
    key: vector<u8>,
    state_after: WalkState,
    min_price: u64,
    max_price: u64,
    recorded_at_ms: u64,
}

/// v4 touch-either arcade market.
///
/// Differences from v3's `SegmentMarketV3<C>`:
///   - DROPPED `open_window_segments` (always-open per doc 25 §4.1).
///   - DROPPED per-barrier trackers (upper_aggregate_stake +
///     lower_aggregate_stake + upper/lower_aggregate_max_payout +
///     upper/lower_rider_count).
///   - ADDED single-bucket trackers (either_aggregate_stake +
///     either_aggregate_max_payout + either_rider_count).
///   - RENAMED `max_payout_per_barrier` → `max_payout_per_round` (same
///     magnitude semantics, one cap shared across both sides).
///   - All v3 prune/archive bookkeeping is inherited verbatim
///     (`unsettled_rides_per_round`, `pruned_rounds`, `archive_index`).
public struct SegmentMarketV4<phantom C> has key {
    id: UID,

    // ── Walk (carried across segments) ──────────────────────────────────────
    walk: WalkState,

    // ── Segment ledger ──────────────────────────────────────────────────────
    next_segment_index: u64,
    segments: Table<u64, SegmentRecord>,

    // ── Wake/sleep gate ─────────────────────────────────────────────────────
    active_ride_count: u64,

    // ── Round + shared grid configuration (immutable post-bootstrap) ────────
    //
    // v4: no open_window_segments — every segment is open.
    round_duration_segments: u64,
    barrier_offset_bps: u64,
    multiplier_bps: u64,
    /// v4 rename of v3's max_payout_per_barrier. Same magnitude semantics,
    /// shared cap across BOTH sides since the vault doesn't care which side
    /// touches.
    max_payout_per_round: u64,

    // ── Cached current-round state ──────────────────────────────────────────
    cached_round_index: u64,
    cached_round_started_at_segment: u64,
    cached_upper_barrier: u64,
    cached_lower_barrier: u64,

    // ── Per-round aggregate (single bucket, no upper/lower split) ───────────
    //
    // v4: the per-side split is gone because rides bet volatility, not
    // direction. One bucket per round; reset on round roll by
    // `ensure_round_current`.
    either_aggregate_stake: u64,
    either_aggregate_max_payout: u64,
    either_rider_count: u64,

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

    // ── v3-inherited prune/archive bookkeeping (doc 23 + doc 24) ────────────
    unsettled_rides_per_round: Table<u64, u64>,
    pruned_rounds: Table<u64, bool>,
    archive_index: Table<u64, vector<u8>>,
}

/// A user's open touch-either ride against a specific round in a
/// SegmentMarketV4. Distinct type from v3's `SegmentRidePositionV3` so
/// callers can't accidentally route a v3 ride into a v4 market or vice
/// versa.
///
/// v4 changes: no `barrier_index`; both `upper_barrier_price` and
/// `lower_barrier_price` are snapshotted at open time (doc 25 §4.1).
public struct SegmentRidePositionV4 has key, store {
    id: UID,
    user: address,
    market_id: ID,

    // ── Round binding ──────────────────────────────────────────────────────
    round_index: u64,
    entry_segment_index: u64,

    // ── BOTH barriers snapshotted at open (no barrier_index in v4) ─────────
    upper_barrier_price: u64,
    lower_barrier_price: u64,

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

public struct SegmentMarketV4Created has copy, drop {
    market_id: ID,
    vault_id: ID,
    home_price: u64,
    round_duration_segments: u64,
    barrier_offset_bps: u64,
    multiplier_bps: u64,
    max_payout_per_round: u64,
    created_at_ms: u64,
}

public struct RoundStartedV4 has copy, drop {
    market_id: ID,
    round_index: u64,
    upper_barrier: u64,
    lower_barrier: u64,
    started_at_segment: u64,
    spot_at_roll: u64,
}

public struct SegmentRecordedV4 has copy, drop {
    market_id: ID,
    k: u64,
    key: vector<u8>,
    min_price: u64,
    max_price: u64,
    recorded_at_ms: u64,
}

/// v4: ride open event carries BOTH barrier prices (no single
/// barrier_index/barrier_price field) per doc 25 §4.4.
public struct RideOpenedV4 has copy, drop {
    ride_id: ID,
    user: address,
    market_id: ID,
    round_index: u64,
    entry_segment_index: u64,
    upper_barrier_price: u64,
    lower_barrier_price: u64,
    stake_per_segment: u64,
    escrowed: u64,
    multiplier_bps: u64,
    opened_at_ms: u64,
}

/// v4: ride close event carries `touched_side` per doc 25 §4.4.
///   - 0 = upper barrier touched (jackpot)
///   - 1 = lower barrier touched (jackpot)
///   - 2 = neither touched (cashout/expired-loss/aborted-refund)
///
/// Both-barriers-touch-in-same-segment tie: UPPER WINS (doc 25 §9 +
/// `touched_side_resolved` helper).
public struct RideClosedV4 has copy, drop {
    ride_id: ID,
    user: address,
    market_id: ID,
    round_index: u64,
    settlement_kind: u8,
    touched_side: u8,
    stake_paid: u64,
    payout: u64,
    forfeit: u64,
    bounty: u64,
    closed_at_ms: u64,
}

/// v3-inherited — emitted by `prune_settled_segments_v4`.
public struct SegmentsPrunedV4 has copy, drop {
    market_id: ID,
    round_index: u64,
    deleted_count: u64,
    pruner: address,
}

/// v3-inherited — emitted by `record_walrus_archive_v4`.
public struct RoundArchivedV4 has copy, drop {
    market_id: ID,
    round_index: u64,
    walrus_blob_id: vector<u8>,
    archiver: address,
}

/// v4.26 — per-market rug-pull configuration + live state.
///
/// Stored as a `sui::dynamic_field` value under `RUG_CONFIG_KEY` on the
/// market's UID rather than as struct fields. Rationale: this lets us ship
/// the rug-pull feature under Sui's COMPATIBLE upgrade policy. Adding two
/// `u64` / `Option<u64>` fields to `SegmentMarketV4<phantom C>` would
/// trigger E01002 (struct shape mismatch) on `sui client upgrade` and the
/// network would reject the publish. Dynamic fields are an additive
/// extension of an existing object — the upgrade validator only sees the
/// struct shape, which is unchanged.
///
/// Lifecycle:
///   - Absent on bootstrap (markets without rug enabled behave identically
///     to today; all accessors gracefully degrade to "rug disabled").
///   - Installed exactly once via `enable_rug<C>` — subsequent calls abort
///     with `ERugAlreadyEnabled` so we never wipe live `rugged_at_segment`
///     state mid-round.
///   - `rug_chance_bps` is the per-segment fire probability in bps
///     (0..=10_000). 150 = 1.5% is the doc 26 §2.1 sweet spot.
///   - `rugged_at_segment` is `option::none()` at the start of each round,
///     set to the segment index by `record_segment` when `roll_rug` fires,
///     and cleared back to `option::none()` by `ensure_round_current` on
///     round transitions.
public struct RugConfig has store, drop {
    rug_chance_bps: u64,
    rugged_at_segment: Option<u64>,
}

/// v4.26 — emitted by `record_segment` when the deterministic rug roll
/// fires the rug for the current round. Frontends subscribe to this to
/// flash the "MARKET HALT" UX (doc 26 §3.6). Open rides at the time of
/// the rug settle as `SETTLEMENT_EXPIRED_LOSS` lazily on close — no new
/// settlement kind is introduced (per doc 26 §3.4 the frontend correlates
/// loss-events with this event by `(market_id, round_index)`).
public struct RugFiredV4 has copy, drop {
    market_id: ID,
    round_index: u64,
    segment_index: u64,
}

// === Read accessors ===

public fun market_id_of_ride(r: &SegmentRidePositionV4): ID { r.market_id }
public fun user(r: &SegmentRidePositionV4): address { r.user }
public fun round_index(r: &SegmentRidePositionV4): u64 { r.round_index }
public fun upper_barrier_price(r: &SegmentRidePositionV4): u64 { r.upper_barrier_price }
public fun lower_barrier_price(r: &SegmentRidePositionV4): u64 { r.lower_barrier_price }
public fun entry_segment_index(r: &SegmentRidePositionV4): u64 { r.entry_segment_index }
public fun multiplier_bps_of_ride(r: &SegmentRidePositionV4): u64 { r.multiplier_bps }
public fun stake_per_segment(r: &SegmentRidePositionV4): u64 { r.stake_per_segment }
public fun escrowed(r: &SegmentRidePositionV4): u64 { r.escrowed }
public fun is_bot_eligible(r: &SegmentRidePositionV4): bool { r.is_bot_eligible }
public fun opened_at_ms(r: &SegmentRidePositionV4): u64 { r.opened_at_ms }
public fun is_closed(r: &SegmentRidePositionV4): bool { r.closed }
public fun closed_at_ms(r: &SegmentRidePositionV4): u64 { r.closed_at_ms }
public fun settlement_kind(r: &SegmentRidePositionV4): u8 { r.settlement_kind }
public fun collateral(r: &SegmentRidePositionV4): &TypeName { &r.collateral }

public fun settlement_open(): u8 { SETTLEMENT_OPEN }
public fun settlement_touch_win(): u8 { SETTLEMENT_TOUCH_WIN }
public fun settlement_cashout(): u8 { SETTLEMENT_CASHOUT }
public fun settlement_expired_loss(): u8 { SETTLEMENT_EXPIRED_LOSS }
public fun settlement_aborted_refund(): u8 { SETTLEMENT_ABORTED_REFUND }
public fun touched_side_upper(): u8 { TOUCHED_SIDE_UPPER }
public fun touched_side_lower(): u8 { TOUCHED_SIDE_LOWER }
public fun touched_side_none(): u8 { TOUCHED_SIDE_NONE }
public fun default_segment_ms(): u64 { DEFAULT_SEGMENT_MS }
public fun crank_bounty_bps(): u64 { CRANK_BOUNTY_BPS }
public fun settlement_lag_rounds(): u64 { SETTLEMENT_LAG_ROUNDS }
public fun walrus_blob_id_len(): u64 { WALRUS_BLOB_ID_LEN }

public fun next_segment_index<C>(m: &SegmentMarketV4<C>): u64 { m.next_segment_index }
public fun active_ride_count<C>(m: &SegmentMarketV4<C>): u64 { m.active_ride_count }
public fun cached_round_index<C>(m: &SegmentMarketV4<C>): u64 { m.cached_round_index }
public fun cached_upper_barrier<C>(m: &SegmentMarketV4<C>): u64 { m.cached_upper_barrier }
public fun cached_lower_barrier<C>(m: &SegmentMarketV4<C>): u64 { m.cached_lower_barrier }
public fun cached_round_started_at_segment<C>(m: &SegmentMarketV4<C>): u64 {
    m.cached_round_started_at_segment
}
public fun either_aggregate_stake<C>(m: &SegmentMarketV4<C>): u64 { m.either_aggregate_stake }
public fun either_aggregate_max_payout<C>(m: &SegmentMarketV4<C>): u64 { m.either_aggregate_max_payout }
public fun either_rider_count<C>(m: &SegmentMarketV4<C>): u64 { m.either_rider_count }
public fun vault_id<C>(m: &SegmentMarketV4<C>): ID { m.vault_id }
public fun round_duration_segments<C>(m: &SegmentMarketV4<C>): u64 { m.round_duration_segments }
public fun barrier_offset_bps<C>(m: &SegmentMarketV4<C>): u64 { m.barrier_offset_bps }
public fun multiplier_bps<C>(m: &SegmentMarketV4<C>): u64 { m.multiplier_bps }
public fun max_payout_per_round<C>(m: &SegmentMarketV4<C>): u64 { m.max_payout_per_round }
public fun deadband_bps<C>(m: &SegmentMarketV4<C>): u64 { m.deadband_bps }
public fun walk_price<C>(m: &SegmentMarketV4<C>): u64 { sp::state_price(&m.walk) }

// === v4.26 — rug-pull state accessors (doc 26) ===
//
// All accessors gracefully degrade to a "disabled" value when the market
// has no `RugConfig` attached (i.e. `enable_rug` was never called). The
// SDK reads `rug_chance_bps` for display purposes and `rugged_at_segment`
// for the close-time `MARKET HALT` toast; `is_rugged` is a hot-path
// convenience used by both the frontend live indicator and on-chain
// settlement gating.

/// True iff the market has had `enable_rug<C>` called on it.
public fun rug_enabled<C>(m: &SegmentMarketV4<C>): bool {
    dynamic_field::exists_with_type<vector<u8>, RugConfig>(&m.id, RUG_CONFIG_KEY)
}

/// Per-segment rug-fire probability in bps. 0 when rug is not enabled.
public fun rug_chance_bps<C>(m: &SegmentMarketV4<C>): u64 {
    if (!rug_enabled(m)) return 0;
    dynamic_field::borrow<vector<u8>, RugConfig>(&m.id, RUG_CONFIG_KEY).rug_chance_bps
}

/// `Some(seg_idx)` once the rug has fired this round, `None` otherwise.
public fun rugged_at_segment<C>(m: &SegmentMarketV4<C>): Option<u64> {
    if (!rug_enabled(m)) return option::none();
    dynamic_field::borrow<vector<u8>, RugConfig>(&m.id, RUG_CONFIG_KEY).rugged_at_segment
}

/// Has a rug fired in the current round? `false` when rug is not enabled.
public fun is_rugged<C>(m: &SegmentMarketV4<C>): bool {
    option::is_some(&rugged_at_segment(m))
}

public fun has_segment<C>(m: &SegmentMarketV4<C>, k: u64): bool {
    table::contains(&m.segments, k)
}

public fun segment_min<C>(m: &SegmentMarketV4<C>, k: u64): u64 {
    table::borrow(&m.segments, k).min_price
}

public fun segment_max<C>(m: &SegmentMarketV4<C>, k: u64): u64 {
    table::borrow(&m.segments, k).max_price
}

public fun segment_recorded_at_ms<C>(m: &SegmentMarketV4<C>, k: u64): u64 {
    table::borrow(&m.segments, k).recorded_at_ms
}

public fun segment_key<C>(m: &SegmentMarketV4<C>, k: u64): vector<u8> {
    table::borrow(&m.segments, k).key
}

/// v3-inherited — how many open rides remain in the given round.
public fun unsettled_rides_for_round<C>(m: &SegmentMarketV4<C>, round: u64): u64 {
    if (table::contains(&m.unsettled_rides_per_round, round)) {
        *table::borrow(&m.unsettled_rides_per_round, round)
    } else {
        0
    }
}

/// v3-inherited — true once `prune_settled_segments_v4` succeeded.
public fun is_round_pruned<C>(m: &SegmentMarketV4<C>, round: u64): bool {
    table::contains(&m.pruned_rounds, round)
}

/// v3-inherited — true once `record_walrus_archive_v4` succeeded.
public fun has_walrus_archive<C>(m: &SegmentMarketV4<C>, round: u64): bool {
    table::contains(&m.archive_index, round)
}

/// v3-inherited — Walrus blob ID for the given round's archive.
public fun walrus_blob_id<C>(m: &SegmentMarketV4<C>, round: u64): vector<u8> {
    *table::borrow(&m.archive_index, round)
}

// === Constructor + share ===

/// Construct a new SegmentMarketV4. Parameter contract reduced from v3:
///   - DROPPED `open_window_segments` (no window in v4)
///   - RENAMED `max_payout_per_barrier` → `max_payout_per_round`
/// All other parameters carry the same semantics as v3.
public fun new_segment_market_v4<C>(
    vault: &MartingalerVault<C>,
    home_price: u64,
    vol_regime_init: u64,
    round_duration_segments: u64,
    barrier_offset_bps: u64,
    multiplier_bps: u64,
    max_payout_per_round: u64,
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
): SegmentMarketV4<C> {
    // Parameter validation — mirrors v3 minus the open_window_segments
    // constraints.
    assert!(home_price > 0, EInvalidConfig);
    assert!(round_duration_segments > 0, EInvalidConfig);
    assert!(barrier_offset_bps > 0 && barrier_offset_bps <= BPS_DENOMINATOR, EInvalidConfig);
    assert!(multiplier_bps > BPS_DENOMINATOR, EInvalidConfig);
    assert!(deadband_bps <= BPS_DENOMINATOR, EInvalidConfig);
    assert!(cashout_spread_bps <= BPS_DENOMINATOR, EInvalidConfig);
    assert!(sigma_bps_per_sqrt_sec > 0, EInvalidConfig);
    assert!(min_stake_per_segment > 0, EInvalidConfig);
    assert!(max_stake_per_segment >= min_stake_per_segment, EInvalidConfig);
    assert!(max_concurrent_rides > 0, EInvalidConfig);
    assert!(max_rides_per_user > 0, EInvalidConfig);
    assert!(max_payout_per_round > 0, EInvalidConfig);
    assert!(vol_regime_init > 0, EInvalidConfig);

    let walk = sp::new_state(home_price, vol_regime_init, home_price);

    let offset = ((home_price as u128) * (barrier_offset_bps as u128) / BPS_DENOM_128) as u64;
    let upper = home_price + offset;
    let lower = if (home_price > offset) home_price - offset else 1;

    let now = clock.timestamp_ms();
    let vault_id = object::id(vault);

    let market = SegmentMarketV4<C> {
        id: object::new(ctx),
        walk,
        next_segment_index: 0,
        segments: table::new(ctx),
        active_ride_count: 0,
        round_duration_segments,
        barrier_offset_bps,
        multiplier_bps,
        max_payout_per_round,
        cached_round_index: 0,
        cached_round_started_at_segment: 0,
        cached_upper_barrier: upper,
        cached_lower_barrier: lower,
        either_aggregate_stake: 0,
        either_aggregate_max_payout: 0,
        either_rider_count: 0,
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
        // v3-inherited additions
        unsettled_rides_per_round: table::new(ctx),
        pruned_rounds: table::new(ctx),
        archive_index: table::new(ctx),
    };

    sui::event::emit(SegmentMarketV4Created {
        market_id: object::id(&market),
        vault_id,
        home_price,
        round_duration_segments,
        barrier_offset_bps,
        multiplier_bps,
        max_payout_per_round,
        created_at_ms: now,
    });

    market
}

/// Share a freshly-constructed SegmentMarketV4. Called by the admin
/// bootstrap entry in `wick.move`.
public entry fun share_segment_market_v4<C>(market: SegmentMarketV4<C>) {
    transfer::share_object(market);
}

// === v4.26 — enable_rug ===

/// Opt the market into the rug-pull house-edge mechanism (doc 26).
///
/// Installs a `RugConfig` dynamic field under `RUG_CONFIG_KEY`. From this
/// point on, every `record_segment` call rolls a deterministic dice
/// (keccak256(segment_key || market_id_bytes || round_bytes), first 8
/// bytes mod 10_000) and fires `RugFiredV4` if the roll is below
/// `rug_chance_bps`. Rides open at or before the fire-segment settle as
/// `EXPIRED_LOSS` on close (doc 26 §3.4).
///
/// Permissionless — the market itself is shared and rug-enabling is
/// destructive only via the abort, so requiring an admin cap here would
/// just be ceremony. The intended caller is the bootstrap script
/// (`scripts/bootstrap-tusd-market-rugged.sh`) which runs immediately
/// after `bootstrap_segment_market_v4` in the same flow. The validation
/// gate is the `rug_chance_bps <= BPS_DENOMINATOR` assert + the
/// `ERugAlreadyEnabled` idempotency abort.
///
/// Aborts:
///   - `ERugAlreadyEnabled` if a `RugConfig` is already attached.
///   - `EInvalidConfig` if `rug_chance_bps > BPS_DENOMINATOR` (10_000).
public entry fun enable_rug<C>(
    market: &mut SegmentMarketV4<C>,
    rug_chance_bps: u64,
) {
    assert!(!rug_enabled(market), ERugAlreadyEnabled);
    assert!(rug_chance_bps <= BPS_DENOMINATOR, EInvalidConfig);
    dynamic_field::add<vector<u8>, RugConfig>(
        &mut market.id,
        RUG_CONFIG_KEY,
        RugConfig { rug_chance_bps, rugged_at_segment: option::none<u64>() },
    );
}

// === ensure_round_current ===

fun ensure_round_current<C>(market: &mut SegmentMarketV4<C>) {
    let next_idx = market.next_segment_index;
    let current_round = next_idx / market.round_duration_segments;
    if (current_round <= market.cached_round_index) return;

    market.cached_round_index = current_round;
    market.cached_round_started_at_segment = current_round * market.round_duration_segments;

    let spot = sp::state_price(&market.walk);
    let offset = ((spot as u128) * (market.barrier_offset_bps as u128) / BPS_DENOM_128) as u64;
    market.cached_upper_barrier = spot + offset;
    market.cached_lower_barrier = if (spot > offset) spot - offset else 1;

    // v4: reset the single per-round bucket (not separate upper/lower).
    market.either_aggregate_stake = 0;
    market.either_aggregate_max_payout = 0;
    market.either_rider_count = 0;

    // v4.26 — clear the rugged flag on round-roll so the new round gets a
    // fresh roll budget (doc 26 §3.5). No-op when rug is not enabled.
    if (rug_enabled(market)) {
        let cfg = dynamic_field::borrow_mut<vector<u8>, RugConfig>(
            &mut market.id, RUG_CONFIG_KEY,
        );
        cfg.rugged_at_segment = option::none<u64>();
    };

    sui::event::emit(RoundStartedV4 {
        market_id: object::id(market),
        round_index: current_round,
        upper_barrier: market.cached_upper_barrier,
        lower_barrier: market.cached_lower_barrier,
        started_at_segment: market.cached_round_started_at_segment,
        spot_at_roll: spot,
    });
}

// === record_segment ===

/// Same shape as v2/v3: `entry` (not `public`), single 32-byte random draw,
/// constant-gas walk. Routes through `wick::wick::record_segment_v4` so
/// other packages cannot call it directly.
///
/// v4.26: after the walk + ledger write, if the market has rug enabled and
/// no rug has fired in this round yet, performs a deterministic per-segment
/// rug roll (doc 26 §3.3). If `roll_rug` returns true, the rug fires at
/// the segment we just recorded (`k`) and `RugFiredV4` is emitted.
///
/// Settlement is LAZY — `close_segment_ride_v4` reads `rugged_at_segment`
/// via `decide_settlement` and routes pre-rug rides to `EXPIRED_LOSS`. We
/// never iterate active rides here so per-segment gas stays constant.
public(package) entry fun record_segment<C>(
    market: &mut SegmentMarketV4<C>,
    r: &Random,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(market.active_ride_count > 0, ENoActiveRides);

    ensure_round_current(market);

    let mut gen = random::new_generator(r, ctx);
    let key = random::generate_bytes(&mut gen, 32);

    // v4.31 — drift regime integration DEFERRED to v4.32 publish.
    // Bytecode budget would push the upgrade over Sui's 102_400-byte
    // package limit (~260 over after sweep). Client + SDK already
    // compute the regime independently from (market_id, round_index)
    // and RegimeBadge surfaces it as a preview classification; chain
    // walk stays Brownian for now (regime is informational only).

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

    sui::event::emit(SegmentRecordedV4 {
        market_id: object::id(market),
        k,
        key,
        min_price: smin,
        max_price: smax,
        recorded_at_ms: recorded_at,
    });

    // v4.26 — rug roll. All `&market` reads happen inside `roll_rug` —
    // which folds in the enabled-check, rug_chance_bps gate, already-rugged
    // gate, and the deterministic dice — before we take the single
    // `&mut market.id` borrow that fires the rug. Satisfies Move's borrow
    // checker. The at-most-one-fire-per-round invariant comes from the
    // `option::is_some` gate in `roll_rug` plus the round-roll clear in
    // `ensure_round_current`.
    if (roll_rug<C>(market, &key)) {
        let cached_round = market.cached_round_index;
        let market_id_for_event = object::id(market);
        let cfg_mut = dynamic_field::borrow_mut<vector<u8>, RugConfig>(
            &mut market.id, RUG_CONFIG_KEY,
        );
        option::fill(&mut cfg_mut.rugged_at_segment, k);
        sui::event::emit(RugFiredV4 {
            market_id: market_id_for_event,
            round_index: cached_round,
            segment_index: k,
        });
    };
}

// === open_segment_ride_v4 ===

/// v4: Open a touch-either ride against the round's TWO shared barriers.
/// The user does NOT pick a side — both barriers are snapshotted on the
/// ride and a touch on EITHER side wins the jackpot.
///
/// Differences from v3 `open_segment_ride_v3`:
///   - NO `barrier_index` parameter
///   - NO open-window assertion (always-open per doc 25 §4.1)
///   - The single `either_aggregate_max_payout` cap is checked against
///     `max_payout_per_round` (replaces v3's per-side caps)
///
/// All other asserts (vault binding, stake range, escrow capacity, global
/// concurrency, per-user cap, vault-aborted) preserved verbatim.
public fun open_segment_ride_v4<C>(
    market: &mut SegmentMarketV4<C>,
    vault: &mut MartingalerVault<C>,
    bot_registry: &BotRegistry,
    stake_per_segment: u64,
    escrow: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): SegmentRidePositionV4 {
    // 1. Vault binding
    assert!(market.vault_id == object::id(vault), EWrongMarket);
    // 2. Lazy-roll the round if needed
    ensure_round_current(market);
    // 3. (v4: NO open-window assert — every segment in the round is open)
    // 4. Stake range
    assert!(
        stake_per_segment >= market.min_stake_per_segment
            && stake_per_segment <= market.max_stake_per_segment,
        EStakeOutOfRange,
    );

    // 5. Escrow capacity
    let escrow_amount = coin::value(&escrow);
    assert!(escrow_amount > 0, EZeroEscrow);
    let required_escrow =
        ((stake_per_segment as u128) * (market.round_duration_segments as u128)) as u128;
    assert!((escrow_amount as u128) >= required_escrow, EInsufficientEscrow);

    // 6. Global concurrency cap
    assert!(market.active_ride_count < market.max_concurrent_rides, EConcurrentRideLimit);

    // 7. Per-user cap
    let user = ctx.sender();
    let prior_user_open_count = if (table::contains(&market.per_user_open_count, user)) {
        *table::borrow(&market.per_user_open_count, user)
    } else { 0 };
    assert!(prior_user_open_count < market.max_rides_per_user, EPerUserRideLimit);

    // 8. Vault-aborted check
    let market_id = object::id(market);
    assert!(!mv::is_market_aborted(vault, market_id), EMarketAborted);

    // 9. Single per-round cap check (v4 collapse of v3's per-side caps).
    let this_ride_max_payout =
        (((escrow_amount as u128) * (market.multiplier_bps as u128)) / BPS_DENOM_128) as u64;
    assert!(
        market.either_aggregate_max_payout + this_ride_max_payout
            <= market.max_payout_per_round,
        ERoundCapExceeded,
    );

    // 10. Bump the single per-round bucket (v4 collapse of v3's per-side
    //     trackers).
    market.either_aggregate_stake = market.either_aggregate_stake + escrow_amount;
    market.either_aggregate_max_payout =
        market.either_aggregate_max_payout + this_ride_max_payout;
    market.either_rider_count = market.either_rider_count + 1;

    // 11. Bump active_ride_count + per-user open count
    market.active_ride_count = market.active_ride_count + 1;
    if (table::contains(&market.per_user_open_count, user)) {
        let v = table::borrow_mut(&mut market.per_user_open_count, user);
        *v = *v + 1;
    } else {
        table::add(&mut market.per_user_open_count, user, 1);
    };

    // 12. v3-inherited — bump unsettled_rides_per_round for the current
    //     round (prune-gate counter).
    let round = market.cached_round_index;
    bump_unsettled_rides(market, round);

    // 13. Escrow into the vault's treasury
    mv::deposit_ride_escrow<C>(vault, escrow);

    // 14. Snapshot bot eligibility
    let is_bot_eligible = br::is_eligible_for_wick(bot_registry, user);

    let now = clock.timestamp_ms();

    // v4: snapshot BOTH barrier prices (no single picked barrier).
    let upper_at_open = market.cached_upper_barrier;
    let lower_at_open = market.cached_lower_barrier;

    let ride = SegmentRidePositionV4 {
        id: object::new(ctx),
        user,
        market_id,
        round_index: market.cached_round_index,
        entry_segment_index: market.next_segment_index,
        upper_barrier_price: upper_at_open,
        lower_barrier_price: lower_at_open,
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

    sui::event::emit(RideOpenedV4 {
        ride_id: object::id(&ride),
        user,
        market_id,
        round_index: market.cached_round_index,
        entry_segment_index: market.next_segment_index,
        upper_barrier_price: upper_at_open,
        lower_barrier_price: lower_at_open,
        stake_per_segment,
        escrowed: escrow_amount,
        multiplier_bps: market.multiplier_bps,
        opened_at_ms: now,
    });

    ride
}

// === close_segment_ride_v4 ===

public fun close_segment_ride_v4<C>(
    ride: &mut SegmentRidePositionV4,
    market: &mut SegmentMarketV4<C>,
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

    let (stake_paid, payout, forfeit, kind, touched_side) =
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
    decrement_either_trackers(market, ride, this_ride_max_payout);

    market.active_ride_count = market.active_ride_count - 1;
    if (table::contains(&market.per_user_open_count, ride.user)) {
        let v = table::borrow_mut(&mut market.per_user_open_count, ride.user);
        if (*v > 0) { *v = *v - 1; };
    };

    decrement_unsettled_rides(market, ride.round_index);

    ride.closed = true;
    ride.closed_at_ms = now;
    ride.settlement_kind = kind;

    sui::event::emit(RideClosedV4 {
        ride_id: object::id(ride),
        user: ride.user,
        market_id,
        round_index: ride.round_index,
        settlement_kind: kind,
        touched_side,
        stake_paid,
        payout,
        forfeit,
        bounty: 0,
        closed_at_ms: now,
    });

    payout_coin
}

// === crank_expired_segment_ride_v4 ===

public fun crank_expired_segment_ride_v4<C>(
    ride: &mut SegmentRidePositionV4,
    market: &mut SegmentMarketV4<C>,
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

    // v4: scan for EITHER barrier touch across the ride window.
    let touched = scan_for_either_touch<C>(
        market,
        ride.entry_segment_index,
        ride_round_end_segment,
        ride.upper_barrier_price,
        ride.lower_barrier_price,
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
    decrement_either_trackers(market, ride, this_ride_max_payout);

    market.active_ride_count = market.active_ride_count - 1;
    if (table::contains(&market.per_user_open_count, ride.user)) {
        let v = table::borrow_mut(&mut market.per_user_open_count, ride.user);
        if (*v > 0) { *v = *v - 1; };
    };

    decrement_unsettled_rides(market, ride.round_index);

    let now = clock.timestamp_ms();
    ride.closed = true;
    ride.closed_at_ms = now;
    ride.settlement_kind = SETTLEMENT_EXPIRED_LOSS;

    sui::event::emit(RideClosedV4 {
        ride_id: object::id(ride),
        user: ride.user,
        market_id: object::id(market),
        round_index: ride.round_index,
        settlement_kind: SETTLEMENT_EXPIRED_LOSS,
        touched_side: TOUCHED_SIDE_NONE,
        stake_paid,
        payout: 0,
        forfeit: forfeit_after_bounty,
        bounty,
        closed_at_ms: now,
    });

    bounty_coin
}

// === abort_segment_ride_v4 ===

public fun abort_segment_ride_v4<C>(
    ride: &mut SegmentRidePositionV4,
    market: &mut SegmentMarketV4<C>,
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
    decrement_either_trackers(market, ride, this_ride_max_payout);

    market.active_ride_count = market.active_ride_count - 1;
    if (table::contains(&market.per_user_open_count, ride.user)) {
        let v = table::borrow_mut(&mut market.per_user_open_count, ride.user);
        if (*v > 0) { *v = *v - 1; };
    };

    decrement_unsettled_rides(market, ride.round_index);

    ride.closed = true;
    ride.closed_at_ms = now;
    ride.settlement_kind = SETTLEMENT_ABORTED_REFUND;

    sui::event::emit(RideClosedV4 {
        ride_id: object::id(ride),
        user: ride.user,
        market_id: object::id(market),
        round_index: ride.round_index,
        settlement_kind: SETTLEMENT_ABORTED_REFUND,
        touched_side: TOUCHED_SIDE_NONE,
        stake_paid: 0,
        payout: 0,
        forfeit: 0,
        bounty: 0,
        closed_at_ms: now,
    });

    refund_coin
}

// === v3-inherited — record_walrus_archive_v4 ===

/// Permissionless. Records the Walrus blob ID for a round's archive
/// after the archiver bot uploads it. MUST land BEFORE
/// `prune_settled_segments_v4` for that round (v3.1 invariant per doc 24
/// §8). v4 inherits the v3 surface verbatim.
public entry fun record_walrus_archive<C>(
    market: &mut SegmentMarketV4<C>,
    round_index: u64,
    walrus_blob_id: vector<u8>,
    ctx: &mut TxContext,
) {
    assert!(vector::length(&walrus_blob_id) == WALRUS_BLOB_ID_LEN, EInvalidBlobId);
    assert!(
        !table::contains(&market.archive_index, round_index),
        EArchiveAlreadyRecorded,
    );

    table::add(&mut market.archive_index, round_index, walrus_blob_id);

    sui::event::emit(RoundArchivedV4 {
        market_id: object::id(market),
        round_index,
        walrus_blob_id,
        archiver: ctx.sender(),
    });
}

// === v3-inherited — prune_settled_segments_v4 ===

/// Permissionless. Deletes every SegmentRecord in the round's
/// `[round_index × round_duration_segments,
///  (round_index + 1) × round_duration_segments)` range once the round is
/// fully settled. The caller receives the storage rebate.
///
/// Gates inherited from v3 (in order):
///   1. `ETooSoonToPrune` — round must be `SETTLEMENT_LAG_ROUNDS` old.
///   2. `EUnsettledRidesRemain` — `unsettled_rides_per_round[round] == 0`.
///   3. `EAlreadyPruned` — idempotency.
///   4. `ENoWalrusArchive` — archive-before-prune invariant.
///
/// SEV-2 #A fix: only mark `pruned_rounds[round]` when records were
/// actually deleted (empty-round prune is a no-op, not a write).
public entry fun prune_settled_segments<C>(
    market: &mut SegmentMarketV4<C>,
    round_index: u64,
    ctx: &mut TxContext,
) {
    assert!(
        round_index + SETTLEMENT_LAG_ROUNDS <= market.cached_round_index,
        ETooSoonToPrune,
    );

    let unsettled = unsettled_rides_for_round(market, round_index);
    assert!(unsettled == 0, EUnsettledRidesRemain);

    assert!(
        !table::contains(&market.pruned_rounds, round_index),
        EAlreadyPruned,
    );

    assert!(
        table::contains(&market.archive_index, round_index),
        ENoWalrusArchive,
    );

    let from = round_index * market.round_duration_segments;
    let to = from + market.round_duration_segments;
    let mut k = from;
    let mut deleted_count = 0;
    while (k < to) {
        if (table::contains(&market.segments, k)) {
            let _record = table::remove(&mut market.segments, k);
            deleted_count = deleted_count + 1;
        };
        k = k + 1;
    };

    if (deleted_count > 0) {
        table::add(&mut market.pruned_rounds, round_index, true);
    };

    sui::event::emit(SegmentsPrunedV4 {
        market_id: object::id(market),
        round_index,
        deleted_count,
        pruner: ctx.sender(),
    });
}

// === Internal helpers — bump/decrement unsettled-rides table ===

fun bump_unsettled_rides<C>(market: &mut SegmentMarketV4<C>, round: u64) {
    if (table::contains(&market.unsettled_rides_per_round, round)) {
        let v = table::borrow_mut(&mut market.unsettled_rides_per_round, round);
        *v = *v + 1;
    } else {
        table::add(&mut market.unsettled_rides_per_round, round, 1);
    }
}

fun decrement_unsettled_rides<C>(market: &mut SegmentMarketV4<C>, round: u64) {
    if (table::contains(&market.unsettled_rides_per_round, round)) {
        let v = table::borrow_mut(&mut market.unsettled_rides_per_round, round);
        if (*v > 0) {
            *v = *v - 1;
        };
    };
}

// === Internal: settlement decision ===

/// v4 settlement decision. Returns
/// `(stake_paid, payout, forfeit, kind, touched_side)`.
///
/// `touched_side` semantics:
///   - TOUCH_WIN: the side that actually touched first (UPPER wins ties
///     per doc 25 §9 + `touched_side_resolved`)
///   - CASHOUT / EXPIRED_LOSS / ABORTED_REFUND: TOUCHED_SIDE_NONE (2)
///
/// v4.26 ordering (doc 26 §3.4): rug check fires AFTER vault-abort (so an
/// aborted market still refunds 1:1 — the abort is the user-protective
/// invariant) but BEFORE the touch scan, so a ride that was open when the
/// rug fired CANNOT salvage a TOUCH_WIN by waiting for a later barrier
/// crossing. The frontend distinguishes rug from natural expiry via the
/// `RugFiredV4` event (per doc 26 §3.4, the on-chain settlement kind is
/// the same `SETTLEMENT_EXPIRED_LOSS` to avoid a new wire format).
fun decide_settlement<C>(
    ride: &SegmentRidePositionV4,
    market: &SegmentMarketV4<C>,
    vault: &MartingalerVault<C>,
): (u64, u64, u64, u8, u8) {
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
        return (0u64, 0u64, 0u64, SETTLEMENT_ABORTED_REFUND, TOUCHED_SIDE_NONE)
    };

    // v4.26 — rug routing. If a rug has fired this round AND this ride
    // was open at or before that segment, settle as EXPIRED_LOSS
    // regardless of any subsequent barrier touch. Rides opened AFTER the
    // rug (entry_segment_index > rugged_seg) fall through to the normal
    // settlement path — the bet was placed knowing the round was rugged.
    let opt_rugged = rugged_at_segment(market);
    if (option::is_some(&opt_rugged)
        && ride.entry_segment_index <= *option::borrow(&opt_rugged)
    ) {
        return (stake_paid, 0u64, stake_paid, SETTLEMENT_EXPIRED_LOSS, TOUCHED_SIDE_NONE)
    };

    // v4: check EITHER side. If touched, resolve which side wins the
    // touched_side display (UPPER wins same-segment ties).
    if (scan_for_either_touch<C>(
        market,
        ride.entry_segment_index,
        market.next_segment_index,
        ride.upper_barrier_price,
        ride.lower_barrier_price,
    )) {
        let p = (((stake_paid as u128) * (ride.multiplier_bps as u128))
            / BPS_DENOM_128) as u64;
        let touched_side = touched_side_resolved<C>(
            market,
            ride.entry_segment_index,
            market.next_segment_index,
            ride.upper_barrier_price,
            ride.lower_barrier_price,
        );
        return (stake_paid, p, 0u64, SETTLEMENT_TOUCH_WIN, touched_side)
    };

    let ride_round_end_segment =
        (ride.round_index + 1) * market.round_duration_segments;
    if (market.next_segment_index >= ride_round_end_segment) {
        return (stake_paid, 0u64, stake_paid, SETTLEMENT_EXPIRED_LOSS, TOUCHED_SIDE_NONE)
    };

    let segments_remaining = ride_round_end_segment - market.next_segment_index;
    let seconds_remaining =
        (segments_remaining * DEFAULT_SEGMENT_MS) / SECONDS_PER_MS;
    let spot = sp::state_price(&market.walk);
    // v4: cashout against the NEARER of the two barriers (doc 25 §8).
    let nearer_barrier = nearer_barrier(
        spot, ride.upper_barrier_price, ride.lower_barrier_price,
    );
    let factor = ride_pricing::bachelier_cashout_factor(
        spot, nearer_barrier, market.sigma_bps_per_sqrt_sec, seconds_remaining,
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
    (stake_paid, payout, forfeit, SETTLEMENT_CASHOUT, TOUCHED_SIDE_NONE)
}

// === Internal: scan_for_either_touch (v4 new) ===

/// Returns true if ANY segment in [from_idx, to_idx) had
/// `max_price >= effective_upper_barrier` OR
/// `min_price <= effective_lower_barrier`.
///
/// Direction-neutral — either side triggers (doc 25 §4.3). Replaces v3's
/// directional `scan_for_touch` in every settlement path.
fun scan_for_either_touch<C>(
    market: &SegmentMarketV4<C>,
    from_idx: u64,
    to_idx: u64,
    upper_barrier: u64,
    lower_barrier: u64,
): bool {
    let upper_with_deadband = add_deadband_up(upper_barrier, market.deadband_bps);
    let lower_with_deadband = sub_deadband_down(lower_barrier, market.deadband_bps);
    let mut k = from_idx;
    while (k < to_idx) {
        if (table::contains(&market.segments, k)) {
            let r = table::borrow(&market.segments, k);
            if (r.max_price >= upper_with_deadband) return true;
            if (r.min_price <= lower_with_deadband) return true;
        };
        k = k + 1;
    };
    false
}

/// Resolves WHICH side touched first across the ride window. UPPER WINS
/// ties per doc 25 §9 (display-only concern — both sides settle at the same
/// multiplier). Scans segments in order; the first segment that crosses
/// either deadbanded barrier picks the side, with upper checked first.
///
/// Precondition: `scan_for_either_touch` already returned true. If neither
/// side actually touched (shouldn't happen post-check), returns
/// TOUCHED_SIDE_NONE as a safe fallback.
fun touched_side_resolved<C>(
    market: &SegmentMarketV4<C>,
    from_idx: u64,
    to_idx: u64,
    upper_barrier: u64,
    lower_barrier: u64,
): u8 {
    let upper_with_deadband = add_deadband_up(upper_barrier, market.deadband_bps);
    let lower_with_deadband = sub_deadband_down(lower_barrier, market.deadband_bps);
    let mut k = from_idx;
    while (k < to_idx) {
        if (table::contains(&market.segments, k)) {
            let r = table::borrow(&market.segments, k);
            // Doc 25 §9: UPPER wins same-segment ties. Check upper first.
            if (r.max_price >= upper_with_deadband) return TOUCHED_SIDE_UPPER;
            if (r.min_price <= lower_with_deadband) return TOUCHED_SIDE_LOWER;
        };
        k = k + 1;
    };
    TOUCHED_SIDE_NONE
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

/// Returns whichever of (upper, lower) is closer to spot in raw price
/// distance. Used by the Bachelier cashout factor when the ride has not
/// touched — spread price against the nearer barrier (doc 25 §8).
fun nearer_barrier(spot: u64, upper: u64, lower: u64): u64 {
    let dist_up = if (upper > spot) upper - spot else 0;
    let dist_dn = if (spot > lower) spot - lower else 0;
    if (dist_up <= dist_dn) upper else lower
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

/// v4: decrement the single either-bucket trackers (no per-side split).
fun decrement_either_trackers<C>(
    market: &mut SegmentMarketV4<C>,
    ride: &SegmentRidePositionV4,
    ride_max_payout: u64,
) {
    market.either_aggregate_stake =
        saturating_sub(market.either_aggregate_stake, ride.escrowed);
    market.either_aggregate_max_payout =
        saturating_sub(market.either_aggregate_max_payout, ride_max_payout);
    if (market.either_rider_count > 0) {
        market.either_rider_count = market.either_rider_count - 1;
    };
}

fun saturating_sub(a: u64, b: u64): u64 {
    if (a > b) a - b else 0
}

// === v4.26 — rug-pull helpers (doc 26 §3.2) ===

/// Deterministic per-segment rug roll, plus the surrounding "should it
/// fire" gates. Returns `true` iff:
///   (a) rug is enabled (RugConfig dynamic field is attached),
///   (b) `rug_chance_bps > 0` (mechanism not disabled),
///   (c) no rug has fired this round yet, AND
///   (d) keccak256(segment_key || id_bytes || round_bytes) first-8-bytes
///       little-endian % 10_000 < `rug_chance_bps`.
///
/// `bcs::peel_u64` consumes 8 LE bytes — the exact extraction we want,
/// without a hand-rolled u64-from-bytes helper.
///
/// Folded into a single helper so the caller (`record_segment`) can run
/// all `&market` reads in one expression and Move can prove the
/// borrow sequence (read-then-mut) is sound. The hash domain mixes the
/// segment key (cranker-driven entropy not pre-knowable by the user),
/// the market id (so two markets don't share a rug sequence), and the
/// round index (so each round gets a fresh roll budget).
fun roll_rug<C>(market: &SegmentMarketV4<C>, segment_key: &vector<u8>): bool {
    if (!rug_enabled(market)) return false;
    let cfg = dynamic_field::borrow<vector<u8>, RugConfig>(
        &market.id, RUG_CONFIG_KEY,
    );
    if (cfg.rug_chance_bps == 0) return false;
    if (option::is_some(&cfg.rugged_at_segment)) return false;

    let mut buf = vector<u8>[];
    vector::append(&mut buf, *segment_key);
    vector::append(&mut buf, object::id_bytes(market));
    vector::append(&mut buf, bcs::to_bytes(&market.cached_round_index));

    let mut reader = bcs::new(hash::keccak256(&buf));
    let roll = bcs::peel_u64(&mut reader) % BPS_DENOMINATOR;
    roll < cfg.rug_chance_bps
}

// === Test-only helpers ===

#[test_only]
public fun test_only_destroy_market<C>(mut m: SegmentMarketV4<C>) {
    // v4.26 — if rug was enabled on this market, remove the dynamic-field
    // RugConfig BEFORE destructuring + deleting `id`. Sui aborts with
    // `EFieldsRemaining` if `object::delete(id)` runs while any dynamic
    // field is still attached. `RugConfig` has `drop`, so we just discard
    // the removed value.
    if (dynamic_field::exists_with_type<vector<u8>, RugConfig>(&m.id, RUG_CONFIG_KEY)) {
        let _cfg = dynamic_field::remove<vector<u8>, RugConfig>(
            &mut m.id, RUG_CONFIG_KEY,
        );
    };

    let SegmentMarketV4 {
        id, walk: _, next_segment_index: _, segments,
        active_ride_count: _,
        round_duration_segments: _,
        barrier_offset_bps: _, multiplier_bps: _, max_payout_per_round: _,
        cached_round_index: _, cached_round_started_at_segment: _,
        cached_upper_barrier: _, cached_lower_barrier: _,
        either_aggregate_stake: _, either_aggregate_max_payout: _,
        either_rider_count: _,
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
public fun test_only_destroy_ride(r: SegmentRidePositionV4) {
    let SegmentRidePositionV4 {
        id, user: _, market_id: _, round_index: _, entry_segment_index: _,
        upper_barrier_price: _, lower_barrier_price: _,
        multiplier_bps: _, stake_per_segment: _,
        escrowed: _, is_bot_eligible: _, opened_at_ms: _, closed: _,
        closed_at_ms: _, settlement_kind: _, collateral: _,
    } = r;
    object::delete(id);
}

#[test_only]
public fun test_only_record_segment<C>(
    market: &mut SegmentMarketV4<C>,
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
public fun test_only_bump_segment_index<C>(market: &mut SegmentMarketV4<C>, n: u64) {
    market.next_segment_index = market.next_segment_index + n;
}

#[test_only]
public fun test_only_force_round_current<C>(market: &mut SegmentMarketV4<C>) {
    ensure_round_current(market);
}

#[test_only]
public fun test_scan_for_either_touch<C>(
    market: &SegmentMarketV4<C>,
    from_idx: u64,
    to_idx: u64,
    upper_barrier: u64,
    lower_barrier: u64,
): bool {
    scan_for_either_touch(market, from_idx, to_idx, upper_barrier, lower_barrier)
}

#[test_only]
public fun test_touched_side_resolved<C>(
    market: &SegmentMarketV4<C>,
    from_idx: u64,
    to_idx: u64,
    upper_barrier: u64,
    lower_barrier: u64,
): u8 {
    touched_side_resolved(market, from_idx, to_idx, upper_barrier, lower_barrier)
}

#[test_only]
public fun test_add_deadband_up(barrier: u64, deadband_bps: u64): u64 {
    add_deadband_up(barrier, deadband_bps)
}

#[test_only]
public fun test_sub_deadband_down(barrier: u64, deadband_bps: u64): u64 {
    sub_deadband_down(barrier, deadband_bps)
}

#[test_only]
public fun test_only_set_cached_round_index<C>(market: &mut SegmentMarketV4<C>, r: u64) {
    market.cached_round_index = r;
}

#[test_only]
public fun test_only_insert_segment_at<C>(
    market: &mut SegmentMarketV4<C>,
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

#[test_only]
public fun test_only_unsettled_rides_raw<C>(market: &SegmentMarketV4<C>, round: u64): u64 {
    unsettled_rides_for_round(market, round)
}

#[test_only]
public fun test_nearer_barrier(spot: u64, upper: u64, lower: u64): u64 {
    nearer_barrier(spot, upper, lower)
}

// === v4.26 — rug-pull test-only helpers ===

/// Force-fire the rug for the current round at the given segment index,
/// bypassing the deterministic roll. Used by tests that want to drive
/// settlement without setting up a hash that happens to land in the
/// 1.5% band. Requires `enable_rug<C>` to have been called first.
#[test_only]
public fun test_only_set_rugged_at_segment<C>(
    market: &mut SegmentMarketV4<C>,
    seg: u64,
) {
    let cfg = dynamic_field::borrow_mut<vector<u8>, RugConfig>(
        &mut market.id, RUG_CONFIG_KEY,
    );
    cfg.rugged_at_segment = option::some(seg);
}

/// Clear the rugged flag without rolling the round. Useful for tests
/// that want to assert `ensure_round_current` cleared the flag without
/// staging segments. Requires `enable_rug<C>` to have been called first.
#[test_only]
public fun test_only_clear_rugged_at_segment<C>(market: &mut SegmentMarketV4<C>) {
    let cfg = dynamic_field::borrow_mut<vector<u8>, RugConfig>(
        &mut market.id, RUG_CONFIG_KEY,
    );
    cfg.rugged_at_segment = option::none<u64>();
}

/// Adjust `rug_chance_bps` after `enable_rug` has been called. Lets a
/// test exercise the `rug_chance_bps == 0` short-circuit branch of
/// `roll_rug` without re-enabling. Requires `enable_rug<C>` first.
#[test_only]
public fun test_only_set_rug_chance_bps<C>(
    market: &mut SegmentMarketV4<C>,
    bps: u64,
) {
    let cfg = dynamic_field::borrow_mut<vector<u8>, RugConfig>(
        &mut market.id, RUG_CONFIG_KEY,
    );
    cfg.rug_chance_bps = bps;
}

/// Test view into `roll_rug`. Requires `enable_rug<C>` first.
#[test_only]
public fun test_roll_rug<C>(market: &SegmentMarketV4<C>, key: vector<u8>): bool {
    roll_rug<C>(market, &key)
}
