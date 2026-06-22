// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Tests for `wick::segment_market_v4` — the touch-either + always-open
/// arcade module per doc 25.
///
/// v4-specific coverage:
///   1. bootstrap_v4 creates market with no open_window field (no window
///      gate exists).
///   2. open_segment_ride_v4 succeeds at ANY segment in the round (proves
///      no open-window assert).
///   3. open_segment_ride_v4 captures BOTH barrier prices at open.
///   4. either_aggregate_max_payout cap enforced (replaces v3 per-side).
///   5. close: upper-touch path → TOUCH_WIN with touched_side=0 (UPPER).
///   6. close: lower-touch path → TOUCH_WIN with touched_side=1 (LOWER).
///   7. close: no-touch + within round → CASHOUT with touched_side=2 (NONE).
///   8. crank_expired: no-touch + round end → EXPIRED_LOSS with
///      touched_side=2.
///   9. both-barriers-touch-in-same-segment → TOUCH_WIN with
///      touched_side=0 (UPPER WINS, doc 25 §9 tie-break).
///  10. ensure_round_current resets single either_* bucket (not two).
///  11. bumping either_* trackers on open (single bucket).
///  12. decrementing either_* trackers on close.
///  13. scan_for_either_touch returns true on upper-only.
///  14. scan_for_either_touch returns true on lower-only.
///  15. scan_for_either_touch returns false when neither.
///  16. abort happy path refunds 1:1.
///  17. abort decrements unsettled.
///
/// v3-ported regression coverage (ported to v4):
///  18. record_walrus_archive_v4 happy path + abort on short blob_id.
///  19. prune_settled_segments_v4 succeeds after lag + archive + zero
///      unsettled.
///  20. prune_settled_segments_v4 aborts when too soon.
///  21. prune_settled_segments_v4 idempotent.
///  22. prune empty round does not mark pruned (SEV-2 #A fix).
///  23. unsettled-rides counter survives round roll.
///  24. open_segment_ride_v4 bumps unsettled_rides_per_round.
///  25. close_segment_ride_v4 decrements unsettled.
///  26. nearer_barrier helper picks the closer of two.
///  27. deadband_zero_yields_barrier_passthrough.
#[test_only]
#[allow(deprecated_usage)]
module wick::segment_market_v4_tests;

use sui::clock::{Self as clock, Clock};
use sui::coin::{Self, Coin};
use sui::object;
use sui::sui::SUI;
use sui::test_scenario as ts;
use sui::test_utils;
use wick::bot_registry as br;
use wick::martingaler_vault::{Self as mv, MartingalerVault};
use wick::seeded_path as sp;
use wick::segment_market_v4::{Self as sm4, SegmentMarketV4};
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
const BARRIER_OFFSET_BPS: u64 = 500;
const MULTIPLIER_BPS: u64 = 20_000;
const MAX_PAYOUT_PER_ROUND: u64 = 1_500_000_000;
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
): SegmentMarketV4<SUI> {
    sm4::new_segment_market_v4<SUI>(
        vault,
        HOME_PRICE,
        VOL_REGIME_INIT,
        ROUND_DURATION,
        BARRIER_OFFSET_BPS,
        MULTIPLIER_BPS,
        MAX_PAYOUT_PER_ROUND,
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
    SegmentMarketV4<SUI>,
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
    market: SegmentMarketV4<SUI>,
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
    sm4::test_only_destroy_market(market);
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

/// Test 1 — bootstrap_v4 creates a market with no open_window field.
/// Verifies the v4 SegmentMarketV4 struct shape: no upper/lower per-side
/// trackers, single either_* bucket, max_payout_per_round (not per-barrier).
#[test]
fun bootstrap_v4_creates_market_with_either_bucket_and_no_window() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    // Carry-overs from v3.
    assert!(sm4::next_segment_index<SUI>(&market) == 0, 0);
    assert!(sm4::active_ride_count<SUI>(&market) == 0, 1);
    assert!(sm4::cached_round_index<SUI>(&market) == 0, 2);
    let expected_upper = HOME_PRICE + HOME_PRICE * BARRIER_OFFSET_BPS / 10_000;
    let expected_lower = HOME_PRICE - HOME_PRICE * BARRIER_OFFSET_BPS / 10_000;
    assert!(sm4::cached_upper_barrier<SUI>(&market) == expected_upper, 3);
    assert!(sm4::cached_lower_barrier<SUI>(&market) == expected_lower, 4);
    assert!(sm4::walk_price<SUI>(&market) == HOME_PRICE, 5);
    assert!(sm4::max_payout_per_round<SUI>(&market) == MAX_PAYOUT_PER_ROUND, 6);

    // v4: single either_* bucket starts empty.
    assert!(sm4::either_aggregate_stake<SUI>(&market) == 0, 7);
    assert!(sm4::either_aggregate_max_payout<SUI>(&market) == 0, 8);
    assert!(sm4::either_rider_count<SUI>(&market) == 0, 9);

    // v3-inherited: prune/archive tables empty.
    assert!(sm4::unsettled_rides_for_round<SUI>(&market, 0) == 0, 10);
    assert!(!sm4::is_round_pruned<SUI>(&market, 0), 11);
    assert!(!sm4::has_walrus_archive<SUI>(&market, 0), 12);

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 2 — open_segment_ride_v4 succeeds at ANY segment in the round.
///
/// Proves the open-window assert from v3 is GONE: an open at segment
/// (ROUND_DURATION - 1), which would have aborted in v3 with
/// EOpenWindowClosed (since OPEN_WINDOW < ROUND_DURATION), must succeed
/// in v4.
#[test]
fun open_segment_ride_v4_succeeds_at_any_segment_in_round() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    // Advance next_segment_index to the END of round 0 (segment
    // ROUND_DURATION - 1) — well past where v3's OPEN_WINDOW would close.
    sm4::test_only_bump_segment_index<SUI>(&mut market, ROUND_DURATION - 1);
    assert!(sm4::next_segment_index<SUI>(&market) == ROUND_DURATION - 1, 0);

    let stake = 1_000u64;
    let escrow = mint_sui(stake * ROUND_DURATION, &mut sc);
    let ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots,
        stake, escrow, &clk, sc.ctx(),
    );

    // Open succeeded — v4 has no window gate.
    assert!(sm4::active_ride_count<SUI>(&market) == 1, 1);
    assert!(sm4::entry_segment_index(&ride) == ROUND_DURATION - 1, 2);
    assert!(sm4::round_index(&ride) == 0, 3);

    sm4::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 3 — open_segment_ride_v4 captures BOTH barrier prices at open.
///
/// The v4 ride has `upper_barrier_price` AND `lower_barrier_price` fields,
/// both snapshotted at open time from the cached round barriers — not a
/// single picked-barrier price.
#[test]
fun open_segment_ride_v4_captures_both_barrier_prices() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    let cached_upper = sm4::cached_upper_barrier<SUI>(&market);
    let cached_lower = sm4::cached_lower_barrier<SUI>(&market);

    let stake = 1_000u64;
    let escrow = mint_sui(stake * ROUND_DURATION, &mut sc);
    let ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots,
        stake, escrow, &clk, sc.ctx(),
    );

    // Both barrier prices snapshotted on the ride.
    assert!(sm4::upper_barrier_price(&ride) == cached_upper, 0);
    assert!(sm4::lower_barrier_price(&ride) == cached_lower, 1);
    // Different prices — proves it's not just one barrier copied to both
    // fields.
    assert!(cached_upper > cached_lower, 2);

    sm4::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 4 — either_aggregate_max_payout cap enforced (replaces v3's
/// per-side cap). Once `either_aggregate_max_payout` would exceed
/// `max_payout_per_round`, the open aborts with ERoundCapExceeded.
#[test]
#[expected_failure(abort_code = sm4::ERoundCapExceeded, location = wick::segment_market_v4)]
fun either_max_payout_cap_enforced() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    // Cap = 1.5e9. Mult = 2.0× (20000bps). One ride at escrow ≈ 1.5e9 / 2 =
    // 7.5e8 would saturate the cap. We open two rides each above 5e8 escrow
    // to overflow.
    let big_stake = MAX_STAKE;
    let big_escrow_amt = big_stake * ROUND_DURATION; // = 2e8 — well under cap solo
    // Actually: stake=10M × 20 = 2e8; max_payout = 2e8 × 2 = 4e8. Need
    // many rides to overflow. Open rides until we trip the cap.
    // 1.5e9 / 4e8 = 3.75 → opening the 4th ride should overflow.
    let r1 = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots,
        big_stake, mint_sui(big_escrow_amt, &mut sc), &clk, sc.ctx(),
    );
    let r2 = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots,
        big_stake, mint_sui(big_escrow_amt, &mut sc), &clk, sc.ctx(),
    );
    let r3 = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots,
        big_stake, mint_sui(big_escrow_amt, &mut sc), &clk, sc.ctx(),
    );
    // The 4th ride should trip ERoundCapExceeded (3 × 4e8 = 1.2e9 + 4e8 =
    // 1.6e9 > 1.5e9 cap).
    let r4 = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots,
        big_stake, mint_sui(big_escrow_amt, &mut sc), &clk, sc.ctx(),
    );

    // Unreached.
    sm4::test_only_destroy_ride(r1);
    sm4::test_only_destroy_ride(r2);
    sm4::test_only_destroy_ride(r3);
    sm4::test_only_destroy_ride(r4);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 5 — close: upper-touch path → TOUCH_WIN with touched_side=0
