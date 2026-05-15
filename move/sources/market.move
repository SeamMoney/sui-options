// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Wick-native market: touch / no-touch positions backed by a SHARED
/// MartingalerVault<C> singleton (one per collateral type, cross-market).
/// Settled against a `PathObservation` at expiry. Used for SUI / SP500 /
/// random-walk markets. The Predict-backed BTC route does not use this — it
/// composes with Predict's own market state via `wick::predict_route`.
///
/// === C.3.3: MartingalerVault wiring + atomic lock_and_settle ===
/// Replaces v1 `Vault<C>` (per-market, owned by Market struct) with the
/// shared MartingalerVault<C> (cross-market, externally-owned). All
/// entrypoints take the vault as a `&mut MartingalerVault<C>` parameter.
///
/// Vault accounting:
///   - open<C>(market, vault, side, stake, ...) → vault::deposit_open(stake)
///   - lock_and_settle<C>(market, vault, path, oracle, ...) →
///       Phase 4: vault::reserve_for_market(obligation)
///       If Aborted: vault::route_lock_to_abort_refund_pool
///   - redeem<C>(market, vault, position, ...) →
///       Hit/Expired winner: vault::pay_winner (handles queue overflow)
///       Aborted/Cancelled:  vault::claim_aborted_refund (1:1 stake)
///       Loser: zero coin (mint_to_loser + record_loss wiring is C.3.5)
///
/// Payout model: fixed `payout_multiplier_bps` per market. Bettor stakes
/// `stake`. If they win, vault pays `stake * payout_multiplier_bps / 10_000`.
/// Counterparty is the Martingaler treasury, bootstrapped from $0 by trader
/// losses (papertrade-derived).
module wick::market;

use std::string::String;
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use wick::impact_fee::{Self as fee, FeeSnapshot};
use wick::martingaler_vault::{Self as mv, MartingalerVault};
use wick::path_observation::{Self, PathObservation};
use wick::wick_oracle::{Self, WickOracle};

const EWrongPath: u64 = 1;
const EBadMultiplier: u64 = 2;
const EZeroStake: u64 = 3;
const EAfterExpiry: u64 = 4;
const EWrongMarket: u64 = 10;
const ENotReadyToSettle: u64 = 11;
const ENotActive: u64 = 12;
const EStillActive: u64 = 13;
const EBadStatus: u64 = 14;

const SIDE_TOUCH: u8 = 0;
const SIDE_NO_TOUCH: u8 = 1;

// === Market.status enum (u8 constants per reconciliation §1) ===
const STATUS_ACTIVE: u8 = 0;
const STATUS_HIT: u8 = 1;
const STATUS_EXPIRED: u8 = 2;
const STATUS_ABORTED: u8 = 3;
const STATUS_CANCELLED: u8 = 4;

public fun side_touch(): u8 { SIDE_TOUCH }
public fun side_no_touch(): u8 { SIDE_NO_TOUCH }
public fun status_active(): u8 { STATUS_ACTIVE }
public fun status_hit(): u8 { STATUS_HIT }
public fun status_expired(): u8 { STATUS_EXPIRED }
public fun status_aborted(): u8 { STATUS_ABORTED }
public fun status_cancelled(): u8 { STATUS_CANCELLED }

