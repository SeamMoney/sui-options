// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Top-level orchestration for Wick Markets.
///
/// Wick is short-dated touch / no-touch options on oracle-observed barriers.
/// The product is one UX over two backends:
///
///  - **Predict-backed (BTC):** wick callers route through DeepBook Predict's
///    on-chain market — see `wick::predict_route`. (Pending; depends on
///    Predict's `main` branch shipping to testnet.)
///
///  - **Wick-native (SUI / SP500 / random-walk):** Wick owns position
///    bookkeeping in `wick::market`; collateral lives in a SHARED
///    `wick::martingaler_vault` per collateral type C. Markets bind to the
///    vault by ID at create time. Price source is pluggable via
///    `wick::wick_oracle` + a driver module.
///
/// This module exposes convenience bootstrap entrypoints — atomically build
/// (oracle, path, market) for a chosen backend in one call. Vaults are
/// provisioned separately via `bootstrap_vault`.
module wick::wick;

use std::string::String;
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::random::Random;
use wick::bot_registry::BotRegistry;
use wick::fee_router::FeeRouter;
use wick::global_exposure_registry::GlobalExposureRegistry;
use wick::market::{Self, Market};
use wick::martingaler_vault::{Self as mv, MartingalerVault, VaultAdminCap};
use wick::path_observation::{Self, PathObservation};
use wick::pull_oracle_driver::{Self, KeeperCap, PullFeed};
use wick::random_walk_driver::{Self, RandomWalk};
use wick::risk_config::RiskConfig;
use wick::segment_market::{Self as sm, SegmentMarket, SegmentRidePosition};
// v3 re-exports temporarily disabled for this upgrade — segment_market_v3.move
// stashed to move/sources-stash/ because the combined package size (v2 + v3 +
// v4 + sponsor + prune_proto) exceeded the Sui MovePackageTooBig 102_400-byte
// per-package limit (was 115_023). The v4 module replicates v3's
// prune_settled_segments + record_walrus_archive entry points, so the v3 track
// is shippable in a follow-up upgrade once we split the workspace into
// multiple Move packages. Restore: mv move/sources-stash/segment_market_v3.move
// move/sources/ + uncomment the use-line and the v3 re-export block below.
// use wick::segment_market_v3::{Self as sm3, SegmentMarketV3, SegmentRidePositionV3};
use wick::segment_market_v4::{Self as sm4, SegmentMarketV4, SegmentRidePositionV4};
use wick::usd_price_oracle::UsdPriceOracle;
use wick::wick_oracle::WickOracle;
use wick::wick_staking::WickStakingPool;
use wick::wick_token::WickTokenState;

// === Vault provisioning (one per collateral type C) ===

/// Bootstrap a MartingalerVault<C> for a collateral type. Returns the
/// VaultAdminCap to the sender. The vault is shared and ID is emitted via
/// `mv::VaultInitialized`.
public entry fun bootstrap_vault<C>(ctx: &mut TxContext) {
    let (cap, _vault_id) = mv::init_vault<C>(ctx);
    transfer::public_transfer(cap, tx_context::sender(ctx));
}

/// Seed an existing vault with initial liquidity (admin protocol bootstrap).
/// Routes through deposit_open which does the auto-harvest dance — same as
/// any trader-deposit, just funded by admin. Use this to pre-fund a fresh
/// vault before opening the first market.
public entry fun seed_vault<C>(
    vault: &mut MartingalerVault<C>,
    seed: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    if (seed.value() == 0) {
        coin::destroy_zero(seed);
        return
    };
    mv::deposit_open(vault, seed, clock, ctx);
}

// === Market bootstraps ===

/// Bootstrap a Wick-native arcade market backed by a synthetic random walk.
/// Atomically creates: oracle → random walk driver → path observation →
/// market. The vault is referenced (not consumed) — must already exist.
/// All three new objects are shared.
public entry fun bootstrap_random_walk_market<C>(
    name: String,
    underlying: String,
    starting_price: u64,
    vol_bps: u64,
    barrier: u64,
    direction: u8,
    expiry_ms: u64,
    settlement_freshness_ms: u64,
    payout_multiplier_bps: u64,
    correlation_bucket_id: u8,
    // Side reserved for the vault as natural counterparty. For arcade
    // markets pass `market::side_no_touch()` (1) so traders only open
    // TOUCH; pass `market::vault_side_none()` (255) to allow both sides.
    // See docs/design/v2/15_montecarlo_validation_report.md for the
    // solvency analysis that drove this gate.
    vault_side: u8,
    vault: &MartingalerVault<C>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let (oracle, rw) = random_walk_driver::create_market(
        underlying,
        starting_price,
        vol_bps,
        expiry_ms,
        settlement_freshness_ms,
        clock,
        ctx,
    );
    let path = path_observation::new(&oracle, barrier, direction, ctx);
    let market = market::create_v4<C>(
        name, &oracle, &path, vault, payout_multiplier_bps, correlation_bucket_id,
        market::default_sigma_bps_per_sqrt_sec(), vault_side, ctx,
    );
    market::share(market);
    path_observation::share(path);
    random_walk_driver::share(rw);
    wick::wick_oracle::share(oracle);
}

