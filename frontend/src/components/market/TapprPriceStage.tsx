import { useMemo, useState } from "react";
import type { MarketSnapshot } from "@/fixtures/markets";
import { cn } from "@/lib/utils";

const VIEW_W = 1200;
const VIEW_H = 620;
const CHART_TOP = 24;
const PRICE_BOTTOM = 558;
const PRICE_H = PRICE_BOTTOM - CHART_TOP;
const SPOT_X = 840;
const HISTORY_MS = 30_000;

interface PriceTick {
  t: number;
  p: number;
}

function seededTicks(market: MarketSnapshot): PriceTick[] {
  const now = Date.now();
  let seed =
    market.id.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 19) +
    market.underlyingPrice;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return ((seed % 1000) - 500) / 500;
  };

  const ticks: PriceTick[] = [];
  let price = Math.max(1, market.underlyingPrice * 0.992);
  for (let i = 150; i >= 0; i--) {
    const burst = seed % 17 === 0 ? 0.0028 : 0.0009;
    const meanReversion = (market.underlyingPrice - price) / market.underlyingPrice * 0.06;
    price = Math.max(1, price * (1 + rand() * burst + meanReversion));
    ticks.push({
      t: now - i * 200,
      p: price,
    });
  }
  const last = ticks[ticks.length - 1];
  if (last) last.p = market.underlyingPrice;
  return ticks;
}

function fmt(price: number): string {
  return price.toLocaleString(undefined, {
    minimumFractionDigits: price >= 1000 ? 0 : 2,
    maximumFractionDigits: price >= 1000 ? 0 : 4,
  });
}

interface TapprPriceStageProps {
  market: MarketSnapshot;
}

