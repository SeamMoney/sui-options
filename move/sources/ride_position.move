// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Streaming touch ride positions per `docs/design/v2/11_ride_streaming_primitive.md`.
///
/// A `RidePosition` is a binary touch option whose stake accumulates
/// continuously at a per-second rate while the user holds it. Settlement
/// kinds:
///
/// - **TOUCH_WIN** — barrier was crossed at some t ∈ [start_time_ms, close_ms].
///   Payout = `multiplier_bps × stake_paid / 10_000`. The user receives the
///   payout plus the unused portion of their escrow.
/// - **CASHOUT** — voluntary close before touch, before expiry. Payout =
///   `bachelier_factor × stake_paid × (1 - cashout_spread_bps / 10_000)`.
///   Always ≤ `stake_paid` because factor ≤ 1.0.
/// - **EXPIRED_LOSS** — held past expiry without a touch. Stake is forfeit.
/// - **ABORTED_REFUND** — market/path entered Aborted state. 1:1 refund of
///   escrow; no fees, no WICK mint.
///
/// Race-resolution: **touch wins ties**. If `touched_at` falls inside the
/// holding window, the user receives TOUCH_WIN regardless of close intent.
/// Past expiry, only touches at t < expiry_ms count (see `path_observation`).
///
/// Vault accounting: escrow is parked in `vault.treasury` at `open_ride`
/// and pulled back via `martingaler_vault::withdraw_for_ride_settlement` at
/// close. The Martingaler queue absorbs any shortfall on touch_win payouts
/// (where `multiplier × stake_paid` exceeds the original escrow).
///
/// Discrete touch markets (`wick::market`) are untouched. Rides require a
/// separate `RideMarketCaps` shared object that gates `is_streaming`.
module wick::ride_position;

use std::type_name::{Self, TypeName};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use wick::bot_registry::{Self as br, BotRegistry};
use wick::martingaler_vault::{Self as mv, MartingalerVault};
use wick::path_observation::{Self as po, PathObservation};
use wick::ride_market_caps::{Self as rmc, RideMarketCaps};
use wick::ride_pricing;
use wick::usd_price_oracle::{Self as upo, UsdPriceOracle};
use wick::wick_oracle::{Self as wo, WickOracle};
use wick::wick_staking::{Self as ws, WickStakingPool};
use wick::wick_token::{Self as wt, WickTokenState};

// === Settlement kinds ===
const SETTLEMENT_OPEN: u8 = 0;
const SETTLEMENT_TOUCH_WIN: u8 = 1;
const SETTLEMENT_CASHOUT: u8 = 2;
const SETTLEMENT_EXPIRED_LOSS: u8 = 3;
const SETTLEMENT_ABORTED_REFUND: u8 = 4;

// === Errors ===
const EAlreadyClosed: u64 = 1;
const EAfterExpiry: u64 = 2;
const EInsufficientEscrow: u64 = 3;
const ENotExpired: u64 = 4;
const EWrongMarket: u64 = 5;
const EWrongPath: u64 = 6;
const ENotStreaming: u64 = 7;
const EZeroEscrow: u64 = 8;
const EOracleMismatch: u64 = 9;
const ETouchedMustSelfClose: u64 = 10;
const EMarketAborted: u64 = 11;
/// Crank refuses to run when treasury can't cover user_refund + bounty
/// without queue routing. Otherwise the shortfall would be queued naming
/// the keeper's address as claimant, mis-attributing the user's refund.
/// User must self-close (which queues correctly under the user's ctx).
const EInsufficientTreasuryForCrank: u64 = 12;

const SECONDS_PER_MS: u64 = 1_000;
const BPS_DENOMINATOR: u64 = 10_000;
/// 0.5% of expired forfeit goes to whoever cranks an expired ride.
const CRANK_BOUNTY_BPS: u64 = 50;

// === Types ===

public struct RidePosition has key, store {
    id: UID,
    user: address,
    market_id: ID,
    path_id: ID,
    caps_id: ID,
    /// Captured from caps at open — immutable for the lifetime of the ride.
    multiplier_bps: u64,
    stake_rate_micro_usd_per_sec: u64,
    start_time_ms: u64,
    /// Coin amount escrowed up-front. Bounds total possible stake_paid.
    escrowed: u64,
    /// Captured from BotRegistry at open. Bot-ineligible riders skip WICK mint.
    is_bot_eligible: bool,
    closed: bool,
    closed_at_ms: u64,
    settlement_kind: u8,
    collateral: TypeName,
}

