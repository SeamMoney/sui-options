// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Risk parameter registry + cap-enforcement asserts.
///
/// Per reconciliation §14: ALL admin-tunable parameters have Move-enforced
/// upper/lower bounds. The "narrow scope" docstring claim from v1 is
/// REPLACED by Move-enforcement here.
///
/// Per solvency_v2 §3 + reconciliation §4-6: probability-weighted OI caps
/// enforced against GlobalExposureRegistry, with cross-underlying
/// correlation buckets, time-averaged V_eff (1h EWMA same as registry).
module wick::risk_config;

use std::string::String;
use sui::clock::Clock;
use wick::global_exposure_registry::{Self as ger, GlobalExposureRegistry};
use wick::probability;

// === Error codes ===
const EParamBelowMin: u64 = 0;
const EParamAboveMax: u64 = 1;
const ESingleSideExceeded: u64 = 2;
const EGlobalUnderlyingExceeded: u64 = 3;
const ECorrelationBucketExceeded: u64 = 4;
const ESinglePositionExceeded: u64 = 5;
const EQueueCircuitBreakerTripped: u64 = 6;
const EWindDownActive: u64 = 7;
const EZeroVaultEffective: u64 = 8;

// === Hard bounds per reconciliation §14 ===

/// Caps in basis points (10_000 = 100%).
const MIN_PER_POSITION_PCT_BPS: u64 = 10;          // 0.1%
const MAX_PER_POSITION_PCT_BPS: u64 = 500;         // 5%

const MIN_PER_SIDE_EXPOSURE_PCT_BPS: u64 = 500;    // 5%
const MAX_PER_SIDE_EXPOSURE_PCT_BPS: u64 = 3000;   // 30%

const MIN_GLOBAL_PWE_PCT_BPS: u64 = 500;           // 5%
const MAX_GLOBAL_PWE_PCT_BPS: u64 = 2500;          // 25%

const MIN_CORR_BUCKET_PCT_BPS: u64 = 1000;         // 10%
const MAX_CORR_BUCKET_PCT_BPS: u64 = 4000;         // 40%

const MIN_BASE_FEE_BPS: u64 = 25;
const MAX_BASE_FEE_BPS: u64 = 200;

const MIN_CAP_FEE_BPS: u64 = 25;     // must be >= base
const MAX_CAP_FEE_BPS: u64 = 800;

const MIN_CASHOUT_SPREAD_BPS: u64 = 100;
const MAX_CASHOUT_SPREAD_BPS: u64 = 1000;

const MIN_PAYOUT_MULT_BPS: u64 = 11_000;
const MAX_PAYOUT_MULT_BPS: u64 = 50_000;

const MIN_QUEUE_CB_PCT_BPS: u64 = 3000;            // 30%
const MAX_QUEUE_CB_PCT_BPS: u64 = 7000;            // 70%

const MIN_WIND_DOWN_RATIO: u64 = 20;
const MAX_WIND_DOWN_RATIO: u64 = 60;

// === Param ids (used by set_param) ===
const PID_PER_POSITION_PCT: u8 = 0;
const PID_PER_SIDE_EXPOSURE_PCT: u8 = 1;
const PID_GLOBAL_PWE_PCT: u8 = 2;
const PID_CORR_BUCKET_PCT: u8 = 3;
const PID_BASE_FEE: u8 = 4;
const PID_CAP_FEE: u8 = 5;
const PID_CASHOUT_SPREAD: u8 = 6;
const PID_PAYOUT_MULT: u8 = 7;
const PID_QUEUE_CB: u8 = 8;
const PID_WIND_DOWN_RATIO: u8 = 9;

