// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Wick-native market: touch / no-touch positions backed by a SHARED
/// MartingalerVault<C> singleton (one per collateral type, cross-market).
///
/// === C.3.4: impact fee + risk_config + PWE registry wiring ===
/// open<C> now composes assert_open_allowed (per-position + per-side + global
/// PWE + correlation + queue + wind-down) BEFORE depositing stake (closes
/// adversarial #17). PWE is registered into GlobalExposureRegistry on open
/// and CLEARED on lock_and_settle (math agent M7 GAP fix).
///
/// redeem<C> on winners now charges the asymmetric impact fee on PROFIT
/// (payout - stake), per user decision E1 (cleaner UX, dydx-style). Fee is
/// routed through fee_router::accrue (4-bucket split LP/staker/insurance/
/// protocol = 55/25/10/10).
module wick::market;

use std::string::String;
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use wick::bot_registry::{Self as br, BotRegistry};
use wick::fee_router::{Self as router, FeeRouter};
use wick::global_exposure_registry::{Self as ger, GlobalExposureRegistry};
use wick::impact_fee::{Self as fee, FeeSnapshot};
use wick::martingaler_vault::{Self as mv, MartingalerVault};
use wick::path_observation::{Self, PathObservation};
use wick::risk_config::{Self as rc, RiskConfig};
use wick::usd_price_oracle::{Self as upo, UsdPriceOracle};
use wick::wick_oracle::{Self, WickOracle};
use wick::wick_staking::{Self as ws, WickStakingPool};
use wick::wick_token::{Self as wt, WickTokenState};

const EWrongPath: u64 = 1;
const EBadMultiplier: u64 = 2;
const EZeroStake: u64 = 3;
const EAfterExpiry: u64 = 4;
const EWrongMarket: u64 = 10;
const ENotReadyToSettle: u64 = 11;
const ENotActive: u64 = 12;
const EStillActive: u64 = 13;
const EBadStatus: u64 = 14;
const EZeroSigma: u64 = 15;
const EVaultSideClosed: u64 = 16;

const SIDE_TOUCH: u8 = 0;
const SIDE_NO_TOUCH: u8 = 1;
/// DNT: bets the corridor holds (neither barrier touched).
const SIDE_DNT_INSIDE: u8 = 2;
/// DNT: bets at least one barrier is touched.
const SIDE_DNT_OUTSIDE: u8 = 3;
/// Sentinel meaning "no side is reserved for the vault" — both sides
/// can open positions. Used by legacy/DNT markets where the protocol
/// is peer-to-peer rather than vault-vs-trader.
const VAULT_SIDE_NONE: u8 = 255;

const STATUS_ACTIVE: u8 = 0;
const STATUS_HIT: u8 = 1;
const STATUS_EXPIRED: u8 = 2;
const STATUS_ABORTED: u8 = 3;
const STATUS_CANCELLED: u8 = 4;
/// DNT: corridor held (inside wins). Distinct numeric value to keep DNT
/// markets visibly tagged in events / clients without polluting the
/// existing HIT/EXPIRED invariants.
const STATUS_DNT_HELD: u8 = 5;
/// DNT: at least one barrier breached (outside wins).
const STATUS_DNT_BROKEN: u8 = 6;

/// Sensible default volatility for hackathon — 100 bps per sqrt(sec) ≈ 1%/s.
/// Frontend can override per-market via create_v3.
const DEFAULT_SIGMA_BPS_PER_SQRT_SEC: u64 = 100;

