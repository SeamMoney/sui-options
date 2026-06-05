'use client';

/**
 * LegendChart — interactive, dark-themed candlestick chart for the Legend page.
 * Replaces the static TradingView <img> with a real lightweight-charts chart
 * carrying the same indicators it showed: Ichimoku Cloud (Tenkan / Kijun /
 * Senkou A·B + filled cloud / Chikou), KRI(14) in a sub-pane, and volume.
 *
 * Chart skeleton + cloud-primitive technique adapted from TradingViewVarisChart.
 */
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

type Bar = { time: UTCTimestamp; open: number; high: number; low: number; close: number; volume: number };

const DT = 300; // 5-minute bars
const SHIFT = 26;

const C = {
  bg: '#0b0b0d',
  text: '#cfcfd4',
  grid: 'rgba(255,255,255,.045)',
  up: '#1ed760',
  down: '#ff5247',
  tenkan: '#2962ff',
  kijun: '#ff6d00',
  chikou: '#9ccc65',
  senkouA: '#26a69a',
  senkouB: '#ef5350',
  cloudUp: 'rgba(38,166,154,.16)',
  cloudDown: 'rgba(239,83,80,.16)',
  kri: '#b39ddb',
  volume: 'rgba(91,121,189,.5)',
};

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function makeBars(): Bar[] {
  const rand = seeded(0xbada55);
  const total = 320;
  const start = Math.floor(Date.UTC(2026, 4, 18, 13, 30) / 1000) as UTCTimestamp;
  const bars: Bar[] = [];
  let close = 29320;
  let drift = -4;
  let vol = 22;
  for (let i = 0; i < total; i += 1) {
    if (i === 0 || rand() < 0.05) {
      drift = (rand() - 0.5) * 14;
      vol = 12 + rand() * 40;
    }
    const open = close + (rand() - 0.5) * vol * 0.4;
    close = open + drift + (rand() - 0.5) * vol;
    const wick = 4 + rand() * vol * 0.8;
    bars.push({
      time: (start + i * DT) as UTCTimestamp,
      open,
      close,
      high: Math.max(open, close) + wick * (0.4 + rand()),
      low: Math.min(open, close) - wick * (0.4 + rand()),
      volume: 3000 + rand() * 9000,
    });
  }
  return bars;
}

function midHL(bars: Bar[], i: number, period: number): number | null {
  if (i < period - 1) return null;
  let h = -Infinity;
  let l = Infinity;
  for (let k = i - period + 1; k <= i; k += 1) {
    if (bars[k].high > h) h = bars[k].high;
    if (bars[k].low < l) l = bars[k].low;
  }
  return (h + l) / 2;
}

type Ichimoku = {
  tenkan: LineData[];
  kijun: LineData[];
  chikou: LineData[];
  senkouA: LineData[];
  senkouB: LineData[];
  cloud: Array<{ time: UTCTimestamp; a: number; b: number }>;
  last: { tenkan: number; kijun: number; senkouA: number; senkouB: number; chikou: number };
};

function ichimoku(bars: Bar[]): Ichimoku {
  const n = bars.length;
  const tenkanRaw: Array<number | null> = [];
  const kijunRaw: Array<number | null> = [];
  for (let i = 0; i < n; i += 1) {
    tenkanRaw.push(midHL(bars, i, 9));
    kijunRaw.push(midHL(bars, i, 26));
  }
  const tenkan: LineData[] = [];
  const kijun: LineData[] = [];
  const chikou: LineData[] = [];
  const senkouA: LineData[] = [];
  const senkouB: LineData[] = [];
  const cloud: Array<{ time: UTCTimestamp; a: number; b: number }> = [];

  for (let i = 0; i < n; i += 1) {
    if (tenkanRaw[i] != null) tenkan.push({ time: bars[i].time, value: tenkanRaw[i] as number });
    if (kijunRaw[i] != null) kijun.push({ time: bars[i].time, value: kijunRaw[i] as number });
    // Chikou: close plotted 26 bars back.
    if (i + SHIFT < n) chikou.push({ time: bars[i].time, value: bars[i + SHIFT].close });
    // Senkou A/B: plotted 26 bars FORWARD (cloud extends past the last candle).
    const fwdTime = (Number(bars[i].time) + SHIFT * DT) as UTCTimestamp;
    if (tenkanRaw[i] != null && kijunRaw[i] != null) {
      const a = ((tenkanRaw[i] as number) + (kijunRaw[i] as number)) / 2;
      senkouA.push({ time: fwdTime, value: a });
      const bMid = midHL(bars, i, 52);
      if (bMid != null) {
        senkouB.push({ time: fwdTime, value: bMid });
        cloud.push({ time: fwdTime, a, b: bMid });
      }
    }
  }

  const li = n - 1;
  return {
    tenkan, kijun, chikou, senkouA, senkouB, cloud,
    last: {
      tenkan: (tenkanRaw[li] as number) ?? 0,
      kijun: (kijunRaw[li] as number) ?? 0,
      senkouA: senkouA.length ? senkouA[senkouA.length - 1].value as number : 0,
      senkouB: senkouB.length ? senkouB[senkouB.length - 1].value as number : 0,
      chikou: chikou.length ? chikou[chikou.length - 1].value as number : 0,
    },
  };
}

