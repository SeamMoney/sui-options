// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// PathObservation v2 (hardened) — turns a stream of oracle ticks into a
/// binary "did the price wick past the barrier" outcome.
///
/// v2 changes vs v1 (per docs/design/v2/05_path_observation_v2_hardened.md):
///   - N-consecutive-tick confirmations (default 3): `touched_at` only sticks
///     after `touch_confirmations_required` in-window observations have all
///     crossed the barrier. Single bad tick can no longer lock the outcome.
///     [redteam attack #4]
///   - `settlement_snapshot`: the (max, min, touched_at, count) tuple is
///     frozen the first time `lock_settlement_snapshot` is called. `redeem`
///     reads the snapshot, never live state — kills post-lock racing.
///     [redteam attacks #3, #7, #13]
///   - `Aborted` settlement state: if `observation_count < min_observations`
///     by `expiry_ms + grace_ms`, the path resolves Aborted (refund both
///     sides) instead of silently collapsing to "no-touch wins."
///     [redteam attack #14]
///   - Post-expiry freeze: `record` becomes a pure no-op once
///     `clock.now() >= expiry_ms`. Late ticks cannot bump max_seen / counter
///     / touch state.
///   - `buffer_bps`: trigger price is barrier ± (buffer in bps), kept around
///     for backwards-compat with the v1 design — defaults to 0.
///
/// Deferred to follow-on tasks (not in this module yet):
///   - Ring buffer + `record_range` consuming oracle-resident observations
///     by reference — Phase A.5.
///   - Lazer verifier driver, multisig keeper wrapper — task #78.
///   - `sui::random` PRNG swap in random_walk_driver — separate module.
module wick::path_observation;

use sui::clock::Clock;
use wick::price_observation;
use wick::wick_oracle::{Self, WickOracle};

// === Errors ===
const EOracleMismatch: u64 = 0;
const ENoObservation: u64 = 1;
const ENotYetExpired: u64 = 2;       // RENAMED from EAlreadyExpired (v1 footgun)
const EInvalidDirection: u64 = 4;
const EInvalidConfig: u64 = 5;
const ENotReadyToSettle: u64 = 6;
const ESnapshotAlreadyLocked: u64 = 8;
const ENotInDrainWindow: u64 = 11;   // record_during_drain called outside drain
const EDrainWindowOpen: u64 = 12;    // lock_settlement_snapshot called before drain closed

// === Constants ===
const DEFAULT_BUFFER_BPS: u64 = 0;
const DEFAULT_MIN_OBSERVATIONS: u64 = 6;
const DEFAULT_TOUCH_CONFIRMATIONS: u64 = 3;
const DEFAULT_GRACE_MS: u64 = 60_000;  // 1 minute past expiry → Aborted
/// Window AFTER expiry during which mempool-delayed pre-expiry-stamped
/// ticks may still be applied. lock_settlement_snapshot is gated on
/// `now >= expiry_ms + pre_lock_drain_ms`. THIS is what closes the
/// settlement-bot race documented in the C.3 design — without it, atomic
/// lock_and_settle is cosmetic.
const DEFAULT_PRE_LOCK_DRAIN_MS: u64 = 5_000;  // 5 seconds default
const MAX_BUFFER_BPS: u64 = 1_000;     // 10%
const BPS_DENOM: u128 = 10_000;

// === Settlement state values ===
const SETTLEMENT_NOT_READY: u8 = 0;
const SETTLEMENT_RESOLVED: u8 = 1;
const SETTLEMENT_ABORTED: u8 = 2;

public fun settlement_not_ready(): u8 { SETTLEMENT_NOT_READY }
public fun settlement_resolved(): u8 { SETTLEMENT_RESOLVED }
public fun settlement_aborted(): u8 { SETTLEMENT_ABORTED }

/// Side of the barrier the buyer is watching for.
public fun touch_above(): u8 { 0 }
public fun touch_below(): u8 { 1 }

