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
const INSURANCE: address = @0xDEAD;

// === Helpers ===

fun init_state(
    sc: &mut ts::Scenario,
): (WickStakingPool, StakingAdminCap, WickTokenState, wt::WickAdminCap, clock::Clock) {
    let (pool, scap) = ws::init_for_testing(sc.ctx());
    let (token_state, tcap) = wt::init_for_testing(sc.ctx());
    let mut clk = clock::create_for_testing(sc.ctx());
    clk.set_for_testing(1_000_000_000);
    (pool, scap, token_state, tcap, clk)
}

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

/// Drain whatever forfeited coins were auto-routed to INSURANCE.
fun drain_insurance_sui(sc: &mut ts::Scenario): u64 {
    sc.next_tx(INSURANCE);
    let mut total: u64 = 0;
    while (ts::has_most_recent_for_address<Coin<SUI>>(INSURANCE)) {
        let c: Coin<SUI> = sc.take_from_address(INSURANCE);
        total = total + c.value();
        test_utils::destroy(c);
    };
    total
}

fun drain_insurance_wick(sc: &mut ts::Scenario): u64 {
    sc.next_tx(INSURANCE);
    let mut total: u64 = 0;
    while (ts::has_most_recent_for_address<Coin<WICK_TOKEN>>(INSURANCE)) {
        let c: Coin<WICK_TOKEN> = sc.take_from_address(INSURANCE);
        total = total + c.value();
        test_utils::destroy(c);
    };
    total
}

// === Init ===

#[test]
fun init_pool_starts_empty() {
    let mut sc = ts::begin(ALICE);
    let (pool, scap, ts_, tcap, clk) = init_state(&mut sc);
    assert!(ws::total_staked(&pool) == 0, 0);
    assert!(ws::cumulative_network_losses_micro_usd(&pool) == 0, 1);
    assert!(ws::cumulative_claimed_micro_usd(&pool) == 0, 2);
    assert!(ws::cumulative_forfeit_micro_usd(&pool) == 0, 3);
    assert!(ws::unstake_delay_ms() == 7 * 86_400_000, 4);
    assert!(ws::claim_cap_bps() == 3000, 5);
    assert!(ws::insurance_recipient(&pool) == INSURANCE, 6);

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
    let (mut pool, scap, mut ts_, tcap, clk) = init_state(&mut sc);

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
    let (mut pool, scap, ts_, tcap, clk) = init_state(&mut sc);

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
    let (mut pool, scap, mut ts_, tcap, mut clk) = init_state(&mut sc);

    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    let staked_amount = bob_wick.value();
    sc.next_tx(BOB);
    let mut receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    ws::initiate_unstake(&mut receipt, &pool, &clk, sc.ctx());
    assert!(option::is_some(ws::receipt_unstake_initiated_at_ms(&receipt)), 0);

    clk.increment_for_testing(7 * 86_400_000);
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
    let (mut pool, scap, mut ts_, tcap, mut clk) = init_state(&mut sc);

    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    ws::initiate_unstake(&mut receipt, &pool, &clk, sc.ctx());
    clk.increment_for_testing(6 * 86_400_000);
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
    let (mut pool, scap, mut ts_, tcap, mut clk) = init_state(&mut sc);

    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    clk.increment_for_testing(8 * 86_400_000);
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
    let (mut pool, scap, mut ts_, tcap, clk) = init_state(&mut sc);

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
    let (mut pool, scap, mut ts_, tcap, clk) = init_state(&mut sc);

    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());
    let staked = ws::receipt_staked(&receipt);

    let fee = fee_balance(1_000_000, &mut sc);
    ws::accrue_dividends<SUI>(&mut pool, fee);

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
    let (mut pool, scap, mut ts_, tcap, clk) = init_state(&mut sc);

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
    let (mut pool, scap, ts_, tcap, clk) = init_state(&mut sc);

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
    let (mut pool, scap, mut ts_, tcap, clk) = init_state(&mut sc);

    // Both stakers have huge lifetime loss → caps non-binding.
    ws::test_record_loss(&mut pool, BOB, 1_000_000_000_000);
    ws::test_record_loss(&mut pool, CAROL, 1_000_000_000_000);

    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut bob_receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    let carol_wick = mint_wick_to(&mut ts_, CAROL, 1_000_000, &clk, &mut sc);
    sc.next_tx(CAROL);
    let mut carol_receipt = ws::stake(&mut pool, carol_wick, &clk, sc.ctx());

    let fee = fee_balance(1000, &mut sc);
    ws::accrue_dividends<SUI>(&mut pool, fee);

    sc.next_tx(BOB);
    let bob_coin = ws::claim_dividends<SUI>(&mut bob_receipt, &mut pool, sc.ctx());
    assert!(bob_coin.value() == 500, 0);

    sc.next_tx(CAROL);
    let carol_coin = ws::claim_dividends<SUI>(&mut carol_receipt, &mut pool, sc.ctx());
    assert!(carol_coin.value() == 500, 1);

    // No forfeit was generated.
    assert!(ws::cumulative_forfeit_micro_usd(&pool) == 0, 2);

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
    let (mut pool, scap, mut ts_, tcap, clk) = init_state(&mut sc);

    ws::test_record_loss(&mut pool, BOB, 1_000_000_000_000);
    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    let fee = fee_balance(1000, &mut sc);
    ws::accrue_dividends<SUI>(&mut pool, fee);

    let c1 = ws::claim_dividends<SUI>(&mut receipt, &mut pool, sc.ctx());
    assert!(c1.value() == 1000, 0);
    let c2 = ws::claim_dividends<SUI>(&mut receipt, &mut pool, sc.ctx());
    assert!(c2.value() == 0, 1);

    test_utils::destroy(c1); test_utils::destroy(c2);
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
    let (mut pool, scap, mut ts_, tcap, clk) = init_state(&mut sc);

    ws::test_record_loss(&mut pool, BOB, 1_000_000_000_000);
    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    ws::accrue_dividends<SUI>(&mut pool, fee_balance(300, &mut sc));
    ws::accrue_dividends<SUI>(&mut pool, fee_balance(700, &mut sc));

    let c = ws::claim_dividends<SUI>(&mut receipt, &mut pool, sc.ctx());
    assert!(c.value() == 1000, 0);

    test_utils::destroy(c);
    test_utils::destroy(receipt);
    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

