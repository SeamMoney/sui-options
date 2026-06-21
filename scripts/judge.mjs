#!/usr/bin/env node
/**
 * judge.mjs — the ONE command a reviewer runs to see the whole Wick story prove
 * itself. Fast (~15s), no wallet, no browser, never flaky: it chains the
 * existing no-browser gates and narrates exactly what each one proves, then
 * points at the two deeper hands-on proofs (live UI + a real on-chain ride).
 *
 *   npm run judge
 *
 * Each step is an existing, independently-runnable npm script; this just
 * sequences them with a judge-readable narrative and a single PASS/FAIL.
 * Exits non-zero if any step fails, so it can gate a release too.
 *
 * Flags:
 *   --with-e2e    also run the live-UI Playwright flows (npm run e2e)
 *   --with-chain  also run the full cold on-chain ride loop (npm run smoke:ride)
 *   --full        both of the above
 */
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const withE2e = argv.includes("--with-e2e") || argv.includes("--full");
const withChain = argv.includes("--with-chain") || argv.includes("--full");

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

/**
 * One reviewer-facing step. `script` is an npm run target; `proves` is the
 * one-line claim it establishes.
 */
const steps = [
  { script: "smoke:demo", title: "The live demo is up", proves: "every route + the faucet API answer on testnet, and the DeepBook mid is live" },
  { script: "verify:fairness", title: "Provable fairness — honest path", proves: "the in-browser/CLI replay reproduces the chain's candles bit-for-bit → PASS" },
  { script: "verify:fairness:tamper", title: "Provable fairness — tamper caught", proves: "flip one reported extremum and the verifier exits non-zero → the house can't cheat", expectFail: true },
  { script: "verify:fairness:rug", title: "Provable house edge — honest MARKET HALT", proves: "the v4.26 rug only fires on an honest keccak roll (roll < rug_chance_bps); the verifier re-derives it and routes the wiped ride to EXPIRED_LOSS → the house can't fake or hide a halt" },
  { script: "verify:pro", title: "Live P&L == settlement", proves: "the number you watch on /pro equals the number you're paid, to 1e-9, off the real DeepBook mark" },
  { script: "verify:pro-fairness", title: "/pro provable fairness — commit-reveal", proves: "every /pro round's price path is SHA-256-committed before the lobby; recompute the digest independently (node:crypto) and it binds → the path was fixed before you bet" },
  { script: "verify:pro-fairness:tamper", title: "/pro provable fairness — forged reveal caught", proves: "a dishonest house forges a more-favourable reveal under the published commit; the independent verifier rejects all 4 → the house can't move the path after committing", expectFail: true },
];

const results = [];
function run(script, extraArgs = []) {
  const r = spawnSync(npm, ["run", "--silent", script, ...extraArgs], {
    stdio: "inherit",
    encoding: "utf8",
  });
  return r.status === 0;
}

console.log(C.bold("\n══════════════════════════════════════════════════════════════════"));
console.log(C.bold("  Wick Markets — reviewer proof  (no wallet, no browser, ~15s)"));
console.log(C.bold("══════════════════════════════════════════════════════════════════"));

let n = 0;
for (const step of steps) {
  n += 1;
  console.log(C.cyan(`\n[${n}/${steps.length}] ${step.title}`));
  console.log(C.dim(`      proves: ${step.proves}`));
  console.log(C.dim(`      $ npm run ${step.script}`));
  const exitedZero = run(step.script);
  // For a tamper step, a NON-zero exit is the success condition (the verifier
  // refused to bless a doctored chain). Invert accordingly.
  const ok = step.expectFail ? !exitedZero : exitedZero;
  results.push({ ...step, ok });
  const label = step.expectFail ? `${step.script} caught the tamper` : `${step.script} PASS`;
  console.log(ok ? C.green(`   ✓ ${label}`) : C.red(`   ✗ ${step.script} ${step.expectFail ? "did NOT catch the tamper" : "FAIL"}`));
}

