/**
 * Tests for the SDK's candlestick pattern detector (`patterns.ts`) — the engine
 * behind the live chart's pattern-glow overlay. 1600+ lines of pure predicates
 * had zero test coverage. These use threshold-independent candles (a zero-body
 * candle IS a doji for any sane threshold; a full-body no-wick candle IS a
 * marubozu) so they pin the classification + the detect/offset plumbing without
 * coupling to the exact bps constants.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { isDoji, isMarubozu, detectPatterns } from "../src/patterns.js";
import type { Candle } from "../src/seededPath.js";

const c = (o: number, h: number, l: number, cl: number): Candle => ({
  open: BigInt(o),
  high: BigInt(h),
  low: BigInt(l),
  close: BigInt(cl),
});

// A zero-body candle (open == close) with a real range is unambiguously a doji.
const DOJI = c(100, 110, 90, 100);
// open == low, close == high → full body, no wicks → unambiguously a marubozu.
const MARUBOZU = c(100, 120, 100, 120);
// open == high == low == close → zero range, not a pattern.
const FLAT = c(100, 100, 100, 100);

test("isDoji matches a zero-body candle with range", () => {
  const m = isDoji([DOJI], 0);
  assert.ok(m, "zero-body candle should be a doji");
  assert.equal(m!.name, "Doji");
});

test("isDoji rejects a full-body candle", () => {
  assert.equal(isDoji([MARUBOZU], 0), null);
});

test("isDoji rejects a zero-range candle (no range to judge)", () => {
  assert.equal(isDoji([FLAT], 0), null);
});

test("isMarubozu matches a full-body no-wick candle", () => {
  const m = isMarubozu([MARUBOZU], 0);
  assert.ok(m, "full-body no-wick candle should be a marubozu");
  assert.equal(m!.name, "Marubozu");
});

test("isMarubozu rejects a doji (body too small)", () => {
  assert.equal(isMarubozu([DOJI], 0), null);
});

test("a predicate returns null for an out-of-range offset", () => {
  assert.equal(isDoji([DOJI], 5), null); // offset past the window
});

test("detectPatterns surfaces the doji in a window", () => {
  const matches = detectPatterns([DOJI]);
  assert.ok(
    matches.some((m) => m.name === "Doji"),
    "detectPatterns should include the Doji",
  );
});

test("detectPatterns on an empty window returns no matches (no crash)", () => {
  assert.deepEqual(detectPatterns([]), []);
});
