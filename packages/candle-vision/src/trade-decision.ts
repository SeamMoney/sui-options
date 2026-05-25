import { clamp01, normalizeCandles } from './features';
import { rankPatternSignals, type PatternSignalRankingOptions, type PatternSignalRankingResult, type RankedPatternSignal } from './ranking';
import type { CandleDirection, CandleInput, CandlePatternEvent } from './types';

export type TradeDecisionAction = 'buy' | 'sell' | 'hold';
export type TradeDecisionSide = 'long' | 'short' | 'none';
export type TradeDecisionStatus = 'confirmed' | 'watching' | 'denied' | 'invalidated' | 'expired' | 'no-signal';

export type TradeDecisionReasonCode =
  | 'no_ranked_signal'
  | 'insufficient_data'
  | 'unsupported_pattern'
  | 'neutral_signal'
  | 'stale_signal'
  | 'watch_expired'
  | 'pattern_forming'
  | 'pattern_confirmed'
  | 'breakout_confirmed'
  | 'breakdown_confirmed'
  | 'volume_confirmed'
  | 'volume_below_threshold'
  | 'risk_defined'
  | 'risk_too_wide'
  | 'confluence_same_direction'
  | 'confluence_mixed'
  | 'opposing_signal'
  | 'close_through_stop'
  | 'low_decision_score';

export type TradeDecisionReason = {
  code: TradeDecisionReasonCode;
  label: string;
  weight: number;
  polarity: 'confirm' | 'deny' | 'info';
};

export type TradeDecisionLevel = {
  price: number;
  index: number;
  time: number;
  role: 'entry' | 'stop' | 'invalidation' | 'target';
  source: 'anchor' | 'candle-range' | 'latest-close' | 'risk-multiple';
};

export type TradeDecisionScoreBreakdown = {
  pattern: number;
  ranking: number;
  recency: number;
  confluence: number;
  volume: number;
  risk: number;
  total: number;
};

export type TradeDecision = {
  id: string;
  action: TradeDecisionAction;
  side: TradeDecisionSide;
  status: TradeDecisionStatus;
  confidence: number;
  score: number;
  label: string;
  reasons: TradeDecisionReason[];
  primarySignal?: RankedPatternSignal;
  confirmingSignals: RankedPatternSignal[];
  denyingSignals: RankedPatternSignal[];
  entry?: TradeDecisionLevel;
  stop?: TradeDecisionLevel;
  invalidation?: TradeDecisionLevel;
  targets: TradeDecisionLevel[];
  scoreBreakdown: TradeDecisionScoreBreakdown;
  latestIndex: number;
  createdAt: number;
};

export type TradeDecisionOptions = {
  latestIndex?: number;
  minActionScore?: number;
  minWatchScore?: number;
  recencyWindow?: number;
  maxWatchBars?: number;
  oppositionDenyRatio?: number;
  minVolumeRatio?: number;
  requireVolumeConfirmation?: boolean;
  maxRiskRangeRatio?: number;
  maxConfirmingSignals?: number;
  ranking?: PatternSignalRankingOptions;
};

export type TradeDecisionResult = {
  decision: TradeDecision;
  decisions: TradeDecision[];
  ranking: PatternSignalRankingResult;
};

type ResolvedTradeDecisionOptions = Required<Omit<TradeDecisionOptions, 'latestIndex' | 'maxRiskRangeRatio' | 'ranking'>> & {
  latestIndex: number;
  maxRiskRangeRatio?: number;
  ranking?: PatternSignalRankingOptions;
};

const DEFAULT_OPTIONS = {
  minActionScore: 0.68,
  minWatchScore: 0.45,
  recencyWindow: 48,
  maxWatchBars: 7,
  oppositionDenyRatio: 0.85,
  minVolumeRatio: 0.92,
  requireVolumeConfirmation: false,
  maxConfirmingSignals: 4,
} satisfies Omit<ResolvedTradeDecisionOptions, 'latestIndex' | 'maxRiskRangeRatio' | 'ranking'>;

const EMPTY_BREAKDOWN: TradeDecisionScoreBreakdown = {
  pattern: 0,
  ranking: 0,
  recency: 0,
  confluence: 0,
  volume: 0,
  risk: 0,
  total: 0,
};

