'use client';

import type { PatternScannerStats } from './types';

type PatternStatsProps = {
  stats: PatternScannerStats;
  colors?: {
    supported?: string;
    detected?: string;
    visible?: string;
    watchlist?: string;
  };
};

export function PatternStats({ stats, colors = {} }: PatternStatsProps) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
      <Metric label="Supported" value={stats.supported} color={colors.supported ?? '#e5e7eb'} />
      <Metric label="Detected" value={stats.detectedRaw} color={colors.detected ?? '#facc15'} />
      <Metric label="Visible" value={stats.visible} color={colors.visible ?? '#38bdf8'} />
      <Metric label="Watchlist" value={stats.watchlist} color={colors.watchlist ?? '#a78bfa'} />
    </div>
  );
}

function Metric({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div
      data-pattern-motion
      style={{
        minWidth: 0,
        padding: '9px 10px',
        border: '1px solid rgba(148, 163, 184, .16)',
        borderRadius: 7,
        background: 'rgba(15,23,42,.48)',
      }}
    >
      <div style={{ color: '#8b94a7', fontSize: 9, textTransform: 'uppercase', letterSpacing: '.08em', whiteSpace: 'nowrap' }}>{label}</div>
      <div style={{ color, fontSize: 20, fontWeight: 800, lineHeight: 1.05, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}
