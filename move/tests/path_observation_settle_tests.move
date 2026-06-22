// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Settlement-timing guard for PathObservation. The barrier-cross record must
/// not let anyone read a touch verdict before settlement resolves — otherwise a
/// market could settle on an undefined outcome. A fresh, unresolved path makes
/// touch_outcome abort (ENotYetExpired).
#[test_only]
module wick::path_observation_settle_tests;

use std::string;
use sui::clock;
use sui::test_scenario as ts;
use sui::test_utils;
use wick::path_observation as po;
use wick::random_walk_driver as rwd;
use wick::wick_oracle::WickOracle;

const ALICE: address = @0xA;
const BARRIER: u64 = 2_000_000;

fun mk_path(sc: &mut ts::Scenario): (po::PathObservation, WickOracle, rwd::RandomWalk, clock::Clock) {
    let mut clk = clock::create_for_testing(sc.ctx());
    clk.set_for_testing(1_000);
    let (oracle, rw) = rwd::new_for_testing(
        string::utf8(b"PO"), 1_000_000, 500, 60_000, &clk, sc.ctx(),
    );
    let path = po::new_v2(&oracle, BARRIER, po::touch_above(), 20, 1, 1, 60_000, sc.ctx());
    (path, oracle, rw, clk)
}

#[test]
fun a_fresh_path_is_not_yet_resolved() {
    let mut sc = ts::begin(ALICE);
    let (path, oracle, rw, clk) = mk_path(&mut sc);
    assert!(po::settlement_state(&path, &clk) != po::settlement_resolved(), 0);
    test_utils::destroy(path); test_utils::destroy(oracle); test_utils::destroy(rw);
    clk.destroy_for_testing();
    sc.end();
}

// Safety: the touch verdict can't be read before settlement resolves
// → ENotYetExpired. The outcome is undefined until the round is past expiry.
#[test]
#[expected_failure(abort_code = 2, location = wick::path_observation)]
fun touch_outcome_before_resolved_aborts() {
    let mut sc = ts::begin(ALICE);
    let (path, oracle, rw, clk) = mk_path(&mut sc);
    let _ = po::touch_outcome(&path, &clk); // state != RESOLVED
    test_utils::destroy(path); test_utils::destroy(oracle); test_utils::destroy(rw);
    clk.destroy_for_testing();
    sc.end();
}
