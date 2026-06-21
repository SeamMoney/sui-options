import { calibrateMicroBot, } from './micro-calibration.js';
import { walkForwardMicroBot, } from './micro-walk-forward.js';
export function evaluateMicroBotStrategy(candles, options = {}) {
    const minBars = options.minBars ?? 96;
    const calibration = calibrateMicroBot(candles, options.calibration);
    const walkForwardOptions = options.walkForward ?? {};
    const trainBars = walkForwardOptions.trainBars ?? 90;
    const testBars = walkForwardOptions.testBars ?? 30;
    const minWalkForwardBars = trainBars + testBars;
    const walkForward = candles.length >= minWalkForwardBars
        ? walkForwardMicroBot(candles, {
            ...options.calibration,
            ...walkForwardOptions,
        })
        : null;
    return {
        generatedAt: Date.now(),
        candles: candles.length,
        verdict: buildVerdict({
            candles: candles.length,
            minBars,
            minOutOfSampleTrades: options.minOutOfSampleTrades ?? 4,
            hotScore: options.hotScore ?? 0.68,
            watchScore: options.watchScore ?? 0.48,
            calibration,
            walkForward,
        }),
        calibration,
        walkForward,
    };
}
function buildVerdict(input) {
    if (input.candles < input.minBars) {
        return {
            status: 'warming-up',
            label: 'Collecting setup history',
            score: 0,
            reasons: [`Need ${input.minBars - input.candles} more candles before scoring.`],
        };
    }
    const calibrationScore = input.calibration.best?.score ?? 0;
    const oos = input.walkForward?.summary;
    const oosTrades = oos?.totalTrades ?? 0;
    const stability = oos?.stability ?? 0;
    const winRate = oos?.winRate ?? 0;
    const averagePnl = oos?.averagePnl ?? 0;
    const drawdown = oos?.maxDrawdown ?? 0;
    const pnl = oos?.pnl ?? 0;
    const tradeCoverage = clamp01(oosTrades / Math.max(1, input.minOutOfSampleTrades));
    const pnlScore = Math.tanh(averagePnl * 8) * 0.5 + 0.5;
    const drawdownBase = Math.abs(pnl) + drawdown + 1;
    const drawdownPenalty = drawdown / drawdownBase;
    const score = clamp01(calibrationScore * 0.28 +
        stability * 0.3 +
        winRate * 0.2 +
        pnlScore * 0.14 +
        tradeCoverage * 0.08 -
        drawdownPenalty * 0.16);
    const reasons = [];
    if (input.calibration.best)
        reasons.push(`Best preset: ${input.calibration.best.preset.label}.`);
    if (input.walkForward) {
        reasons.push(`${input.walkForward.summary.positiveFolds}/${input.walkForward.folds.length} out-of-sample folds positive.`);
        reasons.push(`${oosTrades} out-of-sample trade${oosTrades === 1 ? '' : 's'}, ${Math.round(winRate * 100)}% win rate.`);
    }
    else {
        reasons.push('Not enough candles for walk-forward validation yet.');
    }
    if (drawdown > Math.abs(pnl) && oosTrades > 0)
        reasons.push('Drawdown is larger than net edge.');
    if (!input.walkForward || oosTrades < input.minOutOfSampleTrades) {
        return {
            status: score >= input.watchScore ? 'watch' : 'warming-up',
            label: 'Needs more out-of-sample trades',
            score,
            reasons,
        };
    }
    if (score >= input.hotScore && pnl > 0 && stability >= 0.5) {
        return {
            status: 'hot',
            label: 'Paper edge confirmed',
            score,
            reasons,
        };
    }
    if (score >= input.watchScore && stability >= 0.34) {
        return {
            status: 'watch',
            label: 'Watchlist only',
            score,
            reasons,
        };
    }
    return {
        status: 'reject',
        label: 'Do not auto-trade',
        score,
        reasons,
    };
}
function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}
//# sourceMappingURL=micro-strategy-lab.js.map