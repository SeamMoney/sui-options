# API Guide

This guide covers the public TypeScript API for `@sui-options/candle-vision`, the production core package used by scanner jobs, chart adapters, and React integrations.

## Data Model

### `CandleInput`

```ts
type CandleInput = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};
```

Candles should be ordered oldest to newest. `volume` is optional, but detectors that use volume context fall back to price-only scoring when it is missing.

### `CandlePatternEvent`

Pattern events are the main output from the detector.

```ts
type CandlePatternEvent = {
  id: string;
  kind: CandlePatternKind;
  family: 'candlestick' | 'vision-candle' | 'chart-setup';
  status: 'forming' | 'confirmed' | 'invalidated' | 'expired';
  direction: 'bullish' | 'bearish' | 'neutral';
  startIndex: number;
  endIndex: number;
  detectedAt: number;
  confidence: number;
  strength: number;
  label: string;
  description: string;
  source: 'candle-vision';
  anchors: CandlePatternAnchor[];
  color: string;
  scoreBreakdown?: Record<string, number>;
};
```

`confidence` describes how closely the shape matched. `strength` is available for renderer weighting and currently tracks the detector score for built-in events. `startIndex` and `endIndex` reference positions in the input candle array, including when a lookback window is used.

## Detection

### `detectUnifiedCandlePatterns(candles, options?)`

Primary scanner entry point for application code.

```ts
import { detectUnifiedCandlePatterns } from '@sui-options/candle-vision';

const events = detectUnifiedCandlePatterns(candles, {
  lookback: 240,
  minConfidence: 0.58,
  includeWeak: false,
  trendPeriod: 12,
  contextPeriod: 20,
  enableClassicPatterns: true,
  enableVisionPatterns: true,
  enableChartSetups: true,
  enableTaPatterns: true,
});
```

### `detectCandlePatterns(candles, options?)`

Core detector entry point. It scans the full input or the trailing `lookback` window.

```ts
import { detectCandlePatterns } from '@sui-options/candle-vision';

const events = detectCandlePatterns(candles, {
  lookback: 240,
  minConfidence: 0.58,
  includeWeak: false,
  trendPeriod: 12,
  contextPeriod: 20,
  enableClassicPatterns: true,
  enableVisionPatterns: true,
  enableChartSetups: true,
  enableTaPatterns: true,
});
```

`detectExpandedCandlePatterns` is also exported for call sites that want an explicit expanded-detector name.

### `detectLatestCandlePatterns(candles, options?)`

Returns events whose `endIndex` is the last candle.

```ts
const latest = detectLatestCandlePatterns(candles, {
  minConfidence: 0.62,
});
```

### `eventCandleRange(candles, event)`

Returns `{ low, high }` across the event span.

```ts
const range = eventCandleRange(candles, event);
```

## Ranking

### `rankPatternSignals(events, options?)`

Returns all ranked signals plus supported, unsupported, and visible subsets.

```ts
const ranking = rankPatternSignals(events, {
  latestIndex: candles.length - 1,
  maxVisible: 12,
  minVisibleScore: 0.58,
  recencyWindow: 120,
  allowOverlaps: false,
  perKindLimit: 2,
  perFamilyLimit: 8,
});

console.log(ranking.visible);
```

### `rankVisiblePatternSignals(events, options?)`

Shortcut for `rankPatternSignals(events, options).visible`.

### `selectVisiblePatternEvents(events, options?)`

Returns only the event payloads for visible signals.

```ts
const visibleEvents = selectVisiblePatternEvents(events, { maxVisible: 8 });
```

## Lightweight Charts Overlay Adapter

### `createLightweightChartsPatternOverlay(series, chart, options?)`

Creates and optionally attaches a Lightweight Charts primitive that renders Candle Vision pattern overlays over a candlestick series.

