import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import gsap from "gsap";
import { AnimatePresence, motion } from "motion/react";
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

type DetectionFlash = {
  id: string;
  name: string;
  confidence: number;
  direction: "bullish" | "bearish" | "neutral";
  color: string;
};

type SessionStats = { total: number; best: number; score: number };
type RecentDetection = {
  id: string;
  name: string;
  color: string;
  confidence: number;
  direction: "bullish" | "bearish" | "neutral";
};

function prettyPatternName(event: CandlePatternEvent): string {
  const raw = event.label || event.kind || "Pattern";
  return raw
    .replace(/^(candle|pattern|vision|setup|ta|scan)[\s:_-]+/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || "Pattern";
}

/**
 * Gamified lock-on overlay. A targeting reticle snaps onto a detected pattern
 * (corner brackets converge + shockwave rings + screen-color vignette pulse),
 * then a punchy callout card springs in with an animated confidence meter and
 * a combo badge when detections chain.
 *
 * PERFORMANCE: every animated property is a `transform` or `opacity` only — no
 * width/box-shadow/backdrop-filter animation — so the whole thing composites on
 * the GPU and never competes with the streaming chart for main-thread frames.
 */
function DetectionLockOn({ flash, combo }: { flash: DetectionFlash | null; combo: number }) {
  const color = flash?.color ?? "#22c55e";
  const arrow = flash?.direction === "bullish" ? "▲" : flash?.direction === "bearish" ? "▼" : "◆";
  const BOX = 104;
  const corners = [
    { x: -1, y: -1, t: true, l: true },
    { x: 1, y: -1, t: true, r: true },
    { x: -1, y: 1, b: true, l: true },
    { x: 1, y: 1, b: true, r: true },
  ];
  return (
    <AnimatePresence>
      {flash ? (
        <motion.div
          key={flash.id}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 6,
            pointerEvents: "none",
            overflow: "hidden",
            fontFamily: APPLE_FONT,
          }}
        >
          {/* screen-color vignette pulse — opacity only */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 0.5, 0] }}
            transition={{ duration: 1.0, times: [0, 0.16, 1], ease: "easeOut" }}
            style={{
              position: "absolute",
              inset: 0,
              background: `radial-gradient(ellipse at 50% 44%, transparent 52%, ${color} 135%)`,
              willChange: "opacity",
              transform: "translateZ(0)",
            }}
          />
          {/* targeting reticle */}
          <div style={{ position: "absolute", top: "44%", left: "50%", width: 0, height: 0 }}>
            {[0, 0.12].map((d, i) => (
              <motion.div
                key={i}
                initial={{ scale: 0.25, opacity: 0.85 }}
                animate={{ scale: 3 + i, opacity: 0 }}
                transition={{ duration: 0.7, delay: d, ease: "easeOut" }}
                style={{
                  position: "absolute",
                  left: -60,
                  top: -60,
                  width: 120,
                  height: 120,
                  borderRadius: 999,
                  border: `2px solid ${color}`,
                  willChange: "transform, opacity",
                }}
              />
            ))}
            {corners.map((c, i) => (
              <motion.div
                key={i}
                initial={{ x: c.x * (BOX * 0.9), y: c.y * (BOX * 0.9), opacity: 0, scale: 1.4 }}
                animate={{ x: c.x * (BOX / 2), y: c.y * (BOX / 2), opacity: 1, scale: 1 }}
                transition={{ type: "spring", stiffness: 600, damping: 20, delay: 0.04 * i }}
                style={{
                  position: "absolute",
                  width: 22,
                  height: 22,
                  marginLeft: -11,
                  marginTop: -11,
                  borderColor: color,
                  borderStyle: "solid",
                  borderWidth: 0,
                  borderTopWidth: c.t ? 3 : 0,
                  borderBottomWidth: c.b ? 3 : 0,
                  borderLeftWidth: c.l ? 3 : 0,
                  borderRightWidth: c.r ? 3 : 0,
                  willChange: "transform, opacity",
                }}
              />
            ))}
            <motion.div
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: [0, 1.4, 1], opacity: [0, 1, 0.85] }}
              transition={{ duration: 0.5, ease: "easeOut" }}
              style={{
                position: "absolute",
                left: -3,
                top: -3,
                width: 6,
                height: 6,
                borderRadius: 999,
                background: color,
                willChange: "transform, opacity",
              }}
            />
          </div>
          {/* callout card */}
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.82 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.92 }}
            transition={{ type: "spring", stiffness: 520, damping: 22, mass: 0.7 }}
            style={{
              position: "absolute",
              top: "calc(44% + 92px)",
              left: "50%",
              translate: "-50% 0",
              width: 250,
              padding: "11px 16px 13px",
              borderRadius: 14,
              border: `1px solid ${color}`,
              background: "rgba(9, 13, 20, 0.92)",
              boxShadow: `0 0 26px ${color}44, 0 10px 34px rgba(0,0,0,0.45)`,
              color: "#f8fafc",
              willChange: "transform, opacity",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 9, letterSpacing: 1.6, textTransform: "uppercase", color, fontWeight: 800 }}>
                ◇ Pattern Locked
              </span>
              {combo > 1 ? (
                <motion.span
                  key={combo}
                  initial={{ scale: 0.2, opacity: 0 }}
                  animate={{ scale: [0.2, 1.35, 1], opacity: 1 }}
                  transition={{ duration: 0.42, ease: "easeOut" }}
                  style={{
                    fontSize: 11,
                    fontWeight: 900,
                    color: "#0b0e14",
                    background: color,
                    padding: "1px 7px",
                    borderRadius: 999,
                    letterSpacing: 0.5,
                    willChange: "transform",
                  }}
                >
                  ×{combo} COMBO
                </motion.span>
              ) : null}
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ fontSize: 17, fontWeight: 700, lineHeight: 1.1 }}>{flash.name}</span>
              <span style={{ fontSize: 14, color, fontWeight: 800 }}>{arrow}</span>
            </div>
            <div style={{ marginTop: 9, display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ position: "relative", flex: 1, height: 5, borderRadius: 999, background: "rgba(255,255,255,0.1)", overflow: "hidden" }}>
                <motion.div
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: Math.max(0.02, Math.min(1, flash.confidence)) }}
                  transition={{ duration: 0.55, delay: 0.12, ease: "easeOut" }}
                  style={{
                    position: "absolute",
                    inset: 0,
                    transformOrigin: "left center",
                    background: color,
                    borderRadius: 999,
                    willChange: "transform",
                  }}
                />
              </div>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#cbd5e1", fontVariantNumeric: "tabular-nums" }}>
                {Math.round(flash.confidence * 100)}%
              </span>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * Live/Paused status. While following: a subtle pulsing "● LIVE" tag. After the
 * user pans (follow off), it expands into a prominent click-to-resume control —
 * the missing signal for *why* the cinematic camera went quiet and how to re-arm.
 */
function LiveStatus({ live, onResume }: { live: boolean; onResume: () => void }) {
  return (
    <div
      style={{
        position: "absolute",
        bottom: "calc(16px + env(safe-area-inset-bottom))",
        left: "50%",
        translate: "-50% 0",
        zIndex: 5,
        fontFamily: APPLE_FONT,
      }}
    >
      <AnimatePresence mode="wait" initial={false}>
        {live ? (
          <motion.div
            key="live"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.2 }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "5px 11px",
              borderRadius: 999,
              background: "rgba(9,13,20,0.7)",
              border: "1px solid rgba(255,255,255,0.08)",
              pointerEvents: "none",
            }}
          >
            <motion.span
              animate={{ opacity: [1, 0.3, 1], scale: [1, 0.82, 1] }}
              transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
              style={{ width: 7, height: 7, borderRadius: 999, background: THEME.bullish, boxShadow: `0 0 8px ${THEME.bullish}`, willChange: "transform, opacity" }}
            />
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: "#cbd5e1", textTransform: "uppercase" }}>Live</span>
          </motion.div>
        ) : (
          <motion.button
            key="paused"
            type="button"
            onClick={onResume}
            initial={{ opacity: 0, y: 10, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.95 }}
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.97 }}
            transition={{ type: "spring", stiffness: 480, damping: 24 }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              padding: "8px 15px",
              borderRadius: 999,
              background: "rgba(9,13,20,0.92)",
              border: `1px solid ${THEME.compression}`,
              color: "#f8fafc",
              cursor: "pointer",
              font: "inherit",
              boxShadow: `0 0 20px ${THEME.compression}40, 0 8px 24px rgba(0,0,0,0.4)`,
              pointerEvents: "auto",
              willChange: "transform, opacity",
            }}
          >
            <span style={{ fontSize: 13 }}>⏸</span>
            <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 0.4 }}>Paused — tap to follow live</span>
            <span style={{ fontSize: 12, color: THEME.compression }}>→</span>
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

function ProgressionStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <span style={{ fontSize: 14, fontWeight: 800, color: "#f1f5f9", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{value}</span>
      <span style={{ fontSize: 8.5, letterSpacing: 0.6, textTransform: "uppercase", color: "#6b7280", fontWeight: 600 }}>{label}</span>
    </div>
  );
}

