// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// The v2/v3 segment-market event parsers (distinct from v4: a single-barrier
// model with barrier_index + barrier_price + per-barrier payout, rather than
// v4's both-barriers + touched_side). They were untested. Pin their field maps
// and the barrier-index decoder (0 → upper, else → lower).
import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  parseSegmentMarketCreatedEvent,
  parseRoundStartedEvent,
  parseSegmentRecordedEvent,
  parseRideOpenedEvent,
  parseRideClosedEvent,
  BARRIER_UPPER,
  BARRIER_LOWER,
} from "../src/segmentMarket.js";

test("parseSegmentMarketCreatedEvent (v2) maps the per-barrier model fields", () => {
  const e = parseSegmentMarketCreatedEvent({
    market_id: "0xm",
    vault_id: "0xv",
    home_price: "1000000000",
    round_duration_segments: "75",
    open_window_segments: "10",
    barrier_offset_bps: "1000",
    multiplier_bps: "17500",
    max_payout_per_barrier: "1500000000",
    created_at_ms: "1234",
  });
  assert.deepEqual(e, {
    marketId: "0xm",
    vaultId: "0xv",
    homePrice: 1_000_000_000n,
    roundDurationSegments: 75n,
    openWindowSegments: 10n,
    barrierOffsetBps: 1000n,
    multiplierBps: 17_500n,
    maxPayoutPerBarrier: 1_500_000_000n,
    createdAtMs: 1234n,
  });
});

test("parseRoundStartedEvent (v2) maps every field", () => {
  const e = parseRoundStartedEvent({
    market_id: "0xm",
    round_index: "7",
    upper_barrier: "1100",
    lower_barrier: "900",
    started_at_segment: "3",
    spot_at_roll: "1000",
  });
  assert.deepEqual(e, {
    marketId: "0xm",
    roundIndex: 7n,
    upperBarrier: 1100n,
    lowerBarrier: 900n,
    startedAtSegment: 3n,
    spotAtRoll: 1000n,
  });
});

test("parseSegmentRecordedEvent (v2) maps fields + decodes the key", () => {
  const keyArr = Array.from({ length: 32 }, (_, i) => i);
  const e = parseSegmentRecordedEvent({
    market_id: "0xm",
    k: "5",
    key: keyArr,
    min_price: "900",
    max_price: "1100",
    recorded_at_ms: "3000",
  });
  assert.equal(e.marketId, "0xm");
  assert.equal(e.k, 5n);
  assert.equal(e.minPrice, 900n);
  assert.equal(e.maxPrice, 1100n);
  assert.equal(e.recordedAtMs, 3000n);
  assert.deepEqual(Array.from(e.key), keyArr);
});

test("parseRideOpenedEvent (v2) maps single-barrier fields + decodes barrier index", () => {
  const e = parseRideOpenedEvent({
    ride_id: "0xr",
    user: "0xu",
    market_id: "0xm",
    round_index: "7",
    barrier_index: "0",
    barrier_price: "1100",
    stake_per_segment: "100",
    escrowed: "7500",
    multiplier_bps: "17500",
    entry_segment_index: "3",
    opened_at_ms: "1234",
  });
  assert.equal(e.rideId, "0xr");
  assert.equal(e.user, "0xu");
  assert.equal(e.marketId, "0xm");
  assert.equal(e.roundIndex, 7n);
  assert.equal(e.barrierIndex, BARRIER_UPPER); // 0 → upper
  assert.equal(e.barrierPrice, 1100n);
  assert.equal(e.stakePerSegment, 100n);
  assert.equal(e.escrowed, 7500n);
  assert.equal(e.multiplierBps, 17_500n);
  assert.equal(e.entrySegmentIndex, 3n);
  assert.equal(e.openedAtMs, 1234n);
});

test("parseRideClosedEvent (v2) maps settlement fields + decodes barrier index (1 → lower)", () => {
  const e = parseRideClosedEvent({
    ride_id: "0xr",
    user: "0xu",
    market_id: "0xm",
    round_index: "7",
    barrier_index: "1",
    settlement_kind: "1",
    stake_paid: "59",
    payout: "262500",
    forfeit: "0",
    bounty: "0",
    closed_at_ms: "2000",
  });
  assert.equal(e.barrierIndex, BARRIER_LOWER); // 1 → lower
  assert.equal(e.settlementKind, 1);
  assert.equal(e.stakePaid, 59n);
  assert.equal(e.payout, 262_500n);
  assert.equal(e.forfeit, 0n);
  assert.equal(e.bounty, 0n);
  assert.equal(e.closedAtMs, 2000n);
});
