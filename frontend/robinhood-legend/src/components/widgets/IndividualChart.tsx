'use client';
import { useEffect, useMemo, useRef, useState } from 'react';

// ============================================================================
// IndividualChart — top-left panel: account performance line + Deposit btn +
// interval selector + Overview list.
//
// Reference: screenshot 2026-05-11 7.32.41 PM (top-left) & 2.28.35 PM.
//
// Behavior:
//   - Line color follows sign: green if up, red if down.
//   - Interval segment switches the rendered series.
//   - Hover the chart shows a crosshair + price tooltip.
//   - "Deposit" button: brand standard hover/press.
// ============================================================================

const EASE_QUINT = 'cubic-bezier(.22, 1, .36, 1)';
const EASE_CIRC = 'cubic-bezier(0, .55, .45, 1)';

const COLORS = {
  positive: '#00d20c',
  positiveSoft: 'rgba(0, 210, 12, 0.18)',
  negative: '#ff5000',
  negativeSoft: 'rgba(255, 80, 0, 0.18)',
  text: '#f4f4f5',
  textSecondary: '#85858b',
  border: '#29292b',
  buttonBg: '#1f1f22',
  buttonHover: '#2a2a2e',
};

const INTERVALS = ['LIVE', '1D', '1W', '1M', '3M', 'YTD', '1Y', 'ALL'] as const;
type Interval = typeof INTERVALS[number];

export type IndividualChartProps = {
  accountName?: string;
  value: number;
  changeDollar?: number;
  changePct?: number;
  overview?: Array<{ label: string; value: string }>;
};

// Generate a plausible-looking series for the given interval (mock, but
// deterministic per interval so switching feels stable).
function seriesFor(interval: Interval, baseValue: number): number[] {
  const counts: Record<Interval, number> = {
    LIVE: 60, '1D': 80, '1W': 60, '1M': 80, '3M': 90, YTD: 100, '1Y': 120, ALL: 140,
  };
  const n = counts[interval];
  // Deterministic pseudo-random: index → seed
  const seed = interval.charCodeAt(0) + interval.length * 7;
  let s = seed;
  const r = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };

  // Walk biased upward then downward in the second half to mimic the screenshot.
  const out: number[] = [];
  let v = baseValue * (0.4 + r() * 0.3);
  for (let i = 0; i < n; i++) {
    const phase = i / n;
    const drift = (phase < 0.25 ? 0.04 : phase < 0.55 ? -0.02 : 0.005);
    v = v * (1 + drift + (r() - 0.5) * 0.04);
    out.push(Math.max(0.01, v));
  }
  return out;
}

