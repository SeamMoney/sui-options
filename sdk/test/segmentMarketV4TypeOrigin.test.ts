/**
 * Regression suite for segmentMarketV4TypeOriginPackage — the resolver that
 * keeps every v4 consumer (frontend chart, keeper, scripts) from the recurring
 * "wrong package" footgun: Move event/type tags are keyed on the package that
 * DEFINED the type, not the latest upgraded package_id. Querying RideOpenedV4 /
 * RideClosedV4 / SegmentRecordedV4 / RoundStartedV4 / the SegmentRidePositionV4
 * struct under the latest id silently returns ZERO rows after an upgrade.
 * (This class of bug already hit scripts/verify-v4.26-rug.mjs and the keeper.)
 *
 *   npx tsx --test sdk/test/segmentMarketV4TypeOrigin.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { segmentMarketV4TypeOriginPackage } from "../src/segmentMarketV4.js";

// The live testnet v4 type-origin (where segment_market_v4 was introduced), as
// distinct from the latest upgraded package the crank MoveCall targets.
const ORIGIN = "0x10c3384310549ca77b881ecc3f956abef5553c913b855e0062233fc9320e7a4e";
const TUSD = "0x204d595c642a06ccc667a32789a6a5a01d0b7ff3340fb53f7f69649c90d00a31::tusd::TUSD";

test("extracts the type-origin package from a real SegmentMarketV4<TUSD> type", () => {
  const type = `${ORIGIN}::segment_market_v4::SegmentMarketV4<${TUSD}>`;
  assert.equal(segmentMarketV4TypeOriginPackage(type), ORIGIN);
});

test("works for a SUI-collateral market too", () => {
  const type = `${ORIGIN}::segment_market_v4::SegmentMarketV4<0x2::sui::SUI>`;
  assert.equal(segmentMarketV4TypeOriginPackage(type), ORIGIN);
});

test("works for the SegmentRidePositionV4 struct type (no type args)", () => {
  const type = `${ORIGIN}::segment_market_v4::SegmentRidePositionV4`;
  assert.equal(segmentMarketV4TypeOriginPackage(type), ORIGIN);
});

test("returns a bare package address (no module/struct suffix)", () => {
  const got = segmentMarketV4TypeOriginPackage(
    `${ORIGIN}::segment_market_v4::SegmentMarketV4<0x2::sui::SUI>`,
  );
  assert.ok(got && !got.includes("::"), "must be a bare 0x address");
});

test("returns null for an unrelated type so callers can fall back", () => {
  assert.equal(segmentMarketV4TypeOriginPackage("0x2::coin::Coin<0x2::sui::SUI>"), null);
  assert.equal(segmentMarketV4TypeOriginPackage(""), null);
});
