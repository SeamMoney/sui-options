// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Direct unit tests for `wick::random_walk_driver` — the synthetic-asset
/// oracle driver behind the legacy random-walk markets. It was only exercised
/// indirectly; this file asserts `tick` directly:
///   - it only drives a random-walk-kind oracle (ENotRandomWalkDriver) that it
///     was configured for (EConfigOracleMismatch)
///   - each tick increments the nonce, applies the new price to the oracle, and
///     keeps price strictly positive (the down-step floors at 1)
///   - vol_bps == 0 is a true no-op on price (deterministic flat walk)
#[test_only]
module wick::random_walk_driver_tests;

use std::string;
use sui::clock;
use sui::test_scenario as ts;
use sui::test_utils;
use wick::random_walk_driver as rwd;
use wick::wick_oracle as wo;

const ALICE: address = @0xA;
const START: u64 = 100_000_000_000;
const EXPIRY: u64 = 1_000_000;

fun mk(sc: &mut ts::Scenario, clk: &clock::Clock, vol_bps: u64): (wo::WickOracle, rwd::RandomWalk) {
    rwd::new_for_testing(string::utf8(b"BTC"), START, vol_bps, EXPIRY, clk, sc.ctx())
}

// A tick bumps the nonce and latches the new price into the paired oracle.
#[test]
fun tick_advances_nonce_and_applies_to_oracle() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, mut rw) = mk(&mut sc, &clk, 100);
    assert!(rwd::nonce(&rw) == 0, 0);

    clk.set_for_testing(500);
    rwd::tick(&mut rw, &mut oracle, &clk, sc.ctx());

    assert!(rwd::nonce(&rw) == 1, 1);
    assert!(wo::latest_price(&oracle) == rwd::current_price(&rw), 2); // oracle reflects the walk
    assert!(rwd::current_price(&rw) > 0, 3);

    test_utils::destroy(oracle);
    test_utils::destroy(rw);
    clk.destroy_for_testing();
    sc.end();
}

// vol_bps == 0 → the step is deterministically zero → price never moves.
#[test]
fun zero_vol_keeps_price_flat() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, mut rw) = mk(&mut sc, &clk, 0);

    clk.set_for_testing(500);
    rwd::tick(&mut rw, &mut oracle, &clk, sc.ctx());

    assert!(rwd::current_price(&rw) == START, 0);
    assert!(wo::latest_price(&oracle) == START, 1);

    test_utils::destroy(oracle);
    test_utils::destroy(rw);
    clk.destroy_for_testing();
    sc.end();
}

// Repeated ticks keep incrementing the nonce and never drive price to zero.
#[test]
fun multiple_ticks_increment_nonce_and_stay_positive() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, mut rw) = mk(&mut sc, &clk, 50);

    let mut i = 0;
    while (i < 3) {
        clk.set_for_testing(100 * (i + 1));
        rwd::tick(&mut rw, &mut oracle, &clk, sc.ctx());
        assert!(rwd::current_price(&rw) > 0, 0);
        i = i + 1;
    };
    assert!(rwd::nonce(&rw) == 3, 1);

    test_utils::destroy(oracle);
    test_utils::destroy(rw);
    clk.destroy_for_testing();
    sc.end();
}

// The driver refuses to tick an oracle of a different driver kind.
#[test]
#[expected_failure(abort_code = rwd::ENotRandomWalkDriver)]
fun tick_wrong_driver_kind_aborts() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (oracle_rw, mut rw) = mk(&mut sc, &clk, 50);
    // A predict-kind oracle — wrong kind for a random-walk driver.
    let mut predict_oracle =
        wo::new_for_testing(string::utf8(b"BTC"), wo::driver_predict(), b"", EXPIRY, sc.ctx());

    clk.set_for_testing(500);
    rwd::tick(&mut rw, &mut predict_oracle, &clk, sc.ctx()); // aborts ENotRandomWalkDriver

    test_utils::destroy(oracle_rw);
    test_utils::destroy(rw);
    test_utils::destroy(predict_oracle);
    clk.destroy_for_testing();
    sc.end();
}

// The driver refuses to tick a DIFFERENT random-walk oracle than the one it was
// configured against (driver kind matches, but the oracle id does not).
#[test]
#[expected_failure(abort_code = rwd::EConfigOracleMismatch)]
fun tick_wrong_oracle_aborts() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (oracle_rw, mut rw) = mk(&mut sc, &clk, 50);
    let mut other =
        wo::new_for_testing(string::utf8(b"BTC"), wo::driver_random_walk(), b"", EXPIRY, sc.ctx());

    clk.set_for_testing(500);
    rwd::tick(&mut rw, &mut other, &clk, sc.ctx()); // aborts EConfigOracleMismatch

    test_utils::destroy(oracle_rw);
    test_utils::destroy(rw);
    test_utils::destroy(other);
    clk.destroy_for_testing();
    sc.end();
}
