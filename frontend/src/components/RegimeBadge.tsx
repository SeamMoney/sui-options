/**
 * RegimeBadge — small fixed-position pill showing the current round's
 * drift regime (RANGING / TRENDING UP / TRENDING DOWN).
 *
 * The regime is derived deterministically from `keccak256(market_id ||
 * round_index)` mod 3, mirroring `wick::segment_market_v4::regime_drift_for_round`.
 * Same input → same regime on chain + client. No event needed, no
 * subscription, no storage.
 *
 * Visual placement: bottom-right of the chart (paired with the
 * bottom-left RugFeed), pointer-events-none, low-key — explains what's
 * happening to the chart without competing for tap focus.
 */
import { useMemo } from "react";
import {
  REGIME_TREND_UP,
  REGIME_TREND_DOWN,
  REGIME_LABEL,
  regimeDriftForRound,
  type RegimeKind,
} from "@wick/sdk";

interface RegimeBadgeProps {
  readonly marketId: string;
  readonly roundIndex: bigint | null;
}

export function RegimeBadge({ marketId, roundIndex }: RegimeBadgeProps) {
  const regime = useMemo(() => {
    if (roundIndex == null) return null;
    return regimeDriftForRound(marketId, roundIndex);
  }, [marketId, roundIndex]);

  if (!regime) return null;

  const label = REGIME_LABEL[regime.kind];
  const accent = pickAccent(regime.kind);

  return (
    <div
      className="fixed bottom-3 right-3 z-[1550] pointer-events-none"
      aria-hidden
    >
      <div className="glass-container px-3 py-2 rounded-lg font-mono select-none">
        <div className="glass-filter" />
        <div className="glass-overlay" />
        <div className="glass-specular" />
        <div className="relative z-10 leading-tight">
          <div className="text-[9px] uppercase tracking-[0.18em] text-white/45 mb-1">
            Regime
          </div>
          <div
            className="text-[11px] tabular-nums"
            style={{ color: accent }}
          >
            {label}
          </div>
          {roundIndex != null ? (
            <div className="text-[9px] tracking-[0.12em] text-white/35 mt-1">
              R{roundIndex.toString()}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function pickAccent(kind: RegimeKind): string {
  switch (kind) {
    case REGIME_TREND_UP:
      return "#00ff88";
    case REGIME_TREND_DOWN:
      return "#ff4444";
    default:
      // RANGE — neutral white with reduced opacity
      return "rgba(255,255,255,0.7)";
  }
}