public struct PathObservation has key {
    id: UID,
    oracle_id: ID,
    barrier: u64,
    direction: u8,
    expiry_ms: u64,
    /// After `expiry_ms + grace_ms` with too few observations, settlement
    /// transitions to Aborted (refund both sides).
    grace_ms: u64,
    /// 0..=MAX_BUFFER_BPS. Trigger price is barrier shifted outward by this
    /// many bps (defends against single-tick noise just brushing the level).
    buffer_bps: u64,
    /// Minimum observations required to count a no-touch outcome as Resolved.
    /// Below this, settlement Aborts after the grace window.
    min_observations: u64,
    /// How many in-window observations have been recorded so far.
    observation_count: u64,
    /// Consecutive in-row crossings of the buffered trigger. Resets to 0 on
    /// any non-crossing tick. `touched_at` only fires when this reaches
    /// `touch_confirmations_required`.
    consecutive_cross_count: u64,
    /// How many in-a-row crossings are required. Default 3.
    touch_confirmations_required: u64,
    max_seen: u64,
    min_seen: u64,
    last_seen_ms: Option<u64>,
    /// Set the first time the buffered trigger is crossed N times in a row.
    touched_at: Option<u64>,
    /// Frozen settlement view. Once Some, `redeem` reads from here exclusively.
    settlement_snapshot: Option<PathSnapshot>,
    /// Drain window after expiry. lock_settlement_snapshot is gated on
    /// `now >= expiry_ms + pre_lock_drain_ms`. record_during_drain accepts
    /// pre-expiry-stamped ticks during this window. Closes the bot race.
    pre_lock_drain_ms: u64,
}

public struct PathSnapshot has copy, drop, store {
    state: u8,                  // SETTLEMENT_RESOLVED or SETTLEMENT_ABORTED
    max_seen: u64,
    min_seen: u64,
    touched_at: Option<u64>,
    observation_count: u64,
    locked_at_ms: u64,
}

public struct PathCreated has copy, drop {
    path_id: ID,
    oracle_id: ID,
    barrier: u64,
    direction: u8,
    expiry_ms: u64,
}

public struct TickRecorded has copy, drop {
    path_id: ID,
    price: u64,
    timestamp_ms: u64,
    new_min: u64,
    new_max: u64,
    consecutive: u64,
}

public struct BarrierTouched has copy, drop {
    path_id: ID,
    touched_at_ms: u64,
    touch_price: u64,
    confirmations: u64,
}

public struct PathSettlementLocked has copy, drop {
    path_id: ID,
    state: u8,
    touched: bool,
}

// === Constructors ===

/// Full v2 constructor with explicit hardening parameters.
public fun new_v2(
    oracle: &WickOracle,
    barrier: u64,
    direction: u8,
    buffer_bps: u64,
    min_observations: u64,
    touch_confirmations_required: u64,
    grace_ms: u64,
    ctx: &mut TxContext,
): PathObservation {
    new_v3(
        oracle, barrier, direction, buffer_bps, min_observations,
        touch_confirmations_required, grace_ms, DEFAULT_PRE_LOCK_DRAIN_MS, ctx,
    )
}

/// v3 constructor with explicit pre_lock_drain_ms. Use this when you need
/// to override the default 5s drain (e.g., low-latency markets at 1s).
public fun new_v3(
    oracle: &WickOracle,
    barrier: u64,
    direction: u8,
    buffer_bps: u64,
    min_observations: u64,
    touch_confirmations_required: u64,
    grace_ms: u64,
    pre_lock_drain_ms: u64,
    ctx: &mut TxContext,
): PathObservation {
    assert!(barrier > 0, EInvalidConfig);
    assert!(direction == touch_above() || direction == touch_below(), EInvalidDirection);
    assert!(buffer_bps <= MAX_BUFFER_BPS, EInvalidConfig);
    assert!(min_observations > 0, EInvalidConfig);
    assert!(touch_confirmations_required >= 1, EInvalidConfig);

    let po = PathObservation {
        id: object::new(ctx),
        oracle_id: object::id(oracle),
        barrier,
        direction,
        expiry_ms: wick_oracle::expiry_ms(oracle),
        grace_ms,
        buffer_bps,
        min_observations,
        observation_count: 0,
        consecutive_cross_count: 0,
        touch_confirmations_required,
        max_seen: 0,
        min_seen: 18_446_744_073_709_551_615,
        last_seen_ms: option::none(),
        touched_at: option::none(),
        settlement_snapshot: option::none(),
        pre_lock_drain_ms,
    };
    sui::event::emit(PathCreated {
        path_id: object::id(&po),
        oracle_id: po.oracle_id,
        barrier,
        direction,
        expiry_ms: po.expiry_ms,
    });
    po
}

