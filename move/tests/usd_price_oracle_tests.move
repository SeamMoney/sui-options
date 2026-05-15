// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

#[test_only]
module wick::usd_price_oracle_tests;

use sui::clock;
use sui::sui::SUI;
use sui::test_scenario as ts;
use sui::test_utils;
use wick::usd_price_oracle as upo;

const ALICE: address = @0xA;

fun setup(sc: &mut ts::Scenario): (upo::UsdPriceOracle, upo::PriceAdminCap, clock::Clock) {
    let (oracle, cap) = upo::init_for_testing(sc.ctx());
    let mut clk = clock::create_for_testing(sc.ctx());
    clk.set_for_testing(1_000_000_000);
    (oracle, cap, clk)
}

#[test]
fun init_starts_empty() {
    let mut sc = ts::begin(ALICE);
    let (oracle, cap, clk) = setup(&mut sc);
    assert!(!upo::has_price<SUI>(&oracle), 0);
    assert!(!upo::is_fresh<SUI>(&oracle, &clk, 60_000), 1);
    test_utils::destroy(oracle);
    test_utils::destroy(cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun set_then_read_price() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, cap, clk) = setup(&mut sc);

    // SUI = $5.00 → 5_000_000 micro-USD per whole SUI; SUI has 9 decimals.
    upo::set_price<SUI>(&cap, &mut oracle, 5_000_000, 9, &clk);
    assert!(upo::has_price<SUI>(&oracle), 0);
    let entry = upo::price_entry<SUI>(&oracle);
    assert!(upo::price_micro_usd_per_whole(&entry) == 5_000_000, 1);
    assert!(upo::price_decimals(&entry) == 9, 2);

    test_utils::destroy(oracle);
    test_utils::destroy(cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun loss_micro_usd_calculation() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, cap, clk) = setup(&mut sc);

    // SUI at $5.00 (5_000_000 micro-USD per whole, 9 decimals).
    upo::set_price<SUI>(&cap, &mut oracle, 5_000_000, 9, &clk);

    // 1 whole SUI = 1_000_000_000 base units → loss = 5_000_000 micro-USD ($5).
    assert!(upo::loss_micro_usd<SUI>(&oracle, 1_000_000_000, &clk, 60_000) == 5_000_000, 0);
    // 0.5 SUI = 500_000_000 base units → $2.50 = 2_500_000 micro-USD.
    assert!(upo::loss_micro_usd<SUI>(&oracle, 500_000_000, &clk, 60_000) == 2_500_000, 1);
    // Dust 1 base unit (1 nano-SUI) → 5_000_000 / 1e9 = 0 (truncates).
    assert!(upo::loss_micro_usd<SUI>(&oracle, 1, &clk, 60_000) == 0, 2);
    // Zero stake → 0.
    assert!(upo::loss_micro_usd<SUI>(&oracle, 0, &clk, 60_000) == 0, 3);

    test_utils::destroy(oracle);
    test_utils::destroy(cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun stale_price_returns_zero() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, cap, mut clk) = setup(&mut sc);
    upo::set_price<SUI>(&cap, &mut oracle, 5_000_000, 9, &clk);

    // Within staleness window: returns price.
    assert!(upo::loss_micro_usd<SUI>(&oracle, 1_000_000_000, &clk, 60_000) == 5_000_000, 0);

    // Move past staleness: returns 0 (graceful no-op for downstream mint).
    clk.increment_for_testing(120_000);  // 2 minutes
    assert!(upo::loss_micro_usd<SUI>(&oracle, 1_000_000_000, &clk, 60_000) == 0, 1);
    assert!(!upo::is_fresh<SUI>(&oracle, &clk, 60_000), 2);

    test_utils::destroy(oracle);
    test_utils::destroy(cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun unset_price_returns_zero() {
    let mut sc = ts::begin(ALICE);
    let (oracle, cap, clk) = setup(&mut sc);
    // Never set any price → loss_micro_usd returns 0.
    assert!(upo::loss_micro_usd<SUI>(&oracle, 1_000_000_000, &clk, 60_000) == 0, 0);
    test_utils::destroy(oracle);
    test_utils::destroy(cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = upo::ENotAdmin)]
fun set_price_with_wrong_admin_aborts() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, cap, clk) = setup(&mut sc);
    let (other_oracle, other_cap) = upo::init_for_testing(sc.ctx());

    // other_cap has wrong oracle_id.
    upo::set_price<SUI>(&other_cap, &mut oracle, 5_000_000, 9, &clk);

    test_utils::destroy(oracle);
    test_utils::destroy(other_oracle);
    test_utils::destroy(cap);
    test_utils::destroy(other_cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = upo::EZeroPrice)]
fun set_price_zero_aborts() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, cap, clk) = setup(&mut sc);
    upo::set_price<SUI>(&cap, &mut oracle, 0, 9, &clk);
    test_utils::destroy(oracle);
    test_utils::destroy(cap);
    clk.destroy_for_testing();
    sc.end();
}
