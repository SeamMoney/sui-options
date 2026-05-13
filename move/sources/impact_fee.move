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

// === Helpers ===

fun mul_div_u64(a: u64, b: u64, denom: u64): u64 {
    (((a as u128) * (b as u128)) / (denom as u128)) as u64
}
