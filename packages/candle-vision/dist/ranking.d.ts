import type { CandlePatternEvent, CandlePatternFamily, CandlePatternStatus } from './types';
import { type PatternCategory, type PatternDefinition, type PatternRegistry, type PatternSupportStatus } from './registry';
export type PatternSignalSupport = PatternSupportStatus | 'unknown';
export type RankedPatternSignal = {
    event: CandlePatternEvent;
    definition?: PatternDefinition;
    category?: PatternCategory;
    support: PatternSignalSupport;
    supported: boolean;
    visible: boolean;
    rawScore: number;
    visibleScore: number;
    rawRank: number;
    visibleRank?: number;
    reasons: string[];
};
export type PatternSignalRankingOptions = {
    registry?: PatternRegistry;
    maxVisible?: number;
    minVisibleScore?: number;
    latestIndex?: number;
    recencyWindow?: number;
    allowOverlaps?: boolean;
    perKindLimit?: number;
    perFamilyLimit?: number;
    familyWeights?: Partial<Record<CandlePatternFamily, number>>;
    categoryWeights?: Partial<Record<PatternCategory, number>>;
    statusWeights?: Partial<Record<CandlePatternStatus, number>>;
};
export type PatternSignalRankingResult = {
    raw: RankedPatternSignal[];
    supported: RankedPatternSignal[];
    unsupported: RankedPatternSignal[];
    visible: RankedPatternSignal[];
};
export declare function rankPatternSignals(events: CandlePatternEvent[], options?: PatternSignalRankingOptions): PatternSignalRankingResult;
export declare function rankVisiblePatternSignals(events: CandlePatternEvent[], options?: PatternSignalRankingOptions): RankedPatternSignal[];
export declare function selectVisiblePatternEvents(events: CandlePatternEvent[], options?: PatternSignalRankingOptions): CandlePatternEvent[];
//# sourceMappingURL=ranking.d.ts.map