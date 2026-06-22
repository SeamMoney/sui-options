// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// eventCandleRange computes the low/high a detected pattern spans — the price
// box the /coach chart draws to highlight the pattern's candles. If the range
// is wrong the overlay sits over the wrong prices. It was untested; pin that it
// returns the min-low / max-high across exactly the event's candle span.
import test from "node:test";
import assert from "node:assert/strict";

import { eventCandleRange } from "../src/detectors.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const c = (o: number, h: number, l: number, cl: number): any => ({
  open: o,
  high: h,
  low: l,
  close: cl,
});

test("eventCandleRange spans the min-low / max-high over the event's candles", () => {
  const candles = [
    c(100, 110, 95, 105), // 0
    c(105, 120, 100, 115), // 1 — highest high (120)
    c(115, 118, 90, 100), // 2 — lowest low (90)
    c(100, 112, 98, 108), // 3
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const range = eventCandleRange(candles, { startIndex: 1, endIndex: 2 } as any);
  assert.equal(range.high, 120); // max high over candles [1,2]
  assert.equal(range.low, 90); // min low over candles [1,2]
});

test("eventCandleRange for a single-candle event is that candle's low/high", () => {
  const candles = [c(100, 110, 95, 105), c(105, 120, 100, 115)];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const range = eventCandleRange(candles, { startIndex: 1, endIndex: 1 } as any);
  assert.equal(range.high, 120);
  assert.equal(range.low, 100);
});

test("eventCandleRange ignores candles outside the event span", () => {
  const candles = [
    c(100, 999, 1, 105), // 0 — extreme high/low, but OUTSIDE the event
    c(105, 110, 100, 108), // 1
    c(108, 112, 104, 109), // 2
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const range = eventCandleRange(candles, { startIndex: 1, endIndex: 2 } as any);
  assert.equal(range.high, 112); // candle 0's 999 is excluded
  assert.equal(range.low, 100); // candle 0's 1 is excluded
});
