/// Tests for redeem_lp + post-settlement LP economics.
#[test_only]
module wick::lp_tests;

use sui::clock;
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use sui::test_scenario as ts;
use wick::oracle_adapter::{Self, MockOracle};
use wick::wick::{Self, Market, Position, LpPosition};
use wick::invariants;

const ALICE: address = @0xA11CE;

const NOW_MS: u64 = 1_000_000;
const EXPIRY_OFFSET_MS: u64 = 60_000;
const SEED: u64 = 1_000_000;
const BARRIER: u64 = 99_500;

#[test_only]
fun take_clock_at(scenario: &mut ts::Scenario, t: u64): clock::Clock {
    let mut clk = clock::create_for_testing(scenario.ctx());
    clock::set_for_testing(&mut clk, t);
    clk
}

#[test_only]
fun seed(scenario: &mut ts::Scenario, oracle_initial_price: u64) {
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

// === Happy path: HIT ===

#[test]
fun test_redeem_lp_after_hit_pays_touch_reserve() {
    let mut scenario = ts::begin(ALICE);
    seed(&mut scenario, BARRIER - 100);

    // Mark hit (no trades — reserves are still seed/seed).
    scenario.next_tx(ALICE);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let mut oracle = scenario.take_shared<MockOracle>();
        let clk = take_clock_at(&mut scenario, NOW_MS + 1);
        oracle_adapter::set_price(&mut oracle, BARRIER + 50);
        wick::mark_hit(&mut market, &oracle, &clk);
        invariants::assert_collateral_invariant(&market);
        clock::destroy_for_testing(clk);
        ts::return_shared(market);
        ts::return_shared(oracle);
    };

    // Sole LP redeems → claims full touch_reserve (= SEED in this scenario).
    scenario.next_tx(ALICE);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let lp = scenario.take_from_sender<LpPosition>();
        let pre_vault = wick::collateral_value(&market);
        let pre_lp_supply = wick::lp_supply(&market);
        let pre_touch_reserve = wick::touch_reserve(&market);

        assert!(pre_lp_supply == SEED, 1000);
        assert!(pre_touch_reserve == SEED, 1001);

        let coin_out = wick::redeem_lp(&mut market, lp, scenario.ctx());

        // Sole LP claims everything in the touch reserve.
        assert!(coin::value(&coin_out) == pre_touch_reserve, 1002);
        assert!(wick::lp_supply(&market) == 0, 1003);
        assert!(wick::touch_reserve(&market) == 0, 1004);
        assert!(wick::total_touch_supply(&market) == 0, 1005);
        assert!(wick::collateral_value(&market) == pre_vault - pre_touch_reserve, 1006);
        invariants::assert_collateral_invariant(&market);

        coin::burn_for_testing(coin_out);
        ts::return_shared(market);
    };

    scenario.end();
}

// === Happy path: EXPIRED ===

#[test]
fun test_redeem_lp_after_expired_pays_no_touch_reserve() {
    let mut scenario = ts::begin(ALICE);
    seed(&mut scenario, BARRIER - 100);

    scenario.next_tx(ALICE);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let oracle = scenario.take_shared<MockOracle>();
        let clk = take_clock_at(&mut scenario, NOW_MS + EXPIRY_OFFSET_MS + 1);
        wick::settle_expired(&mut market, &clk);
        invariants::assert_collateral_invariant(&market);
        clock::destroy_for_testing(clk);
        ts::return_shared(market);
        ts::return_shared(oracle);
    };

    scenario.next_tx(ALICE);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let lp = scenario.take_from_sender<LpPosition>();
        let pre_no_touch_reserve = wick::no_touch_reserve(&market);

        let coin_out = wick::redeem_lp(&mut market, lp, scenario.ctx());

        assert!(coin::value(&coin_out) == pre_no_touch_reserve, 2000);
        assert!(wick::lp_supply(&market) == 0, 2001);
        assert!(wick::no_touch_reserve(&market) == 0, 2002);
        assert!(wick::total_no_touch_supply(&market) == 0, 2003);
        invariants::assert_collateral_invariant(&market);

        coin::burn_for_testing(coin_out);
        ts::return_shared(market);
    };

    scenario.end();
}

// === Guard: cannot redeem LP while ACTIVE ===

