// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// 4-bucket fee accounting and routing. Per reconciliation §8.
///
/// Buckets:
///   - LP (default 5500 bps) → vault.treasury, available for new payouts
///   - Staker (default 2500 bps) → wick_staking accrual (drained on crank)
///   - Insurance (default 1000 bps) → InsuranceVault (drained on crank)
///   - Protocol (default 1000 bps) → ProtocolTreasury (drained on crank)
///
/// `accrue(router, market_id, balance)` splits an incoming fee balance into
/// 4 portions per the configured shares; LP portion is forwarded directly
/// to the vault, other 3 accumulate in pending balances until `crank()`.
///
/// `crank()` is permissionless. It drains the 3 non-LP pending balances
/// and returns them. Callers are responsible for routing to the final
/// destinations (the staking/insurance/treasury modules), which will be
/// wired up in Phase B + Phase H+. For MVP, crank can return pending
/// balances to a holding object and the integration can be written later.
module wick::fee_router;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::clock::Clock;
use wick::martingaler_vault::{Self as mv, MartingalerVault};

const EBpsSumMismatch: u64 = 0;
const EZeroAmount: u64 = 1;
const EBucketUnknown: u64 = 2;
const ENotAdmin: u64 = 3;
const EShareOutOfRange: u64 = 4;
// v4.31 — removed unused EInsufficientProtocolBucket to free bytecode budget.

const BPS_DENOMINATOR: u64 = 10_000;

const BUCKET_LP: u8 = 0;
const BUCKET_STAKER: u8 = 1;
const BUCKET_INSURANCE: u8 = 2;
const BUCKET_PROTOCOL: u8 = 3;

public struct FeeRouter<phantom C> has key {
    id: UID,
    lp_bps: u64,
    staker_bps: u64,
    insurance_bps: u64,
    protocol_bps: u64,
    /// Pending balances per non-LP bucket.
    /// LP portion is forwarded to vault directly; no LP pending here.
    staker_pending: Balance<C>,
    insurance_pending: Balance<C>,
    protocol_pending: Balance<C>,
    /// Cumulative telemetry by bucket.
    cumulative_lp: u128,
    cumulative_staker: u128,
    cumulative_insurance: u128,
    cumulative_protocol: u128,
    /// Lifetime fees received across all buckets.
    cumulative_total: u128,
    /// Number of accrue calls (telemetry only).
    accrue_count: u64,
    setter_cap_id: ID,
}

public struct FeeRouterAdminCap has key, store {
    id: UID,
    router_id: ID,
}

// === Events ===

public struct FeeRouterInitialized has copy, drop {
    router_id: ID,
    lp_bps: u64,
    staker_bps: u64,
    insurance_bps: u64,
    protocol_bps: u64,
}

public struct FeeAccrued has copy, drop {
    router_id: ID,
    market_id: ID,
    total_in: u64,
    lp_amount: u64,
    staker_amount: u64,
    insurance_amount: u64,
    protocol_amount: u64,
}

public struct FeeCranked has copy, drop {
    router_id: ID,
    bucket: u8,
    drained: u64,
}

public struct FeeSharesUpdated has copy, drop {
    router_id: ID,
    lp_bps: u64,
    staker_bps: u64,
    insurance_bps: u64,
    protocol_bps: u64,
}

// === Init ===

/// Create + share. Default split per reconciliation §8: 55/25/10/10.
public fun init_router<C>(ctx: &mut TxContext): FeeRouterAdminCap {
    init_router_with_shares<C>(5500, 2500, 1000, 1000, ctx)
}

public fun init_router_with_shares<C>(
    lp_bps: u64,
    staker_bps: u64,
    insurance_bps: u64,
    protocol_bps: u64,
    ctx: &mut TxContext,
): FeeRouterAdminCap {
    assert!(lp_bps + staker_bps + insurance_bps + protocol_bps == BPS_DENOMINATOR, EBpsSumMismatch);
    let router = FeeRouter<C> {
        id: object::new(ctx),
        lp_bps,
        staker_bps,
        insurance_bps,
        protocol_bps,
        staker_pending: balance::zero<C>(),
        insurance_pending: balance::zero<C>(),
        protocol_pending: balance::zero<C>(),
        cumulative_lp: 0,
        cumulative_staker: 0,
        cumulative_insurance: 0,
        cumulative_protocol: 0,
        cumulative_total: 0,
        accrue_count: 0,
        setter_cap_id: object::id_from_address(@0x0),  // patched below
    };
    let router_id = object::id(&router);
    let cap = FeeRouterAdminCap { id: object::new(ctx), router_id };
    sui::event::emit(FeeRouterInitialized {
        router_id,
        lp_bps,
        staker_bps,
        insurance_bps,
        protocol_bps,
    });
    transfer::share_object(router);
    cap
}

// === Reads ===

