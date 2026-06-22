// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// The single source of truth for probability-weighted exposure across all
/// markets. Used by:
///   - OI cap denominator (per solvency_v2 §3 — kills the cross-market
///     barrier-stacking attack from cross_market_ptb redteam Attack 1)
///   - Impact fee vulnerability denominator (per impact_fee_v2 §3 — kills
///     the per-market vulnerability bypass)
///
/// One shared object per protocol deployment. Updated atomically by
/// every market::open / market::redeem / ride::open / ride::close.
///
/// Per docs/design/v2/00_reconciliation.md §4. EWMA half-life harmonized
/// to 1h with V_eff per §6.
#[allow(unused_const)]
module wick::global_exposure_registry;

use std::string::String;
use sui::clock::Clock;
use sui::table::{Self, Table};
use sui::vec_map::{Self, VecMap};

const EWMA_HALF_LIFE_MS: u64 = 3_600_000;  // 1 hour, per reconciliation §6

const ENotAdmin: u64 = 0;
// v4.31 — removed unused EBucketAlreadyExists, EBucketUnknown to free
// bytecode budget for the regime drift in segment_market_v4.

public struct UnderlyingSideKey has copy, drop, store {
    underlying: String,
    side: u8,             // 0 = touch, 1 = no_touch
}

public struct ExposureCell has copy, drop, store {
    /// Σ p_i × payout_i, EWMA-smoothed in 1e9-scaled units.
    pwe_smoothed: u128,
    /// Last update time (ms).
    last_update_ms: u64,
}

public struct GlobalExposureRegistry has key {
    id: UID,
    pwe: Table<UnderlyingSideKey, ExposureCell>,
    /// Macro-correlation buckets: bucket_id → list of underlyings in that bucket.
    /// Used by correlation-bucket cap (solvency_v2 §3.3).
    correlation_buckets: VecMap<u8, vector<String>>,
}

public struct RegistryAdminCap has key, store {
    id: UID,
}

// === Events ===

public struct ExposureUpdated has copy, drop {
    underlying: String,
    side: u8,
    pwe_after: u128,
    timestamp_ms: u64,
}

public struct CorrelationBucketSet has copy, drop {
    bucket_id: u8,
    underlyings: vector<String>,
}

// === Init ===

/// Create + share the singleton. Returns the admin cap.
public fun init_registry(ctx: &mut TxContext): RegistryAdminCap {
    let reg = GlobalExposureRegistry {
        id: object::new(ctx),
        pwe: table::new(ctx),
        correlation_buckets: vec_map::empty(),
    };
    transfer::share_object(reg);
    RegistryAdminCap { id: object::new(ctx) }
}

// === Mutators (called by market / ride modules via friend or package-public) ===

/// Apply a delta (signed) to the exposure cell for (underlying, side).
/// Caller computes the delta in probability-weighted units (e.g. p × payout).
/// Positive = open, negative = close/settle.
public(package) fun update_exposure(
    reg: &mut GlobalExposureRegistry,
    underlying: String,
    side: u8,
    is_increase: bool,
    delta_pwe: u128,
    clock: &Clock,
) {
    let key = UnderlyingSideKey { underlying, side };
    let now = clock.timestamp_ms();

    if (!table::contains(&reg.pwe, key)) {
        let initial = if (is_increase) delta_pwe else 0;
        table::add(&mut reg.pwe, key, ExposureCell {
            pwe_smoothed: initial,
            last_update_ms: now,
        });
        sui::event::emit(ExposureUpdated {
            underlying,
            side,
            pwe_after: initial,
            timestamp_ms: now,
        });
        return
    };

    let cell = table::borrow_mut(&mut reg.pwe, key);
    // Apply EWMA decay to existing value before mutating.
    let decayed = ewma_decay(cell.pwe_smoothed, now - cell.last_update_ms);
    let new_value = if (is_increase) {
        decayed + delta_pwe
    } else {
        if (decayed > delta_pwe) decayed - delta_pwe else 0
    };
    cell.pwe_smoothed = new_value;
    cell.last_update_ms = now;

    let underlying_copy = key.underlying;
    sui::event::emit(ExposureUpdated {
        underlying: underlying_copy,
        side,
        pwe_after: new_value,
        timestamp_ms: now,
    });
}

// === Reads ===

