// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

#[test_only]
/// Shared test fixtures for the C.3 vault-backed market world.
#[allow(deprecated_usage)]
module wick::test_helpers;

use std::string;
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario as ts;
use wick::bot_registry::{Self as br, BotRegistry, BotAdminCap};
use wick::fee_router::{Self as router, FeeRouter, FeeRouterAdminCap};
use wick::global_exposure_registry::{Self as ger, GlobalExposureRegistry, RegistryAdminCap};
use wick::market::{Self, Market};
use wick::martingaler_vault::{Self as mv, MartingalerVault, VaultAdminCap};
use wick::path_observation as po;
use wick::random_walk_driver::{Self, RandomWalk};
use wick::risk_config::{Self as rc, RiskConfig, RiskAdminCap};
use wick::usd_price_oracle::{Self as upo, UsdPriceOracle, PriceAdminCap};
use wick::wick_oracle::WickOracle;
use wick::wick_staking::{Self as ws, WickStakingPool, StakingAdminCap};
use wick::wick_token::{Self as wt, WickTokenState, WickAdminCap};

public fun default_starting_price(): u64 { 100_000_000_000 }
public fun default_barrier_above(): u64 { 105_000_000_000 }
public fun default_payout_bps(): u64 { 18_000 }
public fun default_expiry(): u64 { 1_000 }

/// Full world fixture for C.3.4+ tests. Returns ALL the shared objects:
/// (oracle, rw, path, market, vault, vcap, risk_config, rcap, registry, regcap,
///  fee_router, frcap, clock).
///
/// 13 objects but the alternative is 100 LOC of setup per test.
public fun setup_full_world(
    sc: &mut ts::Scenario,
): (
    WickOracle,
    RandomWalk,
    po::PathObservation,
    Market<SUI>,
    MartingalerVault<SUI>,
    VaultAdminCap,
    RiskConfig,
    RiskAdminCap,
    GlobalExposureRegistry,
    RegistryAdminCap,
    FeeRouter<SUI>,
    FeeRouterAdminCap,
    clock::Clock,
) {
    let clk = clock::create_for_testing(sc.ctx());
    let (oracle, rw) = random_walk_driver::new_for_testing(
        string::utf8(b"WICK_RNG"),
        default_starting_price(),
        50,
        default_expiry(),
        &clk,
        sc.ctx(),
    );
    let path = po::new_v2(
        &oracle, default_barrier_above(), po::touch_above(),
        0, 1, 1, 60_000, sc.ctx(),
    );
    let (vault, vcap) = mv::init_for_testing<SUI>(sc.ctx());
    let mkt = market::create<SUI>(
        string::utf8(b"M"), &oracle, &path, &vault, default_payout_bps(), sc.ctx(),
    );
    let (risk_config, rcap) = rc::init_for_testing(sc.ctx());
    let (registry, regcap) = ger::init_for_testing(sc.ctx());
    let (fee_router, frcap) = router::init_for_testing<SUI>(sc.ctx());
    (oracle, rw, path, mkt, vault, vcap, risk_config, rcap, registry, regcap, fee_router, frcap, clk)
}

public fun setup_full_world_with_path_params(
    sc: &mut ts::Scenario,
    expiry_ms: u64,
    min_observations: u64,
    confirmations: u64,
    grace_ms: u64,
    drain_ms: u64,
): (
    WickOracle,
    RandomWalk,
    po::PathObservation,
    Market<SUI>,
    MartingalerVault<SUI>,
    VaultAdminCap,
    RiskConfig,
    RiskAdminCap,
    GlobalExposureRegistry,
    RegistryAdminCap,
    FeeRouter<SUI>,
    FeeRouterAdminCap,
    clock::Clock,
) {
    let clk = clock::create_for_testing(sc.ctx());
    let (oracle, rw) = random_walk_driver::new_for_testing(
        string::utf8(b"WICK_RNG"),
        default_starting_price(),
        50,
        expiry_ms,
        &clk,
        sc.ctx(),
    );
    let path = po::new_v3(
        &oracle, default_barrier_above(), po::touch_above(),
        0, min_observations, confirmations, grace_ms, drain_ms, sc.ctx(),
    );
    let (vault, vcap) = mv::init_for_testing<SUI>(sc.ctx());
    let mkt = market::create<SUI>(
        string::utf8(b"M"), &oracle, &path, &vault, default_payout_bps(), sc.ctx(),
    );
    let (risk_config, rcap) = rc::init_for_testing(sc.ctx());
    let (registry, regcap) = ger::init_for_testing(sc.ctx());
    let (fee_router, frcap) = router::init_for_testing<SUI>(sc.ctx());
    (oracle, rw, path, mkt, vault, vcap, risk_config, rcap, registry, regcap, fee_router, frcap, clk)
}

