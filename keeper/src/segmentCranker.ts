// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// C1 — Pipelined `record_segment` cranker for the provably-fair arcade.
//
// The on-chain SegmentMarket (`move/sources/segment_market.move`) has a
// wake/sleep gate: `record_segment` aborts with `ENoActiveRides (=14)` when
// `active_ride_count == 0`. This cranker pumps `wick::record_segment<C>` at
// a ~400ms cadence whenever the market has at least one open ride; it goes
// quiet otherwise so dormant markets don't burn keeper gas.
//
// References:
//   - docs/design/v2/18_segment_market_design.md §12 (cranker spec)
//   - docs/design/v2/19_round_shared_grid_design.md §7, §12, §17.6
//   - sdk/src/segmentMarket.ts (PTB shape mirrored here; we don't import
//     the SDK because this module is keeper-only and the task forbids
//     reaching into sdk/. The SDK is the canonical reference and any
//     future ABI change should be propagated to both.)
//
// Design properties (per the task brief):
//   - Subscribes via event polling to RideOpened / RideClosed per market;
//     local `active_ride_count` is kept in sync without re-reading the
//     market object every tick.
//   - PIPELINED: tx submission is fire-and-forget. We do NOT wait for
//     confirmation between submissions. A small in-flight cap (default 8)
//     keeps us from drowning the RPC under failure cascades, but it does
//     not serialise the pipeline.
//   - Permissionless: the cranker reads events from chain, so any other
//     runner (a player's client, a second keeper) cranking the same market
//     does not throw our active-count tracker off. The on-chain
//     `record_segment` is idempotent w.r.t. independent runners because
//     each tx is its own segment_index draw.
//   - Robust to chain-side failures: tx-failure logs but does not crash;
//     a per-market backoff briefly pauses scheduling. Event-poll RPC
//     errors also back off.

import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";

// ── Tunables (overridable per `start()` call) ───────────────────────────────

/** Target cadence between `record_segment` submissions per market (ms). */
export const DEFAULT_CRANK_INTERVAL_MS = 400;

/** Max concurrent in-flight crank txs per market. Soft cap; protects the
 * RPC during failure cascades. Fire-and-forget is preserved — we don't
 * await any individual tx, we just refuse to schedule beyond the cap. */
export const DEFAULT_MAX_INFLIGHT_PER_MARKET = 8;

/** Polling cadence for RideOpened / RideClosed events (ms). The Move side
 * gates correctness; this just keeps our wake/sleep decision fresh. */
export const DEFAULT_EVENT_POLL_INTERVAL_MS = 1_500;

/** Max events fetched per RPC page when polling. */
export const DEFAULT_EVENT_PAGE_LIMIT = 50;

/** Pause cadence briefly after a tx submission error (ms). The cranker
 * itself never crashes; this just throttles a flapping RPC. */
export const DEFAULT_ERROR_BACKOFF_MS = 2_000;

/** Gas budget for one `record_segment` call. Empirically ~5M MIST; the
 * default is generous so a chain-side gas-price bump doesn't break us.
 * Override via env `WICK_KEEPER_GAS_RECORD_SEGMENT`. */
export const DEFAULT_GAS_BUDGET = 20_000_000n;

// ── Public API ──────────────────────────────────────────────────────────────

export interface SegmentMarketBinding {
  /** Wick package id — the deployed `<pkg>::wick::record_segment` target. */
  packageId: string;
  /** Type-arg for `record_segment<C>` — e.g. "0x2::sui::SUI". */
  collateralType: string;
  /** Shared SegmentMarket<C> object id. */
  marketId: string;
}

