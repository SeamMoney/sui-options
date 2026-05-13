// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

#[test_only]
module wick::impact_fee_tests;

use wick::impact_fee as fee;

const BARRIER: u64 = 100_000_000_000;  // 100.0 in 1e9 scaling

// === decisiveness_bps ===

#[test]
fun touch_above_winner_decisiveness_proportional_to_overshoot() {
    // touch_above (direction=0), winner. max_seen = 105, barrier = 100 → m = 5%
    let snap = fee::snapshot_at_lock(
        BARRIER, 0,
        105_000_000_000,  // max_seen 5% above barrier
        90_000_000_000,
        1000, 1000,
    );
    let m = fee::decisiveness_bps(&snap, true);
    assert!(m == 500, 0);  // 5% = 500 bps
}

#[test]
fun touch_above_winner_zero_decisiveness_when_max_at_barrier() {
    let snap = fee::snapshot_at_lock(BARRIER, 0, BARRIER, 90_000_000_000, 1000, 1000);
    let m = fee::decisiveness_bps(&snap, true);
    assert!(m == 0, 0);
}

#[test]
fun touch_below_winner_decisiveness() {
    // touch_below (direction=1), winner. min_seen = 95, barrier = 100 → m = 5%
    let snap = fee::snapshot_at_lock(BARRIER, 1, 110_000_000_000, 95_000_000_000, 1000, 1000);
    let m = fee::decisiveness_bps(&snap, true);
    assert!(m == 500, 0);
}

#[test]
fun no_touch_above_winner_decisiveness_proportional_to_room_kept() {
    // touch_above (dir=0), no_touch winner: max_seen never reached barrier.
    // max_seen = 95, barrier = 100 → kept 5% room → m = 500
    let snap = fee::snapshot_at_lock(BARRIER, 0, 95_000_000_000, 90_000_000_000, 1000, 1000);
    let m = fee::decisiveness_bps(&snap, false);
    assert!(m == 500, 0);
}

#[test]
fun no_touch_winner_zero_decisiveness_when_max_at_barrier() {
    let snap = fee::snapshot_at_lock(BARRIER, 0, BARRIER, 90_000_000_000, 1000, 1000);
    let m = fee::decisiveness_bps(&snap, false);
    assert!(m == 0, 0);
}

// === vulnerability_bps ===

#[test]
fun vulnerability_payout_over_max_exposure() {
    // payout=100, exposures (200, 1000) → max=1000, v = 100/1000 = 1000bps = 10%
    let snap = fee::snapshot_at_lock(BARRIER, 0, BARRIER, 0, 200, 1000);
    let v = fee::vulnerability_bps(&snap, 100);
    assert!(v == 1000, 0);
}

#[test]
fun vulnerability_caps_at_full() {
    // payout > max_exposure shouldn't happen but if it does, cap at 10_000
    let snap = fee::snapshot_at_lock(BARRIER, 0, BARRIER, 0, 100, 50);
    let v = fee::vulnerability_bps(&snap, 1000);
    assert!(v == 10_000, 0);
}

#[test]
fun vulnerability_returns_max_when_no_exposure() {
    let snap = fee::snapshot_at_lock(BARRIER, 0, BARRIER, 0, 0, 0);
    let v = fee::vulnerability_bps(&snap, 100);
    assert!(v == 10_000, 0);
}

// === compute_fee_bps formula edge cases ===

#[test]
fun fee_zero_decisiveness_returns_base() {
    // m = 0 → fee = base
    let f = fee::compute_fee_bps(0, 5000, 50, 450, 50);
    assert!(f == 50, 0);
}

#[test]
fun fee_zero_vulnerability_returns_base() {
    // v = 0 → fee = base (sqrt(0) = 0 → no extra)
    let f = fee::compute_fee_bps(500, 0, 50, 450, 50);
    assert!(f == 50, 0);
}

#[test]
fun fee_max_decisiveness_max_vulnerability_caps() {
    // m = 1000% (way past saturation), v = 100% (full vulnerability) → fee ≈ cap
    let f = fee::compute_fee_bps(100_000, 10_000, 50, 450, 50);
    // m_factor ≈ 1.0, sqrt(v) = 1.0, extra = 400 → fee ≈ 450
    assert!(f >= 440, 0);
    assert!(f <= 450, 1);
}

#[test]
fun fee_at_saturation_m_equals_m0_half_extra() {
    // m = m0 = 50, v = 100% → m_factor = 0.5, sqrt(v)=1.0, extra = 200 → fee = 250
    let f = fee::compute_fee_bps(50, 10_000, 50, 450, 50);
    assert!(f == 250, 0);
}

#[test]
fun fee_quarter_vulnerability_halves_extra() {
    // m = m0, v = 25% → m_factor = 0.5, sqrt(v) = 0.5, extra = 100 → fee = 150
    let f = fee::compute_fee_bps(50, 2500, 50, 450, 50);
    assert!(f == 150, 0);
}

