import type { CandleDirection, CandleInput } from './types';

export type TaLineKind =
  | 'support'
  | 'resistance'
  | 'trend'
  | 'channel-upper'
  | 'channel-lower'
  | 'vwap';

export type TaLinePoint = {
  index: number;
  time: number;
  price: number;
};

export type TaLine = {
  id: string;
  kind: TaLineKind;
  label: string;
  direction: CandleDirection;
  confidence: number;
  color: string;
  points: TaLinePoint[];
  style: 'solid' | 'dashed' | 'glow';
};

export type TaLineOptions = {
  lookback?: number;
  swingRadius?: number;
  minSwingDistance?: number;
  channelDeviationMultiplier?: number;
  includeVwap?: boolean;
  maxLines?: number;
};

const DEFAULT_OPTIONS: Required<TaLineOptions> = {
  lookback: 180,
  swingRadius: 3,
  minSwingDistance: 10,
  channelDeviationMultiplier: 1.65,
  includeVwap: true,
  maxLines: 7,
};

type SwingPoint = {
  kind: 'high' | 'low';
  index: number;
  time: number;
  price: number;
  strength: number;
};

type Fit = {
  slope: number;
  intercept: number;
  r2: number;
  deviation: number;
};

export function deriveTaLines(candles: readonly CandleInput[], options: TaLineOptions = {}): TaLine[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (candles.length < Math.max(16, opts.swingRadius * 4)) return [];

  const source = candles.slice(-opts.lookback);
  const offset = candles.length - source.length;
  const closeFit = fitLine(source.map((bar, localIndex) => ({ index: offset + localIndex, price: bar.close })));
  const startIndex = offset;
  const endIndex = candles.length - 1;
  const start = candles[startIndex]!;
  const end = candles[endIndex]!;
  const trendDirection = closeFit.slope > 0 ? 'bullish' : closeFit.slope < 0 ? 'bearish' : 'neutral';
  const confidenceFromFit = clamp01(0.42 + closeFit.r2 * 0.44);

  const lines: TaLine[] = [
    {
      id: `trend:${startIndex}:${endIndex}`,
      kind: 'trend',
      label: trendDirection === 'bullish' ? 'Rising regression' : trendDirection === 'bearish' ? 'Falling regression' : 'Flat regression',
      direction: trendDirection,
      confidence: confidenceFromFit,
      color: trendDirection === 'bearish' ? '#fb7185' : trendDirection === 'bullish' ? '#4ade80' : '#94a3b8',
      style: 'solid',
      points: [
        { index: startIndex, time: start.time, price: lineValue(closeFit, startIndex) },
        { index: endIndex, time: end.time, price: lineValue(closeFit, endIndex) },
      ],
    },
  ];

  const channelOffset = Math.max(0.01, closeFit.deviation * opts.channelDeviationMultiplier);
  lines.push(
    {
      id: `channel-upper:${startIndex}:${endIndex}`,
      kind: 'channel-upper',
      label: 'Upper channel',
      direction: 'bearish',
      confidence: confidenceFromFit * 0.9,
      color: '#a78bfa',
      style: 'dashed',
      points: [
        { index: startIndex, time: start.time, price: lineValue(closeFit, startIndex) + channelOffset },
        { index: endIndex, time: end.time, price: lineValue(closeFit, endIndex) + channelOffset },
      ],
    },
    {
      id: `channel-lower:${startIndex}:${endIndex}`,
      kind: 'channel-lower',
      label: 'Lower channel',
      direction: 'bullish',
      confidence: confidenceFromFit * 0.9,
      color: '#a78bfa',
      style: 'dashed',
      points: [
        { index: startIndex, time: start.time, price: lineValue(closeFit, startIndex) - channelOffset },
        { index: endIndex, time: end.time, price: lineValue(closeFit, endIndex) - channelOffset },
      ],
    },
  );

  const swings = extractSwings(candles, opts.swingRadius);
  const lows = enforceSwingDistance(
    swings.filter((swing) => swing.kind === 'low').sort((a, b) => b.strength - a.strength || b.index - a.index),
    opts.minSwingDistance,
  ).sort((a, b) => a.index - b.index);
  const highs = enforceSwingDistance(
    swings.filter((swing) => swing.kind === 'high').sort((a, b) => b.strength - a.strength || b.index - a.index),
    opts.minSwingDistance,
  ).sort((a, b) => a.index - b.index);

  const support = lineFromSwings('support', lows.slice(-3));
  const resistance = lineFromSwings('resistance', highs.slice(-3));
  if (support) lines.push(support);
  if (resistance) lines.push(resistance);

  if (opts.includeVwap && hasAnyVolume(source)) {
    const vwap = rollingVwap(source);
    lines.push({
      id: `vwap:${startIndex}:${endIndex}`,
      kind: 'vwap',
      label: 'Session VWAP',
      direction: end.close >= vwap ? 'bullish' : 'bearish',
      confidence: 0.72,
      color: '#38bdf8',
      style: 'glow',
      points: [
        { index: startIndex, time: start.time, price: vwap },
        { index: endIndex, time: end.time, price: vwap },
      ],
    });
  }

  return lines
    .filter((line) => line.points.every((point) => Number.isFinite(point.price)))
    .sort((a, b) => linePriority(b) - linePriority(a))
    .slice(0, opts.maxLines);
}

