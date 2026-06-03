import type { OHLCVBar } from '../../types';

export function computeADL(bars: OHLCVBar[], params: Record<string, number>): number[][] {
  const smoothing = Math.max(1, params.smoothing ?? 20);
  const normPeriod = Math.max(2, params.normPeriod ?? 100);
  const len = bars.length;

  // Step 1: raw cumulative ADL
  const raw = new Array<number>(len).fill(NaN);
  let running = 0;
  for (let i = 0; i < len; i++) {
    const { high, low, close, volume } = bars[i];
    const range = high - low;
    const mfm = range === 0 ? 0 : ((close - low) - (high - close)) / range;
    running += mfm * volume;
    raw[i] = running;
  }

  // Step 2: rolling min-max normalization → 0–100
  const adlNorm = new Array<number>(len).fill(NaN);
  for (let i = normPeriod - 1; i < len; i++) {
    let min = Infinity;
    let max = -Infinity;
    for (let j = i - normPeriod + 1; j <= i; j++) {
      if (raw[j] < min) min = raw[j];
      if (raw[j] > max) max = raw[j];
    }
    adlNorm[i] = max === min ? 50 : ((raw[i] - min) / (max - min)) * 100;
  }

  // Step 3: NaN-safe sliding window SMA of the normalized ADL
  const adlSma = new Array<number>(len).fill(NaN);
  let runningSum = 0;
  let validStart = -1;
  for (let i = 0; i < len; i++) {
    if (isNaN(adlNorm[i])) continue;
    if (validStart === -1) validStart = i;
    const j = i - validStart;
    runningSum += adlNorm[i];
    if (j >= smoothing) runningSum -= adlNorm[i - smoothing];
    if (j >= smoothing - 1) adlSma[i] = runningSum / smoothing;
  }

  return [adlNorm, adlSma];
}
