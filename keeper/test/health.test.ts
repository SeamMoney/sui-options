/**
 * Tests for the keeper's /health liveness logic — what ops (and the demo
 * dashboard) read to know the keeper is alive and cranking. A bug here reports
 * a dead keeper as healthy (or vice versa) and hides an outage mid-demo. Pure:
 * `now` is injected so the sliding-window math is deterministic.
 *
 *   npx tsx --test keeper/test/health.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHealth, recordTick, summary } from "../src/health.js";

const BASE = {
  packageId: "0xpkg",
  network: "testnet",
  address: "0xkeeper",
};
const MIN = 60_000;

test("createHealth starts un-ticked with an empty error window", () => {
  const h = createHealth(BASE);
  assert.equal(h.lastTickMs, 0);
  assert.deepEqual(h.errorWindow, []);
  assert.equal(h.packageId, "0xpkg");
});

test("a fresh (never-ticked) keeper reports ok (it just booted)", () => {
  const h = createHealth(BASE);
  const s = summary(h, 5 * MIN);
  assert.equal(s.ok, true);
  assert.equal(s.last_tick_ms, 0);
  assert.equal(s.errors_last_5m, 0);
});

test("ok flips false once the last tick is older than 60s", () => {
  const h = createHealth(BASE);
  recordTick(h, 100 * MIN, 0);
  assert.equal(summary(h, 100 * MIN + 59_000).ok, true, "59s stale → still ok");
  assert.equal(summary(h, 100 * MIN + 60_000).ok, false, "60s stale → not ok");
});

test("recordTick only records failures, and updates last tick each time", () => {
  const h = createHealth(BASE);
  recordTick(h, 10 * MIN, 0);
  assert.equal(h.errorWindow.length, 0, "a clean tick records no error");
  assert.equal(h.lastTickMs, 10 * MIN);
  recordTick(h, 11 * MIN, 3);
  assert.equal(h.lastTickMs, 11 * MIN);
  assert.equal(summary(h, 11 * MIN).errors_last_5m, 3);
});

test("errors_last_5m only counts the trailing 5-minute window", () => {
  const h = createHealth(BASE);
  recordTick(h, 0, 2); // old
  recordTick(h, 4 * MIN, 5); // within 5m of t=4m..9m
  // At t = 6 min, the t=0 errors are 6 min old (outside 5m) and pruned/ignored.
  const s = summary(h, 6 * MIN);
  assert.equal(s.errors_last_5m, 5, "only the in-window failures count");
});

test("recordTick prunes error entries older than the 5-minute window", () => {
  const h = createHealth(BASE);
  recordTick(h, 0, 1);
  recordTick(h, 2 * MIN, 1);
  // A tick at t=6m has cutoff t=1m, so the t=0 entry is dropped, t=2m kept.
  recordTick(h, 6 * MIN, 0);
  assert.equal(h.errorWindow.length, 1);
  assert.equal(h.errorWindow[0]!.tsMs, 2 * MIN);
});
