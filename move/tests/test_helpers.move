// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

#[test_only]
/// Shared test fixtures for the C.3 vault-backed market world.
module wick::test_helpers;

use std::string;
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario as ts;
use wick::fee_router::{Self as router, FeeRouter, FeeRouterAdminCap};
use wick::global_exposure_registry::{Self as ger, GlobalExposureRegistry, RegistryAdminCap};
use wick::market::{Self, Market};
use wick::martingaler_vault::{Self as mv, MartingalerVault, VaultAdminCap};
use wick::path_observation as po;
use wick::random_walk_driver::{Self, RandomWalk};
use wick::risk_config::{Self as rc, RiskConfig, RiskAdminCap};
use wick::wick_oracle::WickOracle;

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
