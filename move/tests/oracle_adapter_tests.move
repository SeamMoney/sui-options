#[test_only]
module wick::oracle_adapter_tests;

use sui::test_scenario as ts;
use wick::oracle_adapter::{Self, MockOracle};

const ALICE: address = @0xA11CE;

const DIR_ABOVE: u8 = 0;
const DIR_BELOW: u8 = 1;

#[test]
fun test_mock_oracle_create_and_get() {
    let mut scenario = ts::begin(ALICE);
    {
        let ctx = scenario.ctx();
        oracle_adapter::create_and_share(b"BTC/USD", 100_000, ctx);
    };

    scenario.next_tx(ALICE);

    let oracle = scenario.take_shared<MockOracle>();
    assert!(oracle_adapter::get_price(&oracle) == 100_000, 1);
    ts::return_shared(oracle);

    scenario.end();
}

#[test]
fun test_set_price_mutates_state() {
    let mut scenario = ts::begin(ALICE);
    {
        let ctx = scenario.ctx();
        oracle_adapter::create_and_share(b"SUI/USD", 3_000, ctx);
    };

    scenario.next_tx(ALICE);
    {
        let mut oracle = scenario.take_shared<MockOracle>();
        oracle_adapter::set_price(&mut oracle, 3_300);
        assert!(oracle_adapter::get_price(&oracle) == 3_300, 2);
        ts::return_shared(oracle);
    };

    scenario.end();
}

#[test]
fun test_barrier_crossed_above() {
    let mut scenario = ts::begin(ALICE);
    {
        let ctx = scenario.ctx();
        oracle_adapter::create_and_share(b"BTC/USD", 99_000, ctx);
    };

    scenario.next_tx(ALICE);
    {
        let mut oracle = scenario.take_shared<MockOracle>();
        // price below barrier — not crossed
        assert!(!oracle_adapter::barrier_crossed(&oracle, DIR_ABOVE, 99_500), 10);
        // price equal to barrier — crossed
        oracle_adapter::set_price(&mut oracle, 99_500);
        assert!(oracle_adapter::barrier_crossed(&oracle, DIR_ABOVE, 99_500), 11);
        // price above barrier — crossed
        oracle_adapter::set_price(&mut oracle, 100_000);
        assert!(oracle_adapter::barrier_crossed(&oracle, DIR_ABOVE, 99_500), 12);
        ts::return_shared(oracle);
    };

    scenario.end();
}

#[test]
fun test_barrier_crossed_below() {
    let mut scenario = ts::begin(ALICE);
    {
        let ctx = scenario.ctx();
        oracle_adapter::create_and_share(b"SUI/USD", 3_500, ctx);
    };

    scenario.next_tx(ALICE);
    {
        let mut oracle = scenario.take_shared<MockOracle>();
        // price above barrier — not crossed
        assert!(!oracle_adapter::barrier_crossed(&oracle, DIR_BELOW, 3_300), 20);
        // price equal — crossed
        oracle_adapter::set_price(&mut oracle, 3_300);
        assert!(oracle_adapter::barrier_crossed(&oracle, DIR_BELOW, 3_300), 21);
        // price below — crossed
        oracle_adapter::set_price(&mut oracle, 3_000);
        assert!(oracle_adapter::barrier_crossed(&oracle, DIR_BELOW, 3_300), 22);
        ts::return_shared(oracle);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = ::wick::oracle_adapter::E_BAD_DIRECTION)]
fun test_barrier_crossed_bad_direction_aborts() {
    let mut scenario = ts::begin(ALICE);
    {
        let ctx = scenario.ctx();
        oracle_adapter::create_and_share(b"BTC/USD", 100_000, ctx);
    };

    scenario.next_tx(ALICE);
    {
        let oracle = scenario.take_shared<MockOracle>();
        let _ = oracle_adapter::barrier_crossed(&oracle, 99, 100_000);
        ts::return_shared(oracle);
    };

    scenario.end();
}
