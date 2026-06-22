# @sui-options/candle-vision-react

React hooks and presentational components for the production Candle Vision scanner package.

Use this package when a React app needs ranked pattern signals, live candle streams, stats panels, or signal lists without wiring the scanner state by hand.

## Install

```bash
npm install @sui-options/candle-vision @sui-options/candle-vision-react react react-dom
```

`@sui-options/candle-vision` is a peer dependency because the React package delegates all detection and ranking to the core scanner.

## Function: `scanCandles` (no React)

The pure scan → rank → stats core that the hooks wrap. Use it from non-React
code (keeper, bots, a server-side coach endpoint) to get the same bundled result
in one call:

```ts
import { scanCandles } from '@sui-options/candle-vision-react';

const { events, ranking, visibleSignals, stats } = scanCandles(candles);
// stats: { total, visible, bullish, bearish, neutral, averageConfidence, … }
```

## Hook: `useCandleVisionScanner`

```tsx
import {
  PatternStatsPanel,
  SignalList,
  useCandleVisionScanner,
  type CandleInput,
} from '@sui-options/candle-vision-react';

export function PatternSidebar({ candles }: { candles: CandleInput[] }) {
  const scanner = useCandleVisionScanner(candles, {
    lookback: 240,
    minConfidence: 0.6,
    includeWeak: false,
    ranking: {
      maxVisible: 10,
      minVisibleScore: 0.58,
      allowOverlaps: false,
    },
  });

  return (
    <aside>
      <PatternStatsPanel stats={scanner.stats} ranking={scanner.ranking} />
      <SignalList signals={scanner.visibleSignals} />
    </aside>
  );
}
```

The hook returns:

- `events`: all detector events.
- `ranking`: full ranking result with supported, unsupported, and visible subsets.
- `visibleSignals`: ranked events ready for UI rendering.
- `visibleEvents`: event payloads from `visibleSignals`.
- `latestEvent`: newest emitted event when present.
- `stats`: totals by direction, status, family, and average confidence/strength.

## Hook: `usePatternStream`

Use `usePatternStream` for live feeds where candles arrive over time.

```tsx
import { usePatternStream } from '@sui-options/candle-vision-react';

const stream = usePatternStream({
  initialCandles,
  maxCandles: 500,
  lookback: 240,
  minConfidence: 0.6,
  ranking: { maxVisible: 10 },
});

stream.appendCandle(nextClosedCandle);
stream.replaceCandles(history);
stream.clearCandles();
```

The stream result includes the same scanner fields as `useCandleVisionScanner`, plus `appendCandle`, `appendCandles`, `replaceCandles`, and `clearCandles`.

## Components

### `PatternStatsPanel`

```tsx
<PatternStatsPanel stats={scanner.stats} ranking={scanner.ranking} />
```

Renders total events, visible events, supported events, bullish and bearish counts, average confidence, and average strength.

### `SignalList`

```tsx
<SignalList
  signals={scanner.visibleSignals}
  maxItems={8}
  renderMeta={(signal) => (
    <span>
      {signal.event.status} - {signal.event.kind}
    </span>
  )}
/>
```

Renders ranked visible signals with label, direction, family/category, score, optional description, and custom metadata.

## Lightweight Charts

The React package does not own chart instances. Use it to compute visible events, then pass those events into the core Lightweight Charts overlay adapter.

```tsx
import { useEffect, useRef } from 'react';
import {
  createLightweightChartsPatternOverlay,
  type LightweightChartsPatternOverlayHandle,
} from '@sui-options/candle-vision/overlay-lightweight-charts';
import { useCandleVisionScanner, type CandleInput } from '@sui-options/candle-vision-react';

export function PatternOverlayBridge({
  candles,
  chart,
  series,
}: {
  candles: CandleInput[];
  chart: unknown;
  series: unknown;
}) {
  const overlayRef = useRef<LightweightChartsPatternOverlayHandle | null>(null);
  const scanner = useCandleVisionScanner(candles, {
    lookback: 240,
    minConfidence: 0.6,
    ranking: { maxVisible: 10 },
  });

  useEffect(() => {
    if (!overlayRef.current) {
      overlayRef.current = createLightweightChartsPatternOverlay(series, chart, {
        candles,
        events: scanner.visibleEvents,
        maxLabels: 8,
      });
      return () => {
        overlayRef.current?.detach();
        overlayRef.current = null;
      };
    }

    overlayRef.current.setData(candles, scanner.visibleEvents);
  }, [candles, chart, scanner.visibleEvents, series]);

  return null;
}
```

## Release And Test Commands

From the repository root:

```bash
npm run build --workspace @sui-options/candle-vision-react
npm run typecheck --workspace @sui-options/candle-vision-react
npm run build --workspace @sui-options/candle-vision
npm run typecheck --workspace @sui-options/candle-vision
node scripts/candle-vision-release-check.mjs
```

## Production Readiness

- Hooks are pure React wrappers around the core scanner and ranking API.
- Components are optional and accept precomputed events, ranking, or stats so production apps can own layout and data flow.
- Stream state can be capped with `maxCandles` to bound work on live feeds.
- Keep detection options memoized in high-frequency dashboards to avoid unnecessary rescans.
- Candle Vision emits technical pattern signals for product and research UX. It is not financial advice.
