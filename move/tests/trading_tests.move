/// Tests for buy_touch / buy_no_touch / swap_* / redeem_complete_set.
///
/// Every test asserts the collateral invariant after each mutation.
#[test_only]
module wick::trading_tests;

use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario as ts;
use wick::wick::{Self, Market, LpPosition};
use wick::invariants;

const ALICE: address = @0xA11CE;
const BOB:   address = @0xB0B;

const NOW_MS: u64 = 1_000_000;
const EXPIRY_OFFSET_MS: u64 = 60_000;

// Larger seed so CPMM swaps produce non-zero outputs at small input sizes.
const SEED: u64 = 1_000_000;

// === Helpers ===

#[test_only]
fun seed_market(scenario: &mut ts::Scenario) {
    let ctx = scenario.ctx();
    let mut clk = clock::create_for_testing(ctx);
    clock::set_for_testing(&mut clk, NOW_MS);
    let coin_in = coin::mint_for_testing<SUI>(SEED, ctx);
    wick::create_market<SUI>(
        b"BTC/USD",
        wick::dir_above(),
        99_500,
        NOW_MS + EXPIRY_OFFSET_MS,
        30, // 30 bps fee
        coin_in,
        &clk,
        ctx,
    );
    clock::destroy_for_testing(clk);
}

#[test_only]
fun take_clock_at(scenario: &mut ts::Scenario, t: u64): clock::Clock {
    let mut clk = clock::create_for_testing(scenario.ctx());
    clock::set_for_testing(&mut clk, t);
    clk
}

// === buy_touch ===

#[test]
fun test_buy_touch_returns_more_than_paid() {
    let mut scenario = ts::begin(ALICE);
    seed_market(&mut scenario);

    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let clk = take_clock_at(&mut scenario, NOW_MS + 1);
        let payment = coin::mint_for_testing<SUI>(10_000, scenario.ctx());

        let pre_vault = wick::collateral_value(&market);
        let pre_touch_supply = wick::total_touch_supply(&market);
        let pre_no_touch_supply = wick::total_no_touch_supply(&market);

        let pos = wick::buy_touch(&mut market, payment, &clk, scenario.ctx());

        // Net economics: paid 10_000, received N+X TOUCH where X comes from the
        // CPMM swap of the unwanted NO_TOUCH half against the reserve.
        assert!(wick::position_side(&pos) == wick::side_touch(), 200);
        assert!(wick::position_amount(&pos) > 10_000, 201);

        // Both supplies grew by exactly the payment amount (mint).
        assert!(wick::total_touch_supply(&market) == pre_touch_supply + 10_000, 202);
        assert!(wick::total_no_touch_supply(&market) == pre_no_touch_supply + 10_000, 203);
        assert!(wick::collateral_value(&market) == pre_vault + 10_000, 204);

        // The swap shifted reserves: NO_TOUCH up, TOUCH down.
        assert!(wick::no_touch_reserve(&market) > SEED, 205);
        assert!(wick::touch_reserve(&market) < SEED, 206);

        invariants::assert_collateral_invariant(&market);

        transfer::public_transfer(pos, BOB);
        clock::destroy_for_testing(clk);
        ts::return_shared(market);
    };

    scenario.end();
}

#[test]
fun test_buy_no_touch_symmetric() {
    let mut scenario = ts::begin(ALICE);
    seed_market(&mut scenario);

    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let clk = take_clock_at(&mut scenario, NOW_MS + 1);
        let payment = coin::mint_for_testing<SUI>(10_000, scenario.ctx());

        let pos = wick::buy_no_touch(&mut market, payment, &clk, scenario.ctx());
        assert!(wick::position_side(&pos) == wick::side_no_touch(), 300);
        assert!(wick::position_amount(&pos) > 10_000, 301);
        invariants::assert_collateral_invariant(&market);

        transfer::public_transfer(pos, BOB);
        clock::destroy_for_testing(clk);
        ts::return_shared(market);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = ::wick::wick::E_PAST_EXPIRY_TRADE)]
fun test_buy_touch_after_expiry_aborts() {
    let mut scenario = ts::begin(ALICE);
    seed_market(&mut scenario);

    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let clk = take_clock_at(&mut scenario, NOW_MS + EXPIRY_OFFSET_MS + 1);
        let payment = coin::mint_for_testing<SUI>(10_000, scenario.ctx());

        let pos = wick::buy_touch(&mut market, payment, &clk, scenario.ctx());

        // Unreachable; pacify Move's drop checker.
        transfer::public_transfer(pos, BOB);
        clock::destroy_for_testing(clk);
        ts::return_shared(market);
    };
    scenario.end();
}

// === swap_touch_for_no_touch ===

