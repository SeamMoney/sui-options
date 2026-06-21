import { type PatternSignalRankingOptions, type PatternSignalRankingResult, type RankedPatternSignal } from './ranking';
import type { CandleInput, CandlePatternEvent } from './types';
export type TradeDecisionAction = 'buy' | 'sell' | 'hold';
export type TradeDecisionSide = 'long' | 'short' | 'none';
export type TradeDecisionStatus = 'confirmed' | 'watching' | 'denied' | 'invalidated' | 'expired' | 'no-signal';
export type TradeDecisionReasonCode = 'no_ranked_signal' | 'insufficient_data' | 'unsupported_pattern' | 'neutral_signal' | 'stale_signal' | 'watch_expired' | 'pattern_forming' | 'pattern_confirmed' | 'breakout_confirmed' | 'breakdown_confirmed' | 'volume_confirmed' | 'volume_below_threshold' | 'risk_defined' | 'risk_too_wide' | 'confluence_same_direction' | 'confluence_mixed' | 'opposing_signal' | 'close_through_stop' | 'low_decision_score';
export type TradeDecisionReason = {
    code: TradeDecisionReasonCode;
    label: string;
    weight: number;
    polarity: 'confirm' | 'deny' | 'info';
};
export type TradeDecisionLevel = {
    price: number;
    index: number;
    time: number;
    role: 'entry' | 'stop' | 'invalidation' | 'target';
    source: 'anchor' | 'candle-range' | 'latest-close' | 'risk-multiple';
};
export type TradeDecisionScoreBreakdown = {
    pattern: number;
    ranking: number;
    recency: number;
    confluence: number;
    volume: number;
    risk: number;
    total: number;
};
export type TradeDecision = {
    id: string;
    action: TradeDecisionAction;
    side: TradeDecisionSide;
    status: TradeDecisionStatus;
    confidence: number;
    score: number;
    label: string;
    reasons: TradeDecisionReason[];
    primarySignal?: RankedPatternSignal;
    confirmingSignals: RankedPatternSignal[];
    denyingSignals: RankedPatternSignal[];
    entry?: TradeDecisionLevel;
    stop?: TradeDecisionLevel;
    invalidation?: TradeDecisionLevel;
    targets: TradeDecisionLevel[];
    scoreBreakdown: TradeDecisionScoreBreakdown;
    latestIndex: number;
    createdAt: number;
};
export type TradeDecisionOptions = {
    latestIndex?: number;
    minActionScore?: number;
    minWatchScore?: number;
    recencyWindow?: number;
    maxWatchBars?: number;
    oppositionDenyRatio?: number;
    minVolumeRatio?: number;
    requireVolumeConfirmation?: boolean;
    maxRiskRangeRatio?: number;
    maxConfirmingSignals?: number;
    ranking?: PatternSignalRankingOptions;
};
export type TradeDecisionResult = {
    decision: TradeDecision;
    decisions: TradeDecision[];
    ranking: PatternSignalRankingResult;
};
export declare function decideTradeFromEvents(events: readonly CandlePatternEvent[], candles: readonly CandleInput[], options?: TradeDecisionOptions): TradeDecisionResult;
export declare function decideTradeFromSignals(signals: readonly RankedPatternSignal[], candles: readonly CandleInput[], options?: TradeDecisionOptions): TradeDecisionResult;
//# sourceMappingURL=trade-decision.d.ts.map