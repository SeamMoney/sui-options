'use client';
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';

/* ============================================================
   ROBINHOOD-STYLE OPTIONS ANALYZER
   ============================================================ */

const GREEN     = '#00C805';
const GREEN_FIL = 'rgba(0, 200, 5, 0.18)';
const RED       = '#FF5000';
const TEXT_GRAY = '#5C6063';
const ICON_GRAY = '#9AA0A6';
const LIGHT_GRY = '#C4C7CB';
const HAIRLINE  = '#E8E9EB';
const BG_PILL   = '#EFF0F2';

/* ─────────── ROLLING DIGIT ─────────── */
function RollingDigit({ digit, color = '#000' }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: '0.58em',
        height: '1em',
        overflow: 'hidden',
        verticalAlign: 'baseline',
        lineHeight: '1em',
        position: 'relative',
      }}
    >
      <span
        style={{
          display: 'block',
          transform: `translateY(-${digit * 10}%)`,
          transition: 'transform 650ms cubic-bezier(0.22, 1, 0.36, 1)',
          color,
        }}
      >
        {Array.from({ length: 10 }).map((_, i) => (
          <span key={i} style={{ display: 'block', height: '1em', lineHeight: '1em', textAlign: 'left' }}>
            {i}
          </span>
        ))}
      </span>
    </span>
  );
}

function RollingNumber({ value, decimals = 2, color = '#000', style = {} }) {
  const sign = value >= 0 ? '+' : '−';
  const abs = Math.abs(value).toFixed(decimals);
  const [intPart, decPart] = abs.split('.');
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const chars = decPart ? [...withCommas, '.', ...decPart] : [...withCommas];

  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', whiteSpace: 'nowrap', ...style }}>
      <span style={{ color }}>{sign}$</span>
      {chars.map((c, i) =>
        /\d/.test(c) ? (
          <RollingDigit key={i} digit={parseInt(c, 10)} color={color} />
        ) : (
          <span key={i} style={{ color }}>{c}</span>
        )
      )}
    </span>
  );
}

/* ─────────── OPTION PAYOFF MODEL ─────────── */
// Smooth max(spot - strike, 0). Smoothing scales with DTE.
function softCall(spot, strike, dte, sigmaBase = 0.5) {
  const t = Math.max(0, dte) / 30;
  const sigma = sigmaBase * Math.sqrt(t + 0.0001);
  if (sigma < 0.005) return Math.max(0, spot - strike);
  const u = (spot - strike) / sigma;
  if (u > 30) return spot - strike;
  return sigma * Math.log1p(Math.exp(u));
}

/* Portfolio:
   • 5 × STRC $100 Call, premium $0.20/sh paid ($100 total cost) – hard kink (lower IV)
   • 4 × STRC $105 Call, premium $0.05/sh paid ($20 total cost)  – more ATM time-value (higher IV)
   Total premium paid (max loss) = $120                                                            */
function portfolioPnL(spot, dte) {
  return -120 + 500 * softCall(spot, 100, dte, 0.5) + 400 * softCall(spot, 105, dte, 2.4);
}

/* ─────────── ICONS ─────────── */
const Icon = {
  X:    (p) => <svg viewBox="0 0 24 24" width={22} height={22} {...p}><path d="M5 5l14 14M19 5L5 19" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/></svg>,
  Info: (p) => <svg viewBox="0 0 24 24" width={16} height={16} {...p}><circle cx="12" cy="12" r="10" stroke={ICON_GRAY} strokeWidth="1.6" fill="none"/><circle cx="12" cy="8" r="1" fill={ICON_GRAY}/><path d="M12 11v6" stroke={ICON_GRAY} strokeWidth="1.6" strokeLinecap="round"/></svg>,
  Tri:  (p) => <svg viewBox="0 0 10 9" width={9} height={8} {...p}><path d="M5 0L10 8H0Z" fill={GREEN}/></svg>,
  ChevD:(p) => <svg viewBox="0 0 24 24" width={20} height={20} {...p}><path d="M7 10l5 5 5-5" fill="none" stroke="#000" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  ChevU:(p) => <svg viewBox="0 0 24 24" width={20} height={20} {...p}><path d="M7 14l5-5 5 5" fill="none" stroke="#000" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  ChevR:(p) => <svg viewBox="0 0 24 24" width={18} height={18} {...p}><path d="M9 6l6 6-6 6" fill="none" stroke="#000" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  ChevL:(p) => <svg viewBox="0 0 24 24" width={14} height={14} {...p}><path d="M15 6l-6 6 6 6" fill="none" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  ChevRight:(p) => <svg viewBox="0 0 24 24" width={14} height={14} {...p}><path d="M9 6l6 6-6 6" fill="none" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  Check:(p) => <svg viewBox="0 0 24 24" width={18} height={18} {...p}><path d="M5 12l4.5 4.5L20 6" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  Minus:(p) => <svg viewBox="0 0 24 24" width={20} height={20} {...p}><path d="M6 12h12" stroke="#000" strokeWidth="1.8" strokeLinecap="round"/></svg>,
  Plus: (p) => <svg viewBox="0 0 24 24" width={20} height={20} {...p}><path d="M6 12h12M12 6v12" stroke="#000" strokeWidth="1.8" strokeLinecap="round"/></svg>,
};