// === Events ===

public struct RideOpened has copy, drop {
    ride_id: ID,
    user: address,
    market_id: ID,
    path_id: ID,
    escrowed: u64,
    rate_micro_usd_per_sec: u64,
    multiplier_bps: u64,
    start_time_ms: u64,
}

public struct RideClosed has copy, drop {
    ride_id: ID,
    user: address,
    market_id: ID,
    settlement_kind: u8,
    stake_paid: u64,
    payout: u64,
    forfeit: u64,
    bounty: u64,
    closed_at_ms: u64,
}

// === Read accessors ===

public fun user(r: &RidePosition): address { r.user }
public fun market_id(r: &RidePosition): ID { r.market_id }
public fun path_id(r: &RidePosition): ID { r.path_id }
public fun caps_id(r: &RidePosition): ID { r.caps_id }
public fun multiplier_bps(r: &RidePosition): u64 { r.multiplier_bps }
public fun stake_rate(r: &RidePosition): u64 { r.stake_rate_micro_usd_per_sec }
public fun start_time_ms(r: &RidePosition): u64 { r.start_time_ms }
public fun escrowed(r: &RidePosition): u64 { r.escrowed }
public fun is_closed(r: &RidePosition): bool { r.closed }
public fun closed_at_ms(r: &RidePosition): u64 { r.closed_at_ms }
public fun settlement_kind(r: &RidePosition): u8 { r.settlement_kind }
public fun collateral(r: &RidePosition): &TypeName { &r.collateral }
public fun is_bot_eligible(r: &RidePosition): bool { r.is_bot_eligible }

public fun settlement_open(): u8 { SETTLEMENT_OPEN }
public fun settlement_touch_win(): u8 { SETTLEMENT_TOUCH_WIN }
public fun settlement_cashout(): u8 { SETTLEMENT_CASHOUT }
public fun settlement_expired_loss(): u8 { SETTLEMENT_EXPIRED_LOSS }
public fun settlement_aborted_refund(): u8 { SETTLEMENT_ABORTED_REFUND }

// === open_ride ===

/// Open a streaming ride. Escrow is moved into `vault.treasury`. The
/// user-side cap and per-market concurrent-escrow cap are reserved.
///
/// Aborts:
/// - `ENotStreaming` if caps.is_streaming is false
/// - `EWrongMarket` / `EWrongPath` if caps don't reference the supplied market/path
/// - `EAfterExpiry` if now >= path.expiry_ms or path is past Active
/// - `EMarketAborted` if vault marks the market as aborted
/// - `ERateTooLow` / `ERateTooHigh` (from ride_market_caps)
/// - `EZeroEscrow` if escrow.value() == 0
/// - `EInsufficientEscrow` if escrow can't cover rate × remaining_seconds
/// - `ECapExceeded` / `EUserCapExceeded` (from ride_market_caps)
public fun open_ride<C>(
    caps: &mut RideMarketCaps,
    path: &PathObservation,
    vault: &mut MartingalerVault<C>,
    bot_registry: &BotRegistry,
    rate_micro_usd_per_sec: u64,
    escrow: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): RidePosition {
    assert!(rmc::is_streaming(caps), ENotStreaming);
    // Defensive: ride is single-barrier only by spec §13. DNT paths use
    // upper_touched_at/lower_touched_at — the single-barrier touched_during
    // helper this ride relies on for the "touch wins ties" rule would always
    // return false on a DNT path, silently breaking touch_win settlement.
    assert!(!po::is_dnt(path), ENotStreaming);

    let market_id_from_caps = rmc::market_id(caps);
    let path_id_actual = object::id(path);
    assert!(rmc::path_id(caps) == path_id_actual, EWrongPath);

    let now = clock.timestamp_ms();
    let expiry_ms = po::expiry_ms(path);
    assert!(now < expiry_ms, EAfterExpiry);
    assert!(po::settlement_state(path, clock) == po::settlement_not_ready(), EAfterExpiry);
    assert!(!mv::is_market_aborted(vault, market_id_from_caps), EMarketAborted);

    rmc::assert_rate_in_range(caps, rate_micro_usd_per_sec);

    let escrow_amount = coin::value(&escrow);
    assert!(escrow_amount > 0, EZeroEscrow);

    let remaining_sec = (expiry_ms - now) / SECONDS_PER_MS;
    let max_stake_u128 =
        ((rate_micro_usd_per_sec as u128) * (remaining_sec as u128) + 999_999) / 1_000_000;
    assert!((escrow_amount as u128) >= max_stake_u128, EInsufficientEscrow);

    let user = ctx.sender();
    rmc::reserve_escrow(caps, user, escrow_amount, ctx);

    mv::deposit_ride_escrow<C>(vault, escrow);

    let is_bot_eligible = br::is_eligible_for_wick(bot_registry, user);
    let multiplier_bps = rmc::multiplier_bps(caps);
    let caps_id = object::id(caps);

    let ride = RidePosition {
        id: object::new(ctx),
        user,
        market_id: market_id_from_caps,
        path_id: path_id_actual,
        caps_id,
        multiplier_bps,
        stake_rate_micro_usd_per_sec: rate_micro_usd_per_sec,
        start_time_ms: now,
        escrowed: escrow_amount,
        is_bot_eligible,
        closed: false,
        closed_at_ms: 0,
        settlement_kind: SETTLEMENT_OPEN,
        collateral: type_name::with_defining_ids<C>(),
    };

    sui::event::emit(RideOpened {
        ride_id: object::id(&ride),
        user,
        market_id: market_id_from_caps,
        path_id: path_id_actual,
        escrowed: escrow_amount,
        rate_micro_usd_per_sec,
        multiplier_bps,
        start_time_ms: now,
    });

    ride
}