export function decideTradeFromEvents(
  events: readonly CandlePatternEvent[],
  candles: readonly CandleInput[],
  options: TradeDecisionOptions = {},
): TradeDecisionResult {
  const latestIndex = resolveLatestIndex(candles, options.latestIndex);
  const ranking = rankPatternSignals([...events], {
    latestIndex,
    maxVisible: Math.max(24, events.length),
    minVisibleScore: 0,
    allowOverlaps: true,
    perKindLimit: 99,
    perFamilyLimit: 99,
    ...options.ranking,
  });

  return decideTradeFromSignals(ranking.raw, candles, { ...options, latestIndex, ranking: options.ranking });
}

export function decideTradeFromSignals(
  signals: readonly RankedPatternSignal[],
  candles: readonly CandleInput[],
  options: TradeDecisionOptions = {},
): TradeDecisionResult {
  const latestIndex = resolveLatestIndex(candles, options.latestIndex);
  const resolved = resolveTradeDecisionOptions(options, latestIndex);
  const ranking = rankingFromSignals(signals);
  const ranked = signals
    .filter((signal) => signal.supported)
    .slice()
    .sort((a, b) => decisionPriority(b, latestIndex) - decisionPriority(a, latestIndex));

  if (!candles.length || latestIndex < 0) {
    return withDecision(noSignalDecision('insufficient_data', latestIndex, candles), [], ranking);
  }

  const decisions = ranked
    .map((signal) => buildDecision(signal, ranked, candles, resolved))
    .filter((decision) => decision.status !== 'no-signal')
    .sort(compareDecisions);

  if (!decisions.length) {
    return withDecision(noSignalDecision('no_ranked_signal', latestIndex, candles), decisions, ranking);
  }

  return withDecision(decisions[0]!, decisions, ranking);
}