/// Backwards-compat wrapper using v2 hardening defaults
/// (3-confirmations, min_obs=6, 1-min grace, no buffer, 5s drain).
public fun new(
    oracle: &WickOracle,
    barrier: u64,
    direction: u8,
    ctx: &mut TxContext,
): PathObservation {
    new_v3(
        oracle,
        barrier,
        direction,
        DEFAULT_BUFFER_BPS,
        DEFAULT_MIN_OBSERVATIONS,
        DEFAULT_TOUCH_CONFIRMATIONS,
        DEFAULT_GRACE_MS,
        DEFAULT_PRE_LOCK_DRAIN_MS,
        ctx,
    )
}

public fun share(po: PathObservation) {
    transfer::share_object(po);
}

// === Recording ===

/// Record the latest oracle observation. Idempotent for stale observations.
/// Anyone can call.
///
/// v2 invariants enforced here:
///   - Post-expiry: pure no-op (housekeeping return). Cannot bump any state.
///   - Stale: returns early if obs_ts <= last_seen_ms.
///   - Touch: only sticks after `touch_confirmations_required` consecutive
///     buffered-trigger crossings. Counter resets on any non-cross.
public fun record(po: &mut PathObservation, oracle: &WickOracle, clock: &Clock) {
    assert!(po.oracle_id == object::id(oracle), EOracleMismatch);

    let now = clock.timestamp_ms();
    if (now >= po.expiry_ms) return;  // post-expiry freeze

    let latest_opt = wick_oracle::latest(oracle);
    assert!(option::is_some(latest_opt), ENoObservation);
    let obs = option::borrow(latest_opt);
    let obs_ts = price_observation::timestamp_ms(obs);
    let obs_price = price_observation::price(obs);

    // Stale-tick guard.
    if (option::is_some(&po.last_seen_ms)) {
        let last = *option::borrow(&po.last_seen_ms);
        if (obs_ts <= last) return;
    };
    // Out-of-window observation (driver pushed a future ts past expiry).
    if (obs_ts > po.expiry_ms) return;

    // Update extremes + counter + last_seen.
    if (obs_price > po.max_seen) po.max_seen = obs_price;
    if (obs_price < po.min_seen) po.min_seen = obs_price;
    po.observation_count = po.observation_count + 1;
    po.last_seen_ms = option::some(obs_ts);

    // N-consecutive-confirmation touch logic.
    if (is_buffered_touch(po, obs_price)) {
        po.consecutive_cross_count = po.consecutive_cross_count + 1;
        if (po.consecutive_cross_count >= po.touch_confirmations_required
            && option::is_none(&po.touched_at)) {
            po.touched_at = option::some(obs_ts);
            sui::event::emit(BarrierTouched {
                path_id: object::id(po),
                touched_at_ms: obs_ts,
                touch_price: obs_price,
                confirmations: po.consecutive_cross_count,
            });
        };
    } else {
        // A touch has to be a real, sustained crossing. Any non-crossing tick
        // resets the run.
        po.consecutive_cross_count = 0;
    };

    sui::event::emit(TickRecorded {
        path_id: object::id(po),
        price: obs_price,
        timestamp_ms: obs_ts,
        new_min: po.min_seen,
        new_max: po.max_seen,
        consecutive: po.consecutive_cross_count,
    });
}

