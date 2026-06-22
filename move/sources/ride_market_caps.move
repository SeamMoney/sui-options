// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Per-market configuration + concurrent-escrow accounting for the
/// streaming-touch ride primitive (`docs/design/v2/11_ride_streaming_primitive.md`).
///
/// HACKATHON-NOTE: The spec puts `RideMarketState` as a field on `Market<C>`.
/// For hackathon speed and to avoid surgery on the existing market module
/// (just landed C.3 with 196 tests passing), we ship this as a SEPARATE
/// shared object keyed by `market_id: ID`. Same data, different storage
/// location. Can be folded into Market<C> later as a refactor.
///
/// The `public(package)` mutators are called only by `wick::ride_position`.
#[allow(deprecated_usage)]
module wick::ride_market_caps;

use sui::table::{Self, Table};
use wick::market::Market;
use wick::path_observation::PathObservation;

// === Error codes ===
const EZeroSigma: u64 = 1;
const EMinAboveMax: u64 = 2;
const EMultiplierTooLow: u64 = 3;
const ECashoutSpreadTooHigh: u64 = 4;
const EPerUserCapAboveMarketCap: u64 = 5;
const ERateTooLow: u64 = 6;
const ERateTooHigh: u64 = 7;
const ECapExceeded: u64 = 8;
const EUserCapExceeded: u64 = 9;

// === Hard bounds ===
/// Multiplier must be at least 1.0x (10_000 bps).
const MIN_MULTIPLIER_BPS: u64 = 10_000;
/// Cashout spread is capped at 20% (2_000 bps) per the constructor contract.
const MAX_CASHOUT_SPREAD_BPS: u64 = 2_000;

// === Core state ===

public struct RideMarketCaps has key {
    id: UID,
    /// The parent Market this configures.
    market_id: ID,
    /// The parent PathObservation this configures.
    path_id: ID,
    /// Set true at create — flag for `ride_position::open_ride`.
    is_streaming: bool,
    /// Min stake rate user can pick, in micro-USD/sec.
    min_stake_rate_micro_usd_per_sec: u64,
    /// Max stake rate user can pick, in micro-USD/sec.
    max_stake_rate_micro_usd_per_sec: u64,
    /// Payout multiplier on touch (e.g. 30_000 = 3.0x).
    multiplier_bps: u64,
    /// Per-second volatility in bps for `ride_pricing::bachelier_cashout_factor`.
    sigma_bps_per_sqrt_sec: u64,
    /// LP edge on voluntary cashout (e.g. 500 = 5%).
    cashout_spread_bps: u64,
    /// Vault-side cap: max sum of escrowed across all open rides on this market.
    max_concurrent_escrow: u64,
    /// Live tracker, updated on reserve/release.
    current_concurrent_escrow: u64,
    /// Anti-whale: per-address cap on this market.
    per_user_max_escrow: u64,
    /// Live per-user tracker.
    per_user_escrow: Table<address, u64>,
}

public struct RideMarketAdminCap has key, store {
    id: UID,
    caps_id: ID,
}

// === Constructor ===

