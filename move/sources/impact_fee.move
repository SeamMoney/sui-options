// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Asymmetric impact fee — charged ONLY on winning closes. Per
/// docs/design/v2/02_asymmetric_impact_fee_v2.md + reconciliation §13.
///
/// Formula:  f(m, v) = b + (cap − b) × m/(m + m0) × √v
///   m = decisiveness (how decisively the winning side won, in bps of barrier)
///   v = vulnerability (this position's payout / max_side_exposure_at_lock, in bps)
///   b = base_fee_bps (default 50)
///   cap = cap_fee_bps (default 450)
///   m0 = m0_bps (Michaelis-Menten saturation constant, default 50)
///
/// Critical: ALL inputs are captured into FeeSnapshot at lock_and_settle
/// Phase 0 and read FROM the snapshot at redeem time. Never read live state.
/// This kills the post-expiry-record exploit (no-touch holders pushing
/// false low values to bypass fee) and the last-redeemer-divide-by-zero.
module wick::impact_fee;

use wick::probability;

const M0_BPS_DEFAULT: u64 = 50;

/// Captured at lock_and_settle Phase 0. Frozen for the lifetime of the
/// market. Fee module reads from this on every redeem.
public struct FeeSnapshot has copy, drop, store {
    barrier: u64,
    /// 0 = touch_above, 1 = touch_below — same enum as PathObservation.direction
    direction: u8,
    max_seen: u64,
    min_seen: u64,
    /// Per-market touch-side and no-touch-side exposures (sum of payout_if_win)
    /// at lock_and_settle time. Frozen — no longer mutates with redemptions.
    touch_exposure_at_lock: u64,
    no_touch_exposure_at_lock: u64,
}

/// Build the snapshot. Called by lock_and_settle Phase 0.
public fun snapshot_at_lock(
    barrier: u64,
    direction: u8,
    max_seen: u64,
    min_seen: u64,
    touch_exposure: u64,
    no_touch_exposure: u64,
): FeeSnapshot {
    FeeSnapshot {
        barrier,
        direction,
        max_seen,
        min_seen,
        touch_exposure_at_lock: touch_exposure,
        no_touch_exposure_at_lock: no_touch_exposure,
    }
}

// === Reads ===

public fun barrier(s: &FeeSnapshot): u64 { s.barrier }
public fun direction(s: &FeeSnapshot): u8 { s.direction }
public fun max_seen(s: &FeeSnapshot): u64 { s.max_seen }
public fun min_seen(s: &FeeSnapshot): u64 { s.min_seen }
public fun touch_exposure(s: &FeeSnapshot): u64 { s.touch_exposure_at_lock }
public fun no_touch_exposure(s: &FeeSnapshot): u64 { s.no_touch_exposure_at_lock }

// === Fee computation ===

/// Decisiveness `m` in bps. For a touch winner it's how far past the barrier
/// the price went. For a no-touch winner it's how much path room remained
/// (closest approach without touching).
public fun decisiveness_bps(snap: &FeeSnapshot, is_touch_winner: bool): u64 {
    if (snap.barrier == 0) return 0;

    if (is_touch_winner) {
        // Touch winner — measure overshoot
        if (snap.direction == 0) {
            // touch_above: m = (max_seen - barrier)/barrier
            if (snap.max_seen <= snap.barrier) return 0;
            mul_div_u64(snap.max_seen - snap.barrier, 10_000, snap.barrier)
        } else {
            // touch_below: m = (barrier - min_seen)/barrier
            if (snap.min_seen >= snap.barrier) return 0;
            mul_div_u64(snap.barrier - snap.min_seen, 10_000, snap.barrier)
        }
    } else {
        // No-touch winner — measure how much room was kept
        if (snap.direction == 0) {
            // touch_above never fired: max_seen < barrier; m = (barrier - max_seen)/barrier
            if (snap.max_seen >= snap.barrier) return 0;
            mul_div_u64(snap.barrier - snap.max_seen, 10_000, snap.barrier)
        } else {
            // touch_below never fired: min_seen > barrier; m = (min_seen - barrier)/barrier
            if (snap.min_seen <= snap.barrier) return 0;
            mul_div_u64(snap.min_seen - snap.barrier, 10_000, snap.barrier)
        }
    }
}

