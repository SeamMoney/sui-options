/**
 * Regression suite for the @wick/sdk v4 transaction BUILDERS — the "build on
 * Wick" surface a wallet/keeper/integration uses to act on-chain. The event
 * parsers are covered in segmentMarketV4.test.ts; these pin the PTB *shape* the
 * builders emit, so a refactor can't silently retarget a Move call or drop the
 * coin-split/transfer that makes an open-ride atomic. No network — we inspect
 * the unsigned Transaction's command list directly.
 *
 *   npx tsx --test sdk/test/segmentMarketV4-builders.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildOpenSegmentRideV4Tx,
  buildRecordSegmentV4Tx,
} from "../src/segmentMarketV4.js";

const A = (n: string | number) => "0x" + String(n).padStart(64, "0");
const PKG = A(1);
const SENDER = A("abcd");
const SUI = "0x2::sui::SUI";

function moveCallOf(tx: ReturnType<typeof buildRecordSegmentV4Tx>) {
  const data = tx.getData();
  const cmds = (data.commands ?? []) as Array<Record<string, any>>;
  const kinds = cmds.map((c) => Object.keys(c)[0]);
  const mc = cmds.find((c) => c.MoveCall)?.MoveCall;
  return { kinds, mc };
}

test("buildOpenSegmentRideV4Tx → split escrow · open_segment_ride_v4 · transfer position", () => {
  const tx = buildOpenSegmentRideV4Tx({
    packageId: PKG,
    collateralType: SUI,
    sender: SENDER,
    marketId: A(2),
    vaultId: A(3),
    botRegistryId: A(4),
    stakePerSegment: 1_000_000n,
    escrowMist: 50_000_000n,
  });
  const { kinds, mc } = moveCallOf(tx);
  // SUI escrow splits from gas, the ride opens, the position transfers to sender.
  assert.deepEqual(kinds, ["SplitCoins", "MoveCall", "TransferObjects"]);
  assert.equal(mc.module, "wick");
  assert.equal(mc.function, "open_segment_ride_v4");
  assert.deepEqual(mc.typeArguments, [SUI]);
});

test("buildRecordSegmentV4Tx → record_segment_v4 with the collateral type arg", () => {
  const tx = buildRecordSegmentV4Tx({
    packageId: PKG,
    collateralType: SUI,
    sender: SENDER,
    marketId: A(2),
  });
  const { mc } = moveCallOf(tx);
  assert.equal(mc.module, "wick");
  assert.equal(mc.function, "record_segment_v4");
  assert.deepEqual(mc.typeArguments, [SUI]);
});

test("open-ride validation rejects non-positive stake/escrow", () => {
  const base = {
    packageId: PKG,
    collateralType: SUI,
    sender: SENDER,
    marketId: A(2),
    vaultId: A(3),
    botRegistryId: A(4),
  };
  assert.throws(() => buildOpenSegmentRideV4Tx({ ...base, stakePerSegment: 1_000_000n, escrowMist: 0n }), /escrowMist/);
  assert.throws(() => buildOpenSegmentRideV4Tx({ ...base, stakePerSegment: 0n, escrowMist: 50_000_000n }), /stakePerSegment/);
});

test("non-SUI collateral requires an explicit escrow source coin", () => {
  // For a non-SUI collateral the escrow can't be split from gas; the builder
  // must demand escrowSourceCoinId rather than produce a tx that fails on-chain.
  assert.throws(
    () =>
      buildOpenSegmentRideV4Tx({
        packageId: PKG,
        collateralType: "0x204d595c::tusd::TUSD",
        sender: SENDER,
        marketId: A(2),
        vaultId: A(3),
        botRegistryId: A(4),
        stakePerSegment: 1_000_000n,
        escrowMist: 50_000_000n,
      }),
    /escrowSourceCoinId/,
  );
});