public struct RiskConfig has key {
    id: UID,
    /// Per-position cap as bps of V_eff (e.g. 500 = 5%).
    max_per_position_pct_bps: u64,
    /// Per-side per-market cap as bps of V_eff.
    max_per_side_exposure_pct_bps: u64,
    /// Global probability-weighted exposure per (underlying, side) cap as bps of V_eff.
    max_global_pwe_pct_bps: u64,
    /// Correlation bucket cap as bps of V_eff.
    max_corr_bucket_pct_bps: u64,
    base_fee_bps: u64,
    cap_fee_bps: u64,
    cashout_spread_bps: u64,
    /// Default payout multiplier for new markets (per-market overrides allowed within bounds).
    default_payout_mult_bps: u64,
    /// Queue / V_eff ratio (in bps) at which new opens revert.
    queue_circuit_breaker_pct_bps: u64,
    /// Wind-down trigger: queue / daily_volume_ewma > this (in days, integer).
    wind_down_queue_volume_ratio_days: u64,
    /// Whether wind-down is currently active.
    wind_down_active: bool,
}

public struct RiskAdminCap has key, store {
    id: UID,
    config_id: ID,
}

// === Events ===

public struct RiskConfigInitialized has copy, drop {
    config_id: ID,
}

public struct RiskParamUpdated has copy, drop {
    config_id: ID,
    param_id: u8,
    new_value: u64,
}

public struct WindDownActivated has copy, drop {
    config_id: ID,
    queue_total: u64,
    daily_volume: u64,
    ratio: u64,
}

public struct WindDownDeactivated has copy, drop {
    config_id: ID,
}

// === Init with sensible defaults ===

public fun init_config(ctx: &mut TxContext): RiskAdminCap {
    let config = RiskConfig {
        id: object::new(ctx),
        max_per_position_pct_bps: 50,         // 0.5%
        max_per_side_exposure_pct_bps: 1000,  // 10%
        max_global_pwe_pct_bps: 2500,         // 25%
        max_corr_bucket_pct_bps: 4000,        // 40%
        base_fee_bps: 50,                     // 0.50%
        cap_fee_bps: 450,                     // 4.50%
        cashout_spread_bps: 500,              // 5.00%
        default_payout_mult_bps: 18_000,      // 1.8x
        queue_circuit_breaker_pct_bps: 5000,  // 50%
        wind_down_queue_volume_ratio_days: 30,
        wind_down_active: false,
    };
    let config_id = object::id(&config);
    sui::event::emit(RiskConfigInitialized { config_id });
    transfer::share_object(config);
    RiskAdminCap { id: object::new(ctx), config_id }
}

// === Reads ===

public fun max_per_position_bps(c: &RiskConfig): u64 { c.max_per_position_pct_bps }
public fun max_per_side_exposure_bps(c: &RiskConfig): u64 { c.max_per_side_exposure_pct_bps }
public fun max_global_pwe_bps(c: &RiskConfig): u64 { c.max_global_pwe_pct_bps }
public fun max_corr_bucket_bps(c: &RiskConfig): u64 { c.max_corr_bucket_pct_bps }
public fun base_fee_bps(c: &RiskConfig): u64 { c.base_fee_bps }
public fun cap_fee_bps(c: &RiskConfig): u64 { c.cap_fee_bps }
public fun cashout_spread_bps(c: &RiskConfig): u64 { c.cashout_spread_bps }
public fun default_payout_mult_bps(c: &RiskConfig): u64 { c.default_payout_mult_bps }
public fun queue_circuit_breaker_bps(c: &RiskConfig): u64 { c.queue_circuit_breaker_pct_bps }
public fun wind_down_queue_volume_ratio(c: &RiskConfig): u64 { c.wind_down_queue_volume_ratio_days }
public fun is_wind_down_active(c: &RiskConfig): bool { c.wind_down_active }

// === Admin: set_param with hard bounds ===

