/**
 * Render tests for the CandleVision React layer — the coach UI the /pro and
 * /coach screens mount. Detection logic lives in @sui-options/candle-vision
 * (tested there); these lock the *rendering*: real detected patterns flow
 * through ranking into <SignalList> / <PatternStatsPanel> and produce the
 * expected markup. Uses react-dom/server's renderToStaticMarkup — no jsdom.
 *
 *   npm -w @sui-options/candle-vision-react test
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SignalList, PatternStatsPanel, scanCandles } from "../src/index.js";
import { detectCandlePatterns } from "@sui-options/candle-vision";

/** A textbook bullish marubozu after a small dip — yields ≥1 strong signal. */
function strongEvents() {
  const base = Array.from({ length: 4 }, (_, i) => {
    const c = 100 - i * 0.25;
    return { time: i + 1, open: c + 0.15, high: c + 1, low: c - 1, close: c, volume: 100 };
  });
  return detectCandlePatterns([...base, { time: 5, open: 99, high: 105.05, low: 98.95, close: 105, volume: 170 }], {
    minConfidence: 0.5,
  });
}

test("SignalList: no signals → renders the empty state, not a crash", () => {
  const html = renderToStaticMarkup(React.createElement(SignalList, { signals: [] }));
  assert.match(html, /No pattern signals/);
});

test("SignalList: a custom empty-state string is honored", () => {
  const html = renderToStaticMarkup(React.createElement(SignalList, { signals: [], emptyState: "Scanning…" }));
  assert.match(html, /Scanning…/);
});

test("SignalList: detected events render signal rows with a label", () => {
  const html = renderToStaticMarkup(React.createElement(SignalList, { events: strongEvents() }));
  assert.match(html, /<li/, "should render at least one signal <li>");
  assert.match(html, /<strong/, "each signal shows a bold label");
  assert.ok(html.length > 120, "populated list should have real content");
});

test("SignalList: maxItems caps the number of rows", () => {
  const events = strongEvents();
  const html = renderToStaticMarkup(React.createElement(SignalList, { events, maxItems: 1 }));
  const rows = (html.match(/<li/g) ?? []).length;
  assert.ok(rows <= 1, `maxItems:1 should render ≤1 row, got ${rows}`);
});

test("PatternStatsPanel: renders stat rows from detected events, no crash", () => {
  const html = renderToStaticMarkup(React.createElement(PatternStatsPanel, { events: strongEvents() }));
  assert.ok(html.length > 40, "should render a stats panel with content");
});

test("PatternStatsPanel: empty events render cleanly (no throw)", () => {
  const html = renderToStaticMarkup(React.createElement(PatternStatsPanel, { events: [] }));
  assert.equal(typeof html, "string");
});

// ── scanCandles: the pure scan→rank→stats core (no React) ───────────────────

function strongCandles() {
  const base = Array.from({ length: 4 }, (_, i) => {
    const c = 100 - i * 0.25;
    return { time: i + 1, open: c + 0.15, high: c + 1, low: c - 1, close: c, volume: 100 };
  });
  return [...base, { time: 5, open: 99, high: 105.05, low: 98.95, close: 105, volume: 170 }];
}

test("scanCandles: empty input → zeroed stats, no events", () => {
  const r = scanCandles([]);
  assert.equal(r.events.length, 0);
  assert.equal(r.stats.total, 0);
  assert.equal(r.stats.bullish, 0);
  assert.equal(r.stats.averageConfidence, 0); // guarded divide-by-zero
  assert.equal(r.visibleSignals.length, 0);
});

test("scanCandles: stats are internally consistent with the detected events", () => {
  const r = scanCandles(strongCandles());
  assert.ok(r.events.length > 0, "a strong bullish setup should detect ≥1 event");
  // total counts every event; direction buckets partition it exactly
  assert.equal(r.stats.total, r.events.length);
  assert.equal(r.stats.bullish + r.stats.bearish + r.stats.neutral, r.events.length);
  // averages are real probabilities in [0,1]
  assert.ok(r.stats.averageConfidence > 0 && r.stats.averageConfidence <= 1);
  // the bundled visibleSignals mirror the ranking's visible set
  assert.equal(r.visibleSignals.length, r.ranking.visible.length);
  assert.equal(r.stats.visible, r.ranking.visible.length);
});

test("scanCandles: a bullish marubozu is counted bullish", () => {
  const r = scanCandles(strongCandles());
  assert.ok(r.stats.bullish >= 1, "the bullish marubozu should land in the bullish bucket");
});
