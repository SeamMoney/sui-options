// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Tests for `wick::segment_market_v3` — the v3.4 production module.
///
/// Coverage targets per doc 23 §7 + doc 24:
///   1. Bootstrap creates a fresh v3 market with empty v3 tables.
///   2. open_segment_ride_v3 bumps unsettled_rides_per_round[round].
///   3. close_segment_ride_v3 decrements it.
///   4. crank_expired_segment_ride_v3 decrements it.
///   5. abort_segment_ride_v3 decrements it.
///   6. record_walrus_archive happy path.
///   7. record_walrus_archive aborts on short blob_id.
///   8. record_walrus_archive aborts on long blob_id.
///   9. record_walrus_archive aborts when already recorded.
///  10. prune_settled_segments succeeds after lag + archive + zero unsettled.
///  11. prune_settled_segments aborts when too soon.
///  12. prune_settled_segments aborts with unsettled rides remaining.
///  13. prune_settled_segments aborts when no Walrus archive.
///  14. prune_settled_segments is idempotent (EAlreadyPruned).
///  15. prune_settled_segments_then_record_segment_still_works — pruned
///      rounds don't affect the hot path.
///  16. prune empty round is a clean no-op (SEV-2 #A fix from
///      /tmp/review-prune-proto.md).
///  17. unsettled counter survives a round roll.
///  18. ported v2 regression: scan_for_touch_above_with_deadband.
///  19. ported v2 regression: close_segment_ride_v3 touch_win.
///  20. ported v2 regression: abort happy path.
///  21. deadband_zero_yields_barrier_passthrough.
#[test_only]
module wick::segment_market_v3_tests;

use sui::clock::{Self as clock, Clock};
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use sui::test_scenario as ts;
use sui::test_utils;
use wick::bot_registry as br;
use wick::martingaler_vault::{Self as mv, MartingalerVault};
use wick::seeded_path as sp;
use wick::segment_market_v3::{Self as sm3, SegmentMarketV3};
use wick::usd_price_oracle as upo;
use wick::wick_staking as ws;
use wick::wick_token as wt;

const ALICE: address = @0xA;
const BOB: address = @0xB;
const KEEPER: address = @0xC;
const ARCHIVER: address = @0xD;
const PRUNER: address = @0xE;

const HOME_PRICE: u64 = 1_000_000_000;
const VOL_REGIME_INIT: u64 = 1_000_000;
const ROUND_DURATION: u64 = 20;
const OPEN_WINDOW: u64 = 5;
const BARRIER_OFFSET_BPS: u64 = 500;
const MULTIPLIER_BPS: u64 = 20_000;
const MAX_PAYOUT_PER_BARRIER: u64 = 1_500_000_000;
const DEADBAND_BPS: u64 = 20;
const SIGMA_BPS: u64 = 50;
const CASHOUT_SPREAD_BPS: u64 = 500;
const ABORT_DEADLINE_MS: u64 = 30_000;
const MIN_STAKE: u64 = 100;
const MAX_STAKE: u64 = 10_000_000;
const MAX_CONCURRENT: u64 = 100;
const MAX_PER_USER: u64 = 5;

// === Helpers ===

fun mint_sui(amount: u64, sc: &mut ts::Scenario): Coin<SUI> {
    coin::mint_for_testing<SUI>(amount, sc.ctx())
}

fun mk_market(
    vault: &MartingalerVault<SUI>,
    sc: &mut ts::Scenario,
    clk: &Clock,
): SegmentMarketV3<SUI> {
    sm3::new_segment_market_v3<SUI>(
        vault,
        HOME_PRICE,
        VOL_REGIME_INIT,
        ROUND_DURATION,
        OPEN_WINDOW,
        BARRIER_OFFSET_BPS,
        MULTIPLIER_BPS,
        MAX_PAYOUT_PER_BARRIER,
        DEADBAND_BPS,
        SIGMA_BPS,
        CASHOUT_SPREAD_BPS,
        ABORT_DEADLINE_MS,
        MIN_STAKE,
        MAX_STAKE,
        MAX_CONCURRENT,
        MAX_PER_USER,
        clk,
        sc.ctx(),
    )
}

