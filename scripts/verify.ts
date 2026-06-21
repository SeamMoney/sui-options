#!/usr/bin/env tsx
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import {
  expandSegment,
  newState,
  type WalkState,
} from "../sdk/src/seededPath.js";
import {
  BARRIER_UPPER,
  SETTLEMENT_ABORTED_REFUND,
  SETTLEMENT_CASHOUT,
  SETTLEMENT_EXPIRED_LOSS,
  SETTLEMENT_NAME,
  SETTLEMENT_OPEN,
  SETTLEMENT_TOUCH_WIN,
  fetchSegmentMarket,
  fetchSegmentRidePosition,
  fetchSegments,
  parseRideClosedEvent,
  parseRideOpenedEvent,
  parseRoundStartedEvent,
  parseSegmentMarketCreatedEvent,
  rideClosedEventType,
  rideOpenedEventType,
  roundStartedEventType,
  segmentMarketCreatedEventType,
  segmentRecordedEventType,
  type RideClosedEvent,
  type RideOpenedEvent,
  type RoundStartedEvent,
  type SegmentMarketCreatedEvent,
  type SegmentRecordSnapshot,
} from "../sdk/src/segmentMarket.js";

type EventCursor = { txDigest: string; eventSeq: string };
type EventOrder = "ascending" | "descending";

interface RpcEvent {
  /** Sui event id — supplied by suix_queryEvents; synthesized by the mock. */
  id?: EventCursor;
  parsedJson?: unknown;
}

interface RpcClient {
  getObject(args: unknown): Promise<unknown>;
  queryEvents(args: unknown): Promise<{
    data: Array<RpcEvent>;
    hasNextPage: boolean;
    nextCursor?: EventCursor | null;
  }>;
}

function asEventId(v: unknown): EventCursor | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.txDigest !== "string" || typeof o.eventSeq !== "string") {
    return undefined;
  }
  return { txDigest: o.txDigest, eventSeq: o.eventSeq };
}

interface Args {
  market: string;
  ride: string;
  rpc: string;
}

interface MarketObjectInfo {
  packageId: string;
  type: string;
}

interface ReplayRow {
  k: bigint;
  round: bigint;
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  eventHigh: bigint;
  eventLow: bigint;
  barrier: bigint;
  touched: boolean;
  extremaMatch: boolean;
}

const DEFAULT_INITIAL_VOL_REGIME = 1_000_000n;
// Default to PublicNode, not the Mysten public testnet fullnode: the latter
// rate-limits under sustained load (and a throttled response drops its CORS
// headers, surfacing as a misleading error). This is the repo-wide testnet RPC
// convention — judges run `npx tsx scripts/verify.ts ...` cold, so the default
// must be the reliable endpoint. Override with --rpc or WICK_VERIFY_RPC.
const DEFAULT_RPC =
  process.env.WICK_VERIFY_RPC ?? "https://sui-testnet-rpc.publicnode.com";

function usage(): never {
  console.error(
    "usage: npx tsx scripts/verify.ts --market <SegmentMarket ID> --ride <SegmentRidePosition ID> [--rpc <url>]",
  );
  console.error(
    "synthetic: npx tsx scripts/verify.ts --market 0xmockMarket --ride 0xmockRide --rpc mock://synthetic",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { rpc: DEFAULT_RPC };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--market" && next) {
      out.market = next;
      i++;
    } else if (arg === "--ride" && next) {
      out.ride = next;
      i++;
    } else if (arg === "--rpc" && next) {
      out.rpc = next;
      i++;
    } else if (arg === "-h" || arg === "--help") {
      usage();
    } else {
      throw new Error(`unknown or incomplete argument: ${arg}`);
    }
  }
  if (!out.market || !out.ride || !out.rpc) usage();
  return out as Args;
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : String(v);
}

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function settlementName(kind: number): string {
  return SETTLEMENT_NAME[kind as keyof typeof SETTLEMENT_NAME] ?? `UNKNOWN_${kind}`;
}

function formatPrice(v: bigint): string {
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  return `${whole}.${frac}`;
}