/// Bootstrap a Wick-native market backed by a keeper-pushed price feed.
/// Used for SUI and SP500 underlyings — feed updates pushed via
/// `pull_oracle_driver::push_price` by the keeper holding `KeeperCap`.
public entry fun bootstrap_pull_market<C>(
    name: String,
    underlying: String,
    upstream_id: String,
    keeper_cap: &KeeperCap,
    barrier: u64,
    direction: u8,
    expiry_ms: u64,
    settlement_freshness_ms: u64,
    payout_multiplier_bps: u64,
    correlation_bucket_id: u8,
    // See `bootstrap_random_walk_market`. For BTC / ETH / SUI / SP500
    // arcade-style touch markets pass `market::side_no_touch()`.
    vault_side: u8,
    vault: &MartingalerVault<C>,
    ctx: &mut TxContext,
) {
    let (oracle, feed) = pull_oracle_driver::create_market(
        underlying,
        upstream_id,
        keeper_cap,
        expiry_ms,
        settlement_freshness_ms,
        ctx,
    );
    let path = path_observation::new(&oracle, barrier, direction, ctx);
    let market = market::create_v4<C>(
        name, &oracle, &path, vault, payout_multiplier_bps, correlation_bucket_id,
        market::default_sigma_bps_per_sqrt_sec(), vault_side, ctx,
    );
    market::share(market);
    path_observation::share(path);
    pull_oracle_driver::share_feed(feed);
    wick::wick_oracle::share(oracle);
}

// === SDK convenience re-exports ===

public fun open_touch<C>(
    market: &mut Market<C>,
    vault: &mut MartingalerVault<C>,
    risk_config: &RiskConfig,
    registry: &mut GlobalExposureRegistry,
    bot_registry: &BotRegistry,
    path: &PathObservation,
    stake: Coin<C>,
    spot: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): wick::market::Position {
    market::open<C>(
        market, vault, risk_config, registry, bot_registry, path,
        market::side_touch(), stake, spot, clock, ctx,
    )
}

public fun open_no_touch<C>(
    market: &mut Market<C>,
    vault: &mut MartingalerVault<C>,
    risk_config: &RiskConfig,
    registry: &mut GlobalExposureRegistry,
    bot_registry: &BotRegistry,
    path: &PathObservation,
    stake: Coin<C>,
    spot: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): wick::market::Position {
    market::open<C>(
        market, vault, risk_config, registry, bot_registry, path,
        market::side_no_touch(), stake, spot, clock, ctx,
    )
}

public fun redeem<C>(
    market: &mut Market<C>,
    vault: &mut MartingalerVault<C>,
    risk_config: &RiskConfig,
    fee_router: &mut FeeRouter<C>,
    wick_state: &mut WickTokenState,
    staking_pool: &mut WickStakingPool,
    price_oracle: &UsdPriceOracle,
    position: wick::market::Position,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    market::redeem<C>(
        market, vault, risk_config, fee_router, wick_state, staking_pool,
        price_oracle, position, clock, ctx,
    )
}

/// Permissionless atomic settlement entry — anyone can crank past
/// `expiry + drain_ms`.
public fun lock_and_settle<C>(
    market: &mut Market<C>,
    vault: &mut MartingalerVault<C>,
    path: &mut PathObservation,
    oracle: &mut WickOracle,
    registry: &mut GlobalExposureRegistry,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    market::lock_and_settle<C>(market, vault, path, oracle, registry, clock, ctx)
}

/// Admin: recover stranded seed from an Aborted market's refund pool.
/// Only callable post-Aborted; routes residue back to vault.treasury (anti-rug).
public fun recover_aborted_seed<C>(
    cap: &VaultAdminCap,
    vault: &mut MartingalerVault<C>,
    market: &Market<C>,
) {
    mv::admin_recover_aborted_seed<C>(cap, vault, object::id(market))
}

