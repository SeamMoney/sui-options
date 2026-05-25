import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  detectUnifiedCandlePatterns,
  rankPatternSignals,
  type CandleInput,
  type CandlePatternDetectorOptions,
  type CandlePatternEvent,
  type CandlePatternFamily,
  type CandlePatternStatus,
  type PatternSignalRankingOptions,
  type PatternSignalRankingResult,
  type RankedPatternSignal,
} from '@sui-options/candle-vision';

export type CandleVisionScannerOptions = CandlePatternDetectorOptions & {
  ranking?: PatternSignalRankingOptions;
};

export type CandleVisionStats = {
  total: number;
  visible: number;
  supported: number;
  unsupported: number;
  bullish: number;
  bearish: number;
  neutral: number;
  byFamily: Record<CandlePatternFamily, number>;
  byStatus: Record<CandlePatternStatus, number>;
  averageConfidence: number;
  averageStrength: number;
};

export type CandleVisionScannerResult = {
  candles: CandleInput[];
  events: CandlePatternEvent[];
  ranking: PatternSignalRankingResult;
  visibleSignals: RankedPatternSignal[];
  visibleEvents: CandlePatternEvent[];
  latestEvent?: CandlePatternEvent;
  stats: CandleVisionStats;
};

export type PatternStreamOptions = CandleVisionScannerOptions & {
  initialCandles?: CandleInput[];
  maxCandles?: number;
};

export type PatternStreamResult = CandleVisionScannerResult & {
  appendCandle: (candle: CandleInput) => void;
  appendCandles: (candles: CandleInput[]) => void;
  replaceCandles: (candles: CandleInput[]) => void;
  clearCandles: () => void;
};

export type PatternStatsPanelProps = {
  stats?: CandleVisionStats;
  events?: CandlePatternEvent[];
  ranking?: PatternSignalRankingResult;
  title?: ReactNode;
  className?: string;
  style?: CSSProperties;
  formatPercent?: (value: number) => ReactNode;
};

export type SignalListProps = {
  signals?: RankedPatternSignal[];
  events?: CandlePatternEvent[];
  emptyState?: ReactNode;
  className?: string;
  style?: CSSProperties;
  maxItems?: number;
  showDescription?: boolean;
  renderMeta?: (signal: RankedPatternSignal) => ReactNode;
};

const EMPTY_FAMILY_COUNTS: Record<CandlePatternFamily, number> = {
  candlestick: 0,
  'vision-candle': 0,
  'chart-setup': 0,
};

const EMPTY_STATUS_COUNTS: Record<CandlePatternStatus, number> = {
  forming: 0,
  confirmed: 0,
  invalidated: 0,
  expired: 0,
};

const EMPTY_CANDLES: CandleInput[] = [];

const PANEL_STYLE: CSSProperties = {
  display: 'grid',
  gap: 12,
  color: '#e5e7eb',
  background: '#111827',
  border: '1px solid rgba(148, 163, 184, 0.22)',
  borderRadius: 8,
  padding: 14,
};

const GRID_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(104px, 1fr))',
  gap: 8,
};

const STAT_STYLE: CSSProperties = {
  display: 'grid',
  gap: 4,
  minWidth: 0,
  border: '1px solid rgba(148, 163, 184, 0.16)',
  borderRadius: 6,
  padding: '8px 10px',
  background: 'rgba(15, 23, 42, 0.72)',
};

const LIST_STYLE: CSSProperties = {
  display: 'grid',
  gap: 8,
  listStyle: 'none',
  margin: 0,
  padding: 0,
};

const SIGNAL_STYLE: CSSProperties = {
  display: 'grid',
  gap: 6,
  minWidth: 0,
  border: '1px solid rgba(148, 163, 184, 0.16)',
  borderRadius: 8,
  padding: 10,
  background: '#0f172a',
};

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 100)));
}

function defaultFormatPercent(value: number) {
  return `${clampPercent(value)}%`;
}

function computeStats(events: CandlePatternEvent[], ranking: PatternSignalRankingResult): CandleVisionStats {
  const byFamily = { ...EMPTY_FAMILY_COUNTS };
  const byStatus = { ...EMPTY_STATUS_COUNTS };
  let bullish = 0;
  let bearish = 0;
  let neutral = 0;
  let confidenceTotal = 0;
  let strengthTotal = 0;

  for (const event of events) {
    byFamily[event.family] += 1;
    byStatus[event.status] += 1;
    confidenceTotal += event.confidence;
    strengthTotal += event.strength;

    if (event.direction === 'bullish') bullish += 1;
    else if (event.direction === 'bearish') bearish += 1;
    else neutral += 1;
  }

  return {
    total: events.length,
    visible: ranking.visible.length,
    supported: ranking.supported.length,
    unsupported: ranking.unsupported.length,
    bullish,
    bearish,
    neutral,
    byFamily,
    byStatus,
    averageConfidence: events.length ? confidenceTotal / events.length : 0,
    averageStrength: events.length ? strengthTotal / events.length : 0,
  };
}

function scanCandles(candles: CandleInput[], options: CandleVisionScannerOptions = {}): CandleVisionScannerResult {
  const { ranking: rankingOptions, ...detectorOptions } = options;
  const events = detectUnifiedCandlePatterns(candles, detectorOptions);
  const latestIndex = candles.length > 0 ? candles.length - 1 : undefined;
  const ranking = rankPatternSignals(events, {
    latestIndex,
    ...rankingOptions,
  });

  return {
    candles,
    events,
    ranking,
    visibleSignals: ranking.visible,
    visibleEvents: ranking.visible.map((signal) => signal.event),
    latestEvent: events.at(-1),
    stats: computeStats(events, ranking),
  };
}