public fun side_touch(): u8 { SIDE_TOUCH }
public fun side_no_touch(): u8 { SIDE_NO_TOUCH }
public fun side_dnt_inside(): u8 { SIDE_DNT_INSIDE }
public fun side_dnt_outside(): u8 { SIDE_DNT_OUTSIDE }
public fun vault_side_none(): u8 { VAULT_SIDE_NONE }
public fun status_active(): u8 { STATUS_ACTIVE }
public fun status_hit(): u8 { STATUS_HIT }
public fun status_expired(): u8 { STATUS_EXPIRED }
public fun status_aborted(): u8 { STATUS_ABORTED }
public fun status_cancelled(): u8 { STATUS_CANCELLED }
public fun status_dnt_held(): u8 { STATUS_DNT_HELD }
public fun status_dnt_broken(): u8 { STATUS_DNT_BROKEN }
public fun default_sigma_bps_per_sqrt_sec(): u64 { DEFAULT_SIGMA_BPS_PER_SQRT_SEC }

public struct Market<phantom C> has key {
    id: UID,
    name: String,
    underlying: String,
    oracle_id: ID,
    path_id: ID,
    vault_id: ID,
    expiry_ms: u64,
    payout_multiplier_bps: u64,
    correlation_bucket_id: u8,
    /// Volatility for compute_pwe: bps per sqrt(sec). Set at create time
    /// from RiskConfig default or per-market override. Used for global OI
    /// cap math via probability::touch_probability.
    sigma_bps_per_sqrt_sec: u64,
    /// Side reserved for the vault as natural counterparty.
    /// `open` rejects positions on this side, so the vault is always the
    /// other side of every trade. Value `VAULT_SIDE_NONE` (255) disables
    /// the gate — used by DNT and legacy two-sided markets.
    /// Wired by Monte Carlo finding (see docs/design/v2/15_montecarlo_validation_report.md):
    /// vault-backed touch markets must gate to single-side opening or
    /// edge per dollar reduces to `1 - M` regardless of `P_touch`.
    vault_side: u8,
    touch_exposure: u64,
    no_touch_exposure: u64,
    touch_stakes: u64,
    no_touch_stakes: u64,
    /// Cumulative PWE registered into GlobalExposureRegistry on the touch
    /// side. Cleared (decremented from registry) on lock_and_settle.
    touch_pwe: u128,
    no_touch_pwe: u128,
    status: u8,
    fee_snapshot: Option<FeeSnapshot>,
    settled_at_ms: Option<u64>,
}

public struct Position has key, store {
    id: UID,
    market_id: ID,
    side: u8,
    stake: u64,
    payout_if_win: u64,
    /// Snapshot of bot-eligibility at OPEN time. C.3.5 will populate from
    /// BotRegistry; for now everyone eligible.
    is_bot_eligible: bool,
    /// PWE attributed to this position. Position-level tracking is for
    /// future early-close support; market-level totals drive the registry.
    pwe_at_open: u128,
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
    sigma_bps_per_sqrt_sec: u64,
}

public struct PositionOpened has copy, drop {
    market_id: ID,
    position_id: ID,
    side: u8,
    stake: u64,
    payout_if_win: u64,
    pwe: u128,
    owner: address,
}

