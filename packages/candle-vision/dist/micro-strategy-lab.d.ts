import { type MicroBotCalibrationOptions, type MicroBotCalibrationResult } from './micro-calibration';
import { type MicroBotWalkForwardOptions, type MicroBotWalkForwardResult } from './micro-walk-forward';
import type { CandleInput } from './types';
export type MicroBotStrategyStatus = 'hot' | 'watch' | 'reject' | 'warming-up';
export type MicroBotStrategyVerdict = {
    status: MicroBotStrategyStatus;
    label: string;
    score: number;
    reasons: string[];
};
export type MicroBotStrategyLabOptions = {
    calibration?: MicroBotCalibrationOptions;
    walkForward?: MicroBotWalkForwardOptions;
    minBars?: number;
    minOutOfSampleTrades?: number;
    hotScore?: number;
    watchScore?: number;
};
export type MicroBotStrategyLabResult = {
    generatedAt: number;
    candles: number;
    verdict: MicroBotStrategyVerdict;
    calibration: MicroBotCalibrationResult;
    walkForward: MicroBotWalkForwardResult | null;
};
export declare function evaluateMicroBotStrategy(candles: readonly CandleInput[], options?: MicroBotStrategyLabOptions): MicroBotStrategyLabResult;
//# sourceMappingURL=micro-strategy-lab.d.ts.map