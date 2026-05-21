/**
 * useRideGesture — p5.js candle chart + press-and-hold gesture lifecycle.
 *
 * Ported from /tmp/cash-trading-game/src/hooks/useP5Chart.ts. Strips:
 *   - aptosMode / callbacksRef.current.onPositionOpened branching
 *   - the seeded-candle generator (we synthesize a random-walk locally,
 *     anchored on the live oracle spot when one is supplied)
 *   - the round/timer/liquidation/rugpull game loop (Wick has no rounds)
 *   - the modal/escape and debug-overlay listeners
 *
 * What it keeps (load-bearing):
 *   - press → onPress, release → onRelease callback shape
 *   - touchActive mouse/touch dedupe (iOS dispatches both)
 *   - drawPNLLine (entry → live cursor, with glow + dot)
 *   - MoneyEmoji burst on profitable close
 *   - screen-shake + red-flash on loss
 *   - pulsing dot at entry, immediate horizontal stub line
 *
 * On-chain bridge is intentionally outside this hook: the parent owns the
 * Sui PTB lifecycle and pipes the live `stakePaid` / `multiplierBps` back
 * in via `setPnl`. This keeps the canvas pure-rendering and lets us swap
 * the data source (oracle, fixture, replay) without touching the gesture
 * code.
 */
import { useEffect, useRef } from "react";
import type p5 from "p5";
import { getTopMargin, getSafeBottom, isStandalone } from "@/utils/safeArea";

export interface RideGestureCallbacks {
  /** Called on mousePressed / touchStarted. Receives the spot price the
   *  user "entered" at (most recent candle close). */
  onPress: (entryPrice: number) => void;
  /** Called on mouseReleased / touchEnded. */
  onRelease: () => void;
}

export interface RideGestureOptions {
  chartRef: React.RefObject<HTMLDivElement | null>;
  p5InstanceRef: React.RefObject<p5 | null>;
  /** True while the position is open. Drives PnL line + emoji burst. */
  isHolding: boolean;
  /** Most recent observed spot in chart units. If supplied, the canvas
   *  drifts toward it instead of pure random walk. */
  liveSpot?: number;
  /** Optional barrier price to draw as a dashed horizontal line. */
  barrier?: number;
  /** Direction: 0 = touch-from-below (barrier above spot), 1 = above. */
  barrierDirection?: 0 | 1;
  /** Touch payout multiplier in bps (e.g. 20000 = 2.0x). Drives live PnL. */
  multiplierBps?: number;
  /** Premium burn rate in $/sec — how fast the held position accrues stake. */
  stakeRatePerSec?: number;
  /** Live PnL callback — fired ~12x/sec while a ride is held. The figure is
   *  a mark-to-market of the touch position derived from the chart the user
   *  is actually watching, so it is genuinely real-time / zero-latency. */
  onPnlChange?: (snap: { pnl: number; staked: number }) => void;
  callbacks: RideGestureCallbacks;
  /** Disable press handling (e.g. wallet not connected, signing in flight). */
  disabled?: boolean;
}

// ── Tunables ────────────────────────────────────────────────────────────────
// A real candlestick chart runs on TWO clocks: a fast price feed, and a
// slower candle period. The right-most candle is "live" — it grows in place
// as sub-prices arrive, then freezes when the period rolls. Closed candles
// never move again. That is what makes the chart read as a stock trading
// organically instead of a snake of pop-in candles sliding back and forth.
const PRICE_TICK_MS = 100; // a new sub-price arrives this often
const CANDLE_PERIOD_MS = 900; // the live candle freezes + a fresh one opens
const MAX_VISIBLE_CANDLES_MOBILE = 4;
const MAX_VISIBLE_CANDLES_DESKTOP = 6;

interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  animation: number;
}

interface PositionState {
  entryPrice: number;
  candlesElapsed: number;
}

interface CompletedTrade {
  entryPrice: number;
  exitPrice: number;
  profit: number;
  candlesElapsed: number;
  exitElapsed: number;
}

