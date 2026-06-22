#!/usr/bin/env tsx
/**
 * audit-ride — the COMPLETE provable-fairness audit of one closed v4 ride, in a
 * single command. Runs the verifiers back to back and fails if any fails:
 *
 *   1. scripts/verify-barriers.ts — the round's TOUCH barriers were not
 *      cherry-picked: they re-derive from the walk price at round-roll
 *      (spot ± barrier_offset_bps), which itself ⟸ the on-chain random keys.
 *   2. scripts/verify-v4.ts   — the candles are honest (every segment's high/low
 *      reproduces from its on-chain key), the MARKET HALT (rug) was an honest
 *      keccak roll, and the settlement KIND matches the price path.
 *   3. scripts/verify-payout.ts — the AMOUNT paid is exactly right (stake_paid
 *      re-derived from on-chain state; payout identity per settlement kind).
 *
 * Together: every dimension a skeptic could question — the barrier, the chart,
 * the house edge, the verdict, and the money — proven for a real on-chain ride.
 *
 *   npx tsx scripts/audit-ride.ts --market <SegmentMarketV4 id> --ride <id> [--rpc <url>]
 *   npm run audit:ride -- --market <id> --ride <id>
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RPC = "https://sui-testnet-rpc.publicnode.com";

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}
function argVal(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
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

/**
 * Refuse to "COMPLETE PASS" an OPEN ride. Each verifier SKIPS (prints "still
 * OPEN" and exits 0) when a ride has no settlement yet, so the aggregate would
 * otherwise claim the verdict + payout are "honest" when neither exists — a
 * vacuous pass. Read the ride's `closed` flag first and report honestly instead.
 * Best-effort: an RPC/lookup failure falls through so a real audit is never
 * blocked by the pre-check; synthetic (mock://) modes have no live object.
 */
async function rideIsOpen(): Promise<boolean> {
  const rideId = argVal("--ride");
  const rpc = argVal("--rpc") ?? DEFAULT_RPC;
  if (!rideId || rpc.startsWith("mock://")) return false;
  try {
    const client = new SuiJsonRpcClient({ network: "testnet", url: rpc });
    const o = (await client.getObject({
      id: rideId,
      options: { showContent: true },
    })) as { data?: { content?: { fields?: { closed?: unknown } } } };
    return o?.data?.content?.fields?.closed === false;
  } catch {
    return false; // never block a real audit on a flaky pre-check
  }
}

async function main(): Promise<void> {
  if (await rideIsOpen()) {
    console.log(`\n${"═".repeat(72)}`);
    console.log("  ⏳ RIDE STILL OPEN — nothing to audit yet.");
    console.log("     No settlement, verdict, or payout exists until the ride closes.");
    console.log("     Re-run audit:ride after close_ride / crank_expired_ride.");
    console.log("═".repeat(72));
    process.exitCode = 2;
    return;
  }

  const barriers = step(
    "1/3  ROUND BARRIERS — not cherry-picked   (scripts/verify-barriers.ts)",
    "verify-barriers.ts",
  );
  const candlesAndHalt = step(
    "2/3  CANDLES · MARKET HALT · VERDICT   (scripts/verify-v4.ts)",
    "verify-v4.ts",
  );
  const payout = step("3/3  PAYOUT AMOUNT   (scripts/verify-payout.ts)", "verify-payout.ts");

  console.log(`\n${"═".repeat(72)}`);
  const pass = barriers && candlesAndHalt && payout;
  if (pass) {
    console.log("  ✅ COMPLETE AUDIT PASS — barriers, candles, house edge, verdict, AND payout are honest.");
  } else {
    console.log(
      `  ❌ AUDIT FAILED — barriers: ${barriers ? "PASS" : "FAIL"} · candles/halt/verdict: ${candlesAndHalt ? "PASS" : "FAIL"} · payout: ${payout ? "PASS" : "FAIL"}`,
    );
  }
  console.log("═".repeat(72));
  process.exitCode = pass ? 0 : 1;
}

void main();