/// Build a RideMarketCaps for `market` + `path`. Caller is responsible for
/// calling `share` to publish. Returns the caps + an admin cap bound to it.
///
/// Validation:
/// - `sigma_bps_per_sqrt_sec > 0` (or Bachelier pricing degenerates)
/// - `min_rate <= max_rate`
/// - `multiplier_bps >= 10_000` (at least 1.0x)
/// - `cashout_spread_bps <= 2_000` (20% hard cap)
/// - `per_user_max_escrow <= max_concurrent_escrow`
public fun new<C>(
    market: &Market<C>,
    path: &PathObservation,
    sigma_bps_per_sqrt_sec: u64,
    multiplier_bps: u64,
    max_concurrent_escrow: u64,
    per_user_max_escrow: u64,
    min_rate: u64,
    max_rate: u64,
    cashout_spread_bps: u64,
    ctx: &mut TxContext,
): (RideMarketCaps, RideMarketAdminCap) {
    assert!(sigma_bps_per_sqrt_sec > 0, EZeroSigma);
    assert!(min_rate <= max_rate, EMinAboveMax);
    assert!(multiplier_bps >= MIN_MULTIPLIER_BPS, EMultiplierTooLow);
    assert!(cashout_spread_bps <= MAX_CASHOUT_SPREAD_BPS, ECashoutSpreadTooHigh);
    assert!(per_user_max_escrow <= max_concurrent_escrow, EPerUserCapAboveMarketCap);

    let caps = RideMarketCaps {
        id: object::new(ctx),
        market_id: object::id(market),
        path_id: object::id(path),
        is_streaming: true,
        min_stake_rate_micro_usd_per_sec: min_rate,
        max_stake_rate_micro_usd_per_sec: max_rate,
        multiplier_bps,
        sigma_bps_per_sqrt_sec,
        cashout_spread_bps,
        max_concurrent_escrow,
        current_concurrent_escrow: 0,
        per_user_max_escrow,
        per_user_escrow: table::new(ctx),
    };
    let caps_id = object::id(&caps);
    let admin = RideMarketAdminCap { id: object::new(ctx), caps_id };
    (caps, admin)
}

/// Publish caps as a shared object.
public fun share(caps: RideMarketCaps) {
    transfer::share_object(caps);
}

// === Read accessors ===

public fun market_id(c: &RideMarketCaps): ID { c.market_id }
public fun path_id(c: &RideMarketCaps): ID { c.path_id }
public fun is_streaming(c: &RideMarketCaps): bool { c.is_streaming }
public fun min_stake_rate(c: &RideMarketCaps): u64 { c.min_stake_rate_micro_usd_per_sec }
public fun max_stake_rate(c: &RideMarketCaps): u64 { c.max_stake_rate_micro_usd_per_sec }
public fun multiplier_bps(c: &RideMarketCaps): u64 { c.multiplier_bps }
public fun sigma_bps_per_sqrt_sec(c: &RideMarketCaps): u64 { c.sigma_bps_per_sqrt_sec }
public fun cashout_spread_bps(c: &RideMarketCaps): u64 { c.cashout_spread_bps }
public fun max_concurrent_escrow(c: &RideMarketCaps): u64 { c.max_concurrent_escrow }
public fun current_concurrent_escrow(c: &RideMarketCaps): u64 { c.current_concurrent_escrow }
public fun per_user_max_escrow(c: &RideMarketCaps): u64 { c.per_user_max_escrow }

/// Returns the live per-user escrow for `user`. 0 if user has no entry.
public fun user_escrow(c: &RideMarketCaps, user: address): u64 {
    if (table::contains(&c.per_user_escrow, user)) {
        *table::borrow(&c.per_user_escrow, user)
    } else {
        0
    }
}

/// Assert `rate` is in `[min_stake_rate, max_stake_rate]`. Aborts with
/// `ERateTooLow` / `ERateTooHigh`.
public fun assert_rate_in_range(c: &RideMarketCaps, rate: u64) {
    assert!(rate >= c.min_stake_rate_micro_usd_per_sec, ERateTooLow);
    assert!(rate <= c.max_stake_rate_micro_usd_per_sec, ERateTooHigh);
}

// === Mutators (only `wick::ride_position` should call these) ===

/// Reserve `amount` of escrow for `user`. Bumps both the market-wide and
/// per-user trackers. Aborts `ECapExceeded` if market cap would be exceeded
/// or `EUserCapExceeded` if user cap would be exceeded.
public(package) fun reserve_escrow(
    caps: &mut RideMarketCaps,
    user: address,
    amount: u64,
    _ctx: &mut TxContext,
) {
    let new_total = caps.current_concurrent_escrow + amount;
    assert!(new_total <= caps.max_concurrent_escrow, ECapExceeded);

    let current_user = if (table::contains(&caps.per_user_escrow, user)) {
        *table::borrow(&caps.per_user_escrow, user)
    } else {
        0
    };
    let new_user = current_user + amount;
    assert!(new_user <= caps.per_user_max_escrow, EUserCapExceeded);

    caps.current_concurrent_escrow = new_total;
    if (table::contains(&caps.per_user_escrow, user)) {
        let slot = table::borrow_mut(&mut caps.per_user_escrow, user);
        *slot = new_user;
    } else {
        table::add(&mut caps.per_user_escrow, user, new_user);
    };
}

