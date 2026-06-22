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
import { dirname, join, resolve } from "node:path";
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

const passthrough = process.argv.slice(2); // --market/--ride/--rpc forwarded as-is

function step(title: string, script: string): boolean {
  console.log(`\n${"═".repeat(72)}\n  ${title}\n${"═".repeat(72)}`);
  const r = spawnSync("npx", ["tsx", join(here, script), ...passthrough], {
    stdio: "inherit",
    cwd: join(here, ".."),
  });
  return (r.status ?? 1) === 0;
}

export function norm(id: string): string {
  const h = (id.startsWith("0x") ? id.slice(2) : id).toLowerCase().padStart(64, "0");
  return `0x${h}`;
}

export type PreCheck =
  | { kind: "ok" }
  | { kind: "open" }
  | { kind: "mismatch"; rideMarket: string };

/**
 * Pure pre-check classifier (unit-tested): given the ride object's fields and the
 * --market arg, decide whether to refuse the audit. Mismatch takes priority over
 * open (auditing the wrong market is the more misleading failure). Unreadable
 * fields → "ok" so a flaky read never blocks a real audit.
 */
export function classifyRide(
  fields: { closed?: unknown; market_id?: unknown } | undefined,
  market: string | undefined,
): PreCheck {
  if (!fields) return { kind: "ok" };
  const rideMarket = typeof fields.market_id === "string" ? fields.market_id : undefined;
  if (market && rideMarket && norm(rideMarket) !== norm(market)) {
    return { kind: "mismatch", rideMarket };
  }
  if (fields.closed === false) return { kind: "open" };
  return { kind: "ok" };
}

/**
 * One live read of the ride object, guarding two ways the aggregate audit could
 * mislead a judge:
 *   • OPEN ride — each verifier SKIPS (prints "still OPEN", exits 0), so the
 *     aggregate would claim the verdict + payout are "honest" when neither
 *     exists yet (a vacuous pass).
 *   • market/ride MISMATCH — auditing a ride against the wrong --market reads a
 *     different market's segments and produces a confusing "the chain lied"
 *     FALSE alarm — the worst possible output for a fairness demo.
 * Best-effort: an RPC/lookup failure (or a mock:// rpc) returns "ok" so a real
 * audit is never blocked by the pre-check.
 */
async function preCheck(): Promise<PreCheck> {
  const rideId = argVal("--ride");
  const market = argVal("--market");
  const rpc = argVal("--rpc") ?? DEFAULT_RPC;
  if (!rideId || rpc.startsWith("mock://")) return { kind: "ok" };
  try {
    const client = new SuiJsonRpcClient({ network: "testnet", url: rpc });
    const o = (await client.getObject({
      id: rideId,
      options: { showContent: true },
    })) as { data?: { content?: { fields?: { closed?: unknown; market_id?: unknown } } } };
    return classifyRide(o?.data?.content?.fields, market);
  } catch {
    return { kind: "ok" }; // never block a real audit on a flaky pre-check
  }
}

async function main(): Promise<void> {
  const pre = await preCheck();
  if (pre.kind === "mismatch") {
    console.log(`\n${"═".repeat(72)}`);
    console.log("  ✋ MARKET / RIDE MISMATCH — refusing to audit (would falsely read 'chain lied').");
    console.log(`     This ride belongs to market ${pre.rideMarket}`);
    console.log(`     but --market was ${argVal("--market")}.`);
    console.log("     Re-run with the ride's own market (see `npm run rides:recent`).");
    console.log("═".repeat(72));
    process.exitCode = 2;
    return;
  }
  if (pre.kind === "open") {
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

// CLI entrypoint, guarded so the module can be imported by tests without running
// the audit (or exiting on the usage check).
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  if (hasFlag("-h") || hasFlag("--help") || !hasFlag("--market") || !hasFlag("--ride")) {
    console.error(
      "usage: npx tsx scripts/audit-ride.ts --market <SegmentMarketV4 id> --ride <id> [--rpc <url>]",
    );
    process.exit(2);
  }
  void main();
}
