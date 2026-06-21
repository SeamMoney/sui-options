/**
 * PatternCoachPanel — a compact, mobile-first "pattern coach" readout that
 * runs the CandleVision detector (@sui-options/candle-vision) over a candle
 * window and surfaces the strongest setups as plain-language coaching.
 *
 * Data-source agnostic by design: it takes a `candles` array, so the same
 * panel works over the synthetic round path, the seeded-path chart, OR a
 * live DeepBook mark feed (the Wick Pro submission prices options off a
 * DeepBook mid — this panel coaches against those same candles).
 *
 * Styling follows the Wick aesthetic: near-black surface, mono numbers,
 * neon-green = bullish, hot-magenta = bearish. Self-contained — no chart
 * dependency, no worker, no p5. The detector is a pure function, so this is
 * cheap to mount as a side panel.
 */
import { useMemo } from "react";
import { useCandleVisionScanner } from "@sui-options/candle-vision-react";
import type { CandleInput } from "@sui-options/candle-vision";
import type { CandleDirection } from "@sui-options/candle-vision";

interface PatternCoachPanelProps {
  /** The candle window to coach over (DeepBook mark / seeded path / synthetic). */
  readonly candles: CandleInput[];
  /** Max setups to list. Default 3 — enough to read at a glance on a phone. */
  readonly maxItems?: number;
  /** Only surface setups at/above this confidence (0–1). Default 0.4. */
  readonly minConfidence?: number;
  readonly className?: string;
}

const DIRECTION_STYLE: Record<
  CandleDirection,
  { color: string; tag: string; verb: string }
> = {
  bullish: { color: "#00ff3f", tag: "LONG", verb: "leaning up" },
  bearish: { color: "#ff0696", tag: "SHORT", verb: "leaning down" },
  neutral: { color: "#9ca3af", tag: "FLAT", verb: "indecision" },
};

function pct(conf: number): string {
  return `${Math.max(0, Math.min(100, Math.round(conf * 100)))}%`;
}

export function PatternCoachPanel({
  candles,
  maxItems = 3,
  minConfidence = 0.4,
  className = "",
}: PatternCoachPanelProps) {
  // Stable options ref — useCandleVisionScanner memoizes on (candles, options),
  // so an inline object would force a re-scan every render.
  const options = useMemo(
    () => ({ minConfidence, ranking: { maxVisible: Math.max(maxItems, 4) } }),
    [minConfidence, maxItems],
  );
  const { visibleSignals } = useCandleVisionScanner(candles, options);

  const top = visibleSignals[0];
  const rest = visibleSignals.slice(0, maxItems);

  return (
    <div
      className={`rounded-2xl border border-white/10 bg-black/60 backdrop-blur-md p-4 font-mono select-none ${className}`}
    >
      <div className="flex items-center justify-between gap-2 mb-3">
        {/* nowrap + tighter tracking so the label stays on one line inside the
            narrow (158px) mobile panel instead of wrapping to two. */}
        <div className="whitespace-nowrap text-[10px] uppercase tracking-[0.12em] text-white/40">
          Pattern Coach
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400/70 motion-safe:animate-ping" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
          </span>
          <span className="text-[9px] uppercase tracking-[0.18em] text-white/35">
            live
          </span>
        </div>
      </div>

      {/* Headline read — the single most actionable setup right now. */}
      {top ? (
        <div className="mb-4">
          <div
            className="text-lg font-bold leading-tight"
            style={{ color: DIRECTION_STYLE[top.event.direction].color }}
          >
            {top.event.label}
          </div>
          {/* flex-wrap so the confidence drops to its own line rather than
              clipping off the right edge on a narrow (158px) mobile panel. */}
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
            <span
              className="rounded px-1.5 py-0.5 font-semibold tracking-wide"
              style={{
                color: DIRECTION_STYLE[top.event.direction].color,
                background: `${DIRECTION_STYLE[top.event.direction].color}1a`,
              }}
            >
              {DIRECTION_STYLE[top.event.direction].tag}
            </span>
            <span className="capitalize text-white/45">{top.event.status}</span>
            <span className="ml-auto tabular-nums text-white/70">
              {pct(top.event.confidence)}
            </span>
          </div>
        </div>
      ) : (
        <div className="mb-4 text-sm text-white/35 leading-relaxed">
          Reading the tape… no high-confidence setup yet.
        </div>
      )}

      {/* The next strongest setups, compact. */}
      {rest.length > 1 && (
        <ul className="flex flex-col gap-1.5">
          {rest.slice(1).map((sig) => {
            const ds = DIRECTION_STYLE[sig.event.direction];
            return (
              <li
                key={sig.event.id}
                className="flex items-center gap-2 text-[11px]"
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: ds.color }}
                />
                <span className="min-w-0 flex-1 truncate text-white/70">{sig.event.label}</span>
                <span className="shrink-0 tabular-nums text-white/35">
                  {pct(sig.event.confidence)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default PatternCoachPanel;
