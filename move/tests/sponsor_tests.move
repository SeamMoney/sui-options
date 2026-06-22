// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

#[test_only]
#[allow(deprecated_usage)]
module wick::sponsor_tests;

use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario as ts;
use sui::test_utils;
use wick::fee_router as fr;
use wick::martingaler_vault as mv;
use wick::sponsor;

const ALICE: address = @0xA;
const SPONSOR_WALLET: address = @0xBEEF;
const BOB: address = @0xB;

fun mid(addr: address): ID { object::id_from_address(addr) }

/// Helper: build a fee_router with `protocol_amount` SUI in its protocol
/// bucket by accruing a sufficiently large fee. Default shares put 10% to
/// protocol so we send `protocol_amount * 10` MIST through `accrue`.
fun fee_router_with_protocol_bucket(
    protocol_amount_mist: u64,
    sc: &mut ts::Scenario,
    clk: &clock::Clock,
): (fr::FeeRouter<SUI>, fr::FeeRouterAdminCap, mv::MartingalerVault<SUI>, mv::VaultAdminCap) {
    let (mut router, r_cap) = fr::init_for_testing<SUI>(sc.ctx());
    let (mut vault, v_cap) = mv::init_for_testing<SUI>(sc.ctx());
    if (protocol_amount_mist > 0) {
        // protocol share = 10% of total — accrue 10× the desired bucket size.
        let total_fee = protocol_amount_mist * 10;
        let fee = coin::mint_for_testing<SUI>(total_fee, sc.ctx()).into_balance();
        fr::test_accrue(&mut router, &mut vault, mid(@0x111), fee, clk, sc.ctx());
    };
    (router, r_cap, vault, v_cap)
}

// === Initial state ===

#[test]
fun sponsor_initial_state_is_correct() {
    let mut sc = ts::begin(ALICE);
    let (policy, cap) = sponsor::init_for_testing(SPONSOR_WALLET, sc.ctx());

    assert!(sponsor::sponsor_address(&policy) == SPONSOR_WALLET, 0);
    // Defaults from doc 22 §3.1 + §5.
    assert!(sponsor::max_spend_per_day_mist(&policy) == 250_000_000_000, 1);
    assert!(sponsor::refill_threshold_mist(&policy) == 5_000_000_000, 2);
    assert!(sponsor::refill_target_mist(&policy) == 50_000_000_000, 3);
    assert!(sponsor::spend_today_mist(&policy) == 0, 4);
    assert!(sponsor::last_reset_day(&policy) == 0, 5);

    test_utils::destroy(policy);
    test_utils::destroy(cap);
    sc.end();
}

// === Threshold gate ===

#[test]
#[expected_failure(abort_code = sponsor::ENotBelowThreshold)]
fun harvest_to_sponsor_aborts_when_above_threshold() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    let (policy, cap) = sponsor::init_for_testing(SPONSOR_WALLET, sc.ctx());
    let (router, r_cap, vault, v_cap) =
        fee_router_with_protocol_bucket(100_000_000_000, &mut sc, &clk);

    // Threshold = 5 SUI = 5_000_000_000. Pass exactly at threshold → abort.
    let mut policy_mut = policy;
    let mut router_mut = router;
    sponsor::harvest_to_sponsor(
        &mut policy_mut,
        &mut router_mut,
        5_000_000_000, // == threshold, NOT below
        &clk,
        sc.ctx(),
    );

    test_utils::destroy(policy_mut);
    test_utils::destroy(cap);
    test_utils::destroy(router_mut);
    test_utils::destroy(r_cap);
    test_utils::destroy(vault);
    test_utils::destroy(v_cap);
    clk.destroy_for_testing();
    sc.end();
}

// === Happy path ===

#[test]
fun harvest_to_sponsor_succeeds_when_below_threshold_and_credits_sponsor() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    let (policy, cap) = sponsor::init_for_testing(SPONSOR_WALLET, sc.ctx());
    // Seed protocol bucket with 100 SUI (10 % of a 1000-SUI fee accrual).
    let (mut router, r_cap, vault, v_cap) =
        fee_router_with_protocol_bucket(100_000_000_000, &mut sc, &clk);
    assert!(fr::protocol_pending(&router) == 100_000_000_000, 100);

    // Sponsor wallet currently has 1 SUI. Target = 50 SUI. Expect drain
    // of 49 SUI (target - current).
    let mut policy_mut = policy;
    sponsor::harvest_to_sponsor(
        &mut policy_mut,
        &mut router,
        1_000_000_000, // 1 SUI current sponsor balance
        &clk,
        sc.ctx(),
    );

    // 49 SUI drained from the protocol bucket.
    assert!(fr::protocol_pending(&router) == 100_000_000_000 - 49_000_000_000, 0);
    // Daily spend bumped by the actual drained amount.
    assert!(sponsor::spend_today_mist(&policy_mut) == 49_000_000_000, 1);

    // Sponsor wallet received a Coin<SUI> for 49 SUI.
    sc.next_tx(SPONSOR_WALLET);
    let received = sc.take_from_address<coin::Coin<SUI>>(SPONSOR_WALLET);
    assert!(received.value() == 49_000_000_000, 2);
    test_utils::destroy(received);

    test_utils::destroy(policy_mut);
    test_utils::destroy(cap);
    test_utils::destroy(router);
    test_utils::destroy(r_cap);
    test_utils::destroy(vault);
    test_utils::destroy(v_cap);
    clk.destroy_for_testing();
    sc.end();
}

