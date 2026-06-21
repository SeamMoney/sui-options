import type { CandleDirection, CandleFeature, CandleInput, CandlePatternDetectorOptions, CandlePatternEvent, CandlePatternKind } from '../../types';
export type SwingKind = 'high' | 'low';
export type SwingPoint = {
    kind: SwingKind;
    index: number;
    time: number;
    price: number;
    strength: number;
    prominence: number;
};
export type SwingExtractionOptions = {
    leftBars?: number;
    rightBars?: number;
    minSwingDistance?: number;
    minProminencePct?: number;
    maxSwings?: number;
};
export type StructurePatternDetectionOptions = CandlePatternDetectorOptions & SwingExtractionOptions & {
    maxBars?: number;
    minBars?: number;
    maxPatternAgeBars?: number;
    maxEventsPerKind?: number;
};
export type StructurePatternCandidate = Omit<CandlePatternEvent, 'id' | 'detectedAt' | 'source' | 'color'> & {
    color?: string;
};
export type StructurePatternDetectorContext = {
    features: CandleFeature[];
    swings: SwingPoint[];
    options: RequiredStructurePatternOptions;
};
export type StructurePatternDetector = {
    kind: CandlePatternKind;
    label: string;
    direction: CandleDirection;
    minBars: number;
    minSwings: number;
    detect: (context: StructurePatternDetectorContext) => StructurePatternCandidate[];
};
type RequiredStructurePatternOptions = Required<Omit<StructurePatternDetectionOptions, keyof CandlePatternDetectorOptions>> & Required<CandlePatternDetectorOptions>;
export declare function extractSwings(candles: CandleInput[], options?: SwingExtractionOptions): SwingPoint[];
export declare const STRUCTURE_PATTERN_DETECTORS: StructurePatternDetector[];
export declare function detectStructurePatternsFromFeatures(features: CandleFeature[], options?: StructurePatternDetectionOptions): CandlePatternEvent[];
export declare function detectStructurePatterns(candles: CandleInput[], options?: StructurePatternDetectionOptions): CandlePatternEvent[];
export {};
//# sourceMappingURL=swing.d.ts.map