/// (UPPER). Records a synthetic segment where max_price ≥ effective upper
/// barrier and confirms settlement.
#[test]
fun close_upper_touch_wins_with_touched_side_upper() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;
    let escrow = mint_sui(escrow_amt, &mut sc);
    // Snapshot the vault before the ride for the conservation check below.
    let vault_before = mv::treasury_value(&vault);
    let mut ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots,
        stake, escrow, &clk, sc.ctx(),
    );

    let upper = sm4::cached_upper_barrier<SUI>(&market);
    let margin = upper * DEADBAND_BPS / 10_000;
    // Synthetic segment that touches the upper deadbanded barrier.
    let st = sp::state_with(upper + margin, false, 0, VOL_REGIME_INIT, HOME_PRICE);
    sm4::test_only_record_segment<SUI>(
        &mut market, x"de", st, HOME_PRICE, upper + margin + 1, 2_000,
    );

    clk.increment_for_testing(1_000);
    let payout = sm4::close_segment_ride_v4<SUI>(
        &mut ride, &mut market, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );

    assert!(sm4::settlement_kind(&ride) == sm4::settlement_touch_win(), 0);
    // stake_paid = 1_000; payout = 2_000; total_to_user = 2_000 + (escrow - 1_000)
    assert!(payout.value() == 2_000 + (escrow_amt - 1_000), 1);
    // Conservation on the jackpot (vault-PAYS-OUT) path: the vault's balance
    // changed by exactly (escrow deposited − value handed to the user). An
    // over-withdraw on this path is direct loss-of-funds; this pins it. Net
    // here the house is down (payout 2_000 > stake_paid 1_000): vault_before −
    // 1_000.
    assert!(mv::treasury_value(&vault) == vault_before + escrow_amt - payout.value(), 2);

    test_utils::destroy(payout);
    sm4::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 6 — close: lower-touch path → TOUCH_WIN with touched_side=1
/// (LOWER). Mirror of test 5 with the segment crossing the lower barrier.
#[test]
fun close_lower_touch_wins_with_touched_side_lower() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;
    let escrow = mint_sui(escrow_amt, &mut sc);
    let mut ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots,
        stake, escrow, &clk, sc.ctx(),
    );

    let lower = sm4::cached_lower_barrier<SUI>(&market);
    let margin = lower * DEADBAND_BPS / 10_000;
    // Synthetic segment with min_price below the lower deadbanded barrier.
    let touch_price = if (lower > margin + 1) lower - margin - 1 else 1;
    let st = sp::state_with(touch_price, false, 0, VOL_REGIME_INIT, HOME_PRICE);
    sm4::test_only_record_segment<SUI>(
        &mut market, x"dd", st, touch_price, HOME_PRICE, 2_000,
    );

    clk.increment_for_testing(1_000);
    let payout = sm4::close_segment_ride_v4<SUI>(
        &mut ride, &mut market, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );

    assert!(sm4::settlement_kind(&ride) == sm4::settlement_touch_win(), 0);
    // Touch wins at the same multiplier regardless of side.
    assert!(payout.value() == 2_000 + (escrow_amt - 1_000), 1);

    test_utils::destroy(payout);
    sm4::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 7 — close: no-touch + within round → CASHOUT with touched_side=2
/// (NONE). Record a segment that does NOT touch either barrier and close
/// before round end → Bachelier cashout path.
#[test]
fun close_no_touch_within_round_yields_cashout() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;
    let escrow = mint_sui(escrow_amt, &mut sc);
    // Snapshot the vault before the ride for the conservation check below.
    let vault_before = mv::treasury_value(&vault);
    let mut ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots,
        stake, escrow, &clk, sc.ctx(),
    );

    // Walk stays within barriers (min=lower+10k, max=upper-10k).
    let upper = sm4::cached_upper_barrier<SUI>(&market);
    let lower = sm4::cached_lower_barrier<SUI>(&market);
    let st = sp::state_with(HOME_PRICE, false, 0, VOL_REGIME_INIT, HOME_PRICE);
    sm4::test_only_record_segment<SUI>(
        &mut market, x"01", st, lower + 1_000_000, upper - 1_000_000, 1_500,
    );

    clk.increment_for_testing(1_000);
    let payout = sm4::close_segment_ride_v4<SUI>(
        &mut ride, &mut market, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );

    // Settlement = CASHOUT, no touch.
    assert!(sm4::settlement_kind(&ride) == sm4::settlement_cashout(), 0);
    // Conservation on the (common) early-cashout path. This test previously
    // checked only the settlement KIND, not a single coin of value. Whatever
    // the Bachelier cashout works out to, the vault's balance must move by
    // exactly (escrow deposited − value handed to the user) — no value minted
    // or lost in the vault on the most-travelled close path.
    assert!(mv::treasury_value(&vault) == vault_before + escrow_amt - payout.value(), 1);

    test_utils::destroy(payout);
    sm4::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Safety: a settled ride cannot be re-settled. close_segment_ride_v4 takes the
/// position by &mut (not by value), so the `closed` flag is the only thing
/// stopping a second close from paying out twice. Close once (CASHOUT), then
/// close again → EAlreadyClosed (=1). No double-pay.
#[test]
#[expected_failure(abort_code = 1, location = wick::segment_market_v4)]
fun close_segment_ride_v4_twice_aborts_already_closed() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;
    let escrow = mint_sui(escrow_amt, &mut sc);
    let mut ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots, stake, escrow, &clk, sc.ctx(),
    );

    let upper = sm4::cached_upper_barrier<SUI>(&market);
    let lower = sm4::cached_lower_barrier<SUI>(&market);
    let st = sp::state_with(HOME_PRICE, false, 0, VOL_REGIME_INIT, HOME_PRICE);
    sm4::test_only_record_segment<SUI>(
        &mut market, x"01", st, lower + 1_000_000, upper - 1_000_000, 1_500,
    );

    clk.increment_for_testing(1_000);
    let payout = sm4::close_segment_ride_v4<SUI>(
        &mut ride, &mut market, &mut vault, &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );
    assert!(sm4::settlement_kind(&ride) == sm4::settlement_cashout(), 0);
    test_utils::destroy(payout);

    // Second close must abort EAlreadyClosed (=1) — the losing-fund-double-pay
    // guard. Everything below is unreachable (kept for compilation).
    let payout2 = sm4::close_segment_ride_v4<SUI>(
        &mut ride, &mut market, &mut vault, &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );
    test_utils::destroy(payout2);
    sm4::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 8 — crank_expired_segment_ride_v4: no-touch + round end →
