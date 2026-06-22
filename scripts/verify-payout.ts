#!/usr/bin/env tsx
/**
 * verify-payout — the "money audit" for a closed v4 ride.
 *
 * `scripts/verify-v4.ts` proves the CANDLES and the MARKET HALT were honest and
 * that the settlement KIND (touch / cashout / expiry) matches the price path.
 * This tool proves the remaining trust dimension: the chain paid the EXACT right
 * AMOUNT. Not "you lost" — "you lost precisely the stake you'd accrued for the
 * segments you held, and not a satoshi more."
 *
 * It is INDEPENDENT of the chain's reported numbers where it counts: it
 * re-derives `stake_paid` from on-chain object state + the segment timestamps
 * (`stake_paid = min(stake_per_segment × segments_held, escrowed)`,
 * `segments_held = min(next_segment_index@close − entry, round_duration)`), then
 * checks the payout identity for the settlement kind, mirroring Move
 * `decide_settlement` in `segment_market_v4.move`:
 *
 *   TOUCH_WIN(1)      payout = stake_paid × multiplier_bps / 10_000 ; forfeit = 0
 *   CASHOUT(2)        payout re-derived EXACTLY via the Bachelier factor
 *                     (scripts/bachelier.ts, bit-identical to Move ride_pricing)
 *                     from the close spot (last segment's state_after), σ, spread
 *                     and seconds-to-round-end; forfeit = stake_paid − payout
 *   EXPIRED_LOSS(3)   payout = 0 ; forfeit = stake_paid     (incl. MARKET HALT)
 *   ABORTED_REFUND(4) payout = 0 ; forfeit = 0              (escrow refunded 1:1)
 *
 * For the non-winning kinds (CASHOUT / EXPIRED_LOSS / ABORTED_REFUND) the rider
 * can never gain, so the conservation identity `payout + forfeit == stake_paid`
 * must hold. TOUCH_WIN is the exception — the vault TOPS UP the win, so the
 * payout exceeds stake_paid by exactly the multiplier and forfeit is 0. The
 * chain's reported `stake_paid` must equal ours in every case.
 *
 *   npx tsx scripts/verify-payout.ts --market <SegmentMarketV4 id> --ride <id>
 *   npm run verify:payout -- --market <id> --ride <id>
 *
 * Uses the RideClosedV4 event for the actual paid numbers — a deliberate,
 * opt-in complement to verify-v4.ts's prune-proof default (events can be pruned
 * by some RPCs; the Mysten fullnode keeps them). Default RPC: PublicNode.
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { cashoutPayout } from "./bachelier.js";

const DEFAULT_SEGMENT_MS = 400n; // segment_market_v4::DEFAULT_SEGMENT_MS

const DEFAULT_RPC = process.env.WICK_VERIFY_RPC ?? "https://sui-testnet-rpc.publicnode.com";
const BPS = 10_000n;

// The money verifier runs inside audit:ride/audit:latest/audit:sweep, so its
// object reads should survive a node throttle/hang like verify-v4 (#413/#424).
// (The RideClosedV4 event query already falls back to the archival fullnode in
// findRideClosedEvent; this covers the getObject/getDynamicFieldObject reads.)
const OBJ_FALLBACK_RPCS = [
  "https://sui-testnet-rpc.publicnode.com",
  "https://fullnode.testnet.sui.io:443",
];
const RPC_TIMEOUT_MS = 20_000;

interface GetObject {
  getObject(a: { id: string; options?: { showContent?: boolean; showType?: boolean } }): Promise<unknown>;
}
interface GetField {
  getDynamicFieldObject(a: { parentId: string; name: { type: string; value: string } }): Promise<unknown>;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`RPC timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Resilient object/field reads: try each endpoint, fall back on a thrown error
 *  or a per-call timeout (a hanging node). A successful null/empty is returned
 *  as-is (no fallback) so a genuinely-absent object stays absent. */
