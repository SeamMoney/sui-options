// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Sponsored-cranking gas tank for Wick v3.
///
/// Per docs/design/v2/22_sponsored_cranking_v3.md §3.1.
///
/// Each `record_segment` call on a SegmentMarketV3 is sponsored — the user
/// signs intent from their burner, the off-chain `/api/sponsor` service
/// co-signs as gas owner. The gas-owner address is the **sponsor wallet**;
/// that wallet is funded from the protocol fee bucket through this module.
///
/// The flow:
/// ```
/// fee_router.protocol_pending ─► harvest_to_sponsor ─► sponsor_address (SUI)
///                                                      ▲
///                            (off-chain) signs gas for ┘
/// ```
///
/// Anyone may call `harvest_to_sponsor` (it is permissionless on chain) but
/// the function enforces two on-chain guards:
///
/// 1. **Threshold gate.** Caller asserts the current sponsor balance is
///    below `refill_threshold_mist`. (See note below on how on-chain code
///    "knows" an off-chain wallet's balance — it doesn't; the caller
///    supplies a measurement and Move enforces the daily spend cap, which
///    is what actually bounds adversarial calls.)
///
/// 2. **Daily spend cap.** `max_spend_per_day_mist` caps the total drained
///    per UTC-day window. Auto-resets when `clock.timestamp_ms / 86_400_000`
///    crosses to a new day. Manual reset is also exposed for ops.
///
/// The struct layout matches doc 22 §3.1 byte-for-byte. The one honest
/// deviation from the doc's pseudo-code: the doc writes
/// `sui::coin::balance_of(policy.sponsor_address)` which is not a real Sui
/// API (Sui's on-chain Move cannot enumerate the SUI coins owned by an
/// arbitrary address — coins are owned objects). We accept the current
/// balance as a parameter; adversarial callers who pass a false low value
/// are bounded by `spend_today_mist + max_spend_per_day_mist`. Off-chain,
/// the sponsor service is the only thing that calls this anyway.
///
/// All admin tweaks (sponsor address, daily cap, refill targets, manual
/// reset) require `SponsorCap`, transferred to the publisher in
/// `init_sponsor`.
module wick::sponsor;

use sui::balance::Balance;
use sui::clock::Clock;
use sui::coin;
use sui::sui::SUI;
use wick::fee_router::{Self as fr, FeeRouter};

// === Error codes ===

const ENotAdmin: u64 = 0;
const ENotBelowThreshold: u64 = 1;
const EDailyCapExhausted: u64 = 2;
const EInvalidTarget: u64 = 3;
const EZeroAmount: u64 = 4;

// === Constants ===

/// One UTC day in milliseconds.
const MS_PER_DAY: u64 = 86_400_000;

/// Default sane policy parameters (doc 22 §3.1 + §5). Tunable via the
/// admin-cap setters below.
///
/// `max_spend_per_day` = 250 SUI ≈ 25% above the daily projection from
/// doc 22 §5 (~200 SUI/day fully ramped). Halts runaway sponsorship spend
/// at the cap rather than letting the protocol bucket drain unchecked.
const DEFAULT_MAX_SPEND_PER_DAY_MIST: u64 = 250_000_000_000;
/// `refill_threshold` = 5 SUI. Sponsor refills only when its on-chain
/// observed balance drops below this floor; otherwise the call aborts so
/// the cranker can't push the protocol bucket dry by spam-refilling.
const DEFAULT_REFILL_THRESHOLD_MIST: u64 = 5_000_000_000;
/// `refill_target` = 50 SUI. Each refill tops the sponsor up to this
/// target (or as close as the protocol bucket / daily cap permits).
const DEFAULT_REFILL_TARGET_MIST: u64 = 50_000_000_000;

// === Types ===

/// Permissioned cap held by the sponsor-service operator. Required for
/// any policy mutation; created exactly once in `init_sponsor` and
/// transferred to the publisher.
public struct SponsorCap has key, store {
    id: UID,
    policy_id: ID,
}

