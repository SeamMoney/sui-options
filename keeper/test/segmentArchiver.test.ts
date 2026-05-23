// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the v3.5 Walrus archiver — pin the BCS schema and the
// hex / base64url helpers. The on-chain + Walrus paths are integration-tested
// at the keeper layer (start with WICK_KEEPER_ARCHIVER_MARKETS); here we just
// nail down the parts that are deterministic and don't need a network.
//
// Runner: node:test (built-in). Execute with:
//   npx tsx --test test/segmentArchiver.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  WickRoundArchiveBCS,
  SegmentArchiveEntryBCS,
  WalkStateBCS,
  base64urlDecode,
  bytesToHex,
  hexToBytes,
  type WalkStatePayload,
  type WickRoundArchivePayload,
} from "../src/segmentArchiver.js";

function zeroWalk(): WalkStatePayload {
  return {
    price: 0n,
    momentum: { neg: false, mag: 0n },
    vol_regime: 0n,
    home: 0n,
    pattern_id: 0,
    candles_remaining: 0,
  };
}

test("hexToBytes / bytesToHex round-trip", () => {
  const cases = [
    "0x00",
    "0xff",
    "0x0123456789abcdef",
    "0x" + "00".repeat(32),
    "0x" + "ab".repeat(32),
  ];
  for (const hex of cases) {
    const bytes = hexToBytes(hex);
    assert.equal(`0x${bytesToHex(bytes)}`, hex);
  }
});

test("hexToBytes rejects odd-length input", () => {
  assert.throws(() => hexToBytes("0xabc"), /odd-length/);
});

test("base64urlDecode decodes the Walrus example blobId to 32 bytes", () => {
  // From docs/walrus.../storing-blobs example: 43 chars, base64url, 32 bytes.
  const sample = "M4hsZGQ1oCktdzegB6HnI6Mi28S2nqOPHxK-W7_4BUk";
  const bytes = base64urlDecode(sample);
  assert.equal(bytes.length, 32);
});

test("base64urlDecode handles URL-safe characters and missing padding", () => {
  // "abc" -> "YWJj" (no padding needed for 3-byte input)
  assert.deepEqual(base64urlDecode("YWJj"), new Uint8Array([97, 98, 99]));
  // "a" -> "YQ" (would need "==" padding in std base64)
  assert.deepEqual(base64urlDecode("YQ"), new Uint8Array([97]));
  // URL-safe: "+/" -> "-_"
  // base64 "fw+_" = bytes [0x7f, 0x0f, 0xbf]; base64url "fw-_" same bytes
  assert.deepEqual(
    base64urlDecode("fw-_"),
    base64urlDecode("fw+/"),
  );
});

test("WalkState BCS round-trip", () => {
  const ws: WalkStatePayload = {
    price: 12_345_678n,
    momentum: { neg: true, mag: 42n },
    vol_regime: 999_999n,
    home: 100_000n,
    pattern_id: 3,
    candles_remaining: 7,
  };
  const bytes = WalkStateBCS.serialize(ws).toBytes();
  const decoded = WalkStateBCS.parse(bytes);
  // BCS u64 / u128 decode as strings.
  assert.equal(decoded.price, "12345678");
  assert.equal(decoded.momentum.neg, true);
  assert.equal(decoded.momentum.mag, "42");
  assert.equal(decoded.vol_regime, "999999");
  assert.equal(decoded.home, "100000");
  assert.equal(decoded.pattern_id, 3);
  assert.equal(decoded.candles_remaining, 7);
});

test("SegmentArchiveEntry BCS round-trip preserves k, key bytes, and extrema", () => {
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = i;
  const entry = {
    k: 17n,
    key,
    recorded_at_ms: 1_700_000_000_000n,
    segment_min: 9_990_000n,
    segment_max: 10_010_000n,
    state_after: zeroWalk(),
  };
  const bytes = SegmentArchiveEntryBCS.serialize(entry).toBytes();
  const decoded = SegmentArchiveEntryBCS.parse(bytes);
  assert.equal(decoded.k, "17");
  assert.equal(decoded.recorded_at_ms, "1700000000000");
  assert.equal(decoded.segment_min, "9990000");
  assert.equal(decoded.segment_max, "10010000");
  // key was emitted as 32-byte vector<u8>
  assert.deepEqual(Array.from(decoded.key), Array.from(key));
});

test("WickRoundArchive BCS encodes schema_version=1 and full payload", () => {
  const marketId = hexToBytes("0x" + "11".repeat(32));
  const archive: WickRoundArchivePayload = {
    schema_version: 1,
    market_id: marketId,
    round_index: 42n,
    round_started_at_ms: 1_700_000_000_000n,
    round_started_at_segment: 840n,
    round_duration_segments: 20n,
    upper_barrier: 105_000_000n,
    lower_barrier: 95_000_000n,
    segments: [],
    walk_state_at_round_start: zeroWalk(),
    closed_at_ms_for_round: 1_700_000_008_000n,
  };
  const bytes = WickRoundArchiveBCS.serialize(archive).toBytes();
  // schema_version is the first byte by struct definition order.
  assert.equal(bytes[0], 1, "schema_version=1 must be the first byte");
  // 32-byte market_id is prefixed by ULEB128 length (single byte 0x20=32).
  assert.equal(bytes[1], 32);
  // Round-trip.
  const decoded = WickRoundArchiveBCS.parse(bytes);
  assert.equal(decoded.schema_version, 1);
  assert.equal(decoded.round_index, "42");
  assert.equal(decoded.round_duration_segments, "20");
  assert.equal(decoded.upper_barrier, "105000000");
  assert.equal(decoded.lower_barrier, "95000000");
  assert.equal(decoded.segments.length, 0);
});

test("WickRoundArchive with 20 segments serializes within a few KB", () => {
  // Sanity check from doc 24 §3: "round=20 archive is ~3 KB".
  // Build a realistic payload and assert the size envelope.
  const marketId = hexToBytes("0x" + "22".repeat(32));
  const segments = Array.from({ length: 20 }, (_, i) => {
    const key = new Uint8Array(32);
    for (let j = 0; j < 32; j++) key[j] = (i * 7 + j) & 0xff;
    return {
      k: BigInt(840 + i),
      key,
      recorded_at_ms: BigInt(1_700_000_000_000 + i * 400),
      segment_min: BigInt(100_000_000 - i * 1_000),
      segment_max: BigInt(100_000_000 + i * 1_000),
      state_after: zeroWalk(),
    };
  });
  const archive: WickRoundArchivePayload = {
    schema_version: 1,
    market_id: marketId,
    round_index: 42n,
    round_started_at_ms: 1_700_000_000_000n,
    round_started_at_segment: 840n,
    round_duration_segments: 20n,
    upper_barrier: 105_000_000n,
    lower_barrier: 95_000_000n,
    segments,
    walk_state_at_round_start: zeroWalk(),
    closed_at_ms_for_round: 1_700_000_008_000n,
  };
  const bytes = WickRoundArchiveBCS.serialize(archive).toBytes();
  // Doc 24 §3 says ~3 KB; allow generous bounds since BCS field overheads
  // can shift the exact number with future schema additions.
  assert.ok(bytes.byteLength >= 1_000, `archive too small: ${bytes.byteLength}`);
  assert.ok(bytes.byteLength <= 8_000, `archive too big: ${bytes.byteLength}`);
  // Sanity: round-trip.
  const decoded = WickRoundArchiveBCS.parse(bytes);
  assert.equal(decoded.segments.length, 20);
});