```ts
import {
  createLightweightChartsPatternOverlay,
} from '@sui-options/candle-vision/overlay-lightweight-charts';

const overlay = createLightweightChartsPatternOverlay(series, chart, {
  candles,
  events: visibleEvents,
  autoAttach: true,
  maxLabels: 8,
});

overlay.setData(nextCandles, nextVisibleEvents);
overlay.update();
overlay.detach();
```

The adapter is structurally typed against the chart and series APIs, so applications install and own the `lightweight-charts` dependency.

### `LightweightChartsPatternOverlayPrimitive`

Primitive class for applications that need to control attachment manually.

```ts
import {
  LightweightChartsPatternOverlayPrimitive,
} from '@sui-options/candle-vision/overlay-lightweight-charts';

const primitive = new LightweightChartsPatternOverlayPrimitive(candles, visibleEvents, {
  maxLabels: 8,
});

series.attachPrimitive?.(primitive);
```

### `LightweightChartsPatternOverlayHandle`

Handle returned by `createLightweightChartsPatternOverlay`.

```ts
type LightweightChartsPatternOverlayHandle = {
  primitive: LightweightChartsPatternOverlayPrimitive;
  setData: (candles: readonly CandleInput[], events: readonly CandlePatternEvent[]) => void;
  update: () => void;
  detach: () => void;
};
```

## Features

### `normalizeCandles(candles, contextPeriod?, trendPeriod?)`

Computes derived fields such as range, body size, wick percentages, range ratio, body ratio, volume ratio, direction, and trend direction.

```ts
const features = normalizeCandles(candles, 20, 12);
```

The exported helpers `bodyHigh`, `bodyLow`, `overlapsBody`, `scoreGreater`, and `scoreLess` are useful when implementing custom detectors.

## Simulated Micro-Bot

### `createMicroBotState(options?)`

Creates the deterministic paper-trading state machine used by streaming demos and replay tools.

```ts
import { createMicroBotState } from '@sui-options/candle-vision';

let state = createMicroBotState({
  enabled: true,
  minHoldMs: 5000,
  maxHoldMs: 10000,
});
```

### `updateMicroBot(input)`

Consumes the latest candle window, raw detected events, and trade decision verdict. It returns the next bot state, including the current signal phase, active position, closed trades, and aggregate stats.

```ts
import {
  decideTradeFromEvents,
  detectUnifiedCandlePatterns,
  updateMicroBot,
} from '@sui-options/candle-vision';

const events = detectUnifiedCandlePatterns(candles, { lookback: 240 });
const decision = decideTradeFromEvents(events, candles, candles.length - 1);

state = updateMicroBot({
  state,
  candles,
  events,
  decision,
  nowMs: performance.now(),
  options: {
    entryThreshold: 0.4,
    flipExitThreshold: 0.52,
    minHoldMs: 5000,
    maxHoldMs: 10000,
  },
});
```

The bot signal phase is one of `scanning`, `forming`, `confirmed`, or `blocked`. Positions close by `target`, `stop`, `pressure-flip`, or `time`.

### `setMicroBotEnabled(state, enabled)`

Toggles the paper bot without discarding its stats.

```ts
state = setMicroBotEnabled(state, false);
```

## Micro-Bot Backtesting

### `backtestMicroBot(candles, options?)`

Replays the same detector, decision, and bot state machine across historical candles.

```ts
import { backtestMicroBot } from '@sui-options/candle-vision';

const result = backtestMicroBot(candles, {
  detector: { lookback: 240, minConfidence: 0.56, includeWeak: true },
  bot: { minHoldMs: 5000, maxHoldMs: 10000, entryThreshold: 0.4 },
});

console.log(result.summary.pnl, result.summary.winRate, result.summary.maxDrawdown);
```

The result contains `state`, `trades`, `equityCurve`, and `summary`. These APIs are for simulation and research only; they do not place orders.

### `calibrateMicroBot(candles, options?)`

Runs multiple micro-bot presets over the same candle history and ranks them by a blended score: expectancy, win rate, profit factor, activity, and drawdown penalty.

