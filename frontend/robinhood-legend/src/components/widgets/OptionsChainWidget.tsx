'use client';
import { useState, useMemo, useCallback } from 'react';

type Side = 'buy' | 'sell';
type Kind = 'call' | 'put';

type ChainRow = {
  strike: number;
  vol: number;
  oi: number;
  cop: number;
  delta: number;
  bid: number;
  ask: number;
};

// Deterministic mock chain — same input → same output. Avoids React hydration
// mismatches and lets the user see the same numbers across renders.
function hashRand(seed: number): number {
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}
function generateChain(symbol: string, spot: number, kind: Kind): ChainRow[] {
  const rows: ChainRow[] = [];
  // Hash symbol to a seed base
  const baseSeed = Array.from(symbol).reduce((a, c) => a + c.charCodeAt(0), 0);
  for (let i = -20; i <= 20; i++) {
    const strike = Math.round((spot + i * 2.5) * 100) / 100;
    const seed = baseSeed * 31 + i * 7 + (kind === 'put' ? 3 : 1);
    const r = hashRand(seed);
    const r2 = hashRand(seed + 17);

    // intrinsic + time value
    const moneyness = kind === 'call' ? spot - strike : strike - spot;
    const intrinsic = Math.max(0, moneyness);
    const tv = 4.5 * Math.exp(-Math.pow((strike - spot) / 14, 2));
    const ask = +(intrinsic + tv + 0.05).toFixed(2);
    const bid = +Math.max(0.01, ask - 0.06 - 0.05 * r).toFixed(2);

    // delta: smooth normal-like curve
    const k = (strike - spot) / 6;
    let delta = kind === 'call'
      ? 1 / (1 + Math.exp(k))
      : -1 / (1 + Math.exp(-k));
    delta = +delta.toFixed(3);

    // chance-of-profit: peaks ATM ~50%, tapers off
    const cop = +(Math.max(2, 50 * Math.exp(-Math.pow((strike - spot) / 12, 2)) + (r2 - 0.5) * 6)).toFixed(2);

    // Open interest: bell around ATM
    const oi = Math.round(800 + 12000 * Math.exp(-Math.pow((strike - spot) / 7, 2)) + r * 3500);
    const vol = Math.round(oi * (0.3 + r2 * 1.4));

    rows.push({ strike, vol, oi, cop, delta, bid, ask });
  }
  return rows.sort((a, b) => b.strike - a.strike);
}

const fmtCurrency = (n: number) =>
  '$' + (Number.isInteger(n) ? n.toFixed(0) : n.toFixed(2));

const fmtPct = (n: number) => n.toFixed(2) + '%';