/// Vulnerability `v` in bps. position payout / max(touch_exposure, no_touch_exposure)
/// at lock time. Capped at 10_000 (100%).
public fun vulnerability_bps(snap: &FeeSnapshot, payout_if_win: u64): u64 {
    let max_exposure = if (snap.touch_exposure_at_lock > snap.no_touch_exposure_at_lock) {
        snap.touch_exposure_at_lock
    } else {
        snap.no_touch_exposure_at_lock
    };
    if (max_exposure == 0) return 10_000;
    let v = mul_div_u64(payout_if_win, 10_000, max_exposure);
    if (v > 10_000) 10_000 else v
}

/// Compute fee_bps using the canonical formula.
/// f(m, v) = b + (cap - b) × m/(m+m0) × √v
public fun compute_fee_bps(
    decisiveness_bps: u64,
    vulnerability_bps: u64,
    base_fee_bps: u64,
    cap_fee_bps: u64,
    m0_bps: u64,
): u64 {
    assert!(cap_fee_bps >= base_fee_bps, 99);
    if (cap_fee_bps == base_fee_bps) return base_fee_bps;
    if (decisiveness_bps == 0) return base_fee_bps;
    if (vulnerability_bps == 0) return base_fee_bps;

    // step 1: m / (m + m0), scaled to 1e9 fixed-point
    let m_plus_m0 = decisiveness_bps + m0_bps;
    let scale: u128 = 1_000_000_000;
    let m_factor_1e9 = if (m_plus_m0 == 0) 0
        else (decisiveness_bps as u128) * scale / (m_plus_m0 as u128);

    // step 2: √v scaled to 1e9
    //   isqrt of bps_value gives sqrt(v) in "sqrt(bps)" units (max ≈ 100 for v=10000)
    //   sqrt(v_bps / 10_000) = isqrt(v_bps) / 100
    //   scaled to 1e9: isqrt(v_bps) × 1e7
    let v_sqrt_raw = probability::isqrt_u64(vulnerability_bps);
    let v_sqrt_1e9 = (v_sqrt_raw as u128) * 10_000_000;

    // step 3: combined scale = m_factor × v_sqrt / 1e9
    let combined_1e9 = m_factor_1e9 * v_sqrt_1e9 / scale;

    // step 4: extra = (cap - b) × combined / 1e9
    let extra_bps = ((cap_fee_bps - base_fee_bps) as u128) * combined_1e9 / scale;
    base_fee_bps + (extra_bps as u64)
}

/// Apply fee to a winning payout. Returns (net_payout, fee_amount).
/// Uses ceiling division for the fee so dust rounds to the protocol.
public fun apply_fee(payout: u64, fee_bps: u64): (u64, u64) {
    if (fee_bps == 0 || payout == 0) return (payout, 0);
    let fee_u128 = ((payout as u128) * (fee_bps as u128) + 9_999) / 10_000;  // ceil
    let fee = fee_u128 as u64;
    let fee_capped = if (fee > payout) payout else fee;
    (payout - fee_capped, fee_capped)
}

/// Convenience: compute fee for a winning position and apply it.
public fun fee_for_winner(
    snap: &FeeSnapshot,
    payout_if_win: u64,
    is_touch_winner: bool,
    base_fee_bps: u64,
    cap_fee_bps: u64,
): (u64, u64) {
    let m = decisiveness_bps(snap, is_touch_winner);
    let v = vulnerability_bps(snap, payout_if_win);
    let fee_bps = compute_fee_bps(m, v, base_fee_bps, cap_fee_bps, m0_bps_default());
    apply_fee(payout_if_win, fee_bps)
}

public fun m0_bps_default(): u64 { M0_BPS_DEFAULT }

// === DNT (double-no-touch) decisiveness ===
//
// DNT has two barriers (lower + upper). The corridor "INSIDE" wins iff
// NEITHER barrier was touched during the window. "OUTSIDE" wins iff at
// least one barrier was breached. Decisiveness for each side rewards a
// different geometry:
//
//   INSIDE  — reward distance from BOTH barriers (min of two distances).
//             Centered = max decisiveness; grazed = ~0.
//   OUTSIDE — reward biggest overshoot past whichever barrier was breached
//             (matches existing single-touch overshoot pattern).
//
// Intermediates use u128 so large nominal barriers (e.g. BTC ~1e11
// micro-USD) and the 10_000 bps factor cannot overflow.

