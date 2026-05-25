import {
  detectUnifiedCandlePatterns,
  rankPatternSignals,
  type CandleInput,
} from '@sui-options/candle-vision';

const candles: CandleInput[] = [
  { time: 1, open: 100, high: 102, low: 96, close: 97, volume: 1200 },
  { time: 2, open: 97, high: 98, low: 94, close: 95, volume: 1280 },
  { time: 3, open: 95, high: 96, low: 92, close: 93, volume: 1325 },
  { time: 4, open: 92, high: 93, low: 88, close: 89, volume: 1500 },
  { time: 5, open: 89, high: 91, low: 86, close: 90, volume: 1720 },
  { time: 6, open: 90, high: 99, low: 89, close: 98, volume: 2600 },
  { time: 7, open: 98, high: 103, low: 97, close: 102, volume: 2450 },
  { time: 8, open: 102, high: 106, low: 101, close: 105, volume: 2300 },
];

const events = detectUnifiedCandlePatterns(candles, {
  lookback: 120,
  minConfidence: 0.58,
  enableClassicPatterns: true,
  enableVisionPatterns: true,
});

const ranking = rankPatternSignals(events, {
  latestIndex: candles.length - 1,
  maxVisible: 6,
  allowOverlaps: false,
});

console.log('Visible pattern signals');

for (const signal of ranking.visible) {
  const { event } = signal;
  const confirmation = event.anchors.find((anchor) => anchor.role === 'confirmation');

  console.log([
    `#${signal.visibleRank}`,
    event.label,
    event.direction,
    `confidence=${event.confidence.toFixed(2)}`,
    `candles=${event.startIndex}-${event.endIndex}`,
    confirmation ? `confirmation=${confirmation.price}` : undefined,
  ].filter(Boolean).join(' | '));
}

console.log(`Detected ${events.length} events; ${ranking.visible.length} selected for display.`);
