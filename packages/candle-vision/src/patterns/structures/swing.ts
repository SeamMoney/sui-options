import {
  clamp01,
  normalizeCandles,
  scoreGreater,
  scoreLess,
} from '../../features';
import type {
  CandleDirection,
  CandleFeature,
  CandleInput,
  CandlePatternAnchor,
  CandlePatternDetectorOptions,
  CandlePatternEvent,
  CandlePatternKind,
  CandlePatternStatus,
} from '../../types';

const EPSILON = 1e-9;

const STRUCTURE_COLORS: Record<CandleDirection, string> = {
  bullish: '#22c55e',
  bearish: '#ef4444',
  neutral: '#a78bfa',
};

const CHART_STRUCTURE_KINDS = new Set<CandlePatternKind>([
  'support-retest',
  'resistance-retest',
  'range-breakout',
  'range-breakdown',
  'double-top',
  'double-bottom',
  'head-and-shoulders',
  'inverse-head-and-shoulders',
  'ascending-triangle',
  'descending-triangle',
  'symmetrical-triangle',
  'rising-wedge',
  'falling-wedge',
  'bull-flag',
  'bear-flag',
  'channel-up',
  'channel-down',
  'cup-and-handle',
]);

export type SwingKind = 'high' | 'low';

export type SwingPoint = {
  kind: SwingKind;
  index: number;
  time: number;
  price: number;
  strength: number;
  prominence: number;
};

export type SwingExtractionOptions = {
  leftBars?: number;
  rightBars?: number;
  minSwingDistance?: number;
  minProminencePct?: number;
  maxSwings?: number;
};

export type StructurePatternDetectionOptions = CandlePatternDetectorOptions & SwingExtractionOptions & {
  maxBars?: number;
  minBars?: number;
  maxPatternAgeBars?: number;
  maxEventsPerKind?: number;
};

export type StructurePatternCandidate = Omit<CandlePatternEvent, 'id' | 'detectedAt' | 'source' | 'color'> & {
  color?: string;
};

export type StructurePatternDetectorContext = {
  features: CandleFeature[];
  swings: SwingPoint[];
  options: RequiredStructurePatternOptions;
};

export type StructurePatternDetector = {
  kind: CandlePatternKind;
  label: string;
  direction: CandleDirection;
  minBars: number;
  minSwings: number;
  detect: (context: StructurePatternDetectorContext) => StructurePatternCandidate[];
};

type RequiredStructurePatternOptions = Required<Omit<StructurePatternDetectionOptions, keyof CandlePatternDetectorOptions>> & Required<CandlePatternDetectorOptions>;

type LineFit = {
  slope: number;
  intercept: number;
  normalizedSlope: number;
  r2: number;
};

const DEFAULT_OPTIONS: RequiredStructurePatternOptions = {
  lookback: 240,
  minConfidence: 0.58,
  includeWeak: false,
  trendPeriod: 12,
  contextPeriod: 20,
  enableClassicPatterns: true,
  enableVisionPatterns: true,
  enableChartSetups: true,
  enableTaPatterns: true,
  leftBars: 2,
  rightBars: 2,
  minSwingDistance: 3,
  minProminencePct: 0.0035,
  maxSwings: 80,
  maxBars: 96,
  minBars: 8,
  maxPatternAgeBars: 18,
  maxEventsPerKind: 6,
};

function makeId(kind: CandlePatternKind, startIndex: number, endIndex: number) {
  return `${kind}:${startIndex}:${endIndex}`;
}

function average(values: number[], fallback = 0) {
  if (!values.length) return fallback;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function relativeDiff(a: number, b: number) {
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), EPSILON);
}

function scoreNear(a: number, b: number, goodAt: number, zeroAt: number) {
  return scoreLess(relativeDiff(a, b), goodAt, zeroAt);
}

function weightedScore(parts: Record<string, number>, weights?: Record<string, number>) {
  const entries = Object.entries(parts);
  const totalWeight = entries.reduce((sum, [key]) => sum + (weights?.[key] ?? 1), 0);
  if (!entries.length || totalWeight <= 0) return 0;
  return clamp01(entries.reduce((sum, [key, value]) => sum + clamp01(value) * (weights?.[key] ?? 1), 0) / totalWeight);
}

function priceRange(features: CandleInput[], startIndex = 0, endIndex = features.length - 1) {
  const start = Math.max(0, startIndex);
  const end = Math.min(features.length - 1, endIndex);
  if (start > end) return { high: 0, low: 0, range: 0 };
  let high = -Infinity;
  let low = Infinity;
  for (let i = start; i <= end; i += 1) {
    high = Math.max(high, features[i].high);
    low = Math.min(low, features[i].low);
  }
  return { high, low, range: Math.max(high - low, EPSILON) };
}

function averageRange(features: CandleFeature[], startIndex: number, endIndex: number) {
  const start = Math.max(0, startIndex);
  const end = Math.min(features.length - 1, endIndex);
  if (start > end) return 0;
  let sum = 0;
  for (let i = start; i <= end; i += 1) sum += features[i].range;
  return sum / (end - start + 1);
}

function barAt(features: CandleFeature[], index: number) {
  return features[Math.max(0, Math.min(features.length - 1, index))];
}

function lineFit(points: Array<{ index: number; price: number }>): LineFit {
  if (points.length < 2) {
    const price = points[0]?.price ?? 0;
    return { slope: 0, intercept: price, normalizedSlope: 0, r2: 1 };
  }

  const meanX = average(points.map((point) => point.index));
  const meanY = average(points.map((point) => point.price));
  let numerator = 0;
  let denominator = 0;
  let total = 0;
  let residual = 0;

  for (const point of points) {
    numerator += (point.index - meanX) * (point.price - meanY);
    denominator += (point.index - meanX) ** 2;
  }

  const slope = denominator > EPSILON ? numerator / denominator : 0;
  const intercept = meanY - slope * meanX;

  for (const point of points) {
    const fitted = slope * point.index + intercept;
    total += (point.price - meanY) ** 2;
    residual += (point.price - fitted) ** 2;
  }

  const normalizedSlope = meanY !== 0 ? slope / Math.abs(meanY) : 0;
  const r2 = total <= EPSILON ? 1 : clamp01(1 - residual / total);
  return { slope, intercept, normalizedSlope, r2 };
}

