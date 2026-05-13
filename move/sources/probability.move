// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Bachelier first-passage probability — the canonical math used by:
///   - OI cap denominator (probability-weighted exposure per solvency_v2)
///   - Asymmetric impact fee vulnerability denominator (impact_fee_v2)
///   - Ride cashout factor (ride_streaming_primitive)
///
/// Single source of truth per docs/design/v2/00_reconciliation.md §5.
/// Returns are 1e9 fixed-point. Floored at PROB_MIN (5%) to defend against
/// camouflage attacks via deep-OTM legs.
module wick::probability;

const PROB_SCALE: u64 = 1_000_000_000;
const PROB_MIN: u64 = 50_000_000;        // 0.05 = floor
const PROB_MAX: u64 = 1_000_000_000;     // 1.00 = ceiling

/// Returns P(touch by T | spot, barrier, σ, Δt) in 1e9 fixed-point.
///
/// Bachelier first-passage closed form for Brownian motion with drift 0:
///   P(touch) = 2 × Φ(-|barrier - spot| / (σ × √Δt))
///
/// All parameters in their natural units:
/// - spot, barrier: 1e9-scaled price
/// - sigma_bps_per_sqrt_sec: σ as basis points per √second of price
/// - seconds_remaining: Δt in whole seconds
public fun touch_probability(
    spot: u64,
    barrier: u64,
    sigma_bps_per_sqrt_sec: u64,
    seconds_remaining: u64,
): u64 {
    if (seconds_remaining == 0) {
        // No time left — P(touch) = 1 if currently at-or-past barrier, else PROB_MIN
        if (spot == barrier) return PROB_MAX;
        return PROB_MIN
    };
    if (sigma_bps_per_sqrt_sec == 0) return PROB_MIN;

    // Distance from current spot to barrier (in barrier-units)
    let dist = if (spot > barrier) spot - barrier else barrier - spot;

    // σ × √Δt — total expected move scale over remaining window, in bps of barrier
    let sqrt_dt = isqrt_u64(seconds_remaining);
    if (sqrt_dt == 0) return PROB_MIN;
    let sigma_total_bps = (sigma_bps_per_sqrt_sec as u128) * (sqrt_dt as u128);
    if (sigma_total_bps == 0) return PROB_MIN;

    // sigma_total in barrier-units = barrier × sigma_total_bps / 10_000
    // Avoid overflow by computing sigma_in_units carefully
    let sigma_in_units = ((barrier as u128) * sigma_total_bps / 10_000) as u128;
    if (sigma_in_units == 0) return PROB_MIN;

    // z = dist / sigma_in_units, expressed as bps for lookup
    // Using u128 to avoid overflow on intermediate
    let z_bps_u128 = ((dist as u128) * 10_000) / sigma_in_units;
    if (z_bps_u128 > 10_000_000) return PROB_MIN;  // far out, clip
    let z_bps = (z_bps_u128 as u64);

    // 2 × Φ(-z) from lookup
    let phi = phi_negative_lookup(z_bps);
    let p = (phi as u128) * 2;
    let p_clipped = if (p > (PROB_MAX as u128)) PROB_MAX else (p as u64);

    if (p_clipped < PROB_MIN) PROB_MIN else p_clipped
}

/// 32-entry lookup of Φ(-z) returning 1e9 fixed-point.
/// z_bps interpreted as "z × 10_000" so z=0 → 0 bps, z=1 → 10_000 bps, z=4 → 40_000 bps.
/// Beyond z=4 returns 0 (probability negligible).
public fun phi_negative_lookup(z_bps: u64): u64 {
    // Hand-tabulated normal CDF tail values: Φ(-z) for z in {0.0, 0.125, 0.25, ..., 4.0}
    // 32 entries covering z ∈ [0, 4) at 0.125 increments
    // Values are 1e9 × Φ(-z)
    if (z_bps == 0) return 500_000_000;  // Φ(0) = 0.5

    let idx_u128 = (z_bps as u128) / 1250;  // 1250 bps = 0.125 in z
    if (idx_u128 >= 32) return 0;
    let idx = (idx_u128 as u64);

    let table: vector<u64> = vector[
        500_000_000,   //  0   z=0.000
        450_262_055,   //  1   z=0.125
        401_293_674,   //  2   z=0.250
        353_830_233,   //  3   z=0.375
        308_537_539,   //  4   z=0.500
        265_985_530,   //  5   z=0.625
        226_627_352,   //  6   z=0.750
        190_786_614,   //  7   z=0.875
        158_655_254,   //  8   z=1.000
        130_294_546,   //  9   z=1.125
        105_649_774,  //  10   z=1.250
         84_565_584,  //  11   z=1.375
         66_807_201,  //  12   z=1.500
         52_081_153,  //  13   z=1.625
         40_059_057,  //  14   z=1.750
         30_396_357,  //  15   z=1.875
         22_750_132,  //  16   z=2.000
         16_792_898,  //  17   z=2.125
         12_224_472,  //  18   z=2.250
          8_775_879,  //  19   z=2.375
          6_209_665,  //  20   z=2.500
          4_332_424,  //  21   z=2.625
          2_979_763,  //  22   z=2.750
          2_018_222,  //  23   z=2.875
          1_349_898,  //  24   z=3.000
            883_826,  //  25   z=3.125
            570_006,  //  26   z=3.250
            362_877,  //  27   z=3.375
            232_677,  //  28   z=3.500
            145_413,  //  29   z=3.625
             89_809,  //  30   z=3.750
             54_581,  //  31   z=3.875
    ];
    *vector::borrow(&table, idx)
}

/// Integer square root via Newton's method. Returns floor(√x).
public fun isqrt_u64(x: u64): u64 {
    if (x == 0) return 0;
    let mut z: u64 = x;
    let mut y: u64 = (x + 1) / 2;
    while (y < z) {
        z = y;
        y = (z + x / z) / 2;
    };
    z
}

public fun prob_scale(): u64 { PROB_SCALE }
public fun prob_min(): u64 { PROB_MIN }
public fun prob_max(): u64 { PROB_MAX }

#[test_only]
public fun test_lookup(z_bps: u64): u64 { phi_negative_lookup(z_bps) }

#[test_only]
public fun test_isqrt(x: u64): u64 { isqrt_u64(x) }
