'use client';
import { useMemo } from 'react';
import { createPortal } from 'react-dom';

const RH = {
  fg1: 'var(--colors-neutral-fg1, #fff)',
  fg2: 'var(--colors-neutral-fg2, rgba(255,255,255,.65))',
  fg3: 'var(--colors-neutral-fg3, rgba(255,255,255,.45))',
  bg2: 'var(--colors-neutral-bg2, rgba(255,255,255,.10))',
  bg3: 'var(--colors-neutral-bg3, rgba(255,255,255,.15))',
  easing: 'cubic-bezier(0.05, 0.39, 0.42, 0.94)',
  s01: '0.25rem', s02: '0.5rem', s03: '0.75rem', s04: '1rem', s06: '1.5rem',
  fontFamily: 'var(--bw-ds--font-family, system-ui)',
  fontSm: '0.8125rem',
  lineHeight: '1.23',
  letterSpacing: '-0.00625rem',
  numericFontFeature: '"tnum"',
};

export type ChainRowDetailsProps = {
  symbol: string;
  expiration: string;
  strike: number;
  kind: 'call' | 'put';
  ask: number;
  volume: number;
  openInterest: number;
  delta: number;
  cop: number;
  mount: HTMLElement;       // portal target inside chain body
  width: number;
  height: number;
  cols: {
    toggle: number;
    strike: number;
    volume: number;
    openInterest: number;
    cop: number;
    delta: number;
    price: number;
  };
};

function seed(key: string) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 1_000_000) / 1_000_000; };
}

const fmt$ = (n: number) => Number.isFinite(n) ? '$' + n.toFixed(2) : '—';
const fmt4 = (n: number) => Number.isFinite(n) ? n.toFixed(4) : '—';
const fmtPct = (n: number) => Number.isFinite(n) ? (n * 100).toFixed(2) + '%' : '—';
const fmtInt = (n: number) => Number.isFinite(n) ? n.toLocaleString('en-US') : '—';

const textBase: React.CSSProperties = {
  fontFamily: RH.fontFamily,
  fontSize: RH.fontSm,
  lineHeight: RH.lineHeight,
  letterSpacing: RH.letterSpacing,
  fontFeatureSettings: RH.numericFontFeature,
  margin: 0,
};

function Pair({ label, value, align }: { label: string; value: string; align: 'left' | 'right' }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: RH.s02, whiteSpace: 'nowrap', textAlign: align }}>
      <span style={{ ...textBase, fontWeight: 400, color: RH.fg2 }}>{label}</span>
      <span style={{ ...textBase, fontWeight: 400, color: RH.fg1 }}>{value}</span>
    </div>
  );
}

function Col({ width, align, children }: { width: number; align: 'left' | 'right'; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: RH.s04, paddingInline: RH.s02, minInlineSize: width, textAlign: align }}>
      {children}
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ paddingBlockStart: RH.s04, paddingBlockEnd: RH.s02, paddingInline: RH.s02, position: 'relative' }}>
      <span style={{ ...textBase, fontWeight: 700, color: RH.fg1 }}>{children}</span>
      <div aria-hidden style={{ position: 'absolute', left: RH.s02, right: RH.s02, bottom: 0, borderBlockEnd: '1px solid ' + RH.bg3 }} />
    </div>
  );
}

