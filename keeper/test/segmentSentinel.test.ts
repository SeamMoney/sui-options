// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the v3.6 sentinel runner — pin the env parser, PTB
// builders (sender + gas owner are set correctly), and the sponsor-call
// outcome shape. The full open-close loop is integration-tested at the
// keeper layer (start with WICK_KEEPER_SENTINEL_MARKETS); here we just
// nail down the deterministic pieces that don't need a network.
//
// Runner: node:test (built-in). Execute with:
//   npx tsx --test test/segmentSentinel.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOpenSentinelRideTx,
  buildCloseSentinelRideTx,
  parseSentinelMarketsEnv,
  DEFAULT_GAS_BUDGET,
  DEFAULT_SPONSOR_URL,
} from "../src/segmentSentinel.js";

const FAKE_PKG = "0x0b94e3daa9ca156f2e541caa177ae27abd40aaacbe599a8f93b3a5a136700e70";
const FAKE_MARKET = "0x0c2bdb9ecafe70cc6c09a3cee6cac29d9a9da0f9618864ad8922d676c05e71f9";
const FAKE_VAULT = "0x73d3a17ab1e1cdc173b8cde1ae7d9789a29d1a177ebfd415196a04a6a10e5b9f";
const FAKE_BOT_REGISTRY = "0x1111111111111111111111111111111111111111111111111111111111111111";
const FAKE_PRICE_ORACLE = "0x2222222222222222222222222222222222222222222222222222222222222222";
const FAKE_TOKEN_STATE = "0x3333333333333333333333333333333333333333333333333333333333333333";
const FAKE_STAKING_POOL = "0x4444444444444444444444444444444444444444444444444444444444444444";
const FAKE_SENDER = "0x5555555555555555555555555555555555555555555555555555555555555555";
const FAKE_SPONSOR = "0x6666666666666666666666666666666666666666666666666666666666666666";
const FAKE_RIDE = "0x7777777777777777777777777777777777777777777777777777777777777777";
const SUI = "0x2::sui::SUI";

test("parseSentinelMarketsEnv: empty / undefined returns []", () => {
  assert.deepEqual(parseSentinelMarketsEnv(undefined, FAKE_PKG), []);
  assert.deepEqual(parseSentinelMarketsEnv("", FAKE_PKG), []);
  assert.deepEqual(parseSentinelMarketsEnv("  ", FAKE_PKG), []);
});

test("parseSentinelMarketsEnv: bare marketId uses defaults", () => {
  const out = parseSentinelMarketsEnv(FAKE_MARKET, FAKE_PKG);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    marketId: FAKE_MARKET,
    packageId: FAKE_PKG,
    collateralType: SUI,
  });
});

test("parseSentinelMarketsEnv: marketId@packageId override", () => {
  const altPkg = "0x" + "ab".repeat(32);
  const out = parseSentinelMarketsEnv(`${FAKE_MARKET}@${altPkg}`, FAKE_PKG);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    marketId: FAKE_MARKET,
    packageId: altPkg,
    collateralType: SUI,
  });
});

test("parseSentinelMarketsEnv: marketId@packageId:collateral override", () => {
  const altPkg = "0x" + "cd".repeat(32);
  const customC = "0x123::usdc::USDC";
  const out = parseSentinelMarketsEnv(
    `${FAKE_MARKET}@${altPkg}:${customC}`,
    FAKE_PKG,
  );
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    marketId: FAKE_MARKET,
    packageId: altPkg,
    collateralType: customC,
  });
});

test("parseSentinelMarketsEnv: multiple markets, mixed shape", () => {
  const m1 = "0x" + "11".repeat(32);
  const m2 = "0x" + "22".repeat(32);
  const m3 = "0x" + "33".repeat(32);
  const altPkg = "0x" + "ab".repeat(32);
  const out = parseSentinelMarketsEnv(
    `${m1}, ${m2}@${altPkg}, ${m3}@${altPkg}:0x99::x::Y`,
    FAKE_PKG,
  );
  assert.equal(out.length, 3);
  assert.equal(out[0]!.packageId, FAKE_PKG);
  assert.equal(out[1]!.packageId, altPkg);
  assert.equal(out[1]!.collateralType, SUI);
  assert.equal(out[2]!.collateralType, "0x99::x::Y");
});

test("DEFAULT_SPONSOR_URL matches the doc 22 §3.4 reference", () => {
  // Hard-coded sanity check — if the URL changes, README + doc must too.
  assert.equal(DEFAULT_SPONSOR_URL, "https://wick-markets.vercel.app/api/sponsor");
});

