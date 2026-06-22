// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// decideTradeFromSignals is the /coach's actionable recommendation (buy/sell/
// hold from the ranked pattern signals). Its two no-trade paths are what the
// coach shows most of the time — when there's no data yet, or no ranked signal
// — and they must safely resolve to "hold / No trade", never a spurious
// buy/sell. Pin those (the with-signal paths run through the detector pipeline
// in the regression suite).
import test from "node:test";
import assert from "node:assert/strict";

import { decideTradeFromSignals } from "../src/trade-decision.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const c = (o: number, h: number, l: number, cl: number): any => ({
  open: o,
  high: h,
  low: l,
  close: cl,
  time: 0,
});

test("decideTradeFromSignals: no candles → No trade / hold / insufficient_data", () => {
  const r = decideTradeFromSignals([], []);
  assert.equal(r.decision.status, "no-signal");
  assert.equal(r.decision.action, "hold");
  assert.equal(r.decision.side, "none");
  assert.equal(r.decision.label, "No trade");
  assert.equal(r.decision.confidence, 0);
  assert.ok(
    r.decision.reasons.some((x) => x.code === "insufficient_data"),
    JSON.stringify(r.decision.reasons),
  );
  assert.deepEqual(r.decisions, []);
});

test("decideTradeFromSignals: candles but no signals → No trade / hold / no_ranked_signal", () => {
  const candles = [c(100, 101, 99, 100), c(100, 102, 99, 101)];
  const r = decideTradeFromSignals([], candles);
  assert.equal(r.decision.status, "no-signal");
  assert.equal(r.decision.action, "hold");
  assert.equal(r.decision.side, "none");
  assert.ok(
    r.decision.reasons.some((x) => x.code === "no_ranked_signal"),
    JSON.stringify(r.decision.reasons),
  );
  assert.deepEqual(r.decisions, []);
});

test("decideTradeFromSignals always returns a well-formed result envelope", () => {
  const r = decideTradeFromSignals([], []);
  assert.ok(r.decision, "has a top decision");
  assert.ok(Array.isArray(r.decisions), "has a decisions array");
  assert.ok(r.ranking, "has a ranking");
});