/// Decisiveness `m` in bps for a DNT INSIDE winner (corridor held).
/// Rewards the closer of (upper - max_seen, min_seen - lower). At the
/// geometric center this distance is range_width/2 so decisiveness = 10_000.
/// Returns 0 if a barrier was actually touched (shouldn't happen for an
/// INSIDE winner; defensive).
public fun dnt_inside_decisiveness_bps(
    lower_barrier: u64,
    upper_barrier: u64,
    max_seen: u64,
    min_seen: u64,
): u64 {
    if (upper_barrier <= lower_barrier) return 0;
    // INSIDE winner shouldn't have touched either barrier; if the snapshot
    // says otherwise, treat as zero decisiveness (graze on the boundary).
    if (max_seen >= upper_barrier) return 0;
    if (min_seen <= lower_barrier) return 0;

    let range_width = upper_barrier - lower_barrier;
    let half_range = range_width / 2;
    if (half_range == 0) return 0;

    let closest_to_upper = upper_barrier - max_seen;
    let closest_to_lower = min_seen - lower_barrier;
    let closest_to_either = if (closest_to_upper < closest_to_lower) {
        closest_to_upper
    } else {
        closest_to_lower
    };

    let bps_u128 = (closest_to_either as u128) * 10_000 / (half_range as u128);
    if (bps_u128 > 10_000) 10_000 else bps_u128 as u64
}

/// Decisiveness `m` in bps for a DNT OUTSIDE winner (a barrier broke).
/// Rewards the biggest overshoot past whichever barrier was breached,
/// expressed as a percentage of the full range width. Returns 0 if neither
/// barrier was touched (defensive — OUTSIDE shouldn't be a winner then).
public fun dnt_outside_decisiveness_bps(
    lower_barrier: u64,
    upper_barrier: u64,
    max_seen: u64,
    min_seen: u64,
): u64 {
    if (upper_barrier <= lower_barrier) return 0;
    let range_width = upper_barrier - lower_barrier;

    let upper_overshoot = if (max_seen > upper_barrier) {
        max_seen - upper_barrier
    } else { 0 };
    let lower_overshoot = if (min_seen < lower_barrier) {
        lower_barrier - min_seen
    } else { 0 };

    let biggest_breach = if (upper_overshoot > lower_overshoot) {
        upper_overshoot
    } else {
        lower_overshoot
    };
    if (biggest_breach == 0) return 0;

    let bps_u128 = (biggest_breach as u128) * 10_000 / (range_width as u128);
    if (bps_u128 > 10_000) 10_000 else bps_u128 as u64
}

// === Helpers ===

fun mul_div_u64(a: u64, b: u64, denom: u64): u64 {
    (((a as u128) * (b as u128)) / (denom as u128)) as u64
}

// === Tests (DNT decisiveness) ===

#[test_only]
const T_LOWER: u64 = 90_000_000_000;   // 90.0 (1e9 scaling)
#[test_only]
const T_UPPER: u64 = 110_000_000_000;  // 110.0
#[test_only]
const T_CENTER: u64 = 100_000_000_000; // 100.0 (midpoint)

#[test]
fun dnt_inside_max_at_center_returns_10000() {
    // max_seen == min_seen == center: both distances = 10.0 = half_range → 10_000 bps
    let m = dnt_inside_decisiveness_bps(T_LOWER, T_UPPER, T_CENTER, T_CENTER);
    assert!(m == 10_000, 0);
}

#[test]
fun dnt_inside_max_at_upper_barrier_returns_0() {
    // max_seen exactly at upper barrier — boundary touch, INSIDE shouldn't win.
    // Defensively returns 0.
    let m = dnt_inside_decisiveness_bps(T_LOWER, T_UPPER, T_UPPER, T_CENTER);
    assert!(m == 0, 0);

    // Same idea for min_seen at lower barrier.
    let m2 = dnt_inside_decisiveness_bps(T_LOWER, T_UPPER, T_CENTER, T_LOWER);
    assert!(m2 == 0, 1);
}