/* ─────────── STATUS BAR ─────────── */
function StatusBar({ time = '10:29', battery = '28', lowBattery = false }) {
  const bColor = lowBattery ? '#FF3B30' : '#000';
  return (
    <div style={{
      height: 54, padding: '0 30px', display: 'flex', alignItems: 'center',
      justifyContent: 'space-between', fontSize: 17, fontWeight: 600,
      letterSpacing: -0.2, position: 'relative',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        {time}
        {/* Silenced bell icon (Do Not Disturb mode) */}
        <svg viewBox="0 0 24 24" width={14} height={14}>
          <path d="M6 8a6 6 0 0 1 12 0v5l1.5 2.5h-15L6 13V8z" fill="none" stroke="#000" strokeWidth="1.6" strokeLinejoin="round"/>
          <path d="M10 19a2 2 0 0 0 4 0" fill="none" stroke="#000" strokeWidth="1.6" strokeLinecap="round"/>
          <line x1="4" y1="4" x2="20" y2="20" stroke="#000" strokeWidth="1.8" strokeLinecap="round"/>
        </svg>
      </div>
      <div style={{
        position: 'absolute', left: '50%', top: 11, transform: 'translateX(-50%)',
        width: 124, height: 36, background: '#000', borderRadius: 22,
      }}/>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {/* signal */}
        <svg viewBox="0 0 18 12" width={18} height={11}>
          <rect x="0"  y="8" width="3" height="4" rx="0.5" fill="#000"/>
          <rect x="5"  y="5" width="3" height="7" rx="0.5" fill="#000"/>
          <rect x="10" y="2" width="3" height="10" rx="0.5" fill="#000"/>
          <rect x="15" y="0" width="3" height="12" rx="0.5" fill="#9AA0A6"/>
        </svg>
        {/* wifi */}
        <svg viewBox="0 0 18 14" width={17} height={13}>
          <path d="M9 4.5c2.6 0 4.9 1 6.7 2.6l1.6-1.7C15 3.3 12.1 2 9 2S3 3.3.7 5.4L2.3 7.1A9.5 9.5 0 0 1 9 4.5z" fill="#000"/>
          <path d="M9 8.2c1.6 0 3 .6 4 1.6l1.5-1.6A8 8 0 0 0 9 6.2a8 8 0 0 0-5.5 2.1l1.5 1.5A6 6 0 0 1 9 8.2z" fill="#000"/>
          <circle cx="9" cy="12" r="1.6" fill="#000"/>
        </svg>
        {/* battery */}
        <svg viewBox="0 0 28 14" width={26} height={12}>
          <rect x="0.5" y="0.5" width="24" height="13" rx="3.5" fill="none" stroke={bColor} strokeOpacity="0.4"/>
          <rect x="2"   y="2"   width={Math.max(2, Math.min(22, (parseInt(battery, 10) / 100) * 22))} height="10" rx="1.6" fill={bColor}/>
          <rect x="25"  y="4"   width="2"  height="6"  rx="1" fill={bColor} opacity="0.4"/>
          <text x="9" y="10.5" fontSize="8" fontWeight="700" fill="#fff" textAnchor="middle">{battery}</text>
        </svg>
      </div>
    </div>
  );
}

/* ─────────── CHART ─────────── */
function PayoffChart({ dte, selectedPrice, onSelectPrice }) {
  const W = 360, H = 220;
  const PAD = { top: 18, right: 38, bottom: 36, left: 10 };
  const xMin = 95.5, xMax = 108.8;

  // Y-axis auto-scales to fit the curve at the right edge, with a small headroom.
  // Rounded up to the nearest $100 so labels look clean ($3.5K, $4.2K, etc.).
  const yMag = useMemo(() => {
    const peak = portfolioPnL(xMax, dte);
    const padded = Math.max(2000, peak * 1.05);
    return Math.ceil(padded / 100) * 100;
  }, [dte]);
  const yMin = -yMag, yMax = yMag;

  const xScale = (x) => PAD.left + ((x - xMin) / (xMax - xMin)) * (W - PAD.left - PAD.right);
  const yScale = (y) => PAD.top + (1 - (y - yMin) / (yMax - yMin)) * (H - PAD.top - PAD.bottom);

  // Build curve points
  const { redPath, greenLine, greenFill, crossX, currentY, dotX } = useMemo(() => {
    const samples = [];
    for (let i = 0; i <= 280; i++) {
      const x = xMin + (i / 280) * (xMax - xMin);
      const y = portfolioPnL(x, dte);
      samples.push([x, y]);
    }
    // Find x where curve crosses y = 0 (breakeven)
    let cross = xMin;
    for (let i = 1; i < samples.length; i++) {
      if (samples[i - 1][1] <= 0 && samples[i][1] > 0) {
        const [x0, y0] = samples[i - 1], [x1, y1] = samples[i];
        cross = x0 + (0 - y0) / (y1 - y0) * (x1 - x0);
        break;
      }
    }

    // RED segment: from xMin to cross, following the actual curve
    // (At low DTE it's basically flat at -$120; at high DTE it slopes up)
    let rp = `M ${xScale(xMin)} ${yScale(portfolioPnL(xMin, dte))}`;
    for (const [x, y] of samples) {
      if (x <= cross) rp += ` L ${xScale(x)} ${yScale(y)}`;
    }
    rp += ` L ${xScale(cross)} ${yScale(0)}`;

    // GREEN segment + fill: from cross onward
    let gl = `M ${xScale(cross)} ${yScale(0)}`;
    let gf = `M ${xScale(cross)} ${yScale(0)}`;
    for (const [x, y] of samples) {
      if (x > cross) {
        gl += ` L ${xScale(x)} ${yScale(y)}`;
        gf += ` L ${xScale(x)} ${yScale(y)}`;
      }
    }
    gf += ` L ${xScale(xMax)} ${yScale(0)} Z`;

    const currY = portfolioPnL(selectedPrice, dte);

    return { redPath: rp, greenLine: gl, greenFill: gf, crossX: cross, currentY: currY, dotX: cross };
  }, [dte, selectedPrice]);

  // Vertical grid lines
  const xTicks = [98, 101, 103, 106];
  const yLab = `$${(yMag / 1000).toFixed(1)}K`;
  const yLabNeg = `-$${(yMag / 1000).toFixed(1)}K`;
  const yTicks = [{ v: yMag, lab: yLab }, { v: 0, lab: '$0' }, { v: -yMag, lab: yLabNeg }];

  // Dotted grid pattern
  const gridXs = [];
  for (let x = xMin; x <= xMax; x += 0.45) gridXs.push(xScale(x));
  const gridYs = [0.28, 0.55, 0.85].flatMap((f) => [yScale(f * yMag), yScale(-f * yMag)]);

  const svgRef = useRef(null);
  const onPointer = (clientX) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    const ratio = x / rect.width;
    const svgX = ratio * W;
    let price = xMin + ((svgX - PAD.left) / (W - PAD.left - PAD.right)) * (xMax - xMin);
    price = Math.max(96, Math.min(108, price));
    onSelectPrice(price);
  };

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: '100%', height: 220, display: 'block', cursor: 'crosshair', touchAction: 'none' }}
      onMouseDown={(e) => onPointer(e.clientX)}
      onMouseMove={(e) => e.buttons === 1 && onPointer(e.clientX)}
      onTouchStart={(e) => onPointer(e.touches[0].clientX)}
      onTouchMove={(e) => { e.preventDefault(); onPointer(e.touches[0].clientX); }}
    >
      <defs>
        <clipPath id="chart-clip">
          <rect x={PAD.left - 2} y={0} width={W - PAD.left - PAD.right + 4} height={H - PAD.bottom + 2} />
        </clipPath>
      </defs>
      {/* Dotted grid */}
      <g opacity="0.55">
        {gridYs.map((y, j) =>
          gridXs.map((x, i) => (
            <circle key={`${i}-${j}`} cx={x} cy={y} r={0.55} fill={LIGHT_GRY} />
          ))
        )}
      </g>

      {/* Baseline (y = 0) – very subtle */}
      <line x1={PAD.left} y1={yScale(0)} x2={W - PAD.right} y2={yScale(0)} stroke="#000" strokeWidth="0.6" />

      {/* Vertical strike marker @ breakeven – thin gray line going up from the inflection dot */}
      <line x1={xScale(crossX)} y1={PAD.top + 12} x2={xScale(crossX)} y2={yScale(0)} stroke="#000" strokeOpacity="0.18" strokeWidth="0.9" />

      {/* Filled green area */}
      <path d={greenFill} fill={GREEN_FIL} clipPath="url(#chart-clip)" />

      {/* Red flat loss line */}
      <path d={redPath} stroke={RED} strokeWidth="2.6" strokeLinecap="round" fill="none" clipPath="url(#chart-clip)" />

      {/* Green curve */}
      <path d={greenLine} stroke={GREEN} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" fill="none" clipPath="url(#chart-clip)" />

      {/* Inflection dot(s) – near expiration, show the strike-kink red dot too */}
      {dte < 4 && (
        <circle cx={xScale(100) - 1} cy={yScale(0)} r={3.6} fill={RED} />
      )}
      <circle cx={xScale(crossX)} cy={yScale(0)} r={3.6} fill="#000" />

      {/* Vertical line at selected price */}
      <line x1={xScale(selectedPrice)} y1={PAD.top + 6} x2={xScale(selectedPrice)} y2={H - PAD.bottom} stroke="#000" strokeWidth="0.9" />

      {/* Selected price label */}
      <g transform={`translate(${xScale(selectedPrice)}, ${PAD.top - 4})`}>
        <text textAnchor="middle" fontSize="12.5" fontWeight="700" fill="#000">
          ${selectedPrice.toFixed(2)}
        </text>
      </g>

      {/* Green dot at intersection on curve (more visible at low DTE where curve is piecewise) */}
      {currentY > 50 && (
        <circle cx={xScale(selectedPrice)} cy={yScale(currentY)} r={4.5} fill={GREEN} stroke="#fff" strokeWidth="1.4" />
      )}

      {/* X-axis labels */}
      {xTicks.map((x) => (
        <text key={x} x={xScale(x)} y={H - PAD.bottom + 18} fontSize="11.5" fill={ICON_GRAY} textAnchor="middle">
          ${x}
        </text>
      ))}

      {/* Y-axis labels (right) */}
      {yTicks.map(({ v, lab }) => (
        <text key={v} x={W - 2} y={yScale(v) + 4} fontSize="11.5" fill={ICON_GRAY} textAnchor="end">
          {lab}
        </text>
      ))}
    </svg>
  );
}