export function useCandleVisionScanner(
  candles: CandleInput[],
  options: CandleVisionScannerOptions = {},
): CandleVisionScannerResult {
  return useMemo(() => scanCandles(candles, options), [candles, options]);
}

export function usePatternStream(options: PatternStreamOptions = {}): PatternStreamResult {
  const { initialCandles = EMPTY_CANDLES, maxCandles, ...scannerOptions } = options;
  const [candles, setCandles] = useState<CandleInput[]>(() => trimCandles(initialCandles, maxCandles));

  useEffect(() => {
    setCandles(trimCandles(initialCandles, maxCandles));
  }, [initialCandles, maxCandles]);

  const appendCandle = useCallback((candle: CandleInput) => {
    setCandles((current) => trimCandles([...current, candle], maxCandles));
  }, [maxCandles]);

  const appendCandles = useCallback((nextCandles: CandleInput[]) => {
    setCandles((current) => trimCandles([...current, ...nextCandles], maxCandles));
  }, [maxCandles]);

  const replaceCandles = useCallback((nextCandles: CandleInput[]) => {
    setCandles(trimCandles(nextCandles, maxCandles));
  }, [maxCandles]);

  const clearCandles = useCallback(() => {
    setCandles([]);
  }, []);

  const scanner = useCandleVisionScanner(candles, scannerOptions);

  return {
    ...scanner,
    appendCandle,
    appendCandles,
    replaceCandles,
    clearCandles,
  };
}

function trimCandles(candles: CandleInput[], maxCandles?: number) {
  if (!maxCandles || candles.length <= maxCandles) return candles;
  return candles.slice(-maxCandles);
}

export function PatternStatsPanel({
  stats,
  events,
  ranking,
  title = 'Pattern Stats',
  className,
  style,
  formatPercent = defaultFormatPercent,
}: PatternStatsPanelProps) {
  const resolvedRanking = useMemo(
    () => ranking ?? rankPatternSignals(events ?? []),
    [events, ranking],
  );
  const resolvedStats = useMemo(
    () => stats ?? computeStats(events ?? [], resolvedRanking),
    [events, resolvedRanking, stats],
  );

  const statsItems = [
    ['Total', resolvedStats.total],
    ['Visible', resolvedStats.visible],
    ['Bullish', resolvedStats.bullish],
    ['Bearish', resolvedStats.bearish],
    ['Avg Confidence', formatPercent(resolvedStats.averageConfidence)],
    ['Avg Strength', formatPercent(resolvedStats.averageStrength)],
  ] as const;

  return (
    <section className={className} style={{ ...PANEL_STYLE, ...style }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: 14, lineHeight: 1.25, fontWeight: 700 }}>{title}</h3>
        <span style={{ color: '#94a3b8', fontSize: 12 }}>
          {resolvedStats.supported} supported
        </span>
      </div>
      <div style={GRID_STYLE}>
        {statsItems.map(([label, value]) => (
          <div key={label} style={STAT_STYLE}>
            <span style={{ color: '#94a3b8', fontSize: 11 }}>{label}</span>
            <strong style={{ overflowWrap: 'anywhere', fontSize: 18, lineHeight: 1.1 }}>{value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

export function SignalList({
  signals,
  events,
  emptyState = 'No pattern signals',
  className,
  style,
  maxItems,
  showDescription = true,
  renderMeta,
}: SignalListProps) {
  const resolvedSignals = useMemo(
    () => signals ?? rankPatternSignals(events ?? []).visible,
    [events, signals],
  );
  const visibleSignals = typeof maxItems === 'number' ? resolvedSignals.slice(0, maxItems) : resolvedSignals;

  if (!visibleSignals.length) {
    return (
      <div className={className} style={{ color: '#94a3b8', fontSize: 13, ...style }}>
        {emptyState}
      </div>
    );
  }

  return (
    <ol className={className} style={{ ...LIST_STYLE, ...style }}>
      {visibleSignals.map((signal) => (
        <li key={signal.event.id} style={{ ...SIGNAL_STYLE, borderLeft: `3px solid ${signal.event.color}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
            <div style={{ display: 'grid', gap: 3, minWidth: 0 }}>
              <strong style={{ color: '#f8fafc', fontSize: 14, lineHeight: 1.25 }}>
                {signal.event.label}
              </strong>
              <span style={{ color: '#94a3b8', fontSize: 12, textTransform: 'capitalize' }}>
                {signal.event.direction} - {signal.category ?? signal.event.family}
              </span>
            </div>
            <span style={{ color: signal.event.color, fontSize: 12, fontWeight: 700 }}>
              {defaultFormatPercent(signal.visibleScore)}
            </span>
          </div>
          {showDescription ? (
            <p style={{ margin: 0, color: '#cbd5e1', fontSize: 12, lineHeight: 1.45 }}>
              {signal.event.description}
            </p>
          ) : null}
          {renderMeta ? (
            <div style={{ color: '#94a3b8', fontSize: 12 }}>
              {renderMeta(signal)}
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export type {
  CandleInput,
  CandlePatternDetectorOptions,
  CandlePatternEvent,
  PatternSignalRankingOptions,
  PatternSignalRankingResult,
  RankedPatternSignal,
};
