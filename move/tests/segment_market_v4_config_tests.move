// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Bootstrap-config guards for the LIVE demo game (SegmentMarketV4). The
/// existing v4 tests build markets only with a known-good config, but
/// new_segment_market_v4 validates ~10 parameters (EInvalidConfig) so a
/// misconfigured market can never come into existence. Pin the representative
/// failure modes: a zero home price, a sub-1x payout multiplier, a max stake
/// below the min, and a zero concurrent-ride cap. The last one is the FINAL
/// config assert, so its firing also proves every prior (good) field passed.
#[test_only]
module wick::segment_market_v4_config_tests;

use sui::clock::{Self, Clock};
use sui::test_scenario as ts;
use sui::test_utils;
use sui::sui::SUI;
use wick::martingaler_vault as mv;
use wick::segment_market_v4 as sm4;

const ALICE: address = @0xA;

// Known-good baseline (copied from segment_market_v4_tests).
const HOME_PRICE: u64 = 1_000_000_000;
const VOL_REGIME_INIT: u64 = 1_000_000;
const ROUND_DURATION: u64 = 20;
const BARRIER_OFFSET_BPS: u64 = 500;
const MULTIPLIER_BPS: u64 = 20_000;
const MAX_PAYOUT_PER_ROUND: u64 = 1_500_000_000;
const DEADBAND_BPS: u64 = 20;
const SIGMA_BPS: u64 = 50;
const CASHOUT_SPREAD_BPS: u64 = 500;
const ABORT_DEADLINE_MS: u64 = 30_000;
const MIN_STAKE: u64 = 100;
const MAX_STAKE: u64 = 10_000_000;
const MAX_CONCURRENT: u64 = 100;
const MAX_PER_USER: u64 = 5;

// Bootstrap with the given overrides; every other field is the good baseline.
// Aborts inside new_segment_market_v4 on a bad config (cleanup unreachable then).
fun attempt(home: u64, mult: u64, min_s: u64, max_s: u64, max_conc: u64, clk: &Clock, sc: &mut ts::Scenario) {
    let (vault, vcap) = mv::init_for_testing<SUI>(sc.ctx());
    let market = sm4::new_segment_market_v4<SUI>(
        &vault, home, VOL_REGIME_INIT, ROUND_DURATION, BARRIER_OFFSET_BPS,
        mult, MAX_PAYOUT_PER_ROUND, DEADBAND_BPS, SIGMA_BPS, CASHOUT_SPREAD_BPS,
        ABORT_DEADLINE_MS, min_s, max_s, max_conc, MAX_PER_USER, clk, sc.ctx(),
    );
    sm4::test_only_destroy_market(market);
    test_utils::destroy(vault);
    test_utils::destroy(vcap);
}

#[test]
#[expected_failure(abort_code = sm4::EInvalidConfig, location = wick::segment_market_v4)]
fun rejects_zero_home_price() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    attempt(0, MULTIPLIER_BPS, MIN_STAKE, MAX_STAKE, MAX_CONCURRENT, &clk, &mut sc);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = sm4::EInvalidConfig, location = wick::segment_market_v4)]
fun rejects_multiplier_not_above_one_x() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    // multiplier_bps must be > BPS_DENOMINATOR (a >1x payout); 5_000 (0.5x) is invalid.
    attempt(HOME_PRICE, 5_000, MIN_STAKE, MAX_STAKE, MAX_CONCURRENT, &clk, &mut sc);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = sm4::EInvalidConfig, location = wick::segment_market_v4)]
fun rejects_max_stake_below_min_stake() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    // Swap so max (MIN_STAKE) < min (MAX_STAKE).
    attempt(HOME_PRICE, MULTIPLIER_BPS, MAX_STAKE, MIN_STAKE, MAX_CONCURRENT, &clk, &mut sc);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = sm4::EInvalidConfig, location = wick::segment_market_v4)]
fun rejects_zero_max_concurrent_rides() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    // The final config assert — its firing proves every prior baseline field passed.
    attempt(HOME_PRICE, MULTIPLIER_BPS, MIN_STAKE, MAX_STAKE, 0, &clk, &mut sc);
    clk.destroy_for_testing();
    sc.end();
}
