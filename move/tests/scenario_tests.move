/// T2.8 — multi-step deterministic scenarios that exercise long sequences of
/// mutations and assert the collateral invariant after every step.
///
/// These are not generative property tests (Move has no fuzzer); they're
/// hand-crafted paths designed to catch regressions in invariant-bearing
/// transitions.
#[test_only]
module wick::scenario_tests;

use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario as ts;
use wick::oracle_adapter::{Self, MockOracle};
use wick::wick::{Self, Market};
use wick::invariants;

const ALICE: address = @0xA11CE;
const BOB:   address = @0xB0B;
const CAROL: address = @0xCA01;

const NOW_MS: u64 = 1_000_000;
const EXPIRY_OFFSET_MS: u64 = 60_000;
const SEED: u64 = 1_000_000;
const BARRIER: u64 = 99_500;

#[test_only]
fun setup(scenario: &mut ts::Scenario, oracle_initial_price: u64) {
    {
        let ctx = scenario.ctx();
        oracle_adapter::create_and_share(b"BTC/USD", oracle_initial_price, ctx);
    };
    scenario.next_tx(ALICE);
    {
        let ctx = scenario.ctx();
        let mut clk = clock::create_for_testing(ctx);
        clock::set_for_testing(&mut clk, NOW_MS);
        let coin_in = coin::mint_for_testing<SUI>(SEED, ctx);
        wick::create_market<SUI>(
            b"BTC/USD",
            wick::dir_above(),
            BARRIER,
            NOW_MS + EXPIRY_OFFSET_MS,
            30,
            coin_in,
            &clk,
            ctx,
        );
        clock::destroy_for_testing(clk);
    };
}

#[test_only]
fun take_clock_at(scenario: &mut ts::Scenario, t: u64): clock::Clock {
    let mut clk = clock::create_for_testing(scenario.ctx());
    clock::set_for_testing(&mut clk, t);
    clk
}

