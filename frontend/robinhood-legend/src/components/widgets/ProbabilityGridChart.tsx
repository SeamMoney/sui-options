'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import gsap from 'gsap';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';

type Bar = {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type Pivot = {
  price: number;
  bar: number;
  bias: 1 | -1;
};

type GridCell = {
  column: number;
  row: number;
  leftLogical: number;
  rightLogical: number;
  topPrice: number;
  bottomPrice: number;
  probability: number;
};

type GridLine = {
  kind: 'time' | 'price';
  value: number;
  label: string;
  percentile: number;
};

type ProbabilityGridModel = {
  currentPivot: Pivot;
  marks: Pivot[];
  cells: GridCell[];
  lines: GridLine[];
  dashboard: number[][];
  barPercentiles: number[];
  pricePercentiles: number[];
  bias: 1 | -1;
  latestLogical: number;
  latestClose: number;
  minPrice: number;
  maxPrice: number;
  sampleCount: number;
};

type Hover = {
  bar: Bar;
  point: { x: number; y: number };
} | null;

const GREEN = '#089981';
const RED = '#f23645';
const BG = '#131722';
const FG = '#d1d4dc';
const MUTED = '#787b86';
const PERCENTILES = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];
const LENGTH = 20;
const MAX_BARS = 420;
const STREAM_INTERVAL_MS = 140;
const STREAM_TICKS_PER_BAR = 8;
const STREAM_ENABLED = false;
const REFERENCE_BARS = [1, 8, 14, 17, 20, 25, 29, 37, 46, 60];
const REFERENCE_RETURNS = [0.0012, 0.0047, 0.0092, 0.0128, 0.0154, 0.0189, 0.0234, 0.0298, 0.0374, 0.0498];

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function colorWithAlpha(hex: string, alpha: number) {
  const clean = hex.replace('#', '');
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function mixColor(a: string, b: string, t: number, alpha: number) {
  const ca = a.replace('#', '');
  const cb = b.replace('#', '');
  const ar = Number.parseInt(ca.slice(0, 2), 16);
  const ag = Number.parseInt(ca.slice(2, 4), 16);
  const ab = Number.parseInt(ca.slice(4, 6), 16);
  const br = Number.parseInt(cb.slice(0, 2), 16);
  const bg = Number.parseInt(cb.slice(2, 4), 16);
  const bb = Number.parseInt(cb.slice(4, 6), 16);
  return `rgba(${Math.round(lerp(ar, br, t))}, ${Math.round(lerp(ag, bg, t))}, ${Math.round(lerp(ab, bb, t))}, ${alpha})`;
}

function nearestRank(values: number[], percentile: number) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[clamp(rank - 1, 0, sorted.length - 1)];
}

function formatPrice(value: number) {
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPct(value: number) {
  return `${Math.round(value)}%`;
}

function trendAt(index: number) {
  const anchors: Array<[number, number]> = [
    [0, 84_900],
    [36, 83_950],
    [72, 85_250],
    [112, 84_650],
    [150, 85_300],
    [190, 84_400],
    [230, 86_100],
    [270, 83_950],
    [312, 85_700],
    [354, 84_250],
    [394, 86_450],
  ];
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const [ai, av] = anchors[i];
    const [bi, bv] = anchors[i + 1];
    if (index >= ai && index <= bi) return lerp(av, bv, (index - ai) / Math.max(1, bi - ai));
  }
  return anchors[anchors.length - 1][1];
}

