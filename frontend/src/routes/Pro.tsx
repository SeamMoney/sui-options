/**
 * /pro — Wick Pro: one-tap Black-Scholes options on a LIVE DeepBook mark.
 *
 * The whole game on one mobile screen:
 *   pick UP (call) or DOWN (put) + a $ amount  →  one big LIVE P&L (value & %),
 *   updating off the real CLOB mid every tick  →  settles at expiry to cash
 *   intrinsic  →  the result EQUALS the last live number you watched.
 *
 * Why the live number always matches settlement (the trust-critical bit):
 *   - The headline P&L is `unrealizedPnl(pos, spot, now, σ)` — the Black-Scholes
 *     sell-to-close mark minus premium, fed the live mid. It moves continuously
 *     as the mark and time-to-expiry change.
 *   - Settlement auto-closes the position at the expiry mark via `sellToClose`.
 *     Both use the SAME mark-to-close formula, and at τ=0 the BS mark collapses
 *     to intrinsic, so the final settled number EQUALS the last live number the
 *     player watched — no trust gap. (Equivalent to "settle to value at expiry",
 *     just shown smoothly all the way in instead of snapping at the end.)
 *
 * Premiums are priced in real time against a fixed per-pool σ over a REAL spot;
 * no wallet, no signing — the legible "is the math honest" demo. See
 * SUBMISSION-STRATEGY (Wick Pro).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useDeepBookMark } from "@/hooks/useDeepBookMark";
import { DEEPBOOK_POOLS, type DeepBookPoolName } from "@/lib/deepbook";

// ── Game knobs ──────────────────────────────────────────────────────────────
// Premiums are priced in REAL time (τ = 60s in years), against a realistic
// annualized σ. That keeps the round FAIR: the break-even move on an ATM
// contract (≈ premium/contract) matches the size of a genuine 60-second SUI
// move (~tenths of a %), so a real tick up or down swings P&L meaningfully —
// instead of an accelerated clock that overprices the premium so badly the
// player can never reach break-even. Settlement is pure intrinsic regardless,
// so live P&L == settlement holds either way; this is purely about playability.
const EXPIRY_SECONDS = 60;
const SPREAD_BPS = 150; // house vig, applied buy-side at open
/** Assumed annualized vol per underlying (the mid is real; realized vol isn't
 *  cheap to measure live, so we price off a sane constant and say so). */
const SIGMA: Record<DeepBookPoolName, number> = { SUI_USDC: 0.65, DEEP_USDC: 0.9 };
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

export function Pro() {
  const [pool, setPool] = useState<DeepBookPoolName>("SUI_USDC");
  const { mark, status } = useDeepBookMark(pool, 1500);
  const [stakeUsd, setStakeUsd] = useState(5);
  const [position, setPosition] = useState<OptionPosition | null>(null);
  const [settled, setSettled] = useState<OptionPosition | null>(null);
  const [history, setHistory] = useState<MarkPoint[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const idRef = useRef(0);

  const sigma = SIGMA[pool];
  const spot = mark?.mid ?? null;

  // 10Hz clock for a smooth countdown + live P&L between mark polls.
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 100);
    return () => window.clearInterval(id);
  }, []);

  // Accumulate the mark into a rolling history for the chart. Reset on pool flip.
  useEffect(() => {
    setHistory([]);
    setPosition(null);
    setSettled(null);
  }, [pool]);
  useEffect(() => {
    if (!mark) return;
    setHistory((h) => {
      const next = [...h, { t: mark.tsMs, mid: mark.mid }];
      return next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next;
    });
  }, [mark?.tsMs, mark?.mid]);

  const openPosition = useCallback(
    (side: OptionSide) => {
      if (spot === null || position) return;
      const tauYears = yearsFromSeconds(EXPIRY_SECONDS);
      const fair = price({ spot, strike: spot, tauYears, sigma, side });
      if (!(fair > 0)) return;
      const perContract = fair * (1 + SPREAD_BPS / 10_000);
      const contracts = stakeUsd / perContract; // premiumPaid == stakeUsd exactly
      const openedAtMs = Date.now();
      const pos = openOption({
        id: `pro-${++idRef.current}`,
        side,
        strike: spot,
        openedAtMs,
        expiryMs: openedAtMs + EXPIRY_SECONDS * 1000,
        contracts,
        fairPremium: fair,
        spreadBps: SPREAD_BPS,
      });
      setSettled(null);
      setPosition(pos);
    },
    [spot, position, stakeUsd, sigma],
  );

  // Settle at expiry by auto-closing at the expiry mark. Because settlement is
  // sellToClose at τ=0 and the live headline is unrealizedPnl (the same
  // mark-to-close formula), the result EQUALS the last live number the player
  // watched — no trust gap. (At τ=0 the BS mark collapses to intrinsic, so this
  // is economically "settle to value at expiry", just shown smoothly the whole
  // way in rather than snapping at the end.)
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

  const secsLeft = position ? Math.max(0, Math.ceil((position.expiryMs - nowMs) / 1000)) : 0;
  const poolMeta = DEEPBOOK_POOLS[pool];

  return (
    <div className="fixed inset-0 flex flex-col bg-[#0b0b0c] text-white overflow-hidden">
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

      {/* Live mark */}
      <div className="px-4 flex items-baseline gap-2 shrink-0">
        <span className="text-3xl font-bold tabular-nums">
          {spot !== null ? fmtPrice(spot) : "—"}
        </span>
        <span className="text-xs text-white/40">{poolMeta.base}/{poolMeta.quote}</span>
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

      {/* Chart */}
      <div className="flex-1 min-h-0 px-2 py-2">
        <MarkChart
          history={history}
          strike={headline?.pos.strike ?? null}
          up={headline ? headline.pnl >= 0 : true}
        />
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
              className={`text-6xl font-black tabular-nums leading-none ${
                headline.pnl >= 0 ? "text-emerald-400" : "text-rose-500"
              }`}
              style={{ textShadow: "0 2px 32px rgba(0,0,0,0.6)" }}
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
        {/* Stake selector — hidden while a position is live */}
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
          <div className="rounded-2xl bg-white/5 border border-white/10 py-4 text-center">
            <div className="text-sm text-white/55">
              Riding to expiry — settles in <span className="font-bold tabular-nums text-white">{secsLeft}s</span>
            </div>
            <div className="text-[11px] text-white/35 mt-0.5">
              strike {fmtPrice(position.strike)} · {position.side === "call" ? "needs price UP" : "needs price DOWN"}
            </div>
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
 * its premium. For an ATM contract that's `premiumPerContract / spot`. This is
 * the one number that tells a player what they're actually betting on.
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

/** Minimal dependency-free SVG area chart of the rolling mark + strike line. */
function MarkChart(props: { history: MarkPoint[]; strike: number | null; up: boolean }) {
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
        <g>
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
        </g>
      )}
      <circle cx={W} cy={lastY} r={5} fill={stroke} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export default Pro;