function formatBool(v: boolean): string {
  return v ? "yes" : "no";
}

function directionTouches(
  segment: { min: bigint; max: bigint },
  barrier: bigint,
  deadbandBps: bigint,
  upper: boolean,
): boolean {
  if (upper) {
    const eff = barrier + (barrier * deadbandBps) / 10_000n;
    return segment.max >= eff;
  }
  const margin = (barrier * deadbandBps) / 10_000n;
  const eff = margin >= barrier ? 0n : barrier - margin;
  return segment.min <= eff;
}

function segmentRound(k: bigint, roundDuration: bigint): bigint {
  return roundDuration === 0n ? 0n : k / roundDuration;
}

async function getMarketObjectInfo(
  client: RpcClient,
  marketId: string,
): Promise<MarketObjectInfo> {
  const raw = asObject(await client.getObject({
    id: marketId,
    options: { showContent: true, showType: true },
  }));
  const data = asObject(raw.data);
  const content = asObject(data.content);
  const type = asString(content.type);
  const marker = "::segment_market::SegmentMarket<";
  const idx = type.indexOf(marker);
  if (idx < 0) {
    throw new Error(`object ${marketId} is not a SegmentMarket; type=${type}`);
  }
  return { packageId: type.slice(0, idx), type };
}

interface MatchedEvent<T> {
  event: T;
  /** Cursor id of the underlying RPC event, when the source provides one. */
  id: EventCursor | undefined;
}

