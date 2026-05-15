// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

#[test_only]
module wick::market_tests;

use std::string;
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario as ts;
use wick::market;
use wick::path_observation;
use wick::price_observation;
use wick::random_walk_driver;
use wick::wick_oracle::{Self, WickOracle};

const ALICE: address = @0xA;
const BOB: address = @0xB;

const POOL_SEED: u64 = 10_000_000_000;       // 10 SUI
const STAKE: u64 = 1_000_000_000;            // 1 SUI
const PAYOUT_BPS: u64 = 18_000;              // 1.8x
const EXPIRY: u64 = 1_000_000;
const STARTING_PRICE: u64 = 100_000_000_000; // 100.0
const BARRIER_ABOVE: u64 = 105_000_000_000;  // 105.0

// ---------- helpers ----------

fun mint_sui(amount: u64, ctx: &mut TxContext): coin::Coin<SUI> {
    coin::mint_for_testing<SUI>(amount, ctx)
}

fun push_obs(oracle: &mut WickOracle, price: u64, ts: u64) {
    let oid = object::id(oracle);
    let obs = price_observation::new(price, ts, oid);
    wick_oracle::apply_observation_for_testing(
        oracle,
        wick_oracle::driver_random_walk(),
        obs,
    );
}

// ---------- happy paths ----------

