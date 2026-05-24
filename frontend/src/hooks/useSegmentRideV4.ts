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
  type RoundStartedV4Event,
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
const DEFAULT_STAKE_PER_SEGMENT_MICROUSD = 200_000n; // $0.20/segment
const DEFAULT_MULTIPLIER_BPS = 17_500; // 1.75× (B7 calibration)
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
  /** Result of the most recent close, surfaced as a toast. */
  lastSettlement: { kind: number; label: string; digest: string } | null;
  /** Human-readable last error, or null. */
  lastError: string | null;
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
    { kind: number; label: string; digest: string } | null
  >(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const busyRef = useRef(false);
  const closeQueuedRef = useRef(false);

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
    if (busyRef.current || positionId) return;
    if (!packageId || !market.vault || !botRegistryId) {
      setLastError("Segment market deployment incomplete.");
      return;
    }
    busyRef.current = true;
    closeQueuedRef.current = false;
    setLastError(null);
    setLastSettlement(null);
    // OPTIMISTIC: flip phase immediately so the chart shows "starting…".
    setPhase("opening");

    void (async () => {
      try {
        const tx = buildOpenSegmentRideV4Tx({
          packageId,
          collateralType: market.collateral || DEFAULT_COLLATERAL,
          sender,
          marketId: market.market,
          vaultId: market.vault,
          botRegistryId,
          stakePerSegment: stakePerSegmentMicroUsd,
          escrowMist,
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
        setPositionId(created.objectId);
        setPhase("riding");
        onBalanceChanged?.();
        busyRef.current = false;
        if (closeQueuedRef.current) {
          closeQueuedRef.current = false;
          closeRef.current();
        }
      } catch (err) {
        busyRef.current = false;
        closeQueuedRef.current = false;
        setPhase("idle");
        const msg = (err as Error).message ?? "open failed";
        setLastError(
          /insufficient|gas|balance|InsufficientGas/i.test(msg)
            ? "Not enough test SUI — tap Get test SUI."
            : msg,
        );
        console.warn("[useSegmentRideV4] open:", err);
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
    if (phase === "opening" && !positionId) {
      // Released before the open tx confirmed — queue the close.
      closeQueuedRef.current = true;
      return;
    }
    if (!positionId) return;
    if (busyRef.current) return;
    busyRef.current = true;
    setPhase("closing");

    void (async () => {
      try {
        const tx = buildCloseSegmentRideV4Tx({
          packageId,
          collateralType: market.collateral || DEFAULT_COLLATERAL,
          sender,
          rideId: positionId,
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
        if (ev?.parsedJson && typeof ev.parsedJson === "object") {
          const f = ev.parsedJson as { settlement_kind?: number | string };
          if (f.settlement_kind !== undefined) kind = Number(f.settlement_kind);
        }
        const labelKey = kind as 0 | 1 | 2 | 3 | 4;
        const label =
          kind >= 0 && labelKey in SETTLEMENT_NAME_V4
            ? SETTLEMENT_NAME_V4[labelKey]
            : "settled";
        setLastSettlement({ kind, label, digest: res.digest });
        setPositionId(null);
        setPhase("idle");
        onBalanceChanged?.();
        busyRef.current = false;
      } catch (err) {
        busyRef.current = false;
        // Close failed — stay in "riding" so the user can release again.
        setPhase("riding");
        const msg = (err as Error).message ?? "cash-out failed";
        setLastError(msg);
        console.warn("[useSegmentRideV4] close:", err);
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
  const triggerStallCrank = useCallback(() => {
    const now = Date.now();
    if (now - lastCrankAtMsRef.current < 1500) return;
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
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (!/already|next|first-write/i.test(msg)) {
          console.warn("[useSegmentRideV4] cranker:", err);
        }
      }
    })();
  }, [client, keypair, market.market, market.collateral, packageId, sender]);

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
    triggerStallCrank,
  };
}