// === Scenario A: long mixed-trade lifecycle ending in HIT ===
//
// Sequence:
//   create → bob buy_touch 10k → carol buy_no_touch 20k → bob swap touch→no_touch round-trip
//   → bob mints complete set 5k via test helper, redeems complete set (early exit)
//   → mark_hit → bob and carol redeem winning sides (touch wins)
// Invariant asserted after every mutation. After full settlement, vault drains
// to outstanding TOUCH supply (which equals 0 once everyone redeems).
#[test]
fun scenario_a_hit_lifecycle_with_mixed_trades() {
    let mut scenario = ts::begin(ALICE);
    setup(&mut scenario, BARRIER - 100);

    // tx 2: bob buys touch
    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let clk = take_clock_at(&mut scenario, NOW_MS + 1);
        let pay = coin::mint_for_testing<SUI>(10_000, scenario.ctx());
        let pos = wick::buy_touch(&mut market, pay, &clk, scenario.ctx());
        invariants::assert_collateral_invariant(&market);
        transfer::public_transfer(pos, BOB);
        clock::destroy_for_testing(clk);
        ts::return_shared(market);
    };

    // tx 3: carol buys no_touch
    scenario.next_tx(CAROL);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let clk = take_clock_at(&mut scenario, NOW_MS + 2);
        let pay = coin::mint_for_testing<SUI>(20_000, scenario.ctx());
        let pos = wick::buy_no_touch(&mut market, pay, &clk, scenario.ctx());
        invariants::assert_collateral_invariant(&market);
        transfer::public_transfer(pos, CAROL);
        clock::destroy_for_testing(clk);
        ts::return_shared(market);
    };

    // tx 4: bob mint complete set 5k and redeem it back (early-exit churn)
    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let pay = coin::mint_for_testing<SUI>(5_000, scenario.ctx());
        let (touch_b, no_touch_b) =
            wick::mint_complete_set_for_testing<SUI>(&mut market, pay, scenario.ctx());
        invariants::assert_collateral_invariant(&market);

        let coin_back = wick::redeem_complete_set(&mut market, touch_b, no_touch_b, scenario.ctx());
        assert!(coin::value(&coin_back) == 5_000, 2000);
        invariants::assert_collateral_invariant(&market);
        coin::burn_for_testing(coin_back);
        ts::return_shared(market);
    };

    // tx 5: bob does a swap round-trip on a fresh complete-set TOUCH
    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let clk = take_clock_at(&mut scenario, NOW_MS + 3);
        let pay = coin::mint_for_testing<SUI>(3_000, scenario.ctx());
        let (touch, no_touch) =
            wick::mint_complete_set_for_testing<SUI>(&mut market, pay, scenario.ctx());
        invariants::assert_collateral_invariant(&market);

        let no_touch_2 = wick::swap_touch_for_no_touch(&mut market, touch, &clk, scenario.ctx());
        invariants::assert_collateral_invariant(&market);
        let touch_back = wick::swap_no_touch_for_touch(&mut market, no_touch_2, &clk, scenario.ctx());
        invariants::assert_collateral_invariant(&market);

        transfer::public_transfer(no_touch, BOB);
        transfer::public_transfer(touch_back, BOB);
        clock::destroy_for_testing(clk);
        ts::return_shared(market);
    };

    // tx 6: oracle crosses, mark_hit
    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let mut oracle = scenario.take_shared<MockOracle>();
        let clk = take_clock_at(&mut scenario, NOW_MS + 10);
        oracle_adapter::set_price(&mut oracle, BARRIER + 200);
        wick::mark_hit(&mut market, &oracle, &clk);
        assert!(wick::status(&market) == wick::status_hit(), 2010);
        invariants::assert_collateral_invariant(&market);
        clock::destroy_for_testing(clk);
        ts::return_shared(market);
        ts::return_shared(oracle);
    };

    // tx 7: bob redeems all his TOUCH positions; NO_TOUCH positions are losers and stay.
    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let pos_ids = scenario.ids_for_sender<wick::Position>();
        let n_pos = vector::length(&pos_ids);
        let mut i = 0;
        while (i < n_pos) {
            let id = *vector::borrow(&pos_ids, i);
            let pos = scenario.take_from_sender_by_id<wick::Position>(id);
            if (wick::position_side(&pos) == wick::side_touch()) {
                let amount = wick::position_amount(&pos);
                let coin_out = wick::redeem_winner(&mut market, pos, scenario.ctx());
                assert!(coin::value(&coin_out) == amount, 2020);
                invariants::assert_collateral_invariant(&market);
                coin::burn_for_testing(coin_out);
            } else {
                // NO_TOUCH is the losing side under HIT — keep, don't redeem.
                transfer::public_transfer(pos, BOB);
            };
            i = i + 1;
        };
        ts::return_shared(market);
    };

    // tx 8: carol redeems her NO_TOUCH (loser). Should abort with E_LOSING_SIDE
    // — verified separately in settlement_tests. Here we just keep her positions
    // and inspect final invariant: vault == TOUCH supply.
    scenario.next_tx(ALICE);
    {
        let market = scenario.take_shared<Market<SUI>>();
        invariants::assert_collateral_invariant(&market);
        ts::return_shared(market);
    };

    scenario.end();
}

