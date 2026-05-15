// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

#[test_only]
module wick::market_status_tests;

use sui::sui::SUI;
use sui::test_scenario as ts;
use sui::test_utils;
use wick::market;
use wick::path_observation as po;
use wick::price_observation;
use wick::test_helpers as h;
use wick::wick_oracle::{Self, WickOracle};

const ALICE: address = @0xA;
const BOB: address = @0xB;
const POOL_SEED: u64 = 10_000_000_000_000;
const STAKE: u64 = 1_000_000_000;
const SPOT: u64 = 100_000_000_000;
const EXPIRY: u64 = 1_000;

fun push_obs(oracle: &mut WickOracle, price: u64, ts: u64) {
    let oid = object::id(oracle);
    let obs = price_observation::new(price, ts, oid);
    wick_oracle::apply_observation_for_testing(oracle, wick_oracle::driver_random_walk(), obs);
}

fun teardown(
    oracle: WickOracle,
    rw: wick::random_walk_driver::RandomWalk,
    path: po::PathObservation,
    mkt: market::Market<SUI>,
    vault: wick::martingaler_vault::MartingalerVault<SUI>,
    vcap: wick::martingaler_vault::VaultAdminCap,
    rconf: wick::risk_config::RiskConfig,
    rcap: wick::risk_config::RiskAdminCap,
    reg: wick::global_exposure_registry::GlobalExposureRegistry,
    regcap: wick::global_exposure_registry::RegistryAdminCap,
    frtr: wick::fee_router::FeeRouter<SUI>,
    frcap: wick::fee_router::FeeRouterAdminCap,
    clk: sui::clock::Clock,
) {
    test_utils::destroy(oracle); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    test_utils::destroy(rconf); test_utils::destroy(rcap);
    test_utils::destroy(reg); test_utils::destroy(regcap);
    test_utils::destroy(frtr); test_utils::destroy(frcap);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
}

#[test]
fun new_market_starts_active() {
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, path, mkt, vault, vcap, rconf, rcap, reg, regcap, frtr, frcap, clk) =
        h::setup_full_world(&mut sc);

    assert!(market::status(&mkt) == market::status_active(), 0);
    assert!(!market::is_settled(&mkt), 1);
    assert!(option::is_none(market::fee_snapshot(&mkt)), 2);

    teardown(oracle, rw, path, mkt, vault, vcap, rconf, rcap, reg, regcap, frtr, frcap, clk);
    sc.end();
}

#[test]
#[expected_failure(abort_code = market::ENotActive)]
fun cannot_open_when_not_active() {
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, path, mut mkt, mut vault, vcap, rconf, rcap, mut reg, regcap, frtr, frcap, clk) =
        h::setup_full_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);

    market::set_status_for_testing(&mut mkt, market::status_hit());
    let stake = h::mint_sui(STAKE, &mut sc);
    let bundle = h::setup_c35_bundle(&mut sc, &clk);
    let pos = h::open_with_bundle(
        &mut mkt, &mut vault, &rconf, &mut reg, &bundle, &path,
        market::side_touch(), stake, SPOT, &clk, sc.ctx(),
    );

    h::destroy_c35_bundle(bundle);
    test_utils::destroy(pos);
    teardown(oracle, rw, path, mkt, vault, vcap, rconf, rcap, reg, regcap, frtr, frcap, clk);
    sc.end();
}

#[test]
fun lock_and_settle_transitions_to_hit_when_touched() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, rw, mut path, mut mkt, mut vault, vcap, rconf, rcap, mut reg, regcap, frtr, frcap, mut clk) =
        h::setup_full_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);

    clk.increment_for_testing(100);
    push_obs(&mut oracle, 110_000_000_000, 100);
    po::record(&mut path, &oracle, &clk);

    clk.set_for_testing(EXPIRY + 6_000);
    push_obs(&mut oracle, 110_000_000_000, EXPIRY + 50);
    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle, &mut reg, &clk, sc.ctx());

    assert!(market::status(&mkt) == market::status_hit(), 0);
    assert!(option::is_some(market::fee_snapshot(&mkt)), 1);
    assert!(option::is_some(market::settled_at_ms(&mkt)), 2);

    teardown(oracle, rw, path, mkt, vault, vcap, rconf, rcap, reg, regcap, frtr, frcap, clk);
    sc.end();
}

#[test]
fun lock_and_settle_transitions_to_expired_when_no_touch() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, rw, mut path, mut mkt, mut vault, vcap, rconf, rcap, mut reg, regcap, frtr, frcap, mut clk) =
        h::setup_full_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);

    clk.increment_for_testing(100);
    push_obs(&mut oracle, 99_000_000_000, 100);
    po::record(&mut path, &oracle, &clk);

    clk.set_for_testing(EXPIRY + 6_000);
    push_obs(&mut oracle, 99_000_000_000, EXPIRY + 50);
    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle, &mut reg, &clk, sc.ctx());
    assert!(market::status(&mkt) == market::status_expired(), 0);

    teardown(oracle, rw, path, mkt, vault, vcap, rconf, rcap, reg, regcap, frtr, frcap, clk);
    sc.end();
}

#[test]
fun lock_and_settle_transitions_to_aborted_when_too_few_obs() {
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, mut path, mut mkt, mut vault, vcap, rconf, rcap, mut reg, regcap, frtr, frcap, mut clk) =
        h::setup_full_world_with_path_params(&mut sc, EXPIRY, 50, 1, 5_000, 5_000);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);
    let mut oracle_mut = oracle;

    clk.set_for_testing(EXPIRY + 11_000);
    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle_mut, &mut reg, &clk, sc.ctx());
    assert!(market::status(&mkt) == market::status_aborted(), 0);

    teardown(oracle_mut, rw, path, mkt, vault, vcap, rconf, rcap, reg, regcap, frtr, frcap, clk);
    sc.end();
}

#[test]
fun fee_snapshot_captured_at_lock() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, rw, mut path, mut mkt, mut vault, vcap, rconf, rcap, mut reg, regcap, frtr, frcap, mut clk) =
        h::setup_full_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);

    let stake = h::mint_sui(STAKE, &mut sc);
    let bundle = h::setup_c35_bundle(&mut sc, &clk);
    let pos = h::open_with_bundle(
        &mut mkt, &mut vault, &rconf, &mut reg, &bundle, &path,
        market::side_touch(), stake, SPOT, &clk, sc.ctx(),
    );

    clk.increment_for_testing(100);
    push_obs(&mut oracle, 110_000_000_000, 100);
    po::record(&mut path, &oracle, &clk);

    clk.set_for_testing(EXPIRY + 6_000);
    push_obs(&mut oracle, 110_000_000_000, EXPIRY + 50);
    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle, &mut reg, &clk, sc.ctx());
    assert!(option::is_some(market::fee_snapshot(&mkt)), 0);

    let _ = BOB;
    h::destroy_c35_bundle(bundle);
    test_utils::destroy(pos);
    teardown(oracle, rw, path, mkt, vault, vcap, rconf, rcap, reg, regcap, frtr, frcap, clk);
    sc.end();
}
