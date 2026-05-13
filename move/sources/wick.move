// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Top-level orchestration for Wick Markets.
///
/// Wick is short-dated touch / no-touch options on oracle-observed barriers.
/// The product is one UX over two backends:
///
///  - **Predict-backed (BTC):** wick callers route through DeepBook Predict's
///    on-chain market — see `wick::predict_route`. (Pending; depends on
///    Predict's `main` branch shipping to testnet.)
///
///  - **Wick-native (SUI / SP500 / random-walk):** Wick owns the collateral
///    vault and position bookkeeping in `wick::market`. Price source is
///    pluggable via `wick::wick_oracle` + a driver module (`pull_oracle_driver`
///    for keeper-pushed feeds, `random_walk_driver` for synthetic markets,
///    `predict_driver` (TODO) for the BTC route).
///
/// This module exposes convenience bootstrap entrypoints — atomically build
/// (oracle, path, market) for a chosen backend in one call.
module wick::wick;

use std::string::String;
use sui::clock::Clock;
use sui::coin::Coin;
use wick::market::{Self, Market};
use wick::path_observation::{Self, PathObservation};
use wick::pull_oracle_driver::{Self, KeeperCap, PullFeed};
use wick::random_walk_driver::{Self, RandomWalk};
use wick::wick_oracle::WickOracle;

/// Bootstrap a Wick-native arcade market backed by a synthetic random walk.
/// Atomically creates: oracle → random walk driver → path observation →
/// market vault. All four are shared. Returns nothing — IDs are emitted via
/// each module's events.
public entry fun bootstrap_random_walk_market<C>(
    name: String,
    underlying: String,
    starting_price: u64,
    vol_bps: u64,
    barrier: u64,
    direction: u8,
    expiry_ms: u64,
    settlement_freshness_ms: u64,
    payout_multiplier_bps: u64,
    seed_collateral: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let (oracle, rw) = random_walk_driver::create_market(
        underlying,
        starting_price,
        vol_bps,
        expiry_ms,
        settlement_freshness_ms,
        clock,
        ctx,
    );
    let path = path_observation::new(&oracle, barrier, direction, ctx);
    let market = market::create<C>(
        name,
        &oracle,
        &path,
        payout_multiplier_bps,
        seed_collateral,
        ctx,
    );
    market::share(market);
    path_observation::share(path);
    random_walk_driver::share(rw);
    wick::wick_oracle::share(oracle);
}

/// Bootstrap a Wick-native market backed by a keeper-pushed price feed.
/// Used for SUI (Pyth Lazer feed 11) and SP500 (Pyth Lazer feed 3145, EMU6).
/// The keeper holds a `KeeperCap` and pushes upstream-verified prices via
/// `pull_oracle_driver::push_price`.
public entry fun bootstrap_pull_market<C>(
    name: String,
    underlying: String,
    upstream_id: String,
    keeper_cap: &KeeperCap,
    barrier: u64,
    direction: u8,
    expiry_ms: u64,
    settlement_freshness_ms: u64,
    payout_multiplier_bps: u64,
    seed_collateral: Coin<C>,
    ctx: &mut TxContext,
) {
    let (oracle, feed) = pull_oracle_driver::create_market(
        underlying,
        upstream_id,
        keeper_cap,
        expiry_ms,
        settlement_freshness_ms,
        ctx,
    );
    let path = path_observation::new(&oracle, barrier, direction, ctx);
    let market = market::create<C>(
        name,
        &oracle,
        &path,
        payout_multiplier_bps,
        seed_collateral,
        ctx,
    );
    market::share(market);
    path_observation::share(path);
    pull_oracle_driver::share_feed(feed);
    wick::wick_oracle::share(oracle);
}

/// Re-exports for SDK convenience — the SDK can call `wick::open_touch` etc.
/// without juggling submodule paths.

public fun open_touch<C>(
    market: &mut Market<C>,
    stake: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): wick::market::Position {
    market::open<C>(market, market::side_touch(), stake, clock, ctx)
}

public fun open_no_touch<C>(
    market: &mut Market<C>,
    stake: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): wick::market::Position {
    market::open<C>(market, market::side_no_touch(), stake, clock, ctx)
}

public fun redeem<C>(
    market: &mut Market<C>,
    position: wick::market::Position,
    path: &PathObservation,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    market::redeem<C>(market, position, path, clock, ctx)
}

#[test_only]
public fun share_random_walk_for_testing(rw: RandomWalk) {
    random_walk_driver::share(rw);
}

#[test_only]
public fun share_pull_feed_for_testing(feed: PullFeed) {
    pull_oracle_driver::share_feed(feed);
}
