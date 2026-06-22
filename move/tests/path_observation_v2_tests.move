// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

#[test_only]
#[allow(deprecated_usage)]
module wick::path_observation_v2_tests;

use std::string;
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario as ts;
use wick::market;
use wick::path_observation as po;
use wick::price_observation;
use wick::random_walk_driver;
use wick::wick_oracle::{Self, WickOracle};

const ALICE: address = @0xA;
const BOB: address = @0xB;

const STARTING_PRICE: u64 = 100_000_000_000;  // 100.0
const BARRIER_ABOVE: u64 = 105_000_000_000;   // 105.0

fun mk_oracle_at(expiry_ms: u64, sc: &mut ts::Scenario, clk: &clock::Clock): (WickOracle, random_walk_driver::RandomWalk) {
    random_walk_driver::new_for_testing(
        string::utf8(b"WICK_RNG"),
        STARTING_PRICE,
        50,
        expiry_ms,
        clk,
        sc.ctx(),
    )
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

// === N-confirmations: single bad tick must NOT lock the outcome ===

#[test]
fun single_bad_tick_does_not_lock_outcome() {
    // One spike obs above trigger followed by 5 obs below. With 3-confirmations
    // required, touched_at must remain None and consecutive resets on each
    // non-cross.
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, _rw) = mk_oracle_at(1_000_000, &mut sc, &clk);
    let mut p = po::new_v2(
        &oracle,
        BARRIER_ABOVE,
        po::touch_above(),
        0, 1, 3, 60_000,  // buffer=0, min_obs=1, conf=3, grace=60s
        sc.ctx(),
    );

    // Spike to 110, then back below
    let prices = vector[110_000_000_000, 99_000_000_000, 98_000_000_000, 100_000_000_000, 101_000_000_000, 102_000_000_000];
    let mut i = 0;
    while (i < 6) {
        clk.increment_for_testing(100);
        let ts_ms = (i + 1) * 100;
        push_obs(&mut oracle, *vector::borrow(&prices, i), ts_ms);
        po::record(&mut p, &oracle, &clk);
        i = i + 1;
    };

    assert!(!po::is_touched(&p), 0);
    assert!(po::consecutive_cross_count(&p) == 0, 1);
    assert!(po::observation_count(&p) == 6, 2);

    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(_rw);
    sui::test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun three_consecutive_crossings_lock_touch() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, _rw) = mk_oracle_at(1_000_000, &mut sc, &clk);
    let mut p = po::new_v2(
        &oracle,
        BARRIER_ABOVE,
        po::touch_above(),
        0, 1, 3, 60_000,
        sc.ctx(),
    );

    clk.increment_for_testing(100);
    push_obs(&mut oracle, 110_000_000_000, 100);
    po::record(&mut p, &oracle, &clk);
    assert!(!po::is_touched(&p), 0);
    assert!(po::consecutive_cross_count(&p) == 1, 1);

    clk.increment_for_testing(100);
    push_obs(&mut oracle, 111_000_000_000, 200);
    po::record(&mut p, &oracle, &clk);
    assert!(!po::is_touched(&p), 2);
    assert!(po::consecutive_cross_count(&p) == 2, 3);

    clk.increment_for_testing(100);
    push_obs(&mut oracle, 112_000_000_000, 300);
    po::record(&mut p, &oracle, &clk);
    assert!(po::is_touched(&p), 4);
    assert!(po::consecutive_cross_count(&p) == 3, 5);

    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(_rw);
    sui::test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun crossing_run_resets_on_intervening_below() {
    // Two crossings, then a non-cross, then two more — should NOT touch.
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, _rw) = mk_oracle_at(1_000_000, &mut sc, &clk);
    let mut p = po::new_v2(
        &oracle, BARRIER_ABOVE, po::touch_above(),
        0, 1, 3, 60_000, sc.ctx(),
    );

    let path_prices = vector[
        110_000_000_000,  // cross 1
        110_000_000_000,  // cross 2
        99_000_000_000,   // RESET
        110_000_000_000,  // cross 1 again
        110_000_000_000,  // cross 2 again
    ];
    let mut i = 0;
    while (i < 5) {
        clk.increment_for_testing(100);
        let ts_ms = (i + 1) * 100;
        push_obs(&mut oracle, *vector::borrow(&path_prices, i), ts_ms);
        po::record(&mut p, &oracle, &clk);
        i = i + 1;
    };

    assert!(!po::is_touched(&p), 0);
    assert!(po::consecutive_cross_count(&p) == 2, 1);

    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(_rw);
    sui::test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}

