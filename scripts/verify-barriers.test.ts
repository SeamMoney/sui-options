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
import { barriersFromSpot, roundRollSpotSource, sameId, readMarket, readRide } from "./verify-barriers.js";

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

test("roundRollSpotSource picks the right on-chain value (round-0 home vs round-N spot)", () => {
  // Round 0 is bootstrap-seeded from the home price (segment 0's `home` field).
  assert.deepEqual(roundRollSpotSource(0n, 75n), { segment: 0n, field: "home" });
  // Round N>0 uses state_after(N·dur − 1).price — the walk price at the roll.
  // (Round 17, dur 75 → segment 1274 — the exact value validated live in #335.)
  assert.deepEqual(roundRollSpotSource(17n, 75n), { segment: 1274n, field: "price" });
  assert.deepEqual(roundRollSpotSource(1n, 75n), { segment: 74n, field: "price" });
  assert.deepEqual(roundRollSpotSource(5n, 4n), { segment: 19n, field: "price" });
});

test("sameId normalizes 0x-prefix / case / leading-zero padding (the ride∈market guard)", () => {
  // Same id, different surface forms — all equal (so the guard never false-FAILs a real pair).
  assert.ok(sameId("0xAbC123", "abc123"));
  assert.ok(sameId("0x00ab", "0xAB"));
  assert.ok(sameId("0x0000000000000000000000000000000000000000000000000000000000000008", "0x8"));
  // Genuinely different ids stay different (so a mismatched --market/--ride IS caught).
  assert.ok(!sameId("0xabc", "0xabd"));
  assert.ok(!sameId("0x54e915", "0xa72a36"));
});

test("read* on a non-existent id give a clear 'not found' error (the judge-typo case)", async () => {
  // A typo'd id makes getObject return { data: null }; the verifier must say
  // "not found — check the id", not "is not a SegmentMarketV4 (type: undefined)".
  const missing = { getObject: async () => ({ data: null }) } as unknown as Parameters<typeof readMarket>[0];
  await assert.rejects(() => readMarket(missing, "0xtypo"), /was not found on-chain/);
  await assert.rejects(() => readRide(missing, "0xtypo"), /was not found on-chain/);
});
