// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// createCandleVisionStream is the live /coach engine: it accumulates candles as
// they arrive, enforces a sliding maxCandles window, and re-scans on each
// update. If the window doesn't trim, memory/scan cost grows unbounded as the
// chart runs; if it trims wrong, the coach scans stale or missing candles. Pin
// accumulation, the sliding window, and replace/clear resets.
import test from "node:test";
import assert from "node:assert/strict";

import { createCandleVisionStream } from "../src/scanner.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const c = (o: number, h: number, l: number, cl: number): any => ({
  open: o,
  high: h,
  low: l,
  close: cl,
  time: 0,
});

test("the stream accumulates appended candles into getCandles + the snapshot", () => {
  const s = createCandleVisionStream();
  assert.deepEqual(s.getCandles(), []);
  assert.equal(s.snapshot().candles.length, 0);

  s.appendCandle(c(100, 110, 95, 105));
  const snap = s.appendCandle(c(105, 120, 100, 115));
  assert.equal(s.getCandles().length, 2);
  assert.equal(snap.candles.length, 2); // appendCandle returns the fresh snapshot
});

test("the stream enforces maxCandles as a sliding window (oldest drops)", () => {
  const s = createCandleVisionStream({ maxCandles: 2 });
  s.appendCandle(c(1, 1, 1, 1));
  s.appendCandle(c(2, 2, 2, 2));
  s.appendCandle(c(3, 3, 3, 3)); // pushes the first out
  assert.deepEqual(s.getCandles().map((k: { open: number }) => k.open), [2, 3]);
});

test("appendCandles also respects the window, and replace/clear reset it", () => {
  const s = createCandleVisionStream({ maxCandles: 3 });
  s.appendCandles([c(1, 1, 1, 1), c(2, 2, 2, 2), c(3, 3, 3, 3), c(4, 4, 4, 4)]);
  assert.deepEqual(s.getCandles().map((k: { open: number }) => k.open), [2, 3, 4]);

  s.replaceCandles([c(9, 9, 9, 9)]);
  assert.deepEqual(s.getCandles().map((k: { open: number }) => k.open), [9]);

  s.clearCandles();
  assert.deepEqual(s.getCandles(), []);
});
