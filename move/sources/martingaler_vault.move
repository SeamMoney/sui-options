// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// The Martingaler vault — single mega-pool per collateral type that backs
/// every market. Bootstraps from $0 via cumulative trader losses; FIFO debt
/// queue when free funds run dry. Per-market settlement locks isolate
/// market-A's reserved payouts from market-B's drains.
///
/// Per docs/design/v2/01_martingaler_accounting_v2.md (state machine,
/// 19 invariants) + docs/design/v2/00_reconciliation.md §1-3, §13.
///
/// Routing rules:
///   - Free incoming stake → treasury (or to side_bucket if queue_total > 0,
///     auto-harvested into queue heads on the same tx)
///   - lock_and_settle reserves obligation from treasury into per-market
///     settlement_locks
///   - Winner redemptions pull from settlement_lock first; shortfall enqueues
///     a FIFO entry that is paid by future losses
///   - Aborted markets refund 1:1 via abort_refund_pool, ranked behind queue
///   - Auto-harvest drains side_bucket into queue heads on every inbound flow,
///     so the queue makes monotonic progress
module wick::martingaler_vault;

use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::table::{Self, Table};
use sui::vec_set::{Self, VecSet};

// === Error codes ===
const EAlreadyLocked: u64 = 0;
const ENotLocked: u64 = 1;
const EZeroAmount: u64 = 2;
const EQueueEmpty: u64 = 3;
const ENoAbortPool: u64 = 4;
const EAlreadyAborted: u64 = 5;
const EWrongClaimant: u64 = 6;
const EClaimantHasNoEntry: u64 = 7;
const EInsufficientLockToRelease: u64 = 8;
const ENotAdmin: u64 = 9;

// === Limits ===
/// Max queue entries to drain per inbound flow's auto-harvest.
const AUTO_HARVEST_MAX_PER_FLOW: u64 = 8;

// === Core state ===

public struct MartingalerVault<phantom C> has key {
    id: UID,
    /// Free funds available for new positions.
    treasury: Balance<C>,
    /// Funds parked for queue payouts. Drained into queue heads by
    /// auto_harvest_internal on every inbound flow when queue_total > 0.
    side_bucket: Balance<C>,
    /// Per-market reserved for settled-but-not-redeemed positions.
    /// Per reconciliation §1: kills cross-market siphoning attack.
    settlement_locks: Table<ID, Balance<C>>,
    /// Tracks which markets have been aborted (to enforce 1:1 refund pool).
    aborted_markets: VecSet<ID>,
    /// Per-market 1:1 refund pool for aborted markets. Ranked BEHIND queue
    /// per reconciliation §3.
    abort_refund_pool: Table<ID, Balance<C>>,
    /// FIFO debt queue. queue_head_idx <= queue_tail_idx. Empty when equal.
    fifo_queue: Table<u64, QueueEntry>,
    queue_head_idx: u64,
    queue_tail_idx: u64,
    /// Sum of all amount_owed across active queue entries.
    queue_total: u64,
    /// Per-bucket fee accumulators (drained by fee_router::crank).
    protocol_fees: Balance<C>,
    staker_fees: Balance<C>,
    insurance_fees: Balance<C>,
    /// Cumulative telemetry for invariant testing.
    cumulative_in: u128,
    cumulative_out: u128,
}

public struct QueueEntry has copy, drop, store {
    claimant: address,
    market_id: ID,
    amount_owed: u64,
    enqueued_at_ms: u64,
}

public struct VaultAdminCap has key, store {
    id: UID,
    vault_id: ID,
}

// === Events ===

public struct VaultInitialized has copy, drop {
    vault_id: ID,
}

public struct StakeDeposited has copy, drop {
    vault_id: ID,
    amount: u64,
    new_treasury: u64,
    new_side_bucket: u64,
}

public struct SettlementLockReserved has copy, drop {
    vault_id: ID,
    market_id: ID,
    obligation: u64,
}

public struct WinnerPaid has copy, drop {
    vault_id: ID,
    market_id: ID,
    winner: address,
    cash_paid: u64,
    queued_amount: u64,
}

public struct QueueEntryAdded has copy, drop {
    vault_id: ID,
    queue_index: u64,
    claimant: address,
    market_id: ID,
    amount_owed: u64,
}

