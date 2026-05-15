// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

#[test_only]
module wick::drain_window_tests;

use std::string;
use sui::clock;
use sui::test_scenario as ts;
use sui::test_utils;
use wick::path_observation as po;
use wick::price_observation;
use wick::random_walk_driver;
use wick::wick_oracle::{Self, WickOracle};

const ALICE: address = @0xA;
const STARTING_PRICE: u64 = 100_000_000_000;
const BARRIER_ABOVE: u64 = 105_000_000_000;

fun mk(expiry_ms: u64, drain_ms: u64, sc: &mut ts::Scenario, clk: &clock::Clock):
    (WickOracle, random_walk_driver::RandomWalk, po::PathObservation) {
    let (oracle, rw) = random_walk_driver::new_for_testing(
        string::utf8(b"WICK_RNG"), STARTING_PRICE, 50, expiry_ms, clk, sc.ctx(),
    );
    let p = po::new_v3(
        &oracle, BARRIER_ABOVE, po::touch_above(),
        0, 1, 1, 60_000, drain_ms, sc.ctx(),
    );
    (oracle, rw, p)
}

fun push_obs(oracle: &mut WickOracle, price: u64, ts: u64) {
    let oid = object::id(oracle);
    let obs = price_observation::new(price, ts, oid);
    wick_oracle::apply_observation_for_testing(oracle, wick_oracle::driver_random_walk(), obs);
}

// === Lock gating ===

#[test]
#[expected_failure(abort_code = po::EDrainWindowOpen)]
fun cannot_lock_during_drain_window() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, _rw, mut p) = mk(1_000, 5_000, &mut sc, &clk);

    // Push one tick before expiry to satisfy min_obs.
    clk.increment_for_testing(100);
    push_obs(&mut oracle, 99_000_000_000, 100);
    po::record(&mut p, &oracle, &clk);

    // Move to expiry+drain−1: still inside drain. Lock must abort.
    clk.set_for_testing(1_000 + 4_999);
    po::lock_settlement_snapshot(&mut p, &clk);

    test_utils::destroy(oracle);
    test_utils::destroy(_rw);
    test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun lock_succeeds_at_drain_boundary() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, _rw, mut p) = mk(1_000, 5_000, &mut sc, &clk);

    clk.increment_for_testing(100);
    push_obs(&mut oracle, 99_000_000_000, 100);
    po::record(&mut p, &oracle, &clk);

    // exactly expiry+drain
    clk.set_for_testing(1_000 + 5_000);
    po::lock_settlement_snapshot(&mut p, &clk);
    let snap = option::borrow(po::settlement_snapshot(&p));
    assert!(po::snapshot_state(snap) == po::settlement_resolved(), 0);

    test_utils::destroy(oracle);
    test_utils::destroy(_rw);
    test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}

// === Drain-window record acceptance ===

#[test]
fun record_during_drain_accepts_pre_expiry_stamped_tick() {
    // Bot-race fix: a tick stamped at obs_ts < expiry_ms but mempool-delayed
    // can land via record_during_drain during [expiry, expiry+drain).
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, _rw, mut p) = mk(1_000, 5_000, &mut sc, &clk);

    // Push pre-expiry obs that didn't make it into a pre-expiry block.
    clk.set_for_testing(1_500);  // chain time past expiry
    push_obs(&mut oracle, 110_000_000_000, 950);  // obs_ts < expiry_ms
    po::record_during_drain(&mut p, &oracle, &clk);

    // Tick was applied: max_seen advanced, observation_count incremented.
    assert!(po::max_seen(&p) == 110_000_000_000, 0);
    assert!(po::observation_count(&p) == 1, 1);
    // Single tick with confirmations=1 should fire touched_at.
    assert!(po::is_touched(&p), 2);

    test_utils::destroy(oracle);
    test_utils::destroy(_rw);
    test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun record_during_drain_rejects_post_expiry_stamped_tick() {
    // Defends against late-print attacks: a fresh post-expiry signed tick
    // cannot decide outcome even if pushed during drain.
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, _rw, mut p) = mk(1_000, 5_000, &mut sc, &clk);

    clk.set_for_testing(1_500);
    push_obs(&mut oracle, 110_000_000_000, 1_400);  // obs_ts >= expiry_ms
    po::record_during_drain(&mut p, &oracle, &clk);

    // Tick rejected silently: state unchanged.
    assert!(po::max_seen(&p) == 0, 0);
    assert!(po::observation_count(&p) == 0, 1);
    assert!(!po::is_touched(&p), 2);

    test_utils::destroy(oracle);
    test_utils::destroy(_rw);
    test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = po::ENotInDrainWindow)]
