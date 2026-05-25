# Trade Decision Engine Regression Test Plan

## Scope

Add deterministic regression coverage beside `packages/candle-vision/test/release-regression.ts`. The current candle-vision release test is a plain `node:assert/strict` script that imports from `../src/index`, uses fixed `CandleInput[]` fixtures, and asserts public behavior only. Follow that shape for the trade decision engine: no network, no clocks except explicit fixture timestamps, no randomized candles.

Relevant candle-vision exports are available from `packages/candle-vision/src/index.ts` and package subpaths:

- `CandleInput`, `CandlePatternEvent`, `CandlePatternStatus`, and related public types.
- `detectUnifiedCandlePatterns`, `detectLatestCandlePatterns`, and `eventCandleRange`.
- `rankPatternSignals`, `rankVisiblePatternSignals`, and `selectVisiblePatternEvents`.

## Suggested Fixture Shapes

Use explicit fixtures instead of deriving critical bars implicitly:

```ts
type DecisionFixture = {
  name: string;
  nowIndex: number;
  candles: CandleInput[];
  patterns: CandlePatternEvent[];
  expected: {
    action: 'buy' | 'sell' | 'hold';
    direction?: 'bullish' | 'bearish';
    status: 'confirmed' | 'denied' | 'invalidated' | 'expired' | 'watching';
    reasonCodes: string[];
    entry?: number;
    stop?: number;
    score?: number;
  };
};
```

Keep candle bars in the existing candle-vision shape:

```ts
{ time: 6, open: 101, high: 106, low: 100, close: 105, volume: 1800 }
```

Keep pattern events in the exported `CandlePatternEvent` shape, with stable IDs and anchors:

```ts
{
  id: 'fixture:bullish-hammer-confirmed',
  kind: 'hammer',
  family: 'candlestick',
  status: 'confirmed',
  direction: 'bullish',
  startIndex: 4,
  endIndex: 5,
  detectedAt: 5,
  confidence: 0.86,
  strength: 0.78,
  label: 'Hammer',
  description: 'Fixture hammer at support',
  source: 'candle-vision',
  anchors: [
    { index: 5, time: 6, price: 96, role: 'low' },
    { index: 6, time: 7, price: 104, role: 'confirmation' },
    { index: 5, time: 6, price: 95.5, role: 'invalidation' },
  ],
  color: '#22c55e',
  scoreBreakdown: { pattern: 0.86, volume: 1.35, confluence: 0.7 },
}
```

## Regression Scenarios

### 1. Bullish Confirmation

Fixture: downtrend baseline, bullish reversal pattern, then a confirmation close above the pattern high/body-high with volume above local average.

Suggested candles:

```ts
[
  { time: 1, open: 110, high: 111, low: 106, close: 107, volume: 1000 },
  { time: 2, open: 107, high: 108, low: 103, close: 104, volume: 1050 },
  { time: 3, open: 104, high: 105, low: 100, close: 101, volume: 1100 },
  { time: 4, open: 101, high: 102, low: 97, close: 98, volume: 1150 },
  { time: 5, open: 98, high: 99, low: 94, close: 96, volume: 1200 },
  { time: 6, open: 96, high: 99, low: 90, close: 98.5, volume: 1500 },
  { time: 7, open: 98.5, high: 105, low: 98, close: 104, volume: 2100 },
]
```

Expected assertions:

- action is `buy`.
- status is `confirmed`.
- entry equals the confirmation close or configured breakout price.
- stop is below the invalidation anchor or pattern low.
- reason codes include `pattern_confirmed`, `volume_confirmed`, and `risk_defined`.

### 2. Bearish Confirmation

Fixture: uptrend baseline, bearish reversal pattern, then confirmation close below the pattern low/body-low with elevated volume.

Suggested candles:

```ts
[
  { time: 1, open: 90, high: 94, low: 89, close: 93, volume: 1000 },
  { time: 2, open: 93, high: 97, low: 92, close: 96, volume: 1050 },
  { time: 3, open: 96, high: 100, low: 95, close: 99, volume: 1100 },
  { time: 4, open: 99, high: 103, low: 98, close: 102, volume: 1150 },
  { time: 5, open: 102, high: 106, low: 101, close: 105, volume: 1200 },
  { time: 6, open: 105, high: 111, low: 104, close: 105.2, volume: 1500 },
  { time: 7, open: 105, high: 106, low: 97, close: 98, volume: 2200 },
]
```

Expected assertions:

- action is `sell`.
- status is `confirmed`.
- stop is above the invalidation anchor or pattern high.
- reason codes include `pattern_confirmed`, `volume_confirmed`, and `risk_defined`.