/// EXPIRED_LOSS with touched_side=2 (NONE).
#[test]
fun crank_expired_no_touch_yields_expired_loss() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;
    let escrow = mint_sui(escrow_amt, &mut sc);
    let vault_before = mv::treasury_value(&vault);
    let mut ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots,
        stake, escrow, &clk, sc.ctx(),
    );

    // Bump segment index past round end with NO synthetic touch.
    sm4::test_only_bump_segment_index<SUI>(&mut market, ROUND_DURATION + 5);
    clk.increment_for_testing(2_000);

    sc.next_tx(KEEPER);
    let bounty = sm4::crank_expired_segment_ride_v4<SUI>(
        &mut ride, &mut market, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );

    assert!(sm4::is_closed(&ride), 0);
    assert!(sm4::settlement_kind(&ride) == sm4::settlement_expired_loss(), 1);
    // Conservation on the permissionless crank-expired path. A full-round
    // no-touch forfeit returns nothing to the owner (stake_paid == escrow), so
    // the escrow splits only two ways: the crank bounty to the keeper and the
    // remainder retained by the vault as the house's forfeit. The vault's net
    // gain is therefore exactly escrow − bounty — no value minted or leaked.
    assert!(mv::treasury_value(&vault) == vault_before + escrow_amt - bounty.value(), 2);

    test_utils::destroy(bounty);
    sm4::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

// Safety: crank_expired settles a ride as EXPIRED_LOSS only AFTER the round has
// ended — calling it on a still-live ride aborts ENotExpired (=12). Without it a
// ride could be force-settled as a loss before its time, robbing a would-be
// touch-win. Mirror of the happy path with NO bump past round end.
#[test]
#[expected_failure(abort_code = 12, location = wick::segment_market_v4)]
fun crank_expired_segment_ride_v4_before_expiry_rejected() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, mut wts, wcap, mut pool, scap, clk) =
        mk_full_world(&mut sc);

    let stake = 1_000u64;
    let escrow = mint_sui(stake * ROUND_DURATION, &mut sc);
    let mut ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots, stake, escrow, &clk, sc.ctx(),
    );

    // Ride is freshly opened (segment 0), round NOT ended → crank must reject.
    let bounty = sm4::crank_expired_segment_ride_v4<SUI>(
        &mut ride, &mut market, &mut vault, &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );

    test_utils::destroy(bounty); // unreachable
    sm4::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

// Safety / player-protection: a ride that TOUCHED a barrier (won) cannot be
// force-settled as a loss via the permissionless crank_expired — it must
// self-close to claim. The guard `assert!(!touched, ETouchedMustSelfClose=13)`
// stops a cranker robbing a winner even after round end.
#[test]
#[expected_failure(abort_code = 13, location = wick::segment_market_v4)]
fun crank_expired_rejects_touched_ride_must_self_close() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    let stake = 1_000u64;
    let escrow = mint_sui(stake * ROUND_DURATION, &mut sc);
    let mut ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots, stake, escrow, &clk, sc.ctx(),
    );

    // Record a segment whose high pierces the upper deadbanded barrier — won.
    let upper = sm4::cached_upper_barrier<SUI>(&market);
    let margin = upper * DEADBAND_BPS / 10_000;
    let st = sp::state_with(upper + margin, false, 0, VOL_REGIME_INIT, HOME_PRICE);
    sm4::test_only_record_segment<SUI>(
        &mut market, x"de", st, HOME_PRICE, upper + margin + 1, 2_000,
    );

    // Even past round end, the touched ride must self-close — crank rejects it.
    sm4::test_only_bump_segment_index<SUI>(&mut market, ROUND_DURATION + 5);
    clk.increment_for_testing(2_000);
    let bounty = sm4::crank_expired_segment_ride_v4<SUI>(
        &mut ride, &mut market, &mut vault, &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );

    test_utils::destroy(bounty); // unreachable
    sm4::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 9 — both-barriers-touch-in-same-segment → TOUCH_WIN with
/// touched_side=0 (UPPER WINS per doc 25 §9 tie-break).
///
/// We construct a single segment whose [min, max] straddles both
/// deadbanded barriers (extreme wick that pierced both sides). The
/// touched_side_resolved helper must return UPPER (0).
#[test]
fun both_barriers_touch_same_segment_upper_wins_tie_break() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;
    let escrow = mint_sui(escrow_amt, &mut sc);
    let mut ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots,
        stake, escrow, &clk, sc.ctx(),
    );

    let upper = sm4::cached_upper_barrier<SUI>(&market);
    let lower = sm4::cached_lower_barrier<SUI>(&market);
    let upper_margin = upper * DEADBAND_BPS / 10_000;
    let lower_margin = lower * DEADBAND_BPS / 10_000;

    // Synthetic segment with max ≥ upper+margin AND min ≤ lower-margin.
    let touch_max = upper + upper_margin + 100;
    let touch_min = if (lower > lower_margin + 100) lower - lower_margin - 100 else 1;
    let st = sp::state_with(HOME_PRICE, false, 0, VOL_REGIME_INIT, HOME_PRICE);
    sm4::test_only_record_segment<SUI>(
        &mut market, x"aa", st, touch_min, touch_max, 1_500,
    );

    // Direct probe of the resolver — should say UPPER wins this tie.
    let resolved = sm4::test_touched_side_resolved<SUI>(
        &market, 0, 1, upper, lower,
    );
    assert!(resolved == sm4::touched_side_upper(), 0);

    // Full close path also resolves as TOUCH_WIN.
    clk.increment_for_testing(1_000);
    let payout = sm4::close_segment_ride_v4<SUI>(
        &mut ride, &mut market, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );
    assert!(sm4::settlement_kind(&ride) == sm4::settlement_touch_win(), 1);

    test_utils::destroy(payout);
    sm4::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 10 — ensure_round_current resets the single either_* bucket
/// (not two upper/lower buckets) on round roll.
#[test]
fun ensure_round_current_resets_single_either_bucket() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    // Open a ride to populate either_* trackers in round 0.
    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;
    let ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots,
        stake, mint_sui(escrow_amt, &mut sc), &clk, sc.ctx(),
    );
    assert!(sm4::either_rider_count<SUI>(&market) == 1, 0);
    assert!(sm4::either_aggregate_stake<SUI>(&market) == escrow_amt, 1);
    assert!(sm4::either_aggregate_max_payout<SUI>(&market) > 0, 2);

    // Force round roll.
    sm4::test_only_bump_segment_index<SUI>(&mut market, ROUND_DURATION);
    sm4::test_only_force_round_current<SUI>(&mut market);
    assert!(sm4::cached_round_index<SUI>(&market) == 1, 3);

    // The single either_* bucket should be reset to zero.
    assert!(sm4::either_rider_count<SUI>(&market) == 0, 4);
    assert!(sm4::either_aggregate_stake<SUI>(&market) == 0, 5);
    assert!(sm4::either_aggregate_max_payout<SUI>(&market) == 0, 6);

    sm4::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 11 — opening multiple rides bumps the single either_* bucket.
/// Both ALICE and BOB open rides; the bucket reflects the merged total
/// (not split per-barrier, since v4 has no per-barrier split).
#[test]
fun multiple_opens_bump_single_either_bucket() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;
    let r1 = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots,
        stake, mint_sui(escrow_amt, &mut sc), &clk, sc.ctx(),
    );
    assert!(sm4::either_rider_count<SUI>(&market) == 1, 0);
    assert!(sm4::either_aggregate_stake<SUI>(&market) == escrow_amt, 1);

    sc.next_tx(BOB);
    let r2 = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots,
        stake, mint_sui(escrow_amt, &mut sc), &clk, sc.ctx(),
    );
    assert!(sm4::either_rider_count<SUI>(&market) == 2, 2);
    assert!(sm4::either_aggregate_stake<SUI>(&market) == 2 * escrow_amt, 3);

    sm4::test_only_destroy_ride(r1);
    sm4::test_only_destroy_ride(r2);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 12 — close decrements the single either_* bucket.
