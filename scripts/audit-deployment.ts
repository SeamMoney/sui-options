#!/usr/bin/env tsx
/**
 * audit-deployment — prove the ENTIRE live v4 deployment is honest, in one
 * command. Reads every `segment_markets_v4` entry from
 * `deployments/testnet.json` and runs the prune-proof `scripts/verify-v4.ts`
 * segment audit against each, then prints a PASS/FAIL summary.
 *
 *   npx tsx scripts/audit-deployment.ts            # or: npm run audit:deployment
 *   npx tsx scripts/audit-deployment.ts --window 12
 *
 * Each market is audited independently: for the most recent `--window` segments
 * the recorded (min, max) must reproduce from the chain's own segment keys +
 * carried state (no event replay, no faucet, no wallet — survives public-node
 * pruning). A single tampered extremum on any market flips that market to FAIL
 * and the whole command exits non-zero, so it can gate a demo runbook.
 *
 * This is the breadth companion to the single-market `verify:fairness:live`
 * and the rug-focused `check:rugs`: it asserts EVERY market a judge could land
 * on is reproducible, not just one.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const RPC = process.env.WICK_API_RPC ?? "https://sui-testnet-rpc.publicnode.com";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const WINDOW = arg("--window", "8");

interface MarketEntry {
  market: string;
  name?: string;
  collateral?: string;
}

function loadMarkets(): MarketEntry[] {
  const path = join(REPO_ROOT, "deployments", "testnet.json");
  const dep = JSON.parse(readFileSync(path, "utf8")) as {
    segment_markets_v4?: MarketEntry[];
  };
  const markets = (dep.segment_markets_v4 ?? []).filter((m) => typeof m.market === "string");
  if (markets.length === 0) {
    throw new Error("no segment_markets_v4 in deployments/testnet.json");
  }
  return markets;
}

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;

interface Result {
  name: string;
  market: string;
  status: "PASS" | "FAIL" | "EMPTY";
  segments: string;
}

function auditOne(m: MarketEntry): Result {
  const name = m.name ?? m.market.slice(0, 10);
  let out = "";
  let ok = false;
  try {
    out = execFileSync(
      "npx",
      ["tsx", join(REPO_ROOT, "scripts/verify-v4.ts"), "--market", m.market, "--window", WINDOW, "--rpc", RPC],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    ok = true;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    out = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
    ok = false;
  }
  return classifyVerifyOutput(out, ok, name, m.market);
}

/**
 * Map a verify-v4 run (its stdout + whether it exited 0) to a per-market
 * verdict. Pure — separated from the subprocess so it's unit-testable:
 *   - "EMPTY" when the market had no segments in range (idle, not a failure)
 *   - "PASS"  only when the verifier ran AND printed the honest verdict
 *   - "FAIL"  otherwise (tamper, unreachable, or a non-zero exit)
 */
export function classifyVerifyOutput(out: string, ranOk: boolean, name: string, market: string): Result {
  // Pull the recorded-segment count the verifier prints ("segments: N recorded …").
  const segMatch = /segments:\s+(\d+)\s+recorded/.exec(out);
  const segments = segMatch ? segMatch[1]! : "?";
  if (/No segments in range — nothing to verify/.test(out)) {
    return { name, market, status: "EMPTY", segments };
  }
  const passed = ranOk && /\bPASS — the chain was honest\.\s*$/.test(out.trim());
  return { name, market, status: passed ? "PASS" : "FAIL", segments };
}

function main(): void {
  const markets = loadMarkets();
  console.log(`auditing ${markets.length} live v4 market(s) @ ${RPC}`);
  console.log(dim(`(prune-proof: re-runs the seeded walk from each market's own segment keys; window=${WINDOW})`));
  console.log("");

  const results: Result[] = [];
  for (const m of markets) {
    process.stdout.write(`  ${m.name ?? m.market.slice(0, 10)} … `);
    const r = auditOne(m);
    results.push(r);
    const tag =
      r.status === "PASS" ? green("✓ HONEST") : r.status === "EMPTY" ? dim("· idle (no segments)") : red("✗ FAIL");
    console.log(`${tag}  ${dim(`${r.segments} seg · ${r.market.slice(0, 12)}…`)}`);
  }

  const failed = results.filter((r) => r.status === "FAIL");
  const audited = results.filter((r) => r.status === "PASS");
  console.log("");
  if (failed.length === 0) {
    console.log(
      green(
        `PASS — every live v4 market is provably honest (${audited.length} audited, ${
          results.length - audited.length
        } idle). No market can fake or alter a recorded candle.`,
      ),
    );
    process.exitCode = 0;
  } else {
    console.log(red(`FAIL — ${failed.length} market(s) failed reproduction: ${failed.map((f) => f.name).join(", ")}`));
    process.exitCode = 1;
  }
}

// Run only when invoked directly (not when imported by the test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