export interface SegmentCrankerOptions {
  /** Per-market crank cadence in ms. Default 400. */
  intervalMs?: number;
  /** Per-market max concurrent in-flight cranks. Default 8. */
  maxInflightPerMarket?: number;
  /** Event-poll cadence in ms. Default 1_500. */
  eventPollIntervalMs?: number;
  /** Events per page on RPC polling. Default 50. */
  eventPageLimit?: number;
  /** Error backoff after a failed submission (ms). Default 2_000. */
  errorBackoffMs?: number;
  /** Gas budget per record_segment tx. Default 20_000_000n MIST. */
  gasBudget?: bigint;
  /** If true, on start() we poll the SegmentMarket object once for its
   * authoritative `active_ride_count` to seed the local counter. If false,
   * we start at 0 and rely on event flow to populate. Default true. */
  seedFromChain?: boolean;
  /** Custom log sink. Default: NDJSON to stdout. */
  log?: (entry: SegmentCrankerLogEntry) => void;
}

export interface SegmentCrankerLogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  action: string;
  market_id?: string;
  tx_digest?: string;
  error?: string;
  active_ride_count?: number;
  inflight?: number;
  msg?: string;
  detail?: Record<string, unknown>;
}

export interface SegmentMarketStatus {
  marketId: string;
  packageId: string;
  collateralType: string;
  activeRideCount: number;
  inflight: number;
  cranking: boolean;
  lastSubmitTsMs: number;
  lastSubmitDigest: string | null;
  lastErrorTsMs: number;
  lastErrorMessage: string | null;
  submittedTotal: number;
  succeededTotal: number;
  failedTotal: number;
  ridesOpenedTotal: number;
  ridesClosedTotal: number;
}

// ── Internal state ──────────────────────────────────────────────────────────

interface MarketState {
  binding: SegmentMarketBinding;
  // Live count of open rides. Driven by RideOpened/RideClosed events.
  activeRideCount: number;
  // How many submitted txs haven't resolved (success or failure) yet.
  inflight: number;
  // setInterval handle for the crank scheduler.
  crankTimer: NodeJS.Timeout | null;
  // setInterval handle for the per-market event poller.
  eventTimer: NodeJS.Timeout | null;
  // Event cursors per stream — separate so we can advance independently.
  openedCursor: EventCursor | null;
  closedCursor: EventCursor | null;
  lastSubmitTsMs: number;
  lastSubmitDigest: string | null;
  lastErrorTsMs: number;
  lastErrorMessage: string | null;
  errorPauseUntilMs: number;
  // Telemetry.
  submittedTotal: number;
  succeededTotal: number;
  failedTotal: number;
  ridesOpenedTotal: number;
  ridesClosedTotal: number;
}

type EventCursor = { txDigest: string; eventSeq: string };

// ── Tx builder — mirrors sdk/src/segmentMarket.ts buildRecordSegmentTx. ─────
// Kept local per the task brief ("don't touch sdk/"). The wick.move router
// re-exports record_segment so the call target lives at <pkg>::wick:: not
// <pkg>::segment_market::. The Random object must be the well-known
// 0x8 system object — passed via tx.object.random().