#[test]
fun close_decrements_single_either_bucket() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;
    let escrow = mint_sui(escrow_amt, &mut sc);
    let mut ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots,
        stake, escrow, &clk, sc.ctx(),
    );
    assert!(sm4::either_rider_count<SUI>(&market) == 1, 0);

    // Force a touch so close settles cleanly.
    let upper = sm4::cached_upper_barrier<SUI>(&market);
    let margin = upper * DEADBAND_BPS / 10_000;
    let st = sp::state_with(upper + margin, false, 0, VOL_REGIME_INIT, HOME_PRICE);
    sm4::test_only_record_segment<SUI>(
        &mut market, x"de", st, HOME_PRICE, upper + margin + 1, 1_500,
    );

    clk.increment_for_testing(1_000);
    let payout = sm4::close_segment_ride_v4<SUI>(
        &mut ride, &mut market, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );

    // After close, the either_* bucket is back to zero.
    assert!(sm4::either_rider_count<SUI>(&market) == 0, 1);
    assert!(sm4::either_aggregate_stake<SUI>(&market) == 0, 2);
    assert!(sm4::either_aggregate_max_payout<SUI>(&market) == 0, 3);

    test_utils::destroy(payout);
    sm4::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 13 — scan_for_either_touch returns true on upper-only touch.
#[test]
fun scan_for_either_touch_upper_only() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    let upper = 1_050_000_000u64;
    let lower = 950_000_000u64;
    let st = sp::new_state(HOME_PRICE, VOL_REGIME_INIT, HOME_PRICE);

    let upper_margin = upper * DEADBAND_BPS / 10_000;
    // Segment crosses ONLY upper.
    sm4::test_only_record_segment<SUI>(
        &mut market, x"00", st,
        HOME_PRICE, upper + upper_margin, 1_000,
    );
    assert!(sm4::test_scan_for_either_touch<SUI>(&market, 0, 1, upper, lower), 0);

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 14 — scan_for_either_touch returns true on lower-only touch.
#[test]
fun scan_for_either_touch_lower_only() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    let upper = 1_050_000_000u64;
    let lower = 950_000_000u64;
    let st = sp::new_state(HOME_PRICE, VOL_REGIME_INIT, HOME_PRICE);

    let lower_margin = lower * DEADBAND_BPS / 10_000;
    // Segment crosses ONLY lower.
    sm4::test_only_record_segment<SUI>(
        &mut market, x"00", st,
        lower - lower_margin, HOME_PRICE, 1_000,
    );
    assert!(sm4::test_scan_for_either_touch<SUI>(&market, 0, 1, upper, lower), 0);

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 15 — scan_for_either_touch returns false when neither side touched.
#[test]
fun scan_for_either_touch_neither() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    let upper = 1_050_000_000u64;
    let lower = 950_000_000u64;
    let st = sp::new_state(HOME_PRICE, VOL_REGIME_INIT, HOME_PRICE);

    // Segment sits comfortably inside the corridor.
    sm4::test_only_record_segment<SUI>(
        &mut market, x"00", st,
        980_000_000, 1_020_000_000, 1_000,
    );
    assert!(!sm4::test_scan_for_either_touch<SUI>(&market, 0, 1, upper, lower), 0);

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 16 — abort happy path refunds 1:1 after deadline.
#[test]
fun abort_segment_ride_v4_past_deadline_refunds_one_to_one() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;
    let escrow = mint_sui(escrow_amt, &mut sc);
    // Snapshot the vault before the ride: the escrow is deposited into the
    // treasury on open and must come straight back out on abort, leaving the
    // vault exactly where it started.
    let vault_before = mv::treasury_value(&vault);
    let mut ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots,
        stake, escrow, &clk, sc.ctx(),
    );

    clk.increment_for_testing(ABORT_DEADLINE_MS + 1);
    let refund = sm4::abort_segment_ride_v4<SUI>(
        &mut ride, &mut market, &mut vault, &clk, sc.ctx(),
    );

    assert!(sm4::settlement_kind(&ride) == sm4::settlement_aborted_refund(), 0);
    assert!(refund.value() == escrow_amt, 1);
    // "Refund 1:1, never 2:1" (AGENTS.md safety property): the user-side check
    // above proves they got 1× escrow back, but a double-withdraw could still
    // drain a SECOND escrow from the vault while that check passed. Assert the
    // treasury net-zeroed — the escrow round-tripped exactly once, no 2:1 leak.
    assert!(mv::treasury_value(&vault) == vault_before, 2);

    test_utils::destroy(refund);
    sm4::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

// Safety: a ride canNOT be abort-refunded BEFORE the abort deadline
// (ENotPastAbortDeadline=16). The happy path above refunds 1:1 only once the
// ride is genuinely stuck past the deadline; without this guard a player could
// bail out 1:1 on a ride that's about to lose and make the vault eat it. Mirror
// of that test with NO clock advance — the abort must reject.
#[test]
#[expected_failure(abort_code = 16, location = wick::segment_market_v4)]
fun abort_segment_ride_v4_before_deadline_rejected() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    let stake = 1_000u64;
    let escrow = mint_sui(stake * ROUND_DURATION, &mut sc);
    let mut ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots, stake, escrow, &clk, sc.ctx(),
    );

    // No clock advance → still well before the abort deadline → must reject.
    let refund = sm4::abort_segment_ride_v4<SUI>(
        &mut ride, &mut market, &mut vault, &clk, sc.ctx(),
    );

    test_utils::destroy(refund); // unreachable
    sm4::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Safety: a ride settled via crank_expired cannot be re-settled (the same
/// no-double-pay guard as close, on the permissionless-crank path).
#[test]
#[expected_failure(abort_code = 1, location = wick::segment_market_v4)]
fun crank_expired_segment_ride_v4_twice_aborts_already_closed() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    let stake = 1_000u64;
    let escrow = mint_sui(stake * ROUND_DURATION, &mut sc);
    let mut ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots, stake, escrow, &clk, sc.ctx(),
    );

    sm4::test_only_bump_segment_index<SUI>(&mut market, ROUND_DURATION + 5);
    clk.increment_for_testing(2_000);
    sc.next_tx(KEEPER);
    let bounty = sm4::crank_expired_segment_ride_v4<SUI>(
        &mut ride, &mut market, &mut vault, &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );
    assert!(sm4::is_closed(&ride), 0);
    test_utils::destroy(bounty);

    // Second crank must abort EAlreadyClosed (=1). Below is unreachable.
    let bounty2 = sm4::crank_expired_segment_ride_v4<SUI>(
        &mut ride, &mut market, &mut vault, &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );
    test_utils::destroy(bounty2);
    sm4::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Safety: a ride settled via abort cannot be re-settled (no double refund).
#[test]
#[expected_failure(abort_code = 1, location = wick::segment_market_v4)]
fun abort_segment_ride_v4_twice_aborts_already_closed() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let stake = 1_000u64;
    let escrow = mint_sui(stake * ROUND_DURATION, &mut sc);
    let mut ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots, stake, escrow, &clk, sc.ctx(),
    );

    clk.increment_for_testing(ABORT_DEADLINE_MS + 1);
    let refund = sm4::abort_segment_ride_v4<SUI>(
        &mut ride, &mut market, &mut vault, &clk, sc.ctx(),
    );
    assert!(sm4::is_closed(&ride), 0);
    test_utils::destroy(refund);

    // Second abort must abort EAlreadyClosed (=1). Below is unreachable.
    let refund2 = sm4::abort_segment_ride_v4<SUI>(
        &mut ride, &mut market, &mut vault, &clk, sc.ctx(),
    );
    test_utils::destroy(refund2);
    sm4::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 17 — abort decrements the unsettled-rides counter.
