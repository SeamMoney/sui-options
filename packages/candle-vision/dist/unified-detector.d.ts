import type { CandleInput, CandlePatternDetectorOptions, CandlePatternEvent } from './types';
export declare function detectCandlePatterns(candles: CandleInput[], options?: CandlePatternDetectorOptions): CandlePatternEvent[];
export type UnifiedCandlePatternOptions = CandlePatternDetectorOptions;
export declare function detectExpandedCandlePatterns(candles: CandleInput[], options?: CandlePatternDetectorOptions): CandlePatternEvent[];
export declare function detectUnifiedCandlePatterns(candles: CandleInput[], options?: UnifiedCandlePatternOptions): CandlePatternEvent[];
export declare function detectLatestCandlePatterns(candles: CandleInput[], options?: CandlePatternDetectorOptions): CandlePatternEvent[];
export declare function eventCandleRange(candles: CandleInput[], event: CandlePatternEvent): {
    low: number;
    high: number;
};
//# sourceMappingURL=unified-detector.d.ts.map