public fun lp_bps<C>(r: &FeeRouter<C>): u64 { r.lp_bps }
public fun staker_bps<C>(r: &FeeRouter<C>): u64 { r.staker_bps }
public fun insurance_bps<C>(r: &FeeRouter<C>): u64 { r.insurance_bps }
public fun protocol_bps<C>(r: &FeeRouter<C>): u64 { r.protocol_bps }
public fun staker_pending<C>(r: &FeeRouter<C>): u64 { balance::value(&r.staker_pending) }
public fun insurance_pending<C>(r: &FeeRouter<C>): u64 { balance::value(&r.insurance_pending) }
public fun protocol_pending<C>(r: &FeeRouter<C>): u64 { balance::value(&r.protocol_pending) }
public fun cumulative_lp<C>(r: &FeeRouter<C>): u128 { r.cumulative_lp }
public fun cumulative_staker<C>(r: &FeeRouter<C>): u128 { r.cumulative_staker }
public fun cumulative_insurance<C>(r: &FeeRouter<C>): u128 { r.cumulative_insurance }
public fun cumulative_protocol<C>(r: &FeeRouter<C>): u128 { r.cumulative_protocol }
public fun cumulative_total<C>(r: &FeeRouter<C>): u128 { r.cumulative_total }
public fun accrue_count<C>(r: &FeeRouter<C>): u64 { r.accrue_count }

// === Accrue ===

/// Split an incoming fee balance into 4 portions per the configured shares.
/// LP portion goes directly to vault.treasury (auto-harvested into queue
/// heads if queue_total > 0). Other 3 portions accumulate in pending.
public fun accrue<C>(
    router: &mut FeeRouter<C>,
    vault: &mut MartingalerVault<C>,
    market_id: ID,
    fee_balance: Balance<C>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let total = balance::value(&fee_balance);
    if (total == 0) {
        balance::destroy_zero(fee_balance);
        return
    };

    // Compute bucket amounts. LP gets the residual to ensure no dust loss.
    let staker_amt = mul_div(total, router.staker_bps, BPS_DENOMINATOR);
    let insurance_amt = mul_div(total, router.insurance_bps, BPS_DENOMINATOR);
    let protocol_amt = mul_div(total, router.protocol_bps, BPS_DENOMINATOR);
    let lp_amt = total - staker_amt - insurance_amt - protocol_amt;

    let mut remaining = fee_balance;

    if (staker_amt > 0) {
        let split = balance::split(&mut remaining, staker_amt);
        balance::join(&mut router.staker_pending, split);
        router.cumulative_staker = router.cumulative_staker + (staker_amt as u128);
    };
    if (insurance_amt > 0) {
        let split = balance::split(&mut remaining, insurance_amt);
        balance::join(&mut router.insurance_pending, split);
        router.cumulative_insurance = router.cumulative_insurance + (insurance_amt as u128);
    };
    if (protocol_amt > 0) {
        let split = balance::split(&mut remaining, protocol_amt);
        balance::join(&mut router.protocol_pending, split);
        router.cumulative_protocol = router.cumulative_protocol + (protocol_amt as u128);
    };

    // Whatever remains is LP — forward to vault directly.
    let lp_actual = balance::value(&remaining);
    if (lp_actual > 0) {
        let lp_coin = coin::from_balance(remaining, ctx);
        mv::deposit_open(vault, lp_coin, clock, ctx);
        router.cumulative_lp = router.cumulative_lp + (lp_actual as u128);
    } else {
        balance::destroy_zero(remaining);
    };

    router.cumulative_total = router.cumulative_total + (total as u128);
    router.accrue_count = router.accrue_count + 1;

    sui::event::emit(FeeAccrued {
        router_id: object::id(router),
        market_id,
        total_in: total,
        lp_amount: lp_amt,
        staker_amount: staker_amt,
        insurance_amount: insurance_amt,
        protocol_amount: protocol_amt,
    });
}

// === Crank — permissionless drain ===

/// Drain all pending of a specific bucket. Returns the Balance<C> for the
/// caller to route to its final destination (staking pool, insurance vault,
/// protocol treasury). Bucket 0 (LP) returns zero — LP fees were already
/// forwarded inline by `accrue`.
public fun crank_bucket<C>(
    router: &mut FeeRouter<C>,
    bucket: u8,
): Balance<C> {
    if (bucket == BUCKET_STAKER) {
        let drained = balance::withdraw_all(&mut router.staker_pending);
        let amount = balance::value(&drained);
        if (amount > 0) {
            sui::event::emit(FeeCranked {
                router_id: object::id(router),
                bucket,
                drained: amount,
            });
        };
        drained
    } else if (bucket == BUCKET_INSURANCE) {
        let drained = balance::withdraw_all(&mut router.insurance_pending);
        let amount = balance::value(&drained);
        if (amount > 0) {
            sui::event::emit(FeeCranked {
                router_id: object::id(router),
                bucket,
                drained: amount,
            });
        };
        drained
    } else if (bucket == BUCKET_PROTOCOL) {
        let drained = balance::withdraw_all(&mut router.protocol_pending);
        let amount = balance::value(&drained);
        if (amount > 0) {
            sui::event::emit(FeeCranked {
                router_id: object::id(router),
                bucket,
                drained: amount,
            });
        };
        drained
    } else if (bucket == BUCKET_LP) {
        // LP fees were already forwarded by accrue; no pending here.
        balance::zero<C>()
    } else {
        abort EBucketUnknown
    }
}

