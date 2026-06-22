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
import { useEffect, useLayoutEffect, useRef } from "react";
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
// 2026-05-24 — bumped 40 → 120 after the user observed candles "stop
// rendering in the middle of the screen they dissapear. they should
// move all the way to the left!" on desktop. At 40 candles × 13px
// spacing = 520px of candles; a ~1100px-wide chart leaves the left
// half empty. The dynamic `maxCandles = Math.min(cap, width/spacing)`
// is what fills the width — the cap is now generous enough that even
// a 1600px desktop fills (~123 candles at 13px). Mobile stays well
// under the cap (375px / 9px = 41 candles).
const MAX_CHART_CANDLES = 120;
// Cap the closed-ride history so a long hold-heavy /ride session can't grow it
// unbounded — it's iterated every draw frame (drawPNLLine) and on every candle
// reveal. 40 ≫ the on-chart window (MAX_CHART_CANDLES), so no still-visible P&L
// line is ever dropped. Mirrors MAX_SEGMENT_RING / MAX_VISIBLE_RUGS.
const MAX_COMPLETED_TRADES = 40;
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
  /**
   * Wallclock-ms of the most recent RugFiredV4 event for this market.
   * Parent passes `Date.now()` when it observes a new RugFiredV4 event;
   * passing a strictly-greater value than the previous render triggers
   * the MARKET HALT FX (lossFlash + screenShake + sad audio + text
   * overlay for 1.5s). Null / unchanged value = no FX.
   */
  rugFiredAtMs?: number | null;
  /**
   * v4.31 — market ID, used to derive the per-round drift regime so the
   * client-side walk applies the same drift the chain does. When omitted
   * the regime defaults to RANGE (zero drift) — visual stays Brownian.
   */
  marketId?: string;
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
  /** Sticky: set once the close reaches either barrier (close>=barrier implies
   *  high>=barrier, i.e. a real chain TOUCH_WIN). Drives a settlement-honest live
   *  P&L — pay only on an actual touch, not on mere proximity. */
  touched: boolean;
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
    rugFiredAtMs = null,
    // v4.31 — `marketId` is accepted on the prop interface so callers can
    // pre-wire it for the upcoming v4.32 chain drift-shift, but the hook
    // itself doesn't read it yet (regime is purely informational until
    // chain integration ships).
    marketId: _marketId,
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
    rugFiredAtMs: rugFiredAtMs ?? null,
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
  // v4.25b — useLayoutEffect, not useEffect. The disabled prop is the
  // gate enforcement: when the funding modal appears, the gesture must
  // be blocked SAME FRAME. Regular useEffect runs after paint, leaving
  // a 1-frame window where FundCta is visible but stateRef.current.disabled
  // is still stale `false` — user's tap during that frame would slip
  // through the gate. useLayoutEffect runs synchronously after DOM
  // mutation, before paint, closing the race. User feedback: "If it told
  // me that I needed more SUI, then why did it let me enter a position?"
  useLayoutEffect(() => {
    stateRef.current.disabled = disabled;
  }, [disabled]);
  // v4.26 — rugFiredAtMs sync. useLayoutEffect (matching disabled above)
  // so the draw loop sees the new value on the very next frame, not one
  // paint later. The sketch's draw loop compares stateRef.current.rugFiredAtMs
  // against its own local lastSeenRugFiredAtMs and fires FX when it
  // observes a strictly-greater value.
  useLayoutEffect(() => {
    stateRef.current.rugFiredAtMs = rugFiredAtMs ?? null;
  }, [rugFiredAtMs]);
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

    // 2026-05-24 — wait for Bai Jamjuree to actually load before
    // importing p5. Google Fonts uses display=swap, so without this
    // gate p5 might rasterize its first frames against the SF Mono
    // fallback; the user then sees "the barrier lines … have basic
    // plain font". Once a canvas frame is drawn with the fallback,
    // browsers don't always re-resolve on subsequent frames. The font
    // load is awaited in parallel with the p5 dynamic-import so the
    // critical path doesn't get slower — whichever finishes last gates
    // the sketch.
    const fontReady: Promise<unknown> =
      typeof document !== "undefined" && document.fonts
        ? document.fonts
            .load('12px "Bai Jamjuree"')
            .catch(() => undefined)
        : Promise.resolve();
    void Promise.all([import("p5"), fontReady]).then(([mod]) => {
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
        // v4.22 — REVEAL_BASE_MS 100 → 160. User flagged 100 felt "too
        // fast" after v4.21 shipped it. 160 ms per candle = ~6.25 fps;
        // a 6-candle segment animates in ~960 ms. Push cadence
        // IDLE_WALK_INTERVAL_MS also bumped 600 → 960 to match (push
        // rate = drain rate, queue stays at 0-6 in steady state).
        const REVEAL_BASE_MS = 160;
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
        // v4.26 — MARKET HALT (rug pull) FX state. lastSeenRugFiredAtMs
        // is the wallclock-ms value last consumed from stateRef.current
        // — if the prop ever bumps to a strictly-greater value we trigger
        // FX (screenShake + lossFlash + sad audio + 1.5s text overlay).
        // rugOverlayUntilMs is wallclock (Date.now()) NOT p.millis() — see
        // the draw-side comment for why timing bases stay split.
        let lastSeenRugFiredAtMs: number | null = null;
        let rugOverlayUntilMs = 0;

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

        // v4.26 — MARKET HALT FX trigger. Called once per draw frame.
        // When stateRef.current.rugFiredAtMs ticks up (parent observes a
        // RugFiredV4 event and passes Date.now()), we fire the same FX
        // primitives used by a loss settlement — screenShake (bigger:
        // 30 vs 15 for emphasis on the "house just took your money"
        // moment), lossFlash, sad audio — plus a 1.5s "💥 MARKET HALT"
        // text overlay. Mirrors the onPhaseChange loss branch exactly so
        // FX behavior stays consistent between a normal expiry-loss and
        // a rug-loss.
        const checkRugTrigger = () => {
          const incoming = stateRef.current.rugFiredAtMs;
          if (incoming === null) return;
          if (lastSeenRugFiredAtMs !== null && incoming <= lastSeenRugFiredAtMs) return;
          lastSeenRugFiredAtMs = incoming;
          screenShake = 30;
          lossFlash = 255;
          tryPlayAudio(
            "https://assets.mixkit.co/active_storage/sfx/2037/2037-preview.mp3",
            0.7,
          );
          rugOverlayUntilMs = Date.now() + 1500;
        };

        // v4.26 — MARKET HALT text overlay. Drawn in the same band as
        // drawPatternTooltip (using the load-bearing quoted-family-name
        // font convention from v4.17). Fade is linear over the 1.5s
        // visible window. Date.now() basis matches checkRugTrigger so
        // the math is consistent — p.millis() would drift relative to
        // the parent's wallclock-ms event timestamps.
        const drawRugOverlay = () => {
          const now = Date.now();
          if (rugOverlayUntilMs <= now) return;
          const fade = Math.max(0, Math.min(1, (rugOverlayUntilMs - now) / 1500));
          p.textFont('"Bai Jamjuree", system-ui, sans-serif');
          p.textAlign(p.CENTER, p.CENTER);
          p.textSize(p.width < 768 ? 36 : 56);
          p.textStyle(p.BOLD);
          p.noStroke();
          p.fill(255, 60, 60, fade * 255);
          p.text("💥 MARKET HALT", p.width / 2, p.height / 2);
          p.textStyle(p.NORMAL);
        };

        // ── Segment → render-candle pipeline (verbatim from v3) ───────────
        const rebuildFromSegments = () => {
          const s = stateRef.current;
          const segs = s.segments;
          candles = [];
          seededCandles = [];
          highestExpandedK = null;
          // v4.29 — clear completedTrades on rebuild. Their PnL line
          // endpoints are stored as ageCandles (an index back from the
          // tail of `candles`). rebuildFromSegments then loops
          // `applySegment(seg, immediate=true)` over every chain segment,
          // and the immediate path bumps `entryAgeCandles += 1` per
          // pushed candle — so a 50-segment catch-up (300 pushes) bumps
          // every completed trade's age by 300, leaving its line either
          // hidden off-screen or anchored at the wrong on-screen candle.
          // User report 2026-05-25: "the green line segments don't stay
          // on the correct spot on the screen attached to the
          // candlestick chart, they separate after a little bit, they
          // drift apart as they move to the left side of the screen."
          // Triggered by Sui public-RPC rate-limiting (v4.29 also moves
          // the RPC URL to publicnode.com which has 10× the throttle
          // budget) — every throttled poll grew the segment gap until
          // the next successful poll triggered a rebuild. The lines
          // weren't accurate post-rebuild anyway, so just drop them.
          completedTrades = [];
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
            // v4.31b — DO NOT bump completedTrades ages by drop here.
            // `entryAgeCandles` is an age-from-tail, which is INVARIANT
            // under head-truncation: when we splice `drop` from the
            // head, both `candles.length` and the anchor index decrease
            // by `drop`, so `(length-1) - index` is unchanged. The push
            // paths in `drainRevealQueue` + `applySegment(immediate)`
            // already bump ages by +1 per pushed candle, which is the
            // correct adjustment. The previous `+= drop` here
            // double-counted, making the line endpoint drift LEFT by
            // `drop` candles every time the ring buffer rolled.
            //
            // User report after v4.29 / v4.30:
            // > "the green lines still don't properly stay attached to
            // >  the candlestick chart after the line is done. and the
            // >  user lets go and it is now moving to the left."
            //
            // `currentPosition.entrySegmentIdx` IS an absolute index
            // (not an age), so it still has to track the splice.
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
          // v4.31 — drift-shift DEFERRED until the chain ships the same
          // mutation (segment_market_v4 was over Sui's 102_400-byte
          // package size limit by ~260 bytes after the regime
          // integration; reverted from chain in same commit, will land
          // in v4.32 publish). Until then, applying drift here would
          // make client candles diverge from chain truth.
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
              // v4.25c — bump completedTrades ages on push so PnL line
              // endpoints stay anchored to the candle where the ride
              // actually closed instead of sliding with the chart. See
              // long note in drainRevealQueue for the full diagnosis.
              for (const t of completedTrades) {
                t.entryAgeCandles += 1;
                t.exitAgeCandles += 1;
              }
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

        // ── IDLE WALK (2026-05-24) ────────────────────────────────────────
        // Zero-cost client-side chart motion when no chain segments are
        // arriving. Same expandSegment math as the chain walk, but seeded
        // with browser randomness instead of `sui::random`. Looks identical
        // visually. Costs $0.
        //
        // Switches off the moment real chain segments start arriving (the
        // reconciler's gap-detect resets walkState to chain truth). User
        // never notices the transition because the visual cadence and shape
        // are the same — only the seed source changed.
        //
        // This solves the chicken-and-egg: a first-time visitor sees a
        // moving chart, decides to tap, the chain takes over for their ride,
        // then idle-walk resumes after they release. No more "frozen until
        // someone plays" problem, no more 0.5 SUI/min cranker burn.
        // v4.22 — IDLE_WALK_INTERVAL_MS 600 → 960 to match the new
        // 160ms reveal cadence (6 × 160 = 960). Push rate = drain rate,
        // chart stays smooth at ~6 candles/sec.
        //
        // CRITICAL — DETERMINISTIC SEED. Before v4.21 the idle walk
        // generated 32 random bytes per push via crypto.getRandomValues,
        // which meant two browsers viewing the same chart saw COMPLETELY
        // DIFFERENT candles between chain cranks. That broke the shared-
        // market premise. Now the seed is derived from the last chain
        // segment's key + a wallclock counter bucketed to
        // IDLE_WALK_INTERVAL_MS. All clients with the same chain state
        // at the same wallclock moment derive the same key, run
        // expandSegment with the same inputs, and see the same candles.
        const IDLE_WALK_INTERVAL_MS = 960;
        let lastIdleWalkMs = 0;
        // Deterministic 32-byte derivation from (lastChainKey, counter).
        // No SubtleCrypto async needed — a simple LCG mix is enough for
        // an idle-walk seed (not security-critical, just needs to be
        // pseudorandom-looking and deterministic across clients).
        const deriveIdleKey = (
          lastKey: Uint8Array | null,
          counter: number,
        ): Uint8Array => {
          const out = new Uint8Array(32);
          if (lastKey && lastKey.length >= 32) out.set(lastKey.subarray(0, 32));
          let mix = BigInt(counter);
          for (let i = 0; i < 32; i++) {
            mix = (mix * 6364136223846793005n + 1442695040888963407n) &
              0xffffffffffffffffn;
            out[i] = (out[i] ?? 0) ^ Number(mix & 0xffn);
          }
          return out;
        };
        const tickIdleWalk = (now: number) => {
          if (!walkState) return;
          const s = stateRef.current;
          // v4.22 — DROPPED the "stop during ride" gate. The old version
          // returned early when phase was opening/riding, which caused
          // the chart to FREEZE during a ride if chain segments didn't
          // arrive within 3s (the stall-cranker threshold) — user
          // reported: "after 1-2s the chart stops moving again, but the
          // PnL keeps changing." Now idle walk stays alive during a
          // ride. When real chain segments arrive, reconcileSegments
          // resets walkState to chain truth and the chart converges.
          // The user sees continuous motion either way.
          //
          // We still defer briefly after a real chain segment lands —
          // gives reconcileSegments time to apply chain truth before
          // idle walk pushes more derived candles on top.
          if (lastSegmentArrivedMs > 0 && now - lastSegmentArrivedMs < 1500) return;
          if (now - lastIdleWalkMs < IDLE_WALK_INTERVAL_MS) return;
          lastIdleWalkMs = now;

          // Pull the last chain segment key (if any) so all clients seed
          // the same way. Falls back to a constant 32-byte zero key if no
          // chain segment has ever been seen — still deterministic across
          // clients (they'll all use zeros + same counter).
          const segs = s.segments;
          const lastChainKey =
            segs.length > 0 ? segs[segs.length - 1]!.key : null;
          // Wallclock-bucketed counter. floor(now / IDLE_WALK_INTERVAL_MS)
          // is the same on every client within the same 600ms tick.
          const counter = Math.floor(Date.now() / IDLE_WALK_INTERVAL_MS);
          const fakeKey = deriveIdleKey(lastChainKey, counter);
          // v4.31 — drift-shift DEFERRED, see applySegment for context.
          const result = expandSegment(walkState, fakeKey);
          walkState = result.newState;
          for (let i = 0; i < result.candles.length; i++) {
            const c = result.candles[i]!;
            const rc = renderCandleFromSeeded(c, 0);
            revealQueue.push({ seeded: c, render: rc, armed: undefined });
          }
          // Don't bump highestExpandedK — that tracks CHAIN segments only.
          // When a real chain segment arrives the reconciler will compare
          // against highestExpandedK + 1n and reset walkState to chain truth,
          // visually "snapping" to reality with a single rebuild.
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
          // v4.25c — User report: "the green and red laser pointer
          // tracker somehow got kind of messed up where it doesnt track
          // on the right spot as accurately once you let go of the
          // screen to close position." drawSinglePNLLine indexes the
          // anchor candle as candles[length - 1 - ageCandles]. When a
          // new candle is pushed (length+1), the ages don't change, so
          // candles[length-1-age] now points one slot to the right of
          // the actual anchor — the line endpoint slides with the chart
          // instead of staying nailed to the close candle. Bumping ages
          // by 1 per push keeps the index pointing at the same candle.
          // truncateRingBuffer already does this on drop (line 583).
          for (const t of completedTrades) {
            t.entryAgeCandles += 1;
            t.exitAgeCandles += 1;
          }
          runPostHocPatternDetection();
          truncateRingBuffer();
          lastRevealMs = now;
        };

        const reconcileSegments = () => {
          const segs = stateRef.current.segments;
          if (segs.length === 0) {
            // No chain segments — bootstrap walkState from the round's
            // home price so idle-walk has somewhere to walk FROM. Used
            // both for the initial seed-candle render AND for the
            // client-side idle walk (which expandSegment's from walkState).
            if (!walkState) {
              const s = stateRef.current;
              const seedPrice = s.round?.spotAtRoll ?? 1000;
              const seedMicro = BigInt(Math.round(seedPrice * PRICE_SCALING));
              walkState = newWalkState(seedMicro, 1_000_000n, seedMicro);
              if (candles.length === 0) {
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
        // Draws the two full-width barrier LINES. The price pills are drawn
        // separately by drawBarrierPills() (after the axis ticks) so they sit
        // on top of the ticks and clear of the bottom-left RugFeed panel.
        const drawBarriers = () => {
          const s = stateRef.current;
          if (!s.round) return;
          const drawLine = (price: number, color: [number, number, number]) => {
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
          };
          drawLine(s.round.upperBarrier, [0, 255, 136]);
          drawLine(s.round.lowerBarrier, [255, 100, 100]);
        };

        // Right-axis price pills for the upper/lower barriers, mirroring the
        // orange current-price tag in drawPriceLine. v4.32: moved off the left
        // edge — the old "▲ upper $…" / "▼ lower $…" labels lived at
        // chartArea.x + 8 and collided permanently with the bottom-left RugFeed
        // "MARKET HALTS" panel (the lower barrier is always pinned near the
        // chart floor). Colour + ▲/▼ glyph keep the direction legible. Each
        // pill nudges clear of the current-price pill so the level stays
        // readable even at the touch climax, when price == barrier.
        const drawBarrierPills = () => {
          const s = stateRef.current;
          if (!s.round) return;
          p.textFont('"Bai Jamjuree", system-ui, sans-serif');

          const labelWidth = p.width < 768 ? 62 : 78;
          const labelHeight = p.width < 768 ? 18 : 22;
          const fontSize = p.width < 768 ? 10 : 12;
          const labelX = p.width - labelWidth - 2;

          const toY = (price: number) =>
            p.map(
              price,
              priceScale.min,
              priceScale.max,
              chartArea.y + chartArea.height,
              chartArea.y,
            );

          const currentY =
            candles.length > 0 ? toY(candles[candles.length - 1]!.close) : null;

          const drawOne = (
            price: number,
            color: [number, number, number],
            glyph: string,
            pushUp: boolean,
          ) => {
            let y = toY(price);
            // Dodge the current-price pill (drawn on the same right axis) so
            // both stay readable when price closes in on the barrier.
            if (currentY !== null && Math.abs(y - currentY) < labelHeight + 2) {
              y = currentY + (pushUp ? -(labelHeight + 2) : labelHeight + 2);
            }
            p.noStroke();
            p.fill(color[0], color[1], color[2], 255);
            p.rect(labelX, y - labelHeight / 2, labelWidth, labelHeight, 4);
            p.fill(8, 8, 10, 255);
            p.textAlign(p.CENTER, p.CENTER);
            p.textSize(fontSize);
            p.textStyle(p.BOLD);
            const t = price.toLocaleString(undefined, {
              maximumFractionDigits: price < 100 ? 2 : 0,
            });
            p.text(`${glyph} $${t}`, labelX + labelWidth / 2, y);
            p.textStyle(p.NORMAL);
          };

          drawOne(s.round.upperBarrier, [0, 255, 136], "▲", true);
          drawOne(s.round.lowerBarrier, [255, 100, 100], "▼", false);
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
          p.textFont('"Bai Jamjuree", system-ui, sans-serif');
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
          p.textFont('"Bai Jamjuree", system-ui, sans-serif');
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
          p.textFont('"Bai Jamjuree", system-ui, sans-serif');
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
          const entryVisible = actualEntryX >= chartArea.x;
          // v4.25d — REMOVED off-screen extrapolation + center-clamping.
          // The old code tried to draw the line even when the entry
          // candle had scrolled off-chart: clip lineStartX to
          // chartArea.x, extrapolate Y by slope, then clamp to center
          // ±35% of chart height. The clamp pulled the start back into
          // the chart, but at a Y that didn't correspond to any actual
          // price — so the line went from a fake left-edge point
          // corner-to-corner across the chart. User feedback: "the
          // tracker line segment isnt on the chart. it was more precise
          // before." Now we hide the line entirely once entry scrolls
          // off-screen. Either it's a faithful entry→exit segment or
          // it isn't drawn.
          if (!entryVisible) return;
          const lineStartX = entryXForSlope;
          const lineStartY = entryY;
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
              touched: false,
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
              if (completedTrades.length > MAX_COMPLETED_TRADES) {
                completedTrades = completedTrades.slice(-MAX_COMPLETED_TRADES);
              }
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
              } else if (profit < -0.30) {
                // v4.26 — gate loss FX above the cashout-fee noise floor.
                // UX audit P2 #23: old `profit < 0` fired the loss sound
                // + screen shake on any negative PnL, including a $0.05
                // cashout-fee loss. That punishes cautious play. Real
                // losses (EXPIRED_LOSS / RUG) on typical $0.10-stake
                // rides are -$7.50 escrow forfeit; typical cashout fees
                // are < $0.15. -$0.30 splits the two cleanly without
                // needing to plumb settlement_kind into the gesture hook.
                // MARKET HALT has its own dedicated FX in checkRugTrigger.
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

          // Settlement-honest live P&L. The chain settles BINARY: only an actual
          // barrier TOUCH pays stake*(mult-1); releasing WITHOUT a touch settles
          // CASHOUT (~$0). The old `staked*(mult-1)*proximity` rendered a green
          // profit for an approach that pays nothing — a judge watched "+$6.80",
          // released without touching, and got ~$0, breaking the "live==settlement"
          // promise on the main gesture. Now: $0 until a real touch (sticky — once
          // the close reaches a barrier, high>=barrier so the chain registers the
          // touch and the ride is a win that stays a win), then the actual win
          // amount. `staked` is still reported separately so the UI can show the
          // amount at risk. A wick-only touch the close misses still surfaces
          // correctly in the on-release settlement toast.
          if (proximity >= 1) currentPosition.touched = true;
          const livePnl = currentPosition.touched ? staked * (mult - 1) : 0;
          s.pnl = livePnl;
          if (now - lastPnlReportMs >= 80) {
            lastPnlReportMs = now;
            onPnlChangeRef.current?.({ pnl: livePnl, staked });
          }
        };

        // ── Gesture → open/close ──────────────────────────────────────────
        // V4: press ANYWHERE opens — no barrier-pick step. No open-window
        // gate. The parent's hook decides single-flight dedupe.

        // v4.26 — iOS audio prime (UX audit P2 #26). Safari blocks
        // `new Audio().play()` unless called inside a real user gesture
        // handler, so the very first win/jackpot was silent — the most
        // magical moment of the demo. Now: on the FIRST press, play a
        // 1-second silent WAV via tryPlayAudio. iOS treats that as the
        // unlock event and subsequent calls succeed. Costs nothing,
        // user hears nothing, every later sound plays as expected.
        const SILENT_WAV =
          "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAVFYAAFRWAAABAAgAZGF0YQAAAAA=";
        let audioUnlocked = false;
        const startPress = (_mx: number, _my: number) => {
          const s = stateRef.current;
          if (s.disabled) return;
          if (s.phase !== "idle") return;
          if (!s.round) return;
          if (!audioUnlocked) {
            audioUnlocked = true;
            tryPlayAudio(SILENT_WAV, 0);
          }
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
          // QUOTED FAMILY NAME — load-bearing. Without the inner quotes,
          // ctx.font becomes `12px Bai Jamjuree, system-ui, sans-serif`,
          // and Safari/iOS WebKit treats `Bai` + `Jamjuree` as two
          // unknown families, falling through to system-ui = SF Mono.
          // User feedback 2026-05-24: "why are the y axis labels and
          // barrier labels text not in bai jamjuree font!!".
          p.textFont('"Bai Jamjuree", system-ui, sans-serif');
          const isMobile = p.windowWidth < 768;
          const leftMargin = isMobile ? 4 : 8;
          // 2026-05-24 v4.18 — restored to the slim Y-axis gutter after
          // the BarrierFlowV4 panel that motivated the 320 px bump was
          // deleted entirely ("Just fucking delete that thing its not
          // useful"). 56 px on desktop is just enough for the Y-axis
          // price labels drawn by drawPriceLabels.
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
          // Run idle-walk BEFORE reveal — generates fake segments in-place
          // when no chain activity, so the queue has something to drain.
          tickIdleWalk(now);
          // Drain one item from the reveal queue per ~80 ms tick so the
          // chart animates candle-by-candle instead of jumping 6 at a time
          // when a SegmentRecordedV4 event lands.
          drainRevealQueue(now);
          checkStall(now);
          checkRugTrigger();
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
          // Barrier pills last (over the axis ticks + price line) so the
          // green/red right-axis tags read cleanly. Lines were drawn earlier
          // (drawBarriers) so candles render on top of them.
          drawBarrierPills();
          drawPNLLine();
          drawRugOverlay();
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
          // Mirror p.setup — 56 px gutter for the Y-axis price labels.
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

        // v4.31h — p5 binds mouse/touch listeners to the WINDOW by
        // default (so the chart can register taps anywhere on the
        // canvas regardless of which child div is on top). Side-effect:
        // a tap inside ANY DOM element — including portals rendered
        // ABOVE the chart, like Dynamic's auth modal — also fires
        // mousePressed/touchStarted here, which calls startPress() and
        // opens a ride mid-modal-tap.
        // User report 2026-05-26: "when I click on the modal it
        // registers it as I'm clicking on the game screen."
        // Fix: gate every handler on `event.target` being inside the
        // chart container. p5 hands the raw DOM event in `event`; we
        // walk up its parents to see if chartRef contains it. If not,
        // return TRUE so p5 lets the event propagate normally (the
        // modal's own onClick wins). Mouse handlers don't always
        // receive the event object in p5; we fall back to checking
        // document.activeElement against the chart, which catches the
        // "click happened on the modal" case cleanly enough for the
        // gesture path.
        const isEventInChart = (ev?: unknown): boolean => {
          const chartEl = chartRef.current;
          if (!chartEl) return false;
          if (ev && typeof ev === "object" && "target" in ev) {
            const t = (ev as Event).target as Node | null;
            if (t && chartEl.contains(t)) return true;
            if (t && !chartEl.contains(t)) return false;
          }
          // Mouse-handler fallback: when no event object is given,
          // check whether the canvas (the chart's child) holds focus.
          // Defaults to ALLOWED so we don't accidentally suppress
          // genuine canvas taps on browsers that don't pass `event`.
          return true;
        };

        p.mousePressed = (event?: unknown) => {
          if (stateRef.current.disabled) return true;
          if (!isEventInChart(event)) return true; // let modal handle it
          try {
            if (!touchActive) startPress(p.mouseX, p.mouseY);
          } catch {
            // ignore
          }
          return false;
        };
        p.mouseReleased = (event?: unknown) => {
          if (stateRef.current.disabled) return true;
          if (!isEventInChart(event)) return true;
          try {
            if (!touchActive) endPress();
          } catch {
            // ignore
          }
          return false;
        };
        p.touchStarted = (event?: unknown) => {
          if (stateRef.current.disabled) return true;
          if (!isEventInChart(event)) return true; // tap on Dynamic modal etc.
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