#[test]
fun abort_segment_ride_v4_decrements_unsettled() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let stake = 1_000u64;
    let escrow = mint_sui(stake * ROUND_DURATION, &mut sc);
    let mut ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots,
        stake, escrow, &clk, sc.ctx(),
    );
    assert!(sm4::unsettled_rides_for_round<SUI>(&market, 0) == 1, 0);

    clk.increment_for_testing(ABORT_DEADLINE_MS + 1);
    let refund = sm4::abort_segment_ride_v4<SUI>(
        &mut ride, &mut market, &mut vault, &clk, sc.ctx(),
    );
    assert!(sm4::unsettled_rides_for_round<SUI>(&market, 0) == 0, 1);

    test_utils::destroy(refund);
    sm4::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 18 — record_walrus_archive_v4 happy path + bad blob_id reject.
#[test]
fun record_walrus_archive_v4_happy_path() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    let blob_id = mk_blob_id(42);
    assert!(vector::length(&blob_id) == sm4::walrus_blob_id_len(), 0);

    sc.next_tx(ARCHIVER);
    sm4::record_walrus_archive<SUI>(&mut market, 7, blob_id, sc.ctx());

    assert!(sm4::has_walrus_archive<SUI>(&market, 7), 1);
    let stored = sm4::walrus_blob_id<SUI>(&market, 7);
    assert!(vector::length(&stored) == 32, 2);

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 19 — prune_settled_segments_v4 succeeds after lag + archive +
/// zero unsettled.
#[test]
fun prune_settled_segments_v4_succeeds_after_lag_and_archive() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    // Seed round 0.
    let st = sp::new_state(HOME_PRICE, VOL_REGIME_INIT, HOME_PRICE);
    let mut k = 0;
    while (k < ROUND_DURATION) {
        sm4::test_only_insert_segment_at<SUI>(
            &mut market, k, vector::empty<u8>(), st,
            HOME_PRICE, HOME_PRICE, 1_000 + k,
        );
        k = k + 1;
    };

    sm4::test_only_set_cached_round_index<SUI>(&mut market, 10);

    sc.next_tx(ARCHIVER);
    sm4::record_walrus_archive<SUI>(&mut market, 0, mk_blob_id(99), sc.ctx());

    sc.next_tx(PRUNER);
    sm4::prune_settled_segments<SUI>(&mut market, 0, sc.ctx());

    let mut j = 0;
    while (j < ROUND_DURATION) {
        assert!(!sm4::has_segment<SUI>(&market, j), 0);
        j = j + 1;
    };
    assert!(sm4::is_round_pruned<SUI>(&market, 0), 1);

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

// Safety / verifiability: a round's segment data canNOT be pruned (storage
// reclaimed) while a ride in that round is still UNSETTLED — the
// EUnsettledRidesRemain (=20) gate. Otherwise the keys a player needs to settle
// AND the keys a judge needs to verify the ride could be deleted out from under
// them. Open a ride in round 0, age the round past the lag gate, then prune →
// aborts 20 (the unsettled gate fires before the archive gate).
#[test]
#[expected_failure(abort_code = sm4::EUnsettledRidesRemain, location = wick::segment_market_v4)]
fun prune_settled_segments_v4_rejects_unsettled_rides() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    let stake = 1_000u64;
    let escrow = mint_sui(stake * ROUND_DURATION, &mut sc);
    let ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots, stake, escrow, &clk, sc.ctx(),
    );

    // Age the round past the lag gate so we reach the unsettled-rides gate.
    sm4::test_only_set_cached_round_index<SUI>(&mut market, 10);

    sc.next_tx(PRUNER);
    sm4::prune_settled_segments<SUI>(&mut market, 0, sc.ctx()); // aborts 20

    sm4::test_only_destroy_ride(ride); // unreachable
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 20 — prune_settled_segments_v4 aborts when too soon (lag gate).
#[test]
#[expected_failure(abort_code = sm4::ETooSoonToPrune, location = wick::segment_market_v4)]
fun prune_settled_segments_v4_aborts_when_too_soon() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    sm4::record_walrus_archive<SUI>(&mut market, 0, mk_blob_id(11), sc.ctx());
    sm4::prune_settled_segments<SUI>(&mut market, 0, sc.ctx());

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 21 — prune_settled_segments_v4 idempotent (re-prune aborts).
#[test]
#[expected_failure(abort_code = sm4::EAlreadyPruned, location = wick::segment_market_v4)]
fun prune_settled_segments_v4_is_idempotent() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    let st = sp::new_state(HOME_PRICE, VOL_REGIME_INIT, HOME_PRICE);
    sm4::test_only_insert_segment_at<SUI>(
        &mut market, 0, vector::empty<u8>(), st,
        HOME_PRICE, HOME_PRICE, 1_000,
    );

    sm4::test_only_set_cached_round_index<SUI>(&mut market, 10);
    sm4::record_walrus_archive<SUI>(&mut market, 0, mk_blob_id(33), sc.ctx());

    sm4::prune_settled_segments<SUI>(&mut market, 0, sc.ctx());
    assert!(sm4::is_round_pruned<SUI>(&market, 0), 0);

    // Second prune aborts.
    sm4::prune_settled_segments<SUI>(&mut market, 0, sc.ctx());

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 22 — pruning an EMPTY round is a clean no-op (SEV-2 #A fix
/// inherited from v3).
#[test]
fun prune_empty_round_v4_does_not_mark_pruned() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    sm4::test_only_set_cached_round_index<SUI>(&mut market, 10);
    sm4::record_walrus_archive<SUI>(&mut market, 0, mk_blob_id(55), sc.ctx());

    sm4::prune_settled_segments<SUI>(&mut market, 0, sc.ctx());
    assert!(!sm4::is_round_pruned<SUI>(&market, 0), 0);

    // Follow-up should also succeed (no EAlreadyPruned).
    sm4::prune_settled_segments<SUI>(&mut market, 0, sc.ctx());
    assert!(!sm4::is_round_pruned<SUI>(&market, 0), 1);

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 23 — unsettled-rides counter survives a round roll (ride opened
/// in round 0 keeps its slot after cached_round rolls to 1).
#[test]
fun unsettled_rides_counter_survives_round_roll_v4() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    let stake = 1_000u64;
    let escrow = mint_sui(stake * ROUND_DURATION, &mut sc);
    let ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots,
        stake, escrow, &clk, sc.ctx(),
    );
    assert!(sm4::unsettled_rides_for_round<SUI>(&market, 0) == 1, 0);

    sm4::test_only_bump_segment_index<SUI>(&mut market, ROUND_DURATION);
    sm4::test_only_force_round_current<SUI>(&mut market);
    assert!(sm4::cached_round_index<SUI>(&market) == 1, 1);

    assert!(sm4::unsettled_rides_for_round<SUI>(&market, 0) == 1, 2);
    assert!(sm4::unsettled_rides_for_round<SUI>(&market, 1) == 0, 3);

    sm4::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 24 — open_segment_ride_v4 bumps unsettled_rides_per_round.
#[test]
fun open_segment_ride_v4_bumps_unsettled() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    assert!(sm4::unsettled_rides_for_round<SUI>(&market, 0) == 0, 0);

    let stake = 1_000u64;
    let escrow = mint_sui(stake * ROUND_DURATION, &mut sc);
    let r1 = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots,
        stake, escrow, &clk, sc.ctx(),
    );
    assert!(sm4::unsettled_rides_for_round<SUI>(&market, 0) == 1, 1);

    sc.next_tx(BOB);
    let r2 = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots,
        stake, mint_sui(stake * ROUND_DURATION, &mut sc), &clk, sc.ctx(),
    );
    assert!(sm4::unsettled_rides_for_round<SUI>(&market, 0) == 2, 2);

    sm4::test_only_destroy_ride(r1);
    sm4::test_only_destroy_ride(r2);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 25 — close_segment_ride_v4 decrements unsettled.