// === Ride primitive — SDK re-exports ===
//
// Wick-native streaming touch options per `docs/design/v2/11_ride_streaming_primitive.md`.
// Rides require a `wick::ride_market_caps::RideMarketCaps` shared object
// gating sigma/multiplier/escrow-caps per market. Discrete markets are
// unaffected.

public fun open_ride<C>(
    caps: &mut wick::ride_market_caps::RideMarketCaps,
    path: &PathObservation,
    vault: &mut MartingalerVault<C>,
    bot_registry: &BotRegistry,
    rate_micro_usd_per_sec: u64,
    escrow: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): wick::ride_position::RidePosition {
    wick::ride_position::open_ride<C>(
        caps, path, vault, bot_registry, rate_micro_usd_per_sec, escrow, clock, ctx,
    )
}

public fun close_ride<C>(
    ride: &mut wick::ride_position::RidePosition,
    caps: &mut wick::ride_market_caps::RideMarketCaps,
    path: &PathObservation,
    oracle: &wick::wick_oracle::WickOracle,
    vault: &mut MartingalerVault<C>,
    price_oracle: &UsdPriceOracle,
    token_state: &mut WickTokenState,
    staking_pool: &mut WickStakingPool,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    wick::ride_position::close_ride<C>(
        ride, caps, path, oracle, vault, price_oracle, token_state, staking_pool, clock, ctx,
    )
}

public fun crank_expired_ride<C>(
    ride: &mut wick::ride_position::RidePosition,
    caps: &mut wick::ride_market_caps::RideMarketCaps,
    path: &PathObservation,
    vault: &mut MartingalerVault<C>,
    price_oracle: &UsdPriceOracle,
    token_state: &mut WickTokenState,
    staking_pool: &mut WickStakingPool,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    wick::ride_position::crank_expired_ride<C>(
        ride, caps, path, vault, price_oracle, token_state, staking_pool, clock, ctx,
    )
}

// === Segment-market arcade (round-based shared barrier grid) ===
//
// Provably-fair arcade per docs/design/v2/18 + 19. The segment-market
// arcade is a PARALLEL track to the legacy ride_position arcade — both
// coexist; nothing about the legacy entrypoints changes here.
//
// `record_segment` is `entry` (not `public`) per doc 17a §1.4 — Sui's
// verifier forbids `public` on functions taking `&Random`. The keeper /
// frontend invokes it directly as a MoveCall; Sui's PTB-command rule
// (only TransferObjects / MergeCoins after a Random MoveCall) closes the
// test-and-abort grinder structurally.

/// Admin bootstrap: construct + share a SegmentMarket<C>. Returns nothing;
/// market ID is in the emitted `SegmentMarketCreated` event.
public entry fun bootstrap_segment_market<C>(
    home_price: u64,
    vol_regime_init: u64,
    round_duration_segments: u64,
    open_window_segments: u64,
    barrier_offset_bps: u64,
    multiplier_bps: u64,
    max_payout_per_barrier: u64,
    deadband_bps: u64,
    sigma_bps_per_sqrt_sec: u64,
    cashout_spread_bps: u64,
    abort_segment_deadline_ms: u64,
    min_stake_per_segment: u64,
    max_stake_per_segment: u64,
    max_concurrent_rides: u64,
    max_rides_per_user: u64,
    vault: &MartingalerVault<C>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let market = sm::new_segment_market<C>(
        vault,
        home_price,
        vol_regime_init,
        round_duration_segments,
        open_window_segments,
        barrier_offset_bps,
        multiplier_bps,
        max_payout_per_barrier,
        deadband_bps,
        sigma_bps_per_sqrt_sec,
        cashout_spread_bps,
        abort_segment_deadline_ms,
        min_stake_per_segment,
        max_stake_per_segment,
        max_concurrent_rides,
        max_rides_per_user,
        clock,
        ctx,
    );
    sm::share_segment_market<C>(market);
}

/// Permissionless cranker entry — anyone (keeper or rider) calls this to
/// record one segment. Wake-gated on `active_ride_count > 0`.
public entry fun record_segment<C>(
    market: &mut SegmentMarket<C>,
    r: &Random,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    sm::record_segment<C>(market, r, clock, ctx);
}