public struct PositionRedeemed has copy, drop {
    market_id: ID,
    position_id: ID,
    side: u8,
    payout: u64,           // gross payout (winner) or stake (refund) or 0 (loser)
    fee_paid: u64,         // impact fee taken from profit (winners only)
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

/// Backwards-compat: bucket=0, sigma=DEFAULT.
public fun create<C>(
    name: String,
    oracle: &WickOracle,
    path: &PathObservation,
    vault: &MartingalerVault<C>,
    payout_multiplier_bps: u64,
    ctx: &mut TxContext,
): Market<C> {
    create_v3<C>(
        name, oracle, path, vault, payout_multiplier_bps, 0,
        DEFAULT_SIGMA_BPS_PER_SQRT_SEC, ctx,
    )
}

/// v2 — explicit correlation_bucket_id, default sigma.
public fun create_v2<C>(
    name: String,
    oracle: &WickOracle,
    path: &PathObservation,
    vault: &MartingalerVault<C>,
    payout_multiplier_bps: u64,
    correlation_bucket_id: u8,
    ctx: &mut TxContext,
): Market<C> {
    create_v3<C>(
        name, oracle, path, vault, payout_multiplier_bps, correlation_bucket_id,
        DEFAULT_SIGMA_BPS_PER_SQRT_SEC, ctx,
    )
}

/// v3 — full create with explicit sigma_bps_per_sqrt_sec.
/// vault_side defaults to VAULT_SIDE_NONE (no gate, both sides openable).
public fun create_v3<C>(
    name: String,
    oracle: &WickOracle,
    path: &PathObservation,
    vault: &MartingalerVault<C>,
    payout_multiplier_bps: u64,
    correlation_bucket_id: u8,
    sigma_bps_per_sqrt_sec: u64,
    ctx: &mut TxContext,
): Market<C> {
    create_v4<C>(
        name, oracle, path, vault, payout_multiplier_bps, correlation_bucket_id,
        sigma_bps_per_sqrt_sec, VAULT_SIDE_NONE, ctx,
    )
}

/// v4 — adds vault_side gate. Pass SIDE_NO_TOUCH for arcade/touch markets
/// so traders can only open the TOUCH side and the vault is the natural
/// counterparty on NO_TOUCH. Pass VAULT_SIDE_NONE for two-sided markets.
public fun create_v4<C>(
    name: String,
    oracle: &WickOracle,
    path: &PathObservation,
    vault: &MartingalerVault<C>,
    payout_multiplier_bps: u64,
    correlation_bucket_id: u8,
    sigma_bps_per_sqrt_sec: u64,
    vault_side: u8,
    ctx: &mut TxContext,
): Market<C> {
    assert!(payout_multiplier_bps > 10_000, EBadMultiplier);
    assert!(payout_multiplier_bps < 100_000, EBadMultiplier);
    assert!(path_observation::oracle_id(path) == object::id(oracle), EWrongPath);
    assert!(sigma_bps_per_sqrt_sec > 0, EZeroSigma);
    // vault_side must be a recognized value
    assert!(
        vault_side == SIDE_TOUCH
            || vault_side == SIDE_NO_TOUCH
            || vault_side == SIDE_DNT_INSIDE
            || vault_side == SIDE_DNT_OUTSIDE
            || vault_side == VAULT_SIDE_NONE,
        EVaultSideClosed,
    );

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
        sigma_bps_per_sqrt_sec,
        vault_side,
        touch_exposure: 0,
        no_touch_exposure: 0,
        touch_stakes: 0,
        no_touch_stakes: 0,
        touch_pwe: 0,
        no_touch_pwe: 0,
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
        sigma_bps_per_sqrt_sec,
    });

    market
}

/// DNT market constructor — asserts path is a DNT path. Otherwise identical
/// to create_v2: same fee/exposure plumbing; touch_* fields are reused to
/// store the INSIDE side and no_touch_* fields to store the OUTSIDE side.
public fun create_dnt<C>(
    name: String,
    oracle: &WickOracle,
    path: &PathObservation,
    vault: &MartingalerVault<C>,
    payout_multiplier_bps: u64,
    correlation_bucket_id: u8,
    ctx: &mut TxContext,
): Market<C> {
    assert!(path_observation::is_dnt(path), EWrongPath);
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
        sigma_bps_per_sqrt_sec: DEFAULT_SIGMA_BPS_PER_SQRT_SEC,
        // DNT markets are two-sided (inside vs outside) by design; no
        // vault-side reservation.
        vault_side: VAULT_SIDE_NONE,
        touch_exposure: 0,
        no_touch_exposure: 0,
        touch_stakes: 0,
        no_touch_stakes: 0,
        touch_pwe: 0,
        no_touch_pwe: 0,
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
        sigma_bps_per_sqrt_sec: DEFAULT_SIGMA_BPS_PER_SQRT_SEC,
    });

    market
}

public fun share<C>(market: Market<C>) {
    transfer::share_object(market);
}

