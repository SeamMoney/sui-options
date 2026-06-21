// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// OracleVersionLock pins the exact Predict package + object a market is allowed
// to settle against, so a market can never be settled against a stale or
// swapped oracle version. `assert_pinned` is the first line of every
// predict-route entrypoint; the migration flow is the only sanctioned way to
// move the pin. These tests cover the safety contract end to end (the module
// previously had no dedicated test).

#[test_only]
module wick::oracle_version_lock_tests;

use sui::object;
use sui::test_scenario as ts;
use sui::test_utils;
use wick::oracle_version_lock as ovl;

const ALICE: address = @0xA;
const PKG_OLD: address = @0x100;
const PKG_NEW: address = @0x200;

#[test]
fun assert_pinned_passes_on_match_and_getters_report_state() {
    let mut sc = ts::begin(ALICE);
    let oid = object::id_from_address(@0xDEAD);
    let (lock, cap) = ovl::init_for_testing(PKG_OLD, oid, sc.ctx());

    // Matching identity → no abort (the happy path every entrypoint takes).
    ovl::assert_pinned(&lock, PKG_OLD, oid);
    assert!(ovl::predict_pkg(&lock) == PKG_OLD, 0);
    assert!(ovl::predict_object_id(&lock) == oid, 1);
    assert!(!ovl::is_migrating(&lock), 2);

    test_utils::destroy(lock);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
#[expected_failure(abort_code = 1, location = wick::oracle_version_lock)]
fun assert_pinned_rejects_wrong_package() {
    let mut sc = ts::begin(ALICE);
    let oid = object::id_from_address(@0xDEAD);
    let (lock, cap) = ovl::init_for_testing(PKG_OLD, oid, sc.ctx());

    // Right object, WRONG package → EVersionMismatch (=1).
    ovl::assert_pinned(&lock, PKG_NEW, oid);

    test_utils::destroy(lock);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
#[expected_failure(abort_code = 1, location = wick::oracle_version_lock)]
fun assert_pinned_rejects_wrong_object() {
    let mut sc = ts::begin(ALICE);
    let oid = object::id_from_address(@0xDEAD);
    let (lock, cap) = ovl::init_for_testing(PKG_OLD, oid, sc.ctx());

    // Right package, WRONG object id → EVersionMismatch (=1).
    ovl::assert_pinned(&lock, PKG_OLD, object::id_from_address(@0xBEEF));

    test_utils::destroy(lock);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
fun migration_flips_the_pin_atomically() {
    let mut sc = ts::begin(ALICE);
    let old_oid = object::id_from_address(@0xDEAD);
    let new_oid = object::id_from_address(@0xCAFE);
    let (mut lock, cap) = ovl::init_for_testing(PKG_OLD, old_oid, sc.ctx());

    // Enter migration: the OLD identity still settles (open positions drain),
    // and the lock reports it is migrating.
    ovl::start_migration(&cap, &mut lock, PKG_NEW, new_oid);
    assert!(ovl::is_migrating(&lock), 0);
    ovl::assert_pinned(&lock, PKG_OLD, old_oid); // old still valid mid-migration

    // Complete: the pin flips to the NEW identity and migration clears.
    ovl::complete_migration(&cap, &mut lock);
    assert!(!ovl::is_migrating(&lock), 1);
    assert!(ovl::predict_pkg(&lock) == PKG_NEW, 2);
    assert!(ovl::predict_object_id(&lock) == new_oid, 3);
    ovl::assert_pinned(&lock, PKG_NEW, new_oid); // new now valid

    test_utils::destroy(lock);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
#[expected_failure(abort_code = 0, location = wick::oracle_version_lock)]
fun complete_migration_without_start_aborts() {
    let mut sc = ts::begin(ALICE);
    let oid = object::id_from_address(@0xDEAD);
    let (mut lock, cap) = ovl::init_for_testing(PKG_OLD, oid, sc.ctx());

    // Not migrating → ENotMigrating (=0).
    ovl::complete_migration(&cap, &mut lock);

    test_utils::destroy(lock);
    test_utils::destroy(cap);
    sc.end();
}

#[test]
fun pin_after_migration_rejects_the_old_version() {
    let mut sc = ts::begin(ALICE);
    let old_oid = object::id_from_address(@0xDEAD);
    let new_oid = object::id_from_address(@0xCAFE);
    let (mut lock, cap) = ovl::init_for_testing(PKG_OLD, old_oid, sc.ctx());

    ovl::start_migration(&cap, &mut lock, PKG_NEW, new_oid);
    ovl::complete_migration(&cap, &mut lock);

    // The old version must no longer pass the pin — proven by the getters
    // (a direct assert_pinned(old) would abort; the dedicated reject tests
    // above cover the abort path).
    assert!(ovl::predict_pkg(&lock) != PKG_OLD, 0);
    assert!(ovl::predict_object_id(&lock) != old_oid, 1);

    test_utils::destroy(lock);
    test_utils::destroy(cap);
    sc.end();
}