function lineValue(line: LineFit, index: number) {
  return line.slope * index + line.intercept;
}

function trendMove(features: CandleFeature[], startIndex: number, endIndex: number) {
  const start = barAt(features, startIndex);
  const end = barAt(features, endIndex);
  return start.close !== 0 ? (end.close - start.close) / Math.abs(start.close) : 0;
}

function pointsOf(swings: SwingPoint[], kind: SwingKind) {
  return swings.filter((swing) => swing.kind === kind).map((swing) => ({ index: swing.index, price: swing.price }));
}

function countTouches(values: number[], level: number, tolerance: number) {
  return values.reduce((count, value) => count + (Math.abs(value - level) <= tolerance ? 1 : 0), 0);
}

function flatnessScore(values: number[], tightPct = 0.012, loosePct = 0.04) {
  if (values.length < 2) return 0;
  const level = average(values);
  const maxDeviation = Math.max(...values.map((value) => relativeDiff(value, level)));
  return scoreLess(maxDeviation, tightPct, loosePct);
}

function movementScore(first: number, last: number, direction: 'up' | 'down', goodAt = 0.012, fullAt = 0.06) {
  const move = first !== 0 ? (last - first) / Math.abs(first) : 0;
  const directionalMove = direction === 'up' ? move : -move;
  return scoreGreater(directionalMove, goodAt, fullAt);
}

function anchorForSwing(swing: SwingPoint): CandlePatternAnchor {
  return {
    index: swing.index,
    time: swing.time,
    price: swing.price,
    role: swing.kind,
  };
}

function anchorsForSpan(features: CandleFeature[], startIndex: number, endIndex: number, direction: CandleDirection): CandlePatternAnchor[] {
  const start = barAt(features, startIndex);
  const end = barAt(features, endIndex);
  const span = features.slice(startIndex, endIndex + 1);
  const high = span.reduce((best, bar) => (bar.high > best.high ? bar : best), span[0] ?? start);
  const low = span.reduce((best, bar) => (bar.low < best.low ? bar : best), span[0] ?? start);
  const confirmationPrice = direction === 'bearish' ? end.low : direction === 'bullish' ? end.high : end.close;
  return [
    { index: start.index, time: start.time, price: start.open, role: 'start' },
    { index: high.index, time: high.time, price: high.high, role: 'high' },
    { index: low.index, time: low.time, price: low.low, role: 'low' },
    { index: end.index, time: end.time, price: confirmationPrice, role: 'confirmation' },
  ];
}

function anchorsForSwings(features: CandleFeature[], swings: SwingPoint[], endIndex: number, direction: CandleDirection, confirmationPrice?: number): CandlePatternAnchor[] {
  const start = barAt(features, swings[0]?.index ?? endIndex);
  const end = barAt(features, endIndex);
  const anchors: CandlePatternAnchor[] = [
    { index: start.index, time: start.time, price: start.open, role: 'start' },
    ...swings.map(anchorForSwing),
  ];
  anchors.push({
    index: end.index,
    time: end.time,
    price: confirmationPrice ?? (direction === 'bearish' ? end.low : direction === 'bullish' ? end.high : end.close),
    role: 'confirmation',
  });
  return anchors;
}

function createCandidate(args: {
  features: CandleFeature[];
  kind: CandlePatternKind;
  status?: CandlePatternStatus;
  direction: CandleDirection;
  startIndex: number;
  endIndex: number;
  confidence: number;
  strength?: number;
  label: string;
  description: string;
  anchors?: CandlePatternAnchor[];
  scoreBreakdown?: Record<string, number>;
}): StructurePatternCandidate {
  return {
    kind: args.kind,
    family: 'chart-setup',
    status: args.status ?? 'confirmed',
    direction: args.direction,
    startIndex: args.startIndex,
    endIndex: args.endIndex,
    confidence: clamp01(args.confidence),
    strength: clamp01(args.strength ?? args.confidence),
    label: args.label,
    description: args.description,
    anchors: args.anchors ?? anchorsForSpan(args.features, args.startIndex, args.endIndex, args.direction),
    color: STRUCTURE_COLORS[args.direction],
    scoreBreakdown: args.scoreBreakdown,
  };
}

