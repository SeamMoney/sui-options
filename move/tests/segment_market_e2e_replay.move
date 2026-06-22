// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

#[test_only]
#[allow(deprecated_usage)]
module wick::segment_market_e2e_replay;

use sui::clock::{Self as clock, Clock};
use sui::coin;
use sui::random::{Self as random, Random};
use sui::sui::SUI;
use sui::test_scenario as ts;
use sui::test_utils;
use wick::bot_registry as br;
use wick::martingaler_vault::{Self as mv, MartingalerVault};
use wick::seeded_path as sp;
use wick::segment_market::{Self as sm, SegmentMarket};
use wick::usd_price_oracle as upo;
use wick::wick as router;
use wick::wick_staking as ws;
use wick::wick_token as wt;

const ALICE: address = @0xA;
const KEEPER: address = @0xC;
const SYSTEM: address = @0x0;

const HOME_PRICE: u64 = 1_000_000_000;
const VOL_REGIME_INIT: u64 = 1_000_000;
const ROUND_DURATION: u64 = 20;
const OPEN_WINDOW: u64 = 5;
const BARRIER_OFFSET_BPS: u64 = 500;
const MULTIPLIER_BPS: u64 = 20_000;
const MAX_PAYOUT_PER_BARRIER: u64 = 1_000_000_000;
const DEADBAND_BPS: u64 = 20;
const SIGMA_BPS: u64 = 50;
const CASHOUT_SPREAD_BPS: u64 = 500;
const ABORT_DEADLINE_MS: u64 = 30_000;
const MIN_STAKE: u64 = 100;
const MAX_STAKE: u64 = 1_000_000;
const MAX_CONCURRENT: u64 = 16;
const MAX_PER_USER: u64 = 16;

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

fun set_random_round(sc: &mut ts::Scenario, round: u64, bytes: vector<u8>) {
    sc.next_tx(SYSTEM);
    let mut r = ts::take_shared<Random>(sc);
    random::update_randomness_state_for_testing(&mut r, round, bytes, sc.ctx());
    ts::return_shared(r);
}

fun record_with_random(
    sc: &mut ts::Scenario,
    market: &mut SegmentMarket<SUI>,
    clk: &Clock,
    round: u64,
    bytes: vector<u8>,
) {
    set_random_round(sc, round, bytes);
    sc.next_tx(KEEPER);
    let r = ts::take_shared<Random>(sc);
    router::record_segment<SUI>(market, &r, clk, sc.ctx());
    ts::return_shared(r);
}

fun replay_keys_and_scan(
    market: &SegmentMarket<SUI>,
    from_idx: u64,
    to_idx: u64,
    barrier: u64,
): bool {
    let mut st = sp::new_state(HOME_PRICE, VOL_REGIME_INIT, HOME_PRICE);
    let mut replay_touched = false;
    let mut k = 0;
    let effective_barrier = barrier + (barrier * sm::deadband_bps<SUI>(market) / 10_000);

    while (k < to_idx) {
        let key = sm::segment_key<SUI>(market, k);
        let (_, new_st, smin, smax) = sp::expand_segment(st, key);

        assert!(smin == sm::segment_min<SUI>(market, k), 100 + k);
        assert!(smax == sm::segment_max<SUI>(market, k), 200 + k);

        if (k >= from_idx && smax >= effective_barrier) {
            replay_touched = true;
        };

        st = new_st;
        k = k + 1;
    };

    let scan_touched = sm::test_scan_for_touch<SUI>(
        market,
        from_idx,
        to_idx,
        barrier,
        true,
    );
    assert!(replay_touched == scan_touched, 300);
    scan_touched
}