public fun open_segment_ride<C>(
    market: &mut SegmentMarket<C>,
    vault: &mut MartingalerVault<C>,
    bot_registry: &BotRegistry,
    barrier_index: u8,
    stake_per_segment: u64,
    escrow: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): SegmentRidePosition {
    sm::open_segment_ride<C>(
        market, vault, bot_registry, barrier_index,
        stake_per_segment, escrow, clock, ctx,
    )
}

public fun close_segment_ride<C>(
    ride: &mut SegmentRidePosition,
    market: &mut SegmentMarket<C>,
    vault: &mut MartingalerVault<C>,
    price_oracle: &UsdPriceOracle,
    token_state: &mut WickTokenState,
    staking_pool: &mut WickStakingPool,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    sm::close_segment_ride<C>(
        ride, market, vault, price_oracle, token_state, staking_pool, clock, ctx,
    )
}

public fun crank_expired_segment_ride<C>(
    ride: &mut SegmentRidePosition,
    market: &mut SegmentMarket<C>,
    vault: &mut MartingalerVault<C>,
    price_oracle: &UsdPriceOracle,
    token_state: &mut WickTokenState,
    staking_pool: &mut WickStakingPool,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    sm::crank_expired_segment_ride<C>(
        ride, market, vault, price_oracle, token_state, staking_pool, clock, ctx,
    )
}

public fun abort_segment_ride<C>(
    ride: &mut SegmentRidePosition,
    market: &mut SegmentMarket<C>,
    vault: &mut MartingalerVault<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    sm::abort_segment_ride<C>(ride, market, vault, clock, ctx)
}

// === Segment-market arcade v3 — SDK re-exports ===
//
// TEMPORARILY DISABLED for this upgrade. The combined package size
// exceeded Sui's MovePackageTooBig 102_400-byte limit (115_023 bytes), so
// segment_market_v3.move has been stashed to move/sources-stash/ and
// these re-exports are block-commented. v4 inherits prune_settled_segments
// + record_walrus_archive functionality (see v4 section below), so no
// product feature is lost. Restore: move the file back + un-comment.
/*
/// Admin bootstrap: construct + share a SegmentMarketV3<C>.
public entry fun bootstrap_segment_market_v3<C>(
    home_price: u64,
    vol_regime_init: u64,
    round_duration_segments: u64,
    open_window_segments: u64,
    barrier_offset_bps: u64,
    multiplier_bps: u64,
    max_payout_per_barrier: u64,
    deadband_bps: u64,
    sigma_bps_per_sqrt_sec: u64,
    cashout_spread_bps: u64,
    abort_segment_deadline_ms: u64,
    min_stake_per_segment: u64,
    max_stake_per_segment: u64,
    max_concurrent_rides: u64,
    max_rides_per_user: u64,
    vault: &MartingalerVault<C>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let market = sm3::new_segment_market_v3<C>(
        vault,
        home_price,
        vol_regime_init,
        round_duration_segments,
        open_window_segments,
        barrier_offset_bps,
        multiplier_bps,
        max_payout_per_barrier,
        deadband_bps,
        sigma_bps_per_sqrt_sec,
        cashout_spread_bps,
        abort_segment_deadline_ms,
        min_stake_per_segment,
        max_stake_per_segment,
        max_concurrent_rides,
        max_rides_per_user,
        clock,
        ctx,
    );
    sm3::share_segment_market_v3<C>(market);
}

/// Permissionless v3 cranker entry — `record_segment` on a v3 market.
public entry fun record_segment_v3<C>(
    market: &mut SegmentMarketV3<C>,
    r: &Random,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    sm3::record_segment<C>(market, r, clock, ctx);
}

public fun open_segment_ride_v3<C>(
    market: &mut SegmentMarketV3<C>,
    vault: &mut MartingalerVault<C>,
    bot_registry: &BotRegistry,
    barrier_index: u8,
    stake_per_segment: u64,
    escrow: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): SegmentRidePositionV3 {
    sm3::open_segment_ride_v3<C>(
        market, vault, bot_registry, barrier_index,
        stake_per_segment, escrow, clock, ctx,
    )
}

public fun close_segment_ride_v3<C>(
    ride: &mut SegmentRidePositionV3,
    market: &mut SegmentMarketV3<C>,
    vault: &mut MartingalerVault<C>,
    price_oracle: &UsdPriceOracle,
    token_state: &mut WickTokenState,
    staking_pool: &mut WickStakingPool,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    sm3::close_segment_ride_v3<C>(
        ride, market, vault, price_oracle, token_state, staking_pool, clock, ctx,
    )
}

public fun crank_expired_segment_ride_v3<C>(
    ride: &mut SegmentRidePositionV3,
    market: &mut SegmentMarketV3<C>,
    vault: &mut MartingalerVault<C>,
    price_oracle: &UsdPriceOracle,
    token_state: &mut WickTokenState,
    staking_pool: &mut WickStakingPool,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    sm3::crank_expired_segment_ride_v3<C>(
        ride, market, vault, price_oracle, token_state, staking_pool, clock, ctx,
    )
}

public fun abort_segment_ride_v3<C>(
    ride: &mut SegmentRidePositionV3,
    market: &mut SegmentMarketV3<C>,
    vault: &mut MartingalerVault<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    sm3::abort_segment_ride_v3<C>(ride, market, vault, clock, ctx)
}

/// Permissionless. Record the Walrus blob ID for a round's archive
/// (doc 24 §5). Archiver bots call this after writing the BCS blob to
/// Walrus and BEFORE `prune_settled_segments_v3` for the same round.
public entry fun record_walrus_archive_v3<C>(
    market: &mut SegmentMarketV3<C>,
    round_index: u64,
    walrus_blob_id: vector<u8>,
    ctx: &mut TxContext,
) {
    sm3::record_walrus_archive<C>(market, round_index, walrus_blob_id, ctx);
}

/// Permissionless. Delete a settled round's SegmentRecord rows; caller
/// pockets the storage rebate (doc 23 §3.2). Gated on
/// SETTLEMENT_LAG_ROUNDS, zero unsettled rides, no prior prune for
/// the round, and presence of a Walrus archive entry.
public entry fun prune_settled_segments_v3<C>(
    market: &mut SegmentMarketV3<C>,
    round_index: u64,
    ctx: &mut TxContext,
) {
    sm3::prune_settled_segments<C>(market, round_index, ctx);
}
*/

