// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

#[test_only]
#[allow(deprecated_usage)]
module wick::segment_market_adversarial;

use sui::clock::{Self as clock, Clock};
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario as ts;
use sui::test_utils;
use wick::bot_registry as br;
use wick::martingaler_vault::{Self as mv, MartingalerVault};
use wick::seeded_path as sp;
use wick::segment_market::{Self as sm, SegmentMarket};
use wick::usd_price_oracle as upo;
use wick::wick_staking as ws;
use wick::wick_token as wt;

const ALICE: address = @0xA;
const BOB: address = @0xB;
const CAROL: address = @0xC;
const DAVE: address = @0xD;
const BACKUP_CRANKER: address = @0xE;

const HOME_PRICE: u64 = 1_000_000_000;
const VOL_REGIME_INIT: u64 = 1_000_000;
const ROUND_DURATION: u64 = 10;
const OPEN_WINDOW: u64 = 3;
const BARRIER_OFFSET_BPS: u64 = 500;
const MULTIPLIER_BPS: u64 = 20_000;
const MAX_PAYOUT_PER_BARRIER: u64 = 200_000;
const DEADBAND_BPS: u64 = 20;
const SIGMA_BPS: u64 = 50;
const CASHOUT_SPREAD_BPS: u64 = 500;
const ABORT_DEADLINE_MS: u64 = 30_000;
const MIN_STAKE: u64 = 100;
const MAX_STAKE: u64 = 10_000;
const MAX_CONCURRENT: u64 = 3;
const MAX_PER_USER: u64 = 10;

const E_OPEN_WINDOW_CLOSED: u64 = 5;
const E_CONCURRENT_RIDE_LIMIT: u64 = 9;
const E_BARRIER_CAP_EXCEEDED: u64 = 11;

fun mint_sui(amount: u64, sc: &mut ts::Scenario): coin::Coin<SUI> {
    coin::mint_for_testing<SUI>(amount, sc.ctx())
}

fun mk_market(
    vault: &MartingalerVault<SUI>,
    sc: &mut ts::Scenario,
    clk: &Clock,
): SegmentMarket<SUI> {
    sm::new_segment_market<SUI>(
        vault,
        HOME_PRICE,
        VOL_REGIME_INIT,
        ROUND_DURATION,
        OPEN_WINDOW,
        BARRIER_OFFSET_BPS,
        MULTIPLIER_BPS,
        MAX_PAYOUT_PER_BARRIER,
        DEADBAND_BPS,
        SIGMA_BPS,
        CASHOUT_SPREAD_BPS,
        ABORT_DEADLINE_MS,
        MIN_STAKE,
        MAX_STAKE,
        MAX_CONCURRENT,
        MAX_PER_USER,
        clk,
        sc.ctx(),
    )
}

fun mk_core_world(sc: &mut ts::Scenario): (
    MartingalerVault<SUI>,
    mv::VaultAdminCap,
    SegmentMarket<SUI>,
    br::BotRegistry,
    br::BotAdminCap,
    clock::Clock,
) {
    let mut clk = clock::create_for_testing(sc.ctx());
    clk.set_for_testing(1_000);
    let (vault, vcap) = mv::init_for_testing<SUI>(sc.ctx());
    let market = mk_market(&vault, sc, &clk);
    let (bots, bcap) = br::init_for_testing(sc.ctx());
    (vault, vcap, market, bots, bcap, clk)
}

fun teardown_core(
    vault: MartingalerVault<SUI>,
    vcap: mv::VaultAdminCap,
    market: SegmentMarket<SUI>,
    bots: br::BotRegistry,
    bcap: br::BotAdminCap,
    clk: clock::Clock,
) {
    test_utils::destroy(vault);
    test_utils::destroy(vcap);
    sm::test_only_destroy_market(market);
    test_utils::destroy(bots);
    test_utils::destroy(bcap);
    clk.destroy_for_testing();
}