/// Touch / no-touch market for a single underlying with a single barrier.
/// Phantom-typed by collateral C — the actual coins live in the
/// MartingalerVault<C>, not here.
public struct Market<phantom C> has key {
    id: UID,
    name: String,
    /// Copied from oracle.underlying() at create. Used by GlobalExposureRegistry
    /// for cross-underlying caps when assert_open_allowed wires in (C.3.4).
    underlying: String,
    oracle_id: ID,
    path_id: ID,
    /// ID of the MartingalerVault<C> backing this market. Pinned at create
    /// to prevent rug-pull where someone hands a different vault later.
    vault_id: ID,
    expiry_ms: u64,
    /// Fixed payout multiplier in basis points: a winning $1 stake returns
    /// `1 * payout_multiplier_bps / 10_000`. e.g. 18_000 = 1.8x.
    payout_multiplier_bps: u64,
    /// Risk-bucket id for cross-underlying correlation caps (C.3.4 wiring).
    /// 0 = "uncategorized" (default for hackathon). Admin sets at create.
    correlation_bucket_id: u8,
    /// Sum of `stake * multiplier / 10_000` (gross payout obligation) for
    /// touch positions currently open.
    touch_exposure: u64,
    /// Same for no-touch positions.
    no_touch_exposure: u64,
    /// Sum of trader stakes currently open on the touch side. Tracks raw
    /// stake (not leveraged payout) — used for Aborted refund accounting.
    touch_stakes: u64,
    /// Same for no-touch side.
    no_touch_stakes: u64,
    /// Lifecycle: Active / Hit / Expired / Aborted / Cancelled. The canonical
    /// gate for open (Active only) and redeem (any settled state).
    status: u8,
    /// FeeSnapshot captured at lock_and_settle time. Frozen — every redeem
    /// reads from this, never live path state. Defends against post-lock
    /// racing (redteam attacks #3, #7, #13).
    fee_snapshot: Option<FeeSnapshot>,
    /// Wall-clock when the status transitioned out of Active. Telemetry +
    /// retention windows.
    settled_at_ms: Option<u64>,
}

public struct Position has key, store {
    id: UID,
    market_id: ID,
    side: u8,
    stake: u64,
    payout_if_win: u64,
    /// Snapshot of bot-eligibility at OPEN time (per adversarial #7). Reading
    /// at redeem-time would let a freshly-flagged bot's outstanding positions
    /// still mint WICK on close. C.3.5 will populate this from BotRegistry.
    is_bot_eligible: bool,
    /// Wall-clock when opened — used for analytics + expiry logic.
    opened_at_ms: u64,
}

public struct MarketCreated has copy, drop {
    market_id: ID,
    oracle_id: ID,
    path_id: ID,
    vault_id: ID,
    expiry_ms: u64,
    payout_multiplier_bps: u64,
    underlying: String,
    correlation_bucket_id: u8,
}

public struct PositionOpened has copy, drop {
    market_id: ID,
    position_id: ID,
    side: u8,
    stake: u64,
    payout_if_win: u64,
    owner: address,
}

public struct PositionRedeemed has copy, drop {
    market_id: ID,
    position_id: ID,
    side: u8,
    payout: u64,
    won: bool,
    owner: address,
}

public struct MarketSettled has copy, drop {
    market_id: ID,
    new_status: u8,
    settled_at_ms: u64,
    touch_exposure_at_lock: u64,
    no_touch_exposure_at_lock: u64,
    obligation_reserved: u64,
}

// === Lifecycle ===

/// Backwards-compat create — uses correlation_bucket_id=0.
public fun create<C>(
    name: String,
    oracle: &WickOracle,
    path: &PathObservation,
    vault: &MartingalerVault<C>,
    payout_multiplier_bps: u64,
    ctx: &mut TxContext,
): Market<C> {
    create_v2<C>(name, oracle, path, vault, payout_multiplier_bps, 0, ctx)
}

/// v2 create — caller specifies correlation_bucket_id for risk-bucket caps.
/// NOTE: vault is a SHARED MartingalerVault<C> — provisioned once per
/// collateral type at protocol bootstrap. Markets bind to it by ID.
public fun create_v2<C>(
    name: String,
    oracle: &WickOracle,
    path: &PathObservation,
    vault: &MartingalerVault<C>,
    payout_multiplier_bps: u64,
    correlation_bucket_id: u8,
    ctx: &mut TxContext,
): Market<C> {
    assert!(payout_multiplier_bps > 10_000, EBadMultiplier);
    assert!(payout_multiplier_bps < 100_000, EBadMultiplier);
    assert!(path_observation::oracle_id(path) == object::id(oracle), EWrongPath);

    let underlying = *wick_oracle::underlying(oracle);

    let market = Market<C> {
        id: object::new(ctx),
        name,
        underlying,
        oracle_id: object::id(oracle),
        path_id: object::id(path),
        vault_id: object::id(vault),
        expiry_ms: wick_oracle::expiry_ms(oracle),
        payout_multiplier_bps,
        correlation_bucket_id,
        touch_exposure: 0,
        no_touch_exposure: 0,
        touch_stakes: 0,
        no_touch_stakes: 0,
        status: STATUS_ACTIVE,
        fee_snapshot: option::none(),
        settled_at_ms: option::none(),
    };

    sui::event::emit(MarketCreated {
        market_id: object::id(&market),
        oracle_id: market.oracle_id,
        path_id: market.path_id,
        vault_id: market.vault_id,
        expiry_ms: market.expiry_ms,
        payout_multiplier_bps,
        underlying: market.underlying,
        correlation_bucket_id,
    });

    market
}

