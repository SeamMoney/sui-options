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
import { rollRugFired } from "./rugRoll";

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

export interface RoundRugResult {
  /** Rug enabled on this market? (false → no house-edge halt to verify.) */
  enabled: boolean;
  rugChanceBps: bigint;
  roundIndex: bigint;
  /** Segment the CHAIN says this round halted at (null = none yet). */
  chainRuggedAt: bigint | null;
  /** Segment OUR independent keccak scan finds as the first firing roll. */
  computedFirstFire: bigint | null;
  /** The winning roll value at the fire segment (for display). */
  fireRoll: bigint | null;
  segmentsScanned: number;
  /** The chain's halt matches an honest, first-firing keccak roll. */
  honest: boolean;
}

/** Read the v4.26 RugConfig dynamic field (key = b"rug_config"). */
async function readRugConfig(
  client: SuiJsonRpcClient,
  marketId: string,
): Promise<{ rugChanceBps: bigint; ruggedAt: bigint | null } | null> {
  const d = obj(
    await client.getDynamicFieldObject({
      parentId: marketId,
      name: { type: "vector<u8>", value: Array.from(new TextEncoder().encode("rug_config")) as unknown as string },
    }),
  );
  // Dynamic-field object: the RugConfig struct lives at content.fields.value.fields.
  const cf = obj(obj(obj(obj(obj(d.data).content).fields).value).fields);
  if (cf.rug_chance_bps == null) return null;
  // rugged_at_segment is an Option<u64>. The RPC renders Some(x) as a BARE
  // value (string/number) — and, on some shapes, as { fields: { vec: [x] } }.
  // None is null/absent. Handle every form (the bare-string case is the live one).
  const ro = cf.rugged_at_segment as unknown;
  let ruggedAt: bigint | null = null;
  if (ro != null) {
    if (typeof ro === "string" || typeof ro === "number" || typeof ro === "bigint") {
      ruggedAt = big(ro);
    } else {
      const vec = (obj((ro as Record<string, unknown>).fields).vec ??
        (ro as Record<string, unknown>).vec) as unknown[] | undefined;
      if (Array.isArray(vec) && vec.length > 0) ruggedAt = big(vec[0]);
    }
  }
  return { rugChanceBps: big(cf.rug_chance_bps), ruggedAt };
}

/**
 * Verify the CURRENT round's MARKET HALT (house edge) is honest — prune-proof.
 * Re-derives the keccak rug roll for every segment of the current round from
 * its on-chain key and finds the FIRST firing roll, then checks it equals the
 * segment the chain actually halted at (`rugged_at_segment` in RugConfig — a
 * live field, not a pruned event). So: the house couldn't fake a halt (claim
 * one where no honest roll fired) or suppress one (skip the first firing roll).
 */
export async function verifyRoundRug(rpcUrl: string, marketId: string): Promise<RoundRugResult> {
  const client = new SuiJsonRpcClient({ url: rpcUrl, network: "testnet" });
  const o = obj(await client.getObject({ id: marketId, options: { showContent: true } }));
  const f = obj(obj(obj(o.data).content).fields);
  const tableId = String(obj(obj(obj(f.segments).fields).id).id);
  const dur = big(f.round_duration_segments);
  const next = big(f.next_segment_index);

  const cfg = await readRugConfig(client, marketId);
  if (!cfg || cfg.rugChanceBps === 0n) {
    return {
      enabled: false, rugChanceBps: 0n, roundIndex: 0n, chainRuggedAt: null,
      computedFirstFire: null, fireRoll: null, segmentsScanned: 0, honest: true,
    };
  }

  // Anchor the round to the data we're verifying — the segment the chain says
  // it halted at if there's a claimed halt, else the latest recorded segment —
  // NOT the market's `cached_round_index`, which lags/races the live segment
  // stream (the round can roll between our non-atomic reads). round = anchor /
  // round_duration is the exact Move formula (`current_round = next_idx / dur`),
  // so the roll's round_index matches what the chain used at record time.
  const anchor = cfg.ruggedAt ?? (next > 0n ? next - 1n : 0n);
  const round = dur > 0n ? anchor / dur : 0n;
  const start = round * dur;
  // If the chain claims a halt at s, we only need [start, s] to confirm s is the
  // FIRST fire of its round (an earlier suppressed fire still surfaces; a faked
  // halt where s didn't fire still fails). With no claimed halt, scan every
  // recorded segment of the round to prove none fired.
  const scanEnd = cfg.ruggedAt !== null ? cfg.ruggedAt + 1n : next;
  const ks: bigint[] = [];
  for (let k = start; k < scanEnd; k++) ks.push(k);
  const recs = await Promise.all(ks.map((k) => readRecord(client, tableId, k)));
  let firstFire: bigint | null = null;
  let fireRoll: bigint | null = null;
  for (let i = 0; i < ks.length; i++) {
    const rec = recs[i];
    if (!rec) continue;
    const { roll, fired } = rollRugFired(rec.key, marketId, round, cfg.rugChanceBps);
    if (fired) {
      firstFire = ks[i]!;
      fireRoll = roll;
      break;
    }
  }

  const honest = (cfg.ruggedAt ?? null) === (firstFire ?? null);
  return {
    enabled: true,
    rugChanceBps: cfg.rugChanceBps,
    roundIndex: round,
    chainRuggedAt: cfg.ruggedAt,
    computedFirstFire: firstFire,
    fireRoll,
    segmentsScanned: ks.length,
    honest,
  };
}