#[test]
fun open_window_race_before_boundary_succeeds() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, clk) = mk_core_world(&mut sc);

    sm::test_only_bump_segment_index<SUI>(&mut market, OPEN_WINDOW - 1);

    let stake = MIN_STAKE;
    let ride = sm::open_segment_ride<SUI>(
        &mut market,
        &mut vault,
        &bots,
        sm::barrier_upper(),
        stake,
        mint_sui(stake * ROUND_DURATION, &mut sc),
        &clk,
        sc.ctx(),
    );

    assert!(sm::entry_segment_index(&ride) == OPEN_WINDOW - 1, 0);
    assert!(sm::active_ride_count<SUI>(&market) == 1, 1);

    sm::test_only_destroy_ride(ride);
    teardown_core(vault, vcap, market, bots, bcap, clk);
    sc.end();
}

#[test]
#[expected_failure(abort_code = E_OPEN_WINDOW_CLOSED, location = wick::segment_market)]
fun open_window_race_after_boundary_aborts_cleanly() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, clk) = mk_core_world(&mut sc);

    sm::test_only_bump_segment_index<SUI>(&mut market, OPEN_WINDOW);

    let stake = MIN_STAKE;
    let ride = sm::open_segment_ride<SUI>(
        &mut market,
        &mut vault,
        &bots,
        sm::barrier_upper(),
        stake,
        mint_sui(stake * ROUND_DURATION, &mut sc),
        &clk,
        sc.ctx(),
    );
    sm::test_only_destroy_ride(ride);
    teardown_core(vault, vcap, market, bots, bcap, clk);
    sc.end();
}

// Safety: open a segment ride with ZERO escrow → EZeroEscrow (=8). Mirrors the
// v4 guard; the legacy module is separate deployed code, so it gets its own
// rejection test rather than relying on the v4 coverage.
#[test]
#[expected_failure(abort_code = 8, location = wick::segment_market)]
fun open_with_zero_escrow_aborts() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, clk) = mk_core_world(&mut sc);

    let stake = MIN_STAKE;
    let ride = sm::open_segment_ride<SUI>(
        &mut market, &mut vault, &bots, sm::barrier_upper(), stake,
        mint_sui(0, &mut sc), &clk, sc.ctx(),
    );

    sm::test_only_destroy_ride(ride); // unreachable
    teardown_core(vault, vcap, market, bots, bcap, clk);
    sc.end();
}

#[test]
#[expected_failure(abort_code = E_BARRIER_CAP_EXCEEDED, location = wick::segment_market)]
fun per_barrier_cap_exhaustion_keeps_other_barrier_open() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, clk) = mk_core_world(&mut sc);

    let max_escrow = MAX_STAKE * ROUND_DURATION;
    let upper_ride = sm::open_segment_ride<SUI>(
        &mut market,
        &mut vault,
        &bots,
        sm::barrier_upper(),
        MAX_STAKE,
        mint_sui(max_escrow, &mut sc),
        &clk,
        sc.ctx(),
    );
    assert!(sm::upper_aggregate_max_payout<SUI>(&market) == MAX_PAYOUT_PER_BARRIER, 0);

    sc.next_tx(BOB);
    let lower_ride = sm::open_segment_ride<SUI>(
        &mut market,
        &mut vault,
        &bots,
        sm::barrier_lower(),
        MAX_STAKE,
        mint_sui(max_escrow, &mut sc),
        &clk,
        sc.ctx(),
    );
    assert!(sm::lower_rider_count<SUI>(&market) == 1, 1);

    sc.next_tx(CAROL);
    let extra_upper = sm::open_segment_ride<SUI>(
        &mut market,
        &mut vault,
        &bots,
        sm::barrier_upper(),
        MIN_STAKE,
        mint_sui(MIN_STAKE * ROUND_DURATION, &mut sc),
        &clk,
        sc.ctx(),
    );
    sm::test_only_destroy_ride(extra_upper);
    sm::test_only_destroy_ride(lower_ride);
    sm::test_only_destroy_ride(upper_ride);
    teardown_core(vault, vcap, market, bots, bcap, clk);
    sc.end();
}

