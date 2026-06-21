import { type PatternOverlayOptions } from '../renderers/pattern-overlay';
import type { CandleInput, CandlePatternEvent } from '../types';
export type LightweightChartsPatternOverlayOptions = PatternOverlayOptions & {
    candles?: readonly CandleInput[];
    events?: readonly CandlePatternEvent[];
    autoAttach?: boolean;
};
type LightweightChartApiLike = {
    timeScale(): {
        logicalToCoordinate(logical: number): number | null;
    };
};
type LightweightSeriesApiLike = {
    priceToCoordinate(price: number): number | null;
};
type LightweightPrimitiveAttachedParams = {
    chart: LightweightChartApiLike;
    series: LightweightSeriesApiLike;
    requestUpdate?: () => void;
};
type CanvasRenderingTarget2D = {
    useMediaCoordinateSpace: (callback: (scope: {
        context: CanvasRenderingContext2D;
        mediaSize: {
            width: number;
            height: number;
        };
    }) => void) => void;
};
type LightweightPaneRenderer = {
    draw: (target: CanvasRenderingTarget2D) => void;
};
type LightweightPaneView = {
    zOrder: () => 'top';
    renderer: () => LightweightPaneRenderer;
};
export type LightweightChartsPatternOverlayHandle = {
    primitive: LightweightChartsPatternOverlayPrimitive;
    setData: (candles: readonly CandleInput[], events: readonly CandlePatternEvent[]) => void;
    setSpotlight: (eventId: string | null) => void;
    replay: () => void;
    update: () => void;
    detach: () => void;
};
/**
 * Lightweight Charts custom-series primitive for rendering Candle Vision pattern overlays.
 *
 * This class intentionally depends on the Lightweight Charts primitive shape through
 * structural types only. Applications that install `lightweight-charts` can pass real
 * chart and candlestick series instances without making it a hard dependency of this
 * package.
 */
export declare class LightweightChartsPatternOverlayPrimitive {
    private chart;
    private series;
    private requestUpdate;
    private candles;
    private events;
    private readonly options;
    private readonly firstSeen;
    private spotlightEventId;
    private readonly paneView;
    constructor(candles?: readonly CandleInput[], events?: readonly CandlePatternEvent[], options?: PatternOverlayOptions);
    setData(candles: readonly CandleInput[], events: readonly CandlePatternEvent[]): void;
    replay(): void;
    setSpotlight(eventId: string | null): void;
    attached(param: LightweightPrimitiveAttachedParams): void;
    detached(): void;
    paneViews(): LightweightPaneView[];
    updateAllViews(): void;
    private draw;
    private markSeen;
}
export declare function createLightweightChartsPatternOverlay(series: LightweightSeriesApiLike, chart: unknown, options?: LightweightChartsPatternOverlayOptions): LightweightChartsPatternOverlayHandle;
export {};
//# sourceMappingURL=lightweight-charts.d.ts.map