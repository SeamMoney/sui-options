#[test_only]
module wick::wick_tests;

use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario as ts;
use wick::wick::{Self, Market, LpPosition};
use wick::invariants;

const ALICE: address = @0xA11CE;

const NOW_MS: u64 = 1_000_000;
const EXPIRY_OFFSET_MS: u64 = 60_000;

#[test]
fun test_create_market_happy_path() {
    let mut scenario = ts::begin(ALICE);

    // tx 1: create the market
    {
        let ctx = scenario.ctx();
        let mut clk = clock::create_for_testing(ctx);
        clock::set_for_testing(&mut clk, NOW_MS);
        let seed = coin::mint_for_testing<SUI>(100, ctx);

        wick::create_market<SUI>(
            b"BTC/USD",
            wick::dir_above(),
            99_500,
            NOW_MS + EXPIRY_OFFSET_MS,
            30,
            seed,
            &clk,
            ctx,
        );

        clock::destroy_for_testing(clk);
    };

    // tx 2: read the shared Market and the LpPosition transferred to the sender
    scenario.next_tx(ALICE);
    {
        let market = scenario.take_shared<Market<SUI>>();

        assert!(wick::status(&market) == wick::status_active(), 100);
        assert!(wick::direction(&market) == wick::dir_above(), 101);
        assert!(wick::barrier(&market) == 99_500, 102);
        assert!(wick::expiry_ms(&market) == NOW_MS + EXPIRY_OFFSET_MS, 103);
        assert!(wick::fee_bps(&market) == 30, 104);
        assert!(wick::touch_reserve(&market) == 100, 105);
        assert!(wick::no_touch_reserve(&market) == 100, 106);
        assert!(wick::total_touch_supply(&market) == 100, 107);
        assert!(wick::total_no_touch_supply(&market) == 100, 108);
        assert!(wick::lp_supply(&market) == 100, 109);
        assert!(wick::collateral_value(&market) == 100, 110);
        invariants::assert_collateral_invariant(&market);

        let lp = scenario.take_from_sender<LpPosition>();
        assert!(wick::lp_shares(&lp) == 100, 111);
        assert!(wick::lp_market_id(&lp) == object::id(&market), 112);

        ts::return_shared(market);
        scenario.return_to_sender(lp);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = ::wick::wick::E_ZERO_BARRIER)]
fun test_create_market_zero_barrier_aborts() {
    let mut scenario = ts::begin(ALICE);
    {
        let ctx = scenario.ctx();
        let mut clk = clock::create_for_testing(ctx);
        clock::set_for_testing(&mut clk, NOW_MS);
        let seed = coin::mint_for_testing<SUI>(100, ctx);

        wick::create_market<SUI>(
            b"BTC/USD",
            wick::dir_above(),
            0, // zero barrier — should abort
            NOW_MS + EXPIRY_OFFSET_MS,
            30,
            seed,
            &clk,
            ctx,
        );

        clock::destroy_for_testing(clk);
    };
    scenario.end();
}

#[test, expected_failure(abort_code = ::wick::wick::E_PAST_EXPIRY)]
fun test_create_market_past_expiry_aborts() {
    let mut scenario = ts::begin(ALICE);
    {
        let ctx = scenario.ctx();
        let mut clk = clock::create_for_testing(ctx);
        clock::set_for_testing(&mut clk, NOW_MS);
        let seed = coin::mint_for_testing<SUI>(100, ctx);

        wick::create_market<SUI>(
            b"BTC/USD",
            wick::dir_above(),
            99_500,
            NOW_MS - 1, // expiry already passed
            30,
            seed,
            &clk,
            ctx,
        );

        clock::destroy_for_testing(clk);
    };
    scenario.end();
}

#[test, expected_failure(abort_code = ::wick::wick::E_ZERO_COLLATERAL)]
fun test_create_market_zero_collateral_aborts() {
    let mut scenario = ts::begin(ALICE);
    {
        let ctx = scenario.ctx();
        let mut clk = clock::create_for_testing(ctx);
        clock::set_for_testing(&mut clk, NOW_MS);
        let seed = coin::mint_for_testing<SUI>(0, ctx); // zero collateral

        wick::create_market<SUI>(
            b"BTC/USD",
            wick::dir_above(),
            99_500,
            NOW_MS + EXPIRY_OFFSET_MS,
            30,
            seed,
            &clk,
            ctx,
        );

        clock::destroy_for_testing(clk);
    };
    scenario.end();
}

#[test, expected_failure(abort_code = ::wick::wick::E_INVALID_DIRECTION)]
fun test_create_market_invalid_direction_aborts() {
    let mut scenario = ts::begin(ALICE);
    {
        let ctx = scenario.ctx();
        let mut clk = clock::create_for_testing(ctx);
        clock::set_for_testing(&mut clk, NOW_MS);
        let seed = coin::mint_for_testing<SUI>(100, ctx);

        wick::create_market<SUI>(
            b"BTC/USD",
            99, // not ABOVE or BELOW
            99_500,
            NOW_MS + EXPIRY_OFFSET_MS,
            30,
            seed,
            &clk,
            ctx,
        );

        clock::destroy_for_testing(clk);
    };
    scenario.end();
}

#[test, expected_failure(abort_code = ::wick::wick::E_INVALID_FEE)]
fun test_create_market_invalid_fee_aborts() {
    let mut scenario = ts::begin(ALICE);
    {
        let ctx = scenario.ctx();
        let mut clk = clock::create_for_testing(ctx);
        clock::set_for_testing(&mut clk, NOW_MS);
        let seed = coin::mint_for_testing<SUI>(100, ctx);

        wick::create_market<SUI>(
            b"BTC/USD",
            wick::dir_above(),
            99_500,
            NOW_MS + EXPIRY_OFFSET_MS,
            10_001, // > 100%
            seed,
            &clk,
            ctx,
        );

        clock::destroy_for_testing(clk);
    };
    scenario.end();
}
