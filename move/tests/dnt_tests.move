// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

#[test_only]
/// Tests for the DNT (double-no-touch) extension to path_observation +
/// market. Covers:
///   1. new_dnt populates both barriers + direction
///   2. record marks upper_touched_at on upper-side crossings
///   3. record marks lower_touched_at on lower-side crossings
///   4. dnt_neither_touched is true when the corridor holds
///   5. dnt_neither_touched is false when either side breaches
///   6. lock_and_settle on a held DNT pays the INSIDE side
///   7. lock_and_settle on a breached DNT pays the OUTSIDE side
module wick::dnt_tests;

use std::string;
use sui::clock;
use sui::sui::SUI;
use sui::test_scenario as ts;
use sui::test_utils;
use wick::fee_router::{Self as router, FeeRouter, FeeRouterAdminCap};
use wick::global_exposure_registry::{Self as ger, GlobalExposureRegistry, RegistryAdminCap};
use wick::market::{Self, Market};
use wick::martingaler_vault::{Self as mv, MartingalerVault, VaultAdminCap};
use wick::path_observation as po;
use wick::price_observation;
use wick::random_walk_driver::{Self, RandomWalk};
use wick::risk_config::{Self as rc, RiskConfig, RiskAdminCap};
use wick::test_helpers as h;
use wick::wick_oracle::{Self, WickOracle};

const ALICE: address = @0xA;

const STARTING_PRICE: u64 = 100_000_000_000;  // 100.0
const LOWER_BARRIER: u64 = 95_000_000_000;    //  95.0
const UPPER_BARRIER: u64 = 105_000_000_000;   // 105.0
const EXPIRY: u64 = 1_000;
const STAKE: u64 = 1_000_000_000;
const POOL_SEED: u64 = 10_000_000_000_000;
const SPOT: u64 = 100_000_000_000;

fun push_obs(oracle: &mut WickOracle, price: u64, ts_ms: u64) {
    let oid = object::id(oracle);
    let obs = price_observation::new(price, ts_ms, oid);
    wick_oracle::apply_observation_for_testing(oracle, wick_oracle::driver_random_walk(), obs);
}

/// DNT analogue of setup_full_world. Returns the same 13-tuple but the
/// PathObservation is built via po::new_dnt and the Market via
/// market::create_dnt. min_observations=1 / confirmations=1 by default so
/// tests can express touches with a single tick.
fun setup_dnt_world(sc: &mut ts::Scenario): (
    WickOracle,
    RandomWalk,
    po::PathObservation,
    Market<SUI>,
    MartingalerVault<SUI>,
    VaultAdminCap,
    RiskConfig,
    RiskAdminCap,
    GlobalExposureRegistry,
    RegistryAdminCap,
    FeeRouter<SUI>,
    FeeRouterAdminCap,
    clock::Clock,
) {
    let clk = clock::create_for_testing(sc.ctx());
    let (oracle, rw) = random_walk_driver::new_for_testing(
        string::utf8(b"WICK_RNG"),
        STARTING_PRICE,
        50,
        EXPIRY,
        &clk,
        sc.ctx(),
    );
    let path = po::new_dnt(
        &oracle,
        LOWER_BARRIER,
        UPPER_BARRIER,
        0,        // buffer_bps
        1,        // min_observations
        1,        // confirmations
        60_000,   // grace_ms
        5_000,    // pre_lock_drain_ms
        sc.ctx(),
    );
    let (vault, vcap) = mv::init_for_testing<SUI>(sc.ctx());
    let mkt = market::create_dnt<SUI>(
        string::utf8(b"DNT"), &oracle, &path, &vault, 18_000, 0, sc.ctx(),
    );
    let (risk_config, rcap) = rc::init_for_testing(sc.ctx());
    let (registry, regcap) = ger::init_for_testing(sc.ctx());
    let (fee_router, frcap) = router::init_for_testing<SUI>(sc.ctx());
    (oracle, rw, path, mkt, vault, vcap, risk_config, rcap, registry, regcap, fee_router, frcap, clk)
}

