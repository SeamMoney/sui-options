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
import { checkPayoutIdentity, nextSegmentIndexAtClose } from "./verify-payout.js";
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

test("bachelier factor matches Move ride_pricing EXACTLY (golden vectors, TS↔Move)", () => {
  // The CASHOUT payout = stake × this factor, so the TS port (scripts/bachelier.ts)
  // must reproduce Move `bachelier_cashout_factor` bit-for-bit, or verify-payout
  // mis-derives the hardest-to-verify payout. These are the EXACT integers Move's
  // move/tests/ride_pricing_tests.move asserts (B=100_000, SIG=100, SEC=100 →
  // z = |barrier−spot|/10_000), so a drift in the TS Φ-table or interpolation —
  // which the property tests above would NOT catch — fails here. factor = 2·Φ(−z).
  const B = 100_000n, SIG = 100n, SEC = 100n;
  const golden: Array<[bigint, bigint]> = [
    [95_000n, 617_075_100n], // z = 0.5
    [90_000n, 317_310_500n], // z = 1.0
    [80_000n, 45_500_300n],  // z = 2.0
    [92_500n, 453_828_300n], // z = 0.75 (interpolated)
    [94_500n, 582_790_600n], // z = 0.55 (interpolated)
  ];
  for (const [spot, expected] of golden) {
    assert.equal(
      bachelierCashoutFactor(spot, B, SIG, SEC),
      expected,
      `factor at spot ${spot} must match Move`,
    );
  }
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
  assert.ok(checkPayoutIdentity(2, 150_000n, 0n, 150_000n, MULT).length > 0); // stake paid but payout 0
});

test("CASHOUT 0-segment (held nothing): payout 0 is valid, not a chain lie", () => {
  // The user closed before any segment was recorded: stake_paid = 0, so the
  // Bachelier payout on zero stake is 0 and the full escrow returns via
  // (escrowed − stake_paid). Requiring payout > 0 unconditionally falsely FAILs
  // an honest quick cashout — regression for the real ride 0x0f2e8412… on the
  // rugged market 0x54e91530…, which reported "the chain paid the wrong amount".
  assert.deepEqual(checkPayoutIdentity(2, 0n, 0n, 0n, MULT), []);
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


// ── nextSegmentIndexAtClose binary search (the #314 late-ride speedup) ───────
// recorded_at_ms is monotonic in k, so the boundary search must return the
// smallest k with recorded_at_ms > closed_at_ms (or nextSegmentIndex if none).
// This was live-only; lock the boundary/off-by-one behaviour against a mock.
function mockTable(recordedAt: Map<number, bigint>): never {
  return {
    getDynamicFieldObject: async (a: { name: { value: string } }) => {
      const k = Number(a.name.value);
      const at = recordedAt.get(k);
      if (at === undefined) return { data: null };
      return {
        data: {
          content: {
            fields: {
              value: {
                fields: { recorded_at_ms: at.toString(), state_after: { fields: { price: "0" } } },
              },
            },
          },
        },
      };
    },
  } as never;
}

test("nextSegmentIndexAtClose: all recorded before close → nextSegmentIndex", async () => {
  const m = new Map<number, bigint>([[5, 10n], [6, 20n], [7, 30n]]);
  assert.equal(await nextSegmentIndexAtClose(mockTable(m), "0xt", 5n, 100n, 8n), 8n);
});

test("nextSegmentIndexAtClose: all recorded after close → entry", async () => {
  const m = new Map<number, bigint>([[5, 200n], [6, 300n]]);
  assert.equal(await nextSegmentIndexAtClose(mockTable(m), "0xt", 5n, 100n, 7n), 5n);
});

test("nextSegmentIndexAtClose: boundary in the middle → first k recorded after close", async () => {
  // 5,6 before; 7,8 after → boundary is 7.
  const m = new Map<number, bigint>([[5, 10n], [6, 20n], [7, 200n], [8, 300n]]);
  assert.equal(await nextSegmentIndexAtClose(mockTable(m), "0xt", 5n, 100n, 9n), 7n);
});

test("nextSegmentIndexAtClose: recorded_at == closed_at is INSIDE the window (<=)", async () => {
  // k=6 recorded exactly at close → counts as before; boundary is 7.
  const m = new Map<number, bigint>([[5, 50n], [6, 100n], [7, 150n]]);
  assert.equal(await nextSegmentIndexAtClose(mockTable(m), "0xt", 5n, 100n, 8n), 7n);
});

test("nextSegmentIndexAtClose matches a linear scan over random monotonic data", async () => {
  // Deterministic pseudo-random monotonic timestamps; compare binary vs linear.
  for (let trial = 0; trial < 40; trial++) {
    const n = 1 + ((trial * 7 + 3) % 30);
    const entry = BigInt((trial * 5) % 4);
    const m = new Map<number, bigint>();
    let t = 1n;
    for (let k = 0; k < Number(entry) + n; k++) { t += BigInt(1 + ((k * 13 + trial) % 9)); m.set(k, t); }
    const next = entry + BigInt(n);
    const closed = m.get((trial * 3) % Number(next)) ?? 0n;
    // reference linear scan (the pre-#314 behaviour)
    let lin = entry;
    while (lin < next) { const at = m.get(Number(lin)); if (at === undefined || at > closed) break; lin += 1n; }
    const bin = await nextSegmentIndexAtClose(mockTable(m), "0xt", entry, closed, next);
    assert.equal(bin, lin, `trial ${trial}: binary ${bin} != linear ${lin}`);
  }
});