public fun seed_vault(
    vault: &mut MartingalerVault<SUI>,
    amount: u64,
    clk: &clock::Clock,
    sc: &mut ts::Scenario,
) {
    if (amount == 0) return;
    let seed = coin::mint_for_testing<SUI>(amount, sc.ctx());
    mv::deposit_open(vault, seed, clk, sc.ctx());
}

public fun mint_sui(amount: u64, sc: &mut ts::Scenario): coin::Coin<SUI> {
    coin::mint_for_testing<SUI>(amount, sc.ctx())
}

/// Bundle of additional shared objects needed by C.3.5 redeem path.
public struct C35Bundle {
    bot_registry: BotRegistry,
    bot_cap: BotAdminCap,
    wick_state: WickTokenState,
    wick_cap: WickAdminCap,
    staking_pool: WickStakingPool,
    staking_cap: StakingAdminCap,
    price_oracle: UsdPriceOracle,
    price_cap: PriceAdminCap,
}

public fun setup_c35_bundle(sc: &mut ts::Scenario, clk: &clock::Clock): C35Bundle {
    let (bot_registry, bot_cap) = br::init_for_testing(sc.ctx());
    let (wick_state, wick_cap) = wt::init_for_testing(sc.ctx());
    let (staking_pool, staking_cap) = ws::init_for_testing(sc.ctx());
    let (mut price_oracle, price_cap) = upo::init_for_testing(sc.ctx());
    // Default: SUI = $1.00 (=1_000_000 micro-USD per whole, 9 decimals).
    upo::set_price<SUI>(&price_cap, &mut price_oracle, 1_000_000, 9, clk);
    C35Bundle {
        bot_registry, bot_cap, wick_state, wick_cap,
        staking_pool, staking_cap, price_oracle, price_cap,
    }
}

public fun bundle_bot_registry(b: &C35Bundle): &BotRegistry { &b.bot_registry }
public fun bundle_wick_state(b: &mut C35Bundle): &mut WickTokenState { &mut b.wick_state }
public fun bundle_staking_pool(b: &mut C35Bundle): &mut WickStakingPool { &mut b.staking_pool }
public fun bundle_price_oracle(b: &C35Bundle): &UsdPriceOracle { &b.price_oracle }

/// Convenience wrapper: open a position with full C.3.5 plumbing.
public fun open_with_bundle(
    market: &mut Market<SUI>,
    vault: &mut MartingalerVault<SUI>,
    risk_config: &RiskConfig,
    registry: &mut GlobalExposureRegistry,
    bundle: &C35Bundle,
    path: &po::PathObservation,
    side: u8,
    stake: coin::Coin<SUI>,
    spot: u64,
    clk: &clock::Clock,
    ctx: &mut TxContext,
): market::Position {
    market::open<SUI>(
        market, vault, risk_config, registry, &bundle.bot_registry, path,
        side, stake, spot, clk, ctx,
    )
}

/// Convenience wrapper: redeem a position with full C.3.5 plumbing.
public fun redeem_with_bundle(
    market: &mut Market<SUI>,
    vault: &mut MartingalerVault<SUI>,
    risk_config: &RiskConfig,
    fee_router: &mut FeeRouter<SUI>,
    bundle: &mut C35Bundle,
    position: market::Position,
    clk: &clock::Clock,
    ctx: &mut TxContext,
): coin::Coin<SUI> {
    market::redeem<SUI>(
        market, vault, risk_config, fee_router,
        &mut bundle.wick_state, &mut bundle.staking_pool, &bundle.price_oracle,
        position, clk, ctx,
    )
}

public fun destroy_c35_bundle(b: C35Bundle) {
    let C35Bundle {
        bot_registry, bot_cap, wick_state, wick_cap,
        staking_pool, staking_cap, price_oracle, price_cap,
    } = b;
    sui::test_utils::destroy(bot_registry);
    sui::test_utils::destroy(bot_cap);
    sui::test_utils::destroy(wick_state);
    sui::test_utils::destroy(wick_cap);
    sui::test_utils::destroy(staking_pool);
    sui::test_utils::destroy(staking_cap);
    sui::test_utils::destroy(price_oracle);
    sui::test_utils::destroy(price_cap);
}