public struct QueueHeadCranked has copy, drop {
    vault_id: ID,
    queue_index: u64,
    claimant: address,
    paid: u64,
    remaining: u64,
}

public struct AbortRefundPoolFunded has copy, drop {
    vault_id: ID,
    market_id: ID,
    funded: u64,
}

public struct AbortRefundClaimed has copy, drop {
    vault_id: ID,
    market_id: ID,
    claimant: address,
    amount: u64,
}

public struct SettlementLockReleased has copy, drop {
    vault_id: ID,
    market_id: ID,
    returned: u64,
}

public struct FeeAccrued has copy, drop {
    vault_id: ID,
    bucket: u8,  // 0=protocol, 1=staker, 2=insurance, 3=lp(treasury)
    amount: u64,
}

// === Init ===

public fun init_vault<C>(ctx: &mut TxContext): (VaultAdminCap, ID) {
    let vault = MartingalerVault<C> {
        id: object::new(ctx),
        treasury: balance::zero<C>(),
        side_bucket: balance::zero<C>(),
        settlement_locks: table::new(ctx),
        aborted_markets: vec_set::empty(),
        abort_refund_pool: table::new(ctx),
        fifo_queue: table::new(ctx),
        queue_head_idx: 0,
        queue_tail_idx: 0,
        queue_total: 0,
        protocol_fees: balance::zero<C>(),
        staker_fees: balance::zero<C>(),
        insurance_fees: balance::zero<C>(),
        cumulative_in: 0,
        cumulative_out: 0,
    };
    let vault_id = object::id(&vault);
    sui::event::emit(VaultInitialized { vault_id });
    transfer::share_object(vault);
    (VaultAdminCap { id: object::new(ctx), vault_id }, vault_id)
}

// === Reads ===

public fun treasury_value<C>(v: &MartingalerVault<C>): u64 { balance::value(&v.treasury) }
public fun side_bucket_value<C>(v: &MartingalerVault<C>): u64 { balance::value(&v.side_bucket) }
public fun queue_total<C>(v: &MartingalerVault<C>): u64 { v.queue_total }
public fun queue_length<C>(v: &MartingalerVault<C>): u64 { v.queue_tail_idx - v.queue_head_idx }
public fun queue_head_idx<C>(v: &MartingalerVault<C>): u64 { v.queue_head_idx }
public fun queue_tail_idx<C>(v: &MartingalerVault<C>): u64 { v.queue_tail_idx }
public fun protocol_fees_value<C>(v: &MartingalerVault<C>): u64 { balance::value(&v.protocol_fees) }
public fun staker_fees_value<C>(v: &MartingalerVault<C>): u64 { balance::value(&v.staker_fees) }
public fun insurance_fees_value<C>(v: &MartingalerVault<C>): u64 { balance::value(&v.insurance_fees) }
public fun cumulative_in<C>(v: &MartingalerVault<C>): u128 { v.cumulative_in }
public fun cumulative_out<C>(v: &MartingalerVault<C>): u128 { v.cumulative_out }
public fun is_market_aborted<C>(v: &MartingalerVault<C>, m: ID): bool { vec_set::contains(&v.aborted_markets, &m) }

public fun lock_value<C>(v: &MartingalerVault<C>, m: ID): u64 {
    if (table::contains(&v.settlement_locks, m)) {
        balance::value(table::borrow(&v.settlement_locks, m))
    } else { 0 }
}

public fun abort_pool_value<C>(v: &MartingalerVault<C>, m: ID): u64 {
    if (table::contains(&v.abort_refund_pool, m)) {
        balance::value(table::borrow(&v.abort_refund_pool, m))
    } else { 0 }
}

/// Returns the QueueEntry at index. Aborts if no such entry.
public fun queue_entry_at<C>(v: &MartingalerVault<C>, idx: u64): QueueEntry {
    *table::borrow(&v.fifo_queue, idx)
}

public fun queue_entry_owed(e: &QueueEntry): u64 { e.amount_owed }
public fun queue_entry_claimant(e: &QueueEntry): address { e.claimant }
public fun queue_entry_market(e: &QueueEntry): ID { e.market_id }

// === Mutators (called by market / ride / fee_router via package-public) ===