// === Trading ===

/// Open a position. STATUS-GATED + RISK-GATED.
///
/// ORDER OF OPS (closes adversarial #17):
///   1. Compute payout + PWE
///   2. assert_open_allowed BEFORE deposit (so risk reject doesn't pollute vault)
///   3. deposit stake into vault
///   4. update market exposure + pwe
///   5. update GlobalExposureRegistry (+pwe)
///
/// `spot` is the current oracle price — caller (frontend) reads from
/// oracle.latest_price() and passes in. Decoupled to avoid a borrow conflict
/// when the same oracle is mutably borrowed elsewhere.
public fun open<C>(
    market: &mut Market<C>,
    vault: &mut MartingalerVault<C>,
    risk_config: &RiskConfig,
    registry: &mut GlobalExposureRegistry,
    bot_registry: &BotRegistry,
    path: &PathObservation,
    side: u8,
    stake: Coin<C>,
    spot: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): Position {
    assert!(market.status == STATUS_ACTIVE, ENotActive);
    assert!(market.vault_id == object::id(vault), EWrongMarket);
    assert!(market.path_id == object::id(path), EWrongPath);
    let now = clock.timestamp_ms();
    assert!(now < market.expiry_ms, EAfterExpiry);
    // Side gating: 0/1 require single-barrier path; 2/3 require DNT path.
    let is_dnt = path_observation::is_dnt(path);
    if (side == SIDE_TOUCH || side == SIDE_NO_TOUCH) {
        assert!(!is_dnt, EWrongPath);
    } else {
        assert!(side == SIDE_DNT_INSIDE || side == SIDE_DNT_OUTSIDE, EBadMultiplier);
        assert!(is_dnt, EWrongPath);
    };

    // Vault-side gate: if the market reserves a side for the vault as
    // natural counterparty, reject opens on that side. Closes the
    // symmetric-demand vault-edge bug surfaced by the Monte Carlo report
    // (docs/design/v2/15_montecarlo_validation_report.md):
    // with shared multiplier M and balanced two-sided demand, vault P&L
    // per dollar reduces to `1 - M` independent of P_touch. Gating to a
    // single side restores `1 - M·P_touch` as the per-position edge.
    assert!(
        market.vault_side == VAULT_SIDE_NONE || side != market.vault_side,
        EVaultSideClosed,
    );

    let stake_amount = stake.value();
    assert!(stake_amount > 0, EZeroStake);

    let payout = mul_bps(stake_amount, market.payout_multiplier_bps);

    // Compute PWE for this position. DNT uses the union-bound Bachelier
    // approximation in rc::compute_pwe_dnt (P_outside ≈ P_touch_upper +
    // P_touch_lower clipped at 1; P_inside = 1 - P_outside). Single-barrier
    // paths use the existing Bachelier first-passage model.
    let seconds_remaining = if (market.expiry_ms > now) (market.expiry_ms - now) / 1_000 else 1;
    let safe_seconds = if (seconds_remaining == 0) 1 else seconds_remaining;
    let position_pwe: u128 = if (is_dnt) {
        rc::compute_pwe_dnt(
            payout,
            spot,
            path_observation::upper_barrier(path),
            path_observation::lower_barrier(path),
            market.sigma_bps_per_sqrt_sec,
            safe_seconds,
            side == SIDE_DNT_INSIDE,
        )
    } else {
        rc::compute_pwe(
            payout,
            spot,
            path_observation::barrier(path),
            market.sigma_bps_per_sqrt_sec,
            safe_seconds,
        )
    };

    // Compute V_eff = vault treasury (free funds available for new payouts).
    // Bootstrap path (V_eff == 0): risk_config asserts will short-circuit
    // sensibly since per-position cap requires V_eff > 0.
    let v_eff = mv::treasury_value(vault);

    // Compute side_exposure_after. INSIDE shares the touch slot; OUTSIDE
    // shares the no_touch slot — same accounting buckets.
    let stores_in_touch_slot = (side == SIDE_TOUCH) || (side == SIDE_DNT_INSIDE);
    let side_exposure_after = if (stores_in_touch_slot) {
        market.touch_exposure + payout
    } else {
        market.no_touch_exposure + payout
    };

    // ASSERT FIRST (closes adversarial #17 — never deposit on rejected open).
    rc::assert_open_allowed(
        risk_config,
        registry,
        market.underlying,
        side,
        market.correlation_bucket_id,
        payout,
        side_exposure_after,
        position_pwe,
        v_eff,
        mv::queue_total(vault),
        clock,
    );

    // Deposit stake (auto-harvests queue heads if non-empty).
    mv::deposit_open(vault, stake, clock, ctx);

    // Update market exposure + stakes + pwe. INSIDE shares touch slot;
    // OUTSIDE shares no_touch slot.
    if (stores_in_touch_slot) {
        market.touch_exposure = market.touch_exposure + payout;
        market.touch_stakes = market.touch_stakes + stake_amount;
        market.touch_pwe = market.touch_pwe + position_pwe;
    } else {
        market.no_touch_exposure = market.no_touch_exposure + payout;
        market.no_touch_stakes = market.no_touch_stakes + stake_amount;
        market.no_touch_pwe = market.no_touch_pwe + position_pwe;
    };

    // Register PWE into global registry (+). Side stays as-is (0/1/2/3)
    // so DNT exposure occupies its own buckets.
    ger::update_exposure(registry, market.underlying, side, true, position_pwe, clock);

    // Bot eligibility snapshotted at OPEN time (per adversarial #7). Reading
    // at redeem-time would let a freshly-flagged bot's outstanding positions
    // still mint WICK on close.
    let is_bot_eligible = br::is_eligible_for_wick(bot_registry, tx_context::sender(ctx));

    let position = Position {
        id: object::new(ctx),
        market_id: object::id(market),
        side,
        stake: stake_amount,
        payout_if_win: payout,
        is_bot_eligible,
        pwe_at_open: position_pwe,
        opened_at_ms: now,
    };

    sui::event::emit(PositionOpened {
        market_id: object::id(market),
        position_id: object::id(&position),
        side,
        stake: stake_amount,
        payout_if_win: payout,
        pwe: position_pwe,
        owner: tx_context::sender(ctx),
    });

    position
}