#[test]
fun fee_monotonic_in_decisiveness() {
    // Holding v constant, fee should grow with m (then plateau)
    let v = 5000;
    let f1 = fee::compute_fee_bps(10, v, 50, 450, 50);
    let f2 = fee::compute_fee_bps(50, v, 50, 450, 50);
    let f3 = fee::compute_fee_bps(500, v, 50, 450, 50);
    let f4 = fee::compute_fee_bps(5000, v, 50, 450, 50);
    assert!(f1 <= f2, 0);
    assert!(f2 <= f3, 1);
    assert!(f3 <= f4, 2);
}

#[test]
fun fee_monotonic_in_vulnerability() {
    let m = 100;
    let f_low = fee::compute_fee_bps(m, 100, 50, 450, 50);
    let f_mid = fee::compute_fee_bps(m, 5000, 50, 450, 50);
    let f_high = fee::compute_fee_bps(m, 10_000, 50, 450, 50);
    assert!(f_low <= f_mid, 0);
    assert!(f_mid <= f_high, 1);
}

#[test]
fun fee_bounds_respected() {
    // Random sweep — all fees should be in [base, cap]
    let mut m = 0u64;
    while (m <= 5000) {
        let mut v = 0u64;
        while (v <= 10_000) {
            let f = fee::compute_fee_bps(m, v, 50, 450, 50);
            assert!(f >= 50, 0);
            assert!(f <= 450, 1);
            v = v + 500;
        };
        m = m + 100;
    };
}

// === apply_fee ===

#[test]
fun apply_fee_extracts_correct_amount() {
    let (net, fee_paid) = fee::apply_fee(1000, 100);  // 100bps = 1%
    // Ceiling: 1000 × 100 / 10000 = 10
    assert!(net == 990, 0);
    assert!(fee_paid == 10, 1);
    assert!(net + fee_paid == 1000, 2);
}

#[test]
fun apply_fee_zero_bps_no_fee() {
    let (net, fee_paid) = fee::apply_fee(1000, 0);
    assert!(net == 1000, 0);
    assert!(fee_paid == 0, 1);
}

#[test]
fun apply_fee_handles_dust_via_ceiling() {
    // Tiny payout, small bps — fee should round UP to at least 1
    let (net, fee_paid) = fee::apply_fee(100, 5);  // 0.05% of 100 = 0.005, ceil = 1
    assert!(fee_paid == 1, 0);
    assert!(net == 99, 1);
}

#[test]
fun apply_fee_caps_at_payout() {
    // Pathological: 200% bps → fee would be 2× payout, capped to payout
    let (net, fee_paid) = fee::apply_fee(100, 20_000);
    assert!(fee_paid == 100, 0);
    assert!(net == 0, 1);
}

// === composed fee_for_winner ===

#[test]
fun winner_with_grazing_touch_pays_near_base() {
    // Touch barely above barrier (1 bp), v = 50%
    let snap = fee::snapshot_at_lock(
        BARRIER, 0,
        BARRIER + 10_000_000,  // 0.01% above
        90_000_000_000,
        500, 1000,  // max exposure 1000
    );
    let (net, fee_paid) = fee::fee_for_winner(&snap, 500, true, 50, 450);
    // Should be very close to base 50 bps = 2.5 of 500
    assert!(fee_paid <= 5, 0);  // dust + tiny extra
    assert!(net >= 495, 1);
}

#[test]
fun winner_with_decisive_touch_pays_more() {
    // Touch decisively past barrier (10%), v = 100%
    let snap = fee::snapshot_at_lock(
        BARRIER, 0,
        110_000_000_000,  // 10% above
        90_000_000_000,
        500, 1000,
    );
    let (net, fee_paid) = fee::fee_for_winner(&snap, 1000, true, 50, 450);
    // m = 1000bps, v = 10000bps. m_factor = 1000/(1000+50) ≈ 0.952, sqrt(v) = 1.0
    // extra ≈ 400 × 0.952 = 381. fee ≈ 431 bps. fee_paid ≈ 43.1, ceil 44
    assert!(fee_paid >= 40, 0);
    assert!(fee_paid <= 50, 1);
    assert!(net + fee_paid == 1000, 2);
}

// === snapshot read accessors ===

#[test]
fun snapshot_accessors_return_inputs() {
    let snap = fee::snapshot_at_lock(BARRIER, 1, 105, 95, 200, 300);
    assert!(fee::barrier(&snap) == BARRIER, 0);
    assert!(fee::direction(&snap) == 1, 1);
    assert!(fee::max_seen(&snap) == 105, 2);
    assert!(fee::min_seen(&snap) == 95, 3);
    assert!(fee::touch_exposure(&snap) == 200, 4);
    assert!(fee::no_touch_exposure(&snap) == 300, 5);
}
