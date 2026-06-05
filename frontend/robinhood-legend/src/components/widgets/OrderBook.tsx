'use client';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

// ============================================================================
// OrderBook (Level-II ladder) widget
//
// Source intel: chunk 6752 / module 79755 / export LadderWidget (Robinhood's
// canvas-rendered ladder). We use DOM rows + CSS transitions for the same
// visual result, with the brand's motion tokens applied throughout.
//
// Motion vocabulary (sourced from main.rs1c15ec8af791941c.css):
//   --rh-ease-quint  = cubic-bezier(.22, 1, .36, 1)   ← premium easeOut
//   --rh-ease-circ   = cubic-bezier(0, .55, .45, 1)   ← sharp easeOut
//   --rh-dur-quick   = 100ms  (hover/press)
//   --rh-dur-base    = 500ms  (bar width, pill slide)
//   --rh-dur-slow    = 800ms  (initial mount, large transitions)
// ============================================================================

export type LadderRow = { price: number; bidSize: number; askSize: number };
export type OrderBookProps = {
  symbol: string;
  lastPrice: number;
  changePct?: number;
  priceStep?: number;
  rowCount?: number;
  pendingOrder?: { side: 'buy' | 'sell'; type: 'limit' | 'stop'; price: number } | null;
  rows?: LadderRow[];
};

const COLORS = {
  positive: '#00d20c',
  positiveAlpha: 'rgba(0, 200, 12, 0.16)',
  positiveFlash: 'rgba(0, 200, 12, 0.28)',
  negative: '#ff5000',
  negativeAlpha: 'rgba(255, 80, 0, 0.17)',
  negativeFlash: 'rgba(255, 80, 0, 0.30)',
  textPrice: '#85858b',
  textSize: '#f4f4f5',
  centerBg: '#1f1f22',
  centerText: '#ffffff',
  border: '#29292b',
  buttonBg: '#1f1f22',
  buttonHover: '#2a2a2e',
};

const EASE_QUINT = 'cubic-bezier(.22, 1, .36, 1)';
const EASE_CIRC = 'cubic-bezier(0, .55, .45, 1)';

const fmtPrice = (p: number) => '$' + p.toFixed(2);
const fmtSize = (n: number) => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'K';
  return String(n);
};

// Mock subscription stream (mirrors the real RxJS feed shape). Each tick we
// mutate ~15% of rows so the ladder breathes like the live one.
function useMockLadder(lastPrice: number, rowCount: number, priceStep: number): LadderRow[] {
  const baseSeed = useRef<Map<number, { bid: number; ask: number }> | null>(null);
  const [tick, setTick] = useState(0);

  if (baseSeed.current === null) {
    const map = new Map<number, { bid: number; ask: number }>();
    const half = Math.floor(rowCount / 2);
    const center = Math.round(lastPrice / priceStep) * priceStep;
    // Realistic depth: lumpy, not a smooth ramp. Empty levels (gaps), occasional
    // big walls, some medium clips, and lots of small odd lots — slightly heavier
    // near the touch but very noisy. fmtSize then renders walls as "2K–10K" and
    // odd lots as exact numbers (47, 8, 273), like a real ladder.
    const depthAt = (dist: number) => {
      const r = Math.random();
      const prox = Math.max(0, 1 - dist / (half + 2)); // 1 near touch → 0 far out
      let size: number;
      if (r < 0.08) size = 0;                                            // gap
      else if (r < 0.18) size = Math.round(1800 + Math.random() * 8500); // wall
      else if (r < 0.52) size = Math.round(110 + Math.random() * 760);   // medium
      else size = Math.round(1 + Math.random() * 140);                   // odd lot
      return size === 0 ? 0 : Math.max(1, Math.round(size * (0.6 + 0.7 * prox)));
    };
    for (let i = -half; i <= half; i++) {
      const price = +(center + i * priceStep).toFixed(2);
      const dist = Math.abs(i);
      map.set(price, { bid: i < 0 ? depthAt(dist) : 0, ask: i > 0 ? depthAt(dist) : 0 });
    }
    baseSeed.current = map;
  }

  useEffect(() => {
    const center = Math.round(lastPrice / priceStep) * priceStep;
    const id = setInterval(() => {
      const map = baseSeed.current!;
      for (const [price, row] of map) {
        const isBid = price < center - priceStep / 2;
        const isAsk = price > center + priceStep / 2;
        if (!isBid && !isAsk) continue;
        // ~35% of resting levels change every tick — orders constantly arriving
        // and getting pulled, so the bars grow/shrink continuously.
        if (Math.random() > 0.35) continue;
        const cur = isBid ? row.bid : row.ask;
        const roll = Math.random();
        let next: number;
        if (roll < 0.1) next = 0;                                              // order pulled
        else if (roll < 0.18) next = Math.round(1500 + Math.random() * 8000);  // big order / wall lands
        else if (roll < 0.42) next = Math.max(1, Math.round((cur || 120) + (Math.random() - 0.35) * 500)); // chunk in/out
        else next = Math.max(1, Math.round((cur || 90) * (1 + (Math.random() - 0.5) * 0.55)));             // drift
        if (isBid) row.bid = next;
        else row.ask = next;
      }
      setTick((t) => t + 1);
    }, 550);
    return () => clearInterval(id);
  }, [lastPrice, priceStep]);

  return useMemo(() => {
    const map = baseSeed.current!;
    return [...map.entries()]
      .map(([price, v]) => ({ price, bidSize: v.bid, askSize: v.ask }))
      .sort((a, b) => b.price - a.price);
    // Recompute each tick so the streamed mutations actually surface.
  }, [tick]);
}