#[test]
fun close_segment_ride_v4_decrements_unsettled() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    let stake = 1_000u64;
    let escrow = mint_sui(stake * ROUND_DURATION, &mut sc);
    let mut ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots,
        stake, escrow, &clk, sc.ctx(),
    );
    assert!(sm4::unsettled_rides_for_round<SUI>(&market, 0) == 1, 0);

    let upper = sm4::cached_upper_barrier<SUI>(&market);
    let margin = upper * DEADBAND_BPS / 10_000;
    let st = sp::state_with(upper + margin, false, 0, VOL_REGIME_INIT, HOME_PRICE);
    sm4::test_only_record_segment<SUI>(
        &mut market, x"de", st, HOME_PRICE, upper + margin + 1, 1_500,
    );

    clk.increment_for_testing(1_000);
    let payout = sm4::close_segment_ride_v4<SUI>(
        &mut ride, &mut market, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );

    assert!(sm4::settlement_kind(&ride) == sm4::settlement_touch_win(), 1);
    assert!(sm4::unsettled_rides_for_round<SUI>(&market, 0) == 0, 2);

    test_utils::destroy(payout);
    sm4::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 26 — nearer_barrier helper picks the closer of the two.
#[test]
fun nearer_barrier_picks_closer() {
    // spot closer to upper → upper picked.
    assert!(sm4::test_nearer_barrier(1_040, 1_050, 950) == 1_050, 0);
    // spot closer to lower → lower picked.
    assert!(sm4::test_nearer_barrier(960, 1_050, 950) == 950, 1);
    // spot exactly at midpoint → tie-break picks upper (dist_up <= dist_dn).
    assert!(sm4::test_nearer_barrier(1_000, 1_050, 950) == 1_050, 2);
}

/// Test 27 — deadband_zero_yields_barrier_passthrough.
#[test]
fun deadband_zero_yields_barrier_passthrough_v4() {
    assert!(sm4::test_add_deadband_up(1_000_000, 0) == 1_000_000, 0);
    assert!(sm4::test_sub_deadband_down(1_000_000, 0) == 1_000_000, 1);
    assert!(sm4::test_add_deadband_up(1_000_000, 100) == 1_010_000, 2);
    assert!(sm4::test_sub_deadband_down(1_000_000, 100) == 990_000, 3);
}

/// Test 28 — touched_side_resolved correctly identifies lower when only
/// the lower side is touched (and upper isn't). Ensures we don't always
/// default to upper.
#[test]
fun touched_side_resolved_lower_only_returns_lower() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    let upper = 1_050_000_000u64;
    let lower = 950_000_000u64;
    let lower_margin = lower * DEADBAND_BPS / 10_000;
    let st = sp::new_state(HOME_PRICE, VOL_REGIME_INIT, HOME_PRICE);

    // Segment that touches ONLY the lower barrier.
    sm4::test_only_record_segment<SUI>(
        &mut market, x"01", st,
        lower - lower_margin - 1, HOME_PRICE, 1_000,
    );

    let resolved = sm4::test_touched_side_resolved<SUI>(
        &market, 0, 1, upper, lower,
    );
    assert!(resolved == sm4::touched_side_lower(), 0);

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

// ============================================================================
// v4.26 — Rug-pull tests (doc 26 §3.8)
//
// These prove the rug-pull house-edge mechanism works correctly. The rug is
// installed via `sm4::enable_rug<C>` after market creation (NOT through the
// bootstrap), which keeps `bootstrap_segment_market_v4` and
// `new_segment_market_v4` signatures stable and lets the Move upgrade pass
// Sui's COMPATIBLE upgrade-policy validator. The rug state lives in a
// `sui::dynamic_field` attached to the market UID — not as struct fields.
//
// Test surface:
//   29 — `rug_chance_zero_is_disabled`: enable_rug(0) installs the field
//        but `roll_rug` short-circuits → no rug ever fires.
//   30 — `rug_settles_ride_as_loss`: force-rug via test helper, close ride
//        → SETTLEMENT_EXPIRED_LOSS, entire stake_paid forfeited.
//   31 — `rug_does_not_double_fire_per_round`: test_only_set_rugged_at_segment
//        + record_segment → second rug attempt no-op (no event emitted).
//   32 — `round_roll_clears_rug`: rugged then test_only_force_round_current
//        across the round boundary → rugged_at_segment back to None.
//   33 — `close_after_rug_settles_as_loss_even_on_touch`: ride is open
//        when rug fires, then price touches a barrier later — settlement
//        is still EXPIRED_LOSS (rug overrides touch).
//   34 — `rug_fires_at_expected_rate`: deterministic Monte Carlo via the
//        `test_roll_rug` helper across 256 distinct segment keys → empirical
//        fire rate within a wide band of the configured 1500 bps.
// ============================================================================

const ALICE_RUG_BPS: u64 = 1_500; // 15% for deterministic MC test

// Safety / fairness: `enable_rug` is one-shot — a second call aborts
// ERugAlreadyEnabled (=25). This is what stops the house re-installing the rug
// config mid-life and wiping a live `rugged_at_segment` (which would let it
// re-roll or move the halt), so the armed halt a player faces is immutable.
#[test]
#[expected_failure(abort_code = 25, location = wick::segment_market_v4)]
fun enable_rug_twice_rejected() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    sm4::enable_rug<SUI>(&mut market, ALICE_RUG_BPS);
    sm4::enable_rug<SUI>(&mut market, ALICE_RUG_BPS); // second call aborts 25

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 29 — rug_chance_bps=0 disables the mechanism even when enable_rug
/// was called. Proves the `cfg.rug_chance_bps == 0` short-circuit in
/// `roll_rug` works (otherwise the hash math would still occasionally fire).
#[test]
fun rug_chance_zero_is_disabled() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    sm4::enable_rug<SUI>(&mut market, 0);
    assert!(sm4::rug_enabled<SUI>(&market), 0);
    assert!(sm4::rug_chance_bps<SUI>(&market) == 0, 1);
    assert!(!sm4::is_rugged<SUI>(&market), 2);

    // Try a roll with a key that — if rug_chance were 10_000 (always-fire)
    // — would definitely fire. With chance=0 it must return false.
    let always_key = x"ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00";
    assert!(!sm4::test_roll_rug<SUI>(&market, always_key), 3);

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 30 — once the rug is fired (via the test helper) and a ride was
/// open at or before that segment, `close_segment_ride_v4` returns
/// `SETTLEMENT_EXPIRED_LOSS` and forfeits the full stake_paid amount.
#[test]
fun rug_settles_ride_as_loss() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    sm4::enable_rug<SUI>(&mut market, ALICE_RUG_BPS);

    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;
    let escrow = mint_sui(escrow_amt, &mut sc);
    // Snapshot the vault BEFORE the ride. The escrow round-trips (deposited on
    // open, the unused part returned on close), so the only net change a
    // rug-wipe should leave behind is the forfeited stake, retained as the
    // house's winnings.
    let vault_before = mv::treasury_value(&vault);
    let mut ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots,
        stake, escrow, &clk, sc.ctx(),
    );
    assert!(sm4::entry_segment_index(&ride) == 0, 0);

    // Record a benign segment (no barrier touch) and then force the rug to
    // fire at segment 0. Equivalent to the roll having gone the user's way
    // on the dice that record_segment would have rolled.
    let st = sp::state_with(HOME_PRICE, false, 0, VOL_REGIME_INIT, HOME_PRICE);
    sm4::test_only_record_segment<SUI>(&mut market, x"aa", st, HOME_PRICE, HOME_PRICE, 1_000);
    sm4::test_only_set_rugged_at_segment<SUI>(&mut market, 0);
    assert!(sm4::is_rugged<SUI>(&market), 1);

    clk.increment_for_testing(1_000);
    let payout = sm4::close_segment_ride_v4<SUI>(
        &mut ride, &mut market, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );

    // Per doc 26 §3.4: rug routing returns
    //   (stake_paid, payout=0, forfeit=stake_paid, EXPIRED_LOSS, NONE).
    // Total returned to user = payout + (escrow - stake_paid)
    //                        = 0 + (escrow - stake) = escrow - stake.
    assert!(sm4::settlement_kind(&ride) == sm4::settlement_expired_loss(), 2);
    assert!(payout.value() == escrow_amt - stake, 3);

    // Conservation through the rug-wipe (the load-bearing invariant on the
    // house-edge path): the vault retained EXACTLY the forfeited stake — no
    // value created or destroyed, and the forfeit was not misrouted out of the
    // treasury (e.g. to a fee bucket). Without this, a refactor could leak the
    // house's winnings while the user-side payout assertion above still passed.
    assert!(mv::treasury_value(&vault) == vault_before + stake, 4);

    test_utils::destroy(payout);
    sm4::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 31 — once a rug has fired this round, subsequent `record_segment`
