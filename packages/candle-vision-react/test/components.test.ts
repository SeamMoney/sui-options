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

import { SignalList, PatternStatsPanel } from "../src/index.js";
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