// Track per-row size changes so we can flash the bar when a value updates.
// Returns a Map<price, {bidFlash:boolean, askFlash:boolean}>.
function useFlashes(rows: LadderRow[]): Map<number, { bidFlash: boolean; askFlash: boolean }> {
  const prev = useRef<Map<number, { bid: number; ask: number }>>(new Map());
  const flashes = useRef<Map<number, { bidFlash: boolean; askFlash: boolean }>>(new Map());
  // Clear flashes after 400ms so the bar settles back to normal.
  const [, setNonce] = useState(0);

  for (const r of rows) {
    const p = prev.current.get(r.price);
    if (p) {
      const bidFlash = r.bidSize !== p.bid && r.bidSize > 0;
      const askFlash = r.askSize !== p.ask && r.askSize > 0;
      if (bidFlash || askFlash) {
        flashes.current.set(r.price, { bidFlash, askFlash });
      }
    }
    prev.current.set(r.price, { bid: r.bidSize, ask: r.askSize });
  }

  useEffect(() => {
    if (flashes.current.size === 0) return;
    const id = setTimeout(() => {
      flashes.current.clear();
      setNonce((n) => n + 1);
    }, 400);
    return () => clearTimeout(id);
  });

  return flashes.current;
}

export function OrderBook(props: OrderBookProps) {
  const {
    symbol: _symbol,
    lastPrice,
    changePct = 0,
    priceStep = 0.25,
    rowCount = 21,
    pendingOrder = null,
    rows: providedRows,
  } = props;

  const mockRows = useMockLadder(lastPrice, rowCount, priceStep);
  const rows = providedRows ?? mockRows;
  const flashes = useFlashes(rows);

  const maxSize = useMemo(() => {
    let m = 1;
    for (const r of rows) {
      if (r.bidSize > m) m = r.bidSize;
      if (r.askSize > m) m = r.askSize;
    }
    return m;
  }, [rows]);

  const snappedLast = useMemo(() => {
    const stepped = Math.round(lastPrice / priceStep) * priceStep;
    return +stepped.toFixed(2);
  }, [lastPrice, priceStep]);

  // Auto-scroll to the current-price row when it changes (smooth-scroll matches
  // the original's onJumpToLastTradePrice behavior).
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const currentRowRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = currentRowRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [snappedLast]);

  return (
    <div
      data-testid="order-book-ladder"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        maxWidth: '100%',
        overflowX: 'hidden',
        boxSizing: 'border-box',
        background: 'transparent',
        color: COLORS.textPrice,
        fontFamily: 'var(--bw-ds--font-family, ui-sans-serif, system-ui)',
        fontVariantNumeric: 'tabular-nums',
        userSelect: 'none',
      }}
    >
      <style>{`[data-testid="order-book-ladder"] ::-webkit-scrollbar{width:0;height:0;display:none}`}</style>
      <OrderStrip lastPrice={snappedLast} changePct={changePct} />

      <div ref={scrollContainerRef} style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', position: 'relative', paddingBlock: 4, scrollBehavior: 'smooth', scrollbarWidth: 'none' }}>
        {rows.map((r) => {
          const isCurrent = Math.abs(r.price - snappedLast) < priceStep / 2;
          const isAsk = r.price > snappedLast;
          const isBid = r.price < snappedLast;
          const flash = flashes.get(r.price);
          if (isCurrent) {
            return (
              <CurrentRow
                key={r.price.toFixed(4)}
                rowRef={currentRowRef}
                price={r.price}
                changePct={changePct}
                bidSize={r.bidSize}
                askSize={r.askSize}
                maxSize={maxSize}
                pendingOrder={pendingOrder && Math.abs(pendingOrder.price - r.price) < priceStep / 2 ? pendingOrder : null}
              />
            );
          }
          return (
            <LadderRowDom
              key={r.price.toFixed(4)}
              price={r.price}
              size={isAsk ? r.askSize : r.bidSize}
              isAsk={isAsk}
              isBid={isBid}
              maxSize={maxSize}
              flashing={!!(flash && (isAsk ? flash.askFlash : flash.bidFlash))}
              pendingOrder={pendingOrder && Math.abs(pendingOrder.price - r.price) < priceStep / 2 ? pendingOrder : null}
            />
          );
        })}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, padding: '6px 10px' }}>
        <ZoomBtn ariaLabel="Zoom out">−</ZoomBtn>
        <ZoomBtn ariaLabel="Zoom in">+</ZoomBtn>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Ladder row
