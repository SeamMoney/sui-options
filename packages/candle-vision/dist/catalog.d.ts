import type { CandleDirection, CandleInput, CandlePatternEvent, CandlePatternFamily, CandlePatternKind } from './types';
export type CandlePatternCatalogEntry = {
    kind: CandlePatternKind;
    family: CandlePatternFamily;
    direction: CandleDirection;
    label: string;
    description: string;
};
export declare const CANDLE_VISION_PATTERN_CATALOG: CandlePatternCatalogEntry[];
export declare function createPatternShowcaseEvents(candles: CandleInput[], catalog?: CandlePatternCatalogEntry[]): CandlePatternEvent[];
//# sourceMappingURL=catalog.d.ts.map