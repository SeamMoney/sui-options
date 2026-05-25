import {
  bodyHigh,
  bodyLow,
  clamp01,
  normalizeCandles,
  scoreGreater,
  scoreLess,
} from './features';
import type {
  CandleDirection,
  CandleFeature,
  CandleInput,
  CandlePatternAnchor,
  CandlePatternDetectorOptions,
  CandlePatternEvent,
  CandlePatternKind,
} from './types';

const DEFAULT_OPTIONS: Required<CandlePatternDetectorOptions> = {
  lookback: 240,
  minConfidence: 0.58,
  includeWeak: false,
  trendPeriod: 12,
  contextPeriod: 20,
  enableClassicPatterns: true,
  enableVisionPatterns: true,
  enableChartSetups: true,
  enableTaPatterns: true,
};

const COLORS: Record<CandleDirection | 'compression', string> = {
  bullish: '#22c55e',
  bearish: '#ef4444',
  neutral: '#facc15',
  compression: '#38bdf8',
};

type Candidate = Omit<CandlePatternEvent, 'id' | 'detectedAt' | 'source' | 'color'> & {
  color?: string;
};

function makeId(kind: CandlePatternKind, startIndex: number, endIndex: number) {
  return `${kind}:${startIndex}:${endIndex}`;
}

function anchorsForRange(features: CandleFeature[], startIndex: number, endIndex: number, direction: CandleDirection): CandlePatternAnchor[] {
  const start = features[startIndex];
  const end = features[endIndex];
  const slice = features.slice(startIndex, endIndex + 1);
  const high = slice.reduce((best, bar) => (bar.high > best.high ? bar : best), slice[0]);
  const low = slice.reduce((best, bar) => (bar.low < best.low ? bar : best), slice[0]);
  const confirmationPrice = direction === 'bearish' ? end.low : direction === 'bullish' ? end.high : end.close;

  return [
    { index: start.index, time: start.time, price: start.open, role: 'start' },
    { index: high.index, time: high.time, price: high.high, role: 'high' },
    { index: low.index, time: low.time, price: low.low, role: 'low' },
    { index: end.index, time: end.time, price: confirmationPrice, role: 'confirmation' },
  ];
}

function anchorsForSingle(bar: CandleFeature, direction: CandleDirection): CandlePatternAnchor[] {
  const confirmationPrice = direction === 'bearish' ? bar.low : direction === 'bullish' ? bar.high : bar.close;
  return [
    { index: bar.index, time: bar.time, price: bar.open, role: 'start' },
    { index: bar.index, time: bar.time, price: bar.high, role: 'high' },
    { index: bar.index, time: bar.time, price: bar.low, role: 'low' },
    { index: bar.index, time: bar.time, price: confirmationPrice, role: 'confirmation' },
  ];
}

function createEvent(features: CandleFeature[], candidate: Candidate): CandlePatternEvent {
  return {
    ...candidate,
    id: makeId(candidate.kind, candidate.startIndex, candidate.endIndex),
    detectedAt: features[candidate.endIndex]?.time ?? Date.now(),
    source: 'candle-vision',
    color: candidate.color ?? COLORS[candidate.direction] ?? COLORS.neutral,
  };
}

function shiftEvent(event: CandlePatternEvent, offset: number, allCandles: CandleInput[]): CandlePatternEvent {
  if (offset === 0) return event;
  const startIndex = event.startIndex + offset;
  const endIndex = event.endIndex + offset;
  return {
    ...event,
    id: makeId(event.kind, startIndex, endIndex),
    startIndex,
    endIndex,
    detectedAt: allCandles[endIndex]?.time ?? event.detectedAt,
    anchors: event.anchors.map((anchor) => {
      const index = anchor.index + offset;
      return {
        ...anchor,
        index,
        time: allCandles[index]?.time ?? anchor.time,
      };
    }),
  };
}