// ---------------------------------------------------------------------------

function LadderRowDom({ price, size, isAsk, isBid, maxSize, flashing, pendingOrder }: {
  price: number; size: number; isAsk: boolean; isBid: boolean; maxSize: number; flashing: boolean;
  pendingOrder: { side: 'buy' | 'sell'; type: 'limit' | 'stop'; price: number } | null;
}) {
  const pct = Math.min(1, size / maxSize);
  const barColor = isAsk ? COLORS.negativeAlpha : COLORS.positiveAlpha;
  const barFlashColor = isAsk ? COLORS.negativeFlash : COLORS.positiveFlash;
  const barSolid = isAsk ? COLORS.negative : COLORS.positive;
  const showSize = size > 0;
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 1fr',
        alignItems: 'center',
        height: 24,
        fontSize: 13,
        background: hovered ? 'rgba(255,255,255,0.03)' : 'transparent',
        transition: `background 100ms ${EASE_QUINT}`,
        cursor: 'pointer',
      }}
    >
      {/* LEFT cell — bid */}
      <div style={{ position: 'relative', height: '100%' }}>
        {isBid && showSize ? (
          <>
            <div style={{
              position: 'absolute',
              right: 0,
              top: '50%',
              transform: 'translateY(-50%)',
              width: `calc(${pct * 100}% - 4px)`,
              height: 18,
              background: flashing ? barFlashColor : barColor,
              borderRadius: 2,
              minWidth: 1,
              transition: `width 500ms ${EASE_QUINT}, background 400ms ease-out`,
            }} />
            <span style={{
              position: 'absolute',
              right: `calc(${pct * 100}% + 4px)`,
              top: '50%',
              transform: 'translateY(-50%)',
              color: barSolid,
              fontSize: 12,
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
              transition: `right 500ms ${EASE_QUINT}`,
            }}>{fmtSize(size)}</span>
          </>
        ) : null}
      </div>

      <div style={{ textAlign: 'center', color: COLORS.textPrice, fontSize: 13 }}>
        {fmtPrice(price)}
      </div>

      {/* RIGHT cell — ask */}
      <div style={{ position: 'relative', height: '100%' }}>
        {isAsk && showSize ? (
          <>
            <div style={{
              position: 'absolute',
              left: 0,
              top: '50%',
              transform: 'translateY(-50%)',
              width: `calc(${pct * 100}% - 4px)`,
              height: 18,
              background: flashing ? barFlashColor : barColor,
              borderRadius: 2,
              minWidth: 1,
              transition: `width 500ms ${EASE_QUINT}, background 400ms ease-out`,
            }} />
            <span style={{
              position: 'absolute',
              left: `calc(${pct * 100}% + 4px)`,
              top: '50%',
              transform: 'translateY(-50%)',
              color: barSolid,
              fontSize: 12,
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
              transition: `left 500ms ${EASE_QUINT}`,
            }}>{fmtSize(size)}</span>
          </>
        ) : null}
      </div>

      {pendingOrder ? <PendingOrderPill order={pendingOrder} /> : null}
    </div>
  );
}

