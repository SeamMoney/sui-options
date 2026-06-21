// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

#[test_only]
/// Move-side golden vectors for the v4.26 MARKET-HALT (rug) dice — the other
/// half of the TS↔Move conformance pinned in `scripts/rugRoll.test.ts`.
///
/// `roll_rug` in `segment_market_v4.move` computes, for each segment:
///   buf  = segment_key ‖ object::id_bytes(market) ‖ bcs::to_bytes(round_index)
///   roll = bcs::peel_u64(keccak256(buf)) % BPS_DENOMINATOR(10_000)
///   fires iff roll < rug_chance_bps
/// and fires on the FIRST qualifying segment of a round.
///
/// This test re-runs that EXACT construction (same `sui::hash::keccak256` +
/// `sui::bcs` the production module uses) on REAL inputs the live chain rugged
/// at — the 7 rounds of the rugged TUSD market `0x54e91530…`, each paired with
/// the roll the chain's own `roll_rug` produced. If a Move-stdlib change, an
/// endianness flip, or a BCS-encoding change ever shifts the result, these exact
/// integers stop matching here AND in the TS port — so the public "anyone can
/// replay the halt" claim can never silently drift on either side.
///
/// Vectors captured from testnet 2026-06-21 (see scripts/audit-rugs.ts, which
/// proves every one of these halts honest against the chain's RugFiredV4 events).
module wick::rug_roll_conformance_tests;

use sui::bcs;
use sui::hash;

/// The rugged TUSD market id, as the 32 raw bytes `object::id_bytes` yields.
const MARKET_ID: vector<u8> =
    x"54e915308c596981fa94e5ff1f6f4e602e8bd1aae8c4a610cb782573310b5282";

const BPS_DENOMINATOR: u64 = 10_000;

/// Byte-identical re-implementation of `roll_rug`'s pure dice computation.
fun compute_roll(key: vector<u8>, id_bytes: vector<u8>, round: u64): u64 {
    let mut buf = key;
    buf.append(id_bytes);
    buf.append(bcs::to_bytes(&round));
    let mut reader = bcs::new(hash::keccak256(&buf));
    bcs::peel_u64(&mut reader) % BPS_DENOMINATOR
}

#[test]
fun rug_roll_matches_onchain_golden_vectors() {
    // [round, on-chain rug segment] → expected roll (all < 150 bps ⇒ fired).
    // round 0, seg 35
    assert!(compute_roll(x"7cde85fe46f38f7193327c47d804eebb0116ac04a4f50c23f8c8885c09634867", MARKET_ID, 0) == 1, 0);
    // round 1, seg 88
    assert!(compute_roll(x"c33f96d6068d5a87c1d433ec15db579f92bfc28f91121febb89b4ddb53a2ad23", MARKET_ID, 1) == 5, 1);
    // round 2, seg 211
    assert!(compute_roll(x"5a2bd162c6a8f2eb34d91594b191e6ef869fc2a938920057b072a6ea9ae0e3aa", MARKET_ID, 2) == 105, 2);
    // round 3, seg 240
    assert!(compute_roll(x"93aa6153f37b01f13b246530820d3a8878c01e2887d10d7db9c4a1555be158ff", MARKET_ID, 3) == 45, 3);
    // round 4, seg 362
    assert!(compute_roll(x"a64b41e67904a53515a53e071785ebf0854512dd13dbf8dd6d5f4f98558a98b0", MARKET_ID, 4) == 95, 4);
    // round 5, seg 447
    assert!(compute_roll(x"093820828196dac74fca1349bd643d1d453f6eec767601bb7878c95084f1cdc5", MARKET_ID, 5) == 124, 5);
    // round 6, seg 458
    assert!(compute_roll(x"9d3ecd317edd3f7349fcafd749d8d95ddb26f4ec1e5c6513baa6fff32d80bf95", MARKET_ID, 6) == 78, 6);

    // Every one of these is a REAL halt the chain fired, so each must roll below
    // the live 150-bps dice — the cryptographic basis of the house edge.
    assert!(compute_roll(x"9d3ecd317edd3f7349fcafd749d8d95ddb26f4ec1e5c6513baa6fff32d80bf95", MARKET_ID, 6) < 150, 7);
}

#[test]
fun round_index_is_in_the_hash_preimage() {
    // Same key, different round → different roll (round 6 yields 78).
    let key = x"9d3ecd317edd3f7349fcafd749d8d95ddb26f4ec1e5c6513baa6fff32d80bf95";
    assert!(compute_roll(key, MARKET_ID, 6) == 78, 0);
    assert!(compute_roll(key, MARKET_ID, 7) != 78, 1);
}

#[test]
fun roll_is_in_range() {
    let key = x"5a2bd162c6a8f2eb34d91594b191e6ef869fc2a938920057b072a6ea9ae0e3aa";
    let r = compute_roll(key, MARKET_ID, 2);
    assert!(r < BPS_DENOMINATOR, 0);
}
