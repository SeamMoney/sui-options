// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// scanCandleVision is the live /coach pipeline (candles → detect → rank →
// stats), and computeCandleVisionStats produces the bullish/bearish/confidence
// numbers the coach UI shows. The detector itself is regression-tested, but the
// STATS aggregation was only ever exercised indirectly, never asserted. Pin its
// invariants so a counting/averaging regression can't silently show judges the
// wrong tally.
import test from "node:test";
import assert from "node:assert/strict";

import { scanCandleVision } from "../src/scanner.ts";

// A small OHLC series with a mix of strong-bodied and indecisive candles, so the
// detector emits several events across families/directions.
const candles = [
  { open: 100, high: 101, low: 99, close: 100.5, time: 1 },
  { open: 100.5, high: 106, low: 100.2, close: 105.8, time: 2 }, // strong bull
  { open: 105.8, high: 106.2, low: 100.1, close: 100.4, time: 3 }, // strong bear
  { open: 100.4, high: 100.6, low: 100.2, close: 100.4, time: 4 }, // doji-ish
  { open: 100.4, high: 104, low: 100.3, close: 103.5, time: 5 },
  { open: 103.5, high: 103.7, low: 98, close: 98.4, time: 6 },
  { open: 98.4, high: 102, low: 98.2, close: 101.7, time: 7 },
];

test("computeCandleVisionStats: the tallies are internally consistent", () => {
  const { events, stats, ranking } = scanCandleVision(candles);

  assert.equal(stats.total, events.length, "total == number of events");
  assert.equal(
    stats.bullish + stats.bearish + stats.neutral,
    stats.total,
    "every event is counted in exactly one direction",
  );

  const familySum = Object.values(stats.byFamily).reduce((a, b) => a + b, 0);
  const statusSum = Object.values(stats.byStatus).reduce((a, b) => a + b, 0);
  assert.equal(familySum, stats.total, "byFamily counts sum to total");
  assert.equal(statusSum, stats.total, "byStatus counts sum to total");

  assert.equal(stats.visible, ranking.visible.length, "visible mirrors the ranking");
  assert.ok(stats.visible <= stats.total, "visible can't exceed total");
});

test("computeCandleVisionStats: averages are well-formed", () => {
  const { stats } = scanCandleVision(candles);
  assert.ok(stats.averageConfidence >= 0 && stats.averageConfidence <= 1, "avg confidence in [0,1]");
  assert.ok(Number.isFinite(stats.averageStrength), "avg strength is finite");
});

test("computeCandleVisionStats: an empty input yields zeroed stats (no divide-by-zero)", () => {
  const { stats } = scanCandleVision([]);
  assert.equal(stats.total, 0);
  assert.equal(stats.bullish + stats.bearish + stats.neutral, 0);
  assert.equal(stats.averageConfidence, 0);
  assert.equal(stats.averageStrength, 0);
});
