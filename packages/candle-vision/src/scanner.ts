import { detectUnifiedCandlePatterns, type UnifiedCandlePatternOptions } from './detectors';
import {
  rankPatternSignals,
  type PatternSignalRankingOptions,
  type PatternSignalRankingResult,
  type RankedPatternSignal,
} from './ranking';
import type {
  CandleDirection,
  CandleInput,
  CandlePatternEvent,
  CandlePatternFamily,
  CandlePatternStatus,
} from './types';

export type CandleVisionScannerOptions = UnifiedCandlePatternOptions & {
  ranking?: PatternSignalRankingOptions;
};

export type CandleVisionStats = {
  total: number;
  visible: number;
  supported: number;
  unsupported: number;
  bullish: number;
  bearish: number;
  neutral: number;
  byFamily: Record<CandlePatternFamily, number>;
  byStatus: Record<CandlePatternStatus, number>;
  averageConfidence: number;
  averageStrength: number;
};

export type CandleVisionScanResult = {
  candles: CandleInput[];
  events: CandlePatternEvent[];
  ranking: PatternSignalRankingResult;
  visibleSignals: RankedPatternSignal[];
  visibleEvents: CandlePatternEvent[];
  latestEvent?: CandlePatternEvent;
  stats: CandleVisionStats;
};

export type CandleVisionStreamOptions = CandleVisionScannerOptions & {
  initialCandles?: readonly CandleInput[];
  maxCandles?: number;
};

export type CandleVisionStream = {
  appendCandle: (candle: CandleInput) => CandleVisionScanResult;
  appendCandles: (candles: readonly CandleInput[]) => CandleVisionScanResult;
  replaceCandles: (candles: readonly CandleInput[]) => CandleVisionScanResult;
  clearCandles: () => CandleVisionScanResult;
  snapshot: () => CandleVisionScanResult;
  getCandles: () => CandleInput[];
};

const EMPTY_FAMILY_COUNTS: Record<CandlePatternFamily, number> = {
  candlestick: 0,
  'vision-candle': 0,
  'chart-setup': 0,
};

const EMPTY_STATUS_COUNTS: Record<CandlePatternStatus, number> = {
  forming: 0,
  confirmed: 0,
  invalidated: 0,
  expired: 0,
};

export function computeCandleVisionStats(
  events: readonly CandlePatternEvent[],
  ranking: PatternSignalRankingResult,
): CandleVisionStats {
  const byFamily = { ...EMPTY_FAMILY_COUNTS };
  const byStatus = { ...EMPTY_STATUS_COUNTS };
  const directions: Record<CandleDirection, number> = {
    bullish: 0,
    bearish: 0,
    neutral: 0,
  };
  let confidenceTotal = 0;
  let strengthTotal = 0;

  for (const event of events) {
    byFamily[event.family] += 1;
    byStatus[event.status] += 1;
    directions[event.direction] += 1;
    confidenceTotal += event.confidence;
    strengthTotal += event.strength;
  }

  return {
    total: events.length,
    visible: ranking.visible.length,
    supported: ranking.supported.length,
    unsupported: ranking.unsupported.length,
    bullish: directions.bullish,
    bearish: directions.bearish,
    neutral: directions.neutral,
    byFamily,
    byStatus,
    averageConfidence: events.length ? confidenceTotal / events.length : 0,
    averageStrength: events.length ? strengthTotal / events.length : 0,
  };
}

export function scanCandleVision(
  candles: readonly CandleInput[],
  options: CandleVisionScannerOptions = {},
): CandleVisionScanResult {
  const { ranking: rankingOptions, ...detectorOptions } = options;
  const candleData = [...candles];
  const events = detectUnifiedCandlePatterns(candleData, detectorOptions);
  const latestIndex = candleData.length > 0 ? candleData.length - 1 : undefined;
  const ranking = rankPatternSignals(events, {
    latestIndex,
    ...rankingOptions,
  });

  return {
    candles: candleData,
    events,
    ranking,
    visibleSignals: ranking.visible,
    visibleEvents: ranking.visible.map((signal) => signal.event),
    latestEvent: events.at(-1),
    stats: computeCandleVisionStats(events, ranking),
  };
}

export function detectLatestVisiblePatterns(
  candles: readonly CandleInput[],
  options: CandleVisionScannerOptions = {},
) {
  const result = scanCandleVision(candles, {
    ...options,
    ranking: {
      minVisibleScore: 0.2,
      recencyWindow: Math.max(8, options.ranking?.recencyWindow ?? 24),
      ...options.ranking,
    },
  });
  const latestIndex = result.candles.length - 1;
  return result.visibleEvents.filter((event) => event.endIndex === latestIndex);
}

export function createCandleVisionStream(options: CandleVisionStreamOptions = {}): CandleVisionStream {
  const { initialCandles = [], maxCandles, ...scannerOptions } = options;
  let candles = trimCandles([...initialCandles], maxCandles);

  const snapshot = () => scanCandleVision(candles, scannerOptions);

  return {
    appendCandle(candle) {
      candles = trimCandles([...candles, candle], maxCandles);
      return snapshot();
    },
    appendCandles(nextCandles) {
      candles = trimCandles([...candles, ...nextCandles], maxCandles);
      return snapshot();
    },
    replaceCandles(nextCandles) {
      candles = trimCandles([...nextCandles], maxCandles);
      return snapshot();
    },
    clearCandles() {
      candles = [];
      return snapshot();
    },
    snapshot,
    getCandles() {
      return [...candles];
    },
  };
}

function trimCandles(candles: CandleInput[], maxCandles?: number) {
  if (!maxCandles || candles.length <= maxCandles) return candles;
  return candles.slice(-maxCandles);
}
