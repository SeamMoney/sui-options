import type { CandlePatternEvent, CandlePatternFamily } from '@/lib/candle-vision';

export type PatternFamilyFilter = CandlePatternFamily | 'all';

export type PatternScannerStats = {
  supported: number;
  detectedRaw: number;
  visible: number;
  watchlist: number;
};

export type SignalPanelEvent = CandlePatternEvent & {
  visible?: boolean;
};
