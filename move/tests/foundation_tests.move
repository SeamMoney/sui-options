// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

#[test_only]
#[allow(deprecated_usage)]
module wick::foundation_tests;

use std::string;
use sui::clock;
use sui::test_scenario as ts;
use wick::path_observation;
use wick::price_observation;
use wick::random_walk_driver;
use wick::wick_oracle::{Self, WickOracle};

const ALICE: address = @0xA;

#[test]
fun price_observation_roundtrip() {
    let oracle_id = object::id_from_address(@0xCAFE);
    let obs = price_observation::new(50_000_000_000_000, 1_700_000_000_000, oracle_id);
    assert!(price_observation::price(&obs) == 50_000_000_000_000, 0);
    assert!(price_observation::timestamp_ms(&obs) == 1_700_000_000_000, 1);
    assert!(price_observation::source_id(&obs) == oracle_id, 2);
}

#[test]
fun wick_oracle_create_and_apply() {
    let mut sc = ts::begin(ALICE);
    let mut oracle = wick_oracle::new_for_testing(
        string::utf8(b"BTC"),
        wick_oracle::driver_random_walk(),
        vector[1, 2, 3],
        2_000_000_000_000,
        sc.ctx(),
    );
    assert!(!wick_oracle::is_settled(&oracle), 0);
    let oid = object::id(&oracle);
    let obs = price_observation::new(100_000_000_000, 1_000_000, oid);
    wick_oracle::apply_observation_for_testing(
        &mut oracle,
        wick_oracle::driver_random_walk(),
        obs,
    );
    assert!(wick_oracle::latest_price(&oracle) == 100_000_000_000, 1);
    sui::test_utils::destroy(oracle);
    sc.end();
}

#[test]
#[expected_failure(abort_code = wick_oracle::EWrongDriver)]
fun wick_oracle_rejects_wrong_driver() {
    let mut sc = ts::begin(ALICE);
    let mut oracle = wick_oracle::new_for_testing(
        string::utf8(b"BTC"),
        wick_oracle::driver_random_walk(),
        vector[],
        2_000_000_000_000,
        sc.ctx(),
    );
    let oid = object::id(&oracle);
    let obs = price_observation::new(100, 1, oid);
    // Try to write a Lazer-driver observation into a RandomWalk oracle.
    wick_oracle::apply_observation_for_testing(
        &mut oracle,
        wick_oracle::driver_lazer(),
        obs,
    );
    sui::test_utils::destroy(oracle);
    sc.end();
}