/**
 * Gamified session-progression HUD: running score (confidence × combo), total
 * patterns locked, best combo, and an animated feed of the most recent hits.
 */
function ProgressionHud({ stats, combo, recent }: { stats: SessionStats; combo: number; recent: RecentDetection[] }) {
  if (stats.total === 0) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: "max(10px, env(safe-area-inset-left))",
        bottom: "calc(16px + env(safe-area-inset-bottom))",
        zIndex: 4,
        width: 190,
        pointerEvents: "none",
        fontFamily: APPLE_FONT,
      }}
    >
      <div style={{ borderRadius: 14, border: "1px solid rgba(255,255,255,0.08)", background: "rgba(9,13,20,0.78)", padding: "10px 12px", boxShadow: "0 10px 30px rgba(0,0,0,0.35)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
          <span style={{ fontSize: 9, letterSpacing: 1.4, textTransform: "uppercase", color: "#8b93a3", fontWeight: 700 }}>Session</span>
          {combo > 1 ? (
            <motion.span
              key={combo}
              initial={{ scale: 0.4, opacity: 0.4 }}
              animate={{ scale: [0.4, 1.25, 1], opacity: 1 }}
              transition={{ duration: 0.4, ease: "easeOut" }}
              style={{ fontSize: 10, fontWeight: 900, color: THEME.neutral, willChange: "transform" }}
            >
              🔥 ×{combo}
            </motion.span>
          ) : null}
        </div>
        <div style={{ display: "flex", gap: 12, marginBottom: recent.length ? 9 : 0 }}>
          <ProgressionStat label="Score" value={stats.score.toLocaleString()} />
          <ProgressionStat label="Patterns" value={String(stats.total)} />
          <ProgressionStat label="Best" value={`×${stats.best}`} />
        </div>
        <div style={{ display: "grid", gap: 4 }}>
          <AnimatePresence initial={false}>
            {recent.map((d) => (
              <motion.div
                key={d.id}
                layout
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                transition={{ type: "spring", stiffness: 500, damping: 30 }}
                style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5 }}
              >
                <span style={{ width: 5, height: 5, borderRadius: 999, background: d.color, flexShrink: 0 }} />
                <span style={{ flex: 1, color: "#cbd5e1", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontWeight: 600 }}>{d.name}</span>
                <span style={{ color: "#6b7280", fontVariantNumeric: "tabular-nums" }}>{Math.round(d.confidence * 100)}%</span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

const THEME = {
  bg: "#c6c4ba",
  panel: "rgba(247, 246, 239, .66)",
  border: "rgba(255, 255, 255, .42)",
  text: "#191a17",
  muted: "#6d6a62",
  grid: "rgba(70, 69, 63, .13)",
  candleUp: "#f7f6ef",
  candleDown: "#242521",
  bullish: "#21d07a",
  bearish: "#ff5263",
  neutral: "#c99a18",
  compression: "#2f97d4",
  setup: "#8b6fed",
  ta: "#fb923c",
};
const APPLE_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif';

const STREAM_INTERVAL_MS = 70;
const STREAM_TICKS_PER_BAR = 9;
const MAX_BARS = 260;
const DISPLAY_MAX_EVENTS = 14;
const SHOW_ALL_MAX_EVENTS = 28;
const PANEL_MAX_EVENTS = 12;
const CHART_OVERLAY_MAX_EVENTS = 7;
const ENDPOINT_PATTERN_WINDOW_BARS = 9;
const LIVE_PROJECT_WINDOW_BARS = 14;
const POSITION_FRAME_MS = 90;
const MANUAL_TRADE_UI_FRAME_MS = 110;
const BOT_UPDATE_EVERY_TICKS = 2;
const DETECTION_RESCAN_EVERY_BARS = 4;
const MICRO_BOT_OPTIONS = {
  minHoldMs: 5000,
  maxHoldMs: 10000,
  cooldownMs: 1500,
  entryThreshold: 0.56,
  flipExitThreshold: 0.48,
  targetRangeMultiple: 0.42,
  stopRangeMultiple: 0.32,
  minPressure: 0.22,
  maxOppositeScore: 0.84,
  minDecisionConfidence: 0.6,
  minMomentumScore: 0.04,
  requireDecisionConfirmation: false,
};
const SCAN_OPTIONS = {
  minConfidence: 0.68,
  lookback: 48,
  includeWeak: false,
  enableExpandedCandles: true,
  enableStructures: true,
  enableTaPatterns: true,
  maxStructureEvents: 6,
  maxPatternAgeBars: 40,
  maxBars: 48,
  minBars: 10,
  maxEventsPerKind: 1,
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
const LIVE_STRATEGY_LAB_ENABLED = false;

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

type BotSignalContext = {
  side: "long" | "short" | "none";
  probability: number;
  threshold: number;
  macroScore: number;
  setupScore: number;
  microScore: number;
  conflictScore: number;
  macroLabel: string;
  setupLabel: string;
  microLabel: string;
  conflictLabel: string;
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
  const initialScan = useMemo(() => scanCandles(initialCandles, false), [initialCandles]);
  const candlesRef = useRef(initialCandles);
  const scanRef = useRef(initialScan);
  const eventsRef = useRef<CandlePatternEvent[]>(
    selectChartOverlayEvents(initialScan.visible, "all", initialCandles.length - 1),
  );
  const spotlightEventRef = useRef<CandlePatternEvent | null>(null);
  const replayTimerRef = useRef<number | null>(null);
  const spotlightClearTimerRef = useRef<number | null>(null);
  const showAllRef = useRef(false);
  const followLiveRef = useRef(true);
  const activeFamilyRef = useRef<PatternFamilyFilter>("all");
  const tradeSideRef = useRef<ManualTradeSide>("long");
  const manualPositionRef = useRef<ManualPosition | null>(null);
  const closedTradesRef = useRef<ClosedManualTrade[]>([]);
  const microBotRef = useRef<MicroBotState>(createMicroBotState());
  const calibrationRef = useRef<MicroBotCalibrationResult | null>(null);
  const walkForwardRef = useRef<MicroBotWalkForwardResult | null>(null);
  const calibrationPendingRef = useRef(false);
  const [activeFamily, setActiveFamily] = useState<PatternFamilyFilter>("all");
  const [showAll, setShowAll] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [followLive, setFollowLive] = useState(true);
  const [tradeSide, setTradeSide] = useState<ManualTradeSide>("long");
  const [manualPosition, setManualPosition] = useState<ManualPosition | null>(null);
  const [closedTrades, setClosedTrades] = useState<ClosedManualTrade[]>([]);
  const [microBot, setMicroBot] = useState<MicroBotState>(() => microBotRef.current);
  const [calibration, setCalibration] = useState<MicroBotCalibrationResult | null>(() => calibrationRef.current);
  const [walkForward, setWalkForward] = useState<MicroBotWalkForwardResult | null>(() => walkForwardRef.current);
  const [spotlightId, setSpotlightId] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanState>(() => initialScan);
  const [hover, setHover] = useState<HoverState>(null);
  // Cinematic detection camera — GSAP-driven zoom-to-pattern lock-on + a
  // Framer Motion flash. cinematicActiveRef is true while a lock-on move is in
  // flight so the streaming follow logic and the range-change follow-killer
  // stand down and don't fight the camera.
  const cinematicActiveRef = useRef(false);
  const cameraTimelineRef = useRef<gsap.core.Timeline | null>(null);
  const lockOnCooldownRef = useRef(0);
  const lockedEventIdsRef = useRef<Set<string>>(new Set());
  const [detectionFlash, setDetectionFlash] = useState<DetectionFlash | null>(null);
  const detectionFlashTimerRef = useRef<number | null>(null);
  const comboRef = useRef(0);
  const [combo, setCombo] = useState(0);
  const sessionStatsRef = useRef<SessionStats>({ total: 0, best: 0, score: 0 });
  const [sessionStats, setSessionStats] = useState<SessionStats>({ total: 0, best: 0, score: 0 });
  const [recentDetections, setRecentDetections] = useState<RecentDetection[]>([]);
  const panelEvents = useMemo(
    () => sortPanelEvents(markVisible(scan.raw, scan.visible)),
    [scan.raw, scan.visible],
  );
  const signalContext = useMemo(
    () => buildBotSignalContext(candlesRef.current, scan, microBot),
    [scan, microBot],
  );

  const setFollowLiveMode = useCallback((next: boolean) => {
    if (followLiveRef.current === next) return;
    followLiveRef.current = next;
    setFollowLive(next);
  }, []);

  const resumeLiveFollow = useCallback(() => {
    setFollowLiveMode(true);
    chartRef.current?.timeScale().scrollToPosition(10, true);
  }, [setFollowLiveMode]);

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
    if (!LIVE_STRATEGY_LAB_ENABLED) return;
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
    scanRef.current = nextScan;
    const chartEvents = selectChartOverlayEvents(nextScan.visible, activeFamilyRef.current, candlesRef.current.length - 1);
    eventsRef.current = chartEvents;
    overlayRef.current?.setData(candlesRef.current, mergeSpotlightEvent(chartEvents, spotlightEventRef.current));
    overlayRef.current?.replay();
    setScan(nextScan);
  };

  const handleFamilyChange = (family: PatternFamilyFilter) => {
    activeFamilyRef.current = family;
    setActiveFamily(family);
    const chartEvents = selectChartOverlayEvents(scanRef.current.visible, family, candlesRef.current.length - 1);
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
    const onPointerUp = () => closeManualTrade("pointer");
    const onBlur = () => {
      closeManualTrade("pointer");
    };

    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onBlur);
    return () => {
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onBlur);
    };
  }, [closeManualTrade]);

  const mountChart = useCallback((host: HTMLDivElement) => {
    const startingScan = scanCandles(candlesRef.current, showAllRef.current);
    scanRef.current = startingScan;
    const startingChartEvents = selectChartOverlayEvents(
      startingScan.visible,
      activeFamilyRef.current,
      candlesRef.current.length - 1,
    );
    eventsRef.current = startingChartEvents;

    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: THEME.bg },
        textColor: THEME.text,
        fontFamily: APPLE_FONT,
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
          color: "rgba(35,35,31,.35)",
          style: LineStyle.Dashed,
          labelBackgroundColor: "#2d2d28",
        },
        horzLine: {
          color: "rgba(35,35,31,.35)",
          style: LineStyle.Dashed,
          labelBackgroundColor: "#2d2d28",
        },
      },
      rightPriceScale: {
        borderColor: "rgba(35,35,31,.18)",
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      timeScale: {
        borderColor: "rgba(35,35,31,.18)",
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
    const handleUserPointerGesture = (event: PointerEvent) => {
      if (event.button === 0) setFollowLiveMode(false);
    };
    const handleUserWheelGesture = () => setFollowLiveMode(false);
    host.addEventListener("pointerdown", handleUserPointerGesture, { capture: true });
    host.addEventListener("wheel", handleUserWheelGesture, { capture: true, passive: true });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: THEME.candleUp,
      downColor: THEME.candleDown,
      borderUpColor: "#2d2e29",
      borderDownColor: "#242521",
      wickUpColor: "rgba(35,36,32,.82)",
      wickDownColor: "rgba(35,36,32,.82)",
      borderVisible: true,
      priceLineVisible: true,
      priceLineColor: THEME.bearish,
      priceLineWidth: 1,
      lastValueVisible: true,
    });
    series.setData(toSeriesData(candlesRef.current));
    let internalRangeUpdate = false;
    let internalRangeTimer: number | null = null;
    let rangeAnimation: {
      start: { from: number; to: number };
      target: { from: number; to: number };
      startedAt: number;
      durationMs: number;
    } | null = null;
    const setVisibleRange = (range: { from: number; to: number }) => {
      internalRangeUpdate = true;
      chart.timeScale().setVisibleLogicalRange(range);
      if (internalRangeTimer != null) window.clearTimeout(internalRangeTimer);
      internalRangeTimer = window.setTimeout(() => {
        internalRangeUpdate = false;
      }, 0);
    };
    const latestFollowRange = (width?: number) => {
      const currentRange = chart.timeScale().getVisibleLogicalRange();
      const currentWidth = width ?? Math.max(32, currentRange ? currentRange.to - currentRange.from : 82);
      const endpoint = candlesRef.current.length - 1 + 10;
      return { from: endpoint - currentWidth, to: endpoint };
    };
    const animateVisibleRangeTo = (target: { from: number; to: number }, durationMs = 240) => {
      const currentRange = chart.timeScale().getVisibleLogicalRange();
      if (!currentRange) {
        setVisibleRange(target);
        return;
      }
      rangeAnimation = {
        start: { from: currentRange.from, to: currentRange.to },
        target,
        startedAt: performance.now(),
        durationMs,
      };
    };
    const advanceRangeAnimation = (frameMs: number) => {
      if (!rangeAnimation) return;
      const t = clamp((frameMs - rangeAnimation.startedAt) / Math.max(1, rangeAnimation.durationMs), 0, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setVisibleRange({
        from: rangeAnimation.start.from + (rangeAnimation.target.from - rangeAnimation.start.from) * eased,
        to: rangeAnimation.start.to + (rangeAnimation.target.to - rangeAnimation.start.to) * eased,
      });
      if (t >= 1) rangeAnimation = null;
    };
    const setSeriesDataMaybeFollowLatest = (data: CandlestickData<UTCTimestamp>[]) => {
      const currentRange = chart.timeScale().getVisibleLogicalRange();
      const width = Math.max(32, currentRange ? currentRange.to - currentRange.from : 82);
      series.setData(data);
      if (!followLiveRef.current || cinematicActiveRef.current) return;
      window.requestAnimationFrame(() => {
        animateVisibleRangeTo(latestFollowRange(width));
      });
    };
    const followLatestAfterIncrement = () => {
      if (!followLiveRef.current || cinematicActiveRef.current) return;
      animateVisibleRangeTo(latestFollowRange(), 180);
    };

    // GSAP cinematic lock-on: zoom the visible range to frame a freshly
    // detected pattern, hold on it, then ease back to the live-follow window.
    // Only ever called while following, and cinematicActiveRef suppresses the
    // streaming follow + range-change follow-killer for the duration so the
    // camera owns the timeScale uncontested.
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const cinematicLockOn = (event: CandlePatternEvent) => {
      if (!followLiveRef.current) return;
      overlayRef.current?.setSpotlight(event.id);
      spotlightEventRef.current = event;
      // Honor reduced-motion: spotlight the pattern but skip the camera move.
      if (prefersReducedMotion) {
        window.setTimeout(() => {
          overlayRef.current?.setSpotlight(null);
          spotlightEventRef.current = null;
        }, 2200);
        return;
      }
      const currentRange = chart.timeScale().getVisibleLogicalRange();
      if (!currentRange) return;
      cameraTimelineRef.current?.kill();
      rangeAnimation = null;
      cinematicActiveRef.current = true;
      // Freeze the price (Y) axis for the lock-on. The framed window still
      // includes the live, ticking candle, and its per-tick high/low changes
      // would otherwise make auto-scale rescale every frame — that is the
      // vertical "shifts back and forth" jitter while locked. Restored on the
      // way out so live follow resumes normal auto-scaling.
      series.priceScale().applyOptions({ autoScale: false });

      // Keep candle size CONSTANT: preserve the visible bar count and only pan
      // so the pattern sits center-ish. Narrowing the bar count is what made
      // candles balloon — we never do that. This is a glide-to-pattern, not a
      // zoom. A few extra bars of lead room keeps the live edge in view.
      const width = Math.max(40, currentRange.to - currentRange.from);
      const center = (event.startIndex + event.endIndex) / 2;
      const framed = {
        from: center - width * 0.55,
        to: center + width * 0.45,
      };
      const proxy = { from: currentRange.from, to: currentRange.to };
      const apply = () => setVisibleRange({ from: proxy.from, to: proxy.to });

      const tl = gsap.timeline({
        onComplete: () => {
          cinematicActiveRef.current = false;
          cameraTimelineRef.current = null;
          series.priceScale().applyOptions({ autoScale: true });
          overlayRef.current?.setSpotlight(null);
          spotlightEventRef.current = null;
          if (followLiveRef.current) setVisibleRange(latestFollowRange());
        },
      });
      // Snappy decisive glide in (expo.out reads as a game "lock"), hold, then
      // a smooth settle back to the live edge.
      tl.to(proxy, { from: framed.from, to: framed.to, duration: 0.52, ease: "expo.out", onUpdate: apply });
      // Function-based end values: GSAP evaluates these when the return tween
      // starts, so we ease back to the live edge as it is *then*, not the stale
      // edge from when the timeline was built.
      tl.to(proxy, {
        from: () => latestFollowRange().from,
        to: () => latestFollowRange().to,
        duration: 0.68,
        ease: "power2.inOut",
        // Re-enable auto-scale as the pan-back begins, so the Y-axis settles
        // home *during* the motion rather than snapping after it lands.
        onStart: () => series.priceScale().applyOptions({ autoScale: true }),
        onUpdate: apply,
      }, "+=1.0");
      cameraTimelineRef.current = tl;
    };

    // Shared lock-on trigger — used by both the detection loop and the startup
    // demo. Tracks a combo streak when locks chain within the combo window.
    const comboWindowMs = 9000;
    const triggerLockOn = (pick: CandlePatternEvent, nowMs: number) => {
      if (lockedEventIdsRef.current.size > 200) lockedEventIdsRef.current.clear();
      lockedEventIdsRef.current.add(pick.id);
      const sinceLast = nowMs - lockOnCooldownRef.current;
      comboRef.current = lockOnCooldownRef.current > 0 && sinceLast < comboWindowMs ? comboRef.current + 1 : 1;
      lockOnCooldownRef.current = nowMs;
      setCombo(comboRef.current);
      cinematicLockOn(pick);
      const tone =
        pick.direction === "bullish" ? THEME.bullish :
        pick.direction === "bearish" ? THEME.bearish : THEME.neutral;
      // Session progression — points scale with the live combo multiplier.
      const points = Math.round(pick.confidence * 100) * comboRef.current;
      sessionStatsRef.current = {
        total: sessionStatsRef.current.total + 1,
        best: Math.max(sessionStatsRef.current.best, comboRef.current),
        score: sessionStatsRef.current.score + points,
      };
      setSessionStats(sessionStatsRef.current);
      setRecentDetections((prev) =>
        [{ id: pick.id, name: prettyPatternName(pick), color: tone, confidence: pick.confidence, direction: pick.direction }, ...prev].slice(0, 4),
      );
      setDetectionFlash({
        id: pick.id,
        name: prettyPatternName(pick),
        confidence: pick.confidence,
        direction: pick.direction,
        color: tone,
      });
      if (detectionFlashTimerRef.current != null) window.clearTimeout(detectionFlashTimerRef.current);
      detectionFlashTimerRef.current = window.setTimeout(() => setDetectionFlash(null), 2600);
    };

    // ── Off-thread pattern detection ──────────────────────────────────────
    // The detector pass runs in a Web Worker; the main thread does the cheap
    // post-processing and applies the result when it lands. Falls back to a
    // synchronous scan if the worker can't be created.
    const maybeTriggerLockOn = (events: CandlePatternEvent[]) => {
      const frameMs = gsap.ticker.time * 1000;
      if (!followLiveRef.current || cinematicActiveRef.current) return;
      if (frameMs - lockOnCooldownRef.current <= 4200) return;
      if (tickRef.current <= STREAM_TICKS_PER_BAR * 2) return;
      // Page-visibility guard: don't fire lock-ons while the tab is hidden.
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      const liveEdge = candlesRef.current.length - 1;
      let pick: CandlePatternEvent | null = null;
      for (const ev of events) {
        if (ev.confidence < 0.62) continue;
        if (ev.endIndex < liveEdge - 18) continue;
        if (lockedEventIdsRef.current.has(ev.id)) continue;
        if (!pick || ev.confidence > pick.confidence) pick = ev;
      }
      if (pick) triggerLockOn(pick, frameMs);
    };

    const applyScan = (scan: ScanState) => {
      scanRef.current = scan;
      const evs = selectChartOverlayEvents(scan.visible, activeFamilyRef.current, candlesRef.current.length - 1);
      eventsRef.current = evs;
      setScan(scan);
      overlay.setData(candlesRef.current, mergeSpotlightEvent(evs, spotlightEventRef.current));
      maybeTriggerLockOn(evs);
    };

    let scanWorker: Worker | null = null;
    let scanInFlight = false;
    let pendingScanLen = 0;
    try {
      scanWorker = new Worker(new URL("./candle-vision.worker.ts", import.meta.url), { type: "module" });
      scanWorker.onmessage = (e: MessageEvent<{ detected: CandlePatternEvent[] }>) => {
        scanInFlight = false;
        // Detected indices stay valid only if the candle array hasn't grown
        // since the request (a sub-bar round-trip); if it has, recompute sync.
        const aligned = candlesRef.current.length === pendingScanLen;
        applyScan(scanCandles(candlesRef.current, showAllRef.current, aligned ? e.data.detected : undefined));
      };
      scanWorker.onerror = () => {
        scanWorker?.terminate();
        scanWorker = null;
      };
    } catch {
      scanWorker = null;
    }

    const requestScan = () => {
      const snapshot = candlesRef.current;
      if (scanWorker) {
        if (scanInFlight) return; // coalesce — the next rescan will dispatch
        scanInFlight = true;
        pendingScanLen = snapshot.length;
        scanWorker.postMessage({ candles: snapshot, options: SCAN_OPTIONS });
      } else {
        applyScan(scanCandles(snapshot, showAllRef.current));
      }
    };

    const overlay = createLightweightChartsPatternOverlay(series, chart, {
      candles: candlesRef.current,
      events: startingChartEvents,
      showLabels: host.clientWidth > 620,
      showBoxTags: host.clientWidth > 620,
      maxLabels: 4,
      maxEvents: CHART_OVERLAY_MAX_EVENTS + 2,
      maxActiveBoxes: 3,
      maxPins: 8,
      maxBoxOverlapRatio: 0.08,
      boxCollisionPaddingPx: 16,
      minDisplayConfidence: 0.58,
      fillOpacity: 0.014,
      strokeOpacity: 0.34,
      scanlineOpacity: 0.24,
      labelCollisionPadding: 34,
      activeTtlMs: 7200,
      collapsedTtlMs: 11500,
      eventFadeOutMs: 1800,
      clusterRadiusPx: 42,
      labelRightInsetPx: 28,
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

    setVisibleRange({
      from: Math.max(0, candlesRef.current.length - 72),
      to: candlesRef.current.length + 10,
    });
    const handleVisibleRangeChange = (range: { from: number; to: number } | null) => {
      if (!range || internalRangeUpdate || cinematicActiveRef.current) return;
      const latestEndpoint = candlesRef.current.length - 1 + 10;
      if (range.to < latestEndpoint - 3) {
        setFollowLiveMode(false);
        rangeAnimation = null;
      }
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleRangeChange);
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
    let lastPositionFrameMs = 0;
    let lastManualUiFrameMs = 0;
    const update = () => {
      const now = gsap.ticker.time;
      const frameMs = now * 1000;
      advanceRangeAnimation(frameMs);
      if (frameMs - lastPositionFrameMs >= POSITION_FRAME_MS) {
        drawPositionOverlay(positionCanvasRef.current, chart, series, manualPositionRef.current, microBotRef.current.position);
        lastPositionFrameMs = frameMs;
      }
      accumulatedMs += (now - previousTime) * 1000;
      previousTime = now;
      if (accumulatedMs < STREAM_INTERVAL_MS) return;
      accumulatedMs %= STREAM_INTERVAL_MS;

      tickRef.current += 1;
      const previous = candlesRef.current;
      const next = streamCandles(previous, tickRef.current, randomRef.current);
      const latest = next[next.length - 1];
      const trimmed =
        next.length === MAX_BARS &&
        previous.length === MAX_BARS &&
        next[0]?.time !== previous[0]?.time;
      candlesRef.current = next;
      const completedBar = tickRef.current % STREAM_TICKS_PER_BAR === 0;
      const shouldRescan = trimmed || tickRef.current % (STREAM_TICKS_PER_BAR * DETECTION_RESCAN_EVERY_BARS) === 0;
      let nextScan = scanRef.current;
      let chartEvents = eventsRef.current;
      if (shouldRescan) {
        requestScan(); // worker (async) or sync fallback → result applied via applyScan
        chartEvents = selectChartOverlayEvents(scanRef.current.visible, activeFamilyRef.current, next.length - 1);
        eventsRef.current = chartEvents;
      } else if (completedBar || tickRef.current % 3 === 0) {
        chartEvents = selectChartOverlayEvents(scanRef.current.visible, activeFamilyRef.current, next.length - 1);
        eventsRef.current = chartEvents;
      }

      if (trimmed) {
        setSeriesDataMaybeFollowLatest(toSeriesData(next));
      } else {
        series.update({
          time: latest.time as UTCTimestamp,
          open: latest.open,
          high: latest.high,
          low: latest.low,
          close: latest.close,
        });
        if (completedBar) followLatestAfterIncrement();
      }
      if (manualPositionRef.current && latest) {
        const marked = markManualPosition(manualPositionRef.current, latest, next.length - 1);
        manualPositionRef.current = marked;
        if (frameMs - lastManualUiFrameMs >= MANUAL_TRADE_UI_FRAME_MS) {
          setManualPosition(marked);
          lastManualUiFrameMs = frameMs;
        }
      }
      if (shouldRescan || tickRef.current % BOT_UPDATE_EVERY_TICKS === 0) {
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
      }
      if (tickRef.current % CALIBRATION_RECALC_TICKS === 0) scheduleCalibration();
      if (completedBar || tickRef.current % 3 === 0) {
        overlay.setData(next, mergeSpotlightEvent(chartEvents, spotlightEventRef.current));
      }
      // Note: scan results (scanRef/eventsRef/setScan/overlay) are applied
      // asynchronously by applyScan when the worker (or sync fallback) returns.
    };
    gsap.ticker.add(update);

    // One-time startup demonstration: ~3s after mount, lock onto the strongest
    // recent pattern so the cinematic camera is unmistakably visible on first
    // load (independent of whether a fresh high-confidence detection has fired
    // yet). Tunable / removable once the detection-driven trigger is dialed in.
    const startupLockOn = gsap.delayedCall(3, () => {
      if (!followLiveRef.current || cinematicActiveRef.current) return;
      const liveEdge = candlesRef.current.length - 1;
      let pick: CandlePatternEvent | null = null;
      for (const ev of eventsRef.current) {
        if (ev.endIndex < liveEdge - 24) continue;
        if (!pick || ev.confidence > pick.confidence) pick = ev;
      }
      if (!pick) return;
      triggerLockOn(pick, gsap.ticker.time * 1000);
    });

    return () => {
      startupLockOn.kill();
      scanWorker?.terminate();
      gsap.ticker.remove(update);
      cameraTimelineRef.current?.kill();
      cameraTimelineRef.current = null;
      cinematicActiveRef.current = false;
      series.priceScale().applyOptions({ autoScale: true });
      if (detectionFlashTimerRef.current != null) window.clearTimeout(detectionFlashTimerRef.current);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleRangeChange);
      if (internalRangeTimer != null) window.clearTimeout(internalRangeTimer);
      host.removeEventListener("pointerdown", handleUserPointerGesture, { capture: true });
      host.removeEventListener("wheel", handleUserWheelGesture, { capture: true });
      overlay.detach();
      chart.remove();
      chartRef.current = null;
      overlayRef.current = null;
    };
  }, [scheduleCalibration, setFollowLiveMode]);

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
        minHeight: 0,
        overflow: "hidden",
        color: THEME.text,
        fontFamily: APPLE_FONT,
        fontVariantNumeric: "tabular-nums",
        background: THEME.bg,
      }}
    >
      <div
        ref={setChartHost}
        data-cv-host
        onPointerDownCapture={(event) => {
          if (event.button === 0) setFollowLiveMode(false);
        }}
        onWheelCapture={() => setFollowLiveMode(false)}
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
      <DetectionLockOn flash={detectionFlash} combo={combo} />
      <ProgressionHud stats={sessionStats} combo={combo} recent={recentDetections} />
      <LiveStatus live={followLive} onResume={resumeLiveFollow} />
      <GlassTradingHud
        bot={microBot}
        context={signalContext}
        followLive={followLive}
        detailsOpen={diagnosticsOpen}
        side={tradeSide}
        position={manualPosition}
        closedTrades={closedTrades}
        onToggleFollow={() => followLive ? setFollowLiveMode(false) : resumeLiveFollow()}
        onToggleDetails={() => setDiagnosticsOpen((open) => !open)}
        onSideChange={handleTradeSideChange}
        onHoldStart={() => openManualTrade("pointer")}
      />

      {diagnosticsOpen ? (
        <div
          data-cv-panel
          className="cv-bottom-sheet"
          style={{
            position: "absolute",
            left: "max(10px, env(safe-area-inset-left))",
            right: "max(10px, env(safe-area-inset-right))",
            bottom: "max(10px, env(safe-area-inset-bottom))",
            zIndex: 4,
            maxHeight: "min(72dvh, 720px)",
            overflow: "auto",
            display: "grid",
            gap: 10,
            padding: 10,
            border: `1px solid ${THEME.border}`,
            borderRadius: 22,
            background: "rgba(247,246,239,.74)",
            backdropFilter: "blur(24px) saturate(1.35)",
            boxShadow: "0 24px 90px rgba(35,35,31,.22), inset 0 1px 0 rgba(255,255,255,.62)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
              <span style={{ width: 8, height: 8, borderRadius: 999, background: THEME.compression }} />
              <span style={{ color: THEME.text, fontSize: 13, fontWeight: 900 }}>Candle Vision</span>
            </div>
            <button
              type="button"
              aria-label="Close details"
              onClick={() => setDiagnosticsOpen(false)}
              style={glassIconButtonStyle(THEME.text)}
            >
              ×
            </button>
          </div>
          <ScalpBotPanel bot={microBot} context={signalContext} calibration={calibration} walkForward={walkForward} />
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
                width: "100%",
                padding: 12,
                border: `1px solid ${THEME.border}`,
                borderRadius: 14,
                background: "rgba(255,255,255,.4)",
                boxShadow: "0 12px 34px rgba(35,35,31,.12)",
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
      ) : null}
      <style>{mobileGlassCss()}</style>
    </div>
  );
}

