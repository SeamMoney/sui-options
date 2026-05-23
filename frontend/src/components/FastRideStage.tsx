import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BARRIER_LOWER,
  BARRIER_UPPER,
  expandSegment,
  newState as newWalkState,
  type BarrierIndex,
  type Candle as SeededCandle,
  type WalkState,
} from "@wick/sdk";
import { cn } from "@/lib/utils";
import type {
  RideGestureCallbacks,
  RidePhase,
  RoundInfo,
  SegmentInput,
} from "@/hooks/useRideGesture";

const VIEW_W = 1600;
const VIEW_H = 860;
const CHART_TOP = 48;
const CHART_BOTTOM = 790;
const CHART_H = CHART_BOTTOM - CHART_TOP;
const SPOT_X = 1120;
const HISTORY_MS = 12_000;
const DEFAULT_SEGMENT_MS = 400;
const MIN_SEGMENT_MS = 250;
const MAX_SEGMENT_MS = 1200;
const PRICE_SCALING = 1_000_000;
const CANDLES_PER_SEGMENT = 6;
const STALL_THRESHOLD_MS = 3000;

interface FastRideStageProps {
  callbacks: RideGestureCallbacks;
  phase: RidePhase;
  pickedBarrier: BarrierIndex | null;
  round: RoundInfo | null;
  segments: ReadonlyArray<SegmentInput>;
  inOpenWindow: boolean;
  multiplierBps?: number;
  stakePerSegmentMicroUsd?: bigint;
  onPnlChange?: (snap: { pnl: number; staked: number }) => void;
  disabled?: boolean;
}

