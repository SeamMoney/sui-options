'use client';
import { useEffect, useRef, useState } from 'react';
import { ORDERBOOK_HTML } from './orderbook-dom';

// ORDERBOOK_HTML is the raw HTML captured from the live Robinhood Legend
// OrderBook widget. We inject it via innerHTML once on mount (not via
// dangerouslySetInnerHTML, which would re-set on every re-render and wipe
// the canvas we mount inside it).

type Row = { price: number; bidSize: number; askSize: number };

type PendingOrder = { side: 'buy' | 'sell'; type: 'limit' | 'stop' | 'market'; price: number; qty?: number };

type Props = {
  symbol?: string;
  lastPrice?: number;
  changePct?: number;
  priceStep?: number;
  rowCount?: number;
  initialQty?: number;
  pendingOrder?: PendingOrder | null;
  showInfoBanner?: boolean;
  onTrade?: (side: 'buy' | 'sell') => void;
  onLadderClick?: (price: number, side: 'buy' | 'sell') => void;
};

const POSITIVE = '#00C805';
const NEGATIVE = '#FF5000';
const FG1 = 'rgba(255,255,255,0.95)';
const FG2 = 'rgba(255,255,255,0.65)';
const FG3 = 'rgba(255,255,255,0.4)';
const BG2 = 'rgba(255,255,255,0.07)';
const ACCENT_POSITIVE_BG = 'rgba(0, 200, 5, 0.12)';
const ACCENT_NEGATIVE_BG = 'rgba(255, 80, 0, 0.12)';

function snapStep(p: number, step: number) {
  return Math.round(p / step) * step;
}

function buildLadder(center: number, step: number, count: number): Row[] {
  const half = Math.floor(count / 2);
  const c = snapStep(center, step);
  const rows: Row[] = [];
  for (let i = half; i >= -half; i--) {
    const price = +(c + i * step).toFixed(2);
    const dist = Math.abs(i) / half;
    const base = Math.round(500 * (1 - dist) + 25);
    const noise = () => Math.round(base * (0.4 + Math.random() * 1.2));
    rows.push({
      price,
      bidSize: i < 0 ? noise() : 0,
      askSize: i > 0 ? noise() : 0,
    });
  }
  return rows;
}

