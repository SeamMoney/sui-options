import assert from 'node:assert/strict';
import {
  CANDLE_VISION_PATTERN_CATALOG,
  backtestMicroBot,
  calibrateMicroBot,
  createMicroBotState,
  decideTradeFromEvents,
  createPatternShowcaseEvents,
  deriveTaLines,
  detectUnifiedCandlePatterns,
  rankPatternSignals,
  updateMicroBot,
  walkForwardMicroBot,
} from '../src/index';
import { baseCandles, patternFixtures } from './fixtures';
import type { CandleInput, CandlePatternEvent } from '../src/types';

function kindsForFixture(name: keyof typeof patternFixtures) {
  return detectUnifiedCandlePatterns(patternFixtures[name], {
    contextPeriod: 3,
    trendPeriod: 3,
    minConfidence: 0.55,
    includeWeak: false,
  }).map((event) => event.kind);
}

function assertFixtureDetects(name: keyof typeof patternFixtures, expectedKind: string) {
  const kinds = kindsForFixture(name);
  assert.ok(
    kinds.includes(expectedKind as never),
    `${name} fixture should detect ${expectedKind}; detected: ${kinds.join(', ') || 'none'}`,
  );
}

assertFixtureDetects('doji', 'doji');
assertFixtureDetects('hammer', 'hammer');
assertFixtureDetects('engulfing', 'engulfing');
assertFixtureDetects('marubozu', 'marubozu');
assertFixtureDetects('harami', 'harami');
assertFixtureDetects('morning-star', 'morning-star');
assertFixtureDetects('vision-momentum', 'vision-momentum');

const candles = baseCandles(120);
const showcaseEvents = createPatternShowcaseEvents(candles);
assert.equal(showcaseEvents.length, CANDLE_VISION_PATTERN_CATALOG.length, 'showcase should expose every catalog entry');

const invalidated: CandlePatternEvent = {
  ...showcaseEvents[0],
  id: 'test:invalidated-doji',
  status: 'invalidated',
  confidence: 1,
  strength: 1,
};

const ranking = rankPatternSignals([...showcaseEvents.slice(0, 30), invalidated], {
  latestIndex: candles.length - 1,
  maxVisible: 5,
  perFamilyLimit: 2,
  minVisibleScore: 0.2,
  allowOverlaps: true,
});

assert.ok(ranking.raw.length > ranking.visible.length, 'raw ranking should include non-visible signals');
assert.ok(ranking.visible.length <= 5, 'visible signals should respect maxVisible');
assert.ok(
  ranking.visible.every((signal) => signal.visible && signal.reasons.includes('visible')),
  'visible signals should be marked visible with reasons',
);
assert.ok(
  ranking.raw.every((signal) => signal.rawScore >= 0 && signal.rawScore <= 1 && signal.visibleScore >= 0 && signal.visibleScore <= 1),
  'ranking scores should stay in [0, 1]',
);
assert.deepEqual(
  ranking.visible.map((signal) => signal.visibleRank),
  ranking.visible.map((_, index) => index + 1),
  'visible ranks should be consecutive',
);

const visibleFamilyCounts = new Map<string, number>();
for (const signal of ranking.visible) {
  visibleFamilyCounts.set(signal.event.family, (visibleFamilyCounts.get(signal.event.family) ?? 0) + 1);
}
assert.ok(
  Array.from(visibleFamilyCounts.values()).every((count) => count <= 2),
  'visible signals should respect perFamilyLimit',
);
assert.ok(
  ranking.raw.some((signal) => signal.event.id === invalidated.id && !signal.visible && signal.reasons.includes('invalidated')),
  'invalidated signals should not be visible',
);

function fixtureEvent(overrides: Partial<CandlePatternEvent>): CandlePatternEvent {
  return {
    id: 'fixture:event',
    kind: 'hammer',
    family: 'candlestick',
    status: 'confirmed',
    direction: 'bullish',
    startIndex: 5,
    endIndex: 5,
    detectedAt: 6,
    confidence: 0.9,
    strength: 0.84,
    label: 'Hammer',
    description: 'Fixture event',
    source: 'candle-vision',
    anchors: [],
    color: '#22c55e',
    ...overrides,
  };
}