function buildDecision(
  primary: RankedPatternSignal,
  allSignals: RankedPatternSignal[],
  candles: readonly CandleInput[],
  options: ResolvedTradeDecisionOptions,
): TradeDecision {
  const event = primary.event;
  const latest = candles[options.latestIndex] ?? candles[candles.length - 1]!;
  const age = Math.max(0, options.latestIndex - event.endIndex);
  const side = sideForDirection(event.direction);
  const actionForSide: TradeDecisionAction = side === 'long' ? 'buy' : side === 'short' ? 'sell' : 'hold';
  const createdAt = latest.time;

  if (!primary.supported) {
    return baseDecision(primary, options, createdAt, {
      status: 'denied',
      action: 'hold',
      side,
      reasons: [reason('unsupported_pattern', 'Unsupported pattern', -18, 'deny')],
    });
  }

  if (event.direction === 'neutral' || side === 'none') {
    return baseDecision(primary, options, createdAt, {
      status: 'no-signal',
      action: 'hold',
      side: 'none',
      reasons: [reason('neutral_signal', 'Neutral signal', 0, 'info')],
    });
  }

  const range = eventRange(candles, event);
  const confirmation = confirmationPrice(candles, event, side, range);
  const invalidation = invalidationPrice(candles, event, side, range);
  const entry = level(latest.close, options.latestIndex, latest.time, 'entry', 'latest-close');
  const stop = level(invalidation, options.latestIndex, latest.time, 'stop', 'anchor');
  const invalidationLevel = level(invalidation, options.latestIndex, latest.time, 'invalidation', 'anchor');
  const risk = Math.abs(entry.price - stop.price);
  const avgRange = averageRange(candles, Math.max(0, options.latestIndex - 20), options.latestIndex);
  const riskRatio = avgRange > 0 ? risk / avgRange : 1;
  const volumeRatio = volumeRatioAt(candles, options.latestIndex);
  const recentScore = clamp01(1 - age / Math.max(1, options.recencyWindow));
  const confirmingSignals = sameDirectionSignals(primary, allSignals, options);
  const denyingSignals = oppositeDirectionSignals(primary, allSignals, options);
  const confluenceScore = confluenceFromSignals(confirmingSignals);
  const volumeScore = clamp01((volumeRatio - 0.72) / 0.72);
  const riskScore = options.maxRiskRangeRatio == null
    ? clamp01(1 - Math.max(0, riskRatio - 1.8) / 4)
    : clamp01(1 - Math.max(0, riskRatio - options.maxRiskRangeRatio) / Math.max(1, options.maxRiskRangeRatio));
  const scoreBreakdown: TradeDecisionScoreBreakdown = {
    pattern: clamp01(event.confidence * 0.62 + event.strength * 0.38),
    ranking: clamp01(primary.visibleScore * 0.66 + primary.rawScore * 0.34),
    recency: recentScore,
    confluence: confluenceScore,
    volume: volumeScore,
    risk: riskScore,
    total: 0,
  };
  scoreBreakdown.total = clamp01(
    scoreBreakdown.pattern * 0.3 +
      scoreBreakdown.ranking * 0.24 +
      scoreBreakdown.recency * 0.16 +
      scoreBreakdown.confluence * 0.14 +
      scoreBreakdown.volume * 0.08 +
      scoreBreakdown.risk * 0.08,
  );

  const reasons: TradeDecisionReason[] = [
    reason(event.status === 'forming' ? 'pattern_forming' : 'pattern_confirmed', event.status === 'forming' ? 'Pattern forming' : 'Pattern confirmed', 16, 'confirm'),
    reason('risk_defined', 'Risk defined', Math.round(scoreBreakdown.risk * 14), 'confirm'),
  ];
  if (confirmingSignals.length) reasons.push(reason('confluence_same_direction', 'Confluence aligned', Math.round(confluenceScore * 18), 'confirm'));
  if (volumeRatio >= options.minVolumeRatio) reasons.push(reason('volume_confirmed', 'Volume confirmed', Math.round(volumeScore * 12), 'confirm'));

  const closeThroughStop = side === 'long' ? latest.close <= stop.price : latest.close >= stop.price;
  const priceConfirmed = side === 'long' ? latest.close >= confirmation : latest.close <= confirmation;
  if (event.status === 'invalidated' || closeThroughStop) {
    reasons.push(reason('close_through_stop', 'Close through stop', -30, 'deny'));
    return decisionFromParts(primary, options, createdAt, {
      action: 'hold',
      side,
      status: 'invalidated',
      scoreBreakdown,
      confidence: scoreBreakdown.total,
      reasons,
      confirmingSignals,
      denyingSignals,
      entry,
      stop,
      invalidation: invalidationLevel,
      targets: [],
    });
  }

  if (event.status === 'expired' || age > options.recencyWindow || (!priceConfirmed && age > options.maxWatchBars)) {
    reasons.push(reason(age > options.maxWatchBars ? 'watch_expired' : 'stale_signal', age > options.maxWatchBars ? 'Watch expired' : 'Stale signal', -18, 'deny'));
    return decisionFromParts(primary, options, createdAt, {
      action: 'hold',
      side,
      status: 'expired',
      scoreBreakdown,
      confidence: scoreBreakdown.total,
      reasons,
      confirmingSignals,
      denyingSignals,
      entry,
      stop,
      invalidation: invalidationLevel,
      targets: [],
    });
  }

  if (denyingSignals.length && denyingSignals[0]!.visibleScore >= primary.visibleScore * options.oppositionDenyRatio) {
    reasons.push(reason('opposing_signal', 'Opposing signal', -22, 'deny'));
    reasons.push(reason('confluence_mixed', 'Mixed confluence', -10, 'deny'));
    return decisionFromParts(primary, options, createdAt, {
      action: 'hold',
      side,
      status: 'denied',
      scoreBreakdown,
      confidence: scoreBreakdown.total,
      reasons,
      confirmingSignals,
      denyingSignals,
      entry,
      stop,
      invalidation: invalidationLevel,
      targets: [],
    });
  }

  if (options.maxRiskRangeRatio != null && riskRatio > options.maxRiskRangeRatio) {
    reasons.push(reason('risk_too_wide', 'Risk too wide', -16, 'deny'));
    return decisionFromParts(primary, options, createdAt, {
      action: 'hold',
      side,
      status: 'denied',
      scoreBreakdown,
      confidence: scoreBreakdown.total,
      reasons,
      confirmingSignals,
      denyingSignals,
      entry,
      stop,
      invalidation: invalidationLevel,
      targets: [],
    });
  }

  const volumeDenied = options.requireVolumeConfirmation && priceConfirmed && volumeRatio < options.minVolumeRatio;
  if (volumeDenied) {
    reasons.push(reason('volume_below_threshold', 'Volume below threshold', -18, 'deny'));
    return decisionFromParts(primary, options, createdAt, {
      action: 'hold',
      side,
      status: 'denied',
      scoreBreakdown,
      confidence: scoreBreakdown.total,
      reasons,
      confirmingSignals,
      denyingSignals,
      entry,
      stop,
      invalidation: invalidationLevel,
      targets: [],
    });
  }

  if (priceConfirmed && scoreBreakdown.total >= options.minActionScore) {
    reasons.push(reason(side === 'long' ? 'breakout_confirmed' : 'breakdown_confirmed', side === 'long' ? 'Breakout confirmed' : 'Breakdown confirmed', 20, 'confirm'));
    return decisionFromParts(primary, options, createdAt, {
      action: actionForSide,
      side,
      status: 'confirmed',
      scoreBreakdown,
      confidence: scoreBreakdown.total,
      reasons,
      confirmingSignals,
      denyingSignals,
      entry,
      stop,
      invalidation: invalidationLevel,
      targets: targetsFor(entry, stop, side),
    });
  }

  if (scoreBreakdown.total < options.minWatchScore) {
    reasons.push(reason('low_decision_score', 'Low decision score', -14, 'deny'));
    return decisionFromParts(primary, options, createdAt, {
      action: 'hold',
      side,
      status: 'denied',
      scoreBreakdown,
      confidence: scoreBreakdown.total,
      reasons,
      confirmingSignals,
      denyingSignals,
      entry,
      stop,
      invalidation: invalidationLevel,
      targets: [],
    });
  }

  return decisionFromParts(primary, options, createdAt, {
    action: 'hold',
    side,
    status: 'watching',
    scoreBreakdown,
    confidence: scoreBreakdown.total,
    reasons,
    confirmingSignals,
    denyingSignals,
    entry: level(confirmation, event.endIndex, candles[event.endIndex]?.time ?? latest.time, 'entry', 'anchor'),
    stop,
    invalidation: invalidationLevel,
    targets: targetsFor(level(confirmation, event.endIndex, candles[event.endIndex]?.time ?? latest.time, 'entry', 'anchor'), stop, side),
  });
}

