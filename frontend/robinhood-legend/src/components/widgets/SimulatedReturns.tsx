'use client';
import { useMemo, useRef, useState } from 'react';

// SR widget — HTML/CSS layout (sidebar + chart slot + sliders row) with the
// chart itself as an SVG that fills its slot. This lets the chart take up the
// entire available vertical space instead of being letterboxed by a fixed
// viewBox aspect ratio.

export type SimulatedReturnsProps = {
  symbol: string;
  spot: number;
  strike: number;
  kind: 'call' | 'put';
  premium: number;
  quantity?: number;
  dte?: number;
  iv?: number;
};

const fmtMoney = (n: number) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtMoneyShort = (n: number) => {
  const a = Math.abs(n), s = n < 0 ? '-$' : '$';
  if (a >= 1_000_000) return s + (a / 1_000_000).toFixed(2) + 'M';
  if (a >= 1_000)     return s + (a / 1_000).toFixed(1) + 'K';
  return s + a.toFixed(0);
};
const fmtPctAbs = (n: number) => Math.abs(n).toFixed(2) + '%';
const fmtPctSigned = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';

function payoffAtExp(s: number, strike: number, kind: 'call' | 'put', premium: number, qty: number): number {
  const intr = kind === 'call' ? Math.max(0, s - strike) : Math.max(0, strike - s);
  return (intr - premium) * 100 * qty;
}
function payoffToday(s: number, strike: number, kind: 'call' | 'put', premium: number, qty: number, dte: number, iv: number): number {
  const d = (s - strike) * (kind === 'call' ? 1 : -1);
  const k = Math.max(0.01, strike * iv * Math.sqrt(Math.max(0.5, dte) / 30) * 0.1);
  const smoothed = (Math.sqrt(d * d + k * k) + d) / 2;
  return (smoothed - premium) * 100 * qty;
}

// Chart inner viewBox — narrow, no sidebar/sliders here. The HTML/CSS layout
// gives the chart its slot, and this viewBox scales to fit that slot with
// preserveAspectRatio="none" (X and Y scale independently — text inside the
// chart is rendered as HTML overlays instead of SVG <text> for clarity).
const CHART_VB_W = 1000;
const CHART_VB_H = 600;
const PAD_L = 8;
const PAD_R = 60;     // room for y-axis labels (rendered as HTML)
const PAD_T = 30;     // room for spot label
const PAD_B = 30;     // room for x-axis labels
const PLOT_W = CHART_VB_W - PAD_L - PAD_R;
const PLOT_H = CHART_VB_H - PAD_T - PAD_B;

const Y_MAX = 1400;
const Y_MIN = -1600;
const Y_RANGE = Y_MAX - Y_MIN;
const Y_ZERO_FRAC = Y_MAX / Y_RANGE;
const yToSvg = (v: number) => PAD_T + (1 - (Math.max(Y_MIN, Math.min(Y_MAX, v)) - Y_MIN) / Y_RANGE) * PLOT_H;
const Y_ZERO_SVG = yToSvg(0);

// Y-axis tick values
const Y_TICKS = [1400, 1200, 1000, 800, 600, 400, 200, 0, -200, -400, -600, -800, -1000, -1200, -1400, -1600];

