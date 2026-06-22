// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// pull_oracle_driver feeds the WickOracle from an off-chain pull source
// (Lazer). Its push_price guards are settlement-integrity critical: a feed
// must reject a replayed/stale price (non-monotonic timestamp), a far-future
// timestamp, and a push signed by the wrong keeper cap — otherwise a market
// could settle against a forged or rewound observation. The module previously
// had no dedicated test.

#[test_only]
#[allow(deprecated_usage)]
module wick::pull_oracle_driver_tests;

use std::string;
use sui::clock;
use sui::test_scenario as ts;
use sui::test_utils;
use wick::pull_oracle_driver as pod;
use wick::wick_oracle;
use wick::random_walk_driver as rwd;

const ALICE: address = @0xA;
const NOW: u64 = 1_000_000;
const SKEW: u64 = 30_000; // MAX_FUTURE_SKEW_MS

fun setup(sc: &mut ts::Scenario): (wick_oracle::WickOracle, pod::PullFeed, pod::KeeperCap, clock::Clock) {
    let (oracle, feed, cap) = pod::new_for_testing(
        string::utf8(b"BTC-USD"),
        string::utf8(b"lazer:btc-usd"),
        9_999_999_999_999,
        sc.ctx(),
    );
    let mut clk = clock::create_for_testing(sc.ctx());
    clk.set_for_testing(NOW);
    (oracle, feed, cap, clk)
}

#[test]
fun push_price_accepts_monotonic_and_advances_last_pushed() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, mut feed, cap, clk) = setup(&mut sc);

    pod::push_price(&mut feed, &mut oracle, &cap, 64_000_000_000, NOW, b"att-1", &clk, sc.ctx());
    assert!(pod::last_pushed_ms(&feed) == NOW, 0);

    // A strictly-later timestamp (still within the future-skew window) is fine.
    pod::push_price(&mut feed, &mut oracle, &cap, 64_500_000_000, NOW + 10_000, b"att-2", &clk, sc.ctx());
    assert!(pod::last_pushed_ms(&feed) == NOW + 10_000, 1);

    test_utils::destroy(oracle); test_utils::destroy(feed); test_utils::destroy(cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = 2, location = wick::pull_oracle_driver)]
fun push_price_rejects_non_monotonic_timestamp() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, mut feed, cap, clk) = setup(&mut sc);

    pod::push_price(&mut feed, &mut oracle, &cap, 64_000_000_000, NOW, b"att-1", &clk, sc.ctx());
    // Re-pushing at the SAME timestamp is a replay → ENonMonotonicTimestamp (=2).
    pod::push_price(&mut feed, &mut oracle, &cap, 1, NOW, b"replay", &clk, sc.ctx());

    test_utils::destroy(oracle); test_utils::destroy(feed); test_utils::destroy(cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = 3, location = wick::pull_oracle_driver)]
fun push_price_rejects_far_future_timestamp() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, mut feed, cap, clk) = setup(&mut sc);

    // Just past the future-skew window → EFutureTimestamp (=3).
    pod::push_price(&mut feed, &mut oracle, &cap, 64_000_000_000, NOW + SKEW + 1, b"future", &clk, sc.ctx());

    test_utils::destroy(oracle); test_utils::destroy(feed); test_utils::destroy(cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun push_price_accepts_timestamp_at_skew_boundary() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, mut feed, cap, clk) = setup(&mut sc);

    // Exactly at now + skew is allowed (<= boundary).
    pod::push_price(&mut feed, &mut oracle, &cap, 64_000_000_000, NOW + SKEW, b"edge", &clk, sc.ctx());
    assert!(pod::last_pushed_ms(&feed) == NOW + SKEW, 0);

    test_utils::destroy(oracle); test_utils::destroy(feed); test_utils::destroy(cap);
    clk.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = 4, location = wick::pull_oracle_driver)]
fun push_price_rejects_wrong_keeper_cap() {
    let mut sc = ts::begin(ALICE);
    let (mut oracle, mut feed, cap, clk) = setup(&mut sc);

    // A different keeper cap can't push to this feed → EWrongCap (=4).
    let rogue = pod::new_keeper_cap(sc.ctx());
    pod::push_price(&mut feed, &mut oracle, &rogue, 64_000_000_000, NOW, b"rogue", &clk, sc.ctx());

    test_utils::destroy(rogue);
    test_utils::destroy(oracle); test_utils::destroy(feed); test_utils::destroy(cap);
    clk.destroy_for_testing();
    sc.end();
}

// Safety: pushing into an oracle whose driver isn't the pull/Lazer kind is
// rejected → ENotPullDriver (=0). A pull feed must be backed by a genuine pull
// oracle, not e.g. the random-walk demo driver.
#[test]
#[expected_failure(abort_code = 0, location = wick::pull_oracle_driver)]
fun push_price_rejects_non_pull_oracle() {
    let mut sc = ts::begin(ALICE);
    let (oracle, mut feed, cap, clk) = setup(&mut sc);
    // A random-walk oracle has driver_kind != lazer → the driver check fires first.
    let (mut rw_oracle, rw) = rwd::new_for_testing(
        string::utf8(b"RW"), 64_000_000_000, 100, 60_000, &clk, sc.ctx(),
    );
    pod::push_price(&mut feed, &mut rw_oracle, &cap, 64_000_000_000, NOW, b"att", &clk, sc.ctx());

    test_utils::destroy(oracle); test_utils::destroy(feed); test_utils::destroy(cap);
    test_utils::destroy(rw_oracle); test_utils::destroy(rw);
    clk.destroy_for_testing();
    sc.end();
}

// Safety: a feed bound to oracle A cannot push into oracle B → EConfigOracleMismatch
// (=1). This is what stops a market from settling against a spoofed/foreign feed
// — the binding between a feed and its oracle is enforced on every push.
#[test]
#[expected_failure(abort_code = 1, location = wick::pull_oracle_driver)]
fun push_price_rejects_feed_bound_to_a_different_oracle() {
    let mut sc = ts::begin(ALICE);
    let (oracle1, mut feed1, cap1, clk) = setup(&mut sc);
    // A second, independent pull oracle (also Lazer, so it passes the driver
    // check) — feed1 is NOT bound to it.
    let (mut oracle2, feed2, cap2) = pod::new_for_testing(
        string::utf8(b"ETH-USD"), string::utf8(b"lazer:eth-usd"), 9_999_999_999_999, sc.ctx(),
    );
    pod::push_price(&mut feed1, &mut oracle2, &cap1, 64_000_000_000, NOW, b"att", &clk, sc.ctx());

    test_utils::destroy(oracle1); test_utils::destroy(oracle2);
    test_utils::destroy(feed1); test_utils::destroy(feed2);
    test_utils::destroy(cap1); test_utils::destroy(cap2);
    clk.destroy_for_testing();
    sc.end();
}
