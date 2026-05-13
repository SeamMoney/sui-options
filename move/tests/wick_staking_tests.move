// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

#[test_only]
module wick::wick_staking_tests;

use sui::balance;
use sui::clock;
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use sui::test_scenario as ts;
use sui::test_utils;
use wick::wick_staking::{Self as ws, WickStakingPool, StakeReceipt, StakingAdminCap};
use wick::wick_token::{Self as wt, WickTokenState, WICK_TOKEN};

const ALICE: address = @0xA;
const BOB: address = @0xB;
const CAROL: address = @0xC;

// === Helpers ===

fun init_pool_and_token(
    sc: &mut ts::Scenario,
): (WickStakingPool, StakingAdminCap, WickTokenState, wt::WickAdminCap, clock::Clock) {
    let (pool, scap) = ws::init_for_testing(sc.ctx());
    let (token_state, tcap) = wt::init_for_testing(sc.ctx());
    let mut clk = clock::create_for_testing(sc.ctx());
    clk.set_for_testing(1_000_000_000);
    (pool, scap, token_state, tcap, clk)
}

/// Mint WICK to an address by calling test_mint_to_loser. Caller is responsible
/// for ensuring the dampener is inactive (genesis_start_ms == 0 or > 7 days).
fun mint_wick_to(
    state: &mut WickTokenState,
    addr: address,
    loss_micro_usd: u64,
    clk: &clock::Clock,
    sc: &mut ts::Scenario,
): Coin<WICK_TOKEN> {
    let _ = wt::test_mint_to_loser(state, addr, loss_micro_usd, true, clk, sc.ctx());
    sc.next_tx(addr);
    sc.take_from_address<Coin<WICK_TOKEN>>(addr)
}

fun fee_balance(amount: u64, sc: &mut ts::Scenario): balance::Balance<SUI> {
    coin::mint_for_testing<SUI>(amount, sc.ctx()).into_balance()
}

// === Init ===

#[test]
fun init_pool_starts_empty() {
    let mut sc = ts::begin(ALICE);
    let (pool, scap, ts_, tcap, clk) = init_pool_and_token(&mut sc);
    assert!(ws::total_staked(&pool) == 0, 0);
    assert!(ws::cumulative_network_losses_micro_usd(&pool) == 0, 1);
    assert!(ws::cumulative_claimed_micro_usd(&pool) == 0, 2);
    assert!(ws::cumulative_forfeit_micro_usd(&pool) == 0, 3);
    assert!(ws::unstake_delay_ms() == 7 * 86_400_000, 4);
    assert!(ws::claim_cap_bps() == 3000, 5);

    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

// === Stake / unstake lifecycle ===

#[test]
fun stake_increases_total_and_returns_receipt() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, mut ts_, tcap, clk) = init_pool_and_token(&mut sc);

    // dampener inactive (genesis not init'd); mint 100 WICK to BOB ($1 loss → 100 WICK = 100 × 1e9 base)
    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    assert!(bob_wick.value() == 100_000_000_000, 0);

    sc.next_tx(BOB);
    let receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());
    assert!(ws::total_staked(&pool) == 100_000_000_000, 1);
    assert!(ws::receipt_owner(&receipt) == BOB, 2);
    assert!(ws::receipt_staked(&receipt) == 100_000_000_000, 3);

    test_utils::destroy(receipt);
    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = ws::EZeroAmount)]