// === close_ride (user-called) ===

/// Voluntarily close a ride. Settlement kind is decided by:
///   1. Market or path aborted → ABORTED_REFUND (1:1)
///   2. Touch fired during [start, min(now, expiry)] → TOUCH_WIN
///   3. now >= expiry (no touch) → EXPIRED_LOSS
///   4. Otherwise → CASHOUT at Bachelier factor
///
/// Returns the Coin<C> the caller should receive (payout + unused escrow).
public fun close_ride<C>(
    ride: &mut RidePosition,
    caps: &mut RideMarketCaps,
    path: &PathObservation,
    oracle: &WickOracle,
    vault: &mut MartingalerVault<C>,
    price_oracle: &UsdPriceOracle,
    token_state: &mut WickTokenState,
    staking_pool: &mut WickStakingPool,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    assert!(!ride.closed, EAlreadyClosed);
    assert!(rmc::market_id(caps) == ride.market_id, EWrongMarket);
    assert!(rmc::path_id(caps) == ride.path_id, EWrongPath);
    assert!(po::oracle_id(path) == object::id(oracle), EOracleMismatch);

    let now = clock.timestamp_ms();
    let expiry_ms = po::expiry_ms(path);

    let (stake_paid, payout, forfeit, kind) = decide_settlement<C>(
        ride.stake_rate_micro_usd_per_sec,
        ride.start_time_ms,
        ride.escrowed,
        ride.multiplier_bps,
        now,
        expiry_ms,
        path,
        oracle,
        caps,
        vault,
        clock,
    );

    let total_to_user = payout + (ride.escrowed - stake_paid);
    let payout_coin = mv::withdraw_for_ride_settlement<C>(vault, total_to_user, ctx);

    if (forfeit > 0 && kind != SETTLEMENT_ABORTED_REFUND) {
        let loss_micro_usd = upo::loss_micro_usd<C>(
            price_oracle, forfeit, clock, upo::default_max_staleness_ms(),
        );
        ws::record_loss(staking_pool, ride.user, loss_micro_usd);
        let _wick_minted = wt::mint_to_loser(
            token_state,
            ride.user,
            loss_micro_usd,
            ride.is_bot_eligible,
            clock,
            ctx,
        );
    };

    rmc::release_escrow(caps, ride.user, ride.escrowed);

    ride.closed = true;
    ride.closed_at_ms = now;
    ride.settlement_kind = kind;

    sui::event::emit(RideClosed {
        ride_id: object::id(ride),
        user: ride.user,
        market_id: ride.market_id,
        settlement_kind: kind,
        stake_paid,
        payout,
        forfeit,
        bounty: 0,
        closed_at_ms: now,
    });

    payout_coin
}

