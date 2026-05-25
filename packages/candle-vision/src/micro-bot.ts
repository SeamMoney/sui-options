import type { CandleInput, CandlePatternEvent } from './types';
import type { TradeDecision } from './trade-decision';

export type MicroBotSide = 'long' | 'short';
export type MicroBotStatus = 'flat' | 'armed' | 'in-position' | 'cooldown';
export type MicroBotExitReason = 'time' | 'target' | 'stop' | 'pressure-flip' | 'manual';
export type MicroBotSignalPhase = 'scanning' | 'forming' | 'confirmed' | 'blocked';

export type MicroBotPosition = {
  id: string;
  side: MicroBotSide;
  entryPrice: number;
  markPrice: number;
  entryIndex: number;
  latestIndex: number;
  openedAtMs: number;
  plannedExitAtMs: number;
  targetPrice: number;
  stopPrice: number;
  pnl: number;
  pnlPct: number;
  progress: number;
};

export type MicroBotTrade = MicroBotPosition & {
  exitPrice: number;
  closedAtMs: number;
  exitReason: MicroBotExitReason;
};

export type MicroBotSignal = {
  side: MicroBotSide | 'none';
  phase: MicroBotSignalPhase;
  pressure: number;
  confidence: number;
  entryScore: number;
  momentum: number;
  patternScore: number;
  setupScore: number;
  volumeScore: number;
  oppositeScore: number;
  reasons: string[];
};

export type MicroBotState = {
  enabled: boolean;
  status: MicroBotStatus;
  signal: MicroBotSignal;
  position: MicroBotPosition | null;
  trades: MicroBotTrade[];
  lastTrade?: MicroBotTrade;
  cooldownUntilMs: number;
  stats: {
    totalTrades: number;
    wins: number;
    losses: number;
    pnl: number;
    winRate: number;
  };
};

export type MicroBotOptions = {
  enabled?: boolean;
  minHoldMs?: number;
  maxHoldMs?: number;
  cooldownMs?: number;
  entryThreshold?: number;
  flipExitThreshold?: number;
  targetRangeMultiple?: number;
  stopRangeMultiple?: number;
  maxTrades?: number;
};

type ResolvedMicroBotOptions = Required<MicroBotOptions>;

const DEFAULT_OPTIONS = {
  enabled: true,
  minHoldMs: 5000,
  maxHoldMs: 10000,
  cooldownMs: 1400,
  entryThreshold: 0.66,
  flipExitThreshold: 0.5,
  targetRangeMultiple: 0.85,
  stopRangeMultiple: 0.72,
  maxTrades: 24,
} satisfies ResolvedMicroBotOptions;

const FLAT_SIGNAL: MicroBotSignal = {
  side: 'none',
  phase: 'scanning',
  pressure: 0,
  confidence: 0,
  entryScore: 0,
  momentum: 0,
  patternScore: 0,
  setupScore: 0,
  volumeScore: 0,
  oppositeScore: 0,
  reasons: ['Waiting for confluence'],
};

export function createMicroBotState(options: MicroBotOptions = {}): MicroBotState {
  return {
    enabled: options.enabled ?? DEFAULT_OPTIONS.enabled,
    status: 'flat',
    signal: FLAT_SIGNAL,
    position: null,
    trades: [],
    cooldownUntilMs: 0,
    stats: {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      pnl: 0,
      winRate: 0,
    },
  };
}