/// Shared policy object. Holds the sponsor wallet address (the off-chain
/// gas-owner key's address) and the rate-limiting + refill parameters.
public struct SponsorPolicy has key {
    id: UID,
    /// Off-chain sponsor wallet address (gas-owner of sponsored txs).
    /// Funded by `harvest_to_sponsor`. Initially set to the publisher
    /// at `init_sponsor`; ops MUST update before going live.
    sponsor_address: address,
    /// Daily SUI spend cap (anti-rug + DoS cap). See doc 22 §4.
    max_spend_per_day_mist: u64,
    /// Cumulative MIST drained today. Reset on UTC-midnight rollover.
    spend_today_mist: u64,
    /// UTC-day index of the last reset (clock.timestamp_ms / 86_400_000).
    last_reset_day: u64,
    /// Refill is allowed only when the sponsor balance is below this.
    refill_threshold_mist: u64,
    /// Refill targets the sponsor balance UP TO this value.
    refill_target_mist: u64,
}

// === Events ===

public struct SponsorInitialized has copy, drop {
    policy_id: ID,
    cap_id: ID,
    sponsor_address: address,
    max_spend_per_day_mist: u64,
    refill_threshold_mist: u64,
    refill_target_mist: u64,
}

public struct SponsorRefilled has copy, drop {
    policy_id: ID,
    drained_mist: u64,
    sponsor_address: address,
    spend_today_mist_after: u64,
    day: u64,
}

public struct SponsorAddressUpdated has copy, drop {
    policy_id: ID,
    old_address: address,
    new_address: address,
}

public struct SponsorMaxSpendUpdated has copy, drop {
    policy_id: ID,
    new_max_spend_per_day_mist: u64,
}

public struct SponsorRefillTargetsUpdated has copy, drop {
    policy_id: ID,
    refill_threshold_mist: u64,
    refill_target_mist: u64,
}

public struct SponsorDailySpendReset has copy, drop {
    policy_id: ID,
    day: u64,
    prior_spend_today_mist: u64,
    auto: bool,
}

// === Init ===
//
// NOTE: Sui's `init` identifier is reserved for the special module
// initializer (runs once on publish, signature `fun init(ctx)`). The
// pattern across this codebase (see `risk_config::init_config`,
// `fee_router::init_router`, `usd_price_oracle::init_oracle`) is
// `init_<thing>` — caller-triggered, returns or transfers the cap. We
// follow that pattern here; doc 22 §3.1 spec calls this `init(ctx)` but
// the substantive contract surface (shared SponsorPolicy + SponsorCap
// transferred to sender) is identical.

/// Create the SponsorPolicy (shared) and SponsorCap (transferred to
/// sender). Defaults match doc 22 §3.1 + §5. The sponsor_address is set
/// to the publisher; ops MUST call `set_sponsor_address` with the actual
/// sponsor wallet before turning the service on.
public entry fun init_sponsor(ctx: &mut TxContext) {
    init_sponsor_with_params(
        tx_context::sender(ctx),
        DEFAULT_MAX_SPEND_PER_DAY_MIST,
        DEFAULT_REFILL_THRESHOLD_MIST,
        DEFAULT_REFILL_TARGET_MIST,
        ctx,
    );
}

/// Same as `init_sponsor` but lets ops pre-configure all four knobs in one
/// call. Useful for genesis-bootstrap where the sponsor key is known up
/// front.
public fun init_sponsor_with_params(
    sponsor_address: address,
    max_spend_per_day_mist: u64,
    refill_threshold_mist: u64,
    refill_target_mist: u64,
    ctx: &mut TxContext,
) {
    assert!(refill_target_mist > refill_threshold_mist, EInvalidTarget);
    let policy = SponsorPolicy {
        id: object::new(ctx),
        sponsor_address,
        max_spend_per_day_mist,
        spend_today_mist: 0,
        last_reset_day: 0,
        refill_threshold_mist,
        refill_target_mist,
    };
    let policy_id = object::id(&policy);
    let cap = SponsorCap { id: object::new(ctx), policy_id };
    let cap_id = object::id(&cap);
    sui::event::emit(SponsorInitialized {
        policy_id,
        cap_id,
        sponsor_address,
        max_spend_per_day_mist,
        refill_threshold_mist,
        refill_target_mist,
    });
    transfer::share_object(policy);
    transfer::public_transfer(cap, tx_context::sender(ctx));
}