// === Daily cap auto-resets at UTC midnight ===

#[test]
fun daily_spend_cap_resets_at_midnight() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());

    // Use a tiny daily cap (10 SUI) and refill targets that won't bind:
    //   threshold = 5 SUI, target = 9 SUI → requested = 9 SUI
    // First harvest at day=0 drains 9 SUI (under the 10-SUI daily cap).
    // Second harvest at the SAME day with the sponsor balance topped back
    // to 0 would request 9 SUI but only 1 SUI remains in the daily budget
    // → drain 1 SUI, hitting cap exactly. After that, EDailyCapExhausted.
    // Cross UTC midnight → counter resets, full 9 SUI drain succeeds again.
    let (policy, cap) = sponsor::init_for_testing_with_params(
        SPONSOR_WALLET,
        10_000_000_000,           // max_spend_per_day = 10 SUI
        5_000_000_000,            // threshold = 5 SUI
        9_000_000_000,            // target = 9 SUI
        sc.ctx(),
    );
    // Stock a fat protocol bucket so the bucket isn't the binding constraint.
    let (mut router, r_cap, vault, v_cap) =
        fee_router_with_protocol_bucket(100_000_000_000, &mut sc, &clk);

    let mut policy_mut = policy;

    // First harvest at day 0 (clock=0). current balance = 0 → requested = 9 SUI.
    sponsor::harvest_to_sponsor(
        &mut policy_mut, &mut router, 0, &clk, sc.ctx(),
    );
    assert!(sponsor::spend_today_mist(&policy_mut) == 9_000_000_000, 0);
    assert!(sponsor::last_reset_day(&policy_mut) == 0, 1);

    // Second harvest, same day, sponsor "spent" back to 0. Requested = 9 SUI
    // but only 1 SUI daily budget left → drain 1 SUI exactly to the cap.
    sponsor::harvest_to_sponsor(
        &mut policy_mut, &mut router, 0, &clk, sc.ctx(),
    );
    assert!(sponsor::spend_today_mist(&policy_mut) == 10_000_000_000, 2);

    // Advance to next UTC day. (86_400_000 ms = 1 day.)
    clock::set_for_testing(&mut clk, 86_400_001);

    // Third harvest: auto-reset on rollover → full 9 SUI drain again.
    sponsor::harvest_to_sponsor(
        &mut policy_mut, &mut router, 0, &clk, sc.ctx(),
    );
    assert!(sponsor::spend_today_mist(&policy_mut) == 9_000_000_000, 3);
    assert!(sponsor::last_reset_day(&policy_mut) == 1, 4);

    // Drain the deposited coins so the test can clean up. Three Coins
    // were transferred to SPONSOR_WALLET (9 + 1 + 9 SUI).
    sc.next_tx(SPONSOR_WALLET);
    let c1 = sc.take_from_address<coin::Coin<SUI>>(SPONSOR_WALLET);
    let c2 = sc.take_from_address<coin::Coin<SUI>>(SPONSOR_WALLET);
    let c3 = sc.take_from_address<coin::Coin<SUI>>(SPONSOR_WALLET);
    test_utils::destroy(c1);
    test_utils::destroy(c2);
    test_utils::destroy(c3);

    test_utils::destroy(policy_mut);
    test_utils::destroy(cap);
    test_utils::destroy(router);
    test_utils::destroy(r_cap);
    test_utils::destroy(vault);
    test_utils::destroy(v_cap);
    clk.destroy_for_testing();
    sc.end();
}

// === Admin-cap gating ===

#[test]
#[expected_failure(abort_code = sponsor::ENotAdmin)]
fun set_sponsor_address_requires_admin_cap() {
    let mut sc = ts::begin(ALICE);
    let (policy, cap) = sponsor::init_for_testing(SPONSOR_WALLET, sc.ctx());

    // Create a DIFFERENT policy + cap. The cap from policy_other should
    // not authorize mutations on `policy`.
    let (policy_other, cap_other) = sponsor::init_for_testing(BOB, sc.ctx());

    let mut policy_mut = policy;
    sponsor::set_sponsor_address(&cap_other, &mut policy_mut, @0xCAFE);

    test_utils::destroy(policy_mut);
    test_utils::destroy(cap);
    test_utils::destroy(policy_other);
    test_utils::destroy(cap_other);
    sc.end();
}

