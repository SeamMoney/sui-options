// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Direct tests for the generic single-collateral `wick::vault` primitive.
/// It's live (used by market, segment_market_v4, ride_position, fee_router,
/// wick, segment_market) and holds collateral, but had no direct test — its
/// conservation was only verified indirectly through the market module. Pin
/// the deposit/withdraw round-trip (every unit conserved) and the two
/// fund-safety guards: no zero-amount moves, no over-withdraw.
#[test_only]
module wick::vault_tests;

use wick::vault;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario as ts;

const ALICE: address = @0xA;

#[test]
fun deposit_withdraw_round_trip_conserves_every_unit() {
    let mut sc = ts::begin(ALICE);
    let mut v = vault::new<SUI>();
    assert!(vault::balance(&v) == 0, 0);

    vault::deposit(&mut v, coin::mint_for_testing<SUI>(100, sc.ctx()));
    assert!(vault::balance(&v) == 100, 1);

    let part = vault::withdraw(&mut v, 40, sc.ctx());
    assert!(coin::value(&part) == 40, 2);
    assert!(vault::balance(&v) == 60, 3); // 100 in − 40 out == 60 held

    let rest = vault::withdraw(&mut v, 60, sc.ctx());
    assert!(vault::balance(&v) == 0, 4);

    vault::destroy_empty(v);
    coin::burn_for_testing(part);
    coin::burn_for_testing(rest);
    sc.end();
}

#[test]
fun deposit_balance_adds_to_held() {
    let mut sc = ts::begin(ALICE);
    let mut v = vault::new<SUI>();
    let c = coin::mint_for_testing<SUI>(70, sc.ctx());
    vault::deposit_balance(&mut v, c.into_balance());
    assert!(vault::balance(&v) == 70, 0);
    let out = vault::withdraw(&mut v, 70, sc.ctx());
    vault::destroy_empty(v);
    coin::burn_for_testing(out);
    sc.end();
}

// Safety: a zero-amount deposit is rejected (EZeroAmount = 0).
#[test]
#[expected_failure(abort_code = 0, location = wick::vault)]
fun deposit_zero_aborts() {
    let mut sc = ts::begin(ALICE);
    let mut v = vault::new<SUI>();
    vault::deposit(&mut v, coin::mint_for_testing<SUI>(0, sc.ctx()));
    vault::destroy_empty(v); // unreachable
    sc.end();
}

// Safety: a zero-amount withdraw is rejected (EZeroAmount = 0).
#[test]
#[expected_failure(abort_code = 0, location = wick::vault)]
fun withdraw_zero_aborts() {
    let mut sc = ts::begin(ALICE);
    let mut v = vault::new<SUI>();
    vault::deposit(&mut v, coin::mint_for_testing<SUI>(50, sc.ctx()));
    let out = vault::withdraw(&mut v, 0, sc.ctx());
    coin::burn_for_testing(out); // unreachable
    vault::destroy_empty(v);
    sc.end();
}

// Safety: cannot withdraw more than held — no minting from thin air
// (EInsufficientBalance = 1).
#[test]
#[expected_failure(abort_code = 1, location = wick::vault)]
fun withdraw_more_than_held_aborts() {
    let mut sc = ts::begin(ALICE);
    let mut v = vault::new<SUI>();
    vault::deposit(&mut v, coin::mint_for_testing<SUI>(50, sc.ctx()));
    let out = vault::withdraw(&mut v, 100, sc.ctx());
    coin::burn_for_testing(out); // unreachable
    vault::destroy_empty(v);
    sc.end();
}
