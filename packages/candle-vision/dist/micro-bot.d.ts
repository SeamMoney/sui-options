import type { CandleInput, CandlePatternEvent } from './types';
import type { TradeDecision } from './trade-decision';
export type MicroBotSide = 'long' | 'short';
export type MicroBotStatus = 'flat' | 'armed' | 'in-position' | 'cooldown';
export type MicroBotExitReason = 'time' | 'target' | 'stop' | 'pressure-flip' | 'manual';
export type MicroBotSignalPhase = 'scanning' | 'forming' | 'confirmed' | 'blocked';
export type MicroBotPosition = {
    id: string;
    side: MicroBotSide;
    entryPrice: number;
    markPrice: number;
    entryIndex: number;
    latestIndex: number;
    openedAtMs: number;
    plannedExitAtMs: number;
    targetPrice: number;
    stopPrice: number;
    pnl: number;
    pnlPct: number;
    progress: number;
};
export type MicroBotTrade = MicroBotPosition & {
    exitPrice: number;
    closedAtMs: number;
    exitReason: MicroBotExitReason;
};
export type MicroBotSignal = {
    side: MicroBotSide | 'none';
    phase: MicroBotSignalPhase;
    pressure: number;
    confidence: number;
    entryScore: number;
    momentum: number;
    patternScore: number;
    setupScore: number;
    volumeScore: number;
    oppositeScore: number;
    reasons: string[];
};
export type MicroBotState = {
    enabled: boolean;
    status: MicroBotStatus;
    signal: MicroBotSignal;
    position: MicroBotPosition | null;
    trades: MicroBotTrade[];
    lastTrade?: MicroBotTrade;
    cooldownUntilMs: number;
    stats: {
        totalTrades: number;
        wins: number;
        losses: number;
        pnl: number;
        winRate: number;
    };
};
export type MicroBotOptions = {
    enabled?: boolean;
    minHoldMs?: number;
    maxHoldMs?: number;
    cooldownMs?: number;
    entryThreshold?: number;
    flipExitThreshold?: number;
    targetRangeMultiple?: number;
    stopRangeMultiple?: number;
    maxTrades?: number;
    minPressure?: number;
    maxOppositeScore?: number;
    minDecisionConfidence?: number;
    minMomentumScore?: number;
    requireDecisionConfirmation?: boolean;
};
export declare function createMicroBotState(options?: MicroBotOptions): MicroBotState;
export declare function updateMicroBot(input: {
    state: MicroBotState;
    candles: readonly CandleInput[];
    events: readonly CandlePatternEvent[];
    decision: TradeDecision;
    nowMs: number;
    options?: MicroBotOptions;
}): MicroBotState;
export declare function setMicroBotEnabled(state: MicroBotState, enabled: boolean): MicroBotState;
//# sourceMappingURL=micro-bot.d.ts.map