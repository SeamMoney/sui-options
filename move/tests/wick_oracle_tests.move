// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Direct unit tests for `wick::wick_oracle` — the settlement-critical oracle
/// every market and ride locks against. It was previously only exercised
/// indirectly (via `apply_observation_for_testing` in market/ride tests); this
/// file asserts its own lifecycle + guards directly:
///   - latest_price refuses to read before any observation (ENoObservation)
///   - a driver can't write into an oracle of a different kind (EWrongDriver)
///   - the FIRST post-expiry observation latches as the settlement obs, and
///     later observations never overwrite it
///   - settlement can only lock past expiry (ENotPastExpiry), needs a latched
///     settlement obs (ENoSettlementObservation), and rejects a stale one
///     (EStaleObservation)
///   - settlement is one-shot: no double-settle, no post-settle writes
///     (EAlreadySettled)
#[test_only]
module wick::wick_oracle_tests;

use std::string;
use sui::clock;
use sui::test_scenario as ts;
use sui::test_utils;
use wick::price_observation as po;
use wick::wick_oracle as wo;

const ALICE: address = @0xA;
const EXPIRY: u64 = 1_000;
const PRICE: u64 = 100_000_000_000;

fun mk_oracle(sc: &mut ts::Scenario): wo::WickOracle {
    wo::new_for_testing(string::utf8(b"BTC"), wo::driver_random_walk(), b"", EXPIRY, sc.ctx())
}

fun obs(oracle: &wo::WickOracle, price: u64, t: u64): po::PriceObservation {
    po::new(price, t, object::id(oracle))
}

// latest_price must refuse to read before any observation is recorded.
#[test]
#[expected_failure(abort_code = wo::ENoObservation)]
fun latest_price_aborts_before_any_observation() {
    let mut sc = ts::begin(ALICE);
    let oracle = mk_oracle(&mut sc);
    let _ = wo::latest_price(&oracle); // aborts ENoObservation
    test_utils::destroy(oracle);
    sc.end();
}

// A recorded observation becomes `latest`; not settled until locked.
#[test]
fun apply_observation_updates_latest() {
    let mut sc = ts::begin(ALICE);
    let mut oracle = mk_oracle(&mut sc);
    let o = obs(&oracle, PRICE, 500);
    wo::apply_observation_for_testing(&mut oracle, wo::driver_random_walk(), o);
    assert!(wo::latest_price(&oracle) == PRICE, 0);
    assert!(!wo::is_settled(&oracle), 1);
    test_utils::destroy(oracle);
    sc.end();
}

// A driver of the wrong kind cannot write into this oracle.
#[test]
#[expected_failure(abort_code = wo::EWrongDriver)]
fun apply_with_wrong_driver_aborts() {
    let mut sc = ts::begin(ALICE);
    let mut oracle = mk_oracle(&mut sc); // driver_kind = random_walk
    let o = obs(&oracle, PRICE, 500);
    wo::apply_observation_for_testing(&mut oracle, wo::driver_predict(), o); // mismatch
    test_utils::destroy(oracle);
    sc.end();
}

// The first post-expiry observation latches as the settlement obs, and a
// permissionless lock past expiry settles to its price.
#[test]
fun post_expiry_observation_latches_and_settles() {
    let mut sc = ts::begin(ALICE);
    let mut oracle = mk_oracle(&mut sc);
    let mut clk = clock::create_for_testing(sc.ctx());

    // First post-expiry obs latches settlement_observation.
    let o = obs(&oracle, PRICE, EXPIRY); // ts == expiry → post-expiry
    wo::apply_observation_for_testing(&mut oracle, wo::driver_random_walk(), o);
    assert!(option::is_some(wo::settlement_observation(&oracle)), 0);

    // A later post-expiry obs updates latest but must NOT overwrite the latch.
    let o2 = obs(&oracle, PRICE + 5_000_000_000, EXPIRY + 100);
    wo::apply_observation_for_testing(&mut oracle, wo::driver_random_walk(), o2);
    assert!(wo::latest_price(&oracle) == PRICE + 5_000_000_000, 1);

    clk.set_for_testing(EXPIRY); // now >= expiry, fresh
    wo::lock_settlement_from_latest(&mut oracle, &clk);
    assert!(wo::is_settled(&oracle), 2);
    assert!(*option::borrow(wo::settlement_price(&oracle)) == PRICE, 3); // the LATCH, not the later obs

    clk.destroy_for_testing();
    test_utils::destroy(oracle);
    sc.end();
}

