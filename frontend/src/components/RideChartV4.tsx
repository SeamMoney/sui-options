/**
 * RideChartV4 — React wrapper around the v4 `useRideGestureV4`.
 *
 * Parallel to `RideChart` (v3), but routes through the v4 gesture hook
 * which:
 *   - drops the upper/lower barrier-pick step (press anywhere → onOpen)
 *   - adds the glowing laser-trace overlay (doc 25 §5.2)
 *
 * The global iOS guards (preventDefault on touchmove/contextmenu/etc.) are
 * load-bearing and identical to RideChart — they keep the page from
 * scrolling or text-selecting while a finger is held on the canvas.
 */
import { useEffect, useRef } from "react";
import type p5 from "p5";
import {
  useRideGestureV4,
  type RideGestureV4Callbacks,
  type RidePhase,
  type RoundInfoV4,
  type SegmentInputV4,
} from "@/hooks/useRideGestureV4";

export interface RideChartV4Props {
  /** Press / release callbacks — pipe these into useSegmentRideV4. */
  callbacks: RideGestureV4Callbacks;
  /** Lifecycle phase from useSegmentRideV4. */
  phase: RidePhase;
  /** Current round info — null until first RoundStartedV4 event. */
  round: RoundInfoV4 | null;
  /** Sorted ring buffer of recent SegmentRecordedV4 events. */
  segments: ReadonlyArray<SegmentInputV4>;
  /** Touch payout multiplier in bps (17_500 = 1.75×). */
  multiplierBps?: number;
  /** Per-segment stake in micro-USD. */
  stakePerSegmentMicroUsd?: bigint;
  /** Live PnL — fires ~12x/sec while the chart is held. */
  onPnlChange?: (snap: { pnl: number; staked: number }) => void;
  /** Disable press handling. */
  disabled?: boolean;
}

export function RideChartV4({
  callbacks,
  phase,
  round,
  segments,
  multiplierBps,
  stakePerSegmentMicroUsd,
  onPnlChange,
  disabled,
}: RideChartV4Props) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const p5InstanceRef = useRef<p5 | null>(null);

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

  useRideGestureV4({
    chartRef,
    p5InstanceRef,
    phase,
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

export default RideChartV4;