function GlassTradingHud({
  bot,
  context,
  followLive,
  detailsOpen,
  side,
  position,
  closedTrades,
  onToggleFollow,
  onToggleDetails,
  onSideChange,
  onHoldStart,
}: {
  bot: MicroBotState;
  context: BotSignalContext;
  followLive: boolean;
  detailsOpen: boolean;
  side: ManualTradeSide;
  position: ManualPosition | null;
  closedTrades: ClosedManualTrade[];
  onToggleFollow: () => void;
  onToggleDetails: () => void;
  onSideChange: (side: ManualTradeSide) => void;
  onHoldStart: () => void;
}) {
  const activeColor = position
    ? position.side === "long" ? THEME.bullish : THEME.bearish
    : context.side === "short" ? THEME.bearish : context.side === "long" ? THEME.bullish : THEME.compression;
  const latestClosed = closedTrades[0];
  const pnl = position?.pnl ?? latestClosed?.pnl ?? bot.stats.pnl;
  const pnlColor = pnl >= 0 ? THEME.bullish : THEME.bearish;
  const winRate = bot.stats.totalTrades >= 8 ? `${Math.round(bot.stats.winRate * 100)}%` : "—";
  const signalValue = Math.round(context.probability * 100);
  const tradeColor = side === "long" ? THEME.bullish : THEME.bearish;

  return (
    <div
      data-cv-panel
      className="cv-glass-hud"
      style={{
        position: "absolute",
        top: "max(10px, env(safe-area-inset-top))",
        left: "max(10px, env(safe-area-inset-left))",
        right: "max(10px, env(safe-area-inset-right))",
        zIndex: 5,
        display: "flex",
        alignItems: "center",
        gap: 8,
        minHeight: 44,
        padding: "7px 8px",
        border: `1px solid ${THEME.border}`,
        borderRadius: 999,
        color: THEME.text,
        background: "rgba(247,246,239,.64)",
        backdropFilter: "blur(26px) saturate(1.45)",
        boxShadow: "0 18px 58px rgba(35,35,31,.2), inset 0 1px 0 rgba(255,255,255,.72)",
      }}
    >
      <div className="cv-brand-pill" aria-label="Candle Vision">
        <span style={{ width: 8, height: 8, borderRadius: 999, background: activeColor, boxShadow: `0 0 16px ${activeColor}` }} />
        <strong>CV</strong>
      </div>

      <MiniHudGauge label="SIG" value={`${signalValue}`} color={activeColor} />
      <MiniHudGauge label="P&L" value={formatPnl(pnl)} color={pnlColor} />
      <MiniHudGauge label="WR" value={winRate} color={bot.stats.winRate >= 0.52 ? THEME.bullish : bot.stats.winRate <= 0.44 ? THEME.bearish : THEME.text} />

      <div className="cv-side-toggle" aria-label="Trade side">
        {(["long", "short"] as const).map((nextSide) => {
          const selected = side === nextSide;
          const color = nextSide === "long" ? THEME.bullish : THEME.bearish;
          return (
            <button
              key={nextSide}
              type="button"
              aria-label={`Select ${nextSide}`}
              onClick={() => onSideChange(nextSide)}
              style={{
                width: 30,
                height: 30,
                border: 0,
                borderRadius: 999,
                background: selected ? hexToRgba(color, 0.18) : "transparent",
                color: selected ? color : THEME.muted,
                fontSize: 11,
                fontWeight: 950,
                cursor: "pointer",
              }}
            >
              {nextSide === "long" ? "L" : "S"}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        aria-label={position ? "Position open" : `Hold to open ${side}`}
        onPointerDown={(event) => {
          event.preventDefault();
          onHoldStart();
        }}
        style={{
          ...glassIconButtonStyle(tradeColor),
          width: 34,
          minWidth: 34,
          boxShadow: position ? `0 0 22px ${hexToRgba(tradeColor, 0.35)}` : undefined,
        }}
      >
        {position ? "●" : "◐"}
      </button>
      <button
        type="button"
        aria-label={followLive ? "Pause live follow" : "Resume live follow"}
        onClick={onToggleFollow}
        style={glassIconButtonStyle(followLive ? THEME.compression : THEME.muted)}
      >
        {followLive ? "◎" : "↗"}
      </button>
      <button
        type="button"
        aria-label={detailsOpen ? "Close details" : "Open details"}
        onClick={onToggleDetails}
        style={glassIconButtonStyle(THEME.text)}
      >
        {detailsOpen ? "×" : "⋯"}
      </button>
    </div>
  );
}

function MiniHudGauge({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="cv-mini-gauge">
      <span>{label}</span>
      <strong style={{ color }}>{value}</strong>
    </div>
  );
}

function glassIconButtonStyle(color: string): CSSProperties {
  return {
    width: 32,
    height: 32,
    minWidth: 32,
    display: "inline-grid",
    placeItems: "center",
    padding: 0,
    borderRadius: 999,
    border: `1px solid ${hexToRgba(color, 0.26)}`,
    background: "rgba(255,255,255,.28)",
    color,
    fontSize: 14,
    fontWeight: 950,
    cursor: "pointer",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,.54)",
  };
}

function mobileGlassCss() {
  return `
    .cv-glass-hud {
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
    }
    .cv-glass-hud::-webkit-scrollbar { display: none; }
    .cv-brand-pill {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      height: 30px;
      padding: 0 10px;
      border-radius: 999px;
      background: rgba(255,255,255,.28);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.58);
      font-size: 12px;
      letter-spacing: .02em;
      white-space: nowrap;
    }
    .cv-mini-gauge {
      min-width: 58px;
      height: 30px;
      display: grid;
      grid-template-columns: auto auto;
      align-items: center;
      justify-content: center;
      gap: 5px;
      padding: 0 9px;
      border-radius: 999px;
      background: rgba(255,255,255,.24);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.52);
      white-space: nowrap;
    }
    .cv-mini-gauge span {
      color: ${THEME.muted};
      font-size: 9px;
      font-weight: 900;
      letter-spacing: .08em;
    }
    .cv-mini-gauge strong {
      font-size: 12px;
      line-height: 1;
      font-weight: 950;
    }
    .cv-side-toggle {
      display: inline-flex;
      align-items: center;
      padding: 2px;
      border-radius: 999px;
      background: rgba(255,255,255,.22);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.52);
    }
    .cv-bottom-sheet {
      scrollbar-width: thin;
      scrollbar-color: rgba(35,35,31,.22) transparent;
    }
    @media (max-width: 680px) {
      .cv-glass-hud {
        top: max(7px, env(safe-area-inset-top)) !important;
        left: max(7px, env(safe-area-inset-left)) !important;
        right: max(7px, env(safe-area-inset-right)) !important;
        min-height: 38px !important;
        gap: 5px !important;
        padding: 5px !important;
        overflow-x: auto;
      }
      .cv-brand-pill {
        height: 28px;
        padding: 0 8px;
      }
      .cv-mini-gauge {
        min-width: 48px;
        height: 28px;
        gap: 4px;
        padding: 0 7px;
      }
      .cv-mini-gauge span {
        font-size: 8px;
      }
      .cv-mini-gauge strong {
        font-size: 11px;
      }
      .cv-side-toggle button {
        width: 27px !important;
        height: 27px !important;
      }
      .cv-bottom-sheet {
        left: 0 !important;
        right: 0 !important;
        bottom: 0 !important;
        max-height: min(76dvh, 680px) !important;
        border-radius: 24px 24px 0 0 !important;
        padding: 10px 10px max(14px, env(safe-area-inset-bottom)) !important;
      }
    }
    @media (max-width: 390px) {
      .cv-brand-pill strong { display: none; }
      .cv-mini-gauge { min-width: 44px; }
      .cv-mini-gauge span { display: none; }
    }
  `;
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
        width: "100%",
        padding: 14,
        border: `1px solid ${color}55`,
        borderRadius: 16,
        background: `linear-gradient(180deg, ${hexToRgba(color, 0.13)}, rgba(255,255,255,.34))`,
        boxShadow: `0 14px 40px rgba(35,35,31,.12), 0 0 28px ${hexToRgba(color, 0.08)}`,
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
              color: THEME.text,
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
            background: "rgba(255,255,255,.3)",
            color: THEME.text,
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

function ScalpBotPanel({
  bot,
  context,
  calibration,
  walkForward,
}: {
  bot: MicroBotState;
  context: BotSignalContext;
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
  const minWinRateSample = 8;
  const sampleReady = bot.stats.totalTrades >= minWinRateSample;
  const sampleLabel = bot.stats.totalTrades < 40 ? `n=${bot.stats.totalTrades}` : "live";
  const winRateLabel = sampleReady ? `${Math.round(bot.stats.winRate * 100)}%` : "warming";
  const winRateColor = sampleReady
    ? bot.stats.winRate >= 0.52 ? THEME.bullish : bot.stats.winRate <= 0.44 ? THEME.bearish : THEME.text
    : THEME.muted;
  const qualityLine = calibration?.best
    ? `${calibration.best.preset.label} backtest ${Math.round(calibration.best.winRate * 100)}%`
    : walkForward?.summary.bestPresetLabel
      ? `${walkForward.summary.bestPresetLabel} walk-forward ${Math.round(walkForward.summary.winRate * 100)}%`
      : sampleReady
        ? "closed-trade sample; strict confluence gate"
        : `waiting for ${minWinRateSample} closed trades`;

  return (
    <section
      data-cv-panel
      data-scalp-bot-panel
      style={{
        position: "relative",
        right: "auto",
        top: "auto",
        zIndex: "auto",
        width: "100%",
        maxHeight: "none",
        overflow: "hidden",
        display: "grid",
        gap: 8,
        padding: 11,
        border: `1px solid ${hexToRgba(activeColor, 0.44)}`,
        borderRadius: 16,
        background: "rgba(255,255,255,.34)",
        boxShadow: `0 14px 40px rgba(35,35,31,.12), 0 0 24px ${hexToRgba(activeColor, 0.08)}`,
        backdropFilter: "blur(18px) saturate(1.25)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: activeColor, fontSize: 10, fontWeight: 900, textTransform: "uppercase" }}>
            5-10s scalp engine
          </div>
          <div style={{ color: THEME.text, fontSize: 18, lineHeight: 1.05, fontWeight: 950 }}>
            {headline}
          </div>
        </div>
        <div style={{ display: "grid", justifyItems: "end", gap: 2 }}>
          <div style={{ color: activeColor, fontSize: 26, lineHeight: 1, fontWeight: 950 }}>
            {Math.round(bot.signal.entryScore * 100)}
          </div>
          <div style={{ color: THEME.muted, fontSize: 10, fontWeight: 800, textTransform: "uppercase" }}>
            signal
          </div>
        </div>
      </div>

      <OrderFlowVisualizer signal={bot.signal} />

      <SignalContextStack context={context} activeColor={activeColor} />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
        <BotMetric label="P&L" value={formatPnl(bot.stats.pnl)} color={bot.stats.pnl >= 0 ? THEME.bullish : THEME.bearish} />
        <BotMetric label="Live WR" value={winRateLabel} color={winRateColor} />
        <BotMetric label={sampleLabel} value={`${bot.stats.totalTrades}x`} color={THEME.text} />
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
        <div style={{ color: THEME.muted, fontSize: 10, lineHeight: 1.3, fontWeight: 750 }}>
          {subline}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {bot.signal.reasons.slice(0, 2).map((reason) => (
          <div
            key={reason}
            style={{
              maxWidth: "100%",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 7px",
              border: `1px solid ${hexToRgba(activeColor, 0.24)}`,
              borderRadius: 999,
              background: hexToRgba(activeColor, 0.08),
            }}
          >
            <span style={{ width: 5, height: 5, borderRadius: 999, background: activeColor }} />
            <span style={{ color: THEME.text, fontSize: 10, fontWeight: 800, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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

      <div style={{ color: THEME.muted, fontSize: 9, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {qualityLine}
      </div>
      <CalibrationSummary calibration={calibration} />
      <WalkForwardSummary walkForward={walkForward} />
    </section>
  );
}

function SignalContextStack({ context, activeColor }: { context: BotSignalContext; activeColor: string }) {
  const isReady = context.probability >= context.threshold && context.side !== "none" && context.conflictScore < 0.48;
  const statusColor = isReady ? activeColor : context.conflictScore >= 0.52 ? THEME.bearish : THEME.neutral;
  return (
    <div
      style={{
        display: "grid",
        gap: 7,
        padding: 9,
        border: `1px solid ${hexToRgba(statusColor, 0.28)}`,
        borderRadius: 8,
        background: `linear-gradient(180deg, ${hexToRgba(statusColor, 0.1)}, rgba(255,255,255,.28))`,
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", alignItems: "center", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: THEME.muted, fontSize: 9, fontWeight: 900, textTransform: "uppercase", letterSpacing: ".08em" }}>
            probability stack
          </div>
          <div style={{ color: THEME.text, fontSize: 12, fontWeight: 900, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {context.side === "none" ? "No directional edge" : `${context.side.toUpperCase()} edge forming`}
          </div>
        </div>
        <div style={{ color: statusColor, fontSize: 20, fontWeight: 950, fontVariantNumeric: "tabular-nums" }}>
          {Math.round(context.probability * 100)}%
        </div>
      </div>
      <div style={{ position: "relative", height: 8, borderRadius: 999, background: "rgba(148,163,184,.14)", overflow: "hidden" }}>
        <div
          style={{
            width: `${Math.round(context.probability * 100)}%`,
            height: "100%",
            borderRadius: 999,
            background: `linear-gradient(90deg, ${hexToRgba(activeColor, 0.52)}, ${activeColor})`,
            boxShadow: `0 0 18px ${hexToRgba(activeColor, 0.28)}`,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: `${Math.round(context.threshold * 100)}%`,
            top: 0,
            bottom: 0,
            width: 2,
            background: THEME.text,
            boxShadow: "0 0 10px rgba(35,35,31,.3)",
          }}
        />
      </div>
      <div style={{ display: "grid", gap: 4 }}>
        <ContextMeter label="Macro" detail={context.macroLabel} value={context.macroScore} color={activeColor} />
        <ContextMeter label="Setup" detail={context.setupLabel} value={context.setupScore} color={THEME.setup} />
        <ContextMeter label="Micro" detail={context.microLabel} value={context.microScore} color={THEME.compression} />
        <ContextMeter label="Conflict" detail={context.conflictLabel} value={context.conflictScore} color={THEME.bearish} inverse />
      </div>
    </div>
  );
}

function ContextMeter({
  label,
  detail,
  value,
  color,
  inverse = false,
}: {
  label: string;
  detail: string;
  value: number;
  color: string;
  inverse?: boolean;
}) {
  const displayColor = inverse && value < 0.35 ? THEME.bullish : color;
  return (
    <div title={`${label}: ${detail}`} style={{ display: "grid", gridTemplateColumns: "52px 1fr 30px", alignItems: "center", gap: 7 }}>
      <span style={{ color: THEME.muted, fontSize: 9, fontWeight: 900, textTransform: "uppercase" }}>{label}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ height: 4, borderRadius: 999, background: "rgba(148,163,184,.12)", overflow: "hidden" }}>
          <div
            style={{
              width: `${Math.round(clamp01(value) * 100)}%`,
              height: "100%",
              borderRadius: 999,
              background: displayColor,
            }}
          />
        </div>
      </div>
      <span style={{ color: displayColor, fontSize: 10, fontWeight: 950, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        {Math.round(clamp01(value) * 100)}
      </span>
    </div>
  );
}

function CalibrationSummary({ calibration }: { calibration: MicroBotCalibrationResult | null }) {
  const best = calibration?.best;
  if (!calibration || !best) {
    return null;
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
          <div style={{ color: THEME.text, fontSize: 13, fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
              color: THEME.text,
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
    return null;
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
          <div style={{ color: THEME.text, fontSize: 13, fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
              color: THEME.text,
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
        background: "rgba(255,255,255,.28)",
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
        background: "rgba(255,255,255,.28)",
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
        color: THEME.text,
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
        width: "100%",
        padding: 14,
        border: `1px solid ${THEME.border}`,
        borderRadius: 16,
        background: "rgba(255,255,255,.34)",
        boxShadow: "0 14px 40px rgba(35,35,31,.12)",
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
          color: THEME.muted,
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
            style={{ color: THEME.muted, fontSize: 12, lineHeight: 1.45, padding: "8px 0" }}
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
      <Metric label="Supported" value={stats.supported} color={THEME.text} />
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
        border: `1px solid ${THEME.border}`,
        borderRadius: 7,
        background: "rgba(255,255,255,.28)",
      }}
    >
      <div
        style={{
          color: THEME.muted,
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
    { id: "all", label: "All", color: THEME.text },
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
                border: `1px solid ${active ? filter.color : "rgba(35,35,31,.14)"}`,
                background: active ? `${filter.color}22` : "rgba(255,255,255,.24)",
                color: active ? filter.color : THEME.muted,
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
            color: THEME.text,
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
            color: THEME.compression,
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
            color: THEME.text,
            fontSize: 12,
            fontWeight: 800,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {event.label}
        </div>
        <div style={{ color: THEME.muted, fontSize: 10 }}>{labelForFamily(event.family)}</div>
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

function scanCandles(candles: CandleInput[], showAll = false, detectedOverride?: CandlePatternEvent[]): ScanState {
  // detectedOverride lets the Web Worker supply the (expensive) detector pass so
  // it runs off the main thread; falls back to a synchronous detect otherwise.
  const detected = detectedOverride ?? detectUnifiedCandlePatterns(candles, SCAN_OPTIONS);
  const maxVisible = showAll ? SHOW_ALL_MAX_EVENTS : DISPLAY_MAX_EVENTS;
  const latestIndex = candles.length - 1;
  const endpointFormation = createEndpointFormationEvent(candles, latestIndex);
  const raw = mergeLiveProjectedEvents(
    endpointFormation ? [...detected, endpointFormation] : detected,
    latestIndex,
    showAll ? 8 : 5,
  );
  const ranked = rankPatternSignals(raw, {
    latestIndex,
    maxVisible,
    minVisibleScore: showAll ? 0.22 : 0.38,
    recencyWindow: showAll ? 180 : 96,
    perKindLimit: 1,
    perFamilyLimit: showAll ? 64 : 24,
    allowOverlaps: true,
  });
  const selectedVisible = selectDiverseSignals(ranked.raw, {
    maxVisible,
    minVisibleScore: showAll ? 0.2 : 0.34,
    latestIndex,
  }).sort((a, b) => a.endIndex - b.endIndex || a.startIndex - b.startIndex);
  const visible = endpointFormation && !selectedVisible.some((event) => event.id === endpointFormation.id)
    ? [...selectedVisible.slice(0, Math.max(0, maxVisible - 1)), endpointFormation]
        .sort((a, b) => a.endIndex - b.endIndex || a.startIndex - b.startIndex)
    : selectedVisible;
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

function createEndpointFormationEvent(candles: CandleInput[], latestIndex: number): CandlePatternEvent | null {
  if (latestIndex < 8) return null;
  const startIndex = Math.max(0, latestIndex - 8);
  const window = candles.slice(startIndex, latestIndex + 1);
  const first = window[0];
  const last = window[window.length - 1];
  if (!first || !last) return null;
  const high = Math.max(...window.map((candle) => candle.high));
  const low = Math.min(...window.map((candle) => candle.low));
  const range = Math.max(0.0001, high - low);
  const closeDelta = last.close - first.open;
  const pressure = clamp(closeDelta / range, -1, 1);
  const bodyCompression = clamp01(
    1 - window.reduce((sum, candle) => sum + Math.abs(candle.close - candle.open), 0) / Math.max(range * window.length, 0.0001),
  );
  const direction = pressure > 0.18 ? "bullish" : pressure < -0.18 ? "bearish" : "neutral";
  const color = direction === "bullish" ? THEME.bullish : direction === "bearish" ? THEME.bearish : THEME.compression;
  const label = direction === "neutral" ? "Live range forming" : `Live ${direction} setup`;
  return {
    id: `endpoint-formation:${latestIndex}`,
    kind: direction === "bullish" ? "vwap-reclaim" : direction === "bearish" ? "vwap-rejection" : "vision-compression",
    family: "vision-candle",
    status: "forming",
    direction,
    startIndex,
    endIndex: latestIndex,
    detectedAt: latestIndex,
    confidence: clamp(0.82 + Math.abs(pressure) * 0.12 + bodyCompression * 0.06, 0.8, 0.96),
    strength: clamp(0.72 + Math.abs(pressure) * 0.18, 0.68, 0.96),
    label,
    description: "Live endpoint formation, continuously rebuilt from the newest candles so the visible box tracks the active price action.",
    source: "candle-vision",
    anchors: [
      { index: startIndex, time: first.time, price: first.open, role: "start" },
      { index: latestIndex, time: last.time, price: last.close, role: "end" },
      { index: window.findIndex((candle) => candle.high === high) + startIndex, time: last.time, price: high, role: "high" },
      { index: window.findIndex((candle) => candle.low === low) + startIndex, time: last.time, price: low, role: "low" },
    ],
    color,
    scoreBreakdown: {
      liveEndpoint: 1,
      pressure: Math.abs(pressure),
      compression: bodyCompression,
    },
  };
}

function mergeLiveProjectedEvents(events: CandlePatternEvent[], latestIndex: number, limit: number) {
  if (latestIndex < 0 || !events.length || limit <= 0) return events;
  const projected = events
    .filter((event) => shouldProjectLiveEvent(event, latestIndex))
    .sort((a, b) => {
      const ageA = latestIndex - a.endIndex;
      const ageB = latestIndex - b.endIndex;
      return ageA - ageB || b.confidence - a.confidence || eventSpan(b) - eventSpan(a);
    })
    .slice(0, limit)
    .map((event) => projectEventToLatest(event, latestIndex));

  if (!projected.length) return events;
  const ids = new Set(events.map((event) => event.id));
  return [...events, ...projected.filter((event) => !ids.has(event.id))];
}

function shouldProjectLiveEvent(event: CandlePatternEvent, latestIndex: number) {
  if (isLiveProjectedEvent(event)) return false;
  if (event.status === "invalidated" || event.status === "expired") return false;
  const age = latestIndex - event.endIndex;
  if (age < 1 || age > LIVE_PROJECT_WINDOW_BARS) return false;
  if (event.family === "chart-setup") return age <= LIVE_PROJECT_WINDOW_BARS && event.confidence >= 0.58;
  if (event.family === "vision-candle") return age <= 12 && event.confidence >= 0.62;
  return age <= 6 && event.confidence >= 0.64;
}

function projectEventToLatest(event: CandlePatternEvent, latestIndex: number): CandlePatternEvent {
  const age = Math.max(1, latestIndex - event.endIndex);
  const confidenceDecay = event.family === "chart-setup" ? 0.012 : 0.02;
  const confidence = clamp01(event.confidence - age * confidenceDecay);
  return {
    ...event,
    id: `${event.id}:live:${latestIndex}`,
    endIndex: latestIndex,
    detectedAt: latestIndex,
    status: "forming",
    confidence: Math.max(0.55, confidence),
    strength: Math.max(0.5, event.strength - age * 0.012),
    description: `${event.description} Live projection follows the newest candles while this setup is still active.`,
    scoreBreakdown: {
      ...(event.scoreBreakdown ?? {}),
      liveProjection: 1,
    },
  };
}

function isLiveProjectedEvent(event: CandlePatternEvent) {
  return event.id.includes(":live:");
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
      return latestIndex - signal.event.endIndex <= 140;
    })
    .sort((a, b) => {
      const ageA = Math.max(0, latestIndex - a.event.endIndex);
      const ageB = Math.max(0, latestIndex - b.event.endIndex);
      const endpointA = ageA <= ENDPOINT_PATTERN_WINDOW_BARS ? 0.3 : 0;
      const endpointB = ageB <= ENDPOINT_PATTERN_WINDOW_BARS ? 0.3 : 0;
      const recencyA = 1 - Math.min(1, ageA / 96);
      const recencyB = 1 - Math.min(1, ageB / 96);
      const structureA = a.event.family === "chart-setup" ? Math.min(0.14, eventSpan(a.event) / 220) : 0;
      const structureB = b.event.family === "chart-setup" ? Math.min(0.14, eventSpan(b.event) / 220) : 0;
      const scoreA = a.visibleScore * 0.52 + a.rawScore * 0.2 + recencyA * 0.16 + structureA + endpointA;
      const scoreB = b.visibleScore * 0.52 + b.rawScore * 0.2 + recencyB * 0.16 + structureB + endpointB;
      return scoreB - scoreA || b.event.confidence - a.event.confidence || b.event.endIndex - a.event.endIndex;
    });

  const byFamily = new Map<CandlePatternFamily, typeof accepted>();
  for (const family of ["candlestick", "vision-candle", "chart-setup"] as const) byFamily.set(family, []);
  for (const signal of accepted) byFamily.get(signal.event.family)?.push(signal);

  const selected: CandlePatternEvent[] = [];
  const selectedKinds = new Set<string>();
  const families: CandlePatternFamily[] = ["candlestick", "vision-candle", "chart-setup"];
  const endpointSignals = accepted
    .filter((signal) => latestIndex - signal.event.endIndex <= ENDPOINT_PATTERN_WINDOW_BARS)
    .sort((a, b) => b.event.endIndex - a.event.endIndex || b.visibleScore - a.visibleScore)
    .slice(0, Math.min(5, maxVisible));

  for (const signal of endpointSignals) {
    if (selected.length >= maxVisible) break;
    if (selected.some((event) => event.id === signal.event.id)) continue;
    selected.push(signal.event);
    selectedKinds.add(signal.event.kind);
  }

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

function selectChartOverlayEvents(events: CandlePatternEvent[], activeFamily: PatternFamilyFilter, latestIndex: number) {
  const maxEvents =
    activeFamily === "all"
      ? CHART_OVERLAY_MAX_EVENTS
      : activeFamily === "chart-setup"
        ? 10
        : activeFamily === "vision-candle"
          ? 8
          : 14;

  const liveEvents = mergeLiveProjectedEvents(events, latestIndex, activeFamily === "all" ? 4 : 7);
  const familyFiltered = activeFamily === "all"
    ? liveEvents.filter((event) => event.family !== "candlestick" || eventSpan(event) <= 5 || isLiveProjectedEvent(event))
    : liveEvents.filter((event) => event.family === activeFamily);

  const quotas: Record<CandlePatternFamily, number> = activeFamily === "all"
    ? { candlestick: 3, "vision-candle": 2, "chart-setup": 3 }
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
  const endpoint = sorted
    .filter((event) => latestIndex - event.endIndex <= ENDPOINT_PATTERN_WINDOW_BARS)
    .slice(0, Math.min(activeFamily === "all" ? 3 : 5, maxEvents));

  for (const event of endpoint) {
    if (selected.length >= maxEvents) break;
    if (used[event.family] >= quotas[event.family]) continue;
    if (selected.some((existing) => existing.id === event.id)) continue;
    selected.push(event);
    used[event.family] += 1;
  }

  for (const event of sorted) {
    if (selected.length >= maxEvents) break;
    if (used[event.family] >= quotas[event.family]) continue;
    if (selected.some((existing) => existing.id === event.id)) continue;
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

function buildBotSignalContext(candles: CandleInput[], scan: ScanState, bot: MicroBotState): BotSignalContext {
  const latestIndex = candles.length - 1;
  const macroPressure = normalizedMove(candles, 72) * 0.56 + normalizedMove(candles, 34) * 0.28 + scan.marketBias * 0.32;
  const setupPressure = directionalEventPressure(scan.raw, latestIndex, "chart-setup", 72);
  const patternPressure =
    directionalEventPressure(scan.raw, latestIndex, "candlestick", 18) * 0.56 +
    directionalEventPressure(scan.raw, latestIndex, "vision-candle", 28) * 0.44;
  const microPressure = bot.signal.pressure * 0.54 + bot.signal.momentum * 0.26 + patternPressure * 0.2;
  const combined = macroPressure * 0.34 + setupPressure * 0.28 + microPressure * 0.38;
  const side = combined > 0.08 ? "long" : combined < -0.08 ? "short" : "none";
  const macroScore = clamp01(Math.abs(macroPressure));
  const setupScore = clamp01(Math.max(Math.abs(setupPressure), bot.signal.setupScore));
  const microScore = clamp01(Math.max(Math.abs(microPressure), bot.signal.entryScore));
  const conflictScore = clamp01(bot.signal.oppositeScore * 0.52 + directionalConflict(macroPressure, setupPressure, microPressure) * 0.48);
  const probability = clamp01(
    macroScore * 0.22 +
    setupScore * 0.24 +
    microScore * 0.34 +
    bot.signal.volumeScore * 0.08 +
    bot.signal.confidence * 0.18 -
    conflictScore * 0.22,
  );

  return {
    side,
    probability,
    threshold: MICRO_BOT_OPTIONS.entryThreshold,
    macroScore,
    setupScore,
    microScore,
    conflictScore,
    macroLabel: describePressure(macroPressure, "higher-timeframe drift"),
    setupLabel: describePressure(setupPressure, "large setup context"),
    microLabel: bot.signal.reasons[0] ?? describePressure(microPressure, "micro trigger"),
    conflictLabel: conflictScore > 0.52 ? "opposing evidence active" : "clean enough",
  };
}

function normalizedMove(candles: CandleInput[], bars: number) {
  if (candles.length < 4) return 0;
  const latest = candles[candles.length - 1]!;
  const prior = candles[Math.max(0, candles.length - 1 - bars)]!;
  const range = averageCandleRange(candles, Math.min(bars, candles.length));
  return clamp((latest.close - prior.close) / Math.max(0.1, range * Math.sqrt(Math.max(1, bars / 6))), -1, 1);
}

function averageCandleRange(candles: CandleInput[], bars: number) {
  const slice = candles.slice(-Math.max(1, bars));
  return Math.max(0.1, slice.reduce((sum, bar) => sum + Math.max(0.01, bar.high - bar.low), 0) / slice.length);
}

function directionalEventPressure(
  events: CandlePatternEvent[],
  latestIndex: number,
  family: CandlePatternFamily,
  windowBars: number,
) {
  let pressure = 0;
  for (const event of events) {
    if (event.family !== family || event.direction === "neutral") continue;
    const age = latestIndex - event.endIndex;
    if (age < 0 || age > windowBars) continue;
    const direction = event.direction === "bullish" ? 1 : -1;
    const recency = clamp01(1 - age / Math.max(1, windowBars));
    const spanWeight = family === "chart-setup" ? clamp(0.65 + eventSpan(event) / 60, 0.7, 1.25) : 1;
    pressure += direction * event.confidence * recency * spanWeight;
  }
  return clamp(pressure, -1, 1);
}

function directionalConflict(...values: number[]) {
  const positive = values.filter((value) => value > 0.12).reduce((sum, value) => sum + value, 0);
  const negative = Math.abs(values.filter((value) => value < -0.12).reduce((sum, value) => sum + value, 0));
  if (positive === 0 || negative === 0) return 0;
  return clamp01(Math.min(positive, negative) / Math.max(positive, negative));
}

function describePressure(value: number, fallback: string) {
  if (value > 0.16) return `${fallback}: bullish`;
  if (value < -0.16) return `${fallback}: bearish`;
  return `${fallback}: neutral`;
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

function clamp01(value: number) {
  return clamp(value, 0, 1);
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
  // Sign decided AFTER rounding: a value that rounds to zero renders "$0.00",
  // never the misleading "-$0.00" (the #682/#721 bug-class).
  const s = Math.abs(value).toFixed(2);
  if (parseFloat(s) === 0) return `$${s}`;
  return `${value < 0 ? "-" : "+"}$${s}`;
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

  if (canvasWidth < 560) {
    ctx.shadowBlur = 0;
    ctx.fillStyle = pnlColor;
    ctx.beginPath();
    ctx.arc(markX, markY, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

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

  if (canvasWidth < 560) {
    ctx.shadowBlur = 0;
    ctx.fillStyle = pnlColor;
    ctx.beginPath();
    ctx.arc(markX, markY, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

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