// === Segment-market arcade v4 — SDK re-exports ===
//
// Per docs/design/v2/25_touch_either_laser_v3.md. v4 is the touch-either
// + always-open variant that replaces v3's barrier-pick mechanic:
//   - `open_segment_ride_v4` takes NO `barrier_index` — rides are
//     direction-neutral, both barriers snapshotted at open, touch on
//     EITHER side wins the jackpot.
//   - No `open_window_segments` — every segment in the round accepts new
//     opens (front-running concern doesn't apply to a volatility bet).
//   - `max_payout_per_round` replaces v3's per-side `max_payout_per_barrier`.
//
// v4 ships ALONGSIDE v2 + v3. Existing testnet markets keep working;
// new bootstraps wire through these entries.

/// Admin bootstrap: construct + share a SegmentMarketV4<C>.
///
/// v4 parameter contract differs from v3:
///   - DROPPED `open_window_segments` (no window)
///   - RENAMED `max_payout_per_barrier` → `max_payout_per_round`
public entry fun bootstrap_segment_market_v4<C>(
    home_price: u64,
    vol_regime_init: u64,
    round_duration_segments: u64,
    barrier_offset_bps: u64,
    multiplier_bps: u64,
    max_payout_per_round: u64,
    deadband_bps: u64,
    sigma_bps_per_sqrt_sec: u64,
    cashout_spread_bps: u64,
    abort_segment_deadline_ms: u64,
    min_stake_per_segment: u64,
    max_stake_per_segment: u64,
    max_concurrent_rides: u64,
    max_rides_per_user: u64,
    vault: &MartingalerVault<C>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let market = sm4::new_segment_market_v4<C>(
        vault,
        home_price,
        vol_regime_init,
        round_duration_segments,
        barrier_offset_bps,
        multiplier_bps,
        max_payout_per_round,
        deadband_bps,
        sigma_bps_per_sqrt_sec,
        cashout_spread_bps,
        abort_segment_deadline_ms,
        min_stake_per_segment,
        max_stake_per_segment,
        max_concurrent_rides,
        max_rides_per_user,
        clock,
        ctx,
    );
    sm4::share_segment_market_v4<C>(market);
}

/// v4.26 — opt the market into the rug-pull house-edge mechanism (doc 26).
///
/// Installs a `RugConfig` dynamic field on the market under the key
/// `b"rug_config"`. Once enabled, every `record_segment_v4` call rolls a
/// deterministic dice; with probability `rug_chance_bps / 10_000` the
/// rug fires and pre-rug rides settle as `EXPIRED_LOSS` on close.
///
/// This is a separate entry rather than a parameter on
/// `bootstrap_segment_market_v4` so the v4 → v4.26 Move upgrade can ship
/// under Sui's COMPATIBLE policy (changing the bootstrap signature would
/// be rejected by the upgrade validator).
///
/// Aborts:
///   - `sm4::ERugAlreadyEnabled` (25) if called twice.
///   - `sm4::EInvalidConfig` (15) if `rug_chance_bps > 10_000`.
public entry fun enable_rug<C>(
    market: &mut SegmentMarketV4<C>,
    rug_chance_bps: u64,
) {
    sm4::enable_rug<C>(market, rug_chance_bps);
}

