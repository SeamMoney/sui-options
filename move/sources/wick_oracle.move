// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Per-market oracle registry. Holds the latest PriceObservation for an
/// underlying and (post-expiry) the settlement price. Stays driver-agnostic:
/// only the dispatching `record_tick_*` entrypoints know which driver to
/// invoke. Markets and PathObservation read this and don't care where the
/// data came from.
module wick::wick_oracle;

use std::string::String;
use sui::clock::Clock;
use wick::price_observation::{Self, PriceObservation};

const EWrongDriver: u64 = 0;
const EAlreadySettled: u64 = 1;
const ENotPastExpiry: u64 = 2;
const EStaleObservation: u64 = 3;
const ENoObservation: u64 = 4;
const ENoSettlementObservation: u64 = 5;

/// Driver kinds. New driver = new value here + new `record_tick_<kind>`
/// entrypoint. PathObservation consumes the resulting observations identically.
public fun driver_lazer(): u8 { 0 }
public fun driver_predict(): u8 { 1 }
public fun driver_random_walk(): u8 { 2 }

/// Per-market oracle. Shared, key-only. Anyone can call the driver-matching
/// `record_tick_*` to push a new observation. Settlement is locked in once
/// `expiry_ms` has passed and a fresh enough observation has been recorded.
public struct WickOracle has key {
    id: UID,
    underlying: String,
    driver_kind: u8,
    /// bcs-encoded driver config — interpreted only by the matching driver
    /// (e.g. lazer feed_id u32, predict market_oracle_id ID, random_walk seed).
    driver_config: vector<u8>,
    latest: Option<PriceObservation>,
    /// v2 hardened: latched the FIRST time `apply_observation` sees an
    /// observation with timestamp_ms >= expiry_ms. Once latched it never
    /// changes. `lock_settlement_from_latest` consumes this, not `latest` —
    /// kills the stale-Lazer settlement game (redteam attack #3).
    settlement_observation: Option<PriceObservation>,
    settlement_price: Option<u64>,
    expiry_ms: u64,
    /// Max staleness allowed when calling `lock_settlement_from_latest`.
    settlement_freshness_ms: u64,
}

public struct OracleCreated has copy, drop {
    oracle_id: ID,
    underlying: String,
    driver_kind: u8,
    expiry_ms: u64,
}

public struct ObservationRecorded has copy, drop {
    oracle_id: ID,
    price: u64,
    timestamp_ms: u64,
}

public struct OracleSettled has copy, drop {
    oracle_id: ID,
    settlement_price: u64,
    settled_at_ms: u64,
}

/// Permissionless creator. Anyone can spin up a market on any underlying with
/// any driver. Caller passes the bcs-encoded driver config; the matching
/// driver's `record_tick_*` will deserialize it.
public fun new(
    underlying: String,
    driver_kind: u8,
    driver_config: vector<u8>,
    expiry_ms: u64,
    settlement_freshness_ms: u64,
    ctx: &mut TxContext,
): WickOracle {
    let oracle = WickOracle {
        id: object::new(ctx),
        underlying,
        driver_kind,
        driver_config,
        latest: option::none(),
        settlement_observation: option::none(),
        settlement_price: option::none(),
        expiry_ms,
        settlement_freshness_ms,
    };
    sui::event::emit(OracleCreated {
        oracle_id: object::id(&oracle),
        underlying: oracle.underlying,
        driver_kind,
        expiry_ms,
    });
    oracle
}

public fun share(oracle: WickOracle) {
    transfer::share_object(oracle);
}

/// Driver-side helper — apply an observation produced by a driver. Asserts
/// kind match so a Lazer driver can't write into a Predict-backed oracle.
///
/// v2 hardened: if `obs.timestamp_ms >= expiry_ms` and `settlement_observation`
/// is still `None`, latches `obs` into `settlement_observation` atomically with
/// writing `latest`. Subsequent post-expiry observations may continue to update
/// `latest` (telemetry) but never overwrite the latched settlement obs.
public(package) fun apply_observation(
    oracle: &mut WickOracle,
    expected_kind: u8,
    obs: PriceObservation,
) {
    assert!(oracle.driver_kind == expected_kind, EWrongDriver);
    assert!(option::is_none(&oracle.settlement_price), EAlreadySettled);

    let obs_ts = price_observation::timestamp_ms(&obs);
    if (obs_ts >= oracle.expiry_ms && option::is_none(&oracle.settlement_observation)) {
        oracle.settlement_observation = option::some(obs);
    };
    oracle.latest = option::some(obs);
    sui::event::emit(ObservationRecorded {
        oracle_id: object::id(oracle),
        price: price_observation::price(&obs),
        timestamp_ms: obs_ts,
    });
}

/// Lock settlement using the FIRST post-expiry observation we ever saw
/// (latched in `settlement_observation`). v2 hardened: a slow cranker cannot
/// burn through the freshness window after latching.
/// Permissionless — anyone can crank.
public fun lock_settlement_from_latest(oracle: &mut WickOracle, clock: &Clock) {
    assert!(option::is_none(&oracle.settlement_price), EAlreadySettled);
    let now = clock.timestamp_ms();
    assert!(now >= oracle.expiry_ms, ENotPastExpiry);
    assert!(option::is_some(&oracle.settlement_observation), ENoSettlementObservation);
    let obs = option::borrow(&oracle.settlement_observation);
    let obs_ts = price_observation::timestamp_ms(obs);
    assert!(now - obs_ts <= oracle.settlement_freshness_ms, EStaleObservation);
    let settle = price_observation::price(obs);
    oracle.settlement_price = option::some(settle);
    sui::event::emit(OracleSettled {
        oracle_id: object::id(oracle),
        settlement_price: settle,
        settled_at_ms: now,
    });
}

// === Reads ===

public fun latest(oracle: &WickOracle): &Option<PriceObservation> { &oracle.latest }

public fun settlement_observation(oracle: &WickOracle): &Option<PriceObservation> {
    &oracle.settlement_observation
}

public fun latest_price(oracle: &WickOracle): u64 {
    assert!(option::is_some(&oracle.latest), ENoObservation);
    price_observation::price(option::borrow(&oracle.latest))
}

public fun settlement_price(oracle: &WickOracle): &Option<u64> { &oracle.settlement_price }

public fun is_settled(oracle: &WickOracle): bool { option::is_some(&oracle.settlement_price) }

public fun underlying(oracle: &WickOracle): &String { &oracle.underlying }

public fun driver_kind(oracle: &WickOracle): u8 { oracle.driver_kind }

public fun driver_config(oracle: &WickOracle): &vector<u8> { &oracle.driver_config }

public fun expiry_ms(oracle: &WickOracle): u64 { oracle.expiry_ms }

// === Test-only ===

#[test_only]
public fun new_for_testing(
    underlying: String,
    driver_kind: u8,
    driver_config: vector<u8>,
    expiry_ms: u64,
    ctx: &mut TxContext,
): WickOracle {
    new(underlying, driver_kind, driver_config, expiry_ms, 60_000, ctx)
}

#[test_only]
public fun apply_observation_for_testing(
    oracle: &mut WickOracle,
    expected_kind: u8,
    obs: PriceObservation,
) {
    apply_observation(oracle, expected_kind, obs);
}
