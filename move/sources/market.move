// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Wick-native market: touch / no-touch positions backed by a single-collateral
/// vault, settled against a `PathObservation` at expiry. Used for SUI / SP500 /
/// random-walk markets. The Predict-backed BTC route does not use this — it
/// composes with Predict's own market state via `wick::predict_route`.
///
/// === C.3.2 status field added ===
/// Market.status: u8 enum (Active=0/Hit=1/Expired=2/Aborted=3/Cancelled=4)
/// per docs/design/v2/00_reconciliation.md §1. Status is the canonical gate
/// for redeem/open. Set by lock_and_settle_v1 (this commit) or its successor
/// atomic lock_and_settle (C.3.3). Does NOT yet wire MartingalerVault — the
/// vault.move-backed v1 path is preserved so existing tests pass.
///
/// Payout model: fixed `payout_multiplier_bps` per market. Bettor stakes
/// `stake`. If they win, vault pays `stake * payout_multiplier_bps / 10_000`.
/// Counterparty is the vault, seeded by the protocol on create.
module wick::market;

use std::string::String;
use sui::clock::Clock;
use sui::coin::Coin;
use wick::impact_fee::{Self as fee, FeeSnapshot};
use wick::path_observation::{Self, PathObservation};
use wick::vault::{Self, Vault};
use wick::wick_oracle::{Self, WickOracle};

const EWrongPath: u64 = 1;
const EBadMultiplier: u64 = 2;
const EZeroStake: u64 = 3;
const EAfterExpiry: u64 = 4;
const ENotExpired: u64 = 5;
const EInsufficientPool: u64 = 6;
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
public struct Market<phantom C> has key {
    id: UID,
    name: String,
    /// Copied from oracle.underlying() at create. Used by GlobalExposureRegistry
    /// for cross-underlying caps when assert_open_allowed wires in (C.3.4).
    underlying: String,
    oracle_id: ID,
    path_id: ID,
    expiry_ms: u64,
    /// Fixed payout multiplier in basis points: a winning $1 stake returns
    /// `1 * payout_multiplier_bps / 10_000`. e.g. 18_000 = 1.8x.
    payout_multiplier_bps: u64,
    /// Risk-bucket id for cross-underlying correlation caps (C.3.4 wiring).
    /// 0 = "uncategorized" (default for hackathon). Admin sets at create.
    correlation_bucket_id: u8,
    vault: Vault<C>,
    /// Sum of open `stake * multiplier / 10_000` for touch positions.
    touch_exposure: u64,
    /// Same for no-touch positions.
    no_touch_exposure: u64,
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
}

public struct MarketCreated has copy, drop {
    market_id: ID,
    oracle_id: ID,
    path_id: ID,
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
}

// === Lifecycle ===

/// Backwards-compat create — uses correlation_bucket_id=0.
public fun create<C>(
    name: String,
    oracle: &WickOracle,
    path: &PathObservation,
    payout_multiplier_bps: u64,
    seed_collateral: Coin<C>,
    ctx: &mut TxContext,
): Market<C> {
    create_v2<C>(name, oracle, path, payout_multiplier_bps, 0, seed_collateral, ctx)
}

/// v2 create — caller specifies correlation_bucket_id for risk-bucket caps.
public fun create_v2<C>(
    name: String,
    oracle: &WickOracle,
    path: &PathObservation,
    payout_multiplier_bps: u64,
    correlation_bucket_id: u8,
    seed_collateral: Coin<C>,
    ctx: &mut TxContext,
): Market<C> {
    assert!(payout_multiplier_bps > 10_000, EBadMultiplier);
    assert!(payout_multiplier_bps < 100_000, EBadMultiplier);
    assert!(path_observation::oracle_id(path) == object::id(oracle), EWrongPath);

    let mut vault = vault::new<C>();
    vault::deposit(&mut vault, seed_collateral);

    let underlying = *wick_oracle::underlying(oracle);

    let market = Market<C> {
        id: object::new(ctx),
        name,
        underlying,
        oracle_id: object::id(oracle),
        path_id: object::id(path),
        expiry_ms: wick_oracle::expiry_ms(oracle),
        payout_multiplier_bps,
        correlation_bucket_id,
        vault,
        touch_exposure: 0,
        no_touch_exposure: 0,
        status: STATUS_ACTIVE,
        fee_snapshot: option::none(),
        settled_at_ms: option::none(),
    };

    sui::event::emit(MarketCreated {
        market_id: object::id(&market),
        oracle_id: market.oracle_id,
        path_id: market.path_id,
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

/// Open a touch or no-touch position. Stake flows into the vault.
/// STATUS-GATED: requires market.status == Active.
public fun open<C>(
    market: &mut Market<C>,
    side: u8,
    stake: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): Position {
    assert!(market.status == STATUS_ACTIVE, ENotActive);
    let now = clock.timestamp_ms();
    assert!(now < market.expiry_ms, EAfterExpiry);
    assert!(side == SIDE_TOUCH || side == SIDE_NO_TOUCH, EBadMultiplier);

    let stake_amount = stake.value();
    assert!(stake_amount > 0, EZeroStake);

    let payout = mul_bps(stake_amount, market.payout_multiplier_bps);

    if (side == SIDE_TOUCH) {
        market.touch_exposure = market.touch_exposure + payout;
    } else {
        market.no_touch_exposure = market.no_touch_exposure + payout;
    };

    vault::deposit(&mut market.vault, stake);

    // Solvency check: vault must cover worst-case payouts on the side that
    // will actually pay (only one side wins). Worst case is max of both.
    let worst_case = if (market.touch_exposure > market.no_touch_exposure)
        market.touch_exposure else market.no_touch_exposure;
    assert!(vault::balance(&market.vault) >= worst_case, EInsufficientPool);

    let position = Position {
        id: object::new(ctx),
        market_id: object::id(market),
        side,
        stake: stake_amount,
        payout_if_win: payout,
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

/// Redeem a settled position. Burns the position; pays out from the vault.
/// STATUS-GATED: requires market.status != Active.
///
/// Switches on market.status (set by lock_and_settle_v1):
///   - Hit:       touch holders win, no_touch get 0
///   - Expired:   no_touch holders win, touch get 0
///   - Aborted:   refund 1:1 to BOTH sides (no winner)
///   - Cancelled: refund 1:1 (admin-initiated, same path as Aborted)
public fun redeem<C>(
    market: &mut Market<C>,
    position: Position,
    path: &PathObservation,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    assert!(position.market_id == object::id(market), EWrongMarket);
    assert!(market.path_id == object::id(path), EWrongPath);
    assert!(market.status != STATUS_ACTIVE, EStillActive);

    let Position { id, market_id: _, side, stake, payout_if_win } = position;
    let pos_id = id.to_inner();
    object::delete(id);

    // Decrement exposure regardless of branch (position is closed).
    if (side == SIDE_TOUCH) {
        market.touch_exposure = if (market.touch_exposure >= payout_if_win)
            market.touch_exposure - payout_if_win else 0;
    } else {
        market.no_touch_exposure = if (market.no_touch_exposure >= payout_if_win)
            market.no_touch_exposure - payout_if_win else 0;
    };

    // Aborted / Cancelled: 1:1 refund.
    if (market.status == STATUS_ABORTED || market.status == STATUS_CANCELLED) {
        assert!(vault::balance(&market.vault) >= stake, EInsufficientPool);
        let refund = vault::withdraw(&mut market.vault, stake, ctx);
        sui::event::emit(PositionRedeemed {
            market_id: object::id(market),
            position_id: pos_id,
            side,
            payout: stake,
            won: false,
            owner: tx_context::sender(ctx),
        });
        return refund
    };

    // Hit / Expired: leveraged payout to the winning side.
    let touched = market.status == STATUS_HIT;
    let won = (side == SIDE_TOUCH && touched)
              || (side == SIDE_NO_TOUCH && !touched);

    let _ = clock;  // path snapshot is canonical now; clock retained for future
    let _ = path;

    if (won) {
        let payout_coin = vault::withdraw(&mut market.vault, payout_if_win, ctx);
        sui::event::emit(PositionRedeemed {
            market_id: object::id(market),
            position_id: pos_id,
            side,
            payout: payout_if_win,
            won: true,
            owner: tx_context::sender(ctx),
        });
        payout_coin
    } else {
        sui::event::emit(PositionRedeemed {
            market_id: object::id(market),
            position_id: pos_id,
            side,
            payout: 0,
            won: false,
            owner: tx_context::sender(ctx),
        });
        sui::coin::zero<C>(ctx)
    }
}

// === Settlement ===

/// v1 lock_and_settle (status orchestration only — does NOT yet wire
/// MartingalerVault or fee_router). Folds the v2 settle_market and
/// lock_settlement helpers into one entry. C.3.3 will replace this with
/// the atomic version per docs/design/v2/00_reconciliation.md §2.
///
/// Phases:
///   P0: idempotency gate (status == Active else early-return)
///   P1: lock path snapshot (asserts now >= expiry + drain inside lock fn)
///   P2: lock oracle settlement_price from settlement_observation latch
///   P3: capture FeeSnapshot from snapshot.{max_seen, min_seen} + exposures
///   P4: transition status (Hit / Expired / Aborted from snapshot.state)
///   P5: emit MarketSettled
///
/// Permissionless — anyone can call. Idempotent across multiple calls.
public fun lock_and_settle_v1<C>(
    market: &mut Market<C>,
    path: &mut PathObservation,
    oracle: &mut WickOracle,
    clock: &Clock,
    _ctx: &mut TxContext,
) {
    // P0: idempotency
    if (market.status != STATUS_ACTIVE) return;
    assert!(market.path_id == object::id(path), EWrongPath);

    // P1: snapshot path (gated on now >= expiry + drain by path module)
    if (option::is_none(path_observation::settlement_snapshot(path))) {
        path_observation::lock_settlement_snapshot(path, clock);
    };
    let snap_opt = path_observation::settlement_snapshot(path);
    assert!(option::is_some(snap_opt), ENotReadyToSettle);
    let snap = option::borrow(snap_opt);

    // P2: oracle settlement_price (only matters for Resolved branches; safe
    // to skip for Aborted but we attempt anyway — lock fn is idempotent and
    // aborts only on missing settlement_observation).
    if (path_observation::snapshot_state(snap) != path_observation::settlement_aborted()
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

    // P4: transition status from snapshot
    let snap_state = path_observation::snapshot_state(snap);
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

    // P5: emit
    sui::event::emit(MarketSettled {
        market_id: object::id(market),
        new_status,
        settled_at_ms: now,
        touch_exposure_at_lock: market.touch_exposure,
        no_touch_exposure_at_lock: market.no_touch_exposure,
    });
}

// === Backwards-compat wrappers (existing v2 tests) ===

/// DEPRECATED: use `lock_and_settle_v1` instead. Kept for v2 tests; just
/// locks the path snapshot without status transition.
public fun settle_market<C>(
    market: &Market<C>,
    path: &mut PathObservation,
    clock: &Clock,
) {
    assert!(market.path_id == object::id(path), EWrongPath);
    if (option::is_none(path_observation::settlement_snapshot(path))) {
        path_observation::lock_settlement_snapshot(path, clock);
    };
}

/// DEPRECATED: use `lock_and_settle_v1`. Locks oracle settlement_price.
public fun lock_settlement<C>(_market: &Market<C>, oracle: &mut WickOracle, clock: &Clock) {
    if (!wick_oracle::is_settled(oracle)) {
        wick_oracle::lock_settlement_from_latest(oracle, clock);
    };
}

// === Reads ===

public fun name<C>(m: &Market<C>): &String { &m.name }
public fun underlying<C>(m: &Market<C>): &String { &m.underlying }
public fun oracle_id<C>(m: &Market<C>): ID { m.oracle_id }
public fun path_id<C>(m: &Market<C>): ID { m.path_id }
public fun expiry_ms<C>(m: &Market<C>): u64 { m.expiry_ms }
public fun payout_multiplier_bps<C>(m: &Market<C>): u64 { m.payout_multiplier_bps }
public fun correlation_bucket_id<C>(m: &Market<C>): u8 { m.correlation_bucket_id }
public fun vault_balance<C>(m: &Market<C>): u64 { vault::balance(&m.vault) }
public fun touch_exposure<C>(m: &Market<C>): u64 { m.touch_exposure }
public fun no_touch_exposure<C>(m: &Market<C>): u64 { m.no_touch_exposure }
public fun status<C>(m: &Market<C>): u8 { m.status }
public fun fee_snapshot<C>(m: &Market<C>): &Option<FeeSnapshot> { &m.fee_snapshot }
public fun settled_at_ms<C>(m: &Market<C>): &Option<u64> { &m.settled_at_ms }
public fun is_settled<C>(m: &Market<C>): bool { m.status != STATUS_ACTIVE }

public fun position_market_id(p: &Position): ID { p.market_id }
public fun position_side(p: &Position): u8 { p.side }
public fun position_stake(p: &Position): u64 { p.stake }
public fun position_payout_if_win(p: &Position): u64 { p.payout_if_win }

// === Helpers ===

fun mul_bps(amount: u64, bps: u64): u64 {
    ((amount as u128) * (bps as u128) / 10_000u128) as u64
}

#[test_only]
/// Drain the vault to a coin (tests dispose) and delete the market in one shot.
public fun drain_and_destroy_for_testing<C>(
    market: Market<C>,
    ctx: &mut TxContext,
): sui::coin::Coin<C> {
    let Market {
        id, name: _, underlying: _, oracle_id: _, path_id: _, expiry_ms: _,
        payout_multiplier_bps: _, correlation_bucket_id: _,
        mut vault, touch_exposure: _, no_touch_exposure: _,
        status: _, fee_snapshot: _, settled_at_ms: _,
    } = market;
    let amt = vault::balance(&vault);
    let drained = if (amt > 0) {
        vault::withdraw(&mut vault, amt, ctx)
    } else {
        sui::coin::zero<C>(ctx)
    };
    vault::destroy_empty(vault);
    object::delete(id);
    drained
}

#[test_only]
public fun set_status_for_testing<C>(market: &mut Market<C>, new_status: u8) {
    assert!(new_status <= STATUS_CANCELLED, EBadStatus);
    market.status = new_status;
}