export function TapprPriceStage({ market }: TapprPriceStageProps) {
  const [hovered, setHovered] = useState(false);
  const ticks = useMemo(() => seededTicks(market), [market]);
  const spot = market.underlyingPrice;

  const { yMin, yMax, points, areaPath, barrierY, spotY } = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const tick of ticks) {
      lo = Math.min(lo, tick.p);
      hi = Math.max(hi, tick.p);
    }
    lo = Math.min(lo, market.barrier, spot);
    hi = Math.max(hi, market.barrier, spot);
    const center = (lo + hi) / 2;
    const halfRange = Math.max((hi - lo) / 2, center * 0.0014);
    const min = center - halfRange * 1.55;
    const max = center + halfRange * 1.55;
    const now = ticks[ticks.length - 1]?.t ?? Date.now();
    const xFor = (t: number) => SPOT_X - ((now - t) / HISTORY_MS) * SPOT_X;
    const yFor = (p: number) =>
      CHART_TOP + ((max - p) / (max - min)) * PRICE_H;
    const pts = ticks
      .map((tick) => `${xFor(tick.t).toFixed(1)},${yFor(tick.p).toFixed(1)}`)
      .join(" ");
    const first = ticks[0];
    const last = ticks[ticks.length - 1];
    return {
      yMin: min,
      yMax: max,
      points: pts,
      areaPath:
        first && last
          ? `M ${xFor(first.t).toFixed(1)},${PRICE_BOTTOM} L ${pts.replaceAll(" ", " L ")} L ${xFor(last.t).toFixed(1)},${PRICE_BOTTOM} Z`
          : "",
      barrierY: yFor(market.barrier),
      spotY: yFor(spot),
    };
  }, [market.barrier, spot, ticks]);

  const bandY = Math.min(barrierY, spotY);
  const bandH = Math.max(2, Math.abs(barrierY - spotY));
  const isAbove = market.direction === "ABOVE";

  return (
    <div
      className="relative min-h-[520px] overflow-hidden rounded-lg border border-border bg-card/35"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="absolute inset-0 wick-grid-bg opacity-60" />
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="relative block size-full min-h-[520px] select-none"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${market.asset} price chart`}
      >
        {Array.from({ length: 4 }).map((_, i) => {
          const y = CHART_TOP + (PRICE_H / 4) * (i + 1);
          return (
            <line
              key={`h-${i}`}
              x1={0}
              x2={VIEW_W}
              y1={y}
              y2={y}
              className="stroke-white/[0.055]"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
        {Array.from({ length: 13 }).map((_, i) => {
          const x = (VIEW_W / 13) * (i + 1);
          return (
            <line
              key={`v-${i}`}
              x1={x}
              x2={x}
              y1={CHART_TOP}
              y2={PRICE_BOTTOM}
              className="stroke-white/[0.04]"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}

        <rect
          x={0}
          y={bandY}
          width={VIEW_W}
          height={bandH}
          className={isAbove ? "fill-emerald-400/[0.055]" : "fill-rose-400/[0.055]"}
        />

        {areaPath ? <path d={areaPath} className="fill-sky-400/10" /> : null}
        {points ? (
          <polyline
            points={points}
            fill="none"
            className="stroke-sky-400"
            strokeWidth={2.8}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}

        <line
          x1={0}
          x2={VIEW_W}
          y1={barrierY}
          y2={barrierY}
          className={cn(isAbove ? "stroke-emerald-400/55" : "stroke-rose-400/55")}
          strokeWidth={1.4}
          strokeDasharray="4 6"
          vectorEffect="non-scaling-stroke"
        />
        <line
          x1={0}
          x2={VIEW_W}
          y1={spotY}
          y2={spotY}
          className="stroke-sky-400/40"
          strokeWidth={1.2}
          strokeDasharray="2 4"
          vectorEffect="non-scaling-stroke"
        />
        <line
          x1={SPOT_X}
          x2={SPOT_X}
          y1={CHART_TOP}
          y2={PRICE_BOTTOM}
          className="stroke-sky-400/25"
          strokeWidth={1}
          strokeDasharray="2 6"
          vectorEffect="non-scaling-stroke"
        />

        <circle cx={SPOT_X} cy={spotY} r={5.5} className="fill-sky-400" />
        <circle cx={SPOT_X} cy={spotY} r={2.5} className="fill-background" />

        <rect
          x={SPOT_X - 94}
          y={spotY - 14}
          width={84}
          height={26}
          rx={5}
          className={cn(
            "stroke-sky-300/60",
            hovered ? "fill-sky-400/25" : "fill-sky-400/18",
          )}
          vectorEffect="non-scaling-stroke"
        />
        <text
          x={SPOT_X - 16}
          y={spotY + 4}
          textAnchor="end"
          className="fill-white font-mono text-[13px] font-bold"
        >
          {fmt(spot)}
        </text>

        <rect
          x={VIEW_W - 178}
          y={barrierY - 14}
          width={164}
          height={28}
          rx={5}
          className="fill-background/80 stroke-white/10"
          vectorEffect="non-scaling-stroke"
        />
        <text
          x={VIEW_W - 96}
          y={barrierY + 5}
          textAnchor="middle"
          className={cn(
            "font-mono text-[13px] font-semibold",
            isAbove ? "fill-emerald-300" : "fill-rose-300",
          )}
        >
          barrier {market.direction === "ABOVE" ? "↑" : "↓"} {fmt(market.barrier)}
        </text>

        <text x={18} y={32} className="fill-muted-foreground font-mono text-[11px]">
          PRICE · {market.asset}
        </text>
        <text
          x={VIEW_W - 18}
          y={32}
          textAnchor="end"
          className="fill-muted-foreground font-mono text-[11px]"
        >
          spot {fmt(spot)}
        </text>
        <text x={18} y={PRICE_BOTTOM + 34} className="fill-muted-foreground font-mono text-[11px]">
          {fmt(yMin)}
        </text>
        <text
          x={VIEW_W - 18}
          y={PRICE_BOTTOM + 34}
          textAnchor="end"
          className="fill-muted-foreground font-mono text-[11px]"
        >
          {fmt(yMax)}
        </text>
      </svg>

      <div className="pointer-events-none absolute bottom-4 right-5 hidden rounded-full border border-border bg-background/70 px-3 py-1 font-mono text-[10px] uppercase text-muted-foreground md:block">
        choose stake below
      </div>
    </div>
  );
}

export default TapprPriceStage;