// === Scenario B: EXPIRED lifecycle, NO_TOUCH wins ===
#[test]
fun scenario_b_expired_lifecycle() {
    let mut scenario = ts::begin(ALICE);
    setup(&mut scenario, BARRIER - 100);

    // tx 2: alice (creator) and bob both buy NO_TOUCH; carol buys TOUCH.
    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let clk = take_clock_at(&mut scenario, NOW_MS + 1);
        let pay_b = coin::mint_for_testing<SUI>(15_000, scenario.ctx());
        let pos_b = wick::buy_no_touch(&mut market, pay_b, &clk, scenario.ctx());
        invariants::assert_collateral_invariant(&market);
        transfer::public_transfer(pos_b, BOB);
        clock::destroy_for_testing(clk);
        ts::return_shared(market);
    };

    scenario.next_tx(CAROL);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let clk = take_clock_at(&mut scenario, NOW_MS + 2);
        let pay_c = coin::mint_for_testing<SUI>(8_000, scenario.ctx());
        let pos_c = wick::buy_touch(&mut market, pay_c, &clk, scenario.ctx());
        invariants::assert_collateral_invariant(&market);
        transfer::public_transfer(pos_c, CAROL);
        clock::destroy_for_testing(clk);
        ts::return_shared(market);
    };

    // tx 4: time advances past expiry without oracle crossing. settle_expired.
    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let oracle = scenario.take_shared<MockOracle>();
        let clk = take_clock_at(&mut scenario, NOW_MS + EXPIRY_OFFSET_MS + 1);
        wick::settle_expired(&mut market, &clk);
        assert!(wick::status(&market) == wick::status_expired(), 3000);
        invariants::assert_collateral_invariant(&market);
        clock::destroy_for_testing(clk);
        ts::return_shared(market);
        ts::return_shared(oracle);
    };

    // tx 5: bob redeems his NO_TOUCH (winner under EXPIRED).
    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let pos_ids = scenario.ids_for_sender<wick::Position>();
        let mut i = 0;
        while (i < vector::length(&pos_ids)) {
            let id = *vector::borrow(&pos_ids, i);
            let pos = scenario.take_from_sender_by_id<wick::Position>(id);
            assert!(wick::position_side(&pos) == wick::side_no_touch(), 3010);
            let amount = wick::position_amount(&pos);
            let coin_out = wick::redeem_winner(&mut market, pos, scenario.ctx());
            assert!(coin::value(&coin_out) == amount, 3011);
            invariants::assert_collateral_invariant(&market);
            coin::burn_for_testing(coin_out);
            i = i + 1;
        };
        ts::return_shared(market);
    };

    scenario.end();
}

// === Scenario C: vault drains exactly to outstanding winning supply ===
//
// Concrete property: at any point during settlement under HIT, the vault
// equals the outstanding TOUCH supply. This is the "no losing-side claim
// ever drains the vault" property and is what makes the protocol solvent.
#[test]
fun scenario_c_vault_drains_to_winning_supply() {
    let mut scenario = ts::begin(ALICE);
    setup(&mut scenario, BARRIER - 100);

    // Mint a clean complete set of 100k for bob via the test helper.
    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let pay = coin::mint_for_testing<SUI>(100_000, scenario.ctx());
        let (touch, no_touch) =
            wick::mint_complete_set_for_testing<SUI>(&mut market, pay, scenario.ctx());
        transfer::public_transfer(touch, BOB);
        transfer::public_transfer(no_touch, BOB);
        ts::return_shared(market);
    };

    // mark_hit
    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let mut oracle = scenario.take_shared<MockOracle>();
        let clk = take_clock_at(&mut scenario, NOW_MS + 1);
        oracle_adapter::set_price(&mut oracle, BARRIER + 1);
        wick::mark_hit(&mut market, &oracle, &clk);
        invariants::assert_collateral_invariant(&market);
        clock::destroy_for_testing(clk);
        ts::return_shared(market);
        ts::return_shared(oracle);
    };

    // Redeem TOUCH winners and verify equality after every redemption.
    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let pos_ids = scenario.ids_for_sender<wick::Position>();
        let mut i = 0;
        while (i < vector::length(&pos_ids)) {
            let id = *vector::borrow(&pos_ids, i);
            let pos = scenario.take_from_sender_by_id<wick::Position>(id);
            if (wick::position_side(&pos) == wick::side_touch()) {
                let coin_out = wick::redeem_winner(&mut market, pos, scenario.ctx());
                // Concrete property: vault == TOUCH supply after each redemption.
                assert!(
                    wick::collateral_value(&market) == wick::total_touch_supply(&market),
                    4000,
                );
                coin::burn_for_testing(coin_out);
            } else {
                transfer::public_transfer(pos, BOB);
            };
            i = i + 1;
        };
        ts::return_shared(market);
    };

    scenario.end();
}

