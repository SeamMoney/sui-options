/**
 * liveVerify — replay a LIVE on-chain v4 market's recent candles in the browser
 * and prove each reproduces from its own segment key + carried walk state.
 *
 * This is the in-browser sibling of `scripts/verify-v4.ts`: same byte-identical
 * seeded-path port (`@wick/sdk` `expandSegment`, checked against 10k vectors in
 * CI), same PRUNE-PROOF approach — read each `SegmentRecord` straight from the
 * market's on-chain `Table<u64, SegmentRecord>` via dynamic fields, so every
 * segment is verifiable INDEPENDENTLY from its predecessor's carried state. No
 * event replay (public nodes prune old events), no "replay from genesis": a few
 * `getObject`/`getDynamicFieldObject` reads and pure math.
 *
 * Dependency-injected (takes an rpcUrl) so the exact same code is unit-dogfooded
 * via tsx against live testnet AND runs in the /verify page. No React, no env.
 */
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { expandSegment, type WalkState } from "@wick/sdk";

export interface LiveVerifyRow {
  k: number;
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  chainHigh: bigint;
  chainLow: bigint;
  /** Recomputed (high, low) AND carried state equal what the chain published. */
  match: boolean;
}

export interface LiveVerifyResult {
  marketId: string;
  packageId: string;
  totalSegments: number;
  rows: LiveVerifyRow[];
  allMatch: boolean;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function big(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string" && v.trim() !== "") return BigInt(v);
  return 0n;
}
function bytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return new Uint8Array(v as number[]);
  return new Uint8Array();
}

/** Decode an on-chain WalkState struct (a SegmentRecord.state_after `fields`). */
export function decodeWalk(f: Record<string, unknown>): WalkState {
  const m = obj(obj(f.momentum).fields);
  return {
    price: big(f.price),
    momentum: { neg: Boolean(m.neg), mag: big(m.mag) },
    volRegime: big(f.vol_regime),
    home: big(f.home),
    patternId: big(f.pattern_id),
    candlesRemaining: big(f.candles_remaining),
  };
}

interface Record_ {
  key: Uint8Array;
  min: bigint;
  max: bigint;
  stateAfter: WalkState;
}

async function readRecord(
  client: SuiJsonRpcClient,
  tableId: string,
  k: bigint,
): Promise<Record_ | null> {
  const d = obj(
    await client.getDynamicFieldObject({ parentId: tableId, name: { type: "u64", value: k.toString() } }),
  );
  const content = obj(obj(d.data).content);
  if (!content.fields) return null;
  const sf = obj(obj(obj(content.fields).value).fields);
  return {
    key: bytes(sf.key),
    min: big(sf.min_price),
    max: big(sf.max_price),
    stateAfter: decodeWalk(obj(obj(sf.state_after).fields)),
  };
}

/** A fetched segment ready for replay (the on-chain key + what the chain claimed). */
export interface LiveSegmentRecord {
  k: number;
  key: Uint8Array;
  min: bigint;
  max: bigint;
  stateAfter: WalkState;
}

/**
 * The pure core: replay each segment from the carried walk state via the
 * byte-identical `expandSegment` and compare the recomputed extrema + carried
 * state to what the chain published. No RPC — so it's unit-testable offline
 * (scripts/live-verify.test.ts) AND reused by `verifyLiveMarket` after fetch.
 */
export function replayAndMatch(
  predState: WalkState,
  records: LiveSegmentRecord[],
): { rows: LiveVerifyRow[]; allMatch: boolean } {
  let prev = predState;
  let allMatch = true;
  const rows: LiveVerifyRow[] = [];
  for (const rec of records) {
    const r = expandSegment(prev, rec.key);
    const match =
      r.min === rec.min &&
      r.max === rec.max &&
      r.newState.price === rec.stateAfter.price &&
      r.newState.volRegime === rec.stateAfter.volRegime &&
      r.newState.momentum.mag === rec.stateAfter.momentum.mag &&
      r.newState.momentum.neg === rec.stateAfter.momentum.neg;
    allMatch = allMatch && match;
    rows.push({
      k: rec.k,
      open: r.candles[0]?.open ?? prev.price,
      high: r.max,
      low: r.min,
      close: r.candles[r.candles.length - 1]?.close ?? r.newState.price,
      chainHigh: rec.max,
      chainLow: rec.min,
      match,
    });
    prev = rec.stateAfter;
  }
  return { rows, allMatch };
}