function CurrentRow({ price, changePct, bidSize, askSize, maxSize, pendingOrder, rowRef }: {
  price: number; changePct: number; bidSize: number; askSize: number; maxSize: number;
  pendingOrder: { side: 'buy' | 'sell'; type: 'limit' | 'stop'; price: number } | null;
  rowRef: React.RefObject<HTMLDivElement | null>;
}) {
  const up = changePct >= 0;
  return (
    <div
      ref={rowRef}
      style={{
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 1fr',
        alignItems: 'center',
        height: 28,
        fontSize: 13,
      }}
    >
      {/* LEFT bid */}
      <div style={{ position: 'relative', height: '100%' }}>
        {bidSize > 0 ? (() => {
          const pct = Math.min(1, bidSize / maxSize);
          return (
            <>
              <div style={{
                position: 'absolute',
                right: 0, top: '50%', transform: 'translateY(-50%)',
                width: `calc(${pct * 100}% - 4px)`,
                height: 22,
                background: COLORS.positiveAlpha,
                borderRadius: 2,
                minWidth: 1,
                transition: `width 500ms ${EASE_QUINT}`,
              }} />
              <span style={{
                position: 'absolute',
                right: `calc(${pct * 100}% + 4px)`,
                top: '50%', transform: 'translateY(-50%)',
                color: COLORS.positive, fontSize: 12,
                fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
                transition: `right 500ms ${EASE_QUINT}`,
              }}>{fmtSize(bidSize)}</span>
            </>
          );
        })() : null}
      </div>

      {/* CENTER — current price pill (animated when row changes via parent scroll) */}
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <span
          style={{
            background: COLORS.centerBg,
            color: COLORS.centerText,
            fontWeight: 700,
            padding: '2px 10px',
            borderRadius: 4,
            fontSize: 13,
            fontVariantNumeric: 'tabular-nums',
            boxShadow: '0 0 0 1px ' + (up ? COLORS.positive : COLORS.negative),
            transition: `box-shadow 500ms ${EASE_QUINT}, color 500ms ease`,
          }}
        >
          {fmtPrice(price)}
        </span>
      </div>

      {/* RIGHT ask */}
      <div style={{ position: 'relative', height: '100%' }}>
        {askSize > 0 ? (() => {
          const pct = Math.min(1, askSize / maxSize);
          return (
            <>
              <div style={{
                position: 'absolute',
                left: 0, top: '50%', transform: 'translateY(-50%)',
                width: `calc(${pct * 100}% - 4px)`,
                height: 22,
                background: COLORS.negativeAlpha,
                borderRadius: 2,
                minWidth: 1,
                transition: `width 500ms ${EASE_QUINT}`,
              }} />
              <span style={{
                position: 'absolute',
                left: `calc(${pct * 100}% + 4px)`,
                top: '50%', transform: 'translateY(-50%)',
                color: COLORS.negative, fontSize: 12,
                fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
                transition: `left 500ms ${EASE_QUINT}`,
              }}>{fmtSize(askSize)}</span>
            </>
          );
        })() : null}
      </div>

      {pendingOrder ? <PendingOrderPill order={pendingOrder} /> : null}
    </div>
  );
}

