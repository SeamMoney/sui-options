// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// createPatternDefinition is what turns a catalog entry into a full pattern
// definition — it COMPUTES category (from family) and minBars (from the
// pattern's candle count), which drive how the /coach classifies and how many
// bars a detector needs. The registry test only checks a definition resolves;
// this pins the computed metadata, and that overrides win.
import test from "node:test";
import assert from "node:assert/strict";

import { createPatternDefinition } from "../src/registry.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const entry = (kind: string, family = "candlestick", direction = "bullish"): any => ({
  kind,
  family,
  direction,
  label: `L:${kind}`,
  description: `D:${kind}`,
});

test("createPatternDefinition computes category from the family + passes the entry through", () => {
  const def = createPatternDefinition(entry("marubozu", "candlestick"));
  assert.equal(def.category, "candlestick");
  assert.equal(def.kind, "marubozu");
  assert.equal(def.label, "L:marubozu");
  assert.equal(def.description, "D:marubozu");
  assert.equal(def.direction, "bullish");
});

test("createPatternDefinition computes minBars from the pattern's candle count", () => {
  assert.equal(createPatternDefinition(entry("marubozu")).minBars, 1); // single-candle
  assert.equal(createPatternDefinition(entry("engulfing")).minBars, 2); // two-candle
  assert.equal(createPatternDefinition(entry("morning-star")).minBars, 3); // three-candle
});

test("createPatternDefinition lets an explicit override win over the computed category", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = createPatternDefinition(entry("marubozu"), { category: "chart-pattern" } as any);
  assert.equal(def.category, "chart-pattern");
});
