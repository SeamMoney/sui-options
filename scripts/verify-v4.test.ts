/**
 * Offline proof that the v4 provable-fairness CLI verifier is honest:
 *   - the synthetic (untampered) v4 market + ride PASSes (exit 0),
 *   - a single tampered segment extremum flips it to FAIL (exit 1),
 *   - the failure pinpoints the tampered segment.
 *
 * Black-box (spawns the real CLI) so it covers arg-parsing, the synthetic
 * client, the seeded-path replay, the touch predicate and the settlement
 * mirror in one shot. No network. Run with:
 *   npx tsx --test scripts/verify-v4.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rollRugFired } from "./rugRoll.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "verify-v4.ts");

function run(rpc: string, extra: string[] = []): { code: number; out: string } {
  const r = spawnSync(
    "npx",
    ["tsx", cli, "--rpc", rpc, "--ride", "0xmock", ...extra],
    { encoding: "utf8", cwd: join(here, "..") },
  );
  return { code: r.status ?? -1, out: `${r.stdout}\n${r.stderr}` };
}

test("synthetic v4 ride PASSes verification (exit 0)", () => {
  const { code, out } = run("mock://synthetic-v4");
  assert.match(out, /extrema replay:\s+match \(every segment\)/);
  assert.match(out, /off-chain verdict: CASHOUT/);
  assert.match(out, /on-chain verdict:\s+CASHOUT/);
  assert.match(out, /PASS — the chain was honest\./);
  assert.equal(code, 0, "honest synthetic must exit 0");
});

test("a tampered extremum FAILs verification (exit 1) and is pinpointed", () => {
  const { code, out } = run("mock://tamper-v4");
  assert.match(out, /extrema replay:\s+MISMATCH/);
  assert.match(out, /FAIL — the chain lied\./);
  // The tamper is on segment k=5: its integ column must read FAIL.
  assert.match(out, /^\s*5\b.*\bFAIL\s*$/m, "segment 5 should be flagged FAIL");
  assert.equal(code, 1, "a dishonest house must exit non-zero");
});

test("synthetic MARKET HALT (rug) ride settles EXPIRED_LOSS and PASSes", () => {
  // Exercises the full rug settlement WIRING offline: readRugConfig →
  // findRoundRug (re-derive the keccak halt) → EXPIRED_LOSS routing → verdict
  // match. This is the only CI guard on the rug path other than the pure-roll
  // golden vectors, and verify-v4.ts has been churned by many PRs — so it
  // protects the headline "provably-fair house edge" from a silent regression.
  const { code, out } = run("mock://rug-v4", ["--home", "1000000000"]);
  assert.match(out, /MARKET HALT:.*rug fired @ segment 0/);
  assert.match(out, /keccak roll=\d+ < rug_chance_bps=10000 \(HONEST\)/);
  assert.match(out, /chain rugged_at_segment=0 \(match\)/);
  assert.match(out, /halt applies → EXPIRED_LOSS/);
  assert.match(out, /off-chain verdict: EXPIRED_LOSS/);
  assert.match(out, /on-chain verdict:\s+EXPIRED_LOSS/);
  assert.match(out, /extrema replay:\s+match \(every segment\)/);
  assert.match(out, /PASS — the chain was honest\./);
  assert.equal(code, 0, "an honest rugged ride must PASS (exit 0)");
});

// ── Cross-round late close (#297, #303) ─────────────────────────────────────
// A ride abandoned past its round end is settled by the chain against a LATER
// round's state (its rug / its segments) that the verifier cannot reconstruct.
// The verdict then legitimately mismatches our own-round derivation. verify-v4
// must NOT cry "the chain lied" — it must PASS with an honest "not
// independently checkable" caveat, while the candles + rug roll stay verified.
// These guards protect that softening (subtle logic on the headline tool) from
// a silent regression; without them a refactor could quietly restore the false
// "chain lied" that made the audit unusable on real late-closed rides.

test("cross-round EXPIRED_LOSS (later-round rug wipe) PASSes with caveat, not 'chain lied'", () => {
  const { code, out } = run("mock://crossloss-v4");
  assert.match(out, /extrema replay:\s+match \(every segment\)/);
  assert.match(out, /on-chain verdict:\s+EXPIRED_LOSS/);
  assert.match(out, /verdict:\s+not independently checkable/);
  assert.match(out, /force-settled EXPIRED_LOSS against a LATER round's rug/);
  assert.doesNotMatch(out, /FAIL — the chain lied/);
  assert.match(out, /PASS — candles honest; verdict not independently checkable/);
  assert.equal(code, 0, "a cross-round EXPIRED_LOSS must PASS (exit 0)");
});

test("cross-round TOUCH_WIN (later-round touch) PASSes with caveat, not 'chain lied'", () => {
  const { code, out } = run("mock://crosswin-v4");
  assert.match(out, /extrema replay:\s+match \(every segment\)/);
  assert.match(out, /on-chain verdict:\s+TOUCH_WIN/);
  assert.match(out, /verdict:\s+not independently checkable/);
  assert.match(out, /touched the barrier in a LATER round/);
  assert.doesNotMatch(out, /FAIL — the chain lied/);
  assert.match(out, /PASS — candles honest; verdict not independently checkable/);
  assert.equal(code, 0, "a cross-round TOUCH_WIN must PASS (exit 0)");
});

// ── MARKET HALT (rug) roll — golden vectors captured live from testnet ──────
// market 0x54e915…5282 (package 0x10c33843…7a4e), rug_chance_bps = 150. The
// chain independently armed `rugged_at_segment = 458` for round 6; our keccak
// port must reproduce roll=78 (fires) at seg 458 and the round-5 fire at seg
// 447 (roll=124). If the hash domain ordering / u64-LE extraction / address
// normalization ever drift, these break. (Real SegmentRecordedV4 keys.)
const RUG_MARKET = "0x54e915308c596981fa94e5ff1f6f4e602e8bd1aae8c4a610cb782573310b5282";

function keyBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

test("rollRugFired reproduces the on-chain rug rolls (golden vectors)", () => {
  // [round, key, expectedRoll, expectedFired @ 150bps]
  const vectors: Array<[bigint, string, bigint, boolean]> = [
    [6n, "0x9d3ecd317edd3f7349fcafd749d8d95ddb26f4ec1e5c6513baa6fff32d80bf95", 78n, true],
    [5n, "0x093820828196dac74fca1349bd643d1d453f6eec767601bb7878c95084f1cdc5", 124n, true],
  ];
  for (const [round, hex, expRoll, expFired] of vectors) {
    const r = rollRugFired(keyBytes(hex), RUG_MARKET, round, 150n);
    assert.equal(r.roll, expRoll, `round ${round}: roll ${r.roll} != ${expRoll}`);
    assert.equal(r.fired, expFired, `round ${round}: fired ${r.fired} != ${expFired}`);
  }
});

test("rollRugFired: roll is in [0,10000) and rug_chance=0 never fires", () => {
  const k = keyBytes("0x9d3ecd317edd3f7349fcafd749d8d95ddb26f4ec1e5c6513baa6fff32d80bf95");
  const r0 = rollRugFired(k, RUG_MARKET, 6n, 0n);
  assert.equal(r0.fired, false, "rug_chance_bps=0 must disable the mechanism");
  assert.equal(r0.roll, 78n, "roll is computed even when the gate is 0");
  assert.ok(r0.roll >= 0n && r0.roll < 10_000n);
});

test("rollRugFired: the round index is part of the hash domain", () => {
  const k = keyBytes("0x9d3ecd317edd3f7349fcafd749d8d95ddb26f4ec1e5c6513baa6fff32d80bf95");
  assert.notEqual(
    rollRugFired(k, RUG_MARKET, 6n, 150n).roll,
    rollRugFired(k, RUG_MARKET, 7n, 150n).roll,
  );
});
