/// Tests for mark_hit / settle_expired / redeem_winner.
#[test_only]
module wick::settlement_tests;

use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario as ts;
use wick::oracle_adapter::{Self, MockOracle};
use wick::wick::{Self, Market, Position};
use wick::invariants;

const ALICE: address = @0xA11CE;
const BOB:   address = @0xB0B;

const NOW_MS: u64 = 1_000_000;
const EXPIRY_OFFSET_MS: u64 = 60_000;
const SEED: u64 = 1_000_000;
const BARRIER: u64 = 99_500;

// === Helpers ===

#[test_only]
fun seed_market_and_oracle(scenario: &mut ts::Scenario, oracle_initial_price: u64) {
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

// === mark_hit ===

#[test]
fun test_mark_hit_happy_path() {
    let mut scenario = ts::begin(ALICE);
    seed_market_and_oracle(&mut scenario, BARRIER - 100);

    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let mut oracle = scenario.take_shared<MockOracle>();
        let clk = take_clock_at(&mut scenario, NOW_MS + 1);

        // Push oracle past the barrier and call mark_hit.
        oracle_adapter::set_price(&mut oracle, BARRIER + 50);
        wick::mark_hit(&mut market, &oracle, &clk);

        assert!(wick::status(&market) == wick::status_hit(), 700);
        invariants::assert_collateral_invariant(&market);

        clock::destroy_for_testing(clk);
        ts::return_shared(market);
        ts::return_shared(oracle);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = ::wick::wick::E_BARRIER_NOT_CROSSED)]
fun test_mark_hit_without_crossing_aborts() {
    let mut scenario = ts::begin(ALICE);
    seed_market_and_oracle(&mut scenario, BARRIER - 100);

    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let oracle = scenario.take_shared<MockOracle>();
        let clk = take_clock_at(&mut scenario, NOW_MS + 1);

        // Oracle still below barrier; mark_hit must reject.
        wick::mark_hit(&mut market, &oracle, &clk);

        clock::destroy_for_testing(clk);
        ts::return_shared(market);
        ts::return_shared(oracle);
    };
    scenario.end();
}

#[test, expected_failure(abort_code = ::wick::wick::E_NOT_ACTIVE)]
fun test_mark_hit_idempotent_second_call_aborts() {
    let mut scenario = ts::begin(ALICE);
    seed_market_and_oracle(&mut scenario, BARRIER - 100);

    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let mut oracle = scenario.take_shared<MockOracle>();
        let clk = take_clock_at(&mut scenario, NOW_MS + 1);

        oracle_adapter::set_price(&mut oracle, BARRIER + 50);
        wick::mark_hit(&mut market, &oracle, &clk); // first call: ok
        wick::mark_hit(&mut market, &oracle, &clk); // second call: must abort

        clock::destroy_for_testing(clk);
        ts::return_shared(market);
        ts::return_shared(oracle);
    };
    scenario.end();
}

#[test, expected_failure(abort_code = ::wick::wick::E_PAST_EXPIRY_TRADE)]
fun test_mark_hit_after_expiry_aborts() {
    let mut scenario = ts::begin(ALICE);
    seed_market_and_oracle(&mut scenario, BARRIER + 50);

    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let oracle = scenario.take_shared<MockOracle>();
        let clk = take_clock_at(&mut scenario, NOW_MS + EXPIRY_OFFSET_MS + 1);

        wick::mark_hit(&mut market, &oracle, &clk);

        clock::destroy_for_testing(clk);
        ts::return_shared(market);
        ts::return_shared(oracle);
    };
    scenario.end();
}

// === settle_expired ===

#[test]
fun test_settle_expired_happy_path() {
    let mut scenario = ts::begin(ALICE);
    seed_market_and_oracle(&mut scenario, BARRIER - 100);

    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let oracle = scenario.take_shared<MockOracle>();
        let clk = take_clock_at(&mut scenario, NOW_MS + EXPIRY_OFFSET_MS + 1);

        wick::settle_expired(&mut market, &clk);
        assert!(wick::status(&market) == wick::status_expired(), 800);
        invariants::assert_collateral_invariant(&market);

        clock::destroy_for_testing(clk);
        ts::return_shared(market);
        ts::return_shared(oracle);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = ::wick::wick::E_NOT_EXPIRED)]