if (withE2e) {
  console.log(C.cyan(`\n[+] Live UI flows (headless Chromium)`));
  console.log(C.dim(`      proves: /pro opens an option whose live P&L ticks; /verify catches a tampered candle; /coach renders the live desk`));
  const ok = run("e2e");
  results.push({ script: "e2e", title: "Live UI flows", ok });
  console.log(ok ? C.green("   ✓ e2e PASS") : C.red("   ✗ e2e FAIL"));

  console.log(C.cyan(`\n[+] Every route + the unknown-route fallback`));
  console.log(C.dim(`      proves: /pro · /coach · /ride · /verify all render; a mistyped URL falls through to the Ride game, never the crash screen`));
  const routesOk = run("check:routes");
  results.push({ script: "check:routes", title: "All routes + unknown-route guard", ok: routesOk });
  console.log(routesOk ? C.green("   ✓ check:routes PASS") : C.red("   ✗ check:routes FAIL (a route is down or the live deploy is stale)"));
}

if (withChain) {
  console.log(C.cyan(`\n[+] Full on-chain ride loop (real testnet txs)`));
  console.log(C.dim(`      proves: a cold burner funds itself, opens → cranks → settles a ride, then audits it → PASS`));
  const ok = run("smoke:ride");
  results.push({ script: "smoke:ride", title: "On-chain ride loop", ok });
  console.log(ok ? C.green("   ✓ smoke:ride PASS") : C.red("   ✗ smoke:ride FAIL"));

  // The LIVE counterpart to the synthetic `verify:fairness:rug` in the default
  // run: re-derive the keccak roll of EVERY MARKET HALT this market ever fired
  // and prove the house could neither fake one nor suppress one — against the
  // real chain history, not a mock. The house edge, audited end-to-end.
  console.log(C.cyan(`\n[+] Every on-chain MARKET HALT is honest (real history)`));
  console.log(C.dim(`      proves: re-derive the keccak roll for every rug the market ever fired → all honest (none faked, none suppressed)`));
  const rugsOk = run("check:rugs");
  results.push({ script: "check:rugs", title: "On-chain halt audit", ok: rugsOk });
  console.log(rugsOk ? C.green("   ✓ check:rugs PASS") : C.red("   ✗ check:rugs FAIL"));

  // Closes the fairness loop. verify:fairness proves candles ⟸ keys; this proves
  // keys ⟸ sui::random — every recorded segment's 32-byte key was drawn from the
  // on-chain Random object (gated by Sui's PTB-Random rule, so it's un-grindable).
  // Together: the house can't choose the keys, and the candles follow from them.
  console.log(C.cyan(`\n[+] The candle keys come from sui::random (not the house)`));
  console.log(C.dim(`      proves: every record_segment_v4 crank drew its key from the on-chain Random — keys ⟸ sui::random, completing candles ⟸ keys`));
  const rndOk = run("verify:randomness");
  results.push({ script: "verify:randomness", title: "Keys from sui::random", ok: rndOk });
  console.log(rndOk ? C.green("   ✓ verify:randomness PASS") : C.red("   ✗ verify:randomness FAIL"));
}

const failed = results.filter((r) => !r.ok);

console.log(C.bold("\n──────────────────────────────────────────────────────────────────"));
if (failed.length === 0) {
  console.log(C.green(C.bold(`  PASS — ${results.length}/${results.length} proofs green.`)));
} else {
  console.log(C.red(C.bold(`  FAIL — ${failed.length}/${results.length} proofs failed: ${failed.map((f) => f.script).join(", ")}`)));
}

if (!withE2e || !withChain) {
  console.log(C.dim("\n  Go deeper (hands-on):"));
  if (!withE2e) console.log(C.dim("    npm run judge -- --with-e2e     # watch the live UI honor the same guarantees"));
  if (!withChain) console.log(C.dim("    npm run judge -- --with-chain   # fund a burner & run a real on-chain ride, cold"));
  console.log(C.dim("    npm run judge -- --full         # everything"));
}
console.log(C.dim("\n  Play it:   https://wick-markets.vercel.app/pro"));
console.log(C.dim("  Verify it: https://wick-markets.vercel.app/verify"));
console.log(C.bold("──────────────────────────────────────────────────────────────────\n"));

process.exit(failed.length === 0 ? 0 : 1);