// === Per-address claim cap (30% of lifetime loss) — auto-routes forfeit ===

#[test]
fun claim_capped_at_30pct_of_lifetime_loss_forfeit_auto_routed() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, mut ts_, tcap, clk) = init_state(&mut sc);

    // BOB: lifetime loss 1000 → addr cap = 300.
    ws::test_record_loss(&mut pool, BOB, 1000);
    // Boost network total so per-fund cap is non-binding.
    ws::test_record_loss(&mut pool, @0xDDD, 1_000_000);

    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    let fee = fee_balance(1000, &mut sc);
    ws::accrue_dividends<SUI>(&mut pool, fee);

    let kept = ws::claim_dividends<SUI>(&mut receipt, &mut pool, sc.ctx());
    assert!(kept.value() == 300, 0);
    assert!(ws::cumulative_forfeit_micro_usd(&pool) == 700, 1);
    assert!(ws::addr_claimed_micro_usd(&pool, BOB) == 300, 2);

    // Auto-routed: 700 sitting at insurance recipient.
    let routed = drain_insurance_sui(&mut sc);
    assert!(routed == 700, 3);

    test_utils::destroy(kept);
    test_utils::destroy(receipt);
    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun zero_lifetime_loss_means_zero_cap_full_forfeit_auto_routed() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, mut ts_, tcap, clk) = init_state(&mut sc);

    // Add network loss so per-fund cap isn't the binding one.
    ws::test_record_loss(&mut pool, @0xDDD, 1_000_000);

    // BOB stakes but has zero lifetime loss → per-address cap = 0 → 100% forfeit.
    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    let fee = fee_balance(1000, &mut sc);
    ws::accrue_dividends<SUI>(&mut pool, fee);

    let kept = ws::claim_dividends<SUI>(&mut receipt, &mut pool, sc.ctx());
    assert!(kept.value() == 0, 0);
    assert!(ws::cumulative_claimed_micro_usd(&pool) == 0, 1);
    assert!(ws::cumulative_forfeit_micro_usd(&pool) == 1000, 2);
    assert!(drain_insurance_sui(&mut sc) == 1000, 3);

    test_utils::destroy(kept);
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
    let (mut pool, scap, mut ts_, tcap, clk) = init_state(&mut sc);

    ws::test_record_loss(&mut pool, BOB, 1000);
    ws::test_record_loss(&mut pool, @0xDDD, 1_000_000);

    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    // First claim: 200 fee → kept 200, no forfeit.
    ws::accrue_dividends<SUI>(&mut pool, fee_balance(200, &mut sc));
    let k1 = ws::claim_dividends<SUI>(&mut receipt, &mut pool, sc.ctx());
    assert!(k1.value() == 200, 0);

    // Second: 500 fee → only 100 of cap left, kept 100, forfeit 400.
    ws::accrue_dividends<SUI>(&mut pool, fee_balance(500, &mut sc));
    let k2 = ws::claim_dividends<SUI>(&mut receipt, &mut pool, sc.ctx());
    assert!(k2.value() == 100, 1);

    // Third: cap exhausted; 100 fee → kept 0, forfeit 100.
    ws::accrue_dividends<SUI>(&mut pool, fee_balance(100, &mut sc));
    let k3 = ws::claim_dividends<SUI>(&mut receipt, &mut pool, sc.ctx());
    assert!(k3.value() == 0, 2);

    assert!(ws::addr_claimed_micro_usd(&pool, BOB) == 300, 3);
    assert!(ws::cumulative_forfeit_micro_usd(&pool) == 500, 4);
    assert!(drain_insurance_sui(&mut sc) == 500, 5);

    test_utils::destroy(k1); test_utils::destroy(k2); test_utils::destroy(k3);
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
    let (mut pool, scap, mut ts_, tcap, clk) = init_state(&mut sc);

    ws::test_record_loss(&mut pool, BOB, 1000);
    ws::test_record_loss(&mut pool, @0xDDD, 1_000_000);
    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    ws::accrue_dividends<SUI>(&mut pool, fee_balance(300, &mut sc));
    let k1 = ws::claim_dividends<SUI>(&mut receipt, &mut pool, sc.ctx());
    assert!(k1.value() == 300, 0);

    // BOB takes another 1000 loss → addr cap now 600, used 300, remaining 300.
    ws::test_record_loss(&mut pool, BOB, 1000);

    ws::accrue_dividends<SUI>(&mut pool, fee_balance(500, &mut sc));
    let k2 = ws::claim_dividends<SUI>(&mut receipt, &mut pool, sc.ctx());
    assert!(k2.value() == 300, 1);
    assert!(ws::cumulative_forfeit_micro_usd(&pool) == 200, 2);
    assert!(drain_insurance_sui(&mut sc) == 200, 3);

    test_utils::destroy(k1); test_utils::destroy(k2);
    test_utils::destroy(receipt);
    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

