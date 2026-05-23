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

type ClusterDot = {
  logical: number;
  price: number;
  color: string;
};

type ProfileBox = {
  startLogical: number;
  endLogical: number;
  bottom: number;
  top: number;
  color: string;
  borderColor?: string;
  isPoc: boolean;
};

type PocLine = {
  clusterIndex: number;
  fromLogical: number;
  toLogical: number;
  price: number;
  volume: number;
  totalVolume: number;
  displayVolume?: string;
  displayTotal?: string;
  color: string;
  endLogical: number;
  rangeLow: number;
  rangeHigh: number;
};

type ClusterProfile = {
  boxes: ProfileBox[];
  dots: ClusterDot[];
  pocLines: PocLine[];
  minPrice: number;
  maxPrice: number;
  latestLogical: number;
  latestClose: number;
};

type Hover = {
  bar: Bar;
  point: { x: number; y: number };
} | null;

const PALETTE = [
  '#2196f3',
  '#f44336',
  '#4caf50',
  '#ff9800',
  '#9c27b0',
  '#00bcd4',
  '#ffeb3b',
  '#e91e63',
  '#795548',
  '#607d8b',
];

const SCRIPT_INPUTS = {
  lookback: 200,
  clusters: 5,
  iterations: 50,
  rowsPerCluster: 20,
  vpWidthBars: 40,
  vpOffsetBars: 10,
  showDots: false,
};

const STREAM_INTERVAL_MS = 50;
const STREAM_TICKS_PER_BAR = 7;
const MAX_STREAM_BARS = 420;

const CAPTURED_CHART = {
  symbol: 'BINANCE:BTCUSDT',
  interval: '15',
  title: 'Bitcoin / TetherUS · 15 · Binance',
  studyTitle: 'LuxAlgo - Clusters Volume Profile',
  background: '#131722',
  text: '#d1d4dc',
  muted: '#787b86',
  barSpacing: 4.35,
  rightOffset: 136,
};

const REFERENCE_PROFILE_LABELS: Record<number, { poc: string; total: string }> = {
  0: { poc: '5.559K', total: '47.018K' },
  1: { poc: '4.149K', total: '44.843K' },
  2: { poc: '4.075K', total: '36.7K' },
  3: { poc: '4.166K', total: '38.392K' },
  4: { poc: '3.214K', total: '31.819K' },
};

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

const BTC_TREND: Array<[number, number]> = [
  [0, 76300],
  [56, 75800],
  [98, 73400],
  [122, 76000],
  [136, 75400],
  [150, 75500],
  [166, 74000],
  [178, 72400],
  [194, 72700],
  [208, 72200],
  [222, 70500],
  [236, 69900],
  [246, 70700],
  [256, 69000],
  [266, 67100],
  [278, 66800],
  [290, 65000],
  [300, 63700],
  [310, 60700],
  [320, 64200],
  [330, 65500],
  [339, 68588.91],
];

function trendAt(index: number) {
  for (let i = 0; i < BTC_TREND.length - 1; i += 1) {
    const [aIndex, aValue] = BTC_TREND[i];
    const [bIndex, bValue] = BTC_TREND[i + 1];
    if (index >= aIndex && index <= bIndex) {
      return lerp(aValue, bValue, (index - aIndex) / Math.max(1, bIndex - aIndex));
    }
  }
  return BTC_TREND[BTC_TREND.length - 1][1];
}