function reasonCodes(decision: ReturnType<typeof decideTradeFromEvents>['decision']) {
  return decision.reasons.map((item) => item.code);
}

const bullishDecisionCandles: CandleInput[] = [
  { time: 1, open: 110, high: 111, low: 106, close: 107, volume: 1000 },
  { time: 2, open: 107, high: 108, low: 103, close: 104, volume: 1050 },
  { time: 3, open: 104, high: 105, low: 100, close: 101, volume: 1100 },
  { time: 4, open: 101, high: 102, low: 97, close: 98, volume: 1150 },
  { time: 5, open: 98, high: 99, low: 94, close: 96, volume: 1200 },
  { time: 6, open: 96, high: 99, low: 90, close: 98.5, volume: 1500 },
  { time: 7, open: 98.5, high: 105, low: 98, close: 104, volume: 2100 },
];

const bullishHammer = fixtureEvent({
  id: 'fixture:bullish-hammer',
  kind: 'hammer',
  direction: 'bullish',
  startIndex: 5,
  endIndex: 5,
  detectedAt: 6,
  anchors: [
    { index: 5, time: 6, price: 96, role: 'start' },
    { index: 5, time: 6, price: 99, role: 'high' },
    { index: 5, time: 6, price: 90, role: 'low' },
    { index: 5, time: 6, price: 103.5, role: 'confirmation' },
    { index: 5, time: 6, price: 90, role: 'invalidation' },
  ],
});

const bullishConfirmed = decideTradeFromEvents([bullishHammer], bullishDecisionCandles, {
  latestIndex: 6,
  minActionScore: 0.62,
});
assert.equal(bullishConfirmed.decision.action, 'buy', 'bullish confirmed fixture should produce buy action');
assert.equal(bullishConfirmed.decision.status, 'confirmed', 'bullish confirmed fixture should be confirmed');
assert.ok(reasonCodes(bullishConfirmed.decision).includes('breakout_confirmed'), 'bullish decision should explain breakout confirmation');
assert.ok(reasonCodes(bullishConfirmed.decision).includes('risk_defined'), 'bullish decision should include risk definition');
assert.ok(bullishConfirmed.decision.targets.length >= 2, 'bullish confirmed decision should emit targets');

const bearishDecisionCandles: CandleInput[] = [
  { time: 1, open: 90, high: 94, low: 89, close: 93, volume: 1000 },
  { time: 2, open: 93, high: 97, low: 92, close: 96, volume: 1050 },
  { time: 3, open: 96, high: 100, low: 95, close: 99, volume: 1100 },
  { time: 4, open: 99, high: 103, low: 98, close: 102, volume: 1150 },
  { time: 5, open: 102, high: 106, low: 101, close: 105, volume: 1200 },
  { time: 6, open: 105, high: 111, low: 104, close: 105.2, volume: 1500 },
  { time: 7, open: 105, high: 106, low: 97, close: 98, volume: 2200 },
];

const bearishStar = fixtureEvent({
  id: 'fixture:bearish-star',
  kind: 'shooting-star',
  direction: 'bearish',
  startIndex: 5,
  endIndex: 5,
  detectedAt: 6,
  label: 'Shooting Star',
  color: '#ef4444',
  anchors: [
    { index: 5, time: 6, price: 105, role: 'start' },
    { index: 5, time: 6, price: 111, role: 'high' },
    { index: 5, time: 6, price: 104, role: 'low' },
    { index: 5, time: 6, price: 98.5, role: 'confirmation' },
    { index: 5, time: 6, price: 111, role: 'invalidation' },
  ],
});

const bearishConfirmed = decideTradeFromEvents([bearishStar], bearishDecisionCandles, {
  latestIndex: 6,
  minActionScore: 0.62,
});
assert.equal(bearishConfirmed.decision.action, 'sell', 'bearish confirmed fixture should produce sell action');
assert.equal(bearishConfirmed.decision.status, 'confirmed', 'bearish confirmed fixture should be confirmed');
assert.ok(reasonCodes(bearishConfirmed.decision).includes('breakdown_confirmed'), 'bearish decision should explain breakdown confirmation');