/* ─────────── DATE SCRUBBER ─────────── */
function DateScrubber({ value, onChange, max = 31 }) {
  const trackRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  const startDate = useMemo(() => new Date(2026, 4, 18, 10, 29), []); // May 18, 2026 10:29 AM
  const expDate   = useMemo(() => new Date(2026, 5, 18, 13, 0), []);  // Jun 18, 2026 1:00 PM
  const spanMs    = expDate.getTime() - startDate.getTime();

  const currDate = useMemo(() => {
    const ms = startDate.getTime() + (value / max) * spanMs;
    return new Date(ms);
  }, [value, max, startDate, spanMs]);

  const dteRemaining = Math.max(0, Math.round((1 - value / max) * 31));
  const atStart  = value < 0.5;
  const nearExp  = value > max * 0.97;

  const formatPill = (d) => {
    const mo = d.toLocaleString('en-US', { month: 'short' });
    const day = d.getDate();
    const hr = d.getHours();
    const min = d.getMinutes();
    const ampm = hr >= 12 ? 'PM' : 'AM';
    const h12 = ((hr + 11) % 12) + 1;
    const timeStr = min === 0 ? `${h12} ${ampm}` : `${h12}:${String(min).padStart(2,'0')} ${ampm}`;
    return `${mo} ${day}, ${timeStr} (${dteRemaining} DTE)`;
  };

  const onPointerMove = useCallback((clientX) => {
    if (!trackRef.current) return;
    const r = trackRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    onChange(ratio * max);
  }, [max, onChange]);

  useEffect(() => {
    if (!dragging) return;
    const m  = (e) => onPointerMove(e.clientX);
    const u  = () => setDragging(false);
    const tm = (e) => { e.preventDefault(); onPointerMove(e.touches[0].clientX); };
    window.addEventListener('mousemove', m);
    window.addEventListener('mouseup', u);
    window.addEventListener('touchmove', tm, { passive: false });
    window.addEventListener('touchend', u);
    return () => {
      window.removeEventListener('mousemove', m);
      window.removeEventListener('mouseup', u);
      window.removeEventListener('touchmove', tm);
      window.removeEventListener('touchend', u);
    };
  }, [dragging, onPointerMove]);

  const thumbPct = (value / max) * 100;

  // Tick marks — 60 ticks total, taller every 7
  const tickCount = 60;

  // Subtitle label under the pill
  const subLabel = atStart ? 'Current time' : (nearExp ? '2 positions' : null);

  // Dynamic date labels - show 2 dates ahead of current, scaled to thumb position
  const labelData = useMemo(() => {
    if (nearExp) return ['6/16', '6/17', '6/18', 'Exp'];
    const baseDay = new Date(currDate);
    baseDay.setHours(0, 0, 0, 0);
    return [1, 2, 3, 4].map((off) => {
      const d = new Date(baseDay);
      d.setDate(baseDay.getDate() + off);
      const expDay = new Date(expDate); expDay.setHours(0, 0, 0, 0);
      if (d.getTime() > expDay.getTime()) return '';
      if (d.getTime() === expDay.getTime()) return 'Exp';
      return `${d.getMonth() + 1}/${d.getDate()}`;
    });
  }, [currDate, expDate, nearExp]);

  return (
    <div style={{ position: 'relative', userSelect: 'none' }}>
      {/* Date pill */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
        <div style={{
          background: BG_PILL, borderRadius: 18, padding: '7px 16px',
          fontSize: 13, fontWeight: 600, color: '#000', textAlign: 'center',
          minWidth: 180,
        }}>
          {formatPill(currDate)}
          {subLabel && (
            <div style={{ fontSize: 12, fontWeight: 400, color: '#000', opacity: 0.65, marginTop: 1 }}>
              {subLabel}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px' }}>
        {/* "Now" button — only appears once user has scrubbed away from the start */}
        {!atStart && (
          <button
            onClick={() => onChange(0)}
            style={{
              display: 'flex', alignItems: 'center', gap: 3, background: '#fff',
              border: `1px solid ${HAIRLINE}`, borderRadius: 14, padding: '5px 9px 5px 7px',
              fontSize: 12.5, fontWeight: 700, color: '#000', cursor: 'pointer',
              whiteSpace: 'nowrap', flexShrink: 0,
            }}
          >
            <Icon.ChevL /> Now
          </button>
        )}

        {/* Track */}
        <div ref={trackRef} style={{ flex: 1, position: 'relative', height: 44, paddingTop: 6 }}>
          {/* Date labels row */}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: ICON_GRAY, marginBottom: 2 }}>
            {labelData.map((l, i) => (
              <span key={i} style={{ flex: 1, textAlign: 'center' }}>{l}</span>
            ))}
          </div>

          {/* Tick marks + thumb (drag anywhere) */}
          <div
            onMouseDown={(e) => { setDragging(true); onPointerMove(e.clientX); }}
            onTouchStart={(e) => { setDragging(true); onPointerMove(e.touches[0].clientX); }}
            style={{ height: 18, position: 'relative', marginTop: 4, cursor: 'grab', touchAction: 'none' }}
          >
            {Array.from({ length: tickCount }).map((_, i) => {
              const isMajor = i % 7 === 0;
              return (
                <div key={i} style={{
                  position: 'absolute',
                  left: `${(i / (tickCount - 1)) * 100}%`,
                  top: 0,
                  width: 0.8,
                  height: isMajor ? 12 : 7,
                  background: LIGHT_GRY,
                  transform: 'translateX(-50%)',
                  pointerEvents: 'none',
                }} />
              );
            })}

            {/* Thumb */}
            <div
              style={{
                position: 'absolute', top: -8, left: `${thumbPct}%`,
                width: 14, height: 32, transform: 'translateX(-50%)',
                pointerEvents: 'none',
              }}
            >
              <div style={{ position: 'absolute', top: 0, left: '50%', width: 1.2, height: 32, background: '#000', transform: 'translateX(-50%)' }} />
              <div style={{ position: 'absolute', top: -1, left: '50%', width: 6, height: 6, background: '#000', borderRadius: '50%', transform: 'translate(-50%, 0)' }} />
              <div style={{ position: 'absolute', top: 26, left: '50%', width: 6, height: 6, background: '#000', borderRadius: '50%', transform: 'translate(-50%, 0)' }} />
            </div>
          </div>
        </div>

        {/* "Last exp" button */}
        <button
          onClick={() => onChange(max)}
          style={{
            display: 'flex', alignItems: 'center', gap: 3, background: '#fff',
            border: `1px solid ${HAIRLINE}`, borderRadius: 14, padding: '5px 7px 5px 9px',
            fontSize: 12.5, fontWeight: 700, color: '#000', cursor: 'pointer',
            whiteSpace: 'nowrap', flexShrink: 0,
            opacity: nearExp ? 0.35 : 1,
          }}
        >
          Last exp <Icon.ChevRight />
        </button>
      </div>
    </div>
  );
}

/* ─────────── POSITION CARD ─────────── */
function PositionCard({ pos, expanded, checked, onToggleExpand, onToggleCheck, onAction }) {
  const valueColor = pos.gain >= 0 ? GREEN : RED;

  return (
    <div style={{
      border: expanded ? `1px solid ${HAIRLINE}` : 'none',
      borderRadius: expanded ? 14 : 0,
      borderBottom: expanded ? `1px solid ${HAIRLINE}` : `1px solid ${HAIRLINE}`,
      padding: expanded ? '16px 14px 16px 14px' : '14px 0',
      background: '#fff',
      marginBottom: expanded ? 8 : 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <button
          onClick={(e) => { e.stopPropagation(); onToggleCheck(); }}
          style={{
            width: 24, height: 24, borderRadius: 5, flexShrink: 0,
            background: checked ? '#000' : '#fff',
            border: `1.5px solid ${checked ? '#000' : '#C4C7CB'}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', padding: 0, marginTop: 1,
          }}
        >
          {checked && <Icon.Check />}
        </button>

        <div
          style={{ flex: 1, cursor: 'pointer' }}
          onClick={onToggleExpand}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15.5, color: '#000' }}>{pos.title}</div>
              <div style={{ fontSize: 12.5, color: TEXT_GRAY, marginTop: 2 }}>{pos.subtitle}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontWeight: 700, fontSize: 15.5, color: '#000' }}>{pos.value}</div>
              <div style={{ fontSize: 12.5, color: valueColor, marginTop: 2 }}>{pos.pct}</div>
            </div>
            <div style={{ marginLeft: 8, paddingTop: 2 }}>
              {expanded ? <Icon.ChevU /> : <Icon.ChevD />}
            </div>
          </div>
        </div>
      </div>

      {expanded && (
        <div style={{ marginTop: 18 }}>
          {/* Greeks grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', rowGap: 14, marginBottom: 8 }}>
            {[
              ['Delta', pos.delta],
              ['Gamma', pos.gamma],
              ['Theta', pos.theta],
              ['Vega', pos.vega],
              ['Current price', pos.curr],
              ['Avg cost', pos.avg],
            ].map(([k, v], i) => (
              <div key={k}>
                <div style={{ fontSize: 12.5, color: TEXT_GRAY }}>{k}</div>
                <div style={{ fontSize: 15, fontWeight: 500, color: '#000', marginTop: 2 }}>{v}</div>
              </div>
            ))}
          </div>

          {/* View details */}
          <div style={{ borderTop: `1px solid ${HAIRLINE}`, marginTop: 10, paddingTop: 14, paddingBottom: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
            <span style={{ fontSize: 15, fontWeight: 500, color: '#000' }}>View details</span>
            <Icon.ChevR />
          </div>

          {/* Quantity */}
          <div style={{ borderTop: `1px solid ${HAIRLINE}`, marginTop: 10, paddingTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 15, fontWeight: 500, color: '#000' }}>Quantity: 0</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 0, border: `1px solid ${HAIRLINE}`, borderRadius: 22 }}>
              <button style={{ width: 44, height: 36, background: 'transparent', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                <Icon.Minus />
              </button>
              <div style={{ width: 1, height: 18, background: HAIRLINE }} />
              <button style={{ width: 44, height: 36, background: 'transparent', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                <Icon.Plus />
              </button>
            </div>
          </div>

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
            {['Roll', 'Open', 'Close'].map((label) => (
              <button
                key={label}
                onClick={() => onAction && onAction(label)}
                style={{
                  flex: 1, height: 44, background: GREEN, color: '#fff', border: 'none',
                  borderRadius: 22, fontSize: 15, fontWeight: 700, cursor: 'pointer',
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────── PHONE FRAME ─────────── */
export function PhoneFrame({ children }) {
  return (
    <div style={{
      minHeight: '100vh', background: '#E5E7EB',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif',
      WebkitFontSmoothing: 'antialiased',
    }}>
      <div style={{
        width: 393, height: 852, background: '#fff', color: '#000', borderRadius: 54,
        overflow: 'hidden', position: 'relative',
        boxShadow: '0 30px 60px rgba(0,0,0,0.25), 0 0 0 12px #1c1c1e, 0 0 0 14px #2c2c2e',
        display: 'flex', flexDirection: 'column',
      }}>
        {children}
      </div>
    </div>
  );
}

/* ─────────── ROLL PAGE ─────────── */
export function RollPage({ position, onBack, onPickNew, time = '11:19' }) {
  return (
    <>
      <StatusBar time={time} />
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 18px 0' }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <Icon.ChevL />
        </button>
        <button style={{
          width: 28, height: 28, borderRadius: '50%', border: `1.5px solid ${ICON_GRAY}`,
          background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', padding: 0,
        }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: ICON_GRAY, lineHeight: 1 }}>!</span>
        </button>
      </div>

      {/* Title bar with subtle gray background */}
      <div style={{ background: '#F4F5F6', padding: '40px 22px 18px' }}>
        <div style={{ fontSize: 32, fontWeight: 700, color: '#000', letterSpacing: -0.5 }}>
          Long Call Roll
        </div>
        <div style={{ fontSize: 15, color: '#000', marginTop: 4 }}>
          Select a new position to open
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px 24px', display: 'flex', flexDirection: 'column', gap: 0 }}>
        {/* Current position card */}
        <div style={{
          background: '#F4F5F6', borderRadius: 14, padding: '18px 18px 22px',
        }}>
          <div style={{ fontSize: 13, color: TEXT_GRAY }}>Current position</div>
          <div style={{ fontSize: 21, fontWeight: 700, color: '#000', marginTop: 4 }}>
            {position.title}
          </div>
          <div style={{ fontSize: 14, color: '#000', marginTop: 2 }}>
            6/18 · {position.contracts} Sells to Close
          </div>
          <div style={{ height: 1, background: HAIRLINE, margin: '14px 0' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 13, color: TEXT_GRAY }}>Time left</div>
              <div style={{ fontSize: 16, fontWeight: 500, color: '#000', marginTop: 4 }}>31 Days</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 13, color: TEXT_GRAY }}>Credit</div>
              <div style={{ fontSize: 16, fontWeight: 500, color: '#000', marginTop: 4 }}>$0.08</div>
            </div>
          </div>
        </div>

        {/* Connector arrow */}
        <div style={{ display: 'flex', justifyContent: 'center', margin: '-12px 0' }}>
          <div style={{
            width: 26, height: 26, borderRadius: '50%', background: '#000',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            position: 'relative', zIndex: 2,
          }}>
            <svg viewBox="0 0 24 24" width={14} height={14}>
              <path d="M12 5v14M6 13l6 6 6-6" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>

        {/* New position placeholder */}
        <button
          onClick={onPickNew}
          style={{
            border: `1px solid ${HAIRLINE}`, borderRadius: 14, padding: '60px 18px',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            background: '#fff', cursor: 'pointer', width: '100%',
          }}
        >
          <div style={{
            width: 32, height: 32, borderRadius: '50%', border: `2px solid ${GREEN}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg viewBox="0 0 24 24" width={18} height={18}>
              <path d="M12 5v14M5 12h14" stroke={GREEN} strokeWidth="2.4" strokeLinecap="round" />
            </svg>
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, color: GREEN, marginTop: 10, textDecoration: 'underline', textUnderlineOffset: 3 }}>
            Select new position
          </div>
        </button>
      </div>

      {/* Bottom learn link */}
      <div style={{ padding: '14px 18px 30px', textAlign: 'center' }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#000', textDecoration: 'underline', textUnderlineOffset: 3 }}>
          Learn about rolling
        </span>
      </div>
    </>
  );
}

/* ─────────── OPTIONS CHAIN PAGE ─────────── */
const SHARE_PRICE = 98.81;
const CHAIN_DATA = [
  // strikes ABOVE current share price (OTM calls — green pill)
  { strike: 115, price: 0.10, today: 0.00,   heldQty: 0 },
  { strike: 110, price: 0.05, today: 0.00,   heldQty: 0 },
  { strike: 105, price: 0.05, today: 0.00,   heldQty: 4 },
  { strike: 100, price: 0.10, today: 0.00,   heldQty: 5 },
  // strikes BELOW share price (ITM calls — orange pill if losing today)
  { strike: 95,  price: 4.40, today: -7.53,  heldQty: 0 },
  { strike: 90,  price: 12.60, today: -10.92, heldQty: 0 },
  { strike: 85,  price: 17.40, today: 1.01,   heldQty: 0 },
];

export function OptionsChain({ onBack, onPickContract, highlightStrike = 105, time = '2:36' }) {
  const [expiry, setExpiry] = useState('Jun 18');

  return (
    <>
      <StatusBar time={time} battery="19" lowBattery />
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px 4px' }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
          <Icon.X />
        </button>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontWeight: 700, fontSize: 16, color: '#000' }}>STRC</div>
          <div style={{ fontSize: 13, color: TEXT_GRAY, marginTop: 1 }}>Individual investing</div>
        </div>
        <button style={{ background: 'none', border: 'none', cursor: 'pointer', position: 'relative', padding: 0 }}>
          <svg viewBox="0 0 24 24" width={24} height={24}>
            <circle cx="12" cy="12" r="3" fill="none" stroke="#000" strokeWidth="2"/>
            <path d="M12 1v2m0 18v2M4.2 4.2l1.4 1.4m12.8 12.8l1.4 1.4M1 12h2m18 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" stroke="#000" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          <div style={{ position: 'absolute', top: 0, right: 0, width: 8, height: 8, borderRadius: '50%', background: GREEN, border: '1.5px solid #fff' }} />
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, padding: '14px 18px 12px', overflowX: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg viewBox="0 0 24 24" width={20} height={20}>
            <rect x="3" y="3" width="7" height="7" rx="1.5" fill={RED}/>
            <rect x="14" y="3" width="7" height="7" rx="1.5" fill={RED}/>
            <rect x="3" y="14" width="7" height="7" rx="1.5" fill={RED}/>
            <rect x="14" y="14" width="7" height="7" rx="1.5" fill={RED}/>
          </svg>
          <span style={{ fontSize: 16, fontWeight: 700, color: RED }}>Builder</span>
        </div>
        {['Jun 18', 'Jul 17', 'Sep 18', 'Dec 18'].map((d) => (
          <button
            key={d}
            onClick={() => setExpiry(d)}
            style={{
              background: expiry === d ? RED : 'transparent',
              color: expiry === d ? '#fff' : RED,
              border: 'none', borderRadius: 14,
              padding: expiry === d ? '6px 12px' : '6px 0',
              fontSize: 16, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            {d}
          </button>
        ))}
      </div>

      {/* Buy/Sell + Call/Put toggles */}
      <div style={{ display: 'flex', gap: 10, padding: '4px 18px 12px' }}>
        <div style={{ flex: 1, display: 'flex', background: BG_PILL, borderRadius: 22, padding: 3, position: 'relative' }}>
          <div style={{
            position: 'absolute', top: 3, bottom: 3, left: 3, width: 'calc(50% - 3px)',
            background: '#fff', borderRadius: 20, boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
          }} />
          <button style={{ flex: 1, height: 32, background: 'transparent', border: 'none', position: 'relative', zIndex: 1, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>Buy</button>
          <button style={{ flex: 1, height: 32, background: 'transparent', border: 'none', position: 'relative', zIndex: 1, fontSize: 14, fontWeight: 500, color: TEXT_GRAY, cursor: 'pointer' }}>Sell</button>
        </div>
        <div style={{ flex: 1, display: 'flex', background: BG_PILL, borderRadius: 22, padding: 3, position: 'relative' }}>
          <div style={{
            position: 'absolute', top: 3, bottom: 3, left: 3, width: 'calc(50% - 3px)',
            background: '#fff', borderRadius: 20, boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
          }} />
          <button style={{ flex: 1, height: 32, background: 'transparent', border: 'none', position: 'relative', zIndex: 1, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>Call</button>
          <button style={{ flex: 1, height: 32, background: 'transparent', border: 'none', position: 'relative', zIndex: 1, fontSize: 14, fontWeight: 500, color: TEXT_GRAY, cursor: 'pointer' }}>Put</button>
        </div>
      </div>

      {/* Chain list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {CHAIN_DATA.map((row, idx) => {
          const isHighlighted = row.strike === highlightStrike;
          const isOTM = row.strike > SHARE_PRICE;
          // Pill color: green if today's change >= 0, orange otherwise
          const pillColor = row.today >= 0 ? GREEN : RED;
          const breakeven = (row.strike + row.price).toFixed(2);
          const toBE = ((row.strike + row.price - SHARE_PRICE) / SHARE_PRICE) * 100;
          // Insert "Share price" divider just before strikes that are below share price
          const insertShareDivider = idx > 0 && CHAIN_DATA[idx - 1].strike > SHARE_PRICE && row.strike < SHARE_PRICE;

          return (
            <React.Fragment key={row.strike}>
              {insertShareDivider && (
                <div style={{ padding: '12px 18px', background: '#F4F5F6', textAlign: 'center', fontSize: 14, fontWeight: 700, color: RED }}>
                  Share price: ${SHARE_PRICE}
                </div>
              )}
              <button
                onClick={() => onPickContract({ strike: row.strike, price: row.price, today: row.today })}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  width: '100%', background: isHighlighted ? '#E9F8E7' : 'transparent',
                  border: 'none', borderBottom: `1px solid ${HAIRLINE}`,
                  padding: '14px 18px', cursor: 'pointer', textAlign: 'left',
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontSize: 21, fontWeight: 600, color: '#000' }}>${row.strike} Call</span>
                    {row.heldQty > 0 && (
                      <span style={{ fontSize: 14, color: GREEN, fontWeight: 700 }}>+{row.heldQty}</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 22, marginTop: 6 }}>
                    <div>
                      <div style={{ fontSize: 12, color: TEXT_GRAY }}>Breakeven</div>
                      <div style={{ fontSize: 13, color: '#000', marginTop: 2 }}>${breakeven}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 12, color: TEXT_GRAY }}>To breakeven</div>
                      <div style={{ fontSize: 13, color: '#000', marginTop: 2 }}>{toBE >= 0 ? '+' : ''}{toBE.toFixed(2)}%</div>
                    </div>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{
                    display: 'inline-flex', alignItems: 'center',
                    border: `2px solid ${pillColor}`, borderRadius: 22, padding: 0,
                  }}>
                    <span style={{ padding: '6px 12px', fontSize: 16, fontWeight: 700, color: pillColor }}>
                      ${row.price.toFixed(2)}
                    </span>
                    <div style={{ width: 1, height: 22, background: pillColor }} />
                    <div style={{ padding: '6px 10px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg viewBox="0 0 24 24" width={16} height={16}>
                        <path d="M12 5v14M5 12h14" stroke={pillColor} strokeWidth="2.2" strokeLinecap="round" />
                      </svg>
                    </div>
                  </div>
                  <div style={{ fontSize: 13, color: pillColor, fontWeight: 600, marginTop: 6 }}>
                    {row.today >= 0 ? '+' : ''}{row.today.toFixed(2)}% <span style={{ color: TEXT_GRAY, fontWeight: 400 }}>Today</span>
                  </div>
                </div>
              </button>
            </React.Fragment>
          );
        })}
      </div>
    </>
  );
}

/* ─────────── SIMULATED RETURNS SHEET ─────────── */
export function SimReturnsSheet({ contract, onBack, onContinue, time = '2:36' }) {
  // time goes 0..31 days from now toward expiration
  const [tDays, setTDays] = useState(31); // start at expiration (matches image 2)
  const [chartPx, setChartPx] = useState(null); // null = no price selection, just show curve

  const strike = contract.strike;
  const premium = contract.price; // per-share
  const cost = premium * 100;

  const W = 360, H = 200;
  const PAD = { top: 24, right: 38, bottom: 30, left: 14 };
  const xMin = 95.5, xMax = 108.8;
  const xs = (x) => PAD.left + ((x - xMin) / (xMax - xMin)) * (W - PAD.left - PAD.right);

  // payoff for one long call at given DTE
  const callValue = (spot, dte) => {
    return softCall(spot, strike, dte, dte > 20 ? 2.2 : 0.6);
  };
  const pnlAt = (spot, dte) => (callValue(spot, dte) - premium) * 100;

  // Y axis auto-scales to right edge
  const dteForChart = 31 - tDays;
  const peakY = Math.max(50, pnlAt(xMax, dteForChart));
  const yMag = Math.ceil(peakY / 1) * 1; // exact value (e.g. $203)
  const ys = (y) => PAD.top + (1 - (y - (-yMag)) / (2 * yMag)) * (H - PAD.top - PAD.bottom);

  // Build curve path
  const samples = [];
  for (let i = 0; i <= 200; i++) {
    const x = xMin + (i / 200) * (xMax - xMin);
    samples.push([x, pnlAt(x, dteForChart)]);
  }
  let cross = strike;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1][1] <= 0 && samples[i][1] > 0) {
      const [x0, y0] = samples[i - 1], [x1, y1] = samples[i];
      cross = x0 + (0 - y0) / (y1 - y0) * (x1 - x0);
      break;
    }
  }

  let redPath = `M ${xs(xMin)} ${ys(pnlAt(xMin, dteForChart))}`;
  for (const [x, y] of samples) if (x <= cross) redPath += ` L ${xs(x)} ${ys(y)}`;
  redPath += ` L ${xs(cross)} ${ys(0)}`;

  let greenLine = `M ${xs(cross)} ${ys(0)}`;
  let greenFill = `M ${xs(cross)} ${ys(0)}`;
  for (const [x, y] of samples) if (x > cross) {
    greenLine += ` L ${xs(x)} ${ys(y)}`;
    greenFill += ` L ${xs(x)} ${ys(y)}`;
  }
  greenFill += ` L ${xs(xMax)} ${ys(0)} Z`;

  // Date pill calc
  const startDate = new Date(2026, 4, 18, 13, 0);
  const expDate = new Date(2026, 5, 18, 13, 0);
  const curDate = new Date(startDate.getTime() + (tDays / 31) * (expDate.getTime() - startDate.getTime()));
  const formatPill = (d) => {
    const mo = d.toLocaleString('en-US', { month: 'short' });
    const day = d.getDate();
    const hr = d.getHours();
    const ampm = hr >= 12 ? 'PM' : 'AM';
    const h12 = ((hr + 11) % 12) + 1;
    return `${mo} ${day}, ${h12}:00 ${ampm} (${Math.max(0, 31 - tDays)} DTE)`;
  };
  const atStart = tDays < 0.5;
  const nearExp = tDays > 30.5;
  const subtitle = !atStart && !nearExp ? 'Time' : null;

  // Scrubber labels around current tDays
  const labelData = useMemo(() => {
    if (nearExp) return ['6/17', '6/18', 'Exp'];
    const baseDay = new Date(curDate); baseDay.setHours(0, 0, 0, 0);
    return [-1, 0, 1, 2, 3].map((off) => {
      const d = new Date(baseDay);
      d.setDate(baseDay.getDate() + off);
      const expDay = new Date(expDate); expDay.setHours(0, 0, 0, 0);
      if (d.getTime() > expDay.getTime()) return '';
      if (d.getTime() === expDay.getTime()) return 'Exp';
      return `${d.getMonth() + 1}/${d.getDate()}`;
    });
  }, [curDate, expDate, nearExp]);

  // Scrubber drag
  const trackRef = useRef(null);
  const [drag, setDrag] = useState(false);
  const onDrag = useCallback((cx) => {
    if (!trackRef.current) return;
    const r = trackRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (cx - r.left) / r.width));
    setTDays(ratio * 31);
  }, []);
  useEffect(() => {
    if (!drag) return;
    const m  = (e) => onDrag(e.clientX);
    const u  = () => setDrag(false);
    const tm = (e) => { e.preventDefault(); onDrag(e.touches[0].clientX); };
    window.addEventListener('mousemove', m);
    window.addEventListener('mouseup', u);
    window.addEventListener('touchmove', tm, { passive: false });
    window.addEventListener('touchend', u);
    return () => {
      window.removeEventListener('mousemove', m);
      window.removeEventListener('mouseup', u);
      window.removeEventListener('touchmove', tm);
      window.removeEventListener('touchend', u);
    };
  }, [drag, onDrag]);

  // Chart price drag
  const svgRef = useRef(null);
  const onChartPick = (clientX) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const r = (clientX - rect.left) / rect.width;
    const svgX = r * W;
    let p = xMin + ((svgX - PAD.left) / (W - PAD.left - PAD.right)) * (xMax - xMin);
    p = Math.max(xMin + 0.5, Math.min(xMax - 0.3, p));
    setChartPx(p);
  };

  // Estimated profit & contract price at selected point
  const estPnL = chartPx != null ? pnlAt(chartPx, dteForChart) : null;
  const estCallVal = chartPx != null ? callValue(chartPx, dteForChart) : null;
  const estCallChg = chartPx != null ? (estCallVal - premium) : null;

  return (
    <>
      <StatusBar time={time} battery="19" lowBattery />
      {/* Drag handle */}
      <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 4px' }}>
        <div style={{ width: 38, height: 5, borderRadius: 3, background: '#C4C7CB' }} />
      </div>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '8px 18px 12px' }}>
        <div>
          <div style={{ fontSize: 21, fontWeight: 700, color: '#000' }}>
            Buy ${strike} Call 6/18
          </div>
          <div style={{ fontSize: 14, color: TEXT_GRAY, marginTop: 2 }}>
            ${premium.toFixed(2)} cost
          </div>
        </div>
        <button
          onClick={onContinue}
          style={{
            width: 38, height: 38, borderRadius: '50%', border: `1.5px solid ${TEXT_GRAY}`,
            background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', padding: 0,
          }}
        >
          <svg viewBox="0 0 24 24" width={20} height={20}>
            <path d="M12 5v14M5 12h14" stroke="#000" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {/* Either summary OR est P&L row */}
        {chartPx == null ? (
          <div style={{ padding: '0 18px 6px', display: 'flex', justifyContent: 'space-around', textAlign: 'center' }}>
            <div>
              <div style={{ fontSize: 13, color: TEXT_GRAY }}>Max profit</div>
              <div style={{ fontSize: 16, color: '#000', marginTop: 3 }}>Unlimited</div>
            </div>
            <div>
              <div style={{ fontSize: 13, color: TEXT_GRAY }}>Breakeven</div>
              <div style={{ fontSize: 16, color: '#000', marginTop: 3 }}>${(strike + premium).toFixed(2)}</div>
            </div>
            <div>
              <div style={{ fontSize: 13, color: TEXT_GRAY }}>Max loss</div>
              <div style={{ fontSize: 16, color: '#000', marginTop: 3 }}>-${cost.toFixed(2)}</div>
            </div>
          </div>
        ) : (
          <div style={{ padding: '0 18px 6px', display: 'flex', gap: 30 }}>
            <div>
              <div style={{ fontSize: 13, color: TEXT_GRAY }}>Est profit &amp; loss</div>
              <div style={{ fontSize: 17, fontWeight: 700, color: estPnL >= 0 ? GREEN : RED, marginTop: 3 }}>
                {estPnL >= 0 ? '+' : '-'}${Math.abs(estPnL).toFixed(2)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 13, color: TEXT_GRAY }}>Est contract price</div>
              <div style={{ fontSize: 17, color: '#000', marginTop: 3 }}>
                {estCallChg >= 0 ? '+' : '-'}${Math.abs(estCallChg).toFixed(2)}
              </div>
            </div>
          </div>
        )}

        {/* Chart */}
        <div style={{ padding: '6px 6px 0' }}>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            style={{ width: '100%', height: H, cursor: 'crosshair', touchAction: 'none' }}
            onMouseDown={(e) => onChartPick(e.clientX)}
            onMouseMove={(e) => e.buttons === 1 && onChartPick(e.clientX)}
            onTouchStart={(e) => onChartPick(e.touches[0].clientX)}
            onTouchMove={(e) => { e.preventDefault(); onChartPick(e.touches[0].clientX); }}
          >
            {/* Dotted grid */}
            <g opacity="0.5">
              {[0.3, 0.6, 0.9].flatMap((f) => [ys(f * yMag), ys(-f * yMag)]).map((y, j) => {
                const xs2 = [];
                for (let x = xMin; x <= xMax; x += 0.5) xs2.push(xs(x));
                return xs2.map((cx, i) => <circle key={`${i}-${j}`} cx={cx} cy={y} r={0.55} fill={LIGHT_GRY} />);
              })}
            </g>
            {/* Baseline */}
            <line x1={PAD.left} y1={ys(0)} x2={W - PAD.right} y2={ys(0)} stroke="#000" strokeWidth="0.6" />
            {/* Stock price reference line at $98.81 (always shown) */}
            <line x1={xs(SHARE_PRICE)} y1={PAD.top + 8} x2={xs(SHARE_PRICE)} y2={H - PAD.bottom} stroke="#000" strokeOpacity="0.25" strokeWidth="0.9" />
            <text x={xs(SHARE_PRICE)} y={PAD.top + 2} textAnchor="middle" fontSize="13" fill={ICON_GRAY} fontWeight="600">${SHARE_PRICE}</text>
            {/* Filled */}
            <path d={greenFill} fill={GREEN_FIL} />
            {/* Red flat */}
            <path d={redPath} stroke={RED} strokeWidth="2.6" strokeLinecap="round" fill="none" />
            {/* Green curve */}
            <path d={greenLine} stroke={GREEN} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            {/* Orange kink dot */}
            <circle cx={xs(cross)} cy={ys(0)} r={4.5} fill={RED} stroke="#fff" strokeWidth="1.2" />
            {/* Selected price vertical line + label */}
            {chartPx != null && (
              <>
                <line x1={xs(chartPx)} y1={PAD.top + 6} x2={xs(chartPx)} y2={H - PAD.bottom} stroke="#000" strokeWidth="1" />
                <text x={xs(chartPx)} y={PAD.top - 2} textAnchor="middle" fontSize="13" fontWeight="700" fill="#000">
                  ${chartPx.toFixed(2)}
                </text>
              </>
            )}
            {/* x labels */}
            {[98, 101, 103, 106].map((x) => (
              <text key={x} x={xs(x)} y={H - PAD.bottom + 18} fontSize="11.5" fill={ICON_GRAY} textAnchor="middle">${x}</text>
            ))}
            {/* y labels */}
            <text x={W - 2} y={ys(yMag) + 4} fontSize="11.5" fill={ICON_GRAY} textAnchor="end">${Math.round(yMag)}</text>
            <text x={W - 2} y={ys(0) + 4} fontSize="11.5" fill={ICON_GRAY} textAnchor="end">$0</text>
            <text x={W - 2} y={ys(-yMag) + 4} fontSize="11.5" fill={ICON_GRAY} textAnchor="end">-${Math.round(yMag)}</text>
          </svg>
        </div>

        {/* Date pill */}
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 8 }}>
          <div style={{
            background: BG_PILL, borderRadius: 18, padding: '7px 16px',
            fontSize: 13, fontWeight: 600, color: '#000', textAlign: 'center',
            minWidth: 180,
          }}>
            {formatPill(curDate)}
            {subtitle && (
              <div style={{ fontSize: 12, fontWeight: 400, color: '#000', opacity: 0.65, marginTop: 1 }}>
                {subtitle}
              </div>
            )}
          </div>
        </div>

        {/* Time scrubber */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 12px 16px' }}>
          {!atStart && (
            <button
              onClick={() => setTDays(0)}
              style={{
                display: 'flex', alignItems: 'center', gap: 3, background: '#fff',
                border: `1px solid ${HAIRLINE}`, borderRadius: 14, padding: '5px 9px 5px 7px',
                fontSize: 12.5, fontWeight: 700, color: '#000', cursor: 'pointer',
                whiteSpace: 'nowrap', flexShrink: 0,
              }}
            >
              <Icon.ChevL /> Now
            </button>
          )}
          <div ref={trackRef} style={{ flex: 1, position: 'relative', height: 40 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: ICON_GRAY, marginBottom: 4 }}>
              {labelData.map((l, i) => (
                <span key={i} style={{ flex: 1, textAlign: 'center' }}>{l}</span>
              ))}
            </div>
            <div
              onMouseDown={(e) => { setDrag(true); onDrag(e.clientX); }}
              onTouchStart={(e) => { setDrag(true); onDrag(e.touches[0].clientX); }}
              style={{ height: 14, position: 'relative', cursor: 'grab', touchAction: 'none' }}
            >
              {Array.from({ length: 56 }).map((_, i) => (
                <div key={i} style={{
                  position: 'absolute', left: `${(i / 55) * 100}%`, top: 0,
                  width: 0.8, height: i % 7 === 0 ? 11 : 6,
                  background: LIGHT_GRY, transform: 'translateX(-50%)', pointerEvents: 'none',
                }} />
              ))}
              <div style={{
                position: 'absolute', top: -8, left: `${(tDays / 31) * 100}%`,
                width: 14, height: 30, transform: 'translateX(-50%)',
                pointerEvents: 'none',
              }}>
                <div style={{ position: 'absolute', top: 0, left: '50%', width: 1.2, height: 30, background: '#000', transform: 'translateX(-50%)' }} />
                <div style={{ position: 'absolute', top: -1, left: '50%', width: 6, height: 6, background: '#000', borderRadius: '50%', transform: 'translate(-50%, 0)' }} />
                <div style={{ position: 'absolute', top: 24, left: '50%', width: 6, height: 6, background: '#000', borderRadius: '50%', transform: 'translate(-50%, 0)' }} />
              </div>
            </div>
          </div>
          {!nearExp && (
            <button
              onClick={() => setTDays(31)}
              style={{
                display: 'flex', alignItems: 'center', gap: 3, background: '#fff',
                border: `1px solid ${HAIRLINE}`, borderRadius: 14, padding: '5px 7px 5px 9px',
                fontSize: 12.5, fontWeight: 700, color: '#000', cursor: 'pointer',
                whiteSpace: 'nowrap', flexShrink: 0,
              }}
            >
              Exp <Icon.ChevRight />
            </button>
          )}
        </div>

        {/* Contracts section */}
        <div style={{ padding: '16px 18px 4px' }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#000', marginBottom: 12 }}>Contracts</div>
          <div style={{ borderTop: `1px solid ${HAIRLINE}` }} />
          <button
            onClick={onContinue}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '14px 0', background: 'transparent', border: 'none',
              borderBottom: `1px solid ${HAIRLINE}`, cursor: 'pointer', textAlign: 'left',
            }}
          >
            <div>
              <div style={{ fontSize: 15, fontWeight: 500, color: '#000' }}>${strike} Call 6/18</div>
              <div style={{ fontSize: 13, color: TEXT_GRAY, marginTop: 2 }}>1 buy to open</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 15, color: '#000' }}>${premium.toFixed(2)}</span>
              <Icon.ChevR />
            </div>
          </button>
        </div>

        <div style={{ textAlign: 'center', fontSize: 13, color: TEXT_GRAY, padding: '20px 18px 16px' }}>
          Learn about Simulated Returns and its risks
          <svg viewBox="0 0 24 24" width={12} height={12} style={{ marginLeft: 4, verticalAlign: -1 }}>
            <path d="M7 17L17 7M9 7h8v8" fill="none" stroke={TEXT_GRAY} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </div>

      {/* Bottom Continue button */}
      <div style={{ padding: '12px 14px 18px', borderTop: `1px solid ${HAIRLINE}` }}>
        <button
          onClick={onContinue}
          style={{
            width: '100%', height: 52, background: GREEN, color: '#fff', border: 'none',
            borderRadius: 26, fontSize: 16, fontWeight: 700, cursor: 'pointer',
          }}
        >
          Continue
        </button>
      </div>
    </>
  );
}

