// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Construction-config guards for PathObservation — the oracle barrier-cross
/// record every market settles against. A market's whole fairness story rests
/// on a well-formed barrier/direction/anti-jitter config, so new_v2 (→ new_v4)
/// rejects a zero barrier, an unknown touch direction, and a zero observation
/// floor. The happy-path constructor is exercised by the market/ride tests, but
/// these rejection guards (EInvalidConfig / EInvalidDirection) were not.
#[test_only]
module wick::path_observation_config_tests;

use std::string;
use sui::clock;
use sui::test_scenario as ts;
use sui::test_utils;
use wick::path_observation as po;
use wick::random_walk_driver as rwd;
use wick::wick_oracle::WickOracle;

const ALICE: address = @0xA;
const BARRIER: u64 = 2_000_000;

fun mk_oracle(sc: &mut ts::Scenario): (WickOracle, rwd::RandomWalk, clock::Clock) {
    let mut clk = clock::create_for_testing(sc.ctx());
    clk.set_for_testing(1_000);
    let (oracle, rw) = rwd::new_for_testing(
        string::utf8(b"PO"), 1_000_000, 500, 60_000, &clk, sc.ctx(),
    );
    (oracle, rw, clk)
}

#[test]
fun new_v2_accepts_a_well_formed_config() {
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, clk) = mk_oracle(&mut sc);
    let path = po::new_v2(&oracle, BARRIER, po::touch_above(), 20, 1, 1, 60_000, sc.ctx());
    test_utils::destroy(path); test_utils::destroy(oracle); test_utils::destroy(rw);
    clk.destroy_for_testing();
    sc.end();
}

// Safety: a zero barrier is meaningless (price can't cross 0) → EInvalidConfig.
#[test]
#[expected_failure(abort_code = 5, location = wick::path_observation)]
fun new_v2_rejects_zero_barrier() {
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, clk) = mk_oracle(&mut sc);
    let path = po::new_v2(&oracle, 0, po::touch_above(), 20, 1, 1, 60_000, sc.ctx());
    test_utils::destroy(path); test_utils::destroy(oracle); test_utils::destroy(rw); // unreachable
    clk.destroy_for_testing();
    sc.end();
}

// Safety: only touch_above (0) / touch_below (1) are valid directions → EInvalidDirection.
#[test]
#[expected_failure(abort_code = 4, location = wick::path_observation)]
fun new_v2_rejects_unknown_direction() {
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, clk) = mk_oracle(&mut sc);
    let path = po::new_v2(&oracle, BARRIER, 99, 20, 1, 1, 60_000, sc.ctx());
    test_utils::destroy(path); test_utils::destroy(oracle); test_utils::destroy(rw); // unreachable
    clk.destroy_for_testing();
    sc.end();
}

// Safety: settlement needs at least one observation → EInvalidConfig (a separate
// config field from the barrier — proves the floor is enforced too).
#[test]
#[expected_failure(abort_code = 5, location = wick::path_observation)]
fun new_v2_rejects_zero_min_observations() {
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, clk) = mk_oracle(&mut sc);
    let path = po::new_v2(&oracle, BARRIER, po::touch_above(), 20, 0, 1, 60_000, sc.ctx());
    test_utils::destroy(path); test_utils::destroy(oracle); test_utils::destroy(rw); // unreachable
    clk.destroy_for_testing();
    sc.end();
}
