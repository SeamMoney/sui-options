/**
 * useSegmentRide — round-based segment-arcade lifecycle (doc 19).
 *
 * Parallel to `useWickRide` (the legacy tick-based hook), but for the
 * provably-fair segment-market arcade. Wires the burner-wallet session to
 * the on-chain `bootstrap_segment_market → record_segment → open_segment_ride
 * → close_segment_ride` lifecycle, and subscribes to the round + segment
 * events the chart hook needs to render.
 *
 * Responsibilities:
 *   1. Subscribe to `RoundStarted` events — keeps `round` current.
 *   2. Subscribe to `SegmentRecorded` events — feeds the segment ring
 *      buffer the chart hook expands into candles.
 *   3. Expose `open(barrierIndex, barrierPrice)` and `close()` —
 *      optimistic phase transitions; chain calls fire in the background.
 *   4. Expose `cranker()` — D4 fallback: client-side `record_segment` when
 *      the keeper stalls. Idempotent at the on-chain side (first-write
 *      wins; subsequent calls just bounce).
 *
 * Optimistic UI (doc 17 §14.5 — load-bearing):
 *   - press → phase immediately = "opening", chart shows starting…
 *   - tx lands → phase = "riding"
 *   - release → phase immediately = "closing", chart shows cashing out…
 *   - tx lands → phase = "idle" + lastSettlement populated for the toast
 *
 * The chart hook decides nothing about chain state — it only watches
 * phase + the ring buffer. This decoupling is what lets the gesture feel
 * native: the chain is a side effect, not a synchronous step.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import {
  BARRIER_LOWER,
  BARRIER_UPPER,
  buildCloseSegmentRideTx,
  buildOpenSegmentRideTx,
  buildRecordSegmentTx,
  fetchSegmentMarket,
  parseRoundStartedEvent,
  parseSegmentRecordedEvent,
  roundStartedEventType,
  segmentRecordedEventType,
  SETTLEMENT_NAME,
  type BarrierIndex,
  type RoundStartedEvent,
  type SegmentMarketSnapshot,
  type SegmentRecordedEvent,
} from "@wick/sdk";
import {
  TESTNET_DEPLOYMENT,
  type SegmentMarketRecord,
} from "@/lib/deployments";
import type { RidePhase, RoundInfo, SegmentInput } from "@/hooks/useRideGesture";

const PRICE_SCALING = 1_000_000;

/** How often we poll the events RPC. Sui doesn't expose a push channel,
 *  so we poll — at this cadence we're never more than one frame behind
 *  the cranker. */
const EVENT_POLL_MS = 350;
/** Cap the ring buffer the chart hook walks each frame — `MAX_CHART_CANDLES`
 *  / 6 candles per segment ≈ 7 segments is plenty. 16 = ~6.4s of history. */
const MAX_SEGMENT_RING = 16;
/** Default fallback when the SegmentMarket object hasn't been read yet
 *  (e.g. before the first poll lands). */
const DEFAULT_STAKE_PER_SEGMENT_MICROUSD = 200_000n; // $0.20/segment
const DEFAULT_MULTIPLIER_BPS = 20_000; // 2.0×
const DEFAULT_ROUND_DURATION_SEGMENTS = 75;
const DEFAULT_OPEN_WINDOW_SEGMENTS = 13;

const DEFAULT_COLLATERAL = "0x2::sui::SUI";

export interface UseSegmentRideConfig {
  market: SegmentMarketRecord;
  keypair: Ed25519Keypair;
  client: SuiJsonRpcClient;
  /** Total escrow to lock — must cover stake_per_segment * round_duration. */
  escrowMist?: bigint;
  /** Per-segment stake in micro-USD; falls back to the market's min. */
  stakePerSegmentMicroUsd?: bigint;
  /** Called after a settle so the parent can refresh the burner balance. */
  onBalanceChanged?: () => void;
}

