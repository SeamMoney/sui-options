import {
  bodyHigh,
  bodyLow,
  clamp01,
  normalizeCandles,
  scoreGreater,
  scoreLess,
} from '../../features';
import type {
  CandleDirection,
  CandleFeature,
  CandleInput,
  CandlePatternDetectorOptions,
  CandlePatternEvent,
} from '../../types';

export type TwoCandlePatternKind =
  | 'engulfing'
  | 'harami'
  | 'piercing-line'
  | 'dark-cloud-cover'
  | 'two-crows'
  | 'counterattack'
  | 'doji-star'
  | 'harami-cross'
  | 'homing-pigeon'
  | 'in-neck'
  | 'matching-low'
  | 'on-neck'
  | 'separating-lines'
  | 'thrusting'
  | 'tasuki-gap'
  | 'upside-gap-two-crows';

export type TwoCandleTaLibName =
  | 'CDLENGULFING'
  | 'CDLHARAMI'
  | 'CDLPIERCING'
  | 'CDLDARKCLOUDCOVER'
  | 'CDL2CROWS'
  | 'CDLCOUNTERATTACK'
  | 'CDLDOJISTAR'
  | 'CDLHARAMICROSS'
  | 'CDLHOMINGPIGEON'
  | 'CDLINNECK'
  | 'CDLMATCHINGLOW'
  | 'CDLONNECK'
  | 'CDLSEPARATINGLINES'
  | 'CDLTHRUSTING'
  | 'CDLTASUKIGAP'
  | 'CDLUPSIDEGAP2CROWS';

export type TwoCandlePatternCandidate = Omit<
  CandlePatternEvent,
  'id' | 'kind' | 'detectedAt' | 'source' | 'color'
> & {
  kind: TwoCandlePatternKind;
  color?: string;
  taLib: {
    name: TwoCandleTaLibName;
    value: -100 | 100;
    candleCount: 2 | 3;
  };
};

export type TwoCandlePatternDefinition = {
  kind: TwoCandlePatternKind;
  taLibName: TwoCandleTaLibName;
  label: string;
  description: string;
  candleCount: 2 | 3;
  family: 'candlestick';
  detect: (features: CandleFeature[], index: number) => TwoCandlePatternCandidate | null;
};

export type TwoCandlePatternDetectorOptions = Pick<
  CandlePatternDetectorOptions,
  'contextPeriod' | 'trendPeriod' | 'minConfidence' | 'includeWeak'
> & {
  definitions?: readonly TwoCandlePatternDefinition[];
};

const DEFAULT_MIN_CONFIDENCE = 0.58;
const EPSILON = 1e-9;

function weightedScore(parts: Record<string, number>, weights?: Record<string, number>) {
  const entries = Object.entries(parts);
  const totalWeight = entries.reduce((sum, [key]) => sum + (weights?.[key] ?? 1), 0);
  if (!entries.length || totalWeight <= 0) return 0;
  return clamp01(entries.reduce((sum, [key, value]) => sum + clamp01(value) * (weights?.[key] ?? 1), 0) / totalWeight);
}

function directionForValue(direction: CandleDirection): -100 | 100 {
  return direction === 'bearish' ? -100 : 100;
}

function realBodyMidpoint(bar: CandleFeature) {
  return (bar.open + bar.close) / 2;
}

function tolerance(bar: CandleFeature, factor = 0.08) {
  return Math.max(bar.averageRange, bar.range, EPSILON) * factor;
}

function nearScore(a: number, b: number, amount: number) {
  const diff = Math.abs(a - b);
  if (diff <= amount) return 1;
  if (diff >= amount * 2) return 0;
  return 1 - (diff - amount) / amount;
}

function isLongBody(bar: CandleFeature) {
  return weightedScore({
    ratio: scoreGreater(bar.bodyRatio, 0.85, 1.55),
    bodyPct: scoreGreater(bar.bodyPct, 0.42, 0.72),
  });
}

function isSmallBody(bar: CandleFeature) {
  return weightedScore({
    ratio: scoreLess(bar.bodyRatio, 0.72, 1.15),
    bodyPct: scoreLess(bar.bodyPct, 0.32, 0.52),
  });
}

