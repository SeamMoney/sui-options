/**
 * Known-value tests for the barrier formula (`scripts/verify-barriers.ts`) — the
 * pure core that proves a round's TOUCH barriers were not cherry-picked. It must
 * reproduce Move `ensure_round_current` (`upper = spot + spot·offset_bps/10_000`,
 * `lower = max(spot − offset, 1)`) bit-for-bit, or verify-barriers mis-judges
 * honest barriers. The vectors are REAL: the spot/offset/barriers of actual
 * closed rides on the rugged market `0x54e91530…`, checked on-chain.
 *
 * Run: `npx tsx --test scripts/verify-barriers.test.ts`
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { barriersFromSpot } from "./verify-barriers.js";

test("reproduces real on-chain barriers (golden vectors, ±10% / 1000bps)", () => {
  // round 17, spot @ round-roll = state_after(1274).price
  let b = barriersFromSpot(1_000_176_620n, 1000n);
  assert.equal(b.upper, 1_100_194_282n, "round 17 upper");
  assert.equal(b.lower, 900_158_958n, "round 17 lower");

  // round 0, spot = home = 1_000_000_000 ($1000.00)
  b = barriersFromSpot(1_000_000_000n, 1000n);
  assert.equal(b.upper, 1_100_000_000n, "round 0 upper");
  assert.equal(b.lower, 900_000_000n, "round 0 lower");
});

test("offset scales with the bps and with spot", () => {
  // 0 bps → barriers collapse to spot
  let b = barriersFromSpot(1_000_000_000n, 0n);
  assert.equal(b.upper, 1_000_000_000n);
  assert.equal(b.lower, 1_000_000_000n);
  // 500 bps (±5%)
  b = barriersFromSpot(2_000_000_000n, 500n);
  assert.equal(b.upper, 2_100_000_000n);
  assert.equal(b.lower, 1_900_000_000n);
});

test("lower barrier floors at 1, never underflows below it", () => {
  // offset ≥ spot ⇒ lower clamps to 1 (mirrors Move `if (spot > offset) … else 1`)
  const b = barriersFromSpot(100n, 20_000n); // 200% offset
  assert.equal(b.lower, 1n);
  assert.equal(b.upper, 300n);
});

test("integer truncation matches Move (floor division)", () => {
  // 333 · 1234 / 10000 = 41.08… → 41 (floor)
  const b = barriersFromSpot(333n, 1234n);
  assert.equal(b.upper, 333n + 41n);
  assert.equal(b.lower, 333n - 41n);
});