function makeReferenceBars(): Bar[] {
  const rand = seeded(0x9a11c0);
  const start = Math.floor(Date.UTC(2025, 3, 5, 5, 0) / 1000);
  const bars: Bar[] = [];
  let previousClose = trendAt(0);

  for (let i = 0; i < 400; i += 1) {
    const trend = trendAt(i);
    const wave = Math.sin(i / 5.3) * 130 + Math.sin(i / 18.5) * 240;
    const open = previousClose + (rand() - 0.5) * 420;
    const close = trend + wave + (rand() - 0.5) * 360;
    const wick = 90 + rand() * 360 + (i > 160 && i < 230 ? rand() * 340 : 0);
    bars.push({
      time: (start + i * 15 * 60) as UTCTimestamp,
      open,
      high: Math.max(open, close) + wick * (0.38 + rand()),
      low: Math.min(open, close) - wick * (0.38 + rand()),
      close,
      volume: 240 + rand() * 2500,
    });
    previousClose = close;
  }

  const visibleStart = Math.floor(Date.UTC(2025, 3, 9, 5, 0) / 1000);
  const anchors: Array<[number, number]> = [
    [0, 84_520],
    [3, 84_140],
    [4, 84_020],
    [7, 84_300],
    [10, 84_520],
    [13, 84_820],
    [16, 85_220],
    [18, 85_110],
    [21, 85_020],
    [24, 84_850],
    [27, 84_520],
    [30, 84_720],
    [32, 84_610],
    [34, 84_980],
    [36, 85_500],
    [38, 85_980],
    [40, 86_520],
    [42, 87_080],
    [43, 86_840],
    [44, 87_020],
  ];
  const visible: Bar[] = [];
  let prevClose = anchors[0][1];
  for (let i = 0; i <= 44; i += 1) {
    let left = anchors[0];
    let right = anchors[anchors.length - 1];
    for (let j = 0; j < anchors.length - 1; j += 1) {
      if (i >= anchors[j][0] && i <= anchors[j + 1][0]) {
        left = anchors[j];
        right = anchors[j + 1];
        break;
      }
    }
    const t = left[0] === right[0] ? 0 : (i - left[0]) / (right[0] - left[0]);
    const close = lerp(left[1], right[1], t) + (rand() - 0.5) * 70;
    const open = i === 0 ? close + 42 : prevClose + (rand() - 0.5) * 75;
    const rangeBoost = i >= 39 && i <= 42 ? 210 : 95;
    visible.push({
      time: (visibleStart + i * 15 * 60) as UTCTimestamp,
      open,
      close,
      high: Math.max(open, close) + 42 + rand() * rangeBoost,
      low: Math.min(open, close) - 42 - rand() * rangeBoost,
      volume: 600 + rand() * 1800,
    });
    prevClose = close;
  }

  const visibleStartIndex = bars.findIndex((bar) => bar.time >= visibleStart);
  if (visibleStartIndex >= 0) bars.splice(visibleStartIndex, bars.length - visibleStartIndex, ...visible);
  return bars;
}

function toCandles(bars: Bar[]): CandlestickData[] {
  return bars.map((bar) => ({
    time: bar.time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
  }));
}

function highest(values: number[], index: number, length: number) {
  const from = Math.max(0, index - length + 1);
  let result = Number.NEGATIVE_INFINITY;
  for (let i = from; i <= index; i += 1) result = Math.max(result, values[i]);
  return result;
}

function lowest(values: number[], index: number, length: number) {
  const from = Math.max(0, index - length + 1);
  let result = Number.POSITIVE_INFINITY;
  for (let i = from; i <= index; i += 1) result = Math.min(result, values[i]);
  return result;
}

