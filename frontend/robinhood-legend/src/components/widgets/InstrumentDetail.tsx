'use client';
import { useState } from 'react';

// ============================================================================
// InstrumentDetail — bottom-left panel: Symbol header + Buy/Short + tabbed
// content. Reference: screenshots 3.42.32 PM and 3.42.38 PM.
//
// Tabs (sourced from chunk 1230/1703/3380):
//   - Summary: Today range bar, 52W range bar, Volume stats, Recent headlines
//   - Volatility: (placeholder content; structure ready)
//   - Fundamentals: (placeholder content; structure ready)
//
// Motion: same tokens as OrderBook (EASE_QUINT / 100ms / 500ms).
// ============================================================================

const EASE_QUINT = 'cubic-bezier(.22, 1, .36, 1)';
const EASE_CIRC = 'cubic-bezier(0, .55, .45, 1)';

const COLORS = {
  positive: '#00d20c',
  positiveBar: '#1c7427',
  positiveBarLite: 'rgba(0, 210, 12, 0.32)',
  negative: '#ff5000',
  text: '#f4f4f5',
  textSecondary: '#85858b',
  textMuted: '#5b5b62',
  border: '#29292b',
  buttonBg: '#1f1f22',
  buttonHover: '#2a2a2e',
};

type Tab = 'summary' | 'volatility' | 'fundamentals';

export type InstrumentDetailProps = {
  symbol: string;
  name?: string;
  price: number;
  changeDollar?: number;
  changePct?: number;
  bidAsk?: { bidSize: number; bidPrice: number; askPrice: number; askSize: number } | null;
  today?: { low: number; high: number };
  week52?: { low: number; high: number };
  volume?: { today: string; thirtyDayAvg: string; overnight: string; optionsToday: string };
  headlines?: Array<{ age: string; title: string; source: string; underline?: boolean }>;
};

const DEFAULT: Required<Pick<InstrumentDetailProps, 'name' | 'bidAsk' | 'today' | 'week52' | 'volume' | 'headlines'>> = {
  name: 'NVIDIA',
  bidAsk: { bidSize: 600, bidPrice: 219.80, askPrice: 219.83, askSize: 378 },
  today: { low: 213.89, high: 222.30 },
  week52: { low: 120.28, high: 217.80 },
  volume: { today: '160.94M', thirtyDayAvg: '149.59M', overnight: '440.15K', optionsToday: '4.76M' },
  headlines: [
    { age: '26m', title: 'Stock Market Today, May 11: Archer Aviation Inches Higher After Positive Q1 Earnings', source: 'Benzinga' },
    { age: '4h',  title: 'Elon Musk Joins Trump’s China Trip — Nvidia CEO Jensen Huang Not Invited', source: 'Benzinga' },
    { age: '4h',  title: 'Why Is Iren Stock Falling Today despite Nvidia Deal?', source: 'TipRanks' },
    { age: '5h',  title: 'Certara Q1 2026 Earnings Call Transcript', source: 'The Motley Fool' },
    { age: '5h',  title: 'Strong Demand Boosts Nvidia Rival Cerebras Ahead of Its IPO', source: 'The Motley Fool', underline: true },
    { age: '7h',  title: 'Nvidia CEO Jensen Huang Excluded from Trump’s China Trip', source: 'TipRanks' },
    { age: '7h',  title: 'Nvidia’s IREN Deal Looks Increasingly Like A CoreWeave Repeat', source: 'TipRanks' },
  ],
};

