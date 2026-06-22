// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// The vault's three fee buckets (protocol / staker / insurance) are the
/// money-OUT paths to the fee recipients, but withdraw_protocol_fees /
/// withdraw_staker_fees / withdraw_insurance_fees had no direct test. Pin that
/// accrue_fee routes to the bucket named by its id, that each withdraw drains
/// exactly its own bucket (and only it), and that a zero accrual is a no-op.
#[test_only]
module wick::martingaler_vault_fees_tests;

use wick::martingaler_vault as mv;
use sui::balance;
use sui::sui::SUI;
use sui::test_scenario as ts;
use sui::test_utils;

const ALICE: address = @0xA;

#[test]
fun accrue_routes_by_bucket_id_and_each_withdraw_drains_only_its_own() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap) = mv::init_for_testing<SUI>(sc.ctx());

    mv::test_accrue_fee(&mut vault, 0, balance::create_for_testing<SUI>(100)); // protocol
    mv::test_accrue_fee(&mut vault, 1, balance::create_for_testing<SUI>(70)); // staker
    mv::test_accrue_fee(&mut vault, 2, balance::create_for_testing<SUI>(30)); // insurance
    assert!(mv::protocol_fees_value(&vault) == 100, 0);
    assert!(mv::staker_fees_value(&vault) == 70, 1);
    assert!(mv::insurance_fees_value(&vault) == 30, 2);

    // Each withdraw drains exactly its own bucket and leaves the others intact.
    let p = mv::withdraw_protocol_fees(&mut vault);
    assert!(balance::value(&p) == 100, 3);
    assert!(mv::protocol_fees_value(&vault) == 0, 4);
    assert!(mv::staker_fees_value(&vault) == 70, 5); // untouched
    assert!(mv::insurance_fees_value(&vault) == 30, 6); // untouched

    let s = mv::withdraw_staker_fees(&mut vault);
    assert!(balance::value(&s) == 70, 7);
    assert!(mv::staker_fees_value(&vault) == 0, 8);

    let i = mv::withdraw_insurance_fees(&mut vault);
    assert!(balance::value(&i) == 30, 9);
    assert!(mv::insurance_fees_value(&vault) == 0, 10);

    balance::destroy_for_testing(p);
    balance::destroy_for_testing(s);
    balance::destroy_for_testing(i);
    test_utils::destroy(vault);
    test_utils::destroy(vcap);
    sc.end();
}

#[test]
fun accrue_zero_is_a_noop_and_empty_withdraw_yields_zero() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap) = mv::init_for_testing<SUI>(sc.ctx());

    mv::test_accrue_fee(&mut vault, 0, balance::zero<SUI>());
    assert!(mv::protocol_fees_value(&vault) == 0, 0);

    let p = mv::withdraw_protocol_fees(&mut vault);
    assert!(balance::value(&p) == 0, 1);

    balance::destroy_for_testing(p);
    test_utils::destroy(vault);
    test_utils::destroy(vcap);
    sc.end();
}