/**
 * Verify the most recent `window` segments of a live SegmentMarketV4. Returns
 * a per-segment match table. Throws on an unreachable RPC / wrong object type
 * so the caller can show a friendly message.
 */
export async function verifyLiveMarket(
  rpcUrl: string,
  marketId: string,
  window = 8,
): Promise<LiveVerifyResult> {
  const client = new SuiJsonRpcClient({ url: rpcUrl, network: "testnet" });
  const o = obj(await client.getObject({ id: marketId, options: { showContent: true, showType: true } }));
  const data = obj(o.data);
  const content = obj(data.content);
  const type = String(content.type ?? "");
  const m = /::segment_market_v4::SegmentMarketV4<(.+)>$/.exec(type);
  if (!m) throw new Error("not a live SegmentMarketV4 market");
  const f = obj(content.fields);
  const tableId = String(obj(obj(obj(f.segments).fields).id).id);
  const nextIdx = big(f.next_segment_index);
  const packageId = type.split("::")[0]!;

  // Audit [from, to): the most recent `window` segments. `from` must be ≥ 1 so
  // its predecessor's carried state exists (genesis isn't on-chain).
  const w = BigInt(Math.max(1, window));
  const to = nextIdx;
  const from = to > w ? to - w : 1n;
  if (to <= from) {
    return { marketId, packageId, totalSegments: Number(nextIdx), rows: [], allMatch: true };
  }

  // Read the predecessor + the whole window CONCURRENTLY (one round-trip, not
  // ~9 sequential) so the page responds in ~1-2s, not 5+. Then assemble in
  // order, stopping at the first gap (so a missing record can't shift k's).
  const ks: bigint[] = [];
  for (let k = from - 1n; k < to; k++) ks.push(k);
  const fetched = await Promise.all(ks.map((k) => readRecord(client, tableId, k)));
  const pred = fetched[0];
  if (!pred) throw new Error("predecessor segment unavailable; market may be too young");

  const records: LiveSegmentRecord[] = [];
  for (let i = 1; i < fetched.length; i++) {
    const rec = fetched[i];
    if (!rec) break;
    records.push({ k: Number(ks[i]!), key: rec.key, min: rec.min, max: rec.max, stateAfter: rec.stateAfter });
  }
  const { rows, allMatch } = replayAndMatch(pred.stateAfter, records);
  return { marketId, packageId, totalSegments: Number(nextIdx), rows, allMatch };
}

/** Lightweight read of a market's recorded-segment count (0 if unreadable). */
async function segmentCount(client: SuiJsonRpcClient, marketId: string): Promise<bigint> {
  try {
    const o = obj(await client.getObject({ id: marketId, options: { showContent: true } }));
    const f = obj(obj(obj(o.data).content).fields);
    return big(f.next_segment_index);
  } catch {
    return 0n;
  }
}

/**
 * Verify the BUSIEST of a set of live markets (the one with the most recorded
 * segments) — so the page always lands on a market with candles to show, not
 * an idle one. Throws if none have enough segments.
 */
export async function verifyBusiestLiveMarket(
  rpcUrl: string,
  marketIds: string[],
  window = 8,
): Promise<LiveVerifyResult> {
  if (marketIds.length === 0) throw new Error("no live v4 markets configured");
  const client = new SuiJsonRpcClient({ url: rpcUrl, network: "testnet" });
  // Probe every market's segment count CONCURRENTLY, then pick the busiest.
  const counts = await Promise.all(marketIds.map((id) => segmentCount(client, id)));
  let best: string | null = null;
  let bestN = 1n;
  marketIds.forEach((id, i) => {
    if (counts[i]! > bestN) {
      bestN = counts[i]!;
      best = id;
    }
  });
  if (!best) throw new Error("no live market has recorded segments yet — try the CLI (prove:live)");
  return verifyLiveMarket(rpcUrl, best, window);
}