// === Reads ===

public fun sponsor_address(p: &SponsorPolicy): address { p.sponsor_address }
public fun max_spend_per_day_mist(p: &SponsorPolicy): u64 { p.max_spend_per_day_mist }
public fun spend_today_mist(p: &SponsorPolicy): u64 { p.spend_today_mist }
public fun last_reset_day(p: &SponsorPolicy): u64 { p.last_reset_day }
public fun refill_threshold_mist(p: &SponsorPolicy): u64 { p.refill_threshold_mist }
public fun refill_target_mist(p: &SponsorPolicy): u64 { p.refill_target_mist }

// === Harvest — permissionless ===

/// Permissionless refill. Drains up to `refill_target - current_balance`
/// from `fee_router::protocol_pending`, transferring it to
/// `policy.sponsor_address`.
///
/// `current_sponsor_balance_mist` is supplied by the caller (the off-chain
/// sponsor service or any keeper) — see module docstring for the rationale.
/// Adversarial callers are bounded by `max_spend_per_day_mist`.
///
/// Aborts:
///   - ENotBelowThreshold — claimed balance ≥ refill_threshold_mist.
///   - EDailyCapExhausted — would push `spend_today_mist` past the cap
///     after auto-reset for UTC midnight rollover.
///
/// The fee-router collateral is pinned to `sui::sui::SUI` because gas
/// can only be paid in SUI; routing non-SUI collateral to the sponsor
/// wallet would be useless. (Per doc 22 §3.1.)
public entry fun harvest_to_sponsor(
    policy: &mut SponsorPolicy,
    fee_router: &mut FeeRouter<SUI>,
    current_sponsor_balance_mist: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    // 1) Auto-reset spend window on UTC-midnight rollover.
    maybe_reset_daily_spend(policy, clock);

    // 2) Threshold gate.
    assert!(
        current_sponsor_balance_mist < policy.refill_threshold_mist,
        ENotBelowThreshold,
    );

    // 3) Compute requested refill (target - current_balance), then clamp
    //    against remaining daily budget.
    let requested = policy.refill_target_mist - current_sponsor_balance_mist;
    let remaining_daily = if (policy.spend_today_mist >= policy.max_spend_per_day_mist) {
        0
    } else {
        policy.max_spend_per_day_mist - policy.spend_today_mist
    };
    assert!(remaining_daily > 0, EDailyCapExhausted);
    let to_drain = if (requested > remaining_daily) remaining_daily else requested;
    assert!(to_drain > 0, EZeroAmount);

    // 4) Withdraw from the protocol bucket. Returned balance is clamped to
    //    the bucket's actual available amount; we record the actual.
    let drained: Balance<SUI> = fr::withdraw_protocol<SUI>(fee_router, to_drain);
    let actual = sui::balance::value(&drained);
    if (actual == 0) {
        // Bucket was empty — nothing to do. Return the zero balance to
        // satisfy the borrow checker and bail without bumping spend.
        sui::balance::destroy_zero(drained);
        return
    };

    // 5) Bump spend counter, transfer to sponsor wallet.
    policy.spend_today_mist = policy.spend_today_mist + actual;
    let payout = coin::from_balance(drained, ctx);
    transfer::public_transfer(payout, policy.sponsor_address);

    sui::event::emit(SponsorRefilled {
        policy_id: object::id(policy),
        drained_mist: actual,
        sponsor_address: policy.sponsor_address,
        spend_today_mist_after: policy.spend_today_mist,
        day: policy.last_reset_day,
    });
}

// === Admin: cap-gated setters ===

