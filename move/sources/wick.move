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
///  - **Wick-native (SUI / SP500 / random-walk):** Wick owns position
///    bookkeeping in `wick::market`; collateral lives in a SHARED
///    `wick::martingaler_vault` per collateral type C. Markets bind to the
///    vault by ID at create time. Price source is pluggable via
///    `wick::wick_oracle` + a driver module.
///
/// This module exposes convenience bootstrap entrypoints — atomically build
/// (oracle, path, market) for a chosen backend in one call. Vaults are
/// provisioned separately via `bootstrap_vault`.
module wick::wick;

use std::string::String;
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use wick::fee_router::FeeRouter;
use wick::global_exposure_registry::GlobalExposureRegistry;
use wick::market::{Self, Market};
use wick::martingaler_vault::{Self as mv, MartingalerVault, VaultAdminCap};
use wick::path_observation::{Self, PathObservation};
use wick::pull_oracle_driver::{Self, KeeperCap, PullFeed};
use wick::random_walk_driver::{Self, RandomWalk};
use wick::risk_config::RiskConfig;
use wick::wick_oracle::WickOracle;

// === Vault provisioning (one per collateral type C) ===

/// Bootstrap a MartingalerVault<C> for a collateral type. Returns the
/// VaultAdminCap to the sender. The vault is shared and ID is emitted via
/// `mv::VaultInitialized`.
public entry fun bootstrap_vault<C>(ctx: &mut TxContext) {
    let (cap, _vault_id) = mv::init_vault<C>(ctx);
    transfer::public_transfer(cap, tx_context::sender(ctx));
}

/// Seed an existing vault with initial liquidity (admin protocol bootstrap).
/// Routes through deposit_open which does the auto-harvest dance — same as
/// any trader-deposit, just funded by admin. Use this to pre-fund a fresh
/// vault before opening the first market.
public entry fun seed_vault<C>(
    vault: &mut MartingalerVault<C>,
    seed: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    if (seed.value() == 0) {
        coin::destroy_zero(seed);
        return
    };
    mv::deposit_open(vault, seed, clock, ctx);
}

// === Market bootstraps ===

/// Bootstrap a Wick-native arcade market backed by a synthetic random walk.
/// Atomically creates: oracle → random walk driver → path observation →
/// market. The vault is referenced (not consumed) — must already exist.
/// All three new objects are shared.
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
    correlation_bucket_id: u8,
    vault: &MartingalerVault<C>,
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
    let market = market::create_v2<C>(
        name, &oracle, &path, vault, payout_multiplier_bps, correlation_bucket_id, ctx,
    );
    market::share(market);
    path_observation::share(path);
    random_walk_driver::share(rw);
    wick::wick_oracle::share(oracle);
}

/// Bootstrap a Wick-native market backed by a keeper-pushed price feed.
/// Used for SUI and SP500 underlyings — feed updates pushed via
/// `pull_oracle_driver::push_price` by the keeper holding `KeeperCap`.
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
    correlation_bucket_id: u8,
    vault: &MartingalerVault<C>,
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
    let market = market::create_v2<C>(
        name, &oracle, &path, vault, payout_multiplier_bps, correlation_bucket_id, ctx,
    );
    market::share(market);
    path_observation::share(path);
    pull_oracle_driver::share_feed(feed);
    wick::wick_oracle::share(oracle);
}

// === SDK convenience re-exports ===

public fun open_touch<C>(
    market: &mut Market<C>,
    vault: &mut MartingalerVault<C>,
    risk_config: &RiskConfig,
    registry: &mut GlobalExposureRegistry,
    path: &PathObservation,
    stake: Coin<C>,
    spot: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): wick::market::Position {
    market::open<C>(
        market, vault, risk_config, registry, path, market::side_touch(), stake, spot, clock, ctx,
    )
}

public fun open_no_touch<C>(
    market: &mut Market<C>,
    vault: &mut MartingalerVault<C>,
    risk_config: &RiskConfig,
    registry: &mut GlobalExposureRegistry,
    path: &PathObservation,
    stake: Coin<C>,
    spot: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): wick::market::Position {
    market::open<C>(
        market, vault, risk_config, registry, path, market::side_no_touch(), stake, spot, clock, ctx,
    )
}

public fun redeem<C>(
    market: &mut Market<C>,
    vault: &mut MartingalerVault<C>,
    risk_config: &RiskConfig,
    fee_router: &mut FeeRouter<C>,
    position: wick::market::Position,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    market::redeem<C>(market, vault, risk_config, fee_router, position, clock, ctx)
}

/// Permissionless atomic settlement entry — anyone can crank past
/// `expiry + drain_ms`.
public fun lock_and_settle<C>(
    market: &mut Market<C>,
    vault: &mut MartingalerVault<C>,
    path: &mut PathObservation,
    oracle: &mut WickOracle,
    registry: &mut GlobalExposureRegistry,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    market::lock_and_settle<C>(market, vault, path, oracle, registry, clock, ctx)
}

/// Admin: recover stranded seed from an Aborted market's refund pool.
/// Only callable post-Aborted; routes residue back to vault.treasury (anti-rug).
public fun recover_aborted_seed<C>(
    cap: &VaultAdminCap,
    vault: &mut MartingalerVault<C>,
    market: &Market<C>,
) {
    mv::admin_recover_aborted_seed<C>(cap, vault, object::id(market))
}

#[test_only]
public fun share_random_walk_for_testing(rw: RandomWalk) {
    random_walk_driver::share(rw);
}

#[test_only]
public fun share_pull_feed_for_testing(feed: PullFeed) {
    pull_oracle_driver::share_feed(feed);
}