function buildProbabilityGrid(bars: Bar[]): ProbabilityGridModel {
  const maxBodies = bars.map((bar) => Math.max(bar.close, bar.open));
  const minBodies = bars.map((bar) => Math.min(bar.close, bar.open));
  const bullishPrices: number[] = [];
  const bullishBars: number[] = [];
  const bearishPrices: number[] = [];
  const bearishBars: number[] = [];
  const marks: Pivot[] = [];

  let currentPivot: Pivot = { price: bars[0].close, bar: 0, bias: 1 };
  let currentPrice = bars[0].close;
  let currentBar = 0;
  let bias: 1 | -1 = 1;
  let lastBias: 1 | -1 = 1;
  let lastPrice = bars[0].close;
  let lastBar = 0;

  for (let i = 1; i < bars.length; i += 1) {
    const upper = highest(maxBodies, i, LENGTH);
    const lower = lowest(minBodies, i, LENGTH);
    const max = maxBodies[i];
    const min = minBodies[i];
    bias = max === upper ? 1 : min === lower ? -1 : bias;

    let newPivot = false;
    if (bias !== lastBias) {
      newPivot = true;
      currentPivot = {
        price: currentPrice,
        bar: currentBar,
        bias: bias === -1 ? 1 : -1,
      };
      marks.push(currentPivot);
      currentPrice = bias === 1 ? upper : lower;
      currentBar = i;
    } else {
      const nextPrice = bias === 1 ? Math.max(upper, currentPrice) : Math.min(lower, currentPrice);
      if (nextPrice !== currentPrice) currentBar = i;
      currentPrice = nextPrice;
    }

    if (newPivot) {
      const bullish = currentPivot.price > lastPrice;
      const priceDelta = Math.abs(currentPivot.price - lastPrice) / Math.max(1, lastPrice);
      const barsDelta = currentPivot.bar - lastBar;
      if (barsDelta !== 0 && Number.isFinite(priceDelta)) {
        if (bullish) {
          bullishPrices.push(priceDelta);
          bullishBars.push(barsDelta);
        } else {
          bearishPrices.push(priceDelta);
          bearishBars.push(barsDelta);
        }
        lastPrice = currentPivot.price;
        lastBar = currentPivot.bar;
      }
    }
    lastBias = bias;
  }

  const referencePivotIndex = bars.findIndex((bar) => bar.time === (Math.floor(Date.UTC(2025, 3, 9, 6, 0) / 1000) as UTCTimestamp));
  if (referencePivotIndex >= 0) {
    currentPivot = {
      price: 84_020,
      bar: referencePivotIndex,
      bias: -1,
    };
  }

  const selectedPrices = currentPivot.bias === 1 ? bearishPrices : bullishPrices;
  const selectedBars = currentPivot.bias === 1 ? bearishBars : bullishBars;
  const safePrices = selectedPrices.length >= 2 ? selectedPrices : [...bullishPrices, ...bearishPrices];
  const safeBars = selectedBars.length >= 2 ? selectedBars : [...bullishBars, ...bearishBars];

  const useReferenceProfile = referencePivotIndex >= 0;
  const barPercentiles = PERCENTILES.map((p, index) => {
    if (useReferenceProfile) return REFERENCE_BARS[index];
    return Math.max(2, Math.round(nearestRank(safeBars, p) || (p + 10) * 0.65));
  });
  const pricePercentiles = PERCENTILES.map((p, index) => {
    const delta = useReferenceProfile ? REFERENCE_RETURNS[index] : nearestRank(safePrices, p) || (0.002 + p / 10000);
    const direction = currentPivot.bias === 1 ? -1 : 1;
    return currentPivot.price + direction * currentPivot.price * delta;
  });

  const cells: GridCell[] = [];
  const dashboard: number[][] = [];
  for (let c = 0; c < PERCENTILES.length; c += 1) {
    dashboard[c] = [];
    for (let r = 0; r < PERCENTILES.length; r += 1) {
      const barPct = PERCENTILES[c];
      const pricePct = PERCENTILES[r];
      const nextBarPct = c === PERCENTILES.length - 1 ? 100 : PERCENTILES[c + 1];
      const nextPricePct = r === PERCENTILES.length - 1 ? 100 : PERCENTILES[r + 1];
      const probability = (1 - pricePct * 0.01) * (1 - barPct * 0.01);
      dashboard[c][r] = probability;

      const leftLogical = c === 0 ? currentPivot.bar : currentPivot.bar + barPercentiles[c - 1];
      const rightLogical = currentPivot.bar + barPercentiles[c];
      const topPrice = r === 0 ? currentPivot.price : pricePercentiles[r - 1];
      const bottomPrice = pricePercentiles[r];
      cells.push({
        column: c,
        row: r,
        leftLogical,
        rightLogical,
        topPrice,
        bottomPrice,
        probability,
      });
    }
  }

  const lines: GridLine[] = [];
  for (let i = 0; i < PERCENTILES.length; i += 1) {
    lines.push({ kind: 'time', value: currentPivot.bar + barPercentiles[i], label: `${PERCENTILES[i]}th`, percentile: PERCENTILES[i] });
    lines.push({ kind: 'price', value: pricePercentiles[i], label: `${PERCENTILES[i]}th`, percentile: PERCENTILES[i] });
  }

  const recent = bars.slice(Math.max(0, currentPivot.bar - 12), Math.min(bars.length, currentPivot.bar + 70));
  return {
    currentPivot,
    marks,
    cells,
    lines,
    dashboard,
    barPercentiles,
    pricePercentiles,
    bias: currentPivot.bias,
    latestLogical: bars.length - 1,
    latestClose: bars[bars.length - 1].close,
    minPrice: Math.min(...recent.map((bar) => bar.low), ...pricePercentiles, currentPivot.price),
    maxPrice: Math.max(...recent.map((bar) => bar.high), ...pricePercentiles, currentPivot.price),
    sampleCount: safeBars.length,
  };
}

