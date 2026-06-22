// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// Tests for keeper/src/abi.ts — the PTB builder layer the keeper uses to crank
// and settle. These had no coverage. A structural regression here (wrong
// module/function, a dropped collateral type argument, a missing argument) is
// operationally critical: the keeper silently stops cranking and the live chart
// freezes. We assert each builder's MoveCall shape via the tx command data
// (same inspection pattern as segmentSentinel.test.ts).

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Transaction } from "@mysten/sui/transactions";

import {
  addRandomWalkTick,
  addPathRecord,
  addPathRecordDuringDrain,
  addPullPush,
  addLockAndSettle,
  addCrankExpiredRide,
} from "../src/abi.js";

const PKG = "0x" + "1".repeat(64);
const id = (ch: string) => "0x" + ch.repeat(64);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function moveCallOf(tx: Transaction): any {
  const cmds = tx.getData().commands as any[];
  const mc = cmds.find((c) => "MoveCall" in c && c.MoveCall != null);
  assert.ok(mc, "expected a MoveCall command");
  return mc.MoveCall;
}

test("addRandomWalkTick → random_walk_driver::tick, 3 args, no type args", () => {
  const tx = new Transaction();
  addRandomWalkTick(tx, { packageId: PKG, randomWalkId: id("a"), oracleId: id("b") });
  const mc = moveCallOf(tx);
  assert.equal(mc.module, "random_walk_driver");
  assert.equal(mc.function, "tick");
  assert.equal(mc.arguments.length, 3); // rw, oracle, clock
  assert.equal((mc.typeArguments ?? []).length, 0);
});

test("addPathRecord → path_observation::record, 3 args", () => {
  const tx = new Transaction();
  addPathRecord(tx, { packageId: PKG, pathId: id("a"), oracleId: id("b") });
  const mc = moveCallOf(tx);
  assert.equal(mc.module, "path_observation");
  assert.equal(mc.function, "record");
  assert.equal(mc.arguments.length, 3); // path, oracle, clock
});

test("addPathRecordDuringDrain → path_observation::record_during_drain, 3 args", () => {
  const tx = new Transaction();
  addPathRecordDuringDrain(tx, { packageId: PKG, pathId: id("a"), oracleId: id("b") });
  const mc = moveCallOf(tx);
  assert.equal(mc.module, "path_observation");
  assert.equal(mc.function, "record_during_drain");
  assert.equal(mc.arguments.length, 3); // path, oracle, clock
});

test("addPullPush → pull_oracle_driver::push_price, 7 args (feed·oracle·cap·price·ts·att·clock)", () => {
  const tx = new Transaction();
  addPullPush(tx, {
    packageId: PKG,
    feedId: id("a"),
    oracleId: id("b"),
    keeperCapId: id("c"),
    priceScaled: 64_000_000_000n,
    timestampMs: 1_000n,
    attestation: new Uint8Array([1, 2, 3]),
  });
  const mc = moveCallOf(tx);
  assert.equal(mc.module, "pull_oracle_driver");
  assert.equal(mc.function, "push_price");
  assert.equal(mc.arguments.length, 7);
});

// The collateral type argument is load-bearing — settlement is generic over C;
// dropping it would make the call fail to resolve.
test("addLockAndSettle → wick::lock_and_settle with the collateral type arg", () => {
  const tx = new Transaction();
  addLockAndSettle(tx, {
    packageId: PKG,
    collateralType: "0x2::sui::SUI",
    marketId: id("a"),
    vaultId: id("b"),
    pathId: id("c"),
    oracleId: id("d"),
    registryId: id("e"),
  });
  const mc = moveCallOf(tx);
  assert.equal(mc.module, "wick");
  assert.equal(mc.function, "lock_and_settle");
  assert.equal((mc.typeArguments ?? []).length, 1);
  assert.equal(mc.arguments.length, 6); // market, vault, path, oracle, registry, clock
});

// Generic over C, AND it must transfer the bounty coin back to the sender —
// otherwise the returned Coin<C> dangles and the PTB fails to build.
test("addCrankExpiredRide → wick::crank_expired_ride, type arg + bounty transfer", () => {
  const tx = new Transaction();
  const sender = id("f");
  addCrankExpiredRide(
    tx,
    {
      packageId: PKG,
      collateralType: "0x2::sui::SUI",
      rideId: id("a"),
      capsId: id("b"),
      pathId: id("c"),
      vaultId: id("d"),
      usdPriceOracleId: id("e"),
      wickTokenStateId: id("0"),
      stakingPoolId: id("2"),
    },
    sender,
  );
  const cmds = tx.getData().commands as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  const mc = cmds.find((c) => "MoveCall" in c && c.MoveCall != null)!.MoveCall;
  assert.equal(mc.function, "crank_expired_ride");
  assert.equal((mc.typeArguments ?? []).length, 1);
  assert.equal(mc.arguments.length, 8);
  assert.ok(
    cmds.some((c) => "TransferObjects" in c && (c as any).TransferObjects != null), // eslint-disable-line @typescript-eslint/no-explicit-any
    "the bounty Coin<C> must be transferred back to the sender",
  );
});