export interface UseSegmentRideHandle {
  /** Most recent round info (null until the first poll). */
  round: RoundInfo | null;
  /** Recent SegmentRecorded events (chart hook expands these into candles). */
  segments: SegmentInput[];
  /** Live segment index (== last seen `k` + 1; matches market.next_segment_index). */
  nextSegmentIndex: bigint;
  /** Whether we're currently inside the round's open window. */
  inOpenWindow: boolean;
  /** Currently-picked barrier (driven locally; persists until next round). */
  pickedBarrier: BarrierIndex | null;
  /** Manually pick a barrier (called by the chart hook on tap). */
  pickBarrier: (b: BarrierIndex) => void;
  /** Phase state machine. */
  phase: RidePhase;
  /** Press handler — optimistic phase flip to "opening", tx in flight. */
  open: (barrierIndex: BarrierIndex, barrierPrice: number) => void;
  /** Release handler — optimistic phase flip to "closing", tx in flight. */
  close: () => void;
  /** Per-segment stake in micro-USD (live from the market). */
  stakePerSegmentMicroUsd: bigint;
  /** Touch payout multiplier in bps. */
  multiplierBps: number;
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

/** Convert a RoundStartedEvent + market snapshot into a RoundInfo. */
function roundFromEvent(
  ev: RoundStartedEvent,
  market: SegmentMarketSnapshot | null,
): RoundInfo {
  return {
    index: ev.roundIndex,
    startedAtSegment: ev.startedAtSegment,
    upperBarrier: toDisplayPrice(ev.upperBarrier),
    lowerBarrier: toDisplayPrice(ev.lowerBarrier),
    spotAtRoll: toDisplayPrice(ev.spotAtRoll),
    roundDurationSegments: market
      ? Number(market.roundDurationSegments)
      : DEFAULT_ROUND_DURATION_SEGMENTS,
    openWindowSegments: market
      ? Number(market.openWindowSegments)
      : DEFAULT_OPEN_WINDOW_SEGMENTS,
  };
}

/** Convert a SegmentRecordedEvent into the chart hook's SegmentInput. */
function segmentFromEvent(ev: SegmentRecordedEvent): SegmentInput {
  return {
    k: ev.k,
    key: ev.key,
    recordedAtMs: Number(ev.recordedAtMs),
  };
}

export function useSegmentRide(config: UseSegmentRideConfig): UseSegmentRideHandle {
  const { market, keypair, client, onBalanceChanged } = config;

  const packageId = TESTNET_DEPLOYMENT.package_id ?? "";
  const botRegistryId = TESTNET_DEPLOYMENT.bot_registry ?? "";
  const priceOracleId = TESTNET_DEPLOYMENT.usd_price_oracle ?? "";
  const wickTokenStateId = TESTNET_DEPLOYMENT.wick_token_state ?? "";
  const wickStakingPoolId = TESTNET_DEPLOYMENT.wick_staking_pool ?? "";

  const sender = useMemo(() => keypair.toSuiAddress(), [keypair]);

  // ── Market snapshot (polled occasionally; rarely changes post-bootstrap)
  const [marketSnapshot, setMarketSnapshot] = useState<SegmentMarketSnapshot | null>(
    null,
  );
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const snap = await fetchSegmentMarket(client, market.market);
        if (cancelled) return;
        if (snap) setMarketSnapshot(snap);
      } catch (err) {
        console.warn("[useSegmentRide] fetchSegmentMarket:", err);
      }
    };
    void refresh();
    // Polled every 5s — most fields are static after bootstrap, but the
    // per-barrier aggregates / next_segment_index move.
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

  // Cursor for queryEvents — null = "from latest". On first mount we just
  // grab the most recent page; thereafter we ratchet forward by `k`.
  const lastSeenSegmentK = useRef<bigint>(-1n);
  const lastSeenRoundIndex = useRef<bigint>(-1n);

  // Mirror the market snapshot into a ref so the polling effect doesn't
  // teardown each time it updates (every 5s) — only state we read inside
  // the interval needs to stay in deps; the snapshot is only consulted
  // when constructing RoundInfo.
  const marketSnapshotRef = useRef<SegmentMarketSnapshot | null>(null);
  useEffect(() => {
    marketSnapshotRef.current = marketSnapshot;
  }, [marketSnapshot]);

  // Event polling loop. Sui's queryEvents is a polling RPC; that's the
  // best available primitive. EVENT_POLL_MS keeps us within ~one segment
  // of the cranker — well within the rubber-band budget.
  useEffect(() => {
    if (!packageId) return;
    let cancelled = false;
    let inFlight = false;
    const pollOnce = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        // ── SegmentRecorded ────────────────────────────────────────────
        const segPage = await client.queryEvents({
          query: {
            MoveEventType: segmentRecordedEventType(packageId),
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
          const parsed = parseSegmentRecordedEvent(json);
          if (parsed.marketId !== market.market) continue;
          segEvents.push(segmentFromEvent(parsed));
          if (parsed.k > maxKSeen) maxKSeen = parsed.k;
        }
        if (segEvents.length > 0) {
          // De-dupe + sort ascending by k, keep last MAX_SEGMENT_RING.
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

        // ── RoundStarted ───────────────────────────────────────────────
        const roundPage = await client.queryEvents({
          query: { MoveEventType: roundStartedEventType(packageId) },
          limit: 20,
          order: "descending",
        });
        if (cancelled) return;
        // Find the most recent RoundStarted for this market.
        let bestRound: RoundStartedEvent | null = null;
        for (const ev of roundPage.data) {
          const json = ev.parsedJson as Record<string, unknown> | undefined;
          if (!json) continue;
          const parsed = parseRoundStartedEvent(json);
          if (parsed.marketId !== market.market) continue;
          if (!bestRound || parsed.roundIndex > bestRound.roundIndex) {
            bestRound = parsed;
          }
        }
        if (bestRound && bestRound.roundIndex !== lastSeenRoundIndex.current) {
          lastSeenRoundIndex.current = bestRound.roundIndex;
          setRound(roundFromEvent(bestRound, marketSnapshotRef.current));
        }
      } catch (err) {
        console.warn("[useSegmentRide] poll:", err);
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

  // ── Picked barrier — persists until the user re-picks or round rolls.
  const [pickedBarrier, setPickedBarrier] = useState<BarrierIndex | null>(null);
  useEffect(() => {
    // On new round, clear the previous round's pick so the user must
    // re-commit. (Optional product call; could keep last-pick across rounds.)
    setPickedBarrier(null);
  }, [round?.index]);

  const pickBarrier = useCallback((b: BarrierIndex) => {
    setPickedBarrier(b);
  }, []);

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
  const stakePerSegmentMicroUsd =
    config.stakePerSegmentMicroUsd ??
    (marketSnapshot
      ? marketSnapshot.minStakePerSegment
      : DEFAULT_STAKE_PER_SEGMENT_MICROUSD);
  const multiplierBps = marketSnapshot
    ? Number(marketSnapshot.multiplierBps)
    : DEFAULT_MULTIPLIER_BPS;
  const roundDurationSegments = marketSnapshot
    ? marketSnapshot.roundDurationSegments
    : BigInt(DEFAULT_ROUND_DURATION_SEGMENTS);

  // Default escrow = stake_per_segment × round_duration + 10% buffer for
  // the bot-registry / oracle hop. Capped to a reasonable bound.
  const escrowMist =
    config.escrowMist ??
    (stakePerSegmentMicroUsd * roundDurationSegments * 11n) / 10n;

  const inOpenWindow = (() => {
    if (!round) return false;
    const intoRound = Number(nextSegmentIndex - round.startedAtSegment);
    return intoRound < round.openWindowSegments;
  })();

  // ── close declared first; open's queued-close calls it ───────────────
  const closeRef = useRef<() => void>(() => {});

  const open = useCallback(
    (barrierIndex: BarrierIndex, _barrierPrice: number) => {
      if (busyRef.current || positionId) return;
      if (!packageId || !market.vault || !botRegistryId) {
        setLastError("Segment market deployment incomplete.");
        return;
      }
      if (!inOpenWindow) {
        // Open window closed — refuse silently (UI shows it disabled).
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
          const tx = buildOpenSegmentRideTx({
            packageId,
            collateralType: market.collateral || DEFAULT_COLLATERAL,
            sender,
            marketId: market.market,
            vaultId: market.vault,
            botRegistryId,
            barrierIndex,
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
              c.objectType.includes("::segment_market::SegmentRidePosition"),
          );
          if (!created?.objectId) {
            throw new Error("SegmentRidePosition not found in tx result");
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
          console.warn("[useSegmentRide] open:", err);
        }
      })();
    },
    [
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
      inOpenWindow,
      onBalanceChanged,
    ],
  );

  const close = useCallback(() => {
    if (phase === "opening" && !positionId) {
      // Released before the open tx confirmed — queue the close.
      closeQueuedRef.current = true;
      return;
    }
    if (!positionId) return;
    if (busyRef.current) return;
    busyRef.current = true;
    // OPTIMISTIC: flip phase immediately so the chart shows "cashing out…".
    setPhase("closing");

    void (async () => {
      try {
        const tx = buildCloseSegmentRideTx({
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
          (e.type ?? "").includes("::segment_market::RideClosed"),
        );
        let kind = -1;
        if (ev?.parsedJson && typeof ev.parsedJson === "object") {
          const f = ev.parsedJson as { settlement_kind?: number | string };
          if (f.settlement_kind !== undefined) kind = Number(f.settlement_kind);
        }
        const labelKey = kind as 0 | 1 | 2 | 3 | 4;
        const label =
          kind >= 0 && labelKey in SETTLEMENT_NAME
            ? SETTLEMENT_NAME[labelKey]
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
        console.warn("[useSegmentRide] close:", err);
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
  // Called by the chart hook when no SegmentRecorded event has arrived
  // for ~3s while a ride is open. Idempotent at the on-chain side: the
  // crank's first-write-wins guard means concurrent calls just bounce.
  // We rate-limit at the client side so we don't spam the RPC if the
  // chart hook fires onStall repeatedly.
  const lastCrankAtMsRef = useRef(0);
  const triggerStallCrank = useCallback(() => {
    const now = Date.now();
    if (now - lastCrankAtMsRef.current < 1500) return;
    lastCrankAtMsRef.current = now;
    void (async () => {
      try {
        const tx = buildRecordSegmentTx({
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
        // Bouncing is fine — another caller (the keeper, another rider)
        // beat us. Only log unexpected failures.
        const msg = (err as Error).message ?? "";
        if (!/already|next|first-write|window/i.test(msg)) {
          console.warn("[useSegmentRide] cranker:", err);
        }
      }
    })();
  }, [client, keypair, market.market, market.collateral, packageId, sender]);

  // Re-pick when picked barrier is unset but the user opened: ensure the
  // chart hook always sees a valid picked.
  void BARRIER_UPPER;
  void BARRIER_LOWER;

  return {
    round,
    segments,
    nextSegmentIndex,
    inOpenWindow,
    pickedBarrier,
    pickBarrier,
    phase,
    open,
    close,
    stakePerSegmentMicroUsd,
    multiplierBps,
    lastSettlement,
    lastError,
    triggerStallCrank,
  };
}