/// Deposit incoming stake from a position open / ride escrow. Routes
/// auto-harvest into queue heads first if queue is non-empty.
public(package) fun deposit_open<C>(
    vault: &mut MartingalerVault<C>,
    coin: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let amount = coin.value();
    assert!(amount > 0, EZeroAmount);
    vault.cumulative_in = vault.cumulative_in + (amount as u128);
    let bal = coin.into_balance();
    if (vault.queue_total > 0) {
        balance::join(&mut vault.side_bucket, bal);
        auto_harvest_internal(vault, clock, AUTO_HARVEST_MAX_PER_FLOW, ctx);
    } else {
        balance::join(&mut vault.treasury, bal);
    };
    sui::event::emit(StakeDeposited {
        vault_id: object::id(vault),
        amount,
        new_treasury: balance::value(&vault.treasury),
        new_side_bucket: balance::value(&vault.side_bucket),
    });
}

/// Reserve up to `obligation` from treasury into a per-market lock.
/// Called by lock_and_settle Phase 5. Aborts if a lock already exists.
///
/// MARTINGALER MODEL: if treasury has less than the requested obligation,
/// lock is funded with whatever's available (could be 0). The shortfall
/// is absorbed by the FIFO queue at redemption time — winner gets the
/// cash that's there + a queue entry for the rest. This keeps the
/// settlement non-blocking when the vault is bootstrapping.
public(package) fun reserve_for_market<C>(
    vault: &mut MartingalerVault<C>,
    market_id: ID,
    obligation: u64,
) {
    assert!(!table::contains(&vault.settlement_locks, market_id), EAlreadyLocked);
    let treasury_avail = balance::value(&vault.treasury);
    let actually_reserved = if (obligation <= treasury_avail) obligation else treasury_avail;
    if (actually_reserved == 0) {
        table::add(&mut vault.settlement_locks, market_id, balance::zero<C>());
    } else {
        let split = balance::split(&mut vault.treasury, actually_reserved);
        table::add(&mut vault.settlement_locks, market_id, split);
    };
    sui::event::emit(SettlementLockReserved {
        vault_id: object::id(vault),
        market_id,
        obligation,
    });
}

/// Release any unspent settlement_lock back to treasury after the retention
/// window OR when all winners have redeemed. Idempotent: calling on an
/// already-released market is a no-op.
public(package) fun release_settlement_lock<C>(
    vault: &mut MartingalerVault<C>,
    market_id: ID,
) {
    if (!table::contains(&vault.settlement_locks, market_id)) return;
    let lock_bal: Balance<C> = table::remove(&mut vault.settlement_locks, market_id);
    let returned = balance::value(&lock_bal);
    balance::join(&mut vault.treasury, lock_bal);
    sui::event::emit(SettlementLockReleased {
        vault_id: object::id(vault),
        market_id,
        returned,
    });
}

/// Pay a winner from per-market settlement_lock. Shortfall enqueues a FIFO
/// entry. Per reconciliation §3: aborted markets use claim_aborted_refund
/// instead — this function should not be called for aborted markets.
public(package) fun pay_winner<C>(
    vault: &mut MartingalerVault<C>,
    market_id: ID,
    winner: address,
    payout_amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    assert!(table::contains(&vault.settlement_locks, market_id), ENotLocked);
    assert!(payout_amount > 0, EZeroAmount);

    let lock = table::borrow_mut(&mut vault.settlement_locks, market_id);
    let lock_balance = balance::value(lock);

    let (cash_amount, queued_amount) = if (lock_balance >= payout_amount) {
        (payout_amount, 0u64)
    } else {
        (lock_balance, payout_amount - lock_balance)
    };

    let cash_balance = if (cash_amount > 0) {
        balance::split(lock, cash_amount)
    } else {
        balance::zero<C>()
    };

    if (queued_amount > 0) {
        let idx = vault.queue_tail_idx;
        let entry = QueueEntry {
            claimant: winner,
            market_id,
            amount_owed: queued_amount,
            enqueued_at_ms: clock.timestamp_ms(),
        };
        table::add(&mut vault.fifo_queue, idx, entry);
        vault.queue_tail_idx = idx + 1;
        vault.queue_total = vault.queue_total + queued_amount;
        sui::event::emit(QueueEntryAdded {
            vault_id: object::id(vault),
            queue_index: idx,
            claimant: winner,
            market_id,
            amount_owed: queued_amount,
        });
    };

    vault.cumulative_out = vault.cumulative_out + (cash_amount as u128);
    sui::event::emit(WinnerPaid {
        vault_id: object::id(vault),
        market_id,
        winner,
        cash_paid: cash_amount,
        queued_amount,
    });
    coin::from_balance(cash_balance, ctx)
}