function isDoji(bar: CandleFeature) {
  return weightedScore({
    bodyPct: scoreLess(bar.bodyPct, 0.08, 0.16),
    bodyRatio: scoreLess(bar.bodyRatio, 0.28, 0.72),
  });
}

function bodyInside(inner: CandleFeature, outer: CandleFeature, padding = 0) {
  return bodyHigh(inner) <= bodyHigh(outer) + padding && bodyLow(inner) >= bodyLow(outer) - padding;
}

function bodyGapUp(a: CandleFeature, b: CandleFeature) {
  return bodyLow(b) > bodyHigh(a);
}

function bodyGapDown(a: CandleFeature, b: CandleFeature) {
  return bodyHigh(b) < bodyLow(a);
}

function trendScore(bar: CandleFeature, direction: CandleDirection) {
  if (direction === 'neutral') return 0.5;
  if (bar.trendDirection === direction) return 1;
  if (bar.trendDirection === 'neutral') return 0.55;
  return Math.abs(bar.trendSlope) < 0.004 ? 0.35 : 0;
}

function sameOpenScore(a: CandleFeature, b: CandleFeature) {
  return nearScore(a.open, b.open, tolerance(a, 0.06));
}

function anchorsForRange(
  features: CandleFeature[],
  startPosition: number,
  endPosition: number,
  direction: CandleDirection,
) {
  const start = features[startPosition];
  const end = features[endPosition];
  const slice = features.slice(startPosition, endPosition + 1);
  const high = slice.reduce((best, bar) => (bar.high > best.high ? bar : best), slice[0]);
  const low = slice.reduce((best, bar) => (bar.low < best.low ? bar : best), slice[0]);
  const confirmationPrice = direction === 'bearish' ? end.low : direction === 'bullish' ? end.high : end.close;

  return [
    { index: start.index, time: start.time, price: start.open, role: 'start' as const },
    { index: high.index, time: high.time, price: high.high, role: 'high' as const },
    { index: low.index, time: low.time, price: low.low, role: 'low' as const },
    { index: end.index, time: end.time, price: confirmationPrice, role: 'confirmation' as const },
  ];
}

function makeCandidate(
  definition: Omit<TwoCandlePatternDefinition, 'detect'>,
  features: CandleFeature[],
  startPosition: number,
  endPosition: number,
  direction: CandleDirection,
  confidence: number,
  label: string,
  description: string,
  scoreBreakdown: Record<string, number>,
): TwoCandlePatternCandidate {
  const start = features[startPosition];
  const end = features[endPosition];
  return {
    kind: definition.kind,
    family: definition.family,
    status: 'confirmed',
    direction,
    startIndex: start.index,
    endIndex: end.index,
    confidence,
    strength: confidence,
    label,
    description,
    anchors: anchorsForRange(features, startPosition, endPosition, direction),
    scoreBreakdown,
    taLib: {
      name: definition.taLibName,
      value: directionForValue(direction),
      candleCount: definition.candleCount,
    },
  };
}

function definePattern(
  definition: Omit<TwoCandlePatternDefinition, 'family'>,
): TwoCandlePatternDefinition {
  return { ...definition, family: 'candlestick' };
}

const engulfing = definePattern({
  kind: 'engulfing',
  taLibName: 'CDLENGULFING',
  label: 'Engulfing',
  description: 'Current real body engulfs the previous real body after an opposite candle.',
  candleCount: 2,
  detect(features, index) {
    const prev = features[index - 1];
    const curr = features[index];
    if (!prev || !curr) return null;
    const opposite = prev.direction !== 'neutral' && curr.direction !== 'neutral' && prev.direction !== curr.direction;
    const score = weightedScore({
      opposite: opposite ? 1 : 0,
      currentBody: isLongBody(curr),
      previousBody: scoreGreater(prev.bodyPct, 0.18, 0.42),
      bodyHigh: bodyHigh(curr) >= bodyHigh(prev) ? 1 : 0,
      bodyLow: bodyLow(curr) <= bodyLow(prev) ? 1 : 0,
    }, { opposite: 1.4, bodyHigh: 1.2, bodyLow: 1.2 });
    if (score < 0.72) return null;
    const direction = curr.direction;
    return makeCandidate(
      engulfing,
      features,
      index - 1,
      index,
      direction,
      score,
      `${direction === 'bullish' ? 'Bullish' : 'Bearish'} Engulfing`,
      engulfing.description,
      { engulfing: score },
    );
  },
});

