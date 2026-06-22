// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// Coverage for two untested corners of the v4 SDK:
//  - the v4 event-type constructors: the frontend/SDK SUBSCRIBE on these exact
//    strings, so a rename/typo here silently stops the live chart from seeing
//    new markets, rounds, and rides — pin the canonical types.
//  - buildBootstrapSegmentMarketV4Tx: the PTB that stands up a live game —
//    smoke that it builds for a valid config without throwing. (Its MoveCall
//    shape isn't asserted here: it uses tx.object.clock(), which trips the
//    offline tx.getData() validator in @mysten/sui; the on-chain target is
//    exercised by the deploy scripts.)

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Transaction } from "@mysten/sui/transactions";

import {
  buildBootstrapSegmentMarketV4Tx,
  segmentMarketV4CreatedEventType,
  roundStartedV4EventType,
  rideOpenedV4EventType,
} from "../src/segmentMarketV4.js";

const PKG = "0x" + "1".repeat(64);
const id = (ch: string) => "0x" + ch.repeat(64);

test("v4 event-type constructors yield the canonical <pkg>::segment_market_v4::Event strings", () => {
  assert.equal(
    segmentMarketV4CreatedEventType(PKG),
    `${PKG}::segment_market_v4::SegmentMarketV4Created`,
  );
  assert.equal(roundStartedV4EventType(PKG), `${PKG}::segment_market_v4::RoundStartedV4`);
  assert.equal(rideOpenedV4EventType(PKG), `${PKG}::segment_market_v4::RideOpenedV4`);

  // Structural guard: all share the package + module and are distinct, so a
  // wrong-module typo or a duplicated name can't slip through.
  const types = [
    segmentMarketV4CreatedEventType(PKG),
    roundStartedV4EventType(PKG),
    rideOpenedV4EventType(PKG),
  ];
  for (const t of types) assert.ok(t.startsWith(`${PKG}::segment_market_v4::`), `wrong pkg/module: ${t}`);
  assert.equal(new Set(types).size, types.length, "event types must be distinct");
});

test("buildBootstrapSegmentMarketV4Tx builds a Transaction for a valid config", () => {
  const tx = buildBootstrapSegmentMarketV4Tx({
    sender: id("e"),
    packageId: PKG,
    collateralType: "0x2::sui::SUI",
    vaultId: id("v"),
    homePrice: 1_000_000_000n,
    volRegimeInit: 1_000_000n,
    roundDurationSegments: 20n,
    barrierOffsetBps: 500n,
    multiplierBps: 20_000n,
    maxPayoutPerRound: 1_500_000_000n,
    deadbandBps: 20n,
    sigmaBpsPerSqrtSec: 50n,
    cashoutSpreadBps: 500n,
    abortSegmentDeadlineMs: 30_000n,
    minStakePerSegment: 100n,
    maxStakePerSegment: 10_000_000n,
    maxConcurrentRides: 100n,
    maxRidesPerUser: 5n,
  });
  assert.ok(tx instanceof Transaction, "expected a Transaction");
});
