/**
 * /pro — Wick Pro: the Black-Scholes options round game (the sui-options
 * hackathon submission, per SUBMISSION-STRATEGY).
 *
 * One mode, one screen, dead simple:
 *   pick a market → tap UP (call) or DOWN (put) → watch ONE big live P&L →
 *   close (or let it settle) → the result equals the live P&L you watched.
 *
 * All pricing / P&L / settlement is the @sui-options/pro-options engine via
 * useRoundHost. The headline P&L is the engine's settlement-projected number
 * (live == settlement — see useRoundHost / PR #37), so what you watch is what
 * you're paid. The CandleVision PatternCoachPanel reads the same path.
 *
 * Mobile-first; bloxwap aesthetic — black, mono numbers, neon-green = up,
 * hot-magenta = down, big rounded-full buttons.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  MARKET_PRESETS,
  pathToCandles,
  type MarketPreset,
  type OptionSide,
} from "@sui-options/pro-options";
import type { CandleInput } from "@sui-options/candle-vision";
import { useRoundHost } from "@/pro/useRoundHost";
import { PatternCoachPanel } from "@/components/PatternCoachPanel";

const UP_COLOR = "#00ff3f"; // call / win
const DOWN_COLOR = "#ff0696"; // put / loss
const LOBBY_MS = 3_000;
const LIVE_MS = 75_000;
const SETTLE_MS = 4_000;
const CONTRACT_CHOICES = [1, 5, 10, 25];

function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : n > 0 ? "+" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

/** Area+line chart of the revealed path, with strike / breakeven overlays. */
function PriceChart({
  path,
  strike,
  breakeven,
  posSide,
  pnlPositive,
}: {
  path: number[];
  strike: number | null;
  breakeven: number | null;
  posSide: OptionSide | null;
  pnlPositive: boolean;
}) {
  const W = 100;
  const H = 100;
  const pts = path.length > 1 ? path : path.length === 1 ? [path[0]!, path[0]!] : [];
  if (pts.length === 0) {
    return <div className="h-full w-full" />;
  }
  const extras = [strike, breakeven].filter((v): v is number => v != null);
  const hi = Math.max(...pts, ...extras);
  const lo = Math.min(...pts, ...extras);
  const span = Math.max(0.0001, hi - lo);
  const pad = span * 0.08;
  const top = hi + pad;
  const bot = lo - pad;
  const range = top - bot;
  const x = (i: number) => (i / (pts.length - 1)) * W;
  const y = (v: number) => ((top - v) / range) * H;

  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(p).toFixed(2)}`).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;
  // Color the trace by position direction once open; neutral white idle.
  const traceColor = posSide == null ? "#d4d4d8" : pnlPositive ? UP_COLOR : DOWN_COLOR;
  const last = pts[pts.length - 1]!;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full" aria-hidden>
      <defs>
        <linearGradient id="wp-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={traceColor} stopOpacity={0.28} />
          <stop offset="100%" stopColor={traceColor} stopOpacity={0} />
        </linearGradient>
      </defs>
      {/* Idle = bare glowing line (bloxwap pattern); the PnL-tinted area
          fill only appears once a position is open. */}
      {posSide != null && <path d={area} fill="url(#wp-area)" />}
      <path d={line} fill="none" stroke={traceColor} strokeWidth={0.9} vectorEffect="non-scaling-stroke" />
      {strike != null && (
        <line
          x1={0}
          x2={W}
          y1={y(strike)}
          y2={y(strike)}
          stroke="#ffffff"
          strokeWidth={0.5}
          strokeDasharray="2 2"
          opacity={0.45}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {breakeven != null && (
        <line
          x1={0}
          x2={W}
          y1={y(breakeven)}
          y2={y(breakeven)}
          stroke={posSide === "call" ? UP_COLOR : DOWN_COLOR}
          strokeWidth={0.5}
          strokeDasharray="1 2"
          opacity={0.6}
          vectorEffect="non-scaling-stroke"
        />
      )}
      <circle cx={x(pts.length - 1)} cy={y(last)} r={1.1} fill={traceColor} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function WickPro() {
  const [presetId, setPresetId] = useState<string>("trending");
  const preset: MarketPreset = useMemo(
    () => MARKET_PRESETS.find((p) => p.id === presetId) ?? MARKET_PRESETS[0]!,
    [presetId],
  );
  // Per-round seed. Bumped on each new round so the host re-inits.
  const [seed, setSeed] = useState(() => 1000 + Math.floor((preset.startPrice * 7) % 9999));
  const [contracts, setContracts] = useState(5);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openStrike, setOpenStrike] = useState<number | null>(null);
  const [openSide, setOpenSide] = useState<OptionSide | null>(null);
  const [lastResult, setLastResult] = useState<{ pnl: number; ret: number } | null>(null);
  const advancedRef = useRef(false);

  const host = useRoundHost({
    preset,
    seed,
    lobbyMs: LOBBY_MS,
    liveMs: LIVE_MS,
    settleMs: SETTLE_MS,
  });

  const { phase, spot, path, pnl, pnlReturn, positions, msLeftInPhase, quote, openOption, sellToClose } = host;

  // Reset per-round local state when the seed changes (new round mounts).
  useEffect(() => {
    setOpenId(null);
    setOpenStrike(null);
    setOpenSide(null);
    advancedRef.current = false;
  }, [seed]);

  // Auto-advance to the next round once results land. Capture the realized
  // P&L first so the player sees what they made (it equals the live P&L).
  useEffect(() => {
    if (phase === "results" && !advancedRef.current) {
      advancedRef.current = true;
      if (openId) setLastResult({ pnl, ret: pnlReturn });
      const id = window.setTimeout(() => setSeed((s) => s + 1), 2600);
      return () => window.clearTimeout(id);
    }
  }, [phase, openId, pnl, pnlReturn]);

  const hasPosition = openId != null && positions.some((p) => p.id === openId);
  const canTrade = phase === "live" && !hasPosition;

  const place = (side: OptionSide) => {
    if (!canTrade) return;
    const strike = spot; // ATM at open
    const expiryInMs = Math.max(4_000, msLeftInPhase); // expires at round end
    const pos = openOption(side, strike, expiryInMs, contracts);
    if (pos) {
      setOpenId(pos.id);
      setOpenStrike(strike);
      setOpenSide(side);
      setLastResult(null);
    }
  };

  const close = () => {
    if (openId) {
      setLastResult({ pnl, ret: pnlReturn });
      sellToClose(openId);
      setOpenId(null);
      setOpenSide(null);
      setOpenStrike(null);
    }
  };

  // Quote preview for the idle buttons — premium per side at ATM.
  const callQuote = canTrade ? quote("call", spot, Math.max(4_000, msLeftInPhase)) : null;
  const putQuote = canTrade ? quote("put", spot, Math.max(4_000, msLeftInPhase)) : null;

  const breakeven = useMemo(() => {
    if (openStrike == null || openSide == null || !hasPosition) return null;
    const pos = positions.find((p) => p.id === openId);
    if (!pos) return null;
    const perContract = pos.premiumPaid / Math.max(1, pos.contracts);
    return openSide === "call" ? openStrike + perContract : openStrike - perContract;
  }, [openStrike, openSide, hasPosition, positions, openId]);

  const coachCandles: CandleInput[] = useMemo(() => {
    if (path.length < 4) return [];
    return pathToCandles(path, 3, 0, 3).map((c) => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
  }, [path]);

  const pnlPositive = pnl >= 0;
  const secsLeft = Math.ceil(msLeftInPhase / 1000);

  return (
    <div className="fixed inset-0 flex flex-col bg-black text-white overflow-hidden">
      <div className="mx-auto flex h-full w-full max-w-[820px] flex-col px-4 pb-[max(env(safe-area-inset-bottom),12px)] pt-3 sm:px-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-bold tracking-tight">WICK PRO</span>
            <span className="text-[10px] uppercase tracking-[0.18em] text-white/35">
              options · provably fair
            </span>
          </div>
          <div className="font-mono text-sm tabular-nums text-white/80">
            ${spot.toFixed(2)}
          </div>
        </div>

        {/* Market chips (pick asset) */}
        <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1 scrollbar-none">
          {MARKET_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                if (p.id !== presetId) {
                  setPresetId(p.id);
                  setSeed((s) => s + 1);
                }
              }}
              className={`shrink-0 rounded-full px-3 py-1 text-[11px] font-semibold tracking-wide transition ${
                p.id === presetId
                  ? "bg-white text-black"
                  : "bg-white/[0.06] text-white/55 hover:text-white/80"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Chart + big P&L */}
        <div className="relative mt-3 min-h-0 flex-1">
          <div className="absolute inset-0">
            <PriceChart
              path={path}
              strike={hasPosition ? openStrike : null}
              breakeven={breakeven}
              posSide={hasPosition ? openSide : null}
              pnlPositive={pnlPositive}
            />
          </div>

          {/* Phase chip */}
          <div className="absolute left-0 top-0">
            <span className="rounded-full bg-white/[0.06] px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-white/55">
              {phase === "lobby" && "next round…"}
              {phase === "live" && `${secsLeft}s left`}
              {phase === "settle" && "settling"}
              {phase === "results" && "round over"}
            </span>
          </div>

          {/* THE headline P&L — one big number, only when it means something */}
          <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center">
            {hasPosition ? (
              <>
                <div
                  className="text-6xl font-bold leading-none tabular-nums sm:text-7xl"
                  style={{ color: pnlPositive ? UP_COLOR : DOWN_COLOR, textShadow: "0 2px 30px rgba(0,0,0,0.8)" }}
                >
                  {fmtUsd(pnl)}
                </div>
                <div
                  className="mt-2 text-lg font-semibold tabular-nums"
                  style={{ color: pnlPositive ? UP_COLOR : DOWN_COLOR }}
                >
                  {pnlReturn >= 0 ? "+" : ""}
                  {(pnlReturn * 100).toFixed(1)}%
                </div>
              </>
            ) : lastResult ? (
              <div>
                <div
                  className="text-5xl font-bold leading-none tabular-nums sm:text-6xl"
                  style={{ color: lastResult.pnl >= 0 ? UP_COLOR : DOWN_COLOR, textShadow: "0 2px 30px rgba(0,0,0,0.8)" }}
                >
                  {fmtUsd(lastResult.pnl)}
                </div>
                <div className="mt-2 text-xs uppercase tracking-[0.2em] text-white/45">
                  {lastResult.pnl >= 0 ? "you won" : "settled"}
                </div>
              </div>
            ) : (
              <div className="text-xs uppercase tracking-[0.22em] text-white/40">
                {phase === "live" ? "tap UP or DOWN to trade" : "round starting…"}
              </div>
            )}
          </div>

          {/* Coach panel — bottom-right, hidden on the smallest phones to keep the P&L hero clean */}
          {coachCandles.length > 0 && (
            <div className="absolute bottom-1 right-0 hidden w-[220px] sm:block">
              <PatternCoachPanel candles={coachCandles} maxItems={3} />
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="mt-3 shrink-0">
          {/* Amount stepper (hidden while holding a position) */}
          {!hasPosition && (
            <div className="mb-2 flex items-center justify-center gap-1.5">
              <span className="mr-1 text-[10px] uppercase tracking-[0.18em] text-white/35">
                size
              </span>
              {CONTRACT_CHOICES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setContracts(c)}
                  className={`rounded-full px-3 py-1 font-mono text-[11px] tabular-nums transition ${
                    contracts === c ? "bg-white/15 text-white" : "bg-white/[0.04] text-white/45"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          )}

          {hasPosition ? (
            <button
              type="button"
              onClick={close}
              className="h-16 w-full rounded-full bg-white text-lg font-bold uppercase tracking-widest text-black active:scale-[0.98] transition"
            >
              Close · {fmtUsd(pnl)}
            </button>
          ) : (
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                disabled={!canTrade}
                onClick={() => place("put")}
                className="flex h-16 flex-col items-center justify-center rounded-full font-bold uppercase tracking-widest transition active:scale-[0.98] disabled:opacity-35"
                style={{ color: DOWN_COLOR, background: "rgba(255,6,150,0.12)", boxShadow: canTrade ? "0 0 24px rgba(255,6,150,0.18)" : "none" }}
              >
                <span className="text-lg leading-none">DOWN</span>
                {putQuote && (
                  <span className="mt-0.5 font-mono text-[10px] font-normal tracking-normal opacity-70">
                    ${(putQuote.premium * contracts).toFixed(2)}
                  </span>
                )}
              </button>
              <button
                type="button"
                disabled={!canTrade}
                onClick={() => place("call")}
                className="flex h-16 flex-col items-center justify-center rounded-full font-bold uppercase tracking-widest transition active:scale-[0.98] disabled:opacity-35"
                style={{ color: UP_COLOR, background: "rgba(0,255,63,0.12)", boxShadow: canTrade ? "0 0 24px rgba(0,255,63,0.18)" : "none" }}
              >
                <span className="text-lg leading-none">UP</span>
                {callQuote && (
                  <span className="mt-0.5 font-mono text-[10px] font-normal tracking-normal opacity-70">
                    ${(callQuote.premium * contracts).toFixed(2)}
                  </span>
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default WickPro;
