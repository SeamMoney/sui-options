import type { CandleInput } from '../../types';

export type IndicatorValue = number | null;

export type BollingerBandPoint = {
  middle: IndicatorValue;
  upper: IndicatorValue;
  lower: IndicatorValue;
  width: IndicatorValue;
};

export type MacdPoint = {
  macd: IndicatorValue;
  signal: IndicatorValue;
  histogram: IndicatorValue;
};

const EPSILON = 1e-9;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function sanitizePeriod(period: number) {
  return Math.max(1, Math.floor(period));
}

function closeOf(bar: CandleInput) {
  return isFiniteNumber(bar.close) ? bar.close : 0;
}

function typicalPrice(bar: CandleInput) {
  return (bar.high + bar.low + bar.close) / 3;
}

function positiveVolume(bar: CandleInput) {
  return Math.max(0, isFiniteNumber(bar.volume) ? bar.volume : 0);
}

export function closes(candles: CandleInput[]) {
  return candles.map(closeOf);
}

export function hasUsableVolume(candles: CandleInput[]) {
  return candles.some((bar) => positiveVolume(bar) > 0);
}

export function sma(candles: CandleInput[], period = 20): IndicatorValue[] {
  const window = sanitizePeriod(period);
  const output: IndicatorValue[] = Array(candles.length).fill(null);
  let sum = 0;

  for (let i = 0; i < candles.length; i += 1) {
    sum += closeOf(candles[i]);
    if (i >= window) sum -= closeOf(candles[i - window]);
    if (i >= window - 1) output[i] = sum / window;
  }

  return output;
}

export function ema(candles: CandleInput[], period = 20): IndicatorValue[] {
  return emaValues(closes(candles), period);
}

export function emaValues(values: IndicatorValue[], period = 20): IndicatorValue[] {
  const window = sanitizePeriod(period);
  const output: IndicatorValue[] = Array(values.length).fill(null);
  const multiplier = 2 / (window + 1);
  const seed: number[] = [];
  let previous: IndicatorValue = null;

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!isFiniteNumber(value)) continue;

    if (previous === null) {
      seed.push(value);
      if (seed.length === window) {
        previous = seed.reduce((sum, next) => sum + next, 0) / window;
        output[i] = previous;
      }
      continue;
    }

    previous = value * multiplier + previous * (1 - multiplier);
    output[i] = previous;
  }

  return output;
}

export function rsi(candles: CandleInput[], period = 14): IndicatorValue[] {
  const window = sanitizePeriod(period);
  const output: IndicatorValue[] = Array(candles.length).fill(null);
  if (candles.length <= window) return output;

  let gainSum = 0;
  let lossSum = 0;

  for (let i = 1; i <= window; i += 1) {
    const change = closeOf(candles[i]) - closeOf(candles[i - 1]);
    if (change >= 0) gainSum += change;
    else lossSum += Math.abs(change);
  }

  let averageGain = gainSum / window;
  let averageLoss = lossSum / window;
  output[window] = rsiFromAverages(averageGain, averageLoss);

  for (let i = window + 1; i < candles.length; i += 1) {
    const change = closeOf(candles[i]) - closeOf(candles[i - 1]);
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    averageGain = (averageGain * (window - 1) + gain) / window;
    averageLoss = (averageLoss * (window - 1) + loss) / window;
    output[i] = rsiFromAverages(averageGain, averageLoss);
  }

  return output;
}

function rsiFromAverages(averageGain: number, averageLoss: number) {
  if (averageLoss <= EPSILON && averageGain <= EPSILON) return 50;
  if (averageLoss <= EPSILON) return 100;
  if (averageGain <= EPSILON) return 0;
  const relativeStrength = averageGain / averageLoss;
  return 100 - 100 / (1 + relativeStrength);
}

export function macd(candles: CandleInput[], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9): MacdPoint[] {
  const fast = ema(candles, fastPeriod);
  const slow = ema(candles, slowPeriod);
  const macdLine = fast.map((fastValue, index) => {
    const slowValue = slow[index];
    return fastValue === null || slowValue === null ? null : fastValue - slowValue;
  });
  const signal = emaValues(macdLine, signalPeriod);

  return macdLine.map((line, index) => {
    const signalValue = signal[index];
    return {
      macd: line,
      signal: signalValue,
      histogram: line === null || signalValue === null ? null : line - signalValue,
    };
  });
}