// === Per-fund cap (NEW) ===

#[test]
fun per_fund_cap_binds_when_tighter_than_address_cap() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, mut ts_, tcap, clk) = init_state(&mut sc);

    // BOB has huge personal loss → addr cap is huge.
    ws::test_record_loss(&mut pool, BOB, 1_000_000_000);
    // But cumulative network loss is tiny — fund cap = 30% × 100 = 30.
    // Wait: BOB's record_loss already counts toward cumulative. So
    // cumulative = 1_000_000_000, fund cap = 30% × 1_000_000_000 = 300M.
    // To make per-fund the binding constraint, override:
    // we need cumulative to be small while addr is large. Skip BOB's record_loss above
    // and instead inflate addr_state directly through small losses on other addresses.

    // Reset by re-init.
    test_utils::destroy(pool);
    test_utils::destroy(scap);
    let (mut pool2, scap2) = ws::init_for_testing(sc.ctx());

    // BOB: addr cap based on 1B → 300M.
    ws::test_record_loss(&mut pool2, BOB, 1_000_000_000);
    // Now BOB has lifetime_loss=1B (also adds to cumulative). cumulative = 1B.
    // fund cap = 30% × 1B = 300M = same as addr cap.
    // So claim 1000 → both caps allow → kept = 1000.
    // To make fund tighter: register 1000 in cumulative while 1B in addr_state...
    // Not possible with current API since record_loss is the only writer.
    // → instead test where total cumulative across multiple addresses is tiny.

    // Reset again — use only direct table manip via record_loss with small amounts.
    test_utils::destroy(pool2);
    test_utils::destroy(scap2);
    let (mut pool3, scap3) = ws::init_for_testing(sc.ctx());

    // BOB: 500 loss. CAROL: 500 loss. cumulative = 1000. Fund cap = 300.
    // BOB addr cap = 30% × 500 = 150 (binding for BOB).
    ws::test_record_loss(&mut pool3, BOB, 500);
    ws::test_record_loss(&mut pool3, CAROL, 500);
    assert!(ws::fund_cap_remaining_micro_usd(&pool3) == 300, 0);
    assert!(ws::addr_cap_remaining_micro_usd(&pool3, BOB) == 150, 1);

    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut bob_receipt = ws::stake(&mut pool3, bob_wick, &clk, sc.ctx());

    // BOB sole staker. Accrue 1000 → all 1000 BOB's pending.
    // BOB addr cap = 150, fund cap = 300. min = 150 → kept 150, forfeit 850.
    ws::accrue_dividends<SUI>(&mut pool3, fee_balance(1000, &mut sc));
    let k = ws::claim_dividends<SUI>(&mut bob_receipt, &mut pool3, sc.ctx());
    assert!(k.value() == 150, 2);
    assert!(ws::cumulative_forfeit_micro_usd(&pool3) == 850, 3);

    // Now accrue another 1000 and have CAROL claim.
    let carol_wick = mint_wick_to(&mut ts_, CAROL, 500_000, &clk, &mut sc);
    sc.next_tx(CAROL);
    let mut carol_receipt = ws::stake(&mut pool3, carol_wick, &clk, sc.ctx());

    // After CAROL's stake, total_staked doubled (BOB still in).
    // Wait — BOB minted 100 WICK ($1 → 100 WICK × 1e9 = 1e11),
    // CAROL minted 50 WICK ($0.5 → 50 WICK × 1e9 = 5e10).
    // Wait actually both at flat_rate × loss → BOB 1M loss → 1M × 1e5 = 1e11,
    // CAROL 500k loss → 500k × 1e5 = 5e10. CAROL's stake is half BOB's.
    // Accrue 600 → BOB gets 400, CAROL gets 200 (proportional).
    ws::accrue_dividends<SUI>(&mut pool3, fee_balance(600, &mut sc));

    // CAROL's addr cap = 30% × 500 = 150.
    // Fund cap remaining: 300 - 150 (BOB's earlier kept) = 150.
    sc.next_tx(CAROL);
    let kc = ws::claim_dividends<SUI>(&mut carol_receipt, &mut pool3, sc.ctx());
    // CAROL's pending = 200, but min(addr=150, fund=150) = 150 → kept 150.
    assert!(kc.value() == 150, 4);
    // Cumulative claimed = 150 + 150 = 300 — fund cap exhausted.
    assert!(ws::fund_cap_remaining_micro_usd(&pool3) == 0, 5);

    // Drain insurance: 850 (BOB1) + 50 (CAROL forfeit 200-150) = 900.
    assert!(drain_insurance_sui(&mut sc) == 900, 6);

    test_utils::destroy(k);
    test_utils::destroy(kc);
    test_utils::destroy(bob_receipt);
    test_utils::destroy(carol_receipt);
    test_utils::destroy(pool3);
    test_utils::destroy(scap3);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun fund_cap_zero_when_no_network_losses_full_forfeit() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, mut ts_, tcap, clk) = init_state(&mut sc);

    // Set BOB's addr loss large but DON'T touch cumulative... wait, record_loss
    // does both. So this scenario requires zero record_loss calls. fund cap = 0.
    // BOB stakes; no loss tracked anywhere; both caps = 0 → 100% forfeit.
    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    assert!(ws::fund_cap_remaining_micro_usd(&pool) == 0, 0);

    ws::accrue_dividends<SUI>(&mut pool, fee_balance(1000, &mut sc));
    let k = ws::claim_dividends<SUI>(&mut receipt, &mut pool, sc.ctx());
    assert!(k.value() == 0, 1);
    assert!(drain_insurance_sui(&mut sc) == 1000, 2);

    test_utils::destroy(k);
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
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, mut ts_, tcap, mut clk) = init_state(&mut sc);

    ws::test_record_loss(&mut pool, BOB, 1_000_000_000_000);
    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    ws::accrue_dividends<SUI>(&mut pool, fee_balance(1000, &mut sc));
    let c = ws::claim_dividends<SUI>(&mut receipt, &mut pool, sc.ctx());

    ws::initiate_unstake(&mut receipt, &pool, &clk, sc.ctx());
    clk.increment_for_testing(7 * 86_400_000);
    let withdrawn = ws::complete_unstake(receipt, &mut pool, &clk, sc.ctx());
    assert!(withdrawn.value() == 100_000_000_000, 0);

    test_utils::destroy(c);
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
    let (mut pool, scap, ts_, tcap, clk) = init_state(&mut sc);

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
    let (mut pool, scap, ts_, tcap, clk) = init_state(&mut sc);

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
    let (mut pool, scap, mut ts_, tcap, clk) = init_state(&mut sc);

    ws::test_record_loss(&mut pool, BOB, 1_000_000_000_000);
    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    ws::accrue_dividends<SUI>(&mut pool, fee_balance(1000, &mut sc));
    let _ = wt::test_mint_to_loser(&mut ts_, ALICE, 500_000, true, &clk, sc.ctx());
    sc.next_tx(ALICE);
    let alice_wick: Coin<WICK_TOKEN> = sc.take_from_address(ALICE);
    ws::accrue_dividends<WICK_TOKEN>(&mut pool, alice_wick.into_balance());

    sc.next_tx(BOB);
    let sui_c = ws::claim_dividends<SUI>(&mut receipt, &mut pool, sc.ctx());
    assert!(sui_c.value() == 1000, 0);

    let wick_c = ws::claim_dividends<WICK_TOKEN>(&mut receipt, &mut pool, sc.ctx());
    assert!(wick_c.value() == 50_000_000_000, 1);

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