fun stake_zero_aborts() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, ts_, tcap, clk) = init_pool_and_token(&mut sc);

    let zero = coin::zero<WICK_TOKEN>(sc.ctx());
    let r = ws::stake(&mut pool, zero, &clk, sc.ctx());

    test_utils::destroy(r);
    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun initiate_then_complete_unstake_after_delay() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, mut ts_, tcap, mut clk) = init_pool_and_token(&mut sc);

    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    let staked_amount = bob_wick.value();
    sc.next_tx(BOB);
    let mut receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    ws::initiate_unstake(&mut receipt, &pool, &clk, sc.ctx());
    assert!(option::is_some(ws::receipt_unstake_initiated_at_ms(&receipt)), 0);

    clk.increment_for_testing(7 * 86_400_000);  // exactly 7 days
    let withdrawn = ws::complete_unstake(receipt, &mut pool, &clk, sc.ctx());
    assert!(withdrawn.value() == staked_amount, 1);
    assert!(ws::total_staked(&pool) == 0, 2);

    test_utils::destroy(withdrawn);
    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = ws::EUnstakeStillLocked)]
fun complete_unstake_before_delay_aborts() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, mut ts_, tcap, mut clk) = init_pool_and_token(&mut sc);

    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    ws::initiate_unstake(&mut receipt, &pool, &clk, sc.ctx());
    clk.increment_for_testing(6 * 86_400_000);  // only 6 days
    let withdrawn = ws::complete_unstake(receipt, &mut pool, &clk, sc.ctx());

    test_utils::destroy(withdrawn);
    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = ws::ENotInitiated)]
fun complete_unstake_without_initiate_aborts() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, mut ts_, tcap, mut clk) = init_pool_and_token(&mut sc);

    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    clk.increment_for_testing(8 * 86_400_000);  // way past delay
    let withdrawn = ws::complete_unstake(receipt, &mut pool, &clk, sc.ctx());

    test_utils::destroy(withdrawn);
    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = ws::EAlreadyInitiated)]
fun double_initiate_unstake_aborts() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, mut ts_, tcap, clk) = init_pool_and_token(&mut sc);

    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());
    ws::initiate_unstake(&mut receipt, &pool, &clk, sc.ctx());
    ws::initiate_unstake(&mut receipt, &pool, &clk, sc.ctx());  // abort

    test_utils::destroy(receipt);
    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

// === Accrue + claim mechanics ===

