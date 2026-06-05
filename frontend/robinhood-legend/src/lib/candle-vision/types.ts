export type CandleDirection = 'bullish' | 'bearish' | 'neutral';

export type CandlePatternFamily = 'candlestick' | 'vision-candle' | 'chart-setup';

export type CandlePatternStatus = 'forming' | 'confirmed' | 'invalidated' | 'expired';

export type CandlePatternKind =
  | 'doji'
  | 'dragonfly-doji'
  | 'gravestone-doji'
  | 'hammer'
  | 'hanging-man'
  | 'inverted-hammer'
  | 'shooting-star'
  | 'spinning-top'
  | 'high-wave'
  | 'long-legged-doji'
  | 'rickshaw-man'
  | 'takuri'
  | 'marubozu'
  | 'opening-marubozu'
  | 'closing-marubozu'
  | 'belt-hold'
  | 'long-line'
  | 'short-line'
  | 'engulfing'
  | 'harami'
  | 'two-crows'
  | 'counterattack'
  | 'doji-star'
  | 'harami-cross'
  | 'homing-pigeon'
  | 'in-neck'
  | 'matching-low'
  | 'on-neck'
  | 'separating-lines'
  | 'thrusting'
  | 'tasuki-gap'
  | 'upside-gap-two-crows'
  | 'piercing-line'
  | 'dark-cloud-cover'
  | 'morning-star'
  | 'evening-star'
  | 'three-white-soldiers'
  | 'three-black-crows'
  | 'three-inside'
  | 'three-outside'
  | 'three-line-strike'
  | 'three-stars-in-south'
  | 'abandoned-baby'
  | 'advance-block'
  | 'breakaway'
  | 'concealing-baby-swallow'
  | 'identical-three-crows'
  | 'kicking'
  | 'kicking-by-length'
  | 'ladder-bottom'
  | 'mat-hold'
  | 'rising-three-methods'
  | 'falling-three-methods'
  | 'stalled-pattern'
  | 'stick-sandwich'
  | 'tristar'
  | 'unique-three-river'
  | 'upside-gap-three-methods'
  | 'downside-gap-three-methods'
  | 'vision-rejection'
  | 'vision-momentum'
  | 'vision-compression'
  | 'support-retest'
  | 'resistance-retest'
  | 'range-breakout'
  | 'range-breakdown'
  | 'double-top'
  | 'double-bottom'
  | 'head-and-shoulders'
  | 'inverse-head-and-shoulders'
  | 'ascending-triangle'
  | 'descending-triangle'
  | 'symmetrical-triangle'
  | 'rising-wedge'
  | 'falling-wedge'
  | 'bull-flag'
  | 'bear-flag'
  | 'channel-up'
  | 'channel-down'
  | 'cup-and-handle'
  | 'ma-golden-cross'
  | 'ma-death-cross'
  | 'rsi-overbought'
  | 'rsi-oversold'
  | 'macd-bull-cross'
  | 'macd-bear-cross'
  | 'bollinger-squeeze'
  | 'bollinger-breakout'
  | 'volume-climax'
  | 'atr-expansion'
  | 'vwap-reclaim'
  | 'vwap-rejection';

export type CandleInput = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type CandleFeature = CandleInput & {
  index: number;
  range: number;
  body: number;
  bodyPct: number;
  upperWick: number;
  lowerWick: number;
  upperPct: number;
  lowerPct: number;
  closeLocation: number;
  direction: CandleDirection;
  directionScore: number;
  averageRange: number;
  averageBody: number;
  rangeRatio: number;
  bodyRatio: number;
  volumeRatio: number;
  trendSlope: number;
  trendDirection: CandleDirection;
};

export type CandlePatternAnchor = {
  index: number;
  time: number;
  price: number;
  role:
    | 'start'
    | 'end'
    | 'high'
    | 'low'
    | 'body-high'
    | 'body-low'
    | 'confirmation'
    | 'invalidation';
};

export type CandlePatternEvent = {
  id: string;
  kind: CandlePatternKind;
  family: CandlePatternFamily;
  status: CandlePatternStatus;
  direction: CandleDirection;
  startIndex: number;
  endIndex: number;
  detectedAt: number;
  confidence: number;
  strength: number;
  label: string;
  description: string;
  source: 'candle-vision';
  anchors: CandlePatternAnchor[];
  color: string;
  scoreBreakdown?: Record<string, number>;
};

export type CandlePatternDetectorOptions = {
  lookback?: number;
  minConfidence?: number;
  includeWeak?: boolean;
  trendPeriod?: number;
  contextPeriod?: number;
  enableClassicPatterns?: boolean;
  enableVisionPatterns?: boolean;
  enableChartSetups?: boolean;
  enableTaPatterns?: boolean;
};

export type CandlePatternTheme = {
  bullish: string;
  bearish: string;
  neutral: string;
  compression: string;
  setup: string;
  ta: string;
  text: string;
};
