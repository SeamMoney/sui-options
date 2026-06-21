import type { CandleInput } from '../../types';
export type IndicatorValue = number | null;
export type BollingerBandPoint = {
    middle: IndicatorValue;
    upper: IndicatorValue;
    lower: IndicatorValue;
    width: IndicatorValue;
};
export type MacdPoint = {
    macd: IndicatorValue;
    signal: IndicatorValue;
    histogram: IndicatorValue;
};
export declare function closes(candles: CandleInput[]): number[];
export declare function hasUsableVolume(candles: CandleInput[]): boolean;
export declare function sma(candles: CandleInput[], period?: number): IndicatorValue[];
export declare function ema(candles: CandleInput[], period?: number): IndicatorValue[];
export declare function emaValues(values: IndicatorValue[], period?: number): IndicatorValue[];
export declare function rsi(candles: CandleInput[], period?: number): IndicatorValue[];
export declare function macd(candles: CandleInput[], fastPeriod?: number, slowPeriod?: number, signalPeriod?: number): MacdPoint[];
export declare function bollingerBands(candles: CandleInput[], period?: number, multiplier?: number): BollingerBandPoint[];
export declare function trueRange(candles: CandleInput[]): number[];
export declare function atr(candles: CandleInput[], period?: number): IndicatorValue[];
export declare function vwap(candles: CandleInput[], period?: number): IndicatorValue[];
export declare function rollingVolumeAverage(candles: CandleInput[], period?: number): IndicatorValue[];
export declare function rollingAverage(values: IndicatorValue[], period?: number): IndicatorValue[];
//# sourceMappingURL=indicators.d.ts.map