interface TimedCandle {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface EntryState {
  openedAtMs: number;
  entryPrice: number;
  barrierIndex: BarrierIndex;
  barrierPrice: number;
}

const toDisplay = (microUsd: bigint | number): number =>
  Number(microUsd) / PRICE_SCALING;

const toMicro = (displayUsd: number): bigint =>
  BigInt(Math.max(1, Math.round(displayUsd * PRICE_SCALING)));

function seededToTimed(c: SeededCandle, t: number): TimedCandle {
  return {
    t,
    open: toDisplay(c.open),
    high: toDisplay(c.high),
    low: toDisplay(c.low),
    close: toDisplay(c.close),
  };
}

function estimateSegmentMs(segments: ReadonlyArray<SegmentInput>): number {
  if (segments.length < 2) return DEFAULT_SEGMENT_MS;
  const a = segments[segments.length - 2];
  const b = segments[segments.length - 1];
  if (!a || !b) return DEFAULT_SEGMENT_MS;
  const dt = b.recordedAtMs - a.recordedAtMs;
  if (!Number.isFinite(dt)) return DEFAULT_SEGMENT_MS;
  return Math.max(MIN_SEGMENT_MS, Math.min(MAX_SEGMENT_MS, dt));
}

function buildCandles(
  round: RoundInfo | null,
  segments: ReadonlyArray<SegmentInput>,
): TimedCandle[] {
  const home = round?.spotAtRoll ?? 100;
  if (segments.length === 0) {
    const t = Date.now();
    return [{ t, open: home, high: home, low: home, close: home }];
  }

  const segmentMs = estimateSegmentMs(segments);
  const candleMs = segmentMs / CANDLES_PER_SEGMENT;
  const homeMicro = toMicro(home);
  let walkState: WalkState = newWalkState(homeMicro, 1_000_000n, homeMicro);
  const out: TimedCandle[] = [];

  const sorted = [...segments].sort((a, b) =>
    a.k < b.k ? -1 : a.k > b.k ? 1 : 0,
  );
  for (const seg of sorted) {
    const result = expandSegment(walkState, seg.key);
    walkState = result.newState;
    for (let i = 0; i < result.candles.length; i++) {
      const c = result.candles[i];
      if (!c) continue;
      const t =
        seg.recordedAtMs -
        (result.candles.length - 1 - i) * candleMs;
      out.push(seededToTimed(c, t));
    }
  }

  return out.slice(-96);
}

function priceFormat(price: number): string {
  return price.toLocaleString(undefined, {
    minimumFractionDigits: price >= 1000 ? 0 : 2,
    maximumFractionDigits: price >= 1000 ? 0 : 4,
  });
}

export function FastRideStage({
  callbacks,
  phase,
  pickedBarrier,
  round,
  segments,
  inOpenWindow,
  multiplierBps = 20_000,
  stakePerSegmentMicroUsd = 200_000n,
  onPnlChange,
  disabled,
}: FastRideStageProps) {
  const [now, setNow] = useState(() => Date.now());
  const [entry, setEntry] = useState<EntryState | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const pressStartedOpenRef = useRef(false);
  const stallFiredRef = useRef(false);

  useEffect(() => {
    let frame = 0;
    let alive = true;
    const tick = () => {
      if (!alive) return;
      setNow(Date.now());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    stallFiredRef.current = false;
  }, [segments.length]);

  const candles = useMemo(() => buildCandles(round, segments), [round, segments]);
  const latest = candles[candles.length - 1];
  const spot = latest?.close ?? round?.spotAtRoll ?? 100;
  const spotRef = useRef(spot);
  spotRef.current = spot;

  const targetRange = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const c of candles) {
      min = Math.min(min, c.low);
      max = Math.max(max, c.high);
    }
    if (round) {
      min = Math.min(min, round.lowerBarrier);
      max = Math.max(max, round.upperBarrier);
    }
    if (entry) {
      min = Math.min(min, entry.entryPrice, entry.barrierPrice);
      max = Math.max(max, entry.entryPrice, entry.barrierPrice);
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = spot * 0.995;
      max = spot * 1.005;
    }
    const range = Math.max(max - min, Math.max(spot * 0.004, 0.1));
    return {
      min: Math.max(0, min - range * 0.28),
      max: max + range * 0.28,
    };
  }, [candles, entry, round, spot]);

  const [easedRange, setEasedRange] = useState(targetRange);
  useEffect(() => {
    setEasedRange((prev) => ({
      min: prev.min * 0.88 + targetRange.min * 0.12,
      max: prev.max * 0.88 + targetRange.max * 0.12,
    }));
  }, [targetRange]);

  const yFor = useCallback(
    (price: number) =>
      CHART_TOP +
      ((easedRange.max - price) / (easedRange.max - easedRange.min)) * CHART_H,
    [easedRange],
  );

  const xFor = useCallback(
    (t: number) => SPOT_X - ((now - t) / HISTORY_MS) * SPOT_X,
    [now],
  );

  const visibleCandles = useMemo(
    () =>
      candles
        .map((c) => ({ ...c, x: xFor(c.t) }))
        .filter((c) => c.x > -80 && c.x < VIEW_W + 40),
    [candles, xFor],
  );

  const areaPath = useMemo(() => {
    if (visibleCandles.length < 2) return "";
    const parts = visibleCandles.map((c) => `${c.x.toFixed(1)},${yFor(c.close).toFixed(1)}`);
    const first = visibleCandles[0];
    const last = visibleCandles[visibleCandles.length - 1];
    if (!first || !last) return "";
    return `M ${first.x.toFixed(1)},${CHART_BOTTOM} L ${parts.join(" L ")} L ${last.x.toFixed(1)},${CHART_BOTTOM} Z`;
  }, [visibleCandles, yFor]);

  const spotY = yFor(spot);
  const roundProgress = useMemo(() => {
    if (!round) return 0;
    const lastK = segments[segments.length - 1]?.k;
    if (lastK === undefined) return 0;
    const into = Number(lastK - round.startedAtSegment + 1n);
    return Math.max(0, Math.min(1, into / round.roundDurationSegments));
  }, [round, segments]);

  const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (disabled || phase !== "idle" || !round) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const y = ((event.clientY - rect.top) / rect.height) * VIEW_H;
    const barrierIndex = y < VIEW_H / 2 ? BARRIER_UPPER : BARRIER_LOWER;
    const barrierPrice =
      barrierIndex === BARRIER_UPPER ? round.upperBarrier : round.lowerBarrier;

    pressStartedOpenRef.current = false;
    if (!inOpenWindow) return;
    pressStartedOpenRef.current = true;
    setEntry({
      openedAtMs: Date.now(),
      entryPrice: spotRef.current,
      barrierIndex,
      barrierPrice,
    });
    callbacks.onOpen(barrierIndex, barrierPrice);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    if (
      pressStartedOpenRef.current ||
      phase === "opening" ||
      phase === "riding"
    ) {
      callbacks.onClose();
    }
    pressStartedOpenRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  useEffect(() => {
    if (phase === "idle") {
      setEntry(null);
      onPnlChange?.({ pnl: 0, staked: 0 });
    }
  }, [onPnlChange, phase]);

  useEffect(() => {
    if (!entry || (phase !== "opening" && phase !== "riding")) return;
    const id = window.setInterval(() => {
      const heldMs = Math.max(0, Date.now() - entry.openedAtMs);
      const heldSegments = heldMs / estimateSegmentMs(segments);
      const stakePerSegUsd = Number(stakePerSegmentMicroUsd) / PRICE_SCALING;
      const staked = heldSegments * stakePerSegUsd;
      const mult = multiplierBps / 10_000;
      const currentSpot = spotRef.current;
      const denom =
        entry.barrierIndex === BARRIER_UPPER
          ? entry.barrierPrice - entry.entryPrice
          : entry.entryPrice - entry.barrierPrice;
      const rawProgress =
        denom === 0
          ? 0
          : entry.barrierIndex === BARRIER_UPPER
            ? (currentSpot - entry.entryPrice) / denom
            : (entry.entryPrice - currentSpot) / denom;
      const progress = Math.max(-1.2, Math.min(1.05, rawProgress));
      onPnlChange?.({ pnl: staked * (mult - 1) * progress, staked });
    }, 80);
    return () => window.clearInterval(id);
  }, [entry, multiplierBps, onPnlChange, phase, segments, stakePerSegmentMicroUsd]);

  useEffect(() => {
    if (phase !== "opening" && phase !== "riding") return;
    const id = window.setInterval(() => {
      const lastSegment = segments[segments.length - 1];
      if (!lastSegment) return;
      if (Date.now() - lastSegment.recordedAtMs < STALL_THRESHOLD_MS) return;
      if (stallFiredRef.current) return;
      stallFiredRef.current = true;
      callbacks.onStall?.();
    }, 500);
    return () => window.clearInterval(id);
  }, [callbacks, phase, segments]);

  const activeBarrier =
    entry?.barrierIndex ??
    pickedBarrier ??
    (spotY < VIEW_H / 2 ? BARRIER_UPPER : BARRIER_LOWER);

  const renderBarrier = (
    barrierIndex: BarrierIndex,
    price: number,
    label: string,
  ) => {
    const isPicked = pickedBarrier === barrierIndex || activeBarrier === barrierIndex;
    const y = yFor(price);
    const tone =
      barrierIndex === BARRIER_UPPER
        ? "stroke-emerald-400 fill-emerald-400"
        : "stroke-rose-400 fill-rose-400";
    return (
      <g key={label} pointerEvents="none">
        <line
          x1={0}
          x2={VIEW_W}
          y1={y}
          y2={y}
          className={cn(tone, isPicked ? "opacity-80" : "opacity-35")}
          strokeWidth={isPicked ? 2 : 1.2}
          strokeDasharray="8 8"
          vectorEffect="non-scaling-stroke"
        />
        <rect
          x={VIEW_W - 202}
          y={y - 15}
          width={190}
          height={30}
          rx={6}
          className="fill-background/90 stroke-white/10"
          vectorEffect="non-scaling-stroke"
        />
        <text
          x={VIEW_W - 190}
          y={y + 5}
          className={cn("font-mono text-[15px] font-semibold", tone)}
        >
          {label} ${priceFormat(price)}
        </text>
      </g>
    );
  };

  return (
    <div className="absolute inset-0 overflow-hidden bg-background">
      <div className="absolute inset-0 wick-grid-bg opacity-70" />
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className={cn(
          "relative block size-full select-none",
          disabled ? "cursor-default" : "cursor-crosshair",
        )}
        preserveAspectRatio="none"
        role="img"
        aria-label="Live Wick ride chart"
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {Array.from({ length: 8 }).map((_, i) => {
          const y = CHART_TOP + (CHART_H / 8) * i;
          return (
            <line
              key={`h-${i}`}
              x1={0}
              x2={VIEW_W}
              y1={y}
              y2={y}
              className="stroke-white/5"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
        {Array.from({ length: 14 }).map((_, i) => {
          const x = (VIEW_W / 14) * (i + 1);
          return (
            <line
              key={`v-${i}`}
              x1={x}
              x2={x}
              y1={CHART_TOP}
              y2={CHART_BOTTOM}
              className="stroke-white/[0.035]"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}

        {areaPath ? <path d={areaPath} className="fill-white/[0.025]" /> : null}

        {round ? (
          <>
            {renderBarrier(BARRIER_UPPER, round.upperBarrier, "upper")}
            {renderBarrier(BARRIER_LOWER, round.lowerBarrier, "lower")}
          </>
        ) : null}

        {entry ? (
          <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <rect
              x={0}
              y={Math.min(yFor(entry.entryPrice), yFor(entry.barrierPrice))}
              width={SPOT_X}
              height={Math.max(
                3,
                Math.abs(yFor(entry.entryPrice) - yFor(entry.barrierPrice)),
              )}
              className={
                entry.barrierIndex === BARRIER_UPPER
                  ? "fill-emerald-400/10 stroke-emerald-400/35"
                  : "fill-rose-400/10 stroke-rose-400/35"
              }
              strokeDasharray="6 7"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          </motion.g>
        ) : null}

        {visibleCandles.map((c, idx) => {
          const x = c.x;
          const yOpen = yFor(c.open);
          const yClose = yFor(c.close);
          const yHigh = yFor(c.high);
          const yLow = yFor(c.low);
          const up = c.close >= c.open;
          const bodyTop = Math.min(yOpen, yClose);
          const bodyH = Math.max(2, Math.abs(yClose - yOpen));
          const width = 8;
          return (
            <g key={`${c.t}-${idx}`}>
              <line
                x1={x}
                x2={x}
                y1={yHigh}
                y2={yLow}
                className={up ? "stroke-emerald-400/80" : "stroke-zinc-300/70"}
                strokeWidth={1.2}
                vectorEffect="non-scaling-stroke"
              />
              <rect
                x={x - width / 2}
                y={bodyTop}
                width={width}
                height={bodyH}
                rx={2}
                className={
                  up
                    ? "fill-emerald-400 stroke-emerald-300"
                    : "fill-background stroke-zinc-300/80"
                }
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          );
        })}

        <line
          x1={0}
          x2={VIEW_W}
          y1={spotY}
          y2={spotY}
          className="stroke-amber-300/35"
          strokeWidth={1.2}
          strokeDasharray="3 7"
          vectorEffect="non-scaling-stroke"
        />
        <line
          x1={SPOT_X}
          x2={SPOT_X}
          y1={CHART_TOP}
          y2={CHART_BOTTOM}
          className="stroke-amber-300/30"
          strokeWidth={1}
          strokeDasharray="2 8"
          vectorEffect="non-scaling-stroke"
        />
        <circle cx={SPOT_X} cy={spotY} r={7} className="fill-amber-300" />
        <circle cx={SPOT_X} cy={spotY} r={3} className="fill-background" />
        <rect
          x={SPOT_X + 14}
          y={spotY - 16}
          width={118}
          height={32}
          rx={7}
          className="fill-amber-300 stroke-amber-200"
          vectorEffect="non-scaling-stroke"
        />
        <text
          x={SPOT_X + 73}
          y={spotY + 5}
          textAnchor="middle"
          className="fill-background font-mono text-[15px] font-bold"
        >
          ${priceFormat(spot)}
        </text>

        <g pointerEvents="none">
          <rect
            x={32}
            y={VIEW_H - 42}
            width={VIEW_W - 64}
            height={4}
            rx={2}
            className="fill-white/10"
          />
          <rect
            x={32}
            y={VIEW_H - 42}
            width={(VIEW_W - 64) * roundProgress}
            height={4}
            rx={2}
            className={inOpenWindow ? "fill-amber-300" : "fill-white/35"}
          />
        </g>
      </svg>

      <div className="pointer-events-none absolute bottom-[calc(env(safe-area-inset-bottom)+18px)] left-4 hidden rounded-md border border-white/10 bg-background/75 px-3 py-2 font-mono text-[10px] uppercase text-white/45 md:block">
        {inOpenWindow ? "hold upper/lower half to ride" : "barriers locked until next round"}
      </div>
    </div>
  );
}

export default FastRideStage;
