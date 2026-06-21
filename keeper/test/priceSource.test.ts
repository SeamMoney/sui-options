/**
 * Tests for scalePrice — the keeper converts an off-chain USD quote into the
 * fixed-point integer it pushes to the on-chain oracle. A rounding or decimals
 * bug here writes a WRONG price on-chain (every pull-oracle market then settles
 * against it), so the float→bigint contract gets pinned, including the
 * floating-point footguns it's defending against.
 *
 *   npx tsx --test keeper/test/priceSource.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { scalePrice } from "../src/price-source.js";

test("scales by 10^decimals", () => {
  assert.equal(scalePrice(1, 6), 1_000_000n);
  assert.equal(scalePrice(0.71, 6), 710_000n);
  assert.equal(scalePrice(64_000, 6), 64_000_000_000n);
  assert.equal(scalePrice(2.5, 9), 2_500_000_000n);
});

test("rounds half-up to the nearest integer unit", () => {
  // 1.2345675 * 1e6 = 1234567.5 → 1234568 (round half up)
  assert.equal(scalePrice(1.2345675, 6), 1_234_568n);
  // a sub-unit fraction rounds to the nearest unit, never truncates blindly
  assert.equal(scalePrice(0.0000004, 6), 0n); // 0.4 units → 0
  assert.equal(scalePrice(0.0000006, 6), 1n); // 0.6 units → 1
});

test("handles zero and defends against float representation error", () => {
  assert.equal(scalePrice(0, 6), 0n);
  // 0.1 + 0.2 famously != 0.3 in IEEE-754; scaled to micro-units it must still
  // land on a clean integer (Math.round defends the boundary).
  assert.equal(scalePrice(0.1 + 0.2, 6), 300_000n);
});

test("decimals = 0 yields whole units", () => {
  assert.equal(scalePrice(42.7, 0), 43n);
  assert.equal(scalePrice(42.4, 0), 42n);
});

test("always returns a bigint", () => {
  assert.equal(typeof scalePrice(1.23, 6), "bigint");
});