function formatSize(n: number) {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function alphaForRow(distFromCenter: number, total: number) {
  const t = 1 - Math.min(1, distFromCenter / Math.max(1, total / 2));
  const a = Math.round((0.25 + 0.7 * t) * 255);
  return a.toString(16).padStart(2, '0');
}

function drawLadder(
  ctx: CanvasRenderingContext2D,
  rows: Row[],
  center: number,
  w: number,
  h: number,
  hoveredRow: number | null,
  lastDirection: 'up' | 'down' = 'up',
) {
  ctx.clearRect(0, 0, w, h);
  const fontFamily = 'Phonic, "SF Mono", ui-monospace, Menlo, monospace';
  ctx.textBaseline = 'middle';

  const rowH = h / rows.length;
  const priceColW = 124;
  const priceColX = (w - priceColW) / 2;
  const leftEdge = priceColX - 8;
  const rightEdge = priceColX + priceColW + 8;
  const leftMaxBar = leftEdge - 16;
  const rightMaxBar = w - rightEdge - 16;
  const maxSize = Math.max(1, ...rows.flatMap((r) => [r.bidSize, r.askSize]));
  const centerIdx = rows.findIndex((r) => Math.abs(r.price - center) < 1e-9);
  const centerPillColor = lastDirection === 'up' ? POSITIVE : NEGATIVE;

  // Hover row background (drawn first, behind bars)
  if (hoveredRow !== null) {
    ctx.fillStyle = BG2;
    ctx.fillRect(0, hoveredRow * rowH, w, rowH);
  }

  // Last-price row highlight pill — small colored rect aligned with the price column
  if (centerIdx >= 0) {
    const yTop = centerIdx * rowH;
    ctx.fillStyle = centerPillColor;
    const pillX = priceColX + 6;
    const pillW = priceColW - 12;
    ctx.fillRect(pillX, yTop + 2, pillW, rowH - 4);
  }

  rows.forEach((row, i) => {
    const yMid = i * rowH + rowH / 2;
    const dist = Math.abs(i - centerIdx);
    const alpha = alphaForRow(dist, rows.length);

    if (row.bidSize > 0) {
      const barW = Math.max(2, Math.min(leftMaxBar, (row.bidSize / maxSize) * leftMaxBar));
      ctx.fillStyle = POSITIVE + alpha;
      ctx.fillRect(leftEdge - barW, yMid - (rowH - 4) / 2, barW, rowH - 4);
      ctx.fillStyle = POSITIVE;
      ctx.textAlign = 'right';
      ctx.font = `700 12px ${fontFamily}`;
      ctx.fillText(formatSize(row.bidSize), leftEdge - barW - 4, yMid);
    }

    if (row.askSize > 0) {
      const barW = Math.max(2, Math.min(rightMaxBar, (row.askSize / maxSize) * rightMaxBar));
      ctx.fillStyle = NEGATIVE + alpha;
      ctx.fillRect(rightEdge, yMid - (rowH - 4) / 2, barW, rowH - 4);
      ctx.fillStyle = NEGATIVE;
      ctx.textAlign = 'left';
      ctx.font = `700 12px ${fontFamily}`;
      ctx.fillText(formatSize(row.askSize), rightEdge + barW + 4, yMid);
    }

    const isCenter = i === centerIdx;
    ctx.fillStyle = isCenter ? '#fff' : FG2;
    ctx.textAlign = 'center';
    ctx.font = `${isCenter ? 700 : 400} 13px ${fontFamily}`;
    ctx.fillText(`$${row.price.toFixed(2)}`, priceColX + priceColW / 2, yMid);
  });
}

export function PixelOrderBook({
  symbol = 'AMD',
  lastPrice = 219.8,
  changePct: _changePct = 2.14,
  priceStep = 0.25,
  rowCount = 41,
  initialQty = 1,
  pendingOrder = null,
  showInfoBanner = false,
  onTrade,
  onLadderClick,
}: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const prevPriceRef = useRef<number>(lastPrice);
  const [qty, setQty] = useState(initialQty);
  const [rows, setRows] = useState<Row[]>(() => buildLadder(lastPrice, priceStep, rowCount));
  const [hovered, setHovered] = useState<number | null>(null);
  const [lastDir, setLastDir] = useState<'up' | 'down'>('up');
  useEffect(() => {
    if (lastPrice > prevPriceRef.current) setLastDir('up');
    else if (lastPrice < prevPriceRef.current) setLastDir('down');
    prevPriceRef.current = lastPrice;
  }, [lastPrice]);

  // Inject the captured Robinhood DOM exactly once. Using innerHTML directly
  // (not dangerouslySetInnerHTML) means subsequent React re-renders won't blow
  // away the canvas / event listeners we attach to this subtree.
  const [domReady, setDomReady] = useState(false);
  useEffect(() => {
    if (!rootRef.current) return;
    if (rootRef.current.innerHTML === '') {
      rootRef.current.innerHTML = ORDERBOOK_HTML;
    }
    setDomReady(true);
  }, []);

  // Mount the canvas inside the captured DOM tree at [data-element="canvasArea"]
  useEffect(() => {
    if (!domReady || !rootRef.current) return;
    const area = rootRef.current.querySelector<HTMLElement>('[data-element="canvasArea"]');
    if (!area) return;
    const canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.touchAction = 'manipulation';
    canvas.style.cursor = 'crosshair';
    area.appendChild(canvas);
    canvasRef.current = canvas;
    const rowToPrice = (idx: number) => {
      const center = snapStep(lastPrice, priceStep);
      const half = Math.floor(rowCount / 2);
      return +(center + (half - idx) * priceStep).toFixed(2);
    };
    const onMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const rowH = rect.height / rowCount;
      const idx = Math.min(rowCount - 1, Math.max(0, Math.floor(y / rowH)));
      setHovered(idx);
    };
    const onLeave = () => setHovered(null);
    const onClick = (e: PointerEvent) => {
      if (!onLadderClick) return;
      const rect = canvas.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const rowH = rect.height / rowCount;
      const idx = Math.min(rowCount - 1, Math.max(0, Math.floor(y / rowH)));
      const price = rowToPrice(idx);
      const side = price < lastPrice ? 'buy' : 'sell';
      onLadderClick(price, side);
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('pointerup', onClick);
    return () => {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerup', onClick);
      canvas.remove();
      canvasRef.current = null;
    };
  }, [domReady, rowCount, lastPrice, priceStep, onLadderClick]);

  // Redraw whenever rows / hover change, and on resize
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawLadder(ctx, rows, snapStep(lastPrice, priceStep), rect.width, rect.height, hovered, lastDir);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [rows, hovered, lastPrice, priceStep, lastDir]);

  // Mock subscription: every 1.2s mutate 15% of rows (RxJS-shaped feed)
  useEffect(() => {
    const id = setInterval(() => {
      setRows((prev) =>
        prev.map((r) => {
          if (Math.random() > 0.15) return r;
          const factor = 0.6 + Math.random() * 0.8;
          return {
            ...r,
            bidSize: r.bidSize > 0 ? Math.max(0, Math.round(r.bidSize * factor)) : 0,
            askSize: r.askSize > 0 ? Math.max(0, Math.round(r.askSize * factor)) : 0,
          };
        }),
      );
    }, 1200);
    return () => clearInterval(id);
  }, []);

  // Wire interactivity to the captured DOM via refs
  useEffect(() => {
    if (!domReady) return;
    const root = rootRef.current;
    if (!root) return;
    // Buy/Sell market buttons
    const buyBtn = root.querySelector<HTMLButtonElement>('[data-testid="ladder.header.equity.button.buy.buy"]');
    const sellBtn = root.querySelector<HTMLButtonElement>('[data-testid="ladder.header.equity.button.sell.sell"]');
    // Enable the sell button (captured DOM had it disabled for paper account)
    if (sellBtn) {
      sellBtn.disabled = false;
      const lbl = sellBtn.querySelector<HTMLElement>('span > span');
      if (lbl) lbl.style.color = NEGATIVE;
      sellBtn.style.cursor = 'pointer';
    }
    const onBuy = () => onTrade?.('buy');
    const onSell = () => onTrade?.('sell');
    buyBtn?.addEventListener('click', onBuy);
    sellBtn?.addEventListener('click', onSell);

    // Stepper buttons
    const dec = root.querySelector<HTMLButtonElement>('[data-testid="undefined-stepper-decrement"]');
    const inc = root.querySelector<HTMLButtonElement>('[data-testid="undefined-stepper-increment"]');
    if (dec) {
      dec.disabled = qty <= 1;
      const decIcon = dec.querySelector<SVGPathElement>('svg path');
      if (decIcon) decIcon.setAttribute('fill', qty <= 1 ? FG3 : 'var(--colors-neutral-fg1)');
    }
    const onDec = () => setQty((q) => Math.max(1, q - 1));
    const onInc = () => setQty((q) => q + 1);
    dec?.addEventListener('click', onDec);
    inc?.addEventListener('click', onInc);

    // Sync quantity input value
    const input = root.querySelector<HTMLInputElement>('[aria-label="Change quantity"]');
    if (input) input.value = String(qty);

    return () => {
      buyBtn?.removeEventListener('click', onBuy);
      sellBtn?.removeEventListener('click', onSell);
      dec?.removeEventListener('click', onDec);
      inc?.removeEventListener('click', onInc);
    };
  }, [domReady, qty, onTrade]);

  // Update header symbol label (the captured DOM has "AMD" baked in — swap per prop)
  useEffect(() => {
    if (!domReady) return;
    const root = rootRef.current;
    if (!root) return;
    const flatten = root.querySelector<HTMLButtonElement>('[data-testid="ladder-header-flatten-button"] button');
    if (flatten) {
      flatten.setAttribute('aria-label', `You don't have a position in ${symbol} or any open orders.`);
    }
  }, [domReady, symbol]);

  // Hide / show the "24 Hour Market" info banner. In live Robinhood this only
  // shows during off-hours; in our captured DOM it's always present.
  useEffect(() => {
    if (!domReady) return;
    const root = rootRef.current;
    if (!root) return;
    const banner = root.querySelector<HTMLElement>('[role="status"]');
    if (banner) {
      const wrapper = banner.closest<HTMLElement>('.padding-block_token\\(spacing\\.02\\)') ?? banner.parentElement;
      if (wrapper) wrapper.style.display = showInfoBanner ? '' : 'none';
    }
  }, [domReady, showInfoBanner]);

  // Render the trade-entry overlay (Buy stop / Sell limit / hover preview pill).
  // We create our own overlay element rather than wrestling with the captured
  // one (which had "AMD"-specific position + class names baked in).
  useEffect(() => {
    if (!domReady) return;
    const root = rootRef.current;
    if (!root) return;

    // Hide the original captured overlay so it doesn't interfere
    const capturedOverlay = root.querySelector<HTMLElement>('[data-testid="trade-entry-overlay-container"]');
    if (capturedOverlay) capturedOverlay.style.display = 'none';

    const ladderContainer = root.querySelector<HTMLElement>('[data-testid="ladder-chart-container"]');
    if (!ladderContainer) return;
    let pill = root.querySelector<HTMLElement>('[data-pixel-overlay]');
    if (!pill) {
      pill = document.createElement('div');
      pill.setAttribute('data-pixel-overlay', '');
      pill.style.position = 'absolute';
      pill.style.left = '50%';
      pill.style.zIndex = '3';
      pill.style.padding = '4px 10px';
      pill.style.borderRadius = '20px';
      pill.style.fontFamily = 'Phonic, "SF Mono", ui-monospace, monospace';
      pill.style.fontSize = '13px';
      pill.style.fontWeight = '700';
      pill.style.backdropFilter = 'blur(15px)';
      pill.style.pointerEvents = 'none';
      pill.style.whiteSpace = 'nowrap';
      pill.style.transition = 'top 100ms cubic-bezier(0.22, 1, 0.36, 1)';
      pill.style.display = 'flex';
      pill.style.gap = '8px';
      pill.style.alignItems = 'center';
      ladderContainer.appendChild(pill);
    }

    // Determine which overlay to show. Pending order takes priority; otherwise
    // hover state previews a "Buy/Sell stop $X" pill.
    let side: 'buy' | 'sell' | null = null;
    let label = '';
    let price = 0;
    if (pendingOrder) {
      side = pendingOrder.side;
      label = `${pendingOrder.side === 'buy' ? 'Buy' : 'Sell'} ${pendingOrder.type}`;
      price = pendingOrder.price;
    } else if (hovered !== null) {
      const center = snapStep(lastPrice, priceStep);
      const half = Math.floor(rowCount / 2);
      price = +(center + (half - hovered) * priceStep).toFixed(2);
      side = price < lastPrice ? 'buy' : price > lastPrice ? 'sell' : null;
      if (side) label = `${side === 'buy' ? 'Buy' : 'Sell'} stop`;
    }

    if (!side) {
      pill.style.display = 'none';
      return;
    }
    pill.style.display = 'flex';
    const rect = ladderContainer.getBoundingClientRect();
    const rowH = rect.height / rowCount;
    const center = snapStep(lastPrice, priceStep);
    const offsetRows = (center - price) / priceStep;
    const half = Math.floor(rowCount / 2);
    const idx = half + offsetRows;
    const y = idx * rowH + rowH / 2;
    pill.style.top = `${y - 14}px`;
    pill.style.transform = 'translateX(-50%)';
    if (side === 'buy') {
      pill.style.background = ACCENT_POSITIVE_BG;
      pill.style.border = '1px solid rgba(0, 200, 5, 0.4)';
      pill.style.color = POSITIVE;
    } else {
      pill.style.background = ACCENT_NEGATIVE_BG;
      pill.style.border = '1px solid rgba(255, 80, 0, 0.4)';
      pill.style.color = NEGATIVE;
    }
    pill.innerHTML = `<span>${label}</span><span style="color:#fff">$${price.toFixed(2)}</span>`;
  }, [domReady, pendingOrder, hovered, lastPrice, priceStep, rowCount]);


  return (
    <div
      ref={rootRef}
      style={{ width: '100%', height: '100%' }}
      suppressHydrationWarning
    />
  );
}