#[test]
fun new_dnt_sets_both_barriers_and_direction() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    let (oracle, rw) = random_walk_driver::new_for_testing(
        string::utf8(b"WICK_RNG"),
        STARTING_PRICE,
        50,
        EXPIRY,
        &clk,
        sc.ctx(),
    );
    let p = po::new_dnt(
        &oracle, LOWER_BARRIER, UPPER_BARRIER, 0, 1, 1, 60_000, 5_000, sc.ctx(),
    );

    assert!(po::is_dnt(&p), 0);
    assert!(po::direction(&p) == po::touch_dnt(), 1);
    assert!(po::lower_barrier(&p) == LOWER_BARRIER, 2);
    assert!(po::upper_barrier(&p) == UPPER_BARRIER, 3);
    // Legacy single barrier should be 0 for a DNT path.
    assert!(po::barrier(&p) == 0, 4);
    assert!(option::is_none(po::upper_touched_at(&p)), 5);
    assert!(option::is_none(po::lower_touched_at(&p)), 6);
    assert!(po::dnt_neither_touched(&p), 7);

    test_utils::destroy(oracle);
    test_utils::destroy(rw);
    test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun record_marks_upper_touched_at_when_price_crosses_upper() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, rw) = random_walk_driver::new_for_testing(
        string::utf8(b"WICK_RNG"),
        STARTING_PRICE, 50, EXPIRY, &clk, sc.ctx(),
    );
    let mut p = po::new_dnt(
        &oracle, LOWER_BARRIER, UPPER_BARRIER, 0, 1, 1, 60_000, 5_000, sc.ctx(),
    );

    clk.increment_for_testing(100);
    push_obs(&mut oracle, 110_000_000_000, 100);  // above upper
    po::record(&mut p, &oracle, &clk);

    assert!(option::is_some(po::upper_touched_at(&p)), 0);
    assert!(option::is_none(po::lower_touched_at(&p)), 1);
    assert!(!po::dnt_neither_touched(&p), 2);

    test_utils::destroy(oracle);
    test_utils::destroy(rw);
    test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun record_marks_lower_touched_at_when_price_crosses_lower() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, rw) = random_walk_driver::new_for_testing(
        string::utf8(b"WICK_RNG"),
        STARTING_PRICE, 50, EXPIRY, &clk, sc.ctx(),
    );
    let mut p = po::new_dnt(
        &oracle, LOWER_BARRIER, UPPER_BARRIER, 0, 1, 1, 60_000, 5_000, sc.ctx(),
    );

    clk.increment_for_testing(100);
    push_obs(&mut oracle, 90_000_000_000, 100);  // below lower
    po::record(&mut p, &oracle, &clk);

    assert!(option::is_some(po::lower_touched_at(&p)), 0);
    assert!(option::is_none(po::upper_touched_at(&p)), 1);
    assert!(!po::dnt_neither_touched(&p), 2);

    test_utils::destroy(oracle);
    test_utils::destroy(rw);
    test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun dnt_neither_touched_returns_true_when_corridor_held() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, rw) = random_walk_driver::new_for_testing(
        string::utf8(b"WICK_RNG"),
        STARTING_PRICE, 50, EXPIRY, &clk, sc.ctx(),
    );
    let mut p = po::new_dnt(
        &oracle, LOWER_BARRIER, UPPER_BARRIER, 0, 1, 1, 60_000, 5_000, sc.ctx(),
    );

    // Several in-corridor ticks: should remain "neither touched".
    let prices = vector[100_000_000_000, 102_000_000_000, 98_500_000_000, 99_500_000_000, 101_500_000_000];
    let mut i = 0;
    while (i < 5) {
        clk.increment_for_testing(100);
        let ts_ms = (i + 1) * 100;
        push_obs(&mut oracle, *vector::borrow(&prices, i), ts_ms);
        po::record(&mut p, &oracle, &clk);
        i = i + 1;
    };

    assert!(po::dnt_neither_touched(&p), 0);
    assert!(option::is_none(po::upper_touched_at(&p)), 1);
    assert!(option::is_none(po::lower_touched_at(&p)), 2);

    test_utils::destroy(oracle);
    test_utils::destroy(rw);
    test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun dnt_neither_touched_returns_false_when_either_barrier_breached() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, rw) = random_walk_driver::new_for_testing(
        string::utf8(b"WICK_RNG"),
        STARTING_PRICE, 50, EXPIRY, &clk, sc.ctx(),
    );
    let mut p = po::new_dnt(
        &oracle, LOWER_BARRIER, UPPER_BARRIER, 0, 1, 1, 60_000, 5_000, sc.ctx(),
    );

    // First in-corridor tick — neither touched yet.
    clk.increment_for_testing(100);
    push_obs(&mut oracle, 102_000_000_000, 100);
    po::record(&mut p, &oracle, &clk);
    assert!(po::dnt_neither_touched(&p), 0);

    // Upper breach.
    clk.increment_for_testing(100);
    push_obs(&mut oracle, 106_000_000_000, 200);
    po::record(&mut p, &oracle, &clk);
    assert!(!po::dnt_neither_touched(&p), 1);
    assert!(option::is_some(po::upper_touched_at(&p)), 2);

    test_utils::destroy(oracle);
    test_utils::destroy(rw);
    test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun lock_and_settle_dnt_market_with_held_corridor_pays_inside_side() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, rw, mut path, mut mkt, mut vault, vcap, rconf, rcap, mut reg, regcap, mut frtr, frcap, mut clk) =
        setup_dnt_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);
    let mut bundle = h::setup_c35_bundle(&mut sc, &clk);

    // Alice INSIDE, Bob OUTSIDE.
    let stake_a = h::mint_sui(STAKE, &mut sc);
    let alice_pos = h::open_with_bundle(
        &mut mkt, &mut vault, &rconf, &mut reg, &bundle, &path,
        market::side_dnt_inside(), stake_a, SPOT, &clk, sc.ctx(),
    );
    let stake_b = h::mint_sui(STAKE, &mut sc);
    let bob_pos = h::open_with_bundle(
        &mut mkt, &mut vault, &rconf, &mut reg, &bundle, &path,
        market::side_dnt_outside(), stake_b, SPOT, &clk, sc.ctx(),
    );

    // Corridor holds: only in-corridor ticks.
    clk.increment_for_testing(200);
    push_obs(&mut oracle, 101_000_000_000, 200);
    po::record(&mut path, &oracle, &clk);
    clk.increment_for_testing(200);
    push_obs(&mut oracle, 99_000_000_000, 400);
    po::record(&mut path, &oracle, &clk);

    clk.set_for_testing(EXPIRY + 6_000);
    push_obs(&mut oracle, 100_000_000_000, EXPIRY + 50);
    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle, &mut reg, &clk, sc.ctx());
    assert!(market::status(&mkt) == market::status_dnt_held(), 0);

    let alice_payout = h::redeem_with_bundle(
        &mut mkt, &mut vault, &rconf, &mut frtr, &mut bundle, alice_pos, &clk, sc.ctx(),
    );
    let bob_payout = h::redeem_with_bundle(
        &mut mkt, &mut vault, &rconf, &mut frtr, &mut bundle, bob_pos, &clk, sc.ctx(),
    );
    // Inside wins → leveraged payout. Outside loses → 0.
    assert!(alice_payout.value() > STAKE, 1);
    assert!(bob_payout.value() == 0, 2);

    // Vault-level conservation through a FULL DNT settlement (two deposits → fee
    // routing → a two-sided leveraged payout). conservation_in_minus_out_equals_held
    // proves this for the vault primitive in isolation; this proves a real DNT
    // lifecycle preserves it: every bucket still sums to exactly
    // cumulative_in − cumulative_out, so the leveraged payout + fees neither
    // minted nor leaked collateral.
    let mkt_id = object::id(&mkt);
    let held = mv::treasury_value(&vault)
        + mv::side_bucket_value(&vault)
        + mv::protocol_fees_value(&vault)
        + mv::staker_fees_value(&vault)
        + mv::insurance_fees_value(&vault)
        + mv::queue_total(&vault)
        + mv::lock_value(&vault, mkt_id)
        + mv::abort_pool_value(&vault, mkt_id);
    assert!(mv::cumulative_in(&vault) - mv::cumulative_out(&vault) == (held as u128), 3);

    test_utils::destroy(alice_payout);
    test_utils::destroy(bob_payout);
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
fun lock_and_settle_dnt_market_with_breached_corridor_pays_outside_side() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, rw, mut path, mut mkt, mut vault, vcap, rconf, rcap, mut reg, regcap, mut frtr, frcap, mut clk) =
        setup_dnt_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);
    let mut bundle = h::setup_c35_bundle(&mut sc, &clk);

    let stake_a = h::mint_sui(STAKE, &mut sc);
    let alice_pos = h::open_with_bundle(
        &mut mkt, &mut vault, &rconf, &mut reg, &bundle, &path,
        market::side_dnt_inside(), stake_a, SPOT, &clk, sc.ctx(),
    );
    let stake_b = h::mint_sui(STAKE, &mut sc);
    let bob_pos = h::open_with_bundle(
        &mut mkt, &mut vault, &rconf, &mut reg, &bundle, &path,
        market::side_dnt_outside(), stake_b, SPOT, &clk, sc.ctx(),
    );

    // Upper barrier breached mid-window.
    clk.increment_for_testing(200);
    push_obs(&mut oracle, 110_000_000_000, 200);
    po::record(&mut path, &oracle, &clk);

    clk.set_for_testing(EXPIRY + 6_000);
    push_obs(&mut oracle, 110_000_000_000, EXPIRY + 50);
    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle, &mut reg, &clk, sc.ctx());
    assert!(market::status(&mkt) == market::status_dnt_broken(), 0);

    let alice_payout = h::redeem_with_bundle(
        &mut mkt, &mut vault, &rconf, &mut frtr, &mut bundle, alice_pos, &clk, sc.ctx(),
    );
    let bob_payout = h::redeem_with_bundle(
        &mut mkt, &mut vault, &rconf, &mut frtr, &mut bundle, bob_pos, &clk, sc.ctx(),
    );
    // Outside wins → leveraged payout. Inside loses → 0.
    assert!(bob_payout.value() > STAKE, 1);
    assert!(alice_payout.value() == 0, 2);

    // Same vault-level conservation as the held case, mirrored for the BROKEN
    // corridor (outside wins): every bucket still sums to exactly
    // cumulative_in − cumulative_out — the leveraged payout + fees conserved.
    let mkt_id = object::id(&mkt);
    let held = mv::treasury_value(&vault)
        + mv::side_bucket_value(&vault)
        + mv::protocol_fees_value(&vault)
        + mv::staker_fees_value(&vault)
        + mv::insurance_fees_value(&vault)
        + mv::queue_total(&vault)
        + mv::lock_value(&vault, mkt_id)
        + mv::abort_pool_value(&vault, mkt_id);
    assert!(mv::cumulative_in(&vault) - mv::cumulative_out(&vault) == (held as u128), 3);

    test_utils::destroy(alice_payout);
    test_utils::destroy(bob_payout);
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