// === Bonus coverage: the admin setters move state correctly ===

#[test]
fun set_sponsor_address_with_correct_cap_succeeds() {
    let mut sc = ts::begin(ALICE);
    let (policy, cap) = sponsor::init_for_testing(SPONSOR_WALLET, sc.ctx());

    let mut policy_mut = policy;
    sponsor::set_sponsor_address(&cap, &mut policy_mut, @0xCAFE);
    assert!(sponsor::sponsor_address(&policy_mut) == @0xCAFE, 0);

    test_utils::destroy(policy_mut);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
fun set_max_spend_and_refill_targets_round_trip() {
    let mut sc = ts::begin(ALICE);
    let (policy, cap) = sponsor::init_for_testing(SPONSOR_WALLET, sc.ctx());

    let mut policy_mut = policy;
    sponsor::set_max_spend_per_day(&cap, &mut policy_mut, 99_999);
    assert!(sponsor::max_spend_per_day_mist(&policy_mut) == 99_999, 0);

    sponsor::set_refill_targets(&cap, &mut policy_mut, 100, 1_000);
    assert!(sponsor::refill_threshold_mist(&policy_mut) == 100, 1);
    assert!(sponsor::refill_target_mist(&policy_mut) == 1_000, 2);

    test_utils::destroy(policy_mut);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
#[expected_failure(abort_code = sponsor::EInvalidTarget)]
fun set_refill_targets_rejects_target_le_threshold() {
    let mut sc = ts::begin(ALICE);
    let (policy, cap) = sponsor::init_for_testing(SPONSOR_WALLET, sc.ctx());

    let mut policy_mut = policy;
    // target == threshold → reject.
    sponsor::set_refill_targets(&cap, &mut policy_mut, 1_000, 1_000);

    test_utils::destroy(policy_mut);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
fun reset_daily_spend_clears_counter_and_advances_day() {
    let mut sc = ts::begin(ALICE);
    let mut clk = clock::create_for_testing(sc.ctx());
    let (policy, cap) = sponsor::init_for_testing_with_params(
        SPONSOR_WALLET, 10_000, 5, 9, sc.ctx(),
    );

    let (mut router, r_cap, vault, v_cap) =
        fee_router_with_protocol_bucket(1_000_000_000, &mut sc, &clk);

    // Spend something first.
    let mut policy_mut = policy;
    sponsor::harvest_to_sponsor(&mut policy_mut, &mut router, 0, &clk, sc.ctx());
    assert!(sponsor::spend_today_mist(&policy_mut) > 0, 0);

    // Manual reset at day 5.
    clock::set_for_testing(&mut clk, 5 * 86_400_000);
    sponsor::reset_daily_spend(&cap, &mut policy_mut, &clk);
    assert!(sponsor::spend_today_mist(&policy_mut) == 0, 1);
    assert!(sponsor::last_reset_day(&policy_mut) == 5, 2);

    // Clean up the SPONSOR_WALLET coin.
    sc.next_tx(SPONSOR_WALLET);
    let received = sc.take_from_address<coin::Coin<SUI>>(SPONSOR_WALLET);
    test_utils::destroy(received);

    test_utils::destroy(policy_mut);
    test_utils::destroy(cap);
    test_utils::destroy(router);
    test_utils::destroy(r_cap);
    test_utils::destroy(vault);
    test_utils::destroy(v_cap);
    clk.destroy_for_testing();
    sc.end();
}

// === Edge case: empty bucket is a graceful no-op ===

#[test]
fun harvest_with_empty_protocol_bucket_is_noop() {
    let mut sc = ts::begin(ALICE);
    let clk = clock::create_for_testing(sc.ctx());
    let (policy, cap) = sponsor::init_for_testing(SPONSOR_WALLET, sc.ctx());
    // Empty protocol bucket.
    let (mut router, r_cap, vault, v_cap) =
        fee_router_with_protocol_bucket(0, &mut sc, &clk);

    let mut policy_mut = policy;
    sponsor::harvest_to_sponsor(
        &mut policy_mut, &mut router, 0, &clk, sc.ctx(),
    );

    // Nothing spent; no coin sent.
    assert!(sponsor::spend_today_mist(&policy_mut) == 0, 0);

    test_utils::destroy(policy_mut);
    test_utils::destroy(cap);
    test_utils::destroy(router);
    test_utils::destroy(r_cap);
    test_utils::destroy(vault);
    test_utils::destroy(v_cap);
    clk.destroy_for_testing();
    sc.end();
}