function weightedScore(parts: Record<string, number>, weights?: Record<string, number>) {
  const entries = Object.entries(parts);
  const totalWeight = entries.reduce((sum, [key]) => sum + (weights?.[key] ?? 1), 0);
  if (!entries.length || totalWeight <= 0) return 0;
  return clamp01(entries.reduce((sum, [key, value]) => sum + clamp01(value) * (weights?.[key] ?? 1), 0) / totalWeight);
}

function singleBarCandidates(bar: CandleFeature): Candidate[] {
  const candidates: Candidate[] = [];
  const dojiScore = weightedScore({
    body: scoreLess(bar.bodyPct, 0.08, 0.18),
    range: scoreGreater(bar.rangeRatio, 0.75, 1.45),
  });
  if (dojiScore > 0.55) {
    candidates.push({
      kind: 'doji',
      family: 'candlestick',
      status: 'confirmed',
      direction: 'neutral',
      startIndex: bar.index,
      endIndex: bar.index,
      confidence: dojiScore,
      strength: dojiScore,
      label: 'Doji',
      description: 'Open and close are nearly equal, showing local indecision.',
      anchors: anchorsForSingle(bar, 'neutral'),
      scoreBreakdown: { dojiScore },
    });
  }

  const lowerRejection = weightedScore({
    lowerWick: scoreGreater(bar.lowerPct, 0.46, 0.72),
    body: scoreLess(bar.bodyPct, 0.32, 0.5),
    closeLocation: scoreGreater(bar.closeLocation, 0.56, 0.86),
    range: scoreGreater(bar.rangeRatio, 0.85, 1.8),
  });
  if (lowerRejection > 0.62) {
    const kind = bar.trendDirection === 'bullish' ? 'hanging-man' : 'hammer';
    candidates.push({
      kind,
      family: 'candlestick',
      status: 'confirmed',
      direction: kind === 'hanging-man' ? 'bearish' : 'bullish',
      startIndex: bar.index,
      endIndex: bar.index,
      confidence: lowerRejection,
      strength: lowerRejection,
      label: kind === 'hanging-man' ? 'Hanging Man' : 'Hammer',
      description: 'Long lower wick shows aggressive buying after a downside probe.',
      anchors: anchorsForSingle(bar, 'bullish'),
      scoreBreakdown: { lowerRejection },
    });
  }

  const upperRejection = weightedScore({
    upperWick: scoreGreater(bar.upperPct, 0.46, 0.72),
    body: scoreLess(bar.bodyPct, 0.32, 0.5),
    closeLocation: scoreLess(bar.closeLocation, 0.44, 0.14),
    range: scoreGreater(bar.rangeRatio, 0.85, 1.8),
  });
  if (upperRejection > 0.62) {
    const kind = bar.trendDirection === 'bearish' ? 'inverted-hammer' : 'shooting-star';
    candidates.push({
      kind,
      family: 'candlestick',
      status: 'confirmed',
      direction: kind === 'inverted-hammer' ? 'bullish' : 'bearish',
      startIndex: bar.index,
      endIndex: bar.index,
      confidence: upperRejection,
      strength: upperRejection,
      label: kind === 'inverted-hammer' ? 'Inverted Hammer' : 'Shooting Star',
      description: 'Long upper wick shows aggressive selling after an upside probe.',
      anchors: anchorsForSingle(bar, 'bearish'),
      scoreBreakdown: { upperRejection },
    });
  }

  const marubozu = weightedScore({
    body: scoreGreater(bar.bodyPct, 0.72, 0.94),
    upper: scoreLess(bar.upperPct, 0.08, 0.2),
    lower: scoreLess(bar.lowerPct, 0.08, 0.2),
  });
  if (marubozu > 0.72) {
    candidates.push({
      kind: 'marubozu',
      family: 'candlestick',
      status: 'confirmed',
      direction: bar.direction === 'neutral' ? 'neutral' : bar.direction,
      startIndex: bar.index,
      endIndex: bar.index,
      confidence: marubozu,
      strength: marubozu,
      label: `${bar.direction === 'bearish' ? 'Bearish' : 'Bullish'} Marubozu`,
      description: 'Large body with almost no wicks, showing clean directional control.',
      anchors: anchorsForSingle(bar, bar.direction),
      scoreBreakdown: { marubozu },
    });
  }

  const highWave = weightedScore({
    body: scoreLess(bar.bodyPct, 0.22, 0.38),
    upper: scoreGreater(bar.upperPct, 0.28, 0.48),
    lower: scoreGreater(bar.lowerPct, 0.28, 0.48),
    range: scoreGreater(bar.rangeRatio, 1.1, 2.2),
  });
  if (highWave > 0.68) {
    candidates.push({
      kind: bar.bodyPct < 0.16 ? 'high-wave' : 'spinning-top',
      family: 'candlestick',
      status: 'confirmed',
      direction: 'neutral',
      startIndex: bar.index,
      endIndex: bar.index,
      confidence: highWave,
      strength: highWave,
      label: bar.bodyPct < 0.16 ? 'High Wave' : 'Spinning Top',
      description: 'Small body with long shadows, showing volatility and indecision.',
      anchors: anchorsForSingle(bar, 'neutral'),
      scoreBreakdown: { highWave },
    });
  }

  const dragonfly = weightedScore({
    doji: dojiScore,
    lower: scoreGreater(bar.lowerPct, 0.58, 0.86),
    upper: scoreLess(bar.upperPct, 0.08, 0.18),
  });
  if (dragonfly > 0.66) {
    candidates.push({
      kind: 'dragonfly-doji',
      family: 'candlestick',
      status: 'confirmed',
      direction: 'bullish',
      startIndex: bar.index,
      endIndex: bar.index,
      confidence: dragonfly,
      strength: dragonfly,
      label: 'Dragonfly Doji',
      description: 'Doji with a long lower shadow, highlighting downside rejection.',
      anchors: anchorsForSingle(bar, 'bullish'),
      scoreBreakdown: { dragonfly },
    });
  }

  const gravestone = weightedScore({
    doji: dojiScore,
    upper: scoreGreater(bar.upperPct, 0.58, 0.86),
    lower: scoreLess(bar.lowerPct, 0.08, 0.18),
  });
  if (gravestone > 0.66) {
    candidates.push({
      kind: 'gravestone-doji',
      family: 'candlestick',
      status: 'confirmed',
      direction: 'bearish',
      startIndex: bar.index,
      endIndex: bar.index,
      confidence: gravestone,
      strength: gravestone,
      label: 'Gravestone Doji',
      description: 'Doji with a long upper shadow, highlighting upside rejection.',
      anchors: anchorsForSingle(bar, 'bearish'),
      scoreBreakdown: { gravestone },
    });
  }

  return candidates;
}

