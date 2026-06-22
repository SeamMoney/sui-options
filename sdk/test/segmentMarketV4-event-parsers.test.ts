// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// The v4 event parsers turn an on-chain event's parsedJson (snake_case, u64s as
// strings) into the camelCase/bigint shape the frontend's live chart, rug
// headline, and ride cards consume. A wrong field map (or a typo'd key) silently
// yields `undefined` and breaks the live UI, so pin the full field mapping for
// the four pure parsers (the two with byte/enum decoders are covered elsewhere).
import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  parseSegmentMarketV4CreatedEvent,
  parseRoundStartedV4Event,
  parseRideOpenedV4Event,
  parseRugFiredV4EventJson,
} from "../src/segmentMarketV4.js";

test("parseSegmentMarketV4CreatedEvent maps every field", () => {
  const e = parseSegmentMarketV4CreatedEvent({
    market_id: "0xmkt",
    vault_id: "0xvault",
    home_price: "1000000000",
    round_duration_segments: "20",
    barrier_offset_bps: "500",
    multiplier_bps: "20000",
    max_payout_per_round: "1500000000",
    created_at_ms: "1234",
  });
  assert.deepEqual(e, {
    marketId: "0xmkt",
    vaultId: "0xvault",
    homePrice: 1_000_000_000n,
    roundDurationSegments: 20n,
    barrierOffsetBps: 500n,
    multiplierBps: 20_000n,
    maxPayoutPerRound: 1_500_000_000n,
    createdAtMs: 1234n,
  });
});

test("parseRoundStartedV4Event maps every field (drives the live chart's round roll)", () => {
  const e = parseRoundStartedV4Event({
    market_id: "0xmkt",
    round_index: "7",
    upper_barrier: "1100",
    lower_barrier: "900",
    started_at_segment: "3",
    spot_at_roll: "1000",
  });
  assert.deepEqual(e, {
    marketId: "0xmkt",
    roundIndex: 7n,
    upperBarrier: 1100n,
    lowerBarrier: 900n,
    startedAtSegment: 3n,
    spotAtRoll: 1000n,
  });
});

test("parseRideOpenedV4Event maps every field (drives the live ride card)", () => {
  const e = parseRideOpenedV4Event({
    ride_id: "0xride",
    user: "0xuser",
    market_id: "0xmkt",
    round_index: "7",
    entry_segment_index: "3",
    upper_barrier_price: "1100",
    lower_barrier_price: "900",
    stake_per_segment: "100",
    escrowed: "7500",
    multiplier_bps: "20000",
    opened_at_ms: "1234",
  });
  assert.deepEqual(e, {
    rideId: "0xride",
    user: "0xuser",
    marketId: "0xmkt",
    roundIndex: 7n,
    entrySegmentIndex: 3n,
    upperBarrierPrice: 1100n,
    lowerBarrierPrice: 900n,
    stakePerSegment: 100n,
    escrowed: 7500n,
    multiplierBps: 20_000n,
    openedAtMs: 1234n,
  });
});

test("parseRugFiredV4EventJson maps the headline rug fields", () => {
  const e = parseRugFiredV4EventJson({
    market_id: "0xmkt",
    round_index: "7",
    segment_index: "42",
  });
  assert.equal(e.marketId, "0xmkt");
  assert.equal(e.roundIndex, 7n);
  assert.equal(e.segmentIndex, 42n);
});