function lineFromSwings(kind: Extract<TaLineKind, 'support' | 'resistance'>, swings: SwingPoint[]): TaLine | null {
  if (swings.length < 2) return null;
  const fit = fitLine(swings.map((swing) => ({ index: swing.index, price: swing.price })));
  const first = swings[0]!;
  const last = swings[swings.length - 1]!;
  const direction: CandleDirection = kind === 'support' ? 'bullish' : 'bearish';
  const strength = swings.reduce((sum, swing) => sum + swing.strength, 0) / swings.length;
  return {
    id: `${kind}:${first.index}:${last.index}`,
    kind,
    label: kind === 'support' ? 'Swing support' : 'Swing resistance',
    direction,
    confidence: clamp01(0.48 + fit.r2 * 0.25 + strength * 0.22),
    color: kind === 'support' ? '#35e987' : '#ff5f75',
    style: 'glow',
    points: [
      { index: first.index, time: first.time, price: lineValue(fit, first.index) },
      { index: last.index, time: last.time, price: lineValue(fit, last.index) },
    ],
  };
}

function extractSwings(candles: readonly CandleInput[], radius: number) {
  const swings: SwingPoint[] = [];
  for (let index = radius; index < candles.length - radius; index += 1) {
    const bar = candles[index]!;
    let high = true;
    let low = true;
    for (let j = index - radius; j <= index + radius; j += 1) {
      if (j === index) continue;
      if (candles[j]!.high >= bar.high) high = false;
      if (candles[j]!.low <= bar.low) low = false;
    }

    const left = candles[Math.max(0, index - radius)]!;
    const right = candles[Math.min(candles.length - 1, index + radius)]!;
    const localRange = Math.max(
      1e-9,
      Math.max(bar.high, left.high, right.high) - Math.min(bar.low, left.low, right.low),
    );
    if (high) {
      const shoulder = Math.max(left.high, right.high);
      swings.push({ kind: 'high', index, time: bar.time, price: bar.high, strength: clamp01((bar.high - shoulder) / localRange) });
    }
    if (low) {
      const shoulder = Math.min(left.low, right.low);
      swings.push({ kind: 'low', index, time: bar.time, price: bar.low, strength: clamp01((shoulder - bar.low) / localRange) });
    }
  }
  return swings;
}

function enforceSwingDistance(swings: SwingPoint[], minDistance: number) {
  const selected: SwingPoint[] = [];
  for (const swing of swings) {
    if (selected.every((existing) => Math.abs(existing.index - swing.index) >= minDistance)) {
      selected.push(swing);
    }
  }
  return selected;
}

function fitLine(points: Array<{ index: number; price: number }>): Fit {
  if (points.length < 2) {
    const price = points[0]?.price ?? 0;
    return { slope: 0, intercept: price, r2: 1, deviation: 0 };
  }
  const meanX = points.reduce((sum, point) => sum + point.index, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.price, 0) / points.length;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    numerator += (point.index - meanX) * (point.price - meanY);
    denominator += (point.index - meanX) ** 2;
  }
  const slope = denominator > 1e-9 ? numerator / denominator : 0;
  const intercept = meanY - slope * meanX;
  let total = 0;
  let residual = 0;
  for (const point of points) {
    const fitted = lineValue({ slope, intercept }, point.index);
    total += (point.price - meanY) ** 2;
    residual += (point.price - fitted) ** 2;
  }
  const r2 = total <= 1e-9 ? 1 : clamp01(1 - residual / total);
  const deviation = Math.sqrt(residual / Math.max(1, points.length));
  return { slope, intercept, r2, deviation };
}

function lineValue(line: Pick<Fit, 'slope' | 'intercept'>, index: number) {
  return line.slope * index + line.intercept;
}

function hasAnyVolume(candles: readonly CandleInput[]) {
  return candles.some((bar) => (bar.volume ?? 0) > 0);
}

function rollingVwap(candles: readonly CandleInput[]) {
  let notional = 0;
  let volume = 0;
  for (const bar of candles) {
    const barVolume = Math.max(0, bar.volume ?? 0);
    const typical = (bar.high + bar.low + bar.close) / 3;
    notional += typical * barVolume;
    volume += barVolume;
  }
  return volume > 0 ? notional / volume : candles[candles.length - 1]?.close ?? 0;
}

function linePriority(line: TaLine) {
  const kindBoost = line.kind === 'support' || line.kind === 'resistance' ? 0.12 : line.kind === 'vwap' ? 0.08 : 0;
  return line.confidence + kindBoost;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}
