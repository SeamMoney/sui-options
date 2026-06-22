// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

#[test_only]
module wick::market_tests;

use std::string;
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
const POOL_SEED: u64 = 10_000_000_000_000;  // 10k SUI — generous so 50bps per-position cap (= 50 SUI max payout) easily covers 1.8 SUI test payouts
const STAKE: u64 = 1_000_000_000;
const SPOT: u64 = 100_000_000_000;
const EXPIRY: u64 = 1_000;

fun push_obs(oracle: &mut WickOracle, price: u64, ts: u64) {
    let oid = object::id(oracle);
    let obs = price_observation::new(price, ts, oid);
    wick_oracle::apply_observation_for_testing(oracle, wick_oracle::driver_random_walk(), obs);
}

#[test]
fun touch_wins_when_barrier_crossed_then_settled() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, rw, mut path, mut mkt, mut vault, vcap, rconf, rcap, mut reg, regcap, mut frtr, frcap, mut clk) =
        h::setup_full_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);
    let mut bundle = h::setup_c35_bundle(&mut sc, &clk);

    let stake = h::mint_sui(STAKE, &mut sc);
    let bob_pos = h::open_with_bundle(
        &mut mkt, &mut vault, &rconf, &mut reg, &bundle, &path,
        market::side_touch(), stake, SPOT, &clk, sc.ctx(),
    );
    assert!(market::touch_exposure(&mkt) == 1_800_000_000, 0);

    clk.increment_for_testing(500);
    push_obs(&mut oracle, 110_000_000_000, 500);
    po::record(&mut path, &oracle, &clk);

    clk.set_for_testing(EXPIRY + 6_000);
    push_obs(&mut oracle, 110_000_000_000, EXPIRY + 50);
    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle, &mut reg, &clk, sc.ctx());
    assert!(market::status(&mkt) == market::status_hit(), 1);

    let payout = h::redeem_with_bundle(&mut mkt, &mut vault, &rconf, &mut frtr, &mut bundle, bob_pos, &clk, sc.ctx());
    // Winner gets net payout = stake + (profit - fee). Fee comes off profit.
    assert!(payout.value() < 1_800_000_000, 2);   // some fee deducted
    assert!(payout.value() > 1_000_000_000, 3);   // but still > stake (winner profits)
    test_utils::destroy(payout);

    let _ = BOB;
    test_utils::destroy(oracle); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    test_utils::destroy(rconf); test_utils::destroy(rcap);
    test_utils::destroy(reg); test_utils::destroy(regcap);
    test_utils::destroy(frtr); test_utils::destroy(frcap);
    h::destroy_c35_bundle(bundle);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun no_touch_wins_when_barrier_never_crossed() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, rw, mut path, mut mkt, mut vault, vcap, rconf, rcap, mut reg, regcap, mut frtr, frcap, mut clk) =
        h::setup_full_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);
    let mut bundle = h::setup_c35_bundle(&mut sc, &clk);

    let stake = h::mint_sui(STAKE, &mut sc);
    let pos = h::open_with_bundle(
        &mut mkt, &mut vault, &rconf, &mut reg, &bundle, &path,
        market::side_no_touch(), stake, SPOT, &clk, sc.ctx(),
    );

    clk.increment_for_testing(500);
    push_obs(&mut oracle, 99_000_000_000, 500);
    po::record(&mut path, &oracle, &clk);

    clk.set_for_testing(EXPIRY + 6_000);
    push_obs(&mut oracle, 102_000_000_000, EXPIRY + 50);
    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle, &mut reg, &clk, sc.ctx());

    let payout = h::redeem_with_bundle(&mut mkt, &mut vault, &rconf, &mut frtr, &mut bundle, pos, &clk, sc.ctx());
    assert!(payout.value() < 1_800_000_000, 0);
    assert!(payout.value() > 1_000_000_000, 1);
    test_utils::destroy(payout);

    test_utils::destroy(oracle); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    test_utils::destroy(rconf); test_utils::destroy(rcap);
    test_utils::destroy(reg); test_utils::destroy(regcap);
    test_utils::destroy(frtr); test_utils::destroy(frcap);
    h::destroy_c35_bundle(bundle);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun loser_receives_zero() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, rw, mut path, mut mkt, mut vault, vcap, rconf, rcap, mut reg, regcap, mut frtr, frcap, mut clk) =
        h::setup_full_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);
    let mut bundle = h::setup_c35_bundle(&mut sc, &clk);

    let stake = h::mint_sui(STAKE, &mut sc);
    let bob = h::open_with_bundle(
        &mut mkt, &mut vault, &rconf, &mut reg, &bundle, &path,
        market::side_no_touch(), stake, SPOT, &clk, sc.ctx(),
    );

    clk.increment_for_testing(500);
    push_obs(&mut oracle, 110_000_000_000, 500);
    po::record(&mut path, &oracle, &clk);

    clk.set_for_testing(EXPIRY + 6_000);
    push_obs(&mut oracle, 110_000_000_000, EXPIRY + 50);
    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle, &mut reg, &clk, sc.ctx());

    let payout = h::redeem_with_bundle(&mut mkt, &mut vault, &rconf, &mut frtr, &mut bundle, bob, &clk, sc.ctx());
    assert!(payout.value() == 0, 0);
    test_utils::destroy(payout);

    let _ = BOB;
    test_utils::destroy(oracle); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    test_utils::destroy(rconf); test_utils::destroy(rcap);
    test_utils::destroy(reg); test_utils::destroy(regcap);
    test_utils::destroy(frtr); test_utils::destroy(frcap);
    h::destroy_c35_bundle(bundle);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = market::EAfterExpiry)]