/// Release `amount` of escrow for `user`. Decrements both trackers.
/// Saturates at 0 if amount exceeds either tracker — idempotent for
/// double-close attempts at the ride_position layer.
public(package) fun release_escrow(
    caps: &mut RideMarketCaps,
    user: address,
    amount: u64,
) {
    // Market-wide tracker (saturating)
    caps.current_concurrent_escrow = if (amount >= caps.current_concurrent_escrow) {
        0
    } else {
        caps.current_concurrent_escrow - amount
    };

    // Per-user tracker (saturating)
    if (table::contains(&caps.per_user_escrow, user)) {
        let slot = table::borrow_mut(&mut caps.per_user_escrow, user);
        *slot = if (amount >= *slot) { 0 } else { *slot - amount };
    };
}

// === Test-only helpers ===

#[test_only]
/// Build a RideMarketCaps bypassing the Market/Path coupling. Useful for
/// other test files that just need a configured caps object without
/// constructing the whole world.
public fun init_for_testing(
    market_id: ID,
    path_id: ID,
    sigma_bps_per_sqrt_sec: u64,
    multiplier_bps: u64,
    max_concurrent_escrow: u64,
    per_user_max_escrow: u64,
    min_rate: u64,
    max_rate: u64,
    cashout_spread_bps: u64,
    ctx: &mut TxContext,
): (RideMarketCaps, RideMarketAdminCap) {
    let caps = RideMarketCaps {
        id: object::new(ctx),
        market_id,
        path_id,
        is_streaming: true,
        min_stake_rate_micro_usd_per_sec: min_rate,
        max_stake_rate_micro_usd_per_sec: max_rate,
        multiplier_bps,
        sigma_bps_per_sqrt_sec,
        cashout_spread_bps,
        max_concurrent_escrow,
        current_concurrent_escrow: 0,
        per_user_max_escrow,
        per_user_escrow: table::new(ctx),
    };
    let caps_id = object::id(&caps);
    let admin = RideMarketAdminCap { id: object::new(ctx), caps_id };
    (caps, admin)
}

#[test_only]
public fun test_reserve_escrow(
    caps: &mut RideMarketCaps,
    user: address,
    amount: u64,
    ctx: &mut TxContext,
) {
    reserve_escrow(caps, user, amount, ctx);
}

#[test_only]
public fun test_release_escrow(
    caps: &mut RideMarketCaps,
    user: address,
    amount: u64,
) {
    release_escrow(caps, user, amount);
}

// === Inline tests ===

#[test_only]
const ALICE: address = @0xA;
#[test_only]
const BOB: address = @0xB;

#[test_only]
fun dummy_id(addr: address): ID { object::id_from_address(addr) }

#[test]
fun new_and_share_round_trips_inputs() {
    use sui::test_scenario as ts;
    let mut sc = ts::begin(ALICE);
    let (caps, admin) = init_for_testing(
        dummy_id(@0xCAFE),  // market_id
        dummy_id(@0xBEEF),  // path_id
        100,                 // sigma_bps_per_sqrt_sec
        30_000,              // multiplier_bps (3.0x)
        1_000_000,           // max_concurrent_escrow
        100_000,             // per_user_max_escrow
        500_000,             // min_rate (0.5 USD/sec)
        10_000_000,          // max_rate (10 USD/sec)
        500,                 // cashout_spread_bps (5%)
        sc.ctx(),
    );

    assert!(market_id(&caps) == dummy_id(@0xCAFE), 1);
    assert!(path_id(&caps) == dummy_id(@0xBEEF), 2);
    assert!(is_streaming(&caps), 3);
    assert!(min_stake_rate(&caps) == 500_000, 4);
    assert!(max_stake_rate(&caps) == 10_000_000, 5);
    assert!(multiplier_bps(&caps) == 30_000, 6);
    assert!(sigma_bps_per_sqrt_sec(&caps) == 100, 7);
    assert!(cashout_spread_bps(&caps) == 500, 8);
    assert!(max_concurrent_escrow(&caps) == 1_000_000, 9);
    assert!(per_user_max_escrow(&caps) == 100_000, 10);
    assert!(current_concurrent_escrow(&caps) == 0, 11);
    assert!(user_escrow(&caps, ALICE) == 0, 12);

    share(caps);
    sui::test_utils::destroy(admin);
    sc.end();
}