function makeResilientReader(rpcUrl: string): GetObject & GetField {
  const seen = new Set<string>();
  const clients = [rpcUrl, ...OBJ_FALLBACK_RPCS]
    .filter((u) => u && !seen.has(u) && seen.add(u))
    .map((url) => new SuiJsonRpcClient({ url, network: "testnet" }));
  async function tryAll<T>(fn: (c: SuiJsonRpcClient) => Promise<T>): Promise<T> {
    let last: unknown;
    for (const c of clients) {
      try {
        return await withTimeout(fn(c), RPC_TIMEOUT_MS);
      } catch (e) {
        last = e;
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }
  return {
    getObject: (a) => tryAll((c) => c.getObject(a as never)),
    getDynamicFieldObject: (a) => tryAll((c) => c.getDynamicFieldObject(a as never)),
  };
}

const SETTLEMENT_NAME: Record<number, string> = {
  0: "OPEN",
  1: "TOUCH_WIN",
  2: "CASHOUT",
  3: "EXPIRED_LOSS",
  4: "ABORTED_REFUND",
};

interface Args {
  market: string;
  ride: string;
  rpc: string;
}

function usage(): never {
  console.error(
    "usage: npx tsx scripts/verify-payout.ts --market <SegmentMarketV4 id> --ride <SegmentRidePositionV4 id> [--rpc <url>]",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { rpc: DEFAULT_RPC };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const n = argv[i + 1];
    if (a === "--market" && n) (out.market = n), i++;
    else if (a === "--ride" && n) (out.ride = n), i++;
    else if (a === "--rpc" && n) (out.rpc = n), i++;
    else if (a === "-h" || a === "--help") usage();
    else throw new Error(`unknown or incomplete argument: ${a}`);
  }
  if (!out.market || !out.ride) usage();
  return out as Args;
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function asStr(v: unknown): string {
  return typeof v === "string" ? v : String(v);
}
function asBig(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string" && v.trim() !== "") return BigInt(v);
  return 0n;
}
function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
function fmt(v: bigint): string {
  return v.toString();
}

interface Ride {
  entry: bigint;
  round: bigint;
  multiplierBps: bigint;
  stakePerSegment: bigint;
  escrowed: bigint;
  upperBarrier: bigint;
  lowerBarrier: bigint;
  closed: boolean;
  closedAtMs: bigint;
  settlementKind: number;
}

/**
 * Check the payout identity for the settlement kind, returning a list of
 * violations (empty = honest). For non-winning kinds the stake is conserved as
 * `payout + forfeit + bounty == stake_paid` — the `bounty` term is the 50bps
 * CRANK_BOUNTY paid to a keeper that cranks an expired ride (0 on a self-close).
 */
export function checkPayoutIdentity(
  kind: number,
  stakePaid: bigint,
  payout: bigint,
  forfeit: bigint,
  multiplierBps: bigint,
  bounty: bigint = 0n,
): string[] {
  const errs: string[] = [];
  if (kind === 1) {
    // TOUCH_WIN — the vault tops up the win, so payout EXCEEDS stake_paid; the
    // conservation identity does NOT apply. payout = stake_paid × multiplier.
    // A win is never crank-settled, so there is no bounty.
    const expected = (stakePaid * multiplierBps) / BPS;
    if (payout !== expected) {
      errs.push(`TOUCH_WIN payout ${payout} != stake_paid×${multiplierBps}bps = ${expected}`);
    }
    if (forfeit !== 0n) errs.push(`TOUCH_WIN forfeit ${forfeit} != 0`);
    if (bounty !== 0n) errs.push(`TOUCH_WIN bounty ${bounty} != 0`);
    return errs;
  }
  // Non-winning kinds: the rider can never gain — stake is conserved. When a
  // keeper CRANKS an expired ride, a CRANK_BOUNTY (50bps of stake_paid) is paid
  // to the cranker out of the rider's forfeited stake, so the full identity is
  // payout + forfeit + bounty == stake_paid (bounty is 0 on a self-close).
  if (payout + forfeit + bounty !== stakePaid) {
    errs.push(`payout(${payout}) + forfeit(${forfeit}) + bounty(${bounty}) != stake_paid(${stakePaid})`);
  }
  if (kind === 3) {
    // EXPIRED_LOSS (incl. MARKET HALT): no payout; the held stake is forfeited
    // (minus any crank bounty). forfeit + bounty must equal stake_paid.
    if (payout !== 0n) errs.push(`EXPIRED_LOSS payout ${payout} != 0`);
    if (forfeit + bounty !== stakePaid) {
      errs.push(`EXPIRED_LOSS forfeit ${forfeit} + bounty ${bounty} != stake_paid ${stakePaid}`);
    }
  } else if (kind === 2) {
    // CASHOUT — sanity bounds here; the EXACT Bachelier payout is re-derived
    // and compared against the chain in main() (needs the close spot via RPC).
    // A 0-segment cashout (the user closed before any segment was recorded)
    // legitimately pays 0: stake_paid is 0, so the Bachelier payout on a zero
    // stake is 0 and the full escrow is refunded via (escrowed − stake_paid).
    // Only a cashout that actually accrued stake must pay something positive —
    // requiring payout > 0 unconditionally falsely FAILs an honest quick cashout.
    if (stakePaid > 0n && !(payout > 0n)) {
      errs.push(`CASHOUT payout ${payout} must be > 0 when stake_paid ${stakePaid} > 0`);
    }
    if (payout > stakePaid) errs.push(`CASHOUT payout ${payout} > stake_paid ${stakePaid}`);
  } else if (kind === 4) {
    // ABORTED_REFUND — escrow refunded 1:1; no stake consumed, no bounty.
    if (payout !== 0n) errs.push(`ABORTED_REFUND payout ${payout} != 0`);
    if (forfeit !== 0n) errs.push(`ABORTED_REFUND forfeit ${forfeit} != 0`);
  } else {
    // Fail CLOSED: the on-chain enum is OPEN/TOUCH_WIN/CASHOUT/EXPIRED_LOSS/
    // ABORTED_REFUND (0–4; OPEN is handled before this). A kind outside that set
    // is a settlement the verifier has no payout rule for — refuse to pass it
    // rather than bless it on the conservation check alone.
    errs.push(`unknown settlement_kind ${kind} — the verifier has no payout rule for it`);
  }
  return errs;
}

/**
 * Multiplier provenance. The win payout = stake × the ride's *snapshotted*
 * multiplier, which Move sets equal to the market's CONFIGURED multiplier at
 * open (`ride.multiplier_bps = market.multiplier_bps`, immutable). Returns a
 * violation string if the ride's rate doesn't match the market's configured one
 * (a quietly-lowered rate), or null if it's the honest configured rate.
 */
export function multiplierProvenanceError(
  rideMultiplierBps: bigint,
  marketMultiplierBps: bigint,
): string | null {
  return rideMultiplierBps === marketMultiplierBps
    ? null
    : `ride multiplier ${rideMultiplierBps}bps != market's configured ${marketMultiplierBps}bps`;
}

/**
 * Re-derive stake_paid (what the rider actually paid as they held) from object
 * state, mirroring Move: `segments_held = min(next_segment_index@close − entry,
 * round_duration)` and `stake_paid = min(stake_per_segment × segments_held,
 * escrowed)`. This is the load-bearing money quantity (the loss on an expiry, the
 * base of every payout); pure so both caps — the per-round duration cap and the
 * escrow cap — are unit-tested, not merely live-validated.
 */
export function deriveStakePaid(
  nextAtClose: bigint,
  entry: bigint,
  roundDuration: bigint,
  stakePerSegment: bigint,
  escrowed: bigint,
): { segmentsHeld: bigint; stakePaid: bigint } {
  const rawHeld = nextAtClose > entry ? nextAtClose - entry : 0n;
  const segmentsHeld = rawHeld > roundDuration ? roundDuration : rawHeld;
  const uncapped = stakePerSegment * segmentsHeld;
  const stakePaid = uncapped > escrowed ? escrowed : uncapped;
  return { segmentsHeld, stakePaid };
}

/**
 * Seconds remaining in the ride's round at close — the Bachelier cash-out's
 * time-to-expiry input (more time ⇒ more touch probability ⇒ higher cash-out).
 * `round_end = (round + 1) × round_duration` (segment index); the segments left
 * × 400ms, clamped at 0 if closed at/after the round boundary. Pure so this
 * money input is unit-tested, not just live-validated.
 */
export function cashoutSecondsRemaining(
  rideRound: bigint,
  roundDuration: bigint,
  nextAtClose: bigint,
  segmentMs: bigint,
): bigint {
  const rideRoundEnd = (rideRound + 1n) * roundDuration;
  const segsRemaining = rideRoundEnd > nextAtClose ? rideRoundEnd - nextAtClose : 0n;
  return (segsRemaining * segmentMs) / 1000n;
}

export async function readRide(client: GetObject, id: string): Promise<{ ride: Ride; marketId: string }> {
  const o = asObj(await client.getObject({ id, options: { showContent: true, showType: true } }));
  const content = asObj(asObj(o.data).content);
  if (!/::segment_market_v4::SegmentRidePositionV4$/.test(asStr(content.type))) {
    throw new Error(`object ${id} is not a SegmentRidePositionV4 (type: ${asStr(content.type)})`);
  }
  const f = asObj(content.fields);
  return {
    marketId: asStr(f.market_id),
    ride: {
      entry: asBig(f.entry_segment_index),
      round: asBig(f.round_index),
      multiplierBps: asBig(f.multiplier_bps),
      stakePerSegment: asBig(f.stake_per_segment),
      escrowed: asBig(f.escrowed),
      upperBarrier: asBig(f.upper_barrier_price),
      lowerBarrier: asBig(f.lower_barrier_price),
      closed: Boolean(f.closed),
      closedAtMs: asBig(f.closed_at_ms),
      settlementKind: Number(asBig(f.settlement_kind)),
    },
  };
}

export async function readMarket(
  client: GetObject,
  id: string,
): Promise<{
  packageId: string;
  tableId: string;
  roundDuration: bigint;
  nextSegmentIndex: bigint;
  sigmaBpsPerSqrtSec: bigint;
  cashoutSpreadBps: bigint;
  multiplierBps: bigint;
}> {
  const o = asObj(await client.getObject({ id, options: { showContent: true, showType: true } }));
  const content = asObj(asObj(o.data).content);
  const type = asStr(content.type);
  const m = /::segment_market_v4::SegmentMarketV4<(.+)>$/.exec(type);
  if (!m) throw new Error(`object ${id} is not a SegmentMarketV4 (type: ${type})`);
  const f = asObj(content.fields);
  const tableId = asStr(asObj(asObj(asObj(f.segments).fields).id).id);
  return {
    packageId: type.split("::")[0]!,
    tableId,
    roundDuration: asBig(f.round_duration_segments),
    nextSegmentIndex: asBig(f.next_segment_index),
    sigmaBpsPerSqrtSec: asBig(f.sigma_bps_per_sqrt_sec),
    cashoutSpreadBps: asBig(f.cashout_spread_bps),
    multiplierBps: asBig(f.multiplier_bps),
  };
}

/** Read a segment record's fields (recorded_at_ms + state_after.price), or null. */
async function readSegmentFields(
  client: GetField,
  tableId: string,
  k: bigint,
): Promise<{ recordedAtMs: bigint; stateAfterPrice: bigint } | null> {
  const d = asObj(
    await client.getDynamicFieldObject({ parentId: tableId, name: { type: "u64", value: k.toString() } }),
  );
  const data = asObj(d.data);
  if (!data.content) return null;
  const sf = asObj(asObj(asObj(asObj(data.content).fields).value).fields);
  const stateAfter = asObj(asObj(sf.state_after).fields);
  return { recordedAtMs: asBig(sf.recorded_at_ms), stateAfterPrice: asBig(stateAfter.price) };
}

/** recorded_at_ms of segment k, or null if absent. */
async function segmentRecordedAt(client: GetField, tableId: string, k: bigint): Promise<bigint | null> {
  const r = await readSegmentFields(client, tableId, k);
  return r ? r.recordedAtMs : null;
}

/**
 * next_segment_index@close = the count of segments recorded at or before the
 * ride closed — i.e. the smallest k in [entry, nextSegmentIndex] with
 * recorded_at_ms > closed_at_ms (or nextSegmentIndex if none).
 *
 * `recorded_at_ms` is monotonic non-decreasing in k (segments are recorded in
 * index order over time), so we BINARY-SEARCH the boundary: ~log2(N) reads
 * instead of N. This matters for a ride opened early and cranked closed many
 * rounds later — a linear scan there is thousands of sequential RPC reads
 * (minutes); the binary search is ~11 reads (seconds). A `null` read (a pruned
 * segment, not active today) is treated as past the boundary so the search
 * still terminates safely.
 */
export async function nextSegmentIndexAtClose(
  client: GetField,
  tableId: string,
  entry: bigint,
  closedAtMs: bigint,
  nextSegmentIndex: bigint,
): Promise<bigint> {
  let lo = entry;
  let hi = nextSegmentIndex; // invariant: answer in [lo, hi]
  while (lo < hi) {
    const mid = lo + (hi - lo) / 2n;
    const at = await segmentRecordedAt(client, tableId, mid);
    if (at !== null && at <= closedAtMs) {
      lo = mid + 1n; // mid was recorded before close → boundary is after mid
    } else {
      hi = mid; // recorded after close (or missing) → boundary is at/before mid
    }
  }
  return lo;
}

type ClosedEvent = { stakePaid: bigint; payout: bigint; forfeit: bigint; bounty: bigint; settlementKind: number };

/** Archival fallback RPC: keeps historic events that PublicNode prunes. */
const ARCHIVAL_RPC = "https://fullnode.testnet.sui.io:443";

export async function queryRideClosed(
  client: SuiJsonRpcClient,
  packageId: string,
  marketId: string,
  rideId: string,
): Promise<ClosedEvent | null> {
  const eventType = `${packageId}::segment_market_v4::RideClosedV4`;
  let cursor: { txDigest: string; eventSeq: string } | null = null;
  for (let p = 0; p < 200; p++) {
    const page = await client.queryEvents({
      query: { MoveEventType: eventType },
      cursor,
      limit: 50,
      order: "descending",
    });
    for (const ev of page.data) {
      const j = asObj(ev.parsedJson);
      if (sameId(asStr(j.ride_id), rideId) && sameId(asStr(j.market_id), marketId)) {
        return {
          stakePaid: asBig(j.stake_paid),
          payout: asBig(j.payout),
          forfeit: asBig(j.forfeit),
          bounty: asBig(j.bounty),
          settlementKind: Number(asBig(j.settlement_kind)),
        };
      }
    }
    if (!page.hasNextPage || !page.nextCursor) break;
    cursor = page.nextCursor as { txDigest: string; eventSeq: string };
  }
  return null;
}

/**
 * Fetch the ride's RideClosedV4. The default RPC (PublicNode) prunes historic
 * tx events, so a judge running the documented command cold on an older ride
 * would otherwise hit "Could not find the referenced transaction events". We
 * transparently fall back to the archival Mysten fullnode (events retained) on
 * any failure / miss — so the command always works without a manual --rpc.
 */
async function findRideClosedEvent(
  primary: SuiJsonRpcClient,
  primaryUrl: string,
  packageId: string,
  marketId: string,
  rideId: string,
): Promise<ClosedEvent> {
  try {
    const hit = await queryRideClosed(primary, packageId, marketId, rideId);
    if (hit) return hit;
  } catch {
    /* fall through to archival */
  }
  if (primaryUrl !== ARCHIVAL_RPC) {
    console.log(`note: events not on ${primaryUrl} (pruned) — retrying on the archival fullnode…`);
    const fallback = new SuiJsonRpcClient({ url: ARCHIVAL_RPC, network: "testnet" });
    const hit = await queryRideClosed(fallback, packageId, marketId, rideId);
    if (hit) return hit;
  }
  throw new Error(`RideClosedV4 not found for ride ${rideId} on any RPC (is the ride closed?)`);
}

async function main(): Promise<boolean> {
  const args = parseArgs(process.argv.slice(2));
  // Object/field reads go through the resilient reader (fallback + timeout); the
  // event query keeps its own client (findRideClosedEvent falls back to archival).
  const reader = makeResilientReader(args.rpc);
  const client = new SuiJsonRpcClient({ url: args.rpc, network: "testnet" });

  const { ride, marketId } = await readRide(reader, args.ride);
  if (!sameId(marketId, args.market)) {
    throw new Error(`ride belongs to market ${marketId}, not ${args.market}`);
  }
  const market = await readMarket(reader, args.market);

  console.log(`market:  ${args.market}`);
  console.log(`ride:    ${args.ride}`);
  console.log(`network: ${args.rpc}`);

  if (!ride.closed || ride.settlementKind === 0) {
    console.log("\nRide is still OPEN — no payout to audit yet.");
    return true;
  }

  // Independently re-derive stake_paid from object state + the close window.
  const nextAtClose = await nextSegmentIndexAtClose(
    reader,
    market.tableId,
    ride.entry,
    ride.closedAtMs,
    market.nextSegmentIndex,
  );
  const { segmentsHeld, stakePaid: stakePaidDerived } = deriveStakePaid(
    nextAtClose,
    ride.entry,
    market.roundDuration,
    ride.stakePerSegment,
    ride.escrowed,
  );

  const closed = await findRideClosedEvent(client, args.rpc, market.packageId, args.market, args.ride);

  console.log("");
  console.log(`settlement:        ${SETTLEMENT_NAME[closed.settlementKind] ?? closed.settlementKind}`);
  console.log(`segments held:     ${segmentsHeld}  (entry ${ride.entry} → close @ index ${nextAtClose}, round cap ${market.roundDuration})`);
  console.log(`stake/segment:     ${fmt(ride.stakePerSegment)}   escrow cap: ${fmt(ride.escrowed)}`);
  console.log(`stake_paid:        ours ${fmt(stakePaidDerived)}  ·  chain ${fmt(closed.stakePaid)}  ${stakePaidDerived === closed.stakePaid ? "✓ match" : "✗ MISMATCH"}`);
  const multErr = multiplierProvenanceError(ride.multiplierBps, market.multiplierBps);
  console.log(
    `multiplier:        ride ${fmt(ride.multiplierBps)} bps  ·  market ${fmt(market.multiplierBps)} bps  ${multErr === null ? "✓ configured rate" : "✗ MISMATCH"}`,
  );
  console.log(`payout:            ${fmt(closed.payout)}   forfeit: ${fmt(closed.forfeit)}   bounty: ${fmt(closed.bounty)}`);

  const errs: string[] = [];
  if (stakePaidDerived !== closed.stakePaid) {
    errs.push(`re-derived stake_paid ${stakePaidDerived} != chain ${closed.stakePaid}`);
  }
  // Multiplier provenance: the ride's snapshotted multiplier must equal the
  // market's CONFIGURED (immutable) one, else the payout is honest against a
  // quietly-lowered rate. (Pure check — unit-tested in verify-payout.test.ts.)
  if (multErr !== null) errs.push(multErr);
  errs.push(
    ...checkPayoutIdentity(
      closed.settlementKind,
      closed.stakePaid,
      closed.payout,
      closed.forfeit,
      ride.multiplierBps,
      closed.bounty,
    ),
  );

  // CASHOUT: reproduce the EXACT Bachelier payout the chain computed. The spot is
  // the walk price at close = state_after.price of the last in-window segment
  // (nextAtClose−1); seconds_remaining = segments-to-round-end × 400ms.
  let cashoutExact: bigint | null = null;
  if (closed.settlementKind === 2) {
    const last = nextAtClose > 0n ? await readSegmentFields(client, market.tableId, nextAtClose - 1n) : null;
    if (last) {
      const secondsRemaining = cashoutSecondsRemaining(
        ride.round,
        market.roundDuration,
        nextAtClose,
        DEFAULT_SEGMENT_MS,
      );
      cashoutExact = cashoutPayout(
        closed.stakePaid,
        last.stateAfterPrice,
        ride.upperBarrier,
        ride.lowerBarrier,
        market.sigmaBpsPerSqrtSec,
        market.cashoutSpreadBps,
        secondsRemaining,
      );
      if (cashoutExact !== closed.payout) {
        errs.push(`CASHOUT payout ${closed.payout} != re-derived Bachelier ${cashoutExact}`);
      }
    }
  }

  console.log("");
  if (closed.settlementKind === 1) {
    console.log(`✓ TOUCH_WIN paid stake_paid × ${ride.multiplierBps}bps = ${(closed.stakePaid * ride.multiplierBps) / BPS}`);
  } else if (closed.settlementKind === 3) {
    const bountyNote = closed.bounty > 0n ? ` (− ${closed.bounty} crank bounty to the keeper)` : "";
    console.log(`✓ EXPIRED_LOSS / MARKET HALT forfeited exactly the held stake: forfeit ${closed.forfeit}${bountyNote} = stake_paid ${closed.stakePaid}; payout 0 — not a satoshi more was taken`);
  } else if (closed.settlementKind === 2) {
    if (cashoutExact !== null) {
      console.log(`✓ CASHOUT: re-derived the EXACT Bachelier payout ${cashoutExact} == chain ${closed.payout} (spot/σ/time → factor → ×stake −spread); forfeit = stake_paid − payout`);
    } else {
      console.log(`✓ CASHOUT: payout ${closed.payout} within (0, stake_paid ${closed.stakePaid}]; forfeit = stake_paid − payout (segment state_after unavailable — bound-checked only)`);
    }
  } else if (closed.settlementKind === 4) {
    console.log(`✓ ABORTED_REFUND: escrow refunded 1:1, no stake consumed`);
  }

  const pass = errs.length === 0;
  console.log("");
  if (!pass) {
    console.log("payout audit FAILED:");
    for (const e of errs) console.log(`  ✗ ${e}`);
    console.log("\nFAIL — the chain paid the wrong amount.");
  } else {
    console.log("PASS — the chain paid the exact right amount.");
  }
  return pass;
}

// Guard the entrypoint so the module can be imported by tests without running
// the CLI (which would parse the test runner's argv and exit).
const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  main()
    .then((ok) => {
      process.exitCode = ok ? 0 : 1;
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