fun mk_full_world(sc: &mut ts::Scenario): (
    MartingalerVault<SUI>,
    mv::VaultAdminCap,
    SegmentMarketV3<SUI>,
    br::BotRegistry,
    br::BotAdminCap,
    upo::UsdPriceOracle,
    upo::PriceAdminCap,
    wt::WickTokenState,
    wt::WickAdminCap,
    ws::WickStakingPool,
    ws::StakingAdminCap,
    clock::Clock,
) {
    let mut clk = clock::create_for_testing(sc.ctx());
    clk.set_for_testing(1_000);
    let (vault, vcap) = mv::init_for_testing<SUI>(sc.ctx());
    let market = mk_market(&vault, sc, &clk);
    let (bots, bcap) = br::init_for_testing(sc.ctx());
    let (mut upo_obj, pcap) = upo::init_for_testing(sc.ctx());
    upo::set_price<SUI>(&pcap, &mut upo_obj, 1_000_000, 9, &clk);
    let (wts, wcap) = wt::init_for_testing(sc.ctx());
    let (pool, scap) = ws::init_for_testing(sc.ctx());
    (vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk)
}

fun teardown_world(
    vault: MartingalerVault<SUI>,
    vcap: mv::VaultAdminCap,
    market: SegmentMarketV3<SUI>,
    bots: br::BotRegistry,
    bcap: br::BotAdminCap,
    upo_obj: upo::UsdPriceOracle,
    pcap: upo::PriceAdminCap,
    wts: wt::WickTokenState,
    wcap: wt::WickAdminCap,
    pool: ws::WickStakingPool,
    scap: ws::StakingAdminCap,
    clk: clock::Clock,
) {
    test_utils::destroy(vault);
    test_utils::destroy(vcap);
    sm3::test_only_destroy_market(market);
    test_utils::destroy(bots);
    test_utils::destroy(bcap);
    test_utils::destroy(upo_obj);
    test_utils::destroy(pcap);
    test_utils::destroy(wts);
    test_utils::destroy(wcap);
    test_utils::destroy(pool);
    test_utils::destroy(scap);
    clk.destroy_for_testing();
}

/// Synthetic 32-byte blob ID for archive tests.
fun mk_blob_id(seed: u8): vector<u8> {
    let mut v = vector::empty<u8>();
    let mut i: u8 = 0;
    while ((i as u64) < 32) {
        vector::push_back(&mut v, ((seed + i) % 255));
        i = i + 1;
    };
    v
}

// === Tests ===

/// Test 1 — bootstrap creates a fresh v3 market with empty v3 tables.
#[test]
fun bootstrap_creates_fresh_v3_market() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    // v2 carry-over invariants.
    assert!(sm3::next_segment_index<SUI>(&market) == 0, 0);
    assert!(sm3::active_ride_count<SUI>(&market) == 0, 1);
    assert!(sm3::cached_round_index<SUI>(&market) == 0, 2);
    let expected_upper = HOME_PRICE + HOME_PRICE * BARRIER_OFFSET_BPS / 10_000;
    let expected_lower = HOME_PRICE - HOME_PRICE * BARRIER_OFFSET_BPS / 10_000;
    assert!(sm3::cached_upper_barrier<SUI>(&market) == expected_upper, 3);
    assert!(sm3::cached_lower_barrier<SUI>(&market) == expected_lower, 4);
    assert!(sm3::walk_price<SUI>(&market) == HOME_PRICE, 5);

    // v3 additions — all three Tables empty.
    assert!(sm3::unsettled_rides_for_round<SUI>(&market, 0) == 0, 6);
    assert!(!sm3::is_round_pruned<SUI>(&market, 0), 7);
    assert!(!sm3::has_walrus_archive<SUI>(&market, 0), 8);

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 2 — open_segment_ride_v3 bumps unsettled_rides_per_round.
#[test]
fun open_segment_ride_bumps_unsettled() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    assert!(sm3::unsettled_rides_for_round<SUI>(&market, 0) == 0, 0);

    let stake = 1_000u64;
    let escrow = mint_sui(stake * ROUND_DURATION, &mut sc);
    let r1 = sm3::open_segment_ride_v3<SUI>(
        &mut market, &mut vault, &bots,
        sm3::barrier_upper(), stake, escrow, &clk, sc.ctx(),
    );

    assert!(sm3::unsettled_rides_for_round<SUI>(&market, 0) == 1, 1);

    // Open a second ride to confirm increment, not just initialization.
    sc.next_tx(BOB);
    let escrow2 = mint_sui(stake * ROUND_DURATION, &mut sc);
    let r2 = sm3::open_segment_ride_v3<SUI>(
        &mut market, &mut vault, &bots,
        sm3::barrier_lower(), stake, escrow2, &clk, sc.ctx(),
    );

    assert!(sm3::unsettled_rides_for_round<SUI>(&market, 0) == 2, 2);

    sm3::test_only_destroy_ride(r1);
    sm3::test_only_destroy_ride(r2);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 3 — close_segment_ride_v3 decrements unsettled.
