#!/usr/bin/env tsx
/**
 * vault-solvency — prove the live MartingalerVault is solvent on-chain, right
 * now. The vault is the loss-recycling LP that backs every payout; the Move
 * conservation suite proves the v2 invariant `cumulative_in − cumulative_out ==
 * held` (held = treasury + side_bucket + Σ per-market locks) — see
 * `move/SAFETY.md` — and this is the LIVE companion: it reads each deployed
 * vault's on-hand reserves and confirms they cover its outstanding obligations.
 *
 *   npx tsx scripts/vault-solvency.ts        # or: npm run vault:solvency
 *
 * The unambiguous solvency invariant a snapshot can check from object state:
 *
 *     treasury + side_bucket  ≥  queue_total
 *
 * `queue_total` is the sum still owed to the FIFO claim queue (payouts the
 * vault couldn't cover instantly and is clearing from inflows). If on-hand
 * liquid reserves cover the whole backlog, the vault can settle every
 * outstanding claim immediately — solvent. Winners' already-settled payouts
 * are held as real `Balance` objects in per-market settlement_locks (the vault
 * literally holds the coins), so they're self-covering and not at risk.
 *
 * Read-only, current state (no pruned-tx dependency — runs on any node). Exits
 * non-zero if any vault can't clear its queue, so it can gate a runbook.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const RPC = arg("--rpc") ?? process.env.WICK_API_RPC ?? "https://sui-testnet-rpc.publicnode.com";
// Fall back past a throttle/hiccup on the default public node to the archival
// fullnode, so prove:live's solvency step doesn't fail on a transient RPC error
// (matches verify-v4 / verify-payout / audit-rugs). Dedup handles the default.
const FALLBACK_RPCS = [
  "https://sui-testnet-rpc.publicnode.com",
  "https://fullnode.testnet.sui.io:443",
];

interface VaultRpc {
  getObject(a: { id: string; options?: { showContent?: boolean; showType?: boolean } }): Promise<unknown>;
}

const RPC_TIMEOUT_MS = 20_000;

/** Reject if a call hasn't settled in `ms` — a hanging node becomes a thrown
 *  timeout so the client falls back instead of appearing stuck. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`RPC timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** getObject across several endpoints, falling back on a thrown RPC error or a
 *  per-call timeout (a hanging node). */
function makeResilientClient(urls: string[]): VaultRpc {
  const seen = new Set<string>();
  const clients = urls
    .filter((u) => u && !seen.has(u) && seen.add(u))
    .map((url) => new SuiJsonRpcClient({ url, network: "testnet" }));
  return {
    async getObject(a) {
      let last: unknown;
      for (const c of clients) {
        try {
          return await withTimeout(c.getObject(a as never), RPC_TIMEOUT_MS);
        } catch (e) {
          last = e;
        }
      }
      throw last instanceof Error ? last : new Error(String(last));
    },
  };
}

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;
/** SuiScan link so a judge can open the vault and see its reserves first-hand. */
const suiscan = (kind: "object" | "tx", id: string): string => `https://suiscan.xyz/testnet/${kind}/${id}`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

/** Decimals + ticker for the collateral types we deploy against. */
export function denom(collateralType: string): { decimals: number; ticker: string } {
  if (/::sui::SUI$/i.test(collateralType)) return { decimals: 9, ticker: "SUI" };
  if (/::tusd::TUSD$/i.test(collateralType)) return { decimals: 6, ticker: "TUSD" };
  return { decimals: 0, ticker: collateralType.split("::").pop() ?? "units" };
}

export function human(raw: bigint, decimals: number): string {
  if (decimals === 0) return raw.toString();
  const s = raw.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, "").slice(0, 4);
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * The solvency invariant: liquid reserves (treasury + side_bucket) cover the
 * full FIFO claim queue. Pure so it can be unit-tested without a live vault.
 */
export function isSolvent(treasury: bigint, sideBucket: bigint, queueTotal: bigint): boolean {
  return treasury + sideBucket >= queueTotal;
}

