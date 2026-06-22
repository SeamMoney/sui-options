/**
 * Unit tests for check:chart-live's freshness verdict — the pure core of the
 * "is the /ride chart actually moving?" liveness probe. The live RPC read around
 * it is exercised by `npm run check:chart-live`.
 *
 * Run: npx tsx --test scripts/check-chart-live.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifyFreshness } from "./check-chart-live.js";

const NOW = 1_000_000_000_000; // fixed "now" in ms

test("fresh segment (within window) → live", () => {
  const r = classifyFreshness(BigInt(NOW - 30_000), NOW, 180); // 30s ago
  assert.equal(r.live, true);
  assert.equal(r.ageSec, 30);
});

test("stale segment (beyond window) → frozen", () => {
  const r = classifyFreshness(BigInt(NOW - 600_000), NOW, 180); // 10 min ago
  assert.equal(r.live, false);
  assert.equal(r.ageSec, 600);
});

test("exactly at the window boundary → still live (<=)", () => {
  const r = classifyFreshness(BigInt(NOW - 180_000), NOW, 180);
  assert.equal(r.live, true);
});

test("zero / missing timestamp → not live (a bad read must not look fresh)", () => {
  const r = classifyFreshness(0n, NOW, 180);
  assert.equal(r.live, false);
  assert.equal(r.ageSec, Number.POSITIVE_INFINITY);
});

test("future timestamp (clock skew / bad read) → not live", () => {
  const r = classifyFreshness(BigInt(NOW + 60_000), NOW, 180);
  assert.equal(r.live, false);
});

test("custom max-age-sec is respected", () => {
  // 90s ago is live at 180s, frozen at 60s.
  assert.equal(classifyFreshness(BigInt(NOW - 90_000), NOW, 180).live, true);
  assert.equal(classifyFreshness(BigInt(NOW - 90_000), NOW, 60).live, false);
});
