/**
 * Regression suite for the @wick/sdk v4 event parsers — the data layer the
 * keeper, the verifier, and the chart all read on-chain events through. These
 * must survive Sui's JSON polymorphism (u64 fields arrive as a string OR a
 * number depending on the RPC/transport) and decode the v4-specific shapes
 * correctly: `touched_side` (0/1/2), the 32-byte segment key (number[] or hex),
 * and both barrier prices.
 *
 *   npx tsx --test sdk/test/segmentMarketV4.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  parseRideClosedV4Event,
  parseRideOpenedV4Event,
  parseSegmentRecordedV4Event,
  parseRoundStartedV4Event,
  parseRugFiredV4EventJson,
  parseSegmentMarketV4CreatedEvent,
  segmentRecordedV4EventType,
  rideClosedV4EventType,
  rugFiredV4EventType,
  TOUCHED_UPPER,
  TOUCHED_LOWER,
  TOUCHED_NONE,
  SETTLEMENT_TOUCH_WIN_V4,
  SETTLEMENT_CASHOUT_V4,
  SETTLEMENT_NAME_V4,
} from "../src/segmentMarketV4.js";

test("parseRideClosedV4Event maps touched_side and survives string/number u64s", () => {
  // The RPC commonly renders u64 as a string and small enums as numbers.
  const e = parseRideClosedV4Event({
    ride_id: "0xride",
    market_id: "0xmkt",
    round_index: "6",
    settlement_kind: 1,
    closed_at_ms: "1782053119417",
    payout: "87500",
    touched_side: 0,
  });
  assert.equal(e.rideId, "0xride");
  assert.equal(e.roundIndex, 6n);
  assert.equal(e.settlementKind, SETTLEMENT_TOUCH_WIN_V4);
  assert.equal(e.closedAtMs, 1782053119417n);
  assert.equal(e.payout, 87500n);
  assert.equal(e.touchedSide, TOUCHED_UPPER);
});

test("touched_side decodes all three values (incl. string form)", () => {
  const mk = (ts: unknown) =>
    parseRideClosedV4Event({ settlement_kind: 2, touched_side: ts }).touchedSide;
  assert.equal(mk(0), TOUCHED_UPPER);
  assert.equal(mk("1"), TOUCHED_LOWER);
  assert.equal(mk(2), TOUCHED_NONE);
  // An out-of-range code falls back to NONE rather than throwing. (A real
  // RideClosedV4 always carries 0/1/2; touched_side is display-only telemetry.)
  assert.equal(mk(99), TOUCHED_NONE);
});

test("SETTLEMENT_NAME_V4 labels the kinds the verifier prints", () => {
  assert.equal(SETTLEMENT_NAME_V4[SETTLEMENT_TOUCH_WIN_V4], "TOUCH_WIN");
  assert.equal(SETTLEMENT_NAME_V4[SETTLEMENT_CASHOUT_V4], "CASHOUT");
});

test("parseSegmentRecordedV4Event decodes a 32-byte key from a number array", () => {
  const bytes = Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256);
  const e = parseSegmentRecordedV4Event({
    market_id: "0xmkt",
    k: 457,
    key: bytes,
    min_price: "983180000",
    max_price: "1010510000",
    recorded_at_ms: 1782053100000,
  });
  assert.equal(e.k, 457n);
  assert.equal(e.key.length, 32);
  assert.deepEqual(Array.from(e.key), bytes);
  assert.equal(e.minPrice, 983180000n);
  assert.equal(e.maxPrice, 1010510000n);
});

test("parseSegmentRecordedV4Event also accepts a hex-string key", () => {
  const hex = "0x" + "ab".repeat(32);
  const e = parseSegmentRecordedV4Event({ key: hex });
  assert.equal(e.key.length, 32);
  assert.ok([...e.key].every((b) => b === 0xab));
});

test("parseRideOpenedV4Event snapshots BOTH barriers", () => {
  const e = parseRideOpenedV4Event({
    ride_id: "0xride",
    user: "0xuser",
    market_id: "0xmkt",
    round_index: "5",
    entry_segment_index: "439",
    upper_barrier_price: "1124970000",
    lower_barrier_price: "920430000",
    stake_per_segment: "17500",
    multiplier_bps: "20000",
    opened_at_ms: "1782050000000",
  });
  assert.equal(e.entrySegmentIndex, 439n);
  assert.equal(e.upperBarrierPrice, 1124970000n);
  assert.equal(e.lowerBarrierPrice, 920430000n);
  assert.equal(e.multiplierBps, 20000n);
});

test("parseRoundStartedV4Event + parseRugFiredV4EventJson decode their fields", () => {
  const r = parseRoundStartedV4Event({
    market_id: "0xmkt",
    round_index: 6,
    upper_barrier: "1107866203",
    lower_barrier: "906435985",
    started_at_segment: "450",
    spot_at_roll: "1003500000",
  });
  assert.equal(r.roundIndex, 6n);
  assert.equal(r.upperBarrier, 1107866203n);
  assert.equal(r.startedAtSegment, 450n);

  const rug = parseRugFiredV4EventJson({
    market_id: "0xmkt",
    round_index: "6",
    segment_index: "458",
  });
  assert.equal(rug.roundIndex, 6n);
  assert.equal(rug.segmentIndex, 458n);
});

test("parseSegmentMarketV4CreatedEvent reads the genesis home_price", () => {
  const e = parseSegmentMarketV4CreatedEvent({
    market_id: "0xmkt",
    vault_id: "0xvault",
    home_price: "1000000000",
    round_duration_segments: "75",
    barrier_offset_bps: "1000",
    multiplier_bps: "17500",
    max_payout_per_round: "20000000",
    created_at_ms: "1782000000000",
  });
  assert.equal(e.homePrice, 1000000000n);
  assert.equal(e.roundDurationSegments, 75n);
  assert.equal(e.barrierOffsetBps, 1000n);
});

test("event-type tags use the supplied package and v4 module", () => {
  const pkg = "0x10c3";
  assert.equal(segmentRecordedV4EventType(pkg), `${pkg}::segment_market_v4::SegmentRecordedV4`);
  assert.equal(rideClosedV4EventType(pkg), `${pkg}::segment_market_v4::RideClosedV4`);
  assert.equal(rugFiredV4EventType(pkg), `${pkg}::segment_market_v4::RugFiredV4`);
});
