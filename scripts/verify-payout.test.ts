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

const MULT = 17_500n;

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