#[test]
fun assert_rate_in_range_passes_at_bounds_and_midpoint() {
    use sui::test_scenario as ts;
    let mut sc = ts::begin(ALICE);
    let (caps, admin) = init_for_testing(
        dummy_id(@0xCAFE), dummy_id(@0xBEEF),
        100, 30_000, 1_000_000, 100_000, 500_000, 10_000_000, 500, sc.ctx(),
    );
    assert_rate_in_range(&caps, 500_000);    // min
    assert_rate_in_range(&caps, 10_000_000); // max
    assert_rate_in_range(&caps, 5_000_000);  // midpoint

    sui::test_utils::destroy(caps);
    sui::test_utils::destroy(admin);
    sc.end();
}

#[test]
#[expected_failure(abort_code = ERateTooLow)]
fun assert_rate_in_range_aborts_below_min() {
    use sui::test_scenario as ts;
    let mut sc = ts::begin(ALICE);
    let (caps, admin) = init_for_testing(
        dummy_id(@0xCAFE), dummy_id(@0xBEEF),
        100, 30_000, 1_000_000, 100_000, 500_000, 10_000_000, 500, sc.ctx(),
    );
    assert_rate_in_range(&caps, 499_999);
    sui::test_utils::destroy(caps);
    sui::test_utils::destroy(admin);
    sc.end();
}

#[test]
#[expected_failure(abort_code = ERateTooHigh)]
fun assert_rate_in_range_aborts_above_max() {
    use sui::test_scenario as ts;
    let mut sc = ts::begin(ALICE);
    let (caps, admin) = init_for_testing(
        dummy_id(@0xCAFE), dummy_id(@0xBEEF),
        100, 30_000, 1_000_000, 100_000, 500_000, 10_000_000, 500, sc.ctx(),
    );
    assert_rate_in_range(&caps, 10_000_001);
    sui::test_utils::destroy(caps);
    sui::test_utils::destroy(admin);
    sc.end();
}

#[test]
fun reserve_escrow_bumps_trackers() {
    use sui::test_scenario as ts;
    let mut sc = ts::begin(ALICE);
    let (mut caps, admin) = init_for_testing(
        dummy_id(@0xCAFE), dummy_id(@0xBEEF),
        100, 30_000, 1_000_000, 100_000, 500_000, 10_000_000, 500, sc.ctx(),
    );

    test_reserve_escrow(&mut caps, ALICE, 40_000, sc.ctx());
    assert!(current_concurrent_escrow(&caps) == 40_000, 1);
    assert!(user_escrow(&caps, ALICE) == 40_000, 2);

    test_reserve_escrow(&mut caps, BOB, 25_000, sc.ctx());
    assert!(current_concurrent_escrow(&caps) == 65_000, 3);
    assert!(user_escrow(&caps, ALICE) == 40_000, 4);
    assert!(user_escrow(&caps, BOB) == 25_000, 5);

    // Same-user second reserve accumulates
    test_reserve_escrow(&mut caps, ALICE, 30_000, sc.ctx());
    assert!(current_concurrent_escrow(&caps) == 95_000, 6);
    assert!(user_escrow(&caps, ALICE) == 70_000, 7);

    sui::test_utils::destroy(caps);
    sui::test_utils::destroy(admin);
    sc.end();
}

