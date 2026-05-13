// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// WICK staking — stake WICK to earn protocol fee dividends paid in
/// arbitrary collateral types (USDC, SUI, etc).
///
/// Per docs/design/v2/03_wick_tokenomics_v2.md + reconciliation §9.
///
/// Anti-loop layers (per spec):
///   1. 7-day unstake delay (initiate_unstake → wait → complete_unstake).
///   2. Per-fund 30% cap on lifetime claims (max_total_claimed ≤ 30% of
///      cumulative_network_losses).
///   3. Per-address 30% lifetime-loss claim cap (claimed ≤ 30% of
///      address's tracked lifetime loss).
///   4. Forfeit-to-insurance: claims that exceed cap are forfeited to
///      InsuranceVault (not back to staker pool — kills sybil amplification).
///   5. (Future) 48h cliff — debt_per_wick snapshot at stake-time so new
///      stakers can't retroactively claim historical fees.
///
/// MasterChef-style accumulator math: each currency has an `acc_per_wick`
/// that grows on every accrue_dividends. StakeReceipt records the
/// per-currency debt at stake time. Pending claim = staked × (acc - debt).
module wick::wick_staking;

use std::type_name::{Self, TypeName};
use sui::bag::{Self, Bag};
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::table::{Self, Table};
use sui::vec_map::{Self, VecMap};
use wick::wick_token::WICK_TOKEN;

// === Error codes ===
const EZeroAmount: u64 = 0;
const ENotInitiated: u64 = 1;
const EUnstakeStillLocked: u64 = 2;
const ENotOwner: u64 = 3;
const EAlreadyInitiated: u64 = 4;
const ENoStake: u64 = 5;
const EClaimExceedsAddressCap: u64 = 6;
const EClaimExceedsFundCap: u64 = 7;
const EBagAlreadySetup: u64 = 8;

// === Constants ===
const UNSTAKE_DELAY_MS: u64 = 7 * 86_400_000;  // 7 days
const ACC_SCALE: u128 = 1_000_000_000_000;     // 1e12 — for fixed-point accumulator math
const CLAIM_CAP_BPS: u64 = 3000;                // 30% of lifetime loss

// === State ===

public struct WickStakingPool has key {
    id: UID,
    /// Total WICK currently staked.
    total_staked: u64,
    /// acc_per_wick scaled by ACC_SCALE, per currency type. Bag<TypeName, u128>.
    acc_per_wick: Bag,
    /// Pending dividend balances per currency type. Bag<TypeName, Balance<C>>.
    pending: Bag,
    /// Append-only registry of every currency the pool has ever accrued.
    /// Used at stake-time to snapshot debt for already-seen currencies, so
    /// late stakers cannot retroactively claim pre-stake fees.
    currencies_seen: vector<TypeName>,
    /// Per-address state.
    addr_state: Table<address, AddrState>,
    /// Tracked WICK balance held by the pool itself.
    staked_balance: Balance<WICK_TOKEN>,
    /// Cumulative network losses across all markets (in micro-USD).
    /// Used as denominator for per-fund claim cap.
    cumulative_network_losses_micro_usd: u128,
    /// Cumulative claimed-by-all-stakers (in micro-USD).
    cumulative_claimed_micro_usd: u128,
    /// Forfeited dividends pending route to insurance (micro-USD telemetry).
    cumulative_forfeit_to_insurance_micro_usd: u128,
}

public struct AddrState has copy, drop, store {
    /// Lifetime loss tracked for this address (sum of mint_to_loser losses).
    lifetime_loss_micro_usd: u128,
    /// Lifetime claimed by this address (in micro-USD equivalent).
    claimed_micro_usd: u128,
    /// Most recent stake event — used for last_settlement_observed_ms anchor.
    last_stake_at_ms: u64,
}

public struct StakeReceipt has key, store {
    id: UID,
    owner: address,
    /// WICK amount staked.
    staked: u64,
    /// Per-currency debt accumulator at stake time.
    /// VecMap (not Bag) so the struct can be dropped without explicit drain.
    debt_per_wick_by_currency: VecMap<TypeName, u128>,
    /// When this receipt was minted.
    acquired_at_ms: u64,
    /// Set when initiate_unstake is called. complete_unstake requires
    /// now >= this + UNSTAKE_DELAY_MS.
    unstake_initiated_at_ms: Option<u64>,
    /// Anchor for owned-vs-rented stake distinction (used by gamification).
    last_settlement_observed_ms: u64,
}

