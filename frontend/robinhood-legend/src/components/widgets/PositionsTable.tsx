'use client';
import { useMemo, useState } from 'react';

// ============================================================================
// PositionsTable
//
// Source intel: chunk 506 / module 85375 = positionsColumns dictionary.
// Each column has preferredName (long) + shortenedName (compact). Robinhood's
// real table is column-configurable; this is the default mix from the
// screenshot (Symbol/Qty/Mkt val/Mark/Avg price/Last/1D open P&L/1D open P&L %/
// Open P&L/Open P&L %).
//
// Motion vocabulary: same as OrderBook —
//   EASE_QUINT = cubic-bezier(.22, 1, .36, 1)
//   EASE_CIRC  = cubic-bezier(0, .55, .45, 1)
// ============================================================================

const EASE_QUINT = 'cubic-bezier(.22, 1, .36, 1)';

const COLORS = {
  positive: '#00d20c',
  negative: '#ff5000',
  textPrimary: '#f4f4f5',
  textSecondary: '#85858b',
  border: '#29292b',
  rowHover: 'rgba(255,255,255,0.03)',
  rowAltBg: '#0e0e10',
  headerBg: 'transparent',
};

export type Position = {
  symbol: string;
  icon?: string;
  qty: number | string;
  mktVal: number;
  mark: number;
  avgPrice: number;
  last: number;
  // 1-day open P&L
  dayPnl: number;
  dayPnlPct: number;
  // Open P&L (since inception)
  openPnl: number;
  openPnlPct: number;
};

type ColumnKey =
  | 'symbol' | 'qty' | 'mktVal' | 'mark' | 'avgPrice' | 'last'
  | 'dayPnl' | 'dayPnlPct' | 'openPnl' | 'openPnlPct';

type ColumnDef = {
  key: ColumnKey;
  // From the bundle's i18n catalogue (chunk 506 / module 85375):
  preferredName: string;
  shortenedName: string;
  align: 'left' | 'right';
  format: (p: Position) => React.ReactNode;
};

const fmtMoney = (n: number) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPrice = (n: number) => '$' + n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
const fmtPct = (n: number) => (Math.abs(n)).toFixed(2) + '%';

