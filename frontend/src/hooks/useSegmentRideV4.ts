/**
 * useSegmentRideV4 — touch-either always-open arcade lifecycle (doc 25).
 *
 * Parallel to `useSegmentRide` (the v3 round-based hook). This v4 hook:
 *   - drops the open-window gate entirely (every segment is open)
 *   - drops the `barrierIndex` argument on `open` (rides are direction-neutral)
 *   - uses the V4 event tags + parsers from `@wick/sdk` (`*V4`)
 *   - reads merged `either_*` aggregates from the on-chain market snapshot
 *
 * Responsibilities (otherwise unchanged from v3):
 *   1. Subscribe to `RoundStartedV4` events — keeps `round` current.
 *   2. Subscribe to `SegmentRecordedV4` events — feeds the segment ring
 *      buffer the chart hook expands into candles.
 *   3. Expose `open()` (no args) and `close()` — optimistic phase
 *      transitions; chain calls fire in the background.
 *   4. Expose `cranker()` — D4 fallback: client-side `record_segment_v4`
 *      when the keeper stalls.
 *
 * Optimistic UI (doc 17 §14.5 — load-bearing):
 *   - press → phase immediately = "opening", chart shows starting…
 *   - tx lands → phase = "riding"
 *   - release → phase immediately = "closing", chart shows cashing out…
 *   - tx lands → phase = "idle" + lastSettlement populated for the toast
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import {
  buildCloseSegmentRideV4Tx,
  buildOpenSegmentRideV4Tx,
  buildRecordSegmentV4Tx,
  fetchSegmentMarketV4,
  parseRoundStartedV4Event,
  parseSegmentRecordedV4Event,
  roundStartedV4EventType,
  segmentRecordedV4EventType,
  SETTLEMENT_NAME_V4,
  subscribeRugFiredV4,
  type RoundStartedV4Event,
  type RugFiredV4Event,
  type SegmentMarketV4Snapshot,
  type SegmentRecordedV4Event,
} from "@wick/sdk";
import {
  TESTNET_DEPLOYMENT,
  type SegmentMarketV4Record,
} from "@/lib/deployments";
import type { RidePhase, RoundInfo, SegmentInput } from "@/hooks/useRideGesture";

const PRICE_SCALING = 1_000_000;

/** Poll cadence — same as v3 for consistency. */
const EVENT_POLL_MS = 350;
/** Ring buffer size — same as v3. */
const MAX_SEGMENT_RING = 16;
// v4 default: $0.10/segment. Must stay within the market's [min, max]
// stake range. The 2026-05-23 v4 bootstrap on testnet uses
// max_stake_per_segment=150_000 (= $0.15), so anything above that aborts
// `open_segment_ride_v4` with `EStakeOutOfRange` (code 6). The old default
// of 200_000 was over the cap.
const DEFAULT_STAKE_PER_SEGMENT_MICROUSD = 100_000n;
const DEFAULT_MULTIPLIER_BPS = 17_500; // 1.75× (B7 calibration)

// ── Error humanizer (P0 fix — agent #9) ──────────────────────────────────
//
// segment_market_v4.move:78-112 abort codes mapped to 1-line user copy.
// Without this, every chain abort surfaces a raw `MoveAbort … abort code:
// 11, in '0x...::segment_market_v4::open_segment_ride_v4' (instruction 214)`
// in the bottom toast — terrifying to the user and saying nothing
// actionable.
const MOVE_ABORT_MESSAGES: Record<number, string> = {
  1:  "Already cashed out — pull to refresh.",
  2:  "Wrong market — refresh the page.",
  3:  "Market is paused — try again in a moment.",
  4:  "Invalid barrier pick.",
  5:  "Open window closed.",
  // v4.19: abort 6 is EStakeOutOfRange. A refresh does NOT fix it — the
  // market's max_stake_per_segment is lower than the frontend default,
  // which only an operator redeploy can change. Tell the user the truth.
  6:  "This market is misconfigured — ping the maintainer (stake size out of range).",
  7:  "Not enough escrow locked.",
  8:  "Bet can't be zero.",
  9:  "Too many rides open right now — wait a few seconds.",
  10: "You already have a ride open — release first.",
  11: "Round is full — wait 5 seconds for the next round.",
  12: "Round still live — can't expire yet.",
  13: "Touched — release to claim your jackpot.",
  14: "Chart's waking up — try again.",
  15: "Market config invalid — contact support.",
  16: "Too early to abort — try again later.",
};

const RETRYABLE_PATTERNS = [
  /unavailable for consumption/i,
  /current version/i,
  /already locked by a different transaction/i,
  /not be re-?used/i,
  /Transaction needs to be rebuilt/i,
  /fetch failed/i,
  /ECONNRESET|ETIMEDOUT|ENOTFOUND/i,
  /socket hang up/i,
  /\b50[234]\s/,
  /transient/i,
  /timeout/i,
];

const FATAL_PATTERNS = [
  /MoveAbort/, // deterministic abort, will repro on retry
  /InsufficientGas|GasBalanceTooLow/,
  /Equivocated/,
  /PackageError/,
];