/// Update the sponsor wallet address. Required before going live with a
/// freshly-bootstrapped policy.
public entry fun set_sponsor_address(
    cap: &SponsorCap,
    policy: &mut SponsorPolicy,
    new_address: address,
) {
    assert!(cap.policy_id == object::id(policy), ENotAdmin);
    let old = policy.sponsor_address;
    policy.sponsor_address = new_address;
    sui::event::emit(SponsorAddressUpdated {
        policy_id: object::id(policy),
        old_address: old,
        new_address,
    });
}

/// Adjust the daily spend cap. Doc 22 §4 invariant: this is enforced both
/// on-chain (here) and off-chain (in the sponsor service).
public entry fun set_max_spend_per_day(
    cap: &SponsorCap,
    policy: &mut SponsorPolicy,
    new_max: u64,
) {
    assert!(cap.policy_id == object::id(policy), ENotAdmin);
    policy.max_spend_per_day_mist = new_max;
    sui::event::emit(SponsorMaxSpendUpdated {
        policy_id: object::id(policy),
        new_max_spend_per_day_mist: new_max,
    });
}

/// Update refill threshold + target together (the relation
/// `target > threshold` must hold).
public entry fun set_refill_targets(
    cap: &SponsorCap,
    policy: &mut SponsorPolicy,
    threshold: u64,
    target: u64,
) {
    assert!(cap.policy_id == object::id(policy), ENotAdmin);
    assert!(target > threshold, EInvalidTarget);
    policy.refill_threshold_mist = threshold;
    policy.refill_target_mist = target;
    sui::event::emit(SponsorRefillTargetsUpdated {
        policy_id: object::id(policy),
        refill_threshold_mist: threshold,
        refill_target_mist: target,
    });
}

/// Manual daily-spend reset for ops (the harvest path also auto-resets
/// on UTC midnight rollover, so this is rarely needed).
public entry fun reset_daily_spend(
    cap: &SponsorCap,
    policy: &mut SponsorPolicy,
    clock: &Clock,
) {
    assert!(cap.policy_id == object::id(policy), ENotAdmin);
    let prior = policy.spend_today_mist;
    let day = clock.timestamp_ms() / MS_PER_DAY;
    policy.spend_today_mist = 0;
    policy.last_reset_day = day;
    sui::event::emit(SponsorDailySpendReset {
        policy_id: object::id(policy),
        day,
        prior_spend_today_mist: prior,
        auto: false,
    });
}

// === Internals ===

/// Auto-reset the daily spend counter if the current UTC day differs from
/// `last_reset_day`. No-op otherwise.
fun maybe_reset_daily_spend(policy: &mut SponsorPolicy, clock: &Clock) {
    let day = clock.timestamp_ms() / MS_PER_DAY;
    if (day > policy.last_reset_day) {
        let prior = policy.spend_today_mist;
        policy.spend_today_mist = 0;
        policy.last_reset_day = day;
        sui::event::emit(SponsorDailySpendReset {
            policy_id: object::id(policy),
            day,
            prior_spend_today_mist: prior,
            auto: true,
        });
    };
}

// === Test helpers ===

#[test_only]
public fun init_for_testing(
    sponsor_address: address,
    ctx: &mut TxContext,
): (SponsorPolicy, SponsorCap) {
    init_for_testing_with_params(
        sponsor_address,
        DEFAULT_MAX_SPEND_PER_DAY_MIST,
        DEFAULT_REFILL_THRESHOLD_MIST,
        DEFAULT_REFILL_TARGET_MIST,
        ctx,
    )
}

#[test_only]
public fun init_for_testing_with_params(
    sponsor_address: address,
    max_spend_per_day_mist: u64,
    refill_threshold_mist: u64,
    refill_target_mist: u64,
    ctx: &mut TxContext,
): (SponsorPolicy, SponsorCap) {
    assert!(refill_target_mist > refill_threshold_mist, EInvalidTarget);
    let policy = SponsorPolicy {
        id: object::new(ctx),
        sponsor_address,
        max_spend_per_day_mist,
        spend_today_mist: 0,
        last_reset_day: 0,
        refill_threshold_mist,
        refill_target_mist,
    };
    let policy_id = object::id(&policy);
    let cap = SponsorCap { id: object::new(ctx), policy_id };
    (policy, cap)
}
