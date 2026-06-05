'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  CANDLE_PATTERN_REGISTRY,
  CandlePatternOverlayV2,
  detectUnifiedCandlePatterns,
  rankPatternSignals,
  type CandleInput,
  type CandlePatternEvent,
} from '@/lib/candle-vision';
import { SignalPanel } from './candle-vision/SignalPanel';
import type { PatternFamilyFilter, PatternScannerStats, SignalPanelEvent } from './candle-vision/types';

const THEME = {
  bg: '#0d111a',
  panel: 'rgba(16, 22, 34, .78)',
  border: 'rgba(148, 163, 184, .16)',
  text: '#e5e7eb',
  muted: '#8b94a7',
  grid: 'rgba(148, 163, 184, .11)',
  candleUp: '#7cffb2',
  candleDown: '#ff6b7c',
  bullish: '#21d07a',
  bearish: '#ff5263',
  neutral: '#f5c542',
  compression: '#38bdf8',
  setup: '#a78bfa',
  ta: '#fb923c',
};

const STREAM_INTERVAL_MS = 70;
const STREAM_TICKS_PER_BAR = 9;
const MAX_BARS = 260;
const DETECTOR_OPTIONS = { minConfidence: 0.78, lookback: 220 };
const DISPLAY_MAX_EVENTS = 8;
const SCAN_OPTIONS = {
  ...DETECTOR_OPTIONS,
  enableExpandedCandles: true,
  enableStructures: true,
  enableTaPatterns: true,
  maxStructureEvents: 18,
};

type HoverState = {
  event: CandlePatternEvent;
  candle: CandleInput;
} | null;

