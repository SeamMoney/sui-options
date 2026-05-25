import { renderPatternOverlay, type PatternOverlayOptions } from '../renderers/pattern-overlay';
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
  useMediaCoordinateSpace: (
    callback: (scope: {
      context: CanvasRenderingContext2D;
      mediaSize: { width: number; height: number };
    }) => void,
  ) => void;
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
export class LightweightChartsPatternOverlayPrimitive {
  private chart: LightweightChartApiLike | null = null;
  private series: LightweightSeriesApiLike | null = null;
  private requestUpdate: (() => void) | null = null;
  private candles: readonly CandleInput[];
  private events: readonly CandlePatternEvent[];
  private readonly options: PatternOverlayOptions;
  private readonly firstSeen = new Map<string, number>();
  private spotlightEventId: string | null = null;

  private readonly paneView: LightweightPaneView = {
    zOrder: () => 'top',
    renderer: () => ({
      draw: (target) => {
        target.useMediaCoordinateSpace(({ context, mediaSize }) => {
          this.draw(context, mediaSize);
        });
      },
    }),
  };

  constructor(candles: readonly CandleInput[] = [], events: readonly CandlePatternEvent[] = [], options: PatternOverlayOptions = {}) {
    this.candles = candles;
    this.events = events;
    this.options = options;
    this.markSeen(events);
  }

  setData(candles: readonly CandleInput[], events: readonly CandlePatternEvent[]) {
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

  setSpotlight(eventId: string | null) {
    this.spotlightEventId = eventId;
    this.updateAllViews();
  }

  attached(param: LightweightPrimitiveAttachedParams) {
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

  private draw(ctx: CanvasRenderingContext2D, mediaSize: { width: number; height: number }) {
    if (!this.chart || !this.series) return;
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

  private markSeen(events: readonly CandlePatternEvent[]) {
    const now = getNow();
    for (const event of events) {
      if (!this.firstSeen.has(event.id)) this.firstSeen.set(event.id, now);
    }
  }
}

export function createLightweightChartsPatternOverlay(
  series: LightweightSeriesApiLike,
  chart: unknown,
  options: LightweightChartsPatternOverlayOptions = {},
): LightweightChartsPatternOverlayHandle {
  const { candles = [], events = [], autoAttach = true, ...overlayOptions } = options;
  const primitive = new LightweightChartsPatternOverlayPrimitive(candles, events, overlayOptions);
  const primitiveHost = series as LightweightSeriesApiLike & {
    attachPrimitive?: (primitive: unknown) => void;
    detachPrimitive?: (primitive: unknown) => void;
  };

  if (autoAttach) {
    if (typeof primitiveHost.attachPrimitive === 'function') {
      primitiveHost.attachPrimitive(primitive);
    } else {
      primitive.attached({ chart: chart as LightweightChartApiLike, series });
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
