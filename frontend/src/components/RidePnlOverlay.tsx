/**
 * Live PnL card that floats over the ride canvas.
 *
 * Ported from /tmp/cash-trading-game/src/components/PnlOverlay.tsx.
 * Behavioral parity: glow scales with |pnl|/100 ("heats up" as the trade
 * moves), color flips green/red, and a separate `displayPnl` is lerped by
 * the parent for smooth numeric jitter.
 *
 * Font swap: the source uses Bai Jamjuree. The Wick frontend ships Geist
 * (see `frontend/package.json`), so we use the same `--font-sans` token
 * Tailwind/Geist installs at the document level.
 */
import { useEffect, useState } from "react";
import { getTopMargin } from "@/utils/safeArea";

export interface RidePnlOverlayProps {
  /** True $-denominated PnL (positive = profit). */
  pnl: number;
  /** Lerp'd PnL — what we actually render, so the number doesn't tear. */
  displayPnl: number;
  /** Is the user currently holding the screen? */
  isHolding: boolean;
}

export function RidePnlOverlay({ pnl, displayPnl, isHolding }: RidePnlOverlayProps) {
  // Re-evaluate viewport on resize so the card stays in the right place when
  // the iOS rotation handlers fire after a window resize.
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.innerWidth < 768 : true,
  );
  const [topOffset, setTopOffset] = useState<number>(() => getTopMargin() + 10);

  useEffect(() => {
    const onResize = () => {
      setIsMobile(window.innerWidth < 768);
      setTopOffset(getTopMargin() + 10);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const isNeutral = !isHolding || Math.abs(pnl) < 0.01;
  const isProfit = pnl > 0.01;
  const pnlIntensity = Math.min(Math.abs(pnl) / 100, 1);
  const baseIntensity = 0.08;
  const maxIntensity = 0.20;
  const currentIntensity = baseIntensity + pnlIntensity * (maxIntensity - baseIntensity);

  let bgGradient: string;
  if (isNeutral) {
    bgGradient =
      "linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.02) 100%)";
  } else if (isProfit) {
    bgGradient = `linear-gradient(135deg, rgba(0,255,136,${currentIntensity}) 0%, rgba(0,255,136,${currentIntensity * 0.5}) 100%)`;
  } else {
    bgGradient = `linear-gradient(135deg, rgba(255,68,68,${currentIntensity}) 0%, rgba(255,68,68,${currentIntensity * 0.5}) 100%)`;
  }

  return (
    <div
      className="glass-container"
      style={{
        position: "absolute",
        top: `${topOffset}px`,
        left: isMobile ? 19 : 23,
        width: isMobile ? 140 : 180,
        height: isMobile ? 90 : 105,
        borderRadius: 8,
        zIndex: 1500,
        fontFamily: "var(--font-sans)",
        background: `linear-gradient(135deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.04) 100%), ${bgGradient}`,
        boxShadow: `0 10px 40px ${
          isNeutral
            ? "rgba(255,255,255,0.05)"
            : isProfit
              ? `rgba(0,255,136,${currentIntensity})`
              : `rgba(255,68,68,${currentIntensity})`
        }, 0 6px 6px rgba(0,0,0,0.2), 0 0 20px rgba(0,0,0,0.1)`,
        pointerEvents: "none",
      }}
    >
      <div className="glass-filter" />
      <div className="glass-overlay" />
      <div
        className="glass-specular"
        style={{
          boxShadow: `inset 0 0 8px ${
            isNeutral
              ? "rgba(255,255,255,0.08)"
              : isProfit
                ? `rgba(0,255,136,${currentIntensity * 0.8})`
                : `rgba(255,68,68,${currentIntensity * 0.8})`
          }, inset 0 1px 0 rgba(255,255,255,0.2), inset 1px 0 0 rgba(255,255,255,0.1)`,
          background: `radial-gradient(circle at center, ${
            isNeutral
              ? "rgba(255,255,255,0.04)"
              : isProfit
                ? `rgba(0,255,136,${currentIntensity * 0.6})`
                : `rgba(255,68,68,${currentIntensity * 0.6})`
          }, transparent 70%)`,
        }}
      />
      <div
        className="glass-content"
        style={{
          flexDirection: "column",
          justifyContent: "center",
          padding: isMobile ? "12px 16px" : "16px 20px",
        }}
      >
        <div
          style={{
            fontSize: isMobile ? 12 : 14,
            color: "rgba(255,255,255,0.6)",
            marginBottom: 4,
            fontWeight: 500,
            textAlign: "center",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          P&L
        </div>
        <div
          style={{
            fontSize: isMobile ? 24 : 32,
            fontWeight: 700,
            color: isNeutral ? "rgba(255,255,255,0.9)" : isProfit ? "#00FF99" : "#FF5555",
            textAlign: "center",
            letterSpacing: -0.5,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {displayPnl >= 0 ? "+" : ""}${displayPnl.toFixed(2)}
        </div>
        <div
          style={{
            fontSize: isMobile ? 10 : 11,
            color: "rgba(255,255,255,0.5)",
            marginTop: 6,
            fontWeight: 500,
            textAlign: "center",
            opacity: isHolding ? 1 : 0,
            transition: "opacity 0.3s ease",
            letterSpacing: "0.08em",
          }}
        >
          ACTIVE POSITION
        </div>
      </div>
    </div>
  );
}

export default RidePnlOverlay;