const harami = definePattern({
  kind: 'harami',
  taLibName: 'CDLHARAMI',
  label: 'Harami',
  description: 'Small current real body sits inside the previous long real body.',
  candleCount: 2,
  detect(features, index) {
    const prev = features[index - 1];
    const curr = features[index];
    if (!prev || !curr) return null;
    const direction: CandleDirection = prev.direction === 'bearish' ? 'bullish' : prev.direction === 'bullish' ? 'bearish' : 'neutral';
    if (direction === 'neutral') return null;
    const score = weightedScore({
      previousLong: isLongBody(prev),
      currentSmall: isSmallBody(curr),
      inside: bodyInside(curr, prev) ? 1 : 0,
      oppositeOrDoji: curr.direction === 'neutral' || curr.direction !== prev.direction ? 1 : 0.45,
    }, { inside: 1.5, previousLong: 1.2 });
    if (score < 0.72) return null;
    return makeCandidate(
      harami,
      features,
      index - 1,
      index,
      direction,
      score,
      `${direction === 'bullish' ? 'Bullish' : 'Bearish'} Harami`,
      harami.description,
      { harami: score },
    );
  },
});

const piercingLine = definePattern({
  kind: 'piercing-line',
  taLibName: 'CDLPIERCING',
  label: 'Piercing Line',
  description: 'Bullish candle opens weak and closes above the midpoint of the previous bearish body.',
  candleCount: 2,
  detect(features, index) {
    const prev = features[index - 1];
    const curr = features[index];
    if (!prev || !curr) return null;
    const midpoint = realBodyMidpoint(prev);
    const score = weightedScore({
      downtrend: trendScore(prev, 'bearish'),
      previousBearish: prev.direction === 'bearish' ? 1 : 0,
      previousLong: isLongBody(prev),
      currentBullish: curr.direction === 'bullish' ? 1 : 0,
      openBelow: curr.open < prev.low ? 1 : curr.open < prev.close ? 0.55 : 0,
      closeAboveMid: curr.close > midpoint ? 1 : 0,
      closeBelowPrevOpen: curr.close < prev.open ? 1 : 0.45,
    }, { previousBearish: 1.3, currentBullish: 1.3, closeAboveMid: 1.4 });
    if (score < 0.74) return null;
    return makeCandidate(
      piercingLine,
      features,
      index - 1,
      index,
      'bullish',
      score,
      piercingLine.label,
      piercingLine.description,
      { piercingLine: score },
    );
  },
});

const darkCloudCover = definePattern({
  kind: 'dark-cloud-cover',
  taLibName: 'CDLDARKCLOUDCOVER',
  label: 'Dark Cloud Cover',
  description: 'Bearish candle opens strong and closes below the midpoint of the previous bullish body.',
  candleCount: 2,
  detect(features, index) {
    const prev = features[index - 1];
    const curr = features[index];
    if (!prev || !curr) return null;
    const midpoint = realBodyMidpoint(prev);
    const score = weightedScore({
      uptrend: trendScore(prev, 'bullish'),
      previousBullish: prev.direction === 'bullish' ? 1 : 0,
      previousLong: isLongBody(prev),
      currentBearish: curr.direction === 'bearish' ? 1 : 0,
      openAbove: curr.open > prev.high ? 1 : curr.open > prev.close ? 0.55 : 0,
      closeBelowMid: curr.close < midpoint ? 1 : 0,
      closeAbovePrevOpen: curr.close > prev.open ? 1 : 0.45,
    }, { previousBullish: 1.3, currentBearish: 1.3, closeBelowMid: 1.4 });
    if (score < 0.74) return null;
    return makeCandidate(
      darkCloudCover,
      features,
      index - 1,
      index,
      'bearish',
      score,
      darkCloudCover.label,
      darkCloudCover.description,
      { darkCloudCover: score },
    );
  },
});