```ts
import { calibrateMicroBot } from '@sui-options/candle-vision';

const calibration = calibrateMicroBot(candles, {
  warmupBars: 32,
  minTrades: 3,
});

console.table(calibration.rows.map((row) => ({
  preset: row.preset.label,
  score: row.score,
  pnl: row.pnl,
  winRate: row.winRate,
  expectancy: row.expectancy,
  trades: row.totalTrades,
})));
```

Use this before presenting a bot preset as active. It is a quick calibration pass, not a statistically complete strategy validation.

### `walkForwardMicroBot(candles, options?)`

Calibrates presets on a rolling train window, then runs the selected preset on the following out-of-sample test window.

```ts
import { walkForwardMicroBot } from '@sui-options/candle-vision';

const validation = walkForwardMicroBot(candles, {
  trainBars: 90,
  testBars: 30,
  stepBars: 30,
  warmupBars: 24,
});

console.table(validation.folds.map((fold) => ({
  fold: fold.index + 1,
  preset: fold.preset.label,
  trainScore: fold.trainScore,
  testPnl: fold.test.summary.pnl,
  testTrades: fold.test.summary.totalTrades,
})));

console.log(validation.summary.pnl, validation.summary.stability);
```

Use this after calibration when you need a stronger signal that a preset still works on candles it did not train on.

## Catalog And Registry

### `CANDLE_VISION_PATTERN_CATALOG`

Flat catalog entries for all known patterns.

```ts
const candlesticks = CANDLE_VISION_PATTERN_CATALOG.filter(
  (entry) => entry.family === 'candlestick',
);
```

### `CANDLE_PATTERN_REGISTRY`

Registry with definitions, categories, metadata, support state, min bar counts, aliases, and tags.

```ts
const supported = CANDLE_PATTERN_REGISTRY.supported();
const planned = CANDLE_PATTERN_REGISTRY.planned();
const definition = CANDLE_PATTERN_REGISTRY.get('hammer');
```

### `createPatternRegistry(options?)`

Creates a registry with custom definitions or metadata.

```ts
const registry = createPatternRegistry().register({
  kind: 'support-retest',
  family: 'chart-setup',
  category: 'chart-pattern',
  direction: 'bullish',
  label: 'Custom Support Retest',
  description: 'Desk-specific support retest rules.',
  minBars: 12,
  support: 'supported',
  tags: ['custom', 'level'],
});
```

### `createPatternShowcaseEvents(candles, catalog?)`

Creates deterministic showcase events from catalog entries. Use it for docs pages, visual QA, and empty-state pattern galleries, not live trading signals.

```ts
const showcaseEvents = createPatternShowcaseEvents(candles);
```

## React Package Surface

`@sui-options/candle-vision-react` re-exports the core candle and ranking types used by its hooks and components.

```tsx
import {
  PatternStatsPanel,
  SignalList,
  useCandleVisionScanner,
  usePatternStream,
  type CandleVisionScannerOptions,
  type CandleVisionScannerResult,
  type PatternStreamResult,
} from '@sui-options/candle-vision-react';
```

- `useCandleVisionScanner(candles, options?)` returns scanner output, ranking output, visible events, latest event, and aggregate stats.
- `usePatternStream(options?)` adds `appendCandle`, `appendCandles`, `replaceCandles`, and `clearCandles` for live feeds.
- `PatternStatsPanel` renders totals, visible count, direction counts, and average confidence/strength.
- `SignalList` renders ranked visible signals with optional descriptions and custom metadata.

## Release And Test Commands

From the repository root:

```bash
npm run build --workspace @sui-options/candle-vision
npm run typecheck --workspace @sui-options/candle-vision
npm run build --workspace @sui-options/candle-vision-react
npm run typecheck --workspace @sui-options/candle-vision-react
node scripts/candle-vision-release-check.mjs
```

Run the release check before publishing the packages. It compiles the regression harness, runs representative detector fixtures, verifies visible ranking behavior, builds declarations, and validates package imports.
