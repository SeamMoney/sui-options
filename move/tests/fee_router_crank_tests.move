// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Tests for FeeRouter::crank_bucket — the call that drains an accrued fee
/// bucket to its destination. Pin two things the existing fee_router tests
/// don't: every KNOWN bucket (LP / staker / protocol) cranks without aborting
/// (empty when nothing has accrued), and an out-of-range bucket id is rejected
/// (EBucketUnknown) rather than silently returning an empty balance — fee
/// routing must only ever touch the known buckets.
#[test_only]
module wick::fee_router_crank_tests;

use wick::fee_router as fr;
use sui::test_scenario as ts;
use sui::test_utils;
use sui::balance;
use sui::sui::SUI;

const ALICE: address = @0xA;

#[test]
fun crank_bucket_handles_each_known_bucket_when_empty() {
    let mut sc = ts::begin(ALICE);
    let (mut router, cap) = fr::init_for_testing<SUI>(sc.ctx());

    let lp = fr::crank_bucket(&mut router, 0); // BUCKET_LP
    let staker = fr::crank_bucket(&mut router, 1); // BUCKET_STAKER
    let protocol = fr::crank_bucket(&mut router, 3); // BUCKET_PROTOCOL
    assert!(balance::value(&lp) == 0, 0);
    assert!(balance::value(&staker) == 0, 1);
    assert!(balance::value(&protocol) == 0, 2);

    balance::destroy_for_testing(lp);
    balance::destroy_for_testing(staker);
    balance::destroy_for_testing(protocol);
    test_utils::destroy(router);
    test_utils::destroy(cap);
    sc.end();
}

// Safety: cranking an out-of-range fee-bucket id aborts rather than silently
// returning an empty balance → EBucketUnknown (=2).
#[test]
#[expected_failure(abort_code = 2, location = wick::fee_router)]
fun crank_bucket_rejects_unknown_bucket_id() {
    let mut sc = ts::begin(ALICE);
    let (mut router, cap) = fr::init_for_testing<SUI>(sc.ctx());

    let drained = fr::crank_bucket(&mut router, 99); // not a known bucket
    balance::destroy_for_testing(drained); // unreachable
    test_utils::destroy(router);
    test_utils::destroy(cap);
    sc.end();
}
