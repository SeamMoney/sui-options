// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

#[test_only]
#[allow(deprecated_usage)]
module wick::bot_registry_tests;

use sui::test_scenario as ts;
use sui::test_utils;
use wick::bot_registry as br;

const ALICE: address = @0xA;
const BOB: address = @0xB;
const CAROL: address = @0xC;

#[test]
fun empty_registry_everyone_eligible() {
    let mut sc = ts::begin(ALICE);
    let (reg, cap) = br::init_for_testing(sc.ctx());
    assert!(br::is_eligible_for_wick(&reg, BOB), 0);
    assert!(br::is_eligible_for_wick(&reg, CAROL), 1);
    assert!(br::bot_count(&reg) == 0, 2);
    test_utils::destroy(reg);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
fun marked_address_is_ineligible() {
    let mut sc = ts::begin(ALICE);
    let (mut reg, cap) = br::init_for_testing(sc.ctx());

    br::mark_bot(&cap, &mut reg, BOB);
    assert!(!br::is_eligible_for_wick(&reg, BOB), 0);
    assert!(br::is_marked_bot(&reg, BOB), 1);
    assert!(br::is_eligible_for_wick(&reg, CAROL), 2);  // others unaffected
    assert!(br::bot_count(&reg) == 1, 3);

    test_utils::destroy(reg);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
fun unmark_re_enables() {
    let mut sc = ts::begin(ALICE);
    let (mut reg, cap) = br::init_for_testing(sc.ctx());

    br::mark_bot(&cap, &mut reg, BOB);
    br::unmark_bot(&cap, &mut reg, BOB);
    assert!(br::is_eligible_for_wick(&reg, BOB), 0);
    assert!(br::bot_count(&reg) == 0, 1);

    test_utils::destroy(reg);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
fun double_mark_idempotent() {
    let mut sc = ts::begin(ALICE);
    let (mut reg, cap) = br::init_for_testing(sc.ctx());

    br::mark_bot(&cap, &mut reg, BOB);
    br::mark_bot(&cap, &mut reg, BOB);  // no-op, no abort
    assert!(br::bot_count(&reg) == 1, 0);

    test_utils::destroy(reg);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
#[expected_failure(abort_code = br::ENotMarked)]
fun unmark_unknown_aborts() {
    let mut sc = ts::begin(ALICE);
    let (mut reg, cap) = br::init_for_testing(sc.ctx());
    br::unmark_bot(&cap, &mut reg, BOB);  // never marked
    test_utils::destroy(reg);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
#[expected_failure(abort_code = br::ENotAdmin)]
fun mark_with_wrong_admin_aborts() {
    let mut sc = ts::begin(ALICE);
    let (mut reg, cap) = br::init_for_testing(sc.ctx());
    let (other_reg, other_cap) = br::init_for_testing(sc.ctx());
    br::mark_bot(&other_cap, &mut reg, BOB);  // wrong cap
    test_utils::destroy(reg);
    test_utils::destroy(other_reg);
    test_utils::destroy(cap);
    test_utils::destroy(other_cap);
    sc.end();
}
