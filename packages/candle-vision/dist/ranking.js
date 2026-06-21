import { CANDLE_PATTERN_REGISTRY, } from './registry.js';
const DEFAULT_STATUS_WEIGHTS = {
    confirmed: 1,
    forming: 0.82,
    invalidated: 0,
    expired: 0.16,
};
const DEFAULT_CATEGORY_WEIGHTS = {
    candlestick: 1,
    'vision-candle': 1.08,
    'chart-pattern': 0.96,
    'technical-indicator': 0.92,
};
function clamp01(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.min(1, Math.max(0, value));
}
function overlap(a, b) {
    return a.startIndex <= b.endIndex && b.startIndex <= a.endIndex;
}
function countBy(items, key) {
    return items.reduce((counts, item) => {
        const value = key(item);
        counts.set(value, (counts.get(value) ?? 0) + 1);
        return counts;
    }, new Map());
}
function scoreSignal(event, definition, latestIndex, options) {
    const confidence = clamp01(event.confidence);
    const strength = clamp01(event.strength);
    const statusWeight = options.statusWeights?.[event.status] ?? DEFAULT_STATUS_WEIGHTS[event.status] ?? 0;
    const rawScore = clamp01(confidence * 0.58 + strength * 0.34 + statusWeight * 0.08);
    const category = definition?.category;
    const familyWeight = options.familyWeights?.[event.family] ?? 1;
    const categoryWeight = category
        ? options.categoryWeights?.[category] ?? DEFAULT_CATEGORY_WEIGHTS[category] ?? 1
        : 0.84;
    const recencyWindow = Math.max(1, options.recencyWindow ?? 120);
    const distance = Math.max(0, latestIndex - event.endIndex);
    const recency = Math.max(0.35, 1 - distance / recencyWindow);
    const visibleScore = clamp01(rawScore * recency * familyWeight * categoryWeight);
    return { rawScore, visibleScore };
}
function canShowSignal(signal, selected, options) {
    const reasons = [];
    if (!signal.supported)
        reasons.push('unsupported');
    if (signal.visibleScore < options.minVisibleScore)
        reasons.push('below-visible-score');
    if (signal.event.status === 'invalidated')
        reasons.push('invalidated');
    if (signal.event.status === 'expired')
        reasons.push('expired');
    const kindCounts = countBy(selected, (item) => item.event.kind);
    if ((kindCounts.get(signal.event.kind) ?? 0) >= options.perKindLimit)
        reasons.push('kind-limit');
    const familyCounts = countBy(selected, (item) => item.event.family);
    if ((familyCounts.get(signal.event.family) ?? 0) >= options.perFamilyLimit)
        reasons.push('family-limit');
    if (!options.allowOverlaps && selected.some((item) => overlap(item.event, signal.event)))
        reasons.push('overlap');
    return reasons;
}
export function rankPatternSignals(events, options = {}) {
    const registry = options.registry ?? CANDLE_PATTERN_REGISTRY;
    const latestIndex = options.latestIndex ?? events.reduce((latest, event) => Math.max(latest, event.endIndex), 0);
    const visibilityOptions = {
        allowOverlaps: options.allowOverlaps ?? false,
        perKindLimit: options.perKindLimit ?? 2,
        perFamilyLimit: options.perFamilyLimit ?? 8,
        minVisibleScore: options.minVisibleScore ?? 0.58,
    };
    const raw = events
        .map((event) => {
        const definition = registry.get(event.kind);
        const support = definition?.support ?? 'unknown';
        const supported = support === 'supported';
        const scores = scoreSignal(event, definition, latestIndex, options);
        const reasons = supported ? [] : ['unsupported'];
        return {
            event,
            definition,
            category: definition?.category,
            support,
            supported,
            visible: false,
            rawScore: scores.rawScore,
            visibleScore: scores.visibleScore,
            rawRank: 0,
            reasons,
        };
    })
        .sort((a, b) => b.rawScore - a.rawScore || b.event.confidence - a.event.confidence || b.event.endIndex - a.event.endIndex)
        .map((signal, index) => ({ ...signal, rawRank: index + 1 }));
    const supported = raw.filter((signal) => signal.supported);
    const unsupported = raw.filter((signal) => !signal.supported);
    const visible = [];
    for (const signal of supported.slice().sort((a, b) => b.visibleScore - a.visibleScore || b.rawScore - a.rawScore)) {
        const reasons = canShowSignal(signal, visible, visibilityOptions);
        if (reasons.length) {
            signal.reasons = [...new Set([...signal.reasons, ...reasons])];
            continue;
        }
        visible.push({
            ...signal,
            visible: true,
            visibleRank: visible.length + 1,
            reasons: ['visible'],
        });
        if (visible.length >= (options.maxVisible ?? 12))
            break;
    }
    const visibleById = new Map(visible.map((signal) => [signal.event.id, signal]));
    const rankedRaw = raw.map((signal) => visibleById.get(signal.event.id) ?? signal);
    const rankedSupported = rankedRaw.filter((signal) => signal.supported);
    const rankedUnsupported = rankedRaw.filter((signal) => !signal.supported);
    return {
        raw: rankedRaw,
        supported: rankedSupported,
        unsupported: rankedUnsupported,
        visible,
    };
}
export function rankVisiblePatternSignals(events, options = {}) {
    return rankPatternSignals(events, options).visible;
}
export function selectVisiblePatternEvents(events, options = {}) {
    return rankVisiblePatternSignals(events, options).map((signal) => signal.event);
}
//# sourceMappingURL=ranking.js.map