function decisionFromParts(
  primary: RankedPatternSignal,
  options: ResolvedTradeDecisionOptions,
  createdAt: number,
  parts: {
    action: TradeDecisionAction;
    side: TradeDecisionSide;
    status: TradeDecisionStatus;
    scoreBreakdown: TradeDecisionScoreBreakdown;
    confidence: number;
    reasons: TradeDecisionReason[];
    confirmingSignals: RankedPatternSignal[];
    denyingSignals: RankedPatternSignal[];
    entry?: TradeDecisionLevel;
    stop?: TradeDecisionLevel;
    invalidation?: TradeDecisionLevel;
    targets: TradeDecisionLevel[];
  },
): TradeDecision {
  return {
    id: `decision:${primary.event.id}:${options.latestIndex}`,
    label: decisionLabel(parts.action, parts.status, parts.side),
    primarySignal: primary,
    latestIndex: options.latestIndex,
    createdAt,
    score: parts.scoreBreakdown.total,
    ...parts,
  };
}

function baseDecision(
  primary: RankedPatternSignal,
  options: ResolvedTradeDecisionOptions,
  createdAt: number,
  parts: {
    action: TradeDecisionAction;
    side: TradeDecisionSide;
    status: TradeDecisionStatus;
    reasons: TradeDecisionReason[];
  },
): TradeDecision {
  return {
    id: `decision:${primary.event.id}:${options.latestIndex}`,
    action: parts.action,
    side: parts.side,
    status: parts.status,
    confidence: 0,
    score: 0,
    label: decisionLabel(parts.action, parts.status, parts.side),
    reasons: parts.reasons,
    primarySignal: primary,
    confirmingSignals: [],
    denyingSignals: [],
    targets: [],
    scoreBreakdown: EMPTY_BREAKDOWN,
    latestIndex: options.latestIndex,
    createdAt,
  };
}