// === Post-expiry freeze ===

#[test]
fun post_expiry_record_is_pure_noop() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, _rw) = mk_oracle_at(1_000, &mut sc, &clk);
    let mut p = po::new_v2(
        &oracle, BARRIER_ABOVE, po::touch_above(),
        0, 1, 1, 60_000, sc.ctx(),  // confirmations=1 — would touch on first cross if allowed
    );

    // Move clock past expiry, push barrier-crossing obs, call record.
    clk.set_for_testing(2_000);
    push_obs(&mut oracle, 110_000_000_000, 1_500);
    po::record(&mut p, &oracle, &clk);

    // All path state must be untouched.
    assert!(!po::is_touched(&p), 0);
    assert!(po::observation_count(&p) == 0, 1);
    assert!(po::max_seen(&p) == 0, 2);
    assert!(po::consecutive_cross_count(&p) == 0, 3);

    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(_rw);
    sui::test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}

// === Settlement state transitions ===

#[test]
fun settlement_state_resolved_with_min_observations() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, _rw) = mk_oracle_at(1_000, &mut sc, &clk);
    let mut p = po::new_v2(
        &oracle, BARRIER_ABOVE, po::touch_above(),
        0, 3, 1, 60_000, sc.ctx(),  // need 3 obs minimum
    );

    // Pre-expiry: Not Ready
    assert!(po::settlement_state(&p, &clk) == po::settlement_not_ready(), 0);

    // Push 3 below-barrier observations
    let mut i = 0;
    while (i < 3) {
        clk.increment_for_testing(100);
        let ts_ms = (i + 1) * 100;
        push_obs(&mut oracle, 99_000_000_000, ts_ms);
        po::record(&mut p, &oracle, &clk);
        i = i + 1;
    };

    // Past expiry now
    clk.set_for_testing(2_000);
    assert!(po::settlement_state(&p, &clk) == po::settlement_resolved(), 1);

    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(_rw);
    sui::test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun settlement_state_aborts_after_grace_with_too_few_obs() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (oracle, _rw) = mk_oracle_at(1_000, &mut sc, &clk);
    let p = po::new_v2(
        &oracle, BARRIER_ABOVE, po::touch_above(),
        0, 6, 1, 5_000, sc.ctx(),  // need 6 obs, grace 5s
    );

    // Push 0 observations. Move past expiry but before grace.
    clk.set_for_testing(2_000);
    assert!(po::settlement_state(&p, &clk) == po::settlement_not_ready(), 0);

    // Past grace: Aborted
    clk.set_for_testing(7_000);  // expiry + 6s > expiry + grace 5s
    assert!(po::settlement_state(&p, &clk) == po::settlement_aborted(), 1);

    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(_rw);
    sui::test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}

// === Snapshot lock ===

#[test]
fun snapshot_lock_freezes_outcome() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, _rw) = mk_oracle_at(1_000, &mut sc, &clk);
    let mut p = po::new_v2(
        &oracle, BARRIER_ABOVE, po::touch_above(),
        0, 1, 1, 60_000, sc.ctx(),
    );

    // Push one below-barrier obs, advance past expiry + drain (5s default), lock.
    clk.increment_for_testing(100);
    push_obs(&mut oracle, 99_000_000_000, 100);
    po::record(&mut p, &oracle, &clk);

    clk.set_for_testing(7_000);  // expiry 1000 + drain 5000 + buffer
    po::lock_settlement_snapshot(&mut p, &clk);

    let snap_opt = po::settlement_snapshot(&p);
    assert!(option::is_some(snap_opt), 0);
    let snap = option::borrow(snap_opt);
    assert!(po::snapshot_state(snap) == po::settlement_resolved(), 1);
    assert!(!po::snapshot_is_touched(snap), 2);
    assert!(po::snapshot_max_seen(snap) == 99_000_000_000, 3);

    // touch_outcome consumes the snapshot, returns false (no touch).
    assert!(!po::touch_outcome(&p, &clk), 4);

    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(_rw);
    sui::test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = po::ESnapshotAlreadyLocked)]