fun record_during_drain_aborts_pre_expiry() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, _rw, mut p) = mk(1_000, 5_000, &mut sc, &clk);

    clk.set_for_testing(500);  // pre-expiry
    push_obs(&mut oracle, 99_000_000_000, 100);
    po::record_during_drain(&mut p, &oracle, &clk);

    test_utils::destroy(oracle);
    test_utils::destroy(_rw);
    test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = po::ENotInDrainWindow)]
fun record_during_drain_aborts_after_drain() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, _rw, mut p) = mk(1_000, 5_000, &mut sc, &clk);

    clk.set_for_testing(7_000);  // past expiry+drain
    push_obs(&mut oracle, 99_000_000_000, 900);
    po::record_during_drain(&mut p, &oracle, &clk);

    test_utils::destroy(oracle);
    test_utils::destroy(_rw);
    test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}

// === The bot-race scenario this fixes ===

#[test]
fun bot_race_resolution_late_confirmation_lands_via_drain() {
    // Setup: 3-confirmation requirement. 2 confirmations land before expiry;
    // 3rd is stamped at obs_ts=950 (pre-expiry) but mempool-delayed and only
    // arrives via record_during_drain at chain-time 1_500. Without the drain
    // window, this tick would be lost and snapshot would freeze "no-touch
    // wins." With the drain window, the third confirmation lands and touch
    // fires before snapshot lock.
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, _rw) = random_walk_driver::new_for_testing(
        string::utf8(b"WICK_RNG"), STARTING_PRICE, 50, 1_000, &clk, sc.ctx(),
    );
    let mut p = po::new_v3(
        &oracle, BARRIER_ABOVE, po::touch_above(),
        0, 1, 3, 60_000, 5_000, sc.ctx(),  // 3-confirmation, 5s drain
    );

    // Two confirmations pre-expiry.
    clk.increment_for_testing(100);
    push_obs(&mut oracle, 110_000_000_000, 100);
    po::record(&mut p, &oracle, &clk);
    clk.increment_for_testing(100);
    push_obs(&mut oracle, 110_500_000_000, 200);
    po::record(&mut p, &oracle, &clk);
    assert!(!po::is_touched(&p), 0);
    assert!(po::consecutive_cross_count(&p) == 2, 1);

    // Third confirmation: chain reaches expiry without it landing. Bot tries
    // to lock the millisecond after expiry but is gated by drain window.
    clk.set_for_testing(1_500);  // 500ms past expiry, in drain window

    // Late tick lands via record_during_drain (obs_ts=950, pre-expiry).
    push_obs(&mut oracle, 111_000_000_000, 950);
    po::record_during_drain(&mut p, &oracle, &clk);

    // Touched fires! The losing-side bot's race is defeated.
    assert!(po::is_touched(&p), 2);
    assert!(po::consecutive_cross_count(&p) == 3, 3);

    // Now lock can succeed past drain window.
    clk.set_for_testing(7_000);
    po::lock_settlement_snapshot(&mut p, &clk);
    let snap = option::borrow(po::settlement_snapshot(&p));
    assert!(po::snapshot_is_touched(snap), 4);

    test_utils::destroy(oracle);
    test_utils::destroy(_rw);
    test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}

// === Defaults check ===

#[test]
fun default_constructor_uses_5s_drain() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    let (oracle, _rw) = random_walk_driver::new_for_testing(
        string::utf8(b"WICK_RNG"), STARTING_PRICE, 50, 1_000_000, &clk, sc.ctx(),
    );
    let p = po::new(&oracle, BARRIER_ABOVE, po::touch_above(), sc.ctx());
    assert!(po::pre_lock_drain_ms(&p) == po::default_pre_lock_drain_ms(), 0);
    assert!(po::default_pre_lock_drain_ms() == 5_000, 1);

    test_utils::destroy(oracle);
    test_utils::destroy(_rw);
    test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}
