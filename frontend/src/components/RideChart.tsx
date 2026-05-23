/**
 * RideChart — React wrapper around the segment-arcade `useRideGesture`.
 *
 * The chart's data source is the on-chain `SegmentRecorded` event ring
 * buffer fed in via `segments` — the hook expands each one through
 * `seededPath.expandSegment` to render the deterministic 6 candles. The
 * chart you see IS the price you settle against (doc 17 §1, §15.1).
 *
 * The global `preventDefault` block is load-bearing for iOS Safari — it
 * stops the page scrolling or showing the context menu while a finger is
 * down on the canvas.
 */
import { useEffect, useRef } from "react";
import type p5 from "p5";
import {
  useRideGesture,
  type RideGestureCallbacks,
  type RidePhase,
  type RoundInfo,
  type SegmentInput,
} from "@/hooks/useRideGesture";
import type { BarrierIndex } from "@wick/sdk";

export interface RideChartProps {
  /** Press / release callbacks — pipe these into useSegmentRide. */
  callbacks: RideGestureCallbacks;
  /** Lifecycle phase from useSegmentRide. */
  phase: RidePhase;
  /** Currently-picked barrier (driven by the parent). */
  pickedBarrier: BarrierIndex | null;
  /** Current round info — null until first RoundStarted event. */
  round: RoundInfo | null;
  /** Sorted ring buffer of recent SegmentRecorded events. */
  segments: ReadonlyArray<SegmentInput>;
  /** Touch payout multiplier in bps (20_000 = 2.0×). Drives the live PnL. */
  multiplierBps?: number;
  /** Per-segment stake in micro-USD (mirror of the on-chain market field). */
  stakePerSegmentMicroUsd?: bigint;
  /** Live PnL — fires ~12x/sec while the chart is held. */
  onPnlChange?: (snap: { pnl: number; staked: number }) => void;
  /** Disable press handling. */
  disabled?: boolean;
}

export function RideChart({
  callbacks,
  phase,
  pickedBarrier,
  round,
  segments,
  multiplierBps,
  stakePerSegmentMicroUsd,
  onPnlChange,
  disabled,
}: RideChartProps) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const p5InstanceRef = useRef<p5 | null>(null);

  // Global iOS guards: stop the page from scrolling, selecting text, or
  // showing the context menu while a finger is down on the canvas.
  useEffect(() => {
    const preventDefault = (e: Event) => e.preventDefault();
    document.body.addEventListener("touchmove", preventDefault, {
      passive: false,
    });
    document.addEventListener("contextmenu", preventDefault);
    document.addEventListener("selectstart", preventDefault);
    document.addEventListener("selectionchange", preventDefault);
    document.addEventListener("gesturestart", preventDefault);
    document.addEventListener("gesturechange", preventDefault);
    document.addEventListener("gestureend", preventDefault);
    return () => {
      document.body.removeEventListener("touchmove", preventDefault);
      document.removeEventListener("contextmenu", preventDefault);
      document.removeEventListener("selectstart", preventDefault);
      document.removeEventListener("selectionchange", preventDefault);
      document.removeEventListener("gesturestart", preventDefault);
      document.removeEventListener("gesturechange", preventDefault);
      document.removeEventListener("gestureend", preventDefault);
    };
  }, []);

  useRideGesture({
    chartRef,
    p5InstanceRef,
    phase,
    pickedBarrier,
    round,
    segments,
    multiplierBps,
    stakePerSegmentMicroUsd,
    onPnlChange,
    callbacks,
    disabled,
  });

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        height: "calc(100% + env(safe-area-inset-bottom))",
        marginBottom: "calc(-1 * env(safe-area-inset-bottom))",
        width: "100vw",
        background: "transparent",
        overflow: "hidden",
        // Block iOS double-tap zoom on the canvas surface.
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
      }}
    >
      <div ref={chartRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}

export default RideChart;
