// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the ActiveRideCountTracker helper in segmentCranker.ts.
// Runner: node:test (built-in). Execute with:
//   npx tsx --test test/activeRideCountTracker.test.ts
//
// The tracker is the deterministic, RPC-free portion of the cranker —
// given a stream of (kind, marketId) events, the resulting per-market
// count must match what we expect. The cranker's wake/sleep decision
// mirrors `shouldCrank()` so these tests pin the load-bearing predicate.

import test from "node:test";
import assert from "node:assert/strict";
import {
  ActiveRideCountTracker,
  parseSegmentMarketsEnv,
} from "../src/segmentCranker.js";

test("unknown market reads 0 and does not crank", () => {
  const t = new ActiveRideCountTracker();
  assert.equal(t.get("0xabc"), 0);
  assert.equal(t.shouldCrank("0xabc"), false);
});

test("opened increments, closed decrements", () => {
  const t = new ActiveRideCountTracker();
  const m = "0xmarket1";
  assert.equal(t.onRideOpened(m), 1);
  assert.equal(t.onRideOpened(m), 2);
  assert.equal(t.shouldCrank(m), true);
  assert.equal(t.onRideClosed(m), 1);
  assert.equal(t.onRideClosed(m), 0);
  assert.equal(t.shouldCrank(m), false);
});

test("close below zero clamps at zero", () => {
  // Drift case: we received a Closed event for a ride we never saw Opened
  // (e.g. cranker started mid-flight before re-seeding from chain). The
  // tracker must clamp at 0 rather than going negative — otherwise the
  // wake gate stays open after the next genuine open.
  const t = new ActiveRideCountTracker();
  const m = "0xdrift";
  assert.equal(t.onRideClosed(m), 0);
  assert.equal(t.onRideClosed(m), 0);
  assert.equal(t.get(m), 0);
  // Genuine open should still register.
  assert.equal(t.onRideOpened(m), 1);
});

test("multiple markets are independent", () => {
  const t = new ActiveRideCountTracker();
  const a = "0xA";
  const b = "0xB";
  t.onRideOpened(a);
  t.onRideOpened(a);
  t.onRideOpened(b);
  assert.equal(t.get(a), 2);
  assert.equal(t.get(b), 1);
  t.onRideClosed(a);
  assert.equal(t.get(a), 1);
  assert.equal(t.get(b), 1);
  t.onRideClosed(b);
  assert.equal(t.get(a), 1);
  assert.equal(t.get(b), 0);
  assert.equal(t.shouldCrank(a), true);
  assert.equal(t.shouldCrank(b), false);
});

test("seed primes from chain, subsequent opens compose correctly", () => {
  // On `start()` we seed from the chain's authoritative
  // `active_ride_count` so the first cadence tick is honest. Events
  // arriving after seed must add/subtract on top, not overwrite.
  const t = new ActiveRideCountTracker();
  const m = "0xseeded";
  t.seed(m, 5);
  assert.equal(t.get(m), 5);
  t.onRideOpened(m);
  assert.equal(t.get(m), 6);
  t.onRideClosed(m);
  t.onRideClosed(m);
  assert.equal(t.get(m), 4);
});

test("seed rejects negative and non-finite", () => {
  const t = new ActiveRideCountTracker();
  assert.throws(() => t.seed("0xm", -1));
  assert.throws(() => t.seed("0xm", Number.NaN));
  assert.throws(() => t.seed("0xm", Number.POSITIVE_INFINITY));
});

test("reset clears a single market or all markets", () => {
  const t = new ActiveRideCountTracker();
  t.seed("0xA", 3);
  t.seed("0xB", 2);
  t.reset("0xA");
  assert.equal(t.get("0xA"), 0);
  assert.equal(t.get("0xB"), 2);
  t.reset();
  assert.equal(t.get("0xB"), 0);
  assert.deepEqual(t.snapshot(), []);
});

test("snapshot returns all known markets", () => {
  const t = new ActiveRideCountTracker();
  t.seed("0xA", 1);
  t.onRideOpened("0xB");
  t.onRideOpened("0xB");
  const snap = t.snapshot().sort((x, y) => x.marketId.localeCompare(y.marketId));
  assert.deepEqual(snap, [
    { marketId: "0xA", count: 1 },
    { marketId: "0xB", count: 2 },
  ]);
});

test("parseSegmentMarketsEnv empty / undefined / whitespace", () => {
  const pkg = "0xpkg";
  assert.deepEqual(parseSegmentMarketsEnv(undefined, pkg), []);
  assert.deepEqual(parseSegmentMarketsEnv("", pkg), []);
  assert.deepEqual(parseSegmentMarketsEnv("   ", pkg), []);
  assert.deepEqual(parseSegmentMarketsEnv(",,,", pkg), []);
});

test("parseSegmentMarketsEnv plain marketId uses defaults", () => {
  const result = parseSegmentMarketsEnv("0xMKT", "0xPKG");
  assert.deepEqual(result, [
    { marketId: "0xMKT", packageId: "0xPKG", collateralType: "0x2::sui::SUI" },
  ]);
});

test("parseSegmentMarketsEnv comma-separated list", () => {
  const result = parseSegmentMarketsEnv("0xA, 0xB ,0xC", "0xPKG", "0xUSDC::usdc::USDC");
  assert.equal(result.length, 3);
  assert.deepEqual(result.map((r) => r.marketId), ["0xA", "0xB", "0xC"]);
  for (const r of result) {
    assert.equal(r.packageId, "0xPKG");
    assert.equal(r.collateralType, "0xUSDC::usdc::USDC");
  }
});

test("parseSegmentMarketsEnv with explicit package + collateral", () => {
  const result = parseSegmentMarketsEnv(
    "0xMKT@0xPKG2:0xCustom::token::TOKEN",
    "0xDefaultPkg",
  );
  assert.deepEqual(result, [
    {
      marketId: "0xMKT",
      packageId: "0xPKG2",
      collateralType: "0xCustom::token::TOKEN",
    },
  ]);
});

test("parseSegmentMarketsEnv with explicit package only", () => {
  const result = parseSegmentMarketsEnv("0xMKT@0xPKG2", "0xDefaultPkg");
  assert.deepEqual(result, [
    { marketId: "0xMKT", packageId: "0xPKG2", collateralType: "0x2::sui::SUI" },
  ]);
});

test("parseSegmentMarketsEnv mixed list", () => {
  const result = parseSegmentMarketsEnv(
    "0xA, 0xB@0xPKG2, 0xC@0xPKG3:0xColl::c::C",
    "0xDefault",
  );
  assert.deepEqual(result, [
    { marketId: "0xA", packageId: "0xDefault", collateralType: "0x2::sui::SUI" },
    { marketId: "0xB", packageId: "0xPKG2", collateralType: "0x2::sui::SUI" },
    { marketId: "0xC", packageId: "0xPKG3", collateralType: "0xColl::c::C" },
  ]);
});