function kri14(bars: Bar[]): { line: LineData[]; last: number } {
  const p = 14;
  const line: LineData[] = [];
  for (let i = 0; i < bars.length; i += 1) {
    if (i < p - 1) continue;
    let sum = 0;
    for (let k = i - p + 1; k <= i; k += 1) sum += bars[k].close;
    const sma = sum / p;
    line.push({ time: bars[i].time, value: ((bars[i].close - sma) / sma) * 100 });
  }
  return { line, last: line.length ? (line[line.length - 1].value as number) : 0 };
}

/** Fills the Ichimoku cloud between Senkou A and B on a canvas primitive. */
class CloudPrimitive {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<'Candlestick'> | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly paneView = {
    zOrder: () => 'bottom' as const,
    renderer: () => ({
      draw: (target: any) =>
        target.useMediaCoordinateSpace(({ context }: { context: CanvasRenderingContext2D }) => this.draw(context)),
    }),
  };
  constructor(private cloud: Array<{ time: UTCTimestamp; a: number; b: number }>) {}
  setCloud(cloud: Array<{ time: UTCTimestamp; a: number; b: number }>) { this.cloud = cloud; this.requestUpdate?.(); }
  attached(p: any) { this.chart = p.chart; this.series = p.series; this.requestUpdate = p.requestUpdate; }
  detached() { this.chart = null; this.series = null; this.requestUpdate = null; }
  paneViews() { return [this.paneView]; }
  updateAllViews() { this.requestUpdate?.(); }
  private xy(time: Time, price: number) {
    if (!this.chart || !this.series) return null;
    const x = this.chart.timeScale().timeToCoordinate(time);
    const y = this.series.priceToCoordinate(price);
    return x == null || y == null ? null : { x, y };
  }
  private draw(ctx: CanvasRenderingContext2D) {
    if (this.cloud.length < 2) return;
    ctx.save();
    // Split into segments of constant sign (A above B vs below) for color.
    let seg: Array<{ time: UTCTimestamp; a: number; b: number }> = [];
    const flush = () => {
      if (seg.length < 2) { seg = []; return; }
      const aPts = seg.map((p) => this.xy(p.time, p.a)).filter(Boolean) as Array<{ x: number; y: number }>;
      const bPts = seg.map((p) => this.xy(p.time, p.b)).filter(Boolean) as Array<{ x: number; y: number }>;
      if (aPts.length < 2 || bPts.length < 2) { seg = []; return; }
      ctx.beginPath();
      aPts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      bPts.slice().reverse().forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fillStyle = seg[0].a >= seg[0].b ? C.cloudUp : C.cloudDown;
      ctx.fill();
      seg = [];
    };
    let sign: boolean | null = null;
    for (const p of this.cloud) {
      const s = p.a >= p.b;
      if (sign !== null && s !== sign) { flush(); }
      sign = s;
      seg.push(p);
    }
    flush();
    ctx.restore();
  }
}

const lineOpts = (color: string, width = 1) => ({
  color, lineWidth: width as 1 | 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
});