fun snapshot_double_lock_aborts() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, _rw) = mk_oracle_at(1_000, &mut sc, &clk);
    let mut p = po::new_v2(
        &oracle, BARRIER_ABOVE, po::touch_above(),
        0, 1, 1, 60_000, sc.ctx(),
    );

    clk.increment_for_testing(100);
    push_obs(&mut oracle, 99_000_000_000, 100);
    po::record(&mut p, &oracle, &clk);

    clk.set_for_testing(7_000);  // past expiry+drain
    po::lock_settlement_snapshot(&mut p, &clk);
    po::lock_settlement_snapshot(&mut p, &clk);  // abort: ESnapshotAlreadyLocked

    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(_rw);
    sui::test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = po::EDrainWindowOpen)]
fun snapshot_lock_during_drain_window_aborts() {
    // Pre-expiry-or-drain lock attempt now fails with EDrainWindowOpen first.
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (oracle, _rw) = mk_oracle_at(1_000, &mut sc, &clk);
    let mut p = po::new_v2(
        &oracle, BARRIER_ABOVE, po::touch_above(),
        0, 1, 1, 60_000, sc.ctx(),
    );

    // Past expiry but inside drain window: still cannot lock.
    clk.set_for_testing(3_000);  // expiry 1000 + 2s, but drain window runs to 6000
    po::lock_settlement_snapshot(&mut p, &clk);

    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(_rw);
    sui::test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}

// === Aborted refund branch removed (covered by market_tests.move) ===

// === settlement_observation latch (wick_oracle v2) ===

#[test]
fun settlement_observation_latches_first_post_expiry_obs() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, _rw) = mk_oracle_at(1_000, &mut sc, &clk);

    // Pre-expiry obs — should NOT latch
    push_obs(&mut oracle, 100_000_000_000, 500);
    assert!(option::is_none(wick_oracle::settlement_observation(&oracle)), 0);

    // First post-expiry obs — latches
    clk.set_for_testing(2_000);
    push_obs(&mut oracle, 999_000_000_000, 1_500);
    assert!(option::is_some(wick_oracle::settlement_observation(&oracle)), 1);
    let latched = option::borrow(wick_oracle::settlement_observation(&oracle));
    assert!(price_observation::price(latched) == 999_000_000_000, 2);

    // Second post-expiry obs — does NOT overwrite settlement_observation
    push_obs(&mut oracle, 123_000_000_000, 1_700);
    let latched2 = option::borrow(wick_oracle::settlement_observation(&oracle));
    assert!(price_observation::price(latched2) == 999_000_000_000, 3);
    // But latest does update
    assert!(wick_oracle::latest_price(&oracle) == 123_000_000_000, 4);

    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(_rw);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun lock_settlement_uses_first_post_expiry_obs() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, _rw) = mk_oracle_at(1_000, &mut sc, &clk);

    clk.set_for_testing(1_500);
    push_obs(&mut oracle, 555_000_000_000, 1_001);  // first post-expiry
    push_obs(&mut oracle, 999_000_000_000, 1_400);  // later, but cannot overwrite

    wick_oracle::lock_settlement_from_latest(&mut oracle, &clk);
    let settled = *option::borrow(wick_oracle::settlement_price(&oracle));
    assert!(settled == 555_000_000_000, 0);  // first post-expiry, not latest

    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(_rw);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = wick_oracle::ENoSettlementObservation)]
