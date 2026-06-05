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

type WickSignal = {
  logical: number;
  type: 'upper' | 'lower';
  top: number;
  bottom: number;
  volume: number;
  strength: number;
  rsi: number;
};

type WickZone = WickSignal & {
  rightLogical: number;
  active: boolean;
  expiredAt?: number;
};

type WickPressureModel = {
  zones: WickZone[];
  signals: WickSignal[];
  activeUpper: number;
  activeLower: number;
  latestLogical: number;
  latestClose: number;
  minPrice: number;
  maxPrice: number;
  currentUpperStrength: number;
  currentLowerStrength: number;
  currentRsi: number;
};

type Hover = {
  bar: Bar;
  point: { x: number; y: number };
} | null;

const THEME = {
  background: '#131722',
  grid: 'rgba(42, 46, 57, .42)',
  text: '#d1d4dc',
  muted: '#787b86',
  up: '#089981',
  down: '#f23645',
  wickNeutral: '#737375',
  buy: '#00e676',
  sell: '#f23645',
  pane: 'rgba(19, 23, 34, .78)',
};

const CAPTURED_REFERENCE = {
  title: 'Wick Pressure Zones [BigBeluga]',
  symbol: 'BINANCE:ADAUSDT',
  displaySymbol: 'ADAUSDT',
  interval: '10h',
  exchange: 'Binance',
  barSpacing: 4.95,
  rightOffset: 30,
  initialVisibleBars: 176,
};

const STREAM_INTERVAL_MS = 52;
const STREAM_TICKS_PER_BAR = 10;
const MAX_BARS = 520;

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

function trendAt(index: number) {
  const anchors: Array<[number, number]> = [
    [0, 0.95],
    [42, 0.27],
    [92, 0.36],
    [138, 0.24],
    [184, 0.33],
    [230, 0.21],
    [286, 0.30],
    [338, 0.245],
    [390, 0.275],
    [440, 0.242],
  ];

  for (let i = 0; i < anchors.length - 1; i += 1) {
    const [fromIndex, fromValue] = anchors[i];
    const [toIndex, toValue] = anchors[i + 1];
    if (index >= fromIndex && index <= toIndex) {
      return lerp(fromValue, toValue, (index - fromIndex) / Math.max(1, toIndex - fromIndex));
    }
  }
  return anchors[anchors.length - 1][1];
}

