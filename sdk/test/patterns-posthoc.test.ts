// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// detectPatternsAt / detectPostHocPattern power the live "a pattern just
// formed" callout (the candle-pattern surfacing the game shows as candles
// arrive). patterns.test.ts covers the single-candle predicates and
// detectPatterns, but not these two — pin that detectPatternsAt finds a pattern
// completing at a given offset, and that detectPostHocPattern reports the
// pattern landing on the final candle (with the correct absolute end index).
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { detectPatternsAt, detectPostHocPattern } from "../src/patterns.js";
import type { Candle } from "../src/seededPath.js";

const c = (o: number, h: number, l: number, cl: number): Candle => ({
  open: BigInt(o),
  high: BigInt(h),
  low: BigInt(l),
  close: BigInt(cl),
});

// open == low, close == high → full body, no wicks → an unambiguous Marubozu.
const MARUBOZU = c(100, 120, 100, 120);
// moderate body with wicks on both sides — not a doji or marubozu.
const MID = c(100, 105, 98, 103);

test("detectPatternsAt surfaces a single-candle pattern completing at the offset", () => {
  const window = [MID, MARUBOZU];
  const matches = detectPatternsAt(window, 1); // offset 1 = the Marubozu
  assert.ok(
    matches.some((m) => m.name === "Marubozu"),
    `expected a Marubozu at offset 1, got ${JSON.stringify(matches)}`,
  );
});

test("detectPatternsAt does not claim a Marubozu on a moderate candle", () => {
  const matches = detectPatternsAt([MID], 0);
  assert.ok(!matches.some((m) => m.name === "Marubozu"));
});

test("detectPostHocPattern reports the pattern landing on the final candle", () => {
  const candles = [MID, MID, MARUBOZU];
  const matches = detectPostHocPattern(candles);
  const maru = matches.find((m) => m.name === "Marubozu");
  assert.ok(maru, `expected the just-formed Marubozu, got ${JSON.stringify(matches)}`);
  assert.equal(maru!.endIndex, candles.length - 1); // absolute index of the last candle
});

test("detectPostHocPattern on an empty candle list returns [] (no crash)", () => {
  assert.deepEqual(detectPostHocPattern([]), []);
});
