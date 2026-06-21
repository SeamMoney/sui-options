import type { CandleFeature, CandleInput } from './types';
export declare function normalizeCandles(candles: CandleInput[], contextPeriod?: number, trendPeriod?: number): CandleFeature[];
export declare function bodyHigh(bar: CandleInput): number;
export declare function bodyLow(bar: CandleInput): number;
export declare function overlapsBody(a: CandleInput, b: CandleInput): boolean;
export declare function clamp01(value: number): number;
export declare function scoreGreater(value: number, threshold: number, fullAt: number): number;
export declare function scoreLess(value: number, threshold: number, zeroAt: number): number;
//# sourceMappingURL=features.d.ts.map