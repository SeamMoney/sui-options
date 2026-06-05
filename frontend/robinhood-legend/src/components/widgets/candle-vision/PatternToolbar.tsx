'use client';

import type { PatternFamilyFilter } from './types';

type PatternToolbarProps = {
  activeFamily: PatternFamilyFilter;
  onFamilyChange: (family: PatternFamilyFilter) => void;
  showAll: boolean;
  onShowAllChange: (showAll: boolean) => void;
  onReplay?: () => void;
};

const FILTERS: Array<{ id: PatternFamilyFilter; label: string; color: string }> = [
  { id: 'all', label: 'All', color: '#e5e7eb' },
  { id: 'candlestick', label: 'Candles', color: '#facc15' },
  { id: 'vision-candle', label: 'Vision', color: '#38bdf8' },
  { id: 'chart-setup', label: 'Setups', color: '#a78bfa' },
];

export function PatternToolbar({ activeFamily, onFamilyChange, showAll, onShowAllChange, onReplay }: PatternToolbarProps) {
  return (
    <div data-pattern-motion style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {FILTERS.map((filter) => {
          const active = activeFamily === filter.id;
          return (
            <button
              key={filter.id}
              type="button"
              onClick={() => onFamilyChange(filter.id)}
              style={{
                height: 28,
                padding: '0 10px',
                borderRadius: 7,
                border: `1px solid ${active ? filter.color : 'rgba(148,163,184,.18)'}`,
                background: active ? `${filter.color}22` : 'rgba(15,23,42,.42)',
                color: active ? filter.color : '#cbd5e1',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              {filter.label}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: '#cbd5e1', fontSize: 11, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={showAll}
            onChange={(event) => onShowAllChange(event.currentTarget.checked)}
            style={{ accentColor: '#38bdf8' }}
          />
          Show all matches
        </label>
        <button
          type="button"
          onClick={onReplay}
          disabled={!onReplay}
          style={{
            height: 28,
            padding: '0 10px',
            borderRadius: 7,
            border: '1px solid rgba(56,189,248,.34)',
            background: 'rgba(56,189,248,.12)',
            color: '#7dd3fc',
            fontSize: 11,
            fontWeight: 800,
            cursor: onReplay ? 'pointer' : 'default',
            opacity: onReplay ? 1 : 0.5,
          }}
        >
          Replay
        </button>
      </div>
    </div>
  );
}