public fun set_param(
    cap: &RiskAdminCap,
    config: &mut RiskConfig,
    param_id: u8,
    value: u64,
) {
    assert!(cap.config_id == object::id(config), 99);
    let (min, max) = bounds_for(param_id);
    assert!(value >= min, EParamBelowMin);
    assert!(value <= max, EParamAboveMax);
    if (param_id == PID_PER_POSITION_PCT) config.max_per_position_pct_bps = value
    else if (param_id == PID_PER_SIDE_EXPOSURE_PCT) config.max_per_side_exposure_pct_bps = value
    else if (param_id == PID_GLOBAL_PWE_PCT) config.max_global_pwe_pct_bps = value
    else if (param_id == PID_CORR_BUCKET_PCT) config.max_corr_bucket_pct_bps = value
    else if (param_id == PID_BASE_FEE) config.base_fee_bps = value
    else if (param_id == PID_CAP_FEE) {
        assert!(value >= config.base_fee_bps, EParamBelowMin);
        config.cap_fee_bps = value;
    }
    else if (param_id == PID_CASHOUT_SPREAD) config.cashout_spread_bps = value
    else if (param_id == PID_PAYOUT_MULT) config.default_payout_mult_bps = value
    else if (param_id == PID_QUEUE_CB) config.queue_circuit_breaker_pct_bps = value
    else if (param_id == PID_WIND_DOWN_RATIO) config.wind_down_queue_volume_ratio_days = value
    else abort 100;
    sui::event::emit(RiskParamUpdated {
        config_id: object::id(config),
        param_id,
        new_value: value,
    });
}

fun bounds_for(param_id: u8): (u64, u64) {
    if (param_id == PID_PER_POSITION_PCT) (MIN_PER_POSITION_PCT_BPS, MAX_PER_POSITION_PCT_BPS)
    else if (param_id == PID_PER_SIDE_EXPOSURE_PCT) (MIN_PER_SIDE_EXPOSURE_PCT_BPS, MAX_PER_SIDE_EXPOSURE_PCT_BPS)
    else if (param_id == PID_GLOBAL_PWE_PCT) (MIN_GLOBAL_PWE_PCT_BPS, MAX_GLOBAL_PWE_PCT_BPS)
    else if (param_id == PID_CORR_BUCKET_PCT) (MIN_CORR_BUCKET_PCT_BPS, MAX_CORR_BUCKET_PCT_BPS)
    else if (param_id == PID_BASE_FEE) (MIN_BASE_FEE_BPS, MAX_BASE_FEE_BPS)
    else if (param_id == PID_CAP_FEE) (MIN_CAP_FEE_BPS, MAX_CAP_FEE_BPS)
    else if (param_id == PID_CASHOUT_SPREAD) (MIN_CASHOUT_SPREAD_BPS, MAX_CASHOUT_SPREAD_BPS)
    else if (param_id == PID_PAYOUT_MULT) (MIN_PAYOUT_MULT_BPS, MAX_PAYOUT_MULT_BPS)
    else if (param_id == PID_QUEUE_CB) (MIN_QUEUE_CB_PCT_BPS, MAX_QUEUE_CB_PCT_BPS)
    else if (param_id == PID_WIND_DOWN_RATIO) (MIN_WIND_DOWN_RATIO, MAX_WIND_DOWN_RATIO)
    else abort 101
}

// === Admin: wind-down state ===

/// Activate wind-down. Sets `wind_down_active = true`. Per solvency_v2 §6:
/// triggered when queue_total > daily_volume_ewma × wind_down_ratio_days,
/// or admin-forced. Once active, new opens revert.
public fun activate_wind_down(
    _cap: &RiskAdminCap,
    config: &mut RiskConfig,
    queue_total: u64,
    daily_volume: u64,
) {
    config.wind_down_active = true;
    let ratio = if (daily_volume > 0) queue_total / daily_volume else 999_999;
    sui::event::emit(WindDownActivated {
        config_id: object::id(config),
        queue_total,
        daily_volume,
        ratio,
    });
}

public fun deactivate_wind_down(
    _cap: &RiskAdminCap,
    config: &mut RiskConfig,
) {
    config.wind_down_active = false;
    sui::event::emit(WindDownDeactivated { config_id: object::id(config) });
}

// === Cap-enforcement asserts (called by market::open / ride::open) ===

/// Per-position cap.
public fun assert_position_within_per_position_cap(
    config: &RiskConfig,
    payout: u64,
    v_eff: u64,
) {
    assert!(v_eff > 0, EZeroVaultEffective);
    let cap = mul_div(v_eff, config.max_per_position_pct_bps, 10_000);
    assert!(payout <= cap, ESinglePositionExceeded);
}