#[test]
fun touch_wins_when_barrier_crossed_then_settled() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());

    let (mut oracle, _rw) = random_walk_driver::new_for_testing(
        string::utf8(b"WICK_RNG"),
        STARTING_PRICE,
        50,
        EXPIRY,
        &clk,
        sc.ctx(),
    );
    // Use v2 constructor with relaxed settings (min_obs=1, confirmations=1)
    // so these market-mechanics tests don't need to push 3 confirmation ticks
    // and 6 observations. Path-hardening behavior is tested in foundation_v2_tests.
    let mut path = path_observation::new_v2(
        &oracle,
        BARRIER_ABOVE,
        path_observation::touch_above(),
        0,  // buffer_bps
        1,  // min_observations
        1,  // touch_confirmations_required
        60_000,  // grace_ms
        sc.ctx(),
    );

    let seed = mint_sui(POOL_SEED, sc.ctx());
    let mut mkt = market::create<SUI>(
        string::utf8(b"WICK_RNG touch 105"),
        &oracle,
        &path,
        PAYOUT_BPS,
        seed,
        sc.ctx(),
    );

    // Bob opens a TOUCH position.
    let stake = mint_sui(STAKE, sc.ctx());
    let bob_pos = market::open<SUI>(&mut mkt, market::side_touch(), stake, &clk, sc.ctx());
    assert!(market::touch_exposure(&mkt) == 1_800_000_000, 0);
    // Vault grew by stake.
    assert!(market::vault_balance(&mkt) == POOL_SEED + STAKE, 1);

    // Push a barrier-crossing tick.
    clk.increment_for_testing(500);
    push_obs(&mut oracle, 110_000_000_000, 500);
    path_observation::record(&mut path, &oracle, &clk);
    assert!(path_observation::is_touched(&path), 2);

    // Settle: jump past expiry, push a post-expiry obs, lock.
    clk.set_for_testing(EXPIRY + 6_000);  // past pre_lock_drain_ms (5s default)
    push_obs(&mut oracle, 110_000_000_000, EXPIRY + 50);
    market::lock_and_settle_v1<SUI>(&mut mkt, &mut path, &mut oracle, &clk, sc.ctx());
    assert!(wick_oracle::is_settled(&oracle), 3);

    // Bob redeems → wins 1.8 SUI.
    let payout = market::redeem<SUI>(&mut mkt, bob_pos, &path, &clk, sc.ctx());
    assert!(payout.value() == 1_800_000_000, 4);
    // Vault must equal seed + stake - payout.
    assert!(market::vault_balance(&mkt) == POOL_SEED + STAKE - 1_800_000_000, 5);
    assert!(market::touch_exposure(&mkt) == 0, 6);
    sui::test_utils::destroy(payout);

    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(_rw);
    sui::test_utils::destroy(path);
    let leftover = market::drain_and_destroy_for_testing<SUI>(mkt, sc.ctx());
    sui::test_utils::destroy(leftover);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun no_touch_wins_when_barrier_never_crossed() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());

    let (mut oracle, _rw) = random_walk_driver::new_for_testing(
        string::utf8(b"WICK_RNG"),
        STARTING_PRICE,
        50,
        EXPIRY,
        &clk,
        sc.ctx(),
    );
    // Use v2 constructor with relaxed settings (min_obs=1, confirmations=1)
    // so these market-mechanics tests don't need to push 3 confirmation ticks
    // and 6 observations. Path-hardening behavior is tested in foundation_v2_tests.
    let mut path = path_observation::new_v2(
        &oracle,
        BARRIER_ABOVE,
        path_observation::touch_above(),
        0,  // buffer_bps
        1,  // min_observations
        1,  // touch_confirmations_required
        60_000,  // grace_ms
        sc.ctx(),
    );

    let seed = mint_sui(POOL_SEED, sc.ctx());
    let mut mkt = market::create<SUI>(
        string::utf8(b"WICK_RNG no-touch 105"),
        &oracle,
        &path,
        PAYOUT_BPS,
        seed,
        sc.ctx(),
    );

    // Alice opens a NO-TOUCH position.
    let stake = mint_sui(STAKE, sc.ctx());
    let pos = market::open<SUI>(&mut mkt, market::side_no_touch(), stake, &clk, sc.ctx());
    assert!(market::no_touch_exposure(&mkt) == 1_800_000_000, 0);

    // Push observations that stay strictly below the barrier.
    clk.increment_for_testing(500);
    push_obs(&mut oracle, 99_000_000_000, 500);
    path_observation::record(&mut path, &oracle, &clk);
    clk.increment_for_testing(500);
    push_obs(&mut oracle, 102_000_000_000, 1_000);
    path_observation::record(&mut path, &oracle, &clk);
    assert!(!path_observation::is_touched(&path), 1);

    // Settle.
    clk.set_for_testing(EXPIRY + 6_000);  // past pre_lock_drain_ms (5s default)
    push_obs(&mut oracle, 102_000_000_000, EXPIRY + 50);
    market::lock_and_settle_v1<SUI>(&mut mkt, &mut path, &mut oracle, &clk, sc.ctx());

    let payout = market::redeem<SUI>(&mut mkt, pos, &path, &clk, sc.ctx());
    assert!(payout.value() == 1_800_000_000, 2);
    sui::test_utils::destroy(payout);

    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(_rw);
    sui::test_utils::destroy(path);
    let leftover = market::drain_and_destroy_for_testing<SUI>(mkt, sc.ctx());
    sui::test_utils::destroy(leftover);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun loser_receives_zero_payout_and_position_burns() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, _rw) = random_walk_driver::new_for_testing(
        string::utf8(b"WICK_RNG"),
        STARTING_PRICE,
        50,
        EXPIRY,
        &clk,
        sc.ctx(),
    );
    // Use v2 constructor with relaxed settings (min_obs=1, confirmations=1)
    // so these market-mechanics tests don't need to push 3 confirmation ticks
    // and 6 observations. Path-hardening behavior is tested in foundation_v2_tests.
    let mut path = path_observation::new_v2(
        &oracle,
        BARRIER_ABOVE,
        path_observation::touch_above(),
        0,  // buffer_bps
        1,  // min_observations
        1,  // touch_confirmations_required
        60_000,  // grace_ms
        sc.ctx(),
    );
    let seed = mint_sui(POOL_SEED, sc.ctx());
    let mut mkt = market::create<SUI>(
        string::utf8(b"L"),
        &oracle, &path, PAYOUT_BPS, seed, sc.ctx(),
    );

    // Bob opens NO_TOUCH but the price wicks above.
    let stake = mint_sui(STAKE, sc.ctx());
    let bob = market::open<SUI>(&mut mkt, market::side_no_touch(), stake, &clk, sc.ctx());

    clk.increment_for_testing(500);
    push_obs(&mut oracle, 110_000_000_000, 500);
    path_observation::record(&mut path, &oracle, &clk);

    clk.set_for_testing(EXPIRY + 6_000);  // past pre_lock_drain_ms (5s default)
    push_obs(&mut oracle, 110_000_000_000, EXPIRY + 50);
    market::lock_and_settle_v1<SUI>(&mut mkt, &mut path, &mut oracle, &clk, sc.ctx());

    let payout = market::redeem<SUI>(&mut mkt, bob, &path, &clk, sc.ctx());
    assert!(payout.value() == 0, 0);
    sui::test_utils::destroy(payout);

    // Vault retained the stake.
    assert!(market::vault_balance(&mkt) == POOL_SEED + STAKE, 1);

    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(_rw);
    sui::test_utils::destroy(path);
    let leftover = market::drain_and_destroy_for_testing<SUI>(mkt, sc.ctx());
    sui::test_utils::destroy(leftover);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = market::EAfterExpiry)]