function twoBarCandidates(features: CandleFeature[], index: number): Candidate[] {
  const prev = features[index - 1];
  const curr = features[index];
  if (!prev || !curr) return [];
  const candidates: Candidate[] = [];
  const currBodyHigh = bodyHigh(curr);
  const currBodyLow = bodyLow(curr);
  const prevBodyHigh = bodyHigh(prev);
  const prevBodyLow = bodyLow(prev);
  const opposite = prev.direction !== 'neutral' && curr.direction !== 'neutral' && prev.direction !== curr.direction;

  const engulfingScore = weightedScore({
    opposite: opposite ? 1 : 0,
    body: scoreGreater(curr.bodyRatio, 0.72, 1.45),
    high: currBodyHigh >= prevBodyHigh ? 1 : 0,
    low: currBodyLow <= prevBodyLow ? 1 : 0,
  });
  if (engulfingScore > 0.72) {
    candidates.push({
      kind: 'engulfing',
      family: 'candlestick',
      status: 'confirmed',
      direction: curr.direction,
      startIndex: prev.index,
      endIndex: curr.index,
      confidence: engulfingScore,
      strength: engulfingScore,
      label: `${curr.direction === 'bullish' ? 'Bullish' : 'Bearish'} Engulfing`,
      description: 'Current candle body fully engulfs the previous body.',
      anchors: anchorsForRange(features, prev.index, curr.index, curr.direction),
      scoreBreakdown: { engulfingScore },
    });
  }

  const haramiScore = weightedScore({
    opposite: opposite ? 1 : 0.45,
    previousBody: scoreGreater(prev.bodyRatio, 0.85, 1.55),
    currentBody: scoreLess(curr.bodyPct, 0.28, 0.52),
    insideHigh: currBodyHigh <= prevBodyHigh ? 1 : 0,
    insideLow: currBodyLow >= prevBodyLow ? 1 : 0,
  });
  if (haramiScore > 0.72) {
    candidates.push({
      kind: 'harami',
      family: 'candlestick',
      status: 'confirmed',
      direction: prev.direction === 'bearish' ? 'bullish' : prev.direction === 'bullish' ? 'bearish' : 'neutral',
      startIndex: prev.index,
      endIndex: curr.index,
      confidence: haramiScore,
      strength: haramiScore,
      label: 'Harami',
      description: 'Small candle body forms inside the previous candle body.',
      anchors: anchorsForRange(features, prev.index, curr.index, curr.direction),
      scoreBreakdown: { haramiScore },
    });
  }

  const piercing = weightedScore({
    prevBearish: prev.direction === 'bearish' ? 1 : 0,
    currBullish: curr.direction === 'bullish' ? 1 : 0,
    opensBelow: curr.open < prev.low ? 1 : curr.open < prev.close ? 0.55 : 0,
    closesAboveMid: curr.close > (prev.open + prev.close) / 2 ? 1 : 0,
    closesBelowPrevOpen: curr.close < prev.open ? 1 : 0.4,
  });
  if (piercing > 0.74) {
    candidates.push({
      kind: 'piercing-line',
      family: 'candlestick',
      status: 'confirmed',
      direction: 'bullish',
      startIndex: prev.index,
      endIndex: curr.index,
      confidence: piercing,
      strength: piercing,
      label: 'Piercing Line',
      description: 'Bullish candle opens weak, then closes deep into the prior bearish body.',
      anchors: anchorsForRange(features, prev.index, curr.index, 'bullish'),
      scoreBreakdown: { piercing },
    });
  }

  const darkCloud = weightedScore({
    prevBullish: prev.direction === 'bullish' ? 1 : 0,
    currBearish: curr.direction === 'bearish' ? 1 : 0,
    opensAbove: curr.open > prev.high ? 1 : curr.open > prev.close ? 0.55 : 0,
    closesBelowMid: curr.close < (prev.open + prev.close) / 2 ? 1 : 0,
    closesAbovePrevOpen: curr.close > prev.open ? 1 : 0.4,
  });
  if (darkCloud > 0.74) {
    candidates.push({
      kind: 'dark-cloud-cover',
      family: 'candlestick',
      status: 'confirmed',
      direction: 'bearish',
      startIndex: prev.index,
      endIndex: curr.index,
      confidence: darkCloud,
      strength: darkCloud,
      label: 'Dark Cloud Cover',
      description: 'Bearish candle opens strong, then closes deep into the prior bullish body.',
      anchors: anchorsForRange(features, prev.index, curr.index, 'bearish'),
      scoreBreakdown: { darkCloud },
    });
  }

  return candidates;
}

