/**
 * Tests for parseSegmentMarketsEnv — parses WICK_KEEPER_SEGMENT_MARKETS into the
 * bindings that tell the keeper which markets to crank and with what package +
 * collateral. A parse bug here means the keeper cranks the wrong market, the
 * wrong collateral, or nothing — and live rides stall. The `marketId@pkg:type`
 * grammar has a real footgun (the collateral type itself contains `::`), so the
 * splitting is pinned explicitly.
 *
 *   npx tsx --test keeper/test/segmentMarketsEnv.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseSegmentMarketsEnv } from "../src/segmentCranker.js";

const PKG = "0xdefaultpkg";
const SUI = "0x2::sui::SUI";

test("empty / undefined input yields no bindings", () => {
  assert.deepEqual(parseSegmentMarketsEnv(undefined, PKG), []);
  assert.deepEqual(parseSegmentMarketsEnv("", PKG), []);
  assert.deepEqual(parseSegmentMarketsEnv("   ", PKG), []);
});

test("a bare market id inherits the default package and collateral", () => {
  assert.deepEqual(parseSegmentMarketsEnv("0xmkt", PKG), [
    { marketId: "0xmkt", packageId: PKG, collateralType: SUI, version: "v3" },
  ]);
});

test("marketId@packageId overrides the package, keeps default collateral", () => {
  assert.deepEqual(parseSegmentMarketsEnv("0xmkt@0xpkg2", PKG), [
    { marketId: "0xmkt", packageId: "0xpkg2", collateralType: SUI, version: "v3" },
  ]);
});

test("marketId@pkg:type splits on the FIRST colon, preserving :: in the type", () => {
  // The collateral type contains '::' — only the first ':' separates pkg|type.
  assert.deepEqual(parseSegmentMarketsEnv("0xmkt@0xpkg:0xabc::tusd::TUSD", PKG), [
    { marketId: "0xmkt", packageId: "0xpkg", collateralType: "0xabc::tusd::TUSD", version: "v3" },
  ]);
});

test("a comma list is trimmed and empty entries are dropped", () => {
  const out = parseSegmentMarketsEnv(" 0xa , 0xb@0xp ,, 0xc@0xp:0x2::sui::SUI ", PKG);
  assert.deepEqual(out, [
    { marketId: "0xa", packageId: PKG, collateralType: SUI, version: "v3" },
    { marketId: "0xb", packageId: "0xp", collateralType: SUI, version: "v3" },
    { marketId: "0xc", packageId: "0xp", collateralType: "0x2::sui::SUI", version: "v3" },
  ]);
});

test("the default collateral override is honored when no per-market type is given", () => {
  assert.deepEqual(parseSegmentMarketsEnv("0xmkt", PKG, "0xt::tusd::TUSD"), [
    { marketId: "0xmkt", packageId: PKG, collateralType: "0xt::tusd::TUSD", version: "v3" },
  ]);
});
