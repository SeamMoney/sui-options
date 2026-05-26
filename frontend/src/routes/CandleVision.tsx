import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import gsap from "gsap";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type CandlestickData,
  type IChartApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  CANDLE_PATTERN_REGISTRY,
  DEFAULT_MICRO_BOT_PRESETS,
  calibrateMicroBot,
  createMicroBotState,
  decideTradeFromEvents,
  detectUnifiedCandlePatterns,
  rankPatternSignals,
  updateMicroBot,
  walkForwardMicroBot,
  type CandleInput,
  type CandlePatternEvent,
  type CandlePatternFamily,
  type MicroBotCalibrationResult,
  type MicroBotPosition,
  type MicroBotSignal,
  type MicroBotState,
  type MicroBotWalkForwardResult,
  type TradeDecision,
  type TradeDecisionReason,
} from "@sui-options/candle-vision";
import {
  createLightweightChartsPatternOverlay,
  type LightweightChartsPatternOverlayHandle,
} from "@sui-options/candle-vision/overlay-lightweight-charts";

const THEME = {
  bg: "#0d111a",
  panel: "rgba(16, 22, 34, .78)",
  border: "rgba(148, 163, 184, .16)",
  text: "#e5e7eb",
  muted: "#8b94a7",
  grid: "rgba(148, 163, 184, .11)",
  candleUp: "#7cffb2",
  candleDown: "#ff6b7c",
  bullish: "#21d07a",
  bearish: "#ff5263",
  neutral: "#f5c542",
  compression: "#38bdf8",
  setup: "#a78bfa",
  ta: "#fb923c",
};

const STREAM_INTERVAL_MS = 70;
const STREAM_TICKS_PER_BAR = 9;
const MAX_BARS = 260;
const DISPLAY_MAX_EVENTS = 22;
const SHOW_ALL_MAX_EVENTS = 48;
const PANEL_MAX_EVENTS = 16;
const CHART_OVERLAY_MAX_EVENTS = 16;
const MICRO_BOT_OPTIONS = {
  minHoldMs: 5000,
  maxHoldMs: 10000,
  cooldownMs: 1300,
  entryThreshold: 0.4,
  flipExitThreshold: 0.52,
  targetRangeMultiple: 0.72,
  stopRangeMultiple: 0.58,
};
const SCAN_OPTIONS = {
  minConfidence: 0.55,
  lookback: 260,
  includeWeak: true,
  enableExpandedCandles: true,
  enableStructures: true,
  enableTaPatterns: true,
  maxStructureEvents: 56,
  maxPatternAgeBars: 150,
  maxBars: 190,
  minBars: 14,
  maxEventsPerKind: 4,
  minSwingDistance: 4,
  minProminencePct: 0.0028,
};
const CHART_STRATEGY_PRESETS = DEFAULT_MICRO_BOT_PRESETS.filter(
  (preset) => preset.id === "fast-tape" || preset.id === "confirmation",
);
const CALIBRATION_OPTIONS = {
  warmupBars: 16,
  barMs: 1000,
  minTrades: 2,
  presets: CHART_STRATEGY_PRESETS,
  detector: {
    minConfidence: 0.6,
    includeWeak: true,
    enableExpandedCandles: true,
    enableStructures: true,
    enableTaPatterns: true,
    lookback: 64,
    maxBars: 64,
    maxStructureEvents: 14,
    maxEventsPerKind: 1,
    maxPatternAgeBars: 56,
  },
};
const WALK_FORWARD_OPTIONS = {
  warmupBars: 16,
  barMs: 1000,
  minTrades: 2,
  presets: CHART_STRATEGY_PRESETS,
  detector: CALIBRATION_OPTIONS.detector,
  trainBars: 42,
  testBars: 14,
  stepBars: 14,
};
const CALIBRATION_SAMPLE_BARS = 84;
const CALIBRATION_RECALC_TICKS = STREAM_TICKS_PER_BAR * 18;

type ManualTradeSide = "long" | "short";
type ManualTradeTrigger = "keyboard" | "pointer";

type ManualPosition = {
  id: string;
  side: ManualTradeSide;
  trigger: ManualTradeTrigger;
  entryPrice: number;
  markPrice: number;
  entryIndex: number;
  latestIndex: number;
  openedAt: number;
  pnl: number;
  pnlPct: number;
  heldMs: number;
};

type ClosedManualTrade = ManualPosition & {
  exitPrice: number;
  closedAt: number;
};

type PatternFamilyFilter = CandlePatternFamily | "all";

type PatternScannerStats = {
  supported: number;
  detectedRaw: number;
  uniqueKinds: number;
  visible: number;
  watchlist: number;
};

type SignalPanelEvent = CandlePatternEvent & {
  visible?: boolean;
};

type HoverState = {
  event: CandlePatternEvent;
} | null;

type ScanState = {
  raw: CandlePatternEvent[];
  visible: CandlePatternEvent[];
  marketBias: number;
  decision: TradeDecision;
  stats: PatternScannerStats;
};

export function CandleVision() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        background: THEME.bg,
        color: THEME.text,
        overflow: "hidden",
      }}
    >
      <CandleVisionScannerChart />
    </main>
  );
}

