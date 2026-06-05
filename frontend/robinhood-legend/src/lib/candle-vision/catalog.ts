import type {
  CandleDirection,
  CandleInput,
  CandlePatternAnchor,
  CandlePatternEvent,
  CandlePatternFamily,
  CandlePatternKind,
} from './types';

export type CandlePatternCatalogEntry = {
  kind: CandlePatternKind;
  family: CandlePatternFamily;
  direction: CandleDirection;
  label: string;
  description: string;
};

export const CANDLE_VISION_PATTERN_CATALOG: CandlePatternCatalogEntry[] = [
  { kind: 'doji', family: 'candlestick', direction: 'neutral', label: 'Doji', description: 'Open and close compress into the same area, showing indecision.' },
  { kind: 'dragonfly-doji', family: 'candlestick', direction: 'bullish', label: 'Dragonfly Doji', description: 'Long lower shadow with a close near the open, showing downside rejection.' },
  { kind: 'gravestone-doji', family: 'candlestick', direction: 'bearish', label: 'Gravestone Doji', description: 'Long upper shadow with a close near the open, showing upside rejection.' },
  { kind: 'hammer', family: 'candlestick', direction: 'bullish', label: 'Hammer', description: 'Small body with a long lower wick after weakness.' },
  { kind: 'hanging-man', family: 'candlestick', direction: 'bearish', label: 'Hanging Man', description: 'Hammer-shaped bar after strength, warning of exhaustion.' },
  { kind: 'inverted-hammer', family: 'candlestick', direction: 'bullish', label: 'Inverted Hammer', description: 'Small body with a long upper probe after a down move.' },
  { kind: 'shooting-star', family: 'candlestick', direction: 'bearish', label: 'Shooting Star', description: 'Small body with a long upper wick after strength.' },
  { kind: 'spinning-top', family: 'candlestick', direction: 'neutral', label: 'Spinning Top', description: 'Small real body with balanced wicks.' },
  { kind: 'high-wave', family: 'candlestick', direction: 'neutral', label: 'High Wave', description: 'Large upper and lower shadows show volatility without control.' },
  { kind: 'long-legged-doji', family: 'candlestick', direction: 'neutral', label: 'Long-Legged Doji', description: 'Doji with unusually long upper and lower shadows.' },
  { kind: 'rickshaw-man', family: 'candlestick', direction: 'neutral', label: 'Rickshaw Man', description: 'Long-legged doji with the body near the candle midpoint.' },
  { kind: 'takuri', family: 'candlestick', direction: 'bullish', label: 'Takuri', description: 'Dragonfly-style downside probe with strong lower rejection.' },
  { kind: 'marubozu', family: 'candlestick', direction: 'bullish', label: 'Marubozu', description: 'Large directional body with minimal wicks.' },
  { kind: 'opening-marubozu', family: 'candlestick', direction: 'bullish', label: 'Opening Marubozu', description: 'Directional candle with almost no opening shadow.' },
  { kind: 'closing-marubozu', family: 'candlestick', direction: 'bullish', label: 'Closing Marubozu', description: 'Directional candle with almost no closing shadow.' },
  { kind: 'belt-hold', family: 'candlestick', direction: 'bullish', label: 'Belt Hold', description: 'Long candle that opens near one extreme and pushes directionally.' },
  { kind: 'long-line', family: 'candlestick', direction: 'bullish', label: 'Long Line', description: 'Long real body relative to recent candle bodies.' },
  { kind: 'short-line', family: 'candlestick', direction: 'neutral', label: 'Short Line', description: 'Short real body relative to recent candle bodies.' },
  { kind: 'engulfing', family: 'candlestick', direction: 'bullish', label: 'Engulfing', description: 'Current body fully engulfs the previous candle body.' },
  { kind: 'harami', family: 'candlestick', direction: 'bearish', label: 'Harami', description: 'Small current body forms inside the prior body.' },
  { kind: 'two-crows', family: 'candlestick', direction: 'bearish', label: 'Two Crows', description: 'Bearish follow-through after an upside gap.' },
  { kind: 'counterattack', family: 'candlestick', direction: 'neutral', label: 'Counterattack', description: 'Opposite-color candle closes near the prior close after a strong move.' },
  { kind: 'doji-star', family: 'candlestick', direction: 'neutral', label: 'Doji Star', description: 'Doji gaps after a long candle, showing trend pause.' },
  { kind: 'harami-cross', family: 'candlestick', direction: 'neutral', label: 'Harami Cross', description: 'Doji forms inside the previous large body.' },
  { kind: 'homing-pigeon', family: 'candlestick', direction: 'bullish', label: 'Homing Pigeon', description: 'Small bearish candle contained inside a prior bearish body.' },
  { kind: 'in-neck', family: 'candlestick', direction: 'bearish', label: 'In-Neck', description: 'Weak bullish response closes near the prior bearish close.' },
  { kind: 'matching-low', family: 'candlestick', direction: 'bullish', label: 'Matching Low', description: 'Two bearish candles close around the same low.' },
  { kind: 'on-neck', family: 'candlestick', direction: 'bearish', label: 'On-Neck', description: 'Bullish response closes around the prior low after a decline.' },
  { kind: 'separating-lines', family: 'candlestick', direction: 'neutral', label: 'Separating Lines', description: 'Opposite-color candles share similar opens and continue the trend.' },
  { kind: 'thrusting', family: 'candlestick', direction: 'bearish', label: 'Thrusting', description: 'Bullish candle recovers into but not above the prior bearish midpoint.' },
  { kind: 'tasuki-gap', family: 'candlestick', direction: 'neutral', label: 'Tasuki Gap', description: 'Continuation gap partially retraced by the following candle.' },
  { kind: 'upside-gap-two-crows', family: 'candlestick', direction: 'bearish', label: 'Upside Gap Two Crows', description: 'Two bearish candles appear after an upside gap.' },
  { kind: 'piercing-line', family: 'candlestick', direction: 'bullish', label: 'Piercing Line', description: 'Bull candle recovers deeply into the previous bearish candle.' },
  { kind: 'dark-cloud-cover', family: 'candlestick', direction: 'bearish', label: 'Dark Cloud Cover', description: 'Bear candle fades deeply into the previous bullish candle.' },
  { kind: 'morning-star', family: 'candlestick', direction: 'bullish', label: 'Morning Star', description: 'Three-candle reversal: selloff, pause, bullish recovery.' },
  { kind: 'evening-star', family: 'candlestick', direction: 'bearish', label: 'Evening Star', description: 'Three-candle reversal: rally, pause, bearish rejection.' },
  { kind: 'three-white-soldiers', family: 'candlestick', direction: 'bullish', label: 'Three White Soldiers', description: 'Three strong bullish candles with rising closes.' },
  { kind: 'three-black-crows', family: 'candlestick', direction: 'bearish', label: 'Three Black Crows', description: 'Three strong bearish candles with falling closes.' },
  { kind: 'three-inside', family: 'candlestick', direction: 'neutral', label: 'Three Inside', description: 'Harami-style setup confirmed by the third candle.' },
  { kind: 'three-outside', family: 'candlestick', direction: 'neutral', label: 'Three Outside', description: 'Engulfing-style setup confirmed by the third candle.' },
  { kind: 'three-line-strike', family: 'candlestick', direction: 'neutral', label: 'Three-Line Strike', description: 'Three-candle trend interrupted by a sharp opposing strike candle.' },
  { kind: 'three-stars-in-south', family: 'candlestick', direction: 'bullish', label: 'Three Stars In The South', description: 'Three bearish candles compress after downside exhaustion.' },
  { kind: 'abandoned-baby', family: 'candlestick', direction: 'neutral', label: 'Abandoned Baby', description: 'Doji gaps away and is then abandoned by a reversal gap.' },
  { kind: 'advance-block', family: 'candlestick', direction: 'bearish', label: 'Advance Block', description: 'Bullish advance weakens through shrinking bodies and upper shadows.' },
  { kind: 'breakaway', family: 'candlestick', direction: 'neutral', label: 'Breakaway', description: 'Five-candle exhaustion sequence that reverses the initial gap move.' },
  { kind: 'concealing-baby-swallow', family: 'candlestick', direction: 'bullish', label: 'Concealing Baby Swallow', description: 'Four-candle bearish exhaustion structure with hidden reversal pressure.' },
  { kind: 'identical-three-crows', family: 'candlestick', direction: 'bearish', label: 'Identical Three Crows', description: 'Three bearish candles open around the prior close and continue lower.' },
  { kind: 'kicking', family: 'candlestick', direction: 'neutral', label: 'Kicking', description: 'Opposing marubozu candles separated by a gap.' },
  { kind: 'kicking-by-length', family: 'candlestick', direction: 'neutral', label: 'Kicking By Length', description: 'Kicking pattern where the longer candle determines direction.' },
  { kind: 'ladder-bottom', family: 'candlestick', direction: 'bullish', label: 'Ladder Bottom', description: 'Bearish sequence ends with a bullish reversal candle.' },
  { kind: 'mat-hold', family: 'candlestick', direction: 'bullish', label: 'Mat Hold', description: 'Bullish continuation: impulse, controlled pullback, resumed advance.' },
  { kind: 'rising-three-methods', family: 'candlestick', direction: 'bullish', label: 'Rising Three Methods', description: 'Bullish continuation with small countertrend candles inside the impulse range.' },
  { kind: 'falling-three-methods', family: 'candlestick', direction: 'bearish', label: 'Falling Three Methods', description: 'Bearish continuation with small countertrend candles inside the impulse range.' },
  { kind: 'stalled-pattern', family: 'candlestick', direction: 'bearish', label: 'Stalled Pattern', description: 'Bullish advance loses body size and momentum.' },
  { kind: 'stick-sandwich', family: 'candlestick', direction: 'bullish', label: 'Stick Sandwich', description: 'Two bearish closes surround a bullish candle near matching lows.' },
  { kind: 'tristar', family: 'candlestick', direction: 'neutral', label: 'Tristar', description: 'Three doji candles mark extreme indecision around a turning point.' },
  { kind: 'unique-three-river', family: 'candlestick', direction: 'bullish', label: 'Unique Three River', description: 'Bearish pressure fails after a deep lower-shadow candle.' },
  { kind: 'upside-gap-three-methods', family: 'candlestick', direction: 'bullish', label: 'Upside Gap Three Methods', description: 'Bullish continuation gap is partially filled and resumes.' },
  { kind: 'downside-gap-three-methods', family: 'candlestick', direction: 'bearish', label: 'Downside Gap Three Methods', description: 'Bearish continuation gap is partially filled and resumes lower.' },
  { kind: 'vision-rejection', family: 'vision-candle', direction: 'bullish', label: 'Vision Rejection', description: 'Shape-template detector: dominant wick rejection with context.' },
  { kind: 'vision-momentum', family: 'vision-candle', direction: 'bullish', label: 'Vision Momentum', description: 'Shape-template detector: aligned bodies and monotonic closes.' },
  { kind: 'vision-compression', family: 'vision-candle', direction: 'neutral', label: 'Vision Compression', description: 'Shape-template detector: mixed small bodies in contracting range.' },
  { kind: 'support-retest', family: 'chart-setup', direction: 'bullish', label: 'Support Retest', description: 'Price returns to a support shelf and confirms above it.' },
  { kind: 'resistance-retest', family: 'chart-setup', direction: 'bearish', label: 'Resistance Retest', description: 'Price tags a resistance shelf and rejects from it.' },
  { kind: 'range-breakout', family: 'chart-setup', direction: 'bullish', label: 'Range Breakout', description: 'Close expands above a multi-bar range high.' },
  { kind: 'range-breakdown', family: 'chart-setup', direction: 'bearish', label: 'Range Breakdown', description: 'Close expands below a multi-bar range low.' },
  { kind: 'double-top', family: 'chart-setup', direction: 'bearish', label: 'Double Top', description: 'Two similar swing highs fail to continue.' },
  { kind: 'double-bottom', family: 'chart-setup', direction: 'bullish', label: 'Double Bottom', description: 'Two similar swing lows fail to break lower.' },
  { kind: 'head-and-shoulders', family: 'chart-setup', direction: 'bearish', label: 'Head & Shoulders', description: 'Left shoulder, higher head, right shoulder exhaustion pattern.' },
  { kind: 'inverse-head-and-shoulders', family: 'chart-setup', direction: 'bullish', label: 'Inverse H&S', description: 'Left shoulder, lower head, right shoulder recovery pattern.' },
  { kind: 'ascending-triangle', family: 'chart-setup', direction: 'bullish', label: 'Ascending Triangle', description: 'Flat resistance with rising lows.' },
  { kind: 'descending-triangle', family: 'chart-setup', direction: 'bearish', label: 'Descending Triangle', description: 'Flat support with falling highs.' },
  { kind: 'symmetrical-triangle', family: 'chart-setup', direction: 'neutral', label: 'Symmetrical Triangle', description: 'Lower highs and higher lows compress into an apex.' },
  { kind: 'rising-wedge', family: 'chart-setup', direction: 'bearish', label: 'Rising Wedge', description: 'Rising but narrowing structure, often exhaustion.' },
  { kind: 'falling-wedge', family: 'chart-setup', direction: 'bullish', label: 'Falling Wedge', description: 'Falling but narrowing structure, often accumulation.' },
  { kind: 'bull-flag', family: 'chart-setup', direction: 'bullish', label: 'Bull Flag', description: 'Impulse up, shallow pullback, continuation watch.' },
  { kind: 'bear-flag', family: 'chart-setup', direction: 'bearish', label: 'Bear Flag', description: 'Impulse down, shallow rebound, continuation watch.' },
  { kind: 'channel-up', family: 'chart-setup', direction: 'bullish', label: 'Channel Up', description: 'Parallel rising highs and lows.' },
  { kind: 'channel-down', family: 'chart-setup', direction: 'bearish', label: 'Channel Down', description: 'Parallel falling highs and lows.' },
  { kind: 'cup-and-handle', family: 'chart-setup', direction: 'bullish', label: 'Cup & Handle', description: 'Rounded base followed by a shallow handle.' },
  { kind: 'ma-golden-cross', family: 'chart-setup', direction: 'bullish', label: 'Golden Cross', description: 'Fast moving average crosses above slow moving average.' },
  { kind: 'ma-death-cross', family: 'chart-setup', direction: 'bearish', label: 'Death Cross', description: 'Fast moving average crosses below slow moving average.' },
  { kind: 'rsi-overbought', family: 'chart-setup', direction: 'bearish', label: 'RSI Overbought', description: 'Momentum is extended above the overbought band.' },
  { kind: 'rsi-oversold', family: 'chart-setup', direction: 'bullish', label: 'RSI Oversold', description: 'Momentum is extended below the oversold band.' },
  { kind: 'macd-bull-cross', family: 'chart-setup', direction: 'bullish', label: 'MACD Bull Cross', description: 'MACD line crosses above signal.' },
  { kind: 'macd-bear-cross', family: 'chart-setup', direction: 'bearish', label: 'MACD Bear Cross', description: 'MACD line crosses below signal.' },
  { kind: 'bollinger-squeeze', family: 'chart-setup', direction: 'neutral', label: 'Bollinger Squeeze', description: 'Volatility contracts into a tight band.' },
  { kind: 'bollinger-breakout', family: 'chart-setup', direction: 'bullish', label: 'Bollinger Breakout', description: 'Price closes outside a volatility band after compression.' },
  { kind: 'volume-climax', family: 'chart-setup', direction: 'neutral', label: 'Volume Climax', description: 'Volume spikes far above local baseline.' },
  { kind: 'atr-expansion', family: 'chart-setup', direction: 'neutral', label: 'ATR Expansion', description: 'True range expands sharply after quiet candles.' },
  { kind: 'vwap-reclaim', family: 'chart-setup', direction: 'bullish', label: 'VWAP Reclaim', description: 'Price closes back above VWAP after trading below.' },
  { kind: 'vwap-rejection', family: 'chart-setup', direction: 'bearish', label: 'VWAP Rejection', description: 'Price tests VWAP from below and fails.' },
];