#[test, expected_failure(abort_code = ::wick::wick::E_LP_STILL_ACTIVE)]
fun test_redeem_lp_while_active_aborts() {
    let mut scenario = ts::begin(ALICE);
    seed(&mut scenario, BARRIER - 100);

    scenario.next_tx(ALICE);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let lp = scenario.take_from_sender<LpPosition>();
        let coin_out = wick::redeem_lp(&mut market, lp, scenario.ctx());
        coin::burn_for_testing(coin_out);
        ts::return_shared(market);
    };
    scenario.end();
}

// === Conservation: HIT path with a bettor + an LP ===
//
// Demonstrates real payoff economics:
//   alice deposits SEED (1M) as LP.
//   bob deposits PAY (200K) on TOUCH and gets > 200K position.
//   barrier hits.
//   bob redeems his TOUCH winnings.
//   alice redeems her LP.
// Total deposits == total withdrawals (modulo bob's profit being alice's loss).

const BOB: address = @0xB0B;
const PAY: u64 = 200_000;

#[test]
fun test_conservation_hit_with_bettor_and_lp() {
    let mut scenario = ts::begin(ALICE);
    seed(&mut scenario, BARRIER - 100);

    // Bob buys touch.
    scenario.next_tx(BOB);
    let bob_position_amount: u64;
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let clk = take_clock_at(&mut scenario, NOW_MS + 1);
        let pay = coin::mint_for_testing<SUI>(PAY, scenario.ctx());
        let pos = wick::buy_touch(&mut market, pay, &clk, scenario.ctx());
        bob_position_amount = wick::position_amount(&pos);
        // Bob got more TOUCH than he paid because the AMM swapped the unwanted
        // NO_TOUCH half for extra TOUCH.
        assert!(bob_position_amount > PAY, 3000);
        invariants::assert_collateral_invariant(&market);
        transfer::public_transfer(pos, BOB);
        clock::destroy_for_testing(clk);
        ts::return_shared(market);
    };

    // Mark hit.
    scenario.next_tx(ALICE);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let mut oracle = scenario.take_shared<MockOracle>();
        let clk = take_clock_at(&mut scenario, NOW_MS + 2);
        oracle_adapter::set_price(&mut oracle, BARRIER + 50);
        wick::mark_hit(&mut market, &oracle, &clk);
        clock::destroy_for_testing(clk);
        ts::return_shared(market);
        ts::return_shared(oracle);
    };

    // Bob redeems his TOUCH winnings.
    scenario.next_tx(BOB);
    let bob_won: u64;
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let pos = scenario.take_from_sender<Position>();
        let coin_out = wick::redeem_winner(&mut market, pos, scenario.ctx());
        bob_won = coin::value(&coin_out);
        assert!(bob_won == bob_position_amount, 3001);
        invariants::assert_collateral_invariant(&market);
        coin::burn_for_testing(coin_out);
        ts::return_shared(market);
    };

    // Alice redeems her LP.
    scenario.next_tx(ALICE);
    let alice_lp_claim: u64;
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let lp = scenario.take_from_sender<LpPosition>();
        let coin_out = wick::redeem_lp(&mut market, lp, scenario.ctx());
        alice_lp_claim = coin::value(&coin_out);

        // Vault and supply both fully drained on the winning side.
        assert!(wick::collateral_value(&market) == 0, 3002);
        assert!(wick::total_touch_supply(&market) == 0, 3003);
        assert!(wick::touch_reserve(&market) == 0, 3004);
        assert!(wick::lp_supply(&market) == 0, 3005);

        coin::burn_for_testing(coin_out);
        ts::return_shared(market);
    };

    // CONSERVATION: total deposits == total withdrawals.
    //   deposits  = SEED (alice LP) + PAY (bob bet) = 1_200_000
    //   exits     = bob_won + alice_lp_claim
    let total_deposits = SEED + PAY;
    let total_exits = bob_won + alice_lp_claim;
    assert!(total_exits == total_deposits, 3006);

    // Alice's net = alice_lp_claim − SEED (negative, she lost).
    // Bob's net  = bob_won − PAY (positive, he won).
    // Sum = 0.
    let alice_net = (alice_lp_claim as u128); // unsigned arithmetic — store separately
    let alice_in = (SEED as u128);
    let bob_net = (bob_won as u128);
    let bob_in = (PAY as u128);
    // alice loss == bob gain
    assert!(alice_in - alice_net == bob_net - bob_in, 3007);

    scenario.end();
}