export function InstrumentDetail(props: InstrumentDetailProps) {
  const {
    symbol, name = DEFAULT.name, price, changeDollar = 0, changePct = 0,
    bidAsk = DEFAULT.bidAsk,
    today = DEFAULT.today, week52 = DEFAULT.week52,
    volume = DEFAULT.volume, headlines = DEFAULT.headlines,
  } = props;
  const [tab, setTab] = useState<Tab>('summary');
  const up = changeDollar >= 0;

  return (
    <div
      data-testid="instrument-detail-widget"
      style={{
        display: 'flex', flexDirection: 'column', height: '100%',
        fontFamily: 'var(--bw-ds--font-family, ui-sans-serif, system-ui)',
        fontVariantNumeric: 'tabular-nums',
        color: COLORS.text,
        background: 'transparent',
        overflowY: 'auto',
      }}
    >
      {/* Header strip: icon + symbol search + menu */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '6px 10px', borderBottom: `1px solid ${COLORS.border}`, gap: 8 }}>
        <div style={{ width: 28, height: 28, background: '#7a45ff', borderRadius: 6 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', background: COLORS.buttonBg, borderRadius: 6, fontWeight: 700, fontSize: 13 }}>
          <span style={{ color: COLORS.textSecondary }}>⌕</span>
          <span>{symbol}</span>
        </div>
        <div style={{ flex: 1 }} />
        <button aria-label="More" style={{ background: 'transparent', border: 'none', color: COLORS.textSecondary, cursor: 'pointer', padding: '0 6px' }}>⋮</button>
      </div>

      <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* Name + price */}
        <div style={{ fontSize: 28, fontWeight: 400, letterSpacing: '-0.5px' }}>{name}</div>
        <div style={{ fontSize: 36, fontWeight: 400, lineHeight: 1.05 }}>${price.toFixed(2)}</div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, color: up ? COLORS.positive : COLORS.negative }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 9 }}>{up ? '▲' : '▼'}</span>
            <span>${Math.abs(changeDollar).toFixed(2)} ({Math.abs(changePct).toFixed(2)}%)</span>
          </span>
          {bidAsk ? (
            <span style={{ color: COLORS.textSecondary, fontSize: 12 }}>
              B <span style={{ color: COLORS.text }}>{bidAsk.bidSize}</span> x ${bidAsk.bidPrice.toFixed(2)} – ${bidAsk.askPrice.toFixed(2)} x <span style={{ color: COLORS.text }}>{bidAsk.askSize}</span> A
            </span>
          ) : null}
        </div>

        {/* Buy/Short buttons */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 6 }}>
          <TradeButton side="buy">Buy</TradeButton>
          <TradeButton side="sell">Short</TradeButton>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${COLORS.border}`, padding: '0 16px', gap: 24 }}>
        <Tab label="Summary"      active={tab === 'summary'}      onClick={() => setTab('summary')} />
        <Tab label="Volatility"   active={tab === 'volatility'}   onClick={() => setTab('volatility')} />
        <Tab label="Fundamentals" active={tab === 'fundamentals'} onClick={() => setTab('fundamentals')} />
      </div>

      <div style={{ padding: 16, flex: 1 }}>
        {tab === 'summary' ? (
          <SummaryTab today={today} week52={week52} price={price} volume={volume} headlines={headlines} />
        ) : tab === 'volatility' ? (
          <Placeholder text="Volatility metrics — IV percentile rank, HV, term structure." />
        ) : (
          <Placeholder text="Fundamentals — P/E, EPS, dividend, market cap, beta." />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Summary tab content
// ---------------------------------------------------------------------------

function SummaryTab({ today, week52, price, volume, headlines }: {
  today: { low: number; high: number };
  week52: { low: number; high: number };
  price: number;
  volume: { today: string; thirtyDayAvg: string; overnight: string; optionsToday: string };
  headlines: Array<{ age: string; title: string; source: string; underline?: boolean }>;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <RangeBar label="Today" low={today.low} high={today.high} current={price} />
      <RangeBar label="52W"   low={week52.low} high={week52.high} current={price} />

      <div style={{ borderTop: `1px solid ${COLORS.border}`, paddingTop: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Volume</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', rowGap: 8, columnGap: 24, fontSize: 13 }}>
          <Stat label="Today" value={volume.today} />
          <Stat label="30D avg" value={volume.thirtyDayAvg} />
          <Stat label="Overnight" value={volume.overnight} />
          <Stat label="Options today" value={volume.optionsToday} />
        </div>
      </div>

      <div style={{ borderTop: `1px solid ${COLORS.border}`, paddingTop: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
          Recent headlines
          <span style={{ color: COLORS.textSecondary, fontSize: 13 }}>ⓘ</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {headlines.map((h, i) => <HeadlineRow key={i} {...h} />)}
        </div>
      </div>
    </div>
  );
}

function RangeBar({ label, low, high, current }: { label: string; low: number; high: number; current: number }) {
  const pct = Math.max(0, Math.min(1, (current - low) / (high - low || 1)));
  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>{label}</div>
      {/* Bar */}
      <div style={{ position: 'relative', height: 4, background: COLORS.positiveBar, borderRadius: 2 }}>
        <div style={{
          position: 'absolute',
          left: `calc(${pct * 100}% - 2px)`,
          top: -3,
          width: 4, height: 10,
          background: COLORS.positive,
          borderRadius: 1,
          transition: `left 500ms ${EASE_QUINT}`,
        }} />
      </div>
      {/* Labels */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 13 }}>
        <span><span style={{ color: COLORS.textSecondary }}>L </span><span style={{ color: COLORS.text }}>${low.toFixed(2)}</span></span>
        <span><span style={{ color: COLORS.text }}>${high.toFixed(2)}</span><span style={{ color: COLORS.textSecondary }}> H</span></span>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span style={{ color: COLORS.textSecondary }}>{label}</span>
      <span style={{ color: COLORS.text }}>{value}</span>
    </div>
  );
}

function HeadlineRow({ age, title, source, underline }: { age: string; title: string; source: string; underline?: boolean }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'grid',
        gridTemplateColumns: '48px 1fr 24px',
        gap: 10,
        padding: '10px 0',
        borderBottom: `1px solid ${COLORS.border}`,
        cursor: 'pointer',
        background: hovered ? 'rgba(255,255,255,0.02)' : 'transparent',
        transition: `background 100ms ${EASE_QUINT}`,
      }}
    >
      <span style={{ background: COLORS.buttonBg, color: COLORS.textSecondary, borderRadius: 4, padding: '2px 0', textAlign: 'center', fontSize: 12, alignSelf: 'flex-start' }}>{age}</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <span style={{ fontSize: 13, color: COLORS.text, textDecoration: underline ? 'underline' : 'none' }}>{title}</span>
        <span style={{ fontSize: 12, color: COLORS.textSecondary }}>{source}</span>
      </div>
      <span style={{ color: COLORS.textSecondary, fontSize: 14, alignSelf: 'flex-start' }}>↗</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Tabs + buttons
// ---------------------------------------------------------------------------

function Tab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: 'transparent', border: 'none',
        color: active ? COLORS.text : (hovered ? COLORS.text : COLORS.textSecondary),
        fontWeight: active ? 700 : 400,
        fontSize: 14,
        padding: '12px 0',
        cursor: 'pointer',
        position: 'relative',
        transition: `color 100ms ${EASE_QUINT}`,
      }}
    >
      {label}
      {active ? (
        <span
          style={{
            position: 'absolute',
            left: 0, right: 0, bottom: -1,
            height: 2,
            background: COLORS.text,
            borderRadius: 1,
          }}
        />
      ) : null}
    </button>
  );
}

function TradeButton({ side, children }: { side: 'buy' | 'sell'; children: React.ReactNode }) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const color = side === 'buy' ? COLORS.positive : COLORS.negative;
  return (
    <button
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setPressed(false); }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      style={{
        padding: '10px 0',
        background: hovered ? COLORS.buttonHover : COLORS.buttonBg,
        border: 'none',
        borderRadius: 6,
        color,
        fontWeight: 700,
        fontSize: 14,
        cursor: 'pointer',
        transform: pressed ? 'scale(0.98)' : 'scale(1)',
        boxShadow: hovered ? `inset 0 0 0 1px ${color}55` : 'inset 0 0 0 1px transparent',
        transition: `transform 100ms ${EASE_CIRC}, background 100ms ${EASE_QUINT}, box-shadow 100ms ${EASE_QUINT}`,
      }}
    >
      {children}
    </button>
  );
}

function Placeholder({ text }: { text: string }) {
  return <div style={{ color: COLORS.textSecondary, fontSize: 13 }}>{text}</div>;
}