fun cannot_open_after_expiry() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (oracle, _rw) = random_walk_driver::new_for_testing(
        string::utf8(b"R"),
        STARTING_PRICE,
        50,
        EXPIRY,
        &clk,
        sc.ctx(),
    );
    let path = path_observation::new(
        &oracle,
        BARRIER_ABOVE,
        path_observation::touch_above(),
        sc.ctx(),
    );
    let seed = mint_sui(POOL_SEED, sc.ctx());
    let mut mkt = market::create<SUI>(
        string::utf8(b"R"),
        &oracle, &path, PAYOUT_BPS, seed, sc.ctx(),
    );
    clk.set_for_testing(EXPIRY + 1);
    let stake = mint_sui(STAKE, sc.ctx());
    let pos = market::open<SUI>(&mut mkt, market::side_touch(), stake, &clk, sc.ctx());
    sui::test_utils::destroy(pos);
    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(_rw);
    sui::test_utils::destroy(path);
    let leftover = market::drain_and_destroy_for_testing<SUI>(mkt, sc.ctx());
    sui::test_utils::destroy(leftover);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = market::EStillActive)]
fun cannot_redeem_before_expiry() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (oracle, _rw) = random_walk_driver::new_for_testing(
        string::utf8(b"R"),
        STARTING_PRICE,
        50,
        EXPIRY,
        &clk,
        sc.ctx(),
    );
    let path = path_observation::new(
        &oracle,
        BARRIER_ABOVE,
        path_observation::touch_above(),
        sc.ctx(),
    );
    let seed = mint_sui(POOL_SEED, sc.ctx());
    let mut mkt = market::create<SUI>(
        string::utf8(b"R"),
        &oracle, &path, PAYOUT_BPS, seed, sc.ctx(),
    );
    let stake = mint_sui(STAKE, sc.ctx());
    let pos = market::open<SUI>(&mut mkt, market::side_touch(), stake, &clk, sc.ctx());
    // Try to redeem immediately — must abort.
    let payout = market::redeem<SUI>(&mut mkt, pos, &path, &clk, sc.ctx());
    sui::test_utils::destroy(payout);
    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(_rw);
    sui::test_utils::destroy(path);
    let leftover = market::drain_and_destroy_for_testing<SUI>(mkt, sc.ctx());
    sui::test_utils::destroy(leftover);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun two_sided_market_clears_correctly() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, _rw) = random_walk_driver::new_for_testing(
        string::utf8(b"R"),
        STARTING_PRICE,
        50,
        EXPIRY,
        &clk,
        sc.ctx(),
    );
    // Use v2 constructor with relaxed settings (min_obs=1, confirmations=1)
    // so these market-mechanics tests don't need to push 3 confirmation ticks
    // and 6 observations. Path-hardening behavior is tested in foundation_v2_tests.
    let mut path = path_observation::new_v2(
        &oracle,
        BARRIER_ABOVE,
        path_observation::touch_above(),
        0,  // buffer_bps
        1,  // min_observations
        1,  // touch_confirmations_required
        60_000,  // grace_ms
        sc.ctx(),
    );
    let seed = mint_sui(POOL_SEED, sc.ctx());
    let mut mkt = market::create<SUI>(
        string::utf8(b"R"),
        &oracle, &path, PAYOUT_BPS, seed, sc.ctx(),
    );

    let stake_a = mint_sui(STAKE, sc.ctx());
    let alice_pos = market::open<SUI>(&mut mkt, market::side_touch(), stake_a, &clk, sc.ctx());
    let stake_b = mint_sui(STAKE, sc.ctx());
    let bob_pos = market::open<SUI>(&mut mkt, market::side_no_touch(), stake_b, &clk, sc.ctx());

    // Touch happens.
    clk.increment_for_testing(500);
    push_obs(&mut oracle, 120_000_000_000, 500);
    path_observation::record(&mut path, &oracle, &clk);

    clk.set_for_testing(EXPIRY + 6_000);  // past pre_lock_drain_ms (5s default)
    push_obs(&mut oracle, 120_000_000_000, EXPIRY + 50);
    market::lock_and_settle_v1<SUI>(&mut mkt, &mut path, &mut oracle, &clk, sc.ctx());

    let alice_payout = market::redeem<SUI>(&mut mkt, alice_pos, &path, &clk, sc.ctx());
    let bob_payout = market::redeem<SUI>(&mut mkt, bob_pos, &path, &clk, sc.ctx());
    assert!(alice_payout.value() == 1_800_000_000, 0);
    assert!(bob_payout.value() == 0, 1);
    // Vault: seed + 2*stake - 1.8 SUI = 10 + 2 - 1.8 = 10.2 SUI
    assert!(market::vault_balance(&mkt) == 10_200_000_000, 2);
    sui::test_utils::destroy(alice_payout);
    sui::test_utils::destroy(bob_payout);

    let _ = BOB;
    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(_rw);
    sui::test_utils::destroy(path);
    let leftover = market::drain_and_destroy_for_testing<SUI>(mkt, sc.ctx());
    sui::test_utils::destroy(leftover);
    clk.destroy_for_testing();
    sc.end();
}