const PnlCell = ({ value, format }: { value: number; format: (n: number) => string }) => {
  const up = value >= 0;
  return (
    <span style={{ color: up ? COLORS.positive : COLORS.negative, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
      <span style={{ fontSize: 9, marginRight: 4 }}>{up ? '▲' : '▼'}</span>
      {format(value)}
    </span>
  );
};

const COLUMNS: ColumnDef[] = [
  {
    key: 'symbol', preferredName: 'Symbol', shortenedName: 'Symbol', align: 'left',
    format: (p) => (
      <span style={{ color: COLORS.textPrimary, fontWeight: 700, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
        {p.symbol}
        {p.icon ? <span style={{ color: COLORS.textSecondary, fontSize: 12 }}>{p.icon}</span> : null}
      </span>
    ),
  },
  { key: 'qty',      preferredName: 'Quantity',          shortenedName: 'Qty',          align: 'right', format: (p) => <span style={{ color: COLORS.textPrimary }}>{typeof p.qty === 'number' ? p.qty.toLocaleString('en-US', { maximumFractionDigits: 6 }) : p.qty}</span> },
  { key: 'mktVal',   preferredName: 'Market value',      shortenedName: 'Mkt val',      align: 'right', format: (p) => <span style={{ color: COLORS.textPrimary }}>{fmtMoney(p.mktVal)}</span> },
  { key: 'mark',     preferredName: 'Mark',              shortenedName: 'Mark',         align: 'right', format: (p) => <span style={{ color: COLORS.textPrimary }}>{fmtMoney(p.mark)}</span> },
  { key: 'avgPrice', preferredName: 'Average price',     shortenedName: 'Avg pr…',      align: 'right', format: (p) => <span style={{ color: COLORS.textPrimary }}>{fmtMoney(p.avgPrice)}</span> },
  { key: 'last',     preferredName: 'Last',              shortenedName: 'Last',         align: 'right', format: (p) => <span style={{ color: COLORS.textPrimary }}>{fmtPrice(p.last)}</span> },
  { key: 'dayPnl',     preferredName: "1D open P&L",   shortenedName: '1D open P&L',   align: 'right', format: (p) => <PnlCell value={p.dayPnl} format={fmtMoney} /> },
  { key: 'dayPnlPct',  preferredName: "1D open P&L %", shortenedName: '1D open P&L %', align: 'right', format: (p) => <PnlCell value={p.dayPnlPct} format={fmtPct} /> },
  { key: 'openPnl',    preferredName: 'Open P&L',      shortenedName: 'Open P&L',      align: 'right', format: (p) => <PnlCell value={p.openPnl} format={fmtMoney} /> },
  { key: 'openPnlPct', preferredName: 'Open P&L %',    shortenedName: 'Open P&L %',    align: 'right', format: (p) => <PnlCell value={p.openPnlPct} format={fmtPct} /> },
];

export type PositionsTableProps = {
  positions?: Position[];
  title?: string;
};

const DEFAULT_POSITIONS: Position[] = [
  { symbol: 'STRC 6/18 $100 Call', qty: 5,         mktVal: 65.00, mark: 0.13, avgPrice: 0.20, last: 0.1000, dayPnl: 15.00,  dayPnlPct: 30.00, openPnl: -35.00, openPnlPct: -35.00 },
  { symbol: 'STRC 6/18 $105 Call', qty: 4,         mktVal:  4.00, mark: 0.01, avgPrice: 0.05, last: 0.0300, dayPnl:  0.00,  dayPnlPct:  0.00, openPnl: -16.00, openPnlPct: -80.00 },
  { symbol: 'USDC',                icon: '⊙',      qty: 0.004778, mktVal:  0.00, mark: 1.00, avgPrice: 1.00, last: 1.0000, dayPnl:  0.00,  dayPnlPct: -0.01, openPnl:   0.00, openPnlPct: -0.01 },
];

export function PositionsTable({ positions = DEFAULT_POSITIONS, title = 'Positions' }: PositionsTableProps) {
  const [sortKey, setSortKey] = useState<ColumnKey>('symbol');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [hoverRowIdx, setHoverRowIdx] = useState<number | null>(null);

  const sorted = useMemo(() => {
    const list = [...positions];
    list.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      const as = String(av);
      const bs = String(bv);
      return sortDir === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as);
    });
    return list;
  }, [positions, sortKey, sortDir]);

  const toggleSort = (key: ColumnKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  return (
    <div
      data-testid="positions-table"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        fontFamily: 'var(--bw-ds--font-family, ui-sans-serif, system-ui)',
        fontVariantNumeric: 'tabular-nums',
        color: COLORS.textPrimary,
        background: 'transparent',
      }}
    >
      {/* Header strip */}
      <div style={{ padding: '12px 16px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 16, fontWeight: 700 }}>{title}</span>
        <PositionsFilterButton />
      </div>

      {/* Column header row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `minmax(180px, 1.6fr) ${'repeat(' + (COLUMNS.length - 1) + ', minmax(72px, 1fr))'}`,
          alignItems: 'center',
          padding: '8px 16px',
          borderBottom: `1px solid ${COLORS.border}`,
          fontSize: 12,
          color: COLORS.textSecondary,
        }}
      >
        {COLUMNS.map((col) => (
          <HeaderCell
            key={col.key}
            label={col.shortenedName}
            sorted={sortKey === col.key ? sortDir : null}
            align={col.align}
            onClick={() => toggleSort(col.key)}
          />
        ))}
      </div>

      {/* Body rows */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {sorted.map((p, i) => (
          <div
            key={p.symbol}
            onMouseEnter={() => setHoverRowIdx(i)}
            onMouseLeave={() => setHoverRowIdx(null)}
            style={{
              display: 'grid',
              gridTemplateColumns: `minmax(180px, 1.6fr) ${'repeat(' + (COLUMNS.length - 1) + ', minmax(72px, 1fr))'}`,
              alignItems: 'center',
              padding: '10px 16px',
              borderBottom: `1px solid ${COLORS.border}`,
              background: hoverRowIdx === i ? COLORS.rowHover : (i % 2 === 1 ? COLORS.rowAltBg : 'transparent'),
              transition: `background 100ms ${EASE_QUINT}`,
              fontSize: 13,
            }}
          >
            {COLUMNS.map((col) => (
              <div key={col.key} style={{ textAlign: col.align, paddingRight: col.align === 'right' ? 8 : 0 }}>
                {col.format(p)}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function HeaderCell({ label, sorted, align, onClick }: { label: string; sorted: 'asc' | 'desc' | null; align: 'left' | 'right'; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: 'transparent',
        border: 'none',
        color: hovered || sorted ? COLORS.textPrimary : COLORS.textSecondary,
        fontSize: 12,
        cursor: 'pointer',
        textAlign: align,
        padding: 0,
        fontWeight: sorted ? 700 : 400,
        display: 'flex',
        alignItems: 'center',
        justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
        gap: 4,
        transition: `color 100ms ${EASE_QUINT}`,
        whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
        paddingRight: align === 'right' ? 8 : 0,
      }}
    >
      {label}
      {sorted ? <span style={{ fontSize: 10 }}>{sorted === 'asc' ? '↑' : '↓'}</span> : null}
    </button>
  );
}

function PositionsFilterButton() {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label="Open filter menu"
      style={{
        background: hovered ? '#2a2a2e' : '#1f1f22',
        border: 'none',
        color: COLORS.textSecondary,
        width: 28, height: 28,
        borderRadius: 6,
        cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: `background 100ms ${EASE_QUINT}`,
      }}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M5 8h6M7 12h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
    </button>
  );
}