fun lock_settlement_aborts_with_no_post_expiry_obs() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, _rw) = mk_oracle_at(1_000, &mut sc, &clk);

    // Push only pre-expiry obs.
    push_obs(&mut oracle, 100_000_000_000, 500);

    // Move clock past expiry but no new obs.
    clk.set_for_testing(1_500);
    wick_oracle::lock_settlement_from_latest(&mut oracle, &clk);

    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(_rw);
    clk.destroy_for_testing();
    sc.end();
}

// === Snapshot freezes outcome against post-lock writes (H8 invariant) ===

#[test]
fun snapshot_freezes_outcome_against_post_lock_writes() {
    // Resolve a no-touch path, lock snapshot, attempt to push a fake "touch"
    // through apply_observation post-lock. → snapshot's touched_at remains None;
    // touch_outcome still returns false.
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, _rw) = mk_oracle_at(1_000, &mut sc, &clk);
    let mut p = po::new_v2(
        &oracle, BARRIER_ABOVE, po::touch_above(),
        0, 1, 3, 60_000, sc.ctx(),
    );

    // Push one below-barrier obs.
    clk.increment_for_testing(100);
    push_obs(&mut oracle, 99_000_000_000, 100);
    po::record(&mut p, &oracle, &clk);

    // Past expiry+drain, lock snapshot.
    clk.set_for_testing(7_000);
    po::lock_settlement_snapshot(&mut p, &clk);

    // Try to push 3 fake "touch" obs. record() must noop because of post-expiry
    // freeze, and even if it didn't, snapshot is the source of truth.
    let mut i = 0;
    while (i < 3) {
        push_obs(&mut oracle, 200_000_000_000, 2_000 + i * 100);
        po::record(&mut p, &oracle, &clk);
        i = i + 1;
    };

    // Snapshot remains frozen at no-touch.
    let snap = option::borrow(po::settlement_snapshot(&p));
    assert!(!po::snapshot_is_touched(snap), 0);
    assert!(po::snapshot_max_seen(snap) == 99_000_000_000, 1);
    assert!(!po::touch_outcome(&p, &clk), 2);

    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(_rw);
    sui::test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}

// === Buffer bps ===

#[test]
fun buffer_bps_skips_at_exact_barrier() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, _rw) = mk_oracle_at(1_000_000, &mut sc, &clk);
    // buffer = 10 bps = 0.1% above barrier
    let mut p = po::new_v2(
        &oracle, BARRIER_ABOVE, po::touch_above(),
        10, 1, 3, 60_000, sc.ctx(),
    );

    // Trigger = 105 × (1 + 10/10000) = 105.105.
    // Push 3 obs at exactly 105.000 — must NOT cross the buffered trigger.
    let mut i = 0;
    while (i < 3) {
        clk.increment_for_testing(100);
        push_obs(&mut oracle, 105_000_000_000, (i + 1) * 100);
        po::record(&mut p, &oracle, &clk);
        i = i + 1;
    };

    assert!(!po::is_touched(&p), 0);

    // Push 3 obs at 105.5 — above the buffered trigger.
    let mut j = 0;
    while (j < 3) {
        clk.increment_for_testing(100);
        push_obs(&mut oracle, 105_500_000_000, 1_000 + j * 100);
        po::record(&mut p, &oracle, &clk);
        j = j + 1;
    };

    assert!(po::is_touched(&p), 1);

    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(_rw);
    sui::test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}

// === Backwards-compat: default new() uses hardening defaults ===

#[test]
fun default_new_uses_hardening_defaults() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    let (oracle, _rw) = mk_oracle_at(1_000_000, &mut sc, &clk);
    let p = po::new(&oracle, BARRIER_ABOVE, po::touch_above(), sc.ctx());

    assert!(po::touch_confirmations_required(&p) == 3, 0);
    assert!(po::min_observations(&p) == 6, 1);
    assert!(po::buffer_bps(&p) == 0, 2);
    assert!(po::grace_ms(&p) == 60_000, 3);
    // A5d: deadband-on-by-default for production posture.
    assert!(po::deadband_bps(&p) == po::default_deadband_bps(), 4);
    assert!(po::default_deadband_bps() == 20, 5);

    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(_rw);
    sui::test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}

// === A5d: sub-spread deadband (papertrade-borrowed anti-jitter) ===

