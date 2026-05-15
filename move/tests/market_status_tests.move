// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

#[test_only]
module wick::market_status_tests;

use std::string;
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario as ts;
use sui::test_utils;
use wick::market;
use wick::path_observation as po;
use wick::price_observation;
use wick::random_walk_driver;
use wick::wick_oracle::{Self, WickOracle};

const ALICE: address = @0xA;
const BOB: address = @0xB;

const POOL_SEED: u64 = 10_000_000_000;
const STAKE: u64 = 1_000_000_000;
const PAYOUT_BPS: u64 = 18_000;
const EXPIRY: u64 = 1_000;
const STARTING_PRICE: u64 = 100_000_000_000;
const BARRIER: u64 = 105_000_000_000;

fun mint(amount: u64, ctx: &mut TxContext): coin::Coin<SUI> {
    coin::mint_for_testing<SUI>(amount, ctx)
}

fun push_obs(oracle: &mut WickOracle, price: u64, ts: u64) {
    let oid = object::id(oracle);
    let obs = price_observation::new(price, ts, oid);
    wick_oracle::apply_observation_for_testing(oracle, wick_oracle::driver_random_walk(), obs);
}

fun setup(sc: &mut ts::Scenario, clk: &clock::Clock):
    (WickOracle, random_walk_driver::RandomWalk, po::PathObservation, market::Market<SUI>) {
    let (oracle, rw) = random_walk_driver::new_for_testing(
        string::utf8(b"WICK_RNG"), STARTING_PRICE, 50, EXPIRY, clk, sc.ctx(),
    );
    let path = po::new_v2(
        &oracle, BARRIER, po::touch_above(),
        0, 1, 1, 60_000, sc.ctx(),
    );
    let seed = mint(POOL_SEED, sc.ctx());
    let mkt = market::create<SUI>(
        string::utf8(b"S"), &oracle, &path, PAYOUT_BPS, seed, sc.ctx(),
    );
    (oracle, rw, path, mkt)
}

// === Initial status ===

#[test]
fun new_market_starts_active() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    let (oracle, rw, path, mkt) = setup(&mut sc, &clk);

    assert!(market::status(&mkt) == market::status_active(), 0);
    assert!(!market::is_settled(&mkt), 1);
    assert!(option::is_none(market::fee_snapshot(&mkt)), 2);
    assert!(option::is_none(market::settled_at_ms(&mkt)), 3);

    test_utils::destroy(oracle);
    test_utils::destroy(rw);
    test_utils::destroy(path);
    let leftover = market::drain_and_destroy_for_testing<SUI>(mkt, sc.ctx());
    test_utils::destroy(leftover);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun create_v2_records_underlying_and_bucket() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    let (oracle, rw) = random_walk_driver::new_for_testing(
        string::utf8(b"BTC"), STARTING_PRICE, 50, EXPIRY, &clk, sc.ctx(),
    );
    let path = po::new_v2(&oracle, BARRIER, po::touch_above(), 0, 1, 1, 60_000, sc.ctx());
    let seed = mint(POOL_SEED, sc.ctx());
    let mkt = market::create_v2<SUI>(
        string::utf8(b"BTC market"), &oracle, &path, PAYOUT_BPS, 7,  // bucket id 7
        seed, sc.ctx(),
    );
    assert!(string::as_bytes(market::underlying(&mkt)) == &b"BTC", 0);
    assert!(market::correlation_bucket_id(&mkt) == 7, 1);

    test_utils::destroy(oracle);
    test_utils::destroy(rw);
    test_utils::destroy(path);
    let leftover = market::drain_and_destroy_for_testing<SUI>(mkt, sc.ctx());
    test_utils::destroy(leftover);
    clk.destroy_for_testing();
    sc.end();
}

// === Status-gating: open ===

#[test]
#[expected_failure(abort_code = market::ENotActive)]
fun cannot_open_when_not_active() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    let (oracle, rw, path, mut mkt) = setup(&mut sc, &clk);

    market::set_status_for_testing(&mut mkt, market::status_hit());
    let stake = mint(STAKE, sc.ctx());
    let pos = market::open<SUI>(&mut mkt, market::side_touch(), stake, &clk, sc.ctx());

    test_utils::destroy(pos);
    test_utils::destroy(oracle);
    test_utils::destroy(rw);
    test_utils::destroy(path);
    let leftover = market::drain_and_destroy_for_testing<SUI>(mkt, sc.ctx());
    test_utils::destroy(leftover);
    clk.destroy_for_testing();
    sc.end();
}

// === Status-gating: redeem ===

#[test]
#[expected_failure(abort_code = market::EStillActive)]
fun cannot_redeem_when_active() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    let (oracle, rw, path, mut mkt) = setup(&mut sc, &clk);

    let stake = mint(STAKE, sc.ctx());
    let pos = market::open<SUI>(&mut mkt, market::side_touch(), stake, &clk, sc.ctx());
    let payout = market::redeem<SUI>(&mut mkt, pos, &path, &clk, sc.ctx());  // active → abort

    test_utils::destroy(payout);
    test_utils::destroy(oracle);
    test_utils::destroy(rw);
    test_utils::destroy(path);
    let leftover = market::drain_and_destroy_for_testing<SUI>(mkt, sc.ctx());
    test_utils::destroy(leftover);
    clk.destroy_for_testing();
    sc.end();
}

// === lock_and_settle_v1 transitions ===