/// Crank the head of the queue: pay out as much of the head entry as
/// side_bucket can cover. Anyone can call; payment goes directly to the
/// queue entry's claimant via transfer.
/// Returns amount paid (0 if queue empty or side_bucket empty).
public fun crank_queue_head<C>(
    vault: &mut MartingalerVault<C>,
    ctx: &mut TxContext,
): u64 {
    if (vault.queue_head_idx >= vault.queue_tail_idx) return 0;
    let bucket_avail = balance::value(&vault.side_bucket);
    if (bucket_avail == 0) return 0;

    let head_idx = vault.queue_head_idx;
    let mut head_entry = table::remove(&mut vault.fifo_queue, head_idx);
    let pay = if (bucket_avail >= head_entry.amount_owed) {
        head_entry.amount_owed
    } else {
        bucket_avail
    };

    let pay_balance = balance::split(&mut vault.side_bucket, pay);
    let pay_coin = coin::from_balance(pay_balance, ctx);
    head_entry.amount_owed = head_entry.amount_owed - pay;
    vault.queue_total = vault.queue_total - pay;
    vault.cumulative_out = vault.cumulative_out + (pay as u128);

    let remaining = head_entry.amount_owed;
    let claimant = head_entry.claimant;
    let market_id = head_entry.market_id;

    if (remaining == 0) {
        // Head fully paid — advance head_idx
        vault.queue_head_idx = head_idx + 1;
    } else {
        // Partially paid — put back at same index
        table::add(&mut vault.fifo_queue, head_idx, head_entry);
    };

    transfer::public_transfer(pay_coin, claimant);
    sui::event::emit(QueueHeadCranked {
        vault_id: object::id(vault),
        queue_index: head_idx,
        claimant,
        paid: pay,
        remaining,
    });
    pay
}

/// Move a market's settlement_lock funds into the abort_refund_pool.
/// Called when lock_and_settle dispatches to SettledAborted.
/// Per reconciliation §3: refunds are 1:1 of stake, ranked behind queue.
public(package) fun route_lock_to_abort_refund<C>(
    vault: &mut MartingalerVault<C>,
    market_id: ID,
) {
    assert!(!vec_set::contains(&vault.aborted_markets, &market_id), EAlreadyAborted);
    assert!(table::contains(&vault.settlement_locks, market_id), ENotLocked);

    let lock_bal: Balance<C> = table::remove(&mut vault.settlement_locks, market_id);
    let funded = balance::value(&lock_bal);
    table::add(&mut vault.abort_refund_pool, market_id, lock_bal);
    vec_set::insert(&mut vault.aborted_markets, market_id);

    sui::event::emit(AbortRefundPoolFunded {
        vault_id: object::id(vault),
        market_id,
        funded,
    });
}

/// Claim from the abort_refund_pool. Caller (market::redeem_aborted)
/// passes the amount owed at 1:1 of stake. Aborts if the market is not
/// aborted or if pool is insufficient.
public(package) fun claim_aborted_refund<C>(
    vault: &mut MartingalerVault<C>,
    market_id: ID,
    claimant: address,
    amount: u64,
    ctx: &mut TxContext,
): Coin<C> {
    assert!(amount > 0, EZeroAmount);
    assert!(table::contains(&vault.abort_refund_pool, market_id), ENoAbortPool);
    let pool = table::borrow_mut(&mut vault.abort_refund_pool, market_id);
    let pool_bal = balance::value(pool);
    assert!(pool_bal >= amount, EInsufficientLockToRelease);
    let payout = balance::split(pool, amount);
    vault.cumulative_out = vault.cumulative_out + (amount as u128);
    sui::event::emit(AbortRefundClaimed {
        vault_id: object::id(vault),
        market_id,
        claimant,
        amount,
    });
    coin::from_balance(payout, ctx)
}

