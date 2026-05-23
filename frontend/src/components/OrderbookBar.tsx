/**
 * OrderbookBar — sideways "volume profile" bar per shared barrier.
 *
 * Doc 19 §14 + §17.5: every round has two shared barriers (upper / lower)
 * and each one carries an on-chain aggregate of how much stake is currently
 * committed against it. This component renders that aggregate as a single
 * sideways bar — width proportional to per-barrier liability cap — so a
 * solo rider can SEE the crowd lean into the same barrier. The bar pulses
 * (~200ms scale flash) every time the underlying stake number changes
 * (i.e. a `RideOpened` / `RideClosed` event has landed).
 *
 * Visual idiom matches RoundCountdown: glass-container surface, Bai
 * Jamjuree mono numbers, tiny uppercase tracker labels. Green = upper
 * (long the touch from below), red = lower. "FULL" desaturated state
 * fires once the per-barrier cap is exhausted (no more rides accepted
 * on that side until the next round).
 */
import { useEffect, useRef, useState } from "react";

/** Display price = micro-USD / 1e6 (mirror of SDK conv). */
const PRICE_SCALING = 1_000_000;
/** Pulse duration in ms — keep tight so it reads as "a tick landed", not
 *  as a long animation. Matches RoundCountdown's amber pulse cadence. */
const PULSE_MS = 200;

export interface OrderbookBarProps {
  /** Which side this bar represents. Drives color + label. */
  readonly side: "upper" | "lower";
  /** Barrier price (micro-USD). Displayed as $X,XXX.XX. */
  readonly barrierPrice: bigint;
  /** Touch payout multiplier in bps (20_000 = 2×). */
  readonly multiplierBps: number;
  /** Current aggregate stake at this barrier (micro-USD). */
  readonly stakeMicroUsd: bigint;
  /** Live rider count on this barrier. */
  readonly riderCount: number;
  /** True when aggregate_max_payout >= max_payout_per_barrier — no more
   *  rides accepted on this side until round rolls. */
  readonly isFull: boolean;
  /** Max stake we'll fill the bar to (micro-USD). Used to normalise the
   *  width — usually `max_payout_per_barrier / multiplier`. */
  readonly maxStakeMicroUsd: bigint;
}

/** Display micro-USD as "$1,234.56" (no $ for tiny values). */
function fmtUsd(microUsd: bigint): string {
  const usd = Number(microUsd) / PRICE_SCALING;
  return `$${usd.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Display barrier price as "$67,543". Round-numbers — no fractional cents. */
function fmtBarrier(microUsd: bigint): string {
  const usd = Number(microUsd) / PRICE_SCALING;
  return `$${usd.toLocaleString(undefined, {
    maximumFractionDigits: usd >= 100 ? 0 : 2,
  })}`;
}

export function OrderbookBar(props: OrderbookBarProps) {
  const {
    side,
    barrierPrice,
    multiplierBps,
    stakeMicroUsd,
    riderCount,
    isFull,
    maxStakeMicroUsd,
  } = props;

  // ── Pulse trigger ───────────────────────────────────────────────────
  // We pulse whenever stakeMicroUsd changes from its last seen value,
  // which is exactly when a RideOpened/RideClosed event has reconciled
  // through the snapshot. We use a string ref to compare bigints cheaply
  // (the stake number lives in a single u64 — toString() compare is safe).
  // The pulse is driven by a boolean state that flips true on change and
  // back to false after PULSE_MS via a timeout, so React re-renders
  // exactly twice per pulse (on and off) rather than continuously.
  const lastStakeStrRef = useRef<string>(stakeMicroUsd.toString());
  const [isPulsing, setIsPulsing] = useState(false);
  useEffect(() => {
    const next = stakeMicroUsd.toString();
    if (next === lastStakeStrRef.current) return;
    lastStakeStrRef.current = next;
    setIsPulsing(true);
    const id = window.setTimeout(() => setIsPulsing(false), PULSE_MS);
    return () => window.clearTimeout(id);
  }, [stakeMicroUsd]);

  // ── Width normalisation ─────────────────────────────────────────────
  // Width = stakeMicroUsd / maxStakeMicroUsd × 100%. Clamp [0, 100].
  // Guard against zero-cap config (would NaN otherwise).
  let widthPct = 0;
  if (maxStakeMicroUsd > 0n) {
    const ratio = Number(stakeMicroUsd) / Number(maxStakeMicroUsd);
    widthPct = Math.max(0, Math.min(100, ratio * 100));
  }
  // When the bar has stake but rounds to <1%, give it a hairline so the
  // crowd's presence is visible. (Hide entirely when truly empty.)
  if (stakeMicroUsd > 0n && widthPct < 1) widthPct = 1;

  const multiplierX = multiplierBps / 10_000;

  // ── Color palette ───────────────────────────────────────────────────
  // Emerald for upper (long the touch up), rose for lower. When FULL,
  // desaturate to white/30 — visible but inert. Mirrors the green/rose
  // toast colors in Ride.tsx so the screen reads as one design system.
  const fillColor = isFull
    ? "bg-white/30"
    : side === "upper"
      ? "bg-emerald-400/80"
      : "bg-rose-400/80";
  const trackColor =
    side === "upper" ? "bg-emerald-400/10" : "bg-rose-400/10";
  const accentText = isFull
    ? "text-white/50"
    : side === "upper"
      ? "text-emerald-300"
      : "text-rose-300";
  const sideLabel = side === "upper" ? "Upper" : "Lower";

  return (
    <div className="glass-container px-3 py-2 rounded-lg font-mono pointer-events-none select-none">
      <div className="glass-filter" />
      <div className="glass-overlay" />
      <div className="glass-specular" />
      <div className="relative z-10 leading-tight">
        {/* Header row: side label · barrier price · multiplier badge */}
        <div className="flex items-center gap-1.5 mb-1.5">
          <span
            className={`text-[9px] uppercase tracking-[0.18em] ${accentText}`}
          >
            {sideLabel}
          </span>
          <span className="text-xs font-semibold tabular-nums text-white">
            {fmtBarrier(barrierPrice)}
          </span>
          <span
            className={`ml-auto text-[9px] uppercase tracking-[0.14em] tabular-nums ${accentText}`}
          >
            {multiplierX.toFixed(2)}×
          </span>
        </div>

        {/* The bar itself — sideways, animates width + pulses on event. */}
        <div
          className={`h-1.5 w-32 rounded-full overflow-hidden ${trackColor}`}
          aria-label={`${sideLabel} barrier orderbook: ${riderCount} riders, ${fmtUsd(
            stakeMicroUsd,
          )} stake`}
        >
          <div
            className={`h-full ${fillColor} transition-[width] duration-200 ease-out`}
            style={{
              width: `${widthPct}%`,
              // Pulse: a quick opacity flash. We use opacity (cheap on the
              // compositor) rather than scale (would clip inside the
              // overflow-hidden track).
              opacity: isPulsing ? 0.55 : 1,
              transition:
                "width 200ms ease-out, opacity 200ms ease-out",
            }}
          />
        </div>

        {/* Footer row: rider count · stake total · FULL badge */}
        <div className="flex items-center justify-between text-[9px] uppercase tracking-[0.14em] mt-1">
          <span className="text-white/55 tabular-nums">
            {riderCount} {riderCount === 1 ? "rider" : "riders"}
          </span>
          {isFull ? (
            <span className="text-white/65 font-semibold tracking-[0.18em]">
              FULL
            </span>
          ) : (
            <span className="text-white/45 tabular-nums">
              {fmtUsd(stakeMicroUsd)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export default OrderbookBar;
