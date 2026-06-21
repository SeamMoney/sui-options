import type { CandleInput } from '../src/types';

export function baseCandles(count: number, start = 100): CandleInput[] {
  return Array.from({ length: count }, (_, index) => {
    const close = start - index * 0.25;
    return {
      time: index + 1,
      open: close + 0.15,
      high: close + 1,
      low: close - 1,
      close,
      volume: 100,
    };
  });
}

export const patternFixtures: Record<string, CandleInput[]> = {
  doji: [
    ...baseCandles(4),
    { time: 5, open: 99, high: 104, low: 94, close: 99.05, volume: 120 },
  ],
  hammer: [
    ...baseCandles(4),
    { time: 5, open: 96, high: 97, low: 84, close: 96.8, volume: 150 },
  ],
  engulfing: [
    ...baseCandles(4),
    { time: 5, open: 96, high: 101, low: 95, close: 100, volume: 120 },
    { time: 6, open: 101, high: 102, low: 92, close: 94, volume: 160 },
  ],
  // Textbook bullish Marubozu: a large directional body with both shadows nearly
  // absent (open≈low, close≈high). This is the pattern the live coach surfaces in
  // the /pro demo ("Bullish Marubozu"), so it gets its own regression.
  marubozu: [
    ...baseCandles(4),
    { time: 5, open: 99.0, high: 105.05, low: 98.95, close: 105.0, volume: 170 },
  ],
  'morning-star': [
    ...baseCandles(4, 112),
    { time: 5, open: 111, high: 112, low: 99, close: 100, volume: 140 },
    { time: 6, open: 99.4, high: 100.2, low: 98.7, close: 99.7, volume: 100 },
    { time: 7, open: 100, high: 109, low: 99.5, close: 108, volume: 170 },
  ],
  'vision-momentum': [
    ...baseCandles(1),
    { time: 2, open: 98, high: 101, low: 97.5, close: 100.5, volume: 110 },
    { time: 3, open: 100.5, high: 103.4, low: 100, close: 103, volume: 120 },
    { time: 4, open: 103, high: 106, low: 102.5, close: 105.6, volume: 130 },
    { time: 5, open: 105.6, high: 108.4, low: 105.1, close: 108, volume: 140 },
    { time: 6, open: 108, high: 111, low: 107.5, close: 110.7, volume: 150 },
    { time: 7, open: 110.7, high: 113.6, low: 110.2, close: 113.2, volume: 160 },
  ],
};