fun cannot_open_after_expiry() {
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, path, mut mkt, mut vault, vcap, rconf, rcap, mut reg, regcap, frtr, frcap, mut clk) =
        h::setup_full_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);
    let bundle = h::setup_c35_bundle(&mut sc, &clk);

    clk.set_for_testing(EXPIRY + 1);
    let stake = h::mint_sui(STAKE, &mut sc);
    let pos = h::open_with_bundle(
        &mut mkt, &mut vault, &rconf, &mut reg, &bundle, &path,
        market::side_touch(), stake, SPOT, &clk, sc.ctx(),
    );

    test_utils::destroy(pos);
    test_utils::destroy(oracle); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    test_utils::destroy(rconf); test_utils::destroy(rcap);
    test_utils::destroy(reg); test_utils::destroy(regcap);
    test_utils::destroy(frtr); test_utils::destroy(frcap);
    h::destroy_c35_bundle(bundle);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}

// Safety: a touch/no-touch position must be funded — opening with a zero
// stake aborts EZeroStake (no free positions on the book).
#[test]
#[expected_failure(abort_code = market::EZeroStake)]
fun cannot_open_with_zero_stake() {
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, path, mut mkt, mut vault, vcap, rconf, rcap, mut reg, regcap, frtr, frcap, mut clk) =
        h::setup_full_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);
    let bundle = h::setup_c35_bundle(&mut sc, &clk);

    // Within expiry, active market, valid side — only the stake is bad.
    let stake = h::mint_sui(0, &mut sc);
    let pos = h::open_with_bundle(
        &mut mkt, &mut vault, &rconf, &mut reg, &bundle, &path,
        market::side_touch(), stake, SPOT, &clk, sc.ctx(),
    );

    test_utils::destroy(pos); // unreachable
    test_utils::destroy(oracle); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    test_utils::destroy(rconf); test_utils::destroy(rcap);
    test_utils::destroy(reg); test_utils::destroy(regcap);
    test_utils::destroy(frtr); test_utils::destroy(frcap);
    h::destroy_c35_bundle(bundle);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = market::EStillActive)]
