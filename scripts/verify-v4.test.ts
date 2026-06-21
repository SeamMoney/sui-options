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

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "verify-v4.ts");

function run(rpc: string): { code: number; out: string } {
  const r = spawnSync(
    "npx",
    ["tsx", cli, "--rpc", rpc, "--ride", "0xmock"],
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
