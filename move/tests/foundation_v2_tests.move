// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

#[test_only]
module wick::foundation_v2_tests;

use std::string;
use sui::clock;
use sui::test_scenario as ts;
use wick::global_exposure_registry as ger;
use wick::oracle_version_lock as ovl;
use wick::probability;

const ALICE: address = @0xA;

// === probability ===

#[test]
fun probability_at_barrier_returns_max_when_zero_time() {
    let p = probability::touch_probability(
        100_000_000_000,  // spot
        100_000_000_000,  // barrier
        100,              // sigma
        0,                // seconds_remaining
    );
    assert!(p == probability::prob_max(), 0);
}

#[test]
fun probability_far_from_barrier_returns_floor() {
    let p = probability::touch_probability(
        100_000_000_000,
        200_000_000_000,  // 100% away
        10,               // tiny sigma
        60,               // short window
    );
    assert!(p == probability::prob_min(), 0);
}

#[test]
fun probability_close_to_barrier_high() {
    let p = probability::touch_probability(
        99_500_000_000,   // spot
        100_000_000_000,  // barrier (0.5% away)
        100,              // sigma
        3600,             // 1 hour
    );
    // Should be substantially above floor
    assert!(p > probability::prob_min() * 5, 0);
    assert!(p <= probability::prob_max(), 1);
}

#[test]
fun probability_monotonic_in_time() {
    // Same setup, more time → higher probability of touch
    let p_short = probability::touch_probability(
        99_000_000_000,
        100_000_000_000,
        50,
        60,
    );
    let p_long = probability::touch_probability(
        99_000_000_000,
        100_000_000_000,
        50,
        3600,
    );
    assert!(p_long >= p_short, 0);
}

#[test]
fun probability_lookup_is_monotonic_decreasing() {
    let mut prev = probability::test_lookup(0);
    let mut z_bps = 1250u64;  // step by 0.125
    while (z_bps < 40_000) {
        let val = probability::test_lookup(z_bps);
        assert!(val <= prev, 0);
        prev = val;
        z_bps = z_bps + 1250;
    };
}

#[test]
fun isqrt_basic() {
    assert!(probability::test_isqrt(0) == 0, 0);
    assert!(probability::test_isqrt(1) == 1, 1);
    assert!(probability::test_isqrt(4) == 2, 2);
    assert!(probability::test_isqrt(9) == 3, 3);
    assert!(probability::test_isqrt(100) == 10, 4);
    assert!(probability::test_isqrt(10_000) == 100, 5);
    // Non-perfect squares: floor
    assert!(probability::test_isqrt(2) == 1, 6);
    assert!(probability::test_isqrt(3) == 1, 7);
    assert!(probability::test_isqrt(8) == 2, 8);
    assert!(probability::test_isqrt(99) == 9, 9);
}

// === oracle_version_lock ===

#[test]
fun lock_initializes_with_pinned_values() {
    let mut sc = ts::begin(ALICE);
    let pkg = @0xCAFE;
    let obj = object::id_from_address(@0xBABE);
    let (lock, cap) = ovl::init_for_testing(pkg, obj, sc.ctx());

    assert!(ovl::predict_pkg(&lock) == pkg, 0);
    assert!(ovl::predict_object_id(&lock) == obj, 1);
    assert!(!ovl::is_migrating(&lock), 2);

    ovl::assert_pinned(&lock, pkg, obj);

    sui::test_utils::destroy(lock);
    sui::test_utils::destroy(cap);
    sc.end();
}

#[test]
#[expected_failure(abort_code = ovl::EVersionMismatch)]
fun lock_assert_pinned_rejects_wrong_pkg() {
    let mut sc = ts::begin(ALICE);
    let pkg = @0xCAFE;
    let obj = object::id_from_address(@0xBABE);
    let (lock, cap) = ovl::init_for_testing(pkg, obj, sc.ctx());

    ovl::assert_pinned(&lock, @0xDEAD, obj);  // wrong pkg

    sui::test_utils::destroy(lock);
    sui::test_utils::destroy(cap);
    sc.end();
}

#[test]
fun lock_migration_flow() {
    let mut sc = ts::begin(ALICE);
    let old_pkg = @0xCAFE;
    let old_obj = object::id_from_address(@0xBABE);
    let new_pkg = @0xDEAD;
    let new_obj = object::id_from_address(@0xBEEF);
    let (mut lock, cap) = ovl::init_for_testing(old_pkg, old_obj, sc.ctx());

    ovl::start_migration(&cap, &mut lock, new_pkg, new_obj);
    assert!(ovl::is_migrating(&lock), 0);
    // Old values still pinned during migration
    ovl::assert_pinned(&lock, old_pkg, old_obj);

    ovl::complete_migration(&cap, &mut lock);
    assert!(!ovl::is_migrating(&lock), 1);
    assert!(ovl::predict_pkg(&lock) == new_pkg, 2);
    assert!(ovl::predict_object_id(&lock) == new_obj, 3);
    // After completion, old values reject
    // (would assert here but test framework doesn't allow chained expected_failure)

    sui::test_utils::destroy(lock);
    sui::test_utils::destroy(cap);
    sc.end();
}