function finalizeCandidate(features: CandleFeature[], candidate: StructurePatternCandidate): CandlePatternEvent {
  return {
    ...candidate,
    id: makeId(candidate.kind, candidate.startIndex, candidate.endIndex),
    detectedAt: features[candidate.endIndex]?.time ?? Date.now(),
    source: 'candle-vision',
    color: candidate.color ?? STRUCTURE_COLORS[candidate.direction],
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

function isRecent(endIndex: number, features: CandleFeature[], options: RequiredStructurePatternOptions) {
  return features.length - 1 - endIndex <= options.maxPatternAgeBars;
}

function passesSpan(startIndex: number, endIndex: number, options: RequiredStructurePatternOptions) {
  const span = endIndex - startIndex + 1;
  return span >= options.minBars && span <= options.maxBars;
}

function findBreak(
  features: CandleFeature[],
  fromIndex: number,
  toIndex: number,
  levelAt: (index: number) => number,
  direction: 'above' | 'below',
  buffer: number,
) {
  const start = Math.max(0, fromIndex);
  const end = Math.min(features.length - 1, toIndex);
  for (let i = start; i <= end; i += 1) {
    const level = levelAt(i);
    if (direction === 'above' && features[i].close > level + buffer) return i;
    if (direction === 'below' && features[i].close < level - buffer) return i;
  }
  return null;
}

function uniqueSwings(swings: SwingPoint[]) {
  return swings.filter((swing, index) => index === 0 || swing.index !== swings[index - 1].index || swing.kind !== swings[index - 1].kind);
}

export function extractSwings(candles: CandleInput[], options: SwingExtractionOptions = {}): SwingPoint[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (candles.length < opts.leftBars + opts.rightBars + 1) return [];

  const allRange = priceRange(candles);
  const avgRange = average(candles.map((bar) => Math.max(bar.high - bar.low, EPSILON)), allRange.range);
  const raw: SwingPoint[] = [];

  for (let i = opts.leftBars; i < candles.length - opts.rightBars; i += 1) {
    const bar = candles[i];
    const left = candles.slice(i - opts.leftBars, i);
    const right = candles.slice(i + 1, i + opts.rightBars + 1);
    const leftHigh = Math.max(...left.map((item) => item.high));
    const rightHigh = Math.max(...right.map((item) => item.high));
    const leftLow = Math.min(...left.map((item) => item.low));
    const rightLow = Math.min(...right.map((item) => item.low));
    const nearbyLow = Math.max(leftLow, rightLow);
    const nearbyHigh = Math.min(leftHigh, rightHigh);
    const minProminence = Math.max(Math.abs(bar.close) * opts.minProminencePct, avgRange * 0.55);

    if (bar.high >= leftHigh && bar.high >= rightHigh && (bar.high > leftHigh || bar.high > rightHigh)) {
      const prominence = Math.max(0, bar.high - nearbyLow);
      if (prominence >= minProminence) {
        raw.push({
          kind: 'high',
          index: i,
          time: bar.time,
          price: bar.high,
          prominence,
          strength: weightedScore({
            prominence: scoreGreater(prominence / Math.max(avgRange, EPSILON), 0.75, 2.4),
            localRange: scoreGreater(prominence / Math.max(allRange.range, EPSILON), 0.025, 0.18),
          }),
        });
      }
    }

    if (bar.low <= leftLow && bar.low <= rightLow && (bar.low < leftLow || bar.low < rightLow)) {
      const prominence = Math.max(0, nearbyHigh - bar.low);
      if (prominence >= minProminence) {
        raw.push({
          kind: 'low',
          index: i,
          time: bar.time,
          price: bar.low,
          prominence,
          strength: weightedScore({
            prominence: scoreGreater(prominence / Math.max(avgRange, EPSILON), 0.75, 2.4),
            localRange: scoreGreater(prominence / Math.max(allRange.range, EPSILON), 0.025, 0.18),
          }),
        });
      }
    }
  }

  const sorted = raw.sort((a, b) => a.index - b.index || b.strength - a.strength);
  const spaced: SwingPoint[] = [];

  for (const swing of sorted) {
    const previous = spaced[spaced.length - 1];
    if (!previous || swing.index - previous.index >= opts.minSwingDistance) {
      spaced.push(swing);
      continue;
    }

    if (previous.kind === swing.kind && swing.strength > previous.strength) {
      spaced[spaced.length - 1] = swing;
      continue;
    }

    if (previous.kind !== swing.kind && Math.abs(swing.price - previous.price) > avgRange * 0.65) {
      spaced.push(swing);
    }
  }

  return uniqueSwings(spaced).slice(-opts.maxSwings);
}

function doubleTopBottomDetector(kind: 'double-top' | 'double-bottom'): StructurePatternDetector {
  const bearish = kind === 'double-top';
  return {
    kind,
    label: bearish ? 'Double Top' : 'Double Bottom',
    direction: bearish ? 'bearish' : 'bullish',
    minBars: 8,
    minSwings: 3,
    detect: ({ features, swings, options }) => {
      const candidates: StructurePatternCandidate[] = [];
      for (let i = 0; i <= swings.length - 3; i += 1) {
        const a = swings[i];
        const b = swings[i + 1];
        const c = swings[i + 2];
        const matches = bearish
          ? a.kind === 'high' && b.kind === 'low' && c.kind === 'high'
          : a.kind === 'low' && b.kind === 'high' && c.kind === 'low';
        if (!matches || !passesSpan(a.index, c.index, options)) continue;

        const avgLocalRange = averageRange(features, a.index, c.index);
        const rimSimilarity = scoreNear(a.price, c.price, 0.012, 0.04);
        const necklineDepth = bearish
          ? scoreGreater((Math.min(a.price, c.price) - b.price) / Math.max(avgLocalRange, EPSILON), 1.25, 4.4)
          : scoreGreater((b.price - Math.max(a.price, c.price)) / Math.max(avgLocalRange, EPSILON), 1.25, 4.4);
        const separation = scoreGreater(c.index - a.index, 7, 24);
        const trend = bearish
          ? scoreGreater(trendMove(features, Math.max(0, a.index - 16), a.index), 0.012, 0.08)
          : scoreGreater(-trendMove(features, Math.max(0, a.index - 16), a.index), 0.012, 0.08);
        const buffer = Math.max(avgLocalRange * 0.2, b.price * 0.0015);
        const confirmIndex = findBreak(
          features,
          c.index + 1,
          Math.min(features.length - 1, c.index + 18),
          () => b.price,
          bearish ? 'below' : 'above',
          buffer,
        );
        const endIndex = confirmIndex ?? c.index;
        if (!isRecent(endIndex, features, options)) continue;

        const confirmation = confirmIndex == null ? 0.46 : 1;
        const confidence = weightedScore(
          { rimSimilarity, necklineDepth, separation, trend, confirmation },
          { rimSimilarity: 1.35, necklineDepth: 1.15, confirmation: 1.35 },
        );
        if (confidence < 0.58 && !options.includeWeak) continue;

        candidates.push(createCandidate({
          features,
          kind,
          status: confirmIndex == null ? 'forming' : 'confirmed',
          direction: bearish ? 'bearish' : 'bullish',
          startIndex: a.index,
          endIndex,
          confidence,
          label: bearish ? 'Double Top' : 'Double Bottom',
          description: bearish
            ? 'Two similar swing highs rejected above a shared neckline.'
            : 'Two similar swing lows held below a shared neckline.',
          anchors: anchorsForSwings(features, [a, b, c], endIndex, bearish ? 'bearish' : 'bullish', b.price),
          scoreBreakdown: { rimSimilarity, necklineDepth, separation, trend, confirmation },
        }));
      }
      return candidates;
    },
  };
}

function headAndShouldersDetector(kind: 'head-and-shoulders' | 'inverse-head-and-shoulders'): StructurePatternDetector {
  const inverse = kind === 'inverse-head-and-shoulders';
  return {
    kind,
    label: inverse ? 'Inverse H&S' : 'Head & Shoulders',
    direction: inverse ? 'bullish' : 'bearish',
    minBars: 14,
    minSwings: 5,
    detect: ({ features, swings, options }) => {
      const candidates: StructurePatternCandidate[] = [];
      for (let i = 0; i <= swings.length - 5; i += 1) {
        const sequence = swings.slice(i, i + 5);
        const [leftShoulder, neckA, head, neckB, rightShoulder] = sequence;
        const matches = inverse
          ? leftShoulder.kind === 'low' && neckA.kind === 'high' && head.kind === 'low' && neckB.kind === 'high' && rightShoulder.kind === 'low'
          : leftShoulder.kind === 'high' && neckA.kind === 'low' && head.kind === 'high' && neckB.kind === 'low' && rightShoulder.kind === 'high';
        if (!matches || !passesSpan(leftShoulder.index, rightShoulder.index, options)) continue;

        const avgLocalRange = averageRange(features, leftShoulder.index, rightShoulder.index);
        const shoulderSimilarity = scoreNear(leftShoulder.price, rightShoulder.price, 0.018, 0.06);
        const headExtension = inverse
          ? scoreGreater((Math.min(leftShoulder.price, rightShoulder.price) - head.price) / Math.max(avgLocalRange, EPSILON), 1.15, 3.8)
          : scoreGreater((head.price - Math.max(leftShoulder.price, rightShoulder.price)) / Math.max(avgLocalRange, EPSILON), 1.15, 3.8);
        const necklineSimilarity = scoreNear(neckA.price, neckB.price, 0.035, 0.11);
        const rightShoulderRespectsHead = inverse
          ? rightShoulder.price > head.price + avgLocalRange * 0.35
          : rightShoulder.price < head.price - avgLocalRange * 0.35;
        const balance = scoreLess(Math.abs((head.index - leftShoulder.index) - (rightShoulder.index - head.index)) / Math.max(rightShoulder.index - leftShoulder.index, 1), 0.24, 0.55);
        const trend = inverse
          ? scoreGreater(-trendMove(features, Math.max(0, leftShoulder.index - 20), leftShoulder.index), 0.014, 0.1)
          : scoreGreater(trendMove(features, Math.max(0, leftShoulder.index - 20), leftShoulder.index), 0.014, 0.1);
        const neckline = lineFit([neckA, neckB]);
        const buffer = Math.max(avgLocalRange * 0.22, Math.abs(lineValue(neckline, rightShoulder.index)) * 0.0015);
        const confirmIndex = findBreak(
          features,
          rightShoulder.index + 1,
          Math.min(features.length - 1, rightShoulder.index + 20),
          (index) => lineValue(neckline, index),
          inverse ? 'above' : 'below',
          buffer,
        );
        const endIndex = confirmIndex ?? rightShoulder.index;
        if (!rightShoulderRespectsHead || !isRecent(endIndex, features, options)) continue;

        const confirmation = confirmIndex == null ? 0.42 : 1;
        const confidence = weightedScore(
          { shoulderSimilarity, headExtension, necklineSimilarity, balance, trend, confirmation },
          { shoulderSimilarity: 1.15, headExtension: 1.3, confirmation: 1.35 },
        );
        if (confidence < 0.6 && !options.includeWeak) continue;

        candidates.push(createCandidate({
          features,
          kind,
          status: confirmIndex == null ? 'forming' : 'confirmed',
          direction: inverse ? 'bullish' : 'bearish',
          startIndex: leftShoulder.index,
          endIndex,
          confidence,
          label: inverse ? 'Inverse Head & Shoulders' : 'Head & Shoulders',
          description: inverse
            ? 'Lower head and higher right shoulder with neckline reclaim potential.'
            : 'Higher head and lower right shoulder with neckline breakdown risk.',
          anchors: anchorsForSwings(features, sequence, endIndex, inverse ? 'bullish' : 'bearish', lineValue(neckline, endIndex)),
          scoreBreakdown: { shoulderSimilarity, headExtension, necklineSimilarity, balance, trend, confirmation },
        }));
      }
      return candidates;
    },
  };
}

function consolidationWindows(swings: SwingPoint[], options: RequiredStructurePatternOptions) {
  const windows: SwingPoint[][] = [];
  for (let start = 0; start < swings.length; start += 1) {
    for (let end = start + 5; end < swings.length; end += 1) {
      const span = swings[end].index - swings[start].index + 1;
      if (span < options.minBars) continue;
      if (span > options.maxBars) break;
      windows.push(swings.slice(start, end + 1));
    }
  }
  return windows;
}

function consolidationBreakout(
  features: CandleFeature[],
  swings: SwingPoint[],
  highLine: LineFit,
  lowLine: LineFit,
  direction: 'above' | 'below',
  avgLocalRange: number,
) {
  const last = swings[swings.length - 1];
  const buffer = Math.max(avgLocalRange * 0.16, Math.abs(last.price) * 0.0012);
  return findBreak(
    features,
    last.index + 1,
    Math.min(features.length - 1, last.index + 14),
    (index) => direction === 'above' ? lineValue(highLine, index) : lineValue(lowLine, index),
    direction,
    buffer,
  );
}

function triangleDetector(kind: 'ascending-triangle' | 'descending-triangle' | 'symmetrical-triangle'): StructurePatternDetector {
  const direction: CandleDirection = kind === 'ascending-triangle' ? 'bullish' : kind === 'descending-triangle' ? 'bearish' : 'neutral';
  return {
    kind,
    label: kind === 'ascending-triangle' ? 'Ascending Triangle' : kind === 'descending-triangle' ? 'Descending Triangle' : 'Symmetrical Triangle',
    direction,
    minBars: 12,
    minSwings: 6,
    detect: ({ features, swings, options }) => {
      const candidates: StructurePatternCandidate[] = [];
      for (const window of consolidationWindows(swings, options)) {
        const highs = pointsOf(window, 'high');
        const lows = pointsOf(window, 'low');
        if (highs.length < 2 || lows.length < 2) continue;
        const startIndex = window[0].index;
        const lastIndex = window[window.length - 1].index;
        const avgLocalRange = averageRange(features, startIndex, lastIndex);
        const highLine = lineFit(highs);
        const lowLine = lineFit(lows);
        const firstWidth = lineValue(highLine, startIndex) - lineValue(lowLine, startIndex);
        const lastWidth = lineValue(highLine, lastIndex) - lineValue(lowLine, lastIndex);
        if (firstWidth <= avgLocalRange || lastWidth <= 0) continue;

        const highPrices = highs.map((point) => point.price);
        const lowPrices = lows.map((point) => point.price);
        const flatHighs = flatnessScore(highPrices, 0.012, 0.04);
        const flatLows = flatnessScore(lowPrices, 0.012, 0.04);
        const lowerHighs = movementScore(highPrices[0], highPrices[highPrices.length - 1], 'down', 0.008, 0.05);
        const higherLows = movementScore(lowPrices[0], lowPrices[lowPrices.length - 1], 'up', 0.008, 0.05);
        const fallingHighLine = scoreGreater(-highLine.normalizedSlope, 0.00045, 0.0035);
        const risingLowLine = scoreGreater(lowLine.normalizedSlope, 0.00045, 0.0035);
        const compression = scoreGreater((firstWidth - lastWidth) / Math.max(firstWidth, EPSILON), 0.16, 0.58);
        const fit = (highLine.r2 + lowLine.r2) / 2;

        let parts: Record<string, number>;
        let breakoutDirection: 'above' | 'below' | null = null;
        let label: string;
        let description: string;
        if (kind === 'ascending-triangle') {
          parts = { flatHighs, higherLows, risingLowLine, compression, fit };
          breakoutDirection = 'above';
          label = 'Ascending Triangle';
          description = 'Flat resistance and rising lows are compressing toward a bullish break.';
        } else if (kind === 'descending-triangle') {
          parts = { flatLows, lowerHighs, fallingHighLine, compression, fit };
          breakoutDirection = 'below';
          label = 'Descending Triangle';
          description = 'Flat support and falling highs are compressing toward a bearish break.';
        } else {
          parts = { lowerHighs, higherLows, fallingHighLine, risingLowLine, compression, fit };
          label = 'Symmetrical Triangle';
          description = 'Lower highs and higher lows are compressing into a neutral triangle.';
        }

        const confirmIndex = breakoutDirection
          ? consolidationBreakout(features, window, highLine, lowLine, breakoutDirection, avgLocalRange)
          : null;
        const endIndex = confirmIndex ?? lastIndex;
        if (!isRecent(endIndex, features, options)) continue;

        const confirmation = confirmIndex == null ? 0.5 : 1;
        const confidence = weightedScore({ ...parts, confirmation }, { compression: 1.25, confirmation: 0.9 });
        if (confidence < 0.62 && !options.includeWeak) continue;

        candidates.push(createCandidate({
          features,
          kind,
          status: confirmIndex == null ? 'forming' : 'confirmed',
          direction,
          startIndex,
          endIndex,
          confidence,
          label,
          description,
          anchors: anchorsForSwings(features, [window[0], ...window.slice(-4)], endIndex, direction),
          scoreBreakdown: { ...parts, confirmation },
        }));
      }
      return candidates;
    },
  };
}

function wedgeChannelDetector(kind: 'rising-wedge' | 'falling-wedge' | 'channel-up' | 'channel-down'): StructurePatternDetector {
  const wedge = kind.includes('wedge');
  const rising = kind === 'rising-wedge' || kind === 'channel-up';
  const direction: CandleDirection = kind === 'falling-wedge' ? 'bullish' : kind === 'rising-wedge' ? 'bearish' : rising ? 'bullish' : 'bearish';
  return {
    kind,
    label: kind === 'rising-wedge' ? 'Rising Wedge' : kind === 'falling-wedge' ? 'Falling Wedge' : kind === 'channel-up' ? 'Channel Up' : 'Channel Down',
    direction,
    minBars: 14,
    minSwings: 6,
    detect: ({ features, swings, options }) => {
      const candidates: StructurePatternCandidate[] = [];
      for (const window of consolidationWindows(swings, options)) {
        const highs = pointsOf(window, 'high');
        const lows = pointsOf(window, 'low');
        if (highs.length < 2 || lows.length < 2) continue;
        const startIndex = window[0].index;
        const lastIndex = window[window.length - 1].index;
        const avgLocalRange = averageRange(features, startIndex, lastIndex);
        const highLine = lineFit(highs);
        const lowLine = lineFit(lows);
        const firstWidth = lineValue(highLine, startIndex) - lineValue(lowLine, startIndex);
        const lastWidth = lineValue(highLine, lastIndex) - lineValue(lowLine, lastIndex);
        if (firstWidth <= avgLocalRange || lastWidth <= avgLocalRange * 0.4) continue;

        const highSlopeScore = rising
          ? scoreGreater(highLine.normalizedSlope, 0.00035, 0.0032)
          : scoreGreater(-highLine.normalizedSlope, 0.00035, 0.0032);
        const lowSlopeScore = rising
          ? scoreGreater(lowLine.normalizedSlope, 0.00035, 0.0032)
          : scoreGreater(-lowLine.normalizedSlope, 0.00035, 0.0032);
        const sameDirection = weightedScore({ highSlopeScore, lowSlopeScore });
        const slopeGap = Math.abs(highLine.normalizedSlope - lowLine.normalizedSlope);
        const parallel = scoreLess(slopeGap, 0.0007, 0.0032);
        const widthChange = (firstWidth - lastWidth) / Math.max(firstWidth, EPSILON);
        const narrowing = scoreGreater(widthChange, 0.14, 0.52);
        const stableWidth = scoreLess(Math.abs(widthChange), 0.16, 0.44);
        const fit = (highLine.r2 + lowLine.r2) / 2;
        const breakoutDirection = kind === 'falling-wedge' ? 'above' : kind === 'rising-wedge' ? 'below' : null;
        const confirmIndex = breakoutDirection
          ? consolidationBreakout(features, window, highLine, lowLine, breakoutDirection, avgLocalRange)
          : null;
        const endIndex = confirmIndex ?? lastIndex;
        if (!isRecent(endIndex, features, options)) continue;

        const confirmation = wedge ? (confirmIndex == null ? 0.44 : 1) : 0.72;
        const parts: Record<string, number> = wedge
          ? { sameDirection, narrowing, fit, confirmation }
          : { sameDirection, parallel, stableWidth, fit };
        const confidence = weightedScore(parts, wedge ? { narrowing: 1.25, confirmation: 1.1 } : { parallel: 1.2, stableWidth: 1.2 });
        if (confidence < 0.62 && !options.includeWeak) continue;

        candidates.push(createCandidate({
          features,
          kind,
          status: wedge && confirmIndex == null ? 'forming' : 'confirmed',
          direction,
          startIndex,
          endIndex,
          confidence,
          label: kind === 'rising-wedge' ? 'Rising Wedge' : kind === 'falling-wedge' ? 'Falling Wedge' : kind === 'channel-up' ? 'Rising Channel' : 'Falling Channel',
          description: wedge
            ? rising
              ? 'Rising highs and lows are narrowing into an exhaustion wedge.'
              : 'Falling highs and lows are narrowing into a recovery wedge.'
            : rising
              ? 'Swing highs and lows are advancing inside a roughly parallel channel.'
              : 'Swing highs and lows are declining inside a roughly parallel channel.',
          anchors: anchorsForSwings(features, [window[0], ...window.slice(-4)], endIndex, direction),
          scoreBreakdown: parts,
        }));
      }
      return candidates;
    },
  };
}

function flagDetector(kind: 'bull-flag' | 'bear-flag'): StructurePatternDetector {
  const bull = kind === 'bull-flag';
  return {
    kind,
    label: bull ? 'Bull Flag' : 'Bear Flag',
    direction: bull ? 'bullish' : 'bearish',
    minBars: 10,
    minSwings: 0,
    detect: ({ features, options }) => {
      const candidates: StructurePatternCandidate[] = [];
      for (let endIndex = Math.max(12, options.minBars); endIndex < features.length; endIndex += 1) {
        for (let flagLength = 6; flagLength <= 18; flagLength += 1) {
          const flagStart = endIndex - flagLength + 1;
          if (flagStart < 6) continue;
          for (let impulseLength = 5; impulseLength <= 16; impulseLength += 1) {
            const impulseStart = flagStart - impulseLength;
            if (impulseStart < 0) continue;
            const impulse = priceRange(features, impulseStart, flagStart - 1);
            const flag = priceRange(features, flagStart, endIndex);
            const avgLocalRange = averageRange(features, impulseStart, endIndex);
            const impulseMove = bull
              ? features[flagStart - 1].high - impulse.low
              : impulse.high - features[flagStart - 1].low;
            if (impulseMove <= avgLocalRange * 2.2) continue;

            const impulsePct = impulseMove / Math.max(Math.abs(features[impulseStart].close), EPSILON);
            const impulseScore = scoreGreater(impulsePct, 0.018, 0.09);
            const impulseDirection = bull
              ? scoreGreater(trendMove(features, impulseStart, flagStart - 1), 0.018, 0.09)
              : scoreGreater(-trendMove(features, impulseStart, flagStart - 1), 0.018, 0.09);
            const retracement = bull
              ? (features[flagStart - 1].high - flag.low) / Math.max(impulseMove, EPSILON)
              : (flag.high - features[flagStart - 1].low) / Math.max(impulseMove, EPSILON);
            const shallow = scoreLess(retracement, 0.38, 0.68);
            const flagSlope = trendMove(features, flagStart, endIndex);
            const drift = bull
              ? scoreLess(flagSlope, 0.012, 0.055)
              : scoreGreater(flagSlope, -0.055, -0.012);
            const flagTightness = scoreLess(flag.range / Math.max(impulseMove, EPSILON), 0.52, 0.88);
            const priorFlagHigh = priceRange(features, flagStart, Math.max(flagStart, endIndex - 1)).high;
            const priorFlagLow = priceRange(features, flagStart, Math.max(flagStart, endIndex - 1)).low;
            const breakout = bull
              ? features[endIndex].close > priorFlagHigh + avgLocalRange * 0.12
              : features[endIndex].close < priorFlagLow - avgLocalRange * 0.12;
            const confirmation = breakout ? 1 : 0.45;
            if (!isRecent(endIndex, features, options)) continue;

            const confidence = weightedScore(
              { impulseScore, impulseDirection, shallow, drift, flagTightness, confirmation },
              { impulseScore: 1.25, impulseDirection: 1.2, confirmation: 1.15 },
            );
            if (confidence < 0.64 && !options.includeWeak) continue;

            candidates.push(createCandidate({
              features,
              kind,
              status: breakout ? 'confirmed' : 'forming',
              direction: bull ? 'bullish' : 'bearish',
              startIndex: impulseStart,
              endIndex,
              confidence,
              label: bull ? 'Bull Flag' : 'Bear Flag',
              description: bull
                ? 'Strong upside impulse is followed by a shallow, controlled pullback.'
                : 'Strong downside impulse is followed by a shallow, controlled rebound.',
              anchors: anchorsForSpan(features, impulseStart, endIndex, bull ? 'bullish' : 'bearish'),
              scoreBreakdown: { impulseScore, impulseDirection, shallow, drift, flagTightness, confirmation },
            }));
          }
        }
      }
      return candidates;
    },
  };
}

function cupAndHandleDetector(): StructurePatternDetector {
  return {
    kind: 'cup-and-handle',
    label: 'Cup & Handle',
    direction: 'bullish',
    minBars: 28,
    minSwings: 4,
    detect: ({ features, swings, options }) => {
      const candidates: StructurePatternCandidate[] = [];
      for (let i = 0; i <= swings.length - 4; i += 1) {
        const leftRim = swings[i];
        const cupLow = swings[i + 1];
        const rightRim = swings[i + 2];
        const handleLow = swings[i + 3];
        if (leftRim.kind !== 'high' || cupLow.kind !== 'low' || rightRim.kind !== 'high' || handleLow.kind !== 'low') continue;
        const startIndex = leftRim.index;
        const endSearch = Math.min(features.length - 1, handleLow.index + 16);
        if (!passesSpan(startIndex, handleLow.index, { ...options, minBars: 24, maxBars: 110 })) continue;

        const avgLocalRange = averageRange(features, startIndex, handleLow.index);
        const rimLevel = (leftRim.price + rightRim.price) / 2;
        const rimSimilarity = scoreNear(leftRim.price, rightRim.price, 0.025, 0.075);
        const depth = rimLevel - cupLow.price;
        const cupDepth = scoreGreater(depth / Math.max(avgLocalRange, EPSILON), 2.2, 7.5);
        const lowPlacement = scoreLess(Math.abs(cupLow.index - (leftRim.index + rightRim.index) / 2) / Math.max(rightRim.index - leftRim.index, 1), 0.22, 0.48);
        const recovery = scoreGreater((rightRim.price - cupLow.price) / Math.max(depth, EPSILON), 0.78, 0.98);
        const handleDepth = (rightRim.price - handleLow.price) / Math.max(depth, EPSILON);
        const shallowHandle = scoreLess(handleDepth, 0.32, 0.58);
        const handleAboveCupLow = handleLow.price > cupLow.price + avgLocalRange ? 1 : 0;
        const confirmIndex = findBreak(
          features,
          handleLow.index + 1,
          endSearch,
          () => rimLevel,
          'above',
          Math.max(avgLocalRange * 0.18, rimLevel * 0.0015),
        );
        const endIndex = confirmIndex ?? handleLow.index;
        if (!isRecent(endIndex, features, options)) continue;

        const confirmation = confirmIndex == null ? 0.42 : 1;
        const confidence = weightedScore(
          { rimSimilarity, cupDepth, lowPlacement, recovery, shallowHandle, handleAboveCupLow, confirmation },
          { rimSimilarity: 1.1, cupDepth: 1.25, shallowHandle: 1.15, confirmation: 1.2 },
        );
        if (confidence < 0.62 && !options.includeWeak) continue;

        candidates.push(createCandidate({
          features,
          kind: 'cup-and-handle',
          status: confirmIndex == null ? 'forming' : 'confirmed',
          direction: 'bullish',
          startIndex,
          endIndex,
          confidence,
          label: 'Cup & Handle',
          description: 'Rounded recovery into similar rims followed by a shallow handle.',
          anchors: anchorsForSwings(features, [leftRim, cupLow, rightRim, handleLow], endIndex, 'bullish', rimLevel),
          scoreBreakdown: { rimSimilarity, cupDepth, lowPlacement, recovery, shallowHandle, handleAboveCupLow, confirmation },
        }));
      }
      return candidates;
    },
  };
}

function retestDetector(kind: 'support-retest' | 'resistance-retest'): StructurePatternDetector {
  const support = kind === 'support-retest';
  return {
    kind,
    label: support ? 'Support Retest' : 'Resistance Retest',
    direction: support ? 'bullish' : 'bearish',
    minBars: 8,
    minSwings: 2,
    detect: ({ features, swings, options }) => {
      const candidates: StructurePatternCandidate[] = [];
      for (let i = Math.max(8, options.minBars); i < features.length; i += 1) {
        if (!isRecent(i, features, options)) continue;
        const prior = swings.filter((swing) => swing.index < i - 2 && swing.index >= i - 90 && swing.kind === (support ? 'low' : 'high'));
        if (prior.length < 2) continue;
        const avgLocalRange = averageRange(features, Math.max(0, i - 40), i);
        const current = features[i];
        for (let a = 0; a < prior.length - 1; a += 1) {
          for (let b = a + 1; b < prior.length; b += 1) {
            const level = (prior[a].price + prior[b].price) / 2;
            const tolerance = Math.max(avgLocalRange * 0.45, Math.abs(level) * 0.0035);
            const touchValues = prior.map((swing) => swing.price);
            const touches = countTouches(touchValues, level, tolerance);
            if (touches < 2) continue;

            const tagged = support
              ? current.low <= level + tolerance && current.low >= level - tolerance * 1.8
              : current.high >= level - tolerance && current.high <= level + tolerance * 1.8;
            if (!tagged) continue;

            const rejection = support
              ? scoreGreater((current.close - current.low) / Math.max(current.range, EPSILON), 0.55, 0.9)
              : scoreGreater((current.high - current.close) / Math.max(current.range, EPSILON), 0.55, 0.9);
            const levelQuality = weightedScore({
              similarity: scoreNear(prior[a].price, prior[b].price, 0.01, 0.04),
              touches: scoreGreater(touches, 1.5, 4),
              spacing: scoreGreater(prior[b].index - prior[a].index, 6, 24),
            });
            const hold = support
              ? current.close > level + tolerance * 0.25
              : current.close < level - tolerance * 0.25;
            const confirmation = hold ? 1 : 0.42;
            const confidence = weightedScore({ levelQuality, rejection, confirmation }, { levelQuality: 1.35, confirmation: 1.2 });
            if (confidence < 0.62 && !options.includeWeak) continue;

            candidates.push(createCandidate({
              features,
              kind,
              status: hold ? 'confirmed' : 'forming',
              direction: support ? 'bullish' : 'bearish',
              startIndex: prior[a].index,
              endIndex: i,
              confidence,
              label: support ? 'Support Retest' : 'Resistance Retest',
              description: support
                ? 'Price tagged a prior support shelf and closed back above it.'
                : 'Price tagged a prior resistance shelf and closed back below it.',
              anchors: [
                anchorForSwing(prior[a]),
                anchorForSwing(prior[b]),
                { index: i, time: current.time, price: support ? current.low : current.high, role: support ? 'low' : 'high' },
                { index: i, time: current.time, price: level, role: 'confirmation' },
              ],
              scoreBreakdown: { levelQuality, rejection, confirmation },
            }));
          }
        }
      }
      return candidates;
    },
  };
}

function rangeBreakDetector(kind: 'range-breakout' | 'range-breakdown'): StructurePatternDetector {
  const breakout = kind === 'range-breakout';
  return {
    kind,
    label: breakout ? 'Range Breakout' : 'Range Breakdown',
    direction: breakout ? 'bullish' : 'bearish',
    minBars: 12,
    minSwings: 0,
    detect: ({ features, options }) => {
      const candidates: StructurePatternCandidate[] = [];
      for (let i = Math.max(14, options.minBars); i < features.length; i += 1) {
        if (!isRecent(i, features, options)) continue;
        for (let length = 14; length <= 48; length += 1) {
          const startIndex = i - length;
          if (startIndex < 0) continue;
          const base = priceRange(features, startIndex, i - 1);
          const avgLocalRange = averageRange(features, startIndex, i);
          const baseWidth = base.range / Math.max(avgLocalRange, EPSILON);
          if (baseWidth < 1.2 || baseWidth > 11) continue;

          const current = features[i];
          const closeBreak = breakout
            ? current.close > base.high + avgLocalRange * 0.18
            : current.close < base.low - avgLocalRange * 0.18;
          if (!closeBreak) continue;

          const compression = scoreLess(baseWidth, 6.2, 11);
          const breakDistance = breakout
            ? scoreGreater((current.close - base.high) / Math.max(avgLocalRange, EPSILON), 0.18, 1.1)
            : scoreGreater((base.low - current.close) / Math.max(avgLocalRange, EPSILON), 0.18, 1.1);
          const closeLocation = breakout
            ? scoreGreater(current.closeLocation, 0.62, 0.9)
            : scoreLess(current.closeLocation, 0.38, 0.1);
          const expansion = scoreGreater(current.rangeRatio, 0.95, 1.8);
          const volume = current.volume ? scoreGreater(current.volumeRatio, 0.9, 2.1) : 0.68;
          const confidence = weightedScore(
            { compression, breakDistance, closeLocation, expansion, volume },
            { breakDistance: 1.35, closeLocation: 1.15 },
          );
          if (confidence < 0.64 && !options.includeWeak) continue;

          candidates.push(createCandidate({
            features,
            kind,
            status: 'confirmed',
            direction: breakout ? 'bullish' : 'bearish',
            startIndex,
            endIndex: i,
            confidence,
            label: breakout ? 'Range Breakout' : 'Range Breakdown',
            description: breakout
              ? 'Close expanded above a multi-bar range ceiling.'
              : 'Close expanded below a multi-bar range floor.',
            anchors: anchorsForSpan(features, startIndex, i, breakout ? 'bullish' : 'bearish'),
            scoreBreakdown: { compression, breakDistance, closeLocation, expansion, volume },
          }));
        }
      }
      return candidates;
    },
  };
}

export const STRUCTURE_PATTERN_DETECTORS: StructurePatternDetector[] = [
  doubleTopBottomDetector('double-top'),
  doubleTopBottomDetector('double-bottom'),
  headAndShouldersDetector('head-and-shoulders'),
  headAndShouldersDetector('inverse-head-and-shoulders'),
  triangleDetector('ascending-triangle'),
  triangleDetector('descending-triangle'),
  triangleDetector('symmetrical-triangle'),
  wedgeChannelDetector('rising-wedge'),
  wedgeChannelDetector('falling-wedge'),
  flagDetector('bull-flag'),
  flagDetector('bear-flag'),
  wedgeChannelDetector('channel-up'),
  wedgeChannelDetector('channel-down'),
  cupAndHandleDetector(),
  retestDetector('support-retest'),
  retestDetector('resistance-retest'),
  rangeBreakDetector('range-breakout'),
  rangeBreakDetector('range-breakdown'),
];

function dedupe(events: CandlePatternEvent[], maxEventsPerKind: number) {
  const sorted = events
    .filter((event) => CHART_STRUCTURE_KINDS.has(event.kind))
    .slice()
    .sort((a, b) => b.confidence - a.confidence || (b.endIndex - b.startIndex) - (a.endIndex - a.startIndex));
  const selected: CandlePatternEvent[] = [];
  const counts = new Map<CandlePatternKind, number>();

  for (const event of sorted) {
    const count = counts.get(event.kind) ?? 0;
    if (count >= maxEventsPerKind) continue;
    const overlapsStronger = selected.some((existing) => {
      const overlaps = event.startIndex <= existing.endIndex && existing.startIndex <= event.endIndex;
      return overlaps && event.kind === existing.kind;
    });
    if (overlapsStronger) continue;
    selected.push(event);
    counts.set(event.kind, count + 1);
  }

  return selected.sort((a, b) => a.endIndex - b.endIndex || a.startIndex - b.startIndex);
}

export function detectStructurePatternsFromFeatures(features: CandleFeature[], options: StructurePatternDetectionOptions = {}) {
  const opts: RequiredStructurePatternOptions = { ...DEFAULT_OPTIONS, ...options };
  if (!opts.enableChartSetups || features.length < opts.minBars) return [];
  const swings = extractSwings(features, opts);
  const context: StructurePatternDetectorContext = { features, swings, options: opts };
  const candidates = STRUCTURE_PATTERN_DETECTORS.flatMap((detector) => {
    if (features.length < detector.minBars || swings.length < detector.minSwings) return [];
    return detector.detect(context);
  });
  const events = candidates
    .filter((candidate) => candidate.confidence >= opts.minConfidence || opts.includeWeak)
    .map((candidate) => finalizeCandidate(features, candidate));
  return dedupe(events, opts.maxEventsPerKind);
}

export function detectStructurePatterns(candles: CandleInput[], options: StructurePatternDetectionOptions = {}) {
  const opts: RequiredStructurePatternOptions = { ...DEFAULT_OPTIONS, ...options };
  const sourceCandles = opts.lookback > 0 ? candles.slice(-opts.lookback) : candles;
  const offset = candles.length - sourceCandles.length;
  const features = normalizeCandles(sourceCandles, opts.contextPeriod, opts.trendPeriod);
  return detectStructurePatternsFromFeatures(features, opts).map((event) => shiftEvent(event, offset, candles));
}
