// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

#[test_only]
/// Known-value tests for `touch_probability` (= 2·Φ(−z), step-tabulated,
/// clamped to [PROB_MIN, PROB_MAX]). This feeds the exposure caps, so a wrong
/// Φ table entry, the ×2 reflection, the z-computation, or the clamp boundary
/// is a loss-of-funds risk — yet the existing tests only hit the MIN/MAX clamps.
/// These pin the actual numbers in the unclamped middle.
///
/// Setup so z_bps reads straight off the distance:
///   barrier 100_000, sigma 100 bps/√s, seconds 100 (√ = 10)
///   ⇒ sigma_in_units = barrier · (sigma·√sec)/10_000 = 100_000 · 1000/10_000 = 10_000
///   ⇒ z_bps = dist · 10_000 / 10_000 = dist   (spot 90_000 ⇒ z = 1.0, etc.)
module wick::probability_tests;

use wick::probability as prob;

const B: u64 = 100_000;
const SIG: u64 = 100;
const SEC: u64 = 100;

// === unclamped known values: p = 2·Φ(−z) ===

#[test]
fun touch_prob_exact_at_z_0_5() {
    // spot 95_000 ⇒ z = 0.5 ⇒ 2·Φ(−0.5) = 2·308_537_539 = 617_075_078
    assert!(prob::touch_probability(95_000, B, SIG, SEC) == 617_075_078, 0);
}

#[test]
fun touch_prob_exact_at_z_1_0() {
    // spot 90_000 ⇒ z = 1.0 ⇒ 2·158_655_254 = 317_310_508
    assert!(prob::touch_probability(90_000, B, SIG, SEC) == 317_310_508, 0);
}

#[test]
fun touch_prob_exact_at_z_1_5() {
    // spot 85_000 ⇒ z = 1.5 ⇒ 2·66_807_201 = 133_614_402 (still above the 0.05 floor)
    assert!(prob::touch_probability(85_000, B, SIG, SEC) == 133_614_402, 0);
}

// === the [PROB_MIN, PROB_MAX] clamps ===

#[test]
fun touch_prob_clamps_to_floor_far_out() {
    // spot 80_000 ⇒ z = 2.0 ⇒ 2·22_750_132 = 45_500_264 < PROB_MIN ⇒ clamped up to 0.05
    assert!(prob::touch_probability(80_000, B, SIG, SEC) == prob::prob_min(), 0);
}

#[test]
fun touch_prob_is_max_at_barrier() {
    // z = 0 ⇒ 2·Φ(0) = 2·0.5 = 1.0 = PROB_MAX
    assert!(prob::touch_probability(100_000, B, SIG, SEC) == prob::prob_max(), 0);
}

// === above vs below the barrier is identical at the same distance ===

#[test]
fun touch_prob_symmetric_about_barrier() {
    let below = prob::touch_probability(95_000, B, SIG, SEC);
    let above = prob::touch_probability(105_000, B, SIG, SEC);
    assert!(below == above, 0);
    assert!(below == 617_075_078, 1);
}

// === Φ(-z) lookup itself, at exact table points ===

#[test]
fun phi_lookup_known_points() {
    assert!(prob::test_lookup(0) == 500_000_000, 0);       // Φ(0)  = 0.5
    assert!(prob::test_lookup(10_000) == 158_655_254, 1);  // Φ(-1) = 0.15866
    assert!(prob::test_lookup(20_000) == 22_750_132, 2);   // Φ(-2) = 0.02275
    assert!(prob::test_lookup(40_000) == 0, 3);            // z ≥ 4 ⇒ negligible
}

// === the lookup is a 0.125-wide STEP (no interpolation) — document it ===

#[test]
fun phi_lookup_is_stepwise_within_a_bin() {
    // z_bps 10_000 and 11_000 fall in the same 0.125 bin (idx 8) ⇒ identical
    assert!(prob::test_lookup(10_000) == prob::test_lookup(11_000), 0);
    // 11_250 crosses into the next bin (idx 9) ⇒ strictly smaller
    assert!(prob::test_lookup(11_250) < prob::test_lookup(10_000), 1);
}

// === no time left: at barrier ⇒ MAX, off barrier ⇒ MIN ===

#[test]
fun touch_prob_zero_seconds_edges() {
    assert!(prob::touch_probability(100_000, B, SIG, 0) == prob::prob_max(), 0);
    assert!(prob::touch_probability(95_000, B, SIG, 0) == prob::prob_min(), 1);
}
