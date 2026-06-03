import type { OHLCVBar } from '../../types';
import { computeADL } from '../oscillators/adl';

export function computeADLCrossover(bars: OHLCVBar[], params: Record<string, number>): number[][] {
  const [adl, adlSma] = computeADL(bars, params);
  const len = bars.length;
  const buySignals = new Array<number>(len).fill(NaN);
  const sellSignals = new Array<number>(len).fill(NaN);

  for (let i = 1; i < len; i++) {
    const prevAdl = adl[i - 1];
    const prevSma = adlSma[i - 1];
    const currAdl = adl[i];
    const currSma = adlSma[i];

    if ([prevAdl, prevSma, currAdl, currSma].some((v) => Number.isNaN(v))) continue;

    if (prevAdl <= prevSma && currAdl > currSma) {
      buySignals[i] = bars[i].low;
    } else if (prevAdl >= prevSma && currAdl < currSma) {
      sellSignals[i] = bars[i].high;
    }
  }

  return [buySignals, sellSignals];
}
