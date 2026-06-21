import type { CandleFeature, CandleInput, CandlePatternDetectorOptions, CandlePatternEvent } from '../../types';
export type TwoCandlePatternKind = 'engulfing' | 'harami' | 'piercing-line' | 'dark-cloud-cover' | 'two-crows' | 'counterattack' | 'doji-star' | 'harami-cross' | 'homing-pigeon' | 'in-neck' | 'matching-low' | 'on-neck' | 'separating-lines' | 'thrusting' | 'tasuki-gap' | 'upside-gap-two-crows';
export type TwoCandleTaLibName = 'CDLENGULFING' | 'CDLHARAMI' | 'CDLPIERCING' | 'CDLDARKCLOUDCOVER' | 'CDL2CROWS' | 'CDLCOUNTERATTACK' | 'CDLDOJISTAR' | 'CDLHARAMICROSS' | 'CDLHOMINGPIGEON' | 'CDLINNECK' | 'CDLMATCHINGLOW' | 'CDLONNECK' | 'CDLSEPARATINGLINES' | 'CDLTHRUSTING' | 'CDLTASUKIGAP' | 'CDLUPSIDEGAP2CROWS';
export type TwoCandlePatternCandidate = Omit<CandlePatternEvent, 'id' | 'kind' | 'detectedAt' | 'source' | 'color'> & {
    kind: TwoCandlePatternKind;
    color?: string;
    taLib: {
        name: TwoCandleTaLibName;
        value: -100 | 100;
        candleCount: 2 | 3;
    };
};
export type TwoCandlePatternDefinition = {
    kind: TwoCandlePatternKind;
    taLibName: TwoCandleTaLibName;
    label: string;
    description: string;
    candleCount: 2 | 3;
    family: 'candlestick';
    detect: (features: CandleFeature[], index: number) => TwoCandlePatternCandidate | null;
};
export type TwoCandlePatternDetectorOptions = Pick<CandlePatternDetectorOptions, 'contextPeriod' | 'trendPeriod' | 'minConfidence' | 'includeWeak'> & {
    definitions?: readonly TwoCandlePatternDefinition[];
};
export declare const TWO_CANDLE_PATTERN_DEFINITIONS: readonly TwoCandlePatternDefinition[];
export declare function detectTwoCandlePatternCandidatesFromFeatures(features: CandleFeature[], index: number, definitions?: readonly TwoCandlePatternDefinition[]): TwoCandlePatternCandidate[];
export declare function detectTwoCandlePatternCandidates(candles: CandleInput[], options?: TwoCandlePatternDetectorOptions): TwoCandlePatternCandidate[];
//# sourceMappingURL=two-candle.d.ts.map