#[test]
#[expected_failure(abort_code = EUserCapExceeded)]
fun reserve_escrow_per_user_cap_aborts() {
    use sui::test_scenario as ts;
    let mut sc = ts::begin(ALICE);
    let (mut caps, admin) = init_for_testing(
        dummy_id(@0xCAFE), dummy_id(@0xBEEF),
        100, 30_000, 1_000_000, 100_000, 500_000, 10_000_000, 500, sc.ctx(),
    );
    test_reserve_escrow(&mut caps, ALICE, 60_000, sc.ctx());
    // Second reserve would push to 120_000 > 100_000 per-user cap
    test_reserve_escrow(&mut caps, ALICE, 60_000, sc.ctx());
    sui::test_utils::destroy(caps);
    sui::test_utils::destroy(admin);
    sc.end();
}

#[test]
#[expected_failure(abort_code = ECapExceeded)]
fun reserve_escrow_market_cap_aborts() {
    use sui::test_scenario as ts;
    let mut sc = ts::begin(ALICE);
    // Per-user cap == market cap so it's the market cap that bites first.
    let (mut caps, admin) = init_for_testing(
        dummy_id(@0xCAFE), dummy_id(@0xBEEF),
        100, 30_000, 100_000, 100_000, 500_000, 10_000_000, 500, sc.ctx(),
    );
    test_reserve_escrow(&mut caps, ALICE, 60_000, sc.ctx());
    test_reserve_escrow(&mut caps, BOB, 60_000, sc.ctx()); // 120k > 100k cap
    sui::test_utils::destroy(caps);
    sui::test_utils::destroy(admin);
    sc.end();
}

#[test]
fun release_escrow_returns_trackers_to_zero() {
    use sui::test_scenario as ts;
    let mut sc = ts::begin(ALICE);
    let (mut caps, admin) = init_for_testing(
        dummy_id(@0xCAFE), dummy_id(@0xBEEF),
        100, 30_000, 1_000_000, 100_000, 500_000, 10_000_000, 500, sc.ctx(),
    );
    test_reserve_escrow(&mut caps, ALICE, 40_000, sc.ctx());
    test_reserve_escrow(&mut caps, BOB, 25_000, sc.ctx());
    assert!(current_concurrent_escrow(&caps) == 65_000, 1);

    test_release_escrow(&mut caps, ALICE, 40_000);
    assert!(current_concurrent_escrow(&caps) == 25_000, 2);
    assert!(user_escrow(&caps, ALICE) == 0, 3);

    test_release_escrow(&mut caps, BOB, 25_000);
    assert!(current_concurrent_escrow(&caps) == 0, 4);
    assert!(user_escrow(&caps, BOB) == 0, 5);

    sui::test_utils::destroy(caps);
    sui::test_utils::destroy(admin);
    sc.end();
}

#[test]
fun release_escrow_saturates_on_overflow() {
    use sui::test_scenario as ts;
    let mut sc = ts::begin(ALICE);
    let (mut caps, admin) = init_for_testing(
        dummy_id(@0xCAFE), dummy_id(@0xBEEF),
        100, 30_000, 1_000_000, 100_000, 500_000, 10_000_000, 500, sc.ctx(),
    );
    test_reserve_escrow(&mut caps, ALICE, 10_000, sc.ctx());
    // Release more than reserved — must saturate, not abort.
    test_release_escrow(&mut caps, ALICE, 999_999);
    assert!(current_concurrent_escrow(&caps) == 0, 1);
    assert!(user_escrow(&caps, ALICE) == 0, 2);

    // Idempotent — second release on already-zeroed user is a no-op.
    test_release_escrow(&mut caps, ALICE, 50_000);
    assert!(current_concurrent_escrow(&caps) == 0, 3);
    assert!(user_escrow(&caps, ALICE) == 0, 4);

    // Release for a user with no entry doesn't blow up.
    test_release_escrow(&mut caps, BOB, 1_000);
    assert!(user_escrow(&caps, BOB) == 0, 5);

    sui::test_utils::destroy(caps);
    sui::test_utils::destroy(admin);
    sc.end();
}

