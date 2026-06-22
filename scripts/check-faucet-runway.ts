#!/usr/bin/env tsx
/**
 * check:faucet-runway — assert the faucet wallet can still fund judges.
 *
 * The companion to check:chart-live: that catches a frozen chart, this catches a
 * drained faucet. A judge's FIRST action is "Get free funds"; if the faucet
 * wallet runs out of SUI, /api/faucet (and the TUSD mint, whose gas is SUI)
 * returns 503 — yet smoke:demo (site is UP) stays green, so the outage is
 * silent until a judge hits the door. This is the early-warning probe: read the
 * faucet wallet's SUI balance and FAIL if it's below --min-sui (default 20 SUI,
 * ~10 SUI drips of headroom) so an operator can refill BEFORE judges are blocked.
 *
 *   npm run check:faucet-runway
 *   npx tsx scripts/check-faucet-runway.ts --min-sui 20 --rpc <url>
 *
 * The faucet wallet is the owner of the TUSD TreasuryCap (same key drips SUI and
 * mints TUSD — see api/faucet-tusd.ts), so we never need the private key here.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

const DEFAULT_RPC = "https://sui-testnet-rpc.publicnode.com";
const FALLBACK_RPC = "https://fullnode.testnet.sui.io:443";
// Pinned in api/faucet-tusd.ts; the faucet wallet is this cap's owner.
const TUSD_TREASURY_CAP =
  "0x7db5b3edead4f503ce8ef19ace6eca26e961edd08871042ad5de6f870a369b11";
const MIST_PER_SUI = 1_000_000_000n;
const DRIP_MIST = 2n * MIST_PER_SUI; // /api/faucet drips 2 SUI/request
const DEFAULT_MIN_SUI = 20; // ~10 drips of headroom before we alert
const RPC_TIMEOUT_MS = 20_000;

// Per-call RPC timeout so a stuck endpoint can't hang the probe (and, via
// check:all, the whole demo-health gate) indefinitely — matches the fleet's
// resilience pattern (verify-barriers #434, check:rugs #437, verify-randomness #441).
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
function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export interface Runway {
  ok: boolean;
  drips: number;
}

/**
 * Pure runway verdict (unit-tested): how many SUI drips the balance covers, and
 * whether that clears the minimum. A zero/negative balance is never ok.
 */
export function classifyRunway(
  balanceMist: bigint,
  dripMist: bigint,
  minSuiMist: bigint,
): Runway {
  const drips = dripMist > 0n ? Number(balanceMist / dripMist) : 0;
  return { ok: balanceMist >= minSuiMist && balanceMist > 0n, drips };
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
  const minSui = Number(argVal("--min-sui") ?? DEFAULT_MIN_SUI);
  const minSuiMist = BigInt(Math.round(minSui)) * MIST_PER_SUI;

  const client = await firstWorkingClient(argVal("--rpc"));
  const cap = asObj(await withTimeout(client.getObject({ id: TUSD_TREASURY_CAP, options: { showOwner: true } }), RPC_TIMEOUT_MS));
  const owner = asObj(asObj(cap.data).owner).AddressOwner;
  if (typeof owner !== "string") {
    console.error("✗ faucet-runway: could not resolve the faucet wallet (TUSD cap owner).");
    process.exitCode = 1;
    return;
  }
  const bal = asObj(await withTimeout(client.getBalance({ owner, coinType: "0x2::sui::SUI" }), RPC_TIMEOUT_MS));
  const balanceMist = BigInt(String(bal.totalBalance ?? "0"));
  const sui = Number(balanceMist) / Number(MIST_PER_SUI);

  const { ok, drips } = classifyRunway(balanceMist, DRIP_MIST, minSuiMist);
  if (ok) {
    console.log(`✓ faucet-runway — ${sui.toFixed(2)} SUI (~${drips} drips) ≥ ${minSui} SUI. Judges can fund.`);
    process.exitCode = 0;
  } else {
    console.error(`✗ faucet LOW — ${sui.toFixed(2)} SUI (~${drips} drips) < ${minSui} SUI floor.`);
    console.error(`  Refill the faucet wallet ${owner} with SUI before judges are blocked at "Get free funds".`);
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