function CandleVisionScannerChart() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const positionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const overlayRef = useRef<LightweightChartsPatternOverlayHandle | null>(null);
  const chartCleanupRef = useRef<(() => void) | null>(null);
  const randomRef = useRef(seeded(0x51a7));
  const tickRef = useRef(0);
  const initialCandles = useMemo(() => generateCandles(), []);
  const candlesRef = useRef(initialCandles);
  const eventsRef = useRef<CandlePatternEvent[]>([]);
  const spotlightEventRef = useRef<CandlePatternEvent | null>(null);
  const replayTimerRef = useRef<number | null>(null);
  const spotlightClearTimerRef = useRef<number | null>(null);
  const showAllRef = useRef(true);
  const activeFamilyRef = useRef<PatternFamilyFilter>("all");
  const tradeSideRef = useRef<ManualTradeSide>("long");
  const manualPositionRef = useRef<ManualPosition | null>(null);
  const closedTradesRef = useRef<ClosedManualTrade[]>([]);
  const microBotRef = useRef<MicroBotState>(createMicroBotState());
  const calibrationRef = useRef<MicroBotCalibrationResult | null>(null);
  const walkForwardRef = useRef<MicroBotWalkForwardResult | null>(null);
  const calibrationPendingRef = useRef(false);
  const [activeFamily, setActiveFamily] = useState<PatternFamilyFilter>("all");
  const [showAll, setShowAll] = useState(true);
  const [tradeSide, setTradeSide] = useState<ManualTradeSide>("long");
  const [manualPosition, setManualPosition] = useState<ManualPosition | null>(null);
  const [closedTrades, setClosedTrades] = useState<ClosedManualTrade[]>([]);
  const [microBot, setMicroBot] = useState<MicroBotState>(() => microBotRef.current);
  const [calibration, setCalibration] = useState<MicroBotCalibrationResult | null>(() => calibrationRef.current);
  const [walkForward, setWalkForward] = useState<MicroBotWalkForwardResult | null>(() => walkForwardRef.current);
  const [spotlightId, setSpotlightId] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanState>(() => {
    const starting = scanCandles(initialCandles, true);
    eventsRef.current = selectChartOverlayEvents(starting.visible, "all");
    return starting;
  });
  const [hover, setHover] = useState<HoverState>(null);
  const panelEvents = useMemo(
    () => sortPanelEvents(markVisible(scan.raw, scan.visible)),
    [scan.raw, scan.visible],
  );

  const handleTradeSideChange = useCallback((side: ManualTradeSide) => {
    tradeSideRef.current = side;
    setTradeSide(side);
  }, []);

  const openManualTrade = useCallback((trigger: ManualTradeTrigger) => {
    if (manualPositionRef.current) return;
    const latestIndex = candlesRef.current.length - 1;
    const latest = candlesRef.current[latestIndex];
    if (!latest) return;
    const next: ManualPosition = {
      id: `manual:${trigger}:${latest.time}:${Math.round(performance.now())}`,
      side: tradeSideRef.current,
      trigger,
      entryPrice: latest.close,
      markPrice: latest.close,
      entryIndex: latestIndex,
      latestIndex,
      openedAt: performance.now(),
      pnl: 0,
      pnlPct: 0,
      heldMs: 0,
    };
    manualPositionRef.current = next;
    setManualPosition(next);
    gsap.fromTo("[data-hold-trade-panel]", { scale: 0.992 }, { scale: 1, duration: 0.18, ease: "power2.out" });
  }, []);

  const closeManualTrade = useCallback((trigger?: ManualTradeTrigger) => {
    const active = manualPositionRef.current;
    if (!active) return;
    if (trigger && active.trigger !== trigger) return;
    const latestIndex = candlesRef.current.length - 1;
    const latest = candlesRef.current[latestIndex];
    if (!latest) return;
    const marked = markManualPosition(active, latest, latestIndex);
    const closed: ClosedManualTrade = {
      ...marked,
      exitPrice: latest.close,
      closedAt: performance.now(),
    };
    manualPositionRef.current = null;
    setManualPosition(null);
    closedTradesRef.current = [closed, ...closedTradesRef.current].slice(0, 5);
    setClosedTrades(closedTradesRef.current);
  }, []);

  const clearReplay = useCallback(() => {
    if (replayTimerRef.current != null) {
      window.clearInterval(replayTimerRef.current);
      replayTimerRef.current = null;
    }
  }, []);

  const clearSpotlight = useCallback(() => {
    if (spotlightClearTimerRef.current != null) {
      window.clearTimeout(spotlightClearTimerRef.current);
      spotlightClearTimerRef.current = null;
    }
    spotlightEventRef.current = null;
    setSpotlightId(null);
    overlayRef.current?.setSpotlight(null);
    overlayRef.current?.setData(candlesRef.current, eventsRef.current);
  }, []);

  const scheduleCalibration = useCallback(() => {
    if (calibrationPendingRef.current) return;
    calibrationPendingRef.current = true;
    window.setTimeout(() => {
      try {
        const sample = candlesRef.current.slice(-CALIBRATION_SAMPLE_BARS);
        if (sample.length < 48) return;
        const nextCalibration = calibrateMicroBot(sample, CALIBRATION_OPTIONS);
        const nextWalkForward = sample.length >= WALK_FORWARD_OPTIONS.trainBars + WALK_FORWARD_OPTIONS.testBars
          ? walkForwardMicroBot(sample, WALK_FORWARD_OPTIONS)
          : null;
        calibrationRef.current = nextCalibration;
        walkForwardRef.current = nextWalkForward;
        setCalibration(nextCalibration);
        setWalkForward(nextWalkForward);
      } finally {
        calibrationPendingRef.current = false;
      }
    }, 0);
  }, []);

  useEffect(() => {
    const id = window.setTimeout(scheduleCalibration, 500);
    return () => window.clearTimeout(id);
  }, [scheduleCalibration]);

  const spotlightSignal = useCallback((event: CandlePatternEvent | null, holdMs = 0) => {
    if (spotlightClearTimerRef.current != null) {
      window.clearTimeout(spotlightClearTimerRef.current);
      spotlightClearTimerRef.current = null;
    }
    if (!event) {
      spotlightEventRef.current = null;
      setSpotlightId(null);
      overlayRef.current?.setSpotlight(null);
      overlayRef.current?.setData(candlesRef.current, eventsRef.current);
      return;
    }

    spotlightEventRef.current = event;
    setSpotlightId(event.id);
    overlayRef.current?.setData(candlesRef.current, mergeSpotlightEvent(eventsRef.current, event));
    overlayRef.current?.setSpotlight(event.id);
    if (holdMs > 0) {
      spotlightClearTimerRef.current = window.setTimeout(() => {
        spotlightEventRef.current = null;
        setSpotlightId(null);
        overlayRef.current?.setSpotlight(null);
        overlayRef.current?.setData(candlesRef.current, eventsRef.current);
      }, holdMs);
    }
  }, []);

  const handleShowAllChange = (nextShowAll: boolean) => {
    showAllRef.current = nextShowAll;
    setShowAll(nextShowAll);
    const nextScan = scanCandles(candlesRef.current, nextShowAll);
    const chartEvents = selectChartOverlayEvents(nextScan.visible, activeFamilyRef.current);
    eventsRef.current = chartEvents;
    overlayRef.current?.setData(candlesRef.current, mergeSpotlightEvent(chartEvents, spotlightEventRef.current));
    overlayRef.current?.replay();
    setScan(nextScan);
  };

  const handleFamilyChange = (family: PatternFamilyFilter) => {
    activeFamilyRef.current = family;
    setActiveFamily(family);
    const chartEvents = selectChartOverlayEvents(scan.visible, family);
    eventsRef.current = chartEvents;
    overlayRef.current?.setData(candlesRef.current, mergeSpotlightEvent(chartEvents, spotlightEventRef.current));
    overlayRef.current?.replay();
  };

  const handleReplay = () => {
    clearReplay();
    overlayRef.current?.replay();
    const sequence = panelEvents.slice(0, 14);
    let index = 0;
    if (sequence.length) {
      spotlightSignal(sequence[0], 0);
      replayTimerRef.current = window.setInterval(() => {
        index += 1;
        if (index >= sequence.length) {
          clearReplay();
          spotlightSignal(null);
          return;
        }
        spotlightSignal(sequence[index], 0);
      }, 760);
    }
    gsap.fromTo(
      "[data-cv-panel]",
      { scale: 0.992 },
      { scale: 1, duration: 0.22, ease: "power2.out" },
    );
  };

  useEffect(() => {
    const root = rootRef.current;
    const ctx = gsap.context(() => {
      gsap.fromTo(
        "[data-cv-panel]",
        { autoAlpha: 0, y: -8 },
        { autoAlpha: 1, y: 0, duration: 0.48, stagger: 0.06, ease: "power2.out" },
      );
    }, root ?? undefined);
    return () => ctx.revert();
  }, []);

  useEffect(() => {
    return () => {
      clearReplay();
      if (spotlightClearTimerRef.current != null) window.clearTimeout(spotlightClearTimerRef.current);
    };
  }, [clearReplay]);

  useEffect(() => {
    const isSpaceEvent = (event: KeyboardEvent) =>
      event.code === "Space" || event.key === " " || event.key === "Spacebar";
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSpaceEvent(event) || event.repeat) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || target?.isContentEditable) return;
      event.preventDefault();
      openManualTrade("keyboard");
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!isSpaceEvent(event)) return;
      event.preventDefault();
      closeManualTrade("keyboard");
    };
    const onPointerUp = () => closeManualTrade("pointer");
    const onBlur = () => {
      closeManualTrade("keyboard");
      closeManualTrade("pointer");
    };

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onBlur);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onBlur);
    };
  }, [closeManualTrade, openManualTrade]);

  const mountChart = useCallback((host: HTMLDivElement) => {
    const startingScan = scanCandles(candlesRef.current, showAllRef.current);
    const startingChartEvents = selectChartOverlayEvents(startingScan.visible, activeFamilyRef.current);
    eventsRef.current = startingChartEvents;

    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: THEME.bg },
        textColor: THEME.text,
        fontFamily: "Arial, Helvetica, sans-serif",
        fontSize: 12,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: THEME.grid, style: LineStyle.Dotted },
        horzLines: { color: THEME.grid, style: LineStyle.Dotted },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: "rgba(148, 163, 184, .5)",
          style: LineStyle.Dashed,
          labelBackgroundColor: "#111827",
        },
        horzLine: {
          color: "rgba(148, 163, 184, .5)",
          style: LineStyle.Dashed,
          labelBackgroundColor: "#111827",
        },
      },
      rightPriceScale: {
        borderColor: "rgba(148,163,184,.18)",
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      timeScale: {
        borderColor: "rgba(148,163,184,.18)",
        timeVisible: true,
        secondsVisible: false,
        barSpacing: 10.4,
        rightOffset: 12,
        minBarSpacing: 3,
        tickMarkFormatter: (time: Time) => {
          const date = new Date(Number(time) * 1000);
          return `${String(date.getUTCHours()).padStart(2, "0")}:${String(
            date.getUTCMinutes(),
          ).padStart(2, "0")}`;
        },
      },
      localization: {
        priceFormatter: (price: number) => price.toFixed(2),
        timeFormatter: (time: Time) =>
          new Date(Number(time) * 1000).toUTCString().replace("GMT", "UTC"),
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

    const series = chart.addSeries(CandlestickSeries, {
      upColor: THEME.candleUp,
      downColor: THEME.candleDown,
      borderUpColor: "#d9ffe9",
      borderDownColor: "#ffd3da",
      wickUpColor: "rgba(217,255,233,.95)",
      wickDownColor: "rgba(255,211,218,.95)",
      borderVisible: true,
      priceLineVisible: true,
      priceLineColor: "#38bdf8",
      priceLineWidth: 1,
      lastValueVisible: true,
    });
    series.setData(toSeriesData(candlesRef.current));

    const overlay = createLightweightChartsPatternOverlay(series, chart, {
      candles: candlesRef.current,
      events: startingChartEvents,
      showLabels: true,
      maxLabels: 6,
      maxEvents: CHART_OVERLAY_MAX_EVENTS + 4,
      maxActiveBoxes: 4,
      maxPins: 32,
      maxBoxOverlapRatio: 0.1,
      boxCollisionPaddingPx: 12,
      minDisplayConfidence: 0.46,
      fillOpacity: 0.018,
      strokeOpacity: 0.38,
      scanlineOpacity: 0.32,
      labelCollisionPadding: 28,
      activeTtlMs: 11000,
      collapsedTtlMs: 26000,
      eventFadeOutMs: 3600,
      clusterRadiusPx: 42,
      labelRightInsetPx: 360,
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

    chart.timeScale().setVisibleLogicalRange({
      from: Math.max(0, candlesRef.current.length - 72),
      to: candlesRef.current.length + 10,
    });
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
      setHover(event ? { event } : null);
    });

    chartRef.current = chart;
    overlayRef.current = overlay;
    setScan(startingScan);
    const startingBot = updateMicroBot({
      state: microBotRef.current,
      candles: candlesRef.current,
      events: startingScan.raw,
      decision: startingScan.decision,
      nowMs: performance.now(),
      options: MICRO_BOT_OPTIONS,
    });
    microBotRef.current = startingBot;
    setMicroBot(startingBot);
    scheduleCalibration();

    let accumulatedMs = 0;
    let previousTime = gsap.ticker.time;
    const update = () => {
      overlay.update();
      drawPositionOverlay(positionCanvasRef.current, chart, series, manualPositionRef.current, microBotRef.current.position);
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
      const trimmed =
        next.length === MAX_BARS &&
        previous.length === MAX_BARS &&
        next[0]?.time !== previous[0]?.time;
      candlesRef.current = next;
      const chartEvents = selectChartOverlayEvents(nextScan.visible, activeFamilyRef.current);
      eventsRef.current = chartEvents;

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
      if (manualPositionRef.current && latest) {
        const marked = markManualPosition(manualPositionRef.current, latest, next.length - 1);
        manualPositionRef.current = marked;
        setManualPosition(marked);
      }
      const nextBot = updateMicroBot({
        state: microBotRef.current,
        candles: next,
        events: nextScan.raw,
        decision: nextScan.decision,
        nowMs: performance.now(),
        options: MICRO_BOT_OPTIONS,
      });
      if (nextBot !== microBotRef.current) {
        microBotRef.current = nextBot;
        setMicroBot(nextBot);
      }
      if (tickRef.current % CALIBRATION_RECALC_TICKS === 0) scheduleCalibration();
      overlay.setData(next, mergeSpotlightEvent(chartEvents, spotlightEventRef.current));
      setScan(nextScan);
    };
    gsap.ticker.add(update);

    return () => {
      gsap.ticker.remove(update);
      overlay.detach();
      chart.remove();
      chartRef.current = null;
      overlayRef.current = null;
    };
  }, [scheduleCalibration]);

  const setChartHost = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) {
        chartCleanupRef.current?.();
        chartCleanupRef.current = null;
        return;
      }
      if (chartRef.current) return;
      chartCleanupRef.current = mountChart(node);
    },
    [mountChart],
  );

  return (
    <div
      ref={rootRef}
      style={{
        position: "relative",
        width: "100%",
        height: "100dvh",
        minHeight: 620,
        overflow: "hidden",
        color: THEME.text,
        fontFamily: "Arial, Helvetica, sans-serif",
        fontVariantNumeric: "tabular-nums",
        background: `radial-gradient(circle at 22% 18%, rgba(56,189,248,.12), transparent 28%),
          radial-gradient(circle at 74% 72%, rgba(34,197,94,.08), transparent 30%),
          ${THEME.bg}`,
      }}
    >
      <div
        ref={setChartHost}
        data-cv-host
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          openManualTrade("pointer");
        }}
        style={{ position: "absolute", inset: 0 }}
      />
      <canvas
        ref={positionCanvasRef}
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 1,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
      />

      <div
        data-cv-panel
        style={{
          position: "absolute",
          left: 18,
          top: 16,
          zIndex: 3,
          display: "flex",
          gap: 10,
          alignItems: "center",
          padding: "10px 12px",
          border: `1px solid ${THEME.border}`,
          borderRadius: 8,
          background: THEME.panel,
          backdropFilter: "blur(16px)",
          boxShadow: "0 16px 44px rgba(0,0,0,.28)",
        }}
      >
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: 999,
            background: THEME.compression,
            boxShadow: `0 0 18px ${THEME.compression}`,
          }}
        />
        <div>
          <div style={{ fontSize: 13, fontWeight: 700 }}>Candle Vision</div>
          <div style={{ color: THEME.muted, fontSize: 11 }}>
            classic patterns + shape-template scanner
          </div>
        </div>
      </div>

      <HoldTradePanel
        side={tradeSide}
        position={manualPosition}
        closedTrades={closedTrades}
        onSideChange={handleTradeSideChange}
        onHoldStart={() => openManualTrade("pointer")}
      />

      <ScalpBotPanel bot={microBot} calibration={calibration} walkForward={walkForward} />

      <div
        data-cv-panel
        style={{
          position: "absolute",
          right: 16,
          top: 16,
          zIndex: 3,
          maxHeight: "calc(100% - 32px)",
          display: "grid",
          gap: 10,
        }}
      >
        <TradeDecisionPanel
          decision={scan.decision}
          onSpotlight={(event) => spotlightSignal(event, 3000)}
        />
        <SignalPanel
          stats={scan.stats}
          events={panelEvents}
          activeFamily={activeFamily}
          onFamilyChange={handleFamilyChange}
          showAll={showAll}
          onShowAllChange={handleShowAllChange}
          onReplay={handleReplay}
          onSignalPreview={spotlightSignal}
          onSignalLeave={clearSpotlight}
          spotlightId={spotlightId}
          maxEvents={showAll ? PANEL_MAX_EVENTS : 10}
        />
        {hover ? (
          <div
            style={{
              width: 330,
              padding: 12,
              border: `1px solid ${THEME.border}`,
              borderRadius: 8,
              background: "rgba(16,22,34,.84)",
              backdropFilter: "blur(16px)",
              boxShadow: "0 16px 44px rgba(0,0,0,.28)",
            }}
          >
            <div style={{ color: hover.event.color, fontSize: 12, fontWeight: 700 }}>
              {hover.event.label}
            </div>
            <div style={{ color: THEME.muted, fontSize: 11, lineHeight: 1.45, marginTop: 4 }}>
              {hover.event.description}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TradeDecisionPanel({
  decision,
  onSpotlight,
}: {
  decision: TradeDecision;
  onSpotlight?: (event: CandlePatternEvent) => void;
}) {
  const color = decisionColor(decision);
  const actionLabel = decision.status === "confirmed"
    ? decision.action === "buy" ? "BUY" : decision.action === "sell" ? "SELL" : "HOLD"
    : decision.status === "watching"
      ? decision.side === "long" ? "BUY WATCH" : decision.side === "short" ? "SELL WATCH" : "WAIT"
      : decision.status === "denied"
        ? "DENIED"
        : decision.status === "invalidated"
          ? "VOID"
          : decision.status === "expired"
            ? "EXPIRED"
            : "NO TRADE";
  const confirming = decision.reasons.filter((item) => item.polarity === "confirm").slice(0, 3);
  const denying = decision.reasons.filter((item) => item.polarity === "deny").slice(0, 2);
  const evidence = [...confirming, ...denying].slice(0, 4);
  const primary = decision.primarySignal?.event;

  return (
    <section
      data-pattern-motion
      style={{
        width: 330,
        padding: 14,
        border: `1px solid ${color}55`,
        borderRadius: 8,
        background: `linear-gradient(180deg, ${hexToRgba(color, 0.16)}, rgba(16,22,34,.88))`,
        boxShadow: `0 22px 64px rgba(0,0,0,.34), 0 0 32px ${hexToRgba(color, 0.08)}`,
        backdropFilter: "blur(18px)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "grid", gap: 3, minWidth: 0 }}>
          <div
            style={{
              color,
              fontSize: 11,
              fontWeight: 900,
              letterSpacing: ".1em",
              textTransform: "uppercase",
            }}
          >
            trade decision
          </div>
          <div
            style={{
              color: "#f8fafc",
              fontSize: 22,
              lineHeight: 1,
              fontWeight: 900,
              whiteSpace: "nowrap",
            }}
          >
            {actionLabel}
          </div>
        </div>
        <div
          style={{
            display: "grid",
            justifyItems: "end",
            gap: 2,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <div style={{ color, fontSize: 28, fontWeight: 900, lineHeight: 1 }}>
            {Math.round(decision.confidence * 100)}
          </div>
          <div style={{ color: THEME.muted, fontSize: 10, fontWeight: 800, textTransform: "uppercase" }}>
            score
          </div>
        </div>
      </div>

      <div
        style={{
          marginTop: 10,
          height: 6,
          borderRadius: 999,
          overflow: "hidden",
          background: "rgba(148,163,184,.14)",
        }}
      >
        <div
          style={{
            width: `${Math.round(decision.confidence * 100)}%`,
            height: "100%",
            borderRadius: 999,
            background: `linear-gradient(90deg, ${color}, ${hexToRgba(color, 0.56)})`,
            boxShadow: `0 0 18px ${hexToRgba(color, 0.35)}`,
          }}
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, marginTop: 12 }}>
        <DecisionLevel label="Entry" value={decision.entry?.price} color={color} />
        <DecisionLevel label="Stop" value={decision.stop?.price} color="#ff7a45" />
        <DecisionLevel label="T1" value={decision.targets[0]?.price} color="#38bdf8" />
      </div>

      {primary ? (
        <button
          type="button"
          onClick={() => onSpotlight?.(primary)}
          style={{
            width: "100%",
            display: "grid",
            gridTemplateColumns: "1fr auto",
            alignItems: "center",
            gap: 8,
            marginTop: 12,
            padding: "8px 9px",
            borderRadius: 7,
            border: `1px solid ${hexToRgba(primary.color, 0.46)}`,
            background: "rgba(15,23,42,.48)",
            color: "#e5e7eb",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontWeight: 800 }}>
            {primary.label}
          </span>
          <span style={{ color: primary.color, fontSize: 11, fontWeight: 900 }}>
            spotlight
          </span>
        </button>
      ) : null}

      <div style={{ display: "grid", gap: 6, marginTop: 11 }}>
        {evidence.map((item) => (
          <DecisionReasonRow key={`${item.code}:${item.label}`} reason={item} />
        ))}
      </div>
    </section>
  );
}

function HoldTradePanel({
  side,
  position,
  closedTrades,
  onSideChange,
  onHoldStart,
}: {
  side: ManualTradeSide;
  position: ManualPosition | null;
  closedTrades: ClosedManualTrade[];
  onSideChange: (side: ManualTradeSide) => void;
  onHoldStart: () => void;
}) {
  const activeColor = position
    ? position.side === "long" ? THEME.bullish : THEME.bearish
    : side === "long" ? THEME.bullish : THEME.bearish;
  const latestClosed = closedTrades[0];

  return (
    <div
      data-hold-trade-panel
      data-cv-panel
      style={{
        position: "absolute",
        left: "50%",
        bottom: 22,
        zIndex: 3,
        width: 680,
        maxWidth: "calc(100% - 32px)",
        transform: "translateX(-50%)",
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        alignItems: "center",
        gap: 12,
        padding: 12,
        border: `1px solid ${hexToRgba(activeColor, position ? 0.56 : 0.26)}`,
        borderRadius: 8,
        background: `linear-gradient(180deg, ${hexToRgba(activeColor, position ? 0.16 : 0.08)}, rgba(9,13,22,.88))`,
        boxShadow: `0 24px 70px rgba(0,0,0,.4), 0 0 42px ${hexToRgba(activeColor, position ? 0.18 : 0.06)}`,
        backdropFilter: "blur(18px)",
      }}
    >
      <div style={{ display: "inline-flex", gap: 6 }}>
        {(["long", "short"] as const).map((nextSide) => {
          const selected = side === nextSide;
          const color = nextSide === "long" ? THEME.bullish : THEME.bearish;
          return (
            <button
              key={nextSide}
              type="button"
              onClick={() => onSideChange(nextSide)}
              style={{
                height: 34,
                minWidth: 66,
                borderRadius: 7,
                border: `1px solid ${selected ? color : "rgba(148,163,184,.2)"}`,
                background: selected ? hexToRgba(color, 0.2) : "rgba(15,23,42,.5)",
                color: selected ? color : "#cbd5e1",
                fontSize: 12,
                fontWeight: 900,
                textTransform: "uppercase",
                cursor: "pointer",
              }}
            >
              {nextSide}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onPointerDown={(event) => {
          event.preventDefault();
          onHoldStart();
        }}
        style={{
          minWidth: 0,
          height: 44,
          borderRadius: 8,
          border: `1px solid ${hexToRgba(activeColor, 0.55)}`,
          background: position
            ? `linear-gradient(90deg, ${hexToRgba(activeColor, 0.34)}, rgba(15,23,42,.68))`
            : "rgba(15,23,42,.62)",
          color: "#f8fafc",
          boxShadow: position ? `inset 0 0 0 1px ${hexToRgba(activeColor, 0.25)}, 0 0 30px ${hexToRgba(activeColor, 0.22)}` : "none",
          cursor: "pointer",
          overflow: "hidden",
          position: "relative",
        }}
      >
        <span
          style={{
            position: "absolute",
            inset: 0,
            width: position ? "100%" : "0%",
            background: `linear-gradient(90deg, transparent, ${hexToRgba(activeColor, 0.2)}, transparent)`,
            animation: position ? "cv-hold-sweep 1.1s linear infinite" : "none",
          }}
        />
        <span
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 9,
            fontSize: 12,
            fontWeight: 900,
            letterSpacing: ".05em",
            textTransform: "uppercase",
          }}
        >
          {position ? "release to close" : "hold space or press chart"}
          <span style={{ color: activeColor }}>{position ? position.side : side}</span>
        </span>
      </button>

      <div style={{ minWidth: 116, display: "grid", justifyItems: "end", gap: 2 }}>
        <div
          style={{
            color: position ? (position.pnl >= 0 ? THEME.bullish : THEME.bearish) : latestClosed ? (latestClosed.pnl >= 0 ? THEME.bullish : THEME.bearish) : THEME.muted,
            fontSize: 18,
            fontWeight: 950,
            fontVariantNumeric: "tabular-nums",
            lineHeight: 1,
          }}
        >
          {position ? formatPnl(position.pnl) : latestClosed ? formatPnl(latestClosed.pnl) : "$0.00"}
        </div>
        <div style={{ color: THEME.muted, fontSize: 10, fontWeight: 800, textTransform: "uppercase" }}>
          {position ? `${(position.heldMs / 1000).toFixed(1)}s live` : "last trade"}
        </div>
      </div>

      <div style={{ gridColumn: "1 / -1", color: THEME.muted, fontSize: 10, fontWeight: 800, textTransform: "uppercase", textAlign: "center" }}>
        Manual hold mode · space down opens · key up closes
      </div>
      <style>{`
        @keyframes cv-hold-sweep {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
      `}</style>
    </div>
  );
}

function ScalpBotPanel({
  bot,
  calibration,
  walkForward,
}: {
  bot: MicroBotState;
  calibration: MicroBotCalibrationResult | null;
  walkForward: MicroBotWalkForwardResult | null;
}) {
  const activeColor = bot.position
    ? bot.position.side === "long" ? THEME.bullish : THEME.bearish
    : bot.signal.side === "short" ? THEME.bearish : bot.signal.side === "long" ? THEME.bullish : THEME.compression;
  const headline = bot.position
    ? `${bot.position.side.toUpperCase()} SCALP`
    : bot.status === "cooldown"
      ? "COOLDOWN"
      : bot.signal.phase === "confirmed" && bot.signal.side !== "none"
        ? `${bot.signal.side.toUpperCase()} TRIGGER`
        : bot.signal.phase === "forming" && bot.signal.side !== "none"
          ? `${bot.signal.side.toUpperCase()} FORMING`
          : bot.signal.phase === "blocked"
            ? "BLOCKED"
            : "SCANNING";
  const subline = bot.position
    ? `${formatSeconds(Math.max(0, bot.position.plannedExitAtMs - performance.now()))} exit window`
    : bot.signal.reasons[0] ?? "Waiting for confluence";
  const last = bot.lastTrade;

  return (
    <section
      data-cv-panel
      data-scalp-bot-panel
      style={{
        position: "absolute",
        left: 18,
        bottom: 18,
        zIndex: 3,
        width: 344,
        display: "grid",
        gap: 10,
        padding: 13,
        border: `1px solid ${hexToRgba(activeColor, 0.44)}`,
        borderRadius: 8,
        background: "rgba(10,15,26,.88)",
        boxShadow: `0 18px 54px rgba(0,0,0,.38), 0 0 32px ${hexToRgba(activeColor, 0.1)}`,
        backdropFilter: "blur(16px)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: activeColor, fontSize: 10, fontWeight: 900, textTransform: "uppercase" }}>
            simulated 5-10s scalp bot
          </div>
          <div style={{ color: "#f8fafc", fontSize: 20, lineHeight: 1.05, fontWeight: 950 }}>
            {headline}
          </div>
        </div>
        <div style={{ display: "grid", justifyItems: "end", gap: 2 }}>
          <div style={{ color: activeColor, fontSize: 28, lineHeight: 1, fontWeight: 950 }}>
            {Math.round(bot.signal.entryScore * 100)}
          </div>
          <div style={{ color: THEME.muted, fontSize: 10, fontWeight: 800, textTransform: "uppercase" }}>
            edge
          </div>
        </div>
      </div>

      <OrderFlowVisualizer signal={bot.signal} />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
        <BotMetric label="P&L" value={formatPnl(bot.stats.pnl)} color={bot.stats.pnl >= 0 ? THEME.bullish : THEME.bearish} />
        <BotMetric label="Win rate" value={`${Math.round(bot.stats.winRate * 100)}%`} color={THEME.text} />
        <BotMetric label="Trades" value={String(bot.stats.totalTrades)} color={THEME.text} />
      </div>

      {bot.position ? (
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <span style={{ color: THEME.muted, fontSize: 11, fontWeight: 800 }}>
              {subline}
            </span>
            <span style={{ color: bot.position.pnl >= 0 ? THEME.bullish : THEME.bearish, fontSize: 13, fontWeight: 950 }}>
              {formatPnl(bot.position.pnl)}
            </span>
          </div>
          <div style={{ height: 5, borderRadius: 999, overflow: "hidden", background: "rgba(148,163,184,.15)" }}>
            <div
              style={{
                width: `${Math.round(bot.position.progress * 100)}%`,
                height: "100%",
                borderRadius: 999,
                background: activeColor,
              }}
            />
          </div>
        </div>
      ) : (
        <div style={{ color: THEME.muted, fontSize: 11, lineHeight: 1.35 }}>
          {subline}
        </div>
      )}

      <div style={{ display: "grid", gap: 5 }}>
        {bot.signal.reasons.slice(0, 3).map((reason) => (
          <div key={reason} style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: activeColor }} />
            <span style={{ color: "#cbd5e1", fontSize: 11, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {reason}
            </span>
          </div>
        ))}
      </div>

      {last ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            paddingTop: 7,
            borderTop: `1px solid ${THEME.border}`,
          }}
        >
          <span style={{ color: THEME.muted, fontSize: 10, fontWeight: 800, textTransform: "uppercase" }}>
            Last exit · {formatExitReason(last.exitReason)}
          </span>
          <span style={{ color: last.pnl >= 0 ? THEME.bullish : THEME.bearish, fontSize: 12, fontWeight: 950 }}>
            {formatPnl(last.pnl)}
          </span>
        </div>
      ) : null}

      <CalibrationSummary calibration={calibration} />
      <WalkForwardSummary walkForward={walkForward} />
    </section>
  );
}

function CalibrationSummary({ calibration }: { calibration: MicroBotCalibrationResult | null }) {
  const best = calibration?.best;
  if (!calibration || !best) {
    return (
      <div
        data-calibration-panel
        style={{
          paddingTop: 8,
          borderTop: `1px solid ${THEME.border}`,
          color: THEME.muted,
          fontSize: 11,
          fontWeight: 800,
        }}
      >
        Strategy Lab warming up backtest sample...
      </div>
    );
  }
  const pnlColor = best.pnl >= 0 ? THEME.bullish : THEME.bearish;
  return (
    <div
      data-calibration-panel
      style={{
        display: "grid",
        gap: 8,
        paddingTop: 8,
        borderTop: `1px solid ${THEME.border}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: THEME.compression, fontSize: 10, fontWeight: 900, textTransform: "uppercase" }}>
            strategy lab
          </div>
          <div style={{ color: "#f8fafc", fontSize: 13, fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {best.preset.label}
          </div>
        </div>
        <div style={{ color: pnlColor, fontSize: 18, fontWeight: 950 }}>
          {Math.round(best.score * 100)}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 6 }}>
        <BotMetric label="BT P&L" value={formatPnl(best.pnl)} color={pnlColor} />
        <BotMetric label="Win" value={`${Math.round(best.winRate * 100)}%`} color={THEME.text} />
        <BotMetric label="Exp" value={formatPnl(best.expectancy)} color={best.expectancy >= 0 ? THEME.bullish : THEME.bearish} />
        <BotMetric label="DD" value={formatPnl(-best.maxDrawdown)} color={THEME.muted} />
      </div>
      <div style={{ display: "grid", gap: 4 }}>
        {calibration.rows.slice(0, 3).map((row) => (
          <div
            key={row.preset.id}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto auto",
              gap: 8,
              alignItems: "center",
              color: row === best ? "#f8fafc" : "#cbd5e1",
              fontSize: 10,
            }}
          >
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: row === best ? 900 : 700 }}>
              {row.preset.label}
            </span>
            <span style={{ color: row.pnl >= 0 ? THEME.bullish : THEME.bearish, fontWeight: 900 }}>
              {formatPnl(row.pnl)}
            </span>
            <span style={{ color: THEME.muted, fontWeight: 800 }}>
              {row.totalTrades}x
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function WalkForwardSummary({ walkForward }: { walkForward: MicroBotWalkForwardResult | null }) {
  if (!walkForward || walkForward.folds.length === 0) {
    return (
      <div
        data-walk-forward-panel
        style={{
          paddingTop: 8,
          borderTop: `1px solid ${THEME.border}`,
          color: THEME.muted,
          fontSize: 11,
          fontWeight: 800,
        }}
      >
        Waiting for train/test validation window...
      </div>
    );
  }
  const summary = walkForward.summary;
  const pnlColor = summary.pnl >= 0 ? THEME.bullish : THEME.bearish;
  const stabilityColor = summary.stability >= 0.58 ? THEME.bullish : summary.stability >= 0.34 ? THEME.neutral : THEME.bearish;
  return (
    <div
      data-walk-forward-panel
      style={{
        display: "grid",
        gap: 8,
        paddingTop: 8,
        borderTop: `1px solid ${THEME.border}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: stabilityColor, fontSize: 10, fontWeight: 900, textTransform: "uppercase" }}>
            walk-forward validation
          </div>
          <div style={{ color: "#f8fafc", fontSize: 13, fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {summary.bestPresetLabel ?? "No stable preset"}
          </div>
        </div>
        <div style={{ color: stabilityColor, fontSize: 18, fontWeight: 950 }}>
          {Math.round(summary.stability * 100)}%
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 6 }}>
        <BotMetric label="OOS P&L" value={formatPnl(summary.pnl)} color={pnlColor} />
        <BotMetric label="OOS Win" value={`${Math.round(summary.winRate * 100)}%`} color={THEME.text} />
        <BotMetric label="Folds" value={`${summary.positiveFolds}/${walkForward.folds.length}`} color={stabilityColor} />
        <BotMetric label="DD" value={formatPnl(-summary.maxDrawdown)} color={THEME.muted} />
      </div>
      <div style={{ display: "grid", gap: 3 }}>
        {walkForward.folds.slice(-3).map((fold) => (
          <div
            key={`${fold.index}:${fold.testStart}`}
            style={{
              display: "grid",
              gridTemplateColumns: "auto 1fr auto auto",
              gap: 7,
              alignItems: "center",
              color: "#cbd5e1",
              fontSize: 10,
            }}
          >
            <span style={{ color: THEME.muted, fontWeight: 900 }}>F{fold.index + 1}</span>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 800 }}>
              {fold.preset.label}
            </span>
            <span style={{ color: fold.test.summary.pnl >= 0 ? THEME.bullish : THEME.bearish, fontWeight: 900 }}>
              {formatPnl(fold.test.summary.pnl)}
            </span>
            <span style={{ color: THEME.muted, fontWeight: 800 }}>
              {fold.test.summary.totalTrades}x
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function OrderFlowVisualizer({ signal }: { signal: MicroBotSignal }) {
  const bearish = clamp(Math.max(0, -signal.pressure) * 0.62 + signal.oppositeScore * 0.26, 0, 1);
  const bullish = clamp(Math.max(0, signal.pressure) * 0.62 + signal.entryScore * 0.2, 0, 1);
  const levels = Array.from({ length: 8 }, (_, index) => index);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "stretch", gap: 8 }}>
      <div style={{ display: "grid", gap: 3, alignContent: "center" }}>
        {levels.map((level) => {
          const width = 16 + clamp(bearish * 76 + Math.sin(level * 1.7 + signal.pressure * 3) * 9 - level * 3, 8, 84);
          return (
            <span
              key={`ask-${level}`}
              style={{
                justifySelf: "end",
                width: `${width}%`,
                height: 5,
                borderRadius: 999,
                background: hexToRgba(THEME.bearish, 0.28 + bearish * 0.4),
              }}
            />
          );
        })}
      </div>
      <div style={{ display: "grid", justifyItems: "center", alignContent: "center", gap: 3, minWidth: 54 }}>
        <span style={{ color: signal.side === "short" ? THEME.bearish : signal.side === "long" ? THEME.bullish : THEME.muted, fontSize: 18, fontWeight: 950 }}>
          {signal.side === "short" ? "SELL" : signal.side === "long" ? "BUY" : "FLAT"}
        </span>
        <span style={{ color: THEME.muted, fontSize: 10, fontWeight: 800, textTransform: "uppercase" }}>
          tape
        </span>
      </div>
      <div style={{ display: "grid", gap: 3, alignContent: "center" }}>
        {levels.map((level) => {
          const width = 16 + clamp(bullish * 76 + Math.cos(level * 1.4 + signal.pressure * 3) * 9 - level * 3, 8, 84);
          return (
            <span
              key={`bid-${level}`}
              style={{
                justifySelf: "start",
                width: `${width}%`,
                height: 5,
                borderRadius: 999,
                background: hexToRgba(THEME.bullish, 0.28 + bullish * 0.4),
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function BotMetric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div
      style={{
        display: "grid",
        gap: 3,
        padding: "9px 10px",
        border: `1px solid ${THEME.border}`,
        borderRadius: 7,
        background: "rgba(15,23,42,.48)",
      }}
    >
      <span style={{ color: THEME.muted, fontSize: 9, fontWeight: 900, textTransform: "uppercase" }}>{label}</span>
      <span style={{ color, fontSize: 13, fontWeight: 950 }}>{value}</span>
    </div>
  );
}

function DecisionLevel({ label, value, color }: { label: string; value?: number; color: string }) {
  return (
    <div
      style={{
        padding: "7px 8px",
        border: "1px solid rgba(148,163,184,.14)",
        borderRadius: 7,
        background: "rgba(15,23,42,.5)",
        minWidth: 0,
      }}
    >
      <div style={{ color: THEME.muted, fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".07em" }}>
        {label}
      </div>
      <div style={{ color, fontSize: 13, fontWeight: 900, fontVariantNumeric: "tabular-nums", marginTop: 2 }}>
        {typeof value === "number" ? value.toFixed(2) : "--"}
      </div>
    </div>
  );
}

function DecisionReasonRow({ reason }: { reason: TradeDecisionReason }) {
  const color = reason.polarity === "confirm" ? "#35e987" : reason.polarity === "deny" ? "#ff6b7c" : "#94a3b8";
  const sign = reason.weight > 0 ? "+" : "";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "7px 1fr auto",
        alignItems: "center",
        gap: 8,
        color: "#cbd5e1",
        fontSize: 11,
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: 999, background: color, boxShadow: `0 0 12px ${color}` }} />
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{reason.label}</span>
      <span style={{ color, fontWeight: 900, fontVariantNumeric: "tabular-nums" }}>{sign}{reason.weight}</span>
    </div>
  );
}

function decisionColor(decision: TradeDecision) {
  if (decision.status === "denied" || decision.status === "invalidated" || decision.status === "expired") return "#94a3b8";
  if (decision.action === "buy" || decision.side === "long") return "#35e987";
  if (decision.action === "sell" || decision.side === "short") return "#ff4d61";
  if (decision.status === "watching") return "#f5c542";
  return "#38bdf8";
}

function hexToRgba(hex: string, alpha: number) {
  const normalized = hex.replace("#", "");
  if (normalized.length !== 6) return `rgba(148,163,184,${alpha})`;
  const value = Number.parseInt(normalized, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function SignalPanel({
  stats,
  events,
  activeFamily,
  onFamilyChange,
  showAll,
  onShowAllChange,
  onReplay,
  onSignalPreview,
  onSignalLeave,
  spotlightId,
  maxEvents = 8,
}: {
  stats: PatternScannerStats;
  events: SignalPanelEvent[];
  activeFamily: PatternFamilyFilter;
  onFamilyChange: (family: PatternFamilyFilter) => void;
  showAll: boolean;
  onShowAllChange: (showAll: boolean) => void;
  onReplay?: () => void;
  onSignalPreview?: (event: CandlePatternEvent | null, holdMs?: number) => void;
  onSignalLeave?: () => void;
  spotlightId?: string | null;
  maxEvents?: number;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const filtered = useMemo(() => {
    const familyFiltered =
      activeFamily === "all" ? events : events.filter((event) => event.family === activeFamily);
    return familyFiltered.slice(0, maxEvents);
  }, [activeFamily, events, maxEvents]);

  usePatternPanelAnimation(rootRef, [activeFamily, showAll, filtered.length]);

  return (
    <div
      ref={rootRef}
      style={{
        width: 330,
        padding: 14,
        border: "1px solid rgba(148, 163, 184, .16)",
        borderRadius: 8,
        background: "linear-gradient(180deg, rgba(16,22,34,.94), rgba(16,22,34,.78))",
        boxShadow: "0 20px 60px rgba(0,0,0,.34)",
        backdropFilter: "blur(18px)",
      }}
    >
      <PatternStats stats={stats} />
      <div style={{ height: 12 }} />
      <PatternToolbar
        activeFamily={activeFamily}
        onFamilyChange={onFamilyChange}
        showAll={showAll}
        onShowAllChange={onShowAllChange}
        onReplay={onReplay}
      />
      <div
        style={{
          marginTop: 14,
          color: "#8b94a7",
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: ".08em",
        }}
      >
        ranked signals
      </div>
      <div style={{ display: "grid", gap: 7, marginTop: 8 }}>
        {filtered.map((event) => (
          <SignalRow
            key={event.id}
            event={event}
            active={event.id === spotlightId}
            onPreview={onSignalPreview}
            onLeave={onSignalLeave}
          />
        ))}
        {!filtered.length ? (
          <div
            data-pattern-motion
            style={{ color: "#8b94a7", fontSize: 12, lineHeight: 1.45, padding: "8px 0" }}
          >
            No high-confidence signals in this filter.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PatternStats({ stats }: { stats: PatternScannerStats }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8 }}>
      <Metric label="Supported" value={stats.supported} color="#e5e7eb" />
      <Metric label="Detected" value={stats.detectedRaw} color="#facc15" />
      <Metric label="Kinds" value={stats.uniqueKinds} color="#22c55e" />
      <Metric label="Visible" value={stats.visible} color="#38bdf8" />
    </div>
  );
}

function Metric({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div
      data-pattern-motion
      style={{
        minWidth: 0,
        padding: "9px 10px",
        border: "1px solid rgba(148, 163, 184, .16)",
        borderRadius: 7,
        background: "rgba(15,23,42,.48)",
      }}
    >
      <div
        style={{
          color: "#8b94a7",
          fontSize: 9,
          textTransform: "uppercase",
          letterSpacing: ".08em",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </div>
      <div
        style={{
          color,
          fontSize: 20,
          fontWeight: 800,
          lineHeight: 1.05,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function PatternToolbar({
  activeFamily,
  onFamilyChange,
  showAll,
  onShowAllChange,
  onReplay,
}: {
  activeFamily: PatternFamilyFilter;
  onFamilyChange: (family: PatternFamilyFilter) => void;
  showAll: boolean;
  onShowAllChange: (showAll: boolean) => void;
  onReplay?: () => void;
}) {
  const filters: Array<{ id: PatternFamilyFilter; label: string; color: string }> = [
    { id: "all", label: "All", color: "#e5e7eb" },
    { id: "candlestick", label: "Candles", color: "#facc15" },
    { id: "vision-candle", label: "Vision", color: "#38bdf8" },
    { id: "chart-setup", label: "Setups", color: "#a78bfa" },
  ];

  return (
    <div data-pattern-motion style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {filters.map((filter) => {
          const active = activeFamily === filter.id;
          return (
            <button
              key={filter.id}
              type="button"
              onClick={() => onFamilyChange(filter.id)}
              style={{
                height: 28,
                padding: "0 10px",
                borderRadius: 7,
                border: `1px solid ${active ? filter.color : "rgba(148,163,184,.18)"}`,
                background: active ? `${filter.color}22` : "rgba(15,23,42,.42)",
                color: active ? filter.color : "#cbd5e1",
                fontSize: 11,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              {filter.label}
            </button>
          );
        })}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            color: "#cbd5e1",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={showAll}
            onChange={(event) => onShowAllChange(event.currentTarget.checked)}
            style={{ accentColor: "#38bdf8" }}
          />
          Show all in panel
        </label>
        <button
          type="button"
          onClick={onReplay}
          disabled={!onReplay}
          style={{
            height: 28,
            padding: "0 10px",
            borderRadius: 7,
            border: "1px solid rgba(56,189,248,.34)",
            background: "rgba(56,189,248,.12)",
            color: "#7dd3fc",
            fontSize: 11,
            fontWeight: 800,
            cursor: onReplay ? "pointer" : "default",
            opacity: onReplay ? 1 : 0.5,
          }}
        >
          Replay
        </button>
      </div>
    </div>
  );
}

function SignalRow({
  event,
  active,
  onPreview,
  onLeave,
}: {
  event: SignalPanelEvent;
  active?: boolean;
  onPreview?: (event: CandlePatternEvent | null, holdMs?: number) => void;
  onLeave?: () => void;
}) {
  return (
    <button
      type="button"
      data-pattern-motion
      onMouseEnter={() => onPreview?.(event)}
      onMouseLeave={onLeave}
      onFocus={() => onPreview?.(event)}
      onBlur={onLeave}
      onClick={() => onPreview?.(event, 2600)}
      aria-label={`Spotlight ${event.label}`}
      style={{
        width: "100%",
        appearance: "none",
        display: "grid",
        gridTemplateColumns: "10px 1fr auto",
        alignItems: "center",
        gap: 8,
        padding: "6px 8px",
        borderRadius: 7,
        border: active ? `1px solid ${event.color}` : "1px solid transparent",
        background: active ? `${event.color}1d` : "transparent",
        opacity: event.visible === false ? 0.62 : 1,
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: event.color,
          boxShadow: `0 0 14px ${event.color}`,
        }}
      />
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            color: "#e5e7eb",
            fontSize: 12,
            fontWeight: 800,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {event.label}
        </div>
        <div style={{ color: "#8b94a7", fontSize: 10 }}>{labelForFamily(event.family)}</div>
      </div>
      <div
        style={{
          color: event.color,
          fontSize: 12,
          fontWeight: 800,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {Math.round(event.confidence * 100)}%
      </div>
    </button>
  );
}

function labelForFamily(family: SignalPanelEvent["family"]) {
  if (family === "vision-candle") return "computer vision mode";
  if (family === "chart-setup") return "chart / TA setup";
  return "candlestick rule";
}

function usePatternPanelAnimation(rootRef: RefObject<HTMLElement | null>, deps: unknown[] = []) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || prefersReducedPatternMotion()) return undefined;

    const ctx = gsap.context(() => {
      gsap.fromTo(
        "[data-pattern-motion]",
        { autoAlpha: 0, y: -6 },
        { autoAlpha: 1, y: 0, duration: 0.18, stagger: 0.025, ease: "power2.out" },
      );
    }, root);

    return () => ctx.revert();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

function prefersReducedPatternMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function scanCandles(candles: CandleInput[], showAll = false): ScanState {
  const raw = detectUnifiedCandlePatterns(candles, SCAN_OPTIONS);
  const maxVisible = showAll ? SHOW_ALL_MAX_EVENTS : DISPLAY_MAX_EVENTS;
  const latestIndex = candles.length - 1;
  const ranked = rankPatternSignals(raw, {
    latestIndex,
    maxVisible,
    minVisibleScore: showAll ? 0.22 : 0.38,
    recencyWindow: showAll ? 260 : 190,
    perKindLimit: 1,
    perFamilyLimit: showAll ? 64 : 24,
    allowOverlaps: true,
  });
  const visible = selectDiverseSignals(ranked.raw, {
    maxVisible,
    minVisibleScore: showAll ? 0.2 : 0.34,
    latestIndex,
  }).sort((a, b) => a.endIndex - b.endIndex || a.startIndex - b.startIndex);
  const trade = decideTradeFromEvents(raw, candles, {
    latestIndex,
    minActionScore: 0.62,
    minWatchScore: 0.38,
    maxWatchBars: 10,
    recencyWindow: 56,
    requireVolumeConfirmation: false,
  });
  const uniqueKinds = new Set(raw.map((event) => event.kind)).size;
  return {
    raw,
    visible,
    marketBias: computeMarketBias(candles, trade.decision),
    decision: trade.decision,
    stats: {
      supported: CANDLE_PATTERN_REGISTRY.supported().length,
      detectedRaw: raw.length,
      uniqueKinds,
      visible: visible.length,
      watchlist: raw.filter((event) => event.status === "forming").length,
    },
  };
}

function selectDiverseSignals(
  signals: ReturnType<typeof rankPatternSignals>["raw"],
  {
    maxVisible,
    minVisibleScore,
    latestIndex,
  }: { maxVisible: number; minVisibleScore: number; latestIndex: number },
) {
  const accepted = signals
    .filter((signal) => {
      if (!signal.supported) return false;
      if (signal.event.status === "invalidated" || signal.event.status === "expired") return false;
      if (signal.visibleScore < minVisibleScore) return false;
      return latestIndex - signal.event.endIndex <= 260;
    })
    .sort((a, b) => {
      const recencyA = 1 - Math.min(1, Math.max(0, latestIndex - a.event.endIndex) / 260);
      const recencyB = 1 - Math.min(1, Math.max(0, latestIndex - b.event.endIndex) / 260);
      const structureA = a.event.family === "chart-setup" ? Math.min(0.18, eventSpan(a.event) / 180) : 0;
      const structureB = b.event.family === "chart-setup" ? Math.min(0.18, eventSpan(b.event) / 180) : 0;
      const scoreA = a.visibleScore * 0.58 + a.rawScore * 0.22 + recencyA * 0.12 + structureA;
      const scoreB = b.visibleScore * 0.58 + b.rawScore * 0.22 + recencyB * 0.12 + structureB;
      return scoreB - scoreA || b.event.confidence - a.event.confidence || b.event.endIndex - a.event.endIndex;
    });

  const byFamily = new Map<CandlePatternFamily, typeof accepted>();
  for (const family of ["candlestick", "vision-candle", "chart-setup"] as const) byFamily.set(family, []);
  for (const signal of accepted) byFamily.get(signal.event.family)?.push(signal);

  const selected: CandlePatternEvent[] = [];
  const selectedKinds = new Set<string>();
  const families: CandlePatternFamily[] = ["candlestick", "vision-candle", "chart-setup"];

  while (selected.length < maxVisible) {
    let added = false;
    for (const family of families) {
      const bucket = byFamily.get(family) ?? [];
      while (bucket.length) {
        const signal = bucket.shift();
        if (!signal || selectedKinds.has(signal.event.kind)) continue;
        selected.push(signal.event);
        selectedKinds.add(signal.event.kind);
        added = true;
        break;
      }
      if (selected.length >= maxVisible) break;
    }
    if (!added) break;
  }

  if (selected.length < Math.min(maxVisible, 18)) {
    for (const signal of accepted) {
      if (selected.length >= maxVisible) break;
      if (selected.some((event) => event.id === signal.event.id)) continue;
      selected.push(signal.event);
    }
  }

  return selected;
}

function selectChartOverlayEvents(events: CandlePatternEvent[], activeFamily: PatternFamilyFilter) {
  const maxEvents =
    activeFamily === "all"
      ? CHART_OVERLAY_MAX_EVENTS
      : activeFamily === "chart-setup"
        ? 10
        : activeFamily === "vision-candle"
          ? 8
          : 14;

  const familyFiltered = activeFamily === "all"
    ? events.filter((event) => event.family !== "candlestick" || eventSpan(event) <= 5)
    : events.filter((event) => event.family === activeFamily);

  const quotas: Record<CandlePatternFamily, number> = activeFamily === "all"
    ? { candlestick: 7, "vision-candle": 3, "chart-setup": 6 }
    : { candlestick: maxEvents, "vision-candle": maxEvents, "chart-setup": maxEvents };

  const used: Record<CandlePatternFamily, number> = { candlestick: 0, "vision-candle": 0, "chart-setup": 0 };
  const sorted = familyFiltered
    .slice()
    .sort((a, b) => {
      const structureA = a.family === "chart-setup" ? Math.min(0.18, eventSpan(a) / 180) : 0;
      const structureB = b.family === "chart-setup" ? Math.min(0.18, eventSpan(b) / 180) : 0;
      const scoreA = a.confidence + structureA;
      const scoreB = b.confidence + structureB;
      const recency = b.endIndex - a.endIndex;
      if (a.family !== "chart-setup" && b.family !== "chart-setup" && Math.abs(recency) > 12) return recency;
      return scoreB - scoreA || recency || eventSpan(b) - eventSpan(a);
    });

  const selected: CandlePatternEvent[] = [];
  for (const event of sorted) {
    if (selected.length >= maxEvents) break;
    if (used[event.family] >= quotas[event.family]) continue;
    if (selected.some((existing) => overlapsTooMuch(existing, event, activeFamily === "all" ? 0 : 0.45))) {
      continue;
    }
    selected.push(event);
    used[event.family] += 1;
  }

  return selected.sort((a, b) => a.endIndex - b.endIndex || a.startIndex - b.startIndex);
}

function mergeSpotlightEvent(events: CandlePatternEvent[], spotlight: CandlePatternEvent | null) {
  if (!spotlight || events.some((event) => event.id === spotlight.id)) return events;
  return [...events, spotlight];
}

function eventSpan(event: CandlePatternEvent) {
  return Math.max(1, event.endIndex - event.startIndex + 1);
}

function overlapsTooMuch(a: CandlePatternEvent, b: CandlePatternEvent, allowedRatio: number) {
  const left = Math.max(a.startIndex, b.startIndex);
  const right = Math.min(a.endIndex, b.endIndex);
  const overlap = Math.max(0, right - left + 1);
  if (overlap <= 0) return false;
  const smaller = Math.min(eventSpan(a), eventSpan(b));
  return overlap / smaller > allowedRatio;
}

function markVisible(raw: CandlePatternEvent[], visible: CandlePatternEvent[]): SignalPanelEvent[] {
  const visibleIds = new Set(visible.map((event) => event.id));
  return raw.map((event) => ({ ...event, visible: visibleIds.has(event.id) }));
}

function sortPanelEvents(events: SignalPanelEvent[]) {
  return events.slice().sort((a, b) => {
    const visibleDelta = Number(Boolean(b.visible)) - Number(Boolean(a.visible));
    if (visibleDelta) return visibleDelta;
    return b.endIndex - a.endIndex || b.confidence - a.confidence || a.label.localeCompare(b.label);
  });
}

function computeMarketBias(candles: CandleInput[], decision: TradeDecision) {
  if (candles.length < 8) return 0;
  const latestIndex = candles.length - 1;
  const latest = candles[latestIndex]!;
  const short = candles[Math.max(0, latestIndex - 8)]!;
  const long = candles[Math.max(0, latestIndex - 28)]!;
  const shortMove = (latest.close - short.close) / Math.max(0.01, Math.abs(short.close));
  const longMove = (latest.close - long.close) / Math.max(0.01, Math.abs(long.close));
  const candlePressure = candles.slice(-12).reduce((sum, bar) => {
    const range = Math.max(0.01, bar.high - bar.low);
    return sum + (bar.close - bar.open) / range;
  }, 0) / Math.min(12, candles.length);
  const decisionPressure =
    decision.side === "long" ? decision.confidence * 0.38 :
      decision.side === "short" ? -decision.confidence * 0.38 :
        0;
  return clamp(shortMove * 18 + longMove * 9 + candlePressure * 0.42 + decisionPressure, -1, 1);
}

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

function markManualPosition(position: ManualPosition, latest: CandleInput, latestIndex: number): ManualPosition {
  const direction = position.side === "long" ? 1 : -1;
  const pnl = (latest.close - position.entryPrice) * direction;
  return {
    ...position,
    markPrice: latest.close,
    latestIndex,
    pnl,
    pnlPct: position.entryPrice === 0 ? 0 : pnl / position.entryPrice,
    heldMs: Math.max(0, performance.now() - position.openedAt),
  };
}

function formatPnl(value: number) {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function formatSeconds(ms: number) {
  return `${Math.max(0, ms / 1000).toFixed(1)}s`;
}

function formatExitReason(reason: string) {
  return reason.replace(/-/g, " ");
}

function drawPositionOverlay(
  canvas: HTMLCanvasElement | null,
  chart: { timeScale(): { logicalToCoordinate(logical: number): number | null } },
  series: { priceToCoordinate(price: number): number | null },
  position: ManualPosition | null,
  botPosition: MicroBotPosition | null,
) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.font = "700 10px Arial, Helvetica, sans-serif";
  ctx.textBaseline = "middle";
  if (position) drawManualPositionOverlay(ctx, rect.width, chart, series, position);
  if (botPosition) drawBotPositionOverlay(ctx, rect.width, chart, series, botPosition);
  ctx.restore();
}

function drawManualPositionOverlay(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  chart: { timeScale(): { logicalToCoordinate(logical: number): number | null } },
  series: { priceToCoordinate(price: number): number | null },
  position: ManualPosition,
) {
  const entryY = series.priceToCoordinate(position.entryPrice);
  const markY = series.priceToCoordinate(position.markPrice);
  const entryX = chart.timeScale().logicalToCoordinate(position.entryIndex);
  const markX = chart.timeScale().logicalToCoordinate(position.latestIndex);
  if (entryY == null || markY == null || entryX == null || markX == null) return;
  const entryColor = position.side === "long" ? THEME.bullish : THEME.bearish;
  const slopeColor = position.markPrice >= position.entryPrice ? THEME.bullish : THEME.bearish;
  const pnlColor = position.pnl >= 0 ? THEME.bullish : THEME.bearish;
  const now = performance.now();
  const pulse = 0.5 + Math.sin(now / 180) * 0.5;

  ctx.save();
  ctx.strokeStyle = entryColor;
  ctx.lineWidth = 1.3;
  ctx.globalAlpha = 0.88;
  ctx.setLineDash([6, 7]);
  ctx.beginPath();
  ctx.moveTo(0, entryY);
  ctx.lineTo(canvasWidth, entryY);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = slopeColor;
  ctx.lineWidth = 2;
  ctx.shadowColor = slopeColor;
  ctx.shadowBlur = 12 + pulse * 10;
  ctx.beginPath();
  ctx.moveTo(entryX, entryY);
  ctx.lineTo(markX, markY);
  ctx.stroke();

  const label = `${position.side.toUpperCase()} ${formatPnl(position.pnl)} ${(position.pnlPct * 100).toFixed(2)}%`;
  const width = ctx.measureText(label).width + 18;
  const height = 24;
  const x = Math.max(12, Math.min(canvasWidth - width - 18, markX + 12));
  const y = Math.max(18, markY - height / 2);
  ctx.shadowBlur = 0;
  ctx.fillStyle = "rgba(8,13,24,.9)";
  ctx.strokeStyle = pnlColor;
  roundedRectPath(ctx, x, y, width, height, 7);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = pnlColor;
  ctx.font = "900 11px Arial, Helvetica, sans-serif";
  ctx.fillText(label, x + 9, y + height / 2 + 0.5);
  ctx.restore();
}

function drawBotPositionOverlay(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  chart: { timeScale(): { logicalToCoordinate(logical: number): number | null } },
  series: { priceToCoordinate(price: number): number | null },
  position: MicroBotPosition,
) {
  const entryY = series.priceToCoordinate(position.entryPrice);
  const markY = series.priceToCoordinate(position.markPrice);
  const entryX = chart.timeScale().logicalToCoordinate(position.entryIndex);
  const markX = chart.timeScale().logicalToCoordinate(position.latestIndex);
  if (entryY == null || markY == null || entryX == null || markX == null) return;
  const sideColor = position.side === "long" ? THEME.bullish : THEME.bearish;
  const slopeColor = position.markPrice >= position.entryPrice ? THEME.bullish : THEME.bearish;
  const pnlColor = position.pnl >= 0 ? THEME.bullish : THEME.bearish;
  const label = `BOT ${position.side.toUpperCase()} ${formatPnl(position.pnl)} ${Math.round(position.progress * 100)}%`;
  const width = ctx.measureText(label).width + 20;
  const height = 24;
  const x = Math.max(12, Math.min(canvasWidth - width - 18, markX + 14));
  const y = Math.max(48, markY - height - 12);

  ctx.save();
  ctx.globalAlpha = 0.82;
  ctx.strokeStyle = sideColor;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 6]);
  ctx.beginPath();
  ctx.moveTo(0, entryY);
  ctx.lineTo(canvasWidth, entryY);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.globalAlpha = 1;
  ctx.strokeStyle = slopeColor;
  ctx.lineWidth = 2.4;
  ctx.shadowColor = slopeColor;
  ctx.shadowBlur = 16;
  ctx.beginPath();
  ctx.moveTo(entryX, entryY);
  ctx.lineTo(markX, markY);
  ctx.stroke();

  ctx.shadowBlur = 0;
  ctx.fillStyle = "rgba(8,13,24,.92)";
  ctx.strokeStyle = pnlColor;
  roundedRectPath(ctx, x, y, width, height, 7);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = pnlColor;
  ctx.font = "900 11px Arial, Helvetica, sans-serif";
  ctx.fillText(label, x + 10, y + height / 2 + 0.5);
  ctx.restore();
}

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}

function makeBar(
  time: number,
  open: number,
  close: number,
  high: number,
  low: number,
  volume: number,
): CandleInput {
  return {
    time,
    open,
    high: Math.max(high, open, close),
    low: Math.min(low, open, close),
    close,
    volume,
  };
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
    next[next.length - 1] = makeBar(
      last.time,
      open,
      close,
      high,
      low,
      (last.volume ?? 1400) + rand() * 280 + body * 220,
    );
  }

  return next.length > MAX_BARS ? next.slice(next.length - MAX_BARS) : next;
}