export function ChainRowDetails(props: ChainRowDetailsProps) {
  const { symbol, expiration, strike, kind, ask, volume, openInterest, delta, cop, mount, cols } = props;

  const stats = useMemo(() => {
    const rng = seed(`${symbol}-${expiration}-${strike}-${kind}`);
    const bid  = +Math.max(0.01, ask - 0.05).toFixed(2);
    const mark = +((bid + ask) / 2).toFixed(2);
    const last = +(bid + (ask - bid) * rng()).toFixed(2);
    const high = +(ask + 1 + rng() * 2).toFixed(2);
    const low  = +Math.max(0.01, ask - 1 - rng() * 2).toFixed(2);
    const prevClose = +(ask + 0.3 + rng() * 0.6).toFixed(2);
    const iv   = +(0.35 + rng() * 0.25).toFixed(4);
    return { bid, mark, ask, last, high, low, prevClose, iv };
  }, [symbol, expiration, strike, kind, ask]);

  const greeks = useMemo(() => {
    const rng = seed(`${symbol}-${expiration}-${strike}-${kind}-g`);
    const moneyness = Math.abs(Math.abs(delta) - 0.5);
    const gamma = +Math.max(0.0005, (0.04 - moneyness * 0.06) + rng() * 0.005).toFixed(4);
    const theta = +(-(0.02 + rng() * 0.08)).toFixed(4);
    const vega  = +(0.04 + rng() * 0.18).toFixed(4);
    const rho   = +(0.01 + rng() * 0.04).toFixed(4) * (kind === 'call' ? 1 : -1);
    return { gamma, theta, vega, rho };
  }, [symbol, expiration, strike, kind, delta]);

  const content = (
    <div
      role="region"
      aria-label={`Details for ${symbol} ${expiration} $${strike} ${kind === 'call' ? 'Call' : 'Put'}`}
      style={{
        inlineSize: '100%', blockSize: '100%',
        animation: `chainExpand 200ms ${RH.easing}`,
      }}
    >
      <style>{`@keyframes chainExpand { from { opacity: 0 } to { opacity: 1 } }`}</style>

      <SectionHeading>Stats</SectionHeading>
      <div style={{ display: 'flex', paddingBlock: RH.s01 }}>
        <div style={{ minInlineSize: cols.toggle }} aria-hidden />
        <Col width={cols.strike}       align="left">
          <Pair label="Bid"           value={fmt$(stats.bid)}        align="left" />
          <Pair label="Ask"           value={fmt$(stats.ask)}        align="left" />
        </Col>
        <Col width={cols.volume}       align="right">
          <Pair label="Mark"          value={fmt$(stats.mark)}       align="right" />
          <Pair label="Prev Close"    value={fmt$(stats.prevClose)}  align="right" />
        </Col>
        <Col width={cols.openInterest} align="right">
          <Pair label="High"          value={fmt$(stats.high)}       align="right" />
          <Pair label="Low"           value={fmt$(stats.low)}        align="right" />
        </Col>
        <Col width={cols.cop}          align="right">
          <Pair label="Last Trade"    value={fmt$(stats.last)}       align="right" />
          <Pair label="IV"            value={fmtPct(stats.iv)}       align="right" />
        </Col>
        <Col width={cols.delta}        align="right">
          <Pair label="Volume"        value={fmtInt(volume)}         align="right" />
          <Pair label="Open Interest" value={fmtInt(openInterest)}   align="right" />
        </Col>
      </div>

      <SectionHeading>The Greeks</SectionHeading>
      <div style={{ display: 'flex', paddingBlock: RH.s01 }}>
        <div style={{ minInlineSize: cols.toggle }} aria-hidden />
        <Col width={cols.strike}       align="left"><Pair label="Delta" value={fmt4(delta)}        align="left" /></Col>
        <Col width={cols.volume}       align="right"><Pair label="Gamma" value={fmt4(greeks.gamma)} align="right" /></Col>
        <Col width={cols.openInterest} align="right"><Pair label="Theta" value={fmt4(greeks.theta)} align="right" /></Col>
        <Col width={cols.cop}          align="right"><Pair label="Vega"  value={fmt4(greeks.vega)}  align="right" /></Col>
        <Col width={cols.delta}        align="right"><Pair label="Rho"   value={fmt4(greeks.rho)}   align="right" /></Col>
      </div>

      <div style={{ ...textBase, fontSize: '0.6875rem', color: RH.fg3, paddingInline: RH.s02, paddingBlockStart: RH.s02 }}>
        Chance of profit: {fmtPct(cop)}
      </div>
    </div>
  );

  return createPortal(content, mount);
}
