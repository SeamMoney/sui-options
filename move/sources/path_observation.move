// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// The Wick primitive that adds path-dependence to any oracle. DeepBook
/// Predict (and most binary-options primitives) only know about terminal
/// settlement price. Wick options are *touch* options: did the price wick
/// past the barrier *during* the window. PathObservation records min/max and
/// touch state for a (WickOracle, barrier) pair.
///
/// Anyone can call `record(po, oracle, clock)` on any tick. The barrier
/// crossing is detected by comparing the new observation against the barrier
/// — touch-above triggers when an observation lands at-or-above the barrier;
/// touch-below triggers when it lands at-or-below. Once `touched_at` is
/// `Some`, it never reverts.
module wick::path_observation;

use sui::clock::Clock;
use wick::price_observation;
use wick::wick_oracle::{Self, WickOracle};

const EOracleMismatch: u64 = 0;
const ENoObservation: u64 = 1;
const EAlreadyExpired: u64 = 2;

/// Side of the barrier the buyer is watching for.
public fun touch_above(): u8 { 0 }
public fun touch_below(): u8 { 1 }

public struct PathObservation has key {
    id: UID,
    /// The WickOracle this path is attached to. Must match on every record().
    oracle_id: ID,
    /// Barrier in 1e9-scaled price.
    barrier: u64,
    /// 0 = touch-above (any obs >= barrier triggers); 1 = touch-below.
    direction: u8,
    /// Window end. After this, record() rejects new ticks.
    expiry_ms: u64,
    /// Highest observation seen during the window.
    max_seen: u64,
    /// Lowest observation seen during the window.
    min_seen: u64,
    /// Latest observation timestamp consumed. None until the first record().
    last_seen_ms: Option<u64>,
    /// Set the first time the barrier is crossed. Sticky — never reverts.
    touched_at: Option<u64>,
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
}

public struct BarrierTouched has copy, drop {
    path_id: ID,
    touched_at_ms: u64,
    touch_price: u64,
}

/// Permissionless creator. Pair this with a WickOracle and a barrier; the
/// keeper (or anyone) calls `record` after every oracle tick to advance state.
public fun new(
    oracle: &WickOracle,
    barrier: u64,
    direction: u8,
    ctx: &mut TxContext,
): PathObservation {
    let po = PathObservation {
        id: object::new(ctx),
        oracle_id: object::id(oracle),
        barrier,
        direction,
        expiry_ms: wick_oracle::expiry_ms(oracle),
        // Start min at u64::MAX so the first observation always lowers it.
        max_seen: 0,
        min_seen: 18446744073709551615,
        last_seen_ms: option::none(),
        touched_at: option::none(),
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

public fun share(po: PathObservation) {
    transfer::share_object(po);
}

/// Record the latest observation from the linked WickOracle. Idempotent for
/// stale observations (no-op when the oracle's latest timestamp hasn't
/// advanced since the last call). Anyone can call.
public fun record(po: &mut PathObservation, oracle: &WickOracle, clock: &Clock) {
    assert!(po.oracle_id == object::id(oracle), EOracleMismatch);

    let latest = wick_oracle::latest(oracle);
    assert!(option::is_some(latest), ENoObservation);
    let obs = option::borrow(latest);
    let obs_ts = price_observation::timestamp_ms(obs);
    let obs_price = price_observation::price(obs);

    // No-op if no new data since last record.
    if (option::is_some(&po.last_seen_ms)) {
        let last = *option::borrow(&po.last_seen_ms);
        if (obs_ts <= last) return;
    };

    let now = clock.timestamp_ms();
    // After expiry, clamp the timestamp to expiry — settlement uses the
    // snapshot taken at-or-before expiry, but we still accept post-expiry
    // observations to drive `lock_settlement_from_latest` from the same data.
    let effective_ts = if (obs_ts > po.expiry_ms) po.expiry_ms else obs_ts;

    if (obs_price > po.max_seen) po.max_seen = obs_price;
    if (obs_price < po.min_seen) po.min_seen = obs_price;
    po.last_seen_ms = option::some(effective_ts);

    let crossed = if (po.direction == touch_above()) obs_price >= po.barrier
                  else obs_price <= po.barrier;
    if (crossed && option::is_none(&po.touched_at)) {
        po.touched_at = option::some(effective_ts);
        sui::event::emit(BarrierTouched {
            path_id: object::id(po),
            touched_at_ms: effective_ts,
            touch_price: obs_price,
        });
    };

    // Cap last_seen at expiry once we've consumed a post-expiry observation.
    let _ = now;

    sui::event::emit(TickRecorded {
        path_id: object::id(po),
        price: obs_price,
        timestamp_ms: effective_ts,
        new_min: po.min_seen,
        new_max: po.max_seen,
    });
}

// === Reads ===

public fun oracle_id(po: &PathObservation): ID { po.oracle_id }

public fun barrier(po: &PathObservation): u64 { po.barrier }

public fun direction(po: &PathObservation): u8 { po.direction }

public fun expiry_ms(po: &PathObservation): u64 { po.expiry_ms }

public fun max_seen(po: &PathObservation): u64 { po.max_seen }

public fun min_seen(po: &PathObservation): u64 { po.min_seen }

public fun last_seen_ms(po: &PathObservation): &Option<u64> { &po.last_seen_ms }

public fun touched_at(po: &PathObservation): &Option<u64> { &po.touched_at }

public fun is_touched(po: &PathObservation): bool { option::is_some(&po.touched_at) }

/// Final outcome — only valid after expiry. Keeper or settlement caller is
/// responsible for ensuring all ticks up to expiry have been recorded before
/// reading this.
public fun touch_outcome(po: &PathObservation, clock: &Clock): bool {
    assert!(clock.timestamp_ms() >= po.expiry_ms, EAlreadyExpired);
    option::is_some(&po.touched_at)
}
