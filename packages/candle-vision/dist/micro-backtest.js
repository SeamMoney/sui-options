import { decideTradeFromEvents } from './trade-decision.js';
import { detectUnifiedCandlePatterns } from './detectors.js';
import { createMicroBotState, updateMicroBot, } from './micro-bot.js';
export function backtestMicroBot(candles, options = {}) {
    const warmupBars = options.warmupBars ?? 40;
    const barMs = options.barMs ?? 1000;
    let state = createMicroBotState(options.bot);
    const trades = [];
    const equityCurve = [];
    let peak = 0;
    let maxDrawdown = 0;
    for (let index = Math.max(6, warmupBars); index < candles.length; index += 1) {
        const slice = candles.slice(0, index + 1);
        const events = detectUnifiedCandlePatterns([...slice], {
            minConfidence: 0.55,
            includeWeak: true,
            enableExpandedCandles: true,
            enableStructures: true,
            enableTaPatterns: true,
            lookback: Math.min(220, slice.length),
            ...options.detector,
        });
        const trade = decideTradeFromEvents(events, slice, {
            latestIndex: slice.length - 1,
            minActionScore: 0.6,
            minWatchScore: 0.36,
            maxWatchBars: 9,
            recencyWindow: 52,
            requireVolumeConfirmation: false,
            ...options.decision,
        });
        const previousTradeCount = state.stats.totalTrades;
        state = updateMicroBot({
            state,
            candles: slice,
            events,
            decision: trade.decision,
            nowMs: index * barMs,
            options: options.bot,
        });
        if (state.stats.totalTrades > previousTradeCount && state.lastTrade) {
            trades.push(state.lastTrade);
        }
        peak = Math.max(peak, state.stats.pnl);
        maxDrawdown = Math.max(maxDrawdown, peak - state.stats.pnl);
        equityCurve.push({
            index,
            time: slice[slice.length - 1].time,
            pnl: state.stats.pnl,
            trades: state.stats.totalTrades,
        });
    }
    return {
        state,
        trades,
        equityCurve,
        summary: {
            ...state.stats,
            averagePnl: state.stats.totalTrades === 0 ? 0 : state.stats.pnl / state.stats.totalTrades,
            maxDrawdown,
        },
    };
}
//# sourceMappingURL=micro-backtest.js.map