// === Late-join dilution: new staker doesn't claim historical fees retroactively ===

#[test]
fun late_staker_does_not_take_pre_stake_dividends_in_seen_currency() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, mut ts_, tcap, clk) = init_state(&mut sc);

    ws::test_record_loss(&mut pool, BOB, 1_000_000_000_000);
    ws::test_record_loss(&mut pool, CAROL, 1_000_000_000_000);

    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut bob_receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    ws::accrue_dividends<SUI>(&mut pool, fee_balance(1000, &mut sc));

    let carol_wick = mint_wick_to(&mut ts_, CAROL, 1_000_000, &clk, &mut sc);
    sc.next_tx(CAROL);
    let mut carol_receipt = ws::stake(&mut pool, carol_wick, &clk, sc.ctx());

    let carol_c = ws::claim_dividends<SUI>(&mut carol_receipt, &mut pool, sc.ctx());
    assert!(carol_c.value() == 0, 0);

    sc.next_tx(BOB);
    let bob_c = ws::claim_dividends<SUI>(&mut bob_receipt, &mut pool, sc.ctx());
    assert!(bob_c.value() == 1000, 1);

    test_utils::destroy(carol_c); test_utils::destroy(bob_c);
    test_utils::destroy(carol_receipt); test_utils::destroy(bob_receipt);
    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

