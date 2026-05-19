// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Bachelier-model cashout factor for streaming touch rides.
///
/// Returns the live "cashout factor" — the fraction of the touch payoff a
/// rider should receive if they voluntarily close before a touch occurs. The
/// closer spot is to the barrier (and the more time left), the higher the
/// factor. Released on every `close_ride` to compute the unrealized payout.
///
/// Math:
///     z      = |barrier - spot| / (sigma * sqrt(seconds_remaining))
///     factor = 2 * Phi(-z)         // returns a value in [0, 1] in 1e9 fixed-point
///
/// Phi is the standard-normal CDF; we use a 33-entry lookup over z scaled
/// in bps. Sigma is configured per-market (`sigma_bps_per_sqrt_sec`).
///
/// All inputs/outputs are u64; intermediates use u128 where overflow is
/// possible. The factor is returned in 1e9 fixed-point — callers multiply
/// by accumulated stake and divide by 1_000_000_000.
module wick::ride_pricing;

/// Fixed-point scale for the returned factor.
const FACTOR_SCALE: u64 = 1_000_000_000;

/// Z is encoded in bps when looked up. Lookup is 33 entries spanning
/// z = 0.0 ... z = 3.2 in 0.1 increments. Beyond z = 3.2, factor ~= 0.
const Z_STEP_BPS: u64 = 1_000;
const Z_TABLE_LEN: u64 = 33;

/// 2 * Phi(-z), in 1e9 fixed-point, for z in [0.0, 3.2] step 0.1.
///   2 * Phi(0)   = 1.0
///   2 * Phi(-3.2) ~= 0.001374
/// Values computed offline; round to nearest integer.
fun phi_neg_table(idx: u64): u64 {
    let t = vector[
        1_000_000_000,  // z=0.0
        920_344_300,    // z=0.1
        841_480_900,    // z=0.2
        764_177_300,    // z=0.3
        689_157_500,    // z=0.4
        617_075_100,    // z=0.5
        548_506_100,    // z=0.6
        483_945_200,    // z=0.7
        423_711_400,    // z=0.8
        368_120_000,    // z=0.9
        317_310_500,    // z=1.0
        271_332_400,    // z=1.1
        230_139_500,    // z=1.2
        193_601_100,    // z=1.3
        161_513_400,    // z=1.4
        133_614_400,    // z=1.5
        109_598_600,    // z=1.6
        89_131_900,     // z=1.7
        71_860_700,     // z=1.8
        57_432_900,     // z=1.9
        45_500_300,     // z=2.0
        35_728_700,     // z=2.1
        27_806_700,     // z=2.2
        21_447_900,     // z=2.3
        16_395_100,     // z=2.4
        12_419_300,     // z=2.5
        9_322_400,      // z=2.6
        6_933_900,      // z=2.7
        5_110_300,      // z=2.8
        3_731_700,      // z=2.9
        2_699_800,      // z=3.0
        1_935_000,      // z=3.1
        1_374_200,      // z=3.2
    ];
    if (idx >= Z_TABLE_LEN) 0 else *vector::borrow(&t, idx)
}

/// Integer square root via Newton's method. Used to compute sqrt(seconds_remaining).
public fun isqrt_u64(n: u64): u64 {
    if (n == 0) return 0;
    let mut x: u64 = n;
    let mut y: u64 = (x + 1) / 2;
    while (y < x) {
        x = y;
        y = (x + n / x) / 2;
    };
    x
}

/// Linear interpolation between table[lo] and table[lo+1] at fractional bps.
fun phi_neg_interp(z_bps: u64): u64 {
    let lo_idx = z_bps / Z_STEP_BPS;
    if (lo_idx >= Z_TABLE_LEN - 1) return phi_neg_table(Z_TABLE_LEN - 1);
    let lo_val = phi_neg_table(lo_idx);
    let hi_val = phi_neg_table(lo_idx + 1);
    let frac = z_bps - lo_idx * Z_STEP_BPS;  // 0..Z_STEP_BPS
    // lerp: lo + (hi - lo) * frac / Z_STEP_BPS  (hi <= lo always here)
    let delta = lo_val - hi_val;  // monotonically decreasing
    lo_val - (((delta as u128) * (frac as u128) / (Z_STEP_BPS as u128)) as u64)
}