const LOWER_BARRIER_DNT: u64 = 95_000_000_000;   //  95.0
const UPPER_BARRIER_DNT: u64 = 105_000_000_000;  // 105.0

#[test]
fun tick_at_exactly_buffered_trigger_does_not_count_with_default_deadband() {
    // buffer = 10 bps, deadband = 20 bps (default). Barrier 105.
    // Buffered trigger = 105 × (1 + 10/10000) = 105.105.
    // Effective trigger = 105.105 + 105 × 20/10000 = 105.105 + 0.21 = 105.315.
    // A tick at EXACTLY the buffered trigger (105.105) sits inside the deadband
    // band and MUST NOT bump consecutive_cross_count.
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, _rw) = mk_oracle_at(1_000_000, &mut sc, &clk);
    let mut p = po::new_v2(
        &oracle, BARRIER_ABOVE, po::touch_above(),
        10, 1, 3, 60_000, sc.ctx(),  // buffer=10bps, default deadband=20bps
    );

    // Push 3 obs at exactly the buffered trigger.
    let mut i = 0;
    while (i < 3) {
        clk.increment_for_testing(100);
        push_obs(&mut oracle, 105_105_000_000, (i + 1) * 100);  // 105.105
        po::record(&mut p, &oracle, &clk);
        i = i + 1;
    };

    assert!(!po::is_touched(&p), 0);
    assert!(po::consecutive_cross_count(&p) == 0, 1);

    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(_rw);
    sui::test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun tick_clearing_trigger_by_more_than_deadband_does_count() {
    // Same setup as above. Effective trigger 105.315.
    // 3 ticks at 105.320 (just above) → counter goes to 3 and touch fires.
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, _rw) = mk_oracle_at(1_000_000, &mut sc, &clk);
    let mut p = po::new_v2(
        &oracle, BARRIER_ABOVE, po::touch_above(),
        10, 1, 3, 60_000, sc.ctx(),
    );

    let mut i = 0;
    while (i < 3) {
        clk.increment_for_testing(100);
        push_obs(&mut oracle, 105_320_000_000, (i + 1) * 100);  // 105.320 > 105.315
        po::record(&mut p, &oracle, &clk);
        i = i + 1;
    };

    assert!(po::is_touched(&p), 0);
    assert!(po::consecutive_cross_count(&p) == 3, 1);

    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(_rw);
    sui::test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun deadband_zero_makes_buffer_alone_decisive() {
    // Explicit deadband_bps=0 via new_v4 → only buffer_bps gates the cross.
    // buffer=10bps, barrier=105 → buffered trigger 105.105.
    // 3 ticks at exactly 105.105 must NOW count (no deadband margin).
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, _rw) = mk_oracle_at(1_000_000, &mut sc, &clk);
    let mut p = po::new_v4(
        &oracle, BARRIER_ABOVE, po::touch_above(),
        10,        // buffer_bps
        1,         // min_observations
        3,         // confirmations
        60_000,    // grace_ms
        5_000,     // pre_lock_drain_ms
        0,         // deadband_bps = 0 → buffer-only behavior
        sc.ctx(),
    );

    let mut i = 0;
    while (i < 3) {
        clk.increment_for_testing(100);
        push_obs(&mut oracle, 105_105_000_000, (i + 1) * 100);
        po::record(&mut p, &oracle, &clk);
        i = i + 1;
    };

    assert!(po::is_touched(&p), 0);
    assert!(po::consecutive_cross_count(&p) == 3, 1);
    assert!(po::deadband_bps(&p) == 0, 2);

    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(_rw);
    sui::test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun deadband_filter_resets_consecutive_counter_on_borderline_ticks() {
    // Alternate: clear-cross, borderline (no count + RESET), clear-cross,
    // borderline, clear-cross. With confirmations=3 the run never reaches 3,
    // so touched_at stays None and counter never lands on 3.
    // buffer=0, default deadband=20bps. Barrier 105 → effective trigger
    // 105 + 0.21 = 105.21. Borderline = 105.10 (sits in deadband band).
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, _rw) = mk_oracle_at(1_000_000, &mut sc, &clk);
    let mut p = po::new_v2(
        &oracle, BARRIER_ABOVE, po::touch_above(),
        0, 1, 3, 60_000, sc.ctx(),
    );

    let prices = vector[
        110_000_000_000,  // clear cross (above 105.21) → counter 1
        105_100_000_000,  // borderline (in deadband band) → counter resets to 0
        110_000_000_000,  // clear cross → counter 1
        105_100_000_000,  // borderline → counter resets to 0
        110_000_000_000,  // clear cross → counter 1
    ];
    let mut i = 0;
    while (i < 5) {
        clk.increment_for_testing(100);
        push_obs(&mut oracle, *vector::borrow(&prices, i), (i + 1) * 100);
        po::record(&mut p, &oracle, &clk);
        i = i + 1;
    };

    assert!(!po::is_touched(&p), 0);
    // Final tick was a clear cross → counter at 1, not 3.
    assert!(po::consecutive_cross_count(&p) == 1, 1);

    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(_rw);
    sui::test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun dnt_deadband_filters_upper_micro_flutter() {
    // DNT, upper barrier = 105. buffer=0, default deadband=20bps → effective
    // upper trigger = 105.21. A tick at 105.10 (just inside the deadband
    // band on the upper side) must NOT bump the upper confirmation counter.
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, _rw) = mk_oracle_at(1_000_000, &mut sc, &clk);
    let mut p = po::new_dnt(
        &oracle, LOWER_BARRIER_DNT, UPPER_BARRIER_DNT,
        0, 1, 1, 60_000, 5_000, sc.ctx(),
    );

    clk.increment_for_testing(100);
    push_obs(&mut oracle, 105_100_000_000, 100);  // < 105.21 effective trigger
    po::record(&mut p, &oracle, &clk);

    assert!(option::is_none(po::upper_touched_at(&p)), 0);
    assert!(option::is_none(po::lower_touched_at(&p)), 1);
    assert!(po::consecutive_upper_cross_count(&p) == 0, 2);
    assert!(po::dnt_neither_touched(&p), 3);

    // Same observation crossing past the deadband — now the upper IS hit.
    clk.increment_for_testing(100);
    push_obs(&mut oracle, 105_300_000_000, 200);  // > 105.21
    po::record(&mut p, &oracle, &clk);

    assert!(option::is_some(po::upper_touched_at(&p)), 4);
    assert!(!po::dnt_neither_touched(&p), 5);

    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(_rw);
    sui::test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun dnt_deadband_filters_lower_micro_flutter() {
    // DNT, lower barrier = 95. buffer=0, default deadband=20bps → effective
    // lower trigger = 95 − 95×20/10000 = 95 − 0.19 = 94.81. A tick at 94.90
    // (just above the deadband floor on the lower side) must NOT bump the
    // lower confirmation counter.
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (mut oracle, _rw) = mk_oracle_at(1_000_000, &mut sc, &clk);
    let mut p = po::new_dnt(
        &oracle, LOWER_BARRIER_DNT, UPPER_BARRIER_DNT,
        0, 1, 1, 60_000, 5_000, sc.ctx(),
    );

    clk.increment_for_testing(100);
    push_obs(&mut oracle, 94_900_000_000, 100);  // > 94.81 effective trigger
    po::record(&mut p, &oracle, &clk);

    assert!(option::is_none(po::upper_touched_at(&p)), 0);
    assert!(option::is_none(po::lower_touched_at(&p)), 1);
    assert!(po::consecutive_lower_cross_count(&p) == 0, 2);
    assert!(po::dnt_neither_touched(&p), 3);

    // Clear breach below the deadband floor — lower IS hit.
    clk.increment_for_testing(100);
    push_obs(&mut oracle, 94_700_000_000, 200);  // < 94.81
    po::record(&mut p, &oracle, &clk);

    assert!(option::is_some(po::lower_touched_at(&p)), 4);
    assert!(!po::dnt_neither_touched(&p), 5);

    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(_rw);
    sui::test_utils::destroy(p);
    clk.destroy_for_testing();
    sc.end();
}
