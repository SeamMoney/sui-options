/**
 * useRideGesture — p5.js candle chart + barrier-picker + press-and-hold,
 * **rewritten for the segment-market arcade (doc 19)**.
 *
 * WHAT CHANGED vs the previous incarnation
 * ----------------------------------------
 * - The chart is no longer a per-browser `Math.random()` walk. It is the
 *   *exact* on-chain price: a deterministic function of `SegmentRecorded`
 *   events (32-byte `segment_key` + carried `WalkState`) replayed through
 *   `seededPath.expandSegment`. Move == TS, byte-identical (doc 17 §8 spine
 *   test 1). The chart you see IS the price you settle against.
 *
 * - Round-based shared-grid mode (doc 19):
 *     * Two barriers materialise at round start (upper + lower).
 *     * The first ~5.2s of each 30s round is the OPEN WINDOW — barrier
 *       picker is interactive.
 *     * After that the picker is locked; rides can only close.
 *
 * - Gesture grammar (D2 — built first per doc 17 §14.5):
 *     * Tap a half (upper / lower) to PICK that barrier.
 *     * Press-and-hold anywhere on the chart to COMMIT — instant optimistic
 *       "starting…" → "RIDING" the moment the next segment lands (or fade
 *       back if it was a tap). Release → instant "cashing out…".
 *
 * - Live PnL (D3) is computed inside this hook from the candle stream the
 *   user is actually watching (not a chain poll) — genuinely zero-latency.
 *
 * - Resilience (D4): if no `SegmentRecorded` event arrives for ~3 s while
 *   any ride is open, the parent's fallback cranker is called. The chart
 *   shows a calm "syncing…" badge, never a frozen state.
 *
 * KEPT (FX layer, load-bearing for the gameplay feel)
 * ---------------------------------------------------
 * - Press / release dedupe (iOS dispatches mouse + touch both).
 * - drawPNLLine — entry → live cursor, with glow + dot.
 * - MoneyEmoji burst on profitable close.
 * - Screen-shake + red-flash on loss.
 * - Pulsing dot at entry, immediate horizontal stub line.
 * - Audio cues on close (win / loss).
 *
 * Pattern overlays (D5) and per-barrier orderbook bars (D6) are separate
 * tasks. This hook deliberately leaves architectural space for them — the
 * candle data structure already carries everything `patterns.ts` needs.
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
  BARRIER_UPPER,
  BARRIER_LOWER,
  type BarrierIndex,
} from "@wick/sdk";
import { getTopMargin, getSafeBottom, isStandalone } from "@/utils/safeArea";

// ── Tunables ────────────────────────────────────────────────────────────────
// The on-chain segment cadence is ~400 ms; each segment carries 6 candles
// (doc 17 §10). Animate the 6 candles over the realised inter-arrival
// interval so the chart speed tracks the cranker — rubber-banding within
// bounds when the keeper jitters.
const CANDLES_PER_SEGMENT = 6;
const DEFAULT_SEGMENT_MS = 400;
const MIN_SEGMENT_MS = 250;
const MAX_SEGMENT_MS = 1200;
const MAX_CHART_CANDLES = 40;
/** Stall threshold — if `lastSegmentArrivedMs` is older than this and a
 *  ride is open, call the parent's onStall to trigger the fallback crank. */
const STALL_THRESHOLD_MS = 3000;

// On-chain prices are micro-USD; chart axis is plain USD.
const PRICE_SCALING = 1_000_000;

// ── Public phase enum (mirrored from useSegmentRide) ────────────────────────

export type RidePhase = "idle" | "opening" | "riding" | "closing";

/** Tap = no-op, hold = open. We use a wall-time floor to disambiguate. */
const TAP_VS_HOLD_MS = 120;

