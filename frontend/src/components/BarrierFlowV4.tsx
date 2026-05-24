/**
 * BarrierFlowV4 — V4 right-rail "barrier flow" panel (doc 25 §5.3).
 *
 * V4 markets merge upper + lower aggregates into a single bucket (touch
 * either side wins), so there's nothing to split. This panel surfaces:
 *
 *   ROUND #N · X.Xs left
 *   ─────────────────────────
 *   LIVE RIDERS    7
 *   TOTAL STAKED   $156.20
 *   JACKPOT        $87.50     (multiplier × your escrow estimate)
 *
 *   UPPER  $1,100   (3.4% away)
 *   LOWER  $900     (5.1% away)
 *
 * Distance-to-barrier is computed from the LIVE spot via the polled market
 * snapshot's `walkPrice`. This is the same price the chart is rendering
 * — so what the user sees in the right rail matches what's painted under
 * the laser tracer.
 *
 * Replaces `BarrierOrderbookGrid` for V4 markets. V2/V3 markets keep
 * using the orderbook grid (see Ride.tsx feature flag).
 */
import { useEffect, useState } from "react";
import {
  fetchSegmentMarketV4,
  type SegmentMarketV4Snapshot,
} from "@wick/sdk";
import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

/** Match the v3 OrderbookGrid cadence — 1s feels live. */
const SNAPSHOT_POLL_MS = 1000;

/** Micro-USD scale used across the SDK + Move side. */
const PRICE_SCALING_USD = 1_000_000;

export interface BarrierFlowV4Props {
  /** The SegmentMarketV4<C> id to read from. */
  readonly marketId: string;
  /** Sui JSON RPC client (typically session.client from useSessionWallet). */
  readonly client: SuiJsonRpcClient;
  /** Initial snapshot from useSegmentRideV4 — pass through to avoid a blank first paint. */
  readonly initialSnapshot?: SegmentMarketV4Snapshot | null;
  /**
   * Estimated segment cadence (ms) for the round countdown bar. Defaults to
   * 400 ms per doc 17 §10. The component does its own animation frame
   * tick so the "X.Xs left" stays smooth between snapshot fetches.
   */
  readonly segmentMs?: number;
}

/** Convert micro-USD bigint → USD double for display. */
function toUsd(microUsd: bigint): number {
  return Number(microUsd) / PRICE_SCALING_USD;
}

/** Format a $ amount: 2 decimals if < 100, 0 decimals otherwise. */
function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n < 100
    ? `$${n.toFixed(2)}`
    : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/** Format the distance-to-barrier as a % away from spot. */
function distancePct(spot: number, barrier: number): string {
  if (!Number.isFinite(spot) || spot <= 0 || !Number.isFinite(barrier)) return "—";
  const pct = (Math.abs(barrier - spot) / spot) * 100;
  return `${pct.toFixed(pct < 10 ? 1 : 0)}% away`;
}

