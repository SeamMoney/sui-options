/**
 * Tests for eventOriginPackage — extracts the type-origin package from a
 * SegmentMarket{,V4}<C> object type so the cranker keys Ride{Opened,Closed}
 * event subscriptions on the package that DEFINED the struct, not the latest
 * upgraded crank package.
 *
 * This is load-bearing: after a package upgrade the two packages differ, and
 * `suix_queryEvents` with the wrong (latest) package id silently returns ZERO
 * events — so active_ride_count would never resync and the cranker would either
 * crank forever (gas burn) or never crank (frozen chart). The real testnet
 * deployment is exactly this case: SegmentMarketV4 was introduced in the v3
 * upgrade (0x10c3…) but the crank package is the v4.26 upgrade (0x1fdf…).
 *
 *   npx tsx --test keeper/test/eventOriginPackage.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { eventOriginPackage } from "../src/segmentCranker.js";

const V4_ORIGIN = "0x10c3384310549ca77b881ecc3f956abef5553c913b855e0062233fc9320e7a4e";
const TUSD = "0x204d595c642a06ccc667a32789a6a5a01d0b7ff3340fb53f7f69649c90d00a31::tusd::TUSD";

test("extracts the type-origin package from a real v4 market type (NOT the latest crank package)", () => {
  const type = `${V4_ORIGIN}::segment_market_v4::SegmentMarketV4<${TUSD}>`;
  assert.equal(eventOriginPackage(type), V4_ORIGIN);
});

test("extracts the origin from a legacy v3 SegmentMarket type", () => {
  const origin = "0x9f0320d08c2025c57720b6f9b64fdc767441acb1ef778512abbf00c12e1ee8ba";
  const type = `${origin}::segment_market::SegmentMarket<0x2::sui::SUI>`;
  assert.equal(eventOriginPackage(type), origin);
});

test("prefers the v4 marker when both could appear (v4 type contains 'segment_market')", () => {
  // The substring "::segment_market::" must NOT match inside "::segment_market_v4::".
  const type = `${V4_ORIGIN}::segment_market_v4::SegmentMarketV4<0x2::sui::SUI>`;
  const got = eventOriginPackage(type);
  assert.equal(got, V4_ORIGIN);
  assert.ok(!got!.includes("::"), "must return a bare package address");
});

test("returns null for an unrelated type so the caller falls back to the binding package", () => {
  assert.equal(eventOriginPackage("0x2::coin::Coin<0x2::sui::SUI>"), null);
  assert.equal(eventOriginPackage(""), null);
});
