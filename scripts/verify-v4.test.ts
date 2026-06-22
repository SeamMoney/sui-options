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
import { deriveSettlementKind, effectiveBarriers, segmentTouches } from "./verify-v4.js";

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

test("in-round TOUCH_WIN: verify-v4 DERIVES the jackpot verdict from the candles (verdict: match)", () => {
  // Upper barrier inside the walk's up-excursion → the price wicks through it
  // in-window, so verify-v4 must independently derive TOUCH_WIN and confirm it
  // equals the chain's settlement. (Unlike crosswin, this is checkable, not
  // softened — it locks the jackpot verdict path, the highest-stakes settlement.)
  const { code, out } = run("mock://touch-v4");
  assert.match(out, /extrema replay:\s+match \(every segment\)/);
  assert.match(out, /off-chain verdict:\s+TOUCH_WIN/);
  assert.match(out, /on-chain verdict:\s+TOUCH_WIN/);
  assert.match(out, /verdict:\s+match/);
  assert.match(out, /PASS — the chain was honest/);
  assert.equal(code, 0, "an honest in-round touch-win must PASS (exit 0)");
});

test("in-round TOUCH_WIN on the LOWER barrier (separate detection path) derives + matches", () => {
  // Enters at segment 0 (its low dips ~3% below home), lower barrier in that dip
  // → the price wicks DOWN through it. Exercises `min ≤ effective_lower`, the
  // mirror of the upper test above — a distinct code path that a wrong
  // comparison/deadband-sign would break without the upper test catching it.
  const { code, out } = run("mock://touchlow-v4", ["--home", "1000000000"]);
  assert.match(out, /extrema replay:\s+match \(every segment\)/);
  assert.match(out, /off-chain verdict:\s+TOUCH_WIN/);
  assert.match(out, /on-chain verdict:\s+TOUCH_WIN/);
  assert.match(out, /verdict:\s+match/);
  assert.match(out, /PASS — the chain was honest/);
  assert.equal(code, 0, "an honest lower-barrier touch-win must PASS (exit 0)");
});

test("an ABORTED_REFUND ride PASSes (accepted, not derived) — never a false 'chain lied'", () => {
  // An abort is an external vault event; the 1:1 refund is candle-independent, so
  // verify-v4 must ACCEPT kind 4 and pass, NOT derive CASHOUT and cry mismatch.
  // Locks that a refactor of the verdict logic can't false-FAIL an honest abort.
  const { code, out } = run("mock://aborted-v4");
  assert.match(out, /settled ABORTED_REFUND/);
  assert.match(out, /external vault event/);
  assert.match(out, /nothing to replay/);
  assert.doesNotMatch(out, /FAIL — the chain lied/);
  assert.equal(code, 0, "an honest aborted ride must PASS (exit 0)");
});

test("rug PRECEDENCE: a ride that BOTH rugs and touches settles EXPIRED (rug beats touch)", () => {
  // The SAME lower barrier as touchlow (which alone derives TOUCH_WIN), but with
  // the rug armed at segment 0. The house-edge rule is rug > touch: a
  // touched-but-rugged ride still loses ("that's how the house wins"). verify-v4
  // must derive EXPIRED_LOSS, NOT TOUCH_WIN — a backwards precedence would
  // false-FAIL the headline scenario. (The only verdict-precedence guard.)
  const { code, out } = run("mock://rugtouch-v4", ["--home", "1000000000"]);
  assert.match(out, /rug fired @ segment 0/);
  assert.match(out, /halt applies → EXPIRED_LOSS/);
  assert.match(out, /off-chain verdict:\s+EXPIRED_LOSS/);
  assert.match(out, /on-chain verdict:\s+EXPIRED_LOSS/);
  assert.match(out, /verdict:\s+match/);
  assert.doesNotMatch(out, /off-chain verdict:\s+TOUCH_WIN/);
  assert.equal(code, 0, "a rugged-and-touched ride must settle EXPIRED (exit 0)");
});