function threeBarCandidates(features: CandleFeature[], index: number): Candidate[] {
  const a = features[index - 2];
  const b = features[index - 1];
  const c = features[index];
  if (!a || !b || !c) return [];
  const candidates: Candidate[] = [];

  const morning = weightedScore({
    firstBearish: a.direction === 'bearish' ? 1 : 0,
    firstBody: scoreGreater(a.bodyRatio, 0.75, 1.45),
    starBody: scoreLess(b.bodyPct, 0.28, 0.48),
    thirdBullish: c.direction === 'bullish' ? 1 : 0,
    closeRecovery: c.close > (a.open + a.close) / 2 ? 1 : 0,
  });
  if (morning > 0.72) {
    candidates.push({
      kind: 'morning-star',
      family: 'candlestick',
      status: 'confirmed',
      direction: 'bullish',
      startIndex: a.index,
      endIndex: c.index,
      confidence: morning,
      strength: morning,
      label: 'Morning Star',
      description: 'Three-candle bullish reversal: selloff, indecision, then recovery.',
      anchors: anchorsForRange(features, a.index, c.index, 'bullish'),
      scoreBreakdown: { morning },
    });
  }

  const evening = weightedScore({
    firstBullish: a.direction === 'bullish' ? 1 : 0,
    firstBody: scoreGreater(a.bodyRatio, 0.75, 1.45),
    starBody: scoreLess(b.bodyPct, 0.28, 0.48),
    thirdBearish: c.direction === 'bearish' ? 1 : 0,
    closeFade: c.close < (a.open + a.close) / 2 ? 1 : 0,
  });
  if (evening > 0.72) {
    candidates.push({
      kind: 'evening-star',
      family: 'candlestick',
      status: 'confirmed',
      direction: 'bearish',
      startIndex: a.index,
      endIndex: c.index,
      confidence: evening,
      strength: evening,
      label: 'Evening Star',
      description: 'Three-candle bearish reversal: rally, indecision, then rejection.',
      anchors: anchorsForRange(features, a.index, c.index, 'bearish'),
      scoreBreakdown: { evening },
    });
  }

  const soldiers = weightedScore({
    a: a.direction === 'bullish' ? 1 : 0,
    b: b.direction === 'bullish' ? 1 : 0,
    c: c.direction === 'bullish' ? 1 : 0,
    higherCloses: b.close > a.close && c.close > b.close ? 1 : 0,
    body: (scoreGreater(a.bodyPct, 0.44, 0.72) + scoreGreater(b.bodyPct, 0.44, 0.72) + scoreGreater(c.bodyPct, 0.44, 0.72)) / 3,
  });
  if (soldiers > 0.78) {
    candidates.push({
      kind: 'three-white-soldiers',
      family: 'candlestick',
      status: 'confirmed',
      direction: 'bullish',
      startIndex: a.index,
      endIndex: c.index,
      confidence: soldiers,
      strength: soldiers,
      label: 'Three White Soldiers',
      description: 'Three strong bullish candles with rising closes.',
      anchors: anchorsForRange(features, a.index, c.index, 'bullish'),
      scoreBreakdown: { soldiers },
    });
  }

  const crows = weightedScore({
    a: a.direction === 'bearish' ? 1 : 0,
    b: b.direction === 'bearish' ? 1 : 0,
    c: c.direction === 'bearish' ? 1 : 0,
    lowerCloses: b.close < a.close && c.close < b.close ? 1 : 0,
    body: (scoreGreater(a.bodyPct, 0.44, 0.72) + scoreGreater(b.bodyPct, 0.44, 0.72) + scoreGreater(c.bodyPct, 0.44, 0.72)) / 3,
  });
  if (crows > 0.78) {
    candidates.push({
      kind: 'three-black-crows',
      family: 'candlestick',
      status: 'confirmed',
      direction: 'bearish',
      startIndex: a.index,
      endIndex: c.index,
      confidence: crows,
      strength: crows,
      label: 'Three Black Crows',
      description: 'Three strong bearish candles with falling closes.',
      anchors: anchorsForRange(features, a.index, c.index, 'bearish'),
      scoreBreakdown: { crows },
    });
  }

  return candidates;
}