/// Read current pwe with on-the-fly EWMA decay applied.
public fun read_pwe(
    reg: &GlobalExposureRegistry,
    underlying: String,
    side: u8,
    clock: &Clock,
): u128 {
    let key = UnderlyingSideKey { underlying, side };
    if (!table::contains(&reg.pwe, key)) return 0;
    let cell = table::borrow(&reg.pwe, key);
    let now = clock.timestamp_ms();
    if (now <= cell.last_update_ms) return cell.pwe_smoothed;
    ewma_decay(cell.pwe_smoothed, now - cell.last_update_ms)
}

/// Sum pwe across all underlyings in a correlation bucket, on the same side.
public fun read_bucket_pwe(
    reg: &GlobalExposureRegistry,
    bucket_id: u8,
    side: u8,
    clock: &Clock,
): u128 {
    if (!vec_map::contains(&reg.correlation_buckets, &bucket_id)) return 0;
    let underlyings = vec_map::get(&reg.correlation_buckets, &bucket_id);
    let mut total: u128 = 0;
    let mut i = 0;
    let n = vector::length(underlyings);
    while (i < n) {
        let u = *vector::borrow(underlyings, i);
        total = total + read_pwe(reg, u, side, clock);
        i = i + 1;
    };
    total
}

// === Admin: correlation buckets ===

public fun set_correlation_bucket(
    _cap: &RegistryAdminCap,
    reg: &mut GlobalExposureRegistry,
    bucket_id: u8,
    underlyings: vector<String>,
) {
    if (vec_map::contains(&reg.correlation_buckets, &bucket_id)) {
        vec_map::remove(&mut reg.correlation_buckets, &bucket_id);
    };
    vec_map::insert(&mut reg.correlation_buckets, bucket_id, underlyings);
    let stored = *vec_map::get(&reg.correlation_buckets, &bucket_id);
    sui::event::emit(CorrelationBucketSet {
        bucket_id,
        underlyings: stored,
    });
}

// === EWMA helper ===

/// Exponential decay with 1h half-life.
/// new_value = old_value × 0.5^(elapsed_ms / HALF_LIFE_MS)
/// Approximated via integer math: for elapsed < half-life, use linear
/// interpolation; otherwise fall back to repeated halving.
fun ewma_decay(value: u128, elapsed_ms: u64): u128 {
    if (value == 0) return 0;
    if (elapsed_ms == 0) return value;

    // Number of full half-lives elapsed
    let full_halves = elapsed_ms / EWMA_HALF_LIFE_MS;
    let mut decayed = value;
    let mut i = 0;
    // Cap at 64 halvings (negligible thereafter, prevents pathological loops)
    while (i < full_halves && i < 64) {
        decayed = decayed / 2;
        if (decayed == 0) return 0;
        i = i + 1;
    };

    // Fractional part — linear approximation (good enough for risk caps)
    let frac_ms = elapsed_ms % EWMA_HALF_LIFE_MS;
    if (frac_ms == 0) return decayed;
    // value × (1 - 0.5 × frac/HALF_LIFE) = value × (HALF_LIFE × 2 - frac) / (HALF_LIFE × 2)
    let num = (EWMA_HALF_LIFE_MS as u128) * 2 - (frac_ms as u128);
    let denom = (EWMA_HALF_LIFE_MS as u128) * 2;
    decayed * num / denom
}

// === Test helpers ===

#[test_only]
public fun init_for_testing(ctx: &mut TxContext): (GlobalExposureRegistry, RegistryAdminCap) {
    let reg = GlobalExposureRegistry {
        id: object::new(ctx),
        pwe: table::new(ctx),
        correlation_buckets: vec_map::empty(),
    };
    let cap = RegistryAdminCap { id: object::new(ctx) };
    (reg, cap)
}

#[test_only]
public fun test_update_exposure(
    reg: &mut GlobalExposureRegistry,
    underlying: String,
    side: u8,
    is_increase: bool,
    delta_pwe: u128,
    clock: &Clock,
) {
    update_exposure(reg, underlying, side, is_increase, delta_pwe, clock);
}

#[test_only]
public fun test_ewma_decay(value: u128, elapsed_ms: u64): u128 {
    ewma_decay(value, elapsed_ms)
}

#[test_only]
public fun ewma_half_life_ms(): u64 { EWMA_HALF_LIFE_MS }