function isRetryableSuiError(err: Error | null | undefined): boolean {
  if (!err) return false;
  const m = err.message ?? "";
  if (FATAL_PATTERNS.some((p) => p.test(m))) return false;
  return RETRYABLE_PATTERNS.some((p) => p.test(m));
}

function humanizeChainError(rawMsg: string): string {
  if (!rawMsg) return "Something went wrong — tap again.";
  // MoveAbort path
  const abort = rawMsg.match(/abort code:\s*(\d+)\b/i);
  if (abort && abort[1]) {
    const code = Number(abort[1]);
    if (code in MOVE_ABORT_MESSAGES) return MOVE_ABORT_MESSAGES[code]!;
    return `Move error ${code} — tap and hold again.`;
  }
  if (/rejected as invalid by more than 1\/3 of validators/i.test(rawMsg)) {
    return "Network busy — tap and hold again.";
  }
  if (/insufficient|gas|balance|InsufficientGas/i.test(rawMsg)) {
    // v4.31b — generic message; could be SUI (gas) or the market's
    // collateral coin (TUSD). The Ride.tsx error toast surfaces an
    // inline faucet button so the user can drip both with one tap.
    return "Not enough funds — tap the faucet button to top up.";
  }
  if (/unavailable for consumption|current version|already locked/i.test(rawMsg)) {
    return "Network busy — tap and hold again.";
  }
  return "Something went wrong — tap and hold again.";
}
const DEFAULT_ROUND_DURATION_SEGMENTS = 75;

const DEFAULT_COLLATERAL = "0x2::sui::SUI";

export interface UseSegmentRideV4Config {
  market: SegmentMarketV4Record;
  keypair: Ed25519Keypair;
  client: SuiJsonRpcClient;
  /** Total escrow to lock — must cover stake_per_segment × round_duration. */
  escrowMist?: bigint;
  /** Per-segment stake in micro-USD; falls back to the market's min. */
  stakePerSegmentMicroUsd?: bigint;
  /** Called after a settle so the parent can refresh the burner balance. */
  onBalanceChanged?: () => void;
}

export interface UseSegmentRideV4Handle {
  /** Most recent round info (null until the first poll). */
  round: RoundInfo | null;
  /** Recent SegmentRecordedV4 events (chart hook expands these into candles). */
  segments: SegmentInput[];
  /** Live segment index (== last seen `k` + 1; matches market.next_segment_index). */
  nextSegmentIndex: bigint;
  /** Phase state machine. */
  phase: RidePhase;
  /**
   * Press handler — optimistic phase flip to "opening", tx in flight.
   * V4: NO barrierIndex argument. Touch either side wins the jackpot.
   */
  open: () => void;
  /** Release handler — optimistic phase flip to "closing", tx in flight. */
  close: () => void;
  /** Per-segment stake in micro-USD (live from the market). */
  stakePerSegmentMicroUsd: bigint;
  /** Touch payout multiplier in bps. */
  multiplierBps: number;
  /** Latest market snapshot — surfaced for the right-rail "barrier flow" UI. */
  marketSnapshot: SegmentMarketV4Snapshot | null;
  /**
   * Result of the most recent close, surfaced as a toast.
   *
   * `settlementSubKind === "rugged"` is set when the close lands on
   * settlement_kind=3 (EXPIRED_LOSS) for the same round_index that we
   * just observed a `RugFiredV4` event on — the underlying chain
   * semantics are identical (escrow forfeit), but the UI labels it as
   * "MARKET HALT" instead of "Round ended — no touch". See
   * docs/design/v2/26_rug_pull_house_edge_v4.md §5.1.
   */
  lastSettlement:
    | {
        kind: number;
        label: string;
        digest: string;
        settlementSubKind?: "rugged";
        /** v4.31d — chain-attested stake (raw micro-USD), from RideClosedV4. */
        stakePaidRaw?: bigint;
        /** v4.31d — chain-attested payout (raw micro-USD), from RideClosedV4. */
        payoutRaw?: bigint;
      }
    | null;
  /** Human-readable last error, or null. */
  lastError: string | null;
  /** Clear `lastError` (e.g. when the user dismisses an error banner). */
  clearLastError: () => void;
  /**
   * Wallclock ms (Date.now()) at which the most recent `RugFiredV4`
   * event was observed for this market, or null if none seen this
   * mount. Consumed by `useRideGestureV4` to trigger the MARKET HALT
   * visual FX. See doc 26 §5.2.
   */
  rugFiredAtMs: number | null;
  /** Fallback cranker — called by the chart hook on stall. */
  triggerStallCrank: () => void;
}

interface ObjectChange {
  type: string;
  objectType?: string;
  objectId?: string;
}

interface EventEnvelope {
  type?: string;
  parsedJson?: unknown;
}

/** Convert a micro-USD bigint to display USD. */
const toDisplayPrice = (microUsd: bigint): number =>
  Number(microUsd) / PRICE_SCALING;

/**
 * Convert a RoundStartedV4Event + market snapshot into a RoundInfo.
 * For v4 the `openWindowSegments` field is set equal to
 * `roundDurationSegments` — the chart hook treats "always in the open
 * window" as "the picker / opener is never gated."
 */
