/**
 * Tests for parseSegmentMarketsEnv — parses WICK_KEEPER_SEGMENT_MARKETS into the
 * bindings that tell the keeper which markets to crank and with what package +
 * collateral + module version. A parse bug here means the keeper cranks the
 * wrong market, the wrong collateral, the wrong record_segment(_v4), or nothing
 * — and live rides stall. The `marketId@pkg:type` grammar has a real footgun
 * (the collateral type itself contains `::`), so the splitting is pinned.
 *
 *   npx tsx --test keeper/test/segmentMarketsEnv.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseSegmentMarketsEnv } from "../src/segmentCranker.js";

const PKG = "0xdefaultpkg";
const SUI = "0x2::sui::SUI";
const V3 = "v3" as const; // default module version

test("empty / undefined input yields no bindings", () => {
  assert.deepEqual(parseSegmentMarketsEnv(undefined, PKG), []);
  assert.deepEqual(parseSegmentMarketsEnv("", PKG), []);
  assert.deepEqual(parseSegmentMarketsEnv("   ", PKG), []);
});

test("a bare market id inherits the default package, collateral, and v3 version", () => {
  assert.deepEqual(parseSegmentMarketsEnv("0xmkt", PKG), [
    { marketId: "0xmkt", packageId: PKG, collateralType: SUI, version: V3 },
  ]);
});

test("marketId@packageId overrides the package, keeps default collateral", () => {
  assert.deepEqual(parseSegmentMarketsEnv("0xmkt@0xpkg2", PKG), [
    { marketId: "0xmkt", packageId: "0xpkg2", collateralType: SUI, version: V3 },
  ]);
});

test("marketId@pkg:type splits on the FIRST colon, preserving :: in the type", () => {
  // The collateral type contains '::' — only the first ':' separates pkg|type.
  assert.deepEqual(parseSegmentMarketsEnv("0xmkt@0xpkg:0xabc::tusd::TUSD", PKG), [
    { marketId: "0xmkt", packageId: "0xpkg", collateralType: "0xabc::tusd::TUSD", version: V3 },
  ]);
});

test("a comma list is trimmed and empty entries are dropped", () => {
  const out = parseSegmentMarketsEnv(" 0xa , 0xb@0xp ,, 0xc@0xp:0x2::sui::SUI ", PKG);
  assert.deepEqual(out, [
    { marketId: "0xa", packageId: PKG, collateralType: SUI, version: V3 },
    { marketId: "0xb", packageId: "0xp", collateralType: SUI, version: V3 },
    { marketId: "0xc", packageId: "0xp", collateralType: "0x2::sui::SUI", version: V3 },
  ]);
});

test("the default collateral override is honored when no per-market type is given", () => {
  assert.deepEqual(parseSegmentMarketsEnv("0xmkt", PKG, "0xt::tusd::TUSD"), [
    { marketId: "0xmkt", packageId: PKG, collateralType: "0xt::tusd::TUSD", version: V3 },
  ]);
});

test("the version arg stamps every binding (all live markets are v4)", () => {
  const out = parseSegmentMarketsEnv("0xa,0xb@0xp:0xt::tusd::TUSD", PKG, SUI, "v4");
  assert.deepEqual(out, [
    { marketId: "0xa", packageId: PKG, collateralType: SUI, version: "v4" },
    { marketId: "0xb", packageId: "0xp", collateralType: "0xt::tusd::TUSD", version: "v4" },
  ]);
});
