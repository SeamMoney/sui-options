/**
 * Tests for the keeper's pure decision helpers — the logic that decides
 * whether a tx error is safe to skip and whether a market is due to settle.
 * A bug here makes the LIVE keeper spam-retry a permanent failure, swallow a
 * real one, or settle a market at the wrong moment. No network: pure inputs.
 *
 *   npx tsx --test keeper/test/keeperLogic.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  classifyError,
  isArcadeInWindow,
  isReadyForSettle,
  isInDrainWindow,
} from "../src/keeper.js";

// ── classifyError ────────────────────────────────────────────────────────────

test("classifyError treats already-done / not-due aborts as idempotent", () => {
  for (const code of [
    "EAlreadySettled",
    "EAlreadyClosed",
    "EBadStatus",
    "ENotReadyToSettle",
    "ENotInDrainWindow",
    "EDrainWindowOpen",
    "EStillActive",
  ]) {
    const err = new Error(`tx 0xabc failed: MoveAbort(...) ${code} in 0x..::wick::settle`);
    assert.equal(classifyError(err), "idempotent", `${code} should be idempotent (safe to skip)`);
  }
});

test("classifyError treats anything else as fatal", () => {
  assert.equal(classifyError(new Error("InsufficientGas")), "fatal");
  assert.equal(classifyError(new Error("EInvalidBarrier")), "fatal");
  assert.equal(classifyError(new Error("")), "fatal");
  // A substring match must be exact-ish — a random message is not idempotent.
  assert.equal(classifyError(new Error("connection reset by peer")), "fatal");
});

// ── settle-window timeline ───────────────────────────────────────────────────
//
// The timeline partitions at `expiry` and `expiry + drain`:
//   [ now < expiry ]            → active (in window)
//   [ expiry ≤ now < +drain ]   → drain window (don't settle yet)
//   [ now ≥ expiry + drain ]    → ready to settle
// The three predicates must agree on these boundaries (no gaps/overlaps).

const EXPIRY = 1_000_000;
const DRAIN = 30_000;

test("isArcadeInWindow is true strictly before expiry", () => {
  assert.equal(isArcadeInWindow({ expiry_ms: EXPIRY } as never, EXPIRY - 1), true);
  assert.equal(isArcadeInWindow({ expiry_ms: EXPIRY } as never, EXPIRY), false, "at expiry it's no longer active");
});

test("isInDrainWindow covers [expiry, expiry+drain)", () => {
  assert.equal(isInDrainWindow(EXPIRY, DRAIN, EXPIRY - 1), false, "before expiry: not draining");
  assert.equal(isInDrainWindow(EXPIRY, DRAIN, EXPIRY), true, "at expiry: drain starts");
  assert.equal(isInDrainWindow(EXPIRY, DRAIN, EXPIRY + DRAIN - 1), true);
  assert.equal(isInDrainWindow(EXPIRY, DRAIN, EXPIRY + DRAIN), false, "at +drain: drain over");
});

test("isReadyForSettle is true only at/after expiry+drain", () => {
  assert.equal(isReadyForSettle(EXPIRY, DRAIN, EXPIRY + DRAIN - 1), false);
  assert.equal(isReadyForSettle(EXPIRY, DRAIN, EXPIRY + DRAIN), true, "settle exactly at +drain");
  assert.equal(isReadyForSettle(EXPIRY, DRAIN, EXPIRY + DRAIN + 1), true);
});

test("drain and ready-to-settle are mutually exclusive and jointly cover post-expiry", () => {
  for (const now of [EXPIRY, EXPIRY + 1, EXPIRY + DRAIN - 1, EXPIRY + DRAIN, EXPIRY + DRAIN + 5]) {
    const draining = isInDrainWindow(EXPIRY, DRAIN, now);
    const ready = isReadyForSettle(EXPIRY, DRAIN, now);
    assert.notEqual(draining, ready, `at now=${now} exactly one of {draining, ready} must hold`);
  }
});

test("a missing expiry is never ready to settle / draining (don't act on unknown)", () => {
  assert.equal(isReadyForSettle(undefined, DRAIN, EXPIRY + DRAIN + 1), false);
  assert.equal(isInDrainWindow(undefined, DRAIN, EXPIRY + 1), false);
});
