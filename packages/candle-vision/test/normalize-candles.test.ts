// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// normalizeCandles is the feature-extraction step every candle-pattern detector
// runs on first — body %, wick %, close location, direction, ratios. The
// detectors are regression-tested as a whole, but the extraction itself was
// only pinned at the primitive level (#578). Pin the exact, hand-computable
// features for a textbook Marubozu and Doji, plus the structural invariants.
import test from "node:test";
import assert from "node:assert/strict";

import { normalizeCandles } from "../src/features.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const c = (o: number, h: number, l: number, cl: number): any => ({
  open: o,
  high: h,
  low: l,
  close: cl,
});

test("normalizeCandles: a bullish Marubozu → full body, no wicks, close at the top", () => {
  const [f] = normalizeCandles([c(100, 120, 100, 120)]);
  assert.equal(f.range, 20);
  assert.equal(f.body, 20);
  assert.equal(f.bodyPct, 1);
  assert.equal(f.upperWick, 0);
  assert.equal(f.lowerWick, 0);
  assert.equal(f.upperPct, 0);
  assert.equal(f.lowerPct, 0);
  assert.equal(f.closeLocation, 1);
  assert.equal(f.direction, "bullish");
  assert.equal(f.directionScore, 1);
});

test("normalizeCandles: a Doji → zero body, symmetric wicks, mid close, neutral", () => {
  const [f] = normalizeCandles([c(100, 110, 90, 100)]);
  assert.equal(f.range, 20);
  assert.equal(f.body, 0);
  assert.equal(f.bodyPct, 0);
  assert.equal(f.upperWick, 10);
  assert.equal(f.lowerWick, 10);
  assert.equal(f.upperPct, 0.5);
  assert.equal(f.lowerPct, 0.5);
  assert.equal(f.closeLocation, 0.5);
  assert.equal(f.direction, "neutral");
  assert.equal(f.directionScore, 0);
});

test("normalizeCandles: preserves the bar + index, handles empty input, fractions stay in [0,1]", () => {
  assert.deepEqual(normalizeCandles([]), []);

  const candles = [c(100, 120, 100, 120), c(120, 130, 119, 125)];
  const feats = normalizeCandles(candles);
  assert.equal(feats.length, 2);
  assert.equal(feats[0].index, 0);
  assert.equal(feats[1].index, 1);
  assert.equal(feats[0].open, 100); // original bar fields spread through
  assert.equal(feats[0].close, 120);
  for (const f of feats) {
    for (const p of [f.bodyPct, f.upperPct, f.lowerPct, f.closeLocation]) {
      assert.ok(p >= 0 && p <= 1, `fraction out of [0,1]: ${p}`);
    }
  }
});
