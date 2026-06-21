/**
 * Headless proof that the in-app verifier core is honest: the bundled synthetic
 * ride PASSes, every recomputed extremum matches the chain's claim, and a single
 * tampered extremum flips the verdict to FAIL. Run with:
 *   npx tsx --test frontend/test/verifyReplay.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SETTLEMENT_TOUCH_WIN } from "@wick/sdk";
import { runVerification, formatPrice } from "../src/lib/verifyReplay.ts";
import { buildSyntheticConfig } from "../src/lib/verifyFixture.ts";

test("honest synthetic ride PASSes verification", () => {
  const out = runVerification(buildSyntheticConfig());
  assert.equal(out.rows.length, 3, "three in-range segments");
  assert.equal(out.allExtremaMatch, true, "all extrema match the chain");
  assert.equal(out.touched, true, "barrier was touched");
  assert.equal(out.offchainKind, SETTLEMENT_TOUCH_WIN);
  assert.equal(out.verdictMatch, true);
  assert.equal(out.pass, true);
});

test("replayed extrema reproduce the documented CLI table", () => {
  const out = runVerification(buildSyntheticConfig());
  // These are the exact values scripts/verify.ts prints in mock://synthetic.
  assert.equal(formatPrice(out.rows[0]!.high), "1023.86");
  assert.equal(formatPrice(out.rows[0]!.low), "989.81");
  assert.equal(formatPrice(out.rows[1]!.high), "1028.49");
  assert.equal(formatPrice(out.rows[2]!.high), "1074.05");
  assert.equal(formatPrice(out.rows[2]!.close), "1059.14");
});

test("tampered chain extrema FAIL verification", () => {
  const out = runVerification(buildSyntheticConfig({ tamper: true }));
  assert.equal(out.allExtremaMatch, false, "tamper breaks an extremum");
  assert.equal(out.pass, false, "a dishonest house cannot pass");
  // The tamper is on the final segment; the first two still match.
  assert.equal(out.rows[0]!.extremaMatch, true);
  assert.equal(out.rows[2]!.extremaMatch, false);
});