/// Record an oracle tick DURING the drain window [expiry_ms, expiry_ms +
/// pre_lock_drain_ms). ONLY accepts ticks whose `obs.timestamp_ms < expiry_ms`
/// — i.e. mempool-delayed pre-expiry observations that didn't make it into a
/// pre-expiry block. This is the primitive that lets in-flight confirmation
/// ticks land before snapshot lock, closing the bot-race fairness hole.
///
/// Post-expiry-stamped ticks are silently rejected (return early). The drain
/// window is for the CHAIN, not the price feed.
public fun record_during_drain(po: &mut PathObservation, oracle: &WickOracle, clock: &Clock) {
    assert!(po.oracle_id == object::id(oracle), EOracleMismatch);
    let now = clock.timestamp_ms();
    // Must be in the drain window: at-or-past expiry but before drain closes.
    assert!(now >= po.expiry_ms, ENotInDrainWindow);
    assert!(now < po.expiry_ms + po.pre_lock_drain_ms, ENotInDrainWindow);

    let latest_opt = wick_oracle::latest(oracle);
    assert!(option::is_some(latest_opt), ENoObservation);
    let obs = option::borrow(latest_opt);
    let obs_ts = price_observation::timestamp_ms(obs);
    let obs_price = price_observation::price(obs);

    // Critical: only PRE-expiry-stamped ticks count. Post-expiry obs would
    // let a single late price print decide a touch outcome — not what
    // confirmation logic protects against.
    if (obs_ts >= po.expiry_ms) return;

    // Stale-tick guard.
    if (option::is_some(&po.last_seen_ms)) {
        let last = *option::borrow(&po.last_seen_ms);
        if (obs_ts <= last) return;
    };

    // Same body as record() from this point on — apply the tick to extremes,
    // counter, and N-confirmation touch logic.
    if (obs_price > po.max_seen) po.max_seen = obs_price;
    if (obs_price < po.min_seen) po.min_seen = obs_price;
    po.observation_count = po.observation_count + 1;
    po.last_seen_ms = option::some(obs_ts);

    if (is_buffered_touch(po, obs_price)) {
        po.consecutive_cross_count = po.consecutive_cross_count + 1;
        if (po.consecutive_cross_count >= po.touch_confirmations_required
            && option::is_none(&po.touched_at)) {
            po.touched_at = option::some(obs_ts);
            sui::event::emit(BarrierTouched {
                path_id: object::id(po),
                touched_at_ms: obs_ts,
                touch_price: obs_price,
                confirmations: po.consecutive_cross_count,
            });
        };
    } else {
        po.consecutive_cross_count = 0;
    };

    sui::event::emit(TickRecorded {
        path_id: object::id(po),
        price: obs_price,
        timestamp_ms: obs_ts,
        new_min: po.min_seen,
        new_max: po.max_seen,
        consecutive: po.consecutive_cross_count,
    });
}

/// Whether `price` crosses the buffered trigger for this path's direction.
fun is_buffered_touch(po: &PathObservation, price: u64): bool {
    if (po.direction == touch_above()) {
        let trigger = if (po.buffer_bps == 0) po.barrier
            else add_bps_clamped(po.barrier, po.buffer_bps);
        price >= trigger
    } else {
        let trigger = if (po.buffer_bps == 0) po.barrier
            else sub_bps_floored(po.barrier, po.buffer_bps);
        price <= trigger
    }
}

fun add_bps_clamped(p: u64, bps: u64): u64 {
    let scaled = (p as u128) + (p as u128) * (bps as u128) / BPS_DENOM;
    if (scaled > 18_446_744_073_709_551_615u128) 18_446_744_073_709_551_615u64 else scaled as u64
}

fun sub_bps_floored(p: u64, bps: u64): u64 {
    let delta = (p as u128) * (bps as u128) / BPS_DENOM;
    if (delta >= (p as u128)) 0 else ((p as u128) - delta) as u64
}

// === Settlement state + snapshot lock ===

/// Compute the settlement state from live fields. This is the live read used
/// before snapshot is locked. `lock_settlement_snapshot` consumes the value of
/// this once and freezes it.
fun compute_settlement_state(po: &PathObservation, clock: &Clock): u8 {
    let now = clock.timestamp_ms();
    if (now < po.expiry_ms) return SETTLEMENT_NOT_READY;
    if (option::is_some(&po.touched_at)) return SETTLEMENT_RESOLVED;
    if (po.observation_count >= po.min_observations) return SETTLEMENT_RESOLVED;
    if (now >= po.expiry_ms + po.grace_ms) return SETTLEMENT_ABORTED;
    SETTLEMENT_NOT_READY
}

/// Read settlement state. Once snapshot is locked, returns the snapshot's
/// frozen state. Otherwise computes from live fields.
public fun settlement_state(po: &PathObservation, clock: &Clock): u8 {
    if (option::is_some(&po.settlement_snapshot)) {
        let s = option::borrow(&po.settlement_snapshot);
        return s.state
    };
    compute_settlement_state(po, clock)
}