/// Returns the Bachelier cashout factor in 1e9 fixed-point.
///
/// At z = 0 (spot at barrier) → factor = 1.0 (1_000_000_000).
/// At z = 3.2+ (far from barrier or near-expiry with low vol) → factor ~ 0.
///
/// `sigma_bps_per_sqrt_sec` is the per-second volatility in basis points
/// of the barrier (e.g. 50 bps means price moves ~0.5% per √second of σ).
/// `seconds_remaining` clamps to 1 to avoid divide-by-zero — but callers
/// should still gate `seconds_remaining == 0` at the call site to short-circuit.
public fun bachelier_cashout_factor(
    spot: u64,
    barrier: u64,
    sigma_bps_per_sqrt_sec: u64,
    seconds_remaining: u64,
): u64 {
    if (seconds_remaining == 0) return 0;
    if (sigma_bps_per_sqrt_sec == 0) return if (spot == barrier) FACTOR_SCALE else 0;

    let dist = if (spot > barrier) spot - barrier else barrier - spot;
    if (dist == 0) return FACTOR_SCALE;

    let sqrt_sec = isqrt_u64(seconds_remaining);
    if (sqrt_sec == 0) return 0;

    // sigma_total in absolute price units: barrier * (sigma_bps_per_sqrt_sec / 10_000) * sqrt(seconds)
    // Compute via u128 to avoid overflow on large barriers.
    let sigma_total_x10000: u128 =
        (barrier as u128) * (sigma_bps_per_sqrt_sec as u128) * (sqrt_sec as u128);
    if (sigma_total_x10000 == 0) return 0;

    // z = dist / sigma_total ; we want z in bps for the lookup.
    // z_bps = dist * 10_000 / sigma_total
    //       = dist * 10_000 / (sigma_total_x10000 / 10_000)
    //       = dist * 10_000 * 10_000 / sigma_total_x10000
    let z_bps_u128: u128 = (dist as u128) * 10_000 * 10_000 / sigma_total_x10000;
    let z_bps_capped: u64 = if (z_bps_u128 > ((Z_STEP_BPS * (Z_TABLE_LEN - 1)) as u128))
        Z_STEP_BPS * (Z_TABLE_LEN - 1)
    else
        z_bps_u128 as u64;

    phi_neg_interp(z_bps_capped)
}

public fun factor_scale(): u64 { FACTOR_SCALE }

// === Tests ===

#[test_only]
fun approx_eq(a: u64, b: u64, tolerance: u64): bool {
    if (a > b) a - b <= tolerance else b - a <= tolerance
}

#[test]
fun isqrt_basics() {
    assert!(isqrt_u64(0) == 0, 0);
    assert!(isqrt_u64(1) == 1, 1);
    assert!(isqrt_u64(4) == 2, 2);
    assert!(isqrt_u64(9) == 3, 3);
    assert!(isqrt_u64(100) == 10, 4);
    assert!(isqrt_u64(99) == 9, 5);
    assert!(isqrt_u64(101) == 10, 6);
}

#[test]
fun factor_is_one_at_barrier() {
    // spot == barrier → factor = 1.0
    let f = bachelier_cashout_factor(100_000, 100_000, 50, 300);
    assert!(f == FACTOR_SCALE, 0);
}

#[test]
fun factor_decreases_with_distance() {
    let sigma = 50;
    let seconds = 300;
    let barrier = 100_000;

    let f_close = bachelier_cashout_factor(99_500, barrier, sigma, seconds);
    let f_far   = bachelier_cashout_factor(95_000, barrier, sigma, seconds);
    let f_atb   = bachelier_cashout_factor(100_000, barrier, sigma, seconds);
    assert!(f_atb >= f_close, 0);
    assert!(f_close >= f_far, 1);
    assert!(f_far < FACTOR_SCALE, 2);
}

#[test]
fun factor_decreases_as_time_runs_out_when_far_from_barrier() {
    let sigma = 50;
    let barrier = 100_000;
    let spot = 95_000;  // 5% away
    let f_far_in_time = bachelier_cashout_factor(spot, barrier, sigma, 3_600);
    let f_near_expiry = bachelier_cashout_factor(spot, barrier, sigma, 30);
    assert!(f_far_in_time >= f_near_expiry, 0);
}

#[test]
fun factor_is_zero_at_zero_seconds_when_off_barrier() {
    let f = bachelier_cashout_factor(95_000, 100_000, 50, 0);
    assert!(f == 0, 0);
}

#[test]
fun factor_is_symmetric_above_and_below_barrier() {
    let sigma = 50;
    let seconds = 300;
    let barrier = 100_000;
    let above = bachelier_cashout_factor(102_000, barrier, sigma, seconds);
    let below = bachelier_cashout_factor(98_000, barrier, sigma, seconds);
    assert!(approx_eq(above, below, 100), 0);  // within 100ppb
}

#[test]
fun extreme_distance_returns_near_zero() {
    let f = bachelier_cashout_factor(50_000, 100_000, 50, 300);
    assert!(f < FACTOR_SCALE / 100, 0);  // < 1% of scale
}

#[test]
fun zero_sigma_returns_zero_off_barrier_and_one_at_barrier() {
    assert!(bachelier_cashout_factor(95_000, 100_000, 0, 300) == 0, 0);
    assert!(bachelier_cashout_factor(100_000, 100_000, 0, 300) == FACTOR_SCALE, 1);
}