const lowVolumeCandles = bullishDecisionCandles.map((bar, index) => index === 6 ? { ...bar, volume: 300 } : bar);
const deniedByVolume = decideTradeFromEvents([bullishHammer], lowVolumeCandles, {
  latestIndex: 6,
  minActionScore: 0.62,
  requireVolumeConfirmation: true,
  minVolumeRatio: 0.95,
});
assert.equal(deniedByVolume.decision.action, 'hold', 'low volume fixture should not produce an action');
assert.equal(deniedByVolume.decision.status, 'denied', 'low volume fixture should be denied');
assert.ok(reasonCodes(deniedByVolume.decision).includes('volume_below_threshold'), 'low volume decision should explain denial');

const invalidatedCandles: CandleInput[] = [
  ...bullishDecisionCandles.slice(0, 6),
  { time: 7, open: 98.5, high: 100, low: 95, close: 96.2, volume: 1300 },
  { time: 8, open: 96.2, high: 97, low: 87, close: 88.8, volume: 1700 },
];
const invalidatedDecision = decideTradeFromEvents([bullishHammer], invalidatedCandles, {
  latestIndex: 7,
  minActionScore: 0.62,
});
assert.equal(invalidatedDecision.decision.action, 'hold', 'close through stop should hold');
assert.equal(invalidatedDecision.decision.status, 'invalidated', 'close through stop should invalidate');
assert.ok(reasonCodes(invalidatedDecision.decision).includes('close_through_stop'), 'invalidated decision should explain stop close');

const expiredCandles: CandleInput[] = [
  ...bullishDecisionCandles.slice(0, 6),
  { time: 7, open: 98.5, high: 100, low: 96.5, close: 98.8, volume: 1150 },
  { time: 8, open: 98.8, high: 100.2, low: 97, close: 99.1, volume: 1125 },
  { time: 9, open: 99.1, high: 100.3, low: 97.2, close: 98.9, volume: 1100 },
  { time: 10, open: 98.9, high: 100.1, low: 97.3, close: 99, volume: 1090 },
];
const expiredWatch = decideTradeFromEvents([{ ...bullishHammer, status: 'forming' }], expiredCandles, {
  latestIndex: 9,
  maxWatchBars: 3,
});
assert.equal(expiredWatch.decision.action, 'hold', 'expired watch should hold');
assert.equal(expiredWatch.decision.status, 'expired', 'expired watch should expire');
assert.ok(reasonCodes(expiredWatch.decision).includes('watch_expired'), 'expired watch should explain expiry');

const supportRetest = fixtureEvent({
  id: 'fixture:support-retest',
  kind: 'support-retest',
  family: 'chart-setup',
  direction: 'bullish',
  startIndex: 3,
  endIndex: 6,
  confidence: 0.82,
  strength: 0.76,
  label: 'Support Retest',
  anchors: [{ index: 6, time: 7, price: 103, role: 'confirmation' }],
});
const vwapReclaim = fixtureEvent({
  id: 'fixture:vwap-reclaim',
  kind: 'vwap-reclaim',
  family: 'chart-setup',
  direction: 'bullish',
  startIndex: 5,
  endIndex: 6,
  confidence: 0.78,
  strength: 0.72,
  label: 'VWAP Reclaim',
  anchors: [{ index: 6, time: 7, price: 102, role: 'confirmation' }],
});
const singlePattern = decideTradeFromEvents([bullishHammer], bullishDecisionCandles, { latestIndex: 6, minActionScore: 0.62 });
const confluence = decideTradeFromEvents([bullishHammer, supportRetest, vwapReclaim], bullishDecisionCandles, { latestIndex: 6, minActionScore: 0.62 });
assert.ok(
  confluence.decision.scoreBreakdown.confluence > singlePattern.decision.scoreBreakdown.confluence,
  'same-direction support/TA events should increase confluence score',
);
assert.ok(reasonCodes(confluence.decision).includes('confluence_same_direction'), 'confluence decision should explain same-direction confluence');