const fmtCompact = (n: number) =>
  n >= 1_000_000 ? (n / 1_000_000).toFixed(2) + 'M'
  : n >= 1_000 ? (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K'
  : n.toLocaleString();

const cellBase: React.CSSProperties = {
  fontFamily: 'var(--bw-ds--font-family, system-ui)',
  fontSize: '0.8125rem',
  fontWeight: 400,
  letterSpacing: '-0.00625rem',
  lineHeight: 1.23,
  fontFeatureSettings: '"tnum"',
  whiteSpace: 'nowrap',
};

const SideOrKindToggle: React.FC<{
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  variant?: 'default' | 'compact';
}> = ({ options, value, onChange, variant = 'default' }) => (
  <div
    style={{
      display: 'inline-flex',
      background: 'var(--colors-neutral-bg2, rgba(255,255,255,.08))',
      borderRadius: 6,
      padding: 2,
      gap: 2,
    }}
  >
    {options.map((o) => {
      const active = o.value === value;
      return (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          style={{
            ...cellBase,
            fontWeight: active ? 700 : 500,
            padding: variant === 'compact' ? '4px 10px' : '6px 14px',
            border: 0,
            borderRadius: 4,
            cursor: 'pointer',
            background: active
              ? 'var(--colors-neutral-bg3, rgba(255,255,255,.16))'
              : 'transparent',
            color: 'var(--colors-neutral-fg1, #fff)',
            transition: 'background-color 120ms cubic-bezier(.05,.39,.42,.94)',
          }}
        >
          {o.label}
        </button>
      );
    })}
  </div>
);

const ExpirationPicker: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);
  const options = ['Exp May 15 (4D)', 'Exp May 22 (11D)', 'Exp May 29 (18D)', 'Exp Jun 5 (25D)', 'Exp Jun 19 (39D)', 'Exp Jul 17 (67D)'];
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          ...cellBase,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          border: '1px solid var(--colors-neutral-bg3, rgba(255,255,255,.16))',
          borderRadius: 4,
          background: 'transparent',
          color: 'var(--colors-neutral-fg1, #fff)',
          cursor: 'pointer',
          fontWeight: 500,
        }}
      >
        <span>{value}</span>
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 6l4 4 4-4" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            insetInlineStart: 0,
            zIndex: 10,
            background: 'var(--colors-neutral-bg1, #0a0a0a)',
            border: '1px solid var(--colors-neutral-bg3, rgba(255,255,255,.16))',
            borderRadius: 6,
            padding: 4,
            boxShadow: '0 8px 24px rgba(0,0,0,.5)',
            minWidth: 180,
          }}
        >
          {options.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => { onChange(opt); setOpen(false); }}
              style={{
                ...cellBase,
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '6px 8px',
                border: 0,
                borderRadius: 4,
                background: opt === value ? 'var(--colors-neutral-bg2, rgba(255,255,255,.08))' : 'transparent',
                color: 'var(--colors-neutral-fg1, #fff)',
                cursor: 'pointer',
              }}
              onPointerEnter={(e) => {
                if (opt !== value) (e.currentTarget as HTMLElement).style.background = 'var(--colors-neutral-bg2, rgba(255,255,255,.08))';
              }}
              onPointerLeave={(e) => {
                if (opt !== value) (e.currentTarget as HTMLElement).style.background = 'transparent';
              }}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const COLS = [
  { key: 'strike', label: 'Strike', sortable: true, align: 'start' as const, width: 86 },
  { key: 'vol', label: 'Vol', align: 'end' as const, width: 64 },
  { key: 'oi', label: 'OI', align: 'end' as const, width: 64 },
  { key: 'cop', label: 'COP', align: 'end' as const, width: 64 },
  { key: 'delta', label: 'Delta', align: 'end' as const, width: 64 },
  { key: 'ask', label: 'Ask', align: 'end' as const, width: 70 },
];