export function updateMicroBot(input: {
  state: MicroBotState;
  candles: readonly CandleInput[];
  events: readonly CandlePatternEvent[];
  decision: TradeDecision;
  nowMs: number;
  options?: MicroBotOptions;
}): MicroBotState {
  const options = resolveOptions(input.options);
  const enabled = input.state.enabled && options.enabled;
  const signal = buildMicroBotSignal(input.candles, input.events, input.decision);
  let state: MicroBotState = { ...input.state, enabled, signal };

  if (!enabled || input.candles.length < 7) {
    return { ...state, status: state.position ? 'in-position' : 'flat' };
  }

  const latestIndex = input.candles.length - 1;
  const latest = input.candles[latestIndex];
  if (!latest) return state;

  if (state.position) {
    const marked = markPosition(state.position, latest, latestIndex, input.nowMs);
    const exitReason = shouldExitPosition(marked, signal, input.nowMs, options);
    if (exitReason) return closePosition(state, marked, latest.close, input.nowMs, exitReason, options);
    return { ...state, position: marked, status: 'in-position' };
  }

  if (input.nowMs < state.cooldownUntilMs) {
    return { ...state, status: 'cooldown' };
  }

  if (signal.side === 'none' || signal.phase !== 'confirmed' || signal.entryScore < options.entryThreshold) {
    return { ...state, status: signal.entryScore > options.entryThreshold * 0.78 ? 'armed' : 'flat' };
  }

  return openPosition(state, signal.side, latest, latestIndex, input.nowMs, signal, options, averageRangeFromLatest(input.candles, 18));
}

export function setMicroBotEnabled(state: MicroBotState, enabled: boolean): MicroBotState {
  return {
    ...state,
    enabled,
    status: enabled ? state.status : state.position ? 'in-position' : 'flat',
  };
}

function openPosition(
  state: MicroBotState,
  side: MicroBotSide,
  latest: CandleInput,
  latestIndex: number,
  nowMs: number,
  signal: MicroBotSignal,
  options: ResolvedMicroBotOptions,
  avgRange: number,
): MicroBotState {
  const range = Math.max(0.05, avgRange);
  const direction = side === 'long' ? 1 : -1;
  const holdMs = Math.round(lerp(options.minHoldMs, options.maxHoldMs, clamp01(signal.confidence)));
  const position: MicroBotPosition = {
    id: `micro:${side}:${latest.time}:${Math.round(nowMs)}`,
    side,
    entryPrice: latest.close,
    markPrice: latest.close,
    entryIndex: latestIndex,
    latestIndex,
    openedAtMs: nowMs,
    plannedExitAtMs: nowMs + holdMs,
    targetPrice: latest.close + direction * range * options.targetRangeMultiple,
    stopPrice: latest.close - direction * range * options.stopRangeMultiple,
    pnl: 0,
    pnlPct: 0,
    progress: 0,
  };

  return { ...state, status: 'in-position', position };
}

function closePosition(
  state: MicroBotState,
  position: MicroBotPosition,
  exitPrice: number,
  nowMs: number,
  exitReason: MicroBotExitReason,
  options: ResolvedMicroBotOptions,
): MicroBotState {
  const trade: MicroBotTrade = {
    ...position,
    exitPrice,
    closedAtMs: nowMs,
    exitReason,
  };
  const trades = [trade, ...state.trades].slice(0, options.maxTrades);
  const totalTrades = state.stats.totalTrades + 1;
  const wins = state.stats.wins + (trade.pnl > 0 ? 1 : 0);
  const losses = state.stats.losses + (trade.pnl <= 0 ? 1 : 0);
  const pnl = state.stats.pnl + trade.pnl;
  return {
    ...state,
    status: 'cooldown',
    position: null,
    trades,
    lastTrade: trade,
    cooldownUntilMs: nowMs + options.cooldownMs,
    stats: {
      totalTrades,
      wins,
      losses,
      pnl,
      winRate: totalTrades === 0 ? 0 : wins / totalTrades,
    },
  };
}

function shouldExitPosition(
  position: MicroBotPosition,
  signal: MicroBotSignal,
  nowMs: number,
  options: ResolvedMicroBotOptions,
): MicroBotExitReason | null {
  if (position.side === 'long' && position.markPrice >= position.targetPrice) return 'target';
  if (position.side === 'short' && position.markPrice <= position.targetPrice) return 'target';
  if (position.side === 'long' && position.markPrice <= position.stopPrice) return 'stop';
  if (position.side === 'short' && position.markPrice >= position.stopPrice) return 'stop';
  const heldMs = nowMs - position.openedAtMs;
  if (
    heldMs >= options.minHoldMs &&
    signal.side !== 'none' &&
    signal.side !== position.side &&
    signal.entryScore >= options.flipExitThreshold
  ) {
    return 'pressure-flip';
  }
  if (nowMs >= position.plannedExitAtMs) return 'time';
  return null;
}

