import type { OHLCVBar } from '../../types';

export function computeVolume(bars: OHLCVBar[], _params: Record<string, number>): number[][] {
  return [bars.map((bar) => bar.volume)];
}