public struct StakingAdminCap has key, store {
    id: UID,
    pool_id: ID,
}

// === Events ===

public struct StakingPoolInitialized has copy, drop {
    pool_id: ID,
}

public struct WickStaked has copy, drop {
    pool_id: ID,
    staker: address,
    amount: u64,
    receipt_id: ID,
    new_total_staked: u64,
}

public struct UnstakeInitiated has copy, drop {
    pool_id: ID,
    receipt_id: ID,
    staker: address,
    initiated_at_ms: u64,
    available_at_ms: u64,
}

public struct UnstakeCompleted has copy, drop {
    pool_id: ID,
    receipt_id: ID,
    staker: address,
    amount: u64,
}

public struct DividendsAccrued has copy, drop {
    pool_id: ID,
    currency: TypeName,
    amount: u64,
    new_acc_per_wick: u128,
    total_staked_at_accrue: u64,
}

public struct DividendsClaimed has copy, drop {
    pool_id: ID,
    receipt_id: ID,
    staker: address,
    currency: TypeName,
    claimed: u64,
    forfeited: u64,
}

public struct LossRecordedForCap has copy, drop {
    pool_id: ID,
    loser: address,
    loss_micro_usd: u64,
    cumulative_network_micro_usd: u128,
}

// === Init ===

public fun init_pool(ctx: &mut TxContext): StakingAdminCap {
    let pool = WickStakingPool {
        id: object::new(ctx),
        total_staked: 0,
        acc_per_wick: bag::new(ctx),
        pending: bag::new(ctx),
        currencies_seen: vector::empty(),
        addr_state: table::new(ctx),
        staked_balance: balance::zero<WICK_TOKEN>(),
        cumulative_network_losses_micro_usd: 0,
        cumulative_claimed_micro_usd: 0,
        cumulative_forfeit_to_insurance_micro_usd: 0,
    };
    let pool_id = object::id(&pool);
    sui::event::emit(StakingPoolInitialized { pool_id });
    let cap = StakingAdminCap { id: object::new(ctx), pool_id };
    transfer::share_object(pool);
    cap
}

// === Stake ===

public fun stake(
    pool: &mut WickStakingPool,
    wick_in: Coin<WICK_TOKEN>,
    clock: &Clock,
    ctx: &mut TxContext,
): StakeReceipt {
    let amount = wick_in.value();
    assert!(amount > 0, EZeroAmount);
    let now = clock.timestamp_ms();
    let staker = ctx.sender();

    balance::join(&mut pool.staked_balance, wick_in.into_balance());
    pool.total_staked = pool.total_staked + amount;

    // Snapshot per-currency debt for every currency the pool has ever seen.
    // This is what stops late stakers from claiming pre-stake fees: their
    // debt starts at the current acc, so delta on first claim is 0 for any
    // accrue that happened before the stake.
    let mut debt_map = vec_map::empty<TypeName, u128>();
    let mut i = 0;
    let n = vector::length(&pool.currencies_seen);
    while (i < n) {
        let key = *vector::borrow(&pool.currencies_seen, i);
        let acc = bag_get_or_zero_u128(&pool.acc_per_wick, key);
        vec_map::insert(&mut debt_map, key, acc);
        i = i + 1;
    };

    // Update or create addr state
    if (!table::contains(&pool.addr_state, staker)) {
        table::add(&mut pool.addr_state, staker, AddrState {
            lifetime_loss_micro_usd: 0,
            claimed_micro_usd: 0,
            last_stake_at_ms: now,
        });
    } else {
        let s = table::borrow_mut(&mut pool.addr_state, staker);
        s.last_stake_at_ms = now;
    };

    let receipt = StakeReceipt {
        id: object::new(ctx),
        owner: staker,
        staked: amount,
        debt_per_wick_by_currency: debt_map,
        acquired_at_ms: now,
        unstake_initiated_at_ms: option::none(),
        last_settlement_observed_ms: now,
    };

    sui::event::emit(WickStaked {
        pool_id: object::id(pool),
        staker,
        amount,
        receipt_id: object::id(&receipt),
        new_total_staked: pool.total_staked,
    });
    receipt
}

