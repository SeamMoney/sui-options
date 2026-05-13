// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Driver: synthetic on-chain random-walk price source for Wick's arcade
/// markets. No external feed — deterministic PRNG seeded by `(seed,
/// clock_ms, fresh_object_address)` advances a price step. Gives us 24/7
/// markets with no Pyth dependency at all.
///
/// Step model: log-normal-ish multiplicative walk with a per-tick std-dev
/// in basis points (`vol_bps`). Each call to `tick`:
///   1. Mixes a 256-bit hash from (seed counter, clock_ms, fresh address).
///   2. Maps the high 64 bits to a signed step in `[-vol_bps, +vol_bps]`.
///   3. Applies `price * (10_000 + step) / 10_000`, floored at 1.
///   4. Increments the seed counter so two ticks in the same ms still differ.
module wick::random_walk_driver;

use std::hash;
use std::string::String;
use sui::address;
use sui::bcs;
use sui::clock::Clock;
use wick::price_observation;
use wick::wick_oracle::{Self, WickOracle};

const ENotRandomWalkDriver: u64 = 0;
const EConfigOracleMismatch: u64 = 1;

/// Shared state that the driver advances. One per arcade market.
public struct RandomWalk has key {
    id: UID,
    /// The WickOracle this drives. Driver config on the oracle stores this
    /// `RandomWalk`'s ID so callers can wire them up trustlessly.
    oracle_id: ID,
    current_price: u64,
    last_tick_ms: u64,
    /// Per-tick max move in basis points (10_000 = 100%). 100 = 1% per tick.
    vol_bps: u64,
    /// Counter, mixed into the PRNG so two ticks at the same clock_ms differ.
    nonce: u64,
}

public struct RandomWalkCreated has copy, drop {
    random_walk_id: ID,
    oracle_id: ID,
    starting_price: u64,
    vol_bps: u64,
}

public struct Ticked has copy, drop {
    random_walk_id: ID,
    new_price: u64,
    timestamp_ms: u64,
    nonce: u64,
}

/// Build the WickOracle and the RandomWalk paired together. Wire-up is
/// trustless: WickOracle.driver_config = bcs(RandomWalk.id), and `tick`
/// asserts the link both ways.
public fun create_market(
    underlying: String,
    starting_price: u64,
    vol_bps: u64,
    expiry_ms: u64,
    settlement_freshness_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): (WickOracle, RandomWalk) {
    let rw_uid = object::new(ctx);
    let rw_id = rw_uid.to_inner();
    let driver_config = bcs::to_bytes(&rw_id);
    let mut oracle = wick_oracle::new(
        underlying,
        wick_oracle::driver_random_walk(),
        driver_config,
        expiry_ms,
        settlement_freshness_ms,
        ctx,
    );
    let oracle_id = object::id(&oracle);
    let rw = RandomWalk {
        id: rw_uid,
        oracle_id,
        current_price: starting_price,
        last_tick_ms: clock.timestamp_ms(),
        vol_bps,
        nonce: 0,
    };
    sui::event::emit(RandomWalkCreated {
        random_walk_id: rw_id,
        oracle_id,
        starting_price,
        vol_bps,
    });

    // Seed with the initial price so consumers don't see an empty oracle.
    let seed_obs = price_observation::new(starting_price, clock.timestamp_ms(), oracle_id);
    wick_oracle::apply_observation(
        &mut oracle,
        wick_oracle::driver_random_walk(),
        seed_obs,
    );

    (oracle, rw)
}

public fun share(rw: RandomWalk) {
    transfer::share_object(rw);
}

/// Advance the price one step and write the observation into the oracle.
/// Permissionless — anyone (the keeper, or any user) can call.
public fun tick(rw: &mut RandomWalk, oracle: &mut WickOracle, clock: &Clock, ctx: &mut TxContext) {
    assert!(wick_oracle::driver_kind(oracle) == wick_oracle::driver_random_walk(), ENotRandomWalkDriver);
    assert!(rw.oracle_id == object::id(oracle), EConfigOracleMismatch);

    let now = clock.timestamp_ms();
    rw.nonce = rw.nonce + 1;

    // Mix entropy: nonce + clock + a fresh address (anchors to tx digest).
    let mut bytes: vector<u8> = vector[];
    vector::append(&mut bytes, bcs::to_bytes(&rw.nonce));
    vector::append(&mut bytes, bcs::to_bytes(&now));
    vector::append(&mut bytes, address::to_bytes(tx_context::fresh_object_address(ctx)));
    let digest = hash::sha2_256(bytes);

    // Take first 8 bytes as u64 entropy.
    let mut entropy: u64 = 0;
    let mut i = 0;
    while (i < 8) {
        entropy = (entropy << 8) | (*vector::borrow(&digest, i) as u64);
        i = i + 1;
    };

    // Map entropy → signed step in [-vol_bps, +vol_bps].
    let two_v = rw.vol_bps * 2 + 1;
    let raw = entropy % two_v;
    let signed_step = if (raw >= rw.vol_bps) raw - rw.vol_bps else 0;
    let is_up = raw >= rw.vol_bps;
    let abs_step = if (is_up) signed_step else rw.vol_bps - raw;

    let new_price = if (is_up) {
        let delta = (rw.current_price * abs_step) / 10_000;
        rw.current_price + delta
    } else {
        let delta = (rw.current_price * abs_step) / 10_000;
        if (delta >= rw.current_price) 1 else rw.current_price - delta
    };

    rw.current_price = new_price;
    rw.last_tick_ms = now;

    let obs = price_observation::new(new_price, now, object::id(oracle));
    wick_oracle::apply_observation(oracle, wick_oracle::driver_random_walk(), obs);

    sui::event::emit(Ticked {
        random_walk_id: object::id(rw),
        new_price,
        timestamp_ms: now,
        nonce: rw.nonce,
    });
}

// === Reads ===

public fun oracle_id(rw: &RandomWalk): ID { rw.oracle_id }
public fun current_price(rw: &RandomWalk): u64 { rw.current_price }
public fun vol_bps(rw: &RandomWalk): u64 { rw.vol_bps }
public fun nonce(rw: &RandomWalk): u64 { rw.nonce }

// === Test-only ===

#[test_only]
public fun new_for_testing(
    underlying: String,
    starting_price: u64,
    vol_bps: u64,
    expiry_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): (WickOracle, RandomWalk) {
    create_market(underlying, starting_price, vol_bps, expiry_ms, 60_000, clock, ctx)
}