const FAMILY_COLOR: Record<CandlePatternFamily, string> = {
  candlestick: '#facc15',
  'vision-candle': '#38bdf8',
  'chart-setup': '#a78bfa',
};

function directionalColor(direction: CandleDirection, family: CandlePatternFamily) {
  if (direction === 'bullish') return '#22c55e';
  if (direction === 'bearish') return '#ef4444';
  return FAMILY_COLOR[family];
}

function anchorsForSpan(candles: CandleInput[], startIndex: number, endIndex: number, direction: CandleDirection): CandlePatternAnchor[] {
  const span = candles.slice(startIndex, endIndex + 1);
  const highOffset = span.reduce((best, bar, index) => (bar.high > span[best].high ? index : best), 0);
  const lowOffset = span.reduce((best, bar, index) => (bar.low < span[best].low ? index : best), 0);
  const start = candles[startIndex];
  const end = candles[endIndex];
  const high = candles[startIndex + highOffset];
  const low = candles[startIndex + lowOffset];
  const confirmationPrice = direction === 'bearish' ? low.low : direction === 'bullish' ? high.high : end.close;
  return [
    { index: startIndex, time: start.time, price: start.open, role: 'start' },
    { index: startIndex + highOffset, time: high.time, price: high.high, role: 'high' },
    { index: startIndex + lowOffset, time: low.time, price: low.low, role: 'low' },
    { index: endIndex, time: end.time, price: confirmationPrice, role: 'confirmation' },
  ];
}