/// Admin: recover residue from an aborted market's refund pool back to
/// treasury. Per math agent M8 GAP fix:
///
/// At route-time, abort_refund_pool[m] is funded with the gross OBLIGATION
/// (max(touch_exp, no_touch_exp), in payout units). But holders claim 1:1
/// of STAKE (not payout). After all holders claim, residue = obligation −
/// Σ stakes = (multiplier − 1) × Σ stakes. For 1.8x multiplier with $1k
/// total stakes, that's $800 stranded per aborted market.
///
/// This function flushes the pool back to treasury. Anti-rug: routes to
/// treasury (not arbitrary recipient) and only after the market is in
/// aborted state. Admin-gated for hackathon safety; permissionless variant
/// with retention window is post-MVP.
///
/// Idempotent: if pool already drained or not present, no-op.
public(package) fun recover_aborted_seed<C>(
    cap: &VaultAdminCap,
    vault: &mut MartingalerVault<C>,
    market_id: ID,
) {
    assert!(cap.vault_id == object::id(vault), ENotAdmin);
    assert!(vec_set::contains(&vault.aborted_markets, &market_id), EAlreadyAborted);
    if (!table::contains(&vault.abort_refund_pool, market_id)) return;
    let residue: Balance<C> = table::remove(&mut vault.abort_refund_pool, market_id);
    let amount = balance::value(&residue);
    if (amount == 0) {
        balance::destroy_zero(residue);
        return
    };
    balance::join(&mut vault.treasury, residue);
    sui::event::emit(SettlementLockReleased {
        vault_id: object::id(vault),
        market_id,
        returned: amount,
    });
}

/// Public wrapper for tests + admin scripts. Same semantics as
/// `recover_aborted_seed` (admin-cap-gated).
public fun admin_recover_aborted_seed<C>(
    cap: &VaultAdminCap,
    vault: &mut MartingalerVault<C>,
    market_id: ID,
) {
    recover_aborted_seed(cap, vault, market_id)
}

/// Accrue a fee into a specific bucket. bucket: 0=protocol, 1=staker,
/// 2=insurance, 3=lp(treasury). Called by fee_router::accrue.
public(package) fun accrue_fee<C>(
    vault: &mut MartingalerVault<C>,
    bucket: u8,
    fee_balance: Balance<C>,
) {
    let amount = balance::value(&fee_balance);
    if (amount == 0) {
        balance::destroy_zero(fee_balance);
        return
    };
    if (bucket == 0) balance::join(&mut vault.protocol_fees, fee_balance)
    else if (bucket == 1) balance::join(&mut vault.staker_fees, fee_balance)
    else if (bucket == 2) balance::join(&mut vault.insurance_fees, fee_balance)
    else if (bucket == 3) balance::join(&mut vault.treasury, fee_balance)
    else abort 99;
    sui::event::emit(FeeAccrued { vault_id: object::id(vault), bucket, amount });
}

/// Withdraw protocol fees (admin gated, drained by fee_router::crank).
public(package) fun withdraw_protocol_fees<C>(
    vault: &mut MartingalerVault<C>,
): Balance<C> {
    balance::withdraw_all(&mut vault.protocol_fees)
}
public(package) fun withdraw_staker_fees<C>(
    vault: &mut MartingalerVault<C>,
): Balance<C> {
    balance::withdraw_all(&mut vault.staker_fees)
}
public(package) fun withdraw_insurance_fees<C>(
    vault: &mut MartingalerVault<C>,
): Balance<C> {
    balance::withdraw_all(&mut vault.insurance_fees)
}

// === Ride streaming hooks (per docs/design/v2/11_ride_streaming_primitive.md §9) ===

/// Deposit ride-open escrow into the vault.
///
/// Per spec §9: escrow for the streaming-ride primitive lives in
/// `treasury` — NOT `settlement_lock` (those are reserved for discrete
/// touch/no-touch markets) and NOT the abort-pool path or per-market
/// `side_bucket` accounting. This keeps voluntary cashouts and settled
/// forfeits flowing through a single, simple hook that does not perturb
/// the discrete-market settlement state.
///
/// Note this intentionally bypasses the queue auto-harvest that
/// `deposit_open` performs: ride escrow is short-lived working capital,
/// not new LP stake. Routing it through `side_bucket`/auto-harvest would
/// pay out ride escrow to queued discrete-market winners and then leave
/// the ride underfunded at close.
public(package) fun deposit_ride_escrow<C>(
    vault: &mut MartingalerVault<C>,
    escrow: Coin<C>,
) {
    let amount = escrow.value();
    assert!(amount > 0, EZeroAmount);
    vault.cumulative_in = vault.cumulative_in + (amount as u128);
    balance::join(&mut vault.treasury, escrow.into_balance());
    sui::event::emit(StakeDeposited {
        vault_id: object::id(vault),
        amount,
        new_treasury: balance::value(&vault.treasury),
        new_side_bucket: balance::value(&vault.side_bucket),
    });
}

