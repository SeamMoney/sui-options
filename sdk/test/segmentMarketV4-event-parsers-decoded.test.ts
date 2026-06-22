// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// The remaining two v4 event parsers carry decoders: RideClosedV4 drives the
// settlement/P&L display (and must decode the touched-side enum 0/1/2 →
// upper/lower/none), and SegmentRecordedV4 drives the candle stream (and must
// decode the 32-byte provable-fairness key). A wrong map here mislabels a
// payout or corrupts a verifiable key, so pin both.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  parseRideClosedV4Event,
  parseSegmentRecordedV4Event,
  TOUCHED_UPPER,
  TOUCHED_LOWER,
  TOUCHED_NONE,
} from "../src/segmentMarketV4.js";

test("parseRideClosedV4Event maps the settlement/P&L fields", () => {
  const e = parseRideClosedV4Event({
    ride_id: "0xride",
    user: "0xuser",
    market_id: "0xmkt",
    round_index: "7",
    settlement_kind: "1",
    closed_at_ms: "2000",
    stake_paid: "59",
    payout: "262500",
    forfeit: "0",
    bounty: "0",
    touched_side: "0",
  });
  assert.equal(e.rideId, "0xride");
  assert.equal(e.user, "0xuser");
  assert.equal(e.marketId, "0xmkt");
  assert.equal(e.roundIndex, 7n);
  assert.equal(e.settlementKind, 1);
  assert.equal(e.closedAtMs, 2000n);
  assert.equal(e.stakePaid, 59n);
  assert.equal(e.payout, 262_500n);
  assert.equal(e.forfeit, 0n);
  assert.equal(e.bounty, 0n);
  assert.equal(e.touchedSide, TOUCHED_UPPER);
});

test("parseRideClosedV4Event decodes touched_side 0/1/2 → upper/lower/none", () => {
  const base = {
    ride_id: "0xr", user: "0xu", market_id: "0xm", round_index: "0",
    settlement_kind: "0", closed_at_ms: "0", stake_paid: "0",
    payout: "0", forfeit: "0", bounty: "0",
  };
  assert.equal(parseRideClosedV4Event({ ...base, touched_side: "0" }).touchedSide, TOUCHED_UPPER);
  assert.equal(parseRideClosedV4Event({ ...base, touched_side: "1" }).touchedSide, TOUCHED_LOWER);
  assert.equal(parseRideClosedV4Event({ ...base, touched_side: "2" }).touchedSide, TOUCHED_NONE);
});

test("parseSegmentRecordedV4Event maps fields and decodes the 32-byte key", () => {
  const keyArr = Array.from({ length: 32 }, (_, i) => i);
  const e = parseSegmentRecordedV4Event({
    market_id: "0xmkt",
    k: "5",
    key: keyArr,
    min_price: "900",
    max_price: "1100",
    recorded_at_ms: "3000",
  });
  assert.equal(e.marketId, "0xmkt");
  assert.equal(e.k, 5n);
  assert.equal(e.minPrice, 900n);
  assert.equal(e.maxPrice, 1100n);
  assert.equal(e.recordedAtMs, 3000n);
  assert.equal(e.key.length, 32);
  assert.deepEqual(Array.from(e.key), keyArr);
});
