import type { OHLCVBar } from '../../types';
import { computeMACD } from '../oscillators/macd';

export function computeMACDCrossover(
  bars: OHLCVBar[],
  params: Record<string, number>,
): number[][] {
  const [macdLine, signalLine] = computeMACD(bars, params);
  const len = bars.length;
  const buySignals = new Array<number>(len).fill(NaN);
  const sellSignals = new Array<number>(len).fill(NaN);

  for (let i = 1; i < len; i++) {
    const prevMacd = macdLine[i - 1];
    const prevSignal = signalLine[i - 1];
    const currMacd = macdLine[i];
    const currSignal = signalLine[i];

    if ([prevMacd, prevSignal, currMacd, currSignal].some((v) => Number.isNaN(v))) continue;

    if (prevMacd <= prevSignal && currMacd > currSignal) {
      buySignals[i] = bars[i].low;
    } else if (prevMacd >= prevSignal && currMacd < currSignal) {
      sellSignals[i] = bars[i].high;
    }
  }

  return [buySignals, sellSignals];
}
