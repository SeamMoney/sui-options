/**
 * Guard tests for the v4 ride-open PTB builder — the load-bearing transaction
 * the live /ride game fires for every player. A bad amount or a non-SUI
 * collateral without a coin source must fail fast in the SDK (a clear Error)
 * rather than producing a PTB that aborts on-chain with an opaque arg_idx /
 * TypeMismatch. These cover the input-validation contract; the on-chain ABI
 * itself is exercised end-to-end by scripts/judge-ride-smoke.ts.
 *
 *   npx tsx --test sdk/test/txBuildersV4.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildOpenSegmentRideV4Tx,
  type BuildOpenSegmentRideV4Args,
} from "../src/segmentMarketV4.js";

const base: BuildOpenSegmentRideV4Args = {
  packageId: "0xpkg",
  collateralType: "0x2::sui::SUI",
  sender: "0x" + "1".repeat(64),
  marketId: "0xmkt",
  vaultId: "0xvault",
  botRegistryId: "0xbot",
  stakePerSegment: 17_500n,
  escrowMist: 200_000n,
};

test("a well-formed SUI ride builds a Transaction without throwing", () => {
  const tx = buildOpenSegmentRideV4Tx(base);
  assert.ok(tx, "should return a Transaction");
  // The Transaction is constructed; structural details are covered by the
  // on-chain smoke. Here we only assert the builder accepts valid input.
});

test("a non-SUI ride needs an escrow coin source", () => {
  assert.throws(
    () => buildOpenSegmentRideV4Tx({ ...base, collateralType: "0xtusd::tusd::TUSD" }),
    /escrowSourceCoinId required for non-SUI collateral/,
  );
  // With a coin source supplied it builds fine.
  assert.ok(
    buildOpenSegmentRideV4Tx({
      ...base,
      collateralType: "0xtusd::tusd::TUSD",
      escrowSourceCoinId: "0xcoin",
    }),
  );
});

test("non-positive escrow / stake are rejected before the PTB is built", () => {
  assert.throws(() => buildOpenSegmentRideV4Tx({ ...base, escrowMist: 0n }), /escrowMist must be > 0/);
  assert.throws(() => buildOpenSegmentRideV4Tx({ ...base, escrowMist: -1n }), /escrowMist must be > 0/);
  assert.throws(
    () => buildOpenSegmentRideV4Tx({ ...base, stakePerSegment: 0n }),
    /stakePerSegment must be > 0/,
  );
});

test("non-SUI build merges extra coins (multi-drip consolidation) without throwing", () => {
  // A player whose stake is spread across several faucet drips: the builder
  // must consolidate them rather than fail. Just assert it builds.
  const tx = buildOpenSegmentRideV4Tx({
    ...base,
    collateralType: "0xtusd::tusd::TUSD",
    escrowSourceCoinId: "0xcoinA",
    additionalCoinIds: ["0xcoinB", "0xcoinC", "0xcoinA"], // self-id is filtered out
  });
  assert.ok(tx);
});
