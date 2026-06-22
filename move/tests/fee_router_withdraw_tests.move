// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// fee_router::withdraw_protocol drains a chosen amount from the protocol
/// pending bucket (the admin's protocol-fee sweep). It was untested. Pin that a
/// funded bucket pays out the requested amount, that an over-ask caps at the
/// available balance (no overdraw / minting), that a zero amount is rejected
/// (EZeroAmount), and that an empty bucket yields zero rather than aborting.
#[test_only]
module wick::fee_router_withdraw_tests;

use wick::fee_router as fr;
use wick::martingaler_vault as mv;
use sui::balance;
use sui::sui::SUI;
use sui::clock;
use sui::test_scenario as ts;
use sui::test_utils;

const ALICE: address = @0xA;

#[test]
fun withdraw_protocol_pays_requested_then_caps_at_available() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    // 100% of accrued fees route to the protocol bucket.
    let (mut router, rcap) = fr::init_for_testing_with_shares<SUI>(0, 0, 0, 10_000, sc.ctx());
    let (mut vault, vcap) = mv::init_for_testing<SUI>(sc.ctx());
    let market = object::id_from_address(@0x1);

    fr::accrue(&mut router, &mut vault, market, balance::create_for_testing<SUI>(1_000), &clk, sc.ctx());

    let part = fr::withdraw_protocol(&mut router, 400);
    assert!(balance::value(&part) == 400, 0); // exact requested amount

    // Over-asking caps at the 600 remaining — never overdraws.
    let rest = fr::withdraw_protocol(&mut router, 5_000);
    assert!(balance::value(&rest) == 600, 1);
    // part + rest == the full 1_000 accrued ⇒ nothing minted, nothing lost.
    assert!(balance::value(&part) + balance::value(&rest) == 1_000, 2);

    balance::destroy_for_testing(part);
    balance::destroy_for_testing(rest);
    test_utils::destroy(router);
    test_utils::destroy(rcap);
    test_utils::destroy(vault);
    test_utils::destroy(vcap);
    clk.destroy_for_testing();
    sc.end();
}

// Safety: a zero-amount withdraw is rejected → EZeroAmount (1).
#[test]
#[expected_failure(abort_code = 1, location = wick::fee_router)]
fun withdraw_protocol_rejects_zero_amount() {
    let mut sc = ts::begin(ALICE);
    let (mut router, rcap) = fr::init_for_testing<SUI>(sc.ctx());
    let b = fr::withdraw_protocol(&mut router, 0);
    balance::destroy_for_testing(b); // unreachable
    test_utils::destroy(router);
    test_utils::destroy(rcap);
    sc.end();
}

#[test]
fun withdraw_protocol_on_empty_bucket_yields_zero() {
    let mut sc = ts::begin(ALICE);
    let (mut router, rcap) = fr::init_for_testing<SUI>(sc.ctx());
    let b = fr::withdraw_protocol(&mut router, 100);
    assert!(balance::value(&b) == 0, 0); // empty ⇒ zero, no abort
    balance::destroy_for_testing(b);
    test_utils::destroy(router);
    test_utils::destroy(rcap);
    sc.end();
}
