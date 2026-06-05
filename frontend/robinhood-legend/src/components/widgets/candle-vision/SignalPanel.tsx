'use client';

import { useMemo, useRef } from 'react';
import { PatternStats } from './PatternStats';
import { PatternToolbar } from './PatternToolbar';
import { usePatternPanelAnimation } from './usePatternAnimations';
import type { PatternFamilyFilter, PatternScannerStats, SignalPanelEvent } from './types';

type SignalPanelProps = {
  stats: PatternScannerStats;
  events: SignalPanelEvent[];
  activeFamily: PatternFamilyFilter;
  onFamilyChange: (family: PatternFamilyFilter) => void;
  showAll: boolean;
  onShowAllChange: (showAll: boolean) => void;
  onReplay?: () => void;
  maxEvents?: number;
};

export function SignalPanel({
  stats,
  events,
  activeFamily,
  onFamilyChange,
  showAll,
  onShowAllChange,
  onReplay,
  maxEvents = 8,
}: SignalPanelProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const filtered = useMemo(() => {
    const familyFiltered = activeFamily === 'all' ? events : events.filter((event) => event.family === activeFamily);
    return familyFiltered.slice(-maxEvents).reverse();
  }, [activeFamily, events, maxEvents]);

  usePatternPanelAnimation(rootRef, [activeFamily, showAll, filtered.length]);

  return (
    <div
      ref={rootRef}
      style={{
        width: 330,
        padding: 14,
        border: '1px solid rgba(148, 163, 184, .16)',
        borderRadius: 8,
        background: 'linear-gradient(180deg, rgba(16,22,34,.94), rgba(16,22,34,.78))',
        boxShadow: '0 20px 60px rgba(0,0,0,.34)',
        backdropFilter: 'blur(18px)',
      }}
    >
      <PatternStats stats={stats} />
      <div style={{ height: 12 }} />
      <PatternToolbar
        activeFamily={activeFamily}
        onFamilyChange={onFamilyChange}
        showAll={showAll}
        onShowAllChange={onShowAllChange}
        onReplay={onReplay}
      />
      <div style={{ marginTop: 14, color: '#8b94a7', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.08em' }}>ranked signals</div>
      <div style={{ display: 'grid', gap: 7, marginTop: 8 }}>
        {filtered.map((event) => (
          <SignalRow key={event.id} event={event} />
        ))}
        {!filtered.length ? (
          <div data-pattern-motion style={{ color: '#8b94a7', fontSize: 12, lineHeight: 1.45, padding: '8px 0' }}>
            No high-confidence signals in this filter.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SignalRow({ event }: { event: SignalPanelEvent }) {
  return (
    <div
      data-pattern-motion
      style={{
        display: 'grid',
        gridTemplateColumns: '10px 1fr auto',
        alignItems: 'center',
        gap: 8,
        padding: '5px 0',
        opacity: event.visible === false ? 0.62 : 1,
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 999, background: event.color, boxShadow: `0 0 14px ${event.color}` }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ color: '#e5e7eb', fontSize: 12, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {event.label}
        </div>
        <div style={{ color: '#8b94a7', fontSize: 10 }}>{labelForFamily(event.family)}</div>
      </div>
      <div style={{ color: event.color, fontSize: 12, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{Math.round(event.confidence * 100)}%</div>
    </div>
  );
}

function labelForFamily(family: SignalPanelEvent['family']) {
  if (family === 'vision-candle') return 'computer vision mode';
  if (family === 'chart-setup') return 'chart / TA setup';
  return 'candlestick rule';
}
