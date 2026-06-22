/**
 * Integration guard for the documented /pro fairness loop:
 *
 *     npm run play  →  (copy the printed command)  →  npm run verify:pro-round  →  HONEST
 *
 * DEMO.md and the README promise a judge can play a round and independently
 * re-verify it from the terminal in one copy-paste. This runs `play` for real,
 * extracts the verify:pro-round command it prints, and confirms those exact
 * values reproduce the commit (HONEST) — so a fleet change to play's output
 * format OR to verify-pro-round's contract can't silently break the loop the
 * docs advertise. play is deterministic with --seed and runs in ~1s (the reveal
 * is simulated, not real-time), so this is cold-gate-safe.
 *
 * Run:  npx tsx --test scripts/play-verify-loop.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRound } from "./verify-pro-round.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

test("play → verify:pro-round CLI loop holds end to end (the documented copy-paste)", () => {
  const out = stripAnsi(
    execFileSync("npm", ["run", "--silent", "play", "--", "--seed", "4242"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );

  // 1. play self-verifies the revealed seed against its own commit.
  assert.match(out, /commit verified: ✓/, "play must self-verify the reveal");

  // 2. play prints a copy-paste verify:pro-round command (the closed CLI loop).
  const m = /verify:pro-round -- --commit (\S+) --seed (\d+) --params '(.+)'/.exec(out);
  assert.ok(m, "play must print a ready-to-run 'npm run verify:pro-round' command");

  // 3. those exact printed values independently reproduce the commit → HONEST.
  const [, commit, seedStr, params] = m!;
  const r = checkRound(commit, Number(seedStr), params);
  assert.equal(
    r.ok,
    true,
    `play's printed values must reproduce the commit (HONEST); recomputed ${r.recomputed} vs published ${r.published}`,
  );
});