const counterattack = definePattern({
  kind: 'counterattack',
  taLibName: 'CDLCOUNTERATTACK',
  label: 'Counterattack',
  description: 'Opposite-color long candles close at nearly the same price after a directional move.',
  candleCount: 2,
  detect(features, index) {
    const prev = features[index - 1];
    const curr = features[index];
    if (!prev || !curr) return null;
    const opposite = prev.direction !== 'neutral' && curr.direction !== 'neutral' && prev.direction !== curr.direction;
    const direction = curr.direction;
    if (!opposite || direction === 'neutral') return null;
    const score = weightedScore({
      opposite: 1,
      previousLong: isLongBody(prev),
      currentLong: isLongBody(curr),
      sameClose: nearScore(prev.close, curr.close, tolerance(prev, 0.07)),
      gapOpen: direction === 'bullish'
        ? curr.open < prev.low ? 1 : curr.open < prev.close ? 0.55 : 0
        : curr.open > prev.high ? 1 : curr.open > prev.close ? 0.55 : 0,
      trend: trendScore(prev, direction === 'bullish' ? 'bearish' : 'bullish'),
    }, { sameClose: 1.7, opposite: 1.4 });
    if (score < 0.72) return null;
    return makeCandidate(
      counterattack,
      features,
      index - 1,
      index,
      direction,
      score,
      `${direction === 'bullish' ? 'Bullish' : 'Bearish'} Counterattack`,
      counterattack.description,
      { counterattack: score },
    );
  },
});

const dojiStar = definePattern({
  kind: 'doji-star',
  taLibName: 'CDLDOJISTAR',
  label: 'Doji Star',
  description: 'A doji gaps away from the prior long candle, signaling trend indecision.',
  candleCount: 2,
  detect(features, index) {
    const prev = features[index - 1];
    const curr = features[index];
    if (!prev || !curr || prev.direction === 'neutral') return null;
    const direction: CandleDirection = prev.direction === 'bearish' ? 'bullish' : 'bearish';
    const gap = prev.direction === 'bearish' ? bodyGapDown(prev, curr) : bodyGapUp(prev, curr);
    const score = weightedScore({
      trend: trendScore(prev, prev.direction),
      previousLong: isLongBody(prev),
      doji: isDoji(curr),
      gap: gap ? 1 : 0,
    }, { doji: 1.6, gap: 1.5 });
    if (score < 0.7) return null;
    return makeCandidate(
      dojiStar,
      features,
      index - 1,
      index,
      direction,
      score,
      `${direction === 'bullish' ? 'Bullish' : 'Bearish'} Doji Star`,
      dojiStar.description,
      { dojiStar: score },
    );
  },
});

const haramiCross = definePattern({
  kind: 'harami-cross',
  taLibName: 'CDLHARAMICROSS',
  label: 'Harami Cross',
  description: 'A doji forms inside the prior long real body.',
  candleCount: 2,
  detect(features, index) {
    const prev = features[index - 1];
    const curr = features[index];
    if (!prev || !curr || prev.direction === 'neutral') return null;
    const direction: CandleDirection = prev.direction === 'bearish' ? 'bullish' : 'bearish';
    const score = weightedScore({
      trend: trendScore(prev, prev.direction),
      previousLong: isLongBody(prev),
      doji: isDoji(curr),
      inside: bodyInside(curr, prev, tolerance(prev, 0.02)) ? 1 : 0,
    }, { doji: 1.6, inside: 1.5 });
    if (score < 0.72) return null;
    return makeCandidate(
      haramiCross,
      features,
      index - 1,
      index,
      direction,
      score,
      `${direction === 'bullish' ? 'Bullish' : 'Bearish'} Harami Cross`,
      haramiCross.description,
      { haramiCross: score },
    );
  },
});

const homingPigeon = definePattern({
  kind: 'homing-pigeon',
  taLibName: 'CDLHOMINGPIGEON',
  label: 'Homing Pigeon',
  description: 'Two bearish candles where the second real body nests inside the first.',
  candleCount: 2,
  detect(features, index) {
    const prev = features[index - 1];
    const curr = features[index];
    if (!prev || !curr) return null;
    const score = weightedScore({
      downtrend: trendScore(prev, 'bearish'),
      previousBearish: prev.direction === 'bearish' ? 1 : 0,
      currentBearish: curr.direction === 'bearish' ? 1 : 0,
      previousLong: isLongBody(prev),
      currentSmaller: curr.body < prev.body ? 1 : 0,
      inside: bodyInside(curr, prev, tolerance(prev, 0.02)) ? 1 : 0,
    }, { previousBearish: 1.2, currentBearish: 1.2, inside: 1.5 });
    if (score < 0.73) return null;
    return makeCandidate(
      homingPigeon,
      features,
      index - 1,
      index,
      'bullish',
      score,
      homingPigeon.label,
      homingPigeon.description,
      { homingPigeon: score },
    );
  },
});