/// Withdraw up to `amount` from the protocol bucket. Returns the actual
/// Balance withdrawn (clamped to `min(amount, protocol_pending)`). If the
/// bucket is empty this returns a zero balance.
///
/// Added in v3.1 for `wick::sponsor::harvest_to_sponsor` (doc 22 §3.1).
/// Scoped `public(package)` so only same-package consumers can pull bounded
/// amounts without draining the whole bucket the way `crank_bucket` does.
/// The existing public ABI is unchanged.
///
/// SAFETY: `amount > 0` required (aborts `EZeroAmount` on misuse). If the
/// protocol bucket is smaller than the requested amount the returned
/// balance is silently clamped — callers should re-check `value()` if
/// they need the exact requested amount.
public(package) fun withdraw_protocol<C>(
    router: &mut FeeRouter<C>,
    amount: u64,
): Balance<C> {
    assert!(amount > 0, EZeroAmount);
    let available = balance::value(&router.protocol_pending);
    if (available == 0) {
        return balance::zero<C>()
    };
    let take = if (amount > available) available else amount;
    let drained = balance::split(&mut router.protocol_pending, take);
    sui::event::emit(FeeCranked {
        router_id: object::id(router),
        bucket: BUCKET_PROTOCOL,
        drained: take,
    });
    drained
}

// === Admin ===

public fun set_shares<C>(
    cap: &FeeRouterAdminCap,
    router: &mut FeeRouter<C>,
    lp_bps: u64,
    staker_bps: u64,
    insurance_bps: u64,
    protocol_bps: u64,
) {
    assert!(cap.router_id == object::id(router), ENotAdmin);
    assert!(lp_bps + staker_bps + insurance_bps + protocol_bps == BPS_DENOMINATOR, EBpsSumMismatch);
    // Hard upper bound on protocol share (anti-rug)
    assert!(protocol_bps <= 2000, EShareOutOfRange);  // max 20%
    router.lp_bps = lp_bps;
    router.staker_bps = staker_bps;
    router.insurance_bps = insurance_bps;
    router.protocol_bps = protocol_bps;
    sui::event::emit(FeeSharesUpdated {
        router_id: object::id(router),
        lp_bps,
        staker_bps,
        insurance_bps,
        protocol_bps,
    });
}

// === Bucket id constants ===

public fun bucket_lp(): u8 { BUCKET_LP }
public fun bucket_staker(): u8 { BUCKET_STAKER }
public fun bucket_insurance(): u8 { BUCKET_INSURANCE }
public fun bucket_protocol(): u8 { BUCKET_PROTOCOL }

// === Helpers ===

fun mul_div(a: u64, b: u64, denom: u64): u64 {
    (((a as u128) * (b as u128)) / (denom as u128)) as u64
}

// === Test helpers ===

#[test_only]
public fun init_for_testing<C>(ctx: &mut TxContext): (FeeRouter<C>, FeeRouterAdminCap) {
    init_for_testing_with_shares<C>(5500, 2500, 1000, 1000, ctx)
}

#[test_only]
public fun init_for_testing_with_shares<C>(
    lp_bps: u64,
    staker_bps: u64,
    insurance_bps: u64,
    protocol_bps: u64,
    ctx: &mut TxContext,
): (FeeRouter<C>, FeeRouterAdminCap) {
    assert!(lp_bps + staker_bps + insurance_bps + protocol_bps == BPS_DENOMINATOR, EBpsSumMismatch);
    let router = FeeRouter<C> {
        id: object::new(ctx),
        lp_bps,
        staker_bps,
        insurance_bps,
        protocol_bps,
        staker_pending: balance::zero<C>(),
        insurance_pending: balance::zero<C>(),
        protocol_pending: balance::zero<C>(),
        cumulative_lp: 0,
        cumulative_staker: 0,
        cumulative_insurance: 0,
        cumulative_protocol: 0,
        cumulative_total: 0,
        accrue_count: 0,
        setter_cap_id: object::id_from_address(@0x0),
    };
    let router_id = object::id(&router);
    let cap = FeeRouterAdminCap { id: object::new(ctx), router_id };
    (router, cap)
}

#[test_only]
public fun test_accrue<C>(
    router: &mut FeeRouter<C>,
    vault: &mut MartingalerVault<C>,
    market_id: ID,
    fee_balance: Balance<C>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    accrue(router, vault, market_id, fee_balance, clock, ctx);
}