#[test]
#[expected_failure(abort_code = E_CONCURRENT_RIDE_LIMIT, location = wick::segment_market)]
fun concurrent_open_cap_holds_at_max_concurrent_rides() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, clk) = mk_core_world(&mut sc);

    let stake = MIN_STAKE;
    let escrow = stake * ROUND_DURATION;
    let r1 = sm::open_segment_ride<SUI>(
        &mut market, &mut vault, &bots, sm::barrier_upper(),
        stake, mint_sui(escrow, &mut sc), &clk, sc.ctx(),
    );
    sc.next_tx(BOB);
    let r2 = sm::open_segment_ride<SUI>(
        &mut market, &mut vault, &bots, sm::barrier_lower(),
        stake, mint_sui(escrow, &mut sc), &clk, sc.ctx(),
    );
    sc.next_tx(CAROL);
    let r3 = sm::open_segment_ride<SUI>(
        &mut market, &mut vault, &bots, sm::barrier_upper(),
        stake, mint_sui(escrow, &mut sc), &clk, sc.ctx(),
    );
    assert!(sm::active_ride_count<SUI>(&market) == MAX_CONCURRENT, 0);

    sc.next_tx(DAVE);
    let r4 = sm::open_segment_ride<SUI>(
        &mut market, &mut vault, &bots, sm::barrier_lower(),
        stake, mint_sui(escrow, &mut sc), &clk, sc.ctx(),
    );
    sm::test_only_destroy_ride(r4);
    sm::test_only_destroy_ride(r3);
    sm::test_only_destroy_ride(r2);
    sm::test_only_destroy_ride(r1);
    teardown_core(vault, vcap, market, bots, bcap, clk);
    sc.end();
}

#[test]
fun ride_spans_round_boundary_and_permissionless_backup_crank_settles() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, mut clk) = mk_core_world(&mut sc);
    let (mut price_oracle, price_cap) = upo::init_for_testing(sc.ctx());
    upo::set_price<SUI>(&price_cap, &mut price_oracle, 1_000_000, 9, &clk);
    let (mut wick_state, wick_cap) = wt::init_for_testing(sc.ctx());
    let (mut staking_pool, staking_cap) = ws::init_for_testing(sc.ctx());

    mv::test_deposit_ride_escrow<SUI>(&mut vault, mint_sui(1_000_000_000, &mut sc));

    let stake = MIN_STAKE;
    let escrow = stake * ROUND_DURATION;
    let mut ride = sm::open_segment_ride<SUI>(
        &mut market,
        &mut vault,
        &bots,
        sm::barrier_upper(),
        stake,
        mint_sui(escrow, &mut sc),
        &clk,
        sc.ctx(),
    );

    let st = sp::state_with(HOME_PRICE, false, 0, VOL_REGIME_INIT, HOME_PRICE);
    sm::test_only_record_segment<SUI>(
        &mut market,
        x"01",
        st,
        HOME_PRICE - 1_000_000,
        HOME_PRICE + 1_000_000,
        1_400,
    );
    sm::test_only_record_segment<SUI>(
        &mut market,
        x"02",
        st,
        HOME_PRICE - 1_000_000,
        HOME_PRICE + 1_000_000,
        1_800,
    );

    // The keeper stopped after two harmless segments; the round still ends
    // and any address can clear the stale open ride with the backup crank.
    sm::test_only_bump_segment_index<SUI>(&mut market, ROUND_DURATION - 2);
    clk.increment_for_testing(ROUND_DURATION * sm::default_segment_ms());

    sc.next_tx(BACKUP_CRANKER);
    let bounty = sm::crank_expired_segment_ride<SUI>(
        &mut ride,
        &mut market,
        &mut vault,
        &price_oracle,
        &mut wick_state,
        &mut staking_pool,
        &clk,
        sc.ctx(),
    );

    assert!(sm::is_closed(&ride), 0);
    assert!(sm::settlement_kind(&ride) == sm::settlement_expired_loss(), 1);
    assert!(sm::active_ride_count<SUI>(&market) == 0, 2);
    assert!(bounty.value() == escrow * sm::crank_bounty_bps() / 10_000, 3);

    test_utils::destroy(bounty);
    sm::test_only_destroy_ride(ride);
    test_utils::destroy(price_oracle);
    test_utils::destroy(price_cap);
    test_utils::destroy(wick_state);
    test_utils::destroy(wick_cap);
    test_utils::destroy(staking_pool);
    test_utils::destroy(staking_cap);
    teardown_core(vault, vcap, market, bots, bcap, clk);
    sc.end();
}