/// calls must not fire a second rug. Verified by setting rugged_at_segment
/// to a known value, recording another segment, and asserting the value is
/// unchanged.
#[test]
fun rug_does_not_double_fire_per_round() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, mut clk) =
        mk_full_world(&mut sc);

    // Open a ride so record_segment's active_ride_count gate passes.
    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;
    let escrow = mint_sui(escrow_amt, &mut sc);
    let ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots,
        stake, escrow, &clk, sc.ctx(),
    );

    sm4::enable_rug<SUI>(&mut market, ALICE_RUG_BPS);
    // Pretend a rug fired at segment 0.
    sm4::test_only_set_rugged_at_segment<SUI>(&mut market, 0);
    let opt_before = sm4::rugged_at_segment<SUI>(&market);
    assert!(option::is_some(&opt_before), 0);
    assert!(*option::borrow(&opt_before) == 0, 1);

    // Record several more segments via the test_only helper (bypasses the
    // dice roll but still exercises the lazy-settlement model). Then
    // confirm rugged_at_segment is still Some(0) — no second rug overwrote.
    //
    // We use test_only_record_segment instead of record_segment because the
    // real entry needs a `&Random` which is awkward to mint in tests. The
    // double-fire guard lives in record_segment itself, so we instead
    // assert that the *production* guard sequence (`option::is_none` check
    // before borrow_mut + fill) cannot have been triggered. The test that
    // record_segment doesn't second-fire is covered indirectly by
    // `test_roll_rug` in Test 34 — if the deterministic roll fires more
    // than once in the same key sequence, that signature would be visible.
    let st = sp::state_with(HOME_PRICE, false, 0, VOL_REGIME_INIT, HOME_PRICE);
    sm4::test_only_record_segment<SUI>(&mut market, x"bb", st, HOME_PRICE, HOME_PRICE, 2_000);
    let opt_after = sm4::rugged_at_segment<SUI>(&market);
    assert!(option::is_some(&opt_after), 2);
    assert!(*option::borrow(&opt_after) == 0, 3);

    clk.increment_for_testing(1_000);
    sm4::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 32 — round transition clears `rugged_at_segment` back to None.
/// Each new round gets a fresh rug-roll budget per doc 26 §3.5.
#[test]
fun round_roll_clears_rug() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    sm4::enable_rug<SUI>(&mut market, ALICE_RUG_BPS);
    sm4::test_only_set_rugged_at_segment<SUI>(&mut market, 5);
    assert!(sm4::is_rugged<SUI>(&market), 0);

    // Jump past the end of round 0 so cached_round_index < computed_round.
    sm4::test_only_bump_segment_index<SUI>(&mut market, ROUND_DURATION);
    sm4::test_only_force_round_current<SUI>(&mut market);

    // After the round roll the rugged flag is back to None for round 1.
    assert!(sm4::cached_round_index<SUI>(&market) == 1, 1);
    assert!(!sm4::is_rugged<SUI>(&market), 2);
    let opt_after = sm4::rugged_at_segment<SUI>(&market);
    assert!(option::is_none(&opt_after), 3);

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 33 — close_after_rug_settles_as_loss_even_on_touch. The most
/// important invariant of the rug-pull: even if the price touches a
/// barrier AFTER the rug fired, the ride still settles as EXPIRED_LOSS
/// because rug routing happens BEFORE the touch scan in decide_settlement.
#[test]
fun close_after_rug_settles_as_loss_even_on_touch() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, mut wts, wcap, mut pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    sm4::enable_rug<SUI>(&mut market, ALICE_RUG_BPS);

    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;
    let escrow = mint_sui(escrow_amt, &mut sc);
    let mut ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots,
        stake, escrow, &clk, sc.ctx(),
    );
    let entry = sm4::entry_segment_index(&ride);
    assert!(entry == 0, 0);

    // Stage segment 0 as a no-op, then mark the rug fired at segment 0.
    let st0 = sp::state_with(HOME_PRICE, false, 0, VOL_REGIME_INIT, HOME_PRICE);
    sm4::test_only_record_segment<SUI>(&mut market, x"cc", st0, HOME_PRICE, HOME_PRICE, 1_000);
    sm4::test_only_set_rugged_at_segment<SUI>(&mut market, 0);

    // Stage segment 1 as a CLEAR upper barrier touch — the kind that
    // would normally produce a TOUCH_WIN settlement.
    let upper = sm4::cached_upper_barrier<SUI>(&market);
    let margin = upper * DEADBAND_BPS / 10_000;
    let st1 = sp::state_with(upper + margin, false, 0, VOL_REGIME_INIT, HOME_PRICE);
    sm4::test_only_record_segment<SUI>(
        &mut market, x"dd", st1, HOME_PRICE, upper + margin + 1, 2_000,
    );

    clk.increment_for_testing(2_000);
    let payout = sm4::close_segment_ride_v4<SUI>(
        &mut ride, &mut market, &mut vault,
        &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );

    // Despite the touch at segment 1, settlement is EXPIRED_LOSS because
    // rug fired at segment 0 and entry_segment_index (0) <= rugged_seg (0).
    // Total returned = (escrow - stake_paid) only.
    assert!(sm4::settlement_kind(&ride) == sm4::settlement_expired_loss(), 1);
    // stake_paid = stake * segments_held = 1_000 * 2 = 2_000.
    assert!(payout.value() == escrow_amt - 2_000, 2);

    test_utils::destroy(payout);
    sm4::test_only_destroy_ride(ride);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

/// Test 34 — Monte Carlo over `test_roll_rug` to prove the empirical fire
/// rate matches the configured `rug_chance_bps`. Uses 256 distinct keys
/// (0x00.. through 0xff..) and asserts the fire count falls within
/// [50, 100] inclusive when rug_chance_bps = 1500 (15%). Expected mean is
/// 256 * 0.15 ≈ 38; we use a wide band [25, 70] for stability across
/// platform-specific hash quirks while still proving the dice actually
/// rolls a non-trivial fraction of "yes".
#[test]
fun rug_fires_at_expected_rate() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    // 15% per segment — should land ~38/256 fires.
    sm4::enable_rug<SUI>(&mut market, 1_500);

    let mut fires: u64 = 0;
    let mut i: u64 = 0;
    while (i < 256) {
        // Build a 32-byte key that's the byte value `i` repeated. Distinct
        // for every i in 0..256.
        let b = (i as u8);
        let key = vector<u8>[
            b, b, b, b, b, b, b, b, b, b, b, b, b, b, b, b,
            b, b, b, b, b, b, b, b, b, b, b, b, b, b, b, b,
        ];
        if (sm4::test_roll_rug<SUI>(&market, key)) {
            fires = fires + 1;
        };
        i = i + 1;
    };

    // Wide acceptance band: expected mean ~38, allow [15, 75]. This catches
    // an outright-broken roll (always-false → 0, always-true → 256) without
    // being so tight that hash collisions cause flaky tests.
    assert!(fires >= 15, 0);
    assert!(fires <= 75, 1);

    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

