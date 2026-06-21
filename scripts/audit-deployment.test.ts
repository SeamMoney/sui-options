/**
 * Offline tests for audit-deployment's per-market verdict classification — the
 * PASS/FAIL/EMPTY a judge reads for every live market. It parses verify-v4's
 * stdout, so a brittle regex (or treating an idle market as a failure, or a
 * crashed verifier as a pass) would mislead. Pinned without spawning verify-v4.
 *
 *   npx tsx --test scripts/audit-deployment.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifyVerifyOutput } from "./audit-deployment.ts";

const HONEST = `network:  https://x
market:   0xabc
segments: 627 recorded · deadband 20bps · round 75 seg

extrema replay: match — all 6 segments reproduce from the chain's own keys

PASS — the chain was honest.`;

test("an honest run that exited 0 → PASS, with the segment count", () => {
  const r = classifyVerifyOutput(HONEST, true, "M", "0xabc");
  assert.equal(r.status, "PASS");
  assert.equal(r.segments, "627");
});

test("a market with no segments → EMPTY (idle, not a failure)", () => {
  const out = "segments: 0 recorded · ...\n\nNo segments in range — nothing to verify.";
  const r = classifyVerifyOutput(out, true, "M", "0xabc");
  assert.equal(r.status, "EMPTY");
  assert.equal(r.segments, "0");
});

test("the honest verdict but a non-zero exit → FAIL (don't trust a crashed run)", () => {
  assert.equal(classifyVerifyOutput(HONEST, false, "M", "0xabc").status, "FAIL");
});

test("a tampered/failed run → FAIL", () => {
  const out = "segments: 627 recorded · ...\nextrema replay: MISMATCH\n\nFAIL — the chain lied.";
  const r = classifyVerifyOutput(out, true, "M", "0xabc");
  assert.equal(r.status, "FAIL");
  assert.equal(r.segments, "627");
});

test("an unreachable market (no parseable output) → FAIL with unknown segments", () => {
  const r = classifyVerifyOutput("Could not find ...\n", false, "M", "0xabc");
  assert.equal(r.status, "FAIL");
  assert.equal(r.segments, "?");
});

test("the PASS line must be the honest one — a stray 'PASS' elsewhere doesn't count", () => {
  const out = "segments: 5 recorded\nPASS something unrelated\n\nFAIL — the chain lied.";
  assert.equal(classifyVerifyOutput(out, true, "M", "0xabc").status, "FAIL");
});