async function queryParsedEventsWithIds<T>(
  client: RpcClient,
  eventType: string,
  parse: (json: Record<string, unknown>) => T,
  filter: (event: T) => boolean,
  opts: {
    order?: EventOrder;
    limit?: number;
    maxPages?: number;
    /**
     * Stop paginating as soon as the first match is found. Used by
     * `firstEvent` so a single-event lookup doesn't exhaust
     * maxPages × limit events (= 20,000 by default) on every call.
     */
    earlyExit?: boolean;
    /**
     * Pagination start cursor. Combined with `order: "descending"`, lets
     * callers scan events that landed strictly before a known cursor —
     * used to apply a chain-order cutoff that doesn't depend on
     * wall-clock timestamps.
     */
    startCursor?: EventCursor | null;
  } = {},
): Promise<MatchedEvent<T>[]> {
  const out: MatchedEvent<T>[] = [];
  const limit = opts.limit ?? 100;
  const maxPages = opts.maxPages ?? 200;
  let cursor: EventCursor | null = opts.startCursor ?? null;
  for (let pageNo = 0; pageNo < maxPages; pageNo++) {
    const page = await client.queryEvents({
      query: { MoveEventType: eventType },
      cursor,
      limit,
      order: opts.order ?? "descending",
    });
    for (const ev of page.data) {
      const json = asObject(ev.parsedJson);
      const parsed = parse(json);
      if (filter(parsed)) {
        out.push({ event: parsed, id: asEventId(ev.id) });
        if (opts.earlyExit) return out;
      }
    }
    if (!page.hasNextPage || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}

async function queryParsedEvents<T>(
  client: RpcClient,
  eventType: string,
  parse: (json: Record<string, unknown>) => T,
  filter: (event: T) => boolean,
  opts: {
    order?: EventOrder;
    limit?: number;
    maxPages?: number;
    earlyExit?: boolean;
    startCursor?: EventCursor | null;
  } = {},
): Promise<T[]> {
  const matches = await queryParsedEventsWithIds(
    client,
    eventType,
    parse,
    filter,
    opts,
  );
  return matches.map((m) => m.event);
}

async function firstEventWithId<T>(
  client: RpcClient,
  eventType: string,
  parse: (json: Record<string, unknown>) => T,
  filter: (event: T) => boolean,
  order: EventOrder,
): Promise<MatchedEvent<T> | null> {
  const matches = await queryParsedEventsWithIds(
    client,
    eventType,
    parse,
    filter,
    { order, maxPages: 200, earlyExit: true },
  );
  return matches[0] ?? null;
}

async function firstEvent<T>(
  client: RpcClient,
  eventType: string,
  parse: (json: Record<string, unknown>) => T,
  filter: (event: T) => boolean,
  order: EventOrder,
): Promise<T | null> {
  const m = await firstEventWithId(client, eventType, parse, filter, order);
  return m ? m.event : null;
}

async function fetchRideEvents(
  client: RpcClient,
  packageId: string,
  marketId: string,
  rideId: string,
): Promise<{
  opened: RideOpenedEvent;
  closed: RideClosedEvent;
  /** Cursor id of the RideClosed event — used as the chain-order cutoff
   * when fetching SegmentRecorded events (E1 SEV-2 #A). */
  closedEventId: EventCursor | undefined;
}> {
  const opened = await firstEvent(
    client,
    rideOpenedEventType(packageId),
    parseRideOpenedEvent,
    (e) => sameId(e.marketId, marketId) && sameId(e.rideId, rideId),
    "ascending",
  );
  if (!opened) throw new Error(`RideOpened event not found for ride ${rideId}`);

  const closed = await firstEventWithId(
    client,
    rideClosedEventType(packageId),
    parseRideClosedEvent,
    (e) => sameId(e.marketId, marketId) && sameId(e.rideId, rideId),
    "descending",
  );
  if (!closed) throw new Error(`RideClosed event not found for ride ${rideId}`);

  return { opened, closed: closed.event, closedEventId: closed.id };
}

/**
 * Build the set of SegmentRecorded `k`s that landed strictly before
 * the RideClosed event in Sui's chain order.
 *
 * Why this exists (E1 SEV-2 #A): the previous implementation filtered
 * eligibility with `s.recordedAtMs > closedAt`, which loses precision
 * when a segment's `recorded_at_ms` matches the ride's `closed_at_ms`
 * to the millisecond (e.g. when the same keeper tick both records and
 * closes, or when two `clock::timestamp_ms` reads share the checkpoint).
 * That race produced false MISMATCH verdicts. By starting the
 * descending pagination *from* the close event's cursor
 * (`{ txDigest, eventSeq }`), the fullnode returns only events
 * strictly earlier in checkpoint order — no wall-clock comparisons.
 *
 * When the RPC doesn't supply a close cursor (e.g. the synthetic
 * mock), we fall back to "include every k" — preserving the
 * pre-cursor behavior of the test mock.
 */
async function fetchSegmentKsBeforeClose(
  client: RpcClient,
  opts: {
    packageId: string;
    marketId: string;
    closedEventId: EventCursor | undefined;
    pageLimit?: number;
    maxPages?: number;
  },
): Promise<{ ks: Set<string>; bounded: boolean }> {
  // Without a cursor we can't bound the scan; signal the caller that
  // the eligibility set is "trust all segments in range".
  if (!opts.closedEventId) return { ks: new Set(), bounded: false };

  const ks = new Set<string>();
  await queryParsedEvents(
    client,
    segmentRecordedEventType(opts.packageId),
    (j) => ({ marketId: asString(j.market_id), k: asString(j.k) }),
    (rec) => {
      if (sameId(rec.marketId, opts.marketId)) ks.add(rec.k);
      return false;
    },
    {
      order: "descending",
      limit: opts.pageLimit ?? 100,
      maxPages: opts.maxPages ?? 1_000,
      startCursor: opts.closedEventId,
    },
  );
  return { ks, bounded: true };
}

async function fetchCreationEvent(
  client: RpcClient,
  packageId: string,
  marketId: string,
): Promise<SegmentMarketCreatedEvent | null> {
  return firstEvent(
    client,
    segmentMarketCreatedEventType(packageId),
    parseSegmentMarketCreatedEvent,
    (e) => sameId(e.marketId, marketId),
    "ascending",
  );
}

async function fetchRoundEvents(
  client: RpcClient,
  packageId: string,
  marketId: string,
  rounds: Set<string>,
): Promise<Map<string, RoundStartedEvent>> {
  const found = new Map<string, RoundStartedEvent>();
  if (rounds.size === 0) return found;
  await queryParsedEvents(
    client,
    roundStartedEventType(packageId),
    parseRoundStartedEvent,
    (e) => {
      const hit = sameId(e.marketId, marketId) && rounds.has(e.roundIndex.toString());
      if (hit) found.set(e.roundIndex.toString(), e);
      return false;
    },
    { order: "ascending", maxPages: 300 },
  );
  return found;
}

function initialWalkState(created: SegmentMarketCreatedEvent | null): WalkState {
  if (!created) {
    throw new Error(
      "SegmentMarketCreated event not found; cannot reconstruct segment 0 initial walk state",
    );
  }
  return newState(
    created.homePrice,
    DEFAULT_INITIAL_VOL_REGIME,
    created.homePrice,
  );
}

function printRows(rows: ReplayRow[]): void {
  const headers = [
    "k",
    "round",
    "open",
    "high",
    "low",
    "close",
    "eventHigh",
    "eventLow",
    "barrier",
    "touch",
    "match",
  ];
  const body = rows.map((r) => [
    r.k.toString(),
    r.round.toString(),
    formatPrice(r.open),
    formatPrice(r.high),
    formatPrice(r.low),
    formatPrice(r.close),
    formatPrice(r.eventHigh),
    formatPrice(r.eventLow),
    formatPrice(r.barrier),
    formatBool(r.touched),
    formatBool(r.extremaMatch),
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i]?.length ?? 0)),
  );

  const line = (cols: string[]) =>
    cols.map((c, i) => c.padStart(widths[i] ?? c.length)).join("  ");
  console.log(line(headers));
  console.log(line(headers.map((h, i) => "-".repeat(widths[i] ?? h.length))));
  for (const row of body) console.log(line(row));
}

