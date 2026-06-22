/**
 * Guard: every leaf `test:*` script must be in the cold gate (`test:offline`) —
 * the suite run while CI is down (#519). Offline unit tests have repeatedly been
 * added OUTSIDE it (#518 → #522/#529 put four in test:live; #562 → #564 put
 * test:safety directly in top-level `test`), each time silently dropping
 * cold-gate coverage so a regression in that pure logic could slip while CI is
 * down. `test:live` is now a no-op placeholder, so every real unit test belongs
 * in `test:offline`. This test fails the moment a new `test:*` is wired anywhere
 * else — turning a recurring manual catch into an automatic one.
 *
 * Run: npx tsx --test scripts/cold-gate-coverage.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const scripts = (JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {}) as Record<string, string>;

// Not leaf unit tests: the two split buckets + the separate Move suite
// (`sui move test` — slow, network-free but run on its own).
const NON_LEAF = new Set(["test:offline", "test:live", "test:move"]);

test("every test:* leaf is in the cold gate (test:offline)", () => {
  const offline = scripts["test:offline"] ?? "";
  const leaves = Object.keys(scripts).filter((k) => k.startsWith("test:") && !NON_LEAF.has(k));
  assert.ok(leaves.length > 0, "expected to find test:* leaf scripts");
  const missing = leaves.filter((t) => !offline.includes(`run ${t}`));
  assert.deepEqual(
    missing,
    [],
    `these test:* scripts are NOT in test:offline (the cold gate run while CI is down): ` +
      `${missing.join(", ")}. Add each to test:offline — every offline unit test belongs in ` +
      `the cold gate (test:live is a no-op placeholder; see #519/#522/#529/#564).`,
  );
});