const inNeck = definePattern({
  kind: 'in-neck',
  taLibName: 'CDLINNECK',
  label: 'In-Neck',
  description: 'After a long bearish candle, a small bullish candle opens below the low and closes just into the prior body.',
  candleCount: 2,
  detect(features, index) {
    const prev = features[index - 1];
    const curr = features[index];
    if (!prev || !curr) return null;
    const neckTolerance = tolerance(prev, 0.1);
    const score = weightedScore({
      downtrend: trendScore(prev, 'bearish'),
      previousBearish: prev.direction === 'bearish' ? 1 : 0,
      previousLong: isLongBody(prev),
      currentBullish: curr.direction === 'bullish' ? 1 : 0,
      opensBelowLow: curr.open < prev.low ? 1 : 0,
      closesNearPriorClose: curr.close > prev.close && curr.close <= prev.close + neckTolerance ? 1 : 0,
    }, { opensBelowLow: 1.4, closesNearPriorClose: 1.6 });
    if (score < 0.74) return null;
    return makeCandidate(
      inNeck,
      features,
      index - 1,
      index,
      'bearish',
      score,
      inNeck.label,
      inNeck.description,
      { inNeck: score },
    );
  },
});

const matchingLow = definePattern({
  kind: 'matching-low',
  taLibName: 'CDLMATCHINGLOW',
  label: 'Matching Low',
  description: 'Two bearish candles finish at nearly the same close after a decline.',
  candleCount: 2,
  detect(features, index) {
    const prev = features[index - 1];
    const curr = features[index];
    if (!prev || !curr) return null;
    const score = weightedScore({
      downtrend: trendScore(prev, 'bearish'),
      previousBearish: prev.direction === 'bearish' ? 1 : 0,
      currentBearish: curr.direction === 'bearish' ? 1 : 0,
      previousBody: scoreGreater(prev.bodyPct, 0.32, 0.62),
      currentBody: scoreGreater(curr.bodyPct, 0.22, 0.52),
      sameClose: nearScore(prev.close, curr.close, tolerance(prev, 0.06)),
    }, { sameClose: 1.7 });
    if (score < 0.73) return null;
    return makeCandidate(
      matchingLow,
      features,
      index - 1,
      index,
      'bullish',
      score,
      matchingLow.label,
      matchingLow.description,
      { matchingLow: score },
    );
  },
});

const onNeck = definePattern({
  kind: 'on-neck',
  taLibName: 'CDLONNECK',
  label: 'On-Neck',
  description: 'After a long bearish candle, a small bullish candle opens below the low and closes near that prior low.',
  candleCount: 2,
  detect(features, index) {
    const prev = features[index - 1];
    const curr = features[index];
    if (!prev || !curr) return null;
    const score = weightedScore({
      downtrend: trendScore(prev, 'bearish'),
      previousBearish: prev.direction === 'bearish' ? 1 : 0,
      previousLong: isLongBody(prev),
      currentBullish: curr.direction === 'bullish' ? 1 : 0,
      opensBelowLow: curr.open < prev.low ? 1 : 0,
      closesAtPriorLow: nearScore(curr.close, prev.low, tolerance(prev, 0.08)),
    }, { opensBelowLow: 1.4, closesAtPriorLow: 1.7 });
    if (score < 0.74) return null;
    return makeCandidate(
      onNeck,
      features,
      index - 1,
      index,
      'bearish',
      score,
      onNeck.label,
      onNeck.description,
      { onNeck: score },
    );
  },
});

