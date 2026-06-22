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
import { cashoutSecondsRemaining, checkPayoutIdentity, deriveStakePaid, multiplierProvenanceError, nextSegmentIndexAtClose, queryRideClosed, readRide, readMarket } from "./verify-payout.js";
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

test("an unknown settlement_kind FAILs closed, even if conservation holds", () => {
  // kind 5 is not a real on-chain settlement. Even a conserving split
  // (payout + forfeit == stake_paid) must be refused — the verifier has no
  // payout rule for it, so it can't certify the amount honest.
  const errs = checkPayoutIdentity(5, 150_000n, 150_000n, 0n, MULT);
  assert.ok(errs.length > 0, "unknown kind must produce a violation");
  assert.match(errs.join(" "), /unknown settlement_kind 5/);
});

test("multiplier provenance: ride rate must equal the market's configured rate", () => {
  // The configured rate (17500bps = 1.75×) is honest — no violation.
  assert.equal(multiplierProvenanceError(17_500n, 17_500n), null);
  // A ride whose multiplier was quietly lowered below the market's is rejected,
  // even though `payout = stake × ride.multiplier` would self-consistently pass.
  const err = multiplierProvenanceError(15_000n, 17_500n);
  assert.ok(err !== null, "a lowered ride multiplier must be flagged");
  assert.match(err!, /15000bps != market's configured 17500bps/);
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


// ── queryRideClosed event parse (the MONEY parser) ──────────────────────────
// Maps the RideClosedV4 event's fields to the numbers the audit pays out on. A
// Move-upgrade field rename would silently zero these (asBig → 0) and is caught
// today only by the LIVE check:all, not by offline `npm test`. Lock it here.
function mockEvents(events: Array<Record<string, unknown>>, pageSize = 50): never {
  return {
    queryEvents: async (a: { cursor: { eventSeq: string } | null }) => {
      const start = a.cursor ? Number(a.cursor.eventSeq) : 0;
      const slice = events.slice(start, start + pageSize);
      const nextSeq = start + pageSize;
      const hasNext = nextSeq < events.length;
      return {
        data: slice.map((parsedJson) => ({ parsedJson })),
        hasNextPage: hasNext,
        nextCursor: hasNext ? { txDigest: "0x", eventSeq: String(nextSeq) } : null,
      };
    },
  } as never;
}
const PKG = "0xpkg";
const MKT = "0xmkt";
const RIDE = "0xride";
function closedEvent(over: Record<string, unknown> = {}) {
  return {
    ride_id: RIDE, market_id: MKT, round_index: "6", settlement_kind: 3,
    touched_side: 2, stake_paid: "20000", payout: "0", forfeit: "20000",
    bounty: "0", closed_at_ms: "123", ...over,
  };
}

test("queryRideClosed: maps every money field by name", async () => {
  const got = await queryRideClosed(mockEvents([closedEvent({ stake_paid: "150000", payout: "262500", forfeit: "0", bounty: "0", settlement_kind: 1 })]), PKG, MKT, RIDE);
  assert.deepEqual(got, { stakePaid: 150000n, payout: 262500n, forfeit: 0n, bounty: 0n, settlementKind: 1 });
});

test("queryRideClosed: ignores events for other rides/markets, returns null when absent", async () => {
  const other = closedEvent({ ride_id: "0xother" });
  assert.equal(await queryRideClosed(mockEvents([other]), PKG, MKT, RIDE), null);
});

test("queryRideClosed: finds the event across pages (descending pagination)", async () => {
  const filler = Array.from({ length: 60 }, (_, i) => closedEvent({ ride_id: `0x${i}` }));
  const got = await queryRideClosed(mockEvents([...filler, closedEvent({ payout: "999", forfeit: "0", stake_paid: "999" })]), PKG, MKT, RIDE);
  assert.equal(got?.payout, 999n);
});


// ── readRide / readMarket object parsers (payout-input parse) ───────────────
// Lock the nested-field navigation that feeds the payout derivation, so a
// structure/field rename is caught in offline `npm test` (today only live).
function mockObject(type: string, fields: Record<string, unknown>): never {
  return {
    getObject: async () => ({
      data: { objectId: "0xo", content: { dataType: "moveObject", type, fields } },
    }),
  } as never;
}
const RIDE_TYPE = "0xpkg::segment_market_v4::SegmentRidePositionV4";
const MKT_TYPE = "0xpkg::segment_market_v4::SegmentMarketV4<0x2::sui::SUI>";

test("readRide: parses every payout-relevant field", async () => {
  const { ride, marketId } = await readRide(mockObject(RIDE_TYPE, {
    market_id: "0xMKT", entry_segment_index: "457", round_index: "6",
    multiplier_bps: "17500", stake_per_segment: "10000", escrowed: "825000",
    upper_barrier_price: "1107866203", lower_barrier_price: "906435985",
    closed: true, closed_at_ms: "999", settlement_kind: 3,
  }), "0xride");
  assert.equal(marketId, "0xMKT");
  assert.equal(ride.entry, 457n);
  assert.equal(ride.multiplierBps, 17500n);
  assert.equal(ride.upperBarrier, 1107866203n);
  assert.equal(ride.lowerBarrier, 906435985n);
  assert.equal(ride.closed, true);
  assert.equal(ride.settlementKind, 3);
});

test("readRide: rejects a non-ride object type", async () => {
  await assert.rejects(() => readRide(mockObject("0x2::coin::Coin", {}), "0xride"));
});

test("readMarket: parses tableId + cashout inputs", async () => {
  const m = await readMarket(mockObject(MKT_TYPE, {
    segments: { fields: { id: { id: "0xTABLE" } } },
    round_duration_segments: "75", next_segment_index: "4021",
    sigma_bps_per_sqrt_sec: "100", cashout_spread_bps: "200",
  }), "0xmkt");
  assert.equal(m.packageId, "0xpkg");
  assert.equal(m.tableId, "0xTABLE");
  assert.equal(m.roundDuration, 75n);
  assert.equal(m.sigmaBpsPerSqrtSec, 100n);
  assert.equal(m.cashoutSpreadBps, 200n);
});

test("readMarket: rejects a non-market object type", async () => {
  await assert.rejects(() => readMarket(mockObject("0x2::coin::Coin", {}), "0xmkt"));
});

test("deriveStakePaid: segments-held cap, escrow cap, and zero-hold all hold", () => {
  // Normal: held 8 segments (entry 2 → close index 10), 100/seg, escrow ample.
  assert.deepEqual(deriveStakePaid(10n, 2n, 75n, 100n, 1_000_000n), { segmentsHeld: 8n, stakePaid: 800n });
  // Round-duration cap: close index 100, entry 2 → raw 98, capped to round_dur 75.
  assert.deepEqual(deriveStakePaid(100n, 2n, 75n, 100n, 1_000_000n), { segmentsHeld: 75n, stakePaid: 7_500n });
  // Escrow cap: 8 × 100 = 800 would exceed a 500 escrow → paid is capped to 500.
  assert.deepEqual(deriveStakePaid(10n, 2n, 75n, 100n, 500n), { segmentsHeld: 8n, stakePaid: 500n });
  // Zero hold (closed at/below entry — a 0-segment quick cashout): nothing paid.
  assert.deepEqual(deriveStakePaid(2n, 2n, 75n, 100n, 1_000_000n), { segmentsHeld: 0n, stakePaid: 0n });
  assert.deepEqual(deriveStakePaid(1n, 2n, 75n, 100n, 1_000_000n), { segmentsHeld: 0n, stakePaid: 0n });
});

test("cashoutSecondsRemaining: segments-to-round-end × 400ms, clamped at the boundary", () => {
  // Round 0, dur 75, closed at index 10 → 65 segs left × 400ms = 26s.
  assert.equal(cashoutSecondsRemaining(0n, 75n, 10n, 400n), 26n);
  // Closed exactly at the round boundary (index 75) → 0s left.
  assert.equal(cashoutSecondsRemaining(0n, 75n, 75n, 400n), 0n);
  // Closed PAST the boundary (held cross-round) → clamped to 0, never negative.
  assert.equal(cashoutSecondsRemaining(0n, 75n, 80n, 400n), 0n);
  // Round 1: end = 150; closed at 80 → 70 segs × 400ms = 28s.
  assert.equal(cashoutSecondsRemaining(1n, 75n, 80n, 400n), 28n);
});
