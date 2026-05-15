// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

#[test_only]
/// Shared test fixtures for the C.3 vault-backed market world.
/// Single setup_market_world call returns (oracle, rw, path, mkt, vault, vcap, clk).
module wick::test_helpers;

use std::string;
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario as ts;
use wick::market::{Self, Market};
use wick::martingaler_vault::{Self as mv, MartingalerVault, VaultAdminCap};
use wick::path_observation as po;
use wick::random_walk_driver::{Self, RandomWalk};
use wick::wick_oracle::WickOracle;

/// Default market params.
public fun default_starting_price(): u64 { 100_000_000_000 }     // 100.0
public fun default_barrier_above(): u64 { 105_000_000_000 }      // 105.0
public fun default_payout_bps(): u64 { 18_000 }                  // 1.8x
public fun default_expiry(): u64 { 1_000 }
public fun default_drain_ms(): u64 { 5_000 }

/// Setup a complete market world with relaxed path settings (single tick
/// triggers, single confirmation). Use this when testing market mechanics
/// (open/redeem/settle) — not path hardening.
public fun setup_market_world(
    sc: &mut ts::Scenario,
): (
    WickOracle,
    RandomWalk,
    po::PathObservation,
    Market<SUI>,
    MartingalerVault<SUI>,
    VaultAdminCap,
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
        &oracle,
        default_barrier_above(),
        po::touch_above(),
        0, 1, 1, 60_000, sc.ctx(),  // buffer=0, min_obs=1, conf=1, grace=60s
    );
    let (vault, vcap) = mv::init_for_testing<SUI>(sc.ctx());
    let mkt = market::create<SUI>(
        string::utf8(b"M"), &oracle, &path, &vault, default_payout_bps(), sc.ctx(),
    );
    (oracle, rw, path, mkt, vault, vcap, clk)
}

/// Setup with custom path-hardening params (for path-side tests).
public fun setup_market_world_with_path_params(
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
    (oracle, rw, path, mkt, vault, vcap, clk)
}

/// Seed the vault treasury with `amount` of SUI so the market has counterparty
/// liquidity for early winners (before any losses come in).
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
