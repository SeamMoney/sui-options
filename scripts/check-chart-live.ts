#!/usr/bin/env tsx
/**
 * check:chart-live — assert the live market is RECORDING fresh segments, i.e.
 * the /ride chart a judge watches is actually MOVING, not frozen.
 *
 * Why this exists: `smoke:demo` confirms the site is UP, `check:treasury` the
 * vault, `audit:deployment` the deploy — but NONE catch a dead cranker. If the
 * chart-keeper process dies the chart silently freezes: the page still loads
 * (smoke:demo stays green) yet a judge sees a flatlined chart. This is the
 * missing liveness probe — read the head segment's recorded_at_ms and FAIL if
 * it is older than --max-age-sec (default 180s), so a freeze is caught loudly.
 *
 *   npm run check:chart-live
 *   npx tsx scripts/check-chart-live.ts --market <id> --max-age-sec 180 --rpc <url>
 *
 * Exit 0 iff the chart is live (a segment recorded within the window).
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..");
const DEFAULT_RPC = "https://sui-testnet-rpc.publicnode.com";
const FALLBACK_RPC = "https://fullnode.testnet.sui.io:443";
const DEFAULT_MAX_AGE_SEC = 180;
const RPC_TIMEOUT_MS = 20_000;

// Per-call RPC timeout so a stuck endpoint can't hang the probe (and, via
// check:all, the whole demo-health gate) indefinitely — matches the fleet's
// resilience pattern (verify-barriers #434, check:rugs #437, verify-randomness
// #441). A timeout surfaces as a clear failure, not a silent stall.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`RPC timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

function liveMarketFromDeployment(): string | null {
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
function asBig(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string" && v.trim() !== "") return BigInt(v);
  return 0n;
}

export interface Freshness {
  live: boolean;
  ageSec: number;
}

/**
 * Pure freshness verdict (unit-tested): the chart is live iff the head segment
 * was recorded within maxAgeSec. A future/zero timestamp is treated as not-live
 * (a malformed read must not look "fresh").
 */
export function classifyFreshness(
  recordedAtMs: bigint,
  nowMs: number,
  maxAgeSec: number,
): Freshness {
  if (recordedAtMs <= 0n) return { live: false, ageSec: Number.POSITIVE_INFINITY };
  const ageMs = nowMs - Number(recordedAtMs);
  const ageSec = Math.round(ageMs / 1000);
  // A timestamp in the future (clock skew / bad read) is suspicious → not live.
  if (ageMs < -5000) return { live: false, ageSec };
  return { live: ageMs <= maxAgeSec * 1000, ageSec };
}

async function firstWorkingClient(rpcOverride?: string): Promise<SuiJsonRpcClient> {
  const urls = [rpcOverride, DEFAULT_RPC, FALLBACK_RPC].filter(Boolean) as string[];
  let lastErr: unknown;
  for (const url of urls) {
    try {
      const c = new SuiJsonRpcClient({ url, network: "testnet" });
      await withTimeout(Promise.resolve(c.getLatestSuiSystemState?.()), RPC_TIMEOUT_MS).catch(() => undefined);
      return c;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("no usable RPC");
}

async function main(): Promise<void> {
  const market = argVal("--market") ?? liveMarketFromDeployment();
  if (!market) throw new Error("no --market and no market in deployments/testnet.json");
  const maxAgeSec = Number(argVal("--max-age-sec") ?? DEFAULT_MAX_AGE_SEC);

  const client = await firstWorkingClient(argVal("--rpc"));
  const o = asObj(await withTimeout(client.getObject({ id: market, options: { showContent: true } }), RPC_TIMEOUT_MS));
  const f = asObj(asObj(asObj(o.data).content).fields);
  const next = asBig(f.next_segment_index);
  if (next <= 0n) {
    console.error(`✗ chart-live: market ${market} has recorded no segments yet.`);
    process.exitCode = 1;
    return;
  }
  const tableId = String(asObj(asObj(asObj(f.segments).fields).id).id);
  const head = asObj(
    await withTimeout(
      client.getDynamicFieldObject({ parentId: tableId, name: { type: "u64", value: (next - 1n).toString() } }),
      RPC_TIMEOUT_MS,
    ),
  );
  const recordedAtMs = asBig(asObj(asObj(asObj(asObj(head.data).content).fields).value).fields.recorded_at_ms);

  const { live, ageSec } = classifyFreshness(recordedAtMs, Date.now(), maxAgeSec);
  // Derive the round from the head segment index, not `cached_round_index` —
  // the cached field lags/races the live round on a round-roll (the bug class
  // fixed in the frontend verifier, #488). Falls back to the cached field only
  // if round_duration is unavailable. Display-only here, but keeps the shown
  // round consistent with the head segment number.
  const roundDur = asBig(f.round_duration_segments);
  const round = roundDur > 0n ? ((next - 1n) / roundDur).toString() : String(f.cached_round_index ?? "?");
  if (live) {
    console.log(`✓ chart-live — head segment #${next - 1n} (round ${round}) recorded ${ageSec}s ago (≤ ${maxAgeSec}s). The /ride chart is MOVING.`);
    process.exitCode = 0;
  } else {
    console.error(`✗ chart FROZEN — head segment #${next - 1n} (round ${round}) last recorded ${ageSec}s ago (> ${maxAgeSec}s).`);
    console.error("  The cranker / chart-keeper is likely DOWN — judges will see a flatlined chart. Restart it.");
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