#[test]
fun segment_market_e2e_replay_spine_test_2() {
    let mut sc = ts::begin(ALICE);
    ts::create_system_objects(&mut sc);

    let mut clk = clock::create_for_testing(sc.ctx());
    clk.set_for_testing(1_000);

    let (mut vault, vcap) = mv::init_for_testing<SUI>(sc.ctx());
    let mut market = mk_market(&vault, &mut sc, &clk);
    let (bots, bcap) = br::init_for_testing(sc.ctx());
    let (mut price_oracle, price_cap) = upo::init_for_testing(sc.ctx());
    upo::set_price<SUI>(&price_cap, &mut price_oracle, 1_000_000, 9, &clk);
    let (mut wick_state, wick_cap) = wt::init_for_testing(sc.ctx());
    let (mut staking_pool, staking_cap) = ws::init_for_testing(sc.ctx());

    mv::test_deposit_ride_escrow<SUI>(&mut vault, mint_sui(10_000_000_000, &mut sc));

    let stake = 1_000;
    let escrow_amt = stake * ROUND_DURATION;
    let mut ride = sm::open_segment_ride<SUI>(
        &mut market,
        &mut vault,
        &bots,
        sm::barrier_upper(),
        stake,
        mint_sui(escrow_amt, &mut sc),
        &clk,
        sc.ctx(),
    );

    let entry_idx = sm::entry_segment_index(&ride);
    let barrier = sm::barrier_price(&ride);

    record_with_random(
        &mut sc,
        &mut market,
        &clk,
        0,
        x"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    );
    record_with_random(
        &mut sc,
        &mut market,
        &clk,
        1,
        x"202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f",
    );
    record_with_random(
        &mut sc,
        &mut market,
        &clk,
        2,
        x"404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f",
    );

    let exit_idx = sm::next_segment_index<SUI>(&market);
    let replay_touched = replay_keys_and_scan(&market, entry_idx, exit_idx, barrier);

    sc.next_tx(ALICE);
    clk.increment_for_testing(1_000);
    let payout = sm::close_segment_ride<SUI>(
        &mut ride,
        &mut market,
        &mut vault,
        &price_oracle,
        &mut wick_state,
        &mut staking_pool,
        &clk,
        sc.ctx(),
    );

    let expected_kind = if (replay_touched) {
        sm::settlement_touch_win()
    } else {
        sm::settlement_cashout()
    };
    let onchain_kind = sm::settlement_kind(&ride);
    assert!(onchain_kind == expected_kind, 400);

    test_utils::destroy(payout);
    sm::test_only_destroy_ride(ride);
    sm::test_only_destroy_market(market);
    test_utils::destroy(vault);
    test_utils::destroy(vcap);
    test_utils::destroy(bots);
    test_utils::destroy(bcap);
    test_utils::destroy(price_oracle);
    test_utils::destroy(price_cap);
    test_utils::destroy(wick_state);
    test_utils::destroy(wick_cap);
    test_utils::destroy(staking_pool);
    test_utils::destroy(staking_cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
/// REGRESSION (the #683 cross-round-escape class, for the legacy v2 module): a
/// ride that expired un-touched in its OWN round must NOT be paid a TOUCH_WIN
/// just because a LATER round's segment crossed the ride's old, snapshotted
/// barrier. `close_segment_ride`'s touch scan is now bounded to the ride's round
/// (crank_expired already bounded it). Without the bound, this fabricates a
/// jackpot and drains the vault. Pre-fix this asserts TOUCH_WIN (fails); post-fix
/// EXPIRED_LOSS (passes).
fun v2_ride_cannot_touch_win_on_a_later_rounds_segment() {
    let mut sc = ts::begin(ALICE);
    ts::create_system_objects(&mut sc);
    let mut clk = clock::create_for_testing(sc.ctx());
    clk.set_for_testing(1_000);

    let (mut vault, vcap) = mv::init_for_testing<SUI>(sc.ctx());
    let mut market = mk_market(&vault, &mut sc, &clk);
    let (bots, bcap) = br::init_for_testing(sc.ctx());
    let (mut price_oracle, price_cap) = upo::init_for_testing(sc.ctx());
    upo::set_price<SUI>(&price_cap, &mut price_oracle, 1_000_000, 9, &clk);
    let (mut wick_state, wick_cap) = wt::init_for_testing(sc.ctx());
    let (mut staking_pool, staking_cap) = ws::init_for_testing(sc.ctx());

    mv::test_deposit_ride_escrow<SUI>(&mut vault, mint_sui(10_000_000_000, &mut sc));

    let stake = 1_000;
    let escrow_amt = stake * ROUND_DURATION;
    let mut ride = sm::open_segment_ride<SUI>(
        &mut market,
        &mut vault,
        &bots,
        sm::barrier_upper(),
        stake,
        mint_sui(escrow_amt, &mut sc),
        &clk,
        sc.ctx(),
    );
    let barrier = sm::barrier_price(&ride); // upper barrier, above the home price

    // Round 0 = [0, ROUND_DURATION): record ONE segment that does NOT touch (max
    // well below the upper barrier). Other round-0 slots stay un-recorded —
    // scan_for_touch skips missing segments.
    let st0 = sp::new_state(HOME_PRICE, VOL_REGIME_INIT, HOME_PRICE);
    sm::test_only_record_segment<SUI>(&mut market, x"00", st0, HOME_PRICE, HOME_PRICE, 1_000);
    // Advance next_segment_index to ROUND_DURATION — round 0 is now over.
    sm::test_only_bump_segment_index<SUI>(&mut market, ROUND_DURATION - 1);
    // Round 1: a segment whose max CROSSES the ride's old round-0 barrier.
    let st1 = sp::new_state(HOME_PRICE, VOL_REGIME_INIT, HOME_PRICE);
    sm::test_only_record_segment<SUI>(&mut market, x"01", st1, HOME_PRICE, barrier * 2, 2_000);
    sm::test_only_force_round_current<SUI>(&mut market);

    sc.next_tx(ALICE);
    clk.increment_for_testing(1_000);
    let payout = sm::close_segment_ride<SUI>(
        &mut ride,
        &mut market,
        &mut vault,
        &price_oracle,
        &mut wick_state,
        &mut staking_pool,
        &clk,
        sc.ctx(),
    );

    // The later-round touch must NOT win: the bounded scan sees only round 0
    // (no touch) and the round expired → EXPIRED_LOSS, never TOUCH_WIN.
    assert!(sm::settlement_kind(&ride) == sm::settlement_expired_loss(), 999);

    test_utils::destroy(payout);
    sm::test_only_destroy_ride(ride);
    sm::test_only_destroy_market(market);
    test_utils::destroy(vault);
    test_utils::destroy(vcap);
    test_utils::destroy(bots);
    test_utils::destroy(bcap);
    test_utils::destroy(price_oracle);
    test_utils::destroy(price_cap);
    test_utils::destroy(wick_state);
    test_utils::destroy(wick_cap);
    test_utils::destroy(staking_pool);
    test_utils::destroy(staking_cap);
    clk.destroy_for_testing();
    sc.end();
}