function offchainSettlementKind(
  touched: boolean,
  closed: RideClosedEvent,
  scanEndExclusive: bigint,
  rideRoundEnd: bigint,
): number {
  if (closed.settlementKind === SETTLEMENT_ABORTED_REFUND) {
    return SETTLEMENT_ABORTED_REFUND;
  }
  if (touched) return SETTLEMENT_TOUCH_WIN;
  if (scanEndExclusive >= rideRoundEnd) return SETTLEMENT_EXPIRED_LOSS;
  return SETTLEMENT_CASHOUT;
}

async function verify(args: Args): Promise<boolean> {
  const client: RpcClient = args.rpc.startsWith("mock://")
    ? buildSyntheticClient(args.market, args.ride)
    : new SuiJsonRpcClient({ url: args.rpc, network: "testnet" });

  const marketInfo = await getMarketObjectInfo(client, args.market);
  const market = await fetchSegmentMarket(client as never, args.market);
  if (!market) throw new Error(`failed to fetch SegmentMarket ${args.market}`);

  const rideSnapshot = await fetchSegmentRidePosition(client as never, args.ride);
  if (!rideSnapshot) {
    throw new Error(`failed to fetch SegmentRidePosition ${args.ride}`);
  }

  // S1-B: don't crash if the ride hasn't closed yet — print a friendly message.
  // SETTLEMENT_OPEN = 0 means no RideClosed event has been emitted; the verifier
  // has nothing to compare against. This is the common "user clicks verify on
  // their currently-open ride" case; the script must not crash on it.
  if (rideSnapshot.settlementKind === SETTLEMENT_OPEN) {
    console.log("");
    console.log(
      `Ride ${args.ride} is still OPEN — there is no settlement to verify yet.`,
    );
    console.log(
      "Run verify again after the ride closes (touch_win, cashout, expired_loss, or aborted_refund).",
    );
    console.log("");
    return true;
  }

  // S1-A (known limitation): the off-chain replay seeds segment 0 with
  // DEFAULT_INITIAL_VOL_REGIME (= 1_000_000), matching the value the bootstrap
  // script writes. If this market was deployed with a non-default
  // VOL_REGIME_INIT, extrema replay will FAIL from k=0 even when the chain is
  // honest. Tracked as a follow-up: extend SegmentMarketCreated to emit
  // vol_regime_init, or surface state_after for k=0 from the segments Table.
  // For now, emit a warning so the user can interpret false negatives.
  console.warn(
    `note: verify.ts seeds the walk with vol_regime_init = ${DEFAULT_INITIAL_VOL_REGIME}n (the bootstrap default). If this market was deployed with a non-default value, extrema replay will mismatch from k=0 even on an honest chain.`,
  );

  const { opened, closed, closedEventId } = await fetchRideEvents(
    client,
    marketInfo.packageId,
    args.market,
    args.ride,
  );
  const created = await fetchCreationEvent(client, marketInfo.packageId, args.market);

  const rideRoundEnd = (opened.roundIndex + 1n) * market.roundDurationSegments;
  const allSegments = await fetchSegments(client as never, {
    packageId: marketInfo.packageId,
    marketId: args.market,
    fromK: 0n,
    toK: market.nextSegmentIndex,
    pageLimit: 100,
    maxPages: 1_000,
  });

  // Cursor-based eligibility cutoff (E1 SEV-2 #A): the previous filter
  // `s.recordedAtMs > closedAt` is wrong when a segment's
  // `recorded_at_ms` ties the ride's `closed_at_ms` to the millisecond
  // (same keeper tick, shared clock snapshot). Use the RideClosed
  // event's `{ txDigest, eventSeq }` as the chain-order cutoff instead.
  // For the bounty branch the cutoff is rideRoundEnd (the keeper
  // drained every segment up to the round end) so we don't need the
  // cursor scan there.
  const closeCutoff = await fetchSegmentKsBeforeClose(client, {
    packageId: marketInfo.packageId,
    marketId: args.market,
    closedEventId: closed.bounty > 0n ? undefined : closedEventId,
  });

  const eligible = allSegments.filter((s) => {
    if (s.k < opened.entrySegmentIndex) return false;
    if (closed.bounty > 0n) return s.k < rideRoundEnd;
    if (!closeCutoff.bounded) return true;
    return closeCutoff.ks.has(s.k.toString());
  });
  const scanEndExclusive =
    eligible.length === 0
      ? opened.entrySegmentIndex
      : eligible[eligible.length - 1]!.k + 1n;

  const rounds = new Set<string>();
  for (const s of eligible) {
    rounds.add(segmentRound(s.k, market.roundDurationSegments).toString());
  }
  const roundEvents = await fetchRoundEvents(
    client,
    marketInfo.packageId,
    args.market,
    rounds,
  );

  let state = initialWalkState(created);
  const recordsByK = new Map(allSegments.map((s) => [s.k.toString(), s]));
  const rows: ReplayRow[] = [];
  let touched = false;
  let allExtremaMatch = true;

  for (let k = 0n; k < market.nextSegmentIndex; k++) {
    const record = recordsByK.get(k.toString());
    if (!record) {
      throw new Error(`missing SegmentRecorded event for segment ${k}`);
    }
    const result = expandSegment(state, record.key);
    const inRideRange =
      k >= opened.entrySegmentIndex && k < scanEndExclusive;
    const round = segmentRound(k, market.roundDurationSegments);
    const roundBarrier = roundEvents.get(round.toString());
    const barrier =
      roundBarrier
        ? opened.barrierIndex === BARRIER_UPPER
          ? roundBarrier.upperBarrier
          : roundBarrier.lowerBarrier
        : opened.barrierPrice;
    const segmentTouched =
      inRideRange &&
      directionTouches(
        result,
        opened.barrierPrice,
        market.deadbandBps,
        opened.barrierIndex === BARRIER_UPPER,
      );
    const extremaMatch =
      result.min === record.minPrice && result.max === record.maxPrice;
    if (inRideRange) {
      allExtremaMatch = allExtremaMatch && extremaMatch;
      touched = touched || segmentTouched;
      rows.push({
        k,
        round,
        open: result.candles[0]?.open ?? state.price,
        high: result.max,
        low: result.min,
        close: result.candles[result.candles.length - 1]?.close ?? result.newState.price,
        eventHigh: record.maxPrice,
        eventLow: record.minPrice,
        barrier,
        touched: segmentTouched,
        extremaMatch,
      });
    }
    state = result.newState;
  }

  const offchainKind = offchainSettlementKind(
    touched,
    closed,
    scanEndExclusive,
    rideRoundEnd,
  );
  const verdictMatches = offchainKind === closed.settlementKind;
  const pass = allExtremaMatch && verdictMatches;

  console.log(`market: ${args.market}`);
  console.log(`ride:   ${args.ride}`);
  console.log(`package: ${marketInfo.packageId}`);
  console.log(
    `range:  [${opened.entrySegmentIndex}, ${scanEndExclusive}) of round ${opened.roundIndex}`,
  );
  console.log(
    `barrier: ${formatPrice(opened.barrierPrice)} ${opened.barrierIndex === BARRIER_UPPER ? "upper" : "lower"}; deadband=${market.deadbandBps}bps`,
  );
  console.log("");
  printRows(rows);
  console.log("");
  console.log(`off-chain verdict: ${settlementName(offchainKind)}`);
  console.log(`on-chain verdict:  ${settlementName(closed.settlementKind)}`);
  console.log(`extrema replay:    ${allExtremaMatch ? "match" : "mismatch"}`);
  console.log(pass ? "PASS" : "FAIL");
  return pass;
}

