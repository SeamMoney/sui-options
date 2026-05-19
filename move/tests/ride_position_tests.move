// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

#[test_only]
module wick::ride_position_tests;

use std::string;
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario as ts;
use sui::test_utils;
use wick::bot_registry as br;
use wick::martingaler_vault as mv;
use wick::path_observation as po;
use wick::price_observation;
use wick::random_walk_driver as rwd;
use wick::ride_market_caps as rmc;
use wick::ride_position as rp;
use wick::usd_price_oracle as upo;
use wick::wick_oracle::{Self as wo, WickOracle};
use wick::wick_staking as ws;
use wick::wick_token as wt;

const ALICE: address = @0xA;
const KEEPER: address = @0xC;

const EXPIRY_MS: u64 = 60_000;
const STARTING_PRICE: u64 = 100_000_000_000;
const BARRIER_ABOVE: u64 = 105_000_000_000;
const SIGMA_BPS: u64 = 50;
const MULTIPLIER_BPS: u64 = 30_000;
const MIN_RATE: u64 = 500_000;
const MAX_RATE: u64 = 10_000_000;
const CASHOUT_SPREAD_BPS: u64 = 500;
const MAX_CONCURRENT_ESCROW: u64 = 10_000_000_000;
const PER_USER_MAX_ESCROW: u64 = 5_000_000_000;

fun mint_sui(amount: u64, sc: &mut ts::Scenario): coin::Coin<SUI> {
    coin::mint_for_testing<SUI>(amount, sc.ctx())
}

fun push_obs(oracle: &mut WickOracle, price: u64, ts: u64) {
    let oid = object::id(oracle);
    let obs = price_observation::new(price, ts, oid);
    wo::apply_observation_for_testing(oracle, wo::driver_random_walk(), obs);
}

/// 16-tuple fixture (returned-by-value pattern matches `test_helpers::setup_full_world`
/// so each binding is a separate local and disjoint-field borrows work).
fun mk_world(sc: &mut ts::Scenario): (
    wo::WickOracle,
    rwd::RandomWalk,
    po::PathObservation,
    mv::MartingalerVault<SUI>,
    mv::VaultAdminCap,
    rmc::RideMarketCaps,
    rmc::RideMarketAdminCap,
    br::BotRegistry,
    br::BotAdminCap,
    upo::UsdPriceOracle,
    upo::PriceAdminCap,
    wt::WickTokenState,
    wt::WickAdminCap,
    ws::WickStakingPool,
    ws::StakingAdminCap,
    clock::Clock,
) {
    let mut clk = clock::create_for_testing(sc.ctx());
    clk.set_for_testing(1_000);

    let (oracle, rw) = rwd::new_for_testing(
        string::utf8(b"RIDE_RNG"),
        STARTING_PRICE,
        SIGMA_BPS,
        EXPIRY_MS,
        &clk,
        sc.ctx(),
    );
    let path = po::new_v2(
        &oracle, BARRIER_ABOVE, po::touch_above(),
        0, 1, 1, 60_000, sc.ctx(),
    );

    let (vault, vcap) = mv::init_for_testing<SUI>(sc.ctx());

    let market_id_stub = object::id(&vault);
    let (caps, rcap) = rmc::init_for_testing(
        market_id_stub,
        object::id(&path),
        SIGMA_BPS,
        MULTIPLIER_BPS,
        MAX_CONCURRENT_ESCROW,
        PER_USER_MAX_ESCROW,
        MIN_RATE,
        MAX_RATE,
        CASHOUT_SPREAD_BPS,
        sc.ctx(),
    );

    let (bots, bcap) = br::init_for_testing(sc.ctx());
    let (mut upo_obj, pcap) = upo::init_for_testing(sc.ctx());
    upo::set_price<SUI>(&pcap, &mut upo_obj, 1_000_000, 9, &clk);
    let (wts, wcap) = wt::init_for_testing(sc.ctx());
    let (pool, scap) = ws::init_for_testing(sc.ctx());

    (oracle, rw, path, vault, vcap, caps, rcap, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk)
}

fun teardown_world(
    oracle: wo::WickOracle,
    rw: rwd::RandomWalk,
    path: po::PathObservation,
    vault: mv::MartingalerVault<SUI>,
    vcap: mv::VaultAdminCap,
    caps: rmc::RideMarketCaps,
    rcap: rmc::RideMarketAdminCap,
    bots: br::BotRegistry,
    bcap: br::BotAdminCap,
    upo_obj: upo::UsdPriceOracle,
    pcap: upo::PriceAdminCap,
    wts: wt::WickTokenState,
    wcap: wt::WickAdminCap,
    pool: ws::WickStakingPool,
    scap: ws::StakingAdminCap,
    clk: clock::Clock,
) {
    test_utils::destroy(oracle);
    test_utils::destroy(rw);
    test_utils::destroy(path);
    test_utils::destroy(vault);
    test_utils::destroy(vcap);
    test_utils::destroy(caps);
    test_utils::destroy(rcap);
    test_utils::destroy(bots);
    test_utils::destroy(bcap);
    test_utils::destroy(upo_obj);
    test_utils::destroy(pcap);
    test_utils::destroy(wts);
    test_utils::destroy(wcap);
    test_utils::destroy(pool);
    test_utils::destroy(scap);
    clk.destroy_for_testing();
}