const taLines = deriveTaLines(baseCandles(90), { lookback: 80, includeVwap: true });
assert.ok(taLines.some((line) => line.kind === 'trend'), 'TA lines should include a regression trend line');
assert.ok(taLines.some((line) => line.kind === 'channel-upper'), 'TA lines should include an upper channel');
assert.ok(taLines.some((line) => line.kind === 'channel-lower'), 'TA lines should include a lower channel');
assert.ok(
  taLines.every((line) => line.confidence >= 0 && line.confidence <= 1 && line.points.length >= 2),
  'TA lines should emit bounded confidence and drawable points',
);

let botState = createMicroBotState();
botState = updateMicroBot({
  state: botState,
  candles: bullishDecisionCandles,
  events: [bullishHammer, supportRetest, vwapReclaim],
  decision: confluence.decision,
  nowMs: 1000,
  options: { minHoldMs: 5000, maxHoldMs: 10000, entryThreshold: 0.48 },
});
assert.equal(botState.position?.side, 'long', 'micro bot should enter long on bullish pattern + TA confluence');
assert.equal(botState.status, 'in-position', 'micro bot should mark active position after entry');

botState = updateMicroBot({
  state: botState,
  candles: [
    ...bullishDecisionCandles,
    { time: 8, open: 104, high: 105, low: 103.5, close: 104.7, volume: 2300 },
  ],
  events: [bullishHammer, supportRetest, vwapReclaim],
  decision: confluence.decision,
  nowMs: 11_500,
  options: { minHoldMs: 5000, maxHoldMs: 10000, entryThreshold: 0.48 },
});
assert.equal(botState.position, null, 'micro bot should close after the 5-10 second scalp window or target');
assert.equal(botState.trades.length, 1, 'micro bot should record the closed scalp trade');
assert.ok(botState.trades[0]!.exitReason === 'time' || botState.trades[0]!.exitReason === 'target', 'micro bot should explain timed or target exit');

const backtest = backtestMicroBot(baseCandles(90), {
  warmupBars: 20,
  barMs: 1000,
  bot: { minHoldMs: 5000, maxHoldMs: 10000, entryThreshold: 0.52 },
});
assert.equal(backtest.summary.totalTrades, backtest.state.stats.totalTrades, 'backtest summary should mirror final bot state');
assert.ok(backtest.equityCurve.length > 0, 'backtest should emit an equity curve');
assert.ok(Number.isFinite(backtest.summary.pnl), 'backtest PnL should be finite');
assert.equal(backtest.trades.length, backtest.summary.totalTrades, 'backtest should retain every closed trade, not only the bot state cache');

const calibration = calibrateMicroBot(baseCandles(130), {
  warmupBars: 24,
  barMs: 1000,
  minTrades: 2,
});
assert.ok(calibration.rows.length >= 3, 'calibration should compare multiple strategy presets');
assert.ok(calibration.best, 'calibration should select a best preset');
assert.ok(
  calibration.rows.every((row) => row.score >= 0 && row.score <= 1 && Number.isFinite(row.expectancy)),
  'calibration rows should expose bounded scores and finite expectancy',
);
assert.deepEqual(
  calibration.rows.map((row) => row.score),
  calibration.rows.map((row) => row.score).slice().sort((a, b) => b - a),
  'calibration rows should be sorted by score descending',
);

const walkForward = walkForwardMicroBot(baseCandles(150), {
  warmupBars: 20,
  trainBars: 70,
  testBars: 24,
  stepBars: 24,
  barMs: 1000,
  minTrades: 2,
});
assert.ok(walkForward.folds.length >= 2, 'walk-forward should emit multiple train/test folds');
assert.equal(
  walkForward.summary.totalTrades,
  walkForward.folds.reduce((sum, fold) => sum + fold.test.summary.totalTrades, 0),
  'walk-forward summary should aggregate fold test trades',
);
assert.ok(
  walkForward.folds.every((fold) => fold.testStart === fold.trainEnd && fold.testEnd > fold.testStart),
  'walk-forward folds should keep train/test windows ordered',
);
assert.ok(
  walkForward.folds.every((fold) => fold.efficiency >= 0 && fold.efficiency <= 1),
  'walk-forward efficiency should stay bounded',
);

console.log('candle-vision detector and ranking regressions passed');