/* ─────────── ORDER ENTRY (OPEN) PAGE ─────────── */
export function OpenPage({ position, onBack, time = '2:37' }) {
  const [chartExpanded, setChartExpanded] = useState(false); // chart starts collapsed (image 5)
  const [costExpanded, setCostExpanded] = useState(false);
  const [showNumpad, setShowNumpad] = useState(true); // collapsing the chart shows numpad
  const [chartPx, setChartPx] = useState(null); // for price scrubbing on the expanded chart

  // Parse strike from title like "STRC $105 Call"
  const strikeMatch = /\$(\d+)/.exec(position.title);
  const strike = strikeMatch ? parseInt(strikeMatch[1], 10) : 105;
  const limitPrice = strike === 105 ? 0.05 : 0.10;
  const qty = 1;
  const multiplier = 100;
  const regulatoryFee = 0.04;
  const cost = (limitPrice * multiplier * qty + regulatoryFee).toFixed(2);
  const breakeven = (strike + limitPrice).toFixed(2);
  const maxLoss = (limitPrice * multiplier * qty).toFixed(2);
  const currentPx = 98.81;

  // Chart geometry
  const W = 360, H = 200;
  const PAD = { top: 18, right: 8, bottom: 28, left: 28 };
  const xMin = 94, xMax = 112;
  const xs = (x) => PAD.left + ((x - xMin) / (xMax - xMin)) * (W - PAD.left - PAD.right);
  const yC = PAD.top + (H - PAD.top - PAD.bottom) * 0.62;
  const yT = PAD.top + 2;
  const yB = H - PAD.bottom;
  const xCur = xs(currentPx);
  const xStr = xs(strike);
  const xEnd = xs(xMax);
  const yEnd = yT + 6; // curve hits near top right

  // For price scrubbing
  const callValueAtExp = (spot) => Math.max(0, spot - strike) * multiplier - limitPrice * multiplier;
  const svgRef = useRef(null);
  const onChartPick = (clientX) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const r = (clientX - rect.left) / rect.width;
    const svgX = r * W;
    let p = xMin + ((svgX - PAD.left) / (W - PAD.left - PAD.right)) * (xMax - xMin);
    p = Math.max(95, Math.min(111, p));
    setChartPx(p);
  };
  const expectedPnL = chartPx != null ? callValueAtExp(chartPx) : null;

  return (
    <>
      <StatusBar time={time} battery="19" lowBattery />

      {/* Top bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 18px 0' }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <svg viewBox="0 0 24 24" width={24} height={24}>
            <path d="M5 5l14 14M19 5L5 19" stroke={GREEN} strokeWidth="2.4" strokeLinecap="round"/>
          </svg>
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 17, fontWeight: 700, color: '#000' }}>
          Limit order
          <svg viewBox="0 0 24 24" width={20} height={20}>
            <path d="M7 10l5 5 5-5" fill="none" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        {/* Buy STRC row */}
        <div style={{ padding: '20px 18px 16px', borderBottom: `1px solid ${HAIRLINE}`, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 600, color: '#000' }}>
              Buy STRC ${strike} Call 6/18
            </div>
            <div style={{ fontSize: 13, color: TEXT_GRAY, marginTop: 4 }}>
              STRC ${currentPx} · $2.00 available
            </div>
          </div>
          <div style={{ fontSize: 22, color: showNumpad ? GREEN : ICON_GRAY, fontWeight: 400, borderRight: showNumpad ? `1.5px solid ${GREEN}` : 'none', paddingRight: showNumpad ? 1 : 0, animation: showNumpad ? 'blink 1s step-end infinite' : 'none' }}>
            {qty}
          </div>
        </div>

        {/* Limit price row */}
        <div style={{ padding: '16px 18px', borderBottom: `1px solid ${HAIRLINE}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 500, color: '#000' }}>Limit price</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
              <span style={{ fontSize: 13, color: GREEN, fontWeight: 600 }}>Bid $0.00 · Ask $0.05</span>
              <svg viewBox="0 0 24 24" width={14} height={14}>
                <path d="M7 10l5 5 5-5" fill="none" stroke={GREEN} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
          </div>
          <div style={{ fontSize: 17, color: ICON_GRAY, fontWeight: 500 }}>${limitPrice.toFixed(2)}</div>
        </div>

        {/* Estimated cost row (collapsible) */}
        <button
          onClick={() => setCostExpanded((x) => !x)}
          style={{
            width: '100%', padding: '16px 18px', borderBottom: `1px solid ${HAIRLINE}`,
            display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
            background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 17, fontWeight: 500, color: '#000' }}>Estimated cost</span>
              <svg viewBox="0 0 24 24" width={14} height={14}>
                <path d={costExpanded ? "M7 14l5-5 5 5" : "M7 10l5 5 5-5"} fill="none" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            {costExpanded && (
              <>
                <div style={{ fontSize: 13, color: TEXT_GRAY, marginTop: 8 }}>
                  ${limitPrice.toFixed(2)} × {multiplier} multiplier
                </div>
                <div style={{ fontSize: 13, color: TEXT_GRAY, marginTop: 2 }}>
                  ${regulatoryFee.toFixed(2)} est regulatory fee
                </div>
              </>
            )}
          </div>
          <div style={{ fontSize: 17, fontWeight: 700, color: '#000' }}>${cost}</div>
        </button>

        {/* Spacer when chart is collapsed (numpad mode) */}
        {!chartExpanded && <div style={{ flex: 1 }} />}

        {/* Chart toggle button */}
        <div style={{ display: 'flex', justifyContent: 'center', padding: chartExpanded ? '6px 0 4px' : '4px 0' }}>
          <button
            onClick={() => { setChartExpanded((x) => !x); setShowNumpad((x) => chartExpanded); }}
            style={{
              width: 36, height: 36, borderRadius: '50%', border: `1px solid ${HAIRLINE}`,
              background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', padding: 0,
            }}
          >
            <svg viewBox="0 0 24 24" width={18} height={18}>
              <path d={chartExpanded ? "M7 10l5 5 5-5" : "M7 14l5-5 5 5"} fill="none" stroke={GREEN} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>

        {/* Either: expected P&L (when scrubbing) OR Profit/breakeven/loss row */}
        {chartExpanded && expectedPnL != null ? (
          <div style={{ padding: '0 18px 14px', textAlign: 'center' }}>
            <div style={{ fontSize: 13, color: TEXT_GRAY }}>Expected profit &amp; loss</div>
            <div style={{ fontSize: 21, fontWeight: 700, color: expectedPnL >= 0 ? GREEN : RED, marginTop: 4 }}>
              {expectedPnL >= 0 ? '+' : '-'}${Math.abs(expectedPnL).toFixed(2)}
            </div>
          </div>
        ) : (
          <div style={{ padding: '0 18px 14px', display: 'flex', justifyContent: 'space-around', textAlign: 'center' }}>
            <div>
              <div style={{ fontSize: 13, color: TEXT_GRAY }}>Max profit</div>
              <div style={{ fontSize: 16, color: '#000', marginTop: 4 }}>Unlimited</div>
            </div>
            <div>
              <div style={{ fontSize: 13, color: TEXT_GRAY }}>Breakeven</div>
              <div style={{ fontSize: 16, color: '#000', marginTop: 4 }}>${breakeven}</div>
            </div>
            <div>
              <div style={{ fontSize: 13, color: TEXT_GRAY }}>Max loss</div>
              <div style={{ fontSize: 16, color: '#000', marginTop: 4 }}>-${maxLoss}</div>
            </div>
          </div>
        )}

        {/* Expanded chart */}
        {chartExpanded && (
          <div style={{ padding: '0 12px 16px' }}>
            {/* Price label - either "STRC Price Now" or "STRC Price at Exp" */}
            <div style={{ textAlign: chartPx != null ? 'right' : 'center', paddingRight: chartPx != null ? 14 : 0, marginBottom: -2 }}>
              <div style={{ fontSize: 12, color: TEXT_GRAY }}>
                {chartPx != null ? 'STRC Price at Exp' : 'STRC Price Now'}
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#000', marginTop: 2 }}>
                ${chartPx != null ? chartPx.toFixed(2) : currentPx}
              </div>
            </div>
            <svg
              ref={svgRef}
              viewBox={`0 0 ${W} ${H}`}
              style={{ width: '100%', height: H, cursor: 'crosshair', touchAction: 'none' }}
              onMouseDown={(e) => onChartPick(e.clientX)}
              onMouseMove={(e) => e.buttons === 1 && onChartPick(e.clientX)}
              onTouchStart={(e) => onChartPick(e.touches[0].clientX)}
              onTouchMove={(e) => { e.preventDefault(); onChartPick(e.touches[0].clientX); }}
            >
              {/* Dashed top and bottom borders */}
              <line x1={PAD.left} y1={yT} x2={W - PAD.right} y2={yT} stroke="#000" strokeWidth="0.8" strokeDasharray="3 3" />
              <line x1={PAD.left} y1={yB} x2={W - PAD.right} y2={yB} stroke="#000" strokeWidth="0.8" strokeDasharray="3 3" />
              {/* Vertical line at current STRC price (always shown) */}
              <line x1={xCur} y1={yT} x2={xCur} y2={yB} stroke={chartPx != null ? '#9AA0A6' : '#000'} strokeWidth={chartPx != null ? '0.9' : '1.4'} />
              {/* Zero line */}
              <line x1={PAD.left} y1={yC} x2={W - PAD.right} y2={yC} stroke="#000" strokeWidth="0.6" />
              {/* Red flat segment up to strike */}
              <line x1={PAD.left} y1={yC} x2={xStr} y2={yC} stroke={RED} strokeWidth="2.8" strokeLinecap="round" />
              {/* Green fill area */}
              <path d={`M ${xStr} ${yC} L ${xEnd} ${yEnd} L ${xEnd} ${yC} Z`} fill={GREEN_FIL} />
              {/* Green ascending segment */}
              <line x1={xStr} y1={yC} x2={xEnd} y2={yEnd} stroke={GREEN} strokeWidth="2.8" strokeLinecap="round" />
              {/* Orange kink dot */}
              <circle cx={xStr} cy={yC} r={5.5} fill={RED} stroke="#fff" strokeWidth="1.4" />
              {/* Selected price scrubber line */}
              {chartPx != null && (
                <line x1={xs(chartPx)} y1={yT} x2={xs(chartPx)} y2={yB} stroke="#000" strokeWidth="1.4" />
              )}
              {/* Y-axis labels */}
              <text x={PAD.left - 8} y={yT + 14} fontSize={14} fill="#000" textAnchor="end">+</text>
              <text x={PAD.left - 8} y={yC + 5} fontSize={14} fill="#000" textAnchor="end">0</text>
              <text x={PAD.left - 8} y={yB - 4} fontSize={14} fill="#000" textAnchor="end">-</text>
            </svg>
            <div style={{ textAlign: 'center', fontSize: 13, color: TEXT_GRAY, marginTop: 6 }}>
              Learn about the P/L chart, its risks and limitations
              <svg viewBox="0 0 24 24" width={12} height={12} style={{ marginLeft: 4, verticalAlign: -1 }}>
                <path d="M7 17L17 7M9 7h8v8" fill="none" stroke={TEXT_GRAY} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          </div>
        )}

        {/* Bottom action bar */}
        <div style={{ borderTop: `1px solid ${HAIRLINE}`, padding: '14px 14px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <button style={{
            display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none',
            cursor: 'pointer', padding: '8px 6px',
          }}>
            <svg viewBox="0 0 24 24" width={20} height={20}>
              <path d="M3 17l5-5 4 4 8-9" fill="none" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M14 7h6v6" fill="none" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span style={{ fontSize: 15, fontWeight: 600, color: '#000' }}>Individual</span>
            <svg viewBox="0 0 24 24" width={14} height={14}>
              <path d="M7 10l5 5 5-5" fill="none" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <button style={{
            flex: 1, height: 48, background: GREEN, color: '#fff', border: 'none',
            borderRadius: 24, fontSize: 16, fontWeight: 700, cursor: 'pointer',
          }}>
            Review
          </button>
        </div>

        {/* Numpad — visible when chart is collapsed */}
        {!chartExpanded && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 0, padding: '0 0 14px' }}>
            {['1','2','3','4','5','6','7','8','9','','0','←'].map((k, i) => (
              <button
                key={i}
                disabled={k === ''}
                style={{
                  height: 56, background: 'transparent', border: 'none',
                  fontSize: 32, fontWeight: 400, color: k === '' ? 'transparent' : GREEN,
                  cursor: k === '' ? 'default' : 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                {k === '←' ? (
                  <svg viewBox="0 0 24 24" width={28} height={28}>
                    <path d="M19 12H5M12 19l-7-7 7-7" fill="none" stroke={GREEN} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : k}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}


/* ─────────── ROOT ─────────── */
type MobilePosition = {
  title: string;
  subtitle?: string;
  contracts?: number;
  value?: string;
  pct?: string;
  gain?: number;
  delta?: string;
  gamma?: string;
  theta?: string;
  vega?: string;
  curr?: string;
  avg?: string;
};

type ChainContract = {
  strike: number;
  price: number;
  today: number;
};

type AnalyzerPage =
  | { name: 'main' }
  | { name: 'roll'; position: MobilePosition }
  | { name: 'chain'; position: MobilePosition; highlightStrike: number }
  | { name: 'sim'; position: MobilePosition; contract: ChainContract }
  | { name: 'open'; position: Pick<MobilePosition, 'title'> & Partial<MobilePosition> };

export default function OptionsAnalyzer() {
  const [dte, setDte] = useState(0); // 0 = Now, 31 = Last exp
  const [selectedPrice, setSelectedPrice] = useState(104.99);
  const [expanded, setExpanded] = useState({ 0: false, 1: false });
  const [checked, setChecked] = useState({ 0: true, 1: true });
  const [scrollY, setScrollY] = useState(0);
  const [page, setPage] = useState<AnalyzerPage>({ name: 'main' });

  const dteRemaining = 31 - dte;
  // chart curve at expiration vs now (use 0-28 internal scale for shape)
  const chartDte = (dteRemaining / 31) * 28;
  const pnl = useMemo(() => portfolioPnL(selectedPrice, chartDte), [chartDte, selectedPrice]);
  // Total return % vs cost basis of $120
  const totalReturnPct = (pnl / 120) * 100;

  // Sticky header data
  const stickyPrice = selectedPrice;
  const stickyChangePct = ((selectedPrice - 98.84) / 98.84) * 100;

  const scrollRef = useRef(null);
  const onScroll = () => {
    if (scrollRef.current) setScrollY(scrollRef.current.scrollTop);
  };

  const showSticky = scrollY > 180;

  const positions = [
    {
      title: 'STRC $105 Call', subtitle: '31 DTE · 4 Buys', contracts: 4,
      value: '-$16.00', pct: '-80.00%', gain: -16,
      delta: '0.0544', gamma: '-0.0016', theta: '-0.1776',
      vega: '-1,976,789.40', curr: '$0.01', avg: '$0.05',
    },
    {
      title: 'STRC $100 Call', subtitle: '31 DTE · 5 Buys', contracts: 5,
      value: '-$60.00', pct: '-60.00%', gain: -60,
      delta: '0.1230', gamma: '0.0080', theta: '-0.2104',
      vega: '0.1245', curr: '$0.08', avg: '$0.20',
    },
  ];

  // ─── Page routing ───
  if (page.name === 'roll') {
    return (
      <PhoneFrame>
        <RollPage
          position={page.position}
          onBack={() => setPage({ name: 'main' })}
          onPickNew={() => setPage({ name: 'chain', position: page.position, highlightStrike: page.position.title.includes('100') ? 100 : 105 })}
        />
      </PhoneFrame>
    );
  }
  if (page.name === 'chain') {
    return (
      <PhoneFrame>
        <OptionsChain
          highlightStrike={page.highlightStrike}
          onBack={() => setPage({ name: 'roll', position: page.position })}
          onPickContract={(c) => setPage({ name: 'sim', contract: c, position: page.position })}
        />
      </PhoneFrame>
    );
  }
  if (page.name === 'sim') {
    return (
      <PhoneFrame>
        <SimReturnsSheet
          contract={page.contract}
          onBack={() => setPage({ name: 'chain', position: page.position, highlightStrike: page.contract.strike })}
          onContinue={() => setPage({ name: 'open', position: { title: `STRC $${page.contract.strike} Call` } })}
        />
      </PhoneFrame>
    );
  }
  if (page.name === 'open') {
    return (
      <PhoneFrame>
        <OpenPage position={page.position} onBack={() => setPage({ name: 'main' })} />
      </PhoneFrame>
    );
  }

  return (
    <PhoneFrame>
      <StatusBar />

        {/* Sticky header overlay */}
        <div style={{
          position: 'absolute', top: 54, left: 0, right: 0, zIndex: 10,
          background: '#fff', borderBottom: showSticky ? `1px solid ${HAIRLINE}` : 'none',
          padding: '14px 18px 12px', transition: 'opacity 200ms',
          opacity: showSticky ? 1 : 0, pointerEvents: showSticky ? 'auto' : 'none',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <button style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
              <Icon.X />
            </button>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>${stickyPrice.toFixed(2)}</div>
              <div style={{ fontSize: 11, color: TEXT_GRAY, marginTop: 1 }}>STRC</div>
            </div>
            <button style={{ background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 15 }}>View STRC</button>
          </div>
          <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
            <span style={{ color: TEXT_GRAY }}>STRC</span>
            <span>
              <span style={{ fontWeight: 700 }}>${stickyPrice.toFixed(2)}</span>{' '}
              <span style={{ color: stickyChangePct >= 0 ? GREEN : RED }}>
                ({stickyChangePct >= 0 ? '+' : ''}{stickyChangePct.toFixed(2)}%)
              </span>{' '}
              <span style={{ color: TEXT_GRAY }}>{dteRemaining} DTE</span>
            </span>
          </div>
          <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span style={{ color: TEXT_GRAY }}>Return</span>
            <span>
              <span style={{ fontWeight: 700 }}>{pnl >= 0 ? '+' : '-'}${Math.abs(pnl).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}</span>{' '}
              <span style={{ color: totalReturnPct >= 0 ? GREEN : RED }}>
                ({totalReturnPct >= 0 ? '+' : ''}{totalReturnPct.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}%)
              </span>
            </span>
          </div>
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${HAIRLINE}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Greeks, Max P&amp;L</span>
            <Icon.ChevD />
          </div>
        </div>

        {/* Header (non-sticky) */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 18px 4px',
        }}>
          <button style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
            <Icon.X />
          </button>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Options analyzer</div>
          <button style={{ background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 15 }}>View STRC</button>
        </div>

        {/* Scrollable body */}
        <div
          ref={scrollRef}
          onScroll={onScroll}
          style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', paddingBottom: 30 }}
        >
          {/* Stock info */}
          <div style={{ padding: '14px 18px 6px', fontSize: 13.5 }}>
            <span style={{ fontWeight: 700 }}>STRC</span>{' '}
            <span style={{ color: RED, fontWeight: 700 }}>$98.84 (-0.35%)</span>
          </div>

          {/* Big rolling P&L */}
          <div style={{ padding: '4px 18px 4px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 44, fontWeight: 600, letterSpacing: -1.5, lineHeight: 1.05 }}>
              <RollingNumber value={pnl} />
            </div>
            <div style={{ marginTop: 14 }}>
              <Icon.Info />
            </div>
          </div>

          {/* Total return */}
          <div style={{ padding: '4px 18px 16px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 14 }}>
            <Icon.Tri />
            <span style={{ color: totalReturnPct >= 0 ? GREEN : RED, fontWeight: 700 }}>
              {totalReturnPct.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%
            </span>
            <span style={{ color: TEXT_GRAY }}>Total return</span>
          </div>

          {/* Greeks row */}
          <div style={{ padding: '0 18px 14px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            {(() => {
              const t = dte / 31; // 0 at Now, 1 at Exp
              const delta = 721.29 * (1 - t) + 500 * t;
              const gamma = 59.87 * (1 - t);
              const theta = -14.11 * (1 - t);
              const vega  = 48.47 * (1 - t);
              return [
                ['Delta', delta.toFixed(2)],
                ['Gamma', gamma.toFixed(2)],
                ['Theta', theta.toFixed(2)],
                ['Vega',  vega.toFixed(2)],
              ];
            })().map(([k, v]) => (
              <div key={k}>
                <div style={{ fontSize: 12.5, color: TEXT_GRAY }}>{k}</div>
                <div style={{ fontSize: 15.5, fontWeight: 500, marginTop: 2 }}>{v}</div>
              </div>
            ))}
          </div>

          {/* Chart */}
          <div style={{ padding: '0 6px' }}>
            <PayoffChart dte={chartDte} selectedPrice={selectedPrice} onSelectPrice={setSelectedPrice} />
          </div>

          {/* Max profit / Max loss */}
          <div style={{ padding: '8px 18px 10px', display: 'flex', justifyContent: 'space-between', fontSize: 13.5 }}>
            <span style={{ color: TEXT_GRAY }}>Max profit <span style={{ color: '#000', fontWeight: 500 }}>Unlimited</span></span>
            <span style={{ color: TEXT_GRAY }}>Max loss <span style={{ color: '#000', fontWeight: 500 }}>-$120.00</span></span>
          </div>

          {/* Date scrubber */}
          <div style={{ padding: '8px 0 18px' }}>
            <DateScrubber value={dte} onChange={setDte} max={31} />
          </div>

          {/* Deselect all / Reset */}
          <div style={{ padding: '6px 18px 4px', display: 'flex', justifyContent: 'space-between', fontSize: 14, fontWeight: 700 }}>
            <span style={{ borderBottom: '1px solid #000', cursor: 'pointer' }} onClick={() => setChecked({0:false, 1:false})}>Deselect all</span>
            <span style={{ borderBottom: '1px solid #000', cursor: 'pointer' }} onClick={() => { setChecked({0:true, 1:true}); setExpanded({0:false, 1:false}); }}>Reset</span>
          </div>

          {/* Position list */}
          <div style={{ padding: '14px 18px 4px' }}>
            {positions.map((pos, i) => (
              <PositionCard
                key={i}
                pos={pos}
                expanded={expanded[i]}
                checked={checked[i]}
                onToggleExpand={() => setExpanded((p) => ({ ...p, [i]: !p[i] }))}
                onToggleCheck={() => setChecked((p) => ({ ...p, [i]: !p[i] }))}
                onAction={(label) => {
                  if (label === 'Roll')  setPage({ name: 'roll', position: pos });
                  if (label === 'Open')  setPage({ name: 'open', position: pos });
                }}
              />
            ))}
          </div>
        </div>

        {/* Home indicator */}
        <div style={{
          position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)',
          width: 134, height: 5, background: '#000', borderRadius: 3,
        }}/>
    </PhoneFrame>
  );
}