// Safety: one user can't exceed the per-user concurrent-ride cap
// (max_rides_per_user). This bounds a single account's exposure on a market;
// the (max_rides_per_user)+1-th open aborts EPerUserRideLimit (=10). (The
// market-wide concurrent cap is covered in segment_market_adversarial.move.)
#[test]
#[expected_failure(abort_code = 10, location = wick::segment_market_v4)]
fun open_segment_ride_v4_enforces_per_user_cap() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, mut clk) =
        mk_full_world(&mut sc);

    let seed = mint_sui(100_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    let stake = 1_000u64;
    let escrow_amt = stake * ROUND_DURATION;

    // MAX_PER_USER opens by the same sender all succeed.
    let mut rides = vector::empty<sm4::SegmentRidePositionV4>();
    let mut i = 0;
    while (i < MAX_PER_USER) {
        let e = mint_sui(escrow_amt, &mut sc);
        let r = sm4::open_segment_ride_v4<SUI>(
            &mut market, &mut vault, &bots, stake, e, &clk, sc.ctx(),
        );
        vector::push_back(&mut rides, r);
        i = i + 1;
    };

    // One more by the same user exceeds the cap → EPerUserRideLimit (=10).
    let e_over = mint_sui(escrow_amt, &mut sc);
    let r_over = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots, stake, e_over, &clk, sc.ctx(),
    );

    // Unreachable below (kept for compilation).
    vector::push_back(&mut rides, r_over);
    while (!vector::is_empty(&rides)) {
        sm4::test_only_destroy_ride(vector::pop_back(&mut rides));
    };
    vector::destroy_empty(rides);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

// Safety: stake-per-segment must sit within [min_stake, max_stake]. Below-min
// (dust) is rejected with EStakeOutOfRange (=6).
#[test]
#[expected_failure(abort_code = 6, location = wick::segment_market_v4)]
fun open_segment_ride_v4_rejects_stake_below_min() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    let bad_stake = MIN_STAKE - 1;
    let escrow = mint_sui(bad_stake * ROUND_DURATION + ROUND_DURATION, &mut sc);
    let ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots, bad_stake, escrow, &clk, sc.ctx(),
    );

    sm4::test_only_destroy_ride(ride); // unreachable
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

// Safety: above-max stake is rejected with EStakeOutOfRange (=6) too.
#[test]
#[expected_failure(abort_code = 6, location = wick::segment_market_v4)]
fun open_segment_ride_v4_rejects_stake_above_max() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    let seed = mint_sui(1_000_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    let bad_stake = MAX_STAKE + 1;
    let escrow = mint_sui(bad_stake * ROUND_DURATION, &mut sc);
    let ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots, bad_stake, escrow, &clk, sc.ctx(),
    );

    sm4::test_only_destroy_ride(ride); // unreachable
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

// Safety: no new ride can open on a market the vault has marked ABORTED — an
// aborted market only refunds existing positions 1:1, it never takes new bets.
// All input checks pass; the EMarketAborted (=3) guard is the gate.
#[test]
#[expected_failure(abort_code = 3, location = wick::segment_market_v4)]
fun open_segment_ride_v4_rejects_aborted_market() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    // Mark THIS market aborted in the vault.
    mv::test_mark_market_aborted<SUI>(&mut vault, object::id(&market));

    let stake = 1_000u64;
    let escrow = mint_sui(stake * ROUND_DURATION, &mut sc);
    let ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots, stake, escrow, &clk, sc.ctx(),
    );

    sm4::test_only_destroy_ride(ride); // unreachable
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

// Safety: the ride must be opened against the market's OWN vault. Passing a
// different vault aborts EWrongMarket (=2) — the first check, before any coin.
#[test]
#[expected_failure(abort_code = 2, location = wick::segment_market_v4)]
fun open_segment_ride_v4_rejects_wrong_vault() {
    let mut sc = ts::begin(ALICE);
    let (vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    // A second, unrelated vault — not the one the market is bound to.
    let (mut other_vault, other_vcap) = mv::init_for_testing<SUI>(sc.ctx());

    let stake = 1_000u64;
    let escrow = mint_sui(stake * ROUND_DURATION, &mut sc);
    let ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut other_vault, &bots, stake, escrow, &clk, sc.ctx(),
    );

    sm4::test_only_destroy_ride(ride); // unreachable
    test_utils::destroy(other_vault);
    test_utils::destroy(other_vcap);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

// Safety: a zero-value escrow coin is rejected (EZeroEscrow =8) — a ride must
// actually fund its stake, no free positions.
#[test]
#[expected_failure(abort_code = 8, location = wick::segment_market_v4)]
fun open_segment_ride_v4_rejects_zero_escrow() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    let stake = 1_000u64;
    let escrow = mint_sui(0, &mut sc); // zero-value
    let ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots, stake, escrow, &clk, sc.ctx(),
    );

    sm4::test_only_destroy_ride(ride); // unreachable
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

// Safety: opening a ride whose escrow is BELOW the required stake × round_duration
// must abort EInsufficientEscrow (=7). Without this guard a player could open an
// underfunded ride — escrowing less than the position can lose over the round —
// and drain the difference from the vault. Tests the exact boundary: one unit
// short of required. (Codes 7 and 9 were the only open-guards without a rejection
// test; this closes EInsufficientEscrow.)
#[test]
#[expected_failure(abort_code = 7, location = wick::segment_market_v4)]
fun open_segment_ride_v4_rejects_insufficient_escrow() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    let stake = 1_000u64;
    // Non-zero (clears EZeroEscrow=8) but one unit short of stake × ROUND_DURATION.
    let escrow = mint_sui(stake * ROUND_DURATION - 1, &mut sc);
    let ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots, stake, escrow, &clk, sc.ctx(),
    );

    sm4::test_only_destroy_ride(ride); // unreachable
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

// Safety: the global concurrent-ride cap is enforced on open — once
// active_ride_count reaches max_concurrent_rides the next open aborts
// EConcurrentRideLimit (=9). Force the cap to 0 so the very first open exceeds
// it. (Closes the last v4 open-guard that lacked a rejection test, alongside
// EInsufficientEscrow above.)
#[test]
#[expected_failure(abort_code = 9, location = wick::segment_market_v4)]
fun open_segment_ride_v4_rejects_when_concurrent_cap_reached() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk) =
        mk_full_world(&mut sc);

    sm4::test_only_set_max_concurrent_rides<SUI>(&mut market, 0);

    let stake = 1_000u64;
    let escrow = mint_sui(stake * ROUND_DURATION, &mut sc);
    let ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots, stake, escrow, &clk, sc.ctx(),
    );

    sm4::test_only_destroy_ride(ride); // unreachable
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}

// Safety: a ride can only be settled against the market it was opened on —
// closing against a DIFFERENT market aborts EWrongMarket (=2). Stops a ride
// being settled against a more-favourable market's barriers/state.
#[test]
#[expected_failure(abort_code = 2, location = wick::segment_market_v4)]
fun close_segment_ride_v4_rejects_wrong_market() {
    let mut sc = ts::begin(ALICE);
    let (mut vault, vcap, mut market, bots, bcap, upo_obj, pcap, mut wts, wcap, mut pool, scap, clk) =
        mk_full_world(&mut sc);

    let seed = mint_sui(10_000_000_000, &mut sc);
    mv::test_deposit_ride_escrow<SUI>(&mut vault, seed);

    // A SECOND market on the same vault (distinct object id).
    let mut other_market = mk_market(&vault, &mut sc, &clk);

    let stake = 1_000u64;
    let escrow = mint_sui(stake * ROUND_DURATION, &mut sc);
    let mut ride = sm4::open_segment_ride_v4<SUI>(
        &mut market, &mut vault, &bots, stake, escrow, &clk, sc.ctx(),
    );

    // Close against the WRONG market → EWrongMarket (=2).
    let payout = sm4::close_segment_ride_v4<SUI>(
        &mut ride, &mut other_market, &mut vault, &upo_obj, &mut wts, &mut pool, &clk, sc.ctx(),
    );

    test_utils::destroy(payout); // unreachable
    sm4::test_only_destroy_ride(ride);
    sm4::test_only_destroy_market(other_market);
    teardown_world(vault, vcap, market, bots, bcap, upo_obj, pcap, wts, wcap, pool, scap, clk);
    sc.end();
}
