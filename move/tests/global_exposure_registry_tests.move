// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Direct unit tests for `wick::global_exposure_registry` — the aggregate
/// probability-weighted-exposure (PWE) cap that protects the vault across
/// correlated markets. The market/segment suites exercise register-on-open /
/// clear-on-settle, but never the EWMA *time-decay* (they don't advance the
/// clock an hour). This file locks the decay math with known values and the
/// register → read → decay → decrease lifecycle directly.
///
/// Decay contract (1h half-life, integer approximation): full half-lives halve
/// repeatedly; the fractional part is linear — `value × (2H − frac) / 2H`.
#[test_only]
module wick::global_exposure_registry_tests;

use std::string;
use sui::clock;
use sui::test_scenario as ts;
use sui::test_utils;
use wick::global_exposure_registry as ger;

const ALICE: address = @0xA;
const V: u128 = 1_000_000;
const SIDE: u8 = 0;

fun underlying(): string::String { string::utf8(b"BTC") }

// === EWMA decay — known values ===

#[test]
fun ewma_no_decay_at_zero_elapsed() {
    assert!(ger::test_ewma_decay(V, 0) == V, 0);
}

#[test]
fun ewma_halves_at_one_half_life() {
    let h = ger::ewma_half_life_ms();
    assert!(ger::test_ewma_decay(V, h) == 500_000, 0);
}

#[test]
fun ewma_quarters_at_two_half_lives() {
    let h = ger::ewma_half_life_ms();
    assert!(ger::test_ewma_decay(V, 2 * h) == 250_000, 0);
}

// Half a half-life → linear approx: V × (2H − H/2)/2H = V × 0.75.
#[test]
fun ewma_linear_fraction_at_half_a_half_life() {
    let h = ger::ewma_half_life_ms();
    assert!(ger::test_ewma_decay(V, h / 2) == 750_000, 0);
}

#[test]
fun ewma_zero_value_stays_zero() {
    let h = ger::ewma_half_life_ms();
    assert!(ger::test_ewma_decay(0, h) == 0, 0);
}

// === register → read → decay → decrease lifecycle ===

#[test]
fun update_then_read_round_trips() {
    let mut sc = ts::begin(ALICE);
    let (mut reg, cap) = ger::init_for_testing(sc.ctx());
    let clk = clock::create_for_testing(sc.ctx()); // t = 0

    ger::test_update_exposure(&mut reg, underlying(), SIDE, true, V, &clk);
    assert!(ger::read_pwe(&reg, underlying(), SIDE, &clk) == V, 0); // same instant → no decay

    clk.destroy_for_testing();
    test_utils::destroy(reg);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
fun read_pwe_decays_over_time() {
    let mut sc = ts::begin(ALICE);
    let (mut reg, cap) = ger::init_for_testing(sc.ctx());
    let mut clk = clock::create_for_testing(sc.ctx()); // t = 0

    ger::test_update_exposure(&mut reg, underlying(), SIDE, true, V, &clk);
    clk.set_for_testing(ger::ewma_half_life_ms()); // one half-life later
    assert!(ger::read_pwe(&reg, underlying(), SIDE, &clk) == 500_000, 0);

    clk.destroy_for_testing();
    test_utils::destroy(reg);
    test_utils::destroy(cap);
    sc.end();
}

// A decrease larger than the current (decayed) balance floors at zero — never
// underflows into a huge u128.
#[test]
fun decrease_floors_at_zero() {
    let mut sc = ts::begin(ALICE);
    let (mut reg, cap) = ger::init_for_testing(sc.ctx());
    let clk = clock::create_for_testing(sc.ctx());

    ger::test_update_exposure(&mut reg, underlying(), SIDE, true, V, &clk);
    ger::test_update_exposure(&mut reg, underlying(), SIDE, false, 2 * V, &clk); // over-decrease
    assert!(ger::read_pwe(&reg, underlying(), SIDE, &clk) == 0, 0);

    clk.destroy_for_testing();
    test_utils::destroy(reg);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
fun read_pwe_is_zero_for_unknown_key() {
    let mut sc = ts::begin(ALICE);
    let (reg, cap) = ger::init_for_testing(sc.ctx());
    let clk = clock::create_for_testing(sc.ctx());

    assert!(ger::read_pwe(&reg, underlying(), SIDE, &clk) == 0, 0);

    clk.destroy_for_testing();
    test_utils::destroy(reg);
    test_utils::destroy(cap);
    sc.end();
}