// === Conservation: EXPIRED path with a bettor + an LP ===

#[test]
fun test_conservation_expired_with_bettor_and_lp() {
    let mut scenario = ts::begin(ALICE);
    seed(&mut scenario, BARRIER - 100);

    // Bob buys NO_TOUCH (he expects expiry without touching).
    scenario.next_tx(BOB);
    let bob_position_amount: u64;
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let clk = take_clock_at(&mut scenario, NOW_MS + 1);
        let pay = coin::mint_for_testing<SUI>(PAY, scenario.ctx());
        let pos = wick::buy_no_touch(&mut market, pay, &clk, scenario.ctx());
        bob_position_amount = wick::position_amount(&pos);
        assert!(bob_position_amount > PAY, 4000);
        transfer::public_transfer(pos, BOB);
        clock::destroy_for_testing(clk);
        ts::return_shared(market);
    };

    // Time passes past expiry without oracle crossing → settle_expired.
    scenario.next_tx(ALICE);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let oracle = scenario.take_shared<MockOracle>();
        let clk = take_clock_at(&mut scenario, NOW_MS + EXPIRY_OFFSET_MS + 1);
        wick::settle_expired(&mut market, &clk);
        clock::destroy_for_testing(clk);
        ts::return_shared(market);
        ts::return_shared(oracle);
    };

    // Bob redeems NO_TOUCH winnings.
    scenario.next_tx(BOB);
    let bob_won: u64;
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let pos = scenario.take_from_sender<Position>();
        let coin_out = wick::redeem_winner(&mut market, pos, scenario.ctx());
        bob_won = coin::value(&coin_out);
        assert!(bob_won == bob_position_amount, 4001);
        invariants::assert_collateral_invariant(&market);
        coin::burn_for_testing(coin_out);
        ts::return_shared(market);
    };

    // Alice LP redemption.
    scenario.next_tx(ALICE);
    let alice_lp_claim: u64;
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let lp = scenario.take_from_sender<LpPosition>();
        let coin_out = wick::redeem_lp(&mut market, lp, scenario.ctx());
        alice_lp_claim = coin::value(&coin_out);

        assert!(wick::collateral_value(&market) == 0, 4002);
        assert!(wick::total_no_touch_supply(&market) == 0, 4003);
        assert!(wick::no_touch_reserve(&market) == 0, 4004);
        assert!(wick::lp_supply(&market) == 0, 4005);

        coin::burn_for_testing(coin_out);
        ts::return_shared(market);
    };

    // CONSERVATION
    let total_deposits = SEED + PAY;
    let total_exits = bob_won + alice_lp_claim;
    assert!(total_exits == total_deposits, 4006);

    scenario.end();
}

// === Stranded losing-side: confirm losing positions cannot redeem after LP exits ===

#[test, expected_failure(abort_code = ::wick::wick::E_LOSING_SIDE)]
fun test_losing_side_position_cannot_redeem_after_lp_exit() {
    let mut scenario = ts::begin(ALICE);
    seed(&mut scenario, BARRIER - 100);

    // Bob buys NO_TOUCH (will be the losing side under HIT).
    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let clk = take_clock_at(&mut scenario, NOW_MS + 1);
        let pay = coin::mint_for_testing<SUI>(PAY, scenario.ctx());
        let pos = wick::buy_no_touch(&mut market, pay, &clk, scenario.ctx());
        transfer::public_transfer(pos, BOB);
        clock::destroy_for_testing(clk);
        ts::return_shared(market);
    };

    // Mark HIT.
    scenario.next_tx(ALICE);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let mut oracle = scenario.take_shared<MockOracle>();
        let clk = take_clock_at(&mut scenario, NOW_MS + 2);
        oracle_adapter::set_price(&mut oracle, BARRIER + 50);
        wick::mark_hit(&mut market, &oracle, &clk);
        clock::destroy_for_testing(clk);
        ts::return_shared(market);
        ts::return_shared(oracle);
    };

    // Bob (losing side) tries to redeem — must abort.
    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let pos = scenario.take_from_sender<Position>();
        let coin_out: Coin<SUI> = wick::redeem_winner(&mut market, pos, scenario.ctx());
        coin::burn_for_testing(coin_out);
        ts::return_shared(market);
    };
    scenario.end();
}