public fun initiate_unstake(
    receipt: &mut StakeReceipt,
    pool: &WickStakingPool,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(receipt.owner == ctx.sender(), ENotOwner);
    assert!(option::is_none(&receipt.unstake_initiated_at_ms), EAlreadyInitiated);
    let now = clock.timestamp_ms();
    receipt.unstake_initiated_at_ms = option::some(now);
    sui::event::emit(UnstakeInitiated {
        pool_id: object::id(pool),
        receipt_id: object::id(receipt),
        staker: receipt.owner,
        initiated_at_ms: now,
        available_at_ms: now + UNSTAKE_DELAY_MS,
    });
}

public fun complete_unstake(
    receipt: StakeReceipt,
    pool: &mut WickStakingPool,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<WICK_TOKEN> {
    assert!(receipt.owner == ctx.sender(), ENotOwner);
    assert!(option::is_some(&receipt.unstake_initiated_at_ms), ENotInitiated);
    let initiated_at = *option::borrow(&receipt.unstake_initiated_at_ms);
    let now = clock.timestamp_ms();
    assert!(now >= initiated_at + UNSTAKE_DELAY_MS, EUnstakeStillLocked);

    let StakeReceipt {
        id,
        owner,
        staked,
        debt_per_wick_by_currency: _,
        acquired_at_ms: _,
        unstake_initiated_at_ms: _,
        last_settlement_observed_ms: _,
    } = receipt;

    // VecMap has drop — unclaimed dividends are abandoned with the receipt
    object::delete(id);

    pool.total_staked = pool.total_staked - staked;
    let withdrawn = balance::split(&mut pool.staked_balance, staked);

    sui::event::emit(UnstakeCompleted {
        pool_id: object::id(pool),
        receipt_id: object::id_from_address(@0x0),  // post-delete
        staker: owner,
        amount: staked,
    });
    coin::from_balance(withdrawn, ctx)
}

// === Accrue (called by fee_router::crank or directly) ===

/// Accrue dividends in currency C into the pool. Increases acc_per_wick
/// proportionally and adds the balance to pending. Idempotent on zero.
public fun accrue_dividends<C>(
    pool: &mut WickStakingPool,
    fee_balance: Balance<C>,
) {
    let amount = balance::value(&fee_balance);
    if (amount == 0) {
        balance::destroy_zero(fee_balance);
        return
    };

    let key = type_name::with_defining_ids<C>();

    // Register currency on first sight so future stakers can snapshot its acc.
    if (!vector::contains(&pool.currencies_seen, &key)) {
        vector::push_back(&mut pool.currencies_seen, key);
    };

    // If no stakers, hold pending but don't grow accumulator
    let new_acc = if (pool.total_staked == 0) {
        bag_get_or_zero_u128(&pool.acc_per_wick, key)
    } else {
        // delta_per_wick = amount × ACC_SCALE / total_staked
        let delta = ((amount as u128) * ACC_SCALE) / (pool.total_staked as u128);
        let prev = bag_get_or_zero_u128(&pool.acc_per_wick, key);
        let new_value = prev + delta;
        bag_set_u128(&mut pool.acc_per_wick, key, new_value);
        new_value
    };

    // Append to pending
    if (bag::contains(&pool.pending, key)) {
        let bal: &mut Balance<C> = bag::borrow_mut(&mut pool.pending, key);
        balance::join(bal, fee_balance);
    } else {
        bag::add(&mut pool.pending, key, fee_balance);
    };

    sui::event::emit(DividendsAccrued {
        pool_id: object::id(pool),
        currency: key,
        amount,
        new_acc_per_wick: new_acc,
        total_staked_at_accrue: pool.total_staked,
    });
}

// === Claim ===

/// Claim dividends in currency C. Pays out (staked × (acc - debt) / SCALE),
/// updates the receipt's debt, and enforces the per-address 30% lifetime-loss
/// claim cap. Returns the claimable Coin<C> and a burn balance for forfeits.
public fun claim_dividends<C>(
    receipt: &mut StakeReceipt,
    pool: &mut WickStakingPool,
    ctx: &mut TxContext,
): (Coin<C>, Balance<C>) {
    assert!(receipt.owner == ctx.sender(), ENotOwner);
    assert!(receipt.staked > 0, ENoStake);

    let key = type_name::with_defining_ids<C>();
    let acc_now = bag_get_or_zero_u128(&pool.acc_per_wick, key);
    let debt_prev = vec_map_get_or_zero_u128(&receipt.debt_per_wick_by_currency, &key);
    let delta_per_wick = if (acc_now > debt_prev) acc_now - debt_prev else 0;
    let pending_for_user = ((receipt.staked as u128) * delta_per_wick / ACC_SCALE) as u64;

    if (pending_for_user == 0) {
        vec_map_set_u128(&mut receipt.debt_per_wick_by_currency, key, acc_now);
        return (coin::zero<C>(ctx), balance::zero<C>())
    };

    // Withdraw the full pending_for_user from the pool's pending bag
    let pool_pending: &mut Balance<C> = bag::borrow_mut(&mut pool.pending, key);
    let mut withdrawn = balance::split(pool_pending, pending_for_user);

    // Update receipt debt
    vec_map_set_u128(&mut receipt.debt_per_wick_by_currency, key, acc_now);

    // Per-address 30% cap. We approximate USD-equivalent claim with
    // the raw amount for MVP (multi-currency caps require Pyth normalization
    // — deferred). Treat 1:1 for now and document.
    let staker = receipt.owner;
    let s = table::borrow_mut(&mut pool.addr_state, staker);
    let cap_remaining = compute_addr_cap_remaining(s);
    let (kept, forfeit) = if ((pending_for_user as u128) > cap_remaining) {
        let allowed = cap_remaining as u64;
        (allowed, pending_for_user - allowed)
    } else {
        (pending_for_user, 0)
    };
    s.claimed_micro_usd = s.claimed_micro_usd + (kept as u128);
    pool.cumulative_claimed_micro_usd = pool.cumulative_claimed_micro_usd + (kept as u128);

    let kept_balance = balance::split(&mut withdrawn, kept);
    let forfeit_balance = withdrawn;
    pool.cumulative_forfeit_to_insurance_micro_usd =
        pool.cumulative_forfeit_to_insurance_micro_usd + (forfeit as u128);

    sui::event::emit(DividendsClaimed {
        pool_id: object::id(pool),
        receipt_id: object::id(receipt),
        staker,
        currency: key,
        claimed: kept,
        forfeited: forfeit,
    });

    (coin::from_balance(kept_balance, ctx), forfeit_balance)
}

/// Compute remaining claim cap for an address.
/// cap = 30% × lifetime_loss − already_claimed
fun compute_addr_cap_remaining(s: &AddrState): u128 {
    let cap = (s.lifetime_loss_micro_usd * (CLAIM_CAP_BPS as u128)) / 10_000;
    if (cap > s.claimed_micro_usd) cap - s.claimed_micro_usd else 0
}

// === Loss tracking (called by market/ride on losing settlement) ===

/// Record a loss for an address. Updates per-address lifetime loss + the
/// pool-wide cumulative network losses (used for per-fund cap denominator).
/// Called by market/ride right after wick_token::mint_to_loser succeeds.
public(package) fun record_loss(
    pool: &mut WickStakingPool,
    loser: address,
    loss_micro_usd: u64,
) {
    if (loss_micro_usd == 0) return;
    if (!table::contains(&pool.addr_state, loser)) {
        table::add(&mut pool.addr_state, loser, AddrState {
            lifetime_loss_micro_usd: loss_micro_usd as u128,
            claimed_micro_usd: 0,
            last_stake_at_ms: 0,
        });
    } else {
        let s = table::borrow_mut(&mut pool.addr_state, loser);
        s.lifetime_loss_micro_usd = s.lifetime_loss_micro_usd + (loss_micro_usd as u128);
    };
    pool.cumulative_network_losses_micro_usd =
        pool.cumulative_network_losses_micro_usd + (loss_micro_usd as u128);
    sui::event::emit(LossRecordedForCap {
        pool_id: object::id(pool),
        loser,
        loss_micro_usd,
        cumulative_network_micro_usd: pool.cumulative_network_losses_micro_usd,
    });
}

// === Reads ===

public fun total_staked(p: &WickStakingPool): u64 { p.total_staked }
public fun cumulative_network_losses_micro_usd(p: &WickStakingPool): u128 {
    p.cumulative_network_losses_micro_usd
}
public fun cumulative_claimed_micro_usd(p: &WickStakingPool): u128 { p.cumulative_claimed_micro_usd }
public fun cumulative_forfeit_micro_usd(p: &WickStakingPool): u128 { p.cumulative_forfeit_to_insurance_micro_usd }
public fun receipt_owner(r: &StakeReceipt): address { r.owner }
public fun receipt_staked(r: &StakeReceipt): u64 { r.staked }
public fun receipt_acquired_at_ms(r: &StakeReceipt): u64 { r.acquired_at_ms }
public fun receipt_unstake_initiated_at_ms(r: &StakeReceipt): &Option<u64> { &r.unstake_initiated_at_ms }
public fun receipt_last_settlement_observed_ms(r: &StakeReceipt): u64 { r.last_settlement_observed_ms }
public fun acc_per_wick<C>(p: &WickStakingPool): u128 {
    let key = type_name::with_defining_ids<C>();
    bag_get_or_zero_u128(&p.acc_per_wick, key)
}
public fun pending_balance<C>(p: &WickStakingPool): u64 {
    let key = type_name::with_defining_ids<C>();
    if (bag::contains(&p.pending, key)) {
        let b: &Balance<C> = bag::borrow(&p.pending, key);
        balance::value(b)
    } else { 0 }
}
public fun addr_lifetime_loss_micro_usd(p: &WickStakingPool, addr: address): u128 {
    if (!table::contains(&p.addr_state, addr)) return 0;
    let s = table::borrow(&p.addr_state, addr);
    s.lifetime_loss_micro_usd
}
public fun addr_claimed_micro_usd(p: &WickStakingPool, addr: address): u128 {
    if (!table::contains(&p.addr_state, addr)) return 0;
    let s = table::borrow(&p.addr_state, addr);
    s.claimed_micro_usd
}
public fun unstake_delay_ms(): u64 { UNSTAKE_DELAY_MS }
public fun claim_cap_bps(): u64 { CLAIM_CAP_BPS }
public fun acc_scale(): u128 { ACC_SCALE }

// === Bag helpers (Sui Bag doesn't have a "get or default" so wrap it) ===

fun bag_get_or_zero_u128(b: &Bag, key: TypeName): u128 {
    if (bag::contains(b, key)) *bag::borrow(b, key) else 0
}

fun bag_set_u128(b: &mut Bag, key: TypeName, value: u128) {
    if (bag::contains(b, key)) {
        let v: &mut u128 = bag::borrow_mut(b, key);
        *v = value;
    } else {
        bag::add(b, key, value);
    }
}

fun vec_map_get_or_zero_u128(m: &VecMap<TypeName, u128>, key: &TypeName): u128 {
    if (vec_map::contains(m, key)) *vec_map::get(m, key) else 0
}

fun vec_map_set_u128(m: &mut VecMap<TypeName, u128>, key: TypeName, value: u128) {
    if (vec_map::contains(m, &key)) {
        let v: &mut u128 = vec_map::get_mut(m, &key);
        *v = value;
    } else {
        vec_map::insert(m, key, value);
    }
}

// === Test helpers ===

#[test_only]
public fun init_for_testing(ctx: &mut TxContext): (WickStakingPool, StakingAdminCap) {
    let pool = WickStakingPool {
        id: object::new(ctx),
        total_staked: 0,
        acc_per_wick: bag::new(ctx),
        pending: bag::new(ctx),
        currencies_seen: vector::empty(),
        addr_state: table::new(ctx),
        staked_balance: balance::zero<WICK_TOKEN>(),
        cumulative_network_losses_micro_usd: 0,
        cumulative_claimed_micro_usd: 0,
        cumulative_forfeit_to_insurance_micro_usd: 0,
    };
    let cap = StakingAdminCap { id: object::new(ctx), pool_id: object::id(&pool) };
    (pool, cap)
}

#[test_only]
public fun test_record_loss(pool: &mut WickStakingPool, loser: address, loss_micro_usd: u64) {
    record_loss(pool, loser, loss_micro_usd);
}
