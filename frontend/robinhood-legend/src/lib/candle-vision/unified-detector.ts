import { normalizeCandles } from './features';
import { detectCandlePatterns } from './detectors';
import {
  detectMultiCandlePatternMatches,
  detectSingleCandleTaPatterns,
  detectTwoCandlePatternCandidatesFromFeatures,
} from './patterns/candles';
import { detectStructurePatterns } from './patterns/structures';
import { detectTaPatterns } from './patterns/ta';
import type {
  CandleDirection,
  CandleFeature,
  CandleInput,
  CandlePatternAnchor,
  CandlePatternDetectorOptions,
  CandlePatternEvent,
  CandlePatternKind,
} from './types';

const COLORS: Record<CandleDirection | 'ta' | 'setup', string> = {
  bullish: '#22c55e',
  bearish: '#ef4444',
  neutral: '#facc15',
  ta: '#fb923c',
  setup: '#a78bfa',
};

export type UnifiedCandlePatternOptions = CandlePatternDetectorOptions & {
  enableExpandedCandles?: boolean;
  enableStructures?: boolean;
  maxStructureEvents?: number;
};

function makeId(kind: string, startIndex: number, endIndex: number, prefix = 'expanded') {
  return `${prefix}:${kind}:${startIndex}:${endIndex}`;
}

function anchorsForRange(features: CandleFeature[], startIndex: number, endIndex: number, direction: CandleDirection): CandlePatternAnchor[] {
  const start = features[startIndex];
  const end = features[endIndex];
  const slice = features.slice(startIndex, endIndex + 1);
  const high = slice.reduce((best, bar) => (bar.high > best.high ? bar : best), slice[0]);
  const low = slice.reduce((best, bar) => (bar.low < best.low ? bar : best), slice[0]);
  const confirmationPrice = direction === 'bearish' ? end.low : direction === 'bullish' ? end.high : end.close;

  return [
    { index: start.index, time: start.time, price: start.open, role: 'start' },
    { index: high.index, time: high.time, price: high.high, role: 'high' },
    { index: low.index, time: low.time, price: low.low, role: 'low' },
    { index: end.index, time: end.time, price: confirmationPrice, role: 'confirmation' },
  ];
}

function singleMatchToEvent(feature: CandleFeature, match: ReturnType<typeof detectSingleCandleTaPatterns>[number]): CandlePatternEvent {
  return {
    id: makeId(match.kind, feature.index, feature.index, 'single'),
    kind: match.kind as CandlePatternKind,
    family: 'candlestick',
    status: 'confirmed',
    direction: match.direction,
    startIndex: feature.index,
    endIndex: feature.index,
    detectedAt: feature.time,
    confidence: match.confidence,
    strength: match.strength,
    label: match.label,
    description: match.description,
    source: 'candle-vision',
    anchors: anchorsForRange([feature], 0, 0, match.direction).map((anchor) => ({ ...anchor, index: feature.index })),
    color: COLORS[match.direction],
    scoreBreakdown: match.scoreBreakdown,
  };
}

function multiMatchToEvent(features: CandleFeature[], match: ReturnType<typeof detectMultiCandlePatternMatches>[number]): CandlePatternEvent {
  return {
    id: makeId(match.kind, match.startIndex, match.endIndex, 'multi'),
    kind: match.kind as CandlePatternKind,
    family: 'candlestick',
    status: 'confirmed',
    direction: match.direction,
    startIndex: match.startIndex,
    endIndex: match.endIndex,
    detectedAt: features[match.endIndex]?.time ?? Date.now(),
    confidence: match.confidence,
    strength: match.strength,
    label: match.label,
    description: match.description,
    source: 'candle-vision',
    anchors: anchorsForRange(features, match.startIndex, match.endIndex, match.direction),
    color: COLORS[match.direction],
    scoreBreakdown: match.scoreBreakdown,
  };
}

function shiftEvent(event: CandlePatternEvent, offset: number, allCandles: CandleInput[]) {
  if (offset === 0) return event;
  const startIndex = event.startIndex + offset;
  const endIndex = event.endIndex + offset;
  return {
    ...event,
    id: makeId(event.kind, startIndex, endIndex, event.id.split(':')[0] || 'expanded'),
    startIndex,
    endIndex,
    detectedAt: allCandles[endIndex]?.time ?? event.detectedAt,
    anchors: event.anchors.map((anchor) => {
      const index = anchor.index + offset;
      return {
        ...anchor,
        index,
        time: allCandles[index]?.time ?? anchor.time,
      };
    }),
  };
}

function dedupeEvents(events: CandlePatternEvent[]) {
  const sorted = events
    .slice()
    .sort((a, b) => b.confidence - a.confidence || (b.endIndex - b.startIndex) - (a.endIndex - a.startIndex));
  const selected: CandlePatternEvent[] = [];
  const seen = new Set<string>();

  for (const event of sorted) {
    const key = `${event.kind}:${event.startIndex}:${event.endIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(event);
  }

  return selected.sort((a, b) => a.endIndex - b.endIndex || a.startIndex - b.startIndex);
}

export function detectExpandedCandlePatterns(candles: CandleInput[], options: CandlePatternDetectorOptions = {}) {
  const sourceCandles = options.lookback && options.lookback > 0 ? candles.slice(-options.lookback) : candles;
  const offset = candles.length - sourceCandles.length;
  const features = normalizeCandles(sourceCandles, options.contextPeriod, options.trendPeriod);
  const minConfidence = options.minConfidence ?? 0.58;
  const events: CandlePatternEvent[] = [];

  for (let index = 0; index < features.length; index += 1) {
    const feature = features[index];
    for (const match of detectSingleCandleTaPatterns(feature, options)) {
      if (match.confidence >= minConfidence || options.includeWeak) events.push(singleMatchToEvent(feature, match));
    }
    for (const candidate of detectTwoCandlePatternCandidatesFromFeatures(features, index)) {
      if (candidate.confidence >= minConfidence || options.includeWeak) {
        events.push({
          ...candidate,
          id: makeId(candidate.kind, candidate.startIndex, candidate.endIndex, 'two'),
          kind: candidate.kind as CandlePatternKind,
          detectedAt: features[candidate.endIndex]?.time ?? Date.now(),
          source: 'candle-vision',
          color: COLORS[candidate.direction],
        });
      }
    }
    for (const match of detectMultiCandlePatternMatches(features, index)) {
      if (match.confidence >= minConfidence || options.includeWeak) events.push(multiMatchToEvent(features, match));
    }
  }

  return dedupeEvents(events).map((event) => shiftEvent(event, offset, candles));
}

export function detectUnifiedCandlePatterns(candles: CandleInput[], options: UnifiedCandlePatternOptions = {}) {
  const {
    enableExpandedCandles = true,
    enableStructures = true,
    enableTaPatterns = true,
    maxStructureEvents = 10,
    ...baseOptions
  } = options;

  const classic = detectCandlePatterns(candles, baseOptions);
  const expanded = enableExpandedCandles ? detectExpandedCandlePatterns(candles, baseOptions) : [];
  const structures = enableStructures ? detectStructurePatterns(candles, { ...baseOptions, maxEventsPerKind: 2 }).slice(-maxStructureEvents) : [];
  const ta = enableTaPatterns ? detectTaPatterns(candles, baseOptions).slice(-maxStructureEvents) : [];

  return dedupeEvents([...classic, ...expanded, ...structures, ...ta]);
}
