'use client';

import type { CSSProperties } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';

type VarisChartProps = {
  className?: string;
  style?: CSSProperties;
};

type OhlcvBar = {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type VarisPoint = {
  time: UTCTimestamp;
  sessionStart: boolean;
  mid: number;
  upper1: number;
  lower1: number;
  upper2: number;
  lower2: number;
};

type HoverState = {
  x: number;
  y: number;
  values: OhlcvBar;
} | null;

const REF = {
  symbol: 'MNQ1!',
  exchange: 'CME',
  interval: '5',
  price: 29330.38,
  selectedTime: `Thu 14 May '26 14:55`,
};

const PRICE_MARKERS = [
  { price: 29579.63, color: '#080808' },
  { price: 29537.73, color: '#080808' },
  { price: 29456.13, color: '#080808' },
  { price: 29330.38, color: '#ff443f' },
  { price: 29231.0, color: '#ffffff', textColor: '#111111' },
  { price: 29204.63, color: '#080808' },
  { price: 29081.13, color: '#080808' },
];

const TREND = [
  [0, 29618],
  [36, 29578],
  [72, 29592],
  [108, 29542],
  [132, 29618],
  [154, 29772],
  [178, 29642],
  [218, 29696],
  [249, 29628],
  [281, 29517],
  [315, 29467],
  [352, 29272],
  [382, 29420],
  [411, 29255],
  [447, 29150],
  [481, 29340],
  [512, 29268],
  [549, 29320],
  [586, 29455],
  [616, 29382],
  [652, 29231],
  [690, 29288],
  [735, 29476],
  [768, 29370],
  [810, 29318],
] as const;

const REAL_VARIS = {
  // Extracted from the TradingView layout JSON for the original page.
  band1Points: 125.75,
  band2Points: 249.25,
  vwapColor: 'rgba(255,0,0,0.9)',
  fill1Color: 'rgba(255,255,255,.30)', // Pine color.white with transparency 70.
  fill2Color: 'rgba(0,0,0,.10)', // Pine color.black with transparency 90.
  resetUtcHour: 22, // Pine hour == 17 in New York around the May 2026 reference.
  resetMinute: 0,
};

const INITIAL_VISIBLE_RANGE = {
  from: 168,
  to: 656,
};

function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function trendAt(i: number) {
  for (let a = 0; a < TREND.length - 1; a += 1) {
    const [x0, y0] = TREND[a];
    const [x1, y1] = TREND[a + 1];
    if (i >= x0 && i <= x1) return lerp(y0, y1, (i - x0) / Math.max(1, x1 - x0));
  }
  return TREND[TREND.length - 1][1];
}

function makeReferenceBars(): OhlcvBar[] {
  const rand = seeded(3907);
  const total = 840;
  const start = Math.floor(Date.UTC(2026, 4, 13, 17, 0) / 1000) as UTCTimestamp;
  const bars: OhlcvBar[] = [];
  let previous = trendAt(0);

  for (let i = 0; i < total; i += 1) {
    const target = trendAt(i);
    const volatility =
      i > 132 && i < 178 ? 36 :
      i > 352 && i < 416 ? 42 :
      i > 481 && i < 535 ? 55 :
      i > 690 && i < 760 ? 34 :
      17;
    const drift = Math.sin(i / 8.5) * 6 + Math.cos(i / 29) * 8;
    const open = previous + (rand() - 0.5) * volatility * 0.75;
    const close = target + drift + (rand() - 0.5) * volatility;
    const wick = 14 + rand() * volatility * 0.9;
    let volume = 3500 + rand() * 9000;

    if (i > 132 && i < 162) volume += (162 - Math.abs(147 - i)) * 5200;
    if (i > 468 && i < 528) volume += (528 - Math.abs(498 - i)) * 8200;
    if (i > 622 && i < 656) volume += (i - 621) * 3600;
    if (i > 690 && i < 735) volume += (735 - i) * 2100;

    bars.push({
      time: (start + i * 5 * 60) as UTCTimestamp,
      open,
      close,
      high: Math.max(open, close) + wick * (0.45 + rand()),
      low: Math.min(open, close) - wick * (0.45 + rand()),
      volume,
    });
    previous = close;
  }

  bars[260] = { time: bars[260].time, open: 29692, high: 29724, low: 29662, close: 29702, volume: 13900 };
  bars[497] = { time: bars[497].time, open: 29192, high: 29332, low: 29092, close: 29278, volume: 83800 };
  bars[498] = { time: bars[498].time, open: 29280, high: 29370, low: 29078, close: 29328, volume: 62900 };
  bars[652] = { time: bars[652].time, open: 29298, high: 29318, low: 29220, close: 29231, volume: 31020 };
  return bars;
}

function computeVarisZones(bars: OhlcvBar[]): VarisPoint[] {
  let cumTPV = 0;
  let cumVol = 0;
  return bars.map((bar) => {
    const date = new Date(Number(bar.time) * 1000);
    const isNewSession = date.getUTCHours() === REAL_VARIS.resetUtcHour && date.getUTCMinutes() === REAL_VARIS.resetMinute;
    const typical = (bar.high + bar.low + bar.close) / 3;
    if (isNewSession || cumVol === 0) {
      cumTPV = typical * bar.volume;
      cumVol = bar.volume;
    } else {
      cumTPV += typical * bar.volume;
      cumVol += bar.volume;
    }
    const mid = cumVol !== 0 ? cumTPV / cumVol : typical;
    return {
      time: bar.time,
      sessionStart: isNewSession || cumVol === bar.volume,
      mid,
      upper1: mid + REAL_VARIS.band1Points,
      lower1: mid - REAL_VARIS.band1Points,
      upper2: mid + REAL_VARIS.band2Points,
      lower2: mid - REAL_VARIS.band2Points,
    };
  });
}

class VarisZonesPrimitive {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<'Candlestick'> | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly paneView = {
    zOrder: () => 'bottom' as const,
    renderer: () => ({
      draw: (target: any) => {
        target.useMediaCoordinateSpace(({ context }: { context: CanvasRenderingContext2D }) => this.draw(context));
      },
    }),
  };

  constructor(private readonly points: VarisPoint[]) {}

  attached(param: any) {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached() {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  paneViews() {
    return [this.paneView];
  }

  updateAllViews() {
    this.requestUpdate?.();
  }

  autoscaleInfo(start: number, end: number) {
    const visible = this.points.slice(Math.max(0, Math.floor(start)), Math.min(this.points.length, Math.ceil(end) + 1));
    if (visible.length === 0) return null;
    const lows = visible.map((p) => p.lower2);
    const highs = visible.map((p) => p.upper2);
    return {
      priceRange: {
        minValue: Math.min(...lows),
        maxValue: Math.max(...highs),
      },
      margins: { above: 0.03, below: 0.16 },
    };
  }

  private coordinate(time: Time, price: number) {
    if (!this.chart || !this.series) return null;
    const x = this.chart.timeScale().timeToCoordinate(time);
    const y = this.series.priceToCoordinate(price);
    if (x == null || y == null) return null;
    return { x, y };
  }

  private segments() {
    const out: VarisPoint[][] = [];
    let current: VarisPoint[] = [];
    for (const point of this.points) {
      if (point.sessionStart && current.length) {
        out.push(current);
        current = [];
      }
      current.push(point);
    }
    if (current.length) out.push(current);
    return out;
  }

  private drawBand(ctx: CanvasRenderingContext2D, upperKey: keyof VarisPoint, lowerKey: keyof VarisPoint, fill: string) {
    for (const segment of this.segments()) {
      const upper = segment
        .map((p) => this.coordinate(p.time, p[upperKey] as number))
        .filter(Boolean) as Array<{ x: number; y: number }>;
      const lower = segment
        .map((p) => this.coordinate(p.time, p[lowerKey] as number))
        .filter(Boolean) as Array<{ x: number; y: number }>;
      if (upper.length < 2 || lower.length < 2) continue;

      ctx.beginPath();
      upper.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      lower.slice().reverse().forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    }
  }

  private drawMidline(ctx: CanvasRenderingContext2D) {
    ctx.strokeStyle = '#ff4c42';
    ctx.lineWidth = 1.15;
    for (const segment of this.segments()) {
      const points = segment
        .map((p) => this.coordinate(p.time, p.mid))
        .filter(Boolean) as Array<{ x: number; y: number }>;
      if (points.length < 2) continue;
      ctx.beginPath();
      points.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
    }
  }

  private draw(ctx: CanvasRenderingContext2D) {
    ctx.save();
    this.drawBand(ctx, 'upper2', 'lower2', REAL_VARIS.fill2Color);
    this.drawBand(ctx, 'upper1', 'lower1', REAL_VARIS.fill1Color);
    this.drawMidline(ctx);
    ctx.restore();
  }
}

export function TradingViewVarisChart({ className, style }: VarisChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [hover, setHover] = useState<HoverState>(null);
  const bars = useMemo(makeReferenceBars, []);
  const zones = useMemo(() => computeVarisZones(bars), [bars]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#c3beb6' },
        textColor: '#000000',
        fontFamily: 'Arial, Helvetica, sans-serif',
        fontSize: 13,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,.28)', style: LineStyle.Dashed },
        horzLines: { color: 'rgba(255,255,255,.28)', style: LineStyle.Dashed },
      },
      crosshair: {
        mode: 0,
        vertLine: { color: 'rgba(118,116,110,.45)', style: LineStyle.Dashed, labelBackgroundColor: '#101010' },
        horzLine: { color: 'rgba(118,116,110,.45)', style: LineStyle.Dashed, labelBackgroundColor: '#101010' },
      },
      rightPriceScale: {
        borderColor: '#191919',
        entireTextOnly: true,
        scaleMargins: { top: 0.03, bottom: 0.14 },
      },
      timeScale: {
        borderColor: '#99978f',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 7.812002000000007,
        barSpacing: 4.372530488394797,
        minBarSpacing: 2.5,
        tickMarkFormatter: (time: Time) => {
          const date = new Date(Number(time) * 1000);
          const hours = date.getUTCHours().toString().padStart(2, '0');
          const mins = date.getUTCMinutes().toString().padStart(2, '0');
          return hours === '00' && mins === '00' ? date.getUTCDate().toString() : `${hours}:${mins}`;
        },
      },
      localization: {
        priceFormatter: (price: number) => price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        timeFormatter: (time: Time) => {
          const date = new Date(Number(time) * 1000);
          return date.toUTCString().replace('GMT', 'UTC');
        },
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      upColor: 'rgba(255,255,255,1)',
      downColor: 'rgba(74,74,74,1)',
      borderUpColor: 'rgba(0,0,0,1)',
      borderDownColor: 'rgba(0,0,0,1)',
      wickUpColor: 'rgba(0,0,0,1)',
      wickDownColor: 'rgba(0,0,0,1)',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    candleSeries.setData(bars.map((b): CandlestickData => ({
      time: b.time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    })));

    const primitive = new VarisZonesPrimitive(zones);
    candleSeries.attachPrimitive(primitive as any);

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: '',
      color: '#5b79bd',
      priceFormat: { type: 'volume' },
      lastValueVisible: true,
      priceLineVisible: false,
      base: 0,
    });
    volumeSeries.setData(bars.map((b): HistogramData => ({
      time: b.time,
      value: b.volume,
      color: 'rgba(80,116,189,.72)',
    })));
    chart.priceScale('').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    const midlineSeries = chart.addSeries(LineSeries, {
      color: '#ff4c42',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    midlineSeries.setData(zones.map((p): LineData => ({ time: p.time, value: p.mid })));

    PRICE_MARKERS.forEach((marker) => {
      candleSeries.createPriceLine({
        price: marker.price,
        color: marker.color,
        lineWidth: 1,
        lineVisible: marker.price === REF.price,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: '',
      });
    });

    chart.timeScale().setVisibleLogicalRange(INITIAL_VISIBLE_RANGE);
    chart.priceScale('right').setVisibleRange({ from: 28850, to: 29925 });

    chart.subscribeCrosshairMove((param) => {
      if (!param.point || param.time == null) {
        setHover(null);
        return;
      }
      const idx = bars.findIndex((b) => b.time === param.time);
      const values = idx >= 0 ? bars[idx] : null;
      setHover(values ? { x: param.point.x, y: param.point.y, values } : null);
    });

    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [bars, zones]);

  const last = bars[bars.length - 1];
  return (
    <div
      className={className}
      style={{
        width: '100%',
        height: '100%',
        minHeight: 420,
        position: 'relative',
        overflow: 'hidden',
        background: '#bebcb5',
        fontFamily: 'Arial, Helvetica, sans-serif',
        fontVariantNumeric: 'tabular-nums',
        ...style,
      }}
    >
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      <LegendOverlay hover={hover} last={last} />
      <div
        style={{
          position: 'absolute',
          right: 8,
          top: 8,
          padding: '6px 9px',
          borderRadius: 5,
          border: '1px solid rgba(0,0,0,.14)',
          background: '#f4f4f4',
          color: '#333',
          fontSize: 14,
          pointerEvents: 'none',
        }}
      >
        USD
      </div>
      <div
        style={{
          position: 'absolute',
          left: 8,
          bottom: 10,
          color: '#111',
          fontSize: 22,
          fontWeight: 800,
          textShadow: '0 1px 0 #fff, 1px 0 0 #fff, -1px 0 0 #fff, 0 -1px 0 #fff',
          pointerEvents: 'none',
        }}
      >
        TradingView
      </div>
      <div
        style={{
          position: 'absolute',
          left: 18,
          bottom: 8,
          width: 126,
          height: 32,
          borderRadius: 16,
          background: '#d7484d',
          border: '1px solid #a71924',
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 9,
          fontSize: 13,
          fontWeight: 700,
          boxShadow: '0 2px 6px rgba(0,0,0,.18)',
          pointerEvents: 'none',
          transform: 'translateY(42px)',
        }}
      >
        <span style={{ fontSize: 18, fontWeight: 400 }}>N`</span>
        <span>3 Issues</span>
        <span style={{ fontSize: 17, fontWeight: 400 }}>×</span>
      </div>
    </div>
  );
}

function LegendOverlay({ hover, last }: { hover: HoverState; last: OhlcvBar }) {
  const value = hover?.values ?? last;
  return (
    <div
      style={{
        position: 'absolute',
        top: 10,
        left: 12,
        display: 'grid',
        gap: 8,
        color: '#191919',
        fontSize: 15,
        lineHeight: 1,
        pointerEvents: 'none',
        textShadow: '0 1px 0 rgba(255,255,255,.2)',
      }}
    >
      <div>
        <span>🇺🇸 {REF.symbol} · {REF.interval} · {REF.exchange}&nbsp;</span>
        <span>O{value.open.toLocaleString(undefined, { maximumFractionDigits: 2 })} </span>
        <span>H{value.high.toLocaleString(undefined, { maximumFractionDigits: 2 })} </span>
        <span>L{value.low.toLocaleString(undefined, { maximumFractionDigits: 2 })} </span>
        <span>C{value.close.toLocaleString(undefined, { maximumFractionDigits: 2 })} </span>
        <span>+10.75 (+0.04%) Vol13.15K</span>
      </div>
      <div>
        <span>Vol&nbsp;</span>
        <span style={{ color: '#315dc4' }}>13.15K</span>
      </div>
      <div>
        <span>VARIS Zones&nbsp;</span>
        <span style={{ color: '#ff3f39' }}>29,637.10&nbsp;</span>
        <span>29,762.85&nbsp; 29,511.35&nbsp; 29,886.35&nbsp; 29,387.85</span>
      </div>
      <div
        style={{
          width: 28,
          height: 24,
          border: '1px solid rgba(0,0,0,.14)',
          borderRadius: 3,
          display: 'grid',
          placeItems: 'center',
          color: '#333',
          background: 'rgba(255,255,255,.08)',
        }}
      >
        ⌃
      </div>
    </div>
  );
}
