# @sui-options/candle-vision

Production TypeScript primitives for scanning OHLCV candles, ranking candle-pattern signals, and feeding chart overlays without tying detection logic to a renderer.

`@sui-options/candle-vision` is the core package. Use it in Node jobs, browser apps, chart adapters, tests, and React integrations. Pair it with [`@sui-options/candle-vision-react`](../candle-vision-react/README.md) when you want ready-made hooks and presentational components.

## Install

```bash
npm install @sui-options/candle-vision
```

For React dashboards:

```bash
npm install @sui-options/candle-vision @sui-options/candle-vision-react react react-dom
```

For Lightweight Charts overlays:

```bash
npm install @sui-options/candle-vision lightweight-charts
```

## Core Scan API

```ts
import {
  detectUnifiedCandlePatterns,
  rankVisiblePatternSignals,
  type CandleInput,
} from '@sui-options/candle-vision';

const candles: CandleInput[] = [
  { time: 1717000000, open: 100, high: 105, low: 98, close: 104, volume: 1200 },
  { time: 1717000060, open: 104, high: 106, low: 101, close: 102, volume: 1100 },
  { time: 1717000120, open: 101, high: 108, low: 99, close: 107, volume: 1800 },
];

const events = detectUnifiedCandlePatterns(candles, {
  lookback: 240,
  minConfidence: 0.6,
  includeWeak: false,
});

const visibleSignals = rankVisiblePatternSignals(events, {
  latestIndex: candles.length - 1,
  maxVisible: 8,
  allowOverlaps: false,
});

console.table(visibleSignals.map((signal) => ({
  rank: signal.visibleRank,
  kind: signal.event.kind,
  label: signal.event.label,
  confidence: signal.event.confidence.toFixed(2),
})));
```

Use `detectLatestCandlePatterns` for streaming UIs that only need events ending on the newest closed candle. Use `rankPatternSignals` when you need the full supported, unsupported, and visible ranking result.

## Simulated Micro-Bot And Backtests

The package also includes a deterministic paper-trading loop for product demos, research, and replay UX. It converts pattern/setup evidence into a forming -> confirmed -> entry -> exit lifecycle, with short hold windows, target/stop exits, pressure-flip exits, trade stats, and a matching backtest helper.

```ts
import {
  backtestMicroBot,
  calibrateMicroBot,
  createMicroBotState,
  detectUnifiedCandlePatterns,
  decideTradeFromEvents,
  updateMicroBot,
  walkForwardMicroBot,
} from '@sui-options/candle-vision';

let bot = createMicroBotState();

for (const nextCandles of liveWindows) {
  const events = detectUnifiedCandlePatterns(nextCandles, { lookback: 240 });
  const decision = decideTradeFromEvents(events, nextCandles, nextCandles.length - 1);
  bot = updateMicroBot({
    state: bot,
    candles: nextCandles,
    events,
    decision,
    nowMs: performance.now(),
    options: { minHoldMs: 5000, maxHoldMs: 10000, entryThreshold: 0.4 },
  });
}

const report = backtestMicroBot(historicalCandles, {
  bot: { minHoldMs: 5000, maxHoldMs: 10000 },
  detector: { lookback: 240, minConfidence: 0.56 },
});

const calibration = calibrateMicroBot(historicalCandles, {
  warmupBars: 32,
  minTrades: 3,
});

console.log(calibration.best?.preset.label, calibration.best?.expectancy);

const validation = walkForwardMicroBot(historicalCandles, {
  trainBars: 90,
  testBars: 30,
  stepBars: 30,
});

console.log(validation.summary.pnl, validation.summary.stability);
```

This bot is simulation infrastructure. It does not place real orders and should not be wired to real-money execution without separate risk controls, slippage modeling, venue integration, and compliance review.

For a one-call production path, use the scanner and presets:

```ts
import { createCandleVisionPreset, scanCandleVision } from '@sui-options/candle-vision';

const preset = createCandleVisionPreset({
  theme: 'tradingview-dark',
  overlay: 'computerVision',
  ranking: 'liveTrading',
});

const scan = scanCandleVision(candles, {
  lookback: 240,
  minConfidence: 0.6,
  ranking: preset.ranking,
});
```

## React Hooks And Components

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
    ranking: {
      maxVisible: 10,
      allowOverlaps: false,
    },
  });

  return (
    <aside>
      <PatternStatsPanel stats={scanner.stats} ranking={scanner.ranking} />
      <SignalList signals={scanner.visibleSignals} maxItems={10} />
    </aside>
  );
}
```

`usePatternStream` manages append, replace, trim, and clear operations for live candle feeds.

## Lightweight Charts Overlay Adapter

The core package includes a Lightweight Charts primitive adapter for drawing Candle Vision overlays above a candlestick series.

```ts
import {
  detectUnifiedCandlePatterns,
  rankVisiblePatternSignals,
} from '@sui-options/candle-vision';
import {
  createLightweightChartsPatternOverlay,
} from '@sui-options/candle-vision/overlay-lightweight-charts';

const events = detectUnifiedCandlePatterns(candles, {
  lookback: 240,
  minConfidence: 0.6,
});

const visibleEvents = rankVisiblePatternSignals(events, {
  latestIndex: candles.length - 1,
  maxVisible: 10,
}).map((signal) => signal.event);

const overlay = createLightweightChartsPatternOverlay(series, chart, {
  candles,
  events: visibleEvents,
  maxLabels: 8,
});

overlay.setData(nextCandles, nextVisibleEvents);
overlay.detach();
```

The adapter uses Lightweight Charts' structural primitive shape and keeps `lightweight-charts` as an application dependency instead of a hard dependency of the core scanner.

## Documentation

- [Quickstart](./docs/quickstart.md)
- [API guide](./docs/api.md)
- [Pattern catalog overview](./docs/pattern-catalog.md)
- [Renderer guide](./docs/renderer-guide.md)

## Examples

- [Plain TypeScript scan](./examples/plain-ts.ts)
- [React with Lightweight Charts](./examples/react-lightweight-charts.tsx)

## Release And Test Commands

From the repository root:

```bash
npm run build --workspace @sui-options/candle-vision
npm run typecheck --workspace @sui-options/candle-vision
npm run build --workspace @sui-options/candle-vision-react
npm run typecheck --workspace @sui-options/candle-vision-react
node scripts/candle-vision-release-check.mjs
```

The release check compiles detector regressions, verifies representative pattern fixtures, checks visible-ranking bounds, runs the package build, confirms declaration output, and validates runtime package imports.

## Production Readiness

- The scanner is renderer-neutral and side-effect free, so it can run in browser, worker, Node, test, and server-side rendering contexts.
- Candles are plain data objects and detector output is serializable, which makes events easy to cache, replay, diff, or inspect.
- Ranking helpers reduce overlay noise by applying confidence, strength, recency, status, family, overlap, and per-kind limits before UI rendering.
- TypeScript declarations are emitted from source and should be checked before publishing with the release commands above.
- Candle Vision produces technical pattern signals for product UX and research workflows. It is not financial advice and should be paired with application-level risk controls before production trading use.