fun test_settle_expired_too_early_aborts() {
    let mut scenario = ts::begin(ALICE);
    seed_market_and_oracle(&mut scenario, BARRIER - 100);

    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let oracle = scenario.take_shared<MockOracle>();
        let clk = take_clock_at(&mut scenario, NOW_MS + 1);

        wick::settle_expired(&mut market, &clk);

        clock::destroy_for_testing(clk);
        ts::return_shared(market);
        ts::return_shared(oracle);
    };
    scenario.end();
}

#[test, expected_failure(abort_code = ::wick::wick::E_NOT_ACTIVE)]
fun test_settle_expired_after_hit_aborts() {
    let mut scenario = ts::begin(ALICE);
    seed_market_and_oracle(&mut scenario, BARRIER - 100);

    // First mark hit.
    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let mut oracle = scenario.take_shared<MockOracle>();
        let clk = take_clock_at(&mut scenario, NOW_MS + 1);
        oracle_adapter::set_price(&mut oracle, BARRIER + 50);
        wick::mark_hit(&mut market, &oracle, &clk);
        clock::destroy_for_testing(clk);
        ts::return_shared(market);
        ts::return_shared(oracle);
    };

    // Then try to settle_expired post-expiry — should reject because status != ACTIVE.
    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let oracle = scenario.take_shared<MockOracle>();
        let clk = take_clock_at(&mut scenario, NOW_MS + EXPIRY_OFFSET_MS + 1);
        wick::settle_expired(&mut market, &clk);
        clock::destroy_for_testing(clk);
        ts::return_shared(market);
        ts::return_shared(oracle);
    };
    scenario.end();
}

// === redeem_winner ===

#[test]
fun test_redeem_winner_hit_pays_touch_only() {
    let mut scenario = ts::begin(ALICE);
    seed_market_and_oracle(&mut scenario, BARRIER - 100);

    // Bob buys TOUCH and NO_TOUCH (both sides) using mint_complete_set_for_testing
    // so amounts are clean.
    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let payment = coin::mint_for_testing<SUI>(10_000, scenario.ctx());
        let (touch, no_touch) =
            wick::mint_complete_set_for_testing<SUI>(&mut market, payment, scenario.ctx());
        transfer::public_transfer(touch, BOB);
        transfer::public_transfer(no_touch, BOB);
        ts::return_shared(market);
    };

    // Mark hit.
    scenario.next_tx(BOB);
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

    // Bob redeems his TOUCH.
    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let positions = scenario.ids_for_sender<Position>();
        // Take both positions; redeem TOUCH, hold NO_TOUCH (loser).
        let pos_a = scenario.take_from_sender_by_id<Position>(*vector::borrow(&positions, 0));
        let pos_b = scenario.take_from_sender_by_id<Position>(*vector::borrow(&positions, 1));

        // Identify which is TOUCH.
        let (touch, no_touch) = if (wick::position_side(&pos_a) == wick::side_touch()) {
            (pos_a, pos_b)
        } else {
            (pos_b, pos_a)
        };

        let touch_amount = wick::position_amount(&touch);
        let coin_out = wick::redeem_winner(&mut market, touch, scenario.ctx());
        assert!(coin::value(&coin_out) == touch_amount, 900);
        invariants::assert_collateral_invariant(&market);

        coin::burn_for_testing(coin_out);
        transfer::public_transfer(no_touch, BOB);
        ts::return_shared(market);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = ::wick::wick::E_LOSING_SIDE)]