function noSignalDecision(code: Extract<TradeDecisionReasonCode, 'no_ranked_signal' | 'insufficient_data'>, latestIndex: number, candles: readonly CandleInput[]): TradeDecision {
  const latest = candles[latestIndex] ?? candles[candles.length - 1];
  return {
    id: `decision:none:${latestIndex}`,
    action: 'hold',
    side: 'none',
    status: 'no-signal',
    confidence: 0,
    score: 0,
    label: 'No trade',
    reasons: [reason(code, code === 'insufficient_data' ? 'Insufficient data' : 'No ranked signal', 0, 'info')],
    confirmingSignals: [],
    denyingSignals: [],
    targets: [],
    scoreBreakdown: EMPTY_BREAKDOWN,
    latestIndex,
    createdAt: latest?.time ?? Date.now(),
  };
}

function withDecision(decision: TradeDecision, decisions: TradeDecision[], ranking: PatternSignalRankingResult): TradeDecisionResult {
  return { decision, decisions, ranking };
}

function resolveTradeDecisionOptions(options: TradeDecisionOptions, latestIndex: number): ResolvedTradeDecisionOptions {
  return {
    ...DEFAULT_OPTIONS,
    ...options,
    latestIndex,
  };
}

function resolveLatestIndex(candles: readonly CandleInput[], latestIndex?: number) {
  if (latestIndex == null) return candles.length - 1;
  return Math.max(0, Math.min(candles.length - 1, latestIndex));
}

function rankingFromSignals(signals: readonly RankedPatternSignal[]): PatternSignalRankingResult {
  const raw = [...signals];
  return {
    raw,
    supported: raw.filter((signal) => signal.supported),
    unsupported: raw.filter((signal) => !signal.supported),
    visible: raw.filter((signal) => signal.visible),
  };
}

function decisionPriority(signal: RankedPatternSignal, latestIndex: number) {
  const age = Math.max(0, latestIndex - signal.event.endIndex);
  const recency = clamp01(1 - age / 64);
  const directional = signal.event.direction === 'neutral' ? -0.18 : 0;
  const status = signal.event.status === 'confirmed' ? 0.08 : signal.event.status === 'forming' ? 0.02 : -0.32;
  return signal.visibleScore * 0.48 + signal.rawScore * 0.28 + signal.event.confidence * 0.14 + recency * 0.1 + directional + status;
}

function compareDecisions(a: TradeDecision, b: TradeDecision) {
  const statusA = statusPriority(a.status);
  const statusB = statusPriority(b.status);
  if (statusA !== statusB) return statusB - statusA;
  return b.score - a.score || b.confidence - a.confidence || b.latestIndex - a.latestIndex;
}

function statusPriority(status: TradeDecisionStatus) {
  switch (status) {
    case 'confirmed':
      return 5;
    case 'watching':
      return 4;
    case 'denied':
      return 3;
    case 'invalidated':
      return 2;
    case 'expired':
      return 1;
    case 'no-signal':
      return 0;
  }
}

function sideForDirection(direction: CandleDirection): TradeDecisionSide {
  if (direction === 'bullish') return 'long';
  if (direction === 'bearish') return 'short';
  return 'none';
}

function eventRange(candles: readonly CandleInput[], event: CandlePatternEvent) {
  const start = Math.max(0, Math.min(candles.length - 1, event.startIndex));
  const end = Math.max(start, Math.min(candles.length - 1, event.endIndex));
  const slice = candles.slice(start, end + 1);
  return {
    high: Math.max(...slice.map((bar) => bar.high)),
    low: Math.min(...slice.map((bar) => bar.low)),
    start,
    end,
  };
}

function confirmationPrice(candles: readonly CandleInput[], event: CandlePatternEvent, side: TradeDecisionSide, range: ReturnType<typeof eventRange>) {
  const anchor = event.anchors.find((item) => item.role === 'confirmation');
  if (anchor) return anchor.price;
  return side === 'long' ? range.high : candles[event.endIndex]?.low ?? range.low;
}

function invalidationPrice(candles: readonly CandleInput[], event: CandlePatternEvent, side: TradeDecisionSide, range: ReturnType<typeof eventRange>) {
  const anchor = event.anchors.find((item) => item.role === 'invalidation');
  if (anchor) return anchor.price;
  return side === 'long' ? range.low : candles[event.endIndex]?.high ?? range.high;
}

function level(price: number, index: number, time: number, role: TradeDecisionLevel['role'], source: TradeDecisionLevel['source']): TradeDecisionLevel {
  return { price, index, time, role, source };
}

