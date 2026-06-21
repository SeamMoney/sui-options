import { type CSSProperties, type ReactNode } from 'react';
import { type CandleInput, type CandlePatternDetectorOptions, type CandlePatternEvent, type CandlePatternFamily, type CandlePatternStatus, type PatternSignalRankingOptions, type PatternSignalRankingResult, type RankedPatternSignal } from '@sui-options/candle-vision';
export type CandleVisionScannerOptions = CandlePatternDetectorOptions & {
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
export type CandleVisionScannerResult = {
    candles: CandleInput[];
    events: CandlePatternEvent[];
    ranking: PatternSignalRankingResult;
    visibleSignals: RankedPatternSignal[];
    visibleEvents: CandlePatternEvent[];
    latestEvent?: CandlePatternEvent;
    stats: CandleVisionStats;
};
export type PatternStreamOptions = CandleVisionScannerOptions & {
    initialCandles?: CandleInput[];
    maxCandles?: number;
};
export type PatternStreamResult = CandleVisionScannerResult & {
    appendCandle: (candle: CandleInput) => void;
    appendCandles: (candles: CandleInput[]) => void;
    replaceCandles: (candles: CandleInput[]) => void;
    clearCandles: () => void;
};
export type PatternStatsPanelProps = {
    stats?: CandleVisionStats;
    events?: CandlePatternEvent[];
    ranking?: PatternSignalRankingResult;
    title?: ReactNode;
    className?: string;
    style?: CSSProperties;
    formatPercent?: (value: number) => ReactNode;
};
export type SignalListProps = {
    signals?: RankedPatternSignal[];
    events?: CandlePatternEvent[];
    emptyState?: ReactNode;
    className?: string;
    style?: CSSProperties;
    maxItems?: number;
    showDescription?: boolean;
    renderMeta?: (signal: RankedPatternSignal) => ReactNode;
};
export declare function useCandleVisionScanner(candles: CandleInput[], options?: CandleVisionScannerOptions): CandleVisionScannerResult;
export declare function usePatternStream(options?: PatternStreamOptions): PatternStreamResult;
export declare function PatternStatsPanel({ stats, events, ranking, title, className, style, formatPercent, }: PatternStatsPanelProps): import("react/jsx-runtime").JSX.Element;
export declare function SignalList({ signals, events, emptyState, className, style, maxItems, showDescription, renderMeta, }: SignalListProps): import("react/jsx-runtime").JSX.Element;
export type { CandleInput, CandlePatternDetectorOptions, CandlePatternEvent, PatternSignalRankingOptions, PatternSignalRankingResult, RankedPatternSignal, };
//# sourceMappingURL=index.d.ts.map