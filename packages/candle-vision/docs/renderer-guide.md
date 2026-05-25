# Renderer Guide

`@sui-options/candle-vision` returns event objects that contain enough geometry for adapters to draw labels, markers, spans, and guide lines in any renderer.

## Rendering Contract

Renderers usually need four fields:

```ts
type RenderablePattern = {
  id: string;
  label: string;
  color: string;
  startIndex: number;
  endIndex: number;
  anchors: {
    index: number;
    time: number;
    price: number;
    role: string;
  }[];
};
```

Use `startIndex` and `endIndex` to shade a candle span. Use anchors for exact marker placement.

## Anchor Roles

| Role | Use |
| --- | --- |
| `start` | Start of the detected pattern span. |
| `end` | Optional end marker for custom events. |
| `high` | Highest candle high in the pattern span. |
| `low` | Lowest candle low in the pattern span. |
| `body-high` | Optional body high for custom events. |
| `body-low` | Optional body low for custom events. |
| `confirmation` | Preferred label or marker location. |
| `invalidation` | Optional risk or failure level for custom events. |

Built-in events always include start, high, low, and confirmation anchors.

## Marker Placement

A simple adapter can place bullish labels below the candle, bearish labels above it, and neutral labels at the confirmation anchor.

```ts
import type { CandlePatternEvent } from '@sui-options/candle-vision';

function markerFor(event: CandlePatternEvent) {
  const confirmation = event.anchors.find((anchor) => anchor.role === 'confirmation');
  const high = event.anchors.find((anchor) => anchor.role === 'high');
  const low = event.anchors.find((anchor) => anchor.role === 'low');

  const anchor = event.direction === 'bearish'
    ? high ?? confirmation
    : event.direction === 'bullish'
      ? low ?? confirmation
      : confirmation;

  return anchor
    ? {
        id: event.id,
        time: anchor.time,
        price: anchor.price,
        text: event.label,
        color: event.color,
      }
    : undefined;
}
```

## Lightweight Charts Markers

Lightweight Charts series markers are time-based. Keep candle `time` compatible with the chart series time values.

```ts
import type { CandlePatternEvent } from '@sui-options/candle-vision';

function toSeriesMarker(event: CandlePatternEvent) {
  const confirmation = event.anchors.find((anchor) => anchor.role === 'confirmation');
  if (!confirmation) return undefined;

  return {
    time: confirmation.time,
    position: event.direction === 'bearish' ? 'aboveBar' : 'belowBar',
    color: event.color,
    shape: event.direction === 'bearish' ? 'arrowDown' : 'arrowUp',
    text: event.label,
  } as const;
}
```

## Lightweight Charts Overlay Adapter

For richer overlays, use the package adapter instead of converting events to markers yourself. It draws spans, anchors, and labels from ranked Candle Vision events while leaving chart ownership inside the application.

```ts
import {
  detectUnifiedCandlePatterns,
  rankVisiblePatternSignals,
  type CandleInput,
} from '@sui-options/candle-vision';
import {
  createLightweightChartsPatternOverlay,
} from '@sui-options/candle-vision/overlay-lightweight-charts';

function attachPatternOverlay({
  candles,
  chart,
  series,
}: {
  candles: CandleInput[];
  chart: unknown;
  series: unknown;
}) {
  const events = detectUnifiedCandlePatterns(candles, {
    lookback: 240,
    minConfidence: 0.6,
  });

  const visibleEvents = rankVisiblePatternSignals(events, {
    latestIndex: candles.length - 1,
    maxVisible: 10,
    allowOverlaps: false,
  }).map((signal) => signal.event);

  return createLightweightChartsPatternOverlay(series, chart, {
    candles,
    events: visibleEvents,
    maxLabels: 8,
  });
}
```

The returned handle supports `setData(nextCandles, nextEvents)`, `update()`, and `detach()`. For live charts, keep the handle in a ref and call `setData` after candle or detector output changes.

## Span Overlays

For Canvas or SVG renderers, convert candle indexes to x coordinates and prices to y coordinates in the host chart.

```ts
function eventBox(event: CandlePatternEvent, xForIndex: (index: number) => number, yForPrice: (price: number) => number) {
  const high = event.anchors.find((anchor) => anchor.role === 'high');
  const low = event.anchors.find((anchor) => anchor.role === 'low');
  if (!high || !low) return undefined;

  const x1 = xForIndex(event.startIndex);
  const x2 = xForIndex(event.endIndex);
  const y1 = yForPrice(high.price);
  const y2 = yForPrice(low.price);

  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
    color: event.color,
  };
}
```

## Recommended Flow

1. Run `detectUnifiedCandlePatterns` on sorted candles.
2. Run `rankVisiblePatternSignals` or `selectVisiblePatternEvents`.
3. Convert visible events into renderer-specific markers and spans.
4. Keep raw ranked events available for detail panels, tooltips, and debug views.

For live charts, run `detectLatestCandlePatterns` on each closed candle when you only need new signals. Run a wider `detectCandlePatterns` pass when loading history or changing detector options.

## Production Notes

- Keep candle order stable and oldest-to-newest before every scan.
- Use ranking limits before rendering chart overlays; raw detector output can include overlapping signals.
- Treat chart adapter handles as lifecycle resources and detach them when the chart or series is disposed.
- Keep `time` values consistent between Candle Vision candles and Lightweight Charts series data.
