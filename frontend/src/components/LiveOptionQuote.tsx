/**
 * LiveOptionQuote — a live Black-Scholes quote priced off the DeepBook mark.
 *
 * This is the Wick Pro thesis in one card: take the real SUI/USDC (or DEEP/USDC)
 * DeepBook mid as the spot, the realised σ from the live candle series, and run
 * the same `@sui-options/pro-options` Black-Scholes engine the game uses to show
 * a live CALL/PUT premium + delta for an ATM option at a chosen expiry.
 *
 * Self-contained (owns its data via useDeepBookMark + useDeepBookCandles), so it
 * drops into /coach or the Wick Pro desk with one line. Premiums are shown in
 * basis points of spot — the standard, readable unit for short-dated options on
 * a sub-dollar underlying.
 */
import { quote, yearsFromSeconds } from "@sui-options/pro-options";
import { useDeepBookMark } from "@/hooks/useDeepBookMark";
import { useDeepBookCandles } from "@/hooks/useDeepBookCandles";
import { DEEPBOOK_POOLS, type DeepBookPoolName } from "@/lib/deepbook";

export interface LiveOptionQuoteProps {
  readonly pool?: DeepBookPoolName;
  /** Option tenor in seconds (default 5 minutes). */
  readonly expirySecs?: number;
}

function Side({
  label,
  color,
  premiumBps,
  delta,
  live,
}: {
  label: string;
  color: string;
  premiumBps: number;
  delta: number;
  live: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className={`text-sm font-semibold ${color}`}>{label}</span>
      <span className="flex items-baseline gap-3 font-mono tabular-nums">
        <span className="text-white/85 text-sm">
          {live ? `${premiumBps.toFixed(1)} bps` : "—"}
        </span>
        <span className="text-white/40 text-[11px]">
          Δ {live ? delta.toFixed(2) : "—"}
        </span>
      </span>
    </div>
  );
}

export function LiveOptionQuote({
  pool = "SUI_USDC",
  expirySecs = 300,
}: LiveOptionQuoteProps) {
  const { mark, status } = useDeepBookMark(pool, 2_000);
  const { sigma } = useDeepBookCandles(pool, {
    bucketMs: 60_000,
    windowMs: 60 * 60_000,
    pollMs: 5_000,
  });

  const spot = mark?.mid ?? 0;
  const live = status === "live" && spot > 0;
  const tauYears = yearsFromSeconds(expirySecs);
  const call = live
    ? quote({ spot, strike: spot, tauYears, sigma, side: "call" })
    : null;
  const put = live
    ? quote({ spot, strike: spot, tauYears, sigma, side: "put" })
    : null;
  const toBps = (premium: number) => (spot > 0 ? (premium / spot) * 10_000 : 0);

  const mins = expirySecs >= 60 ? `${Math.round(expirySecs / 60)}m` : `${expirySecs}s`;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 font-sans">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[0.2em] text-white/35">
          Live option · {DEEPBOOK_POOLS[pool].label} · {mins} ATM
        </span>
        <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-white/35">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              live ? "bg-emerald-400" : "bg-white/30"
            }`}
            aria-hidden
          />
          {live ? "live" : status}
        </span>
      </div>

      <div className="mb-3 flex items-baseline gap-4">
        <span className="font-mono tabular-nums text-2xl font-bold text-white">
          {live ? `$${spot.toFixed(4)}` : "—"}
        </span>
        <span className="font-mono text-[11px] text-white/45">
          σ {live ? `${(sigma * 100).toFixed(0)}%` : "—"}
        </span>
      </div>

      <div className="divide-y divide-white/5">
        <Side
          label="CALL"
          color="text-emerald-400"
          premiumBps={call ? toBps(call.premium) : 0}
          delta={call ? call.greeks.delta : 0}
          live={live}
        />
        <Side
          label="PUT"
          color="text-rose-400"
          premiumBps={put ? toBps(put.premium) : 0}
          delta={put ? put.greeks.delta : 0}
          live={live}
        />
      </div>

      <p className="mt-3 text-[10px] leading-snug text-white/30">
        Black-Scholes premium off the live DeepBook mid, σ from the live tape —
        the same engine Wick Pro settles against.
      </p>
    </div>
  );
}

export default LiveOptionQuote;
