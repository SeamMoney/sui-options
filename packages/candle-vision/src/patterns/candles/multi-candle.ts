import {
  bodyHigh,
  bodyLow,
  clamp01,
  scoreGreater,
  scoreLess,
} from '../../features';
import type { CandleDirection, CandleFeature } from '../../types';

type PatternDirection = Exclude<CandleDirection, 'neutral'>;

export type MultiCandlePatternKind =
  | 'three-inside'
  | 'three-outside'
  | 'three-line-strike'
  | 'three-stars-in-south'
  | 'abandoned-baby'
  | 'advance-block'
  | 'breakaway'
  | 'concealing-baby-swallow'
  | 'identical-three-crows'
  | 'kicking'
  | 'kicking-by-length'
  | 'ladder-bottom'
  | 'mat-hold'
  | 'rising-three-methods'
  | 'falling-three-methods'
  | 'stalled-pattern'
  | 'stick-sandwich'
  | 'tristar'
  | 'unique-three-river'
  | 'upside-gap-three-methods'
  | 'downside-gap-three-methods';

export type TaLibMultiCandlePatternName =
  | 'CDL3INSIDE'
  | 'CDL3OUTSIDE'
  | 'CDL3LINESTRIKE'
  | 'CDL3STARSINSOUTH'
  | 'CDLABANDONEDBABY'
  | 'CDLADVANCEBLOCK'
  | 'CDLBREAKAWAY'
  | 'CDLCONCEALBABYSWALL'
  | 'CDLIDENTICAL3CROWS'
  | 'CDLKICKING'
  | 'CDLKICKINGBYLENGTH'
  | 'CDLLADDERBOTTOM'
  | 'CDLMATHOLD'
  | 'CDLRISEFALL3METHODS'
  | 'CDLSTALLEDPATTERN'
  | 'CDLSTICKSANDWICH'
  | 'CDLTRISTAR'
  | 'CDLUNIQUE3RIVER'
  | 'CDLXSIDEGAP3METHODS';

export type MultiCandlePatternMatch = {
  kind: MultiCandlePatternKind;
  taLibName: TaLibMultiCandlePatternName;
  direction: CandleDirection;
  startIndex: number;
  endIndex: number;
  confidence: number;
  strength: number;
  label: string;
  description: string;
  scoreBreakdown: Record<string, number>;
};

export type MultiCandlePatternDefinition = {
  kind: MultiCandlePatternKind;
  taLibName: TaLibMultiCandlePatternName;
  label: string;
  minCandles: number;
  maxCandles: number;
  directions: CandleDirection[];
  detect: (features: CandleFeature[], index: number) => MultiCandlePatternMatch[];
};

type MatchConfig = {
  kind: MultiCandlePatternKind;
  taLibName: TaLibMultiCandlePatternName;
  direction: CandleDirection;
  label: string;
  description: string;
  bars: CandleFeature[];
  parts: Record<string, number>;
  weights?: Record<string, number>;
  threshold?: number;
};

const DEFAULT_THRESHOLD = 0.72;

function weightedScore(parts: Record<string, number>, weights?: Record<string, number>) {
  const entries = Object.entries(parts);
  const totalWeight = entries.reduce((sum, [key]) => sum + (weights?.[key] ?? 1), 0);
  if (!entries.length || totalWeight <= 0) return 0;
  return clamp01(entries.reduce((sum, [key, value]) => sum + clamp01(value) * (weights?.[key] ?? 1), 0) / totalWeight);
}

function matchFrom(config: MatchConfig): MultiCandlePatternMatch[] {
  // A pattern named for a defining feature (a gap, a doji) must actually HAVE it.
  // The weighted average alone let context terms carry e.g. "Downside Gap Three
  // Methods" or a Tasuki Gap over threshold with NO gap (the namesake part scored
  // ~0 but was only weighted, never required). Gate the score on the MINIMUM of any
  // part whose key names such a defining feature (gap* / doji), so a near-zero
  // namesake kills the match. Patterns with no such part are unaffected (gate = 1).
  const gateParts = Object.entries(config.parts).filter(([k]) => /gap|doji/i.test(k));
  const gate = gateParts.length ? Math.min(...gateParts.map(([, v]) => clamp01(v))) : 1;
  const confidence = clamp01(gate * weightedScore(config.parts, config.weights));
  if (confidence < (config.threshold ?? DEFAULT_THRESHOLD)) return [];
  const start = config.bars[0];
  const end = config.bars[config.bars.length - 1];

  return [{
    kind: config.kind,
    taLibName: config.taLibName,
    direction: config.direction,
    startIndex: start.index,
    endIndex: end.index,
    confidence,
    strength: confidence,
    label: config.label,
    description: config.description,
    scoreBreakdown: config.parts,
  }];
}

function windowAt(features: CandleFeature[], endIndex: number, length: number) {
  if (endIndex < length - 1) return null;
  return features.slice(endIndex - length + 1, endIndex + 1);
}

function isBullish(bar: CandleFeature) {
  return bar.direction === 'bullish';
}

function isBearish(bar: CandleFeature) {
  return bar.direction === 'bearish';
}