function streamBars(current: Bar[], tick: number, rand: () => number) {
  const bars = current.slice();
  const last = { ...bars[bars.length - 1] };
  const pulse = Math.sin(tick / 2.9) * 72 + Math.sin((bars.length + tick) / 9.5) * 96;
  const close = Math.max(50_000, last.close + pulse + (rand() - 0.5) * 120);
  bars[bars.length - 1] = {
    ...last,
    close,
    high: Math.max(last.high, close + 52 + rand() * 180),
    low: Math.min(last.low, close - 52 - rand() * 180),
  };
  if (tick > 0 && tick % STREAM_TICKS_PER_BAR === 0) {
    const open = close;
    const nextClose = Math.max(50_000, open + (rand() - 0.5) * 620 + Math.sin(bars.length / 8) * 140);
    bars.push({
      time: (last.time + 15 * 60) as UTCTimestamp,
      open,
      close: nextClose,
      high: Math.max(open, nextClose) + 100 + rand() * 460,
      low: Math.min(open, nextClose) - 100 - rand() * 460,
      volume: 280 + rand() * 3200,
    });
  }
  return bars.slice(-MAX_BARS);
}

function applyVisibleWindow(chart: IChartApi, model: ProbabilityGridModel, bars: Bar[]) {
  const to = Math.max(model.currentPivot.bar + Math.max(...model.barPercentiles) + 10, bars.length + 28);
  chart.timeScale().setVisibleLogicalRange({
    from: Math.max(0, model.currentPivot.bar - 6),
    to,
  });
  const padding = Math.max(180, (model.maxPrice - model.minPrice) * 0.025);
  chart.priceScale('right').setVisibleRange({ from: model.minPrice - padding, to: model.maxPrice + padding });
}

class ProbabilityGridPrimitive {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<'Candlestick'> | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly paneView = {
    zOrder: () => 'top' as const,
    renderer: () => ({
      draw: (target: any) => {
        target.useMediaCoordinateSpace(
          ({ context, mediaSize }: { context: CanvasRenderingContext2D; mediaSize: { width: number; height: number } }) => {
            this.draw(context, mediaSize);
          },
        );
      },
    }),
  };

  constructor(private model: ProbabilityGridModel) {}

  setModel(model: ProbabilityGridModel) {
    this.model = model;
    this.requestUpdate?.();
  }

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

  autoscaleInfo() {
    return {
      priceRange: { minValue: this.model.minPrice, maxValue: this.model.maxPrice },
      margins: { above: 0.09, below: 0.11 },
    };
  }

  private x(logical: number) {
    return this.chart?.timeScale().logicalToCoordinate(logical as any) ?? null;
  }

  private y(price: number) {
    return this.series?.priceToCoordinate(price) ?? null;
  }