export function BarrierFlowV4(props: BarrierFlowV4Props) {
  const { marketId, client, initialSnapshot, segmentMs = 400 } = props;

  const [snapshot, setSnapshot] = useState<SegmentMarketV4Snapshot | null>(
    initialSnapshot ?? null,
  );

  // Local rAF tick — keeps the "Xs left" countdown smooth between polls.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      setTick((t) => (t + 1) % 1024);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Poll the market snapshot. Pause when the tab is hidden (battery /
  // RPC cost) and resume on visibilitychange — mirrors v3 BarrierOrderbookGrid.
  useEffect(() => {
    if (!marketId) return;
    let cancelled = false;
    let intervalId: number | null = null;

    const refresh = async () => {
      try {
        const next = await fetchSegmentMarketV4(client, marketId);
        if (cancelled || !next) return;
        setSnapshot((prev) => {
          if (!prev) return next;
          // Cheap content-equality on the fields this panel renders. If
          // nothing visible changed, keep the previous reference so React
          // skips re-renders.
          if (
            prev.cachedRoundIndex === next.cachedRoundIndex &&
            prev.cachedUpperBarrier === next.cachedUpperBarrier &&
            prev.cachedLowerBarrier === next.cachedLowerBarrier &&
            prev.eitherAggregateStake === next.eitherAggregateStake &&
            prev.eitherAggregateMaxPayout === next.eitherAggregateMaxPayout &&
            prev.eitherRiderCount === next.eitherRiderCount &&
            prev.walkPrice === next.walkPrice &&
            prev.nextSegmentIndex === next.nextSegmentIndex
          ) {
            return prev;
          }
          return next;
        });
      } catch (err) {
        console.warn("[BarrierFlowV4] fetchSegmentMarketV4:", err);
      }
    };

    const startInterval = () => {
      if (intervalId !== null) return;
      intervalId = window.setInterval(() => void refresh(), SNAPSHOT_POLL_MS);
    };
    const stopInterval = () => {
      if (intervalId === null) return;
      window.clearInterval(intervalId);
      intervalId = null;
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        stopInterval();
      } else {
        void refresh();
        startInterval();
      }
    };

    void refresh();
    if (!document.hidden) startInterval();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      stopInterval();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [client, marketId]);

  // Touch the tick to keep React's dep checker happy without affecting render.
  void tick;

  if (!snapshot) return null;

  const roundIndex = snapshot.cachedRoundIndex;
  const dur = Number(snapshot.roundDurationSegments) || 75;
  const segmentsIntoRound = Math.max(
    0,
    Number(snapshot.nextSegmentIndex - snapshot.cachedRoundStartedAtSegment),
  );
  const segmentsLeft = Math.max(0, dur - segmentsIntoRound);
  const secLeft = (segmentsLeft * segmentMs) / 1000;
  const roundProgress = Math.min(1, Math.max(0, segmentsIntoRound / dur));

  const spot = toUsd(snapshot.walkPrice);
  const upper = toUsd(snapshot.cachedUpperBarrier);
  const lower = toUsd(snapshot.cachedLowerBarrier);

  // 2026-05-23 declutter: riders / totalStakedUsd / jackpotUsd / fullnessPct
  // were rendered in the panel but they're spectator metrics — they don't
  // change the user's decision to tap-and-hold. Dropped along with their
  // render blocks. The snapshot still carries them on chain so we can
  // surface them later (admin view, leaderboard, etc.).

  return (
    <div className="glass-container px-3 py-2.5 rounded-lg font-mono pointer-events-none select-none min-w-[180px]">
      <div className="glass-filter" />
      <div className="glass-overlay" />
      <div className="glass-specular" />
      <div className="relative z-10 leading-tight">
        {/* Header — ROUND #N · X.Xs left */}
        <div className="flex items-baseline justify-between mb-2">
          <div className="text-[9px] uppercase tracking-[0.18em] text-white/45">
            Round
          </div>
          <div className="text-[11px] font-semibold tabular-nums text-white/90">
            #{roundIndex.toString()} · {secLeft.toFixed(1)}s
          </div>
        </div>

        {/* Round-progress micro-bar */}
        <div className="h-0.5 w-full rounded-full bg-white/10 overflow-hidden mb-2.5">
          <div
            className="h-full bg-white/55"
            style={{ width: `${roundProgress * 100}%` }}
          />
        </div>

        {/* 2026-05-23 declutter: dropped LIVE RIDERS / TOTAL STAKED /
            JACKPOT / ROUND CAP — spectator metrics that don't change the
            user's decision. The two-barrier block below is the only
            actionable info: are the barriers close enough that touching
            either is plausible? (User feedback: "as little as stuff on
            the screen as possible".) */}

        {/* Two barriers — distance-to-spot for awareness only */}
        <div className="space-y-1">
          <div className="flex items-baseline justify-between">
            <span className="text-[9px] uppercase tracking-[0.14em] text-emerald-400/80">
              ▲ Upper
            </span>
            <span className="text-[11px] font-semibold tabular-nums text-emerald-400">
              {fmtUsd(upper)}
            </span>
          </div>
          <div className="text-[9px] text-white/40 text-right tabular-nums -mt-0.5">
            {distancePct(spot, upper)}
          </div>
          <div className="flex items-baseline justify-between pt-0.5">
            <span className="text-[9px] uppercase tracking-[0.14em] text-rose-400/80">
              ▼ Lower
            </span>
            <span className="text-[11px] font-semibold tabular-nums text-rose-400">
              {fmtUsd(lower)}
            </span>
          </div>
          <div className="text-[9px] text-white/40 text-right tabular-nums -mt-0.5">
            {distancePct(spot, lower)}
          </div>
        </div>
      </div>
    </div>
  );
}

// Reference the rAF tick so it's a tracked state value (the ref + setTick
// keep the countdown smooth between snapshot poll cycles).
export default BarrierFlowV4;