public fun share<C>(market: Market<C>) {
    transfer::share_object(market);
}

// === Trading ===

/// Open a touch or no-touch position. Stake flows into the shared
/// MartingalerVault.
/// STATUS-GATED: requires market.status == Active.
///
/// C.3.3 keeps simple solvency: relies on vault's queue model to absorb
/// asymmetric books. C.3.4 will wire `assert_open_allowed` for global PWE
/// + correlation bucket + per-side caps.
public fun open<C>(
    market: &mut Market<C>,
    vault: &mut MartingalerVault<C>,
    side: u8,
    stake: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): Position {
    assert!(market.status == STATUS_ACTIVE, ENotActive);
    assert!(market.vault_id == object::id(vault), EWrongMarket);
    let now = clock.timestamp_ms();
    assert!(now < market.expiry_ms, EAfterExpiry);
    assert!(side == SIDE_TOUCH || side == SIDE_NO_TOUCH, EBadMultiplier);

    let stake_amount = stake.value();
    assert!(stake_amount > 0, EZeroStake);

    let payout = mul_bps(stake_amount, market.payout_multiplier_bps);

    if (side == SIDE_TOUCH) {
        market.touch_exposure = market.touch_exposure + payout;
        market.touch_stakes = market.touch_stakes + stake_amount;
    } else {
        market.no_touch_exposure = market.no_touch_exposure + payout;
        market.no_touch_stakes = market.no_touch_stakes + stake_amount;
    };

    // Stake flows into the vault (auto-harvests queue heads if non-empty).
    mv::deposit_open(vault, stake, clock, ctx);

    let position = Position {
        id: object::new(ctx),
        market_id: object::id(market),
        side,
        stake: stake_amount,
        payout_if_win: payout,
        is_bot_eligible: true,  // C.3.5 wires bot_registry lookup here
        opened_at_ms: now,
    };

    sui::event::emit(PositionOpened {
        market_id: object::id(market),
        position_id: object::id(&position),
        side,
        stake: stake_amount,
        payout_if_win: payout,
        owner: tx_context::sender(ctx),
    });

    position
}