#[test]
fun accrue_grows_acc_per_wick() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, mut ts_, tcap, clk) = init_pool_and_token(&mut sc);

    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());
    let staked = ws::receipt_staked(&receipt);

    let fee = fee_balance(1_000_000, &mut sc);  // 1M units of SUI
    ws::accrue_dividends<SUI>(&mut pool, fee);

    // acc_per_wick should = 1_000_000 × 1e12 / staked
    let expected = (1_000_000u128 * ws::acc_scale()) / (staked as u128);
    assert!(ws::acc_per_wick<SUI>(&pool) == expected, 0);
    assert!(ws::pending_balance<SUI>(&pool) == 1_000_000, 1);

    test_utils::destroy(receipt);
    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun accrue_with_zero_balance_is_noop() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, mut ts_, tcap, clk) = init_pool_and_token(&mut sc);

    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    let zero = balance::zero<SUI>();
    ws::accrue_dividends<SUI>(&mut pool, zero);
    assert!(ws::acc_per_wick<SUI>(&pool) == 0, 0);
    assert!(ws::pending_balance<SUI>(&pool) == 0, 1);

    test_utils::destroy(receipt);
    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun accrue_with_no_stakers_holds_pending_does_not_grow_acc() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, ts_, tcap, clk) = init_pool_and_token(&mut sc);

    // No stakers yet
    let fee = fee_balance(1_000_000, &mut sc);
    ws::accrue_dividends<SUI>(&mut pool, fee);

    assert!(ws::acc_per_wick<SUI>(&pool) == 0, 0);
    assert!(ws::pending_balance<SUI>(&pool) == 1_000_000, 1);

    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun claim_pays_proportional_to_stake() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, mut ts_, tcap, clk) = init_pool_and_token(&mut sc);

    // BOB stakes 100 WICK ($1 loss), CAROL stakes 100 WICK ($1 loss) — 50/50
    // Both need to have lifetime_loss tracked so the cap allows claims.
    // Use record_loss to also seed the cap budget.
    ws::test_record_loss(&mut pool, BOB, 1_000_000_000_000);   // $1M lifetime loss → cap is huge
    ws::test_record_loss(&mut pool, CAROL, 1_000_000_000_000);

    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut bob_receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    let carol_wick = mint_wick_to(&mut ts_, CAROL, 1_000_000, &clk, &mut sc);
    sc.next_tx(CAROL);
    let mut carol_receipt = ws::stake(&mut pool, carol_wick, &clk, sc.ctx());

    // Accrue 1000 fee — should split 500/500
    let fee = fee_balance(1000, &mut sc);
    ws::accrue_dividends<SUI>(&mut pool, fee);

    sc.next_tx(BOB);
    let (bob_coin, bob_forfeit) = ws::claim_dividends<SUI>(&mut bob_receipt, &mut pool, sc.ctx());
    assert!(bob_coin.value() == 500, 0);
    assert!(balance::value(&bob_forfeit) == 0, 1);
    balance::destroy_zero(bob_forfeit);

    sc.next_tx(CAROL);
    let (carol_coin, carol_forfeit) = ws::claim_dividends<SUI>(&mut carol_receipt, &mut pool, sc.ctx());
    assert!(carol_coin.value() == 500, 2);
    balance::destroy_zero(carol_forfeit);

    test_utils::destroy(bob_coin);
    test_utils::destroy(carol_coin);
    test_utils::destroy(bob_receipt);
    test_utils::destroy(carol_receipt);
    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun second_claim_returns_zero_after_first() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, mut ts_, tcap, clk) = init_pool_and_token(&mut sc);

    ws::test_record_loss(&mut pool, BOB, 1_000_000_000_000);
    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    let fee = fee_balance(1000, &mut sc);
    ws::accrue_dividends<SUI>(&mut pool, fee);

    let (c1, f1) = ws::claim_dividends<SUI>(&mut receipt, &mut pool, sc.ctx());
    assert!(c1.value() == 1000, 0);
    let (c2, f2) = ws::claim_dividends<SUI>(&mut receipt, &mut pool, sc.ctx());
    assert!(c2.value() == 0, 1);

    test_utils::destroy(c1); test_utils::destroy(c2);
    balance::destroy_zero(f1); balance::destroy_zero(f2);
    test_utils::destroy(receipt);
    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun claim_after_multiple_accrues_pays_full_total() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, mut ts_, tcap, clk) = init_pool_and_token(&mut sc);

    ws::test_record_loss(&mut pool, BOB, 1_000_000_000_000);
    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    ws::accrue_dividends<SUI>(&mut pool, fee_balance(300, &mut sc));
    ws::accrue_dividends<SUI>(&mut pool, fee_balance(700, &mut sc));

    let (c, f) = ws::claim_dividends<SUI>(&mut receipt, &mut pool, sc.ctx());
    assert!(c.value() == 1000, 0);
    balance::destroy_zero(f);

    test_utils::destroy(c);
    test_utils::destroy(receipt);
    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

// === Per-address claim cap (30% of lifetime loss) ===

