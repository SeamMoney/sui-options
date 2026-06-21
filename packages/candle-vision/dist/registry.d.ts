import type { CandleDirection, CandleInput, CandlePatternDetectorOptions, CandlePatternEvent, CandlePatternFamily, CandlePatternKind } from './types';
export type PatternCategory = 'candlestick' | 'vision-candle' | 'chart-pattern' | 'technical-indicator';
export type PatternSupportStatus = 'supported' | 'planned';
export type PatternDetectorContext = {
    definition: PatternDefinition;
    registry: PatternRegistry;
    options: CandlePatternDetectorOptions;
};
export type PatternDetector = (candles: CandleInput[], context: PatternDetectorContext) => CandlePatternEvent[];
export type PatternFamilyMetadata = {
    family: CandlePatternFamily;
    category: PatternCategory;
    label: string;
    description: string;
    color: string;
    displayOrder: number;
};
export type PatternCategoryMetadata = {
    category: PatternCategory;
    label: string;
    description: string;
    color: string;
    displayOrder: number;
};
export type PatternDefinition = {
    kind: CandlePatternKind;
    family: CandlePatternFamily;
    category: PatternCategory;
    direction: CandleDirection;
    label: string;
    description: string;
    minBars: number;
    support: PatternSupportStatus;
    detector?: PatternDetector;
    aliases?: string[];
    tags?: string[];
};
export type PatternRegistryOptions = {
    definitions?: PatternDefinition[];
    familyMetadata?: PatternFamilyMetadata[];
    categoryMetadata?: PatternCategoryMetadata[];
};
export declare const PATTERN_CATEGORY_METADATA: Record<PatternCategory, PatternCategoryMetadata>;
export declare const PATTERN_FAMILY_METADATA: Record<CandlePatternFamily, PatternFamilyMetadata>;
export declare function createPatternDefinition(entry: {
    kind: CandlePatternKind;
    family: CandlePatternFamily;
    direction: CandleDirection;
    label: string;
    description: string;
}, overrides?: Partial<PatternDefinition>): PatternDefinition;
export declare const CANDLE_PATTERN_DEFINITIONS: PatternDefinition[];
export declare class PatternRegistry {
    private readonly definitionsByKind;
    private readonly familyMetadataByFamily;
    private readonly categoryMetadataByCategory;
    constructor(options?: PatternRegistryOptions);
    all(): PatternDefinition[];
    get(kind: CandlePatternKind): PatternDefinition | undefined;
    has(kind: CandlePatternKind): boolean;
    supported(): PatternDefinition[];
    planned(): PatternDefinition[];
    byFamily(family: CandlePatternFamily): PatternDefinition[];
    byCategory(category: PatternCategory): PatternDefinition[];
    isSupported(kind: CandlePatternKind): boolean;
    familyMetadata(family: CandlePatternFamily): PatternFamilyMetadata | undefined;
    categoryMetadata(category: PatternCategory): PatternCategoryMetadata | undefined;
    register(definition: PatternDefinition): PatternRegistry;
    registerMany(definitions: PatternDefinition[]): PatternRegistry;
}
export declare const CANDLE_PATTERN_REGISTRY: PatternRegistry;
export declare function createPatternRegistry(options?: PatternRegistryOptions): PatternRegistry;
export declare function getPatternDefinition(kind: CandlePatternKind, registry?: PatternRegistry): PatternDefinition | undefined;
export declare function isSupportedPatternKind(kind: CandlePatternKind, registry?: PatternRegistry): boolean;
//# sourceMappingURL=registry.d.ts.map