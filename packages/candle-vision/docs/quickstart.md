# Quickstart

`@sui-options/candle-vision` scans OHLCV candles and returns renderer-neutral pattern events. Each event includes a pattern kind, direction, confidence, strength, status, color, candle indexes, and price/time anchors that chart adapters can draw.

## 1. Install

```bash
npm install @sui-options/candle-vision
```

For React:

```bash
npm install @sui-options/candle-vision @sui-options/candle-vision-react react react-dom
```

## 2. Prepare Candles

Candles must be sorted oldest to newest. `time` is numeric so consumers can use Unix seconds, Unix milliseconds, or an exchange bar index. Use the same unit consistently in your renderer.

```ts
import type { CandleInput } from '@sui-options/candle-vision';

const candles: CandleInput[] = [
  { time: 1717000000, open: 100, high: 104, low: 98, close: 103, volume: 1200 },
  { time: 1717000060, open: 103, high: 105, low: 99, close: 100, volume: 1350 },
  { time: 1717000120, open: 99, high: 108, low: 97, close: 107, volume: 2100 },
];
```

## 3. Detect Patterns

```ts
import { detectUnifiedCandlePatterns } from '@sui-options/candle-vision';

const events = detectUnifiedCandlePatterns(candles, {
  lookback: 240,
  minConfidence: 0.6,
  includeWeak: false,
});
```

Use `detectLatestCandlePatterns` when your UI only needs signals ending on the latest candle.

```ts
import { detectLatestCandlePatterns } from '@sui-options/candle-vision';

const latestEvents = detectLatestCandlePatterns(candles, {
  minConfidence: 0.58,
});
```

## 4. Rank Visible Signals

Detection can return overlapping signals. Ranking helpers score events by confidence, strength, status, recency, family, and category so renderers can avoid noisy overlays.

```ts
import { rankVisiblePatternSignals } from '@sui-options/candle-vision';

const visibleSignals = rankVisiblePatternSignals(events, {
  latestIndex: candles.length - 1,
  maxVisible: 10,
  minVisibleScore: 0.58,
  allowOverlaps: false,
});

const visibleEvents = visibleSignals.map((signal) => signal.event);
```

## 5. Render From Anchors

Every event has anchors with candle index, time, price, and role.

```ts
for (const event of visibleEvents) {
  const confirmation = event.anchors.find((anchor) => anchor.role === 'confirmation');

  console.log({
    label: event.label,
    direction: event.direction,
    color: event.color,
    startIndex: event.startIndex,
    endIndex: event.endIndex,
    price: confirmation?.price,
  });
}
```

## 6. Add React UI

`@sui-options/candle-vision-react` wraps the core scanner with hooks and small presentational components.

```tsx
import {
  PatternStatsPanel,
  SignalList,
  useCandleVisionScanner,
  type CandleInput,
} from '@sui-options/candle-vision-react';

export function PatternPanel({ candles }: { candles: CandleInput[] }) {
  const scanner = useCandleVisionScanner(candles, {
    lookback: 240,
    minConfidence: 0.6,
    ranking: { maxVisible: 10 },
  });

  return (
    <section>
      <PatternStatsPanel stats={scanner.stats} ranking={scanner.ranking} />
      <SignalList signals={scanner.visibleSignals} />
    </section>
  );
}
```

## 7. Add A Lightweight Charts Overlay

Use the Lightweight Charts overlay adapter when you want shaded pattern spans and labels drawn directly on the chart pane.

```ts
import {
  createLightweightChartsPatternOverlay,
} from '@sui-options/candle-vision/overlay-lightweight-charts';

const overlay = createLightweightChartsPatternOverlay(series, chart, {
  candles,
  events: visibleEvents,
  maxLabels: 8,
});

overlay.setData(nextCandles, nextVisibleEvents);
```

See the [renderer guide](./renderer-guide.md) for marker, span, and overlay adapter details. Use `detectCandlePatterns` when you want the core detector name directly; `detectUnifiedCandlePatterns` is the broader public entry point used by examples.

## 8. Run The Simulated Micro-Bot

Use `createMicroBotState` and `updateMicroBot` when you want a streaming paper-trading layer. The bot watches pattern evidence, enters only after the signal reaches a confirmed phase, and exits by target, stop, pressure flip, or the configured hold window.

```ts
import {
  createMicroBotState,
  detectUnifiedCandlePatterns,
  decideTradeFromEvents,
  updateMicroBot,
  type MicroBotState,
} from '@sui-options/candle-vision';

let bot: MicroBotState = createMicroBotState();

export function onCandles(nextCandles: CandleInput[]) {
  const events = detectUnifiedCandlePatterns(nextCandles, {
    lookback: 240,
    minConfidence: 0.56,
    includeWeak: true,
  });
  const decision = decideTradeFromEvents(events, nextCandles, nextCandles.length - 1);

  bot = updateMicroBot({
    state: bot,
    candles: nextCandles,
    events,
    decision,
    nowMs: performance.now(),
    options: {
      minHoldMs: 5000,
      maxHoldMs: 10000,
      entryThreshold: 0.4,
    },
  });

  return bot;
}
```

## 9. Backtest The Same Rules

`backtestMicroBot` replays candles through the same detector, decision layer, and bot state machine. Use it to tune thresholds before exposing an automated trading experience.

```ts
import { backtestMicroBot } from '@sui-options/candle-vision';

const report = backtestMicroBot(historicalCandles, {
  detector: { lookback: 240, minConfidence: 0.56, includeWeak: true },
  bot: { minHoldMs: 5000, maxHoldMs: 10000, entryThreshold: 0.4 },
});

console.table(report.trades);
console.log(report.summary);
```

The bot/backtest APIs are simulation tools. They do not execute real orders.

## 10. Calibrate Presets

Use `calibrateMicroBot` to compare several built-in scalp profiles on the same candle history.

```ts
import { calibrateMicroBot } from '@sui-options/candle-vision';

const calibration = calibrateMicroBot(historicalCandles, {
  warmupBars: 32,
  minTrades: 3,
});

const best = calibration.best;
console.log(best?.preset.label, best?.score, best?.expectancy);
```

The returned rows are sorted best-first and include score, PnL, win rate, expectancy, drawdown, trade count, and the full backtest result for each preset.

## 11. Run Walk-Forward Validation

`walkForwardMicroBot` repeatedly picks the best preset on a train window, then evaluates it on the next unseen test window. This is the better panel to show users when you want to avoid a fake "best preset" that only fit the latest history.

```ts
import { walkForwardMicroBot } from '@sui-options/candle-vision';

const validation = walkForwardMicroBot(historicalCandles, {
  trainBars: 90,
  testBars: 30,
  stepBars: 30,
  warmupBars: 24,
});

console.log(validation.summary);
console.table(validation.folds.map((fold) => ({
  fold: fold.index + 1,
  preset: fold.preset.label,
  oosPnl: fold.test.summary.pnl,
  oosWinRate: fold.test.summary.winRate,
})));
```

The summary reports out-of-sample PnL, win rate, drawdown, positive folds, and stability.

## 12. Get One Strategy Verdict

Use `evaluateMicroBotStrategy` when the UI needs one clear status instead of raw calibration tables.

```ts
import { evaluateMicroBotStrategy } from '@sui-options/candle-vision';

const lab = evaluateMicroBotStrategy(historicalCandles, {
  minBars: 96,
  minOutOfSampleTrades: 4,
});

console.log(lab.verdict.status, lab.verdict.score);
console.log(lab.verdict.reasons);
```

The status is `hot`, `watch`, `reject`, or `warming-up`. It is still paper-trading research output, not an execution command.
