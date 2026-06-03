import { backtestMicroBot, type MicroBotBacktestOptions, type MicroBotBacktestResult } from './micro-backtest';
import type { MicroBotOptions } from './micro-bot';
import type { TradeDecisionOptions } from './trade-decision';
import type { UnifiedCandlePatternOptions } from './detectors';
import type { CandleInput } from './types';

export type MicroBotCalibrationPreset = {
  id: string;
  label: string;
  description: string;
  detector?: UnifiedCandlePatternOptions;
  decision?: TradeDecisionOptions;
  bot?: MicroBotOptions;
};

export type MicroBotCalibrationRow = {
  preset: MicroBotCalibrationPreset;
  result: MicroBotBacktestResult;
  score: number;
  expectancy: number;
  profitFactor: number;
  totalTrades: number;
  winRate: number;
  pnl: number;
  maxDrawdown: number;
};

export type MicroBotCalibrationOptions = MicroBotBacktestOptions & {
  presets?: readonly MicroBotCalibrationPreset[];
  minTrades?: number;
};

export type MicroBotCalibrationResult = {
  generatedAt: number;
  candles: number;
  minTrades: number;
  best: MicroBotCalibrationRow | null;
  rows: MicroBotCalibrationRow[];
};

export const DEFAULT_MICRO_BOT_PRESETS = [
  {
    id: 'fast-tape',
    label: 'Fast Tape',
    description: 'Fast re-entry profile that still requires confirmed directional tape.',
    decision: { minActionScore: 0.62, minWatchScore: 0.38, recencyWindow: 34, maxWatchBars: 5 },
    bot: {
      minHoldMs: 5000,
      maxHoldMs: 8000,
      cooldownMs: 1200,
      entryThreshold: 0.58,
      flipExitThreshold: 0.48,
      targetRangeMultiple: 0.46,
      stopRangeMultiple: 0.36,
      minPressure: 0.26,
      maxOppositeScore: 0.4,
      requireDecisionConfirmation: true,
      maxTrades: 500,
    },
  },
  {
    id: 'balanced-edge',
    label: 'Balanced Edge',
    description: 'Middle-of-road scalp profile for confirmed live pattern confluence.',
    decision: { minActionScore: 0.66, minWatchScore: 0.42, recencyWindow: 44, maxWatchBars: 7 },
    bot: {
      minHoldMs: 5000,
      maxHoldMs: 10000,
      cooldownMs: 1700,
      entryThreshold: 0.66,
      flipExitThreshold: 0.5,
      targetRangeMultiple: 0.56,
      stopRangeMultiple: 0.42,
      minPressure: 0.3,
      maxOppositeScore: 0.36,
      requireDecisionConfirmation: true,
      maxTrades: 500,
    },
  },
  {
    id: 'confirmation',
    label: 'Confirmation',
    description: 'Waits for stronger evidence and gives trades more room.',
    decision: { minActionScore: 0.72, minWatchScore: 0.48, recencyWindow: 54, maxWatchBars: 8 },
    bot: {
      minHoldMs: 6500,
      maxHoldMs: 10000,
      cooldownMs: 2200,
      entryThreshold: 0.72,
      flipExitThreshold: 0.58,
      targetRangeMultiple: 0.68,
      stopRangeMultiple: 0.48,
      minPressure: 0.36,
      maxOppositeScore: 0.32,
      minDecisionConfidence: 0.64,
      requireDecisionConfirmation: true,
      maxTrades: 500,
    },
  },
  {
    id: 'reversal-hunter',
    label: 'Reversal Hunter',
    description: 'Accepts early reversals only after a confirmed turn and tight invalidation.',
    detector: { minConfidence: 0.52, includeWeak: true, lookback: 180 },
    decision: { minActionScore: 0.64, minWatchScore: 0.4, recencyWindow: 48, maxWatchBars: 7 },
    bot: {
      minHoldMs: 5000,
      maxHoldMs: 9000,
      cooldownMs: 1900,
      entryThreshold: 0.62,
      flipExitThreshold: 0.5,
      targetRangeMultiple: 0.54,
      stopRangeMultiple: 0.34,
      minPressure: 0.28,
      maxOppositeScore: 0.34,
      requireDecisionConfirmation: true,
      maxTrades: 500,
    },
  },
] satisfies readonly MicroBotCalibrationPreset[];

export function calibrateMicroBot(
  candles: readonly CandleInput[],
  options: MicroBotCalibrationOptions = {},
): MicroBotCalibrationResult {
  const presets = options.presets?.length ? options.presets : DEFAULT_MICRO_BOT_PRESETS;
  const minTrades = options.minTrades ?? 4;
  const rows = presets
    .map((preset) => {
      const result = backtestMicroBot(candles, {
        warmupBars: options.warmupBars,
        barMs: options.barMs,
        detector: { ...options.detector, ...preset.detector },
        decision: { ...options.decision, ...preset.decision },
        bot: { ...options.bot, ...preset.bot },
      });
      return rowFromResult(preset, result, minTrades);
    })
    .sort((a, b) => b.score - a.score);

  return {
    generatedAt: Date.now(),
    candles: candles.length,
    minTrades,
    best: rows[0] ?? null,
    rows,
  };
}

function rowFromResult(
  preset: MicroBotCalibrationPreset,
  result: MicroBotBacktestResult,
  minTrades: number,
): MicroBotCalibrationRow {
  const wins = result.trades.filter((trade) => trade.pnl > 0);
  const losses = result.trades.filter((trade) => trade.pnl <= 0);
  const grossWin = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0));
  const totalTrades = result.summary.totalTrades;
  const expectancy = totalTrades === 0 ? 0 : result.summary.pnl / totalTrades;
  const profitFactor = grossLoss === 0 ? (grossWin > 0 ? 99 : 0) : grossWin / grossLoss;
  const activityScore = clamp01(totalTrades / Math.max(1, minTrades));
  const drawdownBase = Math.abs(result.summary.pnl) + result.summary.maxDrawdown + 1;
  const drawdownPenalty = result.summary.maxDrawdown / drawdownBase;
  const pfScore = clamp01(profitFactor / 2.4);
  const expectancyScore = Math.tanh(expectancy * 8) * 0.5 + 0.5;
  const score =
    expectancyScore * 0.42 +
    result.summary.winRate * 0.24 +
    pfScore * 0.2 +
    activityScore * 0.14 -
    drawdownPenalty * 0.18;

  return {
    preset,
    result,
    score: clamp01(score),
    expectancy,
    profitFactor,
    totalTrades,
    winRate: result.summary.winRate,
    pnl: result.summary.pnl,
    maxDrawdown: result.summary.maxDrawdown,
  };
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}
