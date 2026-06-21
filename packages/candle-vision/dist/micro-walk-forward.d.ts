import { type MicroBotBacktestResult } from './micro-backtest';
import { type MicroBotCalibrationOptions, type MicroBotCalibrationPreset } from './micro-calibration';
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
export declare function walkForwardMicroBot(candles: readonly CandleInput[], options?: MicroBotWalkForwardOptions): MicroBotWalkForwardResult;
//# sourceMappingURL=micro-walk-forward.d.ts.map