export function useRideGesture(opts: RideGestureOptions) {
  const {
    chartRef,
    p5InstanceRef,
    isHolding,
    liveSpot,
    barrier,
    barrierDirection,
    multiplierBps,
    stakeRatePerSec,
    onPnlChange,
    callbacks,
    disabled = false,
  } = opts;

  // Refs the p5 closure reads on every frame. We avoid recreating the p5
  // instance when these change.
  const stateRef = useRef({
    isHolding,
    // pnl is computed INSIDE the p5 loop (mark-to-market of the chart the
    // user is watching) — it is not a prop. The loop writes it every frame;
    // drawing + the close-FX read it.
    pnl: 0,
    liveSpot,
    barrier,
    barrierDirection,
    multiplierBps: multiplierBps ?? 20000,
    stakeRatePerSec: stakeRatePerSec ?? 0.2,
    disabled,
  });
  const callbacksRef = useRef(callbacks);
  const onPnlChangeRef = useRef(onPnlChange);

  useEffect(() => {
    stateRef.current.isHolding = isHolding;
  }, [isHolding]);
  useEffect(() => {
    stateRef.current.liveSpot = liveSpot;
  }, [liveSpot]);
  useEffect(() => {
    stateRef.current.barrier = barrier;
  }, [barrier]);
  useEffect(() => {
    stateRef.current.barrierDirection = barrierDirection;
  }, [barrierDirection]);
  useEffect(() => {
    stateRef.current.multiplierBps = multiplierBps ?? 20000;
  }, [multiplierBps]);
  useEffect(() => {
    stateRef.current.stakeRatePerSec = stakeRatePerSec ?? 0.2;
  }, [stakeRatePerSec]);
  useEffect(() => {
    stateRef.current.disabled = disabled;
  }, [disabled]);
  useEffect(() => {
    callbacksRef.current = callbacks;
  }, [callbacks]);
  useEffect(() => {
    onPnlChangeRef.current = onPnlChange;
  }, [onPnlChange]);

  useEffect(() => {
    let p5Mod: typeof p5 | null = null;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    void import("p5").then((mod) => {
      if (cancelled) return;
      p5Mod = (mod.default ?? mod) as typeof p5;
      const sketch = (p: p5) => {
        // ── Local mutable state, scoped to this p5 instance ────────────────
        // candles[] holds CLOSED candles plus, as the final element, the one
        // "live" candle currently forming at the right edge.
        let candles: Candle[] = [];
        let candleWidth = p.windowWidth < 768 ? 6 : 9;
        let candleSpacing = p.windowWidth < 768 ? 9 : 13;
        let maxCandles = p.windowWidth < 768
          ? Math.floor(p.windowWidth / candleSpacing * 0.6) || MAX_VISIBLE_CANDLES_MOBILE
          : Math.floor(p.windowWidth / candleSpacing * 0.7) || MAX_VISIBLE_CANDLES_DESKTOP;
        let priceScale = { min: 0, max: 100 };
        let priceScaleInit = false;
        let chartArea = { x: 30, y: 90, width: 0, height: 0 };
        let gridAlpha = 0;
        let pulseAnimation = 0;
        // Two clocks (see PRICE_TICK_MS / CANDLE_PERIOD_MS).
        let lastTickMs = 0;
        let liveCandleStartMs = 0;
        // PnL bookkeeping for the currently-held position.
        let positionOpenedAtMs = 0;
        let lastPnlReportMs = 0;

        // Seed the synthesized walk near the live oracle spot when we have
        // one; otherwise sit it just inside the barrier so the price line
        // and the barrier line always share a sanely-scaled y-axis. (A bad
        // seed — e.g. 100 against a $1030 barrier — collapses the walk into
        // a flat line, because the far-off barrier blows up the y-range.)
        const seedClose = (): number => {
          const ls = stateRef.current.liveSpot;
          if (ls && ls > 0 && Number.isFinite(ls)) return ls;
          const b = stateRef.current.barrier;
          if (b && b > 0 && Number.isFinite(b)) {
            return stateRef.current.barrierDirection === 1 ? b * 1.01 : b * 0.99;
          }
          return 100;
        };
        let lastClose = seedClose();
        // Momentum carries a trend across candles so the walk *sweeps*
        // toward / away from the barrier instead of dead-flat jitter.
        let momentum = 0;

        // Position state, set on press.
        let currentPosition: PositionState | null = null;
        let completedTrades: CompletedTrade[] = [];
        let pnlLineEndPos: { x: number; y: number } | null = null;

        // Animation / FX state.
        let activeMoneyEmojis: MoneyEmoji[] = [];
        let shouldExplodeEmojis = false;
        let explosionCenter: { x: number; y: number } | null = null;
        let lastEmojiTime = 0;
        let screenShake = 0;
        let lossFlash = 0;

        // ── MoneyEmoji class — ported verbatim, scoped to this p5 ──────────
        class MoneyEmoji {
          x: number;
          y: number;
          vx: number;
          vy: number;
          scale: number;
          rotation: number;
          rotationSpeed: number;
          opacity: number;
          gravity: number;
          drag: number;
          lifetime: number;
          maxLifetime: number;
          exploding: boolean;
          explosionVx: number;
          explosionVy: number;

          constructor(x: number, y: number) {
            this.x = x;
            this.y = y;
            this.vx = (Math.random() - 0.5) * 8;
            this.vy = -Math.random() * 10 - 5;
            this.scale = 0.8 + Math.random() * 0.6;
            this.rotation = Math.random() * 360;
            this.rotationSpeed = (Math.random() - 0.5) * 20;
            this.opacity = 255;
            this.gravity = 0.5;
            this.drag = 0.98;
            this.lifetime = 0;
            this.maxLifetime = this.calcLifetime();
            this.exploding = false;
            this.explosionVx = 0;
            this.explosionVy = 0;
          }

          calcLifetime() {
            const n = activeMoneyEmojis.length;
            if (n <= 3) return 2500;
            if (n <= 6) return 2000;
            if (n <= 10) return 1500;
            return 1000;
          }

          explode(cx: number, cy: number) {
            this.exploding = true;
            const baseAngle = Math.atan2(this.y - cy, this.x - cx);
            const leftBias = -Math.PI * 0.3;
            const randomSpread = (Math.random() - 0.5) * Math.PI * 1.2;
            const angle = baseAngle + leftBias + randomSpread;
            const force = 20 + Math.random() * 15;
            this.explosionVx = Math.cos(angle) * force;
            this.explosionVy = Math.sin(angle) * force;
            this.gravity = 0.8;
          }

          update(): boolean {
            this.lifetime += 16;
            if (this.exploding) {
              this.vx = this.explosionVx;
              this.vy = this.explosionVy;
              this.explosionVx *= 0.95;
              this.explosionVy *= 0.95;
            }
            const n = activeMoneyEmojis.length;
            let g = this.gravity;
            if (n <= 3) g *= 0.4;
            else if (n <= 6) g *= 0.6;
            else if (n <= 10) g *= 0.8;
            this.vy += g;
            this.vx *= this.drag;
            this.vy *= this.drag;
            this.x += this.vx;
            this.y += this.vy;
            this.rotation += this.rotationSpeed;
            if (this.lifetime > this.maxLifetime * 0.7) {
              this.opacity = p.map(
                this.lifetime,
                this.maxLifetime * 0.7,
                this.maxLifetime,
                255,
                0,
              );
            }
            return this.lifetime > this.maxLifetime || this.y > p.height + 50;
          }

          draw() {
            p.push();
            p.translate(this.x, this.y);
            p.rotate(p.radians(this.rotation));
            p.scale(this.scale);
            p.textAlign(p.CENTER, p.CENTER);
            p.textSize(45);
            p.fill(255, 255, 255, this.opacity);
            p.text("💵", 0, 0);
            p.pop();
          }
        }

        const updateMoneyEmojis = () => {
          activeMoneyEmojis = activeMoneyEmojis.filter((e) => {
            const remove = e.update();
            if (!remove) e.draw();
            return !remove;
          });
          const maxEmojis = 15;
          if (activeMoneyEmojis.length > maxEmojis) {
            activeMoneyEmojis = activeMoneyEmojis.slice(-maxEmojis);
          }
          if (activeMoneyEmojis.length > 12) {
            activeMoneyEmojis.forEach((e) => {
              e.maxLifetime = Math.max(800, e.maxLifetime * 0.8);
            });
          }
          if (shouldExplodeEmojis && explosionCenter) {
            const now = p.millis();
            const cooldown = 200;
            if (now - lastEmojiTime > cooldown) {
              let n = 4;
              if (activeMoneyEmojis.length > 6) n = 3;
              if (activeMoneyEmojis.length > 10) n = 2;
              if (activeMoneyEmojis.length > 15) n = 1;
              if (activeMoneyEmojis.length > 18) n = 0;
              for (let i = 0; i < n; i++) {
                const emoji = new MoneyEmoji(
                  explosionCenter.x + (Math.random() - 0.5) * 60,
                  explosionCenter.y + (Math.random() - 0.5) * 40,
                );
                emoji.explode(explosionCenter.x, explosionCenter.y);
                activeMoneyEmojis.push(emoji);
              }
              lastEmojiTime = now;
            }
            shouldExplodeEmojis = false;
          }
        };

        // ── Price walk — one sub-price per PRICE_TICK_MS ───────────────────
        // A momentum random walk: a slow-varying trend term makes the chart
        // *sweep* organically (runs that build, decay, reverse); a gentle
        // pull toward the live oracle keeps it honest and on-screen. Tuned
        // so a held ride has a real but not certain shot at the barrier.
        const nextPrice = (): number => {
          const live = stateRef.current.liveSpot;
          const anchor =
            live && live > 0 && Number.isFinite(live) ? live : lastClose;
          momentum += (Math.random() - 0.5) * lastClose * 0.0007;
          momentum *= 0.93;
          const mcap = lastClose * 0.004;
          momentum = Math.max(-mcap, Math.min(mcap, momentum));
          const revert = (anchor - lastClose) * 0.004;
          const vol = Math.max(0.2, lastClose * 0.001);
          lastClose =
            lastClose + momentum + revert + (Math.random() - 0.5) * vol;
          if (lastClose < 1) lastClose = 1;
          return lastClose;
        };

        const newLiveCandle = (seed: number): Candle => ({
          open: seed,
          high: seed,
          low: seed,
          close: seed,
          animation: 0,
        });

        // Fold one sub-price into the live (right-most) candle — it grows
        // in place, exactly like the forming candle on a real chart.
        const feedLiveCandle = (price: number) => {
          const live = candles[candles.length - 1];
          if (!live) return;
          live.close = price;
          if (price > live.high) live.high = price;
          if (price < live.low) live.low = price;
        };

        // Freeze the live candle (it just stays put in the array) and open a
        // fresh one. Closed candles never move again — the chart scrolls one
        // candle per period, it does not snake.
        const rollCandle = () => {
          candles.push(newLiveCandle(lastClose));
          if (candles.length > maxCandles) candles.shift();
          if (currentPosition) currentPosition.candlesElapsed++;
          for (const t of completedTrades) {
            t.candlesElapsed++;
            t.exitElapsed++;
          }
          // Prune old completed trades — keep the chart legible.
          completedTrades = completedTrades.filter(
            (t) => t.exitElapsed < maxCandles,
          );
        };

        const updatePriceScale = () => {
          if (candles.length === 0) return;
          let min = Infinity;
          let max = -Infinity;
          for (const c of candles) {
            min = Math.min(min, c.low);
            max = Math.max(max, c.high);
          }
          if (currentPosition) {
            min = Math.min(min, currentPosition.entryPrice);
            max = Math.max(max, currentPosition.entryPrice);
          }
          const b = stateRef.current.barrier;
          if (b && Number.isFinite(b) && b > 0) {
            min = Math.min(min, b);
            max = Math.max(max, b);
          }
          const range = Math.max(max - min, 0.01);
          const isMobile = p.windowWidth < 768;
          const topPadding = range * (isMobile ? 0.12 : 0.15);
          const bottomPadding = range * (isMobile ? 0.15 : 0.18);
          const targetMin = Math.max(0, min - bottomPadding);
          const targetMax = max + topPadding;
          // Glide the axis toward its target instead of snapping it every
          // frame — a hard re-fit each tick is what made the whole chart
          // slide up and down like a snake.
          if (!priceScaleInit) {
            priceScale.min = targetMin;
            priceScale.max = targetMax;
            priceScaleInit = true;
          } else {
            priceScale.min = p.lerp(priceScale.min, targetMin, 0.06);
            priceScale.max = p.lerp(priceScale.max, targetMax, 0.06);
          }
        };

        // ── Drawing primitives ─────────────────────────────────────────────
        const drawGrid = () => {
          p.stroke(255, 255, 255, gridAlpha * 0.65);
          p.strokeWeight(0.5);
          p.drawingContext.setLineDash([5, 3]);
          const gridLines = p.width < 768 ? 5 : 8;
          for (let i = 0; i <= gridLines; i++) {
            const y = chartArea.y + (chartArea.height * i) / gridLines;
            p.line(chartArea.x, y, chartArea.x + chartArea.width, y);
          }
          const vlines = Math.floor(p.width / (p.width < 768 ? 60 : 100));
          for (let i = 0; i <= vlines; i++) {
            const x = chartArea.x + (chartArea.width * i) / vlines;
            p.line(x, chartArea.y, x, chartArea.y + chartArea.height);
          }
          p.drawingContext.setLineDash([]);
        };

        const drawBarrier = () => {
          const b = stateRef.current.barrier;
          if (!b || !Number.isFinite(b) || b <= 0) return;
          const y = p.map(
            b,
            priceScale.min,
            priceScale.max,
            chartArea.y + chartArea.height,
            chartArea.y,
          );
          // Glow pulse
          const pulse = 60 + Math.sin(p.millis() * 0.003) * 30;
          const dir = stateRef.current.barrierDirection;
          const color =
            dir === 1 ? [255, 100, 100] : [255, 220, 80]; // touch-from-above red-ish, default warm
          p.stroke(color[0], color[1], color[2], pulse);
          p.strokeWeight(2);
          p.drawingContext.setLineDash([10, 6]);
          p.line(chartArea.x, y, chartArea.x + chartArea.width, y);
          p.drawingContext.setLineDash([]);
          // Label
          p.noStroke();
          p.fill(color[0], color[1], color[2], 220);
          p.textAlign(p.RIGHT, p.BOTTOM);
          p.textSize(p.width < 768 ? 10 : 12);
          p.text(
            `barrier $${b < 100 ? b.toFixed(2) : b.toFixed(0)}`,
            chartArea.x + chartArea.width - 6,
            y - 4,
          );
        };

        const drawCandles = () => {
          for (let dist = 0; dist < candles.length; dist++) {
            const c = candles[candles.length - 1 - dist]!;
            c.animation = p.lerp(c.animation, 1, 0.12);
            const rightPadding = 8;
            const x =
              chartArea.x +
              chartArea.width -
              candleWidth -
              rightPadding -
              dist * candleSpacing;
            if (x + candleWidth < chartArea.x - 1) continue;
            const openY = p.map(
              c.open,
              priceScale.min,
              priceScale.max,
              chartArea.y + chartArea.height,
              chartArea.y,
            );
            const closeY = p.map(
              c.close,
              priceScale.min,
              priceScale.max,
              chartArea.y + chartArea.height,
              chartArea.y,
            );
            const highY = p.map(
              c.high,
              priceScale.min,
              priceScale.max,
              chartArea.y + chartArea.height,
              chartArea.y,
            );
            const lowY = p.map(
              c.low,
              priceScale.min,
              priceScale.max,
              chartArea.y + chartArea.height,
              chartArea.y,
            );
            const isGreen = c.close > c.open;
            const color = isGreen ? [0, 255, 136] : [255, 255, 255];
            // Wick glow on leading candles
            if (dist < 3) {
              p.stroke(color[0], color[1], color[2], 40 * c.animation);
              p.strokeWeight(2);
              p.line(x + candleWidth / 2, highY, x + candleWidth / 2, lowY);
            }
            // Wick line
            p.stroke(color[0], color[1], color[2], 160 * c.animation);
            p.strokeWeight(1);
            p.line(x + candleWidth / 2, highY, x + candleWidth / 2, lowY);
            const bodyHeight = Math.abs(closeY - openY);
            const bodyY = Math.min(openY, closeY);
            // Pulse halo on the leading candle
            if (dist === 0) {
              const pulseSize = p.sin(pulseAnimation) * 1;
              p.fill(color[0], color[1], color[2], 25 * c.animation);
              p.noStroke();
              p.rect(
                x - pulseSize,
                bodyY - pulseSize,
                candleWidth + pulseSize * 2,
                Math.max(bodyHeight, 1) + pulseSize * 2,
                1,
              );
            }
            // Body
            if (isGreen) {
              p.fill(color[0], color[1], color[2], 180 * c.animation);
              p.noStroke();
              p.rect(x, bodyY, candleWidth, Math.max(bodyHeight, 1), 1);
            } else {
              p.fill(12, 12, 12, 220 * c.animation);
              p.stroke(color[0], color[1], color[2], 200 * c.animation);
              p.strokeWeight(1);
              p.rect(x, bodyY, candleWidth, Math.max(bodyHeight, 1), 1);
            }
            if (bodyHeight < 1) {
              p.stroke(color[0], color[1], color[2], 180 * c.animation);
              p.strokeWeight(1.5);
              p.line(x, openY, x + candleWidth, openY);
            }
          }
        };

        const drawPriceLine = () => {
          if (candles.length === 0) return;
          const last = candles[candles.length - 1]!;
          const y = p.map(
            last.close,
            priceScale.min,
            priceScale.max,
            chartArea.y + chartArea.height,
            chartArea.y,
          );
          const labelWidth = p.width < 768 ? 50 : 62;
          const labelHeight = p.width < 768 ? 18 : 22;
          const fontSize = p.width < 768 ? 10 : 12;
          const labelX = p.width - labelWidth - 2;
          p.fill(247, 147, 26, 255);
          p.noStroke();
          p.rect(labelX, y - labelHeight / 2, labelWidth, labelHeight, 4);
          p.fill(0, 0, 0, 255);
          p.textAlign(p.CENTER, p.CENTER);
          p.textSize(fontSize);
          p.textStyle(p.BOLD);
          const t = last.close < 100 ? last.close.toFixed(2) : last.close.toFixed(0);
          p.text(`$${t}`, labelX + labelWidth / 2, y);
          p.textStyle(p.NORMAL);
        };

        const drawPriceLabels = () => {
          const fontSize = p.width < 768 ? 8 : 10;
          const labelCount = p.width < 768 ? 5 : 7;
          p.fill(255, 255, 255, 120);
          p.textAlign(p.CENTER, p.CENTER);
          p.textSize(fontSize);
          const rightMargin = p.width < 768 ? 38 : 50;
          const chartRightEdge = chartArea.x + chartArea.width;
          const labelCenterX = chartRightEdge + rightMargin / 2;
          for (let i = 0; i <= labelCount; i++) {
            let y = chartArea.y + (chartArea.height * i) / labelCount;
            if (i === labelCount) y -= 6;
            const price = p.map(i, 0, labelCount, priceScale.max, priceScale.min);
            const t = price < 100 ? price.toFixed(2) : price.toFixed(0);
            p.text(`$${t}`, labelCenterX, y);
          }
        };

        const drawSinglePNLLine = (
          trade: PositionState | CompletedTrade,
          isCompleted: boolean,
        ) => {
          if (candles.length === 0) return;
          const last = candles[candles.length - 1]!;
          const rightPadding = 8;
          const currentCandleX =
            chartArea.x + chartArea.width - candleWidth - rightPadding;
          const entryElapsed = trade.candlesElapsed;
          const exitElapsed = isCompleted
            ? (trade as CompletedTrade).exitElapsed
            : 0;
          const exitPrice = isCompleted
            ? (trade as CompletedTrade).exitPrice
            : last.close;
          const tradePnl = isCompleted
            ? (trade as CompletedTrade).profit
            : stateRef.current.pnl;
          const entryY = p.map(
            trade.entryPrice,
            priceScale.min,
            priceScale.max,
            chartArea.y + chartArea.height,
            chartArea.y,
          );
          const exitY = p.map(
            exitPrice,
            priceScale.min,
            priceScale.max,
            chartArea.y + chartArea.height,
            chartArea.y,
          );
          const actualEntryX = currentCandleX - entryElapsed * candleSpacing;
          const actualExitX = currentCandleX - exitElapsed * candleSpacing;
          const entryXForSlope = actualEntryX + candleWidth / 2;
          let adjustedExitX = actualExitX + candleWidth / 2;
          let adjustedExitY = exitY;
          if (!isCompleted && entryElapsed === 0) {
            adjustedExitX += Math.min(candleSpacing * 3, 60);
            adjustedExitY = entryY;
          }
          const slope =
            (adjustedExitY - entryY) / (adjustedExitX - entryXForSlope);
          const entryVisible = actualEntryX >= chartArea.x;
          let lineStartX = entryVisible ? entryXForSlope : chartArea.x;
          let lineStartY = entryVisible
            ? entryY
            : entryY + slope * (chartArea.x - entryXForSlope);
          const centerY = chartArea.y + chartArea.height / 2;
          const maxDeviation = chartArea.height * 0.35;
          if (Math.abs(lineStartY - centerY) > maxDeviation) {
            lineStartY =
              lineStartY > centerY
                ? centerY + maxDeviation
                : centerY - maxDeviation;
          }
          lineStartY = Math.max(
            chartArea.y + 10,
            Math.min(chartArea.y + chartArea.height - 10, lineStartY),
          );
          const finalEndX = Math.min(
            adjustedExitX,
            chartArea.x + chartArea.width - rightPadding - 5,
          );
          const lineEndY = adjustedExitY;
          if (!isCompleted && tradePnl >= 0) {
            pnlLineEndPos = { x: finalEndX, y: lineEndY };
          }
          if (!isCompleted && entryElapsed === 0) {
            // Immediate stub line + pulsing dot at entry
            const sx = currentCandleX + candleWidth / 2;
            const ex = Math.min(
              sx + 80,
              chartArea.x + chartArea.width - rightPadding - 10,
            );
            if (tradePnl >= 0) pnlLineEndPos = { x: ex, y: entryY };
            p.stroke(255, 255, 255, 255);
            p.strokeWeight(3);
            p.line(sx, entryY, ex, entryY);
            const dotPulse = 4 + Math.sin(p.millis() * 0.01) * 2;
            p.fill(255, 255, 255, 255);
            p.noStroke();
            p.ellipse(sx, entryY, 8 + dotPulse, 8 + dotPulse);
            return;
          }
          if (finalEndX < lineStartX) return;
          const isProfit = tradePnl >= 0;
          const lc = isProfit ? [0, 255, 136] : [255, 68, 68];
          const alpha = isCompleted ? 180 : 255;
          p.stroke(lc[0], lc[1], lc[2], alpha * 0.3);
          p.strokeWeight(6);
          p.line(lineStartX, lineStartY, finalEndX, lineEndY);
          p.stroke(lc[0], lc[1], lc[2], alpha);
          p.strokeWeight(3);
          p.line(lineStartX, lineStartY, finalEndX, lineEndY);
          if (entryVisible) {
            p.fill(255, 255, 255, alpha);
            p.noStroke();
            p.ellipse(lineStartX, lineStartY, 8, 8);
          }
          if (isCompleted) {
            p.fill(255, 255, 255, alpha);
            p.noStroke();
            p.ellipse(finalEndX, lineEndY, 8, 8);
          }
        };

        const drawPNLLine = () => {
          for (const t of completedTrades) drawSinglePNLLine(t, true);
          if (currentPosition) drawSinglePNLLine(currentPosition, false);
        };

        // ── Position lifecycle ─────────────────────────────────────────────
        const startPosition = () => {
          const s = stateRef.current;
          if (s.disabled) return;
          if (candles.length === 0) return;
          if (currentPosition) return; // already holding
          const last = candles[candles.length - 1]!;
          currentPosition = {
            entryPrice: last.close,
            candlesElapsed: 0,
          };
          positionOpenedAtMs = p.millis();
          lastPnlReportMs = 0;
          stateRef.current.pnl = 0;
          callbacksRef.current.onPress(last.close);
        };

        const closePosition = () => {
          if (!currentPosition) return;
          const last = candles[candles.length - 1]!;
          const profit = stateRef.current.pnl;
          completedTrades.push({
            entryPrice: currentPosition.entryPrice,
            exitPrice: last.close,
            profit,
            candlesElapsed: currentPosition.candlesElapsed,
            exitElapsed: 0,
          });
          if (profit > 0) {
            if (pnlLineEndPos) {
              shouldExplodeEmojis = true;
              explosionCenter = { x: pnlLineEndPos.x, y: pnlLineEndPos.y };
            }
            tryPlayAudio(
              "https://assets.mixkit.co/active_storage/sfx/2003/2003-preview.mp3",
              0.7,
            );
          } else if (profit < 0) {
            screenShake = 15;
            lossFlash = 255;
            tryPlayAudio(
              "https://assets.mixkit.co/active_storage/sfx/2037/2037-preview.mp3",
              0.6,
            );
          }
          currentPosition = null;
          pnlLineEndPos = null;
          stateRef.current.pnl = 0;
          onPnlChangeRef.current?.({ pnl: 0, staked: 0 });
          callbacksRef.current.onRelease();
        };

        const tryPlayAudio = (url: string, volume: number) => {
          try {
            const a = new Audio(url);
            a.volume = volume;
            void a.play().catch(() => {
              // iOS will reject if no recent user gesture — silently swallow.
            });
          } catch {
            // ignore
          }
        };

        // ── Live PnL ───────────────────────────────────────────────────────
        // The number the user sees is a mark-to-market of the touch
        // position, derived from the *chart they are watching* — not a laggy
        // chain poll of a static object — so it moves every single tick.
        // It is an estimate; the realized result is whatever the chain
        // settles at close (shown in the settlement card).
        const updateLivePnl = (now: number) => {
          if (!currentPosition) return;
          const s = stateRef.current;
          const elapsedSec = Math.max(0, (now - positionOpenedAtMs) / 1000);
          const staked = elapsedSec * s.stakeRatePerSec;
          const mult = s.multiplierBps / 10000;
          const live = candles[candles.length - 1];
          const spot = live ? live.close : currentPosition.entryPrice;
          const entry = currentPosition.entryPrice;
          const b = s.barrier;
          let proximity = 0;
          if (b && Number.isFinite(b) && b > 0 && b !== entry) {
            // 0 at entry, 1 at the barrier, negative if price runs away.
            proximity =
              s.barrierDirection === 1
                ? (entry - spot) / (entry - b)
                : (spot - entry) / (b - entry);
          }
          proximity = Math.max(-1.2, Math.min(1.05, proximity));
          // Mark scales with premium burned (hold time) and progress to
          // the barrier — green as you close in, red as price runs away.
          const livePnl = staked * (mult - 1) * proximity;
          s.pnl = livePnl;
          if (now - lastPnlReportMs >= 80) {
            lastPnlReportMs = now;
            onPnlChangeRef.current?.({ pnl: livePnl, staked });
          }
        };

        // ── p5 lifecycle ───────────────────────────────────────────────────
        p.setup = () => {
          p.createCanvas(p.windowWidth, p.windowHeight);
          p.strokeCap(p.ROUND);
          // Use the system Geist font that the document already loads — no
          // need to load a webfont via p.loadFont (which would block).
          p.textFont("Geist, system-ui, sans-serif");
          const isMobile = p.windowWidth < 768;
          const leftMargin = isMobile ? 4 : 8;
          const rightMargin = isMobile ? 40 : 56;
          const topMargin = getTopMargin();
          const bottomInset = getSafeBottom();
          chartArea = {
            x: leftMargin,
            y: topMargin,
            width: p.windowWidth - leftMargin - rightMargin,
            height:
              p.windowHeight - topMargin + bottomInset - (isStandalone ? 15 : 8),
          };
          p.resizeCanvas(p.windowWidth, p.windowHeight + bottomInset);
          candleWidth = isMobile ? 6 : 9;
          candleSpacing = isMobile ? 9 : 13;
          maxCandles = Math.floor(chartArea.width / candleSpacing);
          // Pre-build a full screen of CLOSED candles so the chart opens
          // already scrolling — each one a genuine OHLC of ~9 sub-prices.
          const ticksPerCandle = Math.round(CANDLE_PERIOD_MS / PRICE_TICK_MS);
          const seedCount = Math.max(20, maxCandles - 1);
          for (let i = 0; i < seedCount; i++) {
            const open = lastClose;
            let hi = open;
            let lo = open;
            let close = open;
            for (let k = 0; k < ticksPerCandle; k++) {
              close = nextPrice();
              if (close > hi) hi = close;
              if (close < lo) lo = close;
            }
            candles.push({ open, high: hi, low: lo, close, animation: 1 });
          }
          // The live candle the feed grows from here on.
          candles.push(newLiveCandle(lastClose));
          liveCandleStartMs = p.millis();
          lastTickMs = p.millis();
        };

        p.draw = () => {
          p.background(12, 12, 12);
          if (screenShake > 0) {
            p.translate(
              (Math.random() - 0.5) * screenShake,
              (Math.random() - 0.5) * screenShake,
            );
            screenShake *= 0.9;
            if (screenShake < 0.1) screenShake = 0;
          }
          if (lossFlash > 0) {
            p.fill(255, 0, 0, lossFlash * 0.1);
            p.noStroke();
            p.rect(0, 0, p.width, p.height);
            lossFlash *= 0.85;
            if (lossFlash < 1) lossFlash = 0;
          }
          pulseAnimation += 0.1;
          const now = p.millis();

          // ── Two-clock candle feed ────────────────────────────────────────
          // If the tab was backgrounded, resync rather than replay a flood.
          if (now - lastTickMs > 1500) lastTickMs = now - PRICE_TICK_MS;
          if (now - liveCandleStartMs > 5000) liveCandleStartMs = now;
          // Fast clock: fold sub-prices into the live candle (it grows).
          while (now - lastTickMs >= PRICE_TICK_MS) {
            lastTickMs += PRICE_TICK_MS;
            feedLiveCandle(nextPrice());
          }
          // Slow clock: freeze the live candle, open a fresh one.
          if (now - liveCandleStartMs >= CANDLE_PERIOD_MS) {
            rollCandle();
            liveCandleStartMs = now;
          }

          // Live PnL — mark-to-market of the chart, reported ~12x/sec.
          updateLivePnl(now);

          updatePriceScale();
          drawGrid();
          drawBarrier();
          drawCandles();
          drawPriceLine();
          drawPriceLabels();
          drawPNLLine();
          gridAlpha = p.lerp(gridAlpha, 40, 0.1);
          if (!stateRef.current.isHolding || stateRef.current.pnl <= 0) {
            pnlLineEndPos = null;
          }
          updateMoneyEmojis();
        };

        p.windowResized = () => {
          p.resizeCanvas(p.windowWidth, p.windowHeight);
          p.strokeCap(p.ROUND);
          const isMobile = p.windowWidth < 768;
          const leftMargin = isMobile ? 4 : 8;
          const rightMargin = isMobile ? 40 : 56;
          const topMargin = getTopMargin();
          const bottomInset = getSafeBottom();
          chartArea = {
            x: leftMargin,
            y: topMargin,
            width: p.windowWidth - leftMargin - rightMargin,
            height:
              p.windowHeight - topMargin + bottomInset - (isStandalone ? 15 : 8),
          };
          p.resizeCanvas(p.windowWidth, p.windowHeight + bottomInset);
          candleWidth = isMobile ? 6 : 9;
          candleSpacing = isMobile ? 9 : 13;
          maxCandles = Math.floor(chartArea.width / candleSpacing);
        };

        // ── Mouse/touch handlers — dedupe is load-bearing on iOS ───────────
        let touchActive = false;
        p.mousePressed = () => {
          if (stateRef.current.disabled) return true;
          try {
            if (!touchActive) startPosition();
          } catch {
            // ignore
          }
          return false;
        };
        p.mouseReleased = () => {
          if (stateRef.current.disabled) return true;
          try {
            if (!touchActive) closePosition();
          } catch {
            // ignore
          }
          return false;
        };
        p.touchStarted = (event?: unknown) => {
          if (stateRef.current.disabled) return true;
          touchActive = true;
          try {
            startPosition();
          } catch {
            // ignore
          }
          if (event && typeof event === "object" && "preventDefault" in event) {
            (event as Event).preventDefault();
          }
          return false;
        };
        p.touchMoved = (event?: unknown) => {
          if (event && typeof event === "object" && "preventDefault" in event) {
            (event as Event).preventDefault();
          }
          return false;
        };
        p.touchEnded = (event?: unknown) => {
          if (stateRef.current.disabled) return true;
          touchActive = false;
          try {
            closePosition();
          } catch {
            // ignore
          }
          if (event && typeof event === "object" && "preventDefault" in event) {
            (event as Event).preventDefault();
          }
          return false;
        };
      };

      if (!chartRef.current || !p5Mod) return;
      const inst = new p5Mod(sketch, chartRef.current);
      p5InstanceRef.current = inst;
      cleanup = () => inst.remove();
    });

    return () => {
      cancelled = true;
      if (cleanup) cleanup();
      p5InstanceRef.current = null;
    };
    // We intentionally only re-init the p5 instance once. State updates flow
    // through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