/// Withdraw funds to settle a ride payout (touch win / cashout / forfeit).
///
/// Source priority (patterned on `pay_winner`'s lock-first/queue-rest
/// split, but sourced from `treasury` directly since ride escrow is not
/// kept in a per-market lock):
///   1. Pay from `treasury` up to what's available.
///   2. If `amount` exceeds treasury, enqueue a FIFO entry for the
///      shortfall so future loss inflows pay it down. The returned
///      Coin<C> contains only what treasury could cover — callers must
///      treat it as the actually-paid amount.
///
/// `cumulative_out` is bumped only by the cash actually paid (the queue
/// entry's eventual payment will bump `cumulative_out` again at
/// crank/auto-harvest time, matching `pay_winner` semantics).
public(package) fun withdraw_for_ride_settlement<C>(
    vault: &mut MartingalerVault<C>,
    amount: u64,
    ctx: &mut TxContext,
): Coin<C> {
    assert!(amount > 0, EZeroAmount);

    let treasury_avail = balance::value(&vault.treasury);
    let (cash_amount, queued_amount) = if (treasury_avail >= amount) {
        (amount, 0u64)
    } else {
        (treasury_avail, amount - treasury_avail)
    };

    let cash_balance = if (cash_amount > 0) {
        balance::split(&mut vault.treasury, cash_amount)
    } else {
        balance::zero<C>()
    };

    if (queued_amount > 0) {
        let claimant = ctx.sender();
        let idx = vault.queue_tail_idx;
        // Use the vault id as a sentinel market_id since ride
        // settlement is not bound to a discrete market lock. Crank
        // logic doesn't dispatch on market_id, only on FIFO order.
        let sentinel_market = object::id(vault);
        let entry = QueueEntry {
            claimant,
            market_id: sentinel_market,
            amount_owed: queued_amount,
            enqueued_at_ms: 0,
        };
        table::add(&mut vault.fifo_queue, idx, entry);
        vault.queue_tail_idx = idx + 1;
        vault.queue_total = vault.queue_total + queued_amount;
        sui::event::emit(QueueEntryAdded {
            vault_id: object::id(vault),
            queue_index: idx,
            claimant,
            market_id: sentinel_market,
            amount_owed: queued_amount,
        });
    };

    vault.cumulative_out = vault.cumulative_out + (cash_amount as u128);
    coin::from_balance(cash_balance, ctx)
}

// === Auto-harvest internal ===

/// Drain side_bucket into queue heads, up to max_entries entries.
/// Called from deposit_open to ensure queue makes monotonic progress on
/// every inbound flow when queue_total > 0.
fun auto_harvest_internal<C>(
    vault: &mut MartingalerVault<C>,
    clock: &Clock,
    max_entries: u64,
    ctx: &mut TxContext,
) {
    let mut drained = 0u64;
    while (drained < max_entries) {
        if (vault.queue_head_idx >= vault.queue_tail_idx) break;
        if (balance::value(&vault.side_bucket) == 0) break;

        let head_idx = vault.queue_head_idx;
        let mut head_entry = table::remove(&mut vault.fifo_queue, head_idx);
        let bucket_avail = balance::value(&vault.side_bucket);
        let pay = if (bucket_avail >= head_entry.amount_owed) {
            head_entry.amount_owed
        } else {
            bucket_avail
        };

        let pay_balance = balance::split(&mut vault.side_bucket, pay);
        let pay_coin = coin::from_balance(pay_balance, ctx);
        head_entry.amount_owed = head_entry.amount_owed - pay;
        vault.queue_total = vault.queue_total - pay;
        vault.cumulative_out = vault.cumulative_out + (pay as u128);

        let remaining = head_entry.amount_owed;
        let claimant = head_entry.claimant;

        if (remaining == 0) {
            vault.queue_head_idx = head_idx + 1;
        } else {
            table::add(&mut vault.fifo_queue, head_idx, head_entry);
            // Queue head can't be advanced further — break out
            transfer::public_transfer(pay_coin, claimant);
            sui::event::emit(QueueHeadCranked {
                vault_id: object::id(vault),
                queue_index: head_idx,
                claimant,
                paid: pay,
                remaining,
            });
            return  // bucket exhausted on partial pay
        };

        transfer::public_transfer(pay_coin, claimant);
        sui::event::emit(QueueHeadCranked {
            vault_id: object::id(vault),
            queue_index: head_idx,
            claimant,
            paid: pay,
            remaining: 0,
        });
        let _ = clock;
        drained = drained + 1;
    };
}