export function IndividualChart({
  accountName = 'Individual',
  value,
  changeDollar = 0,
  changePct = 0,
  overview = [
    { label: 'Buying power', value: '$3.00' },
    { label: 'Options buying power', value: '$3.00' },
    { label: 'Futures buying power', value: '$0.00' },
    { label: 'Cash', value: '$3.00' },
  ],
}: IndividualChartProps) {
  const [interval, setInterval] = useState<Interval>('ALL');
  const series = useMemo(() => seriesFor(interval, value), [interval, value]);
  const up = changeDollar >= 0;

  return (
    <div
      data-testid="individual-chart-widget"
      style={{
        display: 'flex', flexDirection: 'column', height: '100%',
        padding: '14px 16px', gap: 10,
        fontFamily: 'var(--bw-ds--font-family, ui-sans-serif, system-ui)',
        fontVariantNumeric: 'tabular-nums',
        color: COLORS.text,
        background: 'transparent',
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div style={{ color: COLORS.textSecondary, fontSize: 13 }}>{accountName}</div>
        <DepositButton />
      </div>

      {/* Value + change row */}
      <div>
        <div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1, letterSpacing: '-0.5px' }}>
          ${value.toFixed(2)}
        </div>
        <div style={{ fontSize: 13, marginTop: 6, color: up ? COLORS.positive : COLORS.negative, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 9 }}>{up ? '▲' : '▼'}</span>
          <span>{up ? '+' : ''}${Math.abs(changeDollar).toFixed(2)} ({Math.abs(changePct).toFixed(2)}%)</span>
          <span style={{ color: COLORS.textSecondary }}>·</span>
          <span style={{ color: COLORS.textSecondary }}>{interval === 'LIVE' ? 'Live' : interval === '1D' ? 'Today' : 'Lifetime'}</span>
        </div>
      </div>

      {/* Chart */}
      <div style={{ flex: '0 1 auto', minHeight: 140, position: 'relative' }}>
        <MiniLineChart series={series} positive={up} />
      </div>

      {/* Interval selector */}
      <IntervalSelector value={interval} onChange={setInterval} />

      {/* Overview list */}
      <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ color: COLORS.text, fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Overview</div>
        {overview.map((o) => (
          <div key={o.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: COLORS.textSecondary, padding: '2px 0' }}>
            <span>{o.label}</span>
            <span style={{ color: COLORS.text }}>{o.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Chart -------------------------------------------------------------------

function MiniLineChart({ series, positive }: { series: number[]; positive: boolean }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const W = 1000, H = 200, PAD_L = 4, PAD_R = 4, PAD_T = 12, PAD_B = 12;
  const min = Math.min(...series), max = Math.max(...series);
  const range = max - min || 1;
  const path = useMemo(() => {
    return series.map((v, i) => {
      const x = PAD_L + (i / (series.length - 1)) * (W - PAD_L - PAD_R);
      const y = PAD_T + (1 - (v - min) / range) * (H - PAD_T - PAD_B);
      return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
  }, [series, min, range]);
  const fill = path + ` L${(W - PAD_R).toFixed(1)},${(H - PAD_B).toFixed(1)} L${PAD_L},${(H - PAD_B).toFixed(1)} Z`;

  const lineColor = positive ? COLORS.positive : COLORS.negative;
  const fillStart = positive ? COLORS.positiveSoft : COLORS.negativeSoft;

  const onMove = (ev: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const vbX = ((ev.clientX - r.left) / r.width) * W;
    const idx = Math.max(0, Math.min(series.length - 1, Math.round(((vbX - PAD_L) / (W - PAD_L - PAD_R)) * (series.length - 1))));
    setHoverIdx(idx);
  };

  const hoverX = hoverIdx == null ? 0 : PAD_L + (hoverIdx / (series.length - 1)) * (W - PAD_L - PAD_R);
  const hoverY = hoverIdx == null ? 0 : PAD_T + (1 - (series[hoverIdx] - min) / range) * (H - PAD_T - PAD_B);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width: '100%', height: '100%', display: 'block', cursor: 'crosshair', touchAction: 'none' }}
        onPointerMove={onMove}
        onPointerLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id="indvFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={fillStart} />
            <stop offset="1" stopColor={fillStart.replace(/[\d.]+\)$/, '0)')} />
          </linearGradient>
        </defs>
        <path d={fill} fill="url(#indvFill)" />
        <path d={path} fill="none" stroke={lineColor} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        {hoverIdx != null ? (
          <>
            <line x1={hoverX} y1={PAD_T} x2={hoverX} y2={H - PAD_B} stroke="#ffffff" strokeWidth={1} strokeDasharray="3 4" opacity={0.45} vectorEffect="non-scaling-stroke" />
            <circle cx={hoverX} cy={hoverY} r={4} fill={lineColor} stroke="#fff" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          </>
        ) : null}
      </svg>
      {hoverIdx != null ? (
        <div
          style={{
            position: 'absolute',
            left: `${(hoverIdx / (series.length - 1)) * 100}%`,
            top: 0,
            transform: 'translateX(-50%)',
            background: '#000',
            border: `1px solid ${COLORS.border}`,
            borderRadius: 6,
            padding: '4px 8px',
            color: COLORS.text,
            fontSize: 11,
            fontVariantNumeric: 'tabular-nums',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            transition: `left 100ms ${EASE_QUINT}`,
          }}
        >
          ${series[hoverIdx].toFixed(2)}
        </div>
      ) : null}
    </div>
  );
}

// Interval selector -------------------------------------------------------

function IntervalSelector({ value, onChange }: { value: Interval; onChange: (v: Interval) => void }) {
  return (
    <div style={{ display: 'flex', gap: 2, padding: '2px', background: COLORS.buttonBg, borderRadius: 8 }}>
      {INTERVALS.map((iv) => (
        <IntervalPill key={iv} label={iv} active={value === iv} onClick={() => onChange(iv)} />
      ))}
    </div>
  );
}

function IntervalPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setPressed(false); }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      style={{
        flex: 1,
        padding: '5px 0',
        background: active ? '#000' : (hovered ? 'rgba(255,255,255,0.04)' : 'transparent'),
        border: 'none',
        color: active ? COLORS.text : (hovered ? COLORS.text : COLORS.textSecondary),
        fontSize: 11,
        fontWeight: active ? 700 : 400,
        cursor: 'pointer',
        borderRadius: 6,
        boxShadow: active ? `0 0 0 1px ${COLORS.border}` : 'none',
        transform: pressed ? 'scale(0.96)' : 'scale(1)',
        transition: `background 100ms ${EASE_QUINT}, color 100ms ${EASE_QUINT}, transform 100ms ${EASE_CIRC}`,
      }}
    >
      {label}
    </button>
  );
}

function DepositButton() {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  return (
    <button
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setPressed(false); }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      style={{
        padding: '6px 14px',
        background: hovered ? COLORS.buttonHover : COLORS.buttonBg,
        border: 'none',
        borderRadius: 6,
        color: COLORS.text,
        fontWeight: 700,
        fontSize: 12,
        cursor: 'pointer',
        transform: pressed ? 'scale(0.97)' : 'scale(1)',
        transition: `transform 100ms ${EASE_CIRC}, background 100ms ${EASE_QUINT}`,
      }}
    >
      Deposit
    </button>
  );
}
