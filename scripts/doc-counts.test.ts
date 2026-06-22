/**
 * Cold-gate enforcement for the Move-test-count docs.
 *
 * scripts/check-doc-counts.sh is a fast, no-compile guard: it asserts every
 * judge-facing doc states the SAME Move-test count AND that the count matches the
 * actual `#[test]` total in move/ (an exact `sui move test` proxy — see #738). It
 * monitors all the count forms a doc can use: "N/N tests", bolded "**N/N** Move
 * tests" (#750), the badge URL + ALT text (#751), "N Move tests", "Total tests: N",
 * "N/N passing" (#749), and the "# N/N" command comment. 9/9 forms covered.
 *
 * Without this test the guard only ran when someone remembered to. Wiring it into
 * the cold gate means a Move test added WITHOUT `npm run sync:count` fails `npm
 * test`, with a one-command fix — instead of a judge running `sui move test` and
 * seeing a number that mismatches the README. Mirrors test:doc-links (the doc-link
 * consistency check already in the gate).
 *
 * Run: npx tsx --test scripts/doc-counts.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("docs state ONE Move-test count that matches the source (check:doc-counts)", () => {
  let out = "";
  try {
    // The guard cd's to the repo root itself; run from there for good measure.
    out = execFileSync("bash", ["scripts/check-doc-counts.sh"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    assert.fail(
      `check:doc-counts FAILED — a doc states a Move-test count that disagrees with the\n` +
        `others or with the move/ source. The one-command fix is: npm run sync:count\n\n` +
        `${e.stdout ?? e.stderr ?? e.message ?? "(no output)"}`,
    );
  }
  // Belt-and-suspenders: a 0 exit must be the genuine all-consistent message, not
  // some other early return.
  assert.match(
    out,
    /consistent across all docs AND matches move\/ source/,
    `check:doc-counts exited 0 but without the all-consistent confirmation:\n${out}`,
  );
});
