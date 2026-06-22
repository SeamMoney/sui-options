/**
 * Offline CI test for the in-browser LIVE verifier's pure core
 * (frontend/src/lib/liveVerify.ts). The /verify page's live mode is otherwise
 * only exercised by the Playwright e2e, which CI doesn't run (no browser) — so
 * without this, the signature replay+match logic has ZERO CI coverage. We test
 * it the way the module's own header promises ("unit-dogfooded via tsx"): feed
 * synthetic records built FROM the byte-identical expandSegment and assert an
 * honest chain matches, a tampered one is caught, and decodeWalk round-trips.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// Import the seeded-path helpers from source (the proven scripts pattern, as in
// verify-v4.ts) — tsx resolves the workspace .ts directly without the package's
// dist-only exports map.
import { newState, expandSegment } from "../sdk/src/seededPath.js";
import {
  replayAndMatch,
  decodeWalk,
  type LiveSegmentRecord,
} from "../frontend/src/lib/liveVerify.ts";

// Build N honest segment records from a seed: each record is exactly what the
// chain WOULD publish (extrema + carried state from expandSegment), so a
// correct verifier must report allMatch === true.
function honestChain(n: number) {
  const seed = newState(1_000_000_000n, 1n, 1_000_000_000n);
  let prev = seed;
  const records: LiveSegmentRecord[] = [];
  for (let i = 0; i < n; i++) {
    const key = new Uint8Array(32);
    key[0] = i + 1;
    key[31] = (i * 7 + 3) & 0xff; // vary the key so segments differ
    const r = expandSegment(prev, key);
    records.push({ k: i, key, min: r.min, max: r.max, stateAfter: r.newState });
    prev = r.newState;
  }
  return { seed, records };
}

test("honest live chain — every recomputed candle matches the chain", () => {
  const { seed, records } = honestChain(8);
  const { rows, allMatch } = replayAndMatch(seed, records);
  assert.equal(rows.length, 8);
  assert.equal(allMatch, true, "an honest chain must fully reproduce");
  for (const row of rows) {
    assert.equal(row.match, true);
    assert.equal(row.high, row.chainHigh);
    assert.equal(row.low, row.chainLow);
  }
});

test("tampered extremum is caught — that row fails, allMatch flips false", () => {
  const { seed, records } = honestChain(8);
  // Forge the chain-reported max on one segment (a dishonest house).
  const i = 3;
  const forged = records.map((r, idx) => (idx === i ? { ...r, max: r.max + 5_000_000n } : r));
  const { rows, allMatch } = replayAndMatch(seed, forged);
  assert.equal(allMatch, false, "a forged extremum must break the proof");
  assert.equal(rows[i]!.match, false, "the tampered segment must be the one flagged");
  assert.equal(rows.filter((r) => !r.match).length, 1, "only the tampered segment fails");
});

test("tampered carried state is caught (price drift breaks the chain)", () => {
  const { seed, records } = honestChain(6);
  const forged = records.map((r, idx) =>
    idx === 2 ? { ...r, stateAfter: { ...r.stateAfter, price: r.stateAfter.price + 1n } } : r,
  );
  const { allMatch, rows } = replayAndMatch(seed, forged);
  assert.equal(allMatch, false);
  assert.equal(rows[2]!.match, false);
});

test("empty record set is vacuously consistent", () => {
  const seed = newState(1_000_000_000n, 1n, 1_000_000_000n);
  const { rows, allMatch } = replayAndMatch(seed, []);
  assert.equal(rows.length, 0);
  assert.equal(allMatch, true);
});

test("decodeWalk round-trips an on-chain WalkState struct", () => {
  const fields = {
    price: "1234567890",
    momentum: { fields: { neg: true, mag: "42" } },
    vol_regime: "2",
    home: "1000000000",
    pattern_id: "0",
    candles_remaining: "5",
  };
  const w = decodeWalk(fields);
  assert.equal(w.price, 1234567890n);
  assert.equal(w.momentum.neg, true);
  assert.equal(w.momentum.mag, 42n);
  assert.equal(w.volRegime, 2n);
  assert.equal(w.home, 1_000_000_000n);
  assert.equal(w.candlesRemaining, 5n);
});
