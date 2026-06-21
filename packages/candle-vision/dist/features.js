const EPSILON = 1e-9;
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
function average(values, fallback = 0) {
    if (!values.length)
        return fallback;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}
function directionOf(open, close, bodyPct) {
    if (bodyPct < 0.08)
        return 'neutral';
    return close > open ? 'bullish' : 'bearish';
}
function trendDirection(slope) {
    if (Math.abs(slope) < 0.001)
        return 'neutral';
    return slope > 0 ? 'bullish' : 'bearish';
}
export function normalizeCandles(candles, contextPeriod = 20, trendPeriod = 12) {
    const ranges = candles.map((bar) => Math.max(bar.high - bar.low, EPSILON));
    const bodies = candles.map((bar) => Math.abs(bar.close - bar.open));
    const volumes = candles.map((bar) => Math.max(bar.volume ?? 0, 0));
    return candles.map((bar, index) => {
        const range = ranges[index];
        const body = bodies[index];
        const highBody = Math.max(bar.open, bar.close);
        const lowBody = Math.min(bar.open, bar.close);
        const upperWick = Math.max(0, bar.high - highBody);
        const lowerWick = Math.max(0, lowBody - bar.low);
        const bodyPct = clamp(body / range, 0, 1);
        const upperPct = clamp(upperWick / range, 0, 1);
        const lowerPct = clamp(lowerWick / range, 0, 1);
        const closeLocation = clamp((bar.close - bar.low) / range, 0, 1);
        const from = Math.max(0, index - contextPeriod + 1);
        const avgRange = average(ranges.slice(from, index + 1), range);
        const avgBody = average(bodies.slice(from, index + 1), body);
        const avgVolume = average(volumes.slice(from, index + 1), bar.volume ?? 0);
        const trendFrom = Math.max(0, index - trendPeriod + 1);
        const trendSlice = candles.slice(trendFrom, index + 1);
        const firstClose = trendSlice[0]?.close ?? bar.close;
        const trendSlope = firstClose !== 0 ? (bar.close - firstClose) / Math.abs(firstClose) : 0;
        const direction = directionOf(bar.open, bar.close, bodyPct);
        return {
            ...bar,
            index,
            range,
            body,
            bodyPct,
            upperWick,
            lowerWick,
            upperPct,
            lowerPct,
            closeLocation,
            direction,
            directionScore: direction === 'bullish' ? 1 : direction === 'bearish' ? -1 : 0,
            averageRange: avgRange,
            averageBody: avgBody,
            rangeRatio: avgRange > EPSILON ? range / avgRange : 1,
            bodyRatio: avgBody > EPSILON ? body / avgBody : 1,
            volumeRatio: avgVolume > EPSILON ? (bar.volume ?? 0) / avgVolume : 1,
            trendSlope,
            trendDirection: trendDirection(trendSlope),
        };
    });
}
export function bodyHigh(bar) {
    return Math.max(bar.open, bar.close);
}
export function bodyLow(bar) {
    return Math.min(bar.open, bar.close);
}
export function overlapsBody(a, b) {
    return bodyHigh(a) >= bodyLow(b) && bodyLow(a) <= bodyHigh(b);
}
export function clamp01(value) {
    return clamp(value, 0, 1);
}
export function scoreGreater(value, threshold, fullAt) {
    if (value <= threshold)
        return 0;
    if (fullAt <= threshold)
        return 1;
    return clamp01((value - threshold) / (fullAt - threshold));
}
export function scoreLess(value, threshold, zeroAt) {
    if (value <= threshold)
        return 1;
    if (zeroAt <= threshold)
        return 0;
    return clamp01(1 - (value - threshold) / (zeroAt - threshold));
}
//# sourceMappingURL=features.js.map