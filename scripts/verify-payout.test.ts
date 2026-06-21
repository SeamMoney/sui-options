/**
 * Unit tests for the v4 payout identity (`checkPayoutIdentity`) — the "money
 * audit" arithmetic that proves the chain paid the exact right amount.
 *
 * The constants below are real on-chain RideClosedV4 numbers from testnet
 * market 0x54e915…5282 (multiplier 17500 bps = 1.75×):
 *   TOUCH_WIN     stake_paid 150000 → payout 262500 (= ×1.75), forfeit 0
 *   CASHOUT       stake_paid 150000 → payout   6970, forfeit 143030
 *   EXPIRED_LOSS  stake_paid  20000 → payout      0, forfeit  20000  (MARKET HALT)
 *
 * Run:  npx tsx --test scripts/verify-payout.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkPayoutIdentity } from "./verify-payout.js";
import {
  isqrtU64,
  bachelierCashoutFactor,
  cashoutPayout,
  FACTOR_SCALE,
} from "./bachelier.js";

const MULT = 17_500n;

// ── Bachelier port — bit-identical to Move wick::ride_pricing ────────────────
test("isqrtU64 matches Move isqrt_u64 known values", () => {
  for (const [n, r] of [[0n, 0n], [1n, 1n], [4n, 2n], [9n, 3n], [100n, 10n], [99n, 9n], [101n, 10n]] as const) {
    assert.equal(isqrtU64(n), r, `isqrt(${n})`);
  }
});

test("bachelier factor = 1.0 at the barrier, 0 at zero seconds off-barrier", () => {
  assert.equal(bachelierCashoutFactor(100_000n, 100_000n, 50n, 300n), FACTOR_SCALE);
  assert.equal(bachelierCashoutFactor(95_000n, 100_000n, 50n, 0n), 0n);
});

test("bachelier factor decreases with distance and is ~symmetric", () => {
  const b = 100_000n, s = 50n, t = 300n;
  const atb = bachelierCashoutFactor(100_000n, b, s, t);
  const close = bachelierCashoutFactor(99_500n, b, s, t);
  const far = bachelierCashoutFactor(95_000n, b, s, t);
  assert.ok(atb >= close && close >= far && far < FACTOR_SCALE);
  const above = bachelierCashoutFactor(102_000n, b, s, t);
  const below = bachelierCashoutFactor(98_000n, b, s, t);
  const d = above > below ? above - below : below - above;
  assert.ok(d <= 100n, `symmetry within 100ppb, got ${d}`);
});

test("cashoutPayout reproduces the live on-chain CASHOUT (golden: 6970)", () => {
  // Real ride 0xbbfc31… on market 0x54e915…: stake 150000, spot = seg456
  // state_after.price 996352353, barriers [906435985, 1107866203], σ=100bps,
  // spread=200bps, 27s remaining → chain paid exactly 6970.
  const p = cashoutPayout(150_000n, 996_352_353n, 1_107_866_203n, 906_435_985n, 100n, 200n, 27n);
  assert.equal(p, 6_970n);
});

test("TOUCH_WIN: payout = stake_paid × multiplier, forfeit 0 (vault tops up, no conservation)", () => {
  assert.deepEqual(checkPayoutIdentity(1, 150_000n, 262_500n, 0n, MULT), []);
});

test("TOUCH_WIN with wrong multiplier payout is rejected", () => {
  assert.ok(checkPayoutIdentity(1, 150_000n, 262_499n, 0n, MULT).length > 0);
  // A win that also kept a forfeit is impossible.
  assert.ok(checkPayoutIdentity(1, 150_000n, 262_500n, 1n, MULT).length > 0);
});

test("CASHOUT: payout in (0, stake_paid], stake conserved", () => {
  assert.deepEqual(checkPayoutIdentity(2, 150_000n, 6_970n, 143_030n, MULT), []);
});

test("CASHOUT rejects a payout that breaks conservation or exceeds stake", () => {
  assert.ok(checkPayoutIdentity(2, 150_000n, 6_970n, 143_031n, MULT).length > 0); // sum != stake
  assert.ok(checkPayoutIdentity(2, 150_000n, 0n, 150_000n, MULT).length > 0); // payout must be > 0
});

test("EXPIRED_LOSS / MARKET HALT: payout 0, forfeit = stake_paid (not a satoshi more)", () => {
  assert.deepEqual(checkPayoutIdentity(3, 20_000n, 0n, 20_000n, MULT), []);
});

test("EXPIRED_LOSS crank-closed: forfeit + bounty (50bps) == stake_paid", () => {
  // A keeper-cranked expired ride: bounty = 20000 × 50/10000 = 100; forfeit = 19900.
  assert.deepEqual(checkPayoutIdentity(3, 20_000n, 0n, 19_900n, MULT, 100n), []);
  // Skimming a bigger bounty than the forfeit accounts for is rejected.
  assert.ok(checkPayoutIdentity(3, 20_000n, 0n, 19_900n, MULT, 200n).length > 0);
});

test("EXPIRED_LOSS that skimmed extra (payout>0 or forfeit>stake) is rejected", () => {
  assert.ok(checkPayoutIdentity(3, 20_000n, 1n, 19_999n, MULT).length > 0); // payout != 0
  assert.ok(checkPayoutIdentity(3, 20_000n, 0n, 20_001n, MULT).length > 0); // forfeit > stake_paid
});

test("ABORTED_REFUND: no stake consumed (payout 0, forfeit 0)", () => {
  assert.deepEqual(checkPayoutIdentity(4, 0n, 0n, 0n, MULT), []);
  assert.ok(checkPayoutIdentity(4, 0n, 0n, 5n, MULT).length > 0);
});
