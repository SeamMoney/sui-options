import { useMemo, useState } from "react";
import type { MarketSnapshot } from "@wick/sdk";
import { CandlestickChart, type OHLCDataPoint } from "@/components/charts/candlestick-chart";
import { Candlestick } from "@/components/charts/candlestick";
import { Grid } from "@/components/charts/grid";
import { XAxis } from "@/components/charts/x-axis";
import { YAxis } from "@/components/charts/y-axis";
import { useChart } from "@/components/charts/chart-context";
import { cn } from "@/lib/utils";

// Match kraken-prediction-market exactly.
export const INTERVALS = [
  { key: "1h",  label: "1H" },
  { key: "6h",  label: "6H" },
  { key: "1d",  label: "1D" },
  { key: "1w",  label: "1W" },
  { key: "max", label: "ALL" },
] as const;

export type IntervalKey = (typeof INTERVALS)[number]["key"];

interface IntervalSpec {
  /** Number of OHLC candles to render. */
  candles: number;
  /** Seconds per candle. */
  candleSec: number;
  /** Sub-ticks per candle when synthesizing — more ticks = realistic wicks. */
  subTicks: number;
}

const SPECS: Record<IntervalKey, IntervalSpec> = {
  "1h":  { candles: 30, candleSec: 2 * 60,        subTicks: 12 },  // ~2-min candles, 1h total
  "6h":  { candles: 36, candleSec: 10 * 60,       subTicks: 12 },  // 10-min candles, 6h total
  "1d":  { candles: 48, candleSec: 30 * 60,       subTicks: 12 },  // 30-min candles, 24h total
  "1w":  { candles: 56, candleSec: 3 * 60 * 60,   subTicks: 12 },  // 3-hour candles, 7d total
  "max": { candles: 60, candleSec: 24 * 60 * 60,  subTicks: 16 },  // 1-day candles, 60d total
};

/**
 * Synthesize OHLC candles for a market on the chosen timeframe.
 *
 * Real oracle history isn't wired yet — when it is, swap this function for a
 * query while keeping the rest of the component intact. For each candle we
 * roll a deterministic random walk through `subTicks` micro-prices and emit
 * the open/high/low/close. The final close is forced to underlyingPrice so
 * the chart agrees with the spot shown elsewhere in the UI.
 */
function syntheticOHLC(market: MarketSnapshot, spec: IntervalSpec): OHLCDataPoint[] {
  const out: OHLCDataPoint[] = [];
  const nowMs = Date.now();
  let seed = (market.id.charCodeAt(2) || 7) + spec.candles * 31;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return ((seed % 1000) - 500) / 50_000;  // ±1% per tick
  };

  // Walk forward from a price below current spot back up — gives the chart
  // a sensible drift toward the spot rather than starting at it.
  let p = Math.max(1, Math.round(market.underlyingPrice * (1 - spec.candles * 0.0008)));
  for (let i = 0; i < spec.candles; i++) {
    const open = p;
    let high = p;
    let low = p;
    for (let j = 0; j < spec.subTicks; j++) {
      p = Math.max(1, Math.round(p * (1 + rand())));
      if (p > high) high = p;
      if (p < low) low = p;
    }
    const close = p;
    const dateMs = nowMs - (spec.candles - 1 - i) * spec.candleSec * 1000;
    out.push({ date: new Date(dateMs), open, high, low, close });
  }

  // Force the most recent candle's close to the live spot so the chart and
  // header price agree, and recompute its high/low to bracket the close.
  const last = out[out.length - 1];
  if (last) {
    last.close = market.underlyingPrice;
    last.high = Math.max(last.high, last.open, last.close);
    last.low = Math.min(last.low, last.open, last.close);
  }
  return out;
}

/**
 * Horizontal reference line drawn at the market's barrier price.
 * Lives inside <CandlestickChart> so it can read xScale/yScale via context.
 */
function BarrierLine({ price, label }: { price: number; label: string }) {
  const { yScale, innerWidth } = useChart();
  const y = yScale(price);
  if (!Number.isFinite(y)) return null;
  return (
    <g pointerEvents="none">
      <line
        x1={0}
        x2={innerWidth}
        y1={y}
        y2={y}
        stroke="#f59e0b"
        strokeWidth={1}
        strokeDasharray="3 4"
      />
      <rect
        x={innerWidth - 90}
        y={y - 9}
        width={86}
        height={16}
        rx={2}
        fill="#0a0a0a"
        stroke="#f59e0b"
        strokeOpacity={0.5}
      />
      <text
        x={innerWidth - 6}
        y={y + 3}
        textAnchor="end"
        fill="#f59e0b"
        fontSize={10}
        fontFamily="Bai Jamjuree, ui-monospace, monospace"
      >
        {label} {price.toLocaleString()}
      </text>
    </g>
  );
}

interface PriceChartProps {
  market: MarketSnapshot;
}

export function PriceChart({ market }: PriceChartProps) {
  const [interval, setIntervalKey] = useState<IntervalKey>("1w");
  const data = useMemo(
    () => syntheticOHLC(market, SPECS[interval]),
    [market, interval],
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-card">
      <div className="flex h-8 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
          price · {market.asset}
        </span>
        <div className="flex items-center gap-0.5 rounded-sm border border-border bg-background/40 p-0.5">
          {INTERVALS.map((iv) => (
            <button
              key={iv.key}
              type="button"
              onClick={() => setIntervalKey(iv.key)}
              className={cn(
                "px-2 h-5 text-[10px] font-mono uppercase tracking-wider rounded-sm transition-colors",
                interval === iv.key
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {iv.label}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-muted-foreground font-mono shrink-0 tabular-nums w-28 text-right">
          spot {market.underlyingPrice.toLocaleString()}
        </span>
      </div>
      <div className="flex-1 min-h-0 px-2 py-1">
        <CandlestickChart
          data={data}
          aspectRatio="auto"
          className="h-full"
          margin={{ top: 16, right: 16, bottom: 28, left: 8 }}
          candleGap={0.3}
          animationDuration={700}
        >
          <Grid horizontal vertical={false} />
          <XAxis />
          <YAxis />
          <Candlestick />
          <BarrierLine price={market.barrier} label="barrier →" />
        </CandlestickChart>
      </div>
    </div>
  );
}