const separatingLines = definePattern({
  kind: 'separating-lines',
  taLibName: 'CDLSEPARATINGLINES',
  label: 'Separating Lines',
  description: 'Opposite-color candles share nearly the same open, with the second candle continuing the trend.',
  candleCount: 2,
  detect(features, index) {
    const prev = features[index - 1];
    const curr = features[index];
    if (!prev || !curr) return null;
    const bullish = prev.direction === 'bearish' && curr.direction === 'bullish';
    const bearish = prev.direction === 'bullish' && curr.direction === 'bearish';
    if (!bullish && !bearish) return null;
    const direction: CandleDirection = bullish ? 'bullish' : 'bearish';
    const score = weightedScore({
      trend: trendScore(prev, direction),
      opposite: 1,
      sameOpen: sameOpenScore(prev, curr),
      currentLong: isLongBody(curr),
      closesWithTrend: direction === 'bullish' ? curr.close > prev.close ? 1 : 0 : curr.close < prev.close ? 1 : 0,
    }, { sameOpen: 1.7, currentLong: 1.2 });
    if (score < 0.72) return null;
    return makeCandidate(
      separatingLines,
      features,
      index - 1,
      index,
      direction,
      score,
      `${direction === 'bullish' ? 'Bullish' : 'Bearish'} Separating Lines`,
      separatingLines.description,
      { separatingLines: score },
    );
  },
});

const thrusting = definePattern({
  kind: 'thrusting',
  taLibName: 'CDLTHRUSTING',
  label: 'Thrusting',
  description: 'After a long bearish candle, a bullish candle opens below the low and closes into the body but below the midpoint.',
  candleCount: 2,
  detect(features, index) {
    const prev = features[index - 1];
    const curr = features[index];
    if (!prev || !curr) return null;
    const midpoint = realBodyMidpoint(prev);
    const score = weightedScore({
      downtrend: trendScore(prev, 'bearish'),
      previousBearish: prev.direction === 'bearish' ? 1 : 0,
      previousLong: isLongBody(prev),
      currentBullish: curr.direction === 'bullish' ? 1 : 0,
      opensBelowLow: curr.open < prev.low ? 1 : 0,
      closesIntoBody: curr.close > prev.close && curr.close < midpoint ? 1 : 0,
    }, { closesIntoBody: 1.7, opensBelowLow: 1.3 });
    if (score < 0.74) return null;
    return makeCandidate(
      thrusting,
      features,
      index - 1,
      index,
      'bearish',
      score,
      thrusting.label,
      thrusting.description,
      { thrusting: score },
    );
  },
});

const tasukiGap = definePattern({
  kind: 'tasuki-gap',
  taLibName: 'CDLTASUKIGAP',
  label: 'Tasuki Gap',
  description: 'Two same-direction candles gap, then an opposite candle retraces into the gap without closing it.',
  candleCount: 3,
  detect(features, index) {
    const a = features[index - 2];
    const b = features[index - 1];
    const c = features[index];
    if (!a || !b || !c) return null;
    const bullish = a.direction === 'bullish' && b.direction === 'bullish' && c.direction === 'bearish' && bodyGapUp(a, b);
    const bearish = a.direction === 'bearish' && b.direction === 'bearish' && c.direction === 'bullish' && bodyGapDown(a, b);
    if (!bullish && !bearish) return null;
    const direction: CandleDirection = bullish ? 'bullish' : 'bearish';
    const gapHeld = bullish
      ? c.close > bodyHigh(a) && c.open < bodyHigh(b) && c.open > bodyLow(b)
      : c.close < bodyLow(a) && c.open > bodyLow(b) && c.open < bodyHigh(b);
    const score = weightedScore({
      trend: trendScore(a, direction),
      firstBody: scoreGreater(a.bodyPct, 0.28, 0.58),
      secondBody: scoreGreater(b.bodyPct, 0.28, 0.58),
      gap: 1,
      oppositeRetrace: c.direction !== b.direction ? 1 : 0,
      gapHeld: gapHeld ? 1 : 0,
    }, { gap: 1.5, gapHeld: 1.6 });
    if (score < 0.72) return null;
    return makeCandidate(
      tasukiGap,
      features,
      index - 2,
      index,
      direction,
      score,
      `${direction === 'bullish' ? 'Upside' : 'Downside'} Tasuki Gap`,
      tasukiGap.description,
      { tasukiGap: score },
    );
  },
});

