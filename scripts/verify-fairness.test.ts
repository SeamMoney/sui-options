/**
 * Unit tests for the Wick Pro commit-reveal fairness core (`scripts/pro-commit.ts`),
 * the /pro analogue of the /ride seeded-path / rug-roll / Bachelier golden vectors.
 *
 * verify:pro-fairness (the integration script) only proves the engine and the
 * verifier AGREE — it can't catch the two drifting together to a non-standard
 * hash. These tests pin the commit to:
 *   1. a GOLDEN external SHA-256 vector (real SHA-256, exact `${seed}:${paramsJson}`
 *      format — independent of pro-options), and
 *   2. CONFORMANCE: the live RoundEngine.commit equals the independent recompute
 *      of its own revealed (seed, paramsJson) — the binding the proof rests on.
 *
 * Run: `npx tsx --test scripts/verify-fairness.test.ts`
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { independentCommit } from "./pro-commit.js";
import { MARKET_PRESETS, RoundEngine, roundConfigFromPreset } from "../packages/pro-options/src/index";

test("independentCommit is real SHA-256 with the exact `seed:paramsJson` format (golden vector)", () => {
  // Externally reproducible: `printf '12345:{}' | sha256sum`.
  assert.equal(
    independentCommit(12345, "{}"),
    "f3941fc98b2dffa0efee7db98a8b0f7407c6979af7ba4dc351495485f41044bb",
  );
  // Matches a from-scratch SHA-256 of the same preimage for arbitrary inputs.
  const seed = 777, params = '{"drift":1,"vol":2}';
  assert.equal(independentCommit(seed, params), createHash("sha256").update(`${seed}:${params}`).digest("hex"));
  // Always a 64-hex-char digest.
  assert.match(independentCommit(0, ""), /^[0-9a-f]{64}$/);
});

test("independentCommit is tamper-sensitive: a different seed or params → different commit", () => {
  const p = '{"a":1}';
  assert.notEqual(independentCommit(100, p), independentCommit(101, p)); // seed off by one
  assert.notEqual(independentCommit(100, p), independentCommit(100, '{"a":2}')); // params changed
});

test("CONFORMANCE: every preset's RoundEngine.commit binds its own revealed seed+params", () => {
  // The whole proof rests on: published commit == SHA-256(revealed seed:params).
  // If the engine's commit format ever drifts from the verifier's, this breaks —
  // the integration script can't catch a synchronized drift, but this can.
  for (let i = 0; i < MARKET_PRESETS.length; i++) {
    const preset = MARKET_PRESETS[i];
    const engine = new RoundEngine(roundConfigFromPreset({ preset, seed: 0xc0ffee + i * 7919, startedAtMs: 1_000_000 }));
    const published = engine.commit;
    const revealed = engine.reveal();
    assert.equal(
      independentCommit(revealed.seed, revealed.paramsJson),
      published,
      `${preset.label}: independent SHA-256 of the reveal must equal the published commit`,
    );
    // And a seed off by one must NOT reproduce it (the commit binds THIS path).
    assert.notEqual(independentCommit(revealed.seed + 1, revealed.paramsJson), published);
  }
});