function visionCandidates(features: CandleFeature[], index: number): Candidate[] {
  const curr = features[index];
  if (!curr) return [];
  const candidates: Candidate[] = [];
  const rejectionSide = curr.lowerPct > curr.upperPct ? 'lower' : 'upper';
  const rejectionScore = weightedScore({
    wickImbalance: scoreGreater(Math.abs(curr.lowerPct - curr.upperPct), 0.32, 0.74),
    wickSize: scoreGreater(Math.max(curr.lowerPct, curr.upperPct), 0.42, 0.82),
    range: scoreGreater(curr.rangeRatio, 0.95, 2.2),
    volume: curr.volume ? scoreGreater(curr.volumeRatio, 0.9, 2.2) : 0.7,
  });

  if (rejectionScore > 0.66) {
    const direction: CandleDirection = rejectionSide === 'lower' ? 'bullish' : 'bearish';
    candidates.push({
      kind: 'vision-rejection',
      family: 'vision-candle',
      status: 'confirmed',
      direction,
      startIndex: curr.index,
      endIndex: curr.index,
      confidence: rejectionScore,
      strength: rejectionScore,
      label: rejectionSide === 'lower' ? 'Lower Wick Rejection' : 'Upper Wick Rejection',
      description: 'Computer-vision style shape match: dominant wick with elevated range/volume context.',
      anchors: anchorsForRange(features, curr.index, curr.index, direction),
      color: direction === 'bullish' ? COLORS.bullish : COLORS.bearish,
      scoreBreakdown: { rejectionScore },
    });
  }

  const window = features.slice(Math.max(0, index - 5), index + 1);
  if (window.length >= 5) {
    const bodies = window.map((bar) => bar.bodyPct);
    const avgBodyPct = bodies.reduce((sum, value) => sum + value, 0) / bodies.length;
    const rangeContraction = window[window.length - 1].averageRange > 0
      ? window[window.length - 1].range / window[0].range
      : 1;
    const directionMix = Math.abs(window.reduce((sum, bar) => sum + bar.directionScore, 0));
    const compressionScore = weightedScore({
      body: scoreLess(avgBodyPct, 0.26, 0.48),
      range: scoreLess(rangeContraction, 0.72, 1.08),
      mixedDirection: scoreLess(directionMix / window.length, 0.34, 0.8),
    });
    if (compressionScore > 0.7) {
      candidates.push({
        kind: 'vision-compression',
        family: 'vision-candle',
        status: 'forming',
        direction: 'neutral',
        startIndex: window[0].index,
        endIndex: curr.index,
        confidence: compressionScore,
        strength: compressionScore,
        label: 'Compression',
        description: 'Small mixed candles with contracting range. Breakout watch.',
        anchors: anchorsForRange(features, window[0].index, curr.index, 'neutral'),
        color: COLORS.compression,
        scoreBreakdown: { compressionScore },
      });
    }

    const momentumDirection = window.every((bar) => bar.direction === 'bullish')
      ? 'bullish'
      : window.every((bar) => bar.direction === 'bearish')
        ? 'bearish'
        : 'neutral';
    const momentumScore = weightedScore({
      aligned: momentumDirection !== 'neutral' ? 1 : 0,
      body: avgBodyPct > 0.42 ? 1 : scoreGreater(avgBodyPct, 0.3, 0.42),
      closes: momentumDirection === 'bullish'
        ? window.every((bar, i) => i === 0 || bar.close >= window[i - 1].close) ? 1 : 0
        : momentumDirection === 'bearish'
          ? window.every((bar, i) => i === 0 || bar.close <= window[i - 1].close) ? 1 : 0
          : 0,
    });
    if (momentumScore > 0.76 && momentumDirection !== 'neutral') {
      candidates.push({
        kind: 'vision-momentum',
        family: 'vision-candle',
        status: 'confirmed',
        direction: momentumDirection,
        startIndex: window[0].index,
        endIndex: curr.index,
        confidence: momentumScore,
        strength: momentumScore,
        label: momentumDirection === 'bullish' ? 'Bullish Momentum Run' : 'Bearish Momentum Run',
        description: 'Computer-vision style run detection: aligned candle bodies with monotonic closes.',
        anchors: anchorsForRange(features, window[0].index, curr.index, momentumDirection),
        color: momentumDirection === 'bullish' ? COLORS.bullish : COLORS.bearish,
        scoreBreakdown: { momentumScore },
      });
    }
  }

  return candidates;
}