/// Permissionless v4 cranker entry — `record_segment` on a v4 market.
public entry fun record_segment_v4<C>(
    market: &mut SegmentMarketV4<C>,
    r: &Random,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    sm4::record_segment<C>(market, r, clock, ctx);
}

/// v4: Open a touch-either ride. No `barrier_index` — touch on EITHER
/// barrier wins.
public fun open_segment_ride_v4<C>(
    market: &mut SegmentMarketV4<C>,
    vault: &mut MartingalerVault<C>,
    bot_registry: &BotRegistry,
    stake_per_segment: u64,
    escrow: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): SegmentRidePositionV4 {
    sm4::open_segment_ride_v4<C>(
        market, vault, bot_registry,
        stake_per_segment, escrow, clock, ctx,
    )
}

public fun close_segment_ride_v4<C>(
    ride: &mut SegmentRidePositionV4,
    market: &mut SegmentMarketV4<C>,
    vault: &mut MartingalerVault<C>,
    price_oracle: &UsdPriceOracle,
    token_state: &mut WickTokenState,
    staking_pool: &mut WickStakingPool,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    sm4::close_segment_ride_v4<C>(
        ride, market, vault, price_oracle, token_state, staking_pool, clock, ctx,
    )
}

public fun crank_expired_segment_ride_v4<C>(
    ride: &mut SegmentRidePositionV4,
    market: &mut SegmentMarketV4<C>,
    vault: &mut MartingalerVault<C>,
    price_oracle: &UsdPriceOracle,
    token_state: &mut WickTokenState,
    staking_pool: &mut WickStakingPool,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    sm4::crank_expired_segment_ride_v4<C>(
        ride, market, vault, price_oracle, token_state, staking_pool, clock, ctx,
    )
}

public fun abort_segment_ride_v4<C>(
    ride: &mut SegmentRidePositionV4,
    market: &mut SegmentMarketV4<C>,
    vault: &mut MartingalerVault<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    sm4::abort_segment_ride_v4<C>(ride, market, vault, clock, ctx)
}

/// v4 mirror of v3 record_walrus_archive — permissionless.
public entry fun record_walrus_archive_v4<C>(
    market: &mut SegmentMarketV4<C>,
    round_index: u64,
    walrus_blob_id: vector<u8>,
    ctx: &mut TxContext,
) {
    sm4::record_walrus_archive<C>(market, round_index, walrus_blob_id, ctx);
}

/// v4 mirror of v3 prune_settled_segments — permissionless, caller pockets
/// the storage rebate.
public entry fun prune_settled_segments_v4<C>(
    market: &mut SegmentMarketV4<C>,
    round_index: u64,
    ctx: &mut TxContext,
) {
    sm4::prune_settled_segments<C>(market, round_index, ctx);
}

// === Sponsored cranking (v3.1) — SDK re-export ===
//
// Per docs/design/v2/22_sponsored_cranking_v3.md §3.1. Sponsored txs let
// the user sign intent from their burner while a protocol-funded sponsor
// wallet pays the gas. `harvest_to_sponsor` is the on-chain refill path:
// permissionless, threshold + daily-cap gated, drains from
// `fee_router::protocol_pending` into the sponsor wallet. Admin tweaks
// (cap, address, targets, reset) live in `wick::sponsor` directly under
// `SponsorCap`; only the harvest is mirrored here for the SDK.

public entry fun harvest_to_sponsor(
    policy: &mut wick::sponsor::SponsorPolicy,
    fee_router: &mut FeeRouter<sui::sui::SUI>,
    current_sponsor_balance_mist: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    wick::sponsor::harvest_to_sponsor(
        policy, fee_router, current_sponsor_balance_mist, clock, ctx,
    );
}

#[test_only]
public fun share_random_walk_for_testing(rw: RandomWalk) {
    random_walk_driver::share(rw);
}

#[test_only]
public fun share_pull_feed_for_testing(feed: PullFeed) {
    pull_oracle_driver::share_feed(feed);
}