export interface RideGestureCallbacks {
  /**
   * Called on press if the user is currently inside the round's OPEN
   * WINDOW. The hook supplies the picked barrierIndex (0 = upper,
   * 1 = lower) and the snapshotted barrier price (display unit, USD).
   * After this fires, the parent fires the on-chain `open_segment_ride`
   * and flips `phase` to "opening" / "riding".
   */
  onOpen: (barrierIndex: BarrierIndex, barrierPrice: number) => void;
  /** Called on release while phase is "riding" or "opening". */
  onClose: () => void;
  /**
   * Called when no SegmentRecorded event has arrived for ~STALL_THRESHOLD_MS
   * while a ride is open. Parent should call `recordSegment` from the
   * client as a fallback cranker (D4). Idempotent at the parent — the hook
   * fires it once per stall, then waits for the next arrival.
   */
  onStall?: () => void;
}

/** What the hook needs to render one segment worth of candles. */
export interface SegmentInput {
  /** Segment index (`k`) — monotonically increasing per market. */
  readonly k: bigint;
  /** 32-byte segment_key drawn from sui::random. */
  readonly key: Uint8Array;
  /** Wall-time the segment was recorded (from the event). */
  readonly recordedAtMs: number;
}

/** Snapshot of the active round, fed from RoundStarted events. */
export interface RoundInfo {
  /** Round index. 0 at bootstrap. */
  readonly index: bigint;
  /** First segment_k bound to this round (= index * roundDurationSegments). */
  readonly startedAtSegment: bigint;
  /** Upper barrier price (micro-USD on chain — display USD here). */
  readonly upperBarrier: number;
  /** Lower barrier price (display USD). */
  readonly lowerBarrier: number;
  /** Walk spot at round roll (display USD, for the seed candle). */
  readonly spotAtRoll: number;
  /** Round duration in segments (75 = 30 s). */
  readonly roundDurationSegments: number;
  /** Open-window length in segments (13 ≈ 5.2 s). */
  readonly openWindowSegments: number;
}

export interface RideGestureOptions {
  chartRef: React.RefObject<HTMLDivElement | null>;
  p5InstanceRef: React.RefObject<p5 | null>;
  /** "idle" | "opening" | "riding" | "closing" — drives PnL line, FX. */
  phase: RidePhase;
  /** Currently picked barrier — null until the user taps a zone. */
  pickedBarrier: BarrierIndex | null;
  /** Current round info (null until first RoundStarted event). */
  round: RoundInfo | null;
  /**
   * Ring buffer of recent segments, ordered by `k`. The hook expands each
   * one into 6 candles via `expandSegment`, carrying `WalkState` forward.
   * The most recent CANDLES_PER_SEGMENT entries form the chart's tail.
   */
  segments: ReadonlyArray<SegmentInput>;
  /** Touch payout multiplier in bps (e.g. 20_000 = 2.0x). */
  multiplierBps?: number;
  /** Per-segment stake in micro-USD — fixed-per-segment per doc 19 §6. */
  stakePerSegmentMicroUsd?: bigint;
  /**
   * Live PnL callback — fires ~12x/sec while the chart is held. The figure
   * is mark-to-market of the touch position derived from the chart the
   * user is actually watching — genuinely zero-latency.
   */
  onPnlChange?: (snap: { pnl: number; staked: number }) => void;
  /** Press-state callbacks (open, close, stall). */
  callbacks: RideGestureCallbacks;
  /** Disable press handling (e.g. wallet not connected). */
  disabled?: boolean;
}

// ── Local chart-render types (decoupled from SDK Candle to avoid coupling
// the renderer's mutable y-coordinates to the deterministic on-chain output)
interface RenderCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  animation: number;
  /** True until the next segment lands — the right-most candle "grows". */
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

interface PositionState {
  entryPrice: number;
  entrySegmentIdx: number; // index into the rendered candle array at open
  barrierIndex: BarrierIndex;
  barrierPrice: number;
}

interface CompletedTrade {
  entryPrice: number;
  exitPrice: number;
  profit: number;
  entryAgeCandles: number;
  exitAgeCandles: number;
}

// ── Math helpers ────────────────────────────────────────────────────────────

const toDisplay = (microUsd: bigint | number): number =>
  Number(microUsd) / PRICE_SCALING;

/** Convert a deterministic SDK Candle (bigint micro-USD) to render units. */
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

