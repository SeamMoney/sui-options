# Candle Vision Trade Decision Layer Notes

## Goal

Add a reusable trade-decision layer above the existing Candle Vision detector and ranking pipeline. The layer should not replace `CandlePatternEvent`; it should consume ranked pattern signals and emit a compact decision object that explains whether the latest market state is actionable, waiting for confirmation, denied, or unavailable.

## Proposed Types

```ts
export type TradeDecisionStatus =
  | 'long'
  | 'short'
  | 'wait'
  | 'denied'
  | 'no-signal';

export type TradeDecisionReason =
  | 'confirmed-bullish-confluence'
  | 'confirmed-bearish-confluence'
  | 'forming-pattern'
  | 'mixed-direction'
  | 'low-confidence'
  | 'low-visible-score'
  | 'stale-signal'
  | 'unsupported-pattern'
  | 'invalidated-pattern'
  | 'neutral-pattern'
  | 'insufficient-data'
  | 'risk-too-wide'
  | 'no-ranked-signal';

export type TradeDecisionSide = 'long' | 'short' | 'none';

export type TradeDecisionLevel = {
  price: number;
  index: number;
  time: number;
  source: 'anchor' | 'candle-range' | 'latest-close';
};

export type TradeDecisionScoreBreakdown = {
  pattern: number;
  ranking: number;
  recency: number;
  confluence: number;
  risk: number;
  total: number;
};

export type TradeDecision = {
  id: string;
  status: TradeDecisionStatus;
  side: TradeDecisionSide;
  score: number;
  confidence: number;
  reasons: TradeDecisionReason[];
  primarySignal?: RankedPatternSignal;
  confirmingSignals: RankedPatternSignal[];
  denyingSignals: RankedPatternSignal[];
  entry?: TradeDecisionLevel;
  stop?: TradeDecisionLevel;
  invalidation?: TradeDecisionLevel;
  target?: TradeDecisionLevel;
  scoreBreakdown: TradeDecisionScoreBreakdown;
  createdAt: number;
  latestIndex: number;
};
```

Keep `TradeDecision` separate from `CandlePatternEvent` so existing overlays, catalogs, detectors, and ranking helpers keep their current contracts. The decision can reference `RankedPatternSignal` because ranking already attaches registry support, raw score, visible score, rank, and visibility reasons.

## Confirmation And Denial Rules

Use confirmed, supported, directional signals as the only immediate trade triggers:

- `long`: primary signal is `direction === 'bullish'`, `status === 'confirmed'`, supported, recent, and above the decision score threshold.
- `short`: same rule for `direction === 'bearish'`.
- `wait`: best signal is `forming`, neutral compression, or a directional setup that needs a next-candle break of the confirmation anchor.
- `denied`: there is a candidate primary signal, but a stronger or equally recent opposite-direction signal, invalidated status, excessive staleness, unsupported pattern, low score, or unacceptable risk rejects it.
- `no-signal`: no ranked signal survives basic support, recency, and score filters.

Suggested confirmation prices should reuse existing anchors:

- Bullish confirmation: break above the primary event's `confirmation` anchor, else event high.
- Bearish confirmation: break below the primary event's `confirmation` anchor, else event low.
- Invalidation: bullish below event low/body-low anchor; bearish above event high/body-high anchor.
- Compression/neutral patterns never emit `long` or `short` alone; they emit `wait` until a directional breakout pattern or price break confirms.

Denial should be explicit and explainable. Opposite signals deny when they overlap the primary span or occurred within the recency window and have comparable score, for example `opposite.visibleScore >= primary.visibleScore * 0.85`. Invalidated and expired events should always deny direct action. Unsupported registry entries should be eligible for diagnostics but not for trade decisions.

## Scoring Inputs

Base score should combine data already available in `CandlePatternEvent` and `RankedPatternSignal`:

- Pattern quality: `event.confidence`, `event.strength`, and `event.scoreBreakdown`.
- Ranking quality: `rawScore`, `visibleScore`, support state, raw/visible rank.
- Status: confirmed > forming > expired > invalidated.
- Recency: distance from `latestIndex` to `event.endIndex`, matching the ranking layer's recency-window approach.
- Confluence: same-direction nearby signals across families, especially `vision-candle` plus `candlestick` or `chart-setup`.
- Conflict: opposite-direction signals near the same span, neutral indecision after the signal, or ranking reasons like `below-visible-score`.
- Risk geometry: entry-to-invalidation distance based on anchors or candle range, optionally normalized by recent average range.

Initial default weights:

```ts
const DEFAULT_TRADE_DECISION_WEIGHTS = {
  pattern: 0.32,
  ranking: 0.28,
  recency: 0.16,
  confluence: 0.16,
  risk: 0.08,
};
```

Recommended first thresholds:

- `minActionScore`: `0.68`
- `minWaitScore`: `0.45`
- `recencyWindow`: `48` bars for trading decisions, shorter than broad overlay visibility.
- `oppositionDenyRatio`: `0.85`
- `maxRiskRangeRatio`: optional, default disabled until normalized range data is exposed by the API.

## Public API Shape

Expose the decision layer as a small additive API from `@sui-options/candle-vision`:

```ts
export type TradeDecisionOptions = {
  latestIndex?: number;
  minActionScore?: number;
  minWaitScore?: number;
  recencyWindow?: number;
  oppositionDenyRatio?: number;
  maxConfirmingSignals?: number;
  ranking?: PatternSignalRankingOptions;
};

export type TradeDecisionResult = {
  decision: TradeDecision;
  decisions: TradeDecision[];
  ranking: PatternSignalRankingResult;
};

export function decideTradeFromSignals(
  signals: readonly RankedPatternSignal[],
  candles: readonly CandleInput[],
  options?: TradeDecisionOptions,
): TradeDecisionResult;

export function decideTradeFromEvents(
  events: readonly CandlePatternEvent[],
  candles: readonly CandleInput[],
  options?: TradeDecisionOptions,
): TradeDecisionResult;

export function scanCandleVisionWithTradeDecision(
  candles: readonly CandleInput[],
  options?: CandleVisionScannerOptions & { tradeDecision?: TradeDecisionOptions },
): CandleVisionScanResult & { tradeDecision: TradeDecision };
```

`decideTradeFromEvents` should call `rankPatternSignals` internally. `decideTradeFromSignals` is useful for the frontend because `CandleVision.tsx` already ranks and diversifies signals. The scanner helper should be additive so current consumers of `scanCandleVision`, `detectUnifiedCandlePatterns`, and `rankPatternSignals` do not need to change.

## Overlay Integration

The existing overlay renders `CandlePatternEvent[]` and the frontend keeps decisions out of overlay state today. Preserve that boundary:

- Continue passing selected `CandlePatternEvent[]` to `overlay.setData(candles, events)`.
- Compute one `TradeDecision` from `ranked.raw` or `ranked.visible` inside the scan path.
- Surface the decision in the right panel as a compact status row above ranked signals.
- Use `primarySignal.event.id` to call the existing spotlight path, so trade decisions reuse `setSpotlight` and `mergeSpotlightEvent`.
- Do not add trade fields to `CandlePatternEvent`; if the overlay needs entry/stop/target drawings later, add an optional overlay input such as `{ events, decisionLevels }` rather than overloading pattern events.

For the first UI pass, the overlay should only highlight the primary signal. Entry, stop, invalidation, and target levels can be rendered later as a separate lightweight layer once the decision model has real usage feedback.
