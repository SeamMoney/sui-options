#!/usr/bin/env node
/**
 * prove-live.mjs — one command that audits the LIVE on-chain protocol end to
 * end and narrates what each proof establishes. Where `npm run judge` is the
 * fast, offline, never-flaky gate, this is the deep on-chain companion: it
 * reads real testnet state and proves the deployed protocol is honest and
 * solvent right now.
 *
 *   npm run prove:live
 *
 * Each step is an independently-runnable npm script; this sequences them with a
 * judge-readable narrative and a single PASS/FAIL, exiting non-zero if any
 * proof fails so it can gate a release/runbook.
 */
import { spawnSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

// Each proof: an npm script + the one-line claim it establishes on live state.
const steps = [
  {
    script: "audit:deployment",
    title: "Every live market is provably fair",
    proves:
      "each deployed v4 market's recorded candles reproduce from its own on-chain segment keys — the house can't fake or alter a candle",
  },
  {
    script: "vault:solvency",
    title: "The protocol is provably solvent",
    proves:
      "every MartingalerVault's on-hand reserves cover its entire FIFO claim queue — it can settle every outstanding payout immediately",
  },
];

function run(script) {
  const r = spawnSync(npm, ["run", "--silent", script], { stdio: "inherit", encoding: "utf8" });
  return (r.status ?? 1) === 0;
}

console.log(C.bold("\n═══ Wick — auditing the LIVE on-chain protocol ═══\n"));
const results = [];
let n = 0;
for (const step of steps) {
  n += 1;
  console.log(C.cyan(`[${n}/${steps.length}] ${step.title}`));
  console.log(C.dim(`      proves: ${step.proves}`));
  console.log(C.dim(`      $ npm run ${step.script}`));
  const ok = run(step.script);
  results.push({ step, ok });
  console.log(ok ? C.green(`   ✓ ${step.script} PASS\n`) : C.red(`   ✗ ${step.script} FAIL\n`));
}

const failed = results.filter((r) => !r.ok);
console.log("─".repeat(64));
if (failed.length === 0) {
  console.log(C.green(C.bold("PASS — the live protocol is provably fair AND solvent.")));
  console.log(C.dim("    deeper proofs:"));
  console.log(C.dim("    npm run verify:halt    # re-derive a real MARKET HALT and prove it was an honest roll"));
  console.log(C.dim("    npm run gas:report     # real on-chain gas economics, priced off the live DeepBook mid"));
  console.log(C.dim("    npm run smoke:ride     # fund a burner & run a real ride cold, then audit it"));
  process.exit(0);
} else {
  console.log(C.red(`FAIL — ${failed.length}/${results.length} live proof(s) failed: ${failed.map((r) => r.step.script).join(", ")}`));
  process.exit(1);
}