// === Test-only helpers ===

#[test_only]
public fun init_for_testing<C>(ctx: &mut TxContext): (MartingalerVault<C>, VaultAdminCap) {
    let vault = MartingalerVault<C> {
        id: object::new(ctx),
        treasury: balance::zero<C>(),
        side_bucket: balance::zero<C>(),
        settlement_locks: table::new(ctx),
        aborted_markets: vec_set::empty(),
        abort_refund_pool: table::new(ctx),
        fifo_queue: table::new(ctx),
        queue_head_idx: 0,
        queue_tail_idx: 0,
        queue_total: 0,
        protocol_fees: balance::zero<C>(),
        staker_fees: balance::zero<C>(),
        insurance_fees: balance::zero<C>(),
        cumulative_in: 0,
        cumulative_out: 0,
    };
    let vault_id = object::id(&vault);
    let cap = VaultAdminCap { id: object::new(ctx), vault_id };
    (vault, cap)
}

#[test_only]
public fun test_deposit_open<C>(
    vault: &mut MartingalerVault<C>,
    coin: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    deposit_open(vault, coin, clock, ctx);
}

#[test_only]
public fun test_reserve_for_market<C>(
    vault: &mut MartingalerVault<C>,
    market_id: ID,
    obligation: u64,
) {
    reserve_for_market(vault, market_id, obligation);
}

#[test_only]
public fun test_pay_winner<C>(
    vault: &mut MartingalerVault<C>,
    market_id: ID,
    winner: address,
    payout_amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    pay_winner(vault, market_id, winner, payout_amount, clock, ctx)
}

#[test_only]
public fun test_release_settlement_lock<C>(
    vault: &mut MartingalerVault<C>,
    market_id: ID,
) {
    release_settlement_lock(vault, market_id);
}

#[test_only]
public fun test_route_lock_to_abort_refund<C>(
    vault: &mut MartingalerVault<C>,
    market_id: ID,
) {
    route_lock_to_abort_refund(vault, market_id);
}

#[test_only]
public fun test_claim_aborted_refund<C>(
    vault: &mut MartingalerVault<C>,
    market_id: ID,
    claimant: address,
    amount: u64,
    ctx: &mut TxContext,
): Coin<C> {
    claim_aborted_refund(vault, market_id, claimant, amount, ctx)
}

#[test_only]
public fun test_accrue_fee<C>(
    vault: &mut MartingalerVault<C>,
    bucket: u8,
    fee_balance: Balance<C>,
) {
    accrue_fee(vault, bucket, fee_balance);
}

#[test_only]
public fun test_deposit_ride_escrow<C>(
    vault: &mut MartingalerVault<C>,
    escrow: Coin<C>,
) {
    deposit_ride_escrow(vault, escrow);
}

#[test_only]
public fun test_withdraw_for_ride_settlement<C>(
    vault: &mut MartingalerVault<C>,
    amount: u64,
    ctx: &mut TxContext,
): Coin<C> {
    withdraw_for_ride_settlement(vault, amount, ctx)
}

/// Test-only: force-mark a market as aborted in the vault's internal set.
/// Bypasses the normal `route_lock_to_abort_refund` flow which requires a
/// settlement_lock to exist first. Useful for ride_position tests that
/// want to exercise the ABORTED_REFUND branch without setting up a full
/// discrete market.
#[test_only]
public fun test_mark_market_aborted<C>(
    vault: &mut MartingalerVault<C>,
    market_id: ID,
) {
    if (!vec_set::contains(&vault.aborted_markets, &market_id)) {
        vec_set::insert(&mut vault.aborted_markets, market_id);
    };
}
