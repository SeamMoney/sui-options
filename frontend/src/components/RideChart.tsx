/**
 * RideChart — React wrapper around `useRideGesture`.
 *
 * Ported from /tmp/cash-trading-game/src/components/CandlestickChart.tsx.
 * Keeps the global `preventDefault` block (load-bearing for iOS Safari —
 * stops the page from scrolling / showing the context menu while a finger
 * is down on the canvas) and the `displayPnl` lerp (smooths the number so
 * the overlay doesn't jitter on every poll).
 */
import { useEffect, useRef, useState } from "react";
import type p5 from "p5";
import RidePnlOverlay from "@/components/RidePnlOverlay";
import { useRideGesture, type RideGestureCallbacks } from "@/hooks/useRideGesture";

export interface RideChartProps {
  /** Press / release callbacks — pipe these into useWickRide. */
  callbacks: RideGestureCallbacks;
  /** True while a ride is open on-chain. Drives PnL color + emoji burst. */
  isHolding: boolean;
  /** Live PnL in $. Wires through to the overlay + chart line color. */
  pnl: number;
  /** Most recent oracle spot (chart units). Optional — chart will random-walk. */
  liveSpot?: number;
  /** Optional barrier price to draw on the chart. */
  barrier?: number;
  /** 0 = touch-from-below, 1 = touch-from-above. */
  barrierDirection?: 0 | 1;
  /** Disable press handling. */
  disabled?: boolean;
}

export function RideChart({
  callbacks,
  isHolding,
  pnl,
  liveSpot,
  barrier,
  barrierDirection,
  disabled,
}: RideChartProps) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const p5InstanceRef = useRef<p5 | null>(null);
  const [displayPnl, setDisplayPnl] = useState(0);

  // Lerp displayPnl toward pnl over 300ms in 30 steps (the cash-trading-game
  // value the source repo ships with). Stops the number from tearing as the
  // 500ms poll updates land.
  useEffect(() => {
    const durationMs = 300;
    const steps = 30;
    const stepMs = durationMs / steps;
    const diff = pnl - displayPnl;
    if (Math.abs(diff) < 0.01) {
      setDisplayPnl(pnl);
      return;
    }
    const inc = diff / steps;
    let step = 0;
    const id = window.setInterval(() => {
      step += 1;
      if (step >= steps) {
        setDisplayPnl(pnl);
        window.clearInterval(id);
      } else {
        setDisplayPnl((prev) => prev + inc);
      }
    }, stepMs);
    return () => window.clearInterval(id);
    // displayPnl intentionally excluded — including it would restart the
    // interval every tick. We only re-lerp on a new target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pnl]);

  // Global iOS guards: stop the page from scrolling, selecting text, or
  // showing the context menu while a finger is down on the canvas.
  useEffect(() => {
    const preventDefault = (e: Event) => e.preventDefault();
    document.body.addEventListener("touchmove", preventDefault, { passive: false });
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
    pnl,
    liveSpot,
    barrier,
    barrierDirection,
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
        display: "flex",
        flexDirection: "column",
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
      <div ref={chartRef} style={{ flex: "1 1 auto" }} />
      <RidePnlOverlay pnl={pnl} displayPnl={displayPnl} isHolding={isHolding} />
    </div>
  );
}

export default RideChart;