test("a suppressed segment (gap below the head) FAILs closed, not silent-truncated", () => {
  // The market reports next_segment_index=8 but segment 5 is missing — a hole the
  // honest chain (contiguous record_segment_v4 indices) can't produce. The
  // verifier must refuse to pass, not silently stop scanning at the gap.
  const { code, out } = run("mock://gap-v4");
  assert.match(out, /segment 5 is missing/);
  assert.match(out, /gap below the recorded head/);
  assert.match(out, /FAIL — the chain lied/);
  assert.equal(code, 1, "a segment dropped below the head must exit non-zero");
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

test("effectiveBarriers: proportional deadband margin + the lower-clamp edge case", () => {
  // 20bps deadband on ±10% barriers around 1e9: up margin 2e6, lo margin 1.8e6.
  assert.deepEqual(effectiveBarriers(1_000_000_000n, 900_000_000n, 20n), {
    upEff: 1_002_000_000n,
    loEff: 898_200_000n,
  });
  // Zero deadband ⇒ effective barriers equal the raw barriers.
  assert.deepEqual(effectiveBarriers(1_000_000_000n, 900_000_000n, 0n), {
    upEff: 1_000_000_000n,
    loEff: 900_000_000n,
  });
  // Clamp: a margin ≥ the lower barrier would underflow → loEff floors at 0,
  // never negative (loMargin = 100 × 20000/10000 = 200 ≥ lower 100).
  assert.equal(effectiveBarriers(1_000_000_000n, 100n, 20_000n).loEff, 0n);
});

test("segmentTouches: inclusive boundary on both barriers (exactly-at = touch)", () => {
  const upEff = 1_020n, loEff = 980n;
  // Strictly inside both barriers → no touch.
  assert.equal(segmentTouches(990n, 1_010n, upEff, loEff), false);
  // Just below the upper / just above the lower → still no touch.
  assert.equal(segmentTouches(981n, 1_019n, upEff, loEff), false);
  // High EXACTLY at the upper barrier → touch (inclusive >=).
  assert.equal(segmentTouches(990n, 1_020n, upEff, loEff), true);
  // Low EXACTLY at the lower barrier → touch (inclusive <=).
  assert.equal(segmentTouches(980n, 1_010n, upEff, loEff), true);
  // Clear wick through either side → touch.
  assert.equal(segmentTouches(990n, 1_030n, upEff, loEff), true);
  assert.equal(segmentTouches(970n, 1_010n, upEff, loEff), true);
});

test("deriveSettlementKind: full precedence rug > touch > time-expiry > cashout", () => {
  // Minimal ride: round 0, entry segment 2. With dur 75 the round ends at index 75.
  const r = {
    marketId: "0x0", entrySegmentIndex: 2n, roundIndex: 0n, upperBarrier: 0n,
    lowerBarrier: 0n, closed: true, closedAtMs: 0n, settlementKind: 0,
  };
  const DUR = 75n; // SETTLEMENT_* : TOUCH_WIN=1, CASHOUT=2, EXPIRED_LOSS=3
  // CASHOUT: no rug, no touch, closed before round end (maxK 4 → next 5 < 75).
  assert.equal(deriveSettlementKind(false, false, 4n, r, DUR), 2);
  // TOUCH_WIN: a touch in-window beats a cashout.
  assert.equal(deriveSettlementKind(false, true, 4n, r, DUR), 1);
  // TIME-EXPIRY → EXPIRED_LOSS: held to the round end, no touch, no rug
  // (maxK 74 → next 75 >= rideRoundEnd 75). THIS branch is unreachable by the
  // synthetic 8-segment modes — they never span a 75-segment round.
  assert.equal(deriveSettlementKind(false, false, 74n, r, DUR), 3);
  // held PAST the end (cross-round) → still EXPIRED.
  assert.equal(deriveSettlementKind(false, false, 100n, r, DUR), 3);
  // RUG beats everything, even a touch → EXPIRED_LOSS (the house-edge precedence).
  assert.equal(deriveSettlementKind(true, true, 4n, r, DUR), 3);
  // TOUCH beats time-expiry: touched AND held to the end → still TOUCH_WIN.
  assert.equal(deriveSettlementKind(false, true, 74n, r, DUR), 1);
  // No segment in window (maxK null) → next = entry 2 < 75 → CASHOUT, not expiry.
  assert.equal(deriveSettlementKind(false, false, null, r, DUR), 2);
});

// ── v4.27 settlement-model (Move #683 bounded scan + #694 durable per-round rug) ──
// Default mode is v4.26 (the deployed chain). `--settlement-model v4.27` re-derives
// against the upgraded rules, under which cross-round verdicts are DETERMINISTIC and
// strictly checked (no softening). These pin: (a) within-round is byte-identical so
// it still PASSes, and (b) the v4.27 verifier strictly REJECTS the exact escapes
// #683/#694 fix — a cross-round ride that "wins" on a LATER round's touch, or is
// wiped by a LATER round's rug — verdicts the upgraded chain would never settle. (A
// genuine v4.27-chain PASS on a cross-round ride awaits a v4.27 synthetic fixture;
// these cover the in-round identity + the strict escape-rejection logic.)
test("v4.27 mode: a within-round TOUCH_WIN still PASSes (in-round rules unchanged)", () => {
  const { code, out } = run("mock://touch-v4", ["--settlement-model", "v4.27"]);
  assert.match(out, /off-chain verdict: TOUCH_WIN/);
  assert.match(out, /PASS — the chain was honest/);
  assert.equal(code, 0);
});

test("v4.27 mode: a later-round TOUCH escape is strictly REJECTED (not softened)", () => {
  // Bounded touch scan → no in-round win → the chain's TOUCH_WIN doesn't reconcile.
  const { code, out } = run("mock://crosswin-v4", ["--settlement-model", "v4.27"]);
  assert.match(out, /verdict:\s+MISMATCH/);
  assert.match(out, /FAIL/);
  assert.doesNotMatch(out, /not independently checkable/);
  assert.equal(code, 1);
});

test("v4.27 mode: a later-round RUG escape is strictly REJECTED (not softened)", () => {
  // Rug read for the ride's OWN round → a later round's rug doesn't apply → the
  // chain's EXPIRED_LOSS doesn't reconcile under v4.27.
  const { code, out } = run("mock://crossloss-v4", ["--settlement-model", "v4.27"]);
  assert.match(out, /verdict:\s+MISMATCH/);
  assert.match(out, /FAIL/);
  assert.doesNotMatch(out, /not independently checkable/);
  assert.equal(code, 1);
});

// The common case is a ride that opens AND settles within its own round — where
// v4.27 is byte-identical to v4.26. Pin that the v4.27 mode preserves ALL three
// in-round outcomes (touch above; rug + cashout here), so flipping the flag at
// deploy can't regress the verdicts judges actually see. The rug case also
// exercises the #694 mirror's within-round path: the durable per-round rug read
// reduces to the live flag for the current round, and the chain cross-check
// still matches.
test("v4.27 mode: a within-round MARKET HALT (rug → EXPIRED_LOSS) still PASSes", () => {
  const { code, out } = run("mock://rug-v4", ["--settlement-model", "v4.27", "--home", "1000000000"]);
  assert.match(out, /off-chain verdict: EXPIRED_LOSS/);
  assert.match(out, /verdict:\s+match/);
  assert.match(out, /PASS — the chain was honest/);
  assert.equal(code, 0);
});

test("v4.27 mode: a within-round no-touch CASHOUT still PASSes", () => {
  const { code, out } = run("mock://synthetic-v4", ["--settlement-model", "v4.27"]);
  assert.match(out, /off-chain verdict: CASHOUT/);
  assert.match(out, /PASS — the chain was honest/);
  assert.equal(code, 0);
});
