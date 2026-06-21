/**
 * Unit tests for executeWithRetry — the gas-coin-contention retry wrapper
 * shared by /api/faucet and /api/faucet-tusd.
 *
 * The faucet wallets own a single gas coin, so concurrent/rapid requests
 * collide on the same coin version and the loser throws an object-version /
 * equivocation error (the intermittent 500s observed live). These tests pin
 * the retry contract: transparent success after a transient throw, give-up
 * after the cap, and one-rebuild-per-attempt (so the SDK re-resolves gas).
 *
 * sleep is injected as a no-op so the suite runs instantly and deterministically
 * — no network, no real backoff.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { executeWithRetry } from "../api/faucet.js";

const noSleep = async () => {};

test("succeeds on the first attempt — run called exactly once", async () => {
  let calls = 0;
  const outcome = await executeWithRetry(
    async () => {
      calls += 1;
      return "ok";
    },
    { sleep: noSleep },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.value, "ok");
  assert.equal(calls, 1);
});

test("throws twice then succeeds — outcome ok after a rebuild each attempt", async () => {
  let calls = 0;
  const outcome = await executeWithRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("ObjectVersionUnavailable");
      return { digest: "D" };
    },
    { sleep: noSleep },
  );
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.ok && outcome.value, { digest: "D" });
  // 2 failures + 1 success = 3 invocations, i.e. the tx was rebuilt each time.
  assert.equal(calls, 3);
});

test("gives up after maxAttempts and surfaces the last error", async () => {
  let calls = 0;
  const outcome = await executeWithRetry(
    async () => {
      calls += 1;
      throw new Error(`equivocation #${calls}`);
    },
    { sleep: noSleep },
  );
  assert.equal(outcome.ok, false);
  assert.equal(calls, 4); // default cap
  assert.match(String(!outcome.ok && outcome.error), /equivocation #4/);
});

test("honours a custom maxAttempts", async () => {
  let calls = 0;
  const outcome = await executeWithRetry(
    async () => {
      calls += 1;
      throw new Error("boom");
    },
    { sleep: noSleep, maxAttempts: 2 },
  );
  assert.equal(outcome.ok, false);
  assert.equal(calls, 2);
});

test("sleeps between attempts but not after the final failure", async () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  await executeWithRetry(
    async () => {
      throw new Error("x");
    },
    { sleep, maxAttempts: 3, random: () => 0 },
  );
  // 3 attempts → 2 inter-attempt sleeps (none after the last failure).
  assert.equal(sleeps.length, 2);
  // Backoff grows per attempt (250 * attempt, jitter 0 here).
  assert.deepEqual(sleeps, [250, 500]);
});

test("does not retry a run that resolves — no spurious extra calls", async () => {
  let calls = 0;
  const outcome = await executeWithRetry(
    async () => {
      calls += 1;
      return 42;
    },
    { sleep: noSleep, maxAttempts: 5 },
  );
  assert.equal(outcome.ok, true);
  assert.equal(calls, 1);
});

console.log("api/faucet.test.ts ok");
