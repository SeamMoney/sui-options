/**
 * keeper/src/ride.ts was entirely untested. `rideCrankability` is the keeper's
 * crank-decision — the off-chain mirror of the on-chain guards (a ride is
 * crankable only once EXPIRED and NOT touched; cf. ENotExpired /
 * ETouchedMustSelfClose). If it drifts from the contract the keeper wastes gas
 * on txs that abort. `buildCrankRideTx` must also fail fast when the settlement
 * object ids aren't configured, rather than build a tx that aborts on-chain.
 *
 *   tsx --test test/ride.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { rideCrankability, buildCrankRideTx } from "../src/ride.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ride = (over: Record<string, unknown> = {}): any => ({
  id: "0xride",
  collateralType: "0x2::sui::SUI",
  capsId: "0xcaps",
  pathId: "0xpath",
  expiryMs: 1_000,
  touched: false,
  ...over,
});

test("rideCrankability: a still-live ride is NOT crankable (mirrors ENotExpired)", () => {
  const r = rideCrankability(ride({ expiryMs: 1_000 }), 500);
  assert.ok(!r.ok && /not yet expired/i.test(r.reason), JSON.stringify(r));
});

test("rideCrankability: a touched (winning) ride is NOT crankable (mirrors ETouchedMustSelfClose)", () => {
  const r = rideCrankability(ride({ expiryMs: 1_000, touched: true }), 2_000);
  assert.ok(!r.ok && /self-close/i.test(r.reason), JSON.stringify(r));
});

test("rideCrankability: an expired, untouched ride IS crankable", () => {
  const r = rideCrankability(ride({ expiryMs: 1_000, touched: false }), 2_000);
  assert.equal(r.ok, true);
});

test("buildCrankRideTx fails fast when settlement object ids are unconfigured", () => {
  // Missing usdPriceOracleId / wickTokenStateId / stakingPoolId / vaultId.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = {
    packageId: "0xpkg",
    collateralType: "0x2::sui::SUI",
    gasBudgetCrank: 20_000_000n,
  } as any;
  assert.throws(
    () => buildCrankRideTx(cfg, "0xsender", ride({})),
    /ride crank needs/i,
  );
});