type ScanState = {
  raw: CandlePatternEvent[];
  visible: CandlePatternEvent[];
  stats: PatternScannerStats;
};

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function normalish(rand: () => number) {
  return rand() + rand() + rand() + rand() - 2;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function toSeriesData(candles: CandleInput[]): CandlestickData<UTCTimestamp>[] {
  return candles.map((bar) => ({
    time: bar.time as UTCTimestamp,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
  }));
}

function makeBar(time: number, open: number, close: number, high: number, low: number, volume: number): CandleInput {
  return { time, open, high: Math.max(high, open, close), low: Math.min(low, open, close), close, volume };
}

function generateCandles() {
  const rand = seeded(0xc0ffee);
  const start = Math.floor(Date.UTC(2026, 4, 18, 13, 30) / 1000);
  const candles: CandleInput[] = [];
  let close = 104.2;
  let drift = -0.02;
  let vol = 0.42;
  let wickScale = 0.36;
  let volumeBase = 1400;

  for (let i = 0; i < 176; i += 1) {
    if (i === 0 || rand() < 0.04) {
      drift = normalish(rand) * 0.028;
      vol = 0.16 + rand() * 0.32;
      wickScale = 0.08 + rand() * 0.26;
      volumeBase = 900 + rand() * 2500;
    }

    const gap = rand() < 0.025 ? normalish(rand) * vol : 0;
    const open = clamp(close + gap + normalish(rand) * vol * 0.2, 96, 116);
    close = clamp(open + drift + normalish(rand) * vol, 96, 116);

    const body = Math.abs(close - open);
    const upperWick = 0.06 + rand() * wickScale + body * (0.08 + rand() * 0.22);
    const lowerWick = 0.06 + rand() * wickScale + body * (0.08 + rand() * 0.22);
    const volumeShock = 1 + Math.min(1.8, body / Math.max(0.15, vol * 2.6));
    const volume = volumeBase * (0.65 + rand() * 0.95) * volumeShock;

    candles.push(
      makeBar(
        start + i * 60,
        open,
        close,
        Math.max(open, close) + upperWick,
        Math.min(open, close) - lowerWick,
        volume,
      ),
    );
  }

  return candles;
}

function streamCandles(previous: CandleInput[], tick: number, rand: () => number) {
  const next = previous.slice();
  const last = next[next.length - 1];
  const newBar = tick % STREAM_TICKS_PER_BAR === 0;
  const regime = Math.floor(tick / 64);
  const drift = ((regime % 5) - 2) * 0.006 + normalish(rand) * 0.008;
  const vol = 0.08 + (regime % 4) * 0.03 + rand() * 0.1;
  const wickScale = 0.06 + rand() * 0.16;
  const open = newBar ? clamp(last.close + normalish(rand) * vol * 0.2, 96, 116) : last.open;
  const close = clamp(last.close + drift + normalish(rand) * vol, 96, 116);
  const body = Math.abs(close - open);
  const high = Math.max(newBar ? open : last.high, open, close + rand() * (wickScale + body * 0.08));
  const low = Math.min(newBar ? open : last.low, open, close - rand() * (wickScale + body * 0.08));

  if (newBar) {
    const time = last.time + 60;
    next.push(
      makeBar(
        time,
        open,
        close,
        Math.max(open, close) + 0.12 + rand() * wickScale,
        Math.min(open, close) - 0.12 - rand() * wickScale,
        1000 + rand() * 2600 + body * 1800,
      ),
    );
  } else {
    next[next.length - 1] = makeBar(last.time, open, close, high, low, (last.volume ?? 1400) + rand() * 280 + body * 220);
  }

  return next.length > MAX_BARS ? next.slice(next.length - MAX_BARS) : next;
}

function scanCandles(candles: CandleInput[], showAll = false): ScanState {
  const raw = detectUnifiedCandlePatterns(candles, SCAN_OPTIONS);
  const ranked = rankPatternSignals(raw, {
    latestIndex: candles.length - 1,
    maxVisible: showAll ? 30 : DISPLAY_MAX_EVENTS,
    minVisibleScore: showAll ? 0.36 : 0.58,
    recencyWindow: showAll ? 180 : 110,
    perKindLimit: showAll ? 4 : 1,
    perFamilyLimit: showAll ? 22 : 8,
    allowOverlaps: showAll,
  });
  const visible = ranked.visible.map((signal) => signal.event).sort((a, b) => a.endIndex - b.endIndex);
  return {
    raw,
    visible,
    stats: {
      supported: CANDLE_PATTERN_REGISTRY.supported().length,
      detectedRaw: raw.length,
      visible: visible.length,
      watchlist: raw.filter((event) => event.status === 'forming').length,
    },
  };
}

function markVisible(raw: CandlePatternEvent[], visible: CandlePatternEvent[]): SignalPanelEvent[] {
  const visibleIds = new Set(visible.map((event) => event.id));
  return raw.map((event) => ({ ...event, visible: visibleIds.has(event.id) }));
}

export function CandleVisionScannerChart() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const primitiveRef = useRef<CandlePatternOverlayV2 | null>(null);
  const chartCleanupRef = useRef<(() => void) | null>(null);
  const randomRef = useRef(seeded(0x51a7));
  const tickRef = useRef(0);
  const initialCandles = useMemo(() => generateCandles(), []);
  const candlesRef = useRef(initialCandles);
  const eventsRef = useRef<CandlePatternEvent[]>([]);
  const showAllRef = useRef(false);
  const [activeFamily, setActiveFamily] = useState<PatternFamilyFilter>('all');
  const [showAll, setShowAll] = useState(false);
  const [scan, setScan] = useState<ScanState>(() => {
    const starting = scanCandles(initialCandles, false);
    eventsRef.current = starting.visible;
    return starting;
  });
  const [hover, setHover] = useState<HoverState>(null);
  const panelEvents = useMemo(() => markVisible(scan.raw, scan.visible), [scan.raw, scan.visible]);

  const handleShowAllChange = (nextShowAll: boolean) => {
    showAllRef.current = nextShowAll;
    setShowAll(nextShowAll);
    const nextScan = scanCandles(candlesRef.current, nextShowAll);
    eventsRef.current = nextScan.visible;
    primitiveRef.current?.setData(candlesRef.current, nextScan.visible);
    setScan(nextScan);
  };

  const handleReplay = () => {
    primitiveRef.current?.updateAllViews();
    gsap.fromTo('[data-cv-panel]', { scale: 0.992 }, { scale: 1, duration: 0.22, ease: 'power2.out' });
  };

  useEffect(() => {
    const root = rootRef.current;
    const ctx = gsap.context(() => {
      gsap.fromTo('[data-cv-panel]', { autoAlpha: 0, y: -8 }, { autoAlpha: 1, y: 0, duration: 0.48, stagger: 0.06, ease: 'power2.out' });
    }, root ?? undefined);
    return () => ctx.revert();
  }, []);

  const mountChart = useCallback((host: HTMLDivElement) => {
    host.dataset.cvChartMounted = '1';
    const startingScan = scanCandles(candlesRef.current, showAllRef.current);
    eventsRef.current = startingScan.visible;

    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: THEME.bg },
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
        vertLine: { color: 'rgba(148, 163, 184, .5)', style: LineStyle.Dashed, labelBackgroundColor: '#111827' },
        horzLine: { color: 'rgba(148, 163, 184, .5)', style: LineStyle.Dashed, labelBackgroundColor: '#111827' },
      },
      rightPriceScale: {
        borderColor: 'rgba(148,163,184,.18)',
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      timeScale: {
        borderColor: 'rgba(148,163,184,.18)',
        timeVisible: true,
        secondsVisible: false,
        barSpacing: 10.4,
        rightOffset: 12,
        minBarSpacing: 3,
        tickMarkFormatter: (time: Time) => {
          const date = new Date(Number(time) * 1000);
          return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
        },
      },
      localization: {
        priceFormatter: (price: number) => price.toFixed(2),
        timeFormatter: (time: Time) => new Date(Number(time) * 1000).toUTCString().replace('GMT', 'UTC'),
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: THEME.candleUp,
      downColor: THEME.candleDown,
      borderUpColor: '#d9ffe9',
      borderDownColor: '#ffd3da',
      wickUpColor: 'rgba(217,255,233,.95)',
      wickDownColor: 'rgba(255,211,218,.95)',
      borderVisible: true,
      priceLineVisible: true,
      priceLineColor: '#38bdf8',
      priceLineWidth: 1,
      lastValueVisible: true,
    });
    series.setData(toSeriesData(candlesRef.current));

    const primitive = new CandlePatternOverlayV2(candlesRef.current, startingScan.visible, {
      showLabels: true,
      maxLabels: 5,
      maxEvents: 32,
      minDisplayConfidence: showAllRef.current ? 0.36 : 0.58,
      fillOpacity: 0.07,
      strokeOpacity: 0.72,
      scanlineOpacity: 0.72,
      labelCollisionPadding: 24,
      theme: {
        bullish: THEME.bullish,
        bearish: THEME.bearish,
        neutral: THEME.neutral,
        compression: THEME.compression,
        setup: THEME.setup,
        ta: THEME.ta,
        text: THEME.text,
      },
    });
    series.attachPrimitive(primitive as any);

    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, candlesRef.current.length - 72), to: candlesRef.current.length + 10 });
    chart.subscribeCrosshairMove((param) => {
      if (!param.time) {
        setHover(null);
        return;
      }
      const index = candlesRef.current.findIndex((item) => item.time === param.time);
      if (index < 0) {
        setHover(null);
        return;
      }
      const event = eventsRef.current
        .slice()
        .reverse()
        .find((item) => index >= item.startIndex && index <= item.endIndex);
      setHover(event ? { event, candle: candlesRef.current[index] } : null);
    });

    chartRef.current = chart;
    seriesRef.current = series;
    primitiveRef.current = primitive;
    setScan(startingScan);

    let accumulatedMs = 0;
    let previousTime = gsap.ticker.time;
    const update = () => {
      primitive.updateAllViews();
      const now = gsap.ticker.time;
      accumulatedMs += (now - previousTime) * 1000;
      previousTime = now;
      if (accumulatedMs < STREAM_INTERVAL_MS) return;
      accumulatedMs %= STREAM_INTERVAL_MS;

      tickRef.current += 1;
      const previous = candlesRef.current;
      const next = streamCandles(previous, tickRef.current, randomRef.current);
      const nextScan = scanCandles(next, showAllRef.current);
      const latest = next[next.length - 1];
      const trimmed = next.length === MAX_BARS && previous.length === MAX_BARS && next[0]?.time !== previous[0]?.time;
      candlesRef.current = next;
      eventsRef.current = nextScan.visible;

      if (trimmed || tickRef.current % STREAM_TICKS_PER_BAR === 0) {
        series.setData(toSeriesData(next));
      } else {
        series.update({
          time: latest.time as UTCTimestamp,
          open: latest.open,
          high: latest.high,
          low: latest.low,
          close: latest.close,
        });
      }
      primitive.setData(next, nextScan.visible);
      setScan(nextScan);
    };
    gsap.ticker.add(update);

    return () => {
      gsap.ticker.remove(update);
      chart.remove();
      delete host.dataset.cvChartMounted;
      chartRef.current = null;
      seriesRef.current = null;
      primitiveRef.current = null;
    };
  }, []);

  const setChartHost = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) {
        chartCleanupRef.current?.();
        chartCleanupRef.current = null;
        hostRef.current = null;
        return;
      }
      hostRef.current = node;
      if (chartRef.current) return;
      chartCleanupRef.current = mountChart(node);
      node.dataset.cvChartCleanup = 'mounted';
    },
    [mountChart],
  );

  return (
    <div
      ref={rootRef}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        minHeight: 620,
        overflow: 'hidden',
        color: THEME.text,
        fontFamily: 'Arial, Helvetica, sans-serif',
        fontVariantNumeric: 'tabular-nums',
        background: `radial-gradient(circle at 22% 18%, rgba(56,189,248,.12), transparent 28%),
          radial-gradient(circle at 74% 72%, rgba(34,197,94,.08), transparent 30%),
          ${THEME.bg}`,
      }}
    >
      <div ref={setChartHost} data-cv-host style={{ position: 'absolute', inset: 0 }} />

      <div
        data-cv-panel
        style={{
          position: 'absolute',
          left: 18,
          top: 16,
          zIndex: 3,
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          padding: '10px 12px',
          border: `1px solid ${THEME.border}`,
          borderRadius: 8,
          background: THEME.panel,
          backdropFilter: 'blur(16px)',
          boxShadow: '0 16px 44px rgba(0,0,0,.28)',
        }}
      >
        <span style={{ width: 9, height: 9, borderRadius: 999, background: THEME.compression, boxShadow: `0 0 18px ${THEME.compression}` }} />
        <div>
          <div style={{ fontSize: 13, fontWeight: 700 }}>Candle Vision</div>
          <div style={{ color: THEME.muted, fontSize: 11 }}>classic patterns + shape-template scanner</div>
        </div>
      </div>

      <div
        data-cv-panel
        style={{
          position: 'absolute',
          right: 16,
          top: 16,
          zIndex: 3,
          maxHeight: 'calc(100% - 32px)',
          display: 'grid',
          gap: 10,
        }}
      >
        <SignalPanel
          stats={scan.stats}
          events={panelEvents}
          activeFamily={activeFamily}
          onFamilyChange={setActiveFamily}
          showAll={showAll}
          onShowAllChange={handleShowAllChange}
          onReplay={handleReplay}
        />
        {hover ? (
          <div
            style={{
              width: 330,
              padding: 12,
              border: `1px solid ${THEME.border}`,
              borderRadius: 8,
              background: 'rgba(16,22,34,.84)',
              backdropFilter: 'blur(16px)',
              boxShadow: '0 16px 44px rgba(0,0,0,.28)',
            }}
          >
            <div style={{ color: hover.event.color, fontSize: 12, fontWeight: 700 }}>{hover.event.label}</div>
            <div style={{ color: THEME.muted, fontSize: 11, lineHeight: 1.45, marginTop: 4 }}>{hover.event.description}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
