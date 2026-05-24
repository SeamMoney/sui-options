/**
 * useRideGestureV4 — v4 touch-either, always-open gesture + p5 candle chart
 * with the **laser-tracer** overlay (doc 25 §5).
 *
 * What's different from `useRideGesture` (v3):
 *
 *   1. NO upper/lower-half "pickedBarrier" affordance. Press ANYWHERE →
 *      `onOpen()` (no args). The ride is direction-neutral — touch either
 *      side wins the jackpot, so there's nothing to pick.
 *
 *   2. NO open-window gate. Every segment is open. The chart hook does
 *      not refuse a press based on "round phase."
 *
 *   3. NEW: `drawLaserTrace()` — a glowing line over the candles, colour-
 *      graded by proximity to the NEAREST barrier (emerald = close to a
 *      barrier / winning; rose = sitting at the midpoint / losing). Uses
 *      a soft-glow underlay + crisp-line top + pulsing live-spot dot.
 *      Per doc 25 §5.2.
 *
 *   4. PnL is now computed against the *nearer* of the two barriers (since
 *      either side wins). The "burned premium scales with held segments"
 *      part is unchanged.
 *
 *   5. The barrier-half hover tint (the soft emerald/rose split) is gone
 *      — there is no "pick a half" affordance any more. The lines remain
 *      as visible barriers (solid, not picker-state-dependent).
 *
 * Otherwise this hook is a direct fork of useRideGesture.ts to keep the
 * v3 hook untouched (still used by markets without a v4 deployment).
 *
 * Decoupling vs the chain layer is the same — phase + segment ring fed
 * in, callbacks fire on press / release / stall.
 */
import { useEffect, useRef } from "react";
import type p5 from "p5";
import {
  detectPostHocPattern,
  expandSegment,
  newState as newWalkState,
  type Candle as SeededCandle,
  type PostHocPatternMatch,
  type SegmentArmedPattern,
  type WalkState,
} from "@wick/sdk";
import { getTopMargin, getSafeBottom, isStandalone } from "@/utils/safeArea";

// ── Tunables (mirrors v3) ───────────────────────────────────────────────────
const CANDLES_PER_SEGMENT = 6;
const DEFAULT_SEGMENT_MS = 400;
const MIN_SEGMENT_MS = 250;
const MAX_SEGMENT_MS = 1200;
const MAX_CHART_CANDLES = 40;
const STALL_THRESHOLD_MS = 3000;

const PRICE_SCALING = 1_000_000;

export type RidePhase = "idle" | "opening" | "riding" | "closing";

export interface RideGestureV4Callbacks {
  /**
   * Called on press anywhere on the chart. V4 has no barrier-pick step —
   * the ride opens against BOTH barriers, touch either side wins.
   * Parent fires the on-chain `open_segment_ride_v4` and flips `phase`.
   */
  onOpen: () => void;
  /** Called on release while phase is "riding" or "opening". */
  onClose: () => void;
  /** Called when no segment event has arrived for ~STALL_THRESHOLD_MS. */
  onStall?: () => void;
}

export interface SegmentInputV4 {
  readonly k: bigint;
  readonly key: Uint8Array;
  readonly recordedAtMs: number;
}

export interface RoundInfoV4 {
  readonly index: bigint;
  readonly startedAtSegment: bigint;
  readonly upperBarrier: number;
  readonly lowerBarrier: number;
  readonly spotAtRoll: number;
  readonly roundDurationSegments: number;
}

export interface RideGestureV4Options {
  chartRef: React.RefObject<HTMLDivElement | null>;
  p5InstanceRef: React.RefObject<p5 | null>;
  phase: RidePhase;
  round: RoundInfoV4 | null;
  segments: ReadonlyArray<SegmentInputV4>;
  multiplierBps?: number;
  stakePerSegmentMicroUsd?: bigint;
  onPnlChange?: (snap: { pnl: number; staked: number }) => void;
  callbacks: RideGestureV4Callbacks;
  disabled?: boolean;
}

// ── Local chart-render types ─────────────────────────────────────────────────
interface RenderCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  animation: number;
  isLive: boolean;
  armedPattern?: ArmedPatternCue;
  postHocPatterns?: PostHocPatternCue[];
}

interface ArmedPatternCue {
  patternId: number;
  patternName: string;
  candlesRemaining: number;
  phase: SegmentArmedPattern["phase"];
  patternCandleIndex: number;
  patternCandleCount: number;
}

interface PostHocPatternCue {
  name: string;
  strength: number;
  label: string;
}

