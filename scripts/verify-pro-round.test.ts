/**
 * Unit tests for verify-pro-round's verdict logic (`checkRound`) — the CLI
 * independent re-verify of one /pro round.
 *
 * The constants are REAL values printed by `npm run play -- --seed 4242`
 * (which reveals seed 424242). If the engine's commit formula or the TS port
 * (scripts/pro-commit.ts) ever drifts, the HONEST case flips and this fails.
 *
 * Run:  npx tsx --test scripts/verify-pro-round.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkRound } from "./verify-pro-round.js";

const PARAMS =
  '{"startPrice":100,"sigmaAnnual":0.9,"driftAnnual":0,"rugChanceBps":80,"rugDownPct":0.05,"steps":90,"stepMs":1000,"yearsPerSecond":0.002}';
const COMMIT = "9f1f4d770354f2326407c1b432a4aeeded652fe14827d0aeba124dd2f14a9cfe";

test("a real play round verifies HONEST (commit reproduces from seed+params)", () => {
  const r = checkRound(COMMIT, 424242, PARAMS);
  assert.equal(r.ok, true);
  assert.equal(r.recomputed, COMMIT);
});

test("normalises a hand-pasted commit (surrounding whitespace + uppercase)", () => {
  assert.equal(checkRound(`  ${COMMIT.toUpperCase()}  `, 424242, PARAMS).ok, true);
});

test("a tampered seed does NOT match (house can't swap the path after the bet)", () => {
  assert.equal(checkRound(COMMIT, 424243, PARAMS).ok, false);
});

test("a tampered param does NOT match", () => {
  const tampered = PARAMS.replace('"sigmaAnnual":0.9', '"sigmaAnnual":0.5');
  assert.equal(checkRound(COMMIT, 424242, tampered).ok, false);
});