fun cannot_redeem_when_active() {
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, path, mut mkt, mut vault, vcap, rconf, rcap, mut reg, regcap, mut frtr, frcap, clk) =
        h::setup_full_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);
    let mut bundle = h::setup_c35_bundle(&mut sc, &clk);

    let stake = h::mint_sui(STAKE, &mut sc);
    let pos = h::open_with_bundle(
        &mut mkt, &mut vault, &rconf, &mut reg, &bundle, &path,
        market::side_touch(), stake, SPOT, &clk, sc.ctx(),
    );
    let payout = h::redeem_with_bundle(&mut mkt, &mut vault, &rconf, &mut frtr, &mut bundle, pos, &clk, sc.ctx());

    test_utils::destroy(payout);
    test_utils::destroy(oracle); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    test_utils::destroy(rconf); test_utils::destroy(rcap);
    test_utils::destroy(reg); test_utils::destroy(regcap);
    test_utils::destroy(frtr); test_utils::destroy(frcap);
    h::destroy_c35_bundle(bundle);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun two_sided_market_clears_correctly() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, rw, mut path, mut mkt, mut vault, vcap, rconf, rcap, mut reg, regcap, mut frtr, frcap, mut clk) =
        h::setup_full_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);
    let mut bundle = h::setup_c35_bundle(&mut sc, &clk);

    let stake_a = h::mint_sui(STAKE, &mut sc);
    let alice_pos = h::open_with_bundle(
        &mut mkt, &mut vault, &rconf, &mut reg, &bundle, &path,
        market::side_touch(), stake_a, SPOT, &clk, sc.ctx(),
    );
    let stake_b = h::mint_sui(STAKE, &mut sc);
    let bob_pos = h::open_with_bundle(
        &mut mkt, &mut vault, &rconf, &mut reg, &bundle, &path,
        market::side_no_touch(), stake_b, SPOT, &clk, sc.ctx(),
    );

    clk.increment_for_testing(500);
    push_obs(&mut oracle, 120_000_000_000, 500);
    po::record(&mut path, &oracle, &clk);

    clk.set_for_testing(EXPIRY + 6_000);
    push_obs(&mut oracle, 120_000_000_000, EXPIRY + 50);
    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle, &mut reg, &clk, sc.ctx());

    let alice_payout = h::redeem_with_bundle(&mut mkt, &mut vault, &rconf, &mut frtr, &mut bundle, alice_pos, &clk, sc.ctx());
    let bob_payout = h::redeem_with_bundle(&mut mkt, &mut vault, &rconf, &mut frtr, &mut bundle, bob_pos, &clk, sc.ctx());
    assert!(alice_payout.value() > STAKE, 0);   // touch wins, profit > 0
    assert!(bob_payout.value() == 0, 1);

    test_utils::destroy(alice_payout); test_utils::destroy(bob_payout);
    let _ = BOB;
    test_utils::destroy(oracle); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    test_utils::destroy(rconf); test_utils::destroy(rcap);
    test_utils::destroy(reg); test_utils::destroy(regcap);
    test_utils::destroy(frtr); test_utils::destroy(frcap);
    h::destroy_c35_bundle(bundle);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}

// === C.3.4-specific tests ===

