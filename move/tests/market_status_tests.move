// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

#[test_only]
module wick::market_status_tests;

use std::string;
use sui::sui::SUI;
use sui::test_scenario as ts;
use sui::test_utils;
use wick::market;
use wick::martingaler_vault as mv;
use wick::path_observation as po;
use wick::price_observation;
use wick::random_walk_driver;
use wick::test_helpers as h;
use wick::wick_oracle::{Self, WickOracle};

const ALICE: address = @0xA;
const BOB: address = @0xB;
const POOL_SEED: u64 = 10_000_000_000;
const STAKE: u64 = 1_000_000_000;
const EXPIRY: u64 = 1_000;

fun push_obs(oracle: &mut WickOracle, price: u64, ts: u64) {
    let oid = object::id(oracle);
    let obs = price_observation::new(price, ts, oid);
    wick_oracle::apply_observation_for_testing(oracle, wick_oracle::driver_random_walk(), obs);
}

#[test]
fun new_market_starts_active() {
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, path, mkt, vault, vcap, clk) = h::setup_market_world(&mut sc);

    assert!(market::status(&mkt) == market::status_active(), 0);
    assert!(!market::is_settled(&mkt), 1);
    assert!(option::is_none(market::fee_snapshot(&mkt)), 2);
    assert!(option::is_none(market::settled_at_ms(&mkt)), 3);

    test_utils::destroy(oracle); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun create_v2_records_underlying_and_bucket() {
    let mut sc = ts::begin(ALICE);
    let clk = sui::clock::create_for_testing(sc.ctx());
    let (oracle, rw) = random_walk_driver::new_for_testing(
        string::utf8(b"BTC"), 100_000_000_000, 50, EXPIRY, &clk, sc.ctx(),
    );
    let path = po::new_v2(&oracle, 105_000_000_000, po::touch_above(), 0, 1, 1, 60_000, sc.ctx());
    let (vault, vcap) = mv::init_for_testing<SUI>(sc.ctx());
    let mkt = market::create_v2<SUI>(
        string::utf8(b"BTC market"), &oracle, &path, &vault, 18_000, 7, sc.ctx(),
    );
    assert!(string::as_bytes(market::underlying(&mkt)) == &b"BTC", 0);
    assert!(market::correlation_bucket_id(&mkt) == 7, 1);

    test_utils::destroy(oracle); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = market::ENotActive)]
fun cannot_open_when_not_active() {
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, path, mut mkt, mut vault, vcap, clk) = h::setup_market_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);

    market::set_status_for_testing(&mut mkt, market::status_hit());
    let stake = h::mint_sui(STAKE, &mut sc);
    let pos = market::open<SUI>(&mut mkt, &mut vault, market::side_touch(), stake, &clk, sc.ctx());

    test_utils::destroy(pos);
    test_utils::destroy(oracle); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun lock_and_settle_transitions_to_hit_when_touched() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, rw, mut path, mut mkt, mut vault, vcap, mut clk) =
        h::setup_market_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);

    clk.increment_for_testing(100);
    push_obs(&mut oracle, 110_000_000_000, 100);
    po::record(&mut path, &oracle, &clk);
    assert!(po::is_touched(&path), 0);

    clk.set_for_testing(EXPIRY + 6_000);
    push_obs(&mut oracle, 110_000_000_000, EXPIRY + 50);
    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle, &clk, sc.ctx());

    assert!(market::status(&mkt) == market::status_hit(), 1);
    assert!(option::is_some(market::fee_snapshot(&mkt)), 2);
    assert!(option::is_some(market::settled_at_ms(&mkt)), 3);

    test_utils::destroy(oracle); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun lock_and_settle_transitions_to_expired_when_no_touch() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, rw, mut path, mut mkt, mut vault, vcap, mut clk) =
        h::setup_market_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);

    clk.increment_for_testing(100);
    push_obs(&mut oracle, 99_000_000_000, 100);
    po::record(&mut path, &oracle, &clk);

    clk.set_for_testing(EXPIRY + 6_000);
    push_obs(&mut oracle, 99_000_000_000, EXPIRY + 50);
    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle, &clk, sc.ctx());

    assert!(market::status(&mkt) == market::status_expired(), 0);

    test_utils::destroy(oracle); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun lock_and_settle_transitions_to_aborted_when_too_few_obs() {
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, mut path, mut mkt, mut vault, vcap, mut clk) =
        h::setup_market_world_with_path_params(&mut sc, EXPIRY, 50, 1, 5_000, 5_000);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);
    let mut oracle_mut = oracle;

    clk.set_for_testing(EXPIRY + 11_000);
    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle_mut, &clk, sc.ctx());
    assert!(market::status(&mkt) == market::status_aborted(), 0);

    test_utils::destroy(oracle_mut); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun lock_and_settle_idempotent_returns_early() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, rw, mut path, mut mkt, mut vault, vcap, mut clk) =
        h::setup_market_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);

    clk.increment_for_testing(100);
    push_obs(&mut oracle, 99_000_000_000, 100);
    po::record(&mut path, &oracle, &clk);

    clk.set_for_testing(EXPIRY + 6_000);
    push_obs(&mut oracle, 99_000_000_000, EXPIRY + 50);

    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle, &clk, sc.ctx());
    let first_status = market::status(&mkt);

    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle, &clk, sc.ctx());
    assert!(market::status(&mkt) == first_status, 0);

    test_utils::destroy(oracle); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun fee_snapshot_captured_at_lock() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, rw, mut path, mut mkt, mut vault, vcap, mut clk) =
        h::setup_market_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);

    let stake = h::mint_sui(STAKE, &mut sc);
    let pos = market::open<SUI>(&mut mkt, &mut vault, market::side_touch(), stake, &clk, sc.ctx());

    clk.increment_for_testing(100);
    push_obs(&mut oracle, 110_000_000_000, 100);
    po::record(&mut path, &oracle, &clk);

    clk.set_for_testing(EXPIRY + 6_000);
    push_obs(&mut oracle, 110_000_000_000, EXPIRY + 50);

    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle, &clk, sc.ctx());
    assert!(option::is_some(market::fee_snapshot(&mkt)), 0);

    let _ = BOB;
    test_utils::destroy(pos);
    test_utils::destroy(oracle); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}