function PendingOrderPill({ order }: { order: { side: 'buy' | 'sell'; type: 'limit' | 'stop'; price: number } }) {
  const isBuy = order.side === 'buy';
  const color = isBuy ? COLORS.positive : COLORS.negative;
  const label = `${isBuy ? 'Buy' : 'Sell'} ${order.type}`;
  return (
    <div style={{
      position: 'absolute',
      left: '50%',
      top: '50%',
      transform: 'translate(-65%, -50%)',
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      background: '#000',
      border: `1px solid ${color}`,
      borderRadius: 999,
      padding: '3px 10px',
      fontSize: 12,
      fontWeight: 700,
      color,
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
      zIndex: 5,
      // Smoothly slide vertically when limit price moves to a new row.
      transition: `transform 500ms ${EASE_QUINT}, top 500ms ${EASE_QUINT}`,
      // Soft attention pulse on first render.
      animation: 'rh-ob-pulse 1600ms ease-out 1',
    }}>
      <span>{label}</span>
      <span style={{ color: '#fff' }}>{fmtPrice(order.price)}</span>
      <style>{`
        @keyframes rh-ob-pulse {
          0%   { box-shadow: 0 0 0 0 ${color}66; }
          70%  { box-shadow: 0 0 0 8px transparent; }
          100% { box-shadow: 0 0 0 0 transparent; }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Order strip (top section: buy/qty/short buttons)
// ---------------------------------------------------------------------------

function OrderStrip({ lastPrice: _lastPrice, changePct: _changePct }: { lastPrice: number; changePct: number }) {
  const [qty, setQty] = useState(1);
  return (
    <div style={{ padding: '8px 12px', borderBottom: `1px solid ${COLORS.border}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: COLORS.textPrice }}>
        <div>
          <div>▲ -- Open P&L</div>
          <div>▲ -- Day P&L</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div>No position</div>
          <div>0 open orders</div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 8 }}>
        <TradeButton side="buy">Buy market</TradeButton>
        <QtyStepper qty={qty} onChange={setQty} />
        <TradeButton side="sell">Short market</TradeButton>
      </div>
    </div>
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
      onBlur={() => setPressed(false)}
      style={{
        padding: '8px 0',
        background: hovered ? COLORS.buttonHover : COLORS.buttonBg,
        border: 'none',
        borderRadius: 6,
        color,
        fontWeight: 700,
        cursor: 'pointer',
        fontSize: 14,
        transform: pressed ? 'scale(0.97)' : 'scale(1)',
        boxShadow: hovered ? `inset 0 0 0 1px ${color}55` : 'inset 0 0 0 1px transparent',
        transition: `transform 100ms ${EASE_CIRC}, background 100ms ${EASE_QUINT}, box-shadow 100ms ${EASE_QUINT}`,
      }}
    >
      {children}
    </button>
  );
}

function QtyStepper({ qty, onChange }: { qty: number; onChange: (q: number) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: COLORS.buttonBg, borderRadius: 6, padding: '0 6px' }}>
      <StepperBtn ariaLabel="Decrease quantity" onClick={() => onChange(Math.max(1, qty - 1))}>−</StepperBtn>
      <span style={{
        color: COLORS.textSize,
        fontWeight: 700,
        minWidth: 28,
        textAlign: 'center',
        fontSize: 14,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {qty}
      </span>
      <StepperBtn ariaLabel="Increase quantity" onClick={() => onChange(qty + 1)}>+</StepperBtn>
    </div>
  );
}

function StepperBtn({ children, onClick, ariaLabel }: { children: React.ReactNode; onClick: () => void; ariaLabel: string }) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  return (
    <button
      aria-label={ariaLabel}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setPressed(false); }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      style={{
        background: hovered ? 'rgba(255,255,255,0.08)' : 'transparent',
        border: 'none',
        color: COLORS.textSize,
        fontSize: 18,
        cursor: 'pointer',
        width: 22,
        height: 22,
        borderRadius: 4,
        transform: pressed ? 'scale(0.9)' : 'scale(1)',
        transition: `transform 100ms ${EASE_CIRC}, background 100ms ${EASE_QUINT}`,
      }}
    >
      {children}
    </button>
  );
}

function ZoomBtn({ children, ariaLabel }: { children: React.ReactNode; ariaLabel: string }) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  return (
    <button
      aria-label={ariaLabel}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setPressed(false); }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      style={{
        width: 28, height: 28, borderRadius: 6,
        background: hovered ? COLORS.buttonHover : COLORS.buttonBg,
        border: 'none', color: COLORS.textPrice,
        fontSize: 16, cursor: 'pointer',
        transform: pressed ? 'scale(0.92)' : 'scale(1)',
        transition: `transform 100ms ${EASE_CIRC}, background 100ms ${EASE_QUINT}`,
      }}
    >
      {children}
    </button>
  );
}
