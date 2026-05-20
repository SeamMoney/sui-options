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
  /** $-denominated live PnL of the open position. Drives line color + glow. */
  pnl: number;
  /** Most recent observed spot in chart units. If supplied, the canvas
   *  drifts toward it instead of pure random walk. */
  liveSpot?: number;
  /** Optional barrier price to draw as a dashed horizontal line. */
  barrier?: number;
  /** Direction: 0 = touch-from-below (barrier above spot), 1 = above. */
  barrierDirection?: 0 | 1;
  callbacks: RideGestureCallbacks;
  /** Disable press handling (e.g. wallet not connected, signing in flight). */
  disabled?: boolean;
}

// ── Tunables (mirrors the cash-trading-game look) ───────────────────────────
const CANDLE_INTERVAL_MS = 120; // a touch slower than CTG's 65ms — feels less frantic for a real-money product
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
    pnl,
    liveSpot,
    barrier,
    barrierDirection,
    callbacks,
    disabled = false,
  } = opts;

  // Refs the p5 closure reads on every frame. We avoid recreating the p5
  // instance when these change.
  const stateRef = useRef({
    isHolding,
    pnl,
    liveSpot,
    barrier,
    barrierDirection,
    disabled,
  });
  const callbacksRef = useRef(callbacks);

  useEffect(() => {
    stateRef.current.isHolding = isHolding;
  }, [isHolding]);
  useEffect(() => {
    stateRef.current.pnl = pnl;
  }, [pnl]);
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
    stateRef.current.disabled = disabled;
  }, [disabled]);
  useEffect(() => {
    callbacksRef.current = callbacks;
  }, [callbacks]);

  useEffect(() => {
    let p5Mod: typeof p5 | null = null;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    void import("p5").then((mod) => {
      if (cancelled) return;
      p5Mod = (mod.default ?? mod) as typeof p5;
      const sketch = (p: p5) => {
        // ── Local mutable state, scoped to this p5 instance ────────────────
        let candles: Candle[] = [];
        let intervalMs = CANDLE_INTERVAL_MS;
        let candleWidth = p.windowWidth < 768 ? 6 : 9;
        let candleSpacing = p.windowWidth < 768 ? 9 : 13;
        let maxCandles = p.windowWidth < 768
          ? Math.floor(p.windowWidth / candleSpacing * 0.6) || MAX_VISIBLE_CANDLES_MOBILE
          : Math.floor(p.windowWidth / candleSpacing * 0.7) || MAX_VISIBLE_CANDLES_DESKTOP;
        let priceScale = { min: 0, max: 100 };
        let chartArea = { x: 30, y: 90, width: 0, height: 0 };
        let gridAlpha = 0;
        let pulseAnimation = 0;
        let lastUpdate = 0;

        // Random-walk seed for the synthesized candle stream.
        let lastClose = stateRef.current.liveSpot ?? 100;
        // Track when we last sync'd to the live oracle spot so we drift
        // toward the real number without yanking the chart.
        let lastSyncSpot = lastClose;

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

        // ── Candle synthesis ───────────────────────────────────────────────
        const synthCandle = (): Candle => {
          // Drift slowly toward the live oracle spot when one is supplied.
          const live = stateRef.current.liveSpot;
          let drift = 0;
          if (live && live > 0 && Number.isFinite(live)) {
            if (Math.abs(live - lastSyncSpot) > lastSyncSpot * 0.02) {
              // Big move from the oracle since we last looked — bias the
              // walk hard toward the new spot so we don't lie to the user
              // about where the market is.
              drift = (live - lastClose) * 0.25;
              lastSyncSpot = live;
            } else {
              drift = (live - lastClose) * 0.05;
            }
          }
          const vol = Math.max(0.2, lastClose * 0.003);
          const open = lastClose;
          const close = open + drift + (Math.random() - 0.5) * vol * 2;
          const high = Math.max(open, close) + Math.random() * vol;
          const low = Math.min(open, close) - Math.random() * vol;
          lastClose = close;
          return { open, high, low, close, animation: 0 };
        };

        const addCandle = () => {
          const c = synthCandle();
          if (candles.length >= maxCandles) candles.shift();
          candles.push(c);
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
          priceScale.min = Math.max(0, min - bottomPadding);
          priceScale.max = max + topPadding;
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
          // Seed a few candles so the chart isn't empty on first paint.
          for (let i = 0; i < 30; i++) addCandle();
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
          if (now - lastUpdate > intervalMs) {
            addCandle();
            lastUpdate = now;
          }
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