/// Atomic lock_and_settle. Folds the previous settle_market + lock_settlement
/// + status transition + obligation reservation into one entry. Idempotent.
///
/// Phases (per state-machine spec):
///   P0: idempotency gate (status == Active else early-return)
///   P1: lock path snapshot (gated on now >= expiry + drain_ms by path module)
///   P2: lock oracle settlement_price from latch (Resolved branches only)
///   P3: capture FeeSnapshot from path snapshot + market exposures
///   P4: transition status (Hit / Expired / Aborted)
///   P5: reserve obligation in vault (gross payout for winning side, both
///       stakes for Aborted refund pool)
///   P6: emit MarketSettled
///
/// PWE-clear (Phase 7) lives in C.3.4 once registry wiring lands.
public fun lock_and_settle<C>(
    market: &mut Market<C>,
    vault: &mut MartingalerVault<C>,
    path: &mut PathObservation,
    oracle: &mut WickOracle,
    clock: &Clock,
    _ctx: &mut TxContext,
) {
    // P0: idempotency
    if (market.status != STATUS_ACTIVE) return;
    assert!(market.path_id == object::id(path), EWrongPath);
    assert!(market.vault_id == object::id(vault), EWrongMarket);

    // P1: snapshot path (gated on now >= expiry + drain by path module)
    if (option::is_none(path_observation::settlement_snapshot(path))) {
        path_observation::lock_settlement_snapshot(path, clock);
    };
    let snap_opt = path_observation::settlement_snapshot(path);
    assert!(option::is_some(snap_opt), ENotReadyToSettle);
    let snap = option::borrow(snap_opt);
    let snap_state = path_observation::snapshot_state(snap);

    // P2: oracle settlement_price (only for Resolved branches)
    if (snap_state != path_observation::settlement_aborted()
        && !wick_oracle::is_settled(oracle)) {
        wick_oracle::lock_settlement_from_latest(oracle, clock);
    };

    // P3: FeeSnapshot
    let fs = fee::snapshot_at_lock(
        path_observation::barrier(path),
        path_observation::direction(path),
        path_observation::snapshot_max_seen(snap),
        path_observation::snapshot_min_seen(snap),
        market.touch_exposure,
        market.no_touch_exposure,
    );
    market.fee_snapshot = option::some(fs);

    // P4: transition status
    let new_status = if (snap_state == path_observation::settlement_aborted()) {
        STATUS_ABORTED
    } else if (path_observation::snapshot_is_touched(snap)) {
        STATUS_HIT
    } else {
        STATUS_EXPIRED
    };
    market.status = new_status;
    let now = clock.timestamp_ms();
    market.settled_at_ms = option::some(now);

    // P5: reserve vault liquidity for the winning branch
    let market_id = object::id(market);
    let obligation = if (new_status == STATUS_HIT) {
        market.touch_exposure
    } else if (new_status == STATUS_EXPIRED) {
        market.no_touch_exposure
    } else {
        // Aborted: refund both sides 1:1 of stake. Reserve sum of stakes.
        market.touch_stakes + market.no_touch_stakes
    };
    mv::reserve_for_market(vault, market_id, obligation);
    if (new_status == STATUS_ABORTED) {
        // Move the lock into the abort refund pool. After all holders claim,
        // pool drains to zero (sum of stakes = obligation). No residue.
        mv::route_lock_to_abort_refund(vault, market_id);
    };

    // P6: emit
    sui::event::emit(MarketSettled {
        market_id,
        new_status,
        settled_at_ms: now,
        touch_exposure_at_lock: market.touch_exposure,
        no_touch_exposure_at_lock: market.no_touch_exposure,
        obligation_reserved: obligation,
    });
}

/// Redeem a settled position. Burns the position; pays out from the vault.
/// STATUS-GATED: requires market.status != Active.
///
/// Switches on market.status (set by lock_and_settle):
///   - Hit:       touch holders win → vault::pay_winner; no_touch get 0 coin
///   - Expired:   no_touch holders win → vault::pay_winner; touch get 0
///   - Aborted:   refund 1:1 via vault::claim_aborted_refund (no winner)
///   - Cancelled: refund 1:1 (admin-initiated, same path as Aborted)
///
/// Impact-fee deduction lives in C.3.4 — for now winners get the full
/// payout_if_win. Loser WICK mint + record_loss live in C.3.5.
public fun redeem<C>(
    market: &mut Market<C>,
    vault: &mut MartingalerVault<C>,
    position: Position,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    assert!(position.market_id == object::id(market), EWrongMarket);
    assert!(market.vault_id == object::id(vault), EWrongMarket);
    assert!(market.status != STATUS_ACTIVE, EStillActive);

    let Position {
        id, market_id: _, side, stake, payout_if_win,
        is_bot_eligible: _, opened_at_ms: _,
    } = position;
    let pos_id = id.to_inner();
    object::delete(id);

    // Decrement exposure + stakes regardless of branch (position is closed).
    if (side == SIDE_TOUCH) {
        market.touch_exposure = if (market.touch_exposure >= payout_if_win)
            market.touch_exposure - payout_if_win else 0;
        market.touch_stakes = if (market.touch_stakes >= stake)
            market.touch_stakes - stake else 0;
    } else {
        market.no_touch_exposure = if (market.no_touch_exposure >= payout_if_win)
            market.no_touch_exposure - payout_if_win else 0;
        market.no_touch_stakes = if (market.no_touch_stakes >= stake)
            market.no_touch_stakes - stake else 0;
    };

    let owner = tx_context::sender(ctx);
    let market_id = object::id(market);

    // Aborted / Cancelled: 1:1 stake refund from abort_refund_pool.
    if (market.status == STATUS_ABORTED || market.status == STATUS_CANCELLED) {
        let refund = mv::claim_aborted_refund(vault, market_id, owner, stake, ctx);
        sui::event::emit(PositionRedeemed {
            market_id,
            position_id: pos_id,
            side,
            payout: stake,
            won: false,
            owner,
        });
        return refund
    };

    // Hit / Expired: leveraged payout to the winning side.
    let touched = market.status == STATUS_HIT;
    let won = (side == SIDE_TOUCH && touched)
              || (side == SIDE_NO_TOUCH && !touched);

    if (won) {
        let payout_coin = mv::pay_winner(vault, market_id, owner, payout_if_win, clock, ctx);
        sui::event::emit(PositionRedeemed {
            market_id,
            position_id: pos_id,
            side,
            payout: payout_if_win,
            won: true,
            owner,
        });
        payout_coin
    } else {
        sui::event::emit(PositionRedeemed {
            market_id,
            position_id: pos_id,
            side,
            payout: 0,
            won: false,
            owner,
        });
        coin::zero<C>(ctx)
    }
}

