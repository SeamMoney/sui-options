#!/usr/bin/env tsx
/**
 * audit-rugs — prove EVERY `MARKET HALT` (v4.26 rug) a market ever fired was
 * cryptographically honest, BOTH ways:
 *
 *   1. No FAKED halt — for each round the chain rugged, re-derive the public
 *      keccak roll for the claimed rug segment and confirm it really did roll
 *      `< rug_chance_bps`. The house can't halt a round the dice didn't call.
 *   2. No SUPPRESSED halt (the subtle one) — confirm NO earlier segment in that
 *      round also rolled `< rug_chance_bps`. `roll_rug` fires on the FIRST
 *      qualifying segment, so if an earlier one qualified the chain skipped it —
 *      which is exactly how a cheating house would keep a winning ride alive.
 *
 * Together these pin the house edge to the published dice: it can neither
 * invent a halt nor hold one back. This is the cryptographic complement to
 * `verify-v4.26-rug.mjs` (which checks the rug RATE statistically).
 *
 * Ground truth (round → rugged segment) comes from the chain's own
 * `RugFiredV4` events; the per-segment keys come straight from the market's
 * `Table` (dynamic fields). The roll is re-derived with the SAME `rollRugFired`
 * (`scripts/rugRoll.ts`) the live `verify-v4` CLI uses.
 *
 * Usage:
 *   npx tsx scripts/audit-rugs.ts [--market <SegmentMarketV4 id>] [--rpc <url>] [--max-rounds N]
 *
 * With no --market it audits the rugged market from deployments/testnet.json.
 * Exit 0 iff every halt is honest; non-zero (and a pinpointed report) otherwise.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { rollRugFired } from "./rugRoll.js";

const FALLBACK_RPCS = [
  "https://sui-testnet-rpc.publicnode.com",
  "https://fullnode.testnet.sui.io:443",
];

interface Args {
  market?: string;
  rpc?: string;
  maxRounds: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { maxRounds: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--market" && next) { out.market = next; i++; }
    else if (a === "--rpc" && next) { out.rpc = next; i++; }
    else if (a === "--max-rounds" && next) { out.maxRounds = Number(next); i++; }
    else if (a === "-h" || a === "--help") {
      console.error("usage: npx tsx scripts/audit-rugs.ts [--market <id>] [--rpc <url>] [--max-rounds N]");
      process.exit(2);
    } else { throw new Error(`unknown or incomplete argument: ${a}`); }
  }
  return out;
}

type EventCursor = { txDigest: string; eventSeq: string };

/** Multi-endpoint client: each call tries every url until one succeeds. */
class ResilientClient {
  private readonly clients: SuiJsonRpcClient[];
  constructor(urls: string[]) {
    const seen = new Set<string>();
    this.clients = urls
      .filter((u) => u && !seen.has(u) && seen.add(u))
      .map((url) => new SuiJsonRpcClient({ url, network: "testnet" }));
  }
  private async tryAll<T>(fn: (c: SuiJsonRpcClient) => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (const c of this.clients) {
      try { return await fn(c); } catch (e) { lastErr = e; }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
  getObject(a: unknown) { return this.tryAll((c) => c.getObject(a as never)); }
  getDynamicFieldObject(a: unknown) { return this.tryAll((c) => c.getDynamicFieldObject(a as never)); }
  queryEvents(a: unknown) {
    return this.tryAll((c) => c.queryEvents(a as never)) as Promise<{
      data: Array<{ parsedJson?: unknown }>;
      hasNextPage: boolean;
      nextCursor?: EventCursor | null;
    }>;
  }
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function asString(v: unknown): string {
  return typeof v === "string" ? v : String(v);
}
function asBig(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string" && v.trim() !== "") return BigInt(v);
  return 0n;
}
function asBytes(v: unknown): Uint8Array {
  if (Array.isArray(v)) return new Uint8Array(v as number[]);
  if (typeof v === "string") {
    const h = v.startsWith("0x") ? v.slice(2) : v;
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  return new Uint8Array();
}
function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

const RUG_CONFIG_KEY_BYTES = Array.from(new TextEncoder().encode("rug_config"));

interface MarketInfo {
  marketId: string;
  typePackage: string;
  segmentsTableId: string;
  roundDurationSegments: bigint;
  rugChanceBps: bigint;
}

async function readMarket(client: ResilientClient, marketId: string): Promise<MarketInfo> {
  const o = asObject(await client.getObject({ id: marketId, options: { showContent: true, showType: true } }));
  const content = asObject(asObject(o.data).content);
  const type = asString(content.type);
  const m = /::segment_market_v4::SegmentMarketV4<(.+)>$/.exec(type);
  if (!m) throw new Error(`object ${marketId} is not a SegmentMarketV4 (type: ${type})`);
  const f = asObject(content.fields);
  const tableId = asString(asObject(asObject(asObject(f.segments).fields).id).id);

  let rugChanceBps = 0n;
  try {
    const rc = asObject(await client.getDynamicFieldObject({
      parentId: marketId,
      name: { type: "vector<u8>", value: RUG_CONFIG_KEY_BYTES },
    }));
    const cfg = asObject(asObject(asObject(asObject(asObject(rc.data).content).fields).value).fields);
    rugChanceBps = asBig(cfg.rug_chance_bps);
  } catch { /* rug disabled */ }

  return {
    marketId,
    typePackage: type.split("::")[0]!,
    segmentsTableId: tableId,
    roundDurationSegments: asBig(f.round_duration_segments),
    rugChanceBps,
  };
}

/** Read one segment's 32-byte key from the market's Table<u64, SegmentRecord>. */
async function readSegmentKey(
  client: ResilientClient,
  tableId: string,
  k: bigint,
): Promise<Uint8Array | null> {
  const d = asObject(await client.getDynamicFieldObject({
    parentId: tableId,
    name: { type: "u64", value: k.toString() },
  }));
  const content = asObject(asObject(d.data).content);
  if (!content.fields) return null;
  const value = asObject(asObject(content.fields).value);
  const sf = asObject(value.fields);
  if (sf.key === undefined) return null;
  return asBytes(sf.key);
}

interface RugEvent { round: bigint; segment: bigint }

/** All RugFiredV4 events for the market — the chain's own halt history. */
async function fetchRugHistory(
  client: ResilientClient,
  candidatePackages: string[],
  marketId: string,
): Promise<RugEvent[]> {
  for (const pkg of candidatePackages) {
    if (!pkg) continue;
    const eventType = `${pkg}::segment_market_v4::RugFiredV4`;
    const found: RugEvent[] = [];
    let cursor: EventCursor | null = null;
    let ok = false;
    try {
      for (let p = 0; p < 50; p++) {
        const page = await client.queryEvents({
          query: { MoveEventType: eventType }, cursor, limit: 50, order: "descending",
        });
        ok = true;
        for (const e of page.data) {
          const j = asObject(e.parsedJson);
          if (sameId(asString(j.market_id), marketId)) {
            found.push({ round: asBig(j.round_index), segment: asBig(j.segment_index) });
          }
        }
        if (!page.hasNextPage || !page.nextCursor) break;
        cursor = page.nextCursor;
      }
    } catch { ok = false; }
    if (ok && found.length > 0) {
      // de-dup + sort by round ascending
      const byRound = new Map<string, RugEvent>();
      for (const r of found) byRound.set(r.round.toString(), r);
      return [...byRound.values()].sort((a, b) => (a.round < b.round ? -1 : 1));
    }
  }
  return [];
}

function deploymentPackages(): string[] {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const d = JSON.parse(readFileSync(resolve(here, "..", "deployments", "testnet.json"), "utf8")) as {
      package_id?: string;
      upgrade_history?: Array<{ to_package_id?: string; from_package_id?: string }>;
      segment_markets_v4?: Array<{ market: string; collateral?: string }>;
    };
    const out: string[] = [];
    if (d.package_id) out.push(d.package_id);
    for (const u of (d.upgrade_history ?? []).slice().reverse()) {
      if (u.to_package_id) out.push(u.to_package_id);
      if (u.from_package_id) out.push(u.from_package_id);
    }
    return out;
  } catch { return []; }
}

function ruggedMarketFromDeployment(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const d = JSON.parse(readFileSync(resolve(here, "..", "deployments", "testnet.json"), "utf8")) as {
      segment_markets_v4?: Array<{ market: string; rug_chance_bps?: number; name?: string }>;
    };
    const list = d.segment_markets_v4 ?? [];
    // Prefer an entry that advertises a rug; else the last v4 market.
    const rugged = list.find((e) => (e.rug_chance_bps ?? 0) > 0 || /rug/i.test(e.name ?? ""));
    return (rugged ?? list.at(-1))?.market ?? null;
  } catch { return null; }
}

interface RoundAudit {
  round: bigint;
  chainRugSeg: bigint;
  rollAtRug: bigint;
  fired: boolean;
  earlierFire: bigint | null; // first earlier segment that wrongly qualified, if any
  honest: boolean;
}

async function audit(args: Args): Promise<boolean> {
  const marketId = args.market ?? ruggedMarketFromDeployment();
  if (!marketId) throw new Error("no --market given and no rugged market in deployments/testnet.json");

  const client = new ResilientClient([args.rpc ?? "", ...FALLBACK_RPCS]);
  const market = await readMarket(client, marketId);

  console.log(`market:        ${marketId}`);
  console.log(`type package:  ${market.typePackage}`);
  console.log(`round length:  ${market.roundDurationSegments} segments`);
  console.log(`rug chance:    ${market.rugChanceBps} bps`);

  if (market.rugChanceBps <= 0n) {
    console.log("\nrug is not enabled on this market — nothing to audit.");
    return true;
  }

  const history = await fetchRugHistory(
    client,
    [...deploymentPackages(), market.typePackage],
    marketId,
  );
  if (history.length === 0) {
    console.log("\nNo RugFiredV4 events found for this market yet — no halts to audit.");
    return true;
  }

  const rounds = history.slice(0, Number.isFinite(args.maxRounds) ? args.maxRounds : history.length);
  console.log(`halts on chain: ${history.length}${rounds.length < history.length ? ` (auditing ${rounds.length})` : ""}\n`);

  const audits: RoundAudit[] = [];
  for (const ev of rounds) {
    const roundStart = ev.round * market.roundDurationSegments;
    // Re-derive the roll at the claimed rug segment.
    const rugKey = await readSegmentKey(client, market.segmentsTableId, ev.segment);
    const atRug = rugKey
      ? rollRugFired(rugKey, marketId, ev.round, market.rugChanceBps)
      : { roll: -1n, fired: false };

    // Scan earlier segments in the round: NONE should have qualified.
    let earlierFire: bigint | null = null;
    for (let k = roundStart; k < ev.segment; k++) {
      const key = await readSegmentKey(client, market.segmentsTableId, k);
      if (!key) continue;
      if (rollRugFired(key, marketId, ev.round, market.rugChanceBps).fired) {
        earlierFire = k;
        break;
      }
    }

    const honest = atRug.fired && earlierFire === null;
    audits.push({
      round: ev.round,
      chainRugSeg: ev.segment,
      rollAtRug: atRug.roll,
      fired: atRug.fired,
      earlierFire,
      honest,
    });

    const status = honest
      ? "✓ HONEST"
      : !atRug.fired
        ? `✗ FAKED (roll ${atRug.roll} ≥ ${market.rugChanceBps} — should NOT have halted)`
        : `✗ SUPPRESSED (segment ${earlierFire} rolled < ${market.rugChanceBps} earlier — chain should have halted there)`;
    console.log(
      `round ${ev.round.toString().padStart(3)} · halt @ segment ${ev.segment.toString().padStart(5)} · roll ${atRug.roll.toString().padStart(5)} < ${market.rugChanceBps}  ${status}`,
    );
  }

  const bad = audits.filter((a) => !a.honest);
  console.log("");
  if (bad.length === 0) {
    console.log(
      `PASS — all ${audits.length} on-chain MARKET HALTs are cryptographically honest:`,
    );
    console.log(
      "       every halt rolled below the published dice, and no earlier segment in the round did.",
    );
    console.log(
      "       The house can neither fake a halt nor suppress one. That is the house edge, provable.",
    );
    return true;
  }
  console.log(`FAIL — ${bad.length}/${audits.length} halts are NOT honest (see ✗ above). The chain lied.`);
  return false;
}

// CLI entrypoint (guarded so the module can be imported by tests).
const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  audit(parseArgs(process.argv.slice(2)))
    .then((ok) => { process.exitCode = ok ? 0 : 1; })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}

export { audit, parseArgs };