function roundFromV4Event(
  ev: RoundStartedV4Event,
  market: SegmentMarketV4Snapshot | null,
): RoundInfo {
  const dur = market
    ? Number(market.roundDurationSegments)
    : DEFAULT_ROUND_DURATION_SEGMENTS;
  return {
    index: ev.roundIndex,
    startedAtSegment: ev.startedAtSegment,
    upperBarrier: toDisplayPrice(ev.upperBarrier),
    lowerBarrier: toDisplayPrice(ev.lowerBarrier),
    spotAtRoll: toDisplayPrice(ev.spotAtRoll),
    roundDurationSegments: dur,
    // V4: "always open" — surface as openWindowSegments === roundDurationSegments
    // so the existing chart-hook gating treats every segment as in-window.
    openWindowSegments: dur,
  };
}

/** Convert a SegmentRecordedV4Event into the chart hook's SegmentInput. */
function segmentFromV4Event(ev: SegmentRecordedV4Event): SegmentInput {
  return {
    k: ev.k,
    key: ev.key,
    recordedAtMs: Number(ev.recordedAtMs),
  };
}

export function useSegmentRideV4(
  config: UseSegmentRideV4Config,
): UseSegmentRideV4Handle {
  const { market, keypair, client, onBalanceChanged } = config;

  const packageId = TESTNET_DEPLOYMENT.package_id ?? "";
  const botRegistryId = TESTNET_DEPLOYMENT.bot_registry ?? "";
  const priceOracleId = TESTNET_DEPLOYMENT.usd_price_oracle ?? "";
  const wickTokenStateId = TESTNET_DEPLOYMENT.wick_token_state ?? "";
  const wickStakingPoolId = TESTNET_DEPLOYMENT.wick_staking_pool ?? "";

  const sender = useMemo(() => keypair.toSuiAddress(), [keypair]);

  // ── Market snapshot (polled occasionally; rarely changes post-bootstrap)
  const [marketSnapshot, setMarketSnapshot] = useState<SegmentMarketV4Snapshot | null>(
    null,
  );
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const snap = await fetchSegmentMarketV4(client, market.market);
        if (cancelled) return;
        if (snap) setMarketSnapshot(snap);
      } catch (err) {
        console.warn("[useSegmentRideV4] fetchSegmentMarketV4:", err);
      }
    };
    void refresh();
    // 5s — most fields are static after bootstrap; the right-rail BarrierFlowV4
    // does its own faster poll for the live aggregate-stake bar.
    const id = window.setInterval(() => void refresh(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [client, market.market]);

  // ── Round + segment subscriptions ────────────────────────────────────
  const [round, setRound] = useState<RoundInfo | null>(null);
  const [segments, setSegments] = useState<SegmentInput[]>([]);
  const [nextSegmentIndex, setNextSegmentIndex] = useState<bigint>(0n);

  const lastSeenSegmentK = useRef<bigint>(-1n);
  const lastSeenRoundIndex = useRef<bigint>(-1n);

  const marketSnapshotRef = useRef<SegmentMarketV4Snapshot | null>(null);
  useEffect(() => {
    marketSnapshotRef.current = marketSnapshot;
  }, [marketSnapshot]);

  useEffect(() => {
    if (!packageId) return;
    let cancelled = false;
    let inFlight = false;
    const pollOnce = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        // ── SegmentRecordedV4 ─────────────────────────────────────────
        const segPage = await client.queryEvents({
          query: {
            MoveEventType: segmentRecordedV4EventType(packageId),
          },
          limit: 50,
          order: "descending",
        });
        if (cancelled) return;
        const segEvents: SegmentInput[] = [];
        let maxKSeen = lastSeenSegmentK.current;
        for (const ev of segPage.data) {
          const json = ev.parsedJson as Record<string, unknown> | undefined;
          if (!json) continue;
          const parsed = parseSegmentRecordedV4Event(json);
          if (parsed.marketId !== market.market) continue;
          segEvents.push(segmentFromV4Event(parsed));
          if (parsed.k > maxKSeen) maxKSeen = parsed.k;
        }
        if (segEvents.length > 0) {
          setSegments((prev) => {
            const seen = new Set(prev.map((s) => s.k.toString()));
            const merged = [...prev];
            for (const e of segEvents) {
              if (!seen.has(e.k.toString())) merged.push(e);
            }
            merged.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
            if (merged.length > MAX_SEGMENT_RING) {
              return merged.slice(merged.length - MAX_SEGMENT_RING);
            }
            return merged;
          });
          lastSeenSegmentK.current = maxKSeen;
          setNextSegmentIndex(maxKSeen + 1n);
        }

        // ── RoundStartedV4 ────────────────────────────────────────────
        const roundPage = await client.queryEvents({
          query: { MoveEventType: roundStartedV4EventType(packageId) },
          limit: 20,
          order: "descending",
        });
        if (cancelled) return;
        let bestRound: RoundStartedV4Event | null = null;
        for (const ev of roundPage.data) {
          const json = ev.parsedJson as Record<string, unknown> | undefined;
          if (!json) continue;
          const parsed = parseRoundStartedV4Event(json);
          if (parsed.marketId !== market.market) continue;
          if (!bestRound || parsed.roundIndex > bestRound.roundIndex) {
            bestRound = parsed;
          }
        }
        if (bestRound && bestRound.roundIndex !== lastSeenRoundIndex.current) {
          lastSeenRoundIndex.current = bestRound.roundIndex;
          setRound(roundFromV4Event(bestRound, marketSnapshotRef.current));
        } else if (!bestRound && marketSnapshotRef.current && lastSeenRoundIndex.current === -1n) {
          // P0 fix (2026-05-24): a freshly-bootstrapped market emits NO
          // RoundStartedV4 event for round 0 — that event only fires on
          // round TRANSITIONS, not the initial round set at bootstrap.
          // Without this fallback, the gesture stays armed-off (because
          // `round` is null) until segment 75 advances and round 1
          // transitions. On a brand-new market with no riders, that
          // never happens — chicken-and-egg.
          //
          // Synthesize a RoundInfo from the market snapshot's cached
          // fields. Same shape roundFromV4Event produces from a real
          // event. As soon as a real RoundStartedV4 lands, the branch
          // above takes over.
          const snap = marketSnapshotRef.current;
          const dur = Number(snap.roundDurationSegments);
          const synthetic: RoundInfo = {
            index: snap.cachedRoundIndex,
            startedAtSegment: snap.cachedRoundStartedAtSegment,
            upperBarrier: Number(snap.cachedUpperBarrier) / PRICE_SCALING,
            lowerBarrier: Number(snap.cachedLowerBarrier) / PRICE_SCALING,
            spotAtRoll:
              (Number(snap.cachedUpperBarrier) + Number(snap.cachedLowerBarrier)) /
              2 /
              PRICE_SCALING,
            roundDurationSegments: dur,
            openWindowSegments: dur,
          };
          lastSeenRoundIndex.current = snap.cachedRoundIndex;
          setRound(synthetic);
        }
      } catch (err) {
        console.warn("[useSegmentRideV4] poll:", err);
      } finally {
        inFlight = false;
      }
    };
    void pollOnce();
    const id = window.setInterval(() => void pollOnce(), EVENT_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [packageId, client, market.market]);

  // ── Phase + position state ───────────────────────────────────────────
  const [phase, setPhase] = useState<RidePhase>("idle");
  const [positionId, setPositionId] = useState<string | null>(null);
  const [lastSettlement, setLastSettlement] = useState<
    {
      kind: number;
      label: string;
      digest: string;
      settlementSubKind?: "rugged";
      /** v4.31d — chain-attested stake (raw micro-USD). */
      stakePaidRaw?: bigint;
      /** v4.31d — chain-attested payout (raw micro-USD). */
      payoutRaw?: bigint;
    } | null
  >(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const busyRef = useRef(false);
  const closeQueuedRef = useRef(false);
  // Ref-mirror of `positionId` so close() reads it synchronously without
  // waiting for React to rebuild the useCallback closure. Fixes the
  // 2026-05-23 stuck-money race: open() does setPositionId() then setPhase
  // ("riding"); the user releases on the next frame; close() reads the
  // STALE captured positionId=null from its closure and silently no-ops,
  // leaving the on-chain ride open until round expiry auto-settles it.
  const positionIdRef = useRef<string | null>(null);
  // P0 fix (agent #8): track mount state so post-unmount async resolvers
  // skip React state updates + don't fire a queued close after the
  // component went away.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ── Rug-fire subscription (doc 26 §5.1) ──────────────────────────────
  // Parallel to the segment-poll effect above. Mounts a streaming
  // subscriber on RugFiredV4 events for this market. On each fire we
  // stamp `rugFiredAtMs` (chart hook's MARKET HALT FX trigger) and
  // remember the round_index so a subsequent close on the SAME round
  // can be tagged as "rugged" rather than a plain expire-loss. Cleanup
  // unsubscribes on unmount and on market.market change, mirroring
  // SegmentRecordedV4's poll-effect cleanup.
  const [rugFiredAtMs, setRugFiredAtMs] = useState<number | null>(null);
  const [lastRugRoundIndex, setLastRugRoundIndex] = useState<bigint | null>(
    null,
  );
  // Ref-mirror so the close handler (below) reads the latest round
  // index synchronously without re-building its useCallback closure.
  // Same pattern as positionIdRef.
  const lastRugRoundIndexRef = useRef<bigint | null>(null);
  useEffect(() => {
    lastRugRoundIndexRef.current = lastRugRoundIndex;
  }, [lastRugRoundIndex]);
  useEffect(() => {
    if (!packageId) return;
    const unsubscribe = subscribeRugFiredV4(
      client,
      market.market,
      packageId,
      (event: RugFiredV4Event) => {
        if (!mountedRef.current) return;
        setRugFiredAtMs(Date.now());
        setLastRugRoundIndex(event.roundIndex);
      },
    );
    return () => {
      unsubscribe();
    };
  }, [packageId, client, market.market]);

  // P0 fix (agent #2 + #10): on mount + on tab-return, sweep for orphan
  // ride positions owned by this session wallet. If the user reloaded mid-
  // ride or iOS dropped the touchend, the on-chain SegmentRidePositionV4
  // still exists. Adopt it so the CASH OUT button can close it.
  useEffect(() => {
    if (!packageId) return;
    const sweep = async () => {
      try {
        const owned = await client.getOwnedObjects({
          owner: sender,
          filter: {
            StructType: `${packageId}::segment_market_v4::SegmentRidePositionV4`,
          },
          // 2026-05-24: ask for content so we can check the `closed` flag.
          // Without this we'd adopt already-closed rides as if they were
          // open and every CASH OUT would hit EAlreadyClosed (abort 1).
          options: { showContent: true },
        });
        // Find the first ride that's still OPEN (not yet settled). The
        // SegmentRidePositionV4 has a `closed: bool` field; if true the
        // on-chain ride has already been settled by another caller (the
        // cranker, crank_expired, or the user themselves in another tab).
        const liveOrphan = owned.data?.find((o) => {
          const fields =
            (o.data?.content as { fields?: { closed?: boolean } } | undefined)
              ?.fields;
          return fields?.closed === false;
        })?.data?.objectId;
        if (liveOrphan && !positionIdRef.current && mountedRef.current) {
          positionIdRef.current = liveOrphan;
          setPositionId(liveOrphan);
          setPhase("riding");
          setLastError(
            "You had a ride open from before — tap CASH OUT to close it.",
          );
        }
      } catch (err) {
        console.warn("[useSegmentRideV4] orphan sweep:", (err as Error).message?.slice(0, 120));
      }
    };
    void sweep();
    const onVis = () => {
      if (document.visibilityState === "visible") void sweep();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [packageId, client, sender]);

  // ── Derived market parameters ────────────────────────────────────────
  const stakePerSegmentMicroUsd: bigint =
    config.stakePerSegmentMicroUsd ??
    (marketSnapshot
      ? marketSnapshot.minStakePerSegment
      : BigInt(DEFAULT_STAKE_PER_SEGMENT_MICROUSD));
  const multiplierBps = marketSnapshot
    ? Number(marketSnapshot.multiplierBps)
    : DEFAULT_MULTIPLIER_BPS;
  const roundDurationSegments = marketSnapshot
    ? marketSnapshot.roundDurationSegments
    : BigInt(DEFAULT_ROUND_DURATION_SEGMENTS);

  // Default escrow = stake_per_segment × round_duration + 10% buffer.
  const escrowMist =
    config.escrowMist ??
    (stakePerSegmentMicroUsd * roundDurationSegments * 11n) / 10n;

  // ── close declared first; open's queued-close calls it ───────────────
  const closeRef = useRef<() => void>(() => {});

  /**
   * V4 open — NO barrier_index. Touch either side wins. No open-window
   * gate either — every segment is open.
   */
  const open = useCallback(() => {
    // P0 fix (agent #10): read positionIdRef.current, not positionId state.
    // The captured `positionId` in this closure can lag behind a recent
    // setPositionId(null) by one render — meaning a second tap right after
    // a settlement silently no-ops while the closure still sees the
    // just-closed ride's id. Reading the ref is always live.
    if (busyRef.current || positionIdRef.current) return;
    if (!packageId || !market.vault || !botRegistryId) {
      setLastError("Segment market deployment incomplete.");
      return;
    }
    busyRef.current = true;
    closeQueuedRef.current = false;
    setLastError(null);
    setLastSettlement(null);
    // v4.21 — FULLY OPTIMISTIC. Skip the "opening" phase entirely. The
    // chart's hero flips straight to "riding" the instant the user taps,
    // matching the "instant tap to start position" hard requirement.
    // Background: open tx fires, eventually the positionId arrives. If
    // the tx fails, setPhase("idle") in the catch path below + surface
    // the error. User feels zero latency.
    setPhase("riding");

    void (async () => {
      // P0 fix (agent #3): wrap the entire IIFE in try/finally so a thrown
      // exception (anywhere — not just inside the retry catch) can never
      // leave busyRef stuck at `true` and lock the user out permanently.
      let lastErr: Error | null = null;
      try {
        // Backoff: 600ms + 400ms jitter per attempt. Sized to cranker's
        // ~1.2s cycle (agent #6) so each retry hits a different cranker
        // phase instead of herding inside the same in-flight tx.
        const MAX_ATTEMPTS = 6;
        let attempt = 0;
        // v4.24 — when collateral is non-SUI (e.g. TUSD), the open tx must
        // split the escrow from a user-owned coin of that type, not from
        // gas (which is always Coin<SUI>). Fetch the largest such coin.
        // For SUI markets, leave escrowSourceCoinId undefined so the
        // builder splits from gas as before.
        const collateral = market.collateral || DEFAULT_COLLATERAL;
        let escrowSourceCoinId: string | undefined = undefined;
        let additionalCoinIds: string[] = [];
        if (collateral !== "0x2::sui::SUI") {
          try {
            const coins = await client.getCoins({
              owner: sender,
              coinType: collateral,
            });
            // v4.31c — pick the largest as the merge target, pass the
            // rest as extras. The PTB merges them all before splitting
            // escrow. This fixes "I have 39 TUSD but it says 6.7" —
            // 39 was the total across 5 small drip coins; 6.7 was the
            // largest single coin (the old behaviour required ONE
            // coin to be big enough). Now we sum across all coins.
            const sorted = (coins.data ?? [])
              .map((c) => ({ id: c.coinObjectId, bal: BigInt(c.balance) }))
              .sort((a, b) => (b.bal > a.bal ? 1 : b.bal < a.bal ? -1 : 0));
            const total = sorted.reduce((acc, c) => acc + c.bal, 0n);
            if (total < escrowMist) {
              const tusdNeeded = (Number(escrowMist) / 1_000_000).toFixed(2);
              const tusdHave = (Number(total) / 1_000_000).toFixed(2);
              setPhase("idle");
              setLastError(
                `Not enough TUSD — need ${tusdNeeded}, have ${tusdHave}. Tap Drip to top up.`,
              );
              busyRef.current = false;
              return;
            }
            const primary = sorted[0];
            if (!primary) {
              setPhase("idle");
              setLastError("No TUSD coins found — tap Drip to fund.");
              busyRef.current = false;
              return;
            }
            escrowSourceCoinId = primary.id;
            additionalCoinIds = sorted.slice(1).map((c) => c.id);
          } catch (err) {
            console.warn("[useSegmentRideV4] getCoins failed:", err);
            setPhase("idle");
            setLastError("Couldn't read your TUSD balance — try again.");
            busyRef.current = false;
            return;
          }
        }
        while (attempt < MAX_ATTEMPTS) {
          attempt += 1;
          try {
            const tx = buildOpenSegmentRideV4Tx({
              packageId,
              collateralType: collateral,
              sender,
              marketId: market.market,
              vaultId: market.vault,
              botRegistryId,
              stakePerSegment: stakePerSegmentMicroUsd,
              escrowMist,
              escrowSourceCoinId,
              additionalCoinIds,
            });
            const res = await client.signAndExecuteTransaction({
              signer: keypair,
              transaction: tx,
              options: { showObjectChanges: true, showEffects: true },
            });
            const created = (res.objectChanges as ObjectChange[] | undefined)?.find(
              (c) =>
                c.type === "created" &&
                typeof c.objectType === "string" &&
                c.objectType.includes("::segment_market_v4::SegmentRidePositionV4"),
            );
            if (!created?.objectId) {
              throw new Error("SegmentRidePositionV4 not found in tx result");
            }
            positionIdRef.current = created.objectId;
            setPositionId(created.objectId);
            // Phase is ALREADY "riding" from the optimistic flip above.
            // Don't re-set it (no-op anyway, but explicit).
            onBalanceChanged?.();
            return;
          } catch (err) {
            lastErr = err as Error;
            if (attempt < MAX_ATTEMPTS && isRetryableSuiError(lastErr)) {
              const backoff = 600 + Math.floor(Math.random() * 400);
              await new Promise((r) => setTimeout(r, backoff));
              continue;
            }
            break;
          }
        }
        // All attempts exhausted — set idle + humanized error.
        setPhase("idle");
        const msg = lastErr?.message ?? "open failed";
        setLastError(humanizeChainError(msg));
        console.warn("[useSegmentRideV4] open failed after retries:", msg.slice(0, 200));
      } finally {
        // P0: always clear busyRef + drain any queued close, even on
        // throws above. The mounted-ref check skips the drain if the
        // component unmounted mid-flight.
        busyRef.current = false;
        if (closeQueuedRef.current) {
          closeQueuedRef.current = false;
          if (mountedRef.current && positionIdRef.current) {
            closeRef.current();
          }
        }
      }
    })();
  }, [
    positionId,
    packageId,
    market.market,
    market.vault,
    market.collateral,
    botRegistryId,
    sender,
    keypair,
    client,
    stakePerSegmentMicroUsd,
    escrowMist,
    onBalanceChanged,
  ]);

  const close = useCallback(() => {
    // v4.21 — FULLY OPTIMISTIC. Flip phase to "idle" the instant the
    // user releases, matching the "instant close position on let go"
    // hard requirement. The chain tx fires in the background; if it
    // succeeds, setLastSettlement renders the win/loss toast a beat
    // later. If it fails, the user has already moved on visually; we
    // surface the error in the toast slot without re-blocking them.
    const livePositionId = positionIdRef.current;
    if (phase === "riding" && !livePositionId) {
      // Released before the open tx confirmed — queue the close so the
      // open handler can drain it once positionId lands. UI stays idle.
      setPhase("idle");
      closeQueuedRef.current = true;
      return;
    }
    if (!livePositionId) {
      if (busyRef.current) closeQueuedRef.current = true;
      setPhase("idle");
      return;
    }
    if (busyRef.current) {
      closeQueuedRef.current = true;
      setPhase("idle");
      return;
    }
    busyRef.current = true;
    // OPTIMISTIC: phase=idle immediately, not "closing".
    setPhase("idle");

    void (async () => {
      // 2026-05-24 — retry on shared-object version conflicts. The
      // SegmentMarketV4 shared object is also being mutated by the cranker
      // (~1 tx/sec). If our build-and-submit lands between the cranker's
      // version-fetch and consensus, we hit "unavailable for consumption /
      // current version: …" or "already locked by a different transaction".
      // Build a fresh tx each attempt — buildCloseSegmentRideV4Tx returns
      // a Transaction object the SDK will re-resolve shared-object refs on.
      // P0 fix (agent #3): try/finally so busyRef always clears, even on
      // thrown exceptions outside the retry catch.
      let lastErr: Error | null = null;
      try {
        // v4.31i — fire a record_segment tx BEFORE close as a SEPARATE
        // transaction. Sui's PTB-Random rule forbids commands after a
        // record_segment in the same PTB (v4.31e tried that and got
        // "Commands following a command with Random can only be
        // TransferObjects or MergeCoins"). Two txes is the workaround:
        // tx1 = crank (advances next_segment_index by 1, scans for touch
        // along the way), tx2 = close (sees segments_held >= 1, returns
        // real stake_paid + payout).
        //
        // Why we need this even with the sentinel cranker running: the
        // sentinel runs every ~4 seconds. If the user releases within
        // that window, `next_segment_index` may still equal their
        // `entry_segment_index` → settlement returns the dreaded
        // stake=$0/payout=$0/kind=CASHOUT (full escrow refund, but no
        // actual play registered, and any touch the user's chart showed
        // was undetectable to the chain because no segments existed to
        // scan).
        //
        // Best-effort: if the crank fails (ENoActiveRides if we beat the
        // open's confirmation, network blip, etc.) we still try the
        // close. The user pays gas for one extra tx (~0.005 SUI).
        try {
          const crankTx = buildRecordSegmentV4Tx({
            packageId,
            collateralType: market.collateral || DEFAULT_COLLATERAL,
            sender,
            marketId: market.market,
          });
          await client.signAndExecuteTransaction({
            signer: keypair,
            transaction: crankTx,
            options: { showEffects: false },
          });
        } catch (err) {
          console.debug(
            "[useSegmentRideV4] pre-close crank skipped:",
            (err as Error).message?.slice(0, 100),
          );
        }
        const MAX_ATTEMPTS = 6;
        let attempt = 0;
        while (attempt < MAX_ATTEMPTS) {
          attempt += 1;
          try {
            const tx = buildCloseSegmentRideV4Tx({
              packageId,
              collateralType: market.collateral || DEFAULT_COLLATERAL,
              sender,
              rideId: livePositionId,
              marketId: market.market,
              vaultId: market.vault,
              priceOracleId,
              tokenStateId: wickTokenStateId,
              stakingPoolId: wickStakingPoolId,
            });
            const res = await client.signAndExecuteTransaction({
              signer: keypair,
              transaction: tx,
              options: { showEvents: true, showEffects: true },
            });
            const ev = (res.events as EventEnvelope[] | undefined)?.find((e) =>
              (e.type ?? "").includes("::segment_market_v4::RideClosedV4"),
            );
            let kind = -1;
            let closedRoundIndex: bigint | null = null;
            let stakePaidRaw: bigint | undefined;
            let payoutRaw: bigint | undefined;
            if (ev?.parsedJson && typeof ev.parsedJson === "object") {
              const f = ev.parsedJson as {
                settlement_kind?: number | string;
                round_index?: number | string;
                stake_paid?: number | string;
                payout?: number | string;
              };
              if (f.settlement_kind !== undefined) kind = Number(f.settlement_kind);
              if (f.round_index !== undefined) {
                try {
                  closedRoundIndex = BigInt(f.round_index as string | number);
                } catch {
                  closedRoundIndex = null;
                }
              }
              // v4.31d — extract chain-attested settlement amounts so
              // the toast can show "+$2.18 net" instead of just "TOUCH
              // WIN" with no dollar reconcile to the wallet delta.
              if (f.stake_paid !== undefined) {
                try { stakePaidRaw = BigInt(f.stake_paid as string | number); } catch {}
              }
              if (f.payout !== undefined) {
                try { payoutRaw = BigInt(f.payout as string | number); } catch {}
              }
            }
            const labelKey = kind as 0 | 1 | 2 | 3 | 4;
            const label =
              kind >= 0 && labelKey in SETTLEMENT_NAME_V4
                ? SETTLEMENT_NAME_V4[labelKey]
                : "settled";
            // doc 26 §5.1 — a settlement_kind=3 (EXPIRED_LOSS) close
            // whose round_index matches the round_index of the last
            // RugFiredV4 we saw is semantically a rug-loss, not a
            // time-expiry loss. Same chain semantics (escrow forfeit),
            // different toast copy ("MARKET HALT" vs "Round ended").
            const settlementSubKind: "rugged" | undefined =
              kind === 3 &&
              closedRoundIndex !== null &&
              lastRugRoundIndexRef.current !== null &&
              closedRoundIndex === lastRugRoundIndexRef.current
                ? "rugged"
                : undefined;
            setLastSettlement({
              kind,
              label,
              digest: res.digest,
              ...(settlementSubKind ? { settlementSubKind } : {}),
              ...(stakePaidRaw !== undefined ? { stakePaidRaw } : {}),
              ...(payoutRaw !== undefined ? { payoutRaw } : {}),
            });
            setLastError(null);
            positionIdRef.current = null;
            setPositionId(null);
            // Phase already "idle" from the optimistic flip above.
            onBalanceChanged?.();
            return;
          } catch (err) {
            lastErr = err as Error;
            // EAlreadyClosed (Move abort 1) means another caller already
            // settled this ride (e.g., crank_expired). Treat as success —
            // we don't have the settlement event, but the position is gone.
            // Sui's actual error format is: "abort code: 1, in '0x...::module::fn' (instruction N)"
            // The old regex /MoveAbort[\s\S]*?,\s*(\d+)\s*\)/ matched the
            // INSTRUCTION number (before the close paren), not the abort
            // code — so EAlreadyClosed was never recognized and the
            // close loop kept retrying 6 times on already-settled rides.
            if (lastErr.message && /abort code:\s*1\b/i.test(lastErr.message)) {
              setLastSettlement({ kind: -1, label: "already settled", digest: "" });
              setLastError(null);
              positionIdRef.current = null;
              setPositionId(null);
              // Phase already "idle".
              onBalanceChanged?.();
              return;
            }
            if (attempt < MAX_ATTEMPTS && isRetryableSuiError(lastErr)) {
              const backoff = 600 + Math.floor(Math.random() * 400);
              await new Promise((r) => setTimeout(r, backoff));
              continue;
            }
            break;
          }
        }
        // All attempts exhausted — the user already saw an instant
        // "released" so don't bounce them back to riding (would be
        // jarring). Surface the error in the toast. The ride is still
        // open on chain — they can refresh and the orphan-sweep will
        // pick it up.
        const msg = lastErr?.message ?? "cash-out failed";
        setLastError(humanizeChainError(msg));
        console.warn("[useSegmentRideV4] close failed after retries:", msg.slice(0, 200));
      } finally {
        busyRef.current = false;
      }
    })();
  }, [
    phase,
    positionId,
    packageId,
    market.market,
    market.vault,
    market.collateral,
    sender,
    priceOracleId,
    wickTokenStateId,
    wickStakingPoolId,
    keypair,
    client,
    onBalanceChanged,
  ]);

  useEffect(() => {
    closeRef.current = close;
  }, [close]);

  // ── D4 fallback cranker ──────────────────────────────────────────────
  const lastCrankAtMsRef = useRef(0);
  // 2026-05-24: when RPC starts rate-limiting (429s), the chart's stall
  // detector fires every 1.5s, each call hits 429, the user's session
  // wallet burns gas on no-ops, and the console fills with red. Track a
  // "give-up window": after 3 consecutive failed cranks, back off to a
  // 30s cooldown so the chart will look frozen but the user's wallet
  // stops bleeding gas and the RPC ban can decay.
  const consecutiveCrankErrsRef = useRef(0);
  const crankCooldownUntilMsRef = useRef(0);
  const triggerStallCrank = useCallback(() => {
    const now = Date.now();
    if (now < crankCooldownUntilMsRef.current) return; // long cooldown
    if (now - lastCrankAtMsRef.current < 1500) return; // standard rate limit
    // v4.25c — gate on positionIdRef, not just phase. The optimistic UI
    // (v4.21) flips phase to 'riding' the instant the user taps, BEFORE
    // the open tx confirms. During that window positionIdRef is still
    // null = no on-chain ride exists. Firing record_segment then hits
    // EChartDormant / ENoActiveRides (abort 14) and spams the console.
    // Now we only fire when there's a confirmed on-chain position.
    if (!positionIdRef.current) return;
    if (phase !== "opening" && phase !== "riding") return;
    lastCrankAtMsRef.current = now;
    void (async () => {
      try {
        const tx = buildRecordSegmentV4Tx({
          packageId,
          collateralType: market.collateral || DEFAULT_COLLATERAL,
          sender,
          marketId: market.market,
        });
        await client.signAndExecuteTransaction({
          signer: keypair,
          transaction: tx,
          options: { showEffects: false },
        });
        consecutiveCrankErrsRef.current = 0;
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (/429|Too Many Requests|Failed to fetch|rate.?limit/i.test(msg)) {
          // RPC is throttling us — apply a 30s cooldown.
          crankCooldownUntilMsRef.current = Date.now() + 30_000;
          consecutiveCrankErrsRef.current = 0;
          return; // don't log; we know what this is
        }
        consecutiveCrankErrsRef.current += 1;
        if (consecutiveCrankErrsRef.current >= 3) {
          crankCooldownUntilMsRef.current = Date.now() + 30_000;
          consecutiveCrankErrsRef.current = 0;
        }
        if (!/already|next|first-write/i.test(msg)) {
          console.warn("[useSegmentRideV4] cranker:", err);
        }
      }
    })();
  }, [phase, client, keypair, market.market, market.collateral, packageId, sender]);

  return {
    round,
    segments,
    nextSegmentIndex,
    phase,
    open,
    close,
    stakePerSegmentMicroUsd,
    multiplierBps,
    marketSnapshot,
    lastSettlement,
    lastError,
    // v4.31c — let callers clear the error (e.g. after the inline
    // Drip button funds the wallet; otherwise the toast keeps saying
    // "Not enough TUSD" even after balance updates).
    clearLastError: () => setLastError(null),
    rugFiredAtMs,
    triggerStallCrank,
  };
}