#[test]
fun claim_capped_at_30pct_of_lifetime_loss_forfeits_excess() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, mut ts_, tcap, clk) = init_pool_and_token(&mut sc);

    // BOB lifetime loss: 1000. Cap = 30% × 1000 = 300.
    ws::test_record_loss(&mut pool, BOB, 1000);

    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    // Accrue 1000 fee — pending_for_user = 1000 (sole staker), cap = 300
    let fee = fee_balance(1000, &mut sc);
    ws::accrue_dividends<SUI>(&mut pool, fee);

    let (kept, forfeit) = ws::claim_dividends<SUI>(&mut receipt, &mut pool, sc.ctx());
    assert!(kept.value() == 300, 0);
    assert!(balance::value(&forfeit) == 700, 1);
    assert!(ws::cumulative_forfeit_micro_usd(&pool) == 700, 2);
    assert!(ws::addr_claimed_micro_usd(&pool, BOB) == 300, 3);

    test_utils::destroy(kept);
    test_utils::destroy(coin::from_balance(forfeit, sc.ctx()));
    test_utils::destroy(receipt);
    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun zero_lifetime_loss_means_zero_cap_full_forfeit() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, mut ts_, tcap, clk) = init_pool_and_token(&mut sc);

    // BOB stakes but has no lifetime loss → cap = 0 → 100% forfeit
    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    let fee = fee_balance(1000, &mut sc);
    ws::accrue_dividends<SUI>(&mut pool, fee);

    let (kept, forfeit) = ws::claim_dividends<SUI>(&mut receipt, &mut pool, sc.ctx());
    assert!(kept.value() == 0, 0);
    assert!(balance::value(&forfeit) == 1000, 1);
    assert!(ws::cumulative_claimed_micro_usd(&pool) == 0, 2);
    assert!(ws::cumulative_forfeit_micro_usd(&pool) == 1000, 3);

    test_utils::destroy(kept);
    test_utils::destroy(coin::from_balance(forfeit, sc.ctx()));
    test_utils::destroy(receipt);
    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun cap_carries_across_multiple_claims_in_same_currency() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, mut ts_, tcap, clk) = init_pool_and_token(&mut sc);

    ws::test_record_loss(&mut pool, BOB, 1000);  // cap = 300

    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    // First claim: 200 fee → kept 200, used 200 of cap, 100 remaining
    ws::accrue_dividends<SUI>(&mut pool, fee_balance(200, &mut sc));
    let (k1, f1) = ws::claim_dividends<SUI>(&mut receipt, &mut pool, sc.ctx());
    assert!(k1.value() == 200, 0);
    balance::destroy_zero(f1);

    // Second claim: 500 fee → only 100 cap remains, kept 100, forfeit 400
    ws::accrue_dividends<SUI>(&mut pool, fee_balance(500, &mut sc));
    let (k2, f2) = ws::claim_dividends<SUI>(&mut receipt, &mut pool, sc.ctx());
    assert!(k2.value() == 100, 1);
    assert!(balance::value(&f2) == 400, 2);

    // Third claim: cap now exhausted; 100 fee → kept 0, forfeit 100
    ws::accrue_dividends<SUI>(&mut pool, fee_balance(100, &mut sc));
    let (k3, f3) = ws::claim_dividends<SUI>(&mut receipt, &mut pool, sc.ctx());
    assert!(k3.value() == 0, 3);
    assert!(balance::value(&f3) == 100, 4);

    assert!(ws::addr_claimed_micro_usd(&pool, BOB) == 300, 5);
    assert!(ws::cumulative_forfeit_micro_usd(&pool) == 500, 6);

    test_utils::destroy(k1); test_utils::destroy(k2); test_utils::destroy(k3);
    test_utils::destroy(coin::from_balance(f2, sc.ctx()));
    test_utils::destroy(coin::from_balance(f3, sc.ctx()));
    test_utils::destroy(receipt);
    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun additional_loss_after_claim_extends_cap() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, mut ts_, tcap, clk) = init_pool_and_token(&mut sc);

    ws::test_record_loss(&mut pool, BOB, 1000);  // cap = 300
    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    // Use up the full 300 cap
    ws::accrue_dividends<SUI>(&mut pool, fee_balance(300, &mut sc));
    let (k1, f1) = ws::claim_dividends<SUI>(&mut receipt, &mut pool, sc.ctx());
    assert!(k1.value() == 300, 0);
    balance::destroy_zero(f1);

    // BOB takes another 1000 loss → lifetime loss now 2000, cap now 600, used 300, remaining 300
    ws::test_record_loss(&mut pool, BOB, 1000);

    ws::accrue_dividends<SUI>(&mut pool, fee_balance(500, &mut sc));
    let (k2, f2) = ws::claim_dividends<SUI>(&mut receipt, &mut pool, sc.ctx());
    assert!(k2.value() == 300, 1);
    assert!(balance::value(&f2) == 200, 2);

    test_utils::destroy(k1); test_utils::destroy(k2);
    test_utils::destroy(coin::from_balance(f2, sc.ctx()));
    test_utils::destroy(receipt);
    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

