import { renderPatternOverlay } from '../renderers/pattern-overlay.js';
/**
 * Lightweight Charts custom-series primitive for rendering Candle Vision pattern overlays.
 *
 * This class intentionally depends on the Lightweight Charts primitive shape through
 * structural types only. Applications that install `lightweight-charts` can pass real
 * chart and candlestick series instances without making it a hard dependency of this
 * package.
 */
export class LightweightChartsPatternOverlayPrimitive {
    chart = null;
    series = null;
    requestUpdate = null;
    candles;
    events;
    options;
    firstSeen = new Map();
    spotlightEventId = null;
    paneView = {
        zOrder: () => 'top',
        renderer: () => ({
            draw: (target) => {
                target.useMediaCoordinateSpace(({ context, mediaSize }) => {
                    this.draw(context, mediaSize);
                });
            },
        }),
    };
    constructor(candles = [], events = [], options = {}) {
        this.candles = candles;
        this.events = events;
        this.options = options;
        this.markSeen(events);
    }
    setData(candles, events) {
        this.candles = candles;
        this.events = events;
        this.markSeen(events);
        this.updateAllViews();
    }
    replay() {
        this.firstSeen.clear();
        this.markSeen(this.events);
        this.updateAllViews();
    }
    setSpotlight(eventId) {
        this.spotlightEventId = eventId;
        this.updateAllViews();
    }
    attached(param) {
        this.chart = param.chart;
        this.series = param.series;
        this.requestUpdate = param.requestUpdate ?? null;
        this.updateAllViews();
    }
    detached() {
        this.chart = null;
        this.series = null;
        this.requestUpdate = null;
    }
    paneViews() {
        return [this.paneView];
    }
    updateAllViews() {
        this.requestUpdate?.();
    }
    draw(ctx, mediaSize) {
        if (!this.chart || !this.series)
            return;
        renderPatternOverlay(ctx, {
            candles: this.candles,
            events: this.events,
            mediaSize,
            firstSeen: this.firstSeen,
            spotlightEventId: this.spotlightEventId,
            logicalToCoordinate: (index) => this.chart?.timeScale().logicalToCoordinate(index) ?? null,
            priceToCoordinate: (price) => this.series?.priceToCoordinate(price) ?? null,
        }, this.options);
    }
    markSeen(events) {
        const now = getNow();
        for (const event of events) {
            if (!this.firstSeen.has(event.id))
                this.firstSeen.set(event.id, now);
        }
    }
}
export function createLightweightChartsPatternOverlay(series, chart, options = {}) {
    const { candles = [], events = [], autoAttach = true, ...overlayOptions } = options;
    const primitive = new LightweightChartsPatternOverlayPrimitive(candles, events, overlayOptions);
    const primitiveHost = series;
    if (autoAttach) {
        if (typeof primitiveHost.attachPrimitive === 'function') {
            primitiveHost.attachPrimitive(primitive);
        }
        else {
            primitive.attached({ chart: chart, series });
        }
    }
    return {
        primitive,
        setData: (nextCandles, nextEvents) => primitive.setData(nextCandles, nextEvents),
        setSpotlight: (eventId) => primitive.setSpotlight(eventId),
        replay: () => primitive.replay(),
        update: () => primitive.updateAllViews(),
        detach: () => {
            if (typeof primitiveHost.detachPrimitive === 'function') {
                primitiveHost.detachPrimitive(primitive);
            }
            primitive.detached();
        },
    };
}
function getNow() {
    return typeof performance === 'undefined' ? Date.now() : performance.now();
}
//# sourceMappingURL=lightweight-charts.js.map