// === Authorization ===

#[test]
#[expected_failure(abort_code = ws::ENotOwner)]
fun non_owner_cannot_initiate_unstake() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, mut ts_, tcap, clk) = init_state(&mut sc);

    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    sc.next_tx(CAROL);
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
    let (mut pool, scap, mut ts_, tcap, clk) = init_state(&mut sc);

    ws::test_record_loss(&mut pool, BOB, 1_000_000_000_000);
    let bob_wick = mint_wick_to(&mut ts_, BOB, 1_000_000, &clk, &mut sc);
    sc.next_tx(BOB);
    let mut receipt = ws::stake(&mut pool, bob_wick, &clk, sc.ctx());

    ws::accrue_dividends<SUI>(&mut pool, fee_balance(1000, &mut sc));

    sc.next_tx(CAROL);
    let c = ws::claim_dividends<SUI>(&mut receipt, &mut pool, sc.ctx());

    test_utils::destroy(c);
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
    let (mut pool, scap, mut ts_, tcap, mut clk) = init_state(&mut sc);

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

// === Admin: insurance recipient rotation ===

#[test]
fun admin_can_rotate_insurance_recipient() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, ts_, tcap, clk) = init_state(&mut sc);

    assert!(ws::insurance_recipient(&pool) == INSURANCE, 0);
    ws::set_insurance_recipient(&scap, &mut pool, @0xCAFE);
    assert!(ws::insurance_recipient(&pool) == @0xCAFE, 1);

    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = ws::ENotAdmin)]
fun cannot_set_insurance_to_zero() {
    let mut sc = ts::begin(ALICE);
    let (mut pool, scap, ts_, tcap, clk) = init_state(&mut sc);
    ws::set_insurance_recipient(&scap, &mut pool, @0x0);

    test_utils::destroy(pool);
    test_utils::destroy(scap);
    test_utils::destroy(ts_);
    test_utils::destroy(tcap);
    clk.destroy_for_testing();
    sc.end();
}