#[test]
fun dnt_inside_proportional_to_min_distance() {
    // range_width = 20, half_range = 10.
    //
    // Case A: max=105, min=95 → distances (5, 5), min=5 → 5/10 = 5000 bps
    let a = dnt_inside_decisiveness_bps(
        T_LOWER, T_UPPER,
        105_000_000_000,
        95_000_000_000,
    );
    assert!(a == 5000, 0);

    // Case B: max=109, min=95 → distances (1, 5), min=1 → 1/10 = 1000 bps
    let b = dnt_inside_decisiveness_bps(
        T_LOWER, T_UPPER,
        109_000_000_000,
        95_000_000_000,
    );
    assert!(b == 1000, 1);

    // Case C: max=102, min=91 → distances (8, 1), min=1 → 1000 bps
    let c = dnt_inside_decisiveness_bps(
        T_LOWER, T_UPPER,
        102_000_000_000,
        91_000_000_000,
    );
    assert!(c == 1000, 2);
}

#[test]
fun dnt_inside_symmetric_above_and_below_center() {
    // Symmetric distance from each barrier should yield identical decisiveness.
    //
    // Hugging the upper barrier: max=108, min=92 → (2, 2) → 2/10 = 2000
    let upper_hug = dnt_inside_decisiveness_bps(
        T_LOWER, T_UPPER,
        108_000_000_000,
        92_000_000_000,
    );
    // Hugging the lower barrier: max=108, min=92 — same min by symmetry.
    // Now mirror it: max=98, min=92 (closest is min, distance 2 from lower)
    // vs                max=108, min=102 (closest is max, distance 2 from upper)
    let lower_closest = dnt_inside_decisiveness_bps(
        T_LOWER, T_UPPER,
        98_000_000_000,
        92_000_000_000,
    );
    let upper_closest = dnt_inside_decisiveness_bps(
        T_LOWER, T_UPPER,
        108_000_000_000,
        102_000_000_000,
    );
    assert!(lower_closest == upper_closest, 0);
    assert!(lower_closest == 2000, 1);
    // And the centered-symmetric case stays symmetric too.
    assert!(upper_hug == 2000, 2);
}

#[test]
fun dnt_outside_proportional_to_breach_size() {
    // range_width = 20.
    //
    // Case A: upper breach by 2 → 2/20 = 1000 bps
    let a = dnt_outside_decisiveness_bps(
        T_LOWER, T_UPPER,
        112_000_000_000,
        95_000_000_000,
    );
    assert!(a == 1000, 0);

    // Case B: lower breach by 4 → 4/20 = 2000 bps
    let b = dnt_outside_decisiveness_bps(
        T_LOWER, T_UPPER,
        105_000_000_000,
        86_000_000_000,
    );
    assert!(b == 2000, 1);

    // Case C: both breached, upper by 1, lower by 5 → max=5 → 5/20 = 2500 bps
    let c = dnt_outside_decisiveness_bps(
        T_LOWER, T_UPPER,
        111_000_000_000,
        85_000_000_000,
    );
    assert!(c == 2500, 2);

    // Case D: massive breach (20 = full range) → caps at 10_000
    let d = dnt_outside_decisiveness_bps(
        T_LOWER, T_UPPER,
        130_000_000_000,
        95_000_000_000,
    );
    assert!(d == 10_000, 3);
}

#[test]
fun dnt_outside_returns_0_when_neither_breached() {
    // Price stayed strictly inside the corridor → OUTSIDE not a real winner.
    let m = dnt_outside_decisiveness_bps(
        T_LOWER, T_UPPER,
        109_000_000_000,
        91_000_000_000,
    );
    assert!(m == 0, 0);

    // Touched-but-not-past also doesn't qualify as a breach (max==upper,
    // min==lower) — overshoot is zero, decisiveness is zero.
    let m2 = dnt_outside_decisiveness_bps(
        T_LOWER, T_UPPER,
        T_UPPER,
        T_LOWER,
    );
    assert!(m2 == 0, 1);
}
