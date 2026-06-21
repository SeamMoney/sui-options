/**
 * Offline tests for gas-report's pure helpers — the DeepBook mid parse that
 * sets the report's USD figures, and the MIST→SUI formatter. A bad parse would
 * print wrong dollar economics to a judge (or divide by a garbage price).
 *
 *   npx tsx --test scripts/gas-report.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { midFromOrderbook, sui } from "./gas-report.ts";

test("midFromOrderbook averages best bid + best ask", () => {
  assert.equal(midFromOrderbook({ bids: [["0.70", "100"]], asks: [["0.72", "50"]] }), 0.71);
  assert.equal(midFromOrderbook({ bids: [["1.0", "1"]], asks: [["3.0", "1"]] }), 2);
});

test("midFromOrderbook returns null on a missing/empty/garbage book", () => {
  assert.equal(midFromOrderbook({}), null);
  assert.equal(midFromOrderbook({ bids: [], asks: [] }), null);
  assert.equal(midFromOrderbook({ bids: [["0.70", "1"]] }), null, "ask side missing");
  assert.equal(midFromOrderbook({ bids: [["x", "1"]], asks: [["0.72", "1"]] }), null, "non-numeric");
  assert.equal(midFromOrderbook({ bids: [["0", "1"]], asks: [["0.72", "1"]] }), null, "zero bid");
  assert.equal(midFromOrderbook(null), null);
  assert.equal(midFromOrderbook("nope"), null);
});

test("sui renders MIST as a 6-decimal SUI string", () => {
  assert.equal(sui(1_000_000_000n), "1.000000");
  assert.equal(sui(6_071_712n), "0.006072"); // a real crank net
  assert.equal(sui(0n), "0.000000");
});