// === Constructor validation (using the real `new` against fixtures) ===

#[test]
#[expected_failure(abort_code = EZeroSigma)]
fun new_aborts_on_zero_sigma() {
    use sui::sui::SUI;
    use sui::test_scenario as ts;
    use wick::test_helpers as th;
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, path, mkt, vault, vcap, risk_config, rcap, registry, regcap, fee_router, frcap, clk) =
        th::setup_full_world(&mut sc);

    let (caps, admin) = new<SUI>(
        &mkt, &path,
        0,        // sigma_bps_per_sqrt_sec = 0 → aborts
        30_000,
        1_000_000,
        100_000,
        500_000,
        10_000_000,
        500,
        sc.ctx(),
    );

    // Unreachable, but the harness needs cleanup paths to type-check.
    sui::test_utils::destroy(caps);
    sui::test_utils::destroy(admin);
    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(rw);
    sui::test_utils::destroy(path);
    sui::test_utils::destroy(mkt);
    sui::test_utils::destroy(vault);
    sui::test_utils::destroy(vcap);
    sui::test_utils::destroy(risk_config);
    sui::test_utils::destroy(rcap);
    sui::test_utils::destroy(registry);
    sui::test_utils::destroy(regcap);
    sui::test_utils::destroy(fee_router);
    sui::test_utils::destroy(frcap);
    sui::clock::destroy_for_testing(clk);
    sc.end();
}

#[test]
#[expected_failure(abort_code = EMinAboveMax)]
fun new_aborts_on_min_above_max() {
    use sui::sui::SUI;
    use sui::test_scenario as ts;
    use wick::test_helpers as th;
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, path, mkt, vault, vcap, risk_config, rcap, registry, regcap, fee_router, frcap, clk) =
        th::setup_full_world(&mut sc);

    let (caps, admin) = new<SUI>(
        &mkt, &path,
        100, 30_000, 1_000_000, 100_000,
        10_000_001, // min > max → aborts
        10_000_000,
        500,
        sc.ctx(),
    );

    sui::test_utils::destroy(caps);
    sui::test_utils::destroy(admin);
    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(rw);
    sui::test_utils::destroy(path);
    sui::test_utils::destroy(mkt);
    sui::test_utils::destroy(vault);
    sui::test_utils::destroy(vcap);
    sui::test_utils::destroy(risk_config);
    sui::test_utils::destroy(rcap);
    sui::test_utils::destroy(registry);
    sui::test_utils::destroy(regcap);
    sui::test_utils::destroy(fee_router);
    sui::test_utils::destroy(frcap);
    sui::clock::destroy_for_testing(clk);
    sc.end();
}

#[test]
#[expected_failure(abort_code = ECashoutSpreadTooHigh)]
fun new_aborts_on_cashout_spread_too_high() {
    use sui::sui::SUI;
    use sui::test_scenario as ts;
    use wick::test_helpers as th;
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, path, mkt, vault, vcap, risk_config, rcap, registry, regcap, fee_router, frcap, clk) =
        th::setup_full_world(&mut sc);

    let (caps, admin) = new<SUI>(
        &mkt, &path,
        100, 30_000, 1_000_000, 100_000,
        500_000, 10_000_000,
        2_001, // > 2_000 cap → aborts
        sc.ctx(),
    );

    sui::test_utils::destroy(caps);
    sui::test_utils::destroy(admin);
    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(rw);
    sui::test_utils::destroy(path);
    sui::test_utils::destroy(mkt);
    sui::test_utils::destroy(vault);
    sui::test_utils::destroy(vcap);
    sui::test_utils::destroy(risk_config);
    sui::test_utils::destroy(rcap);
    sui::test_utils::destroy(registry);
    sui::test_utils::destroy(regcap);
    sui::test_utils::destroy(fee_router);
    sui::test_utils::destroy(frcap);
    sui::clock::destroy_for_testing(clk);
    sc.end();
}

