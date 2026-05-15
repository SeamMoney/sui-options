// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

#[test_only]
module wick::market_tests;

use std::string;
use sui::clock;
use sui::sui::SUI;
use sui::test_scenario as ts;
use sui::test_utils;
use wick::market;
use wick::martingaler_vault as mv;
use wick::path_observation as po;
use wick::price_observation;
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
fun touch_wins_when_barrier_crossed_then_settled() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, rw, mut path, mut mkt, mut vault, vcap, mut clk) =
        h::setup_market_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);

    // Bob opens TOUCH.
    let stake = h::mint_sui(STAKE, &mut sc);
    let bob_pos = market::open<SUI>(&mut mkt, &mut vault, market::side_touch(), stake, &clk, sc.ctx());
    assert!(market::touch_exposure(&mkt) == 1_800_000_000, 0);

    // Touch happens.
    clk.increment_for_testing(500);
    push_obs(&mut oracle, 110_000_000_000, 500);
    po::record(&mut path, &oracle, &clk);
    assert!(po::is_touched(&path), 1);

    // Settle past expiry+drain.
    clk.set_for_testing(EXPIRY + 6_000);
    push_obs(&mut oracle, 110_000_000_000, EXPIRY + 50);
    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle, &clk, sc.ctx());
    assert!(market::status(&mkt) == market::status_hit(), 2);

    // Bob redeems → wins 1.8 SUI from the per-market lock.
    let payout = market::redeem<SUI>(&mut mkt, &mut vault, bob_pos, &clk, sc.ctx());
    assert!(payout.value() == 1_800_000_000, 3);
    test_utils::destroy(payout);

    test_utils::destroy(oracle); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun no_touch_wins_when_barrier_never_crossed() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, rw, mut path, mut mkt, mut vault, vcap, mut clk) =
        h::setup_market_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);

    let stake = h::mint_sui(STAKE, &mut sc);
    let pos = market::open<SUI>(&mut mkt, &mut vault, market::side_no_touch(), stake, &clk, sc.ctx());

    // Push observations below barrier.
    clk.increment_for_testing(500);
    push_obs(&mut oracle, 99_000_000_000, 500);
    po::record(&mut path, &oracle, &clk);
    clk.increment_for_testing(500);

    clk.set_for_testing(EXPIRY + 6_000);
    push_obs(&mut oracle, 102_000_000_000, EXPIRY + 50);
    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle, &clk, sc.ctx());
    assert!(market::status(&mkt) == market::status_expired(), 0);

    let payout = market::redeem<SUI>(&mut mkt, &mut vault, pos, &clk, sc.ctx());
    assert!(payout.value() == 1_800_000_000, 1);
    test_utils::destroy(payout);

    test_utils::destroy(oracle); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun loser_receives_zero_payout_and_position_burns() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, rw, mut path, mut mkt, mut vault, vcap, mut clk) =
        h::setup_market_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);

    // Bob opens NO_TOUCH but price wicks above.
    let stake = h::mint_sui(STAKE, &mut sc);
    let bob = market::open<SUI>(&mut mkt, &mut vault, market::side_no_touch(), stake, &clk, sc.ctx());

    clk.increment_for_testing(500);
    push_obs(&mut oracle, 110_000_000_000, 500);
    po::record(&mut path, &oracle, &clk);

    clk.set_for_testing(EXPIRY + 6_000);
    push_obs(&mut oracle, 110_000_000_000, EXPIRY + 50);
    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle, &clk, sc.ctx());

    let payout = market::redeem<SUI>(&mut mkt, &mut vault, bob, &clk, sc.ctx());
    assert!(payout.value() == 0, 0);
    test_utils::destroy(payout);

    let _ = BOB;
    test_utils::destroy(oracle); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = market::EAfterExpiry)]
fun cannot_open_after_expiry() {
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, path, mut mkt, mut vault, vcap, mut clk) =
        h::setup_market_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);

    clk.set_for_testing(EXPIRY + 1);
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
#[expected_failure(abort_code = market::EStillActive)]
fun cannot_redeem_when_active() {
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, path, mut mkt, mut vault, vcap, clk) =
        h::setup_market_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);

    let stake = h::mint_sui(STAKE, &mut sc);
    let pos = market::open<SUI>(&mut mkt, &mut vault, market::side_touch(), stake, &clk, sc.ctx());
    let payout = market::redeem<SUI>(&mut mkt, &mut vault, pos, &clk, sc.ctx());

    test_utils::destroy(payout);
    test_utils::destroy(oracle); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun two_sided_market_clears_correctly() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, rw, mut path, mut mkt, mut vault, vcap, mut clk) =
        h::setup_market_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);

    let stake_a = h::mint_sui(STAKE, &mut sc);
    let alice_pos = market::open<SUI>(&mut mkt, &mut vault, market::side_touch(), stake_a, &clk, sc.ctx());
    let stake_b = h::mint_sui(STAKE, &mut sc);
    let bob_pos = market::open<SUI>(&mut mkt, &mut vault, market::side_no_touch(), stake_b, &clk, sc.ctx());

    clk.increment_for_testing(500);
    push_obs(&mut oracle, 120_000_000_000, 500);
    po::record(&mut path, &oracle, &clk);

    clk.set_for_testing(EXPIRY + 6_000);
    push_obs(&mut oracle, 120_000_000_000, EXPIRY + 50);
    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle, &clk, sc.ctx());

    let alice_payout = market::redeem<SUI>(&mut mkt, &mut vault, alice_pos, &clk, sc.ctx());
    let bob_payout = market::redeem<SUI>(&mut mkt, &mut vault, bob_pos, &clk, sc.ctx());
    assert!(alice_payout.value() == 1_800_000_000, 0);  // Touch wins
    assert!(bob_payout.value() == 0, 1);                 // NoTouch loses

    test_utils::destroy(alice_payout);
    test_utils::destroy(bob_payout);
    let _ = BOB;
    test_utils::destroy(oracle); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}