#[test]
fun random_walk_creates_market_and_seeds_observation() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    let (oracle, rw) = random_walk_driver::new_for_testing(
        string::utf8(b"WICK_RNG"),
        100_000_000_000, // 100.0 in 1e9 scaling
        50,              // 0.5% per tick max move
        2_000_000_000_000,
        &clk,
        sc.ctx(),
    );
    assert!(wick_oracle::driver_kind(&oracle) == wick_oracle::driver_random_walk(), 0);
    assert!(wick_oracle::latest_price(&oracle) == 100_000_000_000, 1);
    assert!(random_walk_driver::current_price(&rw) == 100_000_000_000, 2);
    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(rw);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun random_walk_tick_changes_price_and_oracle() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, mut rw) = random_walk_driver::new_for_testing(
        string::utf8(b"WICK_RNG"),
        100_000_000_000,
        100, // 1% per tick max move
        2_000_000_000_000,
        &clk,
        sc.ctx(),
    );
    let p0 = wick_oracle::latest_price(&oracle);

    clk.increment_for_testing(1_000);
    random_walk_driver::tick(&mut rw, &mut oracle, &clk, sc.ctx());
    let p1 = wick_oracle::latest_price(&oracle);
    // Move bounded to <= 1% in either direction.
    let delta = if (p1 > p0) p1 - p0 else p0 - p1;
    assert!(delta * 10_000 / p0 <= 100, 0);
    assert!(random_walk_driver::current_price(&rw) == p1, 1);
    assert!(random_walk_driver::nonce(&rw) == 1, 2);

    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(rw);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun path_observation_records_min_max_and_touch() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, _rw) = random_walk_driver::new_for_testing(
        string::utf8(b"WICK_RNG"),
        100_000_000_000,
        50,
        2_000_000_000_000,
        &clk,
        sc.ctx(),
    );
    // Touch-above barrier at 105.0
    let mut po = path_observation::new(
        &oracle,
        105_000_000_000,
        path_observation::touch_above(),
        sc.ctx(),
    );
    // Initial seed observation at 100.0 — record it; below barrier, no touch.
    path_observation::record(&mut po, &oracle, &clk);
    assert!(!path_observation::is_touched(&po), 0);
    assert!(path_observation::max_seen(&po) == 100_000_000_000, 1);
    assert!(path_observation::min_seen(&po) == 100_000_000_000, 2);

    // v2: needs 3 consecutive confirmation ticks above the barrier before
    // touched_at sticks. Push 3 obs at 110.0 with monotonically increasing ts.
    let oid = object::id(&oracle);
    clk.increment_for_testing(500);
    let obs_a = price_observation::new(110_000_000_000, 1_500, oid);
    wick_oracle::apply_observation_for_testing(&mut oracle, wick_oracle::driver_random_walk(), obs_a);
    path_observation::record(&mut po, &oracle, &clk);
    assert!(!path_observation::is_touched(&po), 3);  // 1 confirmation, not enough

    clk.increment_for_testing(500);
    let obs_b = price_observation::new(111_000_000_000, 2_000, oid);
    wick_oracle::apply_observation_for_testing(&mut oracle, wick_oracle::driver_random_walk(), obs_b);
    path_observation::record(&mut po, &oracle, &clk);
    assert!(!path_observation::is_touched(&po), 4);  // 2 confirmations, not enough

    clk.increment_for_testing(500);
    let obs_c = price_observation::new(112_000_000_000, 2_500, oid);
    wick_oracle::apply_observation_for_testing(&mut oracle, wick_oracle::driver_random_walk(), obs_c);
    path_observation::record(&mut po, &oracle, &clk);
    assert!(path_observation::is_touched(&po), 5);  // 3 confirmations → touch fires
    assert!(path_observation::max_seen(&po) == 112_000_000_000, 6);

    // Drop back below barrier — touched_at must remain sticky.
    clk.increment_for_testing(500);
    let obs2 = price_observation::new(95_000_000_000, 3_000, oid);
    wick_oracle::apply_observation_for_testing(
        &mut oracle,
        wick_oracle::driver_random_walk(),
        obs2,
    );
    path_observation::record(&mut po, &oracle, &clk);
    assert!(path_observation::is_touched(&po), 7);
    assert!(path_observation::min_seen(&po) == 95_000_000_000, 8);

    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(_rw);
    sui::test_utils::destroy(po);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = path_observation::EOracleMismatch)]
fun path_observation_rejects_wrong_oracle() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    let (oracle_a, rw_a) = random_walk_driver::new_for_testing(
        string::utf8(b"A"),
        100_000_000_000,
        50,
        2_000_000_000_000,
        &clk,
        sc.ctx(),
    );
    let (oracle_b, rw_b) = random_walk_driver::new_for_testing(
        string::utf8(b"B"),
        100_000_000_000,
        50,
        2_000_000_000_000,
        &clk,
        sc.ctx(),
    );
    let mut po = path_observation::new(
        &oracle_a,
        105_000_000_000,
        path_observation::touch_above(),
        sc.ctx(),
    );
    // Cross-oracle write must abort.
    path_observation::record(&mut po, &oracle_b, &clk);
    sui::test_utils::destroy(oracle_a);
    sui::test_utils::destroy(oracle_b);
    sui::test_utils::destroy(rw_a);
    sui::test_utils::destroy(rw_b);
    sui::test_utils::destroy(po);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun lock_settlement_after_expiry() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let expiry = 1_000_000;
    let (mut oracle, _rw) = random_walk_driver::new_for_testing(
        string::utf8(b"WICK_RNG"),
        100_000_000_000,
        50,
        expiry,
        &clk,
        sc.ctx(),
    );
    // Push a post-expiry observation.
    clk.set_for_testing(expiry + 100);
    let oid = object::id(&oracle);
    let obs = price_observation::new(123_456_789_000, expiry + 50, oid);
    wick_oracle::apply_observation_for_testing(
        &mut oracle,
        wick_oracle::driver_random_walk(),
        obs,
    );
    wick_oracle::lock_settlement_from_latest(&mut oracle, &clk);
    assert!(wick_oracle::is_settled(&oracle), 0);
    let settle = *option::borrow(wick_oracle::settlement_price(&oracle));
    assert!(settle == 123_456_789_000, 1);

    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(_rw);
    clk.destroy_for_testing();
    sc.end();
}