#[test]
#[expected_failure(abort_code = EMultiplierTooLow)]
fun new_aborts_on_multiplier_below_one() {
    use sui::sui::SUI;
    use sui::test_scenario as ts;
    use wick::test_helpers as th;
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, path, mkt, vault, vcap, risk_config, rcap, registry, regcap, fee_router, frcap, clk) =
        th::setup_full_world(&mut sc);

    let (caps, admin) = new<SUI>(
        &mkt, &path,
        100,
        9_999, // < 10_000 → aborts
        1_000_000, 100_000,
        500_000, 10_000_000,
        500,
        sc.ctx(),
    );

    sui::test_utils::destroy(caps);
    sui::test_utils::destroy(admin);
    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(rw);
    sui::test_utils::destroy(path);
    sui::test_utils::destroy(mkt);
    sui::test_utils::destroy(vault);
    sui::test_utils::destroy(vcap);
    sui::test_utils::destroy(risk_config);
    sui::test_utils::destroy(rcap);
    sui::test_utils::destroy(registry);
    sui::test_utils::destroy(regcap);
    sui::test_utils::destroy(fee_router);
    sui::test_utils::destroy(frcap);
    sui::clock::destroy_for_testing(clk);
    sc.end();
}

#[test]
#[expected_failure(abort_code = EPerUserCapAboveMarketCap)]
fun new_aborts_on_per_user_cap_above_market_cap() {
    use sui::sui::SUI;
    use sui::test_scenario as ts;
    use wick::test_helpers as th;
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, path, mkt, vault, vcap, risk_config, rcap, registry, regcap, fee_router, frcap, clk) =
        th::setup_full_world(&mut sc);

    let (caps, admin) = new<SUI>(
        &mkt, &path,
        100, 30_000,
        100_000,    // max_concurrent_escrow
        100_001,    // per_user_max_escrow > market cap → aborts
        500_000, 10_000_000,
        500,
        sc.ctx(),
    );

    sui::test_utils::destroy(caps);
    sui::test_utils::destroy(admin);
    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(rw);
    sui::test_utils::destroy(path);
    sui::test_utils::destroy(mkt);
    sui::test_utils::destroy(vault);
    sui::test_utils::destroy(vcap);
    sui::test_utils::destroy(risk_config);
    sui::test_utils::destroy(rcap);
    sui::test_utils::destroy(registry);
    sui::test_utils::destroy(regcap);
    sui::test_utils::destroy(fee_router);
    sui::test_utils::destroy(frcap);
    sui::clock::destroy_for_testing(clk);
    sc.end();
}

#[test]
fun new_against_real_market_round_trips() {
    use sui::sui::SUI;
    use sui::test_scenario as ts;
    use wick::test_helpers as th;
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, path, mkt, vault, vcap, risk_config, rcap, registry, regcap, fee_router, frcap, clk) =
        th::setup_full_world(&mut sc);

    let (caps, admin) = new<SUI>(
        &mkt, &path,
        100, 30_000, 1_000_000, 100_000, 500_000, 10_000_000, 500,
        sc.ctx(),
    );

    assert!(market_id(&caps) == object::id(&mkt), 1);
    assert!(path_id(&caps) == object::id(&path), 2);
    assert!(is_streaming(&caps), 3);

    share(caps);
    sui::test_utils::destroy(admin);
    sui::test_utils::destroy(oracle);
    sui::test_utils::destroy(rw);
    sui::test_utils::destroy(path);
    sui::test_utils::destroy(mkt);
    sui::test_utils::destroy(vault);
    sui::test_utils::destroy(vcap);
    sui::test_utils::destroy(risk_config);
    sui::test_utils::destroy(rcap);
    sui::test_utils::destroy(registry);
    sui::test_utils::destroy(regcap);
    sui::test_utils::destroy(fee_router);
    sui::test_utils::destroy(frcap);
    sui::clock::destroy_for_testing(clk);
    sc.end();
}