// === crank_expired_ride (permissionless) ===

/// Anyone can crank an expired ride whose user hasn't closed. Pays a 50bps
/// bounty (of forfeit) to the caller and the residual to the user via
/// transfer. **Only handles the EXPIRED_LOSS path** — if the barrier fired
/// during the holding window, the user must self-close to claim, because
/// the vault queue routing would otherwise credit the caller's address.
public fun crank_expired_ride<C>(
    ride: &mut RidePosition,
    caps: &mut RideMarketCaps,
    path: &PathObservation,
    vault: &mut MartingalerVault<C>,
    price_oracle: &UsdPriceOracle,
    token_state: &mut WickTokenState,
    staking_pool: &mut WickStakingPool,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    assert!(!ride.closed, EAlreadyClosed);
    assert!(rmc::market_id(caps) == ride.market_id, EWrongMarket);
    assert!(rmc::path_id(caps) == ride.path_id, EWrongPath);

    let now = clock.timestamp_ms();
    let expiry_ms = po::expiry_ms(path);
    assert!(now >= expiry_ms, ENotExpired);

    // Forbid crank if barrier fired during window — user must self-close.
    assert!(
        !po::touched_during(path, ride.start_time_ms, expiry_ms),
        ETouchedMustSelfClose,
    );

    // Same stake-paid calculation as close_ride.
    let elapsed_sec = compute_elapsed_sec(now, ride.start_time_ms, expiry_ms);
    let stake_paid = compute_stake_paid(
        ride.stake_rate_micro_usd_per_sec, elapsed_sec, ride.escrowed,
    );

    // Bounty = 50bps of forfeit (forfeit == stake_paid here).
    let bounty = ((stake_paid as u128) * (CRANK_BOUNTY_BPS as u128) / (BPS_DENOMINATOR as u128)) as u64;
    let forfeit_after_bounty = stake_paid - bounty;
    let user_refund = ride.escrowed - stake_paid;

    // SEV-1 fix per Reviewer D: refuse to run if treasury can't cover both
    // legs without queue routing. Otherwise `withdraw_for_ride_settlement`
    // would enqueue the shortfall naming the keeper as claimant — the
    // user's refund would end up with the keeper. User must self-close in
    // this case (close_ride queues under the user's ctx, which is correct).
    assert!(
        mv::treasury_value(vault) >= user_refund + bounty,
        EInsufficientTreasuryForCrank,
    );

    // Pay user from vault. (Guaranteed cash by the treasury check above.)
    if (user_refund > 0) {
        let user_coin = mv::withdraw_for_ride_settlement<C>(vault, user_refund, ctx);
        transfer::public_transfer(user_coin, ride.user);
    };

    // WICK mint on the forfeit_after_bounty portion.
    if (forfeit_after_bounty > 0) {
        let loss_micro_usd = upo::loss_micro_usd<C>(
            price_oracle, forfeit_after_bounty, clock, upo::default_max_staleness_ms(),
        );
        ws::record_loss(staking_pool, ride.user, loss_micro_usd);
        let _wick_minted = wt::mint_to_loser(
            token_state,
            ride.user,
            loss_micro_usd,
            ride.is_bot_eligible,
            clock,
            ctx,
        );
    };

    // Pay caller their bounty.
    let bounty_coin = if (bounty > 0) {
        mv::withdraw_for_ride_settlement<C>(vault, bounty, ctx)
    } else {
        coin::zero<C>(ctx)
    };

    rmc::release_escrow(caps, ride.user, ride.escrowed);

    ride.closed = true;
    ride.closed_at_ms = now;
    ride.settlement_kind = SETTLEMENT_EXPIRED_LOSS;

    sui::event::emit(RideClosed {
        ride_id: object::id(ride),
        user: ride.user,
        market_id: ride.market_id,
        settlement_kind: SETTLEMENT_EXPIRED_LOSS,
        stake_paid,
        payout: 0,
        forfeit: forfeit_after_bounty,
        bounty,
        closed_at_ms: now,
    });

    bounty_coin
}

// === Internal helpers ===

