// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

#[test_only]
/// Known-value tests for `compute_pwe_dnt` — the double-no-touch corridor PWE
/// (union bound P_outside = clip(P_touch(upper) + P_touch(lower)); P_inside =
/// 1 − P_outside), feeding the DNT exposure caps.
///
/// risk_config_tests.move covers the at-barrier saturation, the
/// inside+outside=payout identity, and the union clip — but never pins the
/// union-bound combination at an exact intermediate split. These do, reusing the
/// touch_probability values already proven in probability_tests.move (#159):
///   barrier 100_000, sigma 100 bps/√s, seconds 100 ⇒ z_bps = dist·100_000/barrier.
///   touch_probability(95_000, 100_000, 100, 100) = 617_075_078  (z=0.5)
///   a far barrier ⇒ floors at PROB_MIN = 50_000_000
///
/// payout is set to 1e9 (= PROB_SCALE) so pwe = p_winning exactly (no rounding).
module wick::dnt_pwe_tests;

use wick::risk_config as rc;

const PAYOUT: u64 = 1_000_000_000; // == PROB_SCALE, so pwe = p_winning exactly
const SIG: u64 = 100;
const SEC: u64 = 100;

// === one barrier in the unclamped middle, the other floored ===

#[test]
fun pwe_dnt_intermediate_upper_floored_lower() {
    // spot 95_000 ⇒ z(upper 100_000) = 0.5 ⇒ p_up = 617_075_078
    // lower 50_000 is far ⇒ p_dn floors at 50_000_000
    // P_outside = 617_075_078 + 50_000_000 = 667_075_078 ; P_inside = 332_924_922
    let out = rc::compute_pwe_dnt(PAYOUT, 95_000, 100_000, 50_000, SIG, SEC, false);
    let ins = rc::compute_pwe_dnt(PAYOUT, 95_000, 100_000, 50_000, SIG, SEC, true);
    assert!(out == 667_075_078, 0);
    assert!(ins == 332_924_922, 1);
    assert!(out + ins == (PAYOUT as u128), 2); // conservation at an exact known split
}

// === both barriers far ⇒ outside floors at 2·PROB_MIN, inside ≈ full ===

#[test]
fun pwe_dnt_wide_corridor_inside_near_certain() {
    // spot 100_000, upper 200_000 + lower 50_000 both far ⇒ each p floors at
    // 50_000_000 ⇒ P_outside = 100_000_000 ; P_inside = 900_000_000
    let out = rc::compute_pwe_dnt(PAYOUT, 100_000, 200_000, 50_000, SIG, SEC, false);
    let ins = rc::compute_pwe_dnt(PAYOUT, 100_000, 200_000, 50_000, SIG, SEC, true);
    assert!(out == 100_000_000, 0);
    assert!(ins == 900_000_000, 1);
    assert!(out + ins == (PAYOUT as u128), 2);
}

// === payout scales the probability linearly (pwe = payout · p / scale) ===

#[test]
fun pwe_dnt_scales_with_payout() {
    // Same corridor as the wide case (P_outside = 0.1); double the payout ⇒
    // double the pwe. payout 2e9 ⇒ outside = 200_000_000.
    let out = rc::compute_pwe_dnt(2_000_000_000, 100_000, 200_000, 50_000, SIG, SEC, false);
    assert!(out == 200_000_000, 0);
}
