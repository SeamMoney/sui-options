import { backtestMicroBot, type MicroBotBacktestOptions, type MicroBotBacktestResult } from './micro-backtest';
import {
  DEFAULT_MICRO_BOT_PRESETS,
  calibrateMicroBot,
  type MicroBotCalibrationOptions,
  type MicroBotCalibrationPreset,
} from './micro-calibration';
import type { CandleInput } from './types';

export type MicroBotWalkForwardFold = {
  index: number;
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
  preset: MicroBotCalibrationPreset;
  trainScore: number;
  trainPnl: number;
  test: MicroBotBacktestResult;
  testExpectancy: number;
  efficiency: number;
};

export type MicroBotWalkForwardOptions = Omit<MicroBotCalibrationOptions, 'presets'> & {
  presets?: readonly MicroBotCalibrationPreset[];
  trainBars?: number;
  testBars?: number;
  stepBars?: number;
};

export type MicroBotWalkForwardResult = {
  generatedAt: number;
  candles: number;
  trainBars: number;
  testBars: number;
  stepBars: number;
  folds: MicroBotWalkForwardFold[];
  summary: {
    totalTrades: number;
    wins: number;
    losses: number;
    pnl: number;
    winRate: number;
    averagePnl: number;
    maxDrawdown: number;
    positiveFolds: number;
    stability: number;
    bestPresetId: string | null;
    bestPresetLabel: string | null;
  };
};

export function walkForwardMicroBot(
  candles: readonly CandleInput[],
  options: MicroBotWalkForwardOptions = {},
): MicroBotWalkForwardResult {
  const trainBars = options.trainBars ?? 90;
  const testBars = options.testBars ?? 30;
  const stepBars = options.stepBars ?? testBars;
  const warmupBars = options.warmupBars ?? 24;
  const presets = options.presets?.length ? options.presets : DEFAULT_MICRO_BOT_PRESETS;
  const folds: MicroBotWalkForwardFold[] = [];

  for (let trainStart = 0, foldIndex = 0; trainStart + trainBars + Math.max(8, testBars) <= candles.length; trainStart += stepBars, foldIndex += 1) {
    const trainEnd = trainStart + trainBars;
    const testStart = trainEnd;
    const testEnd = Math.min(candles.length, testStart + testBars);
    const trainSample = candles.slice(trainStart, trainEnd);
    const calibration = calibrateMicroBot(trainSample, {
      ...options,
      warmupBars,
      presets,
    });
    if (!calibration.best) continue;

    const contextStart = Math.max(0, testStart - warmupBars);
    const context = candles.slice(contextStart, testEnd);
    const testWarmupBars = Math.max(6, testStart - contextStart);
    const test = backtestPreset(context, calibration.best.preset, {
      ...options,
      warmupBars: testWarmupBars,
    });
    const testExpectancy = test.summary.totalTrades === 0 ? 0 : test.summary.pnl / test.summary.totalTrades;
    const trainExpectancy = calibration.best.expectancy;
    const efficiency = trainExpectancy <= 0 ? (testExpectancy > 0 ? 1 : 0) : clamp01(testExpectancy / trainExpectancy);

    folds.push({
      index: foldIndex,
      trainStart,
      trainEnd,
      testStart,
      testEnd,
      preset: calibration.best.preset,
      trainScore: calibration.best.score,
      trainPnl: calibration.best.pnl,
      test,
      testExpectancy,
      efficiency,
    });
  }

  return {
    generatedAt: Date.now(),
    candles: candles.length,
    trainBars,
    testBars,
    stepBars,
    folds,
    summary: summarizeFolds(folds),
  };
}

function backtestPreset(
  candles: readonly CandleInput[],
  preset: MicroBotCalibrationPreset,
  options: MicroBotBacktestOptions,
) {
  return backtestMicroBot(candles, {
    warmupBars: options.warmupBars,
    barMs: options.barMs,
    detector: preset.detector,
    decision: preset.decision,
    bot: preset.bot,
  });
}

function summarizeFolds(folds: readonly MicroBotWalkForwardFold[]): MicroBotWalkForwardResult['summary'] {
  const trades = folds.flatMap((fold) => fold.test.trades);
  const totalTrades = trades.length;
  const wins = trades.filter((trade) => trade.pnl > 0).length;
  const losses = totalTrades - wins;
  const pnl = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  const averagePnl = totalTrades === 0 ? 0 : pnl / totalTrades;
  let running = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of trades) {
    running += trade.pnl;
    peak = Math.max(peak, running);
    maxDrawdown = Math.max(maxDrawdown, peak - running);
  }
  const positiveFolds = folds.filter((fold) => fold.test.summary.pnl > 0).length;
  const presetCounts = new Map<string, { preset: MicroBotCalibrationPreset; count: number }>();
  for (const fold of folds) {
    const entry = presetCounts.get(fold.preset.id) ?? { preset: fold.preset, count: 0 };
    entry.count += 1;
    presetCounts.set(fold.preset.id, entry);
  }
  const bestPreset = Array.from(presetCounts.values()).sort((a, b) => b.count - a.count)[0]?.preset ?? null;

  return {
    totalTrades,
    wins,
    losses,
    pnl,
    winRate: totalTrades === 0 ? 0 : wins / totalTrades,
    averagePnl,
    maxDrawdown,
    positiveFolds,
    stability: folds.length === 0 ? 0 : positiveFolds / folds.length,
    bestPresetId: bestPreset?.id ?? null,
    bestPresetLabel: bestPreset?.label ?? null,
  };
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}
