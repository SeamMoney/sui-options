/**
 * /pro — Wick Pro: one-tap Black-Scholes options on a LIVE DeepBook mark.
 *
 * This is the SUBMISSION-STRATEGY build: options priced off the REAL DeepBook
 * mid (`useDeepBookMark`, #38) with an honest σ from the live trade series
 * (`useDeepBookCandles` / `realizedVolatility`, #44), the settlement-consistent
 * P&L engine (#37), and the CandleVision pattern coach (#39) reading the SAME
 * live candles. No synthetic path — the price you see is the on-chain CLOB.
 *
 * The whole game on one mobile screen:
 *   pick UP (call) / DOWN (put) + a $ amount → ONE big live P&L (value & %)
 *   updating off the real mid every tick → auto-settles at expiry → the result
 *   EQUALS the last live number you watched.
 *
 * Why live == settlement (the trust-critical bit):
 *   - The headline is `unrealizedPnl(pos, spot, now, σ)` — the Black-Scholes
 *     sell-to-close mark minus premium, fed the live mid; it moves continuously.
 *   - Settlement auto-closes at the expiry mark via `sellToClose`. Same formula,
 *     and at τ=0 the BS mark collapses to intrinsic, so the settled number is
 *     exactly the last live number. Proven in the pro-options conformance tests.
 *
 * Premiums price in real time against the live σ, so the break-even move on the
 * button (e.g. "+0.03% to win") matches a genuine 60-second move — a fair,
 * lively round, not the always-lose overpricing an accelerated clock gives.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  openOption,
  pnlReturnFraction,
  price,
  realizedPnl,
  sellToClose,
  unrealizedPnl,
  yearsFromSeconds,
  type OptionPosition,
  type OptionSide,
} from "@sui-options/pro-options";
import type { CandleInput } from "@sui-options/candle-vision";
import { useDeepBookMark } from "@/hooks/useDeepBookMark";
import { useDeepBookCandles } from "@/hooks/useDeepBookCandles";
import {
  DEEPBOOK_POOLS,
  deepBookPoolExplorerUrl,
  type DeepBookPoolName,
} from "@/lib/deepbook";
import { PatternCoachPanel } from "@/components/PatternCoachPanel";

// ── Game knobs ──────────────────────────────────────────────────────────────
const EXPIRY_SECONDS = 60;
const SPREAD_BPS = 150; // house vig, applied buy-side at open
const FALLBACK_SIGMA = 0.6; // until the live σ lands (useDeepBookCandles seeds 0.6)
const STAKE_PRESETS = [1, 5, 10, 25];
const MAX_POINTS = 120; // rolling mark history for the sparkline

interface MarkPoint {
  t: number;
  mid: number;
}

function fmtSignedUsd(n: number, dp = 2): string {
  const s = Math.abs(n).toFixed(dp);
  return `${n < 0 ? "−" : "+"}$${s}`;
}
function fmtPct(frac: number): string {
  const pct = frac * 100;
  return `${pct < 0 ? "−" : "+"}${Math.abs(pct).toFixed(1)}%`;
}
function fmtPrice(n: number): string {
  if (n >= 100) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(5);
}

export function WickProLive() {
  const [pool, setPool] = useState<DeepBookPoolName>("SUI_USDC");
  const { mark, status } = useDeepBookMark(pool, 1500);
  const { candles, sigma: liveSigma, status: candleStatus } = useDeepBookCandles(pool, {
    bucketMs: 60_000,
    pollMs: 5_000,
  });
  const [stakeUsd, setStakeUsd] = useState(5);
  const [position, setPosition] = useState<OptionPosition | null>(null);
  const [settled, setSettled] = useState<OptionPosition | null>(null);
  const [history, setHistory] = useState<MarkPoint[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const nowMsRef = useRef(nowMs); // latest frame time, for exact close-at-display
  // The exact (spot, nowMs) the headline P&L was last PAINTED with — CLOSE
  // settles from these so the banked result is byte-for-byte the number that
  // was on screen when you tapped (not a fresh frame that may have glided on).
  const paintedRef = useRef<{ spot: number | null; nowMs: number }>({ spot: null, nowMs });
  // Smoothed spot: eased toward the latest mark every animation frame so the
  // price line + P&L glide at ~60fps instead of stepping each 1.5s poll.
  const [spotSmooth, setSpotSmooth] = useState<number | null>(null);
  const spotSmoothRef = useRef<number | null>(null);
  const targetSpotRef = useRef<number | null>(null);
  const idRef = useRef(0);
  const seededRef = useRef(false); // chart pre-seeded from candle history?

  // Live realized vol once candles arrive; sane fallback while connecting.
  const sigma = candleStatus === "live" && liveSigma > 0 ? liveSigma : FALLBACK_SIGMA;
  // The P&L, the chart tip, settlement — everything reads the SAME smoothed
  // spot, so the number a player watches still equals what they're paid.
  const spot = spotSmooth;

  // Graceful degradation: if the DeepBook indexer never delivers a first mark
  // (cold-start outage), don't sit on a blank "waiting…" screen during a demo —
  // surface the offline /pro-sim variant. Resets the moment a mark lands.
  const [coldStartFailed, setColdStartFailed] = useState(false);
  useEffect(() => {
    if (spot !== null) {
      setColdStartFailed(false);
      return;
    }
    const id = window.setTimeout(() => {
      if (spotSmoothRef.current === null) setColdStartFailed(true);
    }, 12_000);
    return () => window.clearTimeout(id);
  }, [spot]);

  // Latest real mark is the easing target.
  useEffect(() => {
    if (mark?.mid != null) targetSpotRef.current = mark.mid;
  }, [mark?.mid]);

  // Whether a position is live — read inside the rAF loop without resubscribing.
  const hasPositionRef = useRef(false);
  useEffect(() => {
    hasPositionRef.current = position != null;
  }, [position]);

  // Single rAF loop: advance the clock (smooth theta decay) and ease the spot
  // toward the live mark at the display refresh rate (~60fps). The per-frame
  // clock tick only fires while a position is open (it drives the live P&L /
  // countdown); idle, we still ease the spot but don't force 60fps re-renders,
  // so the page doesn't burn battery when nobody's in a trade.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      nowMsRef.current = Date.now();
      const target = targetSpotRef.current;
      let eased = false;
      if (target != null) {
        const cur = spotSmoothRef.current;
        // Snap on first mark; otherwise exponential ease (~120ms to converge).
        const next =
          cur == null || Math.abs(target - cur) < target * 1e-7
            ? target
            : cur + (target - cur) * 0.18;
        if (next !== spotSmoothRef.current) {
          spotSmoothRef.current = next;
          setSpotSmooth(next); // re-renders the spot/chart tip + (with a position) the P&L
          eased = true;
        }
      }
      // Drive the live-P&L/countdown clock every frame while in a trade; when
      // idle and the spot has settled, skip the re-render entirely.
      if (hasPositionRef.current && !eased) setNowMs(nowMsRef.current);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Accumulate the mark into a rolling history for the chart. Reset on pool flip.
  useEffect(() => {
    setHistory([]);
    setPosition(null);
    setSettled(null);
    spotSmoothRef.current = null;
    targetSpotRef.current = null;
    setSpotSmooth(null);
    seededRef.current = false;
  }, [pool]);
  // Seed the sparkline with the pool's REAL recent candle closes so the chart
  // is a full, real price history from the first frame — not an empty line
  // building up from scratch. Live marks then extend it.
  useEffect(() => {
    if (seededRef.current || candles.length === 0) return;
    seededRef.current = true;
    const seed = candles.map((c) => ({ t: c.tMs, mid: c.close }));
    // Prepend the real candle history in FRONT of whatever live marks have
    // streamed in so far (the marks are newer than the bars), then cap.
    setHistory((h) => {
      const olderSeed = seed.filter((s) => h.length === 0 || s.t < h[0]!.t);
      const merged = [...olderSeed, ...h];
      return merged.length > MAX_POINTS ? merged.slice(merged.length - MAX_POINTS) : merged;
    });
  }, [candles]);
  useEffect(() => {
    if (!mark) return;
    setHistory((h) => {
      const next = [...h, { t: mark.tsMs, mid: mark.mid }];
      return next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next;
    });
  }, [mark?.tsMs, mark?.mid]);

  // CandleVision coach reads the real DeepBook bars (mapped to its input shape).
  const coachCandles: CandleInput[] = useMemo(
    () =>
      candles.map((c) => ({
        time: c.tMs,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      })),
    [candles],
  );

  // Build a fresh position at the current mark (no state writes — callers set it).
  const buildPosition = useCallback(
    (side: OptionSide): OptionPosition | null => {
      if (spot === null) return null;
      const tauYears = yearsFromSeconds(EXPIRY_SECONDS);
      const fair = price({ spot, strike: spot, tauYears, sigma, side });
      if (!(fair > 0)) return null;
      const perContract = fair * (1 + SPREAD_BPS / 10_000);
      const contracts = stakeUsd / perContract; // premiumPaid == stakeUsd exactly
      const openedAtMs = Date.now();
      return openOption({
        id: `pro-${++idRef.current}`,
        side,
        strike: spot,
        openedAtMs,
        expiryMs: openedAtMs + EXPIRY_SECONDS * 1000,
        contracts,
        fairPremium: fair,
        spreadBps: SPREAD_BPS,
      });
    },
    [spot, stakeUsd, sigma],
  );

  const openPosition = useCallback(
    (side: OptionSide) => {
      if (position) return;
      const pos = buildPosition(side);
      if (!pos) return;
      setSettled(null);
      setPosition(pos);
    },
    [position, buildPosition],
  );

  // CLOSE = cash out NOW at the live mark. sellToClose at `now` returns exactly
  // the unrealizedPnl shown in the headline at the same `now`, so the result the
  // player banks equals the live number they were watching.
  const closeNow = useCallback(() => {
    if (!position) return;
    // Settle from the EXACT (spot, nowMs) the headline was last painted with,
    // so the banked result equals the number on screen when you tapped — even
    // if a 60fps frame glided it in between perception and click.
    const { spot: s, nowMs: t } = paintedRef.current;
    if (s === null) return;
    const done = sellToClose(position, s, t, sigma, SPREAD_BPS);
    setSettled(done);
    setPosition(null);
  }, [position, sigma]);

  // FLIP = reverse the bet: cash out the current leg and open the opposite side
  // at the live mark with the same stake, in one tap. Never leaves you with no
  // position (the whole point of FLIP vs CLOSE).
  const flip = useCallback(() => {
    if (!position || spot === null) return;
    const opp: OptionSide = position.side === "call" ? "put" : "call";
    const next = buildPosition(opp);
    if (!next) return;
    setSettled(null);
    setPosition(next);
  }, [position, spot, buildPosition]);

  // Settle at expiry by auto-closing at the expiry mark — equals the last live
  // number (same mark-to-close formula; at τ=0 the mark collapses to intrinsic).
  useEffect(() => {
    if (!position || spot === null) return;
    if (nowMs >= position.expiryMs) {
      const done = sellToClose(position, spot, position.expiryMs, sigma, SPREAD_BPS);
      setSettled(done);
      setPosition(null);
    }
  }, [nowMs, position, spot, sigma]);

  // The ONE headline P&L: live mark-to-close for an open position, realized for
  // a just-settled one. Same formula on both sides ⇒ continuous through expiry.
  const headline = useMemo(() => {
    if (position && spot !== null) {
      const pnl = unrealizedPnl(position, spot, nowMs, sigma, SPREAD_BPS);
      return { pnl, pct: pnlReturnFraction(pnl, position.premiumPaid), live: true, pos: position };
    }
    if (settled) {
      const pnl = realizedPnl(settled);
      return { pnl, pct: pnlReturnFraction(pnl, settled.premiumPaid), live: false, pos: settled };
    }
    return null;
  }, [position, settled, spot, nowMs, sigma]);

  // Record the inputs this render painted the live P&L with, so CLOSE can
  // settle from exactly them (see closeNow).
  paintedRef.current = { spot, nowMs };

  // Memoized so the 60fps P&L loop doesn't re-run the CandleVision scan — the
  // coach only recomputes when the candle window actually changes (~5s).
  const coachEl = useMemo(
    () =>
      coachCandles.length >= 4 ? (
        <PatternCoachPanel candles={coachCandles} maxItems={3} className="!p-3 sm:!p-4" />
      ) : null,
    [coachCandles],
  );

  // Settle FEEL: a quick full-screen colour flash + number pop when a round
  // resolves, so a win lands with a punch and a loss reads instantly. Keyed on
  // the settled position id so every settle re-triggers it.
  const [flash, setFlash] = useState<null | "win" | "loss">(null);
  // Running session result — shows the game LOOP working over several rounds.
  const [session, setSession] = useState({ pnl: 0, wins: 0, losses: 0 });
  const lastSettledIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!settled) return;
    const won = realizedPnl(settled) >= 0;
    setFlash(won ? "win" : "loss");
    // Tally the round once (the effect can re-run without a new settle).
    if (settled.id !== lastSettledIdRef.current) {
      lastSettledIdRef.current = settled.id;
      const net = realizedPnl(settled);
      setSession((s) => ({
        pnl: s.pnl + net,
        wins: s.wins + (won ? 1 : 0),
        losses: s.losses + (won ? 0 : 1),
      }));
    }
    const id = window.setTimeout(() => setFlash(null), 850);
    return () => window.clearTimeout(id);
  }, [settled]);

  const secsLeft = position ? Math.max(0, Math.ceil((position.expiryMs - nowMs) / 1000)) : 0;
  const poolMeta = DEEPBOOK_POOLS[pool];

  return (
    <div className="fixed inset-0 flex flex-col bg-[#0b0b0c] text-white overflow-hidden">
      <style>{`
        @keyframes wpFlash { 0% { opacity: 0.9 } 100% { opacity: 0 } }
        @keyframes wpPop { 0% { transform: scale(0.7); opacity: 0 } 45% { transform: scale(1.12) } 100% { transform: scale(1); opacity: 1 } }
      `}</style>
      {/* Settle flash — a fading colour wash, green on a win, red on a loss. */}
      {flash && (
        <div
          className="pointer-events-none fixed inset-0 z-40"
          style={{
            background:
              flash === "win"
                ? "radial-gradient(circle at 50% 42%, rgba(16,185,129,0.30), transparent 70%)"
                : "radial-gradient(circle at 50% 42%, rgba(244,63,94,0.22), transparent 70%)",
            animation: "wpFlash 850ms ease-out forwards",
          }}
        />
      )}
      {/* Header */}
      <header className="flex items-center justify-between px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2 shrink-0">
        <div className="flex items-center gap-2">
          <span className="font-black tracking-tight text-lg">
            wick<span className="text-emerald-400">.pro</span>
          </span>
          <span className="text-[10px] uppercase tracking-widest text-white/40 border border-white/15 rounded px-1.5 py-0.5">
            options
          </span>
        </div>
        <div className="flex items-center gap-1">
          {(Object.keys(DEEPBOOK_POOLS) as DeepBookPoolName[]).map((p) => (
            <button
              key={p}
              onClick={() => setPool(p)}
              disabled={!!position}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold transition disabled:opacity-40 ${
                p === pool ? "bg-white text-zinc-950" : "bg-white/10 text-white/70"
              }`}
            >
              {DEEPBOOK_POOLS[p].label}
            </button>
          ))}
        </div>
      </header>

      {/* Live mark + live σ (honest pricing) */}
      <div className="px-4 flex items-baseline gap-2 shrink-0">
        <span className="text-3xl font-bold tabular-nums">
          {spot !== null ? fmtPrice(spot) : "—"}
        </span>
        <a
          href={deepBookPoolExplorerUrl(pool)}
          target="_blank"
          rel="noreferrer"
          title="Verify this DeepBook pool on-chain (mainnet CLOB)"
          className="text-xs text-white/40 underline decoration-white/20 underline-offset-2 hover:text-white/70"
        >
          {poolMeta.base}/{poolMeta.quote} ↗
        </a>
        {candleStatus === "live" && (
          <span className="text-[10px] text-white/35 tabular-nums">σ {(sigma * 100).toFixed(0)}%</span>
        )}
        {session.wins + session.losses > 0 && (
          <span
            className={`text-[10px] tabular-nums ${session.pnl >= 0 ? "text-emerald-400/80" : "text-rose-500/80"}`}
            title="Your running result this session"
          >
            sess {fmtSignedUsd(session.pnl)} · {session.wins}W/{session.losses}L
          </span>
        )}
        <span
          className={`ml-auto text-[10px] uppercase tracking-widest flex items-center gap-1 ${
            status === "live" ? "text-emerald-400" : status === "stale" ? "text-amber-400" : "text-white/40"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${
            status === "live" ? "bg-emerald-400 animate-pulse" : status === "stale" ? "bg-amber-400" : "bg-white/30"
          }`} />
          DeepBook {status}
        </span>
      </div>

      {/* Indexer cold-start fallback — only if no mark after ~12s. */}
      {coldStartFailed && spot === null && (
        <div className="px-4 pb-1 shrink-0">
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200/90">
            Can't reach the DeepBook indexer right now.{" "}
            <a href="/pro-sim" className="font-semibold underline underline-offset-2">
              Play the offline version →
            </a>
          </div>
        </div>
      )}

      {/* Chart + coach overlay */}
      <div className="relative flex-1 min-h-0 px-2 py-2">
        <MarkChart
          history={history}
          strike={headline?.pos.strike ?? null}
          up={headline ? headline.pnl >= 0 : true}
        />
        {/* CandleVision coach — real DeepBook bars. Visible on every viewport. */}
        {coachEl && (
          <div className="absolute bottom-1 right-1 w-[158px] sm:w-[220px]">{coachEl}</div>
        )}
      </div>

      {/* Headline P&L OR the round result */}
      <div className="px-4 shrink-0 text-center min-h-[84px] flex flex-col justify-center">
        {headline ? (
          <>
            <div className="text-[11px] uppercase tracking-[0.2em] text-white/40">
              {headline.live
                ? `${headline.pos.side === "call" ? "UP" : "DOWN"} · ${secsLeft}s left`
                : headline.pnl >= 0
                  ? "Settled — you won"
                  : "Settled — you lost"}
            </div>
            <div
              // Keyed by position/settled id so the number POPS on mount —
              // once when a bet is placed (instant "it's on" feedback) and once
              // when it settles. 60fps text updates keep the same key, so they
              // don't re-trigger the pop.
              key={headline.live ? `live-${position?.id ?? ""}` : `settled-${settled?.id ?? ""}`}
              className={`text-6xl font-black tabular-nums leading-none ${
                headline.pnl >= 0 ? "text-emerald-400" : "text-rose-500"
              }`}
              style={{
                textShadow: "0 2px 32px rgba(0,0,0,0.6)",
                animation: "wpPop 320ms ease-out",
              }}
            >
              {fmtSignedUsd(headline.pnl)}
            </div>
            <div className={`mt-1 text-lg font-bold tabular-nums ${headline.pnl >= 0 ? "text-emerald-400/80" : "text-rose-500/80"}`}>
              {fmtPct(headline.pct)}
            </div>
          </>
        ) : (
          <div className="text-white/45 text-sm">
            Pick a side. ${stakeUsd} premium · live P&L updates off the real mark · auto-settles in {EXPIRY_SECONDS}s.
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shrink-0 space-y-3">
        {!position && (
          <div className="flex items-center justify-center gap-2">
            <span className="text-[11px] uppercase tracking-widest text-white/40">Amount</span>
            {STAKE_PRESETS.map((s) => (
              <button
                key={s}
                onClick={() => setStakeUsd(s)}
                className={`px-3 py-1.5 rounded-lg text-sm font-bold tabular-nums transition ${
                  s === stakeUsd ? "bg-white/90 text-zinc-950" : "bg-white/10 text-white/70"
                }`}
              >
                ${s}
              </button>
            ))}
          </div>
        )}

        {position ? (
          // Locked: the buttons become CLOSE / FLIP — never UP/DOWN while a
          // position is on (GAME-STATE-BUGS rule).
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={closeNow}
              className="rounded-2xl bg-white text-zinc-950 active:scale-95 transition py-5 font-black text-xl disabled:opacity-40 shadow-lg"
            >
              CLOSE
              <div className="text-[11px] font-semibold text-zinc-950/60 normal-case tabular-nums">
                cash out {headline ? fmtSignedUsd(headline.pnl) : ""}
              </div>
            </button>
            <button
              onClick={flip}
              className={`rounded-2xl active:scale-95 transition py-5 font-black text-xl text-zinc-950 shadow-lg ${
                position.side === "call"
                  ? "bg-rose-500 shadow-rose-500/20"
                  : "bg-emerald-500 shadow-emerald-500/20"
              }`}
            >
              FLIP {position.side === "call" ? "▼ DOWN" : "▲ UP"}
              <div className="text-[11px] font-semibold normal-case opacity-70">
                reverse · {secsLeft}s left
              </div>
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => openPosition("call")}
              disabled={spot === null}
              className="rounded-2xl bg-emerald-500 active:scale-95 transition py-5 font-black text-xl text-zinc-950 disabled:opacity-40 shadow-lg shadow-emerald-500/20"
            >
              ▲ UP
              <div className="text-[11px] font-semibold text-emerald-950/70 normal-case">
                {spot !== null ? breakevenLabel(spot, "call", sigma) : "call"}
              </div>
            </button>
            <button
              onClick={() => openPosition("put")}
              disabled={spot === null}
              className="rounded-2xl bg-rose-500 active:scale-95 transition py-5 font-black text-xl text-zinc-950 disabled:opacity-40 shadow-lg shadow-rose-500/20"
            >
              ▼ DOWN
              <div className="text-[11px] font-semibold text-rose-950/70 normal-case">
                {spot !== null ? breakevenLabel(spot, "put", sigma) : "put"}
              </div>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The break-even move: how far spot must travel by expiry for the bet to clear
 * its premium. For an ATM contract that's `premiumPerContract / spot`.
 */
function breakevenLabel(spot: number, side: OptionSide, sigma: number): string {
  const tauYears = yearsFromSeconds(EXPIRY_SECONDS);
  const fair = price({ spot, strike: spot, tauYears, sigma, side });
  if (!(fair > 0)) return side === "call" ? "call" : "put";
  const perContract = fair * (1 + SPREAD_BPS / 10_000);
  const movePct = (perContract / spot) * 100;
  const arrow = side === "call" ? "+" : "−";
  return `${arrow}${movePct.toFixed(2)}% to win`;
}

/** Minimal dependency-free SVG area chart of the rolling mark + strike line.
 *  Memoized so the 60fps P&L loop doesn't re-render the chart every frame —
 *  it only re-draws when the history/strike/colour actually change. */
const MarkChart = memo(function MarkChart(props: {
  history: MarkPoint[];
  strike: number | null;
  up: boolean;
}) {
  const { history, strike, up } = props;
  const W = 1000;
  const H = 320;
  if (history.length < 2) {
    return (
      <div className="h-full w-full flex items-center justify-center text-white/25 text-sm">
        waiting for the DeepBook mark…
      </div>
    );
  }
  const mids = history.map((p) => p.mid);
  let lo = Math.min(...mids, strike ?? Infinity);
  let hi = Math.max(...mids, strike ?? -Infinity);
  if (hi === lo) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.12;
  lo -= pad; hi += pad;
  const x = (i: number) => (i / (history.length - 1)) * W;
  const y = (v: number) => H - ((v - lo) / (hi - lo)) * H;
  const line = mids.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;
  const stroke = up ? "#34d399" : "#f43f5e";
  const lastY = y(mids[mids.length - 1]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full">
      <defs>
        <linearGradient id="proFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#proFill)" />
      <path d={line} fill="none" stroke={stroke} strokeWidth={3} vectorEffect="non-scaling-stroke" />
      {strike !== null && (
        <line
          x1={0}
          x2={W}
          y1={y(strike)}
          y2={y(strike)}
          stroke="#ffffff"
          strokeWidth={1.5}
          strokeDasharray="6 6"
          vectorEffect="non-scaling-stroke"
          opacity={0.5}
        />
      )}
      <circle cx={W} cy={lastY} r={5} fill={stroke} vectorEffect="non-scaling-stroke" />
    </svg>
  );
});

export default WickProLive;