/// Atomic lock_and_settle. Phase 7 (NEW in C.3.4): clear PWE from registry.
public fun lock_and_settle<C>(
    market: &mut Market<C>,
    vault: &mut MartingalerVault<C>,
    path: &mut PathObservation,
    oracle: &mut WickOracle,
    registry: &mut GlobalExposureRegistry,
    clock: &Clock,
    _ctx: &mut TxContext,
) {
    // P0: idempotency
    if (market.status != STATUS_ACTIVE) return;
    assert!(market.path_id == object::id(path), EWrongPath);
    assert!(market.vault_id == object::id(vault), EWrongMarket);

    // P1: snapshot path
    if (option::is_none(path_observation::settlement_snapshot(path))) {
        path_observation::lock_settlement_snapshot(path, clock);
    };
    let snap_opt = path_observation::settlement_snapshot(path);
    assert!(option::is_some(snap_opt), ENotReadyToSettle);
    let snap = option::borrow(snap_opt);
    let snap_state = path_observation::snapshot_state(snap);

    // P2: oracle settlement_price (Resolved branches)
    if (snap_state != path_observation::settlement_aborted()
        && !wick_oracle::is_settled(oracle)) {
        wick_oracle::lock_settlement_from_latest(oracle, clock);
    };

    // P3: FeeSnapshot. DNT paths get the two-barrier variant so
    // `decisiveness_bps_for_side` dispatches to the DNT helpers at redeem.
    let fs = if (path_observation::is_dnt(path)) {
        fee::snapshot_at_lock_dnt(
            path_observation::lower_barrier(path),
            path_observation::upper_barrier(path),
            path_observation::snapshot_max_seen(snap),
            path_observation::snapshot_min_seen(snap),
            market.touch_exposure,    // INSIDE-slot reuse
            market.no_touch_exposure, // OUTSIDE-slot reuse
        )
    } else {
        fee::snapshot_at_lock(
            path_observation::barrier(path),
            path_observation::direction(path),
            path_observation::snapshot_max_seen(snap),
            path_observation::snapshot_min_seen(snap),
            market.touch_exposure,
            market.no_touch_exposure,
        )
    };
    market.fee_snapshot = option::some(fs);

    // P4: status. DNT uses dedicated status values to distinguish corridor
    // outcomes from single-barrier ones in events / clients.
    let is_dnt = path_observation::is_dnt(path);
    let new_status = if (snap_state == path_observation::settlement_aborted()) {
        STATUS_ABORTED
    } else if (is_dnt) {
        if (path_observation::snapshot_dnt_neither_touched(snap)) STATUS_DNT_HELD
        else STATUS_DNT_BROKEN
    } else if (path_observation::snapshot_is_touched(snap)) {
        STATUS_HIT
    } else {
        STATUS_EXPIRED
    };
    market.status = new_status;
    let now = clock.timestamp_ms();
    market.settled_at_ms = option::some(now);

    // P5: vault liquidity reservation. INSIDE shares the touch_exposure
    // slot; OUTSIDE shares no_touch_exposure.
    let market_id = object::id(market);
    let obligation = if (new_status == STATUS_HIT || new_status == STATUS_DNT_HELD) {
        market.touch_exposure
    } else if (new_status == STATUS_EXPIRED || new_status == STATUS_DNT_BROKEN) {
        market.no_touch_exposure
    } else {
        market.touch_stakes + market.no_touch_stakes
    };
    mv::reserve_for_market(vault, market_id, obligation);
    if (new_status == STATUS_ABORTED) {
        mv::route_lock_to_abort_refund(vault, market_id);
    };

    // P7: clear PWE from registry. For DNT markets the PWE is 0 (deferred
    // model), so update_exposure isn't called. Sides are stored under their
    // actual bucket (2/3) for DNT, (0/1) for single-barrier.
    let (touch_side_bucket, no_touch_side_bucket) = if (is_dnt) {
        (SIDE_DNT_INSIDE, SIDE_DNT_OUTSIDE)
    } else {
        (SIDE_TOUCH, SIDE_NO_TOUCH)
    };
    if (market.touch_pwe > 0) {
        ger::update_exposure(
            registry, market.underlying, touch_side_bucket, false, market.touch_pwe, clock,
        );
    };
    if (market.no_touch_pwe > 0) {
        ger::update_exposure(
            registry, market.underlying, no_touch_side_bucket, false, market.no_touch_pwe, clock,
        );
    };

    sui::event::emit(MarketSettled {
        market_id,
        new_status,
        settled_at_ms: now,
        touch_exposure_at_lock: market.touch_exposure,
        no_touch_exposure_at_lock: market.no_touch_exposure,
        obligation_reserved: obligation,
    });
}

