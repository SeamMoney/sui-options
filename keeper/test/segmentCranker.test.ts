/**
 * Shape tests for the live-chart cranker's record-segment tx builder. The
 * cranker keeps the on-chain /ride candle stream moving for judges — if its
 * MoveCall target or the v4-vs-v3 dispatch is wrong, the chart silently
 * freezes. activeRideCountTracker.test.ts only asserts buildRecordSegmentTx
 * doesn't throw; this pins the actual call shape.
 *
 *   tsx --test test/segmentCranker.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { buildRecordSegmentTx } from "../src/segmentCranker.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function moveCallOf(tx: any) {
  const cmds = tx.getData().commands as any[];
  const mc = cmds.find((c) => "MoveCall" in c && c.MoveCall != null);
  assert.ok(mc, "expected a MoveCall command");
  return mc.MoveCall;
}

const v4 = {
  version: "v4" as const,
  packageId: "0xabc123",
  collateralType: "0x2::sui::SUI",
  marketId: "0xdeadbeef",
};

test("v4 binding → wick::record_segment_v4, collateral type arg, 3 args (market, random, clock)", () => {
  const tx = buildRecordSegmentTx(v4, 20_000_000n);
  const mc = moveCallOf(tx);
  assert.equal(mc.module, "wick", "routes through the wick facade, not segment_market_v4");
  assert.equal(mc.function, "record_segment_v4");
  assert.deepEqual(mc.typeArguments, ["0x2::sui::SUI"]);
  assert.equal(mc.arguments.length, 3, "market · &Random (0x8) · &Clock");
});

test("v3 binding → wick::record_segment (legacy dispatch)", () => {
  const tx = buildRecordSegmentTx({ ...v4, version: "v3" }, 9n);
  const mc = moveCallOf(tx);
  assert.equal(mc.function, "record_segment");
});

test("the gas budget is set as configured", () => {
  const tx = buildRecordSegmentTx(v4, 12_345_678n);
  assert.equal(String(tx.getData().gasData.budget), "12345678");
});
