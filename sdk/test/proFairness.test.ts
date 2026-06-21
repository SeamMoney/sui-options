/**
 * Tests for the SDK's /pro commit-reveal verification primitive. Drives a REAL
 * pro-options round to get a genuine { commit, seed, paramsJson }, then confirms
 * verifyProRound binds an honest reveal, rejects a tampered one, and that the
 * @noble/hashes digest matches node:crypto (independence sanity).
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHash } from "node:crypto";

import { proRoundCommit, verifyProRound } from "../src/proFairness.js";
import { RoundEngine, roundConfigFromPreset, presetById } from "../../packages/pro-options/src/index.js";

const engine = new RoundEngine(roundConfigFromPreset({ preset: presetById("trending")!, seed: 4242, startedAtMs: 1_000_000 }));
const r = engine.reveal();

test("proRoundCommit matches the engine's published commit", () => {
  assert.equal(proRoundCommit(r.seed, r.paramsJson), engine.commit);
});

test("proRoundCommit equals node:crypto SHA-256 (independent impls agree)", () => {
  const expected = createHash("sha256").update(`${r.seed}:${r.paramsJson}`).digest("hex");
  assert.equal(proRoundCommit(r.seed, r.paramsJson), expected);
});

test("verifyProRound: honest reveal binds (case-insensitive)", () => {
  assert.equal(verifyProRound(engine.commit, r.seed, r.paramsJson), true);
  assert.equal(verifyProRound(engine.commit.toUpperCase(), r.seed, r.paramsJson), true);
});

test("verifyProRound: a tampered seed or params is rejected", () => {
  assert.equal(verifyProRound(engine.commit, r.seed + 1, r.paramsJson), false);
  assert.equal(verifyProRound(engine.commit, r.seed, r.paramsJson + " "), false);
});

test("verifyProRound: a malformed commit is rejected, not thrown", () => {
  assert.equal(verifyProRound("not-a-hash", r.seed, r.paramsJson), false);
  assert.equal(verifyProRound("", r.seed, r.paramsJson), false);
});

test("known FIPS vector routes through correctly", () => {
  // SHA-256("0:") with seed 0 and empty paramsJson — cross-check against node.
  assert.equal(proRoundCommit(0, ""), createHash("sha256").update("0:").digest("hex"));
});