fun compute_elapsed_sec(now: u64, start_time_ms: u64, expiry_ms: u64): u64 {
    let bound_ms = if (now > expiry_ms) expiry_ms else now;
    let raw_ms = if (bound_ms > start_time_ms) bound_ms - start_time_ms else 0;
    raw_ms / SECONDS_PER_MS
}

fun compute_stake_paid(rate: u64, elapsed_sec: u64, escrowed_cap: u64): u64 {
    let raw = ((rate as u128) * (elapsed_sec as u128)) / 1_000_000;
    if (raw > (escrowed_cap as u128)) escrowed_cap else (raw as u64)
}

fun decide_settlement<C>(
    rate: u64,
    start_time_ms: u64,
    escrowed: u64,
    multiplier_bps: u64,
    now: u64,
    expiry_ms: u64,
    path: &PathObservation,
    oracle: &WickOracle,
    caps: &RideMarketCaps,
    vault: &MartingalerVault<C>,
    clock: &Clock,
): (u64, u64, u64, u8) {
    let elapsed_sec = compute_elapsed_sec(now, start_time_ms, expiry_ms);
    let stake_paid = compute_stake_paid(rate, elapsed_sec, escrowed);

    // 1. Aborted check (market-side via vault, then path-side via snapshot).
    //
    // Use stake_paid = 0, payout = 0 here. The caller computes
    //   total_to_user = payout + (escrowed - stake_paid) = 0 + escrowed = escrowed.
    // This yields the 1:1 refund spec §10 requires. Setting payout = escrowed
    // here would double-pay (escrowed + escrowed).
    if (mv::is_market_aborted(vault, rmc::market_id(caps))) {
        return (0u64, 0u64, 0u64, SETTLEMENT_ABORTED_REFUND)
    };
    if (po::settlement_state(path, clock) == po::settlement_aborted()) {
        return (0u64, 0u64, 0u64, SETTLEMENT_ABORTED_REFUND)
    };

    // 2. Past expiry — touch_win still possible if path actually touched
    //    in window, else expired_loss. Touch wins ties at expiry boundary.
    if (now >= expiry_ms) {
        if (po::touched_during(path, start_time_ms, expiry_ms)) {
            let p = (((stake_paid as u128) * (multiplier_bps as u128)) / (BPS_DENOMINATOR as u128)) as u64;
            // Forfeit on touch_win = 0 from user's perspective (they win).
            return (stake_paid, p, 0u64, SETTLEMENT_TOUCH_WIN)
        };
        return (stake_paid, 0u64, stake_paid, SETTLEMENT_EXPIRED_LOSS)
    };

    // 3. In-window touch
    if (po::touched_during(path, start_time_ms, now)) {
        let p = (((stake_paid as u128) * (multiplier_bps as u128)) / (BPS_DENOMINATOR as u128)) as u64;
        return (stake_paid, p, 0u64, SETTLEMENT_TOUCH_WIN)
    };

    // 4. Cashout at Bachelier factor
    let spot = wo::latest_price(oracle);
    let seconds_remaining = (expiry_ms - now) / SECONDS_PER_MS;
    let factor = ride_pricing::bachelier_cashout_factor(
        spot,
        po::barrier(path),
        rmc::sigma_bps_per_sqrt_sec(caps),
        seconds_remaining,
    );
    let raw_payout =
        ((stake_paid as u128) * (factor as u128) / (ride_pricing::factor_scale() as u128)) as u64;
    let after_spread = ((raw_payout as u128)
        * ((BPS_DENOMINATOR - rmc::cashout_spread_bps(caps)) as u128)
        / (BPS_DENOMINATOR as u128)) as u64;
    let payout = if (after_spread > stake_paid) stake_paid else after_spread;
    let forfeit = stake_paid - payout;
    (stake_paid, payout, forfeit, SETTLEMENT_CASHOUT)
}

// === Test-only ===

#[test_only]
public fun test_only_settlement_open(): u8 { SETTLEMENT_OPEN }
#[test_only]
public fun test_only_destroy_for_test(r: RidePosition) {
    let RidePosition {
        id, user: _, market_id: _, path_id: _, caps_id: _,
        multiplier_bps: _, stake_rate_micro_usd_per_sec: _, start_time_ms: _,
        escrowed: _, is_bot_eligible: _, closed: _, closed_at_ms: _,
        settlement_kind: _, collateral: _,
    } = r;
    object::delete(id);
}
