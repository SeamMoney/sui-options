/**
 * RideChart — React wrapper around `useRideGesture`.
 *
 * Ported from /tmp/cash-trading-game/src/components/CandlestickChart.tsx.
 * Keeps the global `preventDefault` block (load-bearing for iOS Safari —
 * stops the page scrolling / showing the context menu while a finger is
 * down on the canvas).
 *
 * The live PnL is computed INSIDE the gesture hook, from the chart the user
 * is watching, and surfaced through `onPnlChange` — there is no chain poll
 * in the hot path, so the number is genuinely real-time.
 */
import { useEffect, useRef } from "react";
import type p5 from "p5";
import {
  useRideGesture,
  type RideGestureCallbacks,
} from "@/hooks/useRideGesture";

export interface RideChartProps {
  /** Press / release callbacks — pipe these into useWickRide. */
  callbacks: RideGestureCallbacks;
  /** True while a ride is open on-chain. Drives PnL color + emoji burst. */
  isHolding: boolean;
  /** Most recent oracle spot (chart units). Optional — chart random-walks. */
  liveSpot?: number;
  /** Optional barrier price to draw on the chart. */
  barrier?: number;
  /** 0 = touch-from-below, 1 = touch-from-above. */
  barrierDirection?: 0 | 1;
  /** Touch payout multiplier in bps (20000 = 2.0x). Drives the live PnL. */
  multiplierBps?: number;
  /** Premium burn rate in $/sec — how fast a held position accrues stake. */
  stakeRatePerSec?: number;
  /** Live PnL — fires ~12x/sec while the chart is held. */
  onPnlChange?: (snap: { pnl: number; staked: number }) => void;
  /** Disable press handling. */
  disabled?: boolean;
}

export function RideChart({
  callbacks,
  isHolding,
  liveSpot,
  barrier,
  barrierDirection,
  multiplierBps,
  stakeRatePerSec,
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
    isHolding,
    liveSpot,
    barrier,
    barrierDirection,
    multiplierBps,
    stakeRatePerSec,
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
