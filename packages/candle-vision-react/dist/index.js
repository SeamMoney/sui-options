import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useState, } from 'react';
import { detectUnifiedCandlePatterns, rankPatternSignals, } from '@sui-options/candle-vision';
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
const EMPTY_CANDLES = [];
const PANEL_STYLE = {
    display: 'grid',
    gap: 12,
    color: '#e5e7eb',
    background: '#111827',
    border: '1px solid rgba(148, 163, 184, 0.22)',
    borderRadius: 8,
    padding: 14,
};
const GRID_STYLE = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(104px, 1fr))',
    gap: 8,
};
const STAT_STYLE = {
    display: 'grid',
    gap: 4,
    minWidth: 0,
    border: '1px solid rgba(148, 163, 184, 0.16)',
    borderRadius: 6,
    padding: '8px 10px',
    background: 'rgba(15, 23, 42, 0.72)',
};
const LIST_STYLE = {
    display: 'grid',
    gap: 8,
    listStyle: 'none',
    margin: 0,
    padding: 0,
};
const SIGNAL_STYLE = {
    display: 'grid',
    gap: 6,
    minWidth: 0,
    border: '1px solid rgba(148, 163, 184, 0.16)',
    borderRadius: 8,
    padding: 10,
    background: '#0f172a',
};
function clampPercent(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.max(0, Math.min(100, Math.round(value * 100)));
}
function defaultFormatPercent(value) {
    return `${clampPercent(value)}%`;
}
function computeStats(events, ranking) {
    const byFamily = { ...EMPTY_FAMILY_COUNTS };
    const byStatus = { ...EMPTY_STATUS_COUNTS };
    let bullish = 0;
    let bearish = 0;
    let neutral = 0;
    let confidenceTotal = 0;
    let strengthTotal = 0;
    for (const event of events) {
        byFamily[event.family] += 1;
        byStatus[event.status] += 1;
        confidenceTotal += event.confidence;
        strengthTotal += event.strength;
        if (event.direction === 'bullish')
            bullish += 1;
        else if (event.direction === 'bearish')
            bearish += 1;
        else
            neutral += 1;
    }
    return {
        total: events.length,
        visible: ranking.visible.length,
        supported: ranking.supported.length,
        unsupported: ranking.unsupported.length,
        bullish,
        bearish,
        neutral,
        byFamily,
        byStatus,
        averageConfidence: events.length ? confidenceTotal / events.length : 0,
        averageStrength: events.length ? strengthTotal / events.length : 0,
    };
}
/**
 * Run the full scan → rank → stats pipeline once, with no React. The pure core
 * that `useCandleVisionScanner` memoizes — exported so non-React consumers
 * (keeper, bots, a server-side coach endpoint) get the same bundled result
 * (events, ranking, visible signals, stats) in a single call.
 */
