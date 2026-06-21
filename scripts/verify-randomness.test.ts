/**
 * Offline tests for the randomness-provenance proof's detection logic — does a
 * crank tx consume the 0x…08 system Random object? A bug here would falsely
 * clear a house-chosen key, or falsely fail an honest crank, so the address
 * normalization + the input-id extraction (across the JSON shapes Sui returns)
 * are pinned without a live tx.
 *
 *   npx tsx --test scripts/verify-randomness.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { norm, inputObjectIds, RANDOM_OBJECT } from "./verify-randomness.ts";

test("RANDOM_OBJECT is the canonical 32-byte 0x…08", () => {
  assert.equal(RANDOM_OBJECT, "0x" + "0".repeat(63) + "8");
});

test("norm zero-pads + lowercases object ids, rejects non-hex", () => {
  assert.equal(norm("0x8"), RANDOM_OBJECT, "short form pads to the system Random id");
  assert.equal(norm("0x06"), "0x" + "0".repeat(63) + "6");
  assert.equal(norm("0xAbCd"), "0x" + "0".repeat(60) + "abcd");
  assert.equal(norm(123), null, "non-string → null");
  assert.equal(norm("0xZZ"), null, "non-hex → null");
});

test("inputObjectIds extracts ids from both objectId and SharedObject shapes", () => {
  const tx = {
    inputs: [
      { objectId: "0xmarket".replace("market", "1") }, // a normalish id
      { SharedObject: { objectId: "0x8" } }, // the Random object, shared-input shape
      { SharedObject: { objectId: "0x6" } }, // the Clock
      { pure: "0xnotanobject" }, // a pure arg → no object id
    ],
  };
  const ids = inputObjectIds(tx);
  assert.ok(ids.includes(RANDOM_OBJECT), "the 0x…08 Random input is detected");
  assert.ok(ids.includes("0x" + "0".repeat(63) + "6"), "the 0x…06 Clock is detected");
  // A pure (non-object) input contributes nothing.
  assert.equal(ids.length, 3);
});

test("a crank that takes Random is recognised; one without it is not", () => {
  const withRandom = { inputs: [{ objectId: "0xmkt" }, { SharedObject: { objectId: "0x8" } }] };
  const withoutRandom = { inputs: [{ objectId: "0xmkt" }, { SharedObject: { objectId: "0x6" } }] };
  assert.equal(inputObjectIds(withRandom).includes(RANDOM_OBJECT), true);
  assert.equal(inputObjectIds(withoutRandom).includes(RANDOM_OBJECT), false);
  assert.deepEqual(inputObjectIds(undefined), [], "no tx → no inputs");
});