function makeReferenceBars(): Bar[] {
  const rand = seeded(0x7a11c0);
  const start = Math.floor(Date.UTC(2026, 1, 4, 6, 0) / 1000);
  const bars: Bar[] = [];
  let previousClose = trendAt(0);

  for (let i = 0; i < 340; i += 1) {
    const trend = trendAt(i);
    const crash = i > 248 && i < 316;
    const rebound = i > 316;
    const volatility = crash ? 680 : rebound ? 330 : i < 80 ? 300 : 245;
    const wave = Math.sin(i / 5.1) * 135 + Math.cos(i / 12.5) * 210;
    const open = previousClose + (rand() - 0.5) * volatility;
    const close = trend + wave + (rand() - 0.5) * volatility;
    const wick = 110 + rand() * (crash ? 950 : 430);
    let volume = 45 + rand() * 230;

    if (i > 46 && i < 80) volume += 95 + (80 - Math.abs(63 - i)) * 7;
    if (i > 188 && i < 230) volume += 140 + (230 - Math.abs(210 - i)) * 9;
    if (i > 252 && i < 330) volume += 130 + (i - 252) * 1.7;

    bars.push({
      time: (start + i * 15 * 60) as UTCTimestamp,
      open,
      high: Math.max(open, close) + wick * (0.35 + rand()),
      low: Math.min(open, close) - wick * (0.35 + rand()),
      close,
      volume,
    });
    previousClose = close;
  }

  const last = bars[bars.length - 1];
  bars[bars.length - 1] = {
    ...last,
    open: 68194.9,
    high: 68600,
    low: 67772,
    close: 68588.91,
    volume: 382,
  };

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

function streamBars(current: Bar[], tick: number, rand: () => number): Bar[] {
  const bars = current.slice();
  const last = { ...bars[bars.length - 1] };
  const pulse = Math.sin(tick / 3.2) * 9 + Math.sin((bars.length + tick) / 16) * 14;
  const noise = (rand() - 0.5) * 18;
  const delta = pulse + noise;
  const close = Math.max(50_000, last.close + delta);
  const high = Math.max(last.high, close + 10 + rand() * 42);
  const low = Math.min(last.low, close - 10 - rand() * 42);
  const volume = Math.max(40, last.volume * 0.82 + 28 + Math.abs(delta) * 0.8 + rand() * 42);

  bars[bars.length - 1] = {
    ...last,
    close,
    high,
    low,
    volume,
  };

  if (tick > 0 && tick % STREAM_TICKS_PER_BAR === 0) {
    const open = close;
    const newClose = Math.max(50_000, open + (rand() - 0.5) * 72);
    bars.push({
      time: (last.time + 15 * 60) as UTCTimestamp,
      open,
      high: Math.max(open, newClose) + 38 + rand() * 100,
      low: Math.min(open, newClose) - 38 - rand() * 100,
      close: newClose,
      volume: Math.max(42, volume * (0.58 + rand() * 0.4)),
    });
  }

  return bars.slice(-MAX_STREAM_BARS);
}

function applyVisibleWindow(chart: IChartApi, profile: ClusterProfile, bars: Bar[]) {
  chart.timeScale().setVisibleLogicalRange({
    from: bars.length - SCRIPT_INPUTS.lookback - 18,
    to: bars.length + 126,
  });

  chart.priceScale('right').setVisibleRange({ from: 58_000, to: 78_000 });
}

function formatVolume(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 3)}K`;
  return value.toFixed(0);
}

function formatPrice(value: number) {
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function colorWithAlpha(hex: string, alpha: number) {
  const clean = hex.replace('#', '');
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function calculateClusterProfile(bars: Bar[]): ClusterProfile {
  const lookback = Math.min(SCRIPT_INPUTS.lookback, bars.length);
  const lastIndex = bars.length - 1;
  const items = Array.from({ length: lookback }, (_, offset) => {
    const logical = lastIndex - offset;
    const bar = bars[logical];
    return {
      logical,
      price: (bar.high + bar.low) / 2,
      volume: bar.volume,
      high: bar.high,
      low: bar.low,
    };
  });

  const minPrice = Math.min(...items.map((item) => item.price));
  const maxPrice = Math.max(...items.map((item) => item.price));
  const step = (maxPrice - minPrice) / (SCRIPT_INPUTS.clusters + 1);
  const centroids = Array.from({ length: SCRIPT_INPUTS.clusters }, (_, i) => minPrice + (i + 1) * step);
  const assignments = new Array<number>(items.length).fill(0);

  for (let iter = 0; iter < SCRIPT_INPUTS.iterations; iter += 1) {
    for (let i = 0; i < items.length; i += 1) {
      let best = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let c = 0; c < centroids.length; c += 1) {
        const distance = Math.abs(items[i].price - centroids[c]);
        if (distance < bestDistance) {
          best = c;
          bestDistance = distance;
        }
      }
      assignments[i] = best;
    }

    const weightedPrice = new Array<number>(SCRIPT_INPUTS.clusters).fill(0);
    const weightedVolume = new Array<number>(SCRIPT_INPUTS.clusters).fill(0);
    for (let i = 0; i < items.length; i += 1) {
      const cluster = assignments[i];
      weightedPrice[cluster] += items[i].price * items[i].volume;
      weightedVolume[cluster] += items[i].volume;
    }
    for (let c = 0; c < centroids.length; c += 1) {
      if (weightedVolume[c] > 0) centroids[c] = weightedPrice[c] / weightedVolume[c];
    }
  }

  const boxes: ProfileBox[] = [];
  const dots: ClusterDot[] = [];
  const pocLines: PocLine[] = [];
  const calcStart = lastIndex - lookback + 1;
  const vpStartX = lastIndex + SCRIPT_INPUTS.vpOffsetBars;
  let labelsUsed = 0;
  const reservedForMetrics = SCRIPT_INPUTS.clusters * 2;

  for (let cluster = 0; cluster < SCRIPT_INPUTS.clusters; cluster += 1) {
    const color = PALETTE[cluster % PALETTE.length];
    const clusterItems = items.filter((_, i) => assignments[i] === cluster);
    if (!clusterItems.length) continue;

    let clusterMin = Number.POSITIVE_INFINITY;
    let clusterMax = Number.NEGATIVE_INFINITY;
    let totalVolume = 0;

    for (const item of clusterItems) {
      clusterMin = Math.min(clusterMin, item.low);
      clusterMax = Math.max(clusterMax, item.high);
      totalVolume += item.volume;
      if (SCRIPT_INPUTS.showDots && labelsUsed < 500 - reservedForMetrics) {
        dots.push({ logical: item.logical, price: item.price, color });
        labelsUsed += 1;
      }
    }

    const binSize = Math.max((clusterMax - clusterMin) / SCRIPT_INPUTS.rowsPerCluster, 0.01);
    const binVolumes = new Array<number>(SCRIPT_INPUTS.rowsPerCluster).fill(0);

    for (const item of clusterItems) {
      const wickRange = Math.max(item.high - item.low, 0.01);
      for (let bin = 0; bin < SCRIPT_INPUTS.rowsPerCluster; bin += 1) {
        const bottom = clusterMin + bin * binSize;
        const top = bottom + binSize;
        const intersectLow = Math.max(item.low, bottom);
        const intersectHigh = Math.min(item.high, top);
        if (intersectHigh > intersectLow) {
          binVolumes[bin] += item.volume * ((intersectHigh - intersectLow) / wickRange);
        }
      }
    }

    const maxBinVolume = Math.max(...binVolumes);
    const pocBinIndex = binVolumes.indexOf(maxBinVolume);
    if (maxBinVolume <= 0) continue;

    for (let bin = 0; bin < SCRIPT_INPUTS.rowsPerCluster; bin += 1) {
      const volume = binVolumes[bin];
      if (volume <= 0 || boxes.length >= 500) continue;
      const bottom = clusterMin + bin * binSize;
      const top = bottom + binSize;
      const width = Math.max(0.25, Math.trunc((volume / maxBinVolume) * SCRIPT_INPUTS.vpWidthBars));
      const endLogical = vpStartX + width;
      const isPoc = bin === pocBinIndex;
      boxes.push({
        startLogical: vpStartX,
        endLogical,
        bottom,
        top,
        color: isPoc ? color : colorWithAlpha(color, 0.25),
        borderColor: isPoc ? color : undefined,
        isPoc,
      });

      if (isPoc) {
        const price = (top + bottom) / 2;
        const referenceLabel = REFERENCE_PROFILE_LABELS[cluster];
        pocLines.push({
          clusterIndex: cluster,
          fromLogical: calcStart,
          toLogical: vpStartX,
          price,
          volume,
          totalVolume,
          displayVolume: referenceLabel?.poc,
          displayTotal: referenceLabel?.total,
          color,
          endLogical,
          rangeLow: clusterMin,
          rangeHigh: clusterMax,
        });
      }
    }
  }

  return {
    boxes,
    dots,
    pocLines,
    minPrice: Math.min(...items.map((item) => item.low)),
    maxPrice: Math.max(...items.map((item) => item.high)),
    latestLogical: lastIndex,
    latestClose: bars[lastIndex].close,
  };
}

class ClusterVolumePrimitive {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<'Candlestick'> | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly paneView = {
    zOrder: () => 'top' as const,
    renderer: () => ({
      draw: (target: any) => {
        target.useMediaCoordinateSpace(({ context, mediaSize }: { context: CanvasRenderingContext2D; mediaSize: { width: number; height: number } }) => {
          this.draw(context, mediaSize);
        });
      },
    }),
  };

  constructor(private profile: ClusterProfile) {}

  setProfile(profile: ClusterProfile) {
    this.profile = profile;
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
        minValue: this.profile.minPrice,
        maxValue: this.profile.maxPrice,
      },
      margins: { above: 0.08, below: 0.08 },
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

    const firstBox = this.profile.boxes[0];
    let profileStartX = mediaSize.width;
    if (firstBox) {
      const panelX = this.x(firstBox.startLogical);
      if (panelX != null && panelX < mediaSize.width) {
        profileStartX = panelX;
        const gradient = ctx.createLinearGradient(panelX, 0, mediaSize.width, 0);
        gradient.addColorStop(0, 'rgba(7, 10, 18, .20)');
        gradient.addColorStop(0.42, 'rgba(7, 10, 18, .10)');
        gradient.addColorStop(1, 'rgba(7, 10, 18, 0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(panelX - 6, 0, mediaSize.width - panelX + 6, mediaSize.height);
      }
    }

    for (const box of this.profile.boxes) {
      const x1 = this.x(box.startLogical);
      const x2 = this.x(box.endLogical);
      const yTop = this.y(box.top);
      const yBottom = this.y(box.bottom);
      if (x1 == null || x2 == null || yTop == null || yBottom == null) continue;
      const right = Math.max(x1, x2);
      const left = Math.max(Math.min(x1, x2), profileStartX);
      const width = Math.max(1, right - left);
      const top = Math.min(yTop, yBottom);
      const height = Math.max(1, Math.abs(yBottom - yTop));
      if (right < profileStartX || left > mediaSize.width || left + width < 0) continue;

      const gap = box.isPoc ? 0 : Math.min(1.4, Math.max(0, height * 0.18));
      const rowTop = top + gap / 2;
      const rowHeight = Math.max(1, height - gap);

      if (box.isPoc) {
        ctx.save();
        ctx.shadowColor = box.color;
        ctx.shadowBlur = 6;
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = box.color;
        ctx.fillRect(left, rowTop - 2, width, rowHeight + 4);
        ctx.restore();
      }

      ctx.globalAlpha = box.isPoc ? 0.96 : 0.46;
      ctx.fillStyle = box.color;
      ctx.fillRect(left, rowTop, width, rowHeight);

      if (!box.isPoc && height >= 4) {
        ctx.globalAlpha = 0.24;
        ctx.fillStyle = '#131722';
        ctx.fillRect(left, rowTop, width, 1);
      }

      ctx.globalAlpha = 1;
      if (box.borderColor) {
        ctx.strokeStyle = box.borderColor;
        ctx.lineWidth = 0.75;
        ctx.strokeRect(left + 0.5, rowTop + 0.5, Math.max(0, width - 1), Math.max(0, rowHeight - 1));
      }
    }

    for (const line of this.profile.pocLines) {
      const x1 = this.x(line.fromLogical);
      const x2 = this.x(line.toLogical);
      const y = this.y(line.price);
      const labelX = this.x(line.endLogical);
      if (x1 == null || x2 == null || y == null) continue;
      ctx.save();
      ctx.strokeStyle = line.color;
      ctx.setLineDash([7, 9]);
      ctx.globalAlpha = 0.86;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x1, y);
      ctx.lineTo(x2, y);
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.strokeStyle = line.color;
      ctx.shadowColor = line.color;
      ctx.shadowBlur = 8;
      ctx.globalAlpha = 0.2;
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(Math.max(x2 - 1, x1), y);
      ctx.lineTo(labelX ?? x2, y);
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = line.color;
      ctx.textAlign = 'right';
      ctx.font = '11px Arial, Helvetica, sans-serif';
      ctx.globalAlpha = 0.96;
      ctx.fillText(line.displayVolume ?? formatVolume(line.volume), Math.max(74, x1 - 8), y);
      ctx.globalAlpha = 1;
      if (labelX != null) {
        ctx.textAlign = 'left';
        ctx.font = '12px Arial, Helvetica, sans-serif';
        ctx.fillText(`Total: ${line.displayTotal ?? formatVolume(line.totalVolume)}`, labelX + 18, y);
      }
    }

    for (const dot of this.profile.dots) {
      const x = this.x(dot.logical);
      const y = this.y(dot.price);
      if (x == null || y == null || x < -10 || x > mediaSize.width + 10 || y < -10 || y > mediaSize.height + 10) continue;
      ctx.beginPath();
      ctx.arc(x, y, 2.1, 0, Math.PI * 2);
      ctx.fillStyle = dot.color;
      ctx.fill();
    }

    ctx.restore();
  }
}

export function ClustersVolumeProfileChart() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const readoutRef = useRef<HTMLDivElement | null>(null);
  const liveBadgeRef = useRef<HTMLSpanElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const primitiveRef = useRef<ClusterVolumePrimitive | null>(null);
  const tickRef = useRef(0);
  const streamRandomRef = useRef(seeded(0x51e4d));
  const [hover, setHover] = useState<Hover>(null);
  const initialBars = useMemo(() => makeReferenceBars(), []);
  const barsRef = useRef<Bar[]>(initialBars);
  const firstOpenRef = useRef(initialBars[0].open);
  const [activeBar, setActiveBar] = useState<Bar>(() => initialBars[initialBars.length - 1]);

  useEffect(() => {
    const ctx = gsap.context(() => {
      if (readoutRef.current) {
        gsap.fromTo(
          readoutRef.current,
          { autoAlpha: 0, y: -4 },
          { autoAlpha: 1, y: 0, duration: 0.42, ease: 'power2.out' },
        );
      }
      if (liveBadgeRef.current) {
        gsap.to(liveBadgeRef.current, {
          autoAlpha: 1,
          boxShadow: '0 0 14px rgba(38,166,154,.42), inset 0 0 10px rgba(38,166,154,.18)',
          duration: 0.72,
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
    const initialBars = barsRef.current;
    const initialProfile = calculateClusterProfile(initialBars);

    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: CAPTURED_CHART.background },
        textColor: CAPTURED_CHART.text,
        fontFamily: 'Arial, Helvetica, sans-serif',
        fontSize: 12,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(54, 60, 78, 0)' },
        horzLines: { color: 'rgba(54, 60, 78, 0)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(120,123,134,.55)', style: LineStyle.Dashed, labelBackgroundColor: '#363A45' },
        horzLine: { color: 'rgba(120,123,134,.55)', style: LineStyle.Dashed, labelBackgroundColor: '#363A45' },
      },
      rightPriceScale: {
        visible: true,
        borderColor: '#d1d4dc',
        scaleMargins: { top: 0.04, bottom: 0.09 },
        entireTextOnly: false,
      },
      timeScale: {
        borderColor: '#d1d4dc',
        timeVisible: true,
        secondsVisible: false,
        barSpacing: CAPTURED_CHART.barSpacing,
        rightOffset: CAPTURED_CHART.rightOffset,
        minBarSpacing: 0.9,
        tickMarkFormatter: (time: Time) => {
          const date = new Date(Number(time) * 1000);
          const hours = date.getUTCHours().toString().padStart(2, '0');
          const mins = date.getUTCMinutes().toString().padStart(2, '0');
          return hours === '00' && mins === '00' ? String(date.getUTCDate()) : `${hours}:${mins}`;
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
      upColor: 'rgba(247,250,255,1)',
      downColor: 'rgba(118,126,141,1)',
      borderVisible: true,
      borderUpColor: 'rgba(255,255,255,.96)',
      borderDownColor: 'rgba(76,83,98,.98)',
      wickUpColor: 'rgba(205,215,230,.9)',
      wickDownColor: 'rgba(91,99,116,.9)',
      priceLineVisible: false,
      priceLineColor: '#d1d4dc',
      priceLineWidth: 1,
      lastValueVisible: true,
    });

    candleSeries.setData(toCandles(initialBars));

    const primitive = new ClusterVolumePrimitive(initialProfile);
    candleSeries.attachPrimitive(primitive as any);

    applyVisibleWindow(chart, initialProfile, initialBars);

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

    let accumulatedMs = 0;
    let previousTime = gsap.ticker.time;
    const stream = () => {
      const now = gsap.ticker.time;
      accumulatedMs += (now - previousTime) * 1000;
      previousTime = now;
      if (accumulatedMs < STREAM_INTERVAL_MS) return;
      accumulatedMs %= STREAM_INTERVAL_MS;

      tickRef.current += 1;
      const previousBars = barsRef.current;
      const nextBars = streamBars(barsRef.current, tickRef.current, streamRandomRef.current);
      const nextProfile = calculateClusterProfile(nextBars);
      barsRef.current = nextBars;

      const latest = nextBars[nextBars.length - 1];
      const trimmed =
        nextBars.length === MAX_STREAM_BARS &&
        previousBars.length === MAX_STREAM_BARS &&
        nextBars[0]?.time !== previousBars[0]?.time;

      if (trimmed) {
        candleSeries.setData(toCandles(nextBars));
      } else {
        candleSeries.update({
          time: latest.time,
          open: latest.open,
          high: latest.high,
          low: latest.low,
          close: latest.close,
        });
      }

      setActiveBar(latest);
      primitive.setProfile(nextProfile);
      applyVisibleWindow(chart, nextProfile, nextBars);

      if (readoutRef.current) {
        gsap.fromTo(
          readoutRef.current,
          { autoAlpha: 0.7 },
          { autoAlpha: 1, duration: 0.18, ease: 'power1.out', overwrite: true },
        );
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
  const change = active.close - firstOpenRef.current;
  const changePct = (change / firstOpenRef.current) * 100;

  return (
    <div
      ref={rootRef}
      style={{
        width: '100%',
        height: '100%',
        minHeight: 420,
        background: CAPTURED_CHART.background,
        overflow: 'hidden',
        position: 'relative',
        color: CAPTURED_CHART.text,
        fontFamily: 'Arial, Helvetica, sans-serif',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      <div
        ref={hostRef}
        style={{
          position: 'absolute',
          top: 66,
          left: 8,
          right: 8,
          bottom: 28,
          zIndex: 0,
          border: '1px solid rgba(245,247,255,.92)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          top: 66,
          left: 8,
          right: 8,
          bottom: 28,
          zIndex: 1,
          pointerEvents: 'none',
          border: '1px solid rgba(245,247,255,.92)',
          background: 'linear-gradient(90deg, rgba(255,255,255,.012), transparent 18%, transparent 84%, rgba(0,0,0,.12))',
          mixBlendMode: 'screen',
          opacity: 0.72,
        }}
      />
      <div
        ref={readoutRef}
        style={{
          position: 'absolute',
          top: 8,
          left: 8,
          right: 8,
          color: '#d1d4dc',
          fontSize: 18,
          lineHeight: 1.42,
          pointerEvents: 'none',
          zIndex: 3,
          textShadow: '0 1px 2px rgba(0,0,0,.55)',
          width: 'fit-content',
          maxWidth: 'calc(100% - 128px)',
          padding: 0,
          border: 'none',
          borderRadius: 0,
          background: 'transparent',
          backdropFilter: 'none',
        }}
      >
        <div>
          <strong>LuxAlgo</strong> published on TradingView.com, February 06, 2026 10:11:42 EST
        </div>
        <div>
          <strong>{CAPTURED_CHART.symbol}, {CAPTURED_CHART.interval}</strong>{' '}
          <span>{formatPrice(active.close)}</span>{' '}
          <span style={{ color: change >= 0 ? '#26a69a' : '#ef5350' }}>{change >= 0 ? '▲' : '▼'} {formatPrice(Math.abs(change))} ({changePct.toFixed(2)}%)</span>{' '}
          <span>O:{formatPrice(active.open)}</span>{' '}
          <span>H:{formatPrice(active.high)}</span>{' '}
          <span>L:{formatPrice(active.low)}</span>{' '}
          <span>C:{formatPrice(active.close)}</span>
        </div>
        <span ref={liveBadgeRef} style={{ display: 'none' }} />
      </div>
      <div
        style={{
          position: 'absolute',
          top: 84,
          left: 22,
          zIndex: 3,
          pointerEvents: 'none',
          color: '#f5f7ff',
          fontSize: 18,
          lineHeight: 1.5,
          fontWeight: 700,
          textShadow: '0 1px 2px rgba(0,0,0,.42)',
        }}
      >
        <div>{CAPTURED_CHART.title}</div>
        <div>{CAPTURED_CHART.studyTitle}</div>
      </div>
      <div
        style={{
          position: 'absolute',
          right: 6,
          top: 74,
          padding: '8px 11px',
          borderRadius: 5,
          border: '1px solid rgba(209,212,220,.5)',
          background: '#0f1117',
          color: '#d1d4dc',
          fontSize: 12,
          fontWeight: 700,
          pointerEvents: 'none',
          zIndex: 3,
        }}
      >
        USDT
      </div>
      <div
        style={{
          position: 'absolute',
          left: 8,
          bottom: 0,
          color: '#d1d4dc',
          fontSize: 24,
          fontWeight: 800,
          pointerEvents: 'none',
          opacity: 0.92,
          zIndex: 3,
        }}
      >
        TradingView
      </div>
    </div>
  );
}