const AskPill: React.FC<{ value: number; side: Side; selected: boolean; onClick: () => void }> = ({ value, side, selected, onClick }) => {
  const positive = side === 'buy';
  const baseBg = 'var(--colors-neutral-bg2, rgba(255,255,255,.08))';
  const baseFg = positive ? 'var(--colors-accent-positive, #00c805)' : 'var(--colors-accent-negative, #ff5000)';
  const activeBg = positive ? 'var(--colors-extended-prime, #00c805)' : 'var(--colors-extended-joule, #ff5000)';
  const activeFg = '#000';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${positive ? 'Buy' : 'Sell'} at $${value.toFixed(2)}`}
      style={{
        ...cellBase,
        fontWeight: 700,
        padding: '4px 8px',
        border: 0,
        borderRadius: 4,
        cursor: 'pointer',
        minInlineSize: 64,
        background: selected ? activeBg : baseBg,
        color: selected ? activeFg : baseFg,
        transition: 'background-color 80ms ease, color 80ms ease',
      }}
    >
      {fmtCurrency(value)}
    </button>
  );
};

type AtmRowProps = { spot: number };
const AtmDivider: React.FC<AtmRowProps> = ({ spot }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '6px 0',
      position: 'relative',
    }}
    aria-label="At-the-money divider"
  >
    <div
      style={{
        position: 'absolute',
        insetInline: 0,
        top: '50%',
        height: 0,
        borderTop: '1px dashed var(--colors-neutral-bg3, rgba(255,255,255,.16))',
      }}
      aria-hidden="true"
    />
    <div
      style={{
        ...cellBase,
        position: 'relative',
        zIndex: 1,
        background: 'var(--colors-neutral-bg2, rgba(255,255,255,.12))',
        color: 'var(--colors-neutral-fg1, #fff)',
        padding: '4px 12px',
        borderRadius: 9999,
        fontWeight: 700,
      }}
    >
      {fmtCurrency(spot)}
    </div>
  </div>
);

const Row: React.FC<{
  row: ChainRow;
  side: Side;
  expanded: boolean;
  selected: boolean;
  onToggleExpand: () => void;
  onAsk: () => void;
}> = ({ row, side, expanded, selected, onToggleExpand, onAsk }) => {
  const [hover, setHover] = useState(false);
  const rowBg = selected
    ? 'rgba(120, 80, 220, 0.32)'
    : hover
    ? 'rgba(120, 80, 220, 0.16)'
    : 'transparent';
  const cells = useMemo(
    () => [
      { v: fmtCurrency(row.strike), align: 'start' as const, color: 'fg1', bold: true, w: COLS[0].width },
      { v: row.vol >= 1000 ? row.vol.toLocaleString() : String(row.vol), align: 'end' as const, color: 'fg2', w: COLS[1].width },
      { v: row.oi.toLocaleString(), align: 'end' as const, color: 'fg2', w: COLS[2].width },
      { v: fmtPct(row.cop), align: 'end' as const, color: 'fg2', w: COLS[3].width },
      { v: row.delta.toFixed(3), align: 'end' as const, color: 'fg2', w: COLS[4].width },
    ],
    [row]
  );
  return (
    <>
      <div
        role="row"
        tabIndex={0}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        onClick={(e) => {
          // expand only when clicking row content, not the Ask pill
          if (!(e.target as HTMLElement).closest('button')) onToggleExpand();
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 8px',
          blockSize: 40,
          borderBlockEnd: '1px solid var(--colors-neutral-bg2, rgba(255,255,255,.08))',
          background: rowBg,
          transition: 'background-color 100ms cubic-bezier(.05,.39,.42,.94)',
          cursor: 'pointer',
          outline: 'none',
        }}
        aria-expanded={expanded}
      >
        <span
          aria-hidden="true"
          style={{
            display: 'inline-flex',
            width: 12,
            height: 12,
            color: 'var(--colors-neutral-fg2, rgba(255,255,255,.65))',
            transform: expanded ? 'rotate(90deg)' : 'none',
            transition: 'transform 120ms ease',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M4.43103 2.69684L8.55996 5.99996L4.43103 9.30308L4.43103 2.69684Z" fill="currentColor" />
          </svg>
        </span>
        {cells.map((c, i) => (
          <span
            key={i}
            style={{
              ...cellBase,
              fontWeight: c.bold ? 700 : 400,
              flex: `0 0 ${c.w}px`,
              textAlign: c.align,
              color:
                c.color === 'fg1'
                  ? 'var(--colors-neutral-fg1, #fff)'
                  : 'var(--colors-neutral-fg2, rgba(255,255,255,.65))',
            }}
          >
            {c.v}
          </span>
        ))}
        <span style={{ flex: `0 0 ${COLS[5].width}px`, textAlign: 'end' }}>
          <AskPill value={row.ask} side={side} selected={selected} onClick={onAsk} />
        </span>
      </div>
      {expanded && (
        <div
          style={{
            padding: '12px 16px',
            background: 'var(--colors-neutral-bg1, #0a0a0a)',
            borderBlockEnd: '1px solid var(--colors-neutral-bg2, rgba(255,255,255,.08))',
          }}
        >
          <div style={{ ...cellBase, color: 'var(--colors-neutral-fg2, rgba(255,255,255,.65))', marginBottom: 8 }}>
            Stats
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
            <Stat label="Bid" value={fmtCurrency(row.bid)} />
            <Stat label="Mark" value={fmtCurrency(+((row.bid + row.ask) / 2).toFixed(2))} />
            <Stat label="High" value="—" />
            <Stat label="Last Trade" value={fmtCurrency(row.ask)} />
            <Stat label="Volume" value={fmtCompact(row.vol)} />
            <Stat label="Ask" value={fmtCurrency(row.ask)} />
            <Stat label="Prev Close" value={fmtCurrency(+(row.ask - 0.02).toFixed(2))} />
            <Stat label="Low" value="—" />
            <Stat label="IV" value={fmtPct(13.67)} />
            <Stat label="Open Interest" value={fmtCompact(row.oi)} />
          </div>
          <div style={{ ...cellBase, color: 'var(--colors-neutral-fg2, rgba(255,255,255,.65))', margin: '16px 0 8px' }}>
            The Greeks
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
            <Stat label="Delta" value={row.delta.toFixed(4)} />
            <Stat label="Gamma" value="0.0008" />
            <Stat label="Theta" value="-0.0002" />
            <Stat label="Vega" value="0.0001" />
            <Stat label="Rho" value="0.00" />
          </div>
        </div>
      )}
    </>
  );
};

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
    <span style={{ ...cellBase, color: 'var(--colors-neutral-fg2, rgba(255,255,255,.65))' }}>{label}</span>
    <span style={{ ...cellBase, color: 'var(--colors-neutral-fg1, #fff)', fontWeight: 500 }}>{value}</span>
  </div>
);

type Props = {
  symbol?: string;
  spot?: number;
  delta?: number;
  pctChange?: number;
  onAskClick?: (row: ChainRow, side: Side, kind: Kind) => void;
};

export function OptionsChainWidget({
  symbol = 'TSLA',
  spot = 444.17,
  delta = 15.82,
  pctChange = 3.69,
  onAskClick,
}: Props) {
  const [side, setSide] = useState<Side>('buy');
  const [kind, setKind] = useState<Kind>('call');
  const [expiration, setExpiration] = useState('Exp May 15 (4D)');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [selectedStrike, setSelectedStrike] = useState<number | null>(null);
  const [tab, setTab] = useState<'chain' | 'sim'>('chain');

  const rows = useMemo(() => generateChain(symbol, spot, kind), [symbol, spot, kind]);
  // Find ATM split index — first row whose strike is <= spot
  const atmSplit = rows.findIndex((r) => r.strike <= spot);

  const handleAsk = useCallback(
    (row: ChainRow) => {
      setSelectedStrike(row.strike);
      if (onAskClick) onAskClick(row, side, kind);
    },
    [onAskClick, side, kind]
  );

  return (
    <section
      data-widget-kind="OptionsChainWidget"
      style={{
        background: 'var(--colors-neutral-bg1, #000)',
        color: 'var(--colors-neutral-fg1, #fff)',
        border: '1px solid var(--colors-neutral-bg2, rgba(255,255,255,.08))',
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        minBlockSize: 0,
        blockSize: '100%',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderBlockEnd: '1px solid var(--colors-neutral-bg2, rgba(255,255,255,.08))',
        }}
      >
        <div style={{
          inlineSize: 14, blockSize: 14, borderRadius: 3,
          background: 'var(--colors-extended-cosmonautlight, #b095f9)',
        }} aria-hidden="true" />
        <button
          type="button"
          style={{
            ...cellBase,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            background: 'transparent',
            color: 'var(--colors-neutral-fg1, #fff)',
            border: 0,
            cursor: 'pointer',
            padding: 4,
            borderRadius: 4,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" fill="none" strokeWidth="1.5" />
            <path d="M10.5 10.5l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span style={{ fontWeight: 700 }}>{symbol}</span>
        </button>
        <span style={cellBase}>{fmtCurrency(spot)}</span>
        <span
          style={{
            ...cellBase,
            color: pctChange >= 0 ? 'var(--colors-accent-positive, #00c805)' : 'var(--colors-accent-negative, #ff5000)',
            fontWeight: 700,
          }}
        >
          {pctChange >= 0 ? '▲ ' : '▼ '}
          {pctChange >= 0 ? '$' : '−$'}{Math.abs(delta).toFixed(2)} ({pctChange.toFixed(2)}%)
        </span>
        <div style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8 }}>
          <IconBtn aria-label="Controls">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="5" cy="4.5" r="1.5" fill="currentColor" />
              <line x1="8" y1="4.5" x2="14" y2="4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="2" y1="4.5" x2="3.5" y2="4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <circle cx="11" cy="11.5" r="1.5" fill="currentColor" />
              <line x1="2" y1="11.5" x2="9.5" y2="11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="12.5" y1="11.5" x2="14" y2="11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </IconBtn>
          <IconBtn aria-label="More">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="3" r="1.5" fill="currentColor" />
              <circle cx="8" cy="8" r="1.5" fill="currentColor" />
              <circle cx="8" cy="13" r="1.5" fill="currentColor" />
            </svg>
          </IconBtn>
        </div>
      </div>

      {/* Chain / Simulated Returns tabs */}
      <div
        role="tablist"
        style={{
          display: 'flex',
          justifyContent: 'center',
          gap: 16,
          padding: '8px 12px',
          borderBlockEnd: '1px solid var(--colors-neutral-bg2, rgba(255,255,255,.08))',
        }}
      >
        <Tab selected={tab === 'chain'} onClick={() => setTab('chain')}>Chain</Tab>
        <Tab selected={tab === 'sim'} onClick={() => setTab('sim')}>Simulated Returns</Tab>
      </div>

      {/* Buy/Sell + Call/Put + Expiration controls */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '8px 12px',
          borderBlockEnd: '1px solid var(--colors-neutral-bg2, rgba(255,255,255,.08))',
        }}
      >
        <SideOrKindToggle
          options={[{ value: 'buy', label: 'Buy' }, { value: 'sell', label: 'Sell' }]}
          value={side}
          onChange={(v) => setSide(v as Side)}
        />
        <SideOrKindToggle
          options={[{ value: 'call', label: 'Call' }, { value: 'put', label: 'Put' }]}
          value={kind}
          onChange={(v) => setKind(v as Kind)}
        />
        <ExpirationPicker value={expiration} onChange={setExpiration} />
      </div>

      {/* Column headers */}
      <div
        role="row"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 8px',
          paddingInlineStart: 28, // align with chevron offset
          borderBlockEnd: '1px solid var(--colors-neutral-bg2, rgba(255,255,255,.08))',
        }}
      >
        {COLS.map((c, i) => (
          <span
            key={c.key}
            style={{
              ...cellBase,
              fontWeight: 500,
              flex: `0 0 ${c.width}px`,
              textAlign: c.align,
              color: 'var(--colors-neutral-fg2, rgba(255,255,255,.65))',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              justifyContent: c.align === 'end' ? 'flex-end' : 'flex-start',
            }}
          >
            {c.label}
            {c.sortable && (
              <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M3 4l3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" />
              </svg>
            )}
          </span>
        ))}
      </div>

      {/* Rows + ATM divider */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          scrollbarColor: 'var(--colors-neutral-bg3) transparent',
        }}
      >
        {rows.flatMap((r, idx) => {
          const parts: React.ReactNode[] = [];
          if (idx === atmSplit) parts.push(<AtmDivider key={`atm-${r.strike}`} spot={spot} />);
          parts.push(
            <Row
              key={r.strike}
              row={r}
              side={side}
              expanded={expanded === r.strike}
              selected={selectedStrike === r.strike}
              onToggleExpand={() => setExpanded((cur) => (cur === r.strike ? null : r.strike))}
              onAsk={() => handleAsk(r)}
            />
          );
          return parts;
        })}
      </div>
    </section>
  );
}

const Tab: React.FC<{ selected: boolean; onClick: () => void; children: React.ReactNode }> = ({ selected, onClick, children }) => (
  <button
    type="button"
    role="tab"
    aria-selected={selected}
    onClick={onClick}
    style={{
      ...cellBase,
      background: 'transparent',
      color: selected ? 'var(--colors-neutral-fg1, #fff)' : 'var(--colors-neutral-fg2, rgba(255,255,255,.65))',
      border: 0,
      borderBottom: selected ? '2px solid var(--colors-neutral-fg1, #fff)' : '2px solid transparent',
      padding: '4px 2px',
      fontWeight: selected ? 700 : 500,
      cursor: 'pointer',
      transition: 'color 120ms, border-color 120ms',
    }}
  >
    {children}
  </button>
);

const IconBtn: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({ children, ...rest }) => (
  <button
    type="button"
    {...rest}
    style={{
      inlineSize: 24, blockSize: 24,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      background: 'transparent', border: 0, borderRadius: 4,
      color: 'var(--colors-neutral-fg2, rgba(255,255,255,.65))',
      cursor: 'pointer',
      transition: 'background-color 120ms, color 120ms',
    }}
    onPointerEnter={(e) => {
      (e.currentTarget as HTMLElement).style.background = 'var(--colors-neutral-bg2, rgba(255,255,255,.08))';
      (e.currentTarget as HTMLElement).style.color = 'var(--colors-neutral-fg1, #fff)';
    }}
    onPointerLeave={(e) => {
      (e.currentTarget as HTMLElement).style.background = 'transparent';
      (e.currentTarget as HTMLElement).style.color = 'var(--colors-neutral-fg2, rgba(255,255,255,.65))';
    }}
  >
    {children}
  </button>
);
