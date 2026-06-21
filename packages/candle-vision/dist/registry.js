import { CANDLE_VISION_PATTERN_CATALOG } from './catalog.js';
export const PATTERN_CATEGORY_METADATA = {
    candlestick: {
        category: 'candlestick',
        label: 'Candlestick',
        description: 'Single and multi-candle Japanese candlestick structures.',
        color: '#facc15',
        displayOrder: 10,
    },
    'vision-candle': {
        category: 'vision-candle',
        label: 'Vision Candle',
        description: 'Shape and sequence detectors tuned for candle-vision overlays.',
        color: '#38bdf8',
        displayOrder: 20,
    },
    'chart-pattern': {
        category: 'chart-pattern',
        label: 'Chart Pattern',
        description: 'Multi-swing support, resistance, continuation, and reversal structures.',
        color: '#a78bfa',
        displayOrder: 30,
    },
    'technical-indicator': {
        category: 'technical-indicator',
        label: 'Technical Indicator',
        description: 'Indicator-derived signals such as moving averages, RSI, MACD, bands, volume, ATR, and VWAP.',
        color: '#fb923c',
        displayOrder: 40,
    },
};
export const PATTERN_FAMILY_METADATA = {
    candlestick: {
        family: 'candlestick',
        category: 'candlestick',
        label: 'Candlestick',
        description: 'Single and multi-candle Japanese candlestick structures.',
        color: PATTERN_CATEGORY_METADATA.candlestick.color,
        displayOrder: 10,
    },
    'vision-candle': {
        family: 'vision-candle',
        category: 'vision-candle',
        label: 'Vision Candle',
        description: 'Computer-vision style candle shape and run detectors.',
        color: PATTERN_CATEGORY_METADATA['vision-candle'].color,
        displayOrder: 20,
    },
    'chart-setup': {
        family: 'chart-setup',
        category: 'chart-pattern',
        label: 'Chart Setup',
        description: 'Chart structures and technical-analysis setup signals.',
        color: PATTERN_CATEGORY_METADATA['chart-pattern'].color,
        displayOrder: 30,
    },
};
const SUPPORTED_PATTERN_KINDS = new Set([
    'doji',
    'dragonfly-doji',
    'gravestone-doji',
    'long-legged-doji',
    'rickshaw-man',
    'takuri',
    'hammer',
    'hanging-man',
    'inverted-hammer',
    'shooting-star',
    'spinning-top',
    'high-wave',
    'marubozu',
    'opening-marubozu',
    'closing-marubozu',
    'belt-hold',
    'long-line',
    'short-line',
    'engulfing',
    'harami',
    'two-crows',
    'counterattack',
    'doji-star',
    'harami-cross',
    'homing-pigeon',
    'in-neck',
    'matching-low',
    'on-neck',
    'separating-lines',
    'thrusting',
    'tasuki-gap',
    'upside-gap-two-crows',
    'piercing-line',
    'dark-cloud-cover',
    'morning-star',
    'evening-star',
    'three-white-soldiers',
    'three-black-crows',
    'three-inside',
    'three-outside',
    'three-line-strike',
    'three-stars-in-south',
    'abandoned-baby',
    'advance-block',
    'breakaway',
    'concealing-baby-swallow',
    'identical-three-crows',
    'kicking',
    'kicking-by-length',
    'ladder-bottom',
    'mat-hold',
    'rising-three-methods',
    'falling-three-methods',
    'stalled-pattern',
    'stick-sandwich',
    'tristar',
    'unique-three-river',
    'upside-gap-three-methods',
    'downside-gap-three-methods',
    'vision-rejection',
    'vision-momentum',
    'vision-compression',
    'support-retest',
    'resistance-retest',
    'range-breakout',
    'range-breakdown',
    'double-top',
    'double-bottom',
    'head-and-shoulders',
    'inverse-head-and-shoulders',
    'ascending-triangle',
    'descending-triangle',
    'symmetrical-triangle',
    'rising-wedge',
    'falling-wedge',
    'bull-flag',
    'bear-flag',
    'channel-up',
    'channel-down',
    'cup-and-handle',
    'ma-golden-cross',
    'ma-death-cross',
    'rsi-overbought',
    'rsi-oversold',
    'macd-bull-cross',
    'macd-bear-cross',
    'bollinger-squeeze',
    'bollinger-breakout',
    'volume-climax',
    'atr-expansion',
    'vwap-reclaim',
    'vwap-rejection',
]);
const TECHNICAL_INDICATOR_KINDS = new Set([
    'ma-golden-cross',
    'ma-death-cross',
    'rsi-overbought',
    'rsi-oversold',
    'macd-bull-cross',
    'macd-bear-cross',
    'bollinger-squeeze',
    'bollinger-breakout',
    'volume-climax',
    'atr-expansion',
    'vwap-reclaim',
    'vwap-rejection',
]);
function minBarsFor(kind, family) {
    if (family === 'candlestick') {
        if (kind.startsWith('three-') || kind === 'morning-star' || kind === 'evening-star')
            return 3;
        if (kind === 'engulfing' || kind === 'harami' || kind === 'piercing-line' || kind === 'dark-cloud-cover')
            return 2;
        return 1;
    }
    if (family === 'vision-candle')
        return kind === 'vision-compression' ? 6 : 1;
    if (kind.includes('head-and-shoulders') || kind === 'cup-and-handle')
        return 24;
    if (kind.includes('triangle') || kind.includes('wedge') || kind.includes('channel') || kind.endsWith('flag'))
        return 18;
    if (TECHNICAL_INDICATOR_KINDS.has(kind))
        return 20;
    return 8;
}
function categoryFor(kind, family) {
    if (family === 'candlestick')
        return 'candlestick';
    if (family === 'vision-candle')
        return 'vision-candle';
    if (TECHNICAL_INDICATOR_KINDS.has(kind))
        return 'technical-indicator';
    return 'chart-pattern';
}
function tagsFor(kind, family, direction, category) {
    const tags = new Set([family, category, direction]);
    if (SUPPORTED_PATTERN_KINDS.has(kind))
        tags.add('implemented');
    if (kind.includes('rejection') || kind.includes('retest'))
        tags.add('level');
    if (kind.includes('breakout') || kind.includes('breakdown'))
        tags.add('breakout');
    if (kind.includes('cross'))
        tags.add('crossover');
    if (kind.includes('wedge') || kind.includes('triangle') || kind.includes('flag') || kind.includes('channel'))
        tags.add('continuation');
    if (kind.includes('top') || kind.includes('bottom') || kind.includes('shoulders'))
        tags.add('reversal');
    return Array.from(tags);
}
export function createPatternDefinition(entry, overrides = {}) {
    const category = overrides.category ?? categoryFor(entry.kind, entry.family);
    return {
        kind: entry.kind,
        family: entry.family,
        category,
        direction: entry.direction,
        label: entry.label,
        description: entry.description,
        minBars: minBarsFor(entry.kind, entry.family),
        support: SUPPORTED_PATTERN_KINDS.has(entry.kind) ? 'supported' : 'planned',
        tags: tagsFor(entry.kind, entry.family, entry.direction, category),
        ...overrides,
    };
}
export const CANDLE_PATTERN_DEFINITIONS = CANDLE_VISION_PATTERN_CATALOG.map((entry) => createPatternDefinition(entry));
function mapByKey(items, key) {
    return new Map(items.map((item) => [item[key], item]));
}
export class PatternRegistry {
    definitionsByKind;
    familyMetadataByFamily;
    categoryMetadataByCategory;
    constructor(options = {}) {
        const definitions = options.definitions ?? CANDLE_PATTERN_DEFINITIONS;
        this.definitionsByKind = new Map(definitions.map((definition) => [definition.kind, definition]));
        this.familyMetadataByFamily = mapByKey(options.familyMetadata ?? Object.values(PATTERN_FAMILY_METADATA), 'family');
        this.categoryMetadataByCategory = mapByKey(options.categoryMetadata ?? Object.values(PATTERN_CATEGORY_METADATA), 'category');
    }
    all() {
        return Array.from(this.definitionsByKind.values());
    }
    get(kind) {
        return this.definitionsByKind.get(kind);
    }
    has(kind) {
        return this.definitionsByKind.has(kind);
    }
    supported() {
        return this.all().filter((definition) => definition.support === 'supported');
    }
    planned() {
        return this.all().filter((definition) => definition.support === 'planned');
    }
    byFamily(family) {
        return this.all().filter((definition) => definition.family === family);
    }
    byCategory(category) {
        return this.all().filter((definition) => definition.category === category);
    }
    isSupported(kind) {
        return this.get(kind)?.support === 'supported';
    }
    familyMetadata(family) {
        return this.familyMetadataByFamily.get(family);
    }
    categoryMetadata(category) {
        return this.categoryMetadataByCategory.get(category);
    }
    register(definition) {
        return new PatternRegistry({
            definitions: [...this.all().filter((item) => item.kind !== definition.kind), definition],
            familyMetadata: Array.from(this.familyMetadataByFamily.values()),
            categoryMetadata: Array.from(this.categoryMetadataByCategory.values()),
        });
    }
    registerMany(definitions) {
        return definitions.reduce((registry, definition) => registry.register(definition), this);
    }
}
export const CANDLE_PATTERN_REGISTRY = new PatternRegistry();
export function createPatternRegistry(options = {}) {
    return new PatternRegistry(options);
}
export function getPatternDefinition(kind, registry = CANDLE_PATTERN_REGISTRY) {
    return registry.get(kind);
}
export function isSupportedPatternKind(kind, registry = CANDLE_PATTERN_REGISTRY) {
    return registry.isSupported(kind);
}
//# sourceMappingURL=registry.js.map