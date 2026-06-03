import type { OHLCVBar } from '../../types';
import { sma, ema } from '../compute';

function rma(data: number[], period: number): number[] {
  const len = data.length;
  const result = new Array<number>(len).fill(NaN);
  let prev = NaN;

  for (let i = 0; i < len; i++) {
    if (isNaN(data[i])) continue;
    if (isNaN(prev)) {
      // Seed with SMA of first `period` valid values
      let sum = 0;
      let count = 0;
      for (let j = 0; j <= i && count < period; j++) {
        if (!isNaN(data[j])) { sum += data[j]; count++; }
      }
      if (count === period) {
        prev = sum / period;
        result[i] = prev;
      }
    } else {
      prev = (prev * (period - 1) + data[i]) / period;
      result[i] = prev;
    }
  }

  return result;
}

function computeWildersRSI(bars: OHLCVBar[], period: number): number[] {
  const len = bars.length;
  const result = new Array<number>(len).fill(NaN);
  if (len < period + 1) return result;

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const change = bars[i].close - bars[i - 1].close;
    if (change > 0) avgGain += change;
    else avgLoss += -change;
  }
  avgGain /= period;
  avgLoss /= period;

  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < len; i++) {
    const change = bars[i].close - bars[i - 1].close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return result;
}

function computeSmoothing(rsiValues: number[], period: number, maType: number): number[] {
  if (maType === 2) return ema(rsiValues, period);
  if (maType === 3) return rma(rsiValues, period);
  return sma(rsiValues, period);
}

function isPivotLow(data: number[], i: number, left: number, right: number): boolean {
  if (i - left < 0 || i + right >= data.length) return false;
  const val = data[i];
  if (isNaN(val)) return false;
  for (let j = i - left; j <= i + right; j++) {
    if (j === i) continue;
    if (isNaN(data[j]) || data[j] < val) return false;
  }
  return true;
}

function isPivotHigh(data: number[], i: number, left: number, right: number): boolean {
  if (i - left < 0 || i + right >= data.length) return false;
  const val = data[i];
  if (isNaN(val)) return false;
  for (let j = i - left; j <= i + right; j++) {
    if (j === i) continue;
    if (isNaN(data[j]) || data[j] > val) return false;
  }
  return true;
}

export function computeRSIStrategy(bars: OHLCVBar[], params: Record<string, number>): number[][] {
  const rsiPeriod = Math.max(1, Math.round(params.rsiPeriod ?? 14));
  const maPeriod = Math.max(1, Math.round(params.maPeriod ?? 14));
  const maType = Math.round(params.maType ?? 1);
  const divergence = (params.divergence ?? 0) >= 1;
  const lookbackLeft = Math.max(1, Math.round(params.lookbackLeft ?? 5));
  const lookbackRight = Math.max(1, Math.round(params.lookbackRight ?? 5));
  const rangeLower = 5;
  const rangeUpper = 60;

  const len = bars.length;
  const buySignals = new Array<number>(len).fill(NaN);
  const sellSignals = new Array<number>(len).fill(NaN);

  const rsiValues = computeWildersRSI(bars, rsiPeriod);
  const maValues = computeSmoothing(rsiValues, maPeriod, maType);

  // RSI/MA crossover signals
  for (let i = 1; i < len; i++) {
    const prevRsi = rsiValues[i - 1];
    const prevMa = maValues[i - 1];
    const currRsi = rsiValues[i];
    const currMa = maValues[i];
    if ([prevRsi, prevMa, currRsi, currMa].some(isNaN)) continue;

    if (prevRsi <= prevMa && currRsi > currMa) {
      buySignals[i] = bars[i].low;
    } else if (prevRsi >= prevMa && currRsi < currMa) {
      sellSignals[i] = bars[i].high;
    }
  }

  // Divergence signals
  if (divergence) {
    const lows = bars.map((b) => b.low);
    const highs = bars.map((b) => b.high);

    // Track last pivot low/high for divergence comparison
    let lastPlIdx = -1;
    let lastPhIdx = -1;

    for (let i = lookbackLeft; i < len - lookbackRight; i++) {
      const pivotBar = i; // the pivot bar itself

      if (isPivotLow(rsiValues, pivotBar, lookbackLeft, lookbackRight)) {
        // Confirm pivot: signal fires at pivotBar + lookbackRight
        const signalBar = pivotBar + lookbackRight;
        if (signalBar < len && lastPlIdx >= 0) {
          const barsBack = pivotBar - lastPlIdx;
          if (barsBack >= rangeLower && barsBack <= rangeUpper) {
            const rsiHL = rsiValues[pivotBar] > rsiValues[lastPlIdx];
            const priceLL = lows[pivotBar] < lows[lastPlIdx];
            if (rsiHL && priceLL && !isNaN(buySignals[signalBar]) === false) {
              buySignals[signalBar] = bars[signalBar].low;
            }
          }
        }
        lastPlIdx = pivotBar;
      }

      if (isPivotHigh(rsiValues, pivotBar, lookbackLeft, lookbackRight)) {
        const signalBar = pivotBar + lookbackRight;
        if (signalBar < len && lastPhIdx >= 0) {
          const barsBack = pivotBar - lastPhIdx;
          if (barsBack >= rangeLower && barsBack <= rangeUpper) {
            const rsiLH = rsiValues[pivotBar] < rsiValues[lastPhIdx];
            const priceHH = highs[pivotBar] > highs[lastPhIdx];
            if (rsiLH && priceHH && !isNaN(sellSignals[signalBar]) === false) {
              sellSignals[signalBar] = bars[signalBar].high;
            }
          }
        }
        lastPhIdx = pivotBar;
      }
    }
  }

  return [buySignals, sellSignals];
}
