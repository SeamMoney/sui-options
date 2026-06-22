/**
 * Guard: every test named in move/SAFETY.md exists as a Move fun.
 *
 * SAFETY.md is the judge-facing "safety property → test" traceability map; its
 * intro says: "Run one property: `sui move test <test_name>` (substring match on
 * the function)." If a test is renamed or removed but its SAFETY.md reference
 * isn't updated, a judge running that command finds 0 tests — a broken honesty
 * claim ("every fund-safety property maps to a named test you can run").
 *
 * The fleet edits SAFETY.md frequently (mapping new properties — #739/#743/#745),
 * so a stale/typo'd reference is plausible. This catches it in the cold gate.
 * Mirrors test:doc-links (link refs) + test:doc-counts (count refs).
 *
 * Run: npx tsx --test scripts/safety-test-refs.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every `fun NAME` declared in the Move package (tests + sources). */
function moveFunNames(): Set<string> {
  const names = new Set<string>();
  for (const d of ["move/sources", "move/tests"]) {
    const dir = join(repoRoot, d);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".move")) continue;
      const src = readFileSync(join(dir, f), "utf8");
      for (const m of src.matchAll(/\bfun\s+([a-z_][a-z0-9_]*)/g)) names.add(m[1]);
    }
  }
  return names;
}

/** Backtick-quoted test names in SAFETY.md's middle table column: | prop | TESTS | file |. */
function safetyTestRefs(): string[] {
  const md = readFileSync(join(repoRoot, "move", "SAFETY.md"), "utf8");
  const refs = new Set<string>();
  for (const line of md.split("\n")) {
    if (!line.startsWith("|") || line.includes("---")) continue; // data rows only
    const testsCol = line.split("|")[2] ?? ""; // index 2 = the middle (tests) column
    for (const m of testsCol.matchAll(/`([a-z_][a-z0-9_]{6,})`/g)) {
      const n = m[1];
      if (n.includes("_tests") || n.endsWith("_move")) continue; // file refs, not test names
      refs.add(n);
    }
  }
  return [...refs];
}

test("every test named in move/SAFETY.md exists as a Move fun (judges run `sui move test <name>`)", () => {
  const funs = moveFunNames();
  const refs = safetyTestRefs();
  // Sanity: the parser must actually find the table, not silently match nothing.
  assert.ok(
    refs.length > 100,
    `expected 100+ test refs parsed from SAFETY.md, got ${refs.length} — did the table format change?`,
  );
  const missing = refs.filter((r) => !funs.has(r));
  assert.deepEqual(
    missing,
    [],
    `move/SAFETY.md references test name(s) that no longer exist as a Move fun — a judge running ` +
      `'sui move test <name>' would find 0 tests. Update SAFETY.md (or restore the test). Stale: ${missing.join(", ")}`,
  );
});
