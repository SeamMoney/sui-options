import type { CandleDirection, CandleFeature } from '../../types';
export type MultiCandlePatternKind = 'three-inside' | 'three-outside' | 'three-line-strike' | 'three-stars-in-south' | 'abandoned-baby' | 'advance-block' | 'breakaway' | 'concealing-baby-swallow' | 'identical-three-crows' | 'kicking' | 'kicking-by-length' | 'ladder-bottom' | 'mat-hold' | 'rising-three-methods' | 'falling-three-methods' | 'stalled-pattern' | 'stick-sandwich' | 'tristar' | 'unique-three-river' | 'upside-gap-three-methods' | 'downside-gap-three-methods';
export type TaLibMultiCandlePatternName = 'CDL3INSIDE' | 'CDL3OUTSIDE' | 'CDL3LINESTRIKE' | 'CDL3STARSINSOUTH' | 'CDLABANDONEDBABY' | 'CDLADVANCEBLOCK' | 'CDLBREAKAWAY' | 'CDLCONCEALBABYSWALL' | 'CDLIDENTICAL3CROWS' | 'CDLKICKING' | 'CDLKICKINGBYLENGTH' | 'CDLLADDERBOTTOM' | 'CDLMATHOLD' | 'CDLRISEFALL3METHODS' | 'CDLSTALLEDPATTERN' | 'CDLSTICKSANDWICH' | 'CDLTRISTAR' | 'CDLUNIQUE3RIVER' | 'CDLXSIDEGAP3METHODS';
export type MultiCandlePatternMatch = {
    kind: MultiCandlePatternKind;
    taLibName: TaLibMultiCandlePatternName;
    direction: CandleDirection;
    startIndex: number;
    endIndex: number;
    confidence: number;
    strength: number;
    label: string;
    description: string;
    scoreBreakdown: Record<string, number>;
};
export type MultiCandlePatternDefinition = {
    kind: MultiCandlePatternKind;
    taLibName: TaLibMultiCandlePatternName;
    label: string;
    minCandles: number;
    maxCandles: number;
    directions: CandleDirection[];
    detect: (features: CandleFeature[], index: number) => MultiCandlePatternMatch[];
};
export declare const MULTI_CANDLE_PATTERN_DEFINITIONS: MultiCandlePatternDefinition[];
export declare function detectMultiCandlePatternMatches(features: CandleFeature[], index: number, definitions?: MultiCandlePatternDefinition[]): MultiCandlePatternMatch[];
//# sourceMappingURL=multi-candle.d.ts.map