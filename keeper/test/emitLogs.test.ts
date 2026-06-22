// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// emitLogs is the keeper's structured-logging output: one NDJSON line per action
// event, then a tick-summary line with the per-tick counts. An operator (or a
// judge watching the keeper) reads these to confirm the chart is being cranked
// and to spot failures, so the shape is load-bearing. Pin the per-event lines
// and the summary's count fields.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { emitLogs } from "../src/keeper.js";

function captureLogs(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console.log;
  // eslint-disable-next-line no-console, @typescript-eslint/no-explicit-any
  console.log = (...args: any[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

test("emitLogs prints one NDJSON line per event then a tick-summary with the counts", () => {
  const result = {
    startedAtMs: 0,
    finishedAtMs: 10,
    durationMs: 10,
    actions: 2,
    succeeded: 1,
    skippedIdempotent: 0,
    failed: 1,
    events: [
      { ts: "t1", level: "info", action: "rw-tick+record", market_id: "0xm" },
      { ts: "t2", level: "error", action: "lock-and-settle", market_id: "0xm2", error: "boom" },
    ],
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lines = captureLogs(() => emitLogs(result as any));
  assert.equal(lines.length, 3); // 2 events + 1 summary

  assert.deepEqual(JSON.parse(lines[0]), result.events[0]);
  assert.deepEqual(JSON.parse(lines[1]), result.events[1]);

  const summary = JSON.parse(lines[2]);
  assert.equal(summary.action, "tick-summary");
  assert.equal(summary.actions, 2);
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.skipped_idempotent, 0);
  assert.equal(summary.failed, 1);
  assert.equal(summary.duration_ms, 10);
});

test("emitLogs on an empty tick prints just the tick-summary line", () => {
  const result = {
    startedAtMs: 0,
    finishedAtMs: 0,
    durationMs: 0,
    actions: 0,
    succeeded: 0,
    skippedIdempotent: 0,
    failed: 0,
    events: [],
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lines = captureLogs(() => emitLogs(result as any));
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).action, "tick-summary");
});