#[test]
fun lock_and_settle_v1_transitions_to_hit_when_touched() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, rw, mut path, mut mkt) = setup(&mut sc, &clk);

    // Touch happens.
    clk.increment_for_testing(100);
    push_obs(&mut oracle, 110_000_000_000, 100);
    po::record(&mut path, &oracle, &clk);
    assert!(po::is_touched(&path), 0);

    // Past expiry+drain, push settlement obs.
    clk.set_for_testing(EXPIRY + 6_000);
    push_obs(&mut oracle, 110_000_000_000, EXPIRY + 50);

    market::lock_and_settle_v1<SUI>(&mut mkt, &mut path, &mut oracle, &clk, sc.ctx());
    assert!(market::status(&mkt) == market::status_hit(), 1);
    assert!(option::is_some(market::fee_snapshot(&mkt)), 2);
    assert!(option::is_some(market::settled_at_ms(&mkt)), 3);

    test_utils::destroy(oracle);
    test_utils::destroy(rw);
    test_utils::destroy(path);
    let leftover = market::drain_and_destroy_for_testing<SUI>(mkt, sc.ctx());
    test_utils::destroy(leftover);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun lock_and_settle_v1_transitions_to_expired_when_no_touch() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, rw, mut path, mut mkt) = setup(&mut sc, &clk);

    // No touch — push observations below barrier.
    clk.increment_for_testing(100);
    push_obs(&mut oracle, 99_000_000_000, 100);
    po::record(&mut path, &oracle, &clk);

    clk.set_for_testing(EXPIRY + 6_000);
    push_obs(&mut oracle, 99_000_000_000, EXPIRY + 50);

    market::lock_and_settle_v1<SUI>(&mut mkt, &mut path, &mut oracle, &clk, sc.ctx());
    assert!(market::status(&mkt) == market::status_expired(), 0);

    test_utils::destroy(oracle);
    test_utils::destroy(rw);
    test_utils::destroy(path);
    let leftover = market::drain_and_destroy_for_testing<SUI>(mkt, sc.ctx());
    test_utils::destroy(leftover);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun lock_and_settle_v1_transitions_to_aborted_when_too_few_obs() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    // Use higher min_obs so the path Aborts.
    let (mut oracle, rw) = random_walk_driver::new_for_testing(
        string::utf8(b"WICK_RNG"), STARTING_PRICE, 50, EXPIRY, &clk, sc.ctx(),
    );
    let mut path = po::new_v2(
        &oracle, BARRIER, po::touch_above(),
        0, 50, 1, 5_000, sc.ctx(),  // min_obs=50 (impossible), grace 5s
    );
    let seed = mint(POOL_SEED, sc.ctx());
    let mut mkt = market::create<SUI>(
        string::utf8(b"abort"), &oracle, &path, PAYOUT_BPS, seed, sc.ctx(),
    );

    // No observations recorded; jump past expiry+grace+drain.
    clk.set_for_testing(EXPIRY + 6_000);
    market::lock_and_settle_v1<SUI>(&mut mkt, &mut path, &mut oracle, &clk, sc.ctx());

    assert!(market::status(&mkt) == market::status_aborted(), 0);

    test_utils::destroy(oracle);
    test_utils::destroy(rw);
    test_utils::destroy(path);
    let leftover = market::drain_and_destroy_for_testing<SUI>(mkt, sc.ctx());
    test_utils::destroy(leftover);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun lock_and_settle_v1_idempotent_returns_early() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, rw, mut path, mut mkt) = setup(&mut sc, &clk);

    clk.increment_for_testing(100);
    push_obs(&mut oracle, 99_000_000_000, 100);
    po::record(&mut path, &oracle, &clk);

    clk.set_for_testing(EXPIRY + 6_000);
    push_obs(&mut oracle, 99_000_000_000, EXPIRY + 50);

    market::lock_and_settle_v1<SUI>(&mut mkt, &mut path, &mut oracle, &clk, sc.ctx());
    let first_status = market::status(&mkt);

    // Second call: must return early, no state mutation.
    market::lock_and_settle_v1<SUI>(&mut mkt, &mut path, &mut oracle, &clk, sc.ctx());
    assert!(market::status(&mkt) == first_status, 0);

    test_utils::destroy(oracle);
    test_utils::destroy(rw);
    test_utils::destroy(path);
    let leftover = market::drain_and_destroy_for_testing<SUI>(mkt, sc.ctx());
    test_utils::destroy(leftover);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun fee_snapshot_captured_at_lock() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, rw, mut path, mut mkt) = setup(&mut sc, &clk);

    let stake = mint(STAKE, sc.ctx());
    let pos = market::open<SUI>(&mut mkt, market::side_touch(), stake, &clk, sc.ctx());

    clk.increment_for_testing(100);
    push_obs(&mut oracle, 110_000_000_000, 100);
    po::record(&mut path, &oracle, &clk);

    clk.set_for_testing(EXPIRY + 6_000);
    push_obs(&mut oracle, 110_000_000_000, EXPIRY + 50);

    market::lock_and_settle_v1<SUI>(&mut mkt, &mut path, &mut oracle, &clk, sc.ctx());
    let snap_opt = market::fee_snapshot(&mkt);
    assert!(option::is_some(snap_opt), 0);

    let _ = BOB;
    test_utils::destroy(pos);
    test_utils::destroy(oracle);
    test_utils::destroy(rw);
    test_utils::destroy(path);
    let leftover = market::drain_and_destroy_for_testing<SUI>(mkt, sc.ctx());
    test_utils::destroy(leftover);
    clk.destroy_for_testing();
    sc.end();
}