/// Permissionless one-shot lock. After this, all settlement reads come from
/// the snapshot — kills post-lock racing on max_seen / touched_at / count.
///
/// FAIRNESS GATE: requires `now >= expiry_ms + pre_lock_drain_ms`. This is
/// the load-bearing change vs v2 — without it, a losing-side bot could lock
/// the snapshot the millisecond past expiry, freezing out any in-flight
/// pre-expiry confirmation tick. The drain window gives mempool-delayed
/// pre-expiry-stamped ticks a chance to land via `record_during_drain`.
public fun lock_settlement_snapshot(po: &mut PathObservation, clock: &Clock) {
    assert!(option::is_none(&po.settlement_snapshot), ESnapshotAlreadyLocked);
    let now = clock.timestamp_ms();
    assert!(now >= po.expiry_ms + po.pre_lock_drain_ms, EDrainWindowOpen);
    let state = compute_settlement_state(po, clock);
    assert!(state != SETTLEMENT_NOT_READY, ENotReadyToSettle);
    po.settlement_snapshot = option::some(PathSnapshot {
        state,
        max_seen: po.max_seen,
        min_seen: po.min_seen,
        touched_at: po.touched_at,
        observation_count: po.observation_count,
        locked_at_ms: now,
    });
    sui::event::emit(PathSettlementLocked {
        path_id: object::id(po),
        state,
        touched: option::is_some(&po.touched_at),
    });
}

// === Reads ===

public fun oracle_id(po: &PathObservation): ID { po.oracle_id }
public fun barrier(po: &PathObservation): u64 { po.barrier }
public fun direction(po: &PathObservation): u8 { po.direction }
public fun expiry_ms(po: &PathObservation): u64 { po.expiry_ms }
public fun grace_ms(po: &PathObservation): u64 { po.grace_ms }
public fun pre_lock_drain_ms(po: &PathObservation): u64 { po.pre_lock_drain_ms }
public fun default_pre_lock_drain_ms(): u64 { DEFAULT_PRE_LOCK_DRAIN_MS }
public fun buffer_bps(po: &PathObservation): u64 { po.buffer_bps }
public fun min_observations(po: &PathObservation): u64 { po.min_observations }
public fun observation_count(po: &PathObservation): u64 { po.observation_count }
public fun consecutive_cross_count(po: &PathObservation): u64 { po.consecutive_cross_count }
public fun touch_confirmations_required(po: &PathObservation): u64 { po.touch_confirmations_required }
public fun max_seen(po: &PathObservation): u64 { po.max_seen }
public fun min_seen(po: &PathObservation): u64 { po.min_seen }
public fun last_seen_ms(po: &PathObservation): &Option<u64> { &po.last_seen_ms }
public fun touched_at(po: &PathObservation): &Option<u64> { &po.touched_at }
public fun is_touched(po: &PathObservation): bool { option::is_some(&po.touched_at) }

/// True iff the barrier was touched at a timestamp inside [start_ms, end_ms].
/// Load-bearing for `wick::ride_position::close_ride` — establishes the
/// "touch wins ties" race-resolution rule from design doc 11 §5.
public fun touched_during(po: &PathObservation, start_ms: u64, end_ms: u64): bool {
    if (option::is_none(&po.touched_at)) return false;
    let t = *option::borrow(&po.touched_at);
    t >= start_ms && t <= end_ms
}
public fun settlement_snapshot(po: &PathObservation): &Option<PathSnapshot> {
    &po.settlement_snapshot
}
public fun snapshot_state(s: &PathSnapshot): u8 { s.state }
public fun snapshot_max_seen(s: &PathSnapshot): u64 { s.max_seen }
public fun snapshot_min_seen(s: &PathSnapshot): u64 { s.min_seen }
public fun snapshot_touched_at(s: &PathSnapshot): &Option<u64> { &s.touched_at }
public fun snapshot_observation_count(s: &PathSnapshot): u64 { s.observation_count }
public fun snapshot_locked_at_ms(s: &PathSnapshot): u64 { s.locked_at_ms }
public fun snapshot_is_touched(s: &PathSnapshot): bool {
    option::is_some(&s.touched_at)
}

/// Final touch outcome — only valid once settlement is Resolved (NOT Aborted).
/// Reads from snapshot if locked, otherwise from live state. Aborts if not
/// past expiry or if state is Aborted (caller should branch on
/// `settlement_state` before calling).
public fun touch_outcome(po: &PathObservation, clock: &Clock): bool {
    let state = settlement_state(po, clock);
    assert!(state == SETTLEMENT_RESOLVED, ENotYetExpired);
    if (option::is_some(&po.settlement_snapshot)) {
        let s = option::borrow(&po.settlement_snapshot);
        option::is_some(&s.touched_at)
    } else {
        option::is_some(&po.touched_at)
    }
}