/// Redeem a settled position. STATUS-GATED.
///
/// C.3.4: winner branch now charges asymmetric impact fee on PROFIT
/// (= payout_if_win - stake). Fee is split via fee_router into
/// LP/staker/insurance/protocol = 55/25/10/10. Winner receives:
///     net_payout = stake + (profit - fee_amt)
///     fee_amt    → fee_router → split + LP slice → vault.treasury
public fun redeem<C>(
    market: &mut Market<C>,
    vault: &mut MartingalerVault<C>,
    risk_config: &RiskConfig,
    fee_router: &mut FeeRouter<C>,
    wick_state: &mut WickTokenState,
    staking_pool: &mut WickStakingPool,
    price_oracle: &UsdPriceOracle,
    position: Position,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    assert!(position.market_id == object::id(market), EWrongMarket);
    assert!(market.vault_id == object::id(vault), EWrongMarket);
    assert!(market.status != STATUS_ACTIVE, EStillActive);

    let Position {
        id, market_id: _, side, stake, payout_if_win,
        is_bot_eligible, pwe_at_open: _, opened_at_ms: _,
    } = position;
    let pos_id = id.to_inner();
    object::delete(id);

    // Decrement exposure + stakes regardless of branch. INSIDE shares the
    // touch_* slots; OUTSIDE shares the no_touch_* slots.
    let stores_in_touch_slot = (side == SIDE_TOUCH) || (side == SIDE_DNT_INSIDE);
    if (stores_in_touch_slot) {
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

    // Aborted / Cancelled: 1:1 refund (no fee, no WICK mint).
    if (market.status == STATUS_ABORTED || market.status == STATUS_CANCELLED) {
        let refund = mv::claim_aborted_refund(vault, market_id, owner, stake, ctx);
        sui::event::emit(PositionRedeemed {
            market_id,
            position_id: pos_id,
            side,
            payout: stake,
            fee_paid: 0,
            won: false,
            owner,
        });
        return refund
    };

    // Hit / Expired / DNT_HELD / DNT_BROKEN: leveraged payout to winners,
    // loser closure to losers. DNT_HELD ⇒ inside wins; DNT_BROKEN ⇒ outside.
    let status = market.status;
    let won = if (status == STATUS_HIT) {
        side == SIDE_TOUCH
    } else if (status == STATUS_EXPIRED) {
        side == SIDE_NO_TOUCH
    } else if (status == STATUS_DNT_HELD) {
        side == SIDE_DNT_INSIDE
    } else if (status == STATUS_DNT_BROKEN) {
        side == SIDE_DNT_OUTSIDE
    } else {
        false
    };

    if (!won) {
        // LOSER BRANCH: mint WICK + record loss, atomically with the SAME
        // loss_micro_usd value. Per the math agent + adversarial #40 + the
        // user decision E2 + E3:
        //   - Pyth-stale or unset → loss_micro_usd = 0 → both calls graceful no-op
        //   - record_loss FIRST (cheap, never aborts on valid input)
        //   - mint_to_loser SECOND (heavier; gated by is_bot_eligible
        //     captured at OPEN time)
        //   - Both consume the SAME let-bound value — never recomputed
        let loss_micro_usd = upo::loss_micro_usd<C>(
            price_oracle, stake, clock, upo::default_max_staleness_ms(),
        );
        ws::record_loss(staking_pool, owner, loss_micro_usd);
        let _wick_minted = wt::mint_to_loser(
            wick_state, owner, loss_micro_usd, is_bot_eligible, clock, ctx,
        );
        sui::event::emit(PositionRedeemed {
            market_id, position_id: pos_id, side,
            payout: 0, fee_paid: 0, won: false, owner,
        });
        return coin::zero<C>(ctx)
    };

    // Winner branch: pay full payout from settlement_lock, then split off
    // fee from profit and route through fee_router.
    let mut payout_coin = mv::pay_winner(vault, market_id, owner, payout_if_win, clock, ctx);
    let actual_payout = payout_coin.value();  // may be < payout_if_win if queued

    // Fee on PROFIT only (per user decision E1). If actual_payout < stake
    // (extreme shortfall), profit is 0 and fee is 0.
    let profit = if (actual_payout > stake) actual_payout - stake else 0;
    let fee_amt = if (profit == 0) 0 else compute_fee_amount(market, risk_config, side, payout_if_win, profit);

    if (fee_amt > 0 && fee_amt <= profit) {
        let fee_coin = coin::split(&mut payout_coin, fee_amt, ctx);
        let fee_balance = coin::into_balance(fee_coin);
        router::accrue<C>(fee_router, vault, market_id, fee_balance, clock, ctx);
    };

    sui::event::emit(PositionRedeemed {
        market_id, position_id: pos_id, side,
        payout: actual_payout, fee_paid: fee_amt, won: true, owner,
    });
    payout_coin
}

/// Compute impact fee amount on the profit portion of a winning payout.
/// Fee bps come from FeeSnapshot + RiskConfig defaults; applied to profit.
fun compute_fee_amount<C>(
    market: &Market<C>,
    risk_config: &RiskConfig,
    side: u8,
    payout_if_win: u64,
    profit: u64,
): u64 {
    if (option::is_none(&market.fee_snapshot)) return 0;
    let snap = option::borrow(&market.fee_snapshot);
    let m = fee::decisiveness_bps_for_side(snap, side);
    let v = fee::vulnerability_bps(snap, payout_if_win);
    let fee_bps = fee::compute_fee_bps(
        m, v,
        rc::base_fee_bps(risk_config),
        rc::cap_fee_bps(risk_config),
        fee::m0_bps_default(),
    );
    let (_, fee_amt) = fee::apply_fee(profit, fee_bps);
    fee_amt
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
public fun sigma_bps_per_sqrt_sec<C>(m: &Market<C>): u64 { m.sigma_bps_per_sqrt_sec }
public fun vault_side<C>(m: &Market<C>): u8 { m.vault_side }
public fun touch_exposure<C>(m: &Market<C>): u64 { m.touch_exposure }
public fun no_touch_exposure<C>(m: &Market<C>): u64 { m.no_touch_exposure }
public fun touch_stakes<C>(m: &Market<C>): u64 { m.touch_stakes }
public fun no_touch_stakes<C>(m: &Market<C>): u64 { m.no_touch_stakes }
public fun touch_pwe<C>(m: &Market<C>): u128 { m.touch_pwe }
public fun no_touch_pwe<C>(m: &Market<C>): u128 { m.no_touch_pwe }
public fun status<C>(m: &Market<C>): u8 { m.status }
public fun fee_snapshot<C>(m: &Market<C>): &Option<FeeSnapshot> { &m.fee_snapshot }
public fun settled_at_ms<C>(m: &Market<C>): &Option<u64> { &m.settled_at_ms }
public fun is_settled<C>(m: &Market<C>): bool { m.status != STATUS_ACTIVE }

public fun position_market_id(p: &Position): ID { p.market_id }
public fun position_side(p: &Position): u8 { p.side }
public fun position_stake(p: &Position): u64 { p.stake }
public fun position_payout_if_win(p: &Position): u64 { p.payout_if_win }
public fun position_is_bot_eligible(p: &Position): bool { p.is_bot_eligible }
public fun position_pwe_at_open(p: &Position): u128 { p.pwe_at_open }
public fun position_opened_at_ms(p: &Position): u64 { p.opened_at_ms }

// === Helpers ===

fun mul_bps(amount: u64, bps: u64): u64 {
    ((amount as u128) * (bps as u128) / 10_000u128) as u64
}

#[test_only]
public fun destroy_for_testing<C>(market: Market<C>) {
    let Market {
        id, name: _, underlying: _, oracle_id: _, path_id: _, vault_id: _,
        expiry_ms: _, payout_multiplier_bps: _, correlation_bucket_id: _,
        sigma_bps_per_sqrt_sec: _, vault_side: _,
        touch_exposure: _, no_touch_exposure: _, touch_stakes: _, no_touch_stakes: _,
        touch_pwe: _, no_touch_pwe: _,
        status: _, fee_snapshot: _, settled_at_ms: _,
    } = market;
    object::delete(id);
}

#[test_only]
public fun set_status_for_testing<C>(market: &mut Market<C>, new_status: u8) {
    assert!(new_status <= STATUS_DNT_BROKEN, EBadStatus);
    market.status = new_status;
}