fun test_redeem_winner_no_touch_after_hit_aborts() {
    let mut scenario = ts::begin(ALICE);
    seed_market_and_oracle(&mut scenario, BARRIER - 100);

    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let payment = coin::mint_for_testing<SUI>(10_000, scenario.ctx());
        let (touch, no_touch) =
            wick::mint_complete_set_for_testing<SUI>(&mut market, payment, scenario.ctx());
        transfer::public_transfer(touch, BOB);
        transfer::public_transfer(no_touch, BOB);
        ts::return_shared(market);
    };

    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let mut oracle = scenario.take_shared<MockOracle>();
        let clk = take_clock_at(&mut scenario, NOW_MS + 1);
        oracle_adapter::set_price(&mut oracle, BARRIER + 50);
        wick::mark_hit(&mut market, &oracle, &clk);
        clock::destroy_for_testing(clk);
        ts::return_shared(market);
        ts::return_shared(oracle);
    };

    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let positions = scenario.ids_for_sender<Position>();
        let pos_a = scenario.take_from_sender_by_id<Position>(*vector::borrow(&positions, 0));
        let pos_b = scenario.take_from_sender_by_id<Position>(*vector::borrow(&positions, 1));
        let (touch, no_touch) = if (wick::position_side(&pos_a) == wick::side_touch()) {
            (pos_a, pos_b)
        } else {
            (pos_b, pos_a)
        };

        // Try to redeem the loser side after HIT.
        let coin_out = wick::redeem_winner(&mut market, no_touch, scenario.ctx());

        coin::burn_for_testing(coin_out);
        transfer::public_transfer(touch, BOB);
        ts::return_shared(market);
    };
    scenario.end();
}

#[test]
fun test_redeem_winner_expired_pays_no_touch_only() {
    let mut scenario = ts::begin(ALICE);
    seed_market_and_oracle(&mut scenario, BARRIER - 100);

    // Bob mints both sides.
    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let payment = coin::mint_for_testing<SUI>(10_000, scenario.ctx());
        let (touch, no_touch) =
            wick::mint_complete_set_for_testing<SUI>(&mut market, payment, scenario.ctx());
        transfer::public_transfer(touch, BOB);
        transfer::public_transfer(no_touch, BOB);
        ts::return_shared(market);
    };

    // Time passes, oracle never crosses, settle_expired.
    scenario.next_tx(BOB);
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

    // Bob redeems NO_TOUCH (winner under EXPIRED).
    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let positions = scenario.ids_for_sender<Position>();
        let pos_a = scenario.take_from_sender_by_id<Position>(*vector::borrow(&positions, 0));
        let pos_b = scenario.take_from_sender_by_id<Position>(*vector::borrow(&positions, 1));
        let (touch, no_touch) = if (wick::position_side(&pos_a) == wick::side_touch()) {
            (pos_a, pos_b)
        } else {
            (pos_b, pos_a)
        };

        let amt = wick::position_amount(&no_touch);
        let coin_out = wick::redeem_winner(&mut market, no_touch, scenario.ctx());
        assert!(coin::value(&coin_out) == amt, 1000);
        invariants::assert_collateral_invariant(&market);

        coin::burn_for_testing(coin_out);
        transfer::public_transfer(touch, BOB);
        ts::return_shared(market);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = ::wick::wick::E_STILL_ACTIVE)]
fun test_redeem_winner_while_active_aborts() {
    let mut scenario = ts::begin(ALICE);
    seed_market_and_oracle(&mut scenario, BARRIER - 100);

    scenario.next_tx(BOB);
    {
        let mut market = scenario.take_shared<Market<SUI>>();
        let payment = coin::mint_for_testing<SUI>(10_000, scenario.ctx());
        let (touch, no_touch) =
            wick::mint_complete_set_for_testing<SUI>(&mut market, payment, scenario.ctx());

        // Try to redeem before any settlement — must abort with E_STILL_ACTIVE.
        let coin_out = wick::redeem_winner(&mut market, touch, scenario.ctx());

        coin::burn_for_testing(coin_out);
        transfer::public_transfer(no_touch, BOB);
        ts::return_shared(market);
    };
    scenario.end();
}