export function SimulatedReturns(props: SimulatedReturnsProps) {
  const { symbol, spot: actualSpot, strike, kind, premium, quantity = 1, dte: initialDTE = 14, iv: initialIV = 0.5 } = props;

  const [dte, setDTE] = useState(initialDTE);
  const [iv, setIV]   = useState(initialIV);
  const [scrubSpot, setScrubSpot] = useState<number | null>(null);
  const [hoverSpot, setHoverSpot] = useState<number | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);

  const lo = Math.min(actualSpot, strike);
  const hi = Math.max(actualSpot, strike);
  const margin = Math.max(hi - lo, actualSpot * 0.05) * 1.4;
  const sMin = Math.max(0.01, lo - margin);
  const sMax = hi + margin;
  const xToSvg = (s: number) => PAD_L + ((s - sMin) / (sMax - sMin)) * PLOT_W;
  const svgXToSpot = (x: number) => sMin + ((x - PAD_L) / PLOT_W) * (sMax - sMin);

  const { todayPath, atExpPath, todayFill } = useMemo(() => {
    const N = 80;
    const today: Array<{ x: number; y: number; v: number }> = [];
    const exp: Array<{ x: number; y: number; v: number }> = [];
    for (let i = 0; i < N; i++) {
      const s = sMin + ((sMax - sMin) * i) / (N - 1);
      const v = payoffToday(s, strike, kind, premium, quantity, dte, iv);
      const ve = payoffAtExp(s, strike, kind, premium, quantity);
      today.push({ x: xToSvg(s), y: yToSvg(v), v });
      exp.push({ x: xToSvg(s), y: yToSvg(ve), v: ve });
    }
    const toPath = (arr: typeof today) => arr.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');
    const tPath = toPath(today);
    const ePath = toPath(exp);
    const fill = tPath + ` L${today[today.length - 1].x.toFixed(1)},${Y_ZERO_SVG} L${today[0].x.toFixed(1)},${Y_ZERO_SVG} Z`;
    return { todayPath: tPath, atExpPath: ePath, todayFill: fill };
  }, [sMin, sMax, strike, kind, premium, quantity, dte, iv]);

  // X-axis labels — 15 evenly spaced.
  const xTickCount = 15;
  const xTicks = useMemo(() => {
    return Array.from({ length: xTickCount }, (_, i) => {
      const t = i / (xTickCount - 1);
      const v = sMin + t * (sMax - sMin);
      return { label: '$' + (v < 10 ? v.toFixed(1) : Math.round(v)), svgX: PAD_L + t * PLOT_W };
    });
  }, [sMin, sMax]);

  const displaySpot = scrubSpot ?? hoverSpot ?? actualSpot;
  const currentPL = payoffToday(displaySpot, strike, kind, premium, quantity, dte, iv);
  const cost = premium * 100 * quantity;
  const plPct = cost > 0 ? (currentPL / cost) * 100 : 0;
  const plColor = currentPL >= 0 ? '#00d20c' : '#ff5000';

  const greeks = useMemo(() => {
    const d = (displaySpot - strike) * (kind === 'call' ? 1 : -1);
    const delta = Math.max(-1, Math.min(1, 0.5 + d / (strike * Math.max(0.05, iv * 0.4)))) * (kind === 'call' ? 1 : -1);
    const gamma = Math.exp(-Math.abs(d) / (strike * 0.1)) * 0.05;
    const theta = -premium / Math.max(1, dte) * 0.5;
    const vega  = Math.exp(-Math.abs(d) / (strike * 0.1)) * 0.15 * iv * 2;
    return { delta, gamma, theta, vega };
  }, [displaySpot, strike, kind, premium, dte, iv]);

  const markerX = xToSvg(displaySpot);
  const markerY = yToSvg(currentPL);

  // Map pointer event → spot price.
  const clientXYToSpot = (clientX: number, clientY: number): number | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const r = svg.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const vbX = ((clientX - r.left) / r.width) * CHART_VB_W;
    const vbY = ((clientY - r.top) / r.height) * CHART_VB_H;
    if (vbX < PAD_L || vbX > PAD_L + PLOT_W) return null;
    if (vbY < 0 || vbY > CHART_VB_H) return null;
    return svgXToSpot(Math.max(PAD_L, Math.min(PAD_L + PLOT_W, vbX)));
  };

  const sliderPctTime = ((initialDTE - dte) / Math.max(1, initialDTE));
  const sliderPctIV   = iv / 1.18;

  return (
    <div
      aria-label={`Simulated returns for ${symbol} ${kind === 'call' ? 'Call' : 'Put'} $${strike}`}
      style={{
        inlineSize: '100%',
        blockSize: '100%',
        display: 'grid',
        gridTemplateColumns: 'clamp(140px, 18%, 220px) 1fr',
        gridTemplateRows: '1fr auto',
        rowGap: 8,
        columnGap: 8,
        padding: '14px 16px 10px',
        fontFamily: 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", Helvetica, Arial, sans-serif',
        background: 'transparent',
        color: '#f4f4f5',
      }}
    >
      {/* Left sidebar — P&L + Greeks */}
      <div style={{ gridColumn: 1, gridRow: 1, display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 4 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 16, fontWeight: 400, color: '#f4f4f5' }}>
            Estimated P&amp;L
            <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden style={{ opacity: 0.55 }}>
              <circle cx="8" cy="8" r="6.5" stroke="currentColor" fill="none" strokeWidth="1" />
              <text x="8" y="11" textAnchor="middle" fontSize="9" fill="currentColor">i</text>
            </svg>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, lineHeight: 1 }}>
            <span style={{ color: plColor, fontSize: 14, lineHeight: 1 }} aria-hidden>
              {currentPL >= 0 ? '▲' : '▼'}
            </span>
            <span style={{ color: plColor, fontSize: 24, fontWeight: 700, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
              {fmtMoney(currentPL)}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 6, lineHeight: 1 }}>
            <span style={{ color: plColor, fontSize: 10, lineHeight: 1 }} aria-hidden>
              {currentPL >= 0 ? '▲' : '▼'}
            </span>
            <span style={{ color: plColor, fontSize: 12, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
              {fmtPctAbs(plPct)}
            </span>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', columnGap: 18, rowGap: 10 }}>
          <Greek label="Delta" value={greeks.delta.toFixed(4)} />
          <Greek label="Theta" value={greeks.theta.toFixed(4)} />
          <Greek label="Gamma" value={greeks.gamma.toFixed(4)} />
          <Greek label="Vega"  value={greeks.vega.toFixed(4)} />
        </div>
      </div>

      {/* Chart slot — fills available height/width */}
      <div style={{ gridColumn: 2, gridRow: 1, minWidth: 0, minHeight: 0, position: 'relative' }}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${CHART_VB_W} ${CHART_VB_H}`}
          preserveAspectRatio="none"
          width="100%"
          height="100%"
          style={{ display: 'block', cursor: 'crosshair', touchAction: 'none' }}
          onPointerDown={(ev) => {
            const sp = clientXYToSpot(ev.clientX, ev.clientY);
            if (sp == null) return;
            (ev.currentTarget as SVGSVGElement).setPointerCapture(ev.pointerId);
            setScrubSpot(sp);
          }}
          onPointerMove={(ev) => {
            const svg = ev.currentTarget as SVGSVGElement;
            const sp = clientXYToSpot(ev.clientX, ev.clientY);
            if (svg.hasPointerCapture(ev.pointerId) && sp != null) setScrubSpot(sp);
            else setHoverSpot(sp);
          }}
          onPointerUp={(ev) => { try { (ev.currentTarget as SVGSVGElement).releasePointerCapture(ev.pointerId); } catch {} }}
          onPointerLeave={() => setHoverSpot(null)}
          onDoubleClick={() => setScrubSpot(null)}
        >
          <defs>
            <linearGradient id="srGreenArea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#0a8215" stopOpacity="0.40" />
              <stop offset="1" stopColor="#0a8215" stopOpacity="0.02" />
            </linearGradient>
            <linearGradient id="srOrangeArea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#8d3617" stopOpacity="0.35" />
              <stop offset="1" stopColor="#8d3617" stopOpacity="0.03" />
            </linearGradient>
            <filter id="srSoftGlow" x="-10%" y="-10%" width="120%" height="120%">
              <feGaussianBlur stdDeviation="0.55" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
            <clipPath id="srProfitClip"><rect x={PAD_L} y={PAD_T} width={PLOT_W} height={Y_ZERO_SVG - PAD_T} /></clipPath>
            <clipPath id="srLossClip"><rect x={PAD_L} y={Y_ZERO_SVG} width={PLOT_W} height={PAD_T + PLOT_H - Y_ZERO_SVG} /></clipPath>
          </defs>

          {/* Zero line */}
          <line x1={PAD_L} y1={Y_ZERO_SVG} x2={PAD_L + PLOT_W} y2={Y_ZERO_SVG} stroke="#29292b" strokeWidth="2" opacity="0.85" vectorEffect="non-scaling-stroke" />

          {/* Today fills */}
          <path d={todayFill} fill="url(#srGreenArea)" clipPath="url(#srProfitClip)" />
          <path d={todayFill} fill="url(#srOrangeArea)" clipPath="url(#srLossClip)" />

          {/* Today curve */}
          <path d={todayPath} fill="none" stroke="#ff5000" strokeWidth="3.1" strokeLinecap="round" filter="url(#srSoftGlow)" clipPath="url(#srLossClip)" vectorEffect="non-scaling-stroke" />
          <path d={todayPath} fill="none" stroke="#00d20c" strokeWidth="3.1" strokeLinecap="round" filter="url(#srSoftGlow)" clipPath="url(#srProfitClip)" vectorEffect="non-scaling-stroke" />

          {/* At-expiration dotted */}
          <path d={atExpPath} fill="none" stroke="#ff5000" strokeWidth="2.2" strokeDasharray="2 5" strokeLinecap="round" opacity="0.95" clipPath="url(#srLossClip)" vectorEffect="non-scaling-stroke" />
          <path d={atExpPath} fill="none" stroke="#00d20c" strokeWidth="2.2" strokeDasharray="2 5" strokeLinecap="round" opacity="0.95" clipPath="url(#srProfitClip)" vectorEffect="non-scaling-stroke" />

          {/* Hover crosshair (vertical line only — circle is rendered as HTML
              overlay so it stays a perfect circle when SVG stretches). */}
          {hoverSpot != null && scrubSpot == null && (() => {
            const hx = xToSvg(hoverSpot);
            return (
              <line x1={hx} y1={PAD_T} x2={hx} y2={PAD_T + PLOT_H} stroke="#ffffff" strokeWidth="1" strokeDasharray="3 4" opacity="0.45" vectorEffect="non-scaling-stroke" />
            );
          })()}

          {/* Vertical reference line at spot. The marker dot itself is rendered
              as an HTML overlay (preserveAspectRatio="none" would otherwise
              squash an SVG <circle> into an oval). */}
          <line x1={markerX} y1={PAD_T - 18} x2={markerX} y2={PAD_T + PLOT_H} stroke="#b7b7bb" strokeWidth="2" opacity="0.55" vectorEffect="non-scaling-stroke" />
        </svg>

        {/* HTML overlay: spot label + axis labels (sit OUTSIDE the SVG so they
            don't stretch with preserveAspectRatio="none") */}
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', fontVariantNumeric: 'tabular-nums', fontSize: 13, color: '#85858b' }}>
          {/* Spot label */}
          <div style={{
            position: 'absolute',
            left: `${((markerX) / CHART_VB_W) * 100}%`,
            top: 4,
            transform: 'translateX(-50%)',
            color: '#aaaab0',
            fontSize: 13,
            fontWeight: 700,
          }}>
            {fmtMoney(displaySpot)}
            {(scrubSpot != null || (hoverSpot != null && Math.abs(hoverSpot - actualSpot) > 0.01)) && (
              <span style={{ color: (displaySpot - actualSpot) >= 0 ? '#00d20c' : '#ff5000' }}>
                {' (' + fmtPctSigned(((displaySpot - actualSpot) / Math.max(0.01, actualSpot)) * 100) + ')'}
              </span>
            )}
          </div>

          {/* Y-axis labels on the right */}
          {Y_TICKS.map((v) => (
            <div
              key={v}
              style={{
                position: 'absolute',
                right: 4,
                top: `${(yToSvg(v) / CHART_VB_H) * 100}%`,
                transform: 'translateY(-50%)',
                fontSize: 11,
                fontWeight: 700,
                color: '#818188',
              }}
            >
              {fmtMoneyShort(v)}
            </div>
          ))}

          {/* X-axis labels at the bottom */}
          {xTicks.map((t, i) => (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: `${(t.svgX / CHART_VB_W) * 100}%`,
                bottom: 4,
                transform: 'translateX(-50%)',
                fontSize: 11,
                fontWeight: 700,
                color: '#85858b',
              }}
            >
              {t.label}
            </div>
          ))}

          {/* Hover-spot dot (HTML so it stays a perfect circle). */}
          {hoverSpot != null && scrubSpot == null && (() => {
            const hx = xToSvg(hoverSpot);
            const hy = yToSvg(payoffToday(hoverSpot, strike, kind, premium, quantity, dte, iv));
            return (
              <div
                style={{
                  position: 'absolute',
                  left: `${(hx / CHART_VB_W) * 100}%`,
                  top: `${(hy / CHART_VB_H) * 100}%`,
                  transform: 'translate(-50%, -50%)',
                  width: 8, height: 8, borderRadius: '50%',
                  background: '#ffffff', opacity: 0.85,
                }}
              />
            );
          })()}

          {/* Spot marker dot (HTML so it stays a perfect circle). */}
          <div
            style={{
              position: 'absolute',
              left: `${(markerX / CHART_VB_W) * 100}%`,
              top: `${(markerY / CHART_VB_H) * 100}%`,
              transform: 'translate(-50%, -50%)',
              width: 11, height: 11, borderRadius: '50%',
              background: plColor,
              border: '2px solid #ffffff',
              boxSizing: 'border-box',
            }}
          />
        </div>
      </div>

      {/* Sliders row — spans both columns */}
      <div style={{ gridColumn: '1 / -1', gridRow: 2, display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 32, paddingTop: 4 }}>
        <Slider
          label="Time"
          value={`May 11, 19:19 (${dte} DTE)`}
          pct={sliderPctTime}
          onChange={(t) => setDTE(Math.round(initialDTE - t * initialDTE))}
          ticks={[
            { label: 'Now', pct: 0 },
            { label: `Jun ${10 + Math.round(initialDTE / 30 * 8)}`, pct: 1 },
          ]}
        />
        <Slider
          label="IV"
          value={`${Math.round(iv * 100)}%`}
          pct={sliderPctIV}
          onChange={(t) => setIV(+(t * 1.18).toFixed(2))}
          ticks={[
            { label: '0%', pct: 0 },
            { label: '52W L', pct: 0.32 },
            { label: '52W H', pct: 0.68 },
            { label: '118%', pct: 1 },
          ]}
          // 52W L→H shaded range; matches the original "highlightRange" prop on
          // Robinhood's volatility slider (chunk 2902 module 52341).
          highlightRange={{ minPct: 0.32, maxPct: 0.68 }}
          // Reference point: where the original (chain-load-time) IV was.
          // Clicking it resets the slider to that value. Matches "referencePoint".
          referencePoint={{ pct: initialIV / 1.18, onClick: () => setIV(initialIV) }}
          // Delta from referencePoint, shown above the thumb. Matches "thumbText".
          thumbText={Math.abs(iv - initialIV) > 0.005
            ? `${iv >= initialIV ? '+' : ''}${Math.round((iv - initialIV) * 100)}%`
            : undefined}
        />
      </div>
    </div>
  );
}

function Greek({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ color: '#aaaab0', fontSize: 13 }}>{label}</span>
      <span style={{ color: '#f4f4f5', fontSize: 14, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

function Slider({ label, value, pct, onChange, ticks, highlightRange, referencePoint, thumbText }: {
  label: string;
  value: string;
  pct: number;
  onChange: (t: number) => void;
  ticks: Array<{ label: string; pct: number }>;
  // Shaded segment of the track between minPct..maxPct (e.g. 52W L→H).
  highlightRange?: { minPct: number; maxPct: number };
  // Clickable reference marker on the track (e.g. original IV).
  referencePoint?: { pct: number; onClick: () => void };
  // Optional caption rendered above the thumb (e.g. "+5%" delta).
  thumbText?: string;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const updateFromClientX = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    onChange(t);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 13 }}>
        <span style={{ color: '#85858b', fontWeight: 400 }}>{label}</span>
        <span style={{ color: '#f4f4f5', fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{value}</span>
      </div>
      <div
        ref={trackRef}
        onPointerDown={(ev) => {
          (ev.currentTarget as HTMLDivElement).setPointerCapture(ev.pointerId);
          updateFromClientX(ev.clientX);
        }}
        onPointerMove={(ev) => {
          if ((ev.currentTarget as HTMLDivElement).hasPointerCapture(ev.pointerId)) updateFromClientX(ev.clientX);
        }}
        onPointerUp={(ev) => { try { (ev.currentTarget as HTMLDivElement).releasePointerCapture(ev.pointerId); } catch {} }}
        style={{ position: 'relative', height: 26, display: 'flex', alignItems: 'center', cursor: 'pointer' }}
      >
        {/* Track — flat #3d3d3f bar, matches the static exact mock */}
        <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', transform: 'translateY(-50%)', height: 13, background: '#3d3d3f', borderRadius: 2 }} />
        {/* Shaded highlight range (e.g. 52W L→H band on volatility) */}
        {highlightRange ? (
          <div style={{
            position: 'absolute',
            left: `${highlightRange.minPct * 100}%`,
            right: `${(1 - highlightRange.maxPct) * 100}%`,
            top: '50%',
            transform: 'translateY(-50%)',
            height: 13,
            background: '#4a4a4d',
            borderRadius: 0,
          }} />
        ) : null}
        {/* Reference point (clickable to reset) */}
        {referencePoint ? (
          <div
            onPointerDown={(ev) => {
              ev.stopPropagation();
              referencePoint.onClick();
            }}
            style={{
              position: 'absolute',
              left: `${referencePoint.pct * 100}%`,
              top: '50%',
              transform: 'translate(-50%, -50%)',
              width: 7, height: 7, borderRadius: '50%',
              background: '#85858b',
              cursor: 'pointer',
              pointerEvents: 'auto',
            }}
            aria-label="Reset to original"
          />
        ) : null}
        {/* Thumb */}
        <div style={{
          position: 'absolute',
          left: `${pct * 100}%`,
          top: '50%',
          transform: 'translate(-50%, -50%)',
          width: 10, height: 26, borderRadius: 5,
          background: '#f5f5f6',
          boxShadow: '0 1px 4px rgba(0,0,0,.5)',
        }} />
        {/* Thumb caption (delta from reference) */}
        {thumbText ? (
          <span style={{
            position: 'absolute',
            left: `${pct * 100}%`,
            bottom: '100%',
            transform: 'translateX(-50%)',
            marginBottom: 4,
            color: '#f4f4f5',
            fontSize: 11,
            fontVariantNumeric: 'tabular-nums',
            background: 'rgba(0,0,0,.55)',
            padding: '1px 6px',
            borderRadius: 4,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}>
            {thumbText}
          </span>
        ) : null}
      </div>
      {/* Tick labels, positioned along the track */}
      <div style={{ position: 'relative', height: 14 }}>
        {ticks.map((t, i) => {
          const isStart = t.pct <= 0.01;
          const isEnd = t.pct >= 0.99;
          return (
            <span
              key={i}
              style={{
                position: 'absolute',
                left: `${t.pct * 100}%`,
                top: 0,
                transform: isStart ? 'translateX(0)' : isEnd ? 'translateX(-100%)' : 'translateX(-50%)',
                color: '#85858b',
                fontSize: 11,
                fontVariantNumeric: 'tabular-nums',
                whiteSpace: 'nowrap',
              }}
            >
              {t.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}