// === Reads ===

public fun name<C>(m: &Market<C>): &String { &m.name }
public fun underlying<C>(m: &Market<C>): &String { &m.underlying }
public fun oracle_id<C>(m: &Market<C>): ID { m.oracle_id }
public fun path_id<C>(m: &Market<C>): ID { m.path_id }
public fun vault_id<C>(m: &Market<C>): ID { m.vault_id }
public fun expiry_ms<C>(m: &Market<C>): u64 { m.expiry_ms }
public fun payout_multiplier_bps<C>(m: &Market<C>): u64 { m.payout_multiplier_bps }
public fun correlation_bucket_id<C>(m: &Market<C>): u8 { m.correlation_bucket_id }
public fun touch_exposure<C>(m: &Market<C>): u64 { m.touch_exposure }
public fun no_touch_exposure<C>(m: &Market<C>): u64 { m.no_touch_exposure }
public fun touch_stakes<C>(m: &Market<C>): u64 { m.touch_stakes }
public fun no_touch_stakes<C>(m: &Market<C>): u64 { m.no_touch_stakes }
public fun status<C>(m: &Market<C>): u8 { m.status }
public fun fee_snapshot<C>(m: &Market<C>): &Option<FeeSnapshot> { &m.fee_snapshot }
public fun settled_at_ms<C>(m: &Market<C>): &Option<u64> { &m.settled_at_ms }
public fun is_settled<C>(m: &Market<C>): bool { m.status != STATUS_ACTIVE }

public fun position_market_id(p: &Position): ID { p.market_id }
public fun position_side(p: &Position): u8 { p.side }
public fun position_stake(p: &Position): u64 { p.stake }
public fun position_payout_if_win(p: &Position): u64 { p.payout_if_win }
public fun position_is_bot_eligible(p: &Position): bool { p.is_bot_eligible }
public fun position_opened_at_ms(p: &Position): u64 { p.opened_at_ms }

// === Helpers ===

fun mul_bps(amount: u64, bps: u64): u64 {
    ((amount as u128) * (bps as u128) / 10_000u128) as u64
}

#[test_only]
/// Delete the market (no vault drain — vault is external now).
public fun destroy_for_testing<C>(market: Market<C>) {
    let Market {
        id, name: _, underlying: _, oracle_id: _, path_id: _, vault_id: _,
        expiry_ms: _, payout_multiplier_bps: _, correlation_bucket_id: _,
        touch_exposure: _, no_touch_exposure: _, touch_stakes: _, no_touch_stakes: _,
        status: _, fee_snapshot: _, settled_at_ms: _,
    } = market;
    object::delete(id);
}

#[test_only]
public fun set_status_for_testing<C>(market: &mut Market<C>, new_status: u8) {
    assert!(new_status <= STATUS_CANCELLED, EBadStatus);
    market.status = new_status;
}