function markPosition(
  position: MicroBotPosition,
  latest: CandleInput,
  latestIndex: number,
  nowMs: number,
): MicroBotPosition {
  const direction = position.side === 'long' ? 1 : -1;
  const pnl = (latest.close - position.entryPrice) * direction;
  return {
    ...position,
    markPrice: latest.close,
    latestIndex,
    pnl,
    pnlPct: position.entryPrice === 0 ? 0 : pnl / position.entryPrice,
    progress: clamp01((nowMs - position.openedAtMs) / Math.max(1, position.plannedExitAtMs - position.openedAtMs)),
  };
}

function buildMicroBotSignal(
  candles: readonly CandleInput[],
  events: readonly CandlePatternEvent[],
  decision: TradeDecision,
): MicroBotSignal {
  if (candles.length < 7) return FLAT_SIGNAL;
  const latestIndex = candles.length - 1;
  const recentEvents = events.filter((event) => {
    const age = Math.max(0, latestIndex - event.endIndex);
    return age <= 36 && event.status !== 'expired' && event.status !== 'invalidated' && event.direction !== 'neutral';
  });

  let patternPressure = 0;
  let setupPressure = 0;
  let strongestPattern = '';
  let strongestScore = 0;
  let oppositeScore = 0;
  for (const event of recentEvents) {
    const age = Math.max(0, latestIndex - event.endIndex);
    const direction = event.direction === 'bullish' ? 1 : -1;
    const recency = clamp01(1 - age / 36);
    const status = event.status === 'confirmed' ? 1 : 0.72;
    const familyWeight = event.family === 'chart-setup' ? 1.06 : event.family === 'vision-candle' ? 0.92 : 0.78;
    const score = event.confidence * (0.58 + event.strength * 0.42) * recency * status * familyWeight;
    if (event.family === 'chart-setup') setupPressure += direction * score;
    else patternPressure += direction * score;
    if (score > strongestScore) {
      strongestScore = score;
      strongestPattern = event.label;
    }
  }

  const momentum = momentumPressure(candles);
  const volumeScore = volumeImpulse(candles);
  const decisionPressure =
    decision.side === 'long' ? decision.confidence * 0.8 :
      decision.side === 'short' ? -decision.confidence * 0.8 :
        0;
  const eventMagnitude = Math.abs(patternPressure) + Math.abs(setupPressure);
  const rawPressure = eventMagnitude > 0.05
    ? patternPressure * 0.36 + setupPressure * 0.24 + momentum * 0.28 + decisionPressure * 0.12
    : momentum * 0.65 + decisionPressure * 0.35;
  const pressure = clamp(rawPressure, -1, 1);
  const side: MicroBotSide | 'none' = pressure > 0.1 ? 'long' : pressure < -0.1 ? 'short' : 'none';

  for (const event of recentEvents) {
    const direction = event.direction === 'bullish' ? 1 : -1;
    if ((side === 'long' && direction < 0) || (side === 'short' && direction > 0)) {
      oppositeScore += event.confidence * clamp01(1 - Math.max(0, latestIndex - event.endIndex) / 36);
    }
  }

  const patternScore = clamp01(Math.abs(patternPressure));
  const setupScore = clamp01(Math.abs(setupPressure));
  const momentumScore = clamp01(Math.abs(momentum));
  const entryScore = eventMagnitude > 0.05
    ? clamp01(
      Math.abs(pressure) * 0.36 +
        patternScore * 0.22 +
        setupScore * 0.14 +
        momentumScore * 0.18 +
        volumeScore * 0.1 -
        clamp01(oppositeScore) * 0.18,
    )
    : clamp01(Math.abs(pressure) * 0.42 + momentumScore * 0.4 + volumeScore * 0.18);
  const confidence = clamp01(entryScore * 0.72 + Math.abs(pressure) * 0.28);
  const microBoundaryCrossed =
    decision.status === 'confirmed' ||
    (side === 'long' && pressure > 0.52 && momentum > 0.12) ||
    (side === 'short' && pressure < -0.52 && momentum < -0.12) ||
    (Math.abs(pressure) > 0.72 && entryScore >= 0.42) ||
    (eventMagnitude <= 0.05 && Math.abs(pressure) > 0.28 && entryScore > 0.46);
  const hardConflict =
    !microBoundaryCrossed &&
    entryScore < 0.42 &&
    oppositeScore > Math.max(1.35, eventMagnitude * 2.4);
  const actionTakingShape = entryScore >= 0.34 || Math.abs(pressure) > 0.36 || eventMagnitude > 0.7;
  const phase: MicroBotSignalPhase =
    side === 'none'
      ? 'scanning'
      : microBoundaryCrossed && entryScore >= 0.4
        ? 'confirmed'
        : hardConflict
          ? 'blocked'
          : actionTakingShape
            ? 'forming'
            : 'scanning';
  const reasons = [
    strongestPattern ? `Lead: ${strongestPattern}` : 'Lead: Micro impulse scan',
    phase === 'confirmed' ? 'Trigger boundary crossed' : phase === 'forming' ? 'Setup taking shape' : phase === 'blocked' ? 'Mixed pressure, waiting for cleaner edge' : 'Scanning for setup',
    `${side === 'short' ? 'Sell' : side === 'long' ? 'Buy' : 'Flat'} pressure ${(Math.abs(pressure) * 100).toFixed(0)}%`,
    `Momentum ${(Math.abs(momentum) * 100).toFixed(0)}%`,
    volumeScore > 0.55 ? 'Volume impulse active' : 'Volume normal',
  ];

  return {
    side,
    phase,
    pressure,
    confidence,
    entryScore,
    momentum,
    patternScore,
    setupScore,
    volumeScore,
    oppositeScore: clamp01(oppositeScore),
    reasons,
  };
}