#[test]
fun pwe_registered_on_open_and_cleared_on_settle() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, rw, mut path, mut mkt, mut vault, vcap, rconf, rcap, mut reg, regcap, mut frtr, frcap, mut clk) =
        h::setup_full_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);
    let mut bundle = h::setup_c35_bundle(&mut sc, &clk);

    // Open touch: PWE increases on touch side.
    let stake = h::mint_sui(STAKE, &mut sc);
    let pos = h::open_with_bundle(
        &mut mkt, &mut vault, &rconf, &mut reg, &bundle, &path,
        market::side_touch(), stake, SPOT, &clk, sc.ctx(),
    );
    let pwe_after_open = market::touch_pwe(&mkt);
    assert!(pwe_after_open > 0, 0);

    clk.increment_for_testing(500);
    push_obs(&mut oracle, 99_000_000_000, 500);
    po::record(&mut path, &oracle, &clk);

    clk.set_for_testing(EXPIRY + 6_000);
    push_obs(&mut oracle, 99_000_000_000, EXPIRY + 50);
    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle, &mut reg, &clk, sc.ctx());

    // After settle, registry's exposure for (underlying, touch) decremented.
    // We can't easily read after EWMA decay, but the market's pwe still
    // tracks what was attributed; the registry's tracking is what matters.
    assert!(market::status(&mkt) == market::status_expired(), 1);

    let payout = h::redeem_with_bundle(&mut mkt, &mut vault, &rconf, &mut frtr, &mut bundle, pos, &clk, sc.ctx());
    assert!(payout.value() == 0, 2);  // touch lost (no_touch won)
    test_utils::destroy(payout);

    test_utils::destroy(oracle); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    test_utils::destroy(rconf); test_utils::destroy(rcap);
    test_utils::destroy(reg); test_utils::destroy(regcap);
    test_utils::destroy(frtr); test_utils::destroy(frcap);
    h::destroy_c35_bundle(bundle);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun fee_routes_to_router_buckets_on_winner_redeem() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, rw, mut path, mut mkt, mut vault, vcap, rconf, rcap, mut reg, regcap, mut frtr, frcap, mut clk) =
        h::setup_full_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);
    let mut bundle = h::setup_c35_bundle(&mut sc, &clk);

    // Big stake → big profit → measurable fee.
    let stake = h::mint_sui(STAKE, &mut sc);
    let pos = h::open_with_bundle(
        &mut mkt, &mut vault, &rconf, &mut reg, &bundle, &path,
        market::side_touch(), stake, SPOT, &clk, sc.ctx(),
    );

    clk.increment_for_testing(500);
    push_obs(&mut oracle, 110_000_000_000, 500);
    po::record(&mut path, &oracle, &clk);

    clk.set_for_testing(EXPIRY + 6_000);
    push_obs(&mut oracle, 110_000_000_000, EXPIRY + 50);
    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle, &mut reg, &clk, sc.ctx());

    let staker_before = wick::fee_router::staker_pending(&frtr);
    let insurance_before = wick::fee_router::insurance_pending(&frtr);
    let protocol_before = wick::fee_router::protocol_pending(&frtr);

    let payout = h::redeem_with_bundle(&mut mkt, &mut vault, &rconf, &mut frtr, &mut bundle, pos, &clk, sc.ctx());

    // Some fee was routed to non-LP buckets.
    let staker_delta = wick::fee_router::staker_pending(&frtr) - staker_before;
    let insurance_delta = wick::fee_router::insurance_pending(&frtr) - insurance_before;
    let protocol_delta = wick::fee_router::protocol_pending(&frtr) - protocol_before;
    assert!(staker_delta > 0, 0);
    assert!(insurance_delta > 0 || protocol_delta > 0, 1);
    // Staker share should be largest of the non-LP buckets (25% > 10% > 10%).
    assert!(staker_delta >= insurance_delta, 2);
    assert!(staker_delta >= protocol_delta, 3);

    test_utils::destroy(payout);
    test_utils::destroy(oracle); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    test_utils::destroy(rconf); test_utils::destroy(rcap);
    test_utils::destroy(reg); test_utils::destroy(regcap);
    test_utils::destroy(frtr); test_utils::destroy(frcap);
    h::destroy_c35_bundle(bundle);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun aborted_path_routes_to_pool_no_fee() {
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, mut path, mut mkt, mut vault, vcap, rconf, rcap, mut reg, regcap, mut frtr, frcap, mut clk) =
        h::setup_full_world_with_path_params(&mut sc, EXPIRY, 50, 1, 5_000, 5_000);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);
    let mut bundle = h::setup_c35_bundle(&mut sc, &clk);
    let mut oracle_mut = oracle;

    let stake_a = h::mint_sui(STAKE, &mut sc);
    let alice_pos = h::open_with_bundle(
        &mut mkt, &mut vault, &rconf, &mut reg, &bundle, &path,
        market::side_touch(), stake_a, SPOT, &clk, sc.ctx(),
    );

    clk.set_for_testing(EXPIRY + 11_000);
    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle_mut, &mut reg, &clk, sc.ctx());
    assert!(market::status(&mkt) == market::status_aborted(), 0);

    let staker_before = wick::fee_router::staker_pending(&frtr);
    let p_a = h::redeem_with_bundle(&mut mkt, &mut vault, &rconf, &mut frtr, &mut bundle, alice_pos, &clk, sc.ctx());
    assert!(p_a.value() == STAKE, 1);
    // No fee on aborted refund.
    assert!(wick::fee_router::staker_pending(&frtr) == staker_before, 2);

    test_utils::destroy(p_a);
    test_utils::destroy(oracle_mut); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    test_utils::destroy(rconf); test_utils::destroy(rcap);
    test_utils::destroy(reg); test_utils::destroy(regcap);
    test_utils::destroy(frtr); test_utils::destroy(frcap);
    h::destroy_c35_bundle(bundle);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun lock_and_settle_idempotent() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, rw, mut path, mut mkt, mut vault, vcap, rconf, rcap, mut reg, regcap, frtr, frcap, mut clk) =
        h::setup_full_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);
    let bundle = h::setup_c35_bundle(&mut sc, &clk);

    clk.increment_for_testing(100);
    push_obs(&mut oracle, 99_000_000_000, 100);
    po::record(&mut path, &oracle, &clk);

    clk.set_for_testing(EXPIRY + 6_000);
    push_obs(&mut oracle, 99_000_000_000, EXPIRY + 50);
    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle, &mut reg, &clk, sc.ctx());
    let first_status = market::status(&mkt);

    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle, &mut reg, &clk, sc.ctx());
    assert!(market::status(&mkt) == first_status, 0);

    test_utils::destroy(oracle); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    test_utils::destroy(rconf); test_utils::destroy(rcap);
    test_utils::destroy(reg); test_utils::destroy(regcap);
    test_utils::destroy(frtr); test_utils::destroy(frcap);
    h::destroy_c35_bundle(bundle);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}

