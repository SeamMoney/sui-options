/**
 * Offline tests for the vault-solvency proof's pure logic — the solvency
 * verdict and the figures it shows a judge. A regression here would either
 * cry "insolvent" on a healthy vault (false alarm, mid-demo) or pass an
 * actually-broke one, so the invariant + the denom/format math are pinned.
 *
 *   npx tsx --test scripts/vault-solvency.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isSolvent, denom, human, asBig } from "./vault-solvency.ts";

test("isSolvent: liquid reserves must cover the whole claim queue", () => {
  // treasury + side_bucket ≥ queue_total
  assert.equal(isSolvent(100n, 0n, 0n), true);
  assert.equal(isSolvent(100n, 50n, 150n), true, "exactly covered is solvent");
  assert.equal(isSolvent(100n, 50n, 151n), false, "one short of the queue is insolvent");
  assert.equal(isSolvent(0n, 0n, 1n), false);
  assert.equal(isSolvent(0n, 0n, 0n), true, "empty vault with no claims is trivially solvent");
});

test("denom maps the deployed collaterals to decimals + ticker", () => {
  assert.deepEqual(denom("0x2::sui::SUI"), { decimals: 9, ticker: "SUI" });
  assert.deepEqual(denom("0xabc::tusd::TUSD"), { decimals: 6, ticker: "TUSD" });
  // Unknown collateral → raw units, ticker from the last type segment.
  assert.deepEqual(denom("0xdef::wbtc::WBTC"), { decimals: 0, ticker: "WBTC" });
});

test("human renders fixed-point reserves at the right decimals", () => {
  assert.equal(human(1_000_000_000n, 9), "1"); // 1 SUI
  assert.equal(human(2_500_000_000n, 9), "2.5");
  assert.equal(human(100_000_079_568_439n, 6), "100000079.5684"); // ~100M TUSD, trimmed to 4dp
  assert.equal(human(0n, 9), "0");
  assert.equal(human(42n, 0), "42"); // decimals=0 → raw
});

test("asBig parses bigint/number/string and Balance object shapes", () => {
  assert.equal(asBig(5n), 5n);
  assert.equal(asBig(7), 7n);
  assert.equal(asBig("123"), 123n);
  assert.equal(asBig(""), 0n);
  assert.equal(asBig(undefined), 0n);
  // A Balance<C> can render as { fields: { value } } or { value }.
  assert.equal(asBig({ fields: { value: "999" } }), 999n);
  assert.equal(asBig({ value: 12 }), 12n);
});