// === Cleanup correctness ===

#[test]
fun unstake_after_claim_succeeds_no_bag_destroy_bug() {
    // Regression: an earlier impl held debt in a Bag and called destroy_empty
    // on unstake — which aborted if the staker had ever claimed. VecMap fix
    // means the receipt drops cleanly.
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, mut ts_, tcap, mut clk) = init_pool_and_token(&mut sc);

    ws::test_record_loss(&mut pool, BOB, 1_000_000_000_000);
    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    ws::accrue_dividends<SUI>(&mut pool, fee_balance(1000, &mut sc));
    let (c, f) = ws::claim_dividends<SUI>(&mut receipt, &mut pool, sc.ctx());

    ws::initiate_unstake(&mut receipt, &pool, &clk, sc.ctx());
    clk.increment_for_testing(7 * 86_400_000);
    let withdrawn = ws::complete_unstake(receipt, &mut pool, &clk, sc.ctx());
    assert!(withdrawn.value() == 100_000_000_000, 0);

    test_utils::destroy(c);
    balance::destroy_zero(f);
    test_utils::destroy(withdrawn);
    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

// === Loss tracking telemetry ===

#[test]
fun record_loss_accumulates_per_address_and_pool() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, ts_, tcap, clk) = init_pool_and_token(&mut sc);

    ws::test_record_loss(&mut pool, BOB, 100);
    ws::test_record_loss(&mut pool, BOB, 250);
    ws::test_record_loss(&mut pool, CAROL, 400);

    assert!(ws::addr_lifetime_loss_micro_usd(&pool, BOB) == 350, 0);
    assert!(ws::addr_lifetime_loss_micro_usd(&pool, CAROL) == 400, 1);
    assert!(ws::addr_lifetime_loss_micro_usd(&pool, ALICE) == 0, 2);
    assert!(ws::cumulative_network_losses_micro_usd(&pool) == 750, 3);

    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun record_loss_zero_is_noop() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, ts_, tcap, clk) = init_pool_and_token(&mut sc);

    ws::test_record_loss(&mut pool, BOB, 0);
    assert!(ws::addr_lifetime_loss_micro_usd(&pool, BOB) == 0, 0);
    assert!(ws::cumulative_network_losses_micro_usd(&pool) == 0, 1);

    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

// === Multi-currency dividends ===

#[test]
fun accrue_two_currencies_track_independently() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, mut ts_, tcap, clk) = init_pool_and_token(&mut sc);

    ws::test_record_loss(&mut pool, BOB, 1_000_000_000_000);
    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    // Accrue SUI fee
    ws::accrue_dividends<SUI>(&mut pool, fee_balance(1000, &mut sc));
    // Also accrue WICK_TOKEN fee (use WICK as a stand-in second currency since
    // we can mint test units of it)
    let _ = wt::test_mint_to_loser(&mut ts_, ALICE, 500_000, true, &clk, sc.ctx());
    sc.next_tx(ALICE);
    let alice_wick: Coin<WICK_TOKEN> = sc.take_from_address(ALICE);
    ws::accrue_dividends<WICK_TOKEN>(&mut pool, alice_wick.into_balance());

    // Claim SUI as BOB
    sc.next_tx(BOB);
    let (sui_c, sui_f) = ws::claim_dividends<SUI>(&mut receipt, &mut pool, sc.ctx());
    assert!(sui_c.value() == 1000, 0);
    balance::destroy_zero(sui_f);

    // Claim WICK_TOKEN — should be 500_000 × 100_000 = 50e9
    let (wick_c, wick_f) = ws::claim_dividends<WICK_TOKEN>(&mut receipt, &mut pool, sc.ctx());
    assert!(wick_c.value() == 50_000_000_000, 1);
    balance::destroy_zero(wick_f);

    test_utils::destroy(sui_c);
    test_utils::destroy(wick_c);
    test_utils::destroy(receipt);
    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

