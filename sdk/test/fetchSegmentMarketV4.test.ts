/**
 * Mock-client coverage for the v4 chain-read field-mappers:
 * fetchSegmentMarketV4 / fetchSegmentRidePositionV4 / fetchSegmentsV4.
 *
 * These are load-bearing — the /ride chart, the verifiers, and smoke:ride all
 * decode chain objects/events through them, and a silent field-mapping
 * regression is exactly the bug class that blanked the live chart (#308). They
 * had ZERO tests. This locks the contract, including:
 *   - typeOriginPackage extraction (the package that defines segment_market_v4,
 *     0x10c3… here — NOT the latest upgrade id; see #296/#308),
 *   - JSON polymorphism (u64 fields arrive as a STRING or a NUMBER depending on
 *     the RPC/transport) → all parse to bigint,
 *   - the nested walk.fields.price → walkPrice path,
 *   - market_id client-side filtering + k-sort in fetchSegmentsV4,
 *   - null on the wrong object dataType / struct type.
 *
 *   npx tsx --test sdk/test/fetchSegmentMarketV4.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  fetchSegmentMarketV4,
  fetchSegmentRidePositionV4,
  fetchSegmentsV4,
} from "../src/segmentMarketV4.js";

const ORIGIN = "0x10c3384310549ca77b881ecc3f956abef5553c913b855e0062233fc9320e7a4e";
const TUSD = "0x204d595c642a06ccc667a32789a6a5a01d0b7ff3340fb53f7f69649c90d00a31::tusd::TUSD";
const MARKET = "0x54e915308c596981fa94e5ff1f6f4e602e8bd1aae8c4a610cb782573310b5282";

// A market object as the JSON-RPC returns it, with u64s as STRINGS (the common
// transport form) and the walk nested one level under `fields`.
function marketObject() {
  return {
    data: {
      objectId: MARKET,
      content: {
        dataType: "moveObject",
        type: `${ORIGIN}::segment_market_v4::SegmentMarketV4<${TUSD}>`,
        fields: {
          vault_id: "0xVAULT",
          walk: { fields: { price: "1000000000" } },
          next_segment_index: "463",
          active_ride_count: 12, // <- arrives as a NUMBER here (polymorphism)
          round_duration_segments: "75",
          barrier_offset_bps: "1000",
          multiplier_bps: "17500",
          max_payout_per_round: "20000000",
          cached_round_index: "6",
          cached_round_started_at_segment: "450",
          cached_upper_barrier: "1107866203",
          cached_lower_barrier: "906435985",
          either_aggregate_stake: "0",
          either_aggregate_max_payout: "0",
          either_rider_count: "0",
          deadband_bps: "20",
          sigma_bps_per_sqrt_sec: "100",
          cashout_spread_bps: "200",
          abort_segment_deadline_ms: "30000",
          min_stake_per_segment: "10000",
          max_stake_per_segment: "150000",
          max_concurrent_rides: "50",
          max_rides_per_user: "5",
          created_at_ms: "1782000000000",
        },
      },
    },
  };
}

const clientReturning = (obj: unknown) =>
  ({ getObject: async () => obj }) as never;

test("fetchSegmentMarketV4 maps every field + the type-origin package, parsing string|number u64s", async () => {
  const snap = (await fetchSegmentMarketV4(clientReturning(marketObject()), MARKET))!;
  assert.ok(snap, "snapshot should not be null");
  assert.equal(snap.id, MARKET);
  assert.equal(snap.collateralType, TUSD);
  // The load-bearing bit: type-origin pkg, NOT the latest upgrade id.
  assert.equal(snap.typeOriginPackage, ORIGIN);
  assert.equal(snap.vaultId, "0xVAULT");
  assert.equal(snap.walkPrice, 1000000000n, "walkPrice comes from nested walk.fields.price");
  assert.equal(snap.nextSegmentIndex, 463n);
  assert.equal(snap.activeRideCount, 12n, "numeric u64 must also parse to bigint");
  assert.equal(snap.roundDurationSegments, 75n);
  assert.equal(snap.multiplierBps, 17500n);
  assert.equal(snap.cachedUpperBarrier, 1107866203n);
  assert.equal(snap.cachedLowerBarrier, 906435985n);
  assert.equal(snap.minStakePerSegment, 10000n);
  assert.equal(snap.maxStakePerSegment, 150000n);
  assert.equal(snap.createdAtMs, 1782000000000n);
  // bigint, not number/string
  assert.equal(typeof snap.nextSegmentIndex, "bigint");
});

test("fetchSegmentMarketV4 returns null for a non-moveObject / missing data", async () => {
  assert.equal(await fetchSegmentMarketV4(clientReturning({ data: null }), MARKET), null);
  assert.equal(
    await fetchSegmentMarketV4(
      clientReturning({ data: { objectId: MARKET, content: { dataType: "package" } } }),
      MARKET,
    ),
    null,
  );
});

test("fetchSegmentMarketV4 returns null when the type isn't a SegmentMarketV4<C>", async () => {
  const wrong = {
    data: {
      objectId: MARKET,
      content: { dataType: "moveObject", type: "0x2::coin::Coin<0x2::sui::SUI>", fields: {} },
    },
  };
  assert.equal(await fetchSegmentMarketV4(clientReturning(wrong), MARKET), null);
});

test("fetchSegmentRidePositionV4 maps the ride incl. closed/settlementKind + collateral name", async () => {
  const RIDE = "0xRIDE";
  const ride = {
    data: {
      objectId: RIDE,
      content: {
        dataType: "moveObject",
        type: `${ORIGIN}::segment_market_v4::SegmentRidePositionV4`,
        fields: {
          user: "0xUSER",
          market_id: MARKET,
          collateral: { fields: { name: TUSD } },
          round_index: "6",
          entry_segment_index: "457",
          upper_barrier_price: "1107866203",
          lower_barrier_price: "906435985",
          multiplier_bps: "17500",
          stake_per_segment: "150000",
          escrowed: "825000",
          is_bot_eligible: false,
          opened_at_ms: "1782053105028",
          closed: true,
          closed_at_ms: "1782053119417",
          settlement_kind: 2,
        },
      },
    },
  };
  const snap = (await fetchSegmentRidePositionV4(clientReturning(ride), RIDE))!;
  assert.equal(snap.id, RIDE);
  assert.equal(snap.user, "0xUSER");
  assert.equal(snap.marketId, MARKET);
  assert.equal(snap.collateralType, TUSD);
  assert.equal(snap.entrySegmentIndex, 457n);
  assert.equal(snap.escrowed, 825000n);
  assert.equal(snap.closed, true);
  assert.equal(snap.settlementKind, 2);
  assert.equal(typeof snap.settlementKind, "number");
});

test("fetchSegmentRidePositionV4 returns null on the wrong struct type", async () => {
  const wrong = {
    data: {
      objectId: "0xX",
      content: {
        dataType: "moveObject",
        type: `${ORIGIN}::segment_market_v4::SegmentMarketV4<${TUSD}>`,
        fields: {},
      },
    },
  };
  assert.equal(await fetchSegmentRidePositionV4(clientReturning(wrong), "0xX"), null);
});

test("fetchSegmentsV4 filters to the requested market, maps extremes, and sorts by k", async () => {
  const ev = (k: string, market: string, key: number[], min: string, max: string) => ({
    parsedJson: { k, market_id: market, key, min_price: min, max_price: max, recorded_at_ms: "1782000000000" },
  });
  // Page returns descending + a foreign-market event that must be filtered out.
  const page = {
    data: [
      ev("2", MARKET, [1, 2, 3], "990", "1010"),
      ev("0", "0xOTHER", [9, 9], "1", "2"), // foreign — drop
      ev("1", MARKET, [4, 5, 6], "995", "1005"),
      ev("0", MARKET, [7, 8, 9], "1000", "1024"),
    ],
    hasNextPage: false,
    nextCursor: null,
  };
  const client = { queryEvents: async () => page } as never;
  const segs = await fetchSegmentsV4(client, {
    packageId: ORIGIN,
    marketId: MARKET,
    fromK: 0n,
    toK: 3n,
  });
  assert.equal(segs.length, 3, "foreign-market event filtered out");
  assert.deepEqual(segs.map((s) => Number(s.k)), [0, 1, 2], "sorted ascending by k");
  assert.equal(segs[0]!.minPrice, 1000n);
  assert.equal(segs[0]!.maxPrice, 1024n);
  assert.equal(segs[2]!.minPrice, 990n);
  assert.deepEqual(Array.from(segs[0]!.key), [7, 8, 9]);
});
