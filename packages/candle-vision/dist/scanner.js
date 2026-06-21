import { detectUnifiedCandlePatterns } from './detectors.js';
import { rankPatternSignals, } from './ranking.js';
const EMPTY_FAMILY_COUNTS = {
    candlestick: 0,
    'vision-candle': 0,
    'chart-setup': 0,
};
const EMPTY_STATUS_COUNTS = {
    forming: 0,
    confirmed: 0,
    invalidated: 0,
    expired: 0,
};
export function computeCandleVisionStats(events, ranking) {
    const byFamily = { ...EMPTY_FAMILY_COUNTS };
    const byStatus = { ...EMPTY_STATUS_COUNTS };
    const directions = {
        bullish: 0,
        bearish: 0,
        neutral: 0,
    };
    let confidenceTotal = 0;
    let strengthTotal = 0;
    for (const event of events) {
        byFamily[event.family] += 1;
        byStatus[event.status] += 1;
        directions[event.direction] += 1;
        confidenceTotal += event.confidence;
        strengthTotal += event.strength;
    }
    return {
        total: events.length,
        visible: ranking.visible.length,
        supported: ranking.supported.length,
        unsupported: ranking.unsupported.length,
        bullish: directions.bullish,
        bearish: directions.bearish,
        neutral: directions.neutral,
        byFamily,
        byStatus,
        averageConfidence: events.length ? confidenceTotal / events.length : 0,
        averageStrength: events.length ? strengthTotal / events.length : 0,
    };
}
export function scanCandleVision(candles, options = {}) {
    const { ranking: rankingOptions, ...detectorOptions } = options;
    const candleData = [...candles];
    const events = detectUnifiedCandlePatterns(candleData, detectorOptions);
    const latestIndex = candleData.length > 0 ? candleData.length - 1 : undefined;
    const ranking = rankPatternSignals(events, {
        latestIndex,
        ...rankingOptions,
    });
    return {
        candles: candleData,
        events,
        ranking,
        visibleSignals: ranking.visible,
        visibleEvents: ranking.visible.map((signal) => signal.event),
        latestEvent: events.at(-1),
        stats: computeCandleVisionStats(events, ranking),
    };
}
export function detectLatestVisiblePatterns(candles, options = {}) {
    const result = scanCandleVision(candles, {
        ...options,
        ranking: {
            minVisibleScore: 0.2,
            recencyWindow: Math.max(8, options.ranking?.recencyWindow ?? 24),
            ...options.ranking,
        },
    });
    const latestIndex = result.candles.length - 1;
    return result.visibleEvents.filter((event) => event.endIndex === latestIndex);
}
export function createCandleVisionStream(options = {}) {
    const { initialCandles = [], maxCandles, ...scannerOptions } = options;
    let candles = trimCandles([...initialCandles], maxCandles);
    const snapshot = () => scanCandleVision(candles, scannerOptions);
    return {
        appendCandle(candle) {
            candles = trimCandles([...candles, candle], maxCandles);
            return snapshot();
        },
        appendCandles(nextCandles) {
            candles = trimCandles([...candles, ...nextCandles], maxCandles);
            return snapshot();
        },
        replaceCandles(nextCandles) {
            candles = trimCandles([...nextCandles], maxCandles);
            return snapshot();
        },
        clearCandles() {
            candles = [];
            return snapshot();
        },
        snapshot,
        getCandles() {
            return [...candles];
        },
    };
}
function trimCandles(candles, maxCandles) {
    if (!maxCandles || candles.length <= maxCandles)
        return candles;
    return candles.slice(-maxCandles);
}
//# sourceMappingURL=scanner.js.map