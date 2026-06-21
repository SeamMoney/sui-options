import { type MicroBotBacktestOptions, type MicroBotBacktestResult } from './micro-backtest';
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
export declare const DEFAULT_MICRO_BOT_PRESETS: ({
    id: string;
    label: string;
    description: string;
    decision: {
        minActionScore: number;
        minWatchScore: number;
        recencyWindow: number;
        maxWatchBars: number;
    };
    bot: {
        minHoldMs: number;
        maxHoldMs: number;
        cooldownMs: number;
        entryThreshold: number;
        flipExitThreshold: number;
        targetRangeMultiple: number;
        stopRangeMultiple: number;
        minPressure: number;
        maxOppositeScore: number;
        requireDecisionConfirmation: true;
        maxTrades: number;
        minDecisionConfidence?: undefined;
    };
    detector?: undefined;
} | {
    id: string;
    label: string;
    description: string;
    decision: {
        minActionScore: number;
        minWatchScore: number;
        recencyWindow: number;
        maxWatchBars: number;
    };
    bot: {
        minHoldMs: number;
        maxHoldMs: number;
        cooldownMs: number;
        entryThreshold: number;
        flipExitThreshold: number;
        targetRangeMultiple: number;
        stopRangeMultiple: number;
        minPressure: number;
        maxOppositeScore: number;
        minDecisionConfidence: number;
        requireDecisionConfirmation: true;
        maxTrades: number;
    };
    detector?: undefined;
} | {
    id: string;
    label: string;
    description: string;
    detector: {
        minConfidence: number;
        includeWeak: true;
        lookback: number;
    };
    decision: {
        minActionScore: number;
        minWatchScore: number;
        recencyWindow: number;
        maxWatchBars: number;
    };
    bot: {
        minHoldMs: number;
        maxHoldMs: number;
        cooldownMs: number;
        entryThreshold: number;
        flipExitThreshold: number;
        targetRangeMultiple: number;
        stopRangeMultiple: number;
        minPressure: number;
        maxOppositeScore: number;
        requireDecisionConfirmation: true;
        maxTrades: number;
        minDecisionConfidence?: undefined;
    };
})[];
export declare function calibrateMicroBot(candles: readonly CandleInput[], options?: MicroBotCalibrationOptions): MicroBotCalibrationResult;
//# sourceMappingURL=micro-calibration.d.ts.map