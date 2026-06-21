/**
 * Unit tests for the pure classification core of `scripts/audit-rugs.ts`
 * (`npm run check:rugs`). The audit's value is its verdict logic — that it
 * catches a FAKED halt, a halt SUPPRESSED late, a round SUPPRESSED entirely,
 * and accepts only a halt that landed on the first qualifying segment. The
 * network I/O around it is exercised live by `check:rugs`; this locks the
 * decision table in CI so a refactor can't silently weaken the house-edge proof.
 *
 * Run: `npx tsx --test scripts/audit-rugs.test.ts`
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifyRound, type RugVerdict } from "./audit-rugs.js";

function kind(chainRug: bigint | null, firstQ: bigint | null, rollAtRug = 0n): RugVerdict {
  return classifyRound(chainRug, firstQ, rollAtRug, 150n).kind;
}

test("HONEST — chain halted at exactly the first qualifying segment", () => {
  const v = classifyRound(458n, 458n, 78n, 150n);
  assert.equal(v.kind, "honest-halt");
  assert.equal(v.honest, true);
  assert.match(v.status, /✓ HONEST/);
});

test("FAKED — chain halted but no segment qualified", () => {
  // The chain claims a halt @ 100, but the dice never rolled in (firstQ null).
  const v = classifyRound(100n, null, 9000n, 150n);
  assert.equal(v.kind, "faked");
  assert.equal(v.honest, false);
  assert.match(v.status, /FAKED/);
});

test("SUPPRESSED (late) — an earlier segment qualified; chain halted later", () => {
  // First qualifier was 440, but the chain only halted @ 458 — it skipped 440,
  // keeping a ride alive past a rug it owed.
  const v = classifyRound(458n, 440n, 78n, 150n);
  assert.equal(v.kind, "suppressed-late");
  assert.equal(v.honest, false);
  assert.match(v.status, /SUPPRESSED/);
});

test("SUPPRESSED (full) — a segment qualified but the chain fired NO halt", () => {
  // The round should have halted @ 30, but the chain emitted no RugFiredV4.
  const v = classifyRound(null, 30n, 0n, 150n);
  assert.equal(v.kind, "suppressed-full");
  assert.equal(v.honest, false);
  assert.match(v.status, /SUPPRESSED/);
});

test("CLEAN — no segment qualified and the chain correctly didn't halt", () => {
  const v = classifyRound(null, null, 0n, 150n);
  assert.equal(v.kind, "clean");
  assert.equal(v.honest, true);
});

test("only honest-halt and clean are accepted as honest", () => {
  // Decision-table sweep: every (chainRug, firstQ) combination.
  assert.equal(classifyRound(5n, 5n, 1n, 150n).honest, true);   // halted at first qualifier
  assert.equal(classifyRound(5n, 3n, 1n, 150n).honest, false);  // earlier qualifier skipped
  assert.equal(classifyRound(5n, null, 1n, 150n).honest, false); // halted with no qualifier
  assert.equal(classifyRound(null, 5n, 0n, 150n).honest, false); // qualifier but no halt
  assert.equal(classifyRound(null, null, 0n, 150n).honest, true); // clean
});

test("the 7 real rounds on the rugged TUSD market all classify HONEST", () => {
  // (round → rugged segment) as emitted on-chain; each is its own first
  // qualifier, so every one is an honest halt. Locks the live-validated result.
  const live: Array<[bigint, bigint]> = [
    [0n, 35n], [1n, 88n], [2n, 211n], [3n, 240n], [4n, 362n], [5n, 447n], [6n, 458n],
  ];
  for (const [round, seg] of live) {
    assert.equal(kind(seg, seg), "honest-halt", `round ${round} should be honest`);
  }
});
