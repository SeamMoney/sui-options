#!/usr/bin/env tsx
/**
 * audit-latest — the COMPLETE audit of the NEWEST real closed ride, in one
 * read-only command. No wallet, no faucet, no arguments.
 *
 * smoke:ride proves the same chain end-to-end but has to FUND a burner and make
 * a ride first. This is the read-only counterpart: it finds the most recent
 * `RideClosedV4` on the live market and hands it straight to scripts/audit-
 * ride.ts — barriers (not cherry-picked) · candles · MARKET HALT · verdict ·
 * payout, every dimension re-derived from the chain's own `sui::random` keys.
 *
 *   npm run audit:latest                 # newest ride on the rugged market
 *   npx tsx scripts/audit-latest.ts --market <id> --rpc <url>
 *
 * Want to pick a SPECIFIC outcome (a touch win, a cashout, a MARKET HALT)
 * instead of just the newest? `npm run rides:recent` lists one of each with a
 * paste-ready audit-ride command.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { rideClosedV4EventType, parseRideClosedV4Event } from "../sdk/src/segmentMarketV4.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..");

const FALLBACK_RPCS = [
  "https://sui-testnet-rpc.publicnode.com",
  "https://fullnode.testnet.sui.io:443",
];

function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

function ruggedMarketFromDeployment(): string | null {
  try {
    const d = JSON.parse(readFileSync(join(REPO_ROOT, "deployments", "testnet.json"), "utf8")) as {
      segment_markets_v4?: Array<{ market: string; rug_chance_bps?: number; name?: string }>;
    };
    const list = d.segment_markets_v4 ?? [];
    const rugged = list.find((e) => (e.rug_chance_bps ?? 0) > 0 || /rug/i.test(e.name ?? ""));
    return (rugged ?? list.at(-1))?.market ?? null;
  } catch {
    return null;
  }
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function asStr(v: unknown): string {
  return typeof v === "string" ? v : String(v);
}

/** The market object's type-origin package (RideClosedV4 is tagged with it). */
async function typePackage(client: SuiJsonRpcClient, marketId: string): Promise<string> {
  const o = asObj(await client.getObject({ id: marketId, options: { showType: true } }));
  const type = asStr(asObj(o.data).type);
  const marker = "::segment_market_v4::SegmentMarketV4<";
  const i = type.indexOf(marker);
  if (i < 0) throw new Error(`object ${marketId} is not a SegmentMarketV4 (type: ${type})`);
  return type.slice(0, i);
}

async function firstWorkingClient(rpcOverride?: string): Promise<SuiJsonRpcClient> {
  const urls = [rpcOverride, ...FALLBACK_RPCS].filter(Boolean) as string[];
  let lastErr: unknown;
  for (const url of urls) {
    try {
      const c = new SuiJsonRpcClient({ url, network: "testnet" });
      await c.getLatestSuiSystemState?.().catch(() => undefined); // cheap liveness ping (best-effort)
      return c;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("no usable RPC");
}

async function main(): Promise<void> {
  const rpc = argVal("--rpc");
  const market = argVal("--market") ?? ruggedMarketFromDeployment();
  if (!market) throw new Error("no --market and no market in deployments/testnet.json");

  const client = await firstWorkingClient(rpc);
  const pkg = await typePackage(client, market);

  // Newest RideClosedV4 for this market (scan a few pages; events are tagged
  // with the module's defining package, resolved above).
  type Cursor = { txDigest: string; eventSeq: string } | null;
  let cursor: Cursor = null;
  let rideId: string | null = null;
  for (let page = 0; page < 10 && !rideId; page++) {
    const res = (await client.queryEvents({
      query: { MoveEventType: rideClosedV4EventType(pkg) },
      cursor,
      limit: 50,
      order: "descending",
    } as never)) as { data: Array<{ parsedJson?: unknown }>; hasNextPage: boolean; nextCursor?: Cursor };
    for (const ev of res.data) {
      const e = parseRideClosedV4Event(ev.parsedJson as never);
      if (e.marketId.toLowerCase() === market.toLowerCase()) {
        rideId = e.rideId;
        break;
      }
    }
    if (!res.hasNextPage || !res.nextCursor) break;
    cursor = res.nextCursor;
  }

  if (!rideId) {
    console.error(
      `No closed rides found on ${market} yet — run \`npm run smoke:ride\` to make one, or pass --market <id>.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`audit-latest — newest closed ride on ${market}:`);
  console.log(`  ${rideId}\n`);

  const passArgs = ["tsx", join(here, "audit-ride.ts"), "--market", market, "--ride", rideId];
  if (rpc) passArgs.push("--rpc", rpc);
  try {
    execFileSync("npx", passArgs, { stdio: "inherit", cwd: REPO_ROOT });
  } catch {
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