#[test]
#[expected_failure(abort_code = ovl::ENotMigrating)]
fun lock_complete_migration_without_start_aborts() {
    let mut sc = ts::begin(ALICE);
    let (mut lock, cap) = ovl::init_for_testing(@0x1, object::id_from_address(@0x2), sc.ctx());
    ovl::complete_migration(&cap, &mut lock);
    sui::test_utils::destroy(lock);
    sui::test_utils::destroy(cap);
    sc.end();
}

// === global_exposure_registry ===

#[test]
fun registry_open_then_close_zeros_exposure() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    let (mut reg, cap) = ger::init_for_testing(sc.ctx());

    let underlying = string::utf8(b"BTC");
    let touch_side = 0u8;
    let payout: u128 = 100_000_000_000;

    // Open: increase
    ger::test_update_exposure(&mut reg, underlying, touch_side, true, payout, &clk);
    let after_open = ger::read_pwe(&reg, underlying, touch_side, &clk);
    assert!(after_open == payout, 0);

    // Close: decrease (no time passed, no decay)
    ger::test_update_exposure(&mut reg, underlying, touch_side, false, payout, &clk);
    let after_close = ger::read_pwe(&reg, underlying, touch_side, &clk);
    assert!(after_close == 0, 1);

    sui::test_utils::destroy(reg);
    sui::test_utils::destroy(cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun registry_independent_underlyings() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    let (mut reg, cap) = ger::init_for_testing(sc.ctx());

    let btc = string::utf8(b"BTC");
    let sui_under = string::utf8(b"SUI");

    ger::test_update_exposure(&mut reg, btc, 0, true, 100, &clk);
    ger::test_update_exposure(&mut reg, sui_under, 0, true, 200, &clk);

    assert!(ger::read_pwe(&reg, btc, 0, &clk) == 100, 0);
    assert!(ger::read_pwe(&reg, sui_under, 0, &clk) == 200, 1);
    // Other side untouched
    assert!(ger::read_pwe(&reg, btc, 1, &clk) == 0, 2);

    sui::test_utils::destroy(reg);
    sui::test_utils::destroy(cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun ewma_decay_one_half_life_halves() {
    let one_half_life = ger::ewma_half_life_ms();
    let val: u128 = 1_000_000;
    let decayed = ger::test_ewma_decay(val, one_half_life);
    // After exactly one half-life, expect ~half (with small error from frac path)
    // Allowed range: 460k–540k
    assert!(decayed >= 460_000, 0);
    assert!(decayed <= 540_000, 1);
}

#[test]
fun ewma_decay_zero_elapsed_no_change() {
    let val: u128 = 1_000_000;
    let decayed = ger::test_ewma_decay(val, 0);
    assert!(decayed == val, 0);
}

#[test]
fun ewma_decay_far_future_zeroes() {
    let val: u128 = 1_000_000;
    // 64 half-lives = 64 hours. After this, value should round to ~0.
    let elapsed = ger::ewma_half_life_ms() * 64;
    let decayed = ger::test_ewma_decay(val, elapsed);
    assert!(decayed <= 1, 0);
}

#[test]
fun registry_correlation_bucket_sums() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    let (mut reg, cap) = ger::init_for_testing(sc.ctx());

    let btc = string::utf8(b"BTC");
    let eth = string::utf8(b"ETH");
    let sui_u = string::utf8(b"SUI");

    ger::set_correlation_bucket(
        &cap,
        &mut reg,
        0,  // crypto_majors
        vector[btc, eth, sui_u],
    );

    ger::test_update_exposure(&mut reg, btc, 0, true, 100, &clk);
    ger::test_update_exposure(&mut reg, eth, 0, true, 200, &clk);
    ger::test_update_exposure(&mut reg, sui_u, 0, true, 50, &clk);

    let total = ger::read_bucket_pwe(&reg, 0, 0, &clk);
    assert!(total == 350, 0);

    sui::test_utils::destroy(reg);
    sui::test_utils::destroy(cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun registry_close_below_zero_clamps() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    let (mut reg, cap) = ger::init_for_testing(sc.ctx());

    let btc = string::utf8(b"BTC");
    ger::test_update_exposure(&mut reg, btc, 0, true, 100, &clk);
    // Close more than open — should clamp to 0
    ger::test_update_exposure(&mut reg, btc, 0, false, 200, &clk);
    assert!(ger::read_pwe(&reg, btc, 0, &clk) == 0, 0);

    sui::test_utils::destroy(reg);
    sui::test_utils::destroy(cap);
    clk.destroy_for_testing();
    sc.end();
}