export function bollingerBands(candles: CandleInput[], period = 20, multiplier = 2): BollingerBandPoint[] {
  const window = sanitizePeriod(period);
  const output: BollingerBandPoint[] = candles.map(() => ({ middle: null, upper: null, lower: null, width: null }));
  let sum = 0;
  let sumSquares = 0;

  for (let i = 0; i < candles.length; i += 1) {
    const close = closeOf(candles[i]);
    sum += close;
    sumSquares += close * close;

    if (i >= window) {
      const stale = closeOf(candles[i - window]);
      sum -= stale;
      sumSquares -= stale * stale;
    }

    if (i < window - 1) continue;

    const middle = sum / window;
    const variance = Math.max(0, sumSquares / window - middle * middle);
    const deviation = Math.sqrt(variance);
    const upper = middle + multiplier * deviation;
    const lower = middle - multiplier * deviation;
    output[i] = {
      middle,
      upper,
      lower,
      width: Math.abs(middle) <= EPSILON ? null : (upper - lower) / Math.abs(middle),
    };
  }

  return output;
}

export function trueRange(candles: CandleInput[]): number[] {
  return candles.map((bar, index) => {
    const previousClose = index > 0 ? closeOf(candles[index - 1]) : closeOf(bar);
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose),
    );
  });
}

export function atr(candles: CandleInput[], period = 14): IndicatorValue[] {
  const window = sanitizePeriod(period);
  const ranges = trueRange(candles);
  const output: IndicatorValue[] = Array(candles.length).fill(null);
  if (ranges.length < window) return output;

  let average = 0;
  for (let i = 0; i < window; i += 1) average += ranges[i];
  average /= window;
  output[window - 1] = average;

  for (let i = window; i < ranges.length; i += 1) {
    average = (average * (window - 1) + ranges[i]) / window;
    output[i] = average;
  }

  return output;
}

export function vwap(candles: CandleInput[], period?: number): IndicatorValue[] {
  const output: IndicatorValue[] = Array(candles.length).fill(null);
  const useRollingWindow = typeof period === 'number' && Number.isFinite(period) && period > 0;
  const window = useRollingWindow ? sanitizePeriod(period) : candles.length || 1;
  let priceVolumeSum = 0;
  let volumeSum = 0;

  for (let i = 0; i < candles.length; i += 1) {
    const bar = candles[i];
    const volume = positiveVolume(bar) || 1;
    priceVolumeSum += typicalPrice(bar) * volume;
    volumeSum += volume;

    if (useRollingWindow && i >= window) {
      const stale = candles[i - window];
      const staleVolume = positiveVolume(stale) || 1;
      priceVolumeSum -= typicalPrice(stale) * staleVolume;
      volumeSum -= staleVolume;
    }

    if (!useRollingWindow || i >= window - 1) {
      output[i] = volumeSum > EPSILON ? priceVolumeSum / volumeSum : null;
    }
  }

  return output;
}

export function rollingVolumeAverage(candles: CandleInput[], period = 20): IndicatorValue[] {
  const window = sanitizePeriod(period);
  const output: IndicatorValue[] = Array(candles.length).fill(null);
  let sum = 0;

  for (let i = 0; i < candles.length; i += 1) {
    sum += positiveVolume(candles[i]);
    if (i >= window) sum -= positiveVolume(candles[i - window]);
    if (i >= window - 1) output[i] = sum / window;
  }

  return output;
}

export function rollingAverage(values: IndicatorValue[], period = 20): IndicatorValue[] {
  const window = sanitizePeriod(period);
  const output: IndicatorValue[] = Array(values.length).fill(null);
  const queue: number[] = [];
  let sum = 0;

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (isFiniteNumber(value)) {
      queue.push(value);
      sum += value;
    }

    if (queue.length > window) sum -= queue.shift() ?? 0;
    if (queue.length === window) output[i] = sum / window;
  }

  return output;
}