#[test]
fun close_segment_ride_decrements_unsettled() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    let stake = 1_000u64;
    let escrow = mint_sui(stake * ROUND_DURATION, &mut sc);
    let mut ride = sm3::open_segment_ride_v3<SUI>(
        &mut market, &mut vault, &bots,
        sm3::barrier_upper(), stake, escrow, &clk, sc.ctx(),
    );
    assert!(sm3::unsettled_rides_for_round<SUI>(&market, 0) == 1, 0);

    // Touch the upper barrier so close goes through TOUCH_WIN.
    let upper = sm3::cached_upper_barrier<SUI>(&market);
    let margin = upper * DEADBAND_BPS / 10_000;
    let st = sp::state_with(upper + margin, false, 0, VOL_REGIME_INIT, HOME_PRICE);
    sm3::test_only_record_segment<SUI>(
        &mut market, x"de", st, HOME_PRICE, upper + margin + 1, 1_500,
    );

    clk.increment_for_testing(1_000);
    let payout = sm3::close_segment_ride_v3<SUI>(
        &mut ride, &mut market, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );

    assert!(sm3::settlement_kind(&ride) == sm3::settlement_touch_win(), 1);
    assert!(sm3::unsettled_rides_for_round<SUI>(&market, 0) == 0, 2);

    test_utils::destroy(payout);
    sm3::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 4 — crank_expired_segment_ride_v3 decrements unsettled.
#[test]
fun crank_expired_segment_ride_decrements_unsettled() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    let stake = 1_000u64;
    let escrow = mint_sui(stake * ROUND_DURATION, &mut sc);
    let mut ride = sm3::open_segment_ride_v3<SUI>(
        &mut market, &mut vault, &bots,
        sm3::barrier_upper(), stake, escrow, &clk, sc.ctx(),
    );
    assert!(sm3::unsettled_rides_for_round<SUI>(&market, 0) == 1, 0);

    sm3::test_only_bump_segment_index<SUI>(&mut market, ROUND_DURATION + 5);
    clk.increment_for_testing(2_000);

    sc.next_tx(KEEPER);
    let bounty = sm3::crank_expired_segment_ride_v3<SUI>(
        &mut ride, &mut market, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );

    assert!(sm3::is_closed(&ride), 1);
    assert!(sm3::settlement_kind(&ride) == sm3::settlement_expired_loss(), 2);
    assert!(sm3::unsettled_rides_for_round<SUI>(&market, 0) == 0, 3);

    test_utils::destroy(bounty);
    sm3::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 5 — abort_segment_ride_v3 decrements unsettled.
#[test]
fun abort_segment_ride_decrements_unsettled() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let stake = 1_000u64;
    let escrow = mint_sui(stake * ROUND_DURATION, &mut sc);
    let mut ride = sm3::open_segment_ride_v3<SUI>(
        &mut market, &mut vault, &bots,
        sm3::barrier_upper(), stake, escrow, &clk, sc.ctx(),
    );
    assert!(sm3::unsettled_rides_for_round<SUI>(&market, 0) == 1, 0);

    clk.increment_for_testing(ABORT_DEADLINE_MS + 1);
    let refund = sm3::abort_segment_ride_v3<SUI>(
        &mut ride, &mut market, &mut vault, &clk, sc.ctx(),
    );

    assert!(sm3::settlement_kind(&ride) == sm3::settlement_aborted_refund(), 1);
    assert!(sm3::unsettled_rides_for_round<SUI>(&market, 0) == 0, 2);

    test_utils::destroy(refund);
    sm3::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 6 — record_walrus_archive happy path.