const twoCrows = definePattern({
  kind: 'two-crows',
  taLibName: 'CDL2CROWS',
  label: 'Two Crows',
  description: 'A bullish candle is followed by two bearish candles, with the second bearish candle closing back into the first body.',
  candleCount: 3,
  detect(features, index) {
    const a = features[index - 2];
    const b = features[index - 1];
    const c = features[index];
    if (!a || !b || !c) return null;
    const score = weightedScore({
      uptrend: trendScore(a, 'bullish'),
      firstBullish: a.direction === 'bullish' ? 1 : 0,
      firstLong: isLongBody(a),
      secondBearish: b.direction === 'bearish' ? 1 : 0,
      thirdBearish: c.direction === 'bearish' ? 1 : 0,
      secondGapUp: bodyGapUp(a, b) ? 1 : 0,
      thirdOpensInsideSecond: c.open < bodyHigh(b) && c.open > bodyLow(b) ? 1 : 0,
      thirdClosesInFirstBody: c.close < bodyHigh(a) && c.close > bodyLow(a) ? 1 : 0,
    }, { secondGapUp: 1.4, thirdClosesInFirstBody: 1.6 });
    if (score < 0.74) return null;
    return makeCandidate(
      twoCrows,
      features,
      index - 2,
      index,
      'bearish',
      score,
      twoCrows.label,
      twoCrows.description,
      { twoCrows: score },
    );
  },
});

const upsideGapTwoCrows = definePattern({
  kind: 'upside-gap-two-crows',
  taLibName: 'CDLUPSIDEGAP2CROWS',
  label: 'Upside Gap Two Crows',
  description: 'Two bearish candles appear above a bullish candle, with the third engulfing the second while the upside gap remains open.',
  candleCount: 3,
  detect(features, index) {
    const a = features[index - 2];
    const b = features[index - 1];
    const c = features[index];
    if (!a || !b || !c) return null;
    const thirdEngulfsSecond = bodyHigh(c) >= bodyHigh(b) && bodyLow(c) <= bodyLow(b);
    const gapStillOpen = c.close > bodyHigh(a);
    const score = weightedScore({
      uptrend: trendScore(a, 'bullish'),
      firstBullish: a.direction === 'bullish' ? 1 : 0,
      firstLong: isLongBody(a),
      secondBearish: b.direction === 'bearish' ? 1 : 0,
      thirdBearish: c.direction === 'bearish' ? 1 : 0,
      secondGapUp: bodyGapUp(a, b) ? 1 : 0,
      thirdEngulfsSecond: thirdEngulfsSecond ? 1 : 0,
      gapStillOpen: gapStillOpen ? 1 : 0,
    }, { secondGapUp: 1.4, thirdEngulfsSecond: 1.5, gapStillOpen: 1.2 });
    if (score < 0.74) return null;
    return makeCandidate(
      upsideGapTwoCrows,
      features,
      index - 2,
      index,
      'bearish',
      score,
      upsideGapTwoCrows.label,
      upsideGapTwoCrows.description,
      { upsideGapTwoCrows: score },
    );
  },
});

export const TWO_CANDLE_PATTERN_DEFINITIONS: readonly TwoCandlePatternDefinition[] = [
  engulfing,
  harami,
  piercingLine,
  darkCloudCover,
  counterattack,
  dojiStar,
  haramiCross,
  homingPigeon,
  inNeck,
  matchingLow,
  onNeck,
  separatingLines,
  thrusting,
  tasukiGap,
  twoCrows,
  upsideGapTwoCrows,
];

export function detectTwoCandlePatternCandidatesFromFeatures(
  features: CandleFeature[],
  index: number,
  definitions: readonly TwoCandlePatternDefinition[] = TWO_CANDLE_PATTERN_DEFINITIONS,
) {
  return definitions
    .filter((definition) => index >= definition.candleCount - 1)
    .map((definition) => definition.detect(features, index))
    .filter((candidate): candidate is TwoCandlePatternCandidate => Boolean(candidate));
}

export function detectTwoCandlePatternCandidates(
  candles: CandleInput[],
  options: TwoCandlePatternDetectorOptions = {},
) {
  const features = normalizeCandles(candles, options.contextPeriod, options.trendPeriod);
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const definitions = options.definitions ?? TWO_CANDLE_PATTERN_DEFINITIONS;
  const candidates: TwoCandlePatternCandidate[] = [];

  for (let index = 0; index < features.length; index += 1) {
    for (const candidate of detectTwoCandlePatternCandidatesFromFeatures(features, index, definitions)) {
      if (candidate.confidence >= minConfidence || options.includeWeak) {
        candidates.push(candidate);
      }
    }
  }

  return candidates;
}