function average(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function longBodyScore(bar: CandleFeature) {
  return weightedScore({
    bodyPct: scoreGreater(bar.bodyPct, 0.48, 0.74),
    bodyRatio: scoreGreater(bar.bodyRatio, 0.86, 1.46),
  });
}

function smallBodyScore(bar: CandleFeature) {
  return weightedScore({
    bodyPct: scoreLess(bar.bodyPct, 0.28, 0.5),
    bodyRatio: scoreLess(bar.bodyRatio, 0.72, 1.12),
  });
}

function verySmallBodyScore(bar: CandleFeature) {
  return weightedScore({
    bodyPct: scoreLess(bar.bodyPct, 0.12, 0.26),
    bodyRatio: scoreLess(bar.bodyRatio, 0.46, 0.82),
  });
}

function dojiScore(bar: CandleFeature) {
  return weightedScore({
    body: scoreLess(bar.bodyPct, 0.08, 0.18),
    range: scoreGreater(bar.rangeRatio, 0.56, 1.08),
  });
}

function marubozuScore(bar: CandleFeature) {
  return weightedScore({
    body: scoreGreater(bar.bodyPct, 0.72, 0.92),
    upper: scoreLess(bar.upperPct, 0.08, 0.18),
    lower: scoreLess(bar.lowerPct, 0.08, 0.18),
  });
}

function bodyMid(bar: CandleFeature) {
  return (bar.open + bar.close) / 2;
}

function bodyContains(outer: CandleFeature, inner: CandleFeature) {
  return bodyHigh(inner) <= bodyHigh(outer) && bodyLow(inner) >= bodyLow(outer);
}

function rangeContains(outer: CandleFeature, inner: CandleFeature) {
  return inner.high <= outer.high && inner.low >= outer.low;
}

function opensInsideBody(current: CandleFeature, previous: CandleFeature) {
  return current.open <= bodyHigh(previous) && current.open >= bodyLow(previous);
}

function bodyEngulfs(current: CandleFeature, previous: CandleFeature) {
  return bodyHigh(current) >= bodyHigh(previous) && bodyLow(current) <= bodyLow(previous);
}

function similarPriceScore(a: number, b: number, scale: number) {
  const distance = Math.abs(a - b);
  const denominator = Math.max(scale, 1e-9);
  return scoreLess(distance / denominator, 0.08, 0.22);
}

function gapUpScore(previous: CandleFeature, current: CandleFeature) {
  if (current.low > previous.high) return 1;
  if (bodyLow(current) > bodyHigh(previous)) return 0.86;
  if (current.open > previous.close) return 0.58;
  return 0;
}

function gapDownScore(previous: CandleFeature, current: CandleFeature) {
  if (current.high < previous.low) return 1;
  if (bodyHigh(current) < bodyLow(previous)) return 0.86;
  if (current.open < previous.close) return 0.58;
  return 0;
}

function downtrendScore(bar: CandleFeature) {
  if (bar.trendDirection === 'bearish') return 1;
  if (bar.trendSlope < 0) return 0.76;
  return 0.42;
}

function uptrendScore(bar: CandleFeature) {
  if (bar.trendDirection === 'bullish') return 1;
  if (bar.trendSlope > 0) return 0.76;
  return 0.42;
}

function directionRunScore(bars: CandleFeature[], direction: PatternDirection) {
  const directionScore = average(bars.map((bar) => (direction === 'bullish' ? (isBullish(bar) ? 1 : 0) : (isBearish(bar) ? 1 : 0))));
  const closeScore = direction === 'bullish'
    ? bars.every((bar, index) => index === 0 || bar.close > bars[index - 1].close) ? 1 : 0
    : bars.every((bar, index) => index === 0 || bar.close < bars[index - 1].close) ? 1 : 0;

  return weightedScore({ direction: directionScore, closes: closeScore }, { direction: 2, closes: 1 });
}

function threeInside(features: CandleFeature[], index: number): MultiCandlePatternMatch[] {
  const bars = windowAt(features, index, 3);
  if (!bars) return [];
  const [a, b, c] = bars;

  const bullish = matchFrom({
    kind: 'three-inside',
    taLibName: 'CDL3INSIDE',
    direction: 'bullish',
    label: 'Bullish Three Inside',
    description: 'Bearish candle, inside pause, then bullish confirmation through the first body.',
    bars,
    parts: {
      priorTrend: downtrendScore(a),
      firstBearish: isBearish(a) ? 1 : 0,
      firstLong: longBodyScore(a),
      insideBody: bodyContains(a, b) ? 1 : 0,
      pauseBody: smallBodyScore(b),
      confirmation: isBullish(c) ? 1 : 0,
      recovery: c.close > bodyMid(a) ? 1 : c.close > b.close ? 0.58 : 0,
    },
    weights: { firstBearish: 1.3, insideBody: 1.5, confirmation: 1.4, recovery: 1.2 },
  });

  const bearish = matchFrom({
    kind: 'three-inside',
    taLibName: 'CDL3INSIDE',
    direction: 'bearish',
    label: 'Bearish Three Inside',
    description: 'Bullish candle, inside pause, then bearish confirmation through the first body.',
    bars,
    parts: {
      priorTrend: uptrendScore(a),
      firstBullish: isBullish(a) ? 1 : 0,
      firstLong: longBodyScore(a),
      insideBody: bodyContains(a, b) ? 1 : 0,
      pauseBody: smallBodyScore(b),
      confirmation: isBearish(c) ? 1 : 0,
      rejection: c.close < bodyMid(a) ? 1 : c.close < b.close ? 0.58 : 0,
    },
    weights: { firstBullish: 1.3, insideBody: 1.5, confirmation: 1.4, rejection: 1.2 },
  });

  return [...bullish, ...bearish];
}

function threeOutside(features: CandleFeature[], index: number): MultiCandlePatternMatch[] {
  const bars = windowAt(features, index, 3);
  if (!bars) return [];
  const [a, b, c] = bars;

  const bullish = matchFrom({
    kind: 'three-outside',
    taLibName: 'CDL3OUTSIDE',
    direction: 'bullish',
    label: 'Bullish Three Outside',
    description: 'Bullish engulfing pair followed by a higher bullish close.',
    bars,
    parts: {
      priorTrend: downtrendScore(a),
      firstBearish: isBearish(a) ? 1 : 0,
      engulfingBull: isBullish(b) ? 1 : 0,
      engulfs: bodyEngulfs(b, a) ? 1 : 0,
      confirmationBull: isBullish(c) ? 1 : 0,
      higherClose: c.close > b.close ? 1 : 0,
    },
    weights: { engulfingBull: 1.3, engulfs: 1.8, confirmationBull: 1.2, higherClose: 1.4 },
  });

  const bearish = matchFrom({
    kind: 'three-outside',
    taLibName: 'CDL3OUTSIDE',
    direction: 'bearish',
    label: 'Bearish Three Outside',
    description: 'Bearish engulfing pair followed by a lower bearish close.',
    bars,
    parts: {
      priorTrend: uptrendScore(a),
      firstBullish: isBullish(a) ? 1 : 0,
      engulfingBear: isBearish(b) ? 1 : 0,
      engulfs: bodyEngulfs(b, a) ? 1 : 0,
      confirmationBear: isBearish(c) ? 1 : 0,
      lowerClose: c.close < b.close ? 1 : 0,
    },
    weights: { engulfingBear: 1.3, engulfs: 1.8, confirmationBear: 1.2, lowerClose: 1.4 },
  });

  return [...bullish, ...bearish];
}

function threeLineStrike(features: CandleFeature[], index: number): MultiCandlePatternMatch[] {
  const bars = windowAt(features, index, 4);
  if (!bars) return [];
  const [a, b, c, d] = bars;
  const firstThree = [a, b, c];

  const bullish = matchFrom({
    kind: 'three-line-strike',
    taLibName: 'CDL3LINESTRIKE',
    direction: 'bullish',
    label: 'Bullish Three-Line Strike',
    description: 'Three falling bearish candles are erased by a long bullish strike candle.',
    bars,
    parts: {
      priorTrend: downtrendScore(a),
      threeBearish: directionRunScore(firstThree, 'bearish'),
      strikeBullish: isBullish(d) ? 1 : 0,
      opensBelowThird: d.open < c.close ? 1 : d.open < c.open ? 0.62 : 0,
      closesAboveFirst: d.close > a.open ? 1 : d.close > bodyHigh(a) ? 0.76 : 0,
      strikeLong: longBodyScore(d),
    },
    weights: { threeBearish: 1.8, strikeBullish: 1.4, closesAboveFirst: 1.5 },
  });

  const bearish = matchFrom({
    kind: 'three-line-strike',
    taLibName: 'CDL3LINESTRIKE',
    direction: 'bearish',
    label: 'Bearish Three-Line Strike',
    description: 'Three rising bullish candles are erased by a long bearish strike candle.',
    bars,
    parts: {
      priorTrend: uptrendScore(a),
      threeBullish: directionRunScore(firstThree, 'bullish'),
      strikeBearish: isBearish(d) ? 1 : 0,
      opensAboveThird: d.open > c.close ? 1 : d.open > c.open ? 0.62 : 0,
      closesBelowFirst: d.close < a.open ? 1 : d.close < bodyLow(a) ? 0.76 : 0,
      strikeLong: longBodyScore(d),
    },
    weights: { threeBullish: 1.8, strikeBearish: 1.4, closesBelowFirst: 1.5 },
  });

  return [...bullish, ...bearish];
}

function threeStarsInSouth(features: CandleFeature[], index: number): MultiCandlePatternMatch[] {
  const bars = windowAt(features, index, 3);
  if (!bars) return [];
  const [a, b, c] = bars;

  return matchFrom({
    kind: 'three-stars-in-south',
    taLibName: 'CDL3STARSINSOUTH',
    direction: 'bullish',
    label: 'Three Stars in the South',
    description: 'Three bearish candles compress with rising lows after a selloff.',
    bars,
    parts: {
      priorTrend: downtrendScore(a),
      allBearish: [a, b, c].every(isBearish) ? 1 : 0,
      firstLongLowerShadow: weightedScore({ body: longBodyScore(a), lower: scoreGreater(a.lowerPct, 0.28, 0.52) }),
      shrinkingBodies: a.body > b.body && b.body >= c.body ? 1 : 0,
      risingLows: b.low > a.low && c.low >= b.low ? 1 : b.low > a.low ? 0.56 : 0,
      finalContained: rangeContains(b, c) ? 1 : bodyContains(b, c) ? 0.72 : 0,
      finalShortWicks: weightedScore({ upper: scoreLess(c.upperPct, 0.12, 0.26), lower: scoreLess(c.lowerPct, 0.12, 0.26) }),
    },
    weights: { allBearish: 1.5, shrinkingBodies: 1.2, risingLows: 1.5, finalContained: 1.2 },
    threshold: 0.7,
  });
}

function abandonedBaby(features: CandleFeature[], index: number): MultiCandlePatternMatch[] {
  const bars = windowAt(features, index, 3);
  if (!bars) return [];
  const [a, b, c] = bars;

  const bullish = matchFrom({
    kind: 'abandoned-baby',
    taLibName: 'CDLABANDONEDBABY',
    direction: 'bullish',
    label: 'Bullish Abandoned Baby',
    description: 'A downside doji gap is abandoned by a bullish gap and recovery candle.',
    bars,
    parts: {
      priorTrend: downtrendScore(a),
      firstBearish: isBearish(a) ? 1 : 0,
      firstLong: longBodyScore(a),
      doji: dojiScore(b),
      gapDown: gapDownScore(a, b),
      gapUpFromDoji: gapUpScore(b, c),
      thirdBullish: isBullish(c) ? 1 : 0,
      penetration: c.close > bodyMid(a) ? 1 : c.close > b.high ? 0.62 : 0,
    },
    weights: { doji: 1.6, gapDown: 1.4, gapUpFromDoji: 1.4, thirdBullish: 1.2, penetration: 1.2 },
  });

  const bearish = matchFrom({
    kind: 'abandoned-baby',
    taLibName: 'CDLABANDONEDBABY',
    direction: 'bearish',
    label: 'Bearish Abandoned Baby',
    description: 'An upside doji gap is abandoned by a bearish gap and rejection candle.',
    bars,
    parts: {
      priorTrend: uptrendScore(a),
      firstBullish: isBullish(a) ? 1 : 0,
      firstLong: longBodyScore(a),
      doji: dojiScore(b),
      gapUp: gapUpScore(a, b),
      gapDownFromDoji: gapDownScore(b, c),
      thirdBearish: isBearish(c) ? 1 : 0,
      penetration: c.close < bodyMid(a) ? 1 : c.close < b.low ? 0.62 : 0,
    },
    weights: { doji: 1.6, gapUp: 1.4, gapDownFromDoji: 1.4, thirdBearish: 1.2, penetration: 1.2 },
  });

  return [...bullish, ...bearish];
}

function advanceBlock(features: CandleFeature[], index: number): MultiCandlePatternMatch[] {
  const bars = windowAt(features, index, 3);
  if (!bars) return [];
  const [a, b, c] = bars;
  const upperExpansion = c.upperPct > b.upperPct || b.upperPct > a.upperPct ? 1 : 0;
  const bodyDecay = a.body > b.body && b.body >= c.body ? 1 : a.body > c.body ? 0.64 : 0;
  const highAdvanceA = b.high - a.high;
  const highAdvanceB = c.high - b.high;

  return matchFrom({
    kind: 'advance-block',
    taLibName: 'CDLADVANCEBLOCK',
    direction: 'bearish',
    label: 'Advance Block',
    description: 'Three bullish advances lose body size and build upper-shadow rejection.',
    bars,
    parts: {
      priorTrend: uptrendScore(a),
      allBullish: [a, b, c].every(isBullish) ? 1 : 0,
      higherCloses: b.close > a.close && c.close > b.close ? 1 : 0,
      opensWithin: opensInsideBody(b, a) && opensInsideBody(c, b) ? 1 : 0.5,
      bodyDecay,
      upperShadows: upperExpansion,
      shrinkingHighAdvance: highAdvanceA > 0 && highAdvanceB > 0 && highAdvanceB < highAdvanceA ? 1 : 0.42,
    },
    weights: { allBullish: 1.5, higherCloses: 1.2, bodyDecay: 1.4, upperShadows: 1.2 },
    threshold: 0.7,
  });
}

function breakaway(features: CandleFeature[], index: number): MultiCandlePatternMatch[] {
  const bars = windowAt(features, index, 5);
  if (!bars) return [];
  const [a, b, c, d, e] = bars;
  const middle = [b, c, d];

  const bullish = matchFrom({
    kind: 'breakaway',
    taLibName: 'CDLBREAKAWAY',
    direction: 'bullish',
    label: 'Bullish Breakaway',
    description: 'A downside gap continuation fails as the fifth candle closes back into the gap.',
    bars,
    parts: {
      priorTrend: downtrendScore(a),
      firstBearishLong: isBearish(a) ? longBodyScore(a) : 0,
      gapDown: gapDownScore(a, b),
      middleWeakness: average(middle.map((bar) => isBearish(bar) || bar.close <= a.close ? 1 : 0)),
      lowerDrift: d.close <= b.close || d.low <= b.low ? 1 : 0.4,
      reversalBullish: isBullish(e) ? 1 : 0,
      closesIntoGap: e.close > bodyLow(a) || e.close > bodyHigh(b) ? 1 : e.close > d.close ? 0.58 : 0,
      notFullRecovery: e.close < bodyHigh(a) ? 1 : 0.5,
    },
    weights: { firstBearishLong: 1.3, gapDown: 1.5, reversalBullish: 1.4, closesIntoGap: 1.5 },
    threshold: 0.7,
  });

  const bearish = matchFrom({
    kind: 'breakaway',
    taLibName: 'CDLBREAKAWAY',
    direction: 'bearish',
    label: 'Bearish Breakaway',
    description: 'An upside gap continuation fails as the fifth candle closes back into the gap.',
    bars,
    parts: {
      priorTrend: uptrendScore(a),
      firstBullishLong: isBullish(a) ? longBodyScore(a) : 0,
      gapUp: gapUpScore(a, b),
      middleStrength: average(middle.map((bar) => isBullish(bar) || bar.close >= a.close ? 1 : 0)),
      higherDrift: d.close >= b.close || d.high >= b.high ? 1 : 0.4,
      reversalBearish: isBearish(e) ? 1 : 0,
      closesIntoGap: e.close < bodyHigh(a) || e.close < bodyLow(b) ? 1 : e.close < d.close ? 0.58 : 0,
      notFullBreakdown: e.close > bodyLow(a) ? 1 : 0.5,
    },
    weights: { firstBullishLong: 1.3, gapUp: 1.5, reversalBearish: 1.4, closesIntoGap: 1.5 },
    threshold: 0.7,
  });

  return [...bullish, ...bearish];
}

function concealingBabySwallow(features: CandleFeature[], index: number): MultiCandlePatternMatch[] {
  const bars = windowAt(features, index, 4);
  if (!bars) return [];
  const [a, b, c, d] = bars;

  return matchFrom({
    kind: 'concealing-baby-swallow',
    taLibName: 'CDLCONCEALBABYSWALL',
    direction: 'bullish',
    label: 'Concealing Baby Swallow',
    description: 'Four bearish candles hide a failed downside gap and full engulfing capitulation.',
    bars,
    parts: {
      priorTrend: downtrendScore(a),
      allBearish: [a, b, c, d].every(isBearish) ? 1 : 0,
      firstBlackMarubozu: marubozuScore(a),
      secondBlackMarubozu: marubozuScore(b),
      secondLower: b.close < a.close ? 1 : 0,
      thirdGapDown: gapDownScore(b, c),
      thirdUpperProbe: c.high > bodyLow(b) ? 1 : c.upperPct > 0.24 ? 0.62 : 0,
      fourthEngulfsThird: d.open > c.high && d.close < c.low ? 1 : bodyEngulfs(d, c) ? 0.72 : 0,
    },
    weights: { allBearish: 1.4, firstBlackMarubozu: 1.2, secondBlackMarubozu: 1.2, thirdGapDown: 1.1, fourthEngulfsThird: 1.5 },
    threshold: 0.7,
  });
}

function identicalThreeCrows(features: CandleFeature[], index: number): MultiCandlePatternMatch[] {
  const bars = windowAt(features, index, 3);
  if (!bars) return [];
  const [a, b, c] = bars;
  const scale = average(bars.map((bar) => bar.averageRange || bar.range));

  return matchFrom({
    kind: 'identical-three-crows',
    taLibName: 'CDLIDENTICAL3CROWS',
    direction: 'bearish',
    label: 'Identical Three Crows',
    description: 'Three bearish candles open near prior closes and print lower closes.',
    bars,
    parts: {
      priorTrend: uptrendScore(a),
      allBearish: bars.every(isBearish) ? 1 : 0,
      lowerCloses: b.close < a.close && c.close < b.close ? 1 : 0,
      opensAtPriorClose: average([
        similarPriceScore(b.open, a.close, scale),
        similarPriceScore(c.open, b.close, scale),
      ]),
      longBodies: average(bars.map(longBodyScore)),
      smallLowerShadows: average(bars.map((bar) => scoreLess(bar.lowerPct, 0.14, 0.28))),
    },
    weights: { allBearish: 1.5, lowerCloses: 1.4, opensAtPriorClose: 1.4 },
  });
}

function kicking(features: CandleFeature[], index: number): MultiCandlePatternMatch[] {
  const bars = windowAt(features, index, 2);
  if (!bars) return [];
  const [a, b] = bars;

  const bullish = matchFrom({
    kind: 'kicking',
    taLibName: 'CDLKICKING',
    direction: 'bullish',
    label: 'Bullish Kicking',
    description: 'Bearish marubozu gaps into a bullish marubozu reversal.',
    bars,
    parts: {
      firstBearishMarubozu: isBearish(a) ? marubozuScore(a) : 0,
      secondBullishMarubozu: isBullish(b) ? marubozuScore(b) : 0,
      gapUp: gapUpScore(a, b),
    },
    weights: { firstBearishMarubozu: 1.4, secondBullishMarubozu: 1.4, gapUp: 1.5 },
  });

  const bearish = matchFrom({
    kind: 'kicking',
    taLibName: 'CDLKICKING',
    direction: 'bearish',
    label: 'Bearish Kicking',
    description: 'Bullish marubozu gaps into a bearish marubozu reversal.',
    bars,
    parts: {
      firstBullishMarubozu: isBullish(a) ? marubozuScore(a) : 0,
      secondBearishMarubozu: isBearish(b) ? marubozuScore(b) : 0,
      gapDown: gapDownScore(a, b),
    },
    weights: { firstBullishMarubozu: 1.4, secondBearishMarubozu: 1.4, gapDown: 1.5 },
  });

  return [...bullish, ...bearish];
}

function kickingByLength(features: CandleFeature[], index: number): MultiCandlePatternMatch[] {
  const bars = windowAt(features, index, 2);
  if (!bars) return [];
  const [a, b] = bars;
  const oppositeMarubozu = marubozuScore(a) > 0.68 && marubozuScore(b) > 0.68 && a.direction !== 'neutral' && b.direction !== 'neutral' && a.direction !== b.direction;
  const gap = isBullish(b) ? gapUpScore(a, b) : gapDownScore(a, b);
  const longer = a.body > b.body ? a : b;
  const lengthEdge = Math.abs(a.body - b.body) / Math.max(average([a.averageBody, b.averageBody, a.body, b.body]), 1e-9);

  if (!oppositeMarubozu) return [];

  return matchFrom({
    kind: 'kicking-by-length',
    taLibName: 'CDLKICKINGBYLENGTH',
    direction: longer.direction,
    label: `${longer.direction === 'bullish' ? 'Bullish' : 'Bearish'} Kicking by Length`,
    description: 'Opposing marubozu candles gap apart, with direction assigned to the longer body.',
    bars,
    parts: {
      oppositeMarubozu: 1,
      gap,
      longerBodyEdge: scoreGreater(lengthEdge, 0.08, 0.36),
      longerBodyQuality: marubozuScore(longer),
    },
    weights: { oppositeMarubozu: 1.4, gap: 1.5, longerBodyEdge: 1.1 },
  });
}

function ladderBottom(features: CandleFeature[], index: number): MultiCandlePatternMatch[] {
  const bars = windowAt(features, index, 5);
  if (!bars) return [];
  const [a, b, c, d, e] = bars;
  const firstFour = [a, b, c, d];

  return matchFrom({
    kind: 'ladder-bottom',
    taLibName: 'CDLLADDERBOTTOM',
    direction: 'bullish',
    label: 'Ladder Bottom',
    description: 'Four declining bearish candles give way to a bullish candle above the prior body.',
    bars,
    parts: {
      priorTrend: downtrendScore(a),
      fourBearish: firstFour.every(isBearish) ? 1 : 0,
      lowerCloses: b.close < a.close && c.close < b.close && d.close < c.close ? 1 : 0,
      fourthUpperShadow: scoreGreater(d.upperPct, 0.22, 0.46),
      fifthBullish: isBullish(e) ? 1 : 0,
      fifthOpensAboveFourthBody: e.open > bodyHigh(d) ? 1 : e.open > d.close ? 0.62 : 0,
      fifthClosesStrong: e.close > d.high ? 1 : e.close > bodyHigh(d) ? 0.72 : 0,
    },
    weights: { fourBearish: 1.4, lowerCloses: 1.2, fifthBullish: 1.4, fifthClosesStrong: 1.4 },
    threshold: 0.7,
  });
}

function matHold(features: CandleFeature[], index: number): MultiCandlePatternMatch[] {
  const bars = windowAt(features, index, 5);
  if (!bars) return [];
  const [a, b, c, d, e] = bars;
  const middle = [b, c, d];

  const bullish = matchFrom({
    kind: 'mat-hold',
    taLibName: 'CDLMATHOLD',
    direction: 'bullish',
    label: 'Bullish Mat Hold',
    description: 'A strong bullish candle holds its gap through shallow pullback bars, then continues higher.',
    bars,
    parts: {
      priorTrend: uptrendScore(a),
      firstBullishLong: isBullish(a) ? longBodyScore(a) : 0,
      gapUp: gapUpScore(a, b),
      middleSmall: average(middle.map(smallBodyScore)),
      middleHeldAboveFirstOpen: middle.every((bar) => bar.low > bodyLow(a)) ? 1 : 0,
      pullbackNotDeep: Math.min(...middle.map((bar) => bar.low)) > bodyMid(a) ? 1 : 0.58,
      finalBullish: isBullish(e) ? 1 : 0,
      finalBreakout: e.close > Math.max(a.close, b.close, c.close, d.close) ? 1 : e.close > d.close ? 0.62 : 0,
    },
    weights: { firstBullishLong: 1.4, gapUp: 1.2, middleHeldAboveFirstOpen: 1.3, finalBullish: 1.2, finalBreakout: 1.5 },
    threshold: 0.7,
  });

  const bearish = matchFrom({
    kind: 'mat-hold',
    taLibName: 'CDLMATHOLD',
    direction: 'bearish',
    label: 'Bearish Mat Hold',
    description: 'A strong bearish candle holds its gap through shallow rebound bars, then continues lower.',
    bars,
    parts: {
      priorTrend: downtrendScore(a),
      firstBearishLong: isBearish(a) ? longBodyScore(a) : 0,
      gapDown: gapDownScore(a, b),
      middleSmall: average(middle.map(smallBodyScore)),
      middleHeldBelowFirstOpen: middle.every((bar) => bar.high < bodyHigh(a)) ? 1 : 0,
      reboundNotDeep: Math.max(...middle.map((bar) => bar.high)) < bodyMid(a) ? 1 : 0.58,
      finalBearish: isBearish(e) ? 1 : 0,
      finalBreakdown: e.close < Math.min(a.close, b.close, c.close, d.close) ? 1 : e.close < d.close ? 0.62 : 0,
    },
    weights: { firstBearishLong: 1.4, gapDown: 1.2, middleHeldBelowFirstOpen: 1.3, finalBearish: 1.2, finalBreakdown: 1.5 },
    threshold: 0.7,
  });

  return [...bullish, ...bearish];
}

function risingThreeMethods(features: CandleFeature[], index: number): MultiCandlePatternMatch[] {
  const bars = windowAt(features, index, 5);
  if (!bars) return [];
  const [a, b, c, d, e] = bars;
  const middle = [b, c, d];

  return matchFrom({
    kind: 'rising-three-methods',
    taLibName: 'CDLRISEFALL3METHODS',
    direction: 'bullish',
    label: 'Rising Three Methods',
    description: 'A bullish impulse contains three small pullback candles before continuation.',
    bars,
    parts: {
      priorTrend: uptrendScore(a),
      firstBullishLong: isBullish(a) ? longBodyScore(a) : 0,
      middleSmall: average(middle.map(smallBodyScore)),
      middleMostlyBearish: average(middle.map((bar) => (isBearish(bar) || bar.direction === 'neutral' ? 1 : 0))),
      containedInFirstRange: middle.every((bar) => bar.high < a.high && bar.low > a.low) ? 1 : 0,
      finalBullish: isBullish(e) ? 1 : 0,
      finalCloseBreakout: e.close > a.close && e.close > Math.max(b.close, c.close, d.close) ? 1 : 0,
    },
    weights: { firstBullishLong: 1.4, middleSmall: 1.3, containedInFirstRange: 1.4, finalBullish: 1.2, finalCloseBreakout: 1.5 },
  });
}

function fallingThreeMethods(features: CandleFeature[], index: number): MultiCandlePatternMatch[] {
  const bars = windowAt(features, index, 5);
  if (!bars) return [];
  const [a, b, c, d, e] = bars;
  const middle = [b, c, d];

  return matchFrom({
    kind: 'falling-three-methods',
    taLibName: 'CDLRISEFALL3METHODS',
    direction: 'bearish',
    label: 'Falling Three Methods',
    description: 'A bearish impulse contains three small rebound candles before continuation.',
    bars,
    parts: {
      priorTrend: downtrendScore(a),
      firstBearishLong: isBearish(a) ? longBodyScore(a) : 0,
      middleSmall: average(middle.map(smallBodyScore)),
      middleMostlyBullish: average(middle.map((bar) => (isBullish(bar) || bar.direction === 'neutral' ? 1 : 0))),
      containedInFirstRange: middle.every((bar) => bar.high < a.high && bar.low > a.low) ? 1 : 0,
      finalBearish: isBearish(e) ? 1 : 0,
      finalCloseBreakdown: e.close < a.close && e.close < Math.min(b.close, c.close, d.close) ? 1 : 0,
    },
    weights: { firstBearishLong: 1.4, middleSmall: 1.3, containedInFirstRange: 1.4, finalBearish: 1.2, finalCloseBreakdown: 1.5 },
  });
}

function stalledPattern(features: CandleFeature[], index: number): MultiCandlePatternMatch[] {
  const bars = windowAt(features, index, 3);
  if (!bars) return [];
  const [a, b, c] = bars;
  const scale = average(bars.map((bar) => bar.averageRange || bar.range));

  return matchFrom({
    kind: 'stalled-pattern',
    taLibName: 'CDLSTALLEDPATTERN',
    direction: 'bearish',
    label: 'Stalled Pattern',
    description: 'Three bullish candles continue higher, but the final candle stalls with a small body.',
    bars,
    parts: {
      priorTrend: uptrendScore(a),
      allBullish: bars.every(isBullish) ? 1 : 0,
      firstTwoLong: average([longBodyScore(a), longBodyScore(b)]),
      higherCloses: b.close > a.close && c.close > b.close ? 1 : 0,
      thirdSmall: smallBodyScore(c),
      thirdNearSecondClose: similarPriceScore(c.close, b.close, scale),
      upperRejection: scoreGreater(c.upperPct, 0.2, 0.44),
    },
    weights: { allBullish: 1.4, firstTwoLong: 1.2, thirdSmall: 1.4, thirdNearSecondClose: 1.1 },
    threshold: 0.7,
  });
}

function stickSandwich(features: CandleFeature[], index: number): MultiCandlePatternMatch[] {
  const bars = windowAt(features, index, 3);
  if (!bars) return [];
  const [a, b, c] = bars;
  const scale = average(bars.map((bar) => bar.averageRange || bar.range));

  return matchFrom({
    kind: 'stick-sandwich',
    taLibName: 'CDLSTICKSANDWICH',
    direction: 'bullish',
    label: 'Stick Sandwich',
    description: 'A bullish candle is sandwiched by two bearish candles that close at nearly the same price.',
    bars,
    parts: {
      priorTrend: downtrendScore(a),
      firstBearish: isBearish(a) ? 1 : 0,
      middleBullish: isBullish(b) ? 1 : 0,
      thirdBearish: isBearish(c) ? 1 : 0,
      matchingBearCloses: similarPriceScore(a.close, c.close, scale),
      middleAboveCloses: b.close > a.close && b.close > c.close ? 1 : 0,
    },
    weights: { firstBearish: 1.2, middleBullish: 1.2, thirdBearish: 1.2, matchingBearCloses: 1.6 },
  });
}

function tristar(features: CandleFeature[], index: number): MultiCandlePatternMatch[] {
  const bars = windowAt(features, index, 3);
  if (!bars) return [];
  const [a, b, c] = bars;

  const bullish = matchFrom({
    kind: 'tristar',
    taLibName: 'CDLTRISTAR',
    direction: 'bullish',
    label: 'Bullish Tristar',
    description: 'Three doji stars form a low-centered reversal after a decline.',
    bars,
    parts: {
      priorTrend: downtrendScore(a),
      allDoji: average(bars.map(dojiScore)),
      middleBelow: b.low < a.low && b.low < c.low ? 1 : 0,
      firstGapDown: gapDownScore(a, b),
      thirdGapUp: gapUpScore(b, c),
      closeRecovery: c.close >= b.close ? 1 : 0.5,
    },
    weights: { allDoji: 1.8, middleBelow: 1.4, firstGapDown: 1.1, thirdGapUp: 1.1 },
  });

  const bearish = matchFrom({
    kind: 'tristar',
    taLibName: 'CDLTRISTAR',
    direction: 'bearish',
    label: 'Bearish Tristar',
    description: 'Three doji stars form a high-centered reversal after an advance.',
    bars,
    parts: {
      priorTrend: uptrendScore(a),
      allDoji: average(bars.map(dojiScore)),
      middleAbove: b.high > a.high && b.high > c.high ? 1 : 0,
      firstGapUp: gapUpScore(a, b),
      thirdGapDown: gapDownScore(b, c),
      closeFade: c.close <= b.close ? 1 : 0.5,
    },
    weights: { allDoji: 1.8, middleAbove: 1.4, firstGapUp: 1.1, thirdGapDown: 1.1 },
  });

  return [...bullish, ...bearish];
}

function uniqueThreeRiver(features: CandleFeature[], index: number): MultiCandlePatternMatch[] {
  const bars = windowAt(features, index, 3);
  if (!bars) return [];
  const [a, b, c] = bars;

  return matchFrom({
    kind: 'unique-three-river',
    taLibName: 'CDLUNIQUE3RIVER',
    direction: 'bullish',
    label: 'Unique Three River',
    description: 'A long bearish candle, lower hammer-like test, and small recovery show seller exhaustion.',
    bars,
    parts: {
      priorTrend: downtrendScore(a),
      firstBearishLong: isBearish(a) ? longBodyScore(a) : 0,
      secondBearish: isBearish(b) ? 1 : 0,
      secondMakesNewLow: b.low < a.low ? 1 : 0,
      secondClosesInsideFirst: b.close > a.close && b.close < a.open ? 1 : 0.56,
      secondLowerShadow: scoreGreater(b.lowerPct, 0.34, 0.62),
      thirdSmallBullish: isBullish(c) ? smallBodyScore(c) : 0,
      thirdHoldsSecondLow: c.low > b.low ? 1 : 0,
    },
    weights: { firstBearishLong: 1.4, secondMakesNewLow: 1.2, secondLowerShadow: 1.3, thirdSmallBullish: 1.2, thirdHoldsSecondLow: 1.2 },
  });
}

function upsideGapThreeMethods(features: CandleFeature[], index: number): MultiCandlePatternMatch[] {
  const bars = windowAt(features, index, 3);
  if (!bars) return [];
  const [a, b, c] = bars;

  return matchFrom({
    kind: 'upside-gap-three-methods',
    taLibName: 'CDLXSIDEGAP3METHODS',
    direction: 'bullish',
    label: 'Upside Gap Three Methods',
    description: 'Two bullish candles leave an upside gap that the third candle partially fills without breaking trend.',
    bars,
    parts: {
      priorTrend: uptrendScore(a),
      firstBullish: isBullish(a) ? 1 : 0,
      secondBullish: isBullish(b) ? 1 : 0,
      upsideGap: gapUpScore(a, b),
      thirdBearish: isBearish(c) ? 1 : 0,
      thirdOpensInSecondBody: opensInsideBody(c, b) ? 1 : 0.45,
      fillsGapButHolds: c.close < bodyLow(b) && c.close > bodyHigh(a) ? 1 : c.close > a.close ? 0.58 : 0,
    },
    weights: { upsideGap: 1.5, thirdBearish: 1.2, fillsGapButHolds: 1.5 },
  });
}

function downsideGapThreeMethods(features: CandleFeature[], index: number): MultiCandlePatternMatch[] {
  const bars = windowAt(features, index, 3);
  if (!bars) return [];
  const [a, b, c] = bars;

  return matchFrom({
    kind: 'downside-gap-three-methods',
    taLibName: 'CDLXSIDEGAP3METHODS',
    direction: 'bearish',
    label: 'Downside Gap Three Methods',
    description: 'Two bearish candles leave a downside gap that the third candle partially fills without reversing trend.',
    bars,
    parts: {
      priorTrend: downtrendScore(a),
      firstBearish: isBearish(a) ? 1 : 0,
      secondBearish: isBearish(b) ? 1 : 0,
      downsideGap: gapDownScore(a, b),
      thirdBullish: isBullish(c) ? 1 : 0,
      thirdOpensInSecondBody: opensInsideBody(c, b) ? 1 : 0.45,
      fillsGapButHolds: c.close > bodyHigh(b) && c.close < bodyLow(a) ? 1 : c.close < a.close ? 0.58 : 0,
    },
    weights: { downsideGap: 1.5, thirdBullish: 1.2, fillsGapButHolds: 1.5 },
  });
}

export const MULTI_CANDLE_PATTERN_DEFINITIONS: MultiCandlePatternDefinition[] = [
  {
    kind: 'three-inside',
    taLibName: 'CDL3INSIDE',
    label: 'Three Inside',
    minCandles: 3,
    maxCandles: 3,
    directions: ['bullish', 'bearish'],
    detect: threeInside,
  },
  {
    kind: 'three-outside',
    taLibName: 'CDL3OUTSIDE',
    label: 'Three Outside',
    minCandles: 3,
    maxCandles: 3,
    directions: ['bullish', 'bearish'],
    detect: threeOutside,
  },
  {
    kind: 'three-line-strike',
    taLibName: 'CDL3LINESTRIKE',
    label: 'Three-Line Strike',
    minCandles: 4,
    maxCandles: 4,
    directions: ['bullish', 'bearish'],
    detect: threeLineStrike,
  },
  {
    kind: 'three-stars-in-south',
    taLibName: 'CDL3STARSINSOUTH',
    label: 'Three Stars in the South',
    minCandles: 3,
    maxCandles: 3,
    directions: ['bullish'],
    detect: threeStarsInSouth,
  },
  {
    kind: 'abandoned-baby',
    taLibName: 'CDLABANDONEDBABY',
    label: 'Abandoned Baby',
    minCandles: 3,
    maxCandles: 3,
    directions: ['bullish', 'bearish'],
    detect: abandonedBaby,
  },
  {
    kind: 'advance-block',
    taLibName: 'CDLADVANCEBLOCK',
    label: 'Advance Block',
    minCandles: 3,
    maxCandles: 3,
    directions: ['bearish'],
    detect: advanceBlock,
  },
  {
    kind: 'breakaway',
    taLibName: 'CDLBREAKAWAY',
    label: 'Breakaway',
    minCandles: 5,
    maxCandles: 5,
    directions: ['bullish', 'bearish'],
    detect: breakaway,
  },
  {
    kind: 'concealing-baby-swallow',
    taLibName: 'CDLCONCEALBABYSWALL',
    label: 'Concealing Baby Swallow',
    minCandles: 4,
    maxCandles: 4,
    directions: ['bullish'],
    detect: concealingBabySwallow,
  },
  {
    kind: 'identical-three-crows',
    taLibName: 'CDLIDENTICAL3CROWS',
    label: 'Identical Three Crows',
    minCandles: 3,
    maxCandles: 3,
    directions: ['bearish'],
    detect: identicalThreeCrows,
  },
  {
    kind: 'kicking',
    taLibName: 'CDLKICKING',
    label: 'Kicking',
    minCandles: 2,
    maxCandles: 2,
    directions: ['bullish', 'bearish'],
    detect: kicking,
  },
  {
    kind: 'kicking-by-length',
    taLibName: 'CDLKICKINGBYLENGTH',
    label: 'Kicking by Length',
    minCandles: 2,
    maxCandles: 2,
    directions: ['bullish', 'bearish'],
    detect: kickingByLength,
  },
  {
    kind: 'ladder-bottom',
    taLibName: 'CDLLADDERBOTTOM',
    label: 'Ladder Bottom',
    minCandles: 5,
    maxCandles: 5,
    directions: ['bullish'],
    detect: ladderBottom,
  },
  {
    kind: 'mat-hold',
    taLibName: 'CDLMATHOLD',
    label: 'Mat Hold',
    minCandles: 5,
    maxCandles: 5,
    directions: ['bullish', 'bearish'],
    detect: matHold,
  },
  {
    kind: 'rising-three-methods',
    taLibName: 'CDLRISEFALL3METHODS',
    label: 'Rising Three Methods',
    minCandles: 5,
    maxCandles: 5,
    directions: ['bullish'],
    detect: risingThreeMethods,
  },
  {
    kind: 'falling-three-methods',
    taLibName: 'CDLRISEFALL3METHODS',
    label: 'Falling Three Methods',
    minCandles: 5,
    maxCandles: 5,
    directions: ['bearish'],
    detect: fallingThreeMethods,
  },
  {
    kind: 'stalled-pattern',
    taLibName: 'CDLSTALLEDPATTERN',
    label: 'Stalled Pattern',
    minCandles: 3,
    maxCandles: 3,
    directions: ['bearish'],
    detect: stalledPattern,
  },
  {
    kind: 'stick-sandwich',
    taLibName: 'CDLSTICKSANDWICH',
    label: 'Stick Sandwich',
    minCandles: 3,
    maxCandles: 3,
    directions: ['bullish'],
    detect: stickSandwich,
  },
  {
    kind: 'tristar',
    taLibName: 'CDLTRISTAR',
    label: 'Tristar',
    minCandles: 3,
    maxCandles: 3,
    directions: ['bullish', 'bearish'],
    detect: tristar,
  },
  {
    kind: 'unique-three-river',
    taLibName: 'CDLUNIQUE3RIVER',
    label: 'Unique Three River',
    minCandles: 3,
    maxCandles: 3,
    directions: ['bullish'],
    detect: uniqueThreeRiver,
  },
  {
    kind: 'upside-gap-three-methods',
    taLibName: 'CDLXSIDEGAP3METHODS',
    label: 'Upside Gap Three Methods',
    minCandles: 3,
    maxCandles: 3,
    directions: ['bullish'],
    detect: upsideGapThreeMethods,
  },
  {
    kind: 'downside-gap-three-methods',
    taLibName: 'CDLXSIDEGAP3METHODS',
    label: 'Downside Gap Three Methods',
    minCandles: 3,
    maxCandles: 3,
    directions: ['bearish'],
    detect: downsideGapThreeMethods,
  },
];

export function detectMultiCandlePatternMatches(
  features: CandleFeature[],
  index: number,
  definitions = MULTI_CANDLE_PATTERN_DEFINITIONS,
) {
  return definitions.flatMap((definition) => definition.detect(features, index));
}