// === Scenario D: full-conservation property across complex lifecycle ===
//
// Tracks every collateral inflow and outflow across a long, mixed-trade
// sequence ending in HIT, and proves the protocol drains to exactly zero
// once every winner — including the LP — has been paid:
//
//   sum(deposits) == sum(payouts) + sum(losing-side collateral burned)
//
// Concretely: alice (LP, SEED) + bob (BUY_TOUCH, BOB_PAY) + carol
// (BUY_NO_TOUCH, CAROL_PAY) deposit. After mark_hit (TOUCH wins):
//   - bob redeems his TOUCH position (winner)
//   - carol's NO_TOUCH is the loser; she does NOT redeem.
//   - alice redeems her LP and gets the rest of touch_reserve.
//
// Final assertion:
//   bob_payout + alice_lp_claim == SEED + BOB_PAY + CAROL_PAY
// and the vault is empty (= 0). Carol's stranded NO_TOUCH burns the
// collateral she put in — that's the LP edge.
#[test]
#[allow(unused_assignment)]
fun scenario_d_full_conservation_with_lp_claim() {
    let mut scenario = ts::begin(ALICE);
    setup(&mut scenario, BARRIER - 100);

    let bob_pay: u64 = 12_000;
    let carol_pay: u64 = 18_000;

    // tx 2: bob buys TOUCH
    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let clk = take_clock_at(&mut scenario, NOW_MS + 1);
        let pay = coin::mint_for_testing<SUI>(bob_pay, scenario.ctx());
        let pos = wick::buy_touch(&mut market, pay, &clk, scenario.ctx());
        invariants::assert_collateral_invariant(&market);
        transfer::public_transfer(pos, BOB);
        clock::destroy_for_testing(clk);
        ts::return_shared(market);
    };

    // tx 3: carol buys NO_TOUCH (will lose under HIT)
    scenario.next_tx(CAROL);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let clk = take_clock_at(&mut scenario, NOW_MS + 2);
        let pay = coin::mint_for_testing<SUI>(carol_pay, scenario.ctx());
        let pos = wick::buy_no_touch(&mut market, pay, &clk, scenario.ctx());
        invariants::assert_collateral_invariant(&market);
        transfer::public_transfer(pos, CAROL);
        clock::destroy_for_testing(clk);
        ts::return_shared(market);
    };

    // Pre-settlement vault sanity
    let total_deposits = SEED + bob_pay + carol_pay;
    scenario.next_tx(ALICE);
    {
        let market = scenario.take_shared<Market<SUI>>();
        assert!(wick::collateral_value(&market) == total_deposits, 5000);
        ts::return_shared(market);
    };

    // tx 4: oracle crosses, mark_hit
    scenario.next_tx(ALICE);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let mut oracle = scenario.take_shared<MockOracle>();
        let clk = take_clock_at(&mut scenario, NOW_MS + 5);
        oracle_adapter::set_price(&mut oracle, BARRIER + 200);
        wick::mark_hit(&mut market, &oracle, &clk);
        assert!(wick::status(&market) == wick::status_hit(), 5001);
        invariants::assert_collateral_invariant(&market);
        clock::destroy_for_testing(clk);
        ts::return_shared(market);
        ts::return_shared(oracle);
    };

    // tx 5: bob redeems his TOUCH winner. Capture the payout.
    let mut bob_payout: u64 = 0;
    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let pos = scenario.take_from_sender<wick::Position>();
        assert!(wick::position_side(&pos) == wick::side_touch(), 5010);
        let coin_out = wick::redeem_winner(&mut market, pos, scenario.ctx());
        bob_payout = coin::value(&coin_out);
        invariants::assert_collateral_invariant(&market);
        coin::burn_for_testing(coin_out);
        ts::return_shared(market);
    };

    // tx 6: alice redeems her LP. Capture the claim.
    let mut alice_lp_claim: u64 = 0;
    scenario.next_tx(ALICE);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let lp = scenario.take_from_sender<wick::LpPosition>();
        let coin_out = wick::redeem_lp(&mut market, lp, scenario.ctx());
        alice_lp_claim = coin::value(&coin_out);
        coin::burn_for_testing(coin_out);
        ts::return_shared(market);
    };

    // tx 7: full-conservation property — vault drained to exactly 0,
    // and total payouts equal total deposits.
    scenario.next_tx(ALICE);
    {
        let market = scenario.take_shared<Market<SUI>>();
        let total_payouts = bob_payout + alice_lp_claim;
        assert!(total_payouts == total_deposits, 5020);
        assert!(wick::collateral_value(&market) == 0, 5021);
        // Carol's NO_TOUCH supply still on the books, but it's the loser
        // and the touch_reserve has been emptied by the LP redemption.
        assert!(wick::touch_reserve(&market) == 0, 5022);
        ts::return_shared(market);
    };

    scenario.end();
}
