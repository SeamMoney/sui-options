// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

#[test_only]
module wick::risk_config_tests;

use std::string;
use sui::clock;
use sui::test_scenario as ts;
use sui::test_utils;
use wick::global_exposure_registry as ger;
use wick::risk_config as rc;

const ALICE: address = @0xA;

// === init defaults ===

#[test]
fun init_default_values() {
    let mut sc = ts::begin(ALICE);
    let (config, cap) = rc::init_for_testing(sc.ctx());

    assert!(rc::max_per_position_bps(&config) == 50, 0);
    assert!(rc::max_per_side_exposure_bps(&config) == 1000, 1);
    assert!(rc::max_global_pwe_bps(&config) == 2500, 2);
    assert!(rc::max_corr_bucket_bps(&config) == 4000, 3);
    assert!(rc::base_fee_bps(&config) == 50, 4);
    assert!(rc::cap_fee_bps(&config) == 450, 5);
    assert!(!rc::is_wind_down_active(&config), 6);

    test_utils::destroy(config);
    test_utils::destroy(cap);
    sc.end();
}

// === set_param hard bounds ===

#[test]
fun set_per_position_within_bounds_works() {
    let mut sc = ts::begin(ALICE);
    let (mut config, cap) = rc::init_for_testing(sc.ctx());
    rc::set_param(&cap, &mut config, 0, 100);  // 1%
    assert!(rc::max_per_position_bps(&config) == 100, 0);
    test_utils::destroy(config);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
#[expected_failure(abort_code = rc::EParamAboveMax)]
fun set_per_position_above_max_aborts() {
    let mut sc = ts::begin(ALICE);
    let (mut config, cap) = rc::init_for_testing(sc.ctx());
    rc::set_param(&cap, &mut config, 0, 600);  // > 5% max
    test_utils::destroy(config);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
#[expected_failure(abort_code = rc::EParamBelowMin)]
fun set_base_fee_below_min_aborts() {
    let mut sc = ts::begin(ALICE);
    let (mut config, cap) = rc::init_for_testing(sc.ctx());
    rc::set_param(&cap, &mut config, 4, 10);  // below 25 bps min
    test_utils::destroy(config);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
#[expected_failure(abort_code = rc::EParamBelowMin)]
fun set_cap_fee_below_base_fee_aborts() {
    let mut sc = ts::begin(ALICE);
    let (mut config, cap) = rc::init_for_testing(sc.ctx());
    // Set base_fee to 200, then try cap_fee = 100 (below base) — should abort
    rc::set_param(&cap, &mut config, 4, 200);
    rc::set_param(&cap, &mut config, 5, 100);  // 100 bps < 200 base = abort
    test_utils::destroy(config);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
#[expected_failure(abort_code = rc::EParamAboveMax)]
fun set_payout_mult_above_max_aborts() {
    let mut sc = ts::begin(ALICE);
    let (mut config, cap) = rc::init_for_testing(sc.ctx());
    rc::set_param(&cap, &mut config, 7, 100_000);  // way above 50_000 max
    test_utils::destroy(config);
    test_utils::destroy(cap);
    sc.end();
}

// === per-position cap ===

#[test]
fun per_position_cap_passes_within() {
    let mut sc = ts::begin(ALICE);
    let (config, cap) = rc::init_for_testing(sc.ctx());
    // V_eff = 1000, per_position = 50bps = 5 → cap = 5
    rc::assert_position_within_per_position_cap(&config, 5, 1000);
    rc::assert_position_within_per_position_cap(&config, 1, 1000);
    test_utils::destroy(config);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
#[expected_failure(abort_code = rc::ESinglePositionExceeded)]
fun per_position_cap_aborts_above() {
    let mut sc = ts::begin(ALICE);
    let (config, cap) = rc::init_for_testing(sc.ctx());
    rc::assert_position_within_per_position_cap(&config, 6, 1000);
    test_utils::destroy(config);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
#[expected_failure(abort_code = rc::EZeroVaultEffective)]
fun per_position_cap_zero_vault_aborts() {
    let mut sc = ts::begin(ALICE);
    let (config, cap) = rc::init_for_testing(sc.ctx());
    rc::assert_position_within_per_position_cap(&config, 1, 0);
    test_utils::destroy(config);
    test_utils::destroy(cap);
    sc.end();
}

// === per-side exposure cap ===

#[test]
fun per_side_cap_passes_within() {
    let mut sc = ts::begin(ALICE);
    let (config, cap) = rc::init_for_testing(sc.ctx());
    // V_eff = 1000, per_side = 1000bps = 10% → cap = 100
    rc::assert_within_per_side_cap(&config, 100, 1000);
    test_utils::destroy(config);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
#[expected_failure(abort_code = rc::ESingleSideExceeded)]
fun per_side_cap_aborts_above() {
    let mut sc = ts::begin(ALICE);
    let (config, cap) = rc::init_for_testing(sc.ctx());
    rc::assert_within_per_side_cap(&config, 101, 1000);
    test_utils::destroy(config);
    test_utils::destroy(cap);
    sc.end();
}

// === global pwe cap ===

#[test]
fun global_pwe_cap_passes_within() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    let (config, c_cap) = rc::init_for_testing(sc.ctx());
    let (mut reg, r_cap) = ger::init_for_testing(sc.ctx());

    // V_eff = 1_000_000, max_global_pwe = 2500bps = 25% → cap = 250_000
    let underlying = string::utf8(b"BTC");
    // Add some existing exposure
    ger::test_update_exposure(&mut reg, underlying, 0, true, 100_000, &clk);
    // Trying to add 100_000 more → total 200_000, under 250_000 cap
    rc::assert_within_global_pwe_cap(&config, &reg, underlying, 0, 100_000, 1_000_000, &clk);

    test_utils::destroy(config);
    test_utils::destroy(c_cap);
    test_utils::destroy(reg);
    test_utils::destroy(r_cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = rc::EGlobalUnderlyingExceeded)]
fun global_pwe_cap_aborts_above() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    let (config, c_cap) = rc::init_for_testing(sc.ctx());
    let (mut reg, r_cap) = ger::init_for_testing(sc.ctx());

    let underlying = string::utf8(b"BTC");
    ger::test_update_exposure(&mut reg, underlying, 0, true, 200_000, &clk);
    // 200_000 + 60_000 = 260_000 > 250_000 cap → abort
    rc::assert_within_global_pwe_cap(&config, &reg, underlying, 0, 60_000, 1_000_000, &clk);

    test_utils::destroy(config);
    test_utils::destroy(c_cap);
    test_utils::destroy(reg);
    test_utils::destroy(r_cap);
    clk.destroy_for_testing();
    sc.end();
}

// === correlation bucket cap ===

#[test]
fun correlation_bucket_cap_passes_when_bucket_unset() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    let (config, c_cap) = rc::init_for_testing(sc.ctx());
    let (reg, r_cap) = ger::init_for_testing(sc.ctx());

    // No bucket set → bucket pwe is 0, any addition is under cap
    rc::assert_within_correlation_bucket_cap(&config, &reg, 0, 0, 100_000, 1_000_000, &clk);

    test_utils::destroy(config);
    test_utils::destroy(c_cap);
    test_utils::destroy(reg);
    test_utils::destroy(r_cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = rc::ECorrelationBucketExceeded)]
fun correlation_bucket_cap_aborts_above_with_multi_underlying() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    let (config, c_cap) = rc::init_for_testing(sc.ctx());
    let (mut reg, r_cap) = ger::init_for_testing(sc.ctx());

    // V_eff = 1_000_000, corr_bucket = 4000bps = 40% → cap = 400_000
    let btc = string::utf8(b"BTC");
    let eth = string::utf8(b"ETH");
    ger::set_correlation_bucket(&r_cap, &mut reg, 0, vector[btc, eth]);
    ger::test_update_exposure(&mut reg, btc, 0, true, 200_000, &clk);
    ger::test_update_exposure(&mut reg, eth, 0, true, 150_000, &clk);
    // bucket total = 350_000; adding 60_000 → 410_000 > 400_000 → abort
    rc::assert_within_correlation_bucket_cap(&config, &reg, 0, 0, 60_000, 1_000_000, &clk);

    test_utils::destroy(config);
    test_utils::destroy(c_cap);
    test_utils::destroy(reg);
    test_utils::destroy(r_cap);
    clk.destroy_for_testing();
    sc.end();
}

// === queue circuit breaker ===

#[test]
fun queue_cb_passes_when_below_threshold() {
    let mut sc = ts::begin(ALICE);
    let (config, cap) = rc::init_for_testing(sc.ctx());
    // V_eff = 1000, threshold = 5000bps = 50% → cap = 500
    rc::assert_queue_within_circuit_breaker(&config, 499, 1000);
    rc::assert_queue_within_circuit_breaker(&config, 500, 1000);  // exactly at
    test_utils::destroy(config);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
#[expected_failure(abort_code = rc::EQueueCircuitBreakerTripped)]
fun queue_cb_aborts_above_threshold() {
    let mut sc = ts::begin(ALICE);
    let (config, cap) = rc::init_for_testing(sc.ctx());
    rc::assert_queue_within_circuit_breaker(&config, 501, 1000);
    test_utils::destroy(config);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
fun queue_cb_zero_vault_allows_open_for_bootstrap() {
    let mut sc = ts::begin(ALICE);
    let (config, cap) = rc::init_for_testing(sc.ctx());
    // Bootstrap mode — vault empty, anyone can open
    rc::assert_queue_within_circuit_breaker(&config, 1000, 0);
    test_utils::destroy(config);
    test_utils::destroy(cap);
    sc.end();
}

// === wind-down ===

#[test]
fun wind_down_inactive_allows_opens() {
    let mut sc = ts::begin(ALICE);
    let (config, cap) = rc::init_for_testing(sc.ctx());
    rc::assert_not_wind_down(&config);
    test_utils::destroy(config);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
#[expected_failure(abort_code = rc::EWindDownActive)]
fun wind_down_active_blocks_opens() {
    let mut sc = ts::begin(ALICE);
    let (mut config, cap) = rc::init_for_testing(sc.ctx());
    rc::test_set_active_wind_down(&mut config, true);
    rc::assert_not_wind_down(&config);
    test_utils::destroy(config);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
fun wind_down_activate_then_deactivate() {
    let mut sc = ts::begin(ALICE);
    let (mut config, cap) = rc::init_for_testing(sc.ctx());

    rc::activate_wind_down(&cap, &mut config, 5000, 100);
    assert!(rc::is_wind_down_active(&config), 0);

    rc::deactivate_wind_down(&cap, &mut config);
    assert!(!rc::is_wind_down_active(&config), 1);

    test_utils::destroy(config);
    test_utils::destroy(cap);
    sc.end();
}

// === compute_pwe sanity ===

#[test]
fun compute_pwe_at_barrier_is_full_payout() {
    // At barrier, P(touch) = 1.0 (PROB_MAX) → pwe = payout × 1.0 = payout (raw)
    let p = rc::compute_pwe(1000, 100_000_000_000, 100_000_000_000, 100, 0);
    assert!(p == 1000, 0);
}

#[test]
fun compute_pwe_far_returns_floor() {
    // Far from barrier with tight σ → P(touch) floors at 5% → pwe = payout × 5% = 50
    let p = rc::compute_pwe(1000, 100_000_000_000, 200_000_000_000, 1, 1);
    assert!(p == 50, 0);
}

// === compute_pwe_dnt sanity ===

#[test]
fun compute_pwe_dnt_at_either_barrier_is_full_outside_zero_inside() {
    // Spot exactly AT upper barrier — P_touch(upper) saturates to PROB_MAX = 1.0,
    // P_touch(lower) is also 1.0 (because seconds_remaining=0 codepath returns
    // PROB_MAX when spot == barrier; here lower != spot so we use the time-evolved
    // path). Use seconds_remaining=0 to force the at-barrier branch on UPPER, and
    // a wide lower so it stays at floor. Net: P_outside ≈ 1.0 (clipped at max),
    // P_inside ≈ 0 (clamped at 0).
    //
    // OUTSIDE position (is_inside=false) → pwe = payout × 1.0 = payout
    let pwe_outside = rc::compute_pwe_dnt(
        1000,                  // payout
        100_000_000_000,       // spot
        100_000_000_000,       // upper_barrier (== spot)
        50_000_000_000,        // lower_barrier (far below)
        100,                   // sigma_bps_per_sqrt_sec
        0,                     // seconds_remaining = 0 → at-barrier branch
        false,                 // is_inside = false (OUTSIDE)
    );
    assert!(pwe_outside == 1000, 0);

    // INSIDE position on the same setup → pwe = payout × 0 = 0
    let pwe_inside = rc::compute_pwe_dnt(
        1000,
        100_000_000_000,
        100_000_000_000,
        50_000_000_000,
        100,
        0,
        true,
    );
    assert!(pwe_inside == 0, 0);
}

#[test]
fun compute_pwe_dnt_inside_plus_outside_equals_payout() {
    // Conservation: for any (spot, corridor, σ, t), pwe_inside + pwe_outside
    // should equal payout (within rounding). This is the union-bound
    // identity P_outside + P_inside = 1 by construction.
    let payout: u64 = 100_000;
    let spot: u64 = 100_000_000_000;
    let upper: u64 = 105_000_000_000;   // +5%
    let lower: u64 = 95_000_000_000;    // -5%
    let sigma: u64 = 50;                // tight vol so P_touch < PROB_MAX
    let secs: u64 = 3600;               // 1 hour

    let pwe_inside = rc::compute_pwe_dnt(
        payout, spot, upper, lower, sigma, secs, true,
    );
    let pwe_outside = rc::compute_pwe_dnt(
        payout, spot, upper, lower, sigma, secs, false,
    );
    // Sum may differ from payout by at most 1 unit due to integer truncation
    // (each side rounds independently in u128 arithmetic).
    let total = pwe_inside + pwe_outside;
    let target = payout as u128;
    let drift = if (total > target) total - target else target - total;
    assert!(drift <= 1, 0);
}

#[test]
fun compute_pwe_dnt_union_bound_clips_at_one() {
    // Adversarial case: spot ON upper barrier with σ huge enough that the
    // touch-lower probability is also non-trivial. The union bound
    // (P_up + P_dn) would exceed 1.0; we must clip to prevent P_inside
    // from underflowing below 0.
    let pwe_outside = rc::compute_pwe_dnt(
        10_000,
        100_000_000_000,
        100_000_000_000,        // upper = spot → P_up at max
        99_000_000_000,         // lower close enough that P_dn is also large
        10_000,                 // wide σ
        100,                    // long window
        false,
    );
    // Should be ≤ payout (cap respected) — never overflow into a value > payout.
    assert!(pwe_outside <= 10_000, 0);

    let pwe_inside = rc::compute_pwe_dnt(
        10_000,
        100_000_000_000,
        100_000_000_000,
        99_000_000_000,
        10_000,
        100,
        true,
    );
    // INSIDE must be exactly 0 when OUTSIDE saturates — proves the clamp.
    assert!(pwe_inside == 0, 0);
}

// === composed assert_open_allowed ===

#[test]
fun composed_assert_open_allowed_passes() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    let (config, c_cap) = rc::init_for_testing(sc.ctx());
    let (reg, r_cap) = ger::init_for_testing(sc.ctx());

    let underlying = string::utf8(b"BTC");
    rc::assert_open_allowed(
        &config, &reg, underlying, 0, 0,
        5,      // payout (within 50bps of 1000 = 5)
        50,     // new_side_exposure (within 1000bps of 1000 = 100)
        100,    // additional_pwe raw (within 25% × 1000 = 250 cap)
        1000,   // v_eff
        0,      // queue_total
        &clk,
    );

    test_utils::destroy(config);
    test_utils::destroy(c_cap);
    test_utils::destroy(reg);
    test_utils::destroy(r_cap);
    clk.destroy_for_testing();
    sc.end();
}