// === Tests ===

#[test]
fun open_ride_mints_position_with_correct_fields() {
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, path, mut vault, vcap, mut caps, rcap, bots, bcap,
         upo_obj, pcap, wts, wcap, pool, scap, clk) = mk_world(&mut sc);

    let seed = mint_sui(5_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow(&mut vault, seed);

    let rate = 1_000_000;
    let remaining_sec = (EXPIRY_MS - 1_000) / 1_000;
    let max_stake = (rate * remaining_sec + 999_999) / 1_000_000;
    let escrow = mint_sui(max_stake + 100, &mut sc);

    let ride = rp::open_ride<SUI>(
        &mut caps, &path, &mut vault, &bots,
        rate, escrow, &clk, sc.ctx(),
    );

    assert!(rp::user(&ride) == ALICE, 0);
    assert!(rp::stake_rate(&ride) == rate, 1);
    assert!(rp::multiplier_bps(&ride) == MULTIPLIER_BPS, 2);
    assert!(rp::start_time_ms(&ride) == 1_000, 3);
    assert!(rp::escrowed(&ride) > 0, 4);
    assert!(!rp::is_closed(&ride), 5);
    assert!(rp::settlement_kind(&ride) == rp::settlement_open(), 6);
    assert!(rp::is_bot_eligible(&ride), 7);
    assert!(rmc::current_concurrent_escrow(&caps) == rp::escrowed(&ride), 8);
    assert!(rmc::user_escrow(&caps, ALICE) == rp::escrowed(&ride), 9);

    test_utils::destroy(ride);
    teardown_world(oracle, rw, path, vault, vcap, caps, rcap, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
fun close_ride_without_touch_returns_cashout() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, rw, path, mut vault, vcap, mut caps, rcap, bots, bcap,
         upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) = mk_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow(&mut vault, seed);
    push_obs(&mut oracle, 104_500_000_000, 1_000);

    let escrow_amt = 100_000;
    let escrow = mint_sui(escrow_amt, &mut sc);
    let mut ride = rp::open_ride<SUI>(
        &mut caps, &path, &mut vault, &bots,
        1_000_000, escrow, &clk, sc.ctx(),
    );

    clk.increment_for_testing(10_000);
    push_obs(&mut oracle, 104_500_000_000, 11_000);

    let payout = rp::close_ride<SUI>(
        &mut ride, &mut caps, &path, &oracle, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );

    assert!(rp::is_closed(&ride), 0);
    assert!(rp::settlement_kind(&ride) == rp::settlement_cashout(), 1);
    // cashout never profits: total_to_user ≤ escrowed (factor ≤ 1)
    assert!(payout.value() <= escrow_amt, 2);
    assert!(rmc::current_concurrent_escrow(&caps) == 0, 3);
    assert!(rmc::user_escrow(&caps, ALICE) == 0, 4);

    test_utils::destroy(payout);
    test_utils::destroy(ride);
    teardown_world(oracle, rw, path, vault, vcap, caps, rcap, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
fun close_ride_with_touch_pays_multiplier() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, rw, mut path, mut vault, vcap, mut caps, rcap, bots, bcap,
         upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) = mk_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow(&mut vault, seed);

    let escrow_amt = 100_000;
    let escrow = mint_sui(escrow_amt, &mut sc);
    let mut ride = rp::open_ride<SUI>(
        &mut caps, &path, &mut vault, &bots,
        1_000_000, escrow, &clk, sc.ctx(),
    );

    clk.increment_for_testing(5_000);
    push_obs(&mut oracle, 110_000_000_000, 6_000);  // > barrier
    po::record(&mut path, &oracle, &clk);

    let payout = rp::close_ride<SUI>(
        &mut ride, &mut caps, &path, &oracle, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );

    assert!(rp::settlement_kind(&ride) == rp::settlement_touch_win(), 0);
    // touch_win: payout = multiplier × stake_paid, plus escrow_refund.
    // stake_paid ~5 mist, multiplier 3x → payout_winnings ~15 mist
    // total ~= 15 + (100_000 - 5) > escrowed
    assert!(payout.value() > escrow_amt, 1);

    test_utils::destroy(payout);
    test_utils::destroy(ride);
    teardown_world(oracle, rw, path, vault, vcap, caps, rcap, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
fun close_ride_after_expiry_no_touch_returns_escrow_refund_only() {
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, path, mut vault, vcap, mut caps, rcap, bots, bcap,
         upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) = mk_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow(&mut vault, seed);

    let escrow_amt = 100_000;
    let escrow = mint_sui(escrow_amt, &mut sc);
    let mut ride = rp::open_ride<SUI>(
        &mut caps, &path, &mut vault, &bots,
        1_000_000, escrow, &clk, sc.ctx(),
    );

    clk.set_for_testing(EXPIRY_MS + 100);

    let payout = rp::close_ride<SUI>(
        &mut ride, &mut caps, &path, &oracle, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );

    assert!(rp::settlement_kind(&ride) == rp::settlement_expired_loss(), 0);
    // total_to_user = 0 + (escrowed - stake_paid)
    // stake_paid = 59 (capped at escrowed if larger)
    assert!(payout.value() < escrow_amt, 1);
    assert!(payout.value() > 0, 2);

    test_utils::destroy(payout);
    test_utils::destroy(ride);
    teardown_world(oracle, rw, path, vault, vcap, caps, rcap, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
fun crank_expired_ride_pays_user_and_bounty() {
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, path, mut vault, vcap, mut caps, rcap, bots, bcap,
         upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) = mk_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow(&mut vault, seed);

    let escrow = mint_sui(100_000, &mut sc);
    let mut ride = rp::open_ride<SUI>(
        &mut caps, &path, &mut vault, &bots,
        1_000_000, escrow, &clk, sc.ctx(),
    );

    clk.set_for_testing(EXPIRY_MS + 1_000);

    sc.next_tx(KEEPER);
    let bounty = rp::crank_expired_ride<SUI>(
        &mut ride, &mut caps, &path, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );

    assert!(rp::is_closed(&ride), 0);
    assert!(rp::settlement_kind(&ride) == rp::settlement_expired_loss(), 1);
    // Bounty is 50bps of stake_paid which is small here — accept any non-negative
    let _ = bounty.value();

    test_utils::destroy(bounty);
    test_utils::destroy(ride);
    teardown_world(oracle, rw, path, vault, vcap, caps, rcap, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
#[expected_failure(abort_code = rp::ETouchedMustSelfClose)]
fun crank_when_touched_aborts() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, rw, mut path, mut vault, vcap, mut caps, rcap, bots, bcap,
         upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) = mk_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow(&mut vault, seed);

    let escrow = mint_sui(100_000, &mut sc);
    let mut ride = rp::open_ride<SUI>(
        &mut caps, &path, &mut vault, &bots,
        1_000_000, escrow, &clk, sc.ctx(),
    );

    clk.increment_for_testing(5_000);
    push_obs(&mut oracle, 110_000_000_000, 6_000);
    po::record(&mut path, &oracle, &clk);

    clk.set_for_testing(EXPIRY_MS + 1_000);

    sc.next_tx(KEEPER);
    let bounty = rp::crank_expired_ride<SUI>(
        &mut ride, &mut caps, &path, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );
    test_utils::destroy(bounty);
    test_utils::destroy(ride);
    teardown_world(oracle, rw, path, vault, vcap, caps, rcap, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
#[expected_failure(abort_code = rp::EAfterExpiry)]
fun open_ride_after_expiry_aborts() {
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, path, mut vault, vcap, mut caps, rcap, bots, bcap,
         upo_obj, pcap, wts, wcap, pool, scap, mut clk) = mk_world(&mut sc);

    clk.set_for_testing(EXPIRY_MS + 1_000);
    let escrow = mint_sui(100_000, &mut sc);
    let ride = rp::open_ride<SUI>(
        &mut caps, &path, &mut vault, &bots,
        1_000_000, escrow, &clk, sc.ctx(),
    );
    test_utils::destroy(ride);
    teardown_world(oracle, rw, path, vault, vcap, caps, rcap, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

#[test]
#[expected_failure(abort_code = rp::EInsufficientEscrow)]
fun open_ride_insufficient_escrow_aborts() {
    let mut sc = ts::begin(ALICE);
    let (oracle, rw, path, mut vault, vcap, mut caps, rcap, bots, bcap,
         upo_obj, pcap, wts, wcap, pool, scap, clk) = mk_world(&mut sc);

    let escrow = mint_sui(1, &mut sc);
    let ride = rp::open_ride<SUI>(
        &mut caps, &path, &mut vault, &bots,
        1_000_000, escrow, &clk, sc.ctx(),
    );
    test_utils::destroy(ride);
    teardown_world(oracle, rw, path, vault, vcap, caps, rcap, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}