function spanLengthFor(entry: CandlePatternCatalogEntry) {
  if (entry.family === 'candlestick') {
    if (entry.kind.startsWith('three-') || entry.kind === 'morning-star' || entry.kind === 'evening-star') return 3;
    if (entry.kind === 'engulfing' || entry.kind === 'harami' || entry.kind === 'piercing-line' || entry.kind === 'dark-cloud-cover') return 2;
    return 1;
  }
  if (entry.family === 'vision-candle') return entry.kind === 'vision-compression' ? 7 : 5;
  if (entry.kind.includes('triangle') || entry.kind.includes('wedge') || entry.kind.includes('channel') || entry.kind.includes('head') || entry.kind === 'cup-and-handle') return 18;
  if (entry.kind.includes('cross') || entry.kind.startsWith('macd') || entry.kind.startsWith('bollinger')) return 10;
  return 8;
}

export function createPatternShowcaseEvents(candles: CandleInput[], catalog = CANDLE_VISION_PATTERN_CATALOG): CandlePatternEvent[] {
  if (!candles.length) return [];
  const usable = Math.max(1, candles.length - 8);
  const spacing = Math.max(1, Math.floor(usable / Math.max(1, catalog.length)));

  return catalog.map((entry, i) => {
    const length = spanLengthFor(entry);
    const startIndex = Math.min(Math.max(0, 2 + i * spacing), Math.max(0, candles.length - length - 1));
    const endIndex = Math.min(candles.length - 1, startIndex + length - 1);
    const confidence = entry.family === 'candlestick' ? 0.98 : entry.family === 'vision-candle' ? 0.94 : 0.91;

    return {
      id: `catalog:${entry.kind}:${startIndex}:${endIndex}`,
      kind: entry.kind,
      family: entry.family,
      status: entry.kind === 'vision-compression' || entry.kind.includes('squeeze') ? 'forming' : 'confirmed',
      direction: entry.direction,
      startIndex,
      endIndex,
      detectedAt: candles[endIndex]?.time ?? Date.now(),
      confidence,
      strength: confidence,
      label: entry.label,
      description: entry.description,
      source: 'candle-vision',
      anchors: anchorsForSpan(candles, startIndex, endIndex, entry.direction),
      color: directionalColor(entry.direction, entry.family),
      scoreBreakdown: { catalogMatch: confidence },
    };
  });
}
