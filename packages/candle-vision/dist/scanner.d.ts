import { type UnifiedCandlePatternOptions } from './detectors';
import { type PatternSignalRankingOptions, type PatternSignalRankingResult, type RankedPatternSignal } from './ranking';
import type { CandleInput, CandlePatternEvent, CandlePatternFamily, CandlePatternStatus } from './types';
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
export declare function computeCandleVisionStats(events: readonly CandlePatternEvent[], ranking: PatternSignalRankingResult): CandleVisionStats;
export declare function scanCandleVision(candles: readonly CandleInput[], options?: CandleVisionScannerOptions): CandleVisionScanResult;
export declare function detectLatestVisiblePatterns(candles: readonly CandleInput[], options?: CandleVisionScannerOptions): CandlePatternEvent[];
export declare function createCandleVisionStream(options?: CandleVisionStreamOptions): CandleVisionStream;
//# sourceMappingURL=scanner.d.ts.map