### 3. Denied By Volume

Use the bullish confirmation candle geometry from scenario 1, but set confirmation volume below the configured threshold, for example `volume: 900` against a prior baseline near `1200`.

Expected assertions:

- action is `hold`.
- status is `denied`.
- reason codes include `volume_below_threshold`.
- no entry is emitted, or `entry` is undefined/null by engine convention.
- the pattern remains available in diagnostics so callers can explain why the trade was skipped.

### 4. Invalidated By Close Through Stop

Fixture: a pending bullish watch with a defined stop at `95.5`, followed by a candle that closes below the stop.

Suggested tail candles:

```ts
[
  { time: 6, open: 96, high: 99, low: 90, close: 98.5, volume: 1500 },
  { time: 7, open: 98.5, high: 100, low: 95, close: 96.2, volume: 1300 },
  { time: 8, open: 96.2, high: 97, low: 93, close: 94.8, volume: 1700 },
]
```

Expected assertions:

- action is `hold`.
- status is `invalidated`.
- reason codes include `close_through_stop`.
- any prior watch/trade candidate is removed from eligible output.
- invalidation uses close price, not intrabar low alone, unless the engine explicitly supports intrabar stop mode.

### 5. Expired Watch

Fixture: a forming setup detected at index `5`, configured with `maxWatchBars: 3`, then bars `6`, `7`, and `8` fail to confirm or invalidate.

Suggested neutral follow-through:

```ts
[
  { time: 6, open: 96, high: 99, low: 90, close: 98.5, volume: 1500 },
  { time: 7, open: 98.5, high: 100, low: 96.5, close: 98.8, volume: 1150 },
  { time: 8, open: 98.8, high: 100.2, low: 97, close: 99.1, volume: 1125 },
  { time: 9, open: 99.1, high: 100.3, low: 97.2, close: 98.9, volume: 1100 },
]
```

Expected assertions:

- at `nowIndex: 8`, status is still `watching` if the expiry rule is inclusive.
- at `nowIndex: 9`, status is `expired`.
- action is `hold`.
- reason codes include `watch_expired`.
- no stale candidate can confirm after expiry without a new pattern event.

### 6. Confluence Scoring

Fixture: two otherwise similar bullish candidates, one with only a candle pattern and one with aligned support/TA/volume events. Feed both through the same scoring call.

Suggested pattern set:

```ts
[
  bullishHammerEvent,
  {
    id: 'fixture:support-retest',
    kind: 'support-retest',
    family: 'chart-setup',
    status: 'confirmed',
    direction: 'bullish',
    startIndex: 2,
    endIndex: 6,
    detectedAt: 6,
    confidence: 0.8,
    strength: 0.72,
    label: 'Support Retest',
    description: 'Fixture support confluence',
    source: 'candle-vision',
    anchors: [{ index: 6, time: 7, price: 96, role: 'confirmation' }],
    color: '#22c55e',
    scoreBreakdown: { support: 0.8 },
  },
  {
    id: 'fixture:vwap-reclaim',
    kind: 'vwap-reclaim',
    family: 'chart-setup',
    status: 'confirmed',
    direction: 'bullish',
    startIndex: 5,
    endIndex: 6,
    detectedAt: 6,
    confidence: 0.76,
    strength: 0.68,
    label: 'VWAP Reclaim',
    description: 'Fixture TA confluence',
    source: 'candle-vision',
    anchors: [{ index: 6, time: 7, price: 102, role: 'confirmation' }],
    color: '#22c55e',
    scoreBreakdown: { vwap: 102, distanceScore: 0.75, volumeScore: 1 },
  },
]
```

Expected assertions:

- confluence candidate score is greater than the single-pattern score.
- score is deterministic and bounded in `[0, 1]`.
- duplicate events from the same family do not inflate score past the configured family cap.
- opposite-direction or `invalidated` events do not add positive confluence.
- reason codes include `confluence_support` and `confluence_ta` only when those events are eligible.

## Implementation Notes

- Mirror `packages/candle-vision/test/release-regression.ts`: import public exports, use `assert`, and keep expected outputs explicit.
- Prefer a small local fixture helper such as `event(overrides)` that returns a complete `CandlePatternEvent`; keep each scenario's candle array fully readable at the call site.
- Assert both the decision output and diagnostics/reason codes. The reason-code checks are the best guard against silent regressions where the action stays `hold` for the wrong reason.
- Include one boundary assertion per rule: volume equal to threshold, close exactly at stop, and watch age exactly equal to `maxWatchBars`.
- Keep generated fixture IDs stable (`fixture:<scenario>`) so failures are searchable in CI output.