function dedupe(events: CandlePatternEvent[]) {
  const sorted = events
    .slice()
    .sort((a, b) => b.confidence - a.confidence || (b.endIndex - b.startIndex) - (a.endIndex - a.startIndex));
  const selected: CandlePatternEvent[] = [];

  for (const event of sorted) {
    const overlapsStronger = selected.some((existing) => {
      const overlaps = event.startIndex <= existing.endIndex && existing.startIndex <= event.endIndex;
      return overlaps && event.kind === existing.kind;
    });
    if (!overlapsStronger) selected.push(event);
  }

  return selected.sort((a, b) => a.endIndex - b.endIndex || a.startIndex - b.startIndex);
}

export function detectCandlePatterns(candles: CandleInput[], options: CandlePatternDetectorOptions = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const sourceCandles = opts.lookback > 0 ? candles.slice(-opts.lookback) : candles;
  const offset = candles.length - sourceCandles.length;
  const features = normalizeCandles(sourceCandles, opts.contextPeriod, opts.trendPeriod);
  const events: CandlePatternEvent[] = [];

  for (let i = 0; i < features.length; i += 1) {
    const localIndex = i;
    const feature = features[localIndex];

    if (opts.enableClassicPatterns) {
      for (const candidate of singleBarCandidates(feature)) {
        if (candidate.confidence >= opts.minConfidence || opts.includeWeak) events.push(createEvent(features, candidate));
      }
      for (const candidate of twoBarCandidates(features, localIndex)) {
        if (candidate.confidence >= opts.minConfidence || opts.includeWeak) events.push(createEvent(features, candidate));
      }
      for (const candidate of threeBarCandidates(features, localIndex)) {
        if (candidate.confidence >= opts.minConfidence || opts.includeWeak) events.push(createEvent(features, candidate));
      }
    }

    if (opts.enableVisionPatterns) {
      for (const candidate of visionCandidates(features, localIndex)) {
        if (candidate.confidence >= opts.minConfidence || opts.includeWeak) events.push(createEvent(features, candidate));
      }
    }
  }

  return dedupe(events).map((event) => shiftEvent(event, offset, candles));
}

export type UnifiedCandlePatternOptions = CandlePatternDetectorOptions;

export function detectExpandedCandlePatterns(candles: CandleInput[], options: CandlePatternDetectorOptions = {}) {
  return detectCandlePatterns(candles, options);
}

export function detectUnifiedCandlePatterns(candles: CandleInput[], options: UnifiedCandlePatternOptions = {}) {
  return detectCandlePatterns(candles, options);
}

export function detectLatestCandlePatterns(candles: CandleInput[], options: CandlePatternDetectorOptions = {}) {
  if (!candles.length) return [];
  return detectCandlePatterns(candles, { ...options, lookback: Math.max(options.lookback ?? 80, 12) }).filter(
    (event) => event.endIndex === candles.length - 1,
  );
}

export function eventCandleRange(candles: CandleInput[], event: CandlePatternEvent) {
  const slice = candles.slice(event.startIndex, event.endIndex + 1);
  const low = Math.min(...slice.map((bar) => bar.low));
  const high = Math.max(...slice.map((bar) => bar.high));
  return { low, high };
}