export function LegendChart() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const initialBars = useMemo(makeBars, []);
  const initialState = useMemo(() => {
    const i = ichimoku(initialBars);
    const k = kri14(initialBars);
    return { ichi: i.last, kri: k.last, bar: initialBars[initialBars.length - 1] };
  }, [initialBars]);
  const [stream, setStream] = useState(initialState);
  const [hover, setHover] = useState<Bar | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const bars: Bar[] = initialBars.map((b) => ({ ...b }));
    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: C.bg },
        textColor: C.text,
        fontFamily: 'Inter, Arial, sans-serif',
        fontSize: 12,
        attributionLogo: false,
        panes: { separatorColor: 'rgba(255,255,255,.08)', separatorHoverColor: 'rgba(255,255,255,.14)' },
      },
      grid: { vertLines: { color: C.grid, style: LineStyle.Solid }, horzLines: { color: C.grid, style: LineStyle.Solid } },
      crosshair: {
        mode: 0,
        vertLine: { color: 'rgba(148,163,184,.4)', style: LineStyle.Dashed, labelBackgroundColor: '#1c1c1f' },
        horzLine: { color: 'rgba(148,163,184,.4)', style: LineStyle.Dashed, labelBackgroundColor: '#1c1c1f' },
      },
      rightPriceScale: { borderColor: 'rgba(255,255,255,.08)', scaleMargins: { top: 0.06, bottom: 0.26 } },
      timeScale: {
        borderColor: 'rgba(255,255,255,.08)', timeVisible: true, secondsVisible: false, barSpacing: 7, rightOffset: 28,
        tickMarkFormatter: (t: Time) => {
          const d = new Date(Number(t) * 1000);
          return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
        },
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: C.up, downColor: C.down, borderUpColor: C.up, borderDownColor: C.down,
      wickUpColor: C.up, wickDownColor: C.down, priceLineVisible: false, lastValueVisible: true,
    });
    candles.setData(bars.map((b): CandlestickData => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })));

    const cloud = new CloudPrimitive(ichimoku(bars).cloud);
    candles.attachPrimitive(cloud as any);

    const senkouA = chart.addSeries(LineSeries, lineOpts(C.senkouA));
    const senkouB = chart.addSeries(LineSeries, lineOpts(C.senkouB));
    const tenkan = chart.addSeries(LineSeries, lineOpts(C.tenkan));
    const kijun = chart.addSeries(LineSeries, lineOpts(C.kijun));
    const chikou = chart.addSeries(LineSeries, { ...lineOpts(C.chikou), lineStyle: LineStyle.Dotted });

    const vol = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    vol.setData(bars.map((b): HistogramData => ({ time: b.time, value: b.volume, color: C.volume })));
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });

    const kriSeries = chart.addSeries(LineSeries, lineOpts(C.kri, 1), 1);
    kriSeries.createPriceLine({ price: 0, color: 'rgba(255,255,255,.12)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' });
    const kriPane = chart.panes()[1];
    if (kriPane) kriPane.setHeight(110);

    const applyIndicators = () => {
      const i = ichimoku(bars);
      const k = kri14(bars);
      senkouA.setData(i.senkouA); senkouB.setData(i.senkouB);
      tenkan.setData(i.tenkan); kijun.setData(i.kijun); chikou.setData(i.chikou);
      kriSeries.setData(k.line);
      cloud.setCloud(i.cloud);
      setStream({ ichi: i.last, kri: k.last, bar: bars[bars.length - 1] });
    };
    applyIndicators();

    chart.subscribeCrosshairMove((param) => {
      if (param.time == null) { setHover(null); return; }
      const b = bars.find((x) => x.time === param.time);
      setHover(b ? { ...b } : null);
    });

    // Stream a new candle each second so the chart moves like a live market.
    let last = bars[bars.length - 1];
    const id = setInterval(() => {
      const drift = (Math.random() - 0.5) * 14;
      const vv = 12 + Math.random() * 40;
      const open = last.close + (Math.random() - 0.5) * vv * 0.4;
      const close = open + drift + (Math.random() - 0.5) * vv;
      const wick = 4 + Math.random() * vv * 0.8;
      const bar: Bar = {
        time: (Number(last.time) + DT) as UTCTimestamp,
        open,
        close,
        high: Math.max(open, close) + wick * (0.4 + Math.random()),
        low: Math.min(open, close) - wick * (0.4 + Math.random()),
        volume: 3000 + Math.random() * 9000,
      };
      bars.push(bar);
      last = bar;
      candles.update({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
      vol.update({ time: bar.time, value: bar.volume, color: C.volume });
      applyIndicators();
    }, 1000);

    return () => { clearInterval(id); chart.remove(); };
  }, [initialBars]);

  const v = hover ?? stream.bar;
  const f = (n: number) => n.toFixed(2);
  return (
    <div style={{ width: '100%', height: '100%', minHeight: 420, position: 'relative', overflow: 'hidden', background: C.bg, fontFamily: 'Inter, Arial, sans-serif', fontVariantNumeric: 'tabular-nums' }}>
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      <div style={{ position: 'absolute', top: 8, left: 12, display: 'grid', gap: 5, pointerEvents: 'none', fontSize: 12, color: C.text }}>
        <div>
          <span style={{ fontWeight: 700, color: '#f4f4f5' }}>STRC</span>{' '}
          <span>O{f(v.open)} </span><span style={{ color: v.close >= v.open ? C.up : C.down }}>H{f(v.high)} L{f(v.low)} C{f(v.close)}</span>{' '}
          <span style={{ color: '#7c8aa0' }}>V{(v.volume / 1000).toFixed(2)}K</span>
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', color: '#9aa3b2', fontSize: 11 }}>
          <span><b style={{ color: '#f4f4f5' }}>Ichimoku Cloud</b></span>
          <span style={{ color: C.tenkan }}>Tenkan {f(stream.ichi.tenkan)}</span>
          <span style={{ color: C.kijun }}>Kijun {f(stream.ichi.kijun)}</span>
          <span style={{ color: C.chikou }}>Chikou {f(stream.ichi.chikou)}</span>
          <span style={{ color: C.senkouA }}>Senkou A {f(stream.ichi.senkouA)}</span>
          <span style={{ color: C.senkouB }}>Senkou B {f(stream.ichi.senkouB)}</span>
        </div>
        <div style={{ color: C.kri, fontSize: 11 }}>KRI (14) {stream.kri.toFixed(2)}</div>
      </div>
    </div>
  );
}