/// Per-(market, side) raw exposure cap.
public fun assert_within_per_side_cap(
    config: &RiskConfig,
    new_side_exposure: u64,
    v_eff: u64,
) {
    assert!(v_eff > 0, EZeroVaultEffective);
    let cap = mul_div(v_eff, config.max_per_side_exposure_pct_bps, 10_000);
    assert!(new_side_exposure <= cap, ESingleSideExceeded);
}

/// Global probability-weighted exposure cap per (underlying, side).
/// Reads from GlobalExposureRegistry. Per reconciliation §4-5, probability
/// is Bachelier first-passage from wick::probability.
public fun assert_within_global_pwe_cap(
    config: &RiskConfig,
    registry: &GlobalExposureRegistry,
    underlying: String,
    side: u8,
    additional_pwe: u128,
    v_eff: u64,
    clock: &Clock,
) {
    assert!(v_eff > 0, EZeroVaultEffective);
    let current = ger::read_pwe(registry, underlying, side, clock);
    let cap = mul_div128(v_eff as u128, config.max_global_pwe_pct_bps as u128, 10_000);
    assert!(current + additional_pwe <= cap, EGlobalUnderlyingExceeded);
}

/// Cross-underlying correlation bucket cap.
public fun assert_within_correlation_bucket_cap(
    config: &RiskConfig,
    registry: &GlobalExposureRegistry,
    bucket_id: u8,
    side: u8,
    additional_pwe: u128,
    v_eff: u64,
    clock: &Clock,
) {
    assert!(v_eff > 0, EZeroVaultEffective);
    let current = ger::read_bucket_pwe(registry, bucket_id, side, clock);
    let cap = mul_div128(v_eff as u128, config.max_corr_bucket_pct_bps as u128, 10_000);
    assert!(current + additional_pwe <= cap, ECorrelationBucketExceeded);
}

/// Queue circuit breaker — refuse new opens when queue/V_eff > threshold.
public fun assert_queue_within_circuit_breaker(
    config: &RiskConfig,
    queue_total: u64,
    v_eff: u64,
) {
    if (v_eff == 0) {
        // Allow opens when vault is empty (bootstrap)
        return
    };
    let ratio_bps = mul_div(queue_total, 10_000, v_eff);
    assert!(ratio_bps <= config.queue_circuit_breaker_pct_bps, EQueueCircuitBreakerTripped);
}

/// Wind-down halts new opens.
public fun assert_not_wind_down(config: &RiskConfig) {
    assert!(!config.wind_down_active, EWindDownActive);
}

/// Compose all single-position checks. Convenience for callers.
public fun assert_open_allowed(
    config: &RiskConfig,
    registry: &GlobalExposureRegistry,
    underlying: String,
    side: u8,
    correlation_bucket_id: u8,
    payout: u64,
    new_side_exposure_after: u64,
    additional_pwe: u128,
    v_eff: u64,
    queue_total: u64,
    clock: &Clock,
) {
    assert_not_wind_down(config);
    assert_queue_within_circuit_breaker(config, queue_total, v_eff);
    assert_position_within_per_position_cap(config, payout, v_eff);
    assert_within_per_side_cap(config, new_side_exposure_after, v_eff);
    assert_within_global_pwe_cap(config, registry, underlying, side, additional_pwe, v_eff, clock);
    assert_within_correlation_bucket_cap(config, registry, correlation_bucket_id, side, additional_pwe, v_eff, clock);
}

// === Helpers ===

fun mul_div(a: u64, b: u64, denom: u64): u64 {
    (((a as u128) * (b as u128)) / (denom as u128)) as u64
}

fun mul_div128(a: u128, b: u128, denom: u128): u128 {
    (a * b) / denom
}

