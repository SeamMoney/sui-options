/**
 * Unit tests for audit-ride's pre-check classifier — the guards that stop the
 * capstone audit from MISLEADING a judge:
 *   • open ride  → "still OPEN" (don't vacuous-pass a non-existent settlement)
 *   • market/ride mismatch → refuse (don't emit a false "the chain lied")
 * These were added live (#421, #427); this locks them in CI (the live RPC read
 * around them is exercised by `npm run audit:ride`).
 *
 * Run: npx tsx --test scripts/audit-ride.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifyRide, norm } from "./audit-ride.js";

const M = "0x54e915308c596981fa94e5ff1f6f4e602e8bd1aae8c4a610cb782573310b5282";
const OTHER = "0x1111111111111111111111111111111111111111111111111111111111111111";

test("classifyRide: unreadable fields → ok (never block a real audit)", () => {
  assert.equal(classifyRide(undefined, M).kind, "ok");
});

test("classifyRide: closed ride on the right market → ok", () => {
  assert.equal(classifyRide({ closed: true, market_id: M }, M).kind, "ok");
});

test("classifyRide: open ride → open", () => {
  assert.equal(classifyRide({ closed: false, market_id: M }, M).kind, "open");
});

test("classifyRide: wrong market → mismatch (carries the ride's real market)", () => {
  const r = classifyRide({ closed: true, market_id: M }, OTHER);
  assert.equal(r.kind, "mismatch");
  assert.equal(r.kind === "mismatch" && r.rideMarket, M);
});

test("classifyRide: mismatch takes priority over open", () => {
  // An open ride on the WRONG market: the mismatch is the more misleading
  // failure, so report that, not "still open".
  assert.equal(classifyRide({ closed: false, market_id: M }, OTHER).kind, "mismatch");
});

test("classifyRide: no --market given → ok (can't mismatch what wasn't passed)", () => {
  assert.equal(classifyRide({ closed: true, market_id: M }, undefined).kind, "ok");
});

test("norm: pads, lowercases, and 0x-prefixes so equal ids compare equal", () => {
  // Unpadded + uppercase vs canonical → must normalize to the same value.
  assert.equal(norm("0xABC"), norm("0x0000000000000000000000000000000000000000000000000000000000000abc"));
  assert.equal(norm("ABC"), norm("0xabc")); // missing 0x prefix tolerated
  assert.notEqual(norm(M), norm(OTHER));
});
