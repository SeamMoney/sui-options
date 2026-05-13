// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

#[test_only]
module wick::fee_router_tests;

use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario as ts;
use sui::test_utils;
use wick::fee_router as fr;
use wick::martingaler_vault as mv;

const ALICE: address = @0xA;

fun mint(amount: u64, ctx: &mut TxContext): coin::Coin<SUI> {
    coin::mint_for_testing<SUI>(amount, ctx)
}

fun mid(addr: address): ID { object::id_from_address(addr) }

#[test]
fun init_router_default_shares() {
    let mut sc = ts::begin(ALICE);
    let (router, cap) = fr::init_for_testing<SUI>(sc.ctx());

    assert!(fr::lp_bps(&router) == 5500, 0);
    assert!(fr::staker_bps(&router) == 2500, 1);
    assert!(fr::insurance_bps(&router) == 1000, 2);
    assert!(fr::protocol_bps(&router) == 1000, 3);
    // sum = 10_000 enforced at init

    test_utils::destroy(router);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
#[expected_failure(abort_code = fr::EBpsSumMismatch)]
fun init_with_invalid_sum_aborts() {
    let mut sc = ts::begin(ALICE);
    let (router, cap) = fr::init_for_testing_with_shares<SUI>(5000, 2000, 1000, 1000, sc.ctx());
    test_utils::destroy(router);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
fun accrue_splits_into_correct_buckets() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    let (mut router, r_cap) = fr::init_for_testing<SUI>(sc.ctx());
    let (mut vault, v_cap) = mv::init_for_testing<SUI>(sc.ctx());

    // 10_000 fee → expect: lp=5500, staker=2500, insurance=1000, protocol=1000
    let fee = mint(10_000, sc.ctx()).into_balance();
    fr::test_accrue(&mut router, &mut vault, mid(@0x111), fee, &clk, sc.ctx());

    // LP forwarded directly to vault.treasury
    assert!(mv::treasury_value(&vault) == 5500, 0);
    // Other buckets in pending
    assert!(fr::staker_pending(&router) == 2500, 1);
    assert!(fr::insurance_pending(&router) == 1000, 2);
    assert!(fr::protocol_pending(&router) == 1000, 3);
    // Cumulative tracked
    assert!(fr::cumulative_lp(&router) == 5500, 4);
    assert!(fr::cumulative_total(&router) == 10_000, 5);
    assert!(fr::accrue_count(&router) == 1, 6);

    test_utils::destroy(router);
    test_utils::destroy(r_cap);
    test_utils::destroy(vault);
    test_utils::destroy(v_cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun accrue_dust_routed_to_lp() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    let (mut router, r_cap) = fr::init_for_testing<SUI>(sc.ctx());
    let (mut vault, v_cap) = mv::init_for_testing<SUI>(sc.ctx());

    // 1 unit fee — almost all goes to LP via residual
    let fee = mint(1, sc.ctx()).into_balance();
    fr::test_accrue(&mut router, &mut vault, mid(@0x111), fee, &clk, sc.ctx());
    // staker = 1 × 2500 / 10000 = 0
    // insurance = 0
    // protocol = 0
    // lp = 1 - 0 - 0 - 0 = 1
    assert!(mv::treasury_value(&vault) == 1, 0);
    assert!(fr::staker_pending(&router) == 0, 1);

    test_utils::destroy(router);
    test_utils::destroy(r_cap);
    test_utils::destroy(vault);
    test_utils::destroy(v_cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun accrue_zero_balance_noop() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    let (mut router, r_cap) = fr::init_for_testing<SUI>(sc.ctx());
    let (mut vault, v_cap) = mv::init_for_testing<SUI>(sc.ctx());

    let zero = sui::balance::zero<SUI>();
    fr::test_accrue(&mut router, &mut vault, mid(@0x111), zero, &clk, sc.ctx());
    assert!(fr::accrue_count(&router) == 0, 0);
    assert!(mv::treasury_value(&vault) == 0, 1);

    test_utils::destroy(router);
    test_utils::destroy(r_cap);
    test_utils::destroy(vault);
    test_utils::destroy(v_cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun accrue_multiple_calls_accumulate() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    let (mut router, r_cap) = fr::init_for_testing<SUI>(sc.ctx());
    let (mut vault, v_cap) = mv::init_for_testing<SUI>(sc.ctx());

    fr::test_accrue(&mut router, &mut vault, mid(@0x111), mint(10_000, sc.ctx()).into_balance(), &clk, sc.ctx());
    fr::test_accrue(&mut router, &mut vault, mid(@0x111), mint(20_000, sc.ctx()).into_balance(), &clk, sc.ctx());

    assert!(mv::treasury_value(&vault) == 16_500, 0);  // 5500 + 11000
    assert!(fr::staker_pending(&router) == 7500, 1);   // 2500 + 5000
    assert!(fr::cumulative_total(&router) == 30_000, 2);
    assert!(fr::accrue_count(&router) == 2, 3);

    test_utils::destroy(router);
    test_utils::destroy(r_cap);
    test_utils::destroy(vault);
    test_utils::destroy(v_cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun crank_drains_pending_buckets() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    let (mut router, r_cap) = fr::init_for_testing<SUI>(sc.ctx());
    let (mut vault, v_cap) = mv::init_for_testing<SUI>(sc.ctx());

    fr::test_accrue(&mut router, &mut vault, mid(@0x111), mint(10_000, sc.ctx()).into_balance(), &clk, sc.ctx());

    let staker_drained = fr::crank_bucket(&mut router, fr::bucket_staker());
    assert!(sui::balance::value(&staker_drained) == 2500, 0);
    assert!(fr::staker_pending(&router) == 0, 1);

    let insurance_drained = fr::crank_bucket(&mut router, fr::bucket_insurance());
    assert!(sui::balance::value(&insurance_drained) == 1000, 2);

    let protocol_drained = fr::crank_bucket(&mut router, fr::bucket_protocol());
    assert!(sui::balance::value(&protocol_drained) == 1000, 3);

    // LP bucket returns zero (already forwarded inline)
    let lp_drained = fr::crank_bucket(&mut router, fr::bucket_lp());
    assert!(sui::balance::value(&lp_drained) == 0, 4);

    sui::balance::destroy_zero(lp_drained);
    test_utils::destroy(coin::from_balance(staker_drained, sc.ctx()));
    test_utils::destroy(coin::from_balance(insurance_drained, sc.ctx()));
    test_utils::destroy(coin::from_balance(protocol_drained, sc.ctx()));

    test_utils::destroy(router);
    test_utils::destroy(r_cap);
    test_utils::destroy(vault);
    test_utils::destroy(v_cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun set_shares_works_within_cap() {
    let mut sc = ts::begin(ALICE);
    let (mut router, cap) = fr::init_for_testing<SUI>(sc.ctx());

    // 60 / 20 / 10 / 10
    fr::set_shares(&cap, &mut router, 6000, 2000, 1000, 1000);
    assert!(fr::lp_bps(&router) == 6000, 0);

    test_utils::destroy(router);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
#[expected_failure(abort_code = fr::EShareOutOfRange)]
fun set_shares_protocol_above_20pct_aborts() {
    let mut sc = ts::begin(ALICE);
    let (mut router, cap) = fr::init_for_testing<SUI>(sc.ctx());
    fr::set_shares(&cap, &mut router, 4500, 2500, 1000, 2000);  // protocol = 20% ok
    fr::set_shares(&cap, &mut router, 4400, 2500, 1000, 2100);  // protocol = 21% > 20% → abort
    test_utils::destroy(router);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
fun custom_shares_split_correctly() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    // 70/20/5/5
    let (mut router, r_cap) = fr::init_for_testing_with_shares<SUI>(7000, 2000, 500, 500, sc.ctx());
    let (mut vault, v_cap) = mv::init_for_testing<SUI>(sc.ctx());

    fr::test_accrue(&mut router, &mut vault, mid(@0x111), mint(10_000, sc.ctx()).into_balance(), &clk, sc.ctx());
    assert!(mv::treasury_value(&vault) == 7000, 0);
    assert!(fr::staker_pending(&router) == 2000, 1);
    assert!(fr::insurance_pending(&router) == 500, 2);
    assert!(fr::protocol_pending(&router) == 500, 3);

    test_utils::destroy(router);
    test_utils::destroy(r_cap);
    test_utils::destroy(vault);
    test_utils::destroy(v_cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun lp_routes_to_queue_via_auto_harvest_when_queue_present() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    let (mut router, r_cap) = fr::init_for_testing<SUI>(sc.ctx());
    let (mut vault, v_cap) = mv::init_for_testing<SUI>(sc.ctx());

    // First, set up a queued payout owed
    let market = mid(@0x111);
    mv::test_reserve_for_market(&mut vault, market, 0);
    let zero = mv::test_pay_winner(&mut vault, market, @0xB, 1000, &clk, sc.ctx());
    test_utils::destroy(zero);
    assert!(mv::queue_total(&vault) == 1000, 0);

    // Accrue a 10k fee — LP portion (5500) should auto-harvest into queue head
    fr::test_accrue(&mut router, &mut vault, market, mint(10_000, sc.ctx()).into_balance(), &clk, sc.ctx());

    // Queue partially paid: 1000 - 5500_lp_portion → since 5500 > 1000, queue cleared
    // Actually queue had only 1000 owed; LP portion 5500 pays full 1000 + leaves 4500 in side_bucket
    assert!(mv::queue_total(&vault) == 0, 1);
    assert!(mv::side_bucket_value(&vault) == 4500, 2);
    // BOB received 1000 via transfer
    sc.next_tx(@0xB);
    let bob_coin = sc.take_from_address<coin::Coin<SUI>>(@0xB);
    assert!(bob_coin.value() == 1000, 3);
    test_utils::destroy(bob_coin);

    test_utils::destroy(router);
    test_utils::destroy(r_cap);
    test_utils::destroy(vault);
    test_utils::destroy(v_cap);
    clk.destroy_for_testing();
    sc.end();
}