// Safety: DNT_HELD and DNT_BROKEN are mutually exclusive. A market settled to
// HELD must never re-settle to BROKEN — re-settlement is a no-op on the
// terminal status (mirrors lock_and_settle_idempotent, on the DNT path).
#[test]
fun lock_and_settle_dnt_held_idempotent_cannot_flip_to_broken() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, rw, mut path, mut mkt, mut vault, vcap, rconf, rcap, mut reg, regcap, frtr, frcap, mut clk) =
        setup_dnt_world(&mut sc);
    h::seed_vault(&mut vault, POOL_SEED, &clk, &mut sc);

    // Corridor holds — only in-corridor ticks (same as the held-pays test).
    clk.increment_for_testing(200);
    push_obs(&mut oracle, 101_000_000_000, 200);
    po::record(&mut path, &oracle, &clk);
    clk.increment_for_testing(200);
    push_obs(&mut oracle, 99_000_000_000, 400);
    po::record(&mut path, &oracle, &clk);

    clk.set_for_testing(EXPIRY + 6_000);
    push_obs(&mut oracle, 100_000_000_000, EXPIRY + 50);
    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle, &mut reg, &clk, sc.ctx());
    assert!(market::status(&mkt) == market::status_dnt_held(), 0);

    // A second settle can never flip the held corridor to broken.
    market::lock_and_settle<SUI>(&mut mkt, &mut vault, &mut path, &mut oracle, &mut reg, &clk, sc.ctx());
    assert!(market::status(&mkt) == market::status_dnt_held(), 1);
    assert!(market::status(&mkt) != market::status_dnt_broken(), 2);

    test_utils::destroy(oracle); test_utils::destroy(rw); test_utils::destroy(path);
    test_utils::destroy(vault); test_utils::destroy(vcap);
    test_utils::destroy(rconf); test_utils::destroy(rcap);
    test_utils::destroy(reg); test_utils::destroy(regcap);
    test_utils::destroy(frtr); test_utils::destroy(frcap);
    market::destroy_for_testing(mkt);
    clk.destroy_for_testing();
    sc.end();
}