export function buildRecordSegmentTx(
  binding: SegmentMarketBinding,
  gasBudget: bigint,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${binding.packageId}::wick::record_segment`,
    typeArguments: [binding.collateralType],
    arguments: [
      tx.object(binding.marketId),
      tx.object.random(),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  tx.setGasBudget(gasBudget);
  return tx;
}

// ── Event-type helpers — match SDK `rideOpenedEventType` / `rideClosedEventType` ─

export function rideOpenedEventType(packageId: string): string {
  return `${packageId}::segment_market::RideOpened`;
}

export function rideClosedEventType(packageId: string): string {
  return `${packageId}::segment_market::RideClosed`;
}

// ── The cranker ─────────────────────────────────────────────────────────────

export class SegmentCranker {
  private readonly client: SuiJsonRpcClient;
  private readonly signer: Ed25519Keypair;
  private readonly opts: Required<Omit<SegmentCrankerOptions, "log">> & {
    log: (e: SegmentCrankerLogEntry) => void;
  };
  private readonly markets = new Map<string, MarketState>();
  private running = false;

  constructor(
    client: SuiJsonRpcClient,
    signer: Ed25519Keypair,
    opts: SegmentCrankerOptions = {},
  ) {
    this.client = client;
    this.signer = signer;
    this.opts = {
      intervalMs: opts.intervalMs ?? DEFAULT_CRANK_INTERVAL_MS,
      maxInflightPerMarket:
        opts.maxInflightPerMarket ?? DEFAULT_MAX_INFLIGHT_PER_MARKET,
      eventPollIntervalMs:
        opts.eventPollIntervalMs ?? DEFAULT_EVENT_POLL_INTERVAL_MS,
      eventPageLimit: opts.eventPageLimit ?? DEFAULT_EVENT_PAGE_LIMIT,
      errorBackoffMs: opts.errorBackoffMs ?? DEFAULT_ERROR_BACKOFF_MS,
      gasBudget: opts.gasBudget ?? DEFAULT_GAS_BUDGET,
      seedFromChain: opts.seedFromChain ?? true,
      log: opts.log ?? defaultLogger,
    };
  }

  /** Start cranking the supplied markets. Safe to call once; subsequent
   * calls will append new markets without restarting existing ones. */
  async start(bindings: SegmentMarketBinding[]): Promise<void> {
    this.running = true;
    for (const b of bindings) {
      if (this.markets.has(b.marketId)) continue;
      const state: MarketState = {
        binding: b,
        activeRideCount: 0,
        inflight: 0,
        crankTimer: null,
        eventTimer: null,
        openedCursor: null,
        closedCursor: null,
        lastSubmitTsMs: 0,
        lastSubmitDigest: null,
        lastErrorTsMs: 0,
        lastErrorMessage: null,
        errorPauseUntilMs: 0,
        submittedTotal: 0,
        succeededTotal: 0,
        failedTotal: 0,
        ridesOpenedTotal: 0,
        ridesClosedTotal: 0,
      };
      this.markets.set(b.marketId, state);

      // Seed active_ride_count from the chain so the first tick is honest.
      // If this fails, we log + start at 0; events will bring us into sync.
      if (this.opts.seedFromChain) {
        try {
          state.activeRideCount = await this.readActiveRideCount(b.marketId);
          this.opts.log({
            ts: nowIso(),
            level: "info",
            action: "segment-cranker.seed",
            market_id: b.marketId,
            active_ride_count: state.activeRideCount,
          });
        } catch (err) {
          this.opts.log({
            ts: nowIso(),
            level: "warn",
            action: "segment-cranker.seed-failed",
            market_id: b.marketId,
            error: String(err),
            msg: "starting active_ride_count = 0; events will resync",
          });
        }
      }

      // Schedule crank loop.
      state.crankTimer = setInterval(
        () => { void this.maybeCrank(state); },
        this.opts.intervalMs,
      );
      // Allow process to exit cleanly even if timer is still armed.
      if (typeof state.crankTimer.unref === "function") {
        state.crankTimer.unref();
      }

      // Schedule event poller.
      state.eventTimer = setInterval(
        () => { void this.pollEvents(state); },
        this.opts.eventPollIntervalMs,
      );
      if (typeof state.eventTimer.unref === "function") {
        state.eventTimer.unref();
      }

      this.opts.log({
        ts: nowIso(),
        level: "info",
        action: "segment-cranker.start",
        market_id: b.marketId,
        detail: {
          package_id: b.packageId,
          collateral_type: b.collateralType,
          interval_ms: this.opts.intervalMs,
          max_inflight: this.opts.maxInflightPerMarket,
        },
      });
    }
  }

  /** Stop all cranking. In-flight txs are NOT cancelled (Sui can't), but
   * we stop scheduling new ones. Returns once all timers are cleared. */
  stop(): void {
    this.running = false;
    for (const s of this.markets.values()) {
      if (s.crankTimer != null) {
        clearInterval(s.crankTimer);
        s.crankTimer = null;
      }
      if (s.eventTimer != null) {
        clearInterval(s.eventTimer);
        s.eventTimer = null;
      }
    }
    this.opts.log({
      ts: nowIso(),
      level: "info",
      action: "segment-cranker.stop",
      msg: `stopped ${this.markets.size} markets`,
    });
  }

  /** Return a snapshot of every market the cranker is managing. */
  status(): SegmentMarketStatus[] {
    return Array.from(this.markets.values()).map((s) => ({
      marketId: s.binding.marketId,
      packageId: s.binding.packageId,
      collateralType: s.binding.collateralType,
      activeRideCount: s.activeRideCount,
      inflight: s.inflight,
      cranking: this.running && s.activeRideCount > 0,
      lastSubmitTsMs: s.lastSubmitTsMs,
      lastSubmitDigest: s.lastSubmitDigest,
      lastErrorTsMs: s.lastErrorTsMs,
      lastErrorMessage: s.lastErrorMessage,
      submittedTotal: s.submittedTotal,
      succeededTotal: s.succeededTotal,
      failedTotal: s.failedTotal,
      ridesOpenedTotal: s.ridesOpenedTotal,
      ridesClosedTotal: s.ridesClosedTotal,
    }));
  }

  /** Expose the per-market binding by id (useful for tests / inspection). */
  getMarket(marketId: string): SegmentMarketStatus | undefined {
    const s = this.markets.get(marketId);
    if (!s) return undefined;
    return this.status().find((x) => x.marketId === marketId);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** Crank scheduler — called every `intervalMs`. Issues one tx if the
   * wake gate (active > 0) is open, we're not error-paused, and we're
   * below the in-flight cap. Fire-and-forget. */
  private async maybeCrank(state: MarketState): Promise<void> {
    if (!this.running) return;
    if (state.activeRideCount <= 0) return;
    if (state.inflight >= this.opts.maxInflightPerMarket) return;
    const now = Date.now();
    if (now < state.errorPauseUntilMs) return;

    const tx = buildRecordSegmentTx(state.binding, this.opts.gasBudget);
    state.inflight += 1;
    state.submittedTotal += 1;

    // Fire-and-forget. Do NOT await. The .then/.catch handlers update
    // telemetry asynchronously; they do not block the schedule loop.
    this.client
      .signAndExecuteTransaction({
        signer: this.signer,
        transaction: tx,
        // No effects requested → minimal payload, faster RPC turnaround.
        options: { showEffects: false, showEvents: false },
        // Don't wait for execution — return as soon as the fullnode
        // accepted the tx. This is what gives us pipelining at ~400ms.
        requestType: "WaitForEffectsCert",
      })
      .then((res) => {
        state.inflight -= 1;
        state.succeededTotal += 1;
        state.lastSubmitTsMs = Date.now();
        state.lastSubmitDigest = res.digest;
      })
      .catch((err) => {
        state.inflight -= 1;
        state.failedTotal += 1;
        const msg = (err as Error)?.message ?? String(err);
        state.lastErrorTsMs = Date.now();
        state.lastErrorMessage = msg;
        state.errorPauseUntilMs = Date.now() + this.opts.errorBackoffMs;
        // ENoActiveRides (=14) is the wake/sleep gate firing — expected
        // if our event-driven counter is ever a beat behind. Log at info,
        // not error, so dashboards don't alarm.
        const isWakeGate = /ENoActiveRides|abort code: 14\b/.test(msg);
        this.opts.log({
          ts: nowIso(),
          level: isWakeGate ? "info" : "warn",
          action: "segment-cranker.tx-error",
          market_id: state.binding.marketId,
          error: msg,
          inflight: state.inflight,
        });
      });
  }

  /** Poll RideOpened + RideClosed events and update active_ride_count.
   * Idempotent — if the network blip wins, the next tick re-fetches. */
  private async pollEvents(state: MarketState): Promise<void> {
    if (!this.running) return;
    try {
      // Poll both event streams. We use MoveEventType to filter at the
      // RPC; we further filter by market_id client-side because the Move
      // emit doesn't expose a per-market topic.
      const openedType = rideOpenedEventType(state.binding.packageId);
      const closedType = rideClosedEventType(state.binding.packageId);
      const [openedDelta, closedDelta] = await Promise.all([
        this.pollEventStream(state, openedType, "opened"),
        this.pollEventStream(state, closedType, "closed"),
      ]);
      if (openedDelta !== 0 || closedDelta !== 0) {
        state.activeRideCount =
          state.activeRideCount + openedDelta - closedDelta;
        if (state.activeRideCount < 0) {
          // We started seeded mid-flight; a re-sync from chain absorbs
          // the drift. Clamp to 0 to keep wake/sleep correct.
          state.activeRideCount = 0;
        }
        state.ridesOpenedTotal += openedDelta;
        state.ridesClosedTotal += closedDelta;
        this.opts.log({
          ts: nowIso(),
          level: "info",
          action: "segment-cranker.active-count",
          market_id: state.binding.marketId,
          active_ride_count: state.activeRideCount,
          detail: { opened_delta: openedDelta, closed_delta: closedDelta },
        });
      }
    } catch (err) {
      this.opts.log({
        ts: nowIso(),
        level: "warn",
        action: "segment-cranker.event-poll-error",
        market_id: state.binding.marketId,
        error: String(err),
      });
    }
  }

  /** Walk one event stream (RideOpened or RideClosed) from the latest
   * known cursor, returning the count of matching events. Updates the
   * stream's cursor in `state` so subsequent polls don't re-process.
   *
   * Cursor lifecycle:
   *  - First poll (cursor == null): query the LATEST events in
   *    descending order, capture the most recent cursor without counting
   *    anything (we don't want to replay history at start-up — the
   *    `seedFromChain` path provides the authoritative starting count).
   *  - Subsequent polls: walk forward (ascending) from the cursor,
   *    counting each event whose `market_id` matches this binding.
   *
   * Safety: caps at `maxPages` to avoid runaway loops on very busy
   * markets. Missing a few events at the tail is self-healing on the
   * next poll because we update the cursor only on success.
   */
  private async pollEventStream(
    state: MarketState,
    eventType: string,
    kind: "opened" | "closed",
  ): Promise<number> {
    const startCursor = kind === "opened" ? state.openedCursor : state.closedCursor;
    let cursor: EventCursor | null = startCursor;
    const isFirstPoll = cursor == null;
    let count = 0;
    let primedCursor: EventCursor | null = null;
    let pageCount = 0;
    const maxPages = 10;

    while (pageCount < maxPages) {
      pageCount += 1;
      const page = await this.client.queryEvents({
        query: { MoveEventType: eventType },
        cursor,
        limit: this.opts.eventPageLimit,
        order: isFirstPoll ? "descending" : "ascending",
      });

      if (isFirstPoll) {
        // Take the very-latest event's id as our forward cursor. We do
        // not count any events on this poll — the chain-seed call already
        // set state.activeRideCount.
        if (page.data.length > 0) {
          const ev0 = page.data[0]!;
          primedCursor = { txDigest: ev0.id.txDigest, eventSeq: ev0.id.eventSeq };
        }
        break;
      }

      for (const ev of page.data) {
        const j = (ev.parsedJson ?? {}) as Record<string, unknown>;
        const mid = String(j["market_id"] ?? "");
        if (mid === state.binding.marketId) count += 1;
      }
      const next = page.nextCursor as EventCursor | null | undefined;
      if (!page.hasNextPage || !next) {
        if (next != null) cursor = next;
        break;
      }
      cursor = next;
    }

    const newCursor = isFirstPoll ? primedCursor : cursor;
    if (kind === "opened") state.openedCursor = newCursor;
    else state.closedCursor = newCursor;
    return count;
  }

  /** One-shot read of `SegmentMarket.active_ride_count` from chain. Used
   * on `start()` to seed the local counter so we don't have to replay
   * history. */
  private async readActiveRideCount(marketId: string): Promise<number> {
    const o = await this.client.getObject({
      id: marketId,
      options: { showContent: true, showType: true },
    });
    if (!o.data || o.data.content?.dataType !== "moveObject") {
      throw new Error(`segment market ${marketId} not found or not a Move object`);
    }
    const content = o.data.content as { fields: Record<string, unknown> };
    const raw = content.fields["active_ride_count"];
    if (raw == null) {
      throw new Error(`segment market ${marketId} has no active_ride_count field`);
    }
    return Number(raw);
  }
}

// ── Standalone active-count tracker — testable without RPC ──────────────────
//
// Pulled out into a separate type because the deterministic-state portion
// is unit-testable: given a stream of (kind, marketId) events, the
// resulting per-market count is what we expect. RPC + scheduling lives in
// the SegmentCranker class above.

export class ActiveRideCountTracker {
  private readonly counts = new Map<string, number>();

  /** Seed a market's count from chain. */
  seed(marketId: string, count: number): void {
    if (!Number.isFinite(count) || count < 0) {
      throw new Error(`seed count must be a non-negative finite number, got ${count}`);
    }
    this.counts.set(marketId, Math.floor(count));
  }

  /** Apply one RideOpened event. Returns the new count. */
  onRideOpened(marketId: string): number {
    const c = (this.counts.get(marketId) ?? 0) + 1;
    this.counts.set(marketId, c);
    return c;
  }

  /** Apply one RideClosed event. Returns the new count (clamped at 0). */
  onRideClosed(marketId: string): number {
    const prev = this.counts.get(marketId) ?? 0;
    const c = prev > 0 ? prev - 1 : 0;
    this.counts.set(marketId, c);
    return c;
  }

  /** Current count (default 0). */
  get(marketId: string): number {
    return this.counts.get(marketId) ?? 0;
  }

  /** Wake/sleep predicate. The on-chain gate uses `active > 0`; we mirror. */
  shouldCrank(marketId: string): boolean {
    return this.get(marketId) > 0;
  }

  /** Reset one market or all. Useful when the cranker is re-seeded. */
  reset(marketId?: string): void {
    if (marketId == null) this.counts.clear();
    else this.counts.delete(marketId);
  }

  /** Snapshot all known markets and their counts. */
  snapshot(): { marketId: string; count: number }[] {
    return Array.from(this.counts, ([marketId, count]) => ({ marketId, count }));
  }
}

// ── Logger ──────────────────────────────────────────────────────────────────

function defaultLogger(entry: SegmentCrankerLogEntry): void {
  // NDJSON to stdout — matches the rest of the keeper.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
}

function nowIso(): string {
  return new Date().toISOString();
}

// ── Config helper: parse a comma-separated WICK_KEEPER_SEGMENT_MARKETS ──────
//
// Two accepted shapes per item:
//   "<marketId>"                 — uses default package + collateral
//   "<marketId>@<packageId>:<collateralType>"
//
// The default packageId is the keeper's main package; the default
// collateral is "0x2::sui::SUI". This keeps the env-var lightweight for
// the common case (one market on one package).

export function parseSegmentMarketsEnv(
  raw: string | undefined,
  defaultPackageId: string,
  defaultCollateralType = "0x2::sui::SUI",
): SegmentMarketBinding[] {
  if (!raw || raw.trim().length === 0) return [];
  const out: SegmentMarketBinding[] = [];
  for (const item of raw.split(",")) {
    const trimmed = item.trim();
    if (trimmed.length === 0) continue;
    const atIdx = trimmed.indexOf("@");
    if (atIdx < 0) {
      out.push({
        marketId: trimmed,
        packageId: defaultPackageId,
        collateralType: defaultCollateralType,
      });
      continue;
    }
    const marketId = trimmed.slice(0, atIdx).trim();
    const rest = trimmed.slice(atIdx + 1).trim();
    const colonIdx = rest.indexOf(":");
    if (colonIdx < 0) {
      out.push({
        marketId,
        packageId: rest,
        collateralType: defaultCollateralType,
      });
      continue;
    }
    const packageId = rest.slice(0, colonIdx).trim();
    // Collateral type may contain '::' — take everything after the first ':'.
    const collateralType = rest.slice(colonIdx + 1).trim();
    out.push({ marketId, packageId, collateralType });
  }
  return out;
}