function bytes32(seed: number): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < out.length; i++) out[i] = (seed + i * 17) & 0xff;
  return out;
}

function hex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function buildSyntheticClient(marketId: string, rideId: string): RpcClient {
  const packageId = "0xabc";
  const vaultId = "0xdef";
  const home = 1_000_000_000n;
  const roundDuration = 6n;
  const deadbandBps = 0n;
  const keys = [bytes32(1), bytes32(2), bytes32(3)];
  let state = newState(home, DEFAULT_INITIAL_VOL_REGIME, home);
  const segmentEvents = keys.map((key, i) => ({
    type: `${packageId}::segment_market::SegmentRecorded`,
    parsedJson: (() => {
      const result = expandSegment(state, key);
      state = result.newState;
      return {
        market_id: marketId,
        k: String(i),
        key: hex(key),
        min_price: result.min.toString(),
        max_price: result.max.toString(),
        recorded_at_ms: String(1_000 + i * 400),
      };
    })(),
  }));

  // Assign each event a synthetic, globally-monotonic id so the
  // cursor-bounded scan (E1 SEV-2 #A) has something to pivot on. Order
  // matches emission order: created < opened < segment[0] < ... <
  // segment[N-1] < closed.
  type Ev = { type: string; parsedJson: Record<string, unknown>; id: EventCursor };
  const rawEvents: Array<Omit<Ev, "id">> = [
    {
      type: `${packageId}::segment_market::SegmentMarketCreated`,
      parsedJson: {
        market_id: marketId,
        vault_id: vaultId,
        home_price: home.toString(),
        round_duration_segments: roundDuration.toString(),
        open_window_segments: "2",
        barrier_offset_bps: "0",
        multiplier_bps: "20000",
        max_payout_per_barrier: "1000000000",
        created_at_ms: "900",
      },
    },
    {
      type: `${packageId}::segment_market::RideOpened`,
      parsedJson: {
        ride_id: rideId,
        user: "0x1",
        market_id: marketId,
        round_index: "0",
        barrier_index: "0",
        barrier_price: home.toString(),
        stake_per_segment: "100",
        escrowed: "600",
        multiplier_bps: "20000",
        entry_segment_index: "0",
        opened_at_ms: "950",
      },
    },
    ...segmentEvents,
    {
      type: `${packageId}::segment_market::RideClosed`,
      parsedJson: {
        ride_id: rideId,
        user: "0x1",
        market_id: marketId,
        round_index: "0",
        barrier_index: "0",
        settlement_kind: String(SETTLEMENT_TOUCH_WIN),
        stake_paid: "300",
        payout: "600",
        forfeit: "0",
        bounty: "0",
        closed_at_ms: "2500",
      },
    },
  ];
  const events: Ev[] = rawEvents.map((e, i) => ({
    ...e,
    id: { txDigest: `0xtx${String(i).padStart(4, "0")}`, eventSeq: "0" },
  }));

  function compareCursor(a: EventCursor, b: EventCursor): number {
    if (a.txDigest === b.txDigest) {
      const ae = BigInt(a.eventSeq);
      const be = BigInt(b.eventSeq);
      return ae < be ? -1 : ae > be ? 1 : 0;
    }
    return a.txDigest < b.txDigest ? -1 : 1;
  }

  return {
    async getObject(args: unknown): Promise<unknown> {
      const id = asString(asObject(args).id);
      if (sameId(id, marketId)) {
        return {
          data: {
            objectId: marketId,
            content: {
              dataType: "moveObject",
              type: `${packageId}::segment_market::SegmentMarket<0x2::sui::SUI>`,
              fields: {
                vault_id: vaultId,
                walk: { fields: { price: state.price.toString() } },
                next_segment_index: keys.length.toString(),
                active_ride_count: "0",
                round_duration_segments: roundDuration.toString(),
                open_window_segments: "2",
                barrier_offset_bps: "0",
                multiplier_bps: "20000",
                max_payout_per_barrier: "1000000000",
                cached_round_index: "0",
                cached_round_started_at_segment: "0",
                cached_upper_barrier: home.toString(),
                cached_lower_barrier: home.toString(),
                upper_aggregate_stake: "0",
                lower_aggregate_stake: "0",
                upper_aggregate_max_payout: "0",
                lower_aggregate_max_payout: "0",
                upper_rider_count: "0",
                lower_rider_count: "0",
                deadband_bps: deadbandBps.toString(),
                sigma_bps_per_sqrt_sec: "100",
                cashout_spread_bps: "0",
                abort_segment_deadline_ms: "10000",
                min_stake_per_segment: "1",
                max_stake_per_segment: "1000000",
                max_concurrent_rides: "10",
                max_rides_per_user: "10",
                created_at_ms: "900",
              },
            },
          },
        };
      }
      if (sameId(id, rideId)) {
        return {
          data: {
            objectId: rideId,
            content: {
              dataType: "moveObject",
              type: `${packageId}::segment_market::SegmentRidePosition`,
              fields: {
                user: "0x1",
                market_id: marketId,
                round_index: "0",
                entry_segment_index: "0",
                barrier_index: "0",
                barrier_price: home.toString(),
                multiplier_bps: "20000",
                stake_per_segment: "100",
                escrowed: "600",
                is_bot_eligible: true,
                opened_at_ms: "950",
                closed: true,
                closed_at_ms: "2500",
                settlement_kind: String(SETTLEMENT_TOUCH_WIN),
                collateral: { fields: { name: "0x2::sui::SUI" } },
              },
            },
          },
        };
      }
      return { data: null };
    },
    async queryEvents(args: unknown): Promise<{
      data: Array<RpcEvent>;
      hasNextPage: boolean;
      nextCursor: EventCursor | null;
    }> {
      const a = asObject(args);
      const query = asObject(a.query);
      const eventType = asString(query.MoveEventType);
      const order: EventOrder =
        a.order === "ascending" ? "ascending" : "descending";
      const startCursor = asEventId(a.cursor);
      let matches = events.filter((e) => e.type === eventType);
      if (startCursor) {
        // Sui semantics: cursor is exclusive — pagination returns
        // events strictly before/after the cursor depending on order.
        matches = matches.filter((e) =>
          order === "descending"
            ? compareCursor(e.id, startCursor) < 0
            : compareCursor(e.id, startCursor) > 0,
        );
      }
      matches.sort((x, y) =>
        order === "descending"
          ? compareCursor(y.id, x.id)
          : compareCursor(x.id, y.id),
      );
      return {
        data: matches.map((e) => ({ id: e.id, parsedJson: e.parsedJson })),
        hasNextPage: false,
        nextCursor: null,
      };
    },
  };
}

verify(parseArgs(process.argv.slice(2)))
  .then((ok) => {
    process.exitCode = ok ? 0 : 1;
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