// Settlement cannot lock before expiry.
#[test]
#[expected_failure(abort_code = wo::ENotPastExpiry)]
fun lock_before_expiry_aborts() {
    let mut sc = ts::begin(ALICE);
    let mut oracle = mk_oracle(&mut sc);
    let mut clk = clock::create_for_testing(sc.ctx());
    let o = obs(&oracle, PRICE, 500);
    wo::apply_observation_for_testing(&mut oracle, wo::driver_random_walk(), o);
    clk.set_for_testing(500); // before expiry
    wo::lock_settlement_from_latest(&mut oracle, &clk); // aborts ENotPastExpiry
    clk.destroy_for_testing();
    test_utils::destroy(oracle);
    sc.end();
}

// Past expiry but with no latched post-expiry observation → cannot settle.
#[test]
#[expected_failure(abort_code = wo::ENoSettlementObservation)]
fun lock_without_settlement_obs_aborts() {
    let mut sc = ts::begin(ALICE);
    let mut oracle = mk_oracle(&mut sc);
    let mut clk = clock::create_for_testing(sc.ctx());
    let o = obs(&oracle, PRICE, 500); // pre-expiry → never latches
    wo::apply_observation_for_testing(&mut oracle, wo::driver_random_walk(), o);
    clk.set_for_testing(EXPIRY + 1_000);
    wo::lock_settlement_from_latest(&mut oracle, &clk); // aborts ENoSettlementObservation
    clk.destroy_for_testing();
    test_utils::destroy(oracle);
    sc.end();
}

// A latched settlement obs older than the freshness window is rejected — a slow
// cranker cannot settle against a stale price.
#[test]
#[expected_failure(abort_code = wo::EStaleObservation)]
fun stale_settlement_observation_aborts() {
    let mut sc = ts::begin(ALICE);
    let mut oracle = mk_oracle(&mut sc); // settlement_freshness = 60_000
    let mut clk = clock::create_for_testing(sc.ctx());
    let o = obs(&oracle, PRICE, EXPIRY); // latched at ts = EXPIRY
    wo::apply_observation_for_testing(&mut oracle, wo::driver_random_walk(), o);
    clk.set_for_testing(EXPIRY + 60_001); // now - obs_ts = 60_001 > 60_000
    wo::lock_settlement_from_latest(&mut oracle, &clk); // aborts EStaleObservation
    clk.destroy_for_testing();
    test_utils::destroy(oracle);
    sc.end();
}

// Settlement is one-shot — a second lock aborts.
#[test]
#[expected_failure(abort_code = wo::EAlreadySettled)]
fun double_settle_aborts() {
    let mut sc = ts::begin(ALICE);
    let mut oracle = mk_oracle(&mut sc);
    let mut clk = clock::create_for_testing(sc.ctx());
    let o = obs(&oracle, PRICE, EXPIRY);
    wo::apply_observation_for_testing(&mut oracle, wo::driver_random_walk(), o);
    clk.set_for_testing(EXPIRY);
    wo::lock_settlement_from_latest(&mut oracle, &clk);
    wo::lock_settlement_from_latest(&mut oracle, &clk); // aborts EAlreadySettled
    clk.destroy_for_testing();
    test_utils::destroy(oracle);
    sc.end();
}

// Once settled, no further observations may be written.
#[test]
#[expected_failure(abort_code = wo::EAlreadySettled)]
fun apply_after_settled_aborts() {
    let mut sc = ts::begin(ALICE);
    let mut oracle = mk_oracle(&mut sc);
    let mut clk = clock::create_for_testing(sc.ctx());
    let o = obs(&oracle, PRICE, EXPIRY);
    wo::apply_observation_for_testing(&mut oracle, wo::driver_random_walk(), o);
    clk.set_for_testing(EXPIRY);
    wo::lock_settlement_from_latest(&mut oracle, &clk);
    let o2 = obs(&oracle, PRICE, EXPIRY + 10);
    wo::apply_observation_for_testing(&mut oracle, wo::driver_random_walk(), o2); // aborts EAlreadySettled
    clk.destroy_for_testing();
    test_utils::destroy(oracle);
    sc.end();
}