function momentumPressure(candles: readonly CandleInput[]) {
  const latest = candles[candles.length - 1]!;
  const c3 = candles[Math.max(0, candles.length - 4)]!;
  const c8 = candles[Math.max(0, candles.length - 9)]!;
  const c18 = candles[Math.max(0, candles.length - 19)]!;
  const avgRange = averageRangeFromLatest(candles, 18);
  const fast = (latest.close - c3.close) / avgRange;
  const mid = (latest.close - c8.close) / avgRange;
  const slow = (latest.close - c18.close) / avgRange;
  const candlePressure = candles.slice(-8).reduce((sum, bar) => {
    const range = Math.max(0.01, bar.high - bar.low);
    return sum + (bar.close - bar.open) / range;
  }, 0) / Math.min(8, candles.length);
  return clamp(fast * 0.25 + mid * 0.22 + slow * 0.16 + candlePressure * 0.42, -1, 1);
}

function volumeImpulse(candles: readonly CandleInput[]) {
  if (candles.length < 12) return 0.5;
  const latest = candles[candles.length - 1]!;
  const recent = candles.slice(-21, -1).map((bar) => bar.volume ?? 0).filter((value) => value > 0);
  if (!recent.length || latest.volume == null) return 0.5;
  const avg = recent.reduce((sum, value) => sum + value, 0) / recent.length;
  return clamp01((latest.volume / Math.max(1, avg) - 0.72) / 1.35);
}

function averageRangeFromLatest(candles: readonly CandleInput[], count: number) {
  const slice = count <= 0 ? candles : candles.slice(-count);
  if (!slice.length) return 0.1;
  return Math.max(0.1, slice.reduce((sum, bar) => sum + Math.max(0.01, bar.high - bar.low), 0) / slice.length);
}

function resolveOptions(options: MicroBotOptions = {}): ResolvedMicroBotOptions {
  return { ...DEFAULT_OPTIONS, ...options };
}

function clamp01(value: number) {
  return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function lerp(start: number, end: number, t: number) {
  return start + (end - start) * t;
}
