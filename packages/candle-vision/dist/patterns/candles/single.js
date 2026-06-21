import { bodyHigh, bodyLow, clamp01, scoreGreater, scoreLess, } from '../../features.js';
const RANGE_FLOOR = 1e-9;
function weightedScore(parts, weights) {
    const entries = Object.entries(parts);
    const totalWeight = entries.reduce((sum, [key]) => sum + (weights?.[key] ?? 1), 0);
    if (!entries.length || totalWeight <= 0)
        return 0;
    return clamp01(entries.reduce((sum, [key, value]) => sum + clamp01(value) * (weights?.[key] ?? 1), 0) / totalWeight);
}
function defineSingleCandlePattern(meta, evaluate) {
    return {
        ...meta,
        detect: (bar) => {
            if (bar.range <= RANGE_FLOOR)
                return null;
            const result = evaluate(bar);
            if (!result || result.confidence < meta.minConfidence)
                return null;
            return {
                kind: meta.kind,
                family: meta.family,
                scope: meta.scope,
                source: meta.source,
                taLibCode: meta.taLibCode,
                direction: result.direction,
                confidence: clamp01(result.confidence),
                strength: clamp01(result.strength ?? result.confidence),
                label: result.label ?? meta.label,
                description: result.description ?? meta.description,
                scoreBreakdown: result.scoreBreakdown,
            };
        },
    };
}
function directionalBar(bar) {
    return bar.direction === 'neutral' ? null : bar.direction;
}
function directionLabel(direction) {
    return direction === 'bearish' ? 'Bearish' : direction === 'bullish' ? 'Bullish' : 'Neutral';
}
function bodyCenterLocation(bar) {
    return clamp01(((bodyHigh(bar) + bodyLow(bar)) / 2 - bar.low) / bar.range);
}
function bodyNearHighScore(bar) {
    return scoreGreater(bodyLow(bar) <= bar.low ? 1 : (bodyLow(bar) - bar.low) / bar.range, 0.82, 0.96);
}
function bodyNearLowScore(bar) {
    return scoreLess(bodyHigh(bar) >= bar.high ? 1 : (bodyHigh(bar) - bar.low) / bar.range, 0.18, 0.36);
}
function wickBalanceScore(bar) {
    const largestWick = Math.max(bar.upperPct, bar.lowerPct);
    if (largestWick <= RANGE_FLOOR)
        return 0;
    return clamp01(1 - Math.abs(bar.upperPct - bar.lowerPct) / largestWick);
}
function openingShadowPct(bar, direction) {
    if (direction === 'bullish')
        return bar.lowerPct;
    if (direction === 'bearish')
        return bar.upperPct;
    return Math.min(bar.upperPct, bar.lowerPct);
}
function closingShadowPct(bar, direction) {
    if (direction === 'bullish')
        return bar.upperPct;
    if (direction === 'bearish')
        return bar.lowerPct;
    return Math.min(bar.upperPct, bar.lowerPct);
}
function longBodyScore(bar) {
    return weightedScore({
        bodyPct: scoreGreater(bar.bodyPct, 0.5, 0.76),
        bodyRatio: scoreGreater(bar.bodyRatio, 0.85, 1.65),
    }, { bodyPct: 2, bodyRatio: 1 });
}
function dojiBodyScore(bar) {
    return scoreLess(bar.bodyPct, 0.08, 0.18);
}
function dojiScore(bar) {
    return weightedScore({
        body: dojiBodyScore(bar),
        range: scoreGreater(bar.rangeRatio, 0.45, 1.1),
    }, { body: 4, range: 1 });
}
function dojiEvaluation(bar) {
    const score = dojiScore(bar);
    if (score <= 0)
        return null;
    return {
        direction: 'neutral',
        confidence: score,
        scoreBreakdown: {
            body: dojiBodyScore(bar),
            range: scoreGreater(bar.rangeRatio, 0.45, 1.1),
        },
    };
}
function directionalLongBodyEvaluation(bar, scoreBreakdown, weights) {
    const direction = directionalBar(bar);
    if (!direction)
        return null;
    return {
        direction,
        confidence: weightedScore(scoreBreakdown, weights),
    };
}
export const DOJI_PATTERN_DEFINITION = defineSingleCandlePattern({
    id: 'doji',
    kind: 'doji',
    family: 'candlestick',
    scope: 'single-candle',
    source: 'ta-lib-style',
    taLibCode: 'CDLDOJI',
    span: 1,
    label: 'Doji',
    description: 'Open and close are nearly equal, showing local indecision.',
    direction: 'neutral',
    priority: 40,
    minConfidence: 0.58,
    tags: ['doji', 'indecision'],
}, dojiEvaluation);
export const DRAGONFLY_DOJI_PATTERN_DEFINITION = defineSingleCandlePattern({
    id: 'dragonfly-doji',
    kind: 'dragonfly-doji',
    family: 'candlestick',
    scope: 'single-candle',
    source: 'ta-lib-style',
    taLibCode: 'CDLDRAGONFLYDOJI',
    span: 1,
    label: 'Dragonfly Doji',
    description: 'Doji with a long lower shadow and little to no upper shadow.',
    direction: 'bullish',
    priority: 88,
    minConfidence: 0.66,
    tags: ['doji', 'rejection', 'bullish'],
}, (bar) => {
    const parts = {
        doji: dojiScore(bar),
        lowerShadow: scoreGreater(bar.lowerPct, 0.55, 0.86),
        upperShadow: scoreLess(bar.upperPct, 0.06, 0.16),
        bodyNearHigh: bodyNearHighScore(bar),
    };
    const confidence = weightedScore(parts, { doji: 3, lowerShadow: 2, upperShadow: 2, bodyNearHigh: 1 });
    if (confidence <= 0)
        return null;
    return {
        direction: 'bullish',
        confidence,
        scoreBreakdown: parts,
    };
});
export const GRAVESTONE_DOJI_PATTERN_DEFINITION = defineSingleCandlePattern({
    id: 'gravestone-doji',
    kind: 'gravestone-doji',
    family: 'candlestick',
    scope: 'single-candle',
    source: 'ta-lib-style',
    taLibCode: 'CDLGRAVESTONEDOJI',
    span: 1,
    label: 'Gravestone Doji',
    description: 'Doji with a long upper shadow and little to no lower shadow.',
    direction: 'bearish',
    priority: 88,
    minConfidence: 0.66,
    tags: ['doji', 'rejection', 'bearish'],
}, (bar) => {
    const parts = {
        doji: dojiScore(bar),
        upperShadow: scoreGreater(bar.upperPct, 0.55, 0.86),
        lowerShadow: scoreLess(bar.lowerPct, 0.06, 0.16),
        bodyNearLow: bodyNearLowScore(bar),
    };
    const confidence = weightedScore(parts, { doji: 3, upperShadow: 2, lowerShadow: 2, bodyNearLow: 1 });
    if (confidence <= 0)
        return null;
    return {
        direction: 'bearish',
        confidence,
        scoreBreakdown: parts,
    };
});
export const LONG_LEGGED_DOJI_PATTERN_DEFINITION = defineSingleCandlePattern({
    id: 'long-legged-doji',
    kind: 'long-legged-doji',
    family: 'candlestick',
    scope: 'single-candle',
    source: 'ta-lib-style',
    taLibCode: 'CDLLONGLEGGEDDOJI',
    span: 1,
    label: 'Long-Legged Doji',
    description: 'Doji with both upper and lower shadows extended beyond normal noise.',
    direction: 'neutral',
    priority: 82,
    minConfidence: 0.68,
    tags: ['doji', 'volatility', 'indecision'],
}, (bar) => {
    const parts = {
        doji: dojiScore(bar),
        upperShadow: scoreGreater(bar.upperPct, 0.28, 0.48),
        lowerShadow: scoreGreater(bar.lowerPct, 0.28, 0.48),
        range: scoreGreater(bar.rangeRatio, 0.85, 1.8),
    };
    const confidence = weightedScore(parts, { doji: 3, upperShadow: 2, lowerShadow: 2, range: 1 });
    if (confidence <= 0)
        return null;
    return {
        direction: 'neutral',
        confidence,
        scoreBreakdown: parts,
    };
});
export const RICKSHAW_MAN_PATTERN_DEFINITION = defineSingleCandlePattern({
    id: 'rickshaw-man',
    kind: 'rickshaw-man',
    family: 'candlestick',
    scope: 'single-candle',
    source: 'ta-lib-style',
    taLibCode: 'CDLRICKSHAWMAN',
    span: 1,
    label: 'Rickshaw Man',
    description: 'Long-legged doji with the body centered near the middle of the range.',
    direction: 'neutral',
    priority: 90,
    minConfidence: 0.7,
    tags: ['doji', 'volatility', 'balanced'],
}, (bar) => {
    const center = bodyCenterLocation(bar);
    const parts = {
        doji: dojiScore(bar),
        upperShadow: scoreGreater(bar.upperPct, 0.26, 0.46),
        lowerShadow: scoreGreater(bar.lowerPct, 0.26, 0.46),
        centeredBody: scoreLess(Math.abs(center - 0.5), 0.08, 0.22),
        balancedShadows: wickBalanceScore(bar),
    };
    const confidence = weightedScore(parts, { doji: 3, upperShadow: 2, lowerShadow: 2, centeredBody: 2, balancedShadows: 1 });
    if (confidence <= 0)
        return null;
    return {
        direction: 'neutral',
        confidence,
        scoreBreakdown: parts,
    };
});
export const TAKURI_PATTERN_DEFINITION = defineSingleCandlePattern({
    id: 'takuri',
    kind: 'takuri',
    family: 'candlestick',
    scope: 'single-candle',
    source: 'ta-lib-style',
    taLibCode: 'CDLTAKURI',
    span: 1,
    label: 'Takuri',
    description: 'Dragonfly-style doji with an exceptionally long lower shadow.',
    direction: 'bullish',
    priority: 94,
    minConfidence: 0.72,
    tags: ['doji', 'rejection', 'bullish'],
}, (bar) => {
    const parts = {
        doji: dojiScore(bar),
        lowerShadow: scoreGreater(bar.lowerPct, 0.72, 0.92),
        upperShadow: scoreLess(bar.upperPct, 0.05, 0.14),
        bodyNearHigh: bodyNearHighScore(bar),
        range: scoreGreater(bar.rangeRatio, 0.85, 1.7),
    };
    const confidence = weightedScore(parts, { doji: 3, lowerShadow: 3, upperShadow: 2, bodyNearHigh: 1, range: 1 });
    if (confidence <= 0)
        return null;
    return {
        direction: 'bullish',
        confidence,
        scoreBreakdown: parts,
    };
});
export const MARUBOZU_PATTERN_DEFINITION = defineSingleCandlePattern({
    id: 'marubozu',
    kind: 'marubozu',
    family: 'candlestick',
    scope: 'single-candle',
    source: 'ta-lib-style',
    taLibCode: 'CDLMARUBOZU',
    span: 1,
    label: 'Marubozu',
    description: 'Large directional body with both shadows nearly absent.',
    direction: 'dynamic',
    priority: 86,
    minConfidence: 0.72,
    tags: ['marubozu', 'momentum'],
}, (bar) => {
    const direction = directionalBar(bar);
    if (!direction)
        return null;
    const parts = {
        bodyPct: scoreGreater(bar.bodyPct, 0.72, 0.94),
        bodyRatio: scoreGreater(bar.bodyRatio, 0.85, 1.65),
        upperShadow: scoreLess(bar.upperPct, 0.05, 0.14),
        lowerShadow: scoreLess(bar.lowerPct, 0.05, 0.14),
    };
    const confidence = weightedScore(parts, { bodyPct: 2, bodyRatio: 1, upperShadow: 1.5, lowerShadow: 1.5 });
    if (confidence <= 0)
        return null;
    return {
        direction,
        confidence,
        label: `${directionLabel(direction)} Marubozu`,
        scoreBreakdown: parts,
    };
});
export const OPENING_MARUBOZU_PATTERN_DEFINITION = defineSingleCandlePattern({
    id: 'opening-marubozu',
    kind: 'opening-marubozu',
    family: 'candlestick',
    scope: 'single-candle',
    source: 'ta-lib-style',
    taLibCode: 'CDLOPENINGMARUBOZU',
    span: 1,
    label: 'Opening Marubozu',
    description: 'Long directional candle with no meaningful shadow from the open.',
    direction: 'dynamic',
    priority: 78,
    minConfidence: 0.68,
    tags: ['marubozu', 'momentum'],
}, (bar) => {
    const direction = directionalBar(bar);
    if (!direction)
        return null;
    const parts = {
        body: longBodyScore(bar),
        openingShadow: scoreLess(openingShadowPct(bar, direction), 0.05, 0.16),
        closingShadow: scoreLess(closingShadowPct(bar, direction), 0.22, 0.38),
    };
    const confidence = weightedScore(parts, { body: 2, openingShadow: 2, closingShadow: 1 });
    if (confidence <= 0)
        return null;
    return {
        direction,
        confidence,
        label: `${directionLabel(direction)} Opening Marubozu`,
        scoreBreakdown: parts,
    };
});
export const CLOSING_MARUBOZU_PATTERN_DEFINITION = defineSingleCandlePattern({
    id: 'closing-marubozu',
    kind: 'closing-marubozu',
    family: 'candlestick',
    scope: 'single-candle',
    source: 'ta-lib-style',
    taLibCode: 'CDLCLOSINGMARUBOZU',
    span: 1,
    label: 'Closing Marubozu',
    description: 'Long directional candle with no meaningful shadow from the close.',
    direction: 'dynamic',
    priority: 78,
    minConfidence: 0.68,
    tags: ['marubozu', 'momentum'],
}, (bar) => {
    const direction = directionalBar(bar);
    if (!direction)
        return null;
    const parts = {
        body: longBodyScore(bar),
        closingShadow: scoreLess(closingShadowPct(bar, direction), 0.05, 0.16),
        openingShadow: scoreLess(openingShadowPct(bar, direction), 0.22, 0.38),
    };
    const confidence = weightedScore(parts, { body: 2, closingShadow: 2, openingShadow: 1 });
    if (confidence <= 0)
        return null;
    return {
        direction,
        confidence,
        label: `${directionLabel(direction)} Closing Marubozu`,
        scoreBreakdown: parts,
    };
});
export const BELT_HOLD_PATTERN_DEFINITION = defineSingleCandlePattern({
    id: 'belt-hold',
    kind: 'belt-hold',
    family: 'candlestick',
    scope: 'single-candle',
    source: 'ta-lib-style',
    taLibCode: 'CDLBELTHOLD',
    span: 1,
    label: 'Belt Hold',
    description: 'Long candle that opens at one extreme and drives directionally away from it.',
    direction: 'dynamic',
    priority: 76,
    minConfidence: 0.7,
    tags: ['momentum', 'opening-shadow'],
}, (bar) => {
    const direction = directionalBar(bar);
    if (!direction)
        return null;
    const closeControl = direction === 'bullish'
        ? scoreGreater(bar.closeLocation, 0.62, 0.9)
        : scoreLess(bar.closeLocation, 0.1, 0.38);
    const parts = {
        body: longBodyScore(bar),
        openingShadow: scoreLess(openingShadowPct(bar, direction), 0.05, 0.15),
        closeControl,
    };
    const confidence = weightedScore(parts, { body: 2, openingShadow: 2, closeControl: 1 });
    if (confidence <= 0)
        return null;
    return {
        direction,
        confidence,
        label: `${directionLabel(direction)} Belt Hold`,
        scoreBreakdown: parts,
    };
});
export const LONG_LINE_PATTERN_DEFINITION = defineSingleCandlePattern({
    id: 'long-line',
    kind: 'long-line',
    family: 'candlestick',
    scope: 'single-candle',
    source: 'ta-lib-style',
    taLibCode: 'CDLLONGLINE',
    span: 1,
    label: 'Long Line',
    description: 'Directional candle with a long real body and relatively short shadows.',
    direction: 'dynamic',
    priority: 62,
    minConfidence: 0.68,
    tags: ['momentum', 'long-body'],
}, (bar) => {
    const parts = {
        bodyPct: scoreGreater(bar.bodyPct, 0.5, 0.76),
        bodyRatio: scoreGreater(bar.bodyRatio, 0.85, 1.65),
        upperShadow: scoreLess(bar.upperPct, 0.18, 0.34),
        lowerShadow: scoreLess(bar.lowerPct, 0.18, 0.34),
    };
    const evaluation = directionalLongBodyEvaluation(bar, parts, { bodyPct: 2, bodyRatio: 1, upperShadow: 1, lowerShadow: 1 });
    if (!evaluation || evaluation.confidence <= 0)
        return null;
    return {
        direction: evaluation.direction,
        confidence: evaluation.confidence,
        label: `${directionLabel(evaluation.direction)} Long Line`,
        scoreBreakdown: parts,
    };
});
export const SHORT_LINE_PATTERN_DEFINITION = defineSingleCandlePattern({
    id: 'short-line',
    kind: 'short-line',
    family: 'candlestick',
    scope: 'single-candle',
    source: 'ta-lib-style',
    taLibCode: 'CDLSHORTLINE',
    span: 1,
    label: 'Short Line',
    description: 'Small directional candle with short real body and short shadows.',
    direction: 'dynamic',
    priority: 58,
    minConfidence: 0.66,
    tags: ['small-body', 'quiet'],
}, (bar) => {
    const direction = directionalBar(bar);
    if (!direction)
        return null;
    const parts = {
        smallBody: scoreLess(bar.bodyRatio, 0.72, 1.25),
        notDoji: scoreGreater(bar.bodyPct, 0.08, 0.18),
        upperShadow: scoreLess(bar.upperPct, 0.2, 0.38),
        lowerShadow: scoreLess(bar.lowerPct, 0.2, 0.38),
        compactRange: scoreLess(bar.rangeRatio, 0.9, 1.45),
    };
    const confidence = weightedScore(parts, { smallBody: 2, notDoji: 1, upperShadow: 1, lowerShadow: 1, compactRange: 1 });
    if (confidence <= 0)
        return null;
    return {
        direction,
        confidence,
        label: `${directionLabel(direction)} Short Line`,
        scoreBreakdown: parts,
    };
});
export const SINGLE_CANDLE_TA_PATTERN_DEFINITIONS = [
    TAKURI_PATTERN_DEFINITION,
    RICKSHAW_MAN_PATTERN_DEFINITION,
    DRAGONFLY_DOJI_PATTERN_DEFINITION,
    GRAVESTONE_DOJI_PATTERN_DEFINITION,
    LONG_LEGGED_DOJI_PATTERN_DEFINITION,
    MARUBOZU_PATTERN_DEFINITION,
    OPENING_MARUBOZU_PATTERN_DEFINITION,
    CLOSING_MARUBOZU_PATTERN_DEFINITION,
    BELT_HOLD_PATTERN_DEFINITION,
    LONG_LINE_PATTERN_DEFINITION,
    SHORT_LINE_PATTERN_DEFINITION,
    DOJI_PATTERN_DEFINITION,
];
export function detectSingleCandleTaPatterns(bar, options = {}) {
    const minConfidence = options.minConfidence ?? 0.58;
    return SINGLE_CANDLE_TA_PATTERN_DEFINITIONS
        .map((definition) => ({ definition, match: definition.detect(bar) }))
        .filter(({ definition, match }) => {
        if (!match)
            return false;
        return options.includeWeak || match.confidence >= Math.max(minConfidence, definition.minConfidence);
    })
        .sort((a, b) => b.definition.priority - a.definition.priority || b.match.confidence - a.match.confidence)
        .map(({ match }) => match);
}
//# sourceMappingURL=single.js.map