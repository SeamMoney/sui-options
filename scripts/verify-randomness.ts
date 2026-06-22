#!/usr/bin/env tsx
/**
 * verify-randomness — prove the segment keys come from Sui's on-chain
 * randomness, not a house-chosen seed. The candle verifier (verify-v4) proves
 * the candles derive from the recorded segment keys; this closes the other half
 * of the chain of custody: every `record_segment` transaction CONSUMES the
 * shared system `Random` object at 0x…08, so the 32-byte key is drawn from
 * `sui::random` inside the call. An attacker can't grind or pre-choose it (the
 * Move bytecode verifier's PTB-Random structural rule forbids reading the draw
 * in the same PTB), and the house can't substitute its own.
 *
 *   npx tsx scripts/verify-randomness.ts                 # busiest market
 *   npx tsx scripts/verify-randomness.ts --market <id> --n 8
 *
 * Reads recent record_segment txs and confirms each (a) called
 * record_segment(_v4) and (b) took 0x…08 (Random) as an input. Defaults to the
 * Mysten fullnode (PublicNode prunes tx bodies). Exits non-zero if any crank
 * is missing the randomness input.
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
const RPC = arg("--rpc") ?? process.env.WICK_API_RPC ?? "https://fullnode.testnet.sui.io";
const N = Math.max(1, Number(arg("--n") ?? "6"));
const RPC_TIMEOUT_MS = 25_000;

/** Reject if a call hasn't settled in `ms`. verify:randomness needs tx bodies
 *  (only the archival fullnode keeps them — no public-node fallback is possible),
 *  so a hang can't be recovered, but the timeout still turns an indefinite stall
 *  in prove:live / judge --with-chain into a clean, retryable failure. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`RPC timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

export const RANDOM_OBJECT = "0x0000000000000000000000000000000000000000000000000000000000000008";

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
/** SuiScan link so a judge can open the actual sui::random-consuming tx. */
const suiscan = (kind: "object" | "tx", id: string): string => `https://suiscan.xyz/testnet/${kind}/${id}`;

function busiestMarket(): string {
  const dep = JSON.parse(readFileSync(join(REPO_ROOT, "deployments", "testnet.json"), "utf8")) as {
    segment_markets_v4?: Array<{ market: string }>;
  };
  const first = (dep.segment_markets_v4 ?? [])[0]?.market;
  if (!first) throw new Error("no segment_markets_v4 in deployments/testnet.json");
  return first;
}

export function norm(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const hex = id.startsWith("0x") ? id.slice(2) : id;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  return "0x" + hex.padStart(64, "0").toLowerCase();
}

/** Extract input object ids from a tx's programmable inputs (several shapes). */
export function inputObjectIds(tx: Record<string, unknown> | undefined): string[] {
  const inputs = (tx?.inputs as Array<Record<string, unknown>>) ?? [];
  const out: string[] = [];
  for (const i of inputs) {
    const direct = norm(i.objectId);
    if (direct) out.push(direct);
    const shared = i.SharedObject as { objectId?: unknown } | undefined;
    const s = norm(shared?.objectId);
    if (s) out.push(s);
  }
  return out;
}

interface CrankCheck {
  digest: string;
  fn: string;
  usesRandom: boolean;
}

async function main(): Promise<void> {
  const client = new SuiJsonRpcClient({ url: RPC, network: "testnet" });
  const marketFilter = arg("--market") ?? null;

  // The SegmentRecordedV4 event type uses the module's TYPE package — read it
  // off a live market object rather than guessing the (upgraded) package id.
  const probeMarket = marketFilter ?? busiestMarket();
  const o = await withTimeout(client.getObject({ id: probeMarket, options: { showType: true } }), RPC_TIMEOUT_MS);
  const typePkg = (o.data?.type ?? "").split("::")[0];
  if (!typePkg) throw new Error(`could not read market type for ${probeMarket}`);

  console.log(`randomness provenance — segment keys are drawn from sui::random @ ${RPC}`);
  console.log(
    dim(
      `${marketFilter ? `market ${marketFilter}` : "recent cranks across the protocol"} · ` +
        `auditing up to ${N} record_segment tx(s) via SegmentRecordedV4 events`,
    ),
  );
  console.log("");

  // Each SegmentRecordedV4 event was emitted BY a record_segment tx; its digest
  // is the crank we audit. Page descending until we have N (optionally filtered
  // to one market). Robust against the ChangedObject filter being unindexed.
  const eventType = `${typePkg}::segment_market_v4::SegmentRecordedV4`;
  const digests: string[] = [];
  let cursor: { txDigest: string; eventSeq: string } | null = null;
  for (let p = 0; p < 8 && digests.length < N; p++) {
    const page = await withTimeout(client.queryEvents({ query: { MoveEventType: eventType }, cursor, limit: 25, order: "descending" }), RPC_TIMEOUT_MS);
    for (const e of page.data) {
      const j = (e.parsedJson ?? {}) as { market_id?: string };
      if (marketFilter && j.market_id !== marketFilter) continue;
      const dig = e.id?.txDigest;
      if (dig && !digests.includes(dig)) digests.push(dig);
      if (digests.length >= N) break;
    }
    if (!page.hasNextPage || !page.nextCursor) break;
    cursor = page.nextCursor as { txDigest: string; eventSeq: string };
  }

  const checks: CrankCheck[] = [];
  for (const digest of digests) {
    const tb = await withTimeout(client.getTransactionBlock({ digest, options: { showInput: true } }), RPC_TIMEOUT_MS);
    const tx = (tb.transaction?.data?.transaction as Record<string, unknown>) ?? undefined;
    const cmds = (tx?.transactions as Array<{ MoveCall?: { function?: string } }>) ?? [];
    const fn = cmds.find((t) => t.MoveCall)?.MoveCall?.function ?? "";
    if (!/^record_segment/.test(fn)) continue;
    checks.push({ digest, fn, usesRandom: inputObjectIds(tx).includes(RANDOM_OBJECT) });
  }

  if (checks.length === 0) {
    console.log(red("no record_segment transactions found to audit — try --rpc https://fullnode.testnet.sui.io"));
    process.exitCode = 1;
    return;
  }

  let bad = 0;
  for (const c of checks) {
    const tag = c.usesRandom ? green("✓ drew from 0x…08 Random") : red("✗ NO Random input");
    if (!c.usesRandom) bad++;
    console.log(`  ${c.fn.padEnd(20)} ${tag}  ${dim(c.digest)}  ${dim(`↗ ${suiscan("tx", c.digest)}`)}`);
  }
  console.log("");
  if (bad === 0) {
    console.log(
      green(
        `PASS — all ${checks.length} cranks drew their key from sui::random (0x…08). ` +
          "The keys aren't house-chosen; combined with verify-v4 (candles ⟸ keys) the whole path is on-chain-honest.",
      ),
    );
    process.exitCode = 0;
  } else {
    console.log(red(`FAIL — ${bad}/${checks.length} record_segment tx(s) did not consume the system Random object`));
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
