import type { CandleInput, CandlePatternEvent, CandlePatternTheme } from '../types';
export type PatternOverlayOptions = {
    theme?: Partial<CandlePatternTheme>;
    showLabels?: boolean;
    showConfidence?: boolean;
    showBoxTags?: boolean;
    showPins?: boolean;
    showClusters?: boolean;
    maxLabels?: number;
    maxEvents?: number;
    maxActiveBoxes?: number;
    maxPins?: number;
    maxBoxOverlapRatio?: number;
    boxCollisionPaddingPx?: number;
    minDisplayConfidence?: number;
    fillOpacity?: number;
    strokeOpacity?: number;
    scanlineOpacity?: number;
    labelCollisionPadding?: number;
    activeTtlMs?: number;
    collapsedTtlMs?: number;
    eventFadeOutMs?: number;
    clusterRadiusPx?: number;
    labelRightInsetPx?: number;
};
export type PatternOverlayRenderContext = {
    candles: readonly CandleInput[];
    events: readonly CandlePatternEvent[];
    mediaSize: {
        width: number;
        height: number;
    };
    now?: number;
    firstSeen?: ReadonlyMap<string, number>;
    spotlightEventId?: string | null;
    logicalToCoordinate: (index: number) => number | null;
    priceToCoordinate: (price: number) => number | null;
};
type ResolvedPatternOverlayOptions = Required<Omit<PatternOverlayOptions, 'theme'>> & {
    theme: CandlePatternTheme;
};
export declare function resolvePatternOverlayOptions(options?: PatternOverlayOptions): ResolvedPatternOverlayOptions;
export declare function renderPatternOverlay(ctx: CanvasRenderingContext2D, renderContext: PatternOverlayRenderContext, options?: PatternOverlayOptions): void;
export {};
//# sourceMappingURL=pattern-overlay.d.ts.map