function targetsFor(entry: TradeDecisionLevel, stop: TradeDecisionLevel, side: TradeDecisionSide): TradeDecisionLevel[] {
  if (side === 'none') return [];
  const risk = Math.abs(entry.price - stop.price);
  if (!Number.isFinite(risk) || risk <= 0) return [];
  const direction = side === 'long' ? 1 : -1;
  return [1, 2, 3].map((multiple) => level(entry.price + direction * risk * multiple, entry.index, entry.time, 'target', 'risk-multiple'));
}

function sameDirectionSignals(primary: RankedPatternSignal, allSignals: RankedPatternSignal[], options: ResolvedTradeDecisionOptions) {
  const families = new Set<string>();
  const results: RankedPatternSignal[] = [];
  for (const signal of allSignals) {
    if (signal.event.id === primary.event.id) continue;
    if (!signal.supported) continue;
    if (signal.event.direction !== primary.event.direction) continue;
    if (signal.event.status === 'invalidated' || signal.event.status === 'expired') continue;
    if (!nearEnough(primary.event, signal.event, options.recencyWindow)) continue;
    const key = `${signal.event.family}:${signal.event.kind}`;
    if (families.has(key)) continue;
    families.add(key);
    results.push(signal);
    if (results.length >= options.maxConfirmingSignals) break;
  }
  return results.sort((a, b) => b.visibleScore - a.visibleScore || b.event.confidence - a.event.confidence);
}

function oppositeDirectionSignals(primary: RankedPatternSignal, allSignals: RankedPatternSignal[], options: ResolvedTradeDecisionOptions) {
  return allSignals
    .filter((signal) => {
      if (signal.event.id === primary.event.id) return false;
      if (!signal.supported) return false;
      if (signal.event.direction === 'neutral' || signal.event.direction === primary.event.direction) return false;
      if (signal.event.status === 'invalidated' || signal.event.status === 'expired') return false;
      return nearEnough(primary.event, signal.event, options.recencyWindow);
    })
    .sort((a, b) => b.visibleScore - a.visibleScore || b.event.confidence - a.event.confidence);
}

function nearEnough(a: CandlePatternEvent, b: CandlePatternEvent, window: number) {
  const overlap = a.startIndex <= b.endIndex && b.startIndex <= a.endIndex;
  const distance = Math.min(Math.abs(a.endIndex - b.endIndex), Math.abs(a.startIndex - b.startIndex));
  return overlap || distance <= Math.max(2, window);
}

function confluenceFromSignals(signals: RankedPatternSignal[]) {
  const families = new Set(signals.map((signal) => signal.event.family));
  const familyScore = clamp01(families.size / 3);
  const signalScore = clamp01(signals.reduce((sum, signal) => sum + signal.visibleScore, 0) / Math.max(1, signals.length));
  return clamp01(familyScore * 0.45 + signalScore * 0.55);
}

function volumeRatioAt(candles: readonly CandleInput[], index: number) {
  const features = normalizeCandles([...candles], 20, 12);
  return features[index]?.volumeRatio ?? 1;
}

function averageRange(candles: readonly CandleInput[], start: number, end: number) {
  const slice = candles.slice(start, end + 1);
  if (!slice.length) return 0;
  return slice.reduce((sum, bar) => sum + Math.max(0, bar.high - bar.low), 0) / slice.length;
}

function reason(code: TradeDecisionReasonCode, label: string, weight: number, polarity: TradeDecisionReason['polarity']): TradeDecisionReason {
  return { code, label, weight, polarity };
}

function decisionLabel(action: TradeDecisionAction, status: TradeDecisionStatus, side: TradeDecisionSide) {
  if (status === 'no-signal') return 'No trade';
  if (status === 'invalidated') return side === 'short' ? 'Sell invalidated' : side === 'long' ? 'Buy invalidated' : 'Invalidated';
  if (status === 'expired') return side === 'short' ? 'Sell expired' : side === 'long' ? 'Buy expired' : 'Expired';
  if (status === 'denied') return side === 'short' ? 'Sell denied' : side === 'long' ? 'Buy denied' : 'Denied';
  if (status === 'watching') return side === 'short' ? 'Sell watch' : side === 'long' ? 'Buy watch' : 'Wait';
  if (action === 'buy') return 'Buy confirmed';
  if (action === 'sell') return 'Sell confirmed';
  return 'Hold';
}
