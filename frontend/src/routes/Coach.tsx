/**
 * /coach — a standalone preview of the CandleVision PatternCoachPanel.
 *
 * Wick Pro prices options off a live DeepBook mark; this page demonstrates
 * the same pattern-coach panel that layers onto that chart, driven here by
 * a self-contained synthetic candle stream so it always renders cold (no
 * wallet, no RPC). Drop <PatternCoachPanel candles={…}/> onto any candle
 * source to get the identical read.
 */
import { useEffect, useRef, useState } from "react";
import type { CandleInput } from "@sui-options/candle-vision";
import { PatternCoachPanel } from "@/components/PatternCoachPanel";

const MAX_CANDLES = 60;
const STEP_MS = 700;

/**
 * Deterministic-ish synthetic OHLC stream. A bounded random walk with
 * occasional momentum runs and wick spikes, which is enough for the
 * detector to surface real engulfings / dojis / pin bars over time.
 * Seeded LCG so the first frames are reproducible across reloads.
 */
function makeCandle(prevClose: number, seed: number): CandleInput {
  // LCG
  const r1 = ((seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const r2 = ((seed * 214013 + 2531011) & 0x7fffffff) / 0x7fffffff;
  const r3 = ((seed * 1664525 + 1013904223) & 0x7fffffff) / 0x7fffffff;
  const drift = (r1 - 0.48) * 2.4; // slight long bias so trends form
  const open = prevClose;
  const close = Math.max(1, open + drift);
  const bodyHigh = Math.max(open, close);
  const bodyLow = Math.min(open, close);
  const high = bodyHigh + r2 * 1.3;
  const low = bodyLow - r3 * 1.3;
  return { time: seed, open, high, low, close };
}

function useSyntheticCandles(): CandleInput[] {
  const [candles, setCandles] = useState<CandleInput[]>(() => {
    const seed0 = 7;
    const out: CandleInput[] = [];
    let price = 100;
    for (let i = 0; i < 28; i += 1) {
      const c = makeCandle(price, seed0 + i * 17);
      out.push(c);
      price = c.close;
    }
    return out;
  });
  const seedRef = useRef(7 + 28 * 17);

  useEffect(() => {
    const id = window.setInterval(() => {
      setCandles((prev) => {
        const last = prev[prev.length - 1]!;
        seedRef.current += 17;
        const next = makeCandle(last.close, seedRef.current);
        const merged = [...prev, next];
        return merged.length > MAX_CANDLES
          ? merged.slice(merged.length - MAX_CANDLES)
          : merged;
      });
    }, STEP_MS);
    return () => window.clearInterval(id);
  }, []);

  return candles;
}

/** Minimal inline candlestick chart — last N candles, no chart lib. */
function MiniCandles({ candles }: { candles: CandleInput[] }) {
  const W = 100;
  const H = 100;
  if (candles.length === 0) return null;
  const view = candles.slice(-40);
  const highs = view.map((c) => c.high);
  const lows = view.map((c) => c.low);
  const top = Math.max(...highs);
  const bot = Math.min(...lows);
  const span = Math.max(0.0001, top - bot);
  const cw = W / view.length;
  const y = (v: number) => ((top - v) / span) * (H - 6) + 3;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="h-full w-full"
      aria-hidden
    >
      {view.map((c, i) => {
        const x = i * cw + cw / 2;
        const up = c.close >= c.open;
        const color = up ? "#00ff3f" : "#ff0696";
        const bw = Math.max(1.2, cw * 0.6);
        const oy = y(c.open);
        const cyy = y(c.close);
        return (
          <g key={c.time}>
            <line
              x1={x}
              x2={x}
              y1={y(c.high)}
              y2={y(c.low)}
              stroke={color}
              strokeWidth={0.5}
              opacity={0.8}
            />
            <rect
              x={x - bw / 2}
              y={Math.min(oy, cyy)}
              width={bw}
              height={Math.max(0.8, Math.abs(cyy - oy))}
              fill={color}
            />
          </g>
        );
      })}
    </svg>
  );
}

export function Coach() {
  const candles = useSyntheticCandles();
  const last = candles[candles.length - 1];

  return (
    <div className="min-h-full w-full bg-black text-white">
      <div className="mx-auto w-full max-w-[920px] px-4 py-6 sm:px-6 sm:py-10">
        <a
          href="/pro"
          className="text-[11px] text-white/40 hover:text-white/70 transition-colors"
        >
          ← back to Wick Pro
        </a>
        <h1 className="mt-3 text-2xl sm:text-3xl font-bold tracking-tight">
          Pattern Coach
        </h1>
        <p className="mt-2 max-w-[640px] text-sm leading-relaxed text-white/55">
          The CandleVision detector reads the live tape and calls out the
          strongest candlestick setups as they form — the same panel that
          layers onto the Wick Pro DeepBook-mark chart. Demoed here on a live
          synthetic stream.
        </p>

        <div className="mt-6 grid gap-4 sm:grid-cols-[1fr_300px]">
          {/* Chart */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-[10px] uppercase tracking-[0.2em] text-white/35">
                Synthetic mark
              </span>
              <span className="font-mono tabular-nums text-sm text-white/80">
                {last ? last.close.toFixed(2) : "…"}
              </span>
            </div>
            <div className="h-[220px] sm:h-[300px] w-full">
              <MiniCandles candles={candles} />
            </div>
          </div>

          {/* Coach panel */}
          <PatternCoachPanel candles={candles} maxItems={4} />
        </div>
      </div>
    </div>
  );
}

export default Coach;