/// Compute probability-weighted exposure: payout × P(touch). Probability
/// from Bachelier first-passage via wick::probability. Returns RAW
/// payout-units (probability × payout, divided back to payout scale).
/// Caps and registry storage all in this same raw unit.
///
/// Probability is floored at 5% (PROB_MIN), so the smallest non-zero PWE
/// for a payout of 100 is 5. Sub-payout-unit precision is acceptable
/// because the cap denominator (V_eff) is also in the same units and
/// dust falls below the per-position cap floor anyway.
public fun compute_pwe(
    payout: u64,
    spot: u64,
    barrier: u64,
    sigma_bps_per_sqrt_sec: u64,
    seconds_remaining: u64,
): u128 {
    let p = probability::touch_probability(spot, barrier, sigma_bps_per_sqrt_sec, seconds_remaining);
    // p is 1e9 fixed-point in [PROB_MIN, PROB_MAX]. Divide back to raw scale.
    (payout as u128) * (p as u128) / (probability::prob_scale() as u128)
}

/// DNT PWE — probability-weighted exposure for a double-no-touch position.
///
/// Per the per-(underlying, side) global cap, DNT INSIDE positions win if
/// the corridor [lower, upper] holds for the rest of the window; OUTSIDE
/// positions win if EITHER barrier is touched.
///
/// We approximate using the union bound:
///
///     P_outside ≈ P_touch(spot, upper) + P_touch(spot, lower)     (clipped at 1)
///     P_inside  = 1 - P_outside
///
/// The union bound OVERESTIMATES P_outside (double-counts the joint event
/// "both touched"). Underestimating P_inside is the CONSERVATIVE direction
/// for the registry cap — it lets a touch fraction more INSIDE exposure
/// slip past the cap than ideal, but never the other way (which would
/// inflate OUTSIDE exposure and let the vault overcommit). For typical
/// corridor widths (≥ 1σ each side) the joint-touch probability is small
/// and the bound is tight.
///
/// `is_inside` selects which side's winning probability scales the payout.
/// Pass `is_inside = true` for SIDE_DNT_INSIDE positions, `false` for
/// SIDE_DNT_OUTSIDE positions. Both arms reuse the same touch-probability
/// lookups so the gas cost is symmetric.
public fun compute_pwe_dnt(
    payout: u64,
    spot: u64,
    upper_barrier: u64,
    lower_barrier: u64,
    sigma_bps_per_sqrt_sec: u64,
    seconds_remaining: u64,
    is_inside: bool,
): u128 {
    let p_up = probability::touch_probability(
        spot, upper_barrier, sigma_bps_per_sqrt_sec, seconds_remaining,
    );
    let p_dn = probability::touch_probability(
        spot, lower_barrier, sigma_bps_per_sqrt_sec, seconds_remaining,
    );
    let scale_u128 = probability::prob_scale() as u128;
    let max_u128 = probability::prob_max() as u128;

    // Union bound for P(either touched), clipped at PROB_MAX. This is
    // P_outside.
    let p_outside_raw = (p_up as u128) + (p_dn as u128);
    let p_outside = if (p_outside_raw > max_u128) max_u128 else p_outside_raw;

    // P_inside = 1 - P_outside, in the same fixed-point. Guard against
    // arithmetic underflow if P_outside ever exceeds scale (it shouldn't
    // because we clipped at max ≤ scale, but defense-in-depth).
    let p_inside = if (scale_u128 > p_outside) scale_u128 - p_outside else 0;

    let p_winning = if (is_inside) p_inside else p_outside;
    (payout as u128) * p_winning / scale_u128
}

// === Test helpers ===

#[test_only]
public fun init_for_testing(ctx: &mut TxContext): (RiskConfig, RiskAdminCap) {
    let config = RiskConfig {
        id: object::new(ctx),
        max_per_position_pct_bps: 50,
        max_per_side_exposure_pct_bps: 1000,
        max_global_pwe_pct_bps: 2500,
        max_corr_bucket_pct_bps: 4000,
        base_fee_bps: 50,
        cap_fee_bps: 450,
        cashout_spread_bps: 500,
        default_payout_mult_bps: 18_000,
        queue_circuit_breaker_pct_bps: 5000,
        wind_down_queue_volume_ratio_days: 30,
        wind_down_active: false,
    };
    let cid = object::id(&config);
    let cap = RiskAdminCap { id: object::new(ctx), config_id: cid };
    (config, cap)
}

#[test_only]
public fun test_set_active_wind_down(config: &mut RiskConfig, on: bool) {
    config.wind_down_active = on;
}