  private draw(ctx: CanvasRenderingContext2D, mediaSize: { width: number; height: number }) {
    if (!this.chart || !this.series) return;
    ctx.save();
    ctx.font = '11px Arial, Helvetica, sans-serif';
    ctx.textBaseline = 'middle';

    for (const cell of this.model.cells) {
      const x1 = this.x(cell.leftLogical);
      const x2 = this.x(cell.rightLogical);
      const y1 = this.y(cell.topPrice);
      const y2 = this.y(cell.bottomPrice);
      if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
      const left = Math.min(x1, x2);
      const width = Math.max(2, Math.abs(x2 - x1));
      const top = Math.min(y1, y2);
      const height = Math.max(2, Math.abs(y2 - y1));
      if (left > mediaSize.width || left + width < -30 || top > mediaSize.height || top + height < -30) continue;

      const color = this.model.bias === 1 ? mixColor(GREEN, RED, cell.probability, 0.25) : mixColor(RED, GREEN, cell.probability, 0.25);
      ctx.fillStyle = color;
      ctx.fillRect(left, top, width, height);
      ctx.strokeStyle = 'rgba(209,212,220,.18)';
      ctx.lineWidth = 1;
      ctx.strokeRect(left + 0.5, top + 0.5, Math.max(0, width - 1), Math.max(0, height - 1));

      if (width > 26 && height > 17) {
        ctx.fillStyle = 'rgba(209,212,220,.48)';
        ctx.textAlign = 'center';
        ctx.fillText(formatPct(cell.probability * 100), left + width / 2, top + height / 2);
      }
    }

    const maxBar = Math.max(...this.model.barPercentiles);
    const farX = this.x(this.model.currentPivot.bar + maxBar);
    const pivotX = this.x(this.model.currentPivot.bar);
    const pivotY = this.y(this.model.currentPivot.price);

    for (const line of this.model.lines) {
      ctx.save();
      ctx.strokeStyle = 'rgba(209,212,220,.46)';
      ctx.lineWidth = 1;
      ctx.setLineDash(line.percentile % 30 === 0 ? [7, 7] : [2, 6]);
      if (line.kind === 'time') {
        const x = this.x(line.value);
        if (x == null || pivotY == null) {
          ctx.restore();
          continue;
        }
        const endY = this.y(this.model.pricePercentiles[this.model.pricePercentiles.length - 1]);
        if (endY == null) {
          ctx.restore();
          continue;
        }
        ctx.beginPath();
        ctx.moveTo(x, pivotY);
        ctx.lineTo(x, endY);
        ctx.stroke();
        ctx.fillStyle = 'rgba(209,212,220,.52)';
        ctx.textAlign = 'center';
        ctx.fillText(line.label, x, pivotY + (this.model.bias === 1 ? 18 : 18));
      } else {
        const y = this.y(line.value);
        if (y == null || pivotX == null || farX == null) {
          ctx.restore();
          continue;
        }
        ctx.beginPath();
        ctx.moveTo(pivotX, y);
        ctx.lineTo(farX, y);
        ctx.stroke();
        ctx.fillStyle = 'rgba(209,212,220,.52)';
        ctx.textAlign = 'left';
        ctx.fillText(line.label, farX + 8, y);
      }
      ctx.restore();
    }

    if (pivotX != null && pivotY != null) {
      ctx.save();
      ctx.fillStyle = this.model.bias === 1 ? RED : GREEN;
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(pivotX, pivotY, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    for (const mark of this.model.marks.slice(-30)) {
      const x = this.x(mark.bar);
      const y = this.y(mark.price);
      if (x == null || y == null) continue;
      ctx.save();
      ctx.fillStyle = 'rgba(209,212,220,.30)';
      ctx.font = '18px Arial, Helvetica, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('•', x, y + (mark.bias === 1 ? -9 : 10));
      ctx.restore();
    }

    ctx.restore();
  }
}

export function ProbabilityGridChart() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const readoutRef = useRef<HTMLDivElement | null>(null);
  const liveRef = useRef<HTMLSpanElement | null>(null);
  const bars = useMemo(() => makeReferenceBars(), []);
  const barsRef = useRef<Bar[]>(bars);
  const randomRef = useRef(seeded(0xb7c05d));
  const tickRef = useRef(0);
  const [activeBar, setActiveBar] = useState<Bar>(() => bars[bars.length - 1]);
  const [model, setModel] = useState<ProbabilityGridModel>(() => buildProbabilityGrid(bars));
  const [hover, setHover] = useState<Hover>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      if (readoutRef.current) gsap.fromTo(readoutRef.current, { autoAlpha: 0, y: -6 }, { autoAlpha: 1, y: 0, duration: 0.35 });
      if (liveRef.current) {
        gsap.to(liveRef.current, {
          autoAlpha: 1,
          duration: 0.7,
          repeat: -1,
          yoyo: true,
          ease: 'sine.inOut',
        });
      }
    }, rootRef);
    return () => ctx.revert();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const initialModel = buildProbabilityGrid(barsRef.current);
    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: BG },
        textColor: FG,
        fontFamily: 'Arial, Helvetica, sans-serif',
        fontSize: 12,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(54,60,78,0)' },
        horzLines: { color: 'rgba(54,60,78,0)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(120,123,134,.52)', style: LineStyle.Dashed, labelBackgroundColor: '#1d2333' },
        horzLine: { color: 'rgba(120,123,134,.52)', style: LineStyle.Dashed, labelBackgroundColor: '#1d2333' },
      },
      rightPriceScale: {
        visible: true,
        borderColor: '#2a2e39',
        scaleMargins: { top: 0.06, bottom: 0.08 },
      },
      timeScale: {
        borderColor: '#2a2e39',
        timeVisible: true,
        secondsVisible: false,
        barSpacing: 19.5,
        rightOffset: 11,
        minBarSpacing: 2,
        tickMarkFormatter: (time: Time) => {
          const date = new Date(Number(time) * 1000);
          const h = String(date.getUTCHours()).padStart(2, '0');
          const m = String(date.getUTCMinutes()).padStart(2, '0');
          return `${h}:${m}`;
        },
      },
      localization: {
        priceFormatter: (price: number) => formatPrice(price),
        timeFormatter: (time: Time) => new Date(Number(time) * 1000).toUTCString().replace('GMT', 'UTC'),
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
      downColor: 'rgba(149,152,161,1)',
      borderVisible: true,
      borderUpColor: 'rgba(120,123,134,1)',
      borderDownColor: 'rgba(120,123,134,1)',
      wickUpColor: 'rgba(149,152,161,1)',
      wickDownColor: 'rgba(42,46,57,1)',
      priceLineVisible: false,
      lastValueVisible: true,
    });

    candleSeries.setData(toCandles(barsRef.current));
    const primitive = new ProbabilityGridPrimitive(initialModel);
    candleSeries.attachPrimitive(primitive as any);
    applyVisibleWindow(chart, initialModel, barsRef.current);
    setModel(initialModel);

    chart.subscribeCrosshairMove((param) => {
      if (!param.point || param.time == null) {
        setHover(null);
        return;
      }
      const bar = barsRef.current.find((item) => item.time === param.time);
      setHover(bar ? { bar, point: param.point } : null);
    });

    let accumulatedMs = 0;
    let previousTime = gsap.ticker.time;
    const stream = () => {
      const now = gsap.ticker.time;
      accumulatedMs += (now - previousTime) * 1000;
      previousTime = now;
      if (accumulatedMs < STREAM_INTERVAL_MS) return;
      accumulatedMs %= STREAM_INTERVAL_MS;

      tickRef.current += 1;
      const previous = barsRef.current;
      const next = streamBars(previous, tickRef.current, randomRef.current);
      const nextModel = buildProbabilityGrid(next);
      const latest = next[next.length - 1];
      const trimmed = next.length === MAX_BARS && previous.length === MAX_BARS && next[0]?.time !== previous[0]?.time;
      barsRef.current = next;

      if (trimmed) candleSeries.setData(toCandles(next));
      else candleSeries.update({ time: latest.time, open: latest.open, high: latest.high, low: latest.low, close: latest.close });

      primitive.setModel(nextModel);
      applyVisibleWindow(chart, nextModel, next);
      setActiveBar(latest);
      setModel(nextModel);
    };
    if (STREAM_ENABLED) gsap.ticker.add(stream);

    return () => {
      if (STREAM_ENABLED) gsap.ticker.remove(stream);
      chart.remove();
    };
  }, [bars]);

  const active = hover?.bar ?? activeBar;
  const trendColor = model.bias === 1 ? RED : GREEN;

  return (
    <div
      ref={rootRef}
      style={{
        width: '100%',
        height: '100%',
        minHeight: 460,
        position: 'relative',
        overflow: 'hidden',
        background: BG,
        color: FG,
        fontFamily: 'Arial, Helvetica, sans-serif',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      <div ref={hostRef} style={{ position: 'absolute', inset: 0, zIndex: 0 }} />
      <div
        ref={readoutRef}
        style={{
          position: 'absolute',
          top: 18,
          left: 22,
          zIndex: 2,
          padding: 0,
          border: 'none',
          borderRadius: 0,
          background: 'transparent',
          color: FG,
          pointerEvents: 'none',
          boxShadow: 'none',
        }}
      >
        <div style={{ display: 'flex', gap: 7, alignItems: 'center', whiteSpace: 'nowrap', fontSize: 18, fontWeight: 700 }}>
          <span ref={liveRef} style={{ width: 10, height: 10, borderRadius: 99, background: '#f7931a', display: 'inline-block' }} />
          <strong>Bitcoin / U.S. Dollar · 15 · COINBASE</strong>
        </div>
        <div style={{ marginTop: 7, display: 'flex', gap: 8, color: FG, fontSize: 16, fontWeight: 500 }}>
          <span>LuxAlgo - Probability Grid</span>
        </div>
      </div>
    </div>
  );
}