interface PositionStateV4 {
  entryPrice: number;
  entrySegmentIdx: number;
  upperBarrier: number;
  lowerBarrier: number;
}

interface CompletedTradeV4 {
  entryPrice: number;
  exitPrice: number;
  profit: number;
  entryAgeCandles: number;
  exitAgeCandles: number;
}

// ── Math helpers ────────────────────────────────────────────────────────────

const toDisplay = (microUsd: bigint | number): number =>
  Number(microUsd) / PRICE_SCALING;

function renderCandleFromSeeded(c: SeededCandle, animation: number): RenderCandle {
  return {
    open: toDisplay(c.open),
    high: toDisplay(c.high),
    low: toDisplay(c.low),
    close: toDisplay(c.close),
    animation,
    isLive: false,
    postHocPatterns: [],
  };
}

const armedCueFromSegment = (armed: SegmentArmedPattern): ArmedPatternCue => ({
  patternId: armed.patternId,
  patternName: armed.patternName,
  candlesRemaining: armed.candlesRemaining,
  phase: armed.phase,
  patternCandleIndex: armed.patternCandleIndex,
  patternCandleCount: armed.patternCandleCount,
});

const postHocCueFromMatch = (match: PostHocPatternMatch): PostHocPatternCue => ({
  name: match.name,
  strength: match.strength,
  label: match.label,
});

/**
 * Doc 25 §5.2 — `nearestBarrierProximity(spot, upper, lower) ∈ [0, 1]`.
 *   0 means the spot is AT a barrier (the player is winning).
 *   1 means the spot is exactly at the midpoint of the corridor
 *     (the player is losing the most they can — equidistant from both
 *     barriers).
 *
 * Returns clamped values; the caller can rely on [0, 1].
 */
export function nearestBarrierProximity(
  spot: number,
  upper: number,
  lower: number,
): number {
  if (upper <= lower) return 1;
  const width = upper - lower;
  // 0 at upper, 1 at midpoint (and beyond — but we clamp).
  const distUp = Math.max(0, ((upper - spot) / width) * 2);
  // 0 at lower, 1 at midpoint.
  const distDn = Math.max(0, ((spot - lower) / width) * 2);
  return Math.max(0, Math.min(1, Math.min(distUp, distDn)));
}

/**
 * 3-stop colour ramp used by the laser tracer:
 *   emerald-500 (#10b981) at t=0   — winning (close to a barrier)
 *   amber-500   (#f59e0b) at t=0.5 — neutral (between)
 *   rose-500    (#f43f5e) at t=1   — losing (sitting at midpoint)
 *
 * Returns [r, g, b], each ∈ [0, 255], suitable for `p.stroke(r, g, b, a)`.
 */
export function lerpProximityColor(t: number): [number, number, number] {
  const u = Math.max(0, Math.min(1, t));
  const emerald: [number, number, number] = [16, 185, 129];
  const amber: [number, number, number] = [245, 158, 11];
  const rose: [number, number, number] = [244, 63, 94];
  if (u <= 0.5) {
    const local = u / 0.5;
    return [
      Math.round(emerald[0] + (amber[0] - emerald[0]) * local),
      Math.round(emerald[1] + (amber[1] - emerald[1]) * local),
      Math.round(emerald[2] + (amber[2] - emerald[2]) * local),
    ];
  }
  const local = (u - 0.5) / 0.5;
  return [
    Math.round(amber[0] + (rose[0] - amber[0]) * local),
    Math.round(amber[1] + (rose[1] - amber[1]) * local),
    Math.round(amber[2] + (rose[2] - amber[2]) * local),
  ];
}