// === C.3.3 specific tests ===

#[test]
fun lock_and_settle_dispatches_aborted_routes_to_pool() {
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, mut path, mut mkt, mut vault, vcap, mut clk) =
        h::setup_market_world_with_path_params(
            &mut sc, EXPIRY, 50, 1, 5_000, 5_000,  // min_obs=50 forces Aborted
        );
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);

    let mut oracle_mut = oracle;

    let stake_a = h::mint_sui(STAKE, &mut sc);
    let alice_pos = market::open<SUI>(&mut mkt, &mut vault, market::side_touch(), stake_a, &clk, sc.ctx());
    let stake_b = h::mint_sui(STAKE, &mut sc);
    let bob_pos = market::open<SUI>(&mut mkt, &mut vault, market::side_no_touch(), stake_b, &clk, sc.ctx());

    // Past expiry+grace+drain — Aborted.
    clk.set_for_testing(EXPIRY + 11_000);
    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle_mut, &clk, sc.ctx());
    assert!(market::status(&mkt) == market::status_aborted(), 0);
    // Both stakes routed to abort_refund_pool.
    assert!(mv::abort_pool_value(&vault, object::id(&mkt)) == 2 * STAKE, 1);

    let p_a = market::redeem<SUI>(&mut mkt, &mut vault, alice_pos, &clk, sc.ctx());
    let p_b = market::redeem<SUI>(&mut mkt, &mut vault, bob_pos, &clk, sc.ctx());
    assert!(p_a.value() == STAKE, 2);
    assert!(p_b.value() == STAKE, 3);
    // Pool fully drained.
    assert!(mv::abort_pool_value(&vault, object::id(&mkt)) == 0, 4);
    // No residue (we routed only sum-of-stakes, not gross obligation).
    let _ = BOB;
    test_utils::destroy(p_a); test_utils::destroy(p_b);
    test_utils::destroy(oracle_mut); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun lock_and_settle_idempotent() {
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

    // Second call: returns early, no state mutation, no double-reserve.
    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle, &clk, sc.ctx());
    assert!(market::status(&mkt) == first_status, 0);

    test_utils::destroy(oracle); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun shortfall_winner_gets_partial_then_enqueued() {
    // Vault under-seeded relative to obligation → winner gets what's
    // available + queue entry for the rest.
    let mut sc = ts::begin(ALICE);
    let (mut oracle, rw, mut path, mut mkt, mut vault, vcap, mut clk) =
        h::setup_market_world(&mut sc);
    // Seed only $0.5 — far less than 1.8x obligation on a 1 SUI stake.
    h::seed_vault(&mut vault, 500_000_000, &clk, &mut sc);

    let stake = h::mint_sui(STAKE, &mut sc);
    let pos = market::open<SUI>(&mut mkt, &mut vault, market::side_touch(), stake, &clk, sc.ctx());

    clk.increment_for_testing(100);
    push_obs(&mut oracle, 110_000_000_000, 100);
    po::record(&mut path, &oracle, &clk);

    clk.set_for_testing(EXPIRY + 6_000);
    push_obs(&mut oracle, 110_000_000_000, EXPIRY + 50);
    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle, &clk, sc.ctx());
    // Lock = full 1.8 SUI obligation reserved from treasury (which had 1.5 SUI:
    // 0.5 seed + 1.0 stake). All of it goes into the lock.
    assert!(mv::lock_value(&vault, object::id(&mkt)) == 1_500_000_000, 0);

    let payout = market::redeem<SUI>(&mut mkt, &mut vault, pos, &clk, sc.ctx());
    // Winner gets the 1.5 SUI cash that was in the lock; 0.3 SUI shortfall enqueues.
    assert!(payout.value() == 1_500_000_000, 1);
    assert!(mv::queue_total(&vault) == 300_000_000, 2);
    assert!(mv::queue_length(&vault) == 1, 3);

    test_utils::destroy(payout);
    test_utils::destroy(oracle); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun aborted_recover_seed_idempotent_no_residue_when_empty() {
    // After Aborted refunds drain the pool fully, recover_aborted_seed is a no-op
    // (nothing to recover — we only routed stakes, not gross obligation).
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, mut path, mut mkt, mut vault, vcap, mut clk) =
        h::setup_market_world_with_path_params(
            &mut sc, EXPIRY, 50, 1, 5_000, 5_000,
        );
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);
    let mut oracle_mut = oracle;

    let stake_a = h::mint_sui(STAKE, &mut sc);
    let pos_a = market::open<SUI>(&mut mkt, &mut vault, market::side_touch(), stake_a, &clk, sc.ctx());

    clk.set_for_testing(EXPIRY + 11_000);
    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle_mut, &clk, sc.ctx());

    let p_a = market::redeem<SUI>(&mut mkt, &mut vault, pos_a, &clk, sc.ctx());
    assert!(p_a.value() == STAKE, 0);

    // Pool is empty; admin sweep is no-op.
    let treasury_before = mv::treasury_value(&vault);
    mv::admin_recover_aborted_seed<SUI>(&vcap, &mut vault, object::id(&mkt));
    assert!(mv::treasury_value(&vault) == treasury_before, 1);

    test_utils::destroy(p_a);
    test_utils::destroy(oracle_mut); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}
