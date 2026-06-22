// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Tests for the ride exposure + stake-rate caps. RideMarketCaps bounds how
/// much escrow can be concurrently at risk on a streaming market — per market
/// and per user — and clamps the stake rate. These guards are the loss-of-funds
/// backstop for /ride: without them a single user (or the whole book) could
/// over-expose the vault. The existing ride tests only exercise the happy path,
/// so pin the four guards and the reserve/release tracker conservation directly.
#[test_only]
module wick::ride_market_caps_tests;

use wick::ride_market_caps as rmc;
use sui::test_scenario as ts;
use sui::test_utils;

const ALICE: address = @0xA;
const BOB: address = @0xB;
const MAX_CONCURRENT: u64 = 1_000;
const PER_USER: u64 = 400;
const MIN_RATE: u64 = 10;
const MAX_RATE: u64 = 100;

fun mk_caps(sc: &mut ts::Scenario): (rmc::RideMarketCaps, rmc::RideMarketAdminCap) {
    rmc::init_for_testing(
        object::id_from_address(@0x111), // market_id (stub)
        object::id_from_address(@0x222), // path_id (stub)
        500,            // sigma_bps_per_sqrt_sec
        15_000,         // multiplier_bps
        MAX_CONCURRENT,
        PER_USER,
        MIN_RATE,
        MAX_RATE,
        50,             // cashout_spread_bps
        sc.ctx(),
    )
}

#[test]
fun rate_in_range_accepts_both_boundaries() {
    let mut sc = ts::begin(ALICE);
    let (caps, admin) = mk_caps(&mut sc);
    rmc::assert_rate_in_range(&caps, MIN_RATE); // inclusive low
    rmc::assert_rate_in_range(&caps, MAX_RATE); // inclusive high
    test_utils::destroy(caps); test_utils::destroy(admin);
    sc.end();
}

#[test]
#[expected_failure(abort_code = 6, location = wick::ride_market_caps)]
fun rate_below_min_aborts() {
    let mut sc = ts::begin(ALICE);
    let (caps, admin) = mk_caps(&mut sc);
    rmc::assert_rate_in_range(&caps, MIN_RATE - 1); // ERateTooLow
    test_utils::destroy(caps); test_utils::destroy(admin); // unreachable
    sc.end();
}

#[test]
#[expected_failure(abort_code = 7, location = wick::ride_market_caps)]
fun rate_above_max_aborts() {
    let mut sc = ts::begin(ALICE);
    let (caps, admin) = mk_caps(&mut sc);
    rmc::assert_rate_in_range(&caps, MAX_RATE + 1); // ERateTooHigh
    test_utils::destroy(caps); test_utils::destroy(admin); // unreachable
    sc.end();
}

#[test]
fun reserve_then_release_conserves_both_trackers() {
    let mut sc = ts::begin(ALICE);
    let (mut caps, admin) = mk_caps(&mut sc);

    rmc::reserve_escrow(&mut caps, ALICE, 300, sc.ctx());
    assert!(rmc::current_concurrent_escrow(&caps) == 300, 0);
    assert!(rmc::user_escrow(&caps, ALICE) == 300, 1);

    rmc::release_escrow(&mut caps, ALICE, 300);
    assert!(rmc::current_concurrent_escrow(&caps) == 0, 2);
    assert!(rmc::user_escrow(&caps, ALICE) == 0, 3);

    test_utils::destroy(caps); test_utils::destroy(admin);
    sc.end();
}

#[test]
#[expected_failure(abort_code = 8, location = wick::ride_market_caps)]
fun reserve_over_market_cap_aborts() {
    let mut sc = ts::begin(ALICE);
    let (mut caps, admin) = mk_caps(&mut sc);
    // Exceeds the market-wide concurrent cap (checked before the per-user cap).
    rmc::reserve_escrow(&mut caps, BOB, MAX_CONCURRENT + 1, sc.ctx()); // ECapExceeded
    test_utils::destroy(caps); test_utils::destroy(admin); // unreachable
    sc.end();
}

#[test]
#[expected_failure(abort_code = 9, location = wick::ride_market_caps)]
fun reserve_over_user_cap_aborts() {
    let mut sc = ts::begin(ALICE);
    let (mut caps, admin) = mk_caps(&mut sc);
    // Up to the per-user cap is fine (and under the market cap)...
    rmc::reserve_escrow(&mut caps, ALICE, PER_USER, sc.ctx());
    // ...one more unit exceeds the per-user cap while still under the market
    // cap → EUserCapExceeded (proves the per-user check isn't masked by the market one).
    rmc::reserve_escrow(&mut caps, ALICE, 1, sc.ctx());
    test_utils::destroy(caps); test_utils::destroy(admin); // unreachable
    sc.end();
}