// === Late-join dilution: new staker doesn't claim historical fees retroactively
//     (with the lazy-snapshot caveat for never-seen currencies) ===

#[test]
fun late_staker_does_not_take_pre_stake_dividends_in_seen_currency() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, mut ts_, tcap, clk) = init_pool_and_token(&mut sc);

    ws::test_record_loss(&mut pool, BOB, 1_000_000_000_000);
    ws::test_record_loss(&mut pool, CAROL, 1_000_000_000_000);

    // BOB stakes first, accrue happens, then CAROL stakes.
    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut bob_receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    // Accrue into SUI — only BOB exists
    ws::accrue_dividends<SUI>(&mut pool, fee_balance(1000, &mut sc));

    // CAROL stakes after the first accrue
    let carol_wick = mint_wick_to(&mut ts_, CAROL, 1_000_000, &clk, &mut sc);
    sc.next_tx(CAROL);
    let mut carol_receipt = ws::stake(&mut pool, carol_wick, &clk, sc.ctx());

    // Right now the SUI acc is non-zero — CAROL's debt should snapshot it on
    // first claim of SUI and pay her zero for pre-stake fees.
    let (carol_c, carol_f) = ws::claim_dividends<SUI>(&mut carol_receipt, &mut pool, sc.ctx());
    assert!(carol_c.value() == 0, 0);
    balance::destroy_zero(carol_f);

    // BOB still gets the full 1000 (sole pre-stake holder)
    sc.next_tx(BOB);
    let (bob_c, bob_f) = ws::claim_dividends<SUI>(&mut bob_receipt, &mut pool, sc.ctx());
    assert!(bob_c.value() == 1000, 1);
    balance::destroy_zero(bob_f);

    test_utils::destroy(carol_c); test_utils::destroy(bob_c);
    test_utils::destroy(carol_receipt); test_utils::destroy(bob_receipt);
    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

// === Authorization checks ===

#[test]
#[expected_failure(abort_code = ws::ENotOwner)]
fun non_owner_cannot_initiate_unstake() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, mut ts_, tcap, clk) = init_pool_and_token(&mut sc);

    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    sc.next_tx(CAROL);  // CAROL is not the owner
    ws::initiate_unstake(&mut receipt, &pool, &clk, sc.ctx());

    test_utils::destroy(receipt);
    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = ws::ENotOwner)]
fun non_owner_cannot_claim_dividends() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, mut ts_, tcap, clk) = init_pool_and_token(&mut sc);

    ws::test_record_loss(&mut pool, BOB, 1_000_000_000_000);
    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    ws::accrue_dividends<SUI>(&mut pool, fee_balance(1000, &mut sc));

    sc.next_tx(CAROL);
    let (c, f) = ws::claim_dividends<SUI>(&mut receipt, &mut pool, sc.ctx());

    test_utils::destroy(c);
    balance::destroy_zero(f);
    test_utils::destroy(receipt);
    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = ws::ENotOwner)]
fun non_owner_cannot_complete_unstake() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, mut ts_, tcap, mut clk) = init_pool_and_token(&mut sc);

    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());
    ws::initiate_unstake(&mut receipt, &pool, &clk, sc.ctx());

    clk.increment_for_testing(7 * 86_400_000);
    sc.next_tx(CAROL);
    let withdrawn = ws::complete_unstake(receipt, &mut pool, &clk, sc.ctx());

    test_utils::destroy(withdrawn);
    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}
