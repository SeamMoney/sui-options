#!/usr/bin/env tsx
/**
 * audit-ride — the COMPLETE provable-fairness audit of one closed v4 ride, in a
 * single command. Runs both verifiers back to back and fails if either fails:
 *
 *   1. scripts/verify-v4.ts   — the candles are honest (every segment's high/low
 *      reproduces from its on-chain key), the MARKET HALT (rug) was an honest
 *      keccak roll, and the settlement KIND matches the price path.
 *   2. scripts/verify-payout.ts — the AMOUNT paid is exactly right (stake_paid
 *      re-derived from on-chain state; payout identity per settlement kind).
 *
 * Together: every dimension a skeptic could question — the chart, the house
 * edge, the verdict, and the money — proven for a real on-chain ride.
 *
 *   npx tsx scripts/audit-ride.ts --market <SegmentMarketV4 id> --ride <id> [--rpc <url>]
 *   npm run audit:ride -- --market <id> --ride <id>
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

if (hasFlag("-h") || hasFlag("--help") || !hasFlag("--market") || !hasFlag("--ride")) {
  console.error(
    "usage: npx tsx scripts/audit-ride.ts --market <SegmentMarketV4 id> --ride <id> [--rpc <url>]",
  );
  process.exit(2);
}

const passthrough = process.argv.slice(2); // --market/--ride/--rpc forwarded as-is

function step(title: string, script: string): boolean {
  console.log(`\n${"═".repeat(72)}\n  ${title}\n${"═".repeat(72)}`);
  const r = spawnSync("npx", ["tsx", join(here, script), ...passthrough], {
    stdio: "inherit",
    cwd: join(here, ".."),
  });
  return (r.status ?? 1) === 0;
}

const candlesAndHalt = step(
  "1/2  CANDLES · MARKET HALT · VERDICT   (scripts/verify-v4.ts)",
  "verify-v4.ts",
);
const payout = step("2/2  PAYOUT AMOUNT   (scripts/verify-payout.ts)", "verify-payout.ts");

console.log(`\n${"═".repeat(72)}`);
const pass = candlesAndHalt && payout;
if (pass) {
  console.log("  ✅ COMPLETE AUDIT PASS — candles, house edge, verdict, AND payout are honest.");
} else {
  console.log(
    `  ❌ AUDIT FAILED — candles/halt/verdict: ${candlesAndHalt ? "PASS" : "FAIL"} · payout: ${payout ? "PASS" : "FAIL"}`,
  );
}
console.log("═".repeat(72));
process.exitCode = pass ? 0 : 1;
