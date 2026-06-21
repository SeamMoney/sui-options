import { atr, bollingerBands, ema, hasUsableVolume, macd, rollingAverage, rollingVolumeAverage, rsi, sma, vwap, } from './indicators.js';
export * from './indicators.js';
export const DEFAULT_TA_DETECTOR_OPTIONS = {
    minConfidence: 0.58,
    includeWeak: false,
    fastPeriod: 20,
    slowPeriod: 50,
    rsiPeriod: 14,
    rsiOverbought: 70,
    rsiOversold: 30,
    macdFastPeriod: 12,
    macdSlowPeriod: 26,
    macdSignalPeriod: 9,
    bollingerPeriod: 20,
    bollingerMultiplier: 2,
    bollingerSqueezeLookback: 40,
    bollingerBreakoutLookback: 8,
    atrPeriod: 14,
    atrBaselinePeriod: 20,
    atrExpansionRatio: 1.35,
    vwapPeriod: 20,
    volumePeriod: 20,
    volumeClimaxRatio: 2.4,
};
const COLORS = {
    bullish: '#22c55e',
    bearish: '#ef4444',
    neutral: '#a78bfa',
};
function withDefaults(options = {}) {
    return { ...DEFAULT_TA_DETECTOR_OPTIONS, ...options };
}
function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}
function scoreGreater(value, threshold, fullAt) {
    if (value <= threshold)
        return 0;
    if (fullAt <= threshold)
        return 1;
    return clamp01((value - threshold) / (fullAt - threshold));
}
function isNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
function candleDirection(bar) {
    if (Math.abs(bar.close - bar.open) <= 1e-9)
        return 'neutral';
    return bar.close > bar.open ? 'bullish' : 'bearish';
}
function makeAnchors(candles, startIndex, endIndex, direction) {
    const start = candles[startIndex];
    const end = candles[endIndex];
    const span = candles.slice(startIndex, endIndex + 1);
    const highOffset = span.reduce((best, bar, index) => (bar.high > span[best].high ? index : best), 0);
    const lowOffset = span.reduce((best, bar, index) => (bar.low < span[best].low ? index : best), 0);
    const high = candles[startIndex + highOffset];
    const low = candles[startIndex + lowOffset];
    const confirmationPrice = direction === 'bullish' ? high.high : direction === 'bearish' ? low.low : end.close;
    return [
        { index: startIndex, time: start.time, price: start.open, role: 'start' },
        { index: startIndex + highOffset, time: high.time, price: high.high, role: 'high' },
        { index: startIndex + lowOffset, time: low.time, price: low.low, role: 'low' },
        { index: endIndex, time: end.time, price: confirmationPrice, role: 'confirmation' },
    ];
}
function makeEvent(params) {
    const { detectorId, candles, kind, direction, startIndex, endIndex, confidence, strength, label, description, status = 'confirmed', scoreBreakdown, } = params;
    return {
        id: `ta:${detectorId}:${kind}:${startIndex}:${endIndex}`,
        kind,
        family: 'chart-setup',
        status,
        direction,
        startIndex,
        endIndex,
        detectedAt: candles[endIndex]?.time ?? Date.now(),
        confidence: clamp01(confidence),
        strength: clamp01(strength ?? confidence),
        label,
        description,
        source: 'candle-vision',
        anchors: makeAnchors(candles, startIndex, endIndex, direction),
        color: COLORS[direction],
        scoreBreakdown,
    };
}
function crossedAbove(previousFast, previousSlow, fast, slow) {
    return isNumber(previousFast) && isNumber(previousSlow) && isNumber(fast) && isNumber(slow) && previousFast <= previousSlow && fast > slow;
}
function crossedBelow(previousFast, previousSlow, fast, slow) {
    return isNumber(previousFast) && isNumber(previousSlow) && isNumber(fast) && isNumber(slow) && previousFast >= previousSlow && fast < slow;
}
function maCrossEvents(candles, type, options = {}) {
    const opts = withDefaults(options);
    const fast = type === 'sma' ? sma(candles, opts.fastPeriod) : ema(candles, opts.fastPeriod);
    const slow = type === 'sma' ? sma(candles, opts.slowPeriod) : ema(candles, opts.slowPeriod);
    const detectorId = `${type}-cross`;
    const prefix = type.toUpperCase();
    const events = [];
    for (let i = 1; i < candles.length; i += 1) {
        const fastValue = fast[i];
        const slowValue = slow[i];
        const previousFast = fast[i - 1];
        const previousSlow = slow[i - 1];
        if (!isNumber(fastValue) || !isNumber(slowValue) || !isNumber(previousFast) || !isNumber(previousSlow))
            continue;
        const close = Math.max(Math.abs(candles[i].close), 1e-9);
        const spread = Math.abs(fastValue - slowValue) / close;
        const spreadScore = scoreGreater(spread, 0.0004, 0.012);
        const slopeScore = scoreGreater(Math.abs(fastValue - previousFast) / close, 0.0003, 0.008);
        const confidence = 0.62 + spreadScore * 0.2 + slopeScore * 0.16;
        const startIndex = Math.max(0, i - opts.slowPeriod + 1);
        if (crossedAbove(previousFast, previousSlow, fastValue, slowValue)) {
            events.push(makeEvent({
                detectorId,
                candles,
                kind: 'ma-golden-cross',
                direction: 'bullish',
                startIndex,
                endIndex: i,
                confidence,
                label: `${prefix} Golden Cross`,
                description: `${prefix} fast average crossed above the slow average.`,
                scoreBreakdown: { spreadScore, slopeScore, fastPeriod: opts.fastPeriod, slowPeriod: opts.slowPeriod },
            }));
        }
        if (crossedBelow(previousFast, previousSlow, fastValue, slowValue)) {
            events.push(makeEvent({
                detectorId,
                candles,
                kind: 'ma-death-cross',
                direction: 'bearish',
                startIndex,
                endIndex: i,
                confidence,
                label: `${prefix} Death Cross`,
                description: `${prefix} fast average crossed below the slow average.`,
                scoreBreakdown: { spreadScore, slopeScore, fastPeriod: opts.fastPeriod, slowPeriod: opts.slowPeriod },
            }));
        }
    }
    return events;
}
export function detectSmaCrosses(candles, options = {}) {
    return maCrossEvents(candles, 'sma', options);
}
export function detectEmaCrosses(candles, options = {}) {
    return maCrossEvents(candles, 'ema', options);
}
export function detectRsiSetups(candles, options = {}) {
    const opts = withDefaults(options);
    const values = rsi(candles, opts.rsiPeriod);
    const events = [];
    for (let i = 1; i < candles.length; i += 1) {
        const previous = values[i - 1];
        const current = values[i];
        if (!isNumber(previous) || !isNumber(current))
            continue;
        const startIndex = Math.max(0, i - opts.rsiPeriod);
        if (previous < opts.rsiOverbought && current >= opts.rsiOverbought) {
            const extensionScore = scoreGreater(current, opts.rsiOverbought, Math.min(100, opts.rsiOverbought + 12));
            const confidence = 0.62 + extensionScore * 0.28;
            events.push(makeEvent({
                detectorId: 'rsi-levels',
                candles,
                kind: 'rsi-overbought',
                direction: 'bearish',
                startIndex,
                endIndex: i,
                confidence,
                label: 'RSI Overbought',
                description: 'RSI crossed into the overbought band.',
                scoreBreakdown: { rsi: current, threshold: opts.rsiOverbought, extensionScore },
            }));
        }
        if (previous > opts.rsiOversold && current <= opts.rsiOversold) {
            const extensionScore = scoreGreater(opts.rsiOversold - current, 0, 12);
            const confidence = 0.62 + extensionScore * 0.28;
            events.push(makeEvent({
                detectorId: 'rsi-levels',
                candles,
                kind: 'rsi-oversold',
                direction: 'bullish',
                startIndex,
                endIndex: i,
                confidence,
                label: 'RSI Oversold',
                description: 'RSI crossed into the oversold band.',
                scoreBreakdown: { rsi: current, threshold: opts.rsiOversold, extensionScore },
            }));
        }
    }
    return events;
}
function swingHighs(candles, radius) {
    const highs = [];
    for (let i = radius; i < candles.length - radius; i += 1) {
        let isSwing = true;
        for (let j = i - radius; j <= i + radius; j += 1) {
            if (j !== i && candles[j].high >= candles[i].high)
                isSwing = false;
        }
        if (isSwing)
            highs.push(i);
    }
    return highs;
}
function swingLows(candles, radius) {
    const lows = [];
    for (let i = radius; i < candles.length - radius; i += 1) {
        let isSwing = true;
        for (let j = i - radius; j <= i + radius; j += 1) {
            if (j !== i && candles[j].low <= candles[i].low)
                isSwing = false;
        }
        if (isSwing)
            lows.push(i);
    }
    return lows;
}
export function detectRsiDivergences(candles, options = {}) {
    const opts = withDefaults(options);
    const values = rsi(candles, opts.rsiPeriod);
    const signals = [];
    const highs = swingHighs(candles, 2).filter((index) => isNumber(values[index]));
    const lows = swingLows(candles, 2).filter((index) => isNumber(values[index]));
    for (let i = 1; i < highs.length; i += 1) {
        const first = highs[i - 1];
        const second = highs[i];
        const firstRsi = values[first];
        const secondRsi = values[second];
        if (!isNumber(firstRsi) || !isNumber(secondRsi))
            continue;
        const priceDelta = candles[second].high - candles[first].high;
        const rsiDelta = secondRsi - firstRsi;
        if (priceDelta > 0 && rsiDelta < 0) {
            signals.push({
                direction: 'bearish',
                startIndex: first,
                endIndex: second,
                priceDelta,
                rsiDelta,
                confidence: clamp01(0.55 + scoreGreater(priceDelta / Math.max(Math.abs(candles[first].high), 1e-9), 0.001, 0.04) * 0.2 + scoreGreater(Math.abs(rsiDelta), 3, 18) * 0.25),
            });
        }
    }
    for (let i = 1; i < lows.length; i += 1) {
        const first = lows[i - 1];
        const second = lows[i];
        const firstRsi = values[first];
        const secondRsi = values[second];
        if (!isNumber(firstRsi) || !isNumber(secondRsi))
            continue;
        const priceDelta = candles[second].low - candles[first].low;
        const rsiDelta = secondRsi - firstRsi;
        if (priceDelta < 0 && rsiDelta > 0) {
            signals.push({
                direction: 'bullish',
                startIndex: first,
                endIndex: second,
                priceDelta,
                rsiDelta,
                confidence: clamp01(0.55 + scoreGreater(Math.abs(priceDelta) / Math.max(Math.abs(candles[first].low), 1e-9), 0.001, 0.04) * 0.2 + scoreGreater(rsiDelta, 3, 18) * 0.25),
            });
        }
    }
    return signals.sort((a, b) => a.endIndex - b.endIndex);
}
export function detectMacdCrosses(candles, options = {}) {
    const opts = withDefaults(options);
    const values = macd(candles, opts.macdFastPeriod, opts.macdSlowPeriod, opts.macdSignalPeriod);
    const events = [];
    for (let i = 1; i < values.length; i += 1) {
        const previous = values[i - 1];
        const current = values[i];
        if (!isNumber(previous.macd) || !isNumber(previous.signal) || !isNumber(current.macd) || !isNumber(current.signal))
            continue;
        const histogramShift = Math.abs((current.histogram ?? 0) - (previous.histogram ?? 0));
        const close = Math.max(Math.abs(candles[i].close), 1e-9);
        const expansionScore = scoreGreater(histogramShift / close, 0.0001, 0.006);
        const confidence = 0.62 + expansionScore * 0.28;
        const startIndex = Math.max(0, i - opts.macdSlowPeriod - opts.macdSignalPeriod + 2);
        if (previous.macd <= previous.signal && current.macd > current.signal) {
            events.push(makeEvent({
                detectorId: 'macd-cross',
                candles,
                kind: 'macd-bull-cross',
                direction: 'bullish',
                startIndex,
                endIndex: i,
                confidence,
                label: 'MACD Bull Cross',
                description: 'MACD line crossed above the signal line.',
                scoreBreakdown: { macd: current.macd, signal: current.signal, expansionScore },
            }));
        }
        if (previous.macd >= previous.signal && current.macd < current.signal) {
            events.push(makeEvent({
                detectorId: 'macd-cross',
                candles,
                kind: 'macd-bear-cross',
                direction: 'bearish',
                startIndex,
                endIndex: i,
                confidence,
                label: 'MACD Bear Cross',
                description: 'MACD line crossed below the signal line.',
                scoreBreakdown: { macd: current.macd, signal: current.signal, expansionScore },
            }));
        }
    }
    return events;
}
function squeezeFlags(widths, lookback) {
    return widths.map((width, index) => {
        if (!isNumber(width))
            return false;
        const prior = widths.slice(Math.max(0, index - lookback), index).filter(isNumber);
        if (prior.length < Math.max(6, Math.floor(lookback / 3)))
            return false;
        const averageWidth = prior.reduce((sum, next) => sum + next, 0) / prior.length;
        return width < averageWidth * 0.68;
    });
}
export function detectBollingerSetups(candles, options = {}) {
    const opts = withDefaults(options);
    const bands = bollingerBands(candles, opts.bollingerPeriod, opts.bollingerMultiplier);
    const widths = bands.map((point) => point.width);
    const squeezes = squeezeFlags(widths, opts.bollingerSqueezeLookback);
    const events = [];
    for (let i = 1; i < candles.length; i += 1) {
        const band = bands[i];
        if (!isNumber(band.width) || !isNumber(band.upper) || !isNumber(band.lower))
            continue;
        if (squeezes[i] && !squeezes[i - 1]) {
            const recentWidths = widths.slice(Math.max(0, i - opts.bollingerSqueezeLookback), i).filter(isNumber);
            const averageWidth = recentWidths.reduce((sum, next) => sum + next, 0) / Math.max(1, recentWidths.length);
            const compressionScore = averageWidth > 0 ? clamp01(1 - band.width / (averageWidth * 0.68)) : 0;
            events.push(makeEvent({
                detectorId: 'bollinger',
                candles,
                kind: 'bollinger-squeeze',
                direction: 'neutral',
                startIndex: Math.max(0, i - opts.bollingerPeriod + 1),
                endIndex: i,
                confidence: 0.62 + compressionScore * 0.28,
                label: 'Bollinger Squeeze',
                description: 'Bollinger Band width contracted below its local baseline.',
                status: 'forming',
                scoreBreakdown: { bandWidth: band.width, compressionScore },
            }));
        }
        const recentSqueezeIndex = squeezes
            .slice(Math.max(0, i - opts.bollingerBreakoutLookback), i)
            .reduce((latest, isSqueeze, offset) => (isSqueeze ? Math.max(0, i - opts.bollingerBreakoutLookback) + offset : latest), -1);
        if (recentSqueezeIndex < 0)
            continue;
        const close = candles[i].close;
        const closeDistanceUp = close - band.upper;
        const closeDistanceDown = band.lower - close;
        const bandHeight = Math.max(band.upper - band.lower, 1e-9);
        const breakoutScore = scoreGreater(Math.max(closeDistanceUp, closeDistanceDown) / bandHeight, 0, 0.18);
        if (closeDistanceUp > 0) {
            events.push(makeEvent({
                detectorId: 'bollinger',
                candles,
                kind: 'bollinger-breakout',
                direction: 'bullish',
                startIndex: recentSqueezeIndex,
                endIndex: i,
                confidence: 0.64 + breakoutScore * 0.28,
                label: 'Bollinger Breakout',
                description: 'Price closed above the upper band after a recent squeeze.',
                scoreBreakdown: { breakoutScore, bandWidth: band.width },
            }));
        }
        if (closeDistanceDown > 0) {
            events.push(makeEvent({
                detectorId: 'bollinger',
                candles,
                kind: 'bollinger-breakout',
                direction: 'bearish',
                startIndex: recentSqueezeIndex,
                endIndex: i,
                confidence: 0.64 + breakoutScore * 0.28,
                label: 'Bollinger Breakdown',
                description: 'Price closed below the lower band after a recent squeeze.',
                scoreBreakdown: { breakoutScore, bandWidth: band.width },
            }));
        }
    }
    return events;
}
export function detectAtrExpansion(candles, options = {}) {
    const opts = withDefaults(options);
    const values = atr(candles, opts.atrPeriod);
    const baseline = rollingAverage(values, opts.atrBaselinePeriod);
    const events = [];
    for (let i = 1; i < candles.length; i += 1) {
        const current = values[i];
        const currentBaseline = baseline[i];
        const previous = values[i - 1];
        const previousBaseline = baseline[i - 1];
        if (!isNumber(current) || !isNumber(currentBaseline) || !isNumber(previous) || !isNumber(previousBaseline) || currentBaseline <= 0 || previousBaseline <= 0)
            continue;
        const ratio = current / currentBaseline;
        const previousRatio = previous / previousBaseline;
        if (ratio < opts.atrExpansionRatio || previousRatio >= opts.atrExpansionRatio)
            continue;
        const expansionScore = scoreGreater(ratio, opts.atrExpansionRatio, opts.atrExpansionRatio * 1.75);
        events.push(makeEvent({
            detectorId: 'atr-expansion',
            candles,
            kind: 'atr-expansion',
            direction: candleDirection(candles[i]),
            startIndex: Math.max(0, i - opts.atrBaselinePeriod + 1),
            endIndex: i,
            confidence: 0.62 + expansionScore * 0.28,
            label: 'ATR Expansion',
            description: 'ATR expanded above its local baseline after quieter candles.',
            scoreBreakdown: { atr: current, baseline: currentBaseline, ratio, expansionScore },
        }));
    }
    return events;
}
export function detectVwapSetups(candles, options = {}) {
    const opts = withDefaults(options);
    const values = vwap(candles, opts.vwapPeriod);
    const hasVolume = hasUsableVolume(candles);
    const events = [];
    for (let i = 1; i < candles.length; i += 1) {
        const previous = values[i - 1];
        const current = values[i];
        if (!isNumber(previous) || !isNumber(current))
            continue;
        const close = candles[i].close;
        const previousClose = candles[i - 1].close;
        const distance = Math.abs(close - current) / Math.max(Math.abs(current), 1e-9);
        const distanceScore = scoreGreater(distance, 0.0004, 0.012);
        const volumeScore = hasVolume ? 1 : 0.72;
        const confidence = 0.6 + distanceScore * 0.22 + volumeScore * 0.1;
        const startIndex = Math.max(0, i - opts.vwapPeriod + 1);
        if (previousClose <= previous && close > current) {
            events.push(makeEvent({
                detectorId: 'vwap',
                candles,
                kind: 'vwap-reclaim',
                direction: 'bullish',
                startIndex,
                endIndex: i,
                confidence,
                label: 'VWAP Reclaim',
                description: 'Price closed back above VWAP after trading below it.',
                scoreBreakdown: { vwap: current, distanceScore, volumeScore },
            }));
        }
        if (previousClose < previous && candles[i].high >= current && close < current) {
            events.push(makeEvent({
                detectorId: 'vwap',
                candles,
                kind: 'vwap-rejection',
                direction: 'bearish',
                startIndex,
                endIndex: i,
                confidence,
                label: 'VWAP Rejection',
                description: 'Price tested VWAP from below and failed to close above it.',
                scoreBreakdown: { vwap: current, distanceScore, volumeScore },
            }));
        }
    }
    return events;
}
export function detectVolumeClimax(candles, options = {}) {
    const opts = withDefaults(options);
    const averages = rollingVolumeAverage(candles, opts.volumePeriod);
    const events = [];
    for (let i = 1; i < candles.length; i += 1) {
        const average = averages[i - 1];
        const volume = candles[i].volume ?? 0;
        if (!isNumber(average) || average <= 0 || volume <= 0)
            continue;
        const ratio = volume / average;
        if (ratio < opts.volumeClimaxRatio)
            continue;
        const range = candles[i].high - candles[i].low;
        const previousRange = candles[i - 1].high - candles[i - 1].low;
        const rangeScore = previousRange > 0 ? scoreGreater(range / previousRange, 1, 2.2) : 0;
        const volumeScore = scoreGreater(ratio, opts.volumeClimaxRatio, opts.volumeClimaxRatio * 1.9);
        events.push(makeEvent({
            detectorId: 'volume-climax',
            candles,
            kind: 'volume-climax',
            direction: candleDirection(candles[i]),
            startIndex: Math.max(0, i - opts.volumePeriod + 1),
            endIndex: i,
            confidence: 0.62 + volumeScore * 0.24 + rangeScore * 0.12,
            label: 'Volume Climax',
            description: 'Volume spiked far above its local baseline.',
            scoreBreakdown: { volume, averageVolume: average, ratio, volumeScore, rangeScore },
        }));
    }
    return events;
}
export const TA_PATTERN_DETECTORS = [
    { id: 'sma-cross', label: 'SMA Crosses', minCandles: 50, kinds: ['ma-golden-cross', 'ma-death-cross'], detect: detectSmaCrosses },
    { id: 'ema-cross', label: 'EMA Crosses', minCandles: 50, kinds: ['ma-golden-cross', 'ma-death-cross'], detect: detectEmaCrosses },
    { id: 'rsi-levels', label: 'RSI Levels', minCandles: 15, kinds: ['rsi-overbought', 'rsi-oversold'], detect: detectRsiSetups },
    { id: 'macd-cross', label: 'MACD Crosses', minCandles: 35, kinds: ['macd-bull-cross', 'macd-bear-cross'], detect: detectMacdCrosses },
    { id: 'bollinger', label: 'Bollinger Setups', minCandles: 60, kinds: ['bollinger-squeeze', 'bollinger-breakout'], detect: detectBollingerSetups },
    { id: 'atr-expansion', label: 'ATR Expansion', minCandles: 35, kinds: ['atr-expansion'], detect: detectAtrExpansion },
    { id: 'vwap', label: 'VWAP Setups', minCandles: 21, kinds: ['vwap-reclaim', 'vwap-rejection'], detect: detectVwapSetups },
    { id: 'volume-climax', label: 'Volume Climax', minCandles: 21, kinds: ['volume-climax'], detect: detectVolumeClimax },
];
function dedupe(events) {
    const selected = new Map();
    for (const event of events) {
        const key = event.id;
        const previous = selected.get(key);
        if (!previous || event.confidence > previous.confidence)
            selected.set(key, event);
    }
    return Array.from(selected.values()).sort((a, b) => a.endIndex - b.endIndex || a.startIndex - b.startIndex);
}
export function detectTaPatterns(candles, options = {}) {
    const opts = withDefaults(options);
    const events = TA_PATTERN_DETECTORS.flatMap((detector) => {
        if (candles.length < detector.minCandles)
            return [];
        return detector.detect(candles, opts);
    });
    return dedupe(events).filter((event) => event.confidence >= opts.minConfidence || opts.includeWeak);
}
//# sourceMappingURL=index.js.map