/**
 * Direct unit tests for the CandleVision scoring primitives. The detector
 * regression (release-regression.ts) exercises these only indirectly through
 * whole patterns; but every judge-facing confidence score ("Bullish Marubozu
 * 100%") is built from scoreGreater / scoreLess / clamp01, and the body
 * helpers underpin every multi-candle pattern. A bug in one of these skews
 * EVERY pattern score, so pin them directly.
 *
 *   tsx --test test/features.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  bodyHigh,
  bodyLow,
  overlapsBody,
  clamp01,
  scoreGreater,
  scoreLess,
} from "../src/features.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bar = (open: number, close: number): any => ({
  open,
  close,
  high: Math.max(open, close),
  low: Math.min(open, close),
  time: 0,
});

test("clamp01 clamps to [0,1]", () => {
  assert.equal(clamp01(-0.5), 0);
  assert.equal(clamp01(0.3), 0.3);
  assert.equal(clamp01(1.5), 1);
});

test("bodyHigh/bodyLow are open/close max/min, direction-independent", () => {
  assert.equal(bodyHigh(bar(10, 12)), 12); // bull
  assert.equal(bodyLow(bar(10, 12)), 10);
  assert.equal(bodyHigh(bar(12, 10)), 12); // bear — same body, drawn the other way
  assert.equal(bodyLow(bar(12, 10)), 10);
});

test("overlapsBody detects real-body overlap (inclusive at the touch point)", () => {
  assert.equal(overlapsBody(bar(10, 12), bar(11, 13)), true); // overlapping
  assert.equal(overlapsBody(bar(10, 12), bar(20, 22)), false); // disjoint
  assert.equal(overlapsBody(bar(10, 12), bar(12, 14)), true); // touching at 12
});

test("scoreGreater ramps 0→1 between threshold and fullAt", () => {
  assert.equal(scoreGreater(5, 5, 10), 0); // at threshold → 0
  assert.equal(scoreGreater(4, 5, 10), 0); // below → 0
  assert.equal(scoreGreater(10, 5, 10), 1); // at fullAt → 1
  assert.equal(scoreGreater(7.5, 5, 10), 0.5); // midpoint
  assert.equal(scoreGreater(8, 5, 5), 1); // degenerate fullAt<=threshold → 1
});

test("scoreLess ramps 1→0 between threshold and zeroAt", () => {
  assert.equal(scoreLess(5, 5, 10), 1); // at threshold → 1
  assert.equal(scoreLess(4, 5, 10), 1); // below → 1
  assert.equal(scoreLess(10, 5, 10), 0); // at zeroAt → 0
  assert.equal(scoreLess(7.5, 5, 10), 0.5); // midpoint
  assert.equal(scoreLess(8, 5, 5), 0); // degenerate zeroAt<=threshold → 0
});