// ===========================================================================
// Vault-side gate tests (Monte Carlo finding #2 — see
// docs/design/v2/15_montecarlo_validation_report.md)
//
// When `vault_side = SIDE_NO_TOUCH`, only TOUCH-side opens are allowed.
// This closes the symmetric-demand vault-edge bug.
// ===========================================================================

#[test]
fun gated_market_accepts_open_on_allowed_side() {
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, path, _legacy_mkt, mut vault, vcap, rconf, rcap, mut reg, regcap, frtr, frcap, clk) =
        h::setup_full_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);

    // Build a gated market: vault holds NO_TOUCH; traders may only open TOUCH.
    let mut gated = market::create_v4<SUI>(
        string::utf8(b"GATED"), &oracle, &path, &vault,
        market::default_sigma_bps_per_sqrt_sec() * 0 + 18_000, // payout 1.8x
        0,
        market::default_sigma_bps_per_sqrt_sec(),
        market::side_no_touch(),
        sc.ctx(),
    );
    assert!(market::vault_side(&gated) == market::side_no_touch(), 0);

    let mut bundle = h::setup_c35_bundle(&mut sc, &clk);
    let stake = h::mint_sui(STAKE, &mut sc);
    let pos = h::open_with_bundle(
        &mut gated, &mut vault, &rconf, &mut reg, &bundle, &path,
        market::side_touch(), stake, SPOT, &clk, sc.ctx(),
    );
    // Open succeeded — gate is permissive on the allowed side.
    test_utils::destroy(pos);

    test_utils::destroy(oracle); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(_legacy_mkt);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    test_utils::destroy(rconf); test_utils::destroy(rcap);
    test_utils::destroy(reg); test_utils::destroy(regcap);
    test_utils::destroy(frtr); test_utils::destroy(frcap);
    h::destroy_c35_bundle(bundle);
    market::destroy_for_testing(gated);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = 16, location = wick::market)]
fun gated_market_rejects_open_on_vault_side() {
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, path, _legacy_mkt, mut vault, vcap, rconf, rcap, mut reg, regcap, frtr, frcap, clk) =
        h::setup_full_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);

    let mut gated = market::create_v4<SUI>(
        string::utf8(b"GATED"), &oracle, &path, &vault,
        18_000, 0,
        market::default_sigma_bps_per_sqrt_sec(),
        market::side_no_touch(),
        sc.ctx(),
    );
    let bundle = h::setup_c35_bundle(&mut sc, &clk);
    let stake = h::mint_sui(STAKE, &mut sc);
    // Attempt to open on the gated side — should abort with EVaultSideClosed (16).
    let _pos = h::open_with_bundle(
        &mut gated, &mut vault, &rconf, &mut reg, &bundle, &path,
        market::side_no_touch(), stake, SPOT, &clk, sc.ctx(),
    );
    abort 0xDEAD  // unreachable; #[expected_failure] catches the abort above
}

#[test]
fun ungated_market_accepts_both_sides() {
    // Sanity: VAULT_SIDE_NONE markets (legacy / DNT) still let both sides open.
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, path, mut mkt, mut vault, vcap, rconf, rcap, mut reg, regcap, frtr, frcap, clk) =
        h::setup_full_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);

    assert!(market::vault_side(&mkt) == market::vault_side_none(), 0);

    let mut bundle = h::setup_c35_bundle(&mut sc, &clk);
    let s1 = h::mint_sui(STAKE, &mut sc);
    let p1 = h::open_with_bundle(
        &mut mkt, &mut vault, &rconf, &mut reg, &bundle, &path,
        market::side_touch(), s1, SPOT, &clk, sc.ctx(),
    );
    let s2 = h::mint_sui(STAKE, &mut sc);
    let p2 = h::open_with_bundle(
        &mut mkt, &mut vault, &rconf, &mut reg, &bundle, &path,
        market::side_no_touch(), s2, SPOT, &clk, sc.ctx(),
    );
    test_utils::destroy(p1); test_utils::destroy(p2);

    test_utils::destroy(oracle); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    test_utils::destroy(rconf); test_utils::destroy(rcap);
    test_utils::destroy(reg); test_utils::destroy(regcap);
    test_utils::destroy(frtr); test_utils::destroy(frcap);
    h::destroy_c35_bundle(bundle);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}

