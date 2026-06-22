/**
 * Unit tests for check:faucet-runway's runway verdict — the pure core of the
 * "can the faucet still fund judges?" probe. The live balance read around it is
 * exercised by `npm run check:faucet-runway`.
 *
 * Run: npx tsx --test scripts/check-faucet-runway.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifyRunway } from "./check-faucet-runway.js";

const SUI = 1_000_000_000n;
const DRIP = 2n * SUI; // 2 SUI/drip
const MIN = 20n * SUI; // 20 SUI floor

test("healthy balance → ok, drip count reported", () => {
  const r = classifyRunway(100n * SUI, DRIP, MIN);
  assert.equal(r.ok, true);
  assert.equal(r.drips, 50); // 100 / 2
});

test("exactly at the floor → ok (>=)", () => {
  assert.equal(classifyRunway(MIN, DRIP, MIN).ok, true);
});

test("just below the floor → not ok", () => {
  assert.equal(classifyRunway(MIN - 1n, DRIP, MIN).ok, false);
});

test("zero balance → not ok, zero drips", () => {
  const r = classifyRunway(0n, DRIP, MIN);
  assert.equal(r.ok, false);
  assert.equal(r.drips, 0);
});

test("drip count floors (partial drip not counted)", () => {
  // 5 SUI / 2 SUI = 2 full drips
  assert.equal(classifyRunway(5n * SUI, DRIP, MIN).drips, 2);
});
