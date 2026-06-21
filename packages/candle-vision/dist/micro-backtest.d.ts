import { type TradeDecisionOptions } from './trade-decision';
import { type UnifiedCandlePatternOptions } from './detectors';
import { type MicroBotOptions, type MicroBotState, type MicroBotTrade } from './micro-bot';
import type { CandleInput } from './types';
export type MicroBotBacktestOptions = {
    warmupBars?: number;
    barMs?: number;
    detector?: UnifiedCandlePatternOptions;
    decision?: TradeDecisionOptions;
    bot?: MicroBotOptions;
};
export type MicroBotBacktestResult = {
    state: MicroBotState;
    trades: MicroBotTrade[];
    equityCurve: Array<{
        index: number;
        time: number;
        pnl: number;
        trades: number;
    }>;
    summary: {
        totalTrades: number;
        wins: number;
        losses: number;
        pnl: number;
        winRate: number;
        averagePnl: number;
        maxDrawdown: number;
    };
};
export declare function backtestMicroBot(candles: readonly CandleInput[], options?: MicroBotBacktestOptions): MicroBotBacktestResult;
//# sourceMappingURL=micro-backtest.d.ts.map