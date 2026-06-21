/**
 * Conformance tests for `scripts/rugRoll.ts` — the TypeScript port of Move
 * `segment_market_v4::roll_rug`, the v4.26 MARKET-HALT dice. This module is the
 * crux of the house-edge provable-fairness claim: the live `verify-v4` CLI and
 * `audit-rugs` both trust it to reproduce the chain's roll byte-for-byte, so it
 * gets its own dedicated test.
 *
 * The golden vectors are REAL: each is a (round, segment_key) the chain actually
 * rugged at on the live rugged TUSD market `0x54e91530…`, paired with the roll
 * the Move `roll_rug` computed (which is < 150 bps = it fired). If the TS port
 * ever drifts from Move — endianness, BCS round encoding, hash domain — these
 * exact integers stop matching and CI fails. Captured 2026-06-21 from testnet.
 *
 * Run: `npx tsx --test scripts/rugRoll.test.ts`
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { rollRugFired } from "./rugRoll.js";

const RUG_MARKET =
  "0x54e915308c596981fa94e5ff1f6f4e602e8bd1aae8c4a610cb782573310b5282";

// [round, rugSegment, 32-byte segment key, expected roll (Move-computed), fired @150bps]
const GOLDEN: Array<[bigint, bigint, string, bigint, boolean]> = [
  [0n, 35n, "0x7cde85fe46f38f7193327c47d804eebb0116ac04a4f50c23f8c8885c09634867", 1n, true],
  [1n, 88n, "0xc33f96d6068d5a87c1d433ec15db579f92bfc28f91121febb89b4ddb53a2ad23", 5n, true],
  [2n, 211n, "0x5a2bd162c6a8f2eb34d91594b191e6ef869fc2a938920057b072a6ea9ae0e3aa", 105n, true],
  [3n, 240n, "0x93aa6153f37b01f13b246530820d3a8878c01e2887d10d7db9c4a1555be158ff", 45n, true],
  [4n, 362n, "0xa64b41e67904a53515a53e071785ebf0854512dd13dbf8dd6d5f4f98558a98b0", 95n, true],
  [5n, 447n, "0x093820828196dac74fca1349bd643d1d453f6eec767601bb7878c95084f1cdc5", 124n, true],
  [6n, 458n, "0x9d3ecd317edd3f7349fcafd749d8d95ddb26f4ec1e5c6513baa6fff32d80bf95", 78n, true],
];

function keyBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

test("rollRugFired reproduces all 7 on-chain rug rolls byte-for-byte (golden vectors)", () => {
  for (const [round, seg, hex, expRoll, expFired] of GOLDEN) {
    const r = rollRugFired(keyBytes(hex), RUG_MARKET, round, 150n);
    assert.equal(r.roll, expRoll, `round ${round} (seg ${seg}): roll ${r.roll} != ${expRoll}`);
    assert.equal(r.fired, expFired, `round ${round} (seg ${seg}): fired ${r.fired} != ${expFired}`);
    // Each chain-emitted halt must, by construction, have rolled below the dice.
    assert.ok(r.roll < 150n, `round ${round}: a real halt must roll < 150 (got ${r.roll})`);
  }
});

test("the roll is independent of rug_chance_bps; only `fired` depends on it", () => {
  const [round, , hex] = GOLDEN[2]!; // round 2, roll 105
  const at0 = rollRugFired(keyBytes(hex), RUG_MARKET, round, 0n);
  const at150 = rollRugFired(keyBytes(hex), RUG_MARKET, round, 150n);
  const at100 = rollRugFired(keyBytes(hex), RUG_MARKET, round, 100n);
  assert.equal(at0.roll, 105n);
  assert.equal(at150.roll, 105n);
  assert.equal(at0.fired, false, "chance 0 disables the mechanism");
  assert.equal(at150.fired, true, "105 < 150 fires");
  assert.equal(at100.fired, false, "105 >= 100 does NOT fire — the threshold is strict <");
});

test("roll is always in [0, 10000)", () => {
  for (const [round, , hex] of GOLDEN) {
    const r = rollRugFired(keyBytes(hex), RUG_MARKET, round, 150n);
    assert.ok(r.roll >= 0n && r.roll < 10_000n, `roll ${r.roll} out of range`);
  }
});

test("the round index is part of the hash preimage (same key, different round → different roll)", () => {
  const [, , hex] = GOLDEN[0]!;
  const r6 = rollRugFired(keyBytes(hex), RUG_MARKET, 6n, 150n).roll;
  const r7 = rollRugFired(keyBytes(hex), RUG_MARKET, 7n, 150n).roll;
  assert.notEqual(r6, r7, "round must change the roll");
});

test("the market id is part of the hash preimage (same key+round, different market → different roll)", () => {
  const [round, , hex] = GOLDEN[6]!; // round 6, roll 78 on RUG_MARKET
  const other = "0xec32d173efe554247bc0b2b676f52a2f98918f6e0e6065d756757590ba526943";
  const onRug = rollRugFired(keyBytes(hex), RUG_MARKET, round, 150n).roll;
  const onOther = rollRugFired(keyBytes(hex), other, round, 150n).roll;
  assert.equal(onRug, 78n);
  assert.notEqual(onRug, onOther, "market id must change the roll");
});