export function useRideGestureV4(opts: RideGestureV4Options) {
  const {
    chartRef,
    p5InstanceRef,
    phase,
    round,
    segments,
    multiplierBps,
    stakePerSegmentMicroUsd,
    onPnlChange,
    callbacks,
    disabled = false,
  } = opts;

  const stateRef = useRef({
    phase,
    round,
    segments,
    multiplierBps: multiplierBps ?? 17500,
    stakePerSegmentMicroUsd: stakePerSegmentMicroUsd ?? 200_000n,
    disabled,
    pnl: 0,
    stallFired: false,
  });
  const callbacksRef = useRef(callbacks);
  const onPnlChangeRef = useRef(onPnlChange);

  useEffect(() => {
    stateRef.current.phase = phase;
  }, [phase]);
  useEffect(() => {
    stateRef.current.round = round;
  }, [round]);
  useEffect(() => {
    stateRef.current.segments = segments;
    stateRef.current.stallFired = false;
  }, [segments]);
  useEffect(() => {
    stateRef.current.multiplierBps = multiplierBps ?? 17500;
  }, [multiplierBps]);
  useEffect(() => {
    stateRef.current.stakePerSegmentMicroUsd = stakePerSegmentMicroUsd ?? 200_000n;
  }, [stakePerSegmentMicroUsd]);
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
        let candles: RenderCandle[] = [];
        let seededCandles: SeededCandle[] = [];
        let walkState: WalkState | null = null;
        let highestExpandedK: bigint | null = null;
        let lastSegmentArrivedMs = 0;
        let estimatedSegmentMs = DEFAULT_SEGMENT_MS;

        let candleWidth = p.windowWidth < 768 ? 6 : 9;
        let candleSpacing = p.windowWidth < 768 ? 9 : 13;
        let maxCandles = MAX_CHART_CANDLES;
        let priceScale = { min: 0, max: 100 };
        // ── Staggered candle-reveal queue (2026-05-24) ────────────────────
        // The chain emits one SegmentRecordedV4 event per segment; each
        // segment deterministically expands to CANDLES_PER_SEGMENT (=6)
        // OHLC candles via seeded_path::expand_segment. The cranker pushes
        // segments every ~1s on testnet, so naively pushing all 6 candles
        // into `candles[]` at once produced a "jump 6, freeze 1s, jump 6"
        // stutter (user feedback 2026-05-24: "Why is the screen showing
        // like multiple new candles every frame? Yesterday … the candles
        // were like live and animated nicely!").
        //
        // Fix: applySegment(live) enqueues 6 entries; the draw loop drains
        // one per `revealCadenceMs`. Tuned to match the cranker's actual
        // segment rate so the queue stays approximately steady — neither
        // bursting empty (chart freezes) nor blowing up (chart bursts).
        //
        // 2026-05-24 — bumped 80 → 200 after the user observed the chart
        // "starting and stopping". The cranker emits ~6 candles per
        // ~1200 ms cycle (600 ms sleep + ~600 ms tx roundtrip), so the
        // natural per-candle rate is 1200/6 = 200 ms. At 80 ms the chart
        // drained the 6-batch in 480 ms then froze for 720 ms — exactly
        // the start-stop the user saw.
        //
        // Adaptive: when the queue grows past CANDLES_PER_SEGMENT (a
        // burst caught up), the drain still accelerates so we never lag
        // — just gently, not in a way that produces the freeze pattern.
        const REVEAL_BASE_MS = 200;
        type RevealItem = {
          seeded: ReturnType<typeof expandSegment>["candles"][number];
          render: RenderCandle;
          armed: Parameters<typeof armedCueFromSegment>[0] | undefined;
        };
        let revealQueue: RevealItem[] = [];
        let lastRevealMs = 0;
        let priceScaleInit = false;
        let chartArea = { x: 30, y: 90, width: 0, height: 0 };
        let gridAlpha = 0;
        let pulseAnimation = 0;
        let positionOpenedAtMs = 0;
        let lastPnlReportMs = 0;
        let currentPosition: PositionStateV4 | null = null;
        let completedTrades: CompletedTradeV4[] = [];
        let pnlLineEndPos: { x: number; y: number } | null = null;

        let pressMs = 0;
        let lastSeenPhase: RidePhase = "idle";

        // ── FX state (ported verbatim from v3) ────────────────────────────
        let activeMoneyEmojis: MoneyEmoji[] = [];
        let shouldExplodeEmojis = false;
        let explosionCenter: { x: number; y: number } | null = null;
        let lastEmojiTime = 0;
        let screenShake = 0;
        let lossFlash = 0;

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

        const tryPlayAudio = (url: string, volume: number) => {
          try {
            const a = new Audio(url);
            a.volume = volume;
            void a.play().catch(() => {
              // iOS rejection on no-recent-gesture — swallow.
            });
          } catch {
            // ignore
          }
        };

        // ── Segment → render-candle pipeline (verbatim from v3) ───────────
        const rebuildFromSegments = () => {
          const s = stateRef.current;
          const segs = s.segments;
          candles = [];
          seededCandles = [];
          highestExpandedK = null;
          // Home price for the seeded-path walk. When the round event hasn't
          // landed yet (s.round is null on first paint), fall back to the
          // testnet v4 market's bootstrap home_price ($1000) so the candles
          // render at the right Y-axis range. The old fallback of 100
          // produced a flat squiggle at $98 while barriers sat at $1100/$900
          // — visually broken because the chart Y-domain spans both.
          const homePrice = s.round?.spotAtRoll ?? 1000;
          const homePriceMicro = BigInt(Math.round(homePrice * PRICE_SCALING));
          walkState = newWalkState(
            homePriceMicro,
            1_000_000n,
            homePriceMicro,
          );
          // Historical replay path: flush the reveal queue (no staggering
          // for backfilled candles — user wants the chart fully populated
          // on load, not slowly drawn) and reveal everything immediately.
          revealQueue = [];
          for (const seg of segs) {
            applySegment(seg, /* immediate */ true);
          }
        };

        /**
         * Run post-hoc pattern detection over the full seededCandles series
         * and attach detected patterns to the corresponding rendered candles.
         * Called after each reveal (either staggered or immediate).
         */
        const runPostHocPatternDetection = () => {
          for (const match of detectPostHocPattern(seededCandles)) {
            const cue = postHocCueFromMatch(match);
            for (let j = match.startIndex; j <= match.endIndex; j++) {
              const target = candles[j];
              if (!target) continue;
              const existing = target.postHocPatterns ?? [];
              if (!existing.some((patt) => patt.label === cue.label)) {
                target.postHocPatterns = [...existing, cue].slice(-3);
              }
            }
          }
        };

        /** Apply ring-buffer truncation after either reveal path. */
        const truncateRingBuffer = () => {
          if (candles.length > maxCandles + CANDLES_PER_SEGMENT) {
            const drop = candles.length - (maxCandles + CANDLES_PER_SEGMENT);
            candles.splice(0, drop);
            seededCandles.splice(0, drop);
            for (const t of completedTrades) {
              t.entryAgeCandles += drop;
              t.exitAgeCandles += drop;
            }
            if (currentPosition) {
              currentPosition.entrySegmentIdx = Math.max(
                0,
                currentPosition.entrySegmentIdx - drop,
              );
            }
          }
        };

        const applySegment = (seg: SegmentInputV4, immediate = false) => {
          if (!walkState) return;
          const result = expandSegment(walkState, seg.key);
          const armedByCandle = new Map(
            result.armedPatterns.map((armed) => [armed.candleIndex, armed] as const),
          );
          walkState = result.newState;

          if (immediate) {
            // Backfill / historical replay — reveal all 6 at once.
            for (let i = 0; i < result.candles.length; i++) {
              const c = result.candles[i]!;
              const isLast = i === result.candles.length - 1;
              const rc = renderCandleFromSeeded(c, 1);
              const armed = armedByCandle.get(i);
              if (armed) rc.armedPattern = armedCueFromSegment(armed);
              rc.isLive = isLast;
              candles.push(rc);
              seededCandles.push(c);
              runPostHocPatternDetection();
            }
          } else {
            // Live path — enqueue, let drainRevealQueue() reveal one at
            // a time on the draw loop ticker.
            for (let i = 0; i < result.candles.length; i++) {
              const c = result.candles[i]!;
              const rc = renderCandleFromSeeded(c, 0);
              const armed = armedByCandle.get(i);
              revealQueue.push({ seeded: c, render: rc, armed });
            }
          }
          highestExpandedK = seg.k;
          truncateRingBuffer();
        };

        /**
         * Pop one item off `revealQueue` per tick once `revealCadenceMs`
         * has elapsed. Adaptive: when the queue exceeds CANDLES_PER_SEGMENT
         * (cranker burst caught up to multiple segments at once), the
         * cadence accelerates so we don't fall behind.
         */
        const drainRevealQueue = (now: number) => {
          if (revealQueue.length === 0) return;
          // Speed up the reveal proportionally when the backlog grows.
          // Floor at 80 ms so even a big burst still feels paced.
          const cadence = Math.max(
            80,
            REVEAL_BASE_MS - (revealQueue.length - CANDLES_PER_SEGMENT) * 8,
          );
          if (lastRevealMs > 0 && now - lastRevealMs < cadence) return;

          const item = revealQueue.shift()!;
          // Demote the previous live candle; the just-revealed one is now live.
          if (candles.length > 0) {
            const prev = candles[candles.length - 1]!;
            prev.isLive = false;
          }
          item.render.isLive = true;
          if (item.armed) item.render.armedPattern = armedCueFromSegment(item.armed);
          candles.push(item.render);
          seededCandles.push(item.seeded);
          runPostHocPatternDetection();
          truncateRingBuffer();
          lastRevealMs = now;
        };

        const reconcileSegments = () => {
          const segs = stateRef.current.segments;
          if (segs.length === 0) {
            if (candles.length === 0 && !walkState) {
              const s = stateRef.current;
              const seedPrice = s.round?.spotAtRoll ?? 100;
              candles = [
                {
                  open: seedPrice,
                  high: seedPrice,
                  low: seedPrice,
                  close: seedPrice,
                  animation: 1,
                  isLive: true,
                },
              ];
            }
            return;
          }
          const firstK = segs[0]!.k;
          const lastK = segs[segs.length - 1]!.k;
          if (
            highestExpandedK === null ||
            firstK > highestExpandedK + 1n ||
            walkState === null ||
            (stateRef.current.round?.spotAtRoll !== undefined &&
              candles.length === 0)
          ) {
            rebuildFromSegments();
            const now = p.millis();
            if (lastSegmentArrivedMs === 0) lastSegmentArrivedMs = now;
            return;
          }
          if (lastK > highestExpandedK) {
            for (const seg of segs) {
              if (seg.k > highestExpandedK) {
                applySegment(seg);
                const now = p.millis();
                if (lastSegmentArrivedMs > 0) {
                  const dt = now - lastSegmentArrivedMs;
                  if (dt >= MIN_SEGMENT_MS && dt <= MAX_SEGMENT_MS) {
                    estimatedSegmentMs =
                      0.7 * estimatedSegmentMs + 0.3 * dt;
                  }
                }
                lastSegmentArrivedMs = now;
              }
            }
          }
        };

        // ── Y-axis (verbatim) ─────────────────────────────────────────────
        const updatePriceScale = () => {
          if (candles.length === 0) return;
          let min = Infinity;
          let max = -Infinity;
          for (const c of candles) {
            min = Math.min(min, c.low);
            max = Math.max(max, c.high);
          }
          const s = stateRef.current;
          if (currentPosition) {
            min = Math.min(min, currentPosition.entryPrice);
            max = Math.max(max, currentPosition.entryPrice);
          }
          if (s.round) {
            min = Math.min(min, s.round.lowerBarrier);
            max = Math.max(max, s.round.upperBarrier);
          }
          const range = Math.max(max - min, 0.01);
          const isMobile = p.windowWidth < 768;
          const topPadding = range * (isMobile ? 0.12 : 0.15);
          const bottomPadding = range * (isMobile ? 0.15 : 0.18);
          const targetMin = Math.max(0, min - bottomPadding);
          const targetMax = max + topPadding;
          if (!priceScaleInit) {
            priceScale.min = targetMin;
            priceScale.max = targetMax;
            priceScaleInit = true;
          } else {
            priceScale.min = p.lerp(priceScale.min, targetMin, 0.1);
            priceScale.max = p.lerp(priceScale.max, targetMax, 0.1);
          }
        };

        // ── Drawing primitives ────────────────────────────────────────────
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

        /**
         * Draw BOTH barriers — solid horizontal lines, no picker affordance,
         * no half-tinting. Per doc 25 §3: "candles + two SOLID barrier
         * lines + a glowing laser trace of the spot."
         */
        const drawBarriers = () => {
          const s = stateRef.current;
          if (!s.round) return;

          const drawOne = (
            price: number,
            color: [number, number, number],
            label: string,
          ) => {
            const y = p.map(
              price,
              priceScale.min,
              priceScale.max,
              chartArea.y + chartArea.height,
              chartArea.y,
            );
            // Solid line — v4 is always-open, barriers never lock.
            p.stroke(color[0], color[1], color[2], 200);
            p.strokeWeight(2);
            p.drawingContext.setLineDash([]);
            p.line(chartArea.x, y, chartArea.x + chartArea.width, y);

            // Label
            p.noStroke();
            p.fill(color[0], color[1], color[2], 235);
            p.textAlign(p.LEFT, p.CENTER);
            p.textSize(p.width < 768 ? 10 : 12);
            p.text(
              `${label}  $${price.toLocaleString(undefined, {
                maximumFractionDigits: price < 100 ? 2 : 0,
              })}`,
              chartArea.x + 8,
              y - 8,
            );
          };

          drawOne(s.round.upperBarrier, [0, 255, 136], "▲ upper");
          drawOne(s.round.lowerBarrier, [255, 100, 100], "▼ lower");
        };

        const armedPatternText = (cue: ArmedPatternCue): string => {
          if (cue.phase === "fired") return `${cue.patternName} fired`;
          const phase = cue.phase === "arming" ? "forming" : "firing";
          const left = cue.candlesRemaining;
          return `${cue.patternName} ${phase} — ${left} candle${left === 1 ? "" : "s"} left`;
        };

        const postHocPatternText = (cue: PostHocPatternCue): string =>
          `${cue.name} detected`;

        const drawPatternTooltip = (
          tip: { x: number; y: number; lines: string[] } | null,
        ) => {
          if (!tip || tip.lines.length === 0) return;
          const padX = 9;
          const padY = 7;
          const lineHeight = 15;
          p.textSize(11);
          p.textStyle(p.BOLD);
          const width = Math.min(
            230,
            Math.max(...tip.lines.map((line) => p.textWidth(line))) + padX * 2,
          );
          const height = tip.lines.length * lineHeight + padY * 2;
          const x = Math.max(
            chartArea.x + 4,
            Math.min(tip.x - width / 2, chartArea.x + chartArea.width - width - 4),
          );
          const y = Math.max(
            chartArea.y + 4,
            Math.min(tip.y - height - 12, chartArea.y + chartArea.height - height - 4),
          );
          p.noStroke();
          p.fill(24, 24, 27, 238);
          p.rect(x, y, width, height, 6);
          p.stroke(212, 212, 216, 55);
          p.strokeWeight(1);
          p.noFill();
          p.rect(x + 0.5, y + 0.5, width - 1, height - 1, 6);
          p.noStroke();
          p.textAlign(p.LEFT, p.CENTER);
          for (let i = 0; i < tip.lines.length; i++) {
            if (i === 0) p.fill(236, 253, 245);
            else p.fill(244, 244, 245);
            p.text(tip.lines[i]!, x + padX, y + padY + lineHeight * i + lineHeight / 2);
          }
          p.textStyle(p.NORMAL);
        };

        const drawCandles = () => {
          let patternTooltip: { x: number; y: number; lines: string[] } | null = null;
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
            if (dist < 3) {
              p.stroke(color[0], color[1], color[2], 40 * c.animation);
              p.strokeWeight(2);
              p.line(x + candleWidth / 2, highY, x + candleWidth / 2, lowY);
            }
            p.stroke(color[0], color[1], color[2], 160 * c.animation);
            p.strokeWeight(1);
            p.line(x + candleWidth / 2, highY, x + candleWidth / 2, lowY);
            const bodyHeight = Math.abs(closeY - openY);
            const bodyY = Math.min(openY, closeY);
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
            const candleTop = Math.min(highY, lowY, bodyY);
            const candleBottom = Math.max(highY, lowY, bodyY + Math.max(bodyHeight, 1));
            const postHoc = c.postHocPatterns?.[c.postHocPatterns.length - 1];
            if (c.armedPattern) {
              const pulse = 0.5 + Math.sin(p.millis() * 0.008) * 0.18;
              const ctx = p.drawingContext as CanvasRenderingContext2D;
              ctx.shadowBlur = 8 + pulse * 4;
              ctx.shadowColor = `rgba(251, 191, 36, ${0.32 + pulse * 0.10})`;
              p.fill(color[0], color[1], color[2], 200 * c.animation);
              p.noStroke();
              p.rect(x, bodyY, candleWidth, Math.max(bodyHeight, 1), 1);
              ctx.shadowBlur = 0;
            }
            if (
              p.mouseX >= x - 6 &&
              p.mouseX <= x + candleWidth + 6 &&
              p.mouseY >= candleTop - 8 &&
              p.mouseY <= candleBottom + 8
            ) {
              const lines: string[] = [];
              if (c.armedPattern) lines.push(armedPatternText(c.armedPattern));
              if (postHoc) lines.push(postHocPatternText(postHoc));
              if (lines.length > 0) {
                patternTooltip = {
                  x: x + candleWidth / 2,
                  y: candleTop,
                  lines,
                };
              }
            }
          }
          drawPatternTooltip(patternTooltip);
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

        /**
         * DELETED 2026-05-24 — proximity-graded EMA tracer.
         *
         * User feedback: "Just delete it! The laser is the thing that shows
         * when you tap and hold it's the slope line from the start of your
         * position to the current price point. It turns red when you're
         * negative pnl and green in profit."
         *
         * That line already exists — `drawSinglePNLLine` (a few lines down)
         * renders it correctly: green when `tradePnl >= 0`, red when
         * negative, anchored at entry candle, exit anchored at current spot.
         * The EMA tracer was a separate, always-on overlay that competed
         * with the PnL line visually. Removed.
         */
        const drawLaserTrace = () => {
        };

        /** Render the entry → cursor PnL line + emoji burst origin. */
        const drawSinglePNLLine = (
          trade: PositionStateV4 | CompletedTradeV4,
          isCompleted: boolean,
        ) => {
          if (candles.length === 0) return;
          const last = candles[candles.length - 1]!;
          const rightPadding = 8;
          const currentCandleX =
            chartArea.x + chartArea.width - candleWidth - rightPadding;
          const entryAge = isCompleted
            ? (trade as CompletedTradeV4).entryAgeCandles
            : Math.max(
                0,
                candles.length - 1 - (trade as PositionStateV4).entrySegmentIdx,
              );
          const exitAge = isCompleted
            ? (trade as CompletedTradeV4).exitAgeCandles
            : 0;
          const exitPrice = isCompleted
            ? (trade as CompletedTradeV4).exitPrice
            : last.close;
          const tradePnl = isCompleted
            ? (trade as CompletedTradeV4).profit
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
          const actualEntryX = currentCandleX - entryAge * candleSpacing;
          const actualExitX = currentCandleX - exitAge * candleSpacing;
          const entryXForSlope = actualEntryX + candleWidth / 2;
          let adjustedExitX = actualExitX + candleWidth / 2;
          let adjustedExitY = exitY;
          if (!isCompleted && entryAge === 0) {
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
          if (!isCompleted && entryAge === 0) {
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
          p.stroke(lc[0]!, lc[1]!, lc[2]!, alpha * 0.3);
          p.strokeWeight(6);
          p.line(lineStartX, lineStartY, finalEndX, lineEndY);
          p.stroke(lc[0]!, lc[1]!, lc[2]!, alpha);
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

        // ── Phase-transition driven position bookkeeping ──────────────────
        const onPhaseChange = (next: RidePhase, prev: RidePhase) => {
          if (
            (next === "opening" || next === "riding") &&
            (prev === "idle" || prev === "closing")
          ) {
            if (candles.length === 0) return;
            const last = candles[candles.length - 1]!;
            const s = stateRef.current;
            const round = s.round;
            currentPosition = {
              entryPrice: last.close,
              entrySegmentIdx: candles.length - 1,
              upperBarrier: round?.upperBarrier ?? last.close,
              lowerBarrier: round?.lowerBarrier ?? last.close,
            };
            positionOpenedAtMs = p.millis();
            stateRef.current.pnl = 0;
            lastPnlReportMs = 0;
          }
          if (next === "idle" && (prev === "riding" || prev === "closing")) {
            if (currentPosition) {
              const last = candles[candles.length - 1]!;
              const profit = stateRef.current.pnl;
              completedTrades.push({
                entryPrice: currentPosition.entryPrice,
                exitPrice: last?.close ?? currentPosition.entryPrice,
                profit,
                entryAgeCandles: Math.max(
                  0,
                  candles.length - 1 - currentPosition.entrySegmentIdx,
                ),
                exitAgeCandles: 0,
              });
              if (profit > 0) {
                if (pnlLineEndPos) {
                  shouldExplodeEmojis = true;
                  explosionCenter = {
                    x: pnlLineEndPos.x,
                    y: pnlLineEndPos.y,
                  };
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
            }
          }
        };

        /**
         * V4 live PnL. The "proximity" is computed against the NEARER of
         * the two barriers (the player wins if EITHER side touches), so
         * any movement toward either barrier registers as positive
         * progress. We pick whichever side the current spot is closer to.
         */
        const updateLivePnl = (now: number) => {
          if (!currentPosition) return;
          const s = stateRef.current;
          const heldMs = Math.max(0, now - positionOpenedAtMs);
          const segMs = estimatedSegmentMs;
          const heldSegments = heldMs / segMs;
          const stakePerSegUsd =
            Number(s.stakePerSegmentMicroUsd) / PRICE_SCALING;
          const staked = heldSegments * stakePerSegUsd;
          const mult = s.multiplierBps / 10000;
          const live = candles[candles.length - 1];
          const spot = live ? live.close : currentPosition.entryPrice;
          const entry = currentPosition.entryPrice;
          const upper = currentPosition.upperBarrier;
          const lower = currentPosition.lowerBarrier;

          // Progress toward the upper barrier (touch from below).
          const distUp = upper - entry;
          const progressUp = distUp > 0 ? (spot - entry) / distUp : 0;
          // Progress toward the lower barrier (touch from above).
          const distDn = entry - lower;
          const progressDn = distDn > 0 ? (entry - spot) / distDn : 0;
          // V4: either side wins — take the better of the two.
          let proximity = Math.max(progressUp, progressDn);
          proximity = Math.max(-1.2, Math.min(1.05, proximity));

          const livePnl = staked * (mult - 1) * proximity;
          s.pnl = livePnl;
          if (now - lastPnlReportMs >= 80) {
            lastPnlReportMs = now;
            onPnlChangeRef.current?.({ pnl: livePnl, staked });
          }
        };

        // ── Gesture → open/close ──────────────────────────────────────────
        // V4: press ANYWHERE opens — no barrier-pick step. No open-window
        // gate. The parent's hook decides single-flight dedupe.
        const startPress = (_mx: number, _my: number) => {
          const s = stateRef.current;
          if (s.disabled) return;
          if (s.phase !== "idle") return;
          if (!s.round) return;
          pressMs = p.millis();
          callbacksRef.current.onOpen();
        };

        const endPress = () => {
          const s = stateRef.current;
          const heldMs = p.millis() - pressMs;
          pressMs = 0;
          if (s.phase === "riding" || s.phase === "opening") {
            callbacksRef.current.onClose();
          }
          void heldMs;
        };

        // ── Stall detector (D4) ───────────────────────────────────────────
        const checkStall = (now: number) => {
          const s = stateRef.current;
          const rideOpen = s.phase === "opening" || s.phase === "riding";
          if (!rideOpen) {
            stateRef.current.stallFired = false;
            return;
          }
          if (lastSegmentArrivedMs === 0) return;
          const elapsed = now - lastSegmentArrivedMs;
          if (elapsed > STALL_THRESHOLD_MS && !stateRef.current.stallFired) {
            stateRef.current.stallFired = true;
            callbacksRef.current.onStall?.();
          }
        };

        // ── p5 lifecycle ──────────────────────────────────────────────────
        p.setup = () => {
          p.createCanvas(p.windowWidth, p.windowHeight);
          p.strokeCap(p.ROUND);
          p.textFont("Bai Jamjuree, system-ui, sans-serif");
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
          maxCandles = Math.min(
            MAX_CHART_CANDLES,
            Math.floor(chartArea.width / candleSpacing),
          );
          lastSegmentArrivedMs = p.millis();
          estimatedSegmentMs = DEFAULT_SEGMENT_MS;
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

          reconcileSegments();
          // Drain one item from the reveal queue per ~80 ms tick so the
          // chart animates candle-by-candle instead of jumping 6 at a time
          // when a SegmentRecordedV4 event lands.
          drainRevealQueue(now);
          checkStall(now);
          const curPhase = stateRef.current.phase;
          if (curPhase !== lastSeenPhase) {
            onPhaseChange(curPhase, lastSeenPhase);
            lastSeenPhase = curPhase;
          }
          updateLivePnl(now);
          updatePriceScale();
          drawGrid();
          drawBarriers();
          drawCandles();
          // V4: laser tracer goes between candles and the price line, so
          // it's visible on top of the candle bodies but under the live
          // price tag / PnL line.
          drawLaserTrace();
          drawPriceLine();
          drawPriceLabels();
          drawPNLLine();
          gridAlpha = p.lerp(gridAlpha, 40, 0.1);
          if (
            !(curPhase === "riding" || curPhase === "opening") ||
            stateRef.current.pnl <= 0
          ) {
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
          maxCandles = Math.min(
            MAX_CHART_CANDLES,
            Math.floor(chartArea.width / candleSpacing),
          );
        };

        // ── Mouse/touch handlers — dedupe is load-bearing on iOS ──────────
        let touchActive = false;
        p.mousePressed = () => {
          if (stateRef.current.disabled) return true;
          try {
            if (!touchActive) startPress(p.mouseX, p.mouseY);
          } catch {
            // ignore
          }
          return false;
        };
        p.mouseReleased = () => {
          if (stateRef.current.disabled) return true;
          try {
            if (!touchActive) endPress();
          } catch {
            // ignore
          }
          return false;
        };
        p.touchStarted = (event?: unknown) => {
          if (stateRef.current.disabled) return true;
          touchActive = true;
          try {
            startPress(p.mouseX, p.mouseY);
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
          // P0 fix (agent #2): p5 fires touchEnded on EVERY touchend DOM
          // event — including when a SECOND finger lifts while the primary
          // is still held. Without this guard, the secondary finger's lift
          // would silently cash out the user mid-ride. Only end the press
          // when ALL fingers are off the screen.
          const remaining =
            event && typeof event === "object" && "touches" in event
              ? (event as TouchEvent).touches?.length ?? 0
              : 0;
          if (remaining > 0) {
            if (event && typeof event === "object" && "preventDefault" in event) {
              (event as Event).preventDefault();
            }
            return false;
          }
          touchActive = false;
          try {
            endPress();
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
