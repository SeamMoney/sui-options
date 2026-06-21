// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

#[test_only]
/// Known-value tests for the Bachelier ride-cashout factor.
///
/// ride_pricing.move's inline tests cover monotonicity, symmetry and bounds —
/// but never assert the factor equals a KNOWN value at a known z. A wrong table
/// entry, a z-computation slip, or a broken interpolation all pass those. These
/// pin the actual numbers against 2·Φ(−z).
///
/// Setup chosen so z reads straight off the distance:
///   barrier 100_000, sigma 100 bps/√s, seconds 100 (√ = 10)
///   ⇒ sigma_total = barrier · sigma/10_000 · √sec = 100_000 · 0.01 · 10 = 10_000
///   ⇒ z = |barrier − spot| / 10_000   (spot 90_000 ⇒ z = 1.0, etc.)
module wick::ride_pricing_tests;

use wick::ride_pricing as rp;

const B: u64 = 100_000;
const SIG: u64 = 100;
const SEC: u64 = 100;

// === exact table values: factor = 2·Φ(−z), 1e9 fixed point ===

#[test]
fun factor_exact_at_z_0_5() {
    // spot 95_000 ⇒ z = 0.5 ⇒ 2·Φ(−0.5) = 0.6170751
    assert!(rp::bachelier_cashout_factor(95_000, B, SIG, SEC) == 617_075_100, 0);
}

#[test]
fun factor_exact_at_z_1_0() {
    // spot 90_000 ⇒ z = 1.0 ⇒ 0.3173105
    assert!(rp::bachelier_cashout_factor(90_000, B, SIG, SEC) == 317_310_500, 0);
}

#[test]
fun factor_exact_at_z_2_0() {
    // spot 80_000 ⇒ z = 2.0 ⇒ 0.0455003
    assert!(rp::bachelier_cashout_factor(80_000, B, SIG, SEC) == 45_500_300, 0);
}

// === linear interpolation between table entries ===

#[test]
fun factor_interpolates_at_z_0_75() {
    // spot 92_500 ⇒ z = 0.75, halfway between z=0.7 (483_945_200) and
    // z=0.8 (423_711_400): 483_945_200 − 60_233_800·500/1000 = 453_828_300
    assert!(rp::bachelier_cashout_factor(92_500, B, SIG, SEC) == 453_828_300, 0);
}

#[test]
fun factor_interpolates_at_z_0_55() {
    // spot 94_500 ⇒ z = 0.55, halfway between z=0.5 (617_075_100) and
    // z=0.6 (548_506_100): 617_075_100 − 68_569_000·500/1000 = 582_790_600
    assert!(rp::bachelier_cashout_factor(94_500, B, SIG, SEC) == 582_790_600, 0);
}

// === above vs below the barrier is byte-identical at the same z ===

#[test]
fun above_below_barrier_are_identical_at_z_0_75() {
    let below = rp::bachelier_cashout_factor(92_500, B, SIG, SEC);   // 7_500 below
    let above = rp::bachelier_cashout_factor(107_500, B, SIG, SEC);  // 7_500 above
    assert!(below == above, 0);
    assert!(below == 453_828_300, 1);
}

// === overflow safety: BTC-scale barrier keeps the u128 math intact ===

#[test]
fun no_overflow_at_large_barrier() {
    // barrier 1e10, spot 9e9 (z = 1.0 again) ⇒ still 317_310_500, no overflow
    let f = rp::bachelier_cashout_factor(9_000_000_000, 10_000_000_000, SIG, SEC);
    assert!(f == 317_310_500, 0);
}

// === isqrt exactness on larger inputs (used for √seconds_remaining) ===

#[test]
fun isqrt_exact_large() {
    assert!(rp::isqrt_u64(1_000_000) == 1_000, 0);
    assert!(rp::isqrt_u64(1_000_001) == 1_000, 1);
    assert!(rp::isqrt_u64(999_999) == 999, 2);
    // 63_245^2 = 3_999_930_025 ≤ 4e9 < 63_246^2 = 4_000_056_516
    assert!(rp::isqrt_u64(4_000_000_000) == 63_245, 3);
}

// === factor at the barrier is exactly the scale and never above it ===

#[test]
fun factor_at_barrier_is_exactly_scale() {
    let f = rp::bachelier_cashout_factor(100_000, B, SIG, SEC);
    assert!(f == rp::factor_scale(), 0);
    assert!(f <= rp::factor_scale(), 1);
}
