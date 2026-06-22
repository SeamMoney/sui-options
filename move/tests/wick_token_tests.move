// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

#[test_only]
#[allow(deprecated_usage)]
module wick::wick_token_tests;

use sui::clock;
use sui::coin;
use sui::test_scenario as ts;
use sui::test_utils;
use wick::wick_token::{Self as wt, WickTokenState, WICK_TOKEN};

const ALICE: address = @0xA;
const BOB: address = @0xB;
const CAROL: address = @0xC;

fun init_state(sc: &mut ts::Scenario): (WickTokenState, wt::WickAdminCap, clock::Clock) {
    let (state, cap) = wt::init_for_testing(sc.ctx());
    let mut clk = clock::create_for_testing(sc.ctx());
    clk.set_for_testing(1_000_000_000);
    (state, cap, clk)
}

#[test]
fun init_state_starts_empty() {
    let mut sc = ts::begin(ALICE);
    let (state, cap, clk) = init_state(&mut sc);

    assert!(wt::hwm_lp_gain_micro_usd(&state) == 0, 0);
    assert!(wt::genesis_start_ms(&state) == 0, 1);
    assert!(wt::cumulative_minted(&state) == 0, 2);
    assert!(wt::total_supply(&state) == 0, 3);
    assert!(wt::flat_rate(&state) == 100_000, 4);
    assert!(wt::threshold_micro_usd(&state) == 20_000_000_000, 5);

    test_utils::destroy(state);
    test_utils::destroy(cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun current_rate_in_flat_region() {
    let mut sc = ts::begin(ALICE);
    let (state, cap, clk) = init_state(&mut sc);

    // HWM = 0, below threshold → flat rate
    assert!(wt::current_rate_per_micro_usd(&state) == 100_000, 0);

    test_utils::destroy(state);
    test_utils::destroy(cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun mint_with_dampener_off_uses_flat_rate() {
    let mut sc = ts::begin(ALICE);
    let (mut state, cap, clk) = init_state(&mut sc);
    // genesis_start_ms == 0 means dampener inactive (0 + 7days < clock = 1e9 → true means active...)
    // wait, check: is_dampener_active returns false when genesis_start_ms == 0.
    // good — dampener inactive at start.

    // Mint 1M micro-USD = $1
    let minted = wt::test_mint_to_loser(&mut state, BOB, 1_000_000, true, &clk, sc.ctx());
    // rate = 100_000 base WICK per micro-USD; 1M micro-USD × 100_000 = 1e11 base WICK = 100 WICK whole
    assert!(minted == 100_000_000_000, 0);
    assert!(wt::total_supply(&state) == 100_000_000_000, 1);
    assert!(wt::hwm_lp_gain_micro_usd(&state) == 1_000_000, 2);

    test_utils::destroy(state);
    test_utils::destroy(cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun mint_zero_loss_returns_zero() {
    let mut sc = ts::begin(ALICE);
    let (mut state, cap, clk) = init_state(&mut sc);

    let minted = wt::test_mint_to_loser(&mut state, BOB, 0, true, &clk, sc.ctx());
    assert!(minted == 0, 0);
    assert!(wt::total_supply(&state) == 0, 1);

    test_utils::destroy(state);
    test_utils::destroy(cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun mint_bot_ineligible_returns_zero() {
    let mut sc = ts::begin(ALICE);
    let (mut state, cap, clk) = init_state(&mut sc);

    let minted = wt::test_mint_to_loser(&mut state, BOB, 1_000_000, false, &clk, sc.ctx());
    assert!(minted == 0, 0);
    assert!(wt::total_supply(&state) == 0, 1);

    test_utils::destroy(state);
    test_utils::destroy(cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun hwm_strictly_monotone() {
    let mut sc = ts::begin(ALICE);
    let (mut state, cap, clk) = init_state(&mut sc);

    let _ = wt::test_mint_to_loser(&mut state, BOB, 5_000_000, true, &clk, sc.ctx());  // $5
    assert!(wt::hwm_lp_gain_micro_usd(&state) == 5_000_000, 0);

    let _ = wt::test_mint_to_loser(&mut state, BOB, 3_000_000, true, &clk, sc.ctx());  // $3 more
    assert!(wt::hwm_lp_gain_micro_usd(&state) == 8_000_000, 1);

    let _ = wt::test_mint_to_loser(&mut state, CAROL, 1_000_000, true, &clk, sc.ctx());  // $1 more
    assert!(wt::hwm_lp_gain_micro_usd(&state) == 9_000_000, 2);

    test_utils::destroy(state);
    test_utils::destroy(cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun rate_decays_above_threshold() {
    let mut sc = ts::begin(ALICE);
    let (mut state, cap, clk) = init_state(&mut sc);

    // Push HWM to just past threshold ($20k = 20e9 micro-USD)
    // To do this we'd need to mint 20k worth, but dampener limits us to $50/day.
    // Instead, with dampener inactive, mint in chunks until past threshold.
    // Hmm — flat region is up to $20k. Beyond $20k, decay starts.

    // Set HWM artificially? No public function. Work around: many small mints.
    // For test purposes with dampener inactive, mint $1k 25 times = $25k → past threshold.

    let mut i = 0;
    while (i < 25) {
        let _ = wt::test_mint_to_loser(&mut state, BOB, 1_000_000_000, true, &clk, sc.ctx());  // $1000
        i = i + 1;
    };

    let hwm = wt::hwm_lp_gain_micro_usd(&state);
    assert!(hwm == 25_000_000_000, 0);  // $25k

    let rate = wt::current_rate_per_micro_usd(&state);
    // h = 25k - 20k = 5k. s = 1.2M.
    // rate = 100_000 × (1.2M / (1.2M + 5k))² = 100_000 × (1200/1205)² ≈ 100_000 × 0.992 ≈ 99_173
    // Close to flat but slightly below
    assert!(rate < 100_000, 1);
    assert!(rate > 99_000, 2);  // not too much decay yet

    test_utils::destroy(state);
    test_utils::destroy(cap);
    clk.destroy_for_testing();
    sc.end();
}

// === Dampener tests ===

#[test]
fun dampener_active_when_genesis_set() {
    let mut sc = ts::begin(ALICE);
    let (mut state, cap, mut clk) = init_state(&mut sc);

    wt::init_genesis(&cap, &mut state, &clk);
    assert!(wt::is_dampener_active(&state, &clk), 0);

    // Move clock 6 days forward — still active
    clk.increment_for_testing(6 * 86_400_000);
    assert!(wt::is_dampener_active(&state, &clk), 1);

    // Move past 7 days — inactive
    clk.increment_for_testing(2 * 86_400_000);
    assert!(!wt::is_dampener_active(&state, &clk), 2);

    test_utils::destroy(state);
    test_utils::destroy(cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun dampener_caps_daily_mint_per_address() {
    let mut sc = ts::begin(ALICE);
    let (mut state, cap, clk) = init_state(&mut sc);
    wt::init_genesis(&cap, &mut state, &clk);
    // dampener cap = $50 = 50_000_000 micro-USD per address per day

    // Try to mint $100 from BOB
    let minted = wt::test_mint_to_loser(&mut state, BOB, 100_000_000, true, &clk, sc.ctx());
    // Should be capped at $50 worth
    // $50 × 100_000 (rate) = 5_000_000_000 base WICK
    assert!(minted == 5_000_000_000_000, 0);  // 5000 WICK = 50 USD × 100 WICK/USD × 1e9 decimals
    assert!(wt::hwm_lp_gain_micro_usd(&state) == 50_000_000, 1);  // only $50 consumed

    // Try another mint — should be 0 (cap reached)
    let minted2 = wt::test_mint_to_loser(&mut state, BOB, 1_000_000, true, &clk, sc.ctx());
    assert!(minted2 == 0, 2);

    // CAROL can still mint — cap is per-address
    let minted3 = wt::test_mint_to_loser(&mut state, CAROL, 50_000_000, true, &clk, sc.ctx());
    assert!(minted3 > 0, 3);

    test_utils::destroy(state);
    test_utils::destroy(cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun dampener_resets_after_day_rollover() {
    let mut sc = ts::begin(ALICE);
    let (mut state, cap, mut clk) = init_state(&mut sc);
    wt::init_genesis(&cap, &mut state, &clk);

    // Day 0: mint $50 (cap)
    let m1 = wt::test_mint_to_loser(&mut state, BOB, 50_000_000, true, &clk, sc.ctx());
    assert!(m1 == 5_000_000_000_000, 0);

    // Move clock 1 day
    clk.increment_for_testing(86_400_000);

    // Day 1: BOB can mint $50 again
    let m2 = wt::test_mint_to_loser(&mut state, BOB, 50_000_000, true, &clk, sc.ctx());
    assert!(m2 == 5_000_000_000_000, 1);
    // HWM advanced by both days' mints
    assert!(wt::hwm_lp_gain_micro_usd(&state) == 100_000_000, 2);  // $100 total

    test_utils::destroy(state);
    test_utils::destroy(cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun dampener_inactive_after_seven_days() {
    let mut sc = ts::begin(ALICE);
    let (mut state, cap, mut clk) = init_state(&mut sc);
    wt::init_genesis(&cap, &mut state, &clk);

    clk.increment_for_testing(8 * 86_400_000);  // day 8

    // Should now allow large mints unimpeded
    let minted = wt::test_mint_to_loser(&mut state, BOB, 1_000_000_000, true, &clk, sc.ctx());  // $1k
    assert!(minted == 100_000_000_000_000, 0);  // 1e9 × 100_000 = 1e14
    assert!(wt::hwm_lp_gain_micro_usd(&state) == 1_000_000_000, 1);

    test_utils::destroy(state);
    test_utils::destroy(cap);
    clk.destroy_for_testing();
    sc.end();
}

// === Coin minted to loser is transferred ===

#[test]
fun mint_transfers_coin_to_loser_address() {
    let mut sc = ts::begin(ALICE);
    let (mut state, cap, clk) = init_state(&mut sc);

    let minted = wt::test_mint_to_loser(&mut state, BOB, 1_000_000, true, &clk, sc.ctx());
    assert!(minted > 0, 0);

    sc.next_tx(BOB);
    let bob_wick = sc.take_from_address<coin::Coin<WICK_TOKEN>>(BOB);
    assert!(bob_wick.value() == minted, 1);
    test_utils::destroy(bob_wick);

    test_utils::destroy(state);
    test_utils::destroy(cap);
    clk.destroy_for_testing();
    sc.end();
}