#[test]
fun record_walrus_archive_succeeds() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    let blob_id = mk_blob_id(42);
    assert!(vector::length(&blob_id) == sm3::walrus_blob_id_len(), 0);

    sc.next_tx(ARCHIVER);
    sm3::record_walrus_archive<SUI>(&mut market, 7, blob_id, sc.ctx());

    assert!(sm3::has_walrus_archive<SUI>(&market, 7), 1);
    let stored = sm3::walrus_blob_id<SUI>(&market, 7);
    assert!(vector::length(&stored) == 32, 2);

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 7 — record_walrus_archive aborts on short blob_id (< 32 bytes).
#[test]
#[expected_failure(abort_code = sm3::EInvalidBlobId, location = wick::segment_market_v3)]
fun record_walrus_archive_aborts_on_short_blob_id() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    let short = b"too-short";
    sm3::record_walrus_archive<SUI>(&mut market, 0, short, sc.ctx());

    // Unreached — kept for compile.
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 8 — record_walrus_archive aborts on long blob_id (> 32 bytes).
#[test]
#[expected_failure(abort_code = sm3::EInvalidBlobId, location = wick::segment_market_v3)]
fun record_walrus_archive_aborts_on_long_blob_id() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    let mut long = mk_blob_id(0);
    vector::push_back(&mut long, 0u8); // 33 bytes
    sm3::record_walrus_archive<SUI>(&mut market, 0, long, sc.ctx());

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 9 — record_walrus_archive aborts when already recorded.
#[test]
#[expected_failure(abort_code = sm3::EArchiveAlreadyRecorded, location = wick::segment_market_v3)]
fun record_walrus_archive_aborts_when_already_recorded() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    sm3::record_walrus_archive<SUI>(&mut market, 5, mk_blob_id(1), sc.ctx());
    sm3::record_walrus_archive<SUI>(&mut market, 5, mk_blob_id(2), sc.ctx());

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 10 — prune_settled_segments succeeds after lag + archive + zero unsettled.
#[test]
fun prune_settled_segments_succeeds_after_lag_and_archive() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    // Seed round 0 (segments 0..20) with synthetic records bypassing
    // next_segment_index so we can pre-position the segment ledger
    // without progressing through real rounds.
    let st = sp::new_state(HOME_PRICE, VOL_REGIME_INIT, HOME_PRICE);
    let mut k = 0;
    while (k < ROUND_DURATION) {
        sm3::test_only_insert_segment_at<SUI>(
            &mut market, k, vector::empty<u8>(), st,
            HOME_PRICE, HOME_PRICE, 1_000 + k,
        );
        k = k + 1;
    };
    assert!(sm3::has_segment<SUI>(&market, 0), 0);
    assert!(sm3::has_segment<SUI>(&market, ROUND_DURATION - 1), 1);

    // Force lag — make cached_round_index >> 0 + SETTLEMENT_LAG_ROUNDS.
    sm3::test_only_set_cached_round_index<SUI>(&mut market, 10);

    // Record a Walrus archive entry for round 0 (the v3.1 precondition).
    sc.next_tx(ARCHIVER);
    sm3::record_walrus_archive<SUI>(&mut market, 0, mk_blob_id(99), sc.ctx());

    // Prune.
    sc.next_tx(PRUNER);
    sm3::prune_settled_segments<SUI>(&mut market, 0, sc.ctx());

    // Every segment in [0, ROUND_DURATION) should be gone.
    let mut j = 0;
    while (j < ROUND_DURATION) {
        assert!(!sm3::has_segment<SUI>(&market, j), 2);
        j = j + 1;
    };
    assert!(sm3::is_round_pruned<SUI>(&market, 0), 3);

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 11 — prune_settled_segments aborts when too soon (lag gate).
#[test]
#[expected_failure(abort_code = sm3::ETooSoonToPrune, location = wick::segment_market_v3)]
fun prune_settled_segments_aborts_when_too_soon() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    // Archive present, no unsettled rides, but lag not met.
    sm3::record_walrus_archive<SUI>(&mut market, 0, mk_blob_id(11), sc.ctx());
    // cached_round_index is 0; round 0 + LAG(3) > 0 → ETooSoonToPrune.
    sm3::prune_settled_segments<SUI>(&mut market, 0, sc.ctx());

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 12 — prune_settled_segments aborts with unsettled rides remaining.
#[test]
#[expected_failure(abort_code = sm3::EUnsettledRidesRemain, location = wick::segment_market_v3)]
fun prune_settled_segments_aborts_with_unsettled_rides() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    // Open a ride against round 0 — bumps unsettled to 1.
    let stake = 1_000u64;
    let escrow = mint_sui(stake * ROUND_DURATION, &mut sc);
    let ride = sm3::open_segment_ride_v3<SUI>(
        &mut market, &mut vault, &bots,
        sm3::barrier_upper(), stake, escrow, &clk, sc.ctx(),
    );

    // Force lag, archive present, ride still unsettled.
    sm3::test_only_set_cached_round_index<SUI>(&mut market, 10);
    sm3::record_walrus_archive<SUI>(&mut market, 0, mk_blob_id(22), sc.ctx());

    sm3::prune_settled_segments<SUI>(&mut market, 0, sc.ctx());

    sm3::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 13 — prune_settled_segments aborts when no Walrus archive (v3.1
/// archive-before-prune invariant per doc 24 §8).
#[test]
#[expected_failure(abort_code = sm3::ENoWalrusArchive, location = wick::segment_market_v3)]
fun prune_settled_segments_aborts_when_no_walrus_archive() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    sm3::test_only_set_cached_round_index<SUI>(&mut market, 10);
    // No record_walrus_archive call — archive_index[0] missing.
    sm3::prune_settled_segments<SUI>(&mut market, 0, sc.ctx());

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 14 — prune_settled_segments is idempotent (re-prune aborts).
#[test]
#[expected_failure(abort_code = sm3::EAlreadyPruned, location = wick::segment_market_v3)]
fun prune_settled_segments_is_idempotent() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    // Seed at least one record so the first prune sets `pruned_rounds[0]`.
    let st = sp::new_state(HOME_PRICE, VOL_REGIME_INIT, HOME_PRICE);
    sm3::test_only_insert_segment_at<SUI>(
        &mut market, 0, vector::empty<u8>(), st,
        HOME_PRICE, HOME_PRICE, 1_000,
    );

    sm3::test_only_set_cached_round_index<SUI>(&mut market, 10);
    sm3::record_walrus_archive<SUI>(&mut market, 0, mk_blob_id(33), sc.ctx());

    // First prune succeeds.
    sm3::prune_settled_segments<SUI>(&mut market, 0, sc.ctx());
    assert!(sm3::is_round_pruned<SUI>(&market, 0), 0);

    // Second prune aborts via EAlreadyPruned.
    sm3::prune_settled_segments<SUI>(&mut market, 0, sc.ctx());

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 15 — pruned rounds don't affect new rounds' record_segment path.
///
/// The "hot path" check from doc 23 §3.2: deleting the old round's
/// SegmentRecord rows must not block `record_segment` from writing
/// into a fresh round. We verify by pruning round 0 and then inserting
/// a fresh test segment past the round boundary, asserting the new
/// segment lives in the ledger.
#[test]
fun prune_settled_segments_then_record_segment_still_works() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    // Seed round 0.
    let st = sp::new_state(HOME_PRICE, VOL_REGIME_INIT, HOME_PRICE);
    let mut k = 0;
    while (k < ROUND_DURATION) {
        sm3::test_only_insert_segment_at<SUI>(
            &mut market, k, vector::empty<u8>(), st,
            HOME_PRICE, HOME_PRICE, 1_000 + k,
        );
        k = k + 1;
    };

    sm3::test_only_set_cached_round_index<SUI>(&mut market, 10);
    sm3::record_walrus_archive<SUI>(&mut market, 0, mk_blob_id(44), sc.ctx());
    sm3::prune_settled_segments<SUI>(&mut market, 0, sc.ctx());

    // Round 0 is gone.
    let mut j = 0;
    while (j < ROUND_DURATION) {
        assert!(!sm3::has_segment<SUI>(&market, j), 0);
        j = j + 1;
    };

    // Bump next_segment_index past the pruned round and write a fresh
    // segment in round 10 (cached_round_index). This must NOT abort or
    // collide with the pruned-rounds marker.
    let new_k = 10 * ROUND_DURATION + 1;
    sm3::test_only_insert_segment_at<SUI>(
        &mut market, new_k, vector::empty<u8>(), st,
        HOME_PRICE, HOME_PRICE, 2_500,
    );
    assert!(sm3::has_segment<SUI>(&market, new_k), 1);

    // Pruning the same round 0 a second time would abort via
    // EAlreadyPruned (checked in test 14); the marker is set.
    assert!(sm3::is_round_pruned<SUI>(&market, 0), 2);
    // Round 10 itself has not been touched.
    assert!(!sm3::is_round_pruned<SUI>(&market, 10), 3);

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 16 — pruning an EMPTY round is a clean no-op (SEV-2 #A fix from
/// /tmp/review-prune-proto.md). No records to delete, no
/// `pruned_rounds` entry written, deleted_count = 0.
///
/// Without the fix the round would be marked pruned forever even though
/// no rebate was earned — wasted storage cost for the caller.
#[test]
fun prune_empty_round_does_not_mark_pruned() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    // Round 0 is empty (no segments inserted).
    sm3::test_only_set_cached_round_index<SUI>(&mut market, 10);
    sm3::record_walrus_archive<SUI>(&mut market, 0, mk_blob_id(55), sc.ctx());

    // Prune — must NOT abort even though there's nothing to delete.
    sm3::prune_settled_segments<SUI>(&mut market, 0, sc.ctx());

    // SEV-2 #A: pruned_rounds[0] should NOT be set since deleted_count == 0.
    assert!(!sm3::is_round_pruned<SUI>(&market, 0), 0);

    // Therefore a follow-up prune of the same empty round should also
    // succeed (no EAlreadyPruned), proving the no-op is repeatable
    // until records actually exist.
    sm3::prune_settled_segments<SUI>(&mut market, 0, sc.ctx());
    assert!(!sm3::is_round_pruned<SUI>(&market, 0), 1);

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 17 — unsettled-rides counter survives a round roll.
///
/// A ride opened in round 0 keeps its slot in `unsettled_rides_per_round[0]`
/// even after the cached round rolls to 1. The pruner gate must read the
/// ride's bound round, not the current round.
#[test]
fun unsettled_rides_counter_survives_round_roll() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    let stake = 1_000u64;
    let escrow = mint_sui(stake * ROUND_DURATION, &mut sc);
    let ride = sm3::open_segment_ride_v3<SUI>(
        &mut market, &mut vault, &bots,
        sm3::barrier_upper(), stake, escrow, &clk, sc.ctx(),
    );
    assert!(sm3::unsettled_rides_for_round<SUI>(&market, 0) == 1, 0);

    // Roll into round 1.
    sm3::test_only_bump_segment_index<SUI>(&mut market, ROUND_DURATION);
    sm3::test_only_force_round_current<SUI>(&mut market);
    assert!(sm3::cached_round_index<SUI>(&market) == 1, 1);

    // Round 0's unsettled counter is unchanged — the ride is still open.
    assert!(sm3::unsettled_rides_for_round<SUI>(&market, 0) == 1, 2);
    assert!(sm3::unsettled_rides_for_round<SUI>(&market, 1) == 0, 3);

    sm3::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 18 — ported v2 regression: scan_for_touch with deadband above.
#[test]
fun scan_for_touch_above_with_deadband() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    let barrier = 1_050_000_000u64;
    let st = sp::new_state(1_000_000_000, VOL_REGIME_INIT, 1_000_000_000);

    let margin = barrier * DEADBAND_BPS / 10_000;
    sm3::test_only_record_segment<SUI>(
        &mut market, x"00", st,
        900_000_000, barrier + margin - 1, 1_000,
    );
    assert!(!sm3::test_scan_for_touch<SUI>(&market, 0, 1, barrier, true), 0);

    sm3::test_only_record_segment<SUI>(
        &mut market, x"01", st,
        900_000_000, barrier + margin, 2_000,
    );
    assert!(sm3::test_scan_for_touch<SUI>(&market, 0, 2, barrier, true), 1);

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 19 — ported v2 regression: close ride after touch wins.
#[test]
fun close_segment_ride_touch_win_v3() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;
    let escrow = mint_sui(escrow_amt, &mut sc);
    let mut ride = sm3::open_segment_ride_v3<SUI>(
        &mut market, &mut vault, &bots,
        sm3::barrier_upper(), stake, escrow, &clk, sc.ctx(),
    );

    let upper = sm3::cached_upper_barrier<SUI>(&market);
    let margin = upper * DEADBAND_BPS / 10_000;
    let st = sp::state_with(upper + margin, false, 0, VOL_REGIME_INIT, HOME_PRICE);
    sm3::test_only_record_segment<SUI>(
        &mut market, x"de", st, HOME_PRICE, upper + margin + 1, 2_000,
    );

    clk.increment_for_testing(1_000);
    let payout = sm3::close_segment_ride_v3<SUI>(
        &mut ride, &mut market, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );

    assert!(sm3::settlement_kind(&ride) == sm3::settlement_touch_win(), 0);
    // stake_paid = 1_000; payout = 2_000; total_to_user = 2_000 + (escrow - 1_000)
    assert!(payout.value() == 2_000 + (escrow_amt - 1_000), 1);

    test_utils::destroy(payout);
    sm3::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 20 — ported v2 regression: abort happy path refunds 1:1.
#[test]
fun abort_segment_ride_v3_past_deadline_refunds_one_to_one() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;
    let escrow = mint_sui(escrow_amt, &mut sc);
    let mut ride = sm3::open_segment_ride_v3<SUI>(
        &mut market, &mut vault, &bots,
        sm3::barrier_upper(), stake, escrow, &clk, sc.ctx(),
    );

    clk.increment_for_testing(ABORT_DEADLINE_MS + 1);
    let payout = sm3::abort_segment_ride_v3<SUI>(
        &mut ride, &mut market, &mut vault, &clk, sc.ctx(),
    );
    assert!(sm3::settlement_kind(&ride) == sm3::settlement_aborted_refund(), 0);
    assert!(payout.value() == escrow_amt, 1);

    test_utils::destroy(payout);
    sm3::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 21 — deadband_zero_yields_barrier_passthrough.
#[test]
fun deadband_zero_yields_barrier_passthrough() {
    assert!(sm3::test_add_deadband_up(1_000_000, 0) == 1_000_000, 0);
    assert!(sm3::test_sub_deadband_down(1_000_000, 0) == 1_000_000, 1);
    assert!(sm3::test_add_deadband_up(1_000_000, 100) == 1_010_000, 2);
    assert!(sm3::test_sub_deadband_down(1_000_000, 100) == 990_000, 3);
}

/// Test 22 — record_walrus_archive followed by prune within same flow:
/// the archiver bot's two-call sequence (doc 24 §4) lands cleanly.
#[test]
fun archiver_bot_two_call_sequence_lands_cleanly() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    // Seed round 0.
    let st = sp::new_state(HOME_PRICE, VOL_REGIME_INIT, HOME_PRICE);
    let mut k = 0;
    while (k < ROUND_DURATION) {
        sm3::test_only_insert_segment_at<SUI>(
            &mut market, k, vector::empty<u8>(), st,
            HOME_PRICE, HOME_PRICE, 1_000 + k,
        );
        k = k + 1;
    };
    sm3::test_only_set_cached_round_index<SUI>(&mut market, 10);

    // Archiver bot's call 1: record archive entry.
    sc.next_tx(ARCHIVER);
    sm3::record_walrus_archive<SUI>(&mut market, 0, mk_blob_id(77), sc.ctx());
    assert!(sm3::has_walrus_archive<SUI>(&market, 0), 0);

    // Archiver bot's call 2: prune (same archiver pays gas, takes rebate).
    sm3::prune_settled_segments<SUI>(&mut market, 0, sc.ctx());
    assert!(sm3::is_round_pruned<SUI>(&market, 0), 1);
    assert!(!sm3::has_segment<SUI>(&market, 0), 2);
    assert!(!sm3::has_segment<SUI>(&market, ROUND_DURATION - 1), 3);

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 23 — prune is permissionless: a third party (PRUNER) can prune
/// a round archived by ARCHIVER. The rebate flows to whoever's gas
/// coin paid the prune tx.
#[test]
fun prune_is_permissionless_after_archive() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    let st = sp::new_state(HOME_PRICE, VOL_REGIME_INIT, HOME_PRICE);
    sm3::test_only_insert_segment_at<SUI>(
        &mut market, 0, vector::empty<u8>(), st,
        HOME_PRICE, HOME_PRICE, 1_000,
    );
    sm3::test_only_set_cached_round_index<SUI>(&mut market, 10);

    sc.next_tx(ARCHIVER);
    sm3::record_walrus_archive<SUI>(&mut market, 0, mk_blob_id(88), sc.ctx());

    sc.next_tx(PRUNER);
    sm3::prune_settled_segments<SUI>(&mut market, 0, sc.ctx());

    assert!(sm3::is_round_pruned<SUI>(&market, 0), 0);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 24 — close after touch on a round in which the rider opened
/// updates the round's unsettled counter (not the current round).
/// Reproduces the "ride spans round boundary" scenario.
#[test]
fun close_decrements_ride_bound_round_not_current_round() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    let stake = 1_000u64;
    let escrow = mint_sui(stake * ROUND_DURATION, &mut sc);
    let mut ride = sm3::open_segment_ride_v3<SUI>(
        &mut market, &mut vault, &bots,
        sm3::barrier_upper(), stake, escrow, &clk, sc.ctx(),
    );

    assert!(sm3::unsettled_rides_for_round<SUI>(&market, 0) == 1, 0);
    assert!(sm3::round_index(&ride) == 0, 1);

    // Force a touch in round 0.
    let upper = sm3::cached_upper_barrier<SUI>(&market);
    let margin = upper * DEADBAND_BPS / 10_000;
    let st = sp::state_with(upper + margin, false, 0, VOL_REGIME_INIT, HOME_PRICE);
    sm3::test_only_record_segment<SUI>(
        &mut market, x"aa", st, HOME_PRICE, upper + margin + 1, 1_500,
    );

    // Roll into round 1 (without the test forcing it via bump).
    sm3::test_only_bump_segment_index<SUI>(&mut market, ROUND_DURATION);
    sm3::test_only_force_round_current<SUI>(&mut market);
    assert!(sm3::cached_round_index<SUI>(&market) == 1, 2);

    clk.increment_for_testing(1_000);
    let payout = sm3::close_segment_ride_v3<SUI>(
        &mut ride, &mut market, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );

    // The TOUCH happened in round 0, so close routes through TOUCH_WIN
    // and the ride's bound round (0) has its counter decremented, not
    // the current round (1). Round 1 was never touched.
    assert!(sm3::settlement_kind(&ride) == sm3::settlement_touch_win(), 3);
    assert!(sm3::unsettled_rides_for_round<SUI>(&market, 0) == 0, 4);
    assert!(sm3::unsettled_rides_for_round<SUI>(&market, 1) == 0, 5);

    test_utils::destroy(payout);
    sm3::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 25 — concurrent rides across two rounds track unsettled
/// counters independently. Two riders open in round 0, one opens in
/// round 1 (after a forced roll); each round's counter reflects only
/// the rides bound to it.
#[test]
fun concurrent_rides_across_rounds_track_independently() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    let stake = 1_000u64;

    // Round 0 — two rides on different barriers.
    let mut r1 = sm3::open_segment_ride_v3<SUI>(
        &mut market, &mut vault, &bots,
        sm3::barrier_upper(), stake, mint_sui(stake * ROUND_DURATION, &mut sc),
        &clk, sc.ctx(),
    );
    sc.next_tx(BOB);
    let mut r2 = sm3::open_segment_ride_v3<SUI>(
        &mut market, &mut vault, &bots,
        sm3::barrier_lower(), stake, mint_sui(stake * ROUND_DURATION, &mut sc),
        &clk, sc.ctx(),
    );
    assert!(sm3::unsettled_rides_for_round<SUI>(&market, 0) == 2, 0);

    // Roll into round 1, open a ride there.
    sm3::test_only_bump_segment_index<SUI>(&mut market, ROUND_DURATION);
    sm3::test_only_force_round_current<SUI>(&mut market);

    sc.next_tx(ALICE);
    let mut r3 = sm3::open_segment_ride_v3<SUI>(
        &mut market, &mut vault, &bots,
        sm3::barrier_upper(), stake, mint_sui(stake * ROUND_DURATION, &mut sc),
        &clk, sc.ctx(),
    );
    assert!(sm3::unsettled_rides_for_round<SUI>(&market, 0) == 2, 1);
    assert!(sm3::unsettled_rides_for_round<SUI>(&market, 1) == 1, 2);

    // Mark market aborted so closes route through ABORTED_REFUND for all
    // three rides (the simplest deterministic settlement that doesn't
    // require synthetic touches per round).
    let mid = object::id(&market);
    mv::test_mark_market_aborted<SUI>(&mut vault, mid);
    clk.increment_for_testing(1_000);

    sc.next_tx(ALICE);
    let p1 = sm3::close_segment_ride_v3<SUI>(
        &mut r1, &mut market, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );
    // Round 0 counter drops to 1 after first close, round 1 unchanged.
    assert!(sm3::unsettled_rides_for_round<SUI>(&market, 0) == 1, 3);
    assert!(sm3::unsettled_rides_for_round<SUI>(&market, 1) == 1, 4);

    sc.next_tx(BOB);
    let p2 = sm3::close_segment_ride_v3<SUI>(
        &mut r2, &mut market, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );
    assert!(sm3::unsettled_rides_for_round<SUI>(&market, 0) == 0, 5);
    assert!(sm3::unsettled_rides_for_round<SUI>(&market, 1) == 1, 6);

    sc.next_tx(ALICE);
    let p3 = sm3::close_segment_ride_v3<SUI>(
        &mut r3, &mut market, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );
    assert!(sm3::unsettled_rides_for_round<SUI>(&market, 0) == 0, 7);
    assert!(sm3::unsettled_rides_for_round<SUI>(&market, 1) == 0, 8);

    test_utils::destroy(p1);
    test_utils::destroy(p2);
    test_utils::destroy(p3);
    sm3::test_only_destroy_ride(r1);
    sm3::test_only_destroy_ride(r2);
    sm3::test_only_destroy_ride(r3);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}