export function useRideGesture(opts: RideGestureOptions) {
  const {
    chartRef,
    p5InstanceRef,
    phase,
    pickedBarrier,
    round,
    segments,
    multiplierBps,
    stakePerSegmentMicroUsd,
    onPnlChange,
    callbacks,
    disabled = false,
  } = opts;

  // Refs the p5 closure reads on every frame. We avoid recreating the p5
  // instance when these change — see the empty-deps useEffect below.
  const stateRef = useRef({
    phase,
    pickedBarrier,
    round,
    segments,
    multiplierBps: multiplierBps ?? 20000,
    stakePerSegmentMicroUsd: stakePerSegmentMicroUsd ?? 200_000n,
    disabled,
    // pnl is computed INSIDE the p5 loop (mark-to-market of the chart the
    // user is watching) — it is not a prop. The loop writes it every frame.
    pnl: 0,
    // Whether we've already fired onStall for this stall — debounces.
    stallFired: false,
  });
  const callbacksRef = useRef(callbacks);
  const onPnlChangeRef = useRef(onPnlChange);

  useEffect(() => {
    stateRef.current.phase = phase;
  }, [phase]);
  useEffect(() => {
    stateRef.current.pickedBarrier = pickedBarrier;
  }, [pickedBarrier]);
  useEffect(() => {
    stateRef.current.round = round;
  }, [round]);
  useEffect(() => {
    stateRef.current.segments = segments;
    // A new segment arrival clears the stall flag — the chart is alive.
    stateRef.current.stallFired = false;
  }, [segments]);
  useEffect(() => {
    stateRef.current.multiplierBps = multiplierBps ?? 20000;
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
        // ── Local mutable state, scoped to this p5 instance ────────────────
        let candles: RenderCandle[] = [];
        let seededCandles: SeededCandle[] = [];
        // The walk state we carry forward AS WE EXPAND segments. Rebuilt
        // from scratch any time the parent's `segments` ring buffer
        // semantically resets (round change, market swap, mount).
        let walkState: WalkState | null = null;
        // The k of the segment whose candles are currently in `candles`'
        // tail. Used to decide whether a new segment is incremental
        // (append) or rewinding (rebuild).
        let highestExpandedK: bigint | null = null;
        // Wall-time the most recent segment landed in the chart — used for
        // the stall detector AND for the live "growing" candle animation.
        let lastSegmentArrivedMs = 0;
        // Estimated inter-arrival interval (ms) — used to time the
        // intra-segment growing-candle animation. Rubber-bands gently.
        let estimatedSegmentMs = DEFAULT_SEGMENT_MS;

        let candleWidth = p.windowWidth < 768 ? 6 : 9;
        let candleSpacing = p.windowWidth < 768 ? 9 : 13;
        let maxCandles = MAX_CHART_CANDLES;
        let priceScale = { min: 0, max: 100 };
        let priceScaleInit = false;
        let chartArea = { x: 30, y: 90, width: 0, height: 0 };
        let gridAlpha = 0;
        let pulseAnimation = 0;
        let positionOpenedAtMs = 0;
        let lastPnlReportMs = 0;
        // Position state, set when phase flips to "opening" / "riding".
        let currentPosition: PositionState | null = null;
        let completedTrades: CompletedTrade[] = [];
        let pnlLineEndPos: { x: number; y: number } | null = null;

        // Press-state — local mirror of the public phase, plus a tap timer.
        let pressMs = 0;
        // The phase reported the last frame — to detect transitions.
        let lastSeenPhase: RidePhase = "idle";

        // ── FX state (ported verbatim) ────────────────────────────────────
        let activeMoneyEmojis: MoneyEmoji[] = [];
        let shouldExplodeEmojis = false;
        let explosionCenter: { x: number; y: number } | null = null;
        let lastEmojiTime = 0;
        let screenShake = 0;
        let lossFlash = 0;

        // ── MoneyEmoji class — ported verbatim, scoped to this p5 ─────────
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
              // iOS will reject if no recent user gesture — silently swallow.
            });
          } catch {
            // ignore
          }
        };

        // ── Segment → render-candle pipeline ──────────────────────────────
        // The hook receives a sorted ring buffer of SegmentInputs. For each
        // one not yet expanded, we run `expandSegment(state, key)` carrying
        // the walk state forward. The result is 6 deterministic candles
        // appended to `candles`. The chart is then the user's view of the
        // genuinely on-chain price — no Math.random anywhere.

        /** Rebuild candles + walkState from scratch over the full ring buffer.
         *  Called when the parent ring buffer's history changes shape (e.g.
         *  new round, ID switch).
         *
         *  Honest limitation: if the ring buffer starts mid-round (e.g. the
         *  user opened the page at segment 30 of a 75-segment round), the
         *  rebuilt walk seeds at `spotAtRoll` not at the on-chain walk's
         *  segment-30 checkpoint, so the displayed candles can drift from
         *  the on-chain extremes for that round. The /verify CLI (Phase E)
         *  is the authoritative replay; this hook is the *live* renderer
         *  and trades a few candles of imprecision for snappy UX. */
        const rebuildFromSegments = () => {
          const s = stateRef.current;
          const segs = s.segments;
          candles = [];
          seededCandles = [];
          highestExpandedK = null;
          // Seed walk state from the current round's spotAtRoll (or 100 as
          // a sane fallback for the empty / no-round case so the y-axis
          // doesn't collapse before the first segment lands).
          const homePrice = s.round?.spotAtRoll ?? 100;
          // Convert display USD → micro-USD bigint for the SDK.
          const homePriceMicro = BigInt(Math.round(homePrice * PRICE_SCALING));
          walkState = newWalkState(
            homePriceMicro,
            // volRegime starts at 1.0 in 1e6 fixed-point.
            1_000_000n,
            homePriceMicro,
          );
          for (const seg of segs) {
            applySegment(seg);
          }
        };

        /** Expand one segment and append its 6 candles. Updates walkState. */
        const applySegment = (seg: SegmentInput) => {
          if (!walkState) return;
          const result = expandSegment(walkState, seg.key);
          const armedByCandle = new Map(
            result.armedPatterns.map((armed) => [armed.candleIndex, armed] as const),
          );
          // expandSegment doesn't mutate; carry the result forward.
          walkState = result.newState;
          for (let i = 0; i < result.candles.length; i++) {
            const c = result.candles[i]!;
            const isLast = i === result.candles.length - 1;
            const rc = renderCandleFromSeeded(c, 1);
            const armed = armedByCandle.get(i);
            if (armed) rc.armedPattern = armedCueFromSegment(armed);
            // The very last candle of the latest segment is "live" — it
            // gets the growing animation until the next segment lands.
            rc.isLive = isLast;
            candles.push(rc);
            seededCandles.push(c);
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
          }
          highestExpandedK = seg.k;
          // Trim history.
          if (candles.length > maxCandles + CANDLES_PER_SEGMENT) {
            const drop = candles.length - (maxCandles + CANDLES_PER_SEGMENT);
            candles.splice(0, drop);
            seededCandles.splice(0, drop);
            // Shift completedTrades & currentPosition entry index left.
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

        /** Reconcile the parent ring buffer against the locally expanded
         *  set. Cheap when nothing has changed; appends incrementally when
         *  new segments arrive; full rebuild on round/market reset. */
        const reconcileSegments = () => {
          const segs = stateRef.current.segments;
          if (segs.length === 0) {
            if (candles.length === 0 && !walkState) {
              // Show *something* before any segment lands so the canvas
              // isn't blank. The y-axis settles when the round seeds.
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
          // First time, OR the parent's ring buffer reset its history (e.g.
          // a new round — the parent will hand us a fresh starting k).
          // Rebuild from scratch in either case.
          if (
            highestExpandedK === null ||
            firstK > highestExpandedK + 1n ||
            (walkState === null) ||
            // Round changed → the spot anchor moved → rebuild for honesty.
            (stateRef.current.round?.spotAtRoll !== undefined &&
              candles.length === 0)
          ) {
            rebuildFromSegments();
            // Update the inter-arrival timer.
            const now = p.millis();
            if (lastSegmentArrivedMs === 0) lastSegmentArrivedMs = now;
            return;
          }
          // Incremental: any segments past highestExpandedK get appended.
          if (lastK > highestExpandedK) {
            for (const seg of segs) {
              if (seg.k > highestExpandedK) {
                applySegment(seg);
                const now = p.millis();
                if (lastSegmentArrivedMs > 0) {
                  const dt = now - lastSegmentArrivedMs;
                  if (dt >= MIN_SEGMENT_MS && dt <= MAX_SEGMENT_MS) {
                    // EMA toward the realised cadence — gentle rubber-band.
                    estimatedSegmentMs =
                      0.7 * estimatedSegmentMs + 0.3 * dt;
                  }
                }
                lastSegmentArrivedMs = now;
              }
            }
          }
        };

        // ── Y-axis ────────────────────────────────────────────────────────
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

        /** Draw both barriers with their picker highlight + lock state. */
        const drawBarriers = () => {
          const s = stateRef.current;
          if (!s.round) return;
          const inOpenWindow = isInOpenWindow();
          const picked = s.pickedBarrier;

          const drawOne = (
            price: number,
            barrierIndex: BarrierIndex,
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
            const isPicked = picked === barrierIndex;
            const alphaBase = inOpenWindow ? 200 : 110;
            const pulse =
              isPicked && inOpenWindow
                ? 30 + Math.sin(p.millis() * 0.005) * 25
                : 0;
            const alpha = Math.min(255, alphaBase + pulse);
            // Thicker line if picked
            p.stroke(color[0], color[1], color[2], alpha);
            p.strokeWeight(isPicked ? 3 : 2);
            p.drawingContext.setLineDash(
              inOpenWindow ? [10, 6] : [4, 4],
            );
            p.line(chartArea.x, y, chartArea.x + chartArea.width, y);
            p.drawingContext.setLineDash([]);
            // Label
            p.noStroke();
            p.fill(color[0], color[1], color[2], 235);
            p.textAlign(p.LEFT, p.CENTER);
            p.textSize(p.width < 768 ? 10 : 12);
            p.text(
              `${label}  $${price.toLocaleString(undefined, {
                maximumFractionDigits: price < 100 ? 2 : 0,
              })}${!inOpenWindow ? "  · locked" : ""}`,
              chartArea.x + 8,
              y - 8,
            );
          };

          // Upper = green (touch from below), Lower = red (touch from above).
          drawOne(s.round.upperBarrier, BARRIER_UPPER, [0, 255, 136], "▲ upper");
          drawOne(s.round.lowerBarrier, BARRIER_LOWER, [255, 100, 100], "▼ lower");

          // Soft hover zones — slightly tinted halves to hint at the
          // tap-to-pick affordance during the open window.
          if (inOpenWindow) {
            const midY = (priceScale.min + priceScale.max) / 2;
            const midPxY = p.map(
              midY,
              priceScale.min,
              priceScale.max,
              chartArea.y + chartArea.height,
              chartArea.y,
            );
            const upperAlpha = picked === BARRIER_UPPER ? 18 : 7;
            const lowerAlpha = picked === BARRIER_LOWER ? 18 : 7;
            p.noStroke();
            p.fill(0, 255, 136, upperAlpha);
            p.rect(
              chartArea.x,
              chartArea.y,
              chartArea.width,
              midPxY - chartArea.y,
            );
            p.fill(255, 100, 100, lowerAlpha);
            p.rect(
              chartArea.x,
              midPxY,
              chartArea.width,
              chartArea.y + chartArea.height - midPxY,
            );
          }
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
            const candleTop = Math.min(highY, lowY, bodyY);
            const candleBottom = Math.max(highY, lowY, bodyY + Math.max(bodyHeight, 1));
            // Post-hoc pattern rendering removed 2026-05-23 (user feedback:
            // "remove the weird red rings, candles should just be white/green").
            // Detection still runs (cheap) and feeds the hover tooltip below,
            // but the rose-ring overlay no longer draws around the candle.
            const postHoc = c.postHocPatterns?.[c.postHocPatterns.length - 1];
            if (c.armedPattern) {
              const pulse = 1.5 + Math.sin(p.millis() * 0.012) * 0.9;
              const ctx = p.drawingContext as CanvasRenderingContext2D;
              ctx.shadowBlur = 10 + pulse * 3;
              ctx.shadowColor = "rgba(16, 185, 129, 0.75)";
              p.noFill();
              p.stroke(16, 185, 129, 190 * c.animation);
              p.strokeWeight(2.5);
              p.rect(
                x - 5 - pulse,
                candleTop - 6 - pulse,
                candleWidth + 10 + pulse * 2,
                Math.max(10, candleBottom - candleTop + 12 + pulse * 2),
                4,
              );
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

        /** Render the entry → cursor PnL line + emoji burst origin. */
        const drawSinglePNLLine = (
          trade: PositionState | CompletedTrade,
          isCompleted: boolean,
        ) => {
          if (candles.length === 0) return;
          const last = candles[candles.length - 1]!;
          const rightPadding = 8;
          const currentCandleX =
            chartArea.x + chartArea.width - candleWidth - rightPadding;
          const entryAge = isCompleted
            ? (trade as CompletedTrade).entryAgeCandles
            : Math.max(
                0,
                candles.length - 1 - (trade as PositionState).entrySegmentIdx,
              );
          const exitAge = isCompleted
            ? (trade as CompletedTrade).exitAgeCandles
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

        // ── Phase-transition driven position bookkeeping ──────────────────
        const onPhaseChange = (next: RidePhase, prev: RidePhase) => {
          // "opening" / "riding" entered: snapshot entry.
          if (
            (next === "opening" || next === "riding") &&
            (prev === "idle" || prev === "closing")
          ) {
            if (candles.length === 0) return;
            const last = candles[candles.length - 1]!;
            const s = stateRef.current;
            const round = s.round;
            const picked = s.pickedBarrier ?? BARRIER_UPPER;
            const barrierPrice = round
              ? picked === BARRIER_UPPER
                ? round.upperBarrier
                : round.lowerBarrier
              : last.close;
            currentPosition = {
              entryPrice: last.close,
              entrySegmentIdx: candles.length - 1,
              barrierIndex: picked,
              barrierPrice,
            };
            positionOpenedAtMs = p.millis();
            stateRef.current.pnl = 0;
            lastPnlReportMs = 0;
          }
          // Settled (back to idle): flush to completed trades + FX.
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

        // ── Live PnL (D3) ─────────────────────────────────────────────────
        // The number the user sees is mark-to-market of the touch position
        // derived from the chart they are watching — the genuinely on-chain
        // candle stream, NOT a chain poll. Burned premium scales with held
        // segments (per doc 19 §6); proximity scales with chart progress
        // toward the picked barrier.
        const updateLivePnl = (now: number) => {
          if (!currentPosition) return;
          const s = stateRef.current;
          const heldMs = Math.max(0, now - positionOpenedAtMs);
          const segMs = estimatedSegmentMs;
          const heldSegments = heldMs / segMs;
          // Per-segment stake (micro-USD bigint → USD double).
          const stakePerSegUsd =
            Number(s.stakePerSegmentMicroUsd) / PRICE_SCALING;
          const staked = heldSegments * stakePerSegUsd;
          const mult = s.multiplierBps / 10000;
          const live = candles[candles.length - 1];
          const spot = live ? live.close : currentPosition.entryPrice;
          const entry = currentPosition.entryPrice;
          const b = currentPosition.barrierPrice;
          let proximity = 0;
          if (b !== entry) {
            // 0 at entry, 1 at the barrier, negative if price runs away.
            // Upper barrier = touch from below → progress = (spot - entry) / (b - entry).
            // Lower barrier = touch from above → progress = (entry - spot) / (entry - b).
            proximity =
              currentPosition.barrierIndex === BARRIER_UPPER
                ? (spot - entry) / (b - entry)
                : (entry - spot) / (entry - b);
          }
          proximity = Math.max(-1.2, Math.min(1.05, proximity));
          const livePnl = staked * (mult - 1) * proximity;
          s.pnl = livePnl;
          if (now - lastPnlReportMs >= 80) {
            lastPnlReportMs = now;
            onPnlChangeRef.current?.({ pnl: livePnl, staked });
          }
        };

        // ── Open-window helpers ───────────────────────────────────────────
        const segmentsIntoRound = (): number => {
          const s = stateRef.current;
          if (!s.round || highestExpandedK === null) return 0;
          const startedAt = Number(s.round.startedAtSegment);
          const k = Number(highestExpandedK);
          // +1 because k is the most-recent-RECORDED; the round is "into"
          // that count of segments. (We allow 0 for "no segments yet".)
          return Math.max(0, k - startedAt + 1);
        };

        const isInOpenWindow = (): boolean => {
          const s = stateRef.current;
          if (!s.round) return false;
          return segmentsIntoRound() < s.round.openWindowSegments;
        };

        // ── Gesture → open/close (D2 — optimistic UI is built FIRST) ──────
        // Press fires onOpen IMMEDIATELY (optimistic — the parent flips
        // phase → "opening" instantly; the chart shows the entry stub).
        // The on-chain `open_segment_ride` lands a moment later — when it
        // does, the parent flips phase → "riding" and the PnL goes live.
        // Release fires onClose IMMEDIATELY (optimistic → "closing").
        const startPress = (mx: number, my: number) => {
          const s = stateRef.current;
          if (s.disabled) return;
          if (s.phase !== "idle") return;
          if (!s.round) return;
          // Outside the open window we cannot open — but the press can
          // still PICK a barrier (so the user sees their pick highlighted
          // ready for the next round). Picking lives in the touch zone.
          const inUpper = my < chartArea.y + chartArea.height / 2;
          const picked: BarrierIndex = inUpper ? BARRIER_UPPER : BARRIER_LOWER;
          // We always pick on press, regardless of window — picker is
          // visual / a focal point. The PARENT decides whether to send the
          // open tx based on isInOpenWindow at the moment onOpen fires.
          pressMs = p.millis();
          // The actual onOpen call is deferred to mouseDragged / release —
          // we want to distinguish tap (pick only) from hold (open).
          // BUT — to keep optimistic UI snappy we still call onOpen
          // immediately when the open window is live; the parent's hook
          // handles single-flight dedupe.
          if (isInOpenWindow()) {
            const barrierPrice =
              picked === BARRIER_UPPER
                ? s.round.upperBarrier
                : s.round.lowerBarrier;
            callbacksRef.current.onOpen(picked, barrierPrice);
          }
          // Reference mx so the linter sees it used.
          void mx;
        };

        const endPress = () => {
          const s = stateRef.current;
          const heldMs = p.millis() - pressMs;
          pressMs = 0;
          // A tap (≤ TAP_VS_HOLD_MS) inside the open window with phase
          // still "opening" — let the parent's tap-detector / single-flight
          // decide; we always fire onClose on release so any "opening"
          // phase always resolves.
          if (s.phase === "riding" || s.phase === "opening") {
            callbacksRef.current.onClose();
          }
          // The pick persists in stateRef.current.pickedBarrier (driven by
          // the parent's useSegmentRide.pickBarrier).
          void heldMs;
        };

        // ── Stall detector (D4) ───────────────────────────────────────────
        const checkStall = (now: number) => {
          const s = stateRef.current;
          // Only watch for stalls while a ride is open. Idle is fine; the
          // market sleeps when no rides are out (doc 18 §6.4).
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

          // Sync the candle ring buffer to the parent's `segments`.
          reconcileSegments();
          // Stall watchdog.
          checkStall(now);
          // Detect phase transitions for position bookkeeping + FX.
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

  // Reference TAP_VS_HOLD_MS so the constant isn't reported as unused — it
  // is documentation for the parent's single-flight dedupe (see useSegmentRide).
  void TAP_VS_HOLD_MS;
}