export function asBig(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string" && v.trim() !== "") return BigInt(v);
  // A Balance<C> sometimes renders as { fields: { value: "..." } } or just the value.
  if (v && typeof v === "object") {
    const f = (v as { fields?: { value?: unknown }; value?: unknown });
    if (f.fields?.value != null) return asBig(f.fields.value);
    if (f.value != null) return asBig(f.value);
  }
  return 0n;
}

interface VaultEntry {
  key: string;
  id: string;
}

function loadVaults(): VaultEntry[] {
  const dep = JSON.parse(readFileSync(join(REPO_ROOT, "deployments", "testnet.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const out: VaultEntry[] = [];
  for (const [key, val] of Object.entries(dep)) {
    if (/^vault_/.test(key) && !/admin_cap/.test(key) && typeof val === "string" && val.startsWith("0x")) {
      out.push({ key, id: val });
    }
  }
  return out;
}

interface VaultState {
  id: string;
  collateralType: string;
  treasury: bigint;
  sideBucket: bigint;
  queueTotal: bigint;
  fees: bigint;
}

async function readVault(client: VaultRpc, id: string): Promise<VaultState | null> {
  const o = (await client.getObject({ id, options: { showContent: true, showType: true } })) as {
    data?: { content?: { dataType?: string } | null } | null;
  };
  if (!o.data || o.data.content?.dataType !== "moveObject") return null;
  const content = o.data.content as { fields: Record<string, unknown>; type: string };
  if (!/::martingaler_vault::MartingalerVault</.test(content.type)) return null;
  const m = /::martingaler_vault::MartingalerVault<(.+)>$/.exec(content.type);
  const f = content.fields;
  return {
    id,
    collateralType: m?.[1] ?? "",
    treasury: asBig(f.treasury),
    sideBucket: asBig(f.side_bucket),
    queueTotal: asBig(f.queue_total),
    fees: asBig(f.protocol_fees) + asBig(f.staker_fees) + asBig(f.insurance_fees),
  };
}

async function main(): Promise<void> {
  const client = makeResilientClient([RPC, ...FALLBACK_RPCS]);
  const vaults = loadVaults();
  console.log(`vault solvency — live MartingalerVault reserves @ ${RPC}`);
  console.log(dim(`(on-hand liquid reserves must cover the FIFO claim queue; Move proves the full conservation invariant in − out == held — see move/SAFETY.md)`));
  console.log("");

  let insolvent = 0;
  let checked = 0;
  for (const v of vaults) {
    const s = await readVault(client, v.id);
    if (!s) {
      console.log(`  ${v.key}: ${dim("not a MartingalerVault / unreadable — skipped")}`);
      continue;
    }
    checked++;
    const { decimals, ticker } = denom(s.collateralType);
    const liquid = s.treasury + s.sideBucket;
    const solvent = isSolvent(s.treasury, s.sideBucket, s.queueTotal);
    if (!solvent) insolvent++;
    const tag = solvent ? green("✓ SOLVENT") : red("✗ UNDER-COLLATERALIZED");
    console.log(`  ${bold(v.key)} ${dim(`(${ticker})`)}  ${tag}  ${dim(`↗ ${suiscan("object", v.id)}`)}`);
    console.log(
      `    treasury ${human(s.treasury, decimals)} + side_bucket ${human(s.sideBucket, decimals)} = ` +
        `${bold(human(liquid, decimals) + " " + ticker)} liquid  ≥  queue ${human(s.queueTotal, decimals)} ${ticker}`,
    );
    if (s.fees > 0n) console.log(dim(`    (+ ${human(s.fees, decimals)} ${ticker} accrued fees, routed separately)`));
    console.log("");
  }

  if (checked === 0) {
    console.log(red("no readable MartingalerVault found in deployments/testnet.json"));
    process.exitCode = 1;
    return;
  }
  if (insolvent === 0) {
    console.log(
      green(
        `PASS — every live vault is solvent (${checked} checked). On-hand reserves cover every ` +
          `outstanding claim; the loss-recycling LP can settle its full queue immediately.`,
      ),
    );
    process.exitCode = 0;
  } else {
    console.log(red(`FAIL — ${insolvent}/${checked} vault(s) cannot clear their claim queue from liquid reserves`));
    process.exitCode = 1;
  }
}

// Run only when invoked directly (not when imported by the test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