export function scanCandles(candles, options = {}) {
    const { ranking: rankingOptions, ...detectorOptions } = options;
    const events = detectUnifiedCandlePatterns(candles, detectorOptions);
    const latestIndex = candles.length > 0 ? candles.length - 1 : undefined;
    const ranking = rankPatternSignals(events, {
        latestIndex,
        ...rankingOptions,
    });
    return {
        candles,
        events,
        ranking,
        visibleSignals: ranking.visible,
        visibleEvents: ranking.visible.map((signal) => signal.event),
        latestEvent: events.at(-1),
        stats: computeStats(events, ranking),
    };
}
export function useCandleVisionScanner(candles, options = {}) {
    return useMemo(() => scanCandles(candles, options), [candles, options]);
}
export function usePatternStream(options = {}) {
    const { initialCandles = EMPTY_CANDLES, maxCandles, ...scannerOptions } = options;
    const [candles, setCandles] = useState(() => trimCandles(initialCandles, maxCandles));
    useEffect(() => {
        setCandles(trimCandles(initialCandles, maxCandles));
    }, [initialCandles, maxCandles]);
    const appendCandle = useCallback((candle) => {
        setCandles((current) => trimCandles([...current, candle], maxCandles));
    }, [maxCandles]);
    const appendCandles = useCallback((nextCandles) => {
        setCandles((current) => trimCandles([...current, ...nextCandles], maxCandles));
    }, [maxCandles]);
    const replaceCandles = useCallback((nextCandles) => {
        setCandles(trimCandles(nextCandles, maxCandles));
    }, [maxCandles]);
    const clearCandles = useCallback(() => {
        setCandles([]);
    }, []);
    const scanner = useCandleVisionScanner(candles, scannerOptions);
    return {
        ...scanner,
        appendCandle,
        appendCandles,
        replaceCandles,
        clearCandles,
    };
}
function trimCandles(candles, maxCandles) {
    if (!maxCandles || candles.length <= maxCandles)
        return candles;
    return candles.slice(-maxCandles);
}
export function PatternStatsPanel({ stats, events, ranking, title = 'Pattern Stats', className, style, formatPercent = defaultFormatPercent, }) {
    const resolvedRanking = useMemo(() => ranking ?? rankPatternSignals(events ?? []), [events, ranking]);
    const resolvedStats = useMemo(() => stats ?? computeStats(events ?? [], resolvedRanking), [events, resolvedRanking, stats]);
    const statsItems = [
        ['Total', resolvedStats.total],
        ['Visible', resolvedStats.visible],
        ['Bullish', resolvedStats.bullish],
        ['Bearish', resolvedStats.bearish],
        ['Avg Confidence', formatPercent(resolvedStats.averageConfidence)],
        ['Avg Strength', formatPercent(resolvedStats.averageStrength)],
    ];
    return (_jsxs("section", { className: className, style: { ...PANEL_STYLE, ...style }, children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }, children: [_jsx("h3", { style: { margin: 0, fontSize: 14, lineHeight: 1.25, fontWeight: 700 }, children: title }), _jsxs("span", { style: { color: '#94a3b8', fontSize: 12 }, children: [resolvedStats.supported, " supported"] })] }), _jsx("div", { style: GRID_STYLE, children: statsItems.map(([label, value]) => (_jsxs("div", { style: STAT_STYLE, children: [_jsx("span", { style: { color: '#94a3b8', fontSize: 11 }, children: label }), _jsx("strong", { style: { overflowWrap: 'anywhere', fontSize: 18, lineHeight: 1.1 }, children: value })] }, label))) })] }));
}
export function SignalList({ signals, events, emptyState = 'No pattern signals', className, style, maxItems, showDescription = true, renderMeta, }) {
    const resolvedSignals = useMemo(() => signals ?? rankPatternSignals(events ?? []).visible, [events, signals]);
    const visibleSignals = typeof maxItems === 'number' ? resolvedSignals.slice(0, maxItems) : resolvedSignals;
    if (!visibleSignals.length) {
        return (_jsx("div", { className: className, style: { color: '#94a3b8', fontSize: 13, ...style }, children: emptyState }));
    }
    return (_jsx("ol", { className: className, style: { ...LIST_STYLE, ...style }, children: visibleSignals.map((signal) => (_jsxs("li", { style: { ...SIGNAL_STYLE, borderLeft: `3px solid ${signal.event.color}` }, children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }, children: [_jsxs("div", { style: { display: 'grid', gap: 3, minWidth: 0 }, children: [_jsx("strong", { style: { color: '#f8fafc', fontSize: 14, lineHeight: 1.25 }, children: signal.event.label }), _jsxs("span", { style: { color: '#94a3b8', fontSize: 12, textTransform: 'capitalize' }, children: [signal.event.direction, " - ", signal.category ?? signal.event.family] })] }), _jsx("span", { style: { color: signal.event.color, fontSize: 12, fontWeight: 700 }, children: defaultFormatPercent(signal.visibleScore) })] }), showDescription ? (_jsx("p", { style: { margin: 0, color: '#cbd5e1', fontSize: 12, lineHeight: 1.45 }, children: signal.event.description })) : null, renderMeta ? (_jsx("div", { style: { color: '#94a3b8', fontSize: 12 }, children: renderMeta(signal) })) : null] }, signal.event.id))) }));
}
