// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Wick-native market: touch / no-touch positions backed by a single-collateral
/// vault, settled against a `PathObservation` at expiry. Used for SUI / SP500 /
/// random-walk markets. The Predict-backed BTC route does not use this — it
/// composes with Predict's own market state via `wick::predict_route`.
///
/// Payout model (TapL/tap-trading style): fixed `payout_multiplier_bps` per
/// market. Bettor stakes `stake`. If they win, vault pays
/// `stake * payout_multiplier_bps / 10_000`. Counterparty is the
/// `PayoutPool` — protocol-funded for arcade markets.
///
/// Conservation: vault must always cover the worst-case open exposure across
/// both sides. Enforced by `assert_solvent` after every state change.
module wick::market;

use std::string::String;
use sui::clock::Clock;
use sui::coin::Coin;
use wick::path_observation::{Self, PathObservation};
use wick::vault::{Self, Vault};
use wick::wick_oracle::{Self, WickOracle};

const EWrongOracle: u64 = 0;
const EWrongPath: u64 = 1;
const EBadMultiplier: u64 = 2;
const EZeroStake: u64 = 3;
const EAfterExpiry: u64 = 4;
const ENotExpired: u64 = 5;
const EInsufficientPool: u64 = 6;
const ENotWinner: u64 = 7;
const EAlreadyClaimed: u64 = 8;
const EOracleNotSettled: u64 = 9;
const EWrongMarket: u64 = 10;
const ENotReadyToSettle: u64 = 11;

const SIDE_TOUCH: u8 = 0;
const SIDE_NO_TOUCH: u8 = 1;

public fun side_touch(): u8 { SIDE_TOUCH }
public fun side_no_touch(): u8 { SIDE_NO_TOUCH }

/// Touch / no-touch market for a single underlying with a single barrier.
public struct Market<phantom C> has key {
    id: UID,
    name: String,
    oracle_id: ID,
    path_id: ID,
    expiry_ms: u64,
    /// Fixed payout multiplier in basis points: a winning $1 stake returns
    /// `1 * payout_multiplier_bps / 10_000`. e.g. 18_000 = 1.8x.
    payout_multiplier_bps: u64,
    vault: Vault<C>,
    /// Sum of open `stake * multiplier / 10_000` for touch positions.
    touch_exposure: u64,
    /// Same for no-touch positions.
    no_touch_exposure: u64,
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

// === Lifecycle ===

/// Create a Wick-native market. The oracle and path must already exist and
/// be paired. Caller seeds the vault with `seed_collateral` to provide
/// counterparty depth — for arcade markets this is protocol-funded.
public fun create<C>(
    name: String,
    oracle: &WickOracle,
    path: &PathObservation,
    payout_multiplier_bps: u64,
    seed_collateral: Coin<C>,
    ctx: &mut TxContext,
): Market<C> {
    assert!(payout_multiplier_bps > 10_000, EBadMultiplier); // must pay > 1x
    assert!(payout_multiplier_bps < 100_000, EBadMultiplier); // sanity cap 10x
    assert!(path_observation::oracle_id(path) == object::id(oracle), EWrongPath);

    let mut vault = vault::new<C>();
    vault::deposit(&mut vault, seed_collateral);

    let market = Market<C> {
        id: object::new(ctx),
        name,
        oracle_id: object::id(oracle),
        path_id: object::id(path),
        expiry_ms: wick_oracle::expiry_ms(oracle),
        payout_multiplier_bps,
        vault,
        touch_exposure: 0,
        no_touch_exposure: 0,
    };

    sui::event::emit(MarketCreated {
        market_id: object::id(&market),
        oracle_id: market.oracle_id,
        path_id: market.path_id,
        expiry_ms: market.expiry_ms,
        payout_multiplier_bps,
    });

    market
}

public fun share<C>(market: Market<C>) {
    transfer::share_object(market);
}

// === Trading ===

/// Open a touch or no-touch position. Stake flows into the vault.
public fun open<C>(
    market: &mut Market<C>,
    side: u8,
    stake: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): Position {
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
///
/// v2 hardened settlement (per docs/design/v2/05_path_observation_v2_hardened
/// §7): switches on `path_observation::settlement_state`:
///   - Resolved: existing touch-vs-no-touch payout, but reads from snapshot
///     (frozen at lock_settlement_snapshot time, not live state).
///   - Aborted: refund 1:1 to BOTH sides, no winner. This is the safety
///     property — a market that timed out without enough observations cannot
///     silently collapse to "no-touch wins."
///
/// The path's settlement_snapshot must be locked first via
/// `settle_market` (or any caller of `path_observation::lock_settlement_snapshot`).
public fun redeem<C>(
    market: &mut Market<C>,
    position: Position,
    path: &PathObservation,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    assert!(position.market_id == object::id(market), EWrongMarket);
    assert!(market.path_id == object::id(path), EWrongPath);

    let now = clock.timestamp_ms();
    assert!(now >= market.expiry_ms, ENotExpired);

    let state = path_observation::settlement_state(path, clock);
    assert!(state != path_observation::settlement_not_ready(), ENotReadyToSettle);

    let Position { id, market_id: _, side, stake, payout_if_win } = position;
    let pos_id = id.to_inner();
    object::delete(id);

    // Decrement exposure regardless of branch.
    if (side == SIDE_TOUCH) {
        if (market.touch_exposure >= payout_if_win) {
            market.touch_exposure = market.touch_exposure - payout_if_win;
        } else {
            market.touch_exposure = 0;
        };
    } else {
        if (market.no_touch_exposure >= payout_if_win) {
            market.no_touch_exposure = market.no_touch_exposure - payout_if_win;
        } else {
            market.no_touch_exposure = 0;
        };
    };

    if (state == path_observation::settlement_aborted()) {
        // Aborted: refund the original stake (1:1), not the leveraged payout.
        // Safety guard: vault MUST cover the refund. With v1 vault accounting
        // this is true by construction (every open deposited `stake`), but the
        // assert prevents future-vault-refactor footguns and guarantees
        // ordering doesn't strand a refunder.
        //
        // SEED RESIDUE: vault retains seed + Σ(payout_i - stake_i) after all
        // refunds, since exposure decrements by `payout` (>stake) but vault
        // gives back only `stake`. That residue is currently unrecoverable on
        // the v1 vault path. Phase C.3 wires martingaler_vault::route_lock_to_
        // abort_refund_pool which routes the difference cleanly. Documented
        // limitation for MVP.
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

    // Resolved branch — read touch outcome from snapshot if available.
    let touched = path_observation::touch_outcome(path, clock);
    let won = (side == SIDE_TOUCH && touched)
              || (side == SIDE_NO_TOUCH && !touched);

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

/// Permissionless one-shot. Locks the path's settlement_snapshot — required
/// before any `redeem` call. Idempotent: returns early if snapshot already
/// locked. Caller is responsible for ensuring the path has had a chance to
/// observe (and that ticks ≥ min_observations) before calling, otherwise the
/// market resolves Aborted (refund both sides).
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

/// Lock the linked oracle's settlement before any redemptions. Permissionless;
/// just a convenience wrapper that takes both objects in one call.
public fun lock_settlement<C>(_market: &Market<C>, oracle: &mut WickOracle, clock: &Clock) {
    if (!wick_oracle::is_settled(oracle)) {
        wick_oracle::lock_settlement_from_latest(oracle, clock);
    };
}

// === Reads ===

public fun name<C>(m: &Market<C>): &String { &m.name }
public fun oracle_id<C>(m: &Market<C>): ID { m.oracle_id }
public fun path_id<C>(m: &Market<C>): ID { m.path_id }
public fun expiry_ms<C>(m: &Market<C>): u64 { m.expiry_ms }
public fun payout_multiplier_bps<C>(m: &Market<C>): u64 { m.payout_multiplier_bps }
public fun vault_balance<C>(m: &Market<C>): u64 { vault::balance(&m.vault) }
public fun touch_exposure<C>(m: &Market<C>): u64 { m.touch_exposure }
public fun no_touch_exposure<C>(m: &Market<C>): u64 { m.no_touch_exposure }

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
        id, name: _, oracle_id: _, path_id: _, expiry_ms: _,
        payout_multiplier_bps: _, mut vault, touch_exposure: _, no_touch_exposure: _,
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