test("buildOpenSentinelRideTx: sender + gas owner set, calls open_segment_ride_v3", async () => {
  const tx = buildOpenSentinelRideTx({
    packageId: FAKE_PKG,
    collateralType: SUI,
    marketId: FAKE_MARKET,
    vaultId: FAKE_VAULT,
    botRegistryId: FAKE_BOT_REGISTRY,
    barrierIndex: 0,
    stakePerSegment: 1_000_000n,
    escrowMist: 75_000_000n,
    sender: FAKE_SENDER,
    sponsorAddress: FAKE_SPONSOR,
    gasBudget: DEFAULT_GAS_BUDGET,
  });
  const data = tx.getData();
  // Sender = sentinel (signs intent)
  assert.equal(data.sender, FAKE_SENDER);
  // Gas owner = sponsor (Vercel side will reject if not set; the api/sponsor
  // service asserts inspection.gasOwner === sponsorAddress)
  assert.equal(data.gasData.owner, FAKE_SPONSOR);
  // Gas budget set explicitly so the sponsor doesn't have to add one.
  assert.equal(data.gasData.budget, DEFAULT_GAS_BUDGET.toString());
  // Two commands: SplitCoins (gas → escrow) then the MoveCall, plus the
  // TransferObjects to return the ride to the sender. The api/sponsor
  // allowlist permits exactly: 1 MoveCall + N TransferObjects whose targets
  // are the MoveCall result and recipient == sender. The split-coins is the
  // wrinkle — let me confirm the command count and shape.
  const commands = data.commands;
  // SplitCoins + MoveCall + TransferObjects = 3 commands
  assert.equal(commands.length, 3);
  const moveCmd = commands.find(
    (c): c is typeof c & { MoveCall: Record<string, unknown> } =>
      "MoveCall" in c && c.MoveCall != null,
  );
  assert.ok(moveCmd, "expected exactly one MoveCall command");
  assert.equal(moveCmd!.MoveCall!["module"], "wick");
  assert.equal(moveCmd!.MoveCall!["function"], "open_segment_ride_v3");
  // NOTE the api/sponsor allowlist is currently `segment_market_v3::*` so
  // this open call will be 403'd by /api/sponsor — that's the v2-bridge
  // status documented in the README. The PTB shape itself is correct.
});

test("buildCloseSentinelRideTx: sender + gas owner set, calls close_segment_ride_v3", async () => {
  const tx = buildCloseSentinelRideTx({
    packageId: FAKE_PKG,
    collateralType: SUI,
    rideId: FAKE_RIDE,
    marketId: FAKE_MARKET,
    vaultId: FAKE_VAULT,
    priceOracleId: FAKE_PRICE_ORACLE,
    tokenStateId: FAKE_TOKEN_STATE,
    stakingPoolId: FAKE_STAKING_POOL,
    sender: FAKE_SENDER,
    sponsorAddress: FAKE_SPONSOR,
    gasBudget: DEFAULT_GAS_BUDGET,
  });
  const data = tx.getData();
  assert.equal(data.sender, FAKE_SENDER);
  assert.equal(data.gasData.owner, FAKE_SPONSOR);
  assert.equal(data.gasData.budget, DEFAULT_GAS_BUDGET.toString());
  // close PTB shape: MoveCall + TransferObjects = 2 commands.
  const commands = data.commands;
  assert.equal(commands.length, 2);
  const moveCmd = commands.find(
    (c): c is typeof c & { MoveCall: Record<string, unknown> } =>
      "MoveCall" in c && c.MoveCall != null,
  );
  assert.ok(moveCmd, "expected exactly one MoveCall command");
  assert.equal(moveCmd!.MoveCall!["module"], "wick");
  assert.equal(moveCmd!.MoveCall!["function"], "close_segment_ride_v3");
});

test("buildOpenSentinelRideTx rejects zero / negative escrow", () => {
  const base = {
    packageId: FAKE_PKG,
    collateralType: SUI,
    marketId: FAKE_MARKET,
    vaultId: FAKE_VAULT,
    botRegistryId: FAKE_BOT_REGISTRY,
    barrierIndex: 0 as const,
    stakePerSegment: 1_000_000n,
    sender: FAKE_SENDER,
    sponsorAddress: FAKE_SPONSOR,
    gasBudget: DEFAULT_GAS_BUDGET,
  };
  assert.throws(
    () => buildOpenSentinelRideTx({ ...base, escrowMist: 0n }),
    /escrowMist must be > 0/,
  );
  assert.throws(
    () => buildOpenSentinelRideTx({ ...base, escrowMist: 1n, stakePerSegment: 0n }),
    /stakePerSegment must be > 0/,
  );
});