function makeReferenceBars(): Bar[] {
  const rand = seeded(0x4ba5e11);
  const start = Math.floor(Date.UTC(2025, 1, 1, 0, 0) / 1000);
  const bars: Bar[] = [];
  let previousClose = trendAt(0);

  const pressureEvents = new Map<number, 'upper' | 'lower'>([
    [214, 'upper'],
    [238, 'lower'],
    [263, 'upper'],
    [290, 'lower'],
    [318, 'upper'],
    [344, 'lower'],
    [371, 'upper'],
    [397, 'lower'],
    [424, 'upper'],
  ]);

  for (let i = 0; i < 448; i += 1) {
    const trend = trendAt(i);
    const wave = Math.sin(i / 5.8) * 0.012 + Math.sin(i / 17.4) * 0.026 + Math.cos(i / 43) * 0.018;
    const drift = (rand() - 0.5) * 0.014;
    const open = Math.max(0.04, previousClose + (rand() - 0.5) * 0.018);
    let close = Math.max(0.04, trend + wave + drift);
    let upper = 0.006 + rand() * 0.018;
    let lower = 0.006 + rand() * 0.018;
    let volume = 1_200_000 + rand() * 9_200_000;

    const pressure = pressureEvents.get(i);
    if (pressure === 'upper') {
      close = Math.min(open - 0.004 - rand() * 0.012, Math.max(0.045, trend - 0.004));
      upper = 0.058 + rand() * 0.038;
      lower = 0.006 + rand() * 0.01;
      volume += 36_000_000 + rand() * 78_000_000;
    }
    if (pressure === 'lower') {
      close = Math.max(0.04, Math.min(open - 0.002 - rand() * 0.008, trend - 0.004));
      lower = 0.052 + rand() * 0.04;
      upper = 0.006 + rand() * 0.012;
      volume += 32_000_000 + rand() * 82_000_000;
    }

    const high = Math.max(open, close) + upper;
    const low = Math.max(0.02, Math.min(open, close) - lower);
    bars.push({
      time: (start + i * 10 * 60 * 60) as UTCTimestamp,
      open,
      high,
      low,
      close,
      volume,
    });
    previousClose = close;
  }

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

function formatPrice(value: number) {
  return value.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

function formatVolume(value: number) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 100_000_000 ? 1 : 2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(0);
}

function colorWithAlpha(hex: string, alpha: number) {
  const clean = hex.replace('#', '');
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function calculateRsi(bars: Bar[], length = 14) {
  const rsi = new Array<number>(bars.length).fill(50);
  if (bars.length <= length) return rsi;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= length; i += 1) {
    const change = bars[i].close - bars[i - 1].close;
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }

  let avgGain = gain / length;
  let avgLoss = loss / length;
  rsi[length] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = length + 1; i < bars.length; i += 1) {
    const change = bars[i].close - bars[i - 1].close;
    avgGain = (avgGain * (length - 1) + Math.max(change, 0)) / length;
    avgLoss = (avgLoss * (length - 1) + Math.max(-change, 0)) / length;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function maxInWindow(values: number[], index: number, length: number) {
  const from = Math.max(0, index - length + 1);
  let max = 0;
  for (let i = from; i <= index; i += 1) max = Math.max(max, values[i] || 0);
  return max;
}

function calculateWickPressure(bars: Bar[]): WickPressureModel {
  const upperRatios = bars.map((bar) => (bar.high - Math.max(bar.open, bar.close)) / Math.max(bar.open, bar.close));
  const lowerRatios = bars.map((bar) => (Math.min(bar.open, bar.close) - bar.low) / Math.max(bar.low, 0.0001));
  const rsi = calculateRsi(bars, 14);
  const zones: WickZone[] = [];
  const signals: WickSignal[] = [];
  let start = 0;

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    const upperMax = maxInWindow(upperRatios, i, 200);
    const lowerMax = maxInWindow(lowerRatios, i, 200);
    const upperStrength = upperMax > 0 ? Math.trunc((upperRatios[i] / upperMax) * 100) : 0;
    const lowerStrength = lowerMax > 0 ? Math.trunc((lowerRatios[i] / lowerMax) * 100) : 0;

    if (upperStrength >= 80 && lowerStrength < 80 && rsi[i] > 50 && i - start > 20) {
      start = i;
      const signal: WickSignal = {
        logical: i,
        type: 'upper',
        top: bar.high,
        bottom: Math.max(bar.open, bar.close),
        volume: bar.volume,
        strength: upperStrength,
        rsi: rsi[i],
      };
      signals.push(signal);
      zones.push({ ...signal, active: true, rightLogical: i + 20 });
    }

    if (lowerStrength >= 80 && upperStrength < 80 && rsi[i] < 50 && i - start > 20) {
      start = i;
      const signal: WickSignal = {
        logical: i,
        type: 'lower',
        top: Math.min(bar.open, bar.close),
        bottom: bar.low,
        volume: bar.volume,
        strength: lowerStrength,
        rsi: rsi[i],
      };
      signals.push(signal);
      zones.push({ ...signal, active: true, rightLogical: i + 20 });
    }

    if (zones.length > 10) zones.shift();

    for (const zone of zones) {
      if (!zone.active) continue;
      zone.rightLogical = i + 20;
      if (zone.type === 'upper' && bar.low >= zone.top) {
        zone.active = false;
        zone.expiredAt = i;
        zone.rightLogical = i;
      }
      if (zone.type === 'lower' && bar.high <= zone.bottom) {
        zone.active = false;
        zone.expiredAt = i;
        zone.rightLogical = i;
      }
    }
  }

  const latest = bars[bars.length - 1];
  const currentUpperMax = maxInWindow(upperRatios, bars.length - 1, 200);
  const currentLowerMax = maxInWindow(lowerRatios, bars.length - 1, 200);
  const activeZones = zones.filter((zone) => zone.active);
  const recent = bars.slice(-220);

  return {
    zones,
    signals,
    activeUpper: activeZones.filter((zone) => zone.type === 'upper').length,
    activeLower: activeZones.filter((zone) => zone.type === 'lower').length,
    latestLogical: bars.length - 1,
    latestClose: latest.close,
    minPrice: Math.min(...recent.map((bar) => bar.low), ...zones.map((zone) => zone.bottom)),
    maxPrice: Math.max(...recent.map((bar) => bar.high), ...zones.map((zone) => zone.top)),
    currentUpperStrength: currentUpperMax > 0 ? Math.trunc((upperRatios[bars.length - 1] / currentUpperMax) * 100) : 0,
    currentLowerStrength: currentLowerMax > 0 ? Math.trunc((lowerRatios[bars.length - 1] / currentLowerMax) * 100) : 0,
    currentRsi: rsi[bars.length - 1],
  };
}

function streamBars(current: Bar[], tick: number, rand: () => number): Bar[] {
  const bars = current.slice();
  const last = { ...bars[bars.length - 1] };
  const pulse = Math.sin(tick / 3.2) * 0.0009 + Math.sin((bars.length + tick) / 10.8) * 0.00115;
  const noise = (rand() - 0.5) * 0.0012;
  const close = clamp(last.close + pulse + noise, 0.11, 0.68);
  const move = Math.abs(close - last.open);
  const pressurePulse = tick % 71 === 0 ? 0.044 + rand() * 0.022 : 0;
  const lowerPulse = tick % 97 === 0 ? 0.04 + rand() * 0.022 : 0;

  bars[bars.length - 1] = {
    ...last,
    close,
    high: Math.max(last.high, close + 0.0025 + move * 0.42 + pressurePulse),
    low: Math.min(last.low, close - 0.0025 - move * 0.38 - lowerPulse),
    volume: Math.max(900_000, last.volume * 0.86 + 420_000 + Math.abs(pulse + noise) * 3_700_000_000 + rand() * 1_800_000),
  };

  if (tick > 0 && tick % STREAM_TICKS_PER_BAR === 0) {
    const base = bars[bars.length - 1];
    const open = base.close;
    const delta = Math.sin((bars.length + tick) / 6.2) * 0.0027 + (rand() - 0.5) * 0.006;
    const closeNext = clamp(open + delta, 0.11, 0.68);
    const isUpperEvent = bars.length % 31 === 0;
    const isLowerEvent = bars.length % 37 === 0;
    bars.push({
      time: (base.time + 10 * 60 * 60) as UTCTimestamp,
      open,
      close: closeNext,
      high: Math.max(open, closeNext) + 0.004 + rand() * 0.01 + (isUpperEvent ? 0.058 + rand() * 0.028 : 0),
      low: Math.max(0.025, Math.min(open, closeNext) - 0.004 - rand() * 0.01 - (isLowerEvent ? 0.054 + rand() * 0.025 : 0)),
      volume: 1_400_000 + rand() * 7_500_000 + (isUpperEvent || isLowerEvent ? 48_000_000 + rand() * 72_000_000 : 0),
    });
  }

  return bars.slice(-MAX_BARS);
}

function applyVisibleWindow(chart: IChartApi, model: WickPressureModel, bars: Bar[]) {
  chart.timeScale().setVisibleLogicalRange({
    from: Math.max(0, bars.length - CAPTURED_REFERENCE.initialVisibleBars),
    to: bars.length + CAPTURED_REFERENCE.rightOffset,
  });

  const min = model.minPrice;
  const max = model.maxPrice;
  const padding = Math.max(0.026, (max - min) * 0.18);
  chart.priceScale('right').setVisibleRange({ from: min - padding, to: max + padding });
}

class WickPressurePrimitive {
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

  constructor(private model: WickPressureModel) {}

  setModel(model: WickPressureModel) {
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
      priceRange: {
        minValue: this.model.minPrice,
        maxValue: this.model.maxPrice,
      },
      margins: { above: 0.08, below: 0.12 },
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
    ctx.textBaseline = 'middle';
    ctx.font = '12px Arial, Helvetica, sans-serif';

    for (const zone of this.model.zones) {
      this.drawZone(ctx, mediaSize, zone);
    }

    for (const signal of this.model.signals.slice(-18)) {
      this.drawOrigin(ctx, signal);
    }

    this.drawLatestGlow(ctx);
    ctx.restore();
  }

  private drawZone(ctx: CanvasRenderingContext2D, mediaSize: { width: number; height: number }, zone: WickZone) {
    const x1 = this.x(zone.logical);
    const x2 = this.x(zone.rightLogical);
    const yTop = this.y(zone.top);
    const yBottom = this.y(zone.bottom);
    if (x1 == null || x2 == null || yTop == null || yBottom == null) return;

    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    if (right < -20 || left > mediaSize.width + 80) return;
    const top = Math.min(yTop, yBottom);
    const height = Math.max(2, Math.abs(yBottom - yTop));
    const color = zone.type === 'upper' ? THEME.sell : THEME.buy;

    if (!zone.active) {
      ctx.fillStyle = 'rgba(209, 212, 220, .14)';
      ctx.fillRect(left, top, Math.max(1, right - left), height);
      return;
    }

    const bg = ctx.createLinearGradient(left, 0, right, 0);
    bg.addColorStop(0, colorWithAlpha(color, 0.08));
    bg.addColorStop(0.62, colorWithAlpha(color, 0.16));
    bg.addColorStop(1, colorWithAlpha(color, 0.02));
    ctx.fillStyle = bg;
    ctx.fillRect(left, top, Math.max(1, right - left), height);

    const step = height / 10;
    for (let i = 0; i < 10; i += 1) {
      const layerTop = zone.type === 'upper' ? top + i * step : top + i * step;
      const pressureIndex = zone.type === 'upper' ? 9 - i : i;
      const alpha = pressureIndex === 9 ? 0.48 : 0.06 + pressureIndex * 0.03;
      ctx.fillStyle = colorWithAlpha(color, alpha);
      ctx.fillRect(left, layerTop + 0.5, Math.max(1, right - left), Math.max(1, step - 0.7));
    }

    ctx.save();
    ctx.strokeStyle = colorWithAlpha(color, 0.54);
    ctx.setLineDash([9, 8]);
    ctx.lineWidth = 1;
    const mid = top + height / 2;
    ctx.beginPath();
    ctx.moveTo(Math.max(0, left - 18), mid);
    ctx.lineTo(Math.min(mediaSize.width, right), mid);
    ctx.stroke();
    ctx.restore();

    const labelX = clamp(right + 12, 70, mediaSize.width - 90);
    const labelY = top + height / 2;
    ctx.save();
    ctx.font = '12px Arial, Helvetica, sans-serif';
    ctx.textAlign = right + 128 > mediaSize.width ? 'right' : 'left';
    ctx.fillStyle = colorWithAlpha(color, 0.98);
    ctx.shadowColor = colorWithAlpha(color, 0.45);
    ctx.shadowBlur = 8;
    const label = `${formatVolume(zone.volume)}  ${zone.strength}%`;
    ctx.fillText(label, ctx.textAlign === 'right' ? mediaSize.width - 8 : labelX, labelY);
    ctx.restore();
  }

  private drawOrigin(ctx: CanvasRenderingContext2D, signal: WickSignal) {
    const x1 = this.x(signal.logical - 1);
    const x2 = this.x(signal.logical + 1);
    const yTop = this.y(signal.top);
    const yBottom = this.y(signal.bottom);
    if (x1 == null || x2 == null || yTop == null || yBottom == null) return;
    const color = signal.type === 'upper' ? THEME.sell : THEME.buy;
    const left = Math.min(x1, x2);
    const width = Math.max(5, Math.abs(x2 - x1));
    const top = Math.min(yTop, yBottom);
    const height = Math.max(2, Math.abs(yBottom - yTop));

    ctx.save();
    ctx.strokeStyle = colorWithAlpha(color, 0.94);
    ctx.lineWidth = 2;
    ctx.shadowColor = colorWithAlpha(color, 0.44);
    ctx.shadowBlur = 8;
    ctx.strokeRect(left, top, width, height);
    ctx.restore();
  }

  private drawLatestGlow(ctx: CanvasRenderingContext2D) {
    const x = this.x(this.model.latestLogical);
    const y = this.y(this.model.latestClose);
    if (x == null || y == null) return;
    const glow = ctx.createRadialGradient(x, y, 0, x, y, 36);
    glow.addColorStop(0, 'rgba(255,255,255,.18)');
    glow.addColorStop(0.38, 'rgba(255,255,255,.07)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, 36, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function WickPressureZonesChart() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const liveRef = useRef<HTMLSpanElement | null>(null);
  const readoutRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const primitiveRef = useRef<WickPressurePrimitive | null>(null);
  const streamRandomRef = useRef(seeded(0xada2026));
  const tickRef = useRef(0);
  const initialBars = useMemo(() => makeReferenceBars(), []);
  const barsRef = useRef<Bar[]>(initialBars);
  const [activeBar, setActiveBar] = useState<Bar>(() => initialBars[initialBars.length - 1]);
  const [model, setModel] = useState<WickPressureModel>(() => calculateWickPressure(initialBars));
  const [hover, setHover] = useState<Hover>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      if (readoutRef.current) {
        gsap.fromTo(readoutRef.current, { autoAlpha: 0, y: -8 }, { autoAlpha: 1, y: 0, duration: 0.42, ease: 'power2.out' });
      }
      if (liveRef.current) {
        gsap.to(liveRef.current, {
          autoAlpha: 1,
          boxShadow: '0 0 18px rgba(8,153,129,.55), inset 0 0 10px rgba(8,153,129,.22)',
          duration: 0.62,
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
    const initialModel = calculateWickPressure(barsRef.current);

    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: THEME.background },
        textColor: THEME.text,
        fontFamily: 'Arial, Helvetica, sans-serif',
        fontSize: 12,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: THEME.grid, style: LineStyle.Dotted },
        horzLines: { color: THEME.grid, style: LineStyle.Dotted },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(120,123,134,.62)', style: LineStyle.Dashed, labelBackgroundColor: '#1d2333' },
        horzLine: { color: 'rgba(120,123,134,.62)', style: LineStyle.Dashed, labelBackgroundColor: '#1d2333' },
      },
      rightPriceScale: {
        visible: true,
        borderColor: '#2a2e39',
        scaleMargins: { top: 0.07, bottom: 0.08 },
        entireTextOnly: false,
      },
      timeScale: {
        borderColor: '#2a2e39',
        timeVisible: true,
        secondsVisible: false,
        barSpacing: CAPTURED_REFERENCE.barSpacing,
        rightOffset: CAPTURED_REFERENCE.rightOffset,
        minBarSpacing: 1.2,
        tickMarkFormatter: (time: Time) => {
          const date = new Date(Number(time) * 1000);
          const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
          return date.getUTCDate() === 1 ? month : String(date.getUTCDate());
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
      priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
      upColor: THEME.up,
      downColor: THEME.down,
      borderVisible: false,
      wickUpColor: THEME.up,
      wickDownColor: THEME.down,
      priceLineVisible: true,
      priceLineColor: '#f23645',
      priceLineWidth: 1,
      lastValueVisible: true,
    });

    candleSeries.setData(toCandles(barsRef.current));

    const primitive = new WickPressurePrimitive(initialModel);
    candleSeries.attachPrimitive(primitive as any);
    applyVisibleWindow(chart, initialModel, barsRef.current);

    chart.subscribeCrosshairMove((param) => {
      if (!param.point || param.time == null) {
        setHover(null);
        return;
      }
      const bar = barsRef.current.find((item) => item.time === param.time);
      setHover(bar ? { bar, point: param.point } : null);
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    primitiveRef.current = primitive;
    setModel(initialModel);

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
      const next = streamBars(previous, tickRef.current, streamRandomRef.current);
      const nextModel = calculateWickPressure(next);
      const latest = next[next.length - 1];
      const trimmed = next.length === MAX_BARS && previous.length === MAX_BARS && next[0]?.time !== previous[0]?.time;
      barsRef.current = next;

      if (trimmed) {
        candleSeries.setData(toCandles(next));
      } else {
        candleSeries.update({
          time: latest.time,
          open: latest.open,
          high: latest.high,
          low: latest.low,
          close: latest.close,
        });
      }

      primitive.setModel(nextModel);
      applyVisibleWindow(chart, nextModel, next);
      setActiveBar(latest);
      setModel(nextModel);
      if (readoutRef.current) {
        gsap.fromTo(readoutRef.current, { autoAlpha: 0.76 }, { autoAlpha: 1, duration: 0.16, ease: 'power1.out', overwrite: true });
      }
    };
    gsap.ticker.add(stream);

    return () => {
      gsap.ticker.remove(stream);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      primitiveRef.current = null;
    };
  }, []);

  const active = hover?.bar ?? activeBar;
  const change = active.close - barsRef.current[0].open;
  const changePct = (change / barsRef.current[0].open) * 100;
  const zoneTone = model.activeUpper > model.activeLower ? THEME.sell : model.activeLower > model.activeUpper ? THEME.buy : THEME.text;

  return (
    <div
      ref={rootRef}
      style={{
        width: '100%',
        height: '100%',
        minHeight: 460,
        background: `radial-gradient(circle at 76% 16%, rgba(0, 230, 118, .08), transparent 27%),
          radial-gradient(circle at 22% 86%, rgba(242, 54, 69, .07), transparent 33%),
          ${THEME.background}`,
        overflow: 'hidden',
        position: 'relative',
        color: THEME.text,
        fontFamily: 'Arial, Helvetica, sans-serif',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      <div ref={hostRef} style={{ position: 'absolute', inset: 0, zIndex: 0 }} />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 1,
          pointerEvents: 'none',
          background:
            'linear-gradient(180deg, rgba(255,255,255,.022), transparent 12%, transparent 82%, rgba(255,255,255,.018)), linear-gradient(90deg, rgba(255,255,255,.014), transparent 16%, transparent 88%, rgba(0,0,0,.22))',
          mixBlendMode: 'screen',
          opacity: 0.7,
        }}
      />

      <div
        ref={readoutRef}
        style={{
          position: 'absolute',
          top: 10,
          left: 10,
          right: 96,
          zIndex: 3,
          width: 'fit-content',
          maxWidth: 'calc(100% - 130px)',
          padding: '8px 10px 9px',
          border: '1px solid rgba(120, 123, 134, .18)',
          borderRadius: 7,
          background: 'linear-gradient(135deg, rgba(19,23,34,.86), rgba(19,23,34,.42))',
          backdropFilter: 'blur(7px)',
          boxShadow: '0 12px 34px rgba(0,0,0,.22)',
          pointerEvents: 'none',
          textShadow: '0 1px 2px rgba(0,0,0,.52)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap', fontSize: 12, lineHeight: 1.25 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: THEME.text, fontWeight: 700 }}>
            <span ref={liveRef} style={{ width: 7, height: 7, borderRadius: 999, background: zoneTone, display: 'inline-block' }} />
            {CAPTURED_REFERENCE.displaySymbol} · {CAPTURED_REFERENCE.interval} · {CAPTURED_REFERENCE.exchange}
          </span>
          <span style={{ color: THEME.muted }}>O</span>
          <span>{formatPrice(active.open)}</span>
          <span style={{ color: THEME.muted }}>H</span>
          <span>{formatPrice(active.high)}</span>
          <span style={{ color: THEME.muted }}>L</span>
          <span>{formatPrice(active.low)}</span>
          <span style={{ color: THEME.muted }}>C</span>
          <span style={{ color: active.close >= active.open ? THEME.up : THEME.down }}>{formatPrice(active.close)}</span>
          <span style={{ color: change >= 0 ? THEME.up : THEME.down }}>
            {change >= 0 ? '+' : ''}
            {formatPrice(change)} ({changePct >= 0 ? '+' : ''}
            {changePct.toFixed(2)}%)
          </span>
        </div>
        <div style={{ display: 'flex', gap: 13, marginTop: 6, fontSize: 12, color: THEME.muted, whiteSpace: 'nowrap' }}>
          <span style={{ color: THEME.text }}>{CAPTURED_REFERENCE.title}</span>
          <span>
            Upper <strong style={{ color: THEME.sell }}>{model.currentUpperStrength}%</strong>
          </span>
          <span>
            Lower <strong style={{ color: THEME.buy }}>{model.currentLowerStrength}%</strong>
          </span>
          <span>
            RSI <strong style={{ color: THEME.text }}>{model.currentRsi.toFixed(1)}</strong>
          </span>
          <span>
            Zones <strong style={{ color: THEME.sell }}>{model.activeUpper}</strong>/<strong style={{ color: THEME.buy }}>{model.activeLower}</strong>
          </span>
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          left: 10,
          bottom: 10,
          zIndex: 3,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 9px',
          borderRadius: 8,
          background: THEME.pane,
          border: '1px solid rgba(120,123,134,.18)',
          color: THEME.muted,
          fontSize: 11,
          pointerEvents: 'none',
          boxShadow: '0 10px 28px rgba(0,0,0,.22)',
          backdropFilter: 'blur(7px)',
        }}
      >
        <span style={{ color: THEME.sell }}>upper wick = supply</span>
        <span style={{ color: 'rgba(120,123,134,.42)' }}>·</span>
        <span style={{ color: THEME.buy }}>lower wick = demand</span>
        <span style={{ color: 'rgba(120,123,134,.42)' }}>·</span>
        <span>threshold 80% of 200-bar max wick</span>
      </div>
    </div>
  );
}
