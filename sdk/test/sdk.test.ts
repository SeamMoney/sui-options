/**
 * Unit regression suite for the @wick/sdk pure math the UI and verifiers depend
 * on. The seeded-path *walk* is proven byte-identical to Move by the 10k-vector
 * conformance harness; this locks the surrounding helpers that conformance does
 * NOT cover — unit conversions, the CPMM payout mirror, the sign-magnitude
 * arithmetic, and the v4 drift-regime classification.
 *
 *   npx tsx --test sdk/test/sdk.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  MIST_PER_SUI,
  mistToSui,
  suiToMist,
  shortAddr,
  impliedTouchPrice,
  cpmmOut,
} from "../src/format.js";
import {
  sNew,
  sZero,
  sAdd,
  sSub,
  sMulDiv,
  sClampMag,
  keystreamWord,
  draw,
  regimeDriftForRound,
  applyCumulativeDrift,
  REGIME_RANGE,
  REGIME_TREND_UP,
  REGIME_TREND_DOWN,
  REGIME_DRIFT_BPS_PER_SEG,
} from "../src/seededPath.js";

// ── format.ts ────────────────────────────────────────────────────────────────

test("mist/sui conversions round-trip whole and fractional SUI", () => {
  assert.equal(MIST_PER_SUI, 1_000_000_000n);
  assert.equal(mistToSui(1_000_000_000n), 1);
  assert.equal(mistToSui(2_500_000_000n), 2.5);
  assert.equal(suiToMist(1), 1_000_000_000n);
  assert.equal(suiToMist(0.000_000_001), 1n);
  assert.equal(mistToSui(suiToMist(3.25)), 3.25);
});

test("shortAddr truncates long addresses but passes short ones through", () => {
  const addr = "0x" + "ab".repeat(20);
  assert.equal(shortAddr(addr), "0xabab…abab");
  assert.equal(shortAddr(addr, 6, 6), "0xababab…ababab");
  // Already short enough → unchanged.
  assert.equal(shortAddr("0x1234"), "0x1234");
});

test("impliedTouchPrice is the no-touch share, halving on an empty book", () => {
  assert.equal(impliedTouchPrice(0, 0), 0.5);
  assert.equal(impliedTouchPrice(100, 100), 0.5);
  assert.equal(impliedTouchPrice(25, 75), 0.75);
  assert.equal(impliedTouchPrice(75, 25), 0.25);
});

test("cpmmOut mirrors the constant-product mirror: fee, monotonicity, floor", () => {
  // Zero / negative input yields nothing.
  assert.equal(cpmmOut(0, 1000, 1000, 30), 0);
  assert.equal(cpmmOut(-5, 1000, 1000, 30), 0);
  // No-fee exact value: floor(1000 * 100 / (1000 + 100)) = floor(90.909) = 90.
  assert.equal(cpmmOut(100, 1000, 1000, 0), 90);
  // A fee can only reduce (or hold) output vs. no fee.
  const noFee = cpmmOut(100, 1000, 1000, 0);
  const withFee = cpmmOut(100, 1000, 1000, 30);
  assert.ok(withFee <= noFee, "fee must not increase output");
  // Output is monotonic non-decreasing in input size.
  assert.ok(cpmmOut(200, 1000, 1000, 30) >= cpmmOut(100, 1000, 1000, 30));
  // Output never exceeds the output reserve.
  assert.ok(cpmmOut(10_000_000, 1000, 1000, 30) < 1000);
});

// ── seededPath.ts — sign-magnitude arithmetic ────────────────────────────────

test("sNew canonicalises negative zero to non-negative", () => {
  assert.deepEqual(sNew(true, 0n), { neg: false, mag: 0n });
  assert.deepEqual(sZero(), { neg: false, mag: 0n });
  assert.deepEqual(sNew(true, 5n), { neg: true, mag: 5n });
});

test("sAdd/sSub respect signs and magnitudes", () => {
  assert.deepEqual(sAdd(sNew(false, 3n), sNew(false, 4n)), { neg: false, mag: 7n });
  assert.deepEqual(sAdd(sNew(true, 3n), sNew(false, 4n)), { neg: false, mag: 1n });
  assert.deepEqual(sAdd(sNew(false, 3n), sNew(true, 4n)), { neg: true, mag: 1n });
  // a - a == +0 (canonical).
  assert.deepEqual(sSub(sNew(true, 9n), sNew(true, 9n)), { neg: false, mag: 0n });
});

test("sMulDiv carries sign and floors; sClampMag bounds magnitude", () => {
  assert.deepEqual(sMulDiv(sNew(true, 10n), 3n, 4n), { neg: true, mag: 7n }); // floor(30/4)=7
  assert.deepEqual(sClampMag(sNew(true, 100n), 40n), { neg: true, mag: 40n });
  assert.deepEqual(sClampMag(sNew(false, 5n), 40n), { neg: false, mag: 5n });
});

// ── seededPath.ts — keystream ────────────────────────────────────────────────

test("keystreamWord is deterministic and draw stays in [0, 1e6)", () => {
  const key = new Uint8Array(32).fill(7);
  const a = keystreamWord(key, 0);
  const b = keystreamWord(key, 0);
  assert.equal(a, b, "same (key, n) → same word");
  assert.notEqual(keystreamWord(key, 1), a, "different counter → different word");
  for (let n = 0; n < 200; n++) {
    const d = draw(key, n);
    assert.ok(d >= 0n && d < 1_000_000n, `draw ${d} out of range`);
  }
});

// ── seededPath.ts — v4 drift regime (mirror of segment_market_v4) ─────────────

test("regimeDriftForRound is deterministic and reaches all three regimes", () => {
  const market = "0x" + "11".repeat(32);
  const a = regimeDriftForRound(market, 0n);
  const b = regimeDriftForRound(market, 0n);
  assert.deepEqual(a, b, "pure: same inputs → same regime");

  const kinds = new Set<number>();
  for (let r = 0n; r < 60n; r++) kinds.add(regimeDriftForRound(market, r).kind);
  assert.ok(kinds.has(REGIME_RANGE), "RANGE should appear");
  assert.ok(kinds.has(REGIME_TREND_UP), "TREND_UP should appear");
  assert.ok(kinds.has(REGIME_TREND_DOWN), "TREND_DOWN should appear");

  // Shape invariants: RANGE has zero drift; trends carry the per-seg bps.
  for (let r = 0n; r < 30n; r++) {
    const d = regimeDriftForRound(market, r);
    if (d.kind === REGIME_RANGE) assert.equal(d.magBps, 0n);
    else assert.equal(d.magBps, REGIME_DRIFT_BPS_PER_SEG);
    assert.equal(d.neg, d.kind === REGIME_TREND_DOWN);
  }
});

test("applyCumulativeDrift shifts by magBps*segOffset and saturates at 1", () => {
  const base = 1_000_000_000n; // $1000.00 in micro-USD
  // RANGE / zero offset → identity.
  assert.equal(applyCumulativeDrift(base, { kind: REGIME_RANGE, neg: false, magBps: 0n }, 5n), base);
  assert.equal(
    applyCumulativeDrift(base, { kind: REGIME_TREND_UP, neg: false, magBps: 50n }, 0n),
    base,
  );
  // Up 50bps × 4 segments = +2.0% → 1_020_000_000.
  assert.equal(
    applyCumulativeDrift(base, { kind: REGIME_TREND_UP, neg: false, magBps: 50n }, 4n),
    1_020_000_000n,
  );
  // Down 50bps × 4 = -2.0% → 980_000_000.
  assert.equal(
    applyCumulativeDrift(base, { kind: REGIME_TREND_DOWN, neg: true, magBps: 50n }, 4n),
    980_000_000n,
  );
  // Extreme down trend saturates at 1 rather than underflowing.
  const sat = applyCumulativeDrift(10n, { kind: REGIME_TREND_DOWN, neg: true, magBps: 50n }, 100_000n);
  assert.equal(sat, 1n);
});