#[test]
fun test_swap_touch_for_no_touch_round_trip_loses_to_fee() {
    let mut scenario = ts::begin(ALICE);
    seed_market(&mut scenario);

    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let clk = take_clock_at(&mut scenario, NOW_MS + 1);

        // Bob mints a complete set so we have a clean TOUCH position to swap.
        let payment = coin::mint_for_testing<SUI>(10_000, scenario.ctx());
        let (touch, no_touch) =
            wick::mint_complete_set_for_testing<SUI>(&mut market, payment, scenario.ctx());

        let touch_amount_pre = wick::position_amount(&touch);
        invariants::assert_collateral_invariant(&market);

        // Swap TOUCH -> NO_TOUCH, then back. Round-trip should lose to fees only.
        let no_touch_2 = wick::swap_touch_for_no_touch(&mut market, touch, &clk, scenario.ctx());
        invariants::assert_collateral_invariant(&market);
        let touch_back = wick::swap_no_touch_for_touch(&mut market, no_touch_2, &clk, scenario.ctx());
        invariants::assert_collateral_invariant(&market);

        // Round-trip strictly less than original due to two 30bps fees.
        assert!(wick::position_amount(&touch_back) < touch_amount_pre, 400);
        // But within ~1% on small relative trade size.
        let lost = touch_amount_pre - wick::position_amount(&touch_back);
        assert!(lost < touch_amount_pre / 100, 401);

        transfer::public_transfer(no_touch, BOB);
        transfer::public_transfer(touch_back, BOB);
        clock::destroy_for_testing(clk);
        ts::return_shared(market);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = ::wick::wick::E_WRONG_SIDE)]
fun test_swap_wrong_side_aborts() {
    let mut scenario = ts::begin(ALICE);
    seed_market(&mut scenario);

    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let clk = take_clock_at(&mut scenario, NOW_MS + 1);
        let payment = coin::mint_for_testing<SUI>(10_000, scenario.ctx());
        let (touch, no_touch) =
            wick::mint_complete_set_for_testing<SUI>(&mut market, payment, scenario.ctx());

        // Try to swap NO_TOUCH using the TOUCH-side function.
        let bad = wick::swap_touch_for_no_touch(&mut market, no_touch, &clk, scenario.ctx());

        transfer::public_transfer(touch, BOB);
        transfer::public_transfer(bad, BOB);
        clock::destroy_for_testing(clk);
        ts::return_shared(market);
    };
    scenario.end();
}

// === redeem_complete_set ===

#[test]
fun test_redeem_complete_set_returns_collateral() {
    let mut scenario = ts::begin(ALICE);
    seed_market(&mut scenario);

    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let payment = coin::mint_for_testing<SUI>(10_000, scenario.ctx());

        let pre_vault = wick::collateral_value(&market);
        let pre_touch = wick::total_touch_supply(&market);
        let pre_no_touch = wick::total_no_touch_supply(&market);

        let (touch, no_touch) =
            wick::mint_complete_set_for_testing<SUI>(&mut market, payment, scenario.ctx());
        invariants::assert_collateral_invariant(&market);

        let coin_out = wick::redeem_complete_set(&mut market, touch, no_touch, scenario.ctx());

        // Net: vault and supplies returned to pre-mint state.
        assert!(coin::value(&coin_out) == 10_000, 500);
        assert!(wick::collateral_value(&market) == pre_vault, 501);
        assert!(wick::total_touch_supply(&market) == pre_touch, 502);
        assert!(wick::total_no_touch_supply(&market) == pre_no_touch, 503);
        invariants::assert_collateral_invariant(&market);

        coin::burn_for_testing(coin_out);
        ts::return_shared(market);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = ::wick::wick::E_AMOUNT_MISMATCH)]
fun test_redeem_complete_set_unequal_aborts() {
    let mut scenario = ts::begin(ALICE);
    seed_market(&mut scenario);

    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();

        // Mint two different-sized pairs and try to redeem mismatched amounts.
        let pay_a = coin::mint_for_testing<SUI>(10_000, scenario.ctx());
        let (touch_a, no_touch_a) =
            wick::mint_complete_set_for_testing<SUI>(&mut market, pay_a, scenario.ctx());
        let pay_b = coin::mint_for_testing<SUI>(5_000, scenario.ctx());
        let (touch_b, no_touch_b) =
            wick::mint_complete_set_for_testing<SUI>(&mut market, pay_b, scenario.ctx());

        // touch_a (10_000) vs no_touch_b (5_000) — mismatched.
        let coin_out = wick::redeem_complete_set(&mut market, touch_a, no_touch_b, scenario.ctx());

        coin::burn_for_testing(coin_out);
        transfer::public_transfer(touch_b, BOB);
        transfer::public_transfer(no_touch_a, BOB);
        ts::return_shared(market);
    };
    scenario.end();
}

#[test]
fun test_lp_remains_with_creator_after_trades() {
    let mut scenario = ts::begin(ALICE);
    seed_market(&mut scenario);

    // Bob trades.
    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let clk = take_clock_at(&mut scenario, NOW_MS + 1);
        let payment = coin::mint_for_testing<SUI>(50_000, scenario.ctx());
        let pos = wick::buy_touch(&mut market, payment, &clk, scenario.ctx());
        invariants::assert_collateral_invariant(&market);
        transfer::public_transfer(pos, BOB);
        clock::destroy_for_testing(clk);
        ts::return_shared(market);
    };

    // Alice still owns the LP.
    scenario.next_tx(ALICE);
    {
        let lp = scenario.take_from_sender<LpPosition>();
        assert!(wick::lp_shares(&lp) == SEED, 600);
        scenario.return_to_sender(lp);
    };

    scenario.end();
}
