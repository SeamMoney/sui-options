// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// recover_aborted_seed lets the vault admin reclaim the LP's seed residue left
/// in an aborted market's refund pool after depositors have taken their 1:1
/// refunds. It moves money (residue → treasury) and is admin-gated, but had no
/// test. Pin the happy path (residue drains into treasury) and both guards: the
/// market must actually be aborted (EAlreadyAborted), and only the matching
/// admin cap may call it (ENotAdmin). admin_recover_aborted_seed delegates here,
/// so it's covered by the same logic.
#[test_only]
module wick::martingaler_vault_seed_recovery_tests;

use wick::martingaler_vault as mv;
use sui::coin;
use sui::sui::SUI;
use sui::clock;
use sui::test_scenario as ts;
use sui::test_utils;

const ALICE: address = @0xA;
const BOB: address = @0xB;

fun mint(amount: u64, ctx: &mut TxContext): coin::Coin<SUI> {
    coin::mint_for_testing<SUI>(amount, ctx)
}
fun mid(addr: address): ID { object::id_from_address(addr) }

#[test]
fun recover_seed_drains_the_abort_pool_residue_into_treasury() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    let (mut vault, cap) = mv::init_for_testing<SUI>(sc.ctx());
    let market = mid(@0x111);

    mv::test_deposit_open(&mut vault, mint(1000, sc.ctx()), &clk, sc.ctx());
    mv::test_reserve_for_market(&mut vault, market, 700);
    mv::test_route_lock_to_abort_refund(&mut vault, market);
    let refund = mv::test_claim_aborted_refund(&mut vault, market, BOB, 250, sc.ctx());
    assert!(mv::abort_pool_value(&vault, market) == 450, 0); // 700 routed − 250 claimed

    let t_before = mv::treasury_value(&vault);
    mv::recover_aborted_seed(&cap, &mut vault, market);
    assert!(mv::abort_pool_value(&vault, market) == 0, 1); // residue drained
    assert!(mv::treasury_value(&vault) == t_before + 450, 2); // recovered into treasury

    coin::burn_for_testing(refund);
    test_utils::destroy(vault);
    test_utils::destroy(cap);
    clk.destroy_for_testing();
    sc.end();
}

// Safety: you can't recover seed from a market that was never aborted → EAlreadyAborted (5).
#[test]
#[expected_failure(abort_code = 5, location = wick::martingaler_vault)]
fun recover_seed_rejects_a_non_aborted_market() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, cap) = mv::init_for_testing<SUI>(sc.ctx());
    mv::recover_aborted_seed(&cap, &mut vault, mid(@0xDEAD)); // never aborted
    test_utils::destroy(vault);
    test_utils::destroy(cap);
    sc.end();
}

// Safety: a foreign admin cap can't recover another vault's seed → ENotAdmin (9).
#[test]
#[expected_failure(abort_code = 9, location = wick::martingaler_vault)]
fun recover_seed_rejects_a_foreign_admin_cap() {
    let mut sc = ts::begin(ALICE);
    let (mut vault1, cap1) = mv::init_for_testing<SUI>(sc.ctx());
    let (vault2, cap2) = mv::init_for_testing<SUI>(sc.ctx());
    mv::recover_aborted_seed(&cap2, &mut vault1, mid(@0x111)); // cap2 belongs to vault2
    test_utils::destroy(vault1);
    test_utils::destroy(cap1);
    test_utils::destroy(vault2);
    test_utils::destroy(cap2);
    sc.end();
}
