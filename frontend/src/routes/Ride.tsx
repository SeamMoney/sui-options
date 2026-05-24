/**
 * /ride — touch-either, always-open segment-arcade (doc 25) with a
 * graceful fallback to the v3 round-based UI (doc 19) when no v4 market
 * is deployed.
 *
 * Feature flag:
 *   - If `deployments.testnet.json` has any entry under `segment_markets_v4`,
 *     the latest one wins and we render the V4 surface (laser tracer,
 *     always-open press-anywhere gesture, BarrierFlowV4 right rail, the new
 *     "TAP AND HOLD TO RIDE" hero). The "Wait for the next round" branch
 *     is entirely absent from the V4 path.
 *   - Else, we fall back to the existing V3 surface (BarrierOrderbookGrid,
 *     barrier-pick affordance, RoundCountdown timer, "Wait for the next
 *     round" hero when outside the open window).
 *
 * This way the page never breaks during the migration window: v4 ships
 * to the Move side first, the bootstrap script writes its market into the
 * deployments JSON, and the frontend takes over on the next reload.
 */
import { useEffect, useMemo, useState } from "react";
import RideChart from "@/components/RideChart";
import RideChartV4 from "@/components/RideChartV4";
import { FaucetButton } from "@/components/wallet/FaucetButton";
import { RoundCountdown } from "@/components/RoundCountdown";
import { BarrierOrderbookGrid } from "@/components/BarrierOrderbookGrid";
import { BarrierFlowV4 } from "@/components/BarrierFlowV4";
import { useSegmentRide } from "@/hooks/useSegmentRide";
import { useSegmentRideV4 } from "@/hooks/useSegmentRideV4";
import type { RidePhase } from "@/hooks/useRideGesture";
import { useSessionWallet } from "@/hooks/useSessionWallet";
import {
  TESTNET_DEPLOYMENT,
  type SegmentMarketRecord,
  type SegmentMarketV4Record,
} from "@/lib/deployments";
import { BARRIER_UPPER, type BarrierIndex } from "@wick/sdk";

/**
 * Minimum SUI balance to allow a ride. Math for the testnet v4 market:
 *   escrow:    stake_per_segment × round_duration = 100k × 75 = 7.5M MIST
 *              (locked at open, refunded at close)
 *   open gas:  ~5M MIST
 *   close gas: ~5M MIST
 *   buffer:    ~7.5M MIST
 *   ────────────────────────────────────────────────────────
 *   total:     25M MIST = 0.025 SUI
 *
 * The old 0.05 gate was 2× over-provisioned and blocked anyone who burned
 * down to ~0.04 SUI on failed attempts — exactly the state the user hit
 * on 2026-05-23 ("I have 0.028 SUI why can't I play").
 */
const MIN_RIDE_BALANCE_MIST = 25_000_000n;

/**
 * Pick the latest v4 segment market from the deployment. Operators
 * append new bootstraps to the array; picking the LAST entry means a
 * re-bootstrap with fixed params automatically takes over.
 */
function pickSegmentMarketV4(): SegmentMarketV4Record | null {
  const markets = TESTNET_DEPLOYMENT.segment_markets_v4 ?? [];
  if (markets.length === 0) return null;
  return markets[markets.length - 1] ?? null;
}

/** Pick a v3 segment market — fallback when no v4 market is deployed. */
function pickSegmentMarket(): SegmentMarketRecord | null {
  const markets = TESTNET_DEPLOYMENT.segment_markets ?? [];
  if (markets.length === 0) return null;
  return markets[markets.length - 1] ?? null;
}

function useAutoDismissSettlement(
  settlement: { kind: number; label: string; digest: string } | null,
  ttlMs = 6000,
): { kind: number; label: string; digest: string } | null {
  const [visible, setVisible] = useState(settlement);
  useEffect(() => {
    if (!settlement) {
      setVisible(null);
      return;
    }
    setVisible(settlement);
    const id = window.setTimeout(() => setVisible(null), ttlMs);
    return () => window.clearTimeout(id);
  }, [settlement, ttlMs]);
  return visible;
}

function fmtSui(mist: bigint | null): string {
  if (mist === null) return "…";
  return (Number(mist) / 1_000_000_000).toFixed(3);
}

// ─────────────────────────────────────────────────────────────────────────
// CenterHeroV3 — the legacy hero kept for the fallback path.
// ─────────────────────────────────────────────────────────────────────────
function CenterHeroV3(props: {
  needsFunds: boolean;
  phase: RidePhase;
  pnl: number;
  stakePaid: number;
  multiplierX: number;
  barrierLabel: string;
  inOpenWindow: boolean;
  pickedBarrier: BarrierIndex | null;
}) {
  const {
    needsFunds,
    phase,
    pnl,
    stakePaid,
    multiplierX,
    barrierLabel,
    inOpenWindow,
    pickedBarrier,
  } = props;

  let kicker = "";
  let big = "";
  let sub = "";
  let tone: "neutral" | "amber" | "win" | "loss" = "neutral";

  if (needsFunds && phase === "idle") {
    kicker = "One tap to start";
    big = "Get test SUI";
    sub = "tap “Get test SUI”, top-right — free, instant, no wallet needed";
    tone = "amber";
  } else if (phase === "idle") {
    if (!inOpenWindow) {
      kicker = "Round live — barriers locked";
      big = "Wait for the next round";
      sub = "the next round rolls fresh barriers in a moment";
    } else if (pickedBarrier === null) {
      kicker = "Open window · pick a barrier";
      big = "Tap upper or lower";
      sub = `${multiplierX.toFixed(1)}× if price wicks your barrier — then press and hold to ride`;
      tone = "amber";
    } else {
      kicker = `Touch ${barrierLabel} · ${multiplierX.toFixed(1)}× payout`;
      big = "Hold the chart to ride";
      sub = "press and hold to open · release to cash out";
      tone = "amber";
    }
  } else if (phase === "opening") {
    kicker = "Opening your ride";
    big = "Keep holding…";
    sub = "your position is going on-chain — ~1-2 seconds";
  } else if (phase === "riding") {
    kicker = "You're riding — release to cash out";
    big = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
    tone = pnl >= 0 ? "win" : "loss";
    sub = `$${stakePaid.toFixed(2)} staked · ${multiplierX.toFixed(
      1,
    )}× if it touches`;
  } else {
    kicker = "Cashing out";
    big = "Settling…";
    sub = "your payout is landing — ~1-2 seconds";
  }

  const bigColor =
    tone === "win"
      ? "text-emerald-400"
      : tone === "loss"
        ? "text-rose-400"
        : tone === "amber"
          ? "text-amber-300"
          : "text-white";

  return (
    <div
      className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[1500] pointer-events-none w-full max-w-[440px] px-6 text-center"
      role="status"
      aria-live="polite"
    >
      <div
        className={`text-[11px] uppercase tracking-[0.22em] mb-2 ${
          tone === "amber" ? "text-amber-300/90" : "text-white/45"
        }`}
      >
        {kicker}
      </div>
      <div
        className={`font-bold tabular-nums leading-none ${bigColor} ${
          phase === "riding" ? "text-7xl" : "text-3xl"
        }`}
        style={{ textShadow: "0 2px 28px rgba(0,0,0,0.7)" }}
      >
        {big}
      </div>
      <div className="text-xs text-white/60 mt-3 leading-relaxed">{sub}</div>
      {(phase === "opening" || phase === "closing") && (
        <div className="mt-4 flex justify-center">
          <div className="h-1 w-24 rounded-full bg-white/10 overflow-hidden">
            <div className="h-full w-1/3 bg-amber-300/80 motion-safe:animate-[rideBar_1100ms_ease-in-out_infinite]" />
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// CenterHeroV4 — the new touch-either hero (doc 25 §5.4).
//
// Three states, ALWAYS actionable — no "wait for next round" branch:
//   idle       → "TAP AND HOLD TO RIDE — press anywhere — touch either side wins 1.75×"
//   opening    → "Opening your ride — keep holding"
//   riding     → big PnL number, proximity-coloured
//   closing    → "Cashing out"
// ─────────────────────────────────────────────────────────────────────────
function CenterHeroV4(props: {
  needsFunds: boolean;
  phase: RidePhase;
  pnl: number;
  stakePaid: number;
  multiplierX: number;
  /** Mobile-safe fallback when the touchend gesture misses. */
  onCashOut: () => void;
}) {
  const { needsFunds, phase, pnl, stakePaid, multiplierX, onCashOut } = props;

  let kicker = "";
  let big = "";
  let sub = "";
  let tone: "neutral" | "amber" | "win" | "loss" = "neutral";

  if (needsFunds && phase === "idle") {
    kicker = "One tap to start";
    big = "Get test SUI";
    sub = "tap “Get test SUI”, top-right — free, instant, no wallet needed";
    tone = "amber";
  } else if (phase === "idle") {
    // V4: ALWAYS the press-to-ride invitation. No round-phase gating.
    kicker = "⚡  Tap and hold to ride";
    big = "TAP AND HOLD";
    sub = `press anywhere — touch either side wins ${multiplierX.toFixed(2)}×`;
    tone = "amber";
  } else if (phase === "opening") {
    kicker = "Opening your ride";
    big = "Keep holding…";
    sub = "your position is going on-chain — ~1-2 seconds";
  } else if (phase === "riding") {
    kicker = "You're riding — release to cash out";
    big = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
    tone = pnl >= 0 ? "win" : "loss";
    sub = `hold for jackpot · release to cash out · $${stakePaid.toFixed(2)} staked`;
  } else {
    kicker = "Cashing out";
    big = "Settling…";
    sub = "your payout is landing — ~1-2 seconds";
  }

  const bigColor =
    tone === "win"
      ? "text-emerald-400"
      : tone === "loss"
        ? "text-rose-400"
        : tone === "amber"
          ? "text-amber-300"
          : "text-white";

  return (
    <div
      className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[1500] pointer-events-none w-full max-w-[480px] px-6 text-center"
      role="status"
      aria-live="polite"
    >
      <div
        className={`text-[11px] uppercase tracking-[0.22em] mb-2 ${
          tone === "amber" ? "text-amber-300/90" : "text-white/45"
        }`}
      >
        {kicker}
      </div>
      <div
        className={`font-bold tabular-nums leading-none ${bigColor} ${
          phase === "riding" ? "text-7xl" : "text-3xl"
        }`}
        style={{ textShadow: "0 2px 28px rgba(0,0,0,0.7)" }}
      >
        {big}
      </div>
      <div className="text-xs text-white/60 mt-3 leading-relaxed">{sub}</div>
      {(phase === "opening" || phase === "closing") && (
        <div className="mt-4 flex justify-center">
          <div className="h-1 w-24 rounded-full bg-white/10 overflow-hidden">
            <div className="h-full w-1/3 bg-amber-300/80 motion-safe:animate-[rideBar_1100ms_ease-in-out_infinite]" />
          </div>
        </div>
      )}
      {/*
        Mobile-safe cash-out fallback (2026-05-23). The gesture path —
        finger release → touchEnded → close() — sometimes misses on iOS
        Safari (touchcancel fires instead of touchend if the system pulls
        focus, or a state race makes close() see positionId=null). This
        button is the always-tappable backup: huge target, pointer-events-
        auto so it captures the tap even though the outer hero stays
        pointer-events-none for the rest of its content.
      */}
      {(phase === "riding" || phase === "opening" || phase === "closing") && (
        <div className="mt-6 flex justify-center pointer-events-auto">
          <button
            type="button"
            aria-label="Cash out — close your active ride"
            aria-busy={phase === "closing"}
            disabled={phase === "closing"}
            // P0 fix (agent #4): use single onPointerUp instead of
            // onClick + onTouchEnd. The dual-binding doubled-fired close()
            // because iOS Safari can deliver both the touch-synthesized
            // click AND the touchend, even with preventDefault. Pointer
            // events fire exactly once for both mouse and touch.
            // Empty onTouchStart re-enables iOS :active visual feedback.
            onTouchStart={() => {
              /* iOS :active enabler */
            }}
            onPointerUp={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onCashOut();
            }}
            className={`px-10 py-5 rounded-full text-base font-bold uppercase tracking-widest shadow-2xl active:scale-95 transition select-none focus-visible:ring-4 focus-visible:ring-amber-300/60 focus-visible:outline-none ${
              phase === "closing"
                ? "bg-white/40 text-zinc-700 cursor-not-allowed"
                : "bg-white text-zinc-950"
            }`}
            style={{
              touchAction: "manipulation",
              WebkitTapHighlightColor: "rgba(255,255,255,0.2)",
            }}
          >
            {phase === "closing" ? "Cashing out…" : "Cash out"}
          </button>
        </div>
      )}
    </div>
  );
}

/** FundCta — the funding gate shown when the burner is too low to ride. */
function FundCta(props: {
  balanceMist: bigint | null;
  address: string;
  onFunded: () => void;
}) {
  return (
    <div
      className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[1650] w-full max-w-[400px] px-6 text-center pointer-events-auto"
      role="status"
      aria-live="polite"
    >
      <div className="text-[11px] uppercase tracking-[0.22em] mb-2 text-amber-300/90">
        One tap to start
      </div>
      <div
        className="text-3xl font-bold text-white leading-none mb-3"
        style={{ textShadow: "0 2px 28px rgba(0,0,0,0.7)" }}
      >
        Add test SUI to ride
      </div>
      <div className="text-xs text-white/60 mb-5 leading-relaxed">
        You have {fmtSui(props.balanceMist)} SUI — a ride needs about 0.05.
        It’s free testnet SUI, no wallet required.
      </div>
      <div className="flex flex-col items-center gap-3">
        <FaucetButton
          recipient={props.address}
          onFunded={props.onFunded}
          size="lg"
          label="Get free test SUI"
        />
        <a
          href={`https://faucet.sui.io/?address=${props.address}`}
          target="_blank"
          rel="noreferrer"
          className="text-[11px] text-white/45 underline underline-offset-2"
        >
          or top up at the Sui faucet →
        </a>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// RideV4 — the V4 path. Self-contained (uses useSegmentRideV4 +
// useRideGestureV4 + BarrierFlowV4) so the V3 path doesn't carry its
// hooks when V4 is active and vice versa.
// ─────────────────────────────────────────────────────────────────────────
function RideV4(props: { picked: SegmentMarketV4Record }) {
  const { picked } = props;
  const session = useSessionWallet();

  const ride = useSegmentRideV4({
    market: picked,
    keypair: session.keypair,
    client: session.client,
    onBalanceChanged: session.refreshBalance,
  });

  const stableCallbacks = useMemo(
    () => ({
      onOpen: () => ride.open(),
      onClose: () => ride.close(),
      onStall: () => ride.triggerStallCrank(),
    }),
    // P0 fix (agents #1, #10): the previous empty-deps form captured
    // ride.open / ride.close from the FIRST render forever. The gesture
    // hook's callbacksRef-update effect at useRideGestureV4.ts:272 fires
    // when this object's identity changes — empty deps meant it never
    // did, so the gesture path was wired to the first-render hooks. Today
    // it happened to work because the underlying refs are stable, but any
    // future change to open/close that depends on a state value would
    // break silently. Listing the deps makes the comment true.
    [ride.open, ride.close, ride.triggerStallCrank],
  );

  const settlementToast = useAutoDismissSettlement(ride.lastSettlement);

  const [ridePnl, setRidePnl] = useState<{ pnl: number; staked: number }>({
    pnl: 0,
    staked: 0,
  });

  const needsFunds =
    session.balanceMist !== null &&
    session.balanceMist < MIN_RIDE_BALANCE_MIST;
  const stakePaid = ridePnl.staked;
  const multiplierX = ride.multiplierBps / 10_000;

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#0c0c0c] text-foreground select-none">
      {/* ── Chart ─────────────────────────────────────────────────────── */}
      <div className="absolute inset-0 mx-auto md:max-w-[800px]">
        <RideChartV4
          callbacks={stableCallbacks}
          phase={ride.phase}
          round={ride.round}
          segments={ride.segments}
          multiplierBps={ride.multiplierBps}
          stakePerSegmentMicroUsd={ride.stakePerSegmentMicroUsd}
          onPnlChange={setRidePnl}
          disabled={needsFunds}
        />
      </div>

      {/* ── Top bar — balance · round timer · faucet ──────────────────── */}
      <div
        className="fixed left-0 right-0 z-[1600] flex items-start justify-between px-3 pointer-events-none gap-2"
        style={{ top: `calc(env(safe-area-inset-top) + 10px)` }}
      >
        <div className="glass-container px-3 py-2 rounded-lg font-mono">
          <div className="glass-filter" />
          <div className="glass-overlay" />
          <div className="glass-specular" />
          <div className="relative z-10 leading-tight">
            <div className="text-[9px] uppercase tracking-[0.18em] text-white/45">
              Play balance
            </div>
            <div className="text-sm font-semibold tabular-nums text-white">
              {fmtSui(session.balanceMist)} SUI
            </div>
          </div>
        </div>

        {/*
         * V4 declutter: the top-bar RoundCountdown was duplicating info
         * that BarrierFlowV4 (right rail) already shows — round number +
         * countdown — plus it still displayed "PICK A BARRIER" copy from
         * v3 even though v4 has no barrier-pick step. Dropped entirely
         * for v4. The right-rail panel is the single source of round
         * status. (User feedback 2026-05-23: "as little as stuff on the
         * screen as possible".)
         */}

        <div className="pointer-events-auto">
          {!needsFunds && session.balanceMist !== null ? (
            <div className="glass-container px-3 py-2 rounded-lg font-mono">
              <div className="glass-filter" />
              <div className="glass-overlay" />
              <div className="glass-specular" />
              <div className="relative z-10 text-[11px] text-emerald-400/90 uppercase tracking-wider">
                ✓ ready
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* ── Right edge: V4 barrier-flow panel ─────────────────────────── */}
      <div
        className="fixed right-3 z-[1550] pointer-events-none"
        style={{ top: `calc(env(safe-area-inset-top) + 80px)` }}
      >
        <BarrierFlowV4
          marketId={picked.market}
          client={session.client}
          initialSnapshot={ride.marketSnapshot}
        />
      </div>

      {/* ── Center: fund CTA when broke, else V4 state hero ──────────── */}
      {needsFunds && ride.phase === "idle" && !settlementToast ? (
        <FundCta
          balanceMist={session.balanceMist}
          address={session.address}
          onFunded={session.refreshBalance}
        />
      ) : !settlementToast ? (
        <CenterHeroV4
          needsFunds={needsFunds}
          phase={ride.phase}
          pnl={ridePnl.pnl}
          stakePaid={stakePaid}
          multiplierX={multiplierX}
          onCashOut={() => ride.close()}
        />
      ) : null}

      {/* ── Settlement result ───────────────────────────────────────── */}
      {settlementToast && (
        <div
          className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[1700] w-full max-w-[440px] px-6 text-center motion-safe:animate-[rideSettleIn_280ms_ease-out]"
          role="status"
          aria-live="polite"
        >
          <div className="text-[11px] uppercase tracking-[0.22em] mb-2 text-white/45">
            {settlementToast.kind === 1
              ? "Touch hit — jackpot"
              : settlementToast.kind === 2
                ? "Cashed out"
                : settlementToast.kind === 3
                  ? "Round ended — no touch"
                  : settlementToast.kind === 4
                    ? "Market voided — refunded"
                    : "Ride settled"}
          </div>
          <div
            className={`text-5xl font-bold leading-none ${
              settlementToast.kind === 1
                ? "text-emerald-400"
                : settlementToast.kind === 2
                  ? "text-white"
                  : settlementToast.kind === 3
                    ? "text-rose-400"
                    : "text-amber-300"
            }`}
            style={{ textShadow: "0 2px 28px rgba(0,0,0,0.7)" }}
          >
            {settlementToast.label.replace(/_/g, " ")}
          </div>
          <a
            href={`https://suiscan.xyz/testnet/tx/${settlementToast.digest}`}
            target="_blank"
            rel="noreferrer"
            className="inline-block text-xs text-white/55 mt-3 underline underline-offset-2"
          >
            view transaction →
          </a>
        </div>
      )}

      {/* ── Error line ──────────────────────────────────────────────── */}
      {ride.lastError && ride.phase === "idle" && (
        <div
          className="fixed left-1/2 -translate-x-1/2 z-[1650] pointer-events-none"
          style={{ bottom: `calc(env(safe-area-inset-bottom) + 18px)` }}
        >
          <div className="font-mono text-[11px] text-rose-400/85 text-center max-w-[340px] px-4">
            {ride.lastError}
          </div>
        </div>
      )}

      <style>{`
        @keyframes rideSettleIn {
          from { opacity: 0; transform: translate(-50%, calc(-50% + 10px)); }
          to   { opacity: 1; transform: translate(-50%, -50%); }
        }
        @keyframes rideBar {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(320%); }
        }
      `}</style>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// RideV3 — the legacy V3 path (kept unchanged for fallback).
// ─────────────────────────────────────────────────────────────────────────
function RideV3(props: { picked: SegmentMarketRecord }) {
  const { picked } = props;
  const session = useSessionWallet();

  const ride = useSegmentRide({
    market: picked,
    keypair: session.keypair,
    client: session.client,
    onBalanceChanged: session.refreshBalance,
  });

  const stableCallbacks = useMemo(
    () => ({
      onOpen: (barrierIndex: BarrierIndex, barrierPrice: number) => {
        ride.pickBarrier(barrierIndex);
        ride.open(barrierIndex, barrierPrice);
      },
      onClose: () => ride.close(),
      onStall: () => ride.triggerStallCrank(),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const settlementToast = useAutoDismissSettlement(ride.lastSettlement);

  const [ridePnl, setRidePnl] = useState<{ pnl: number; staked: number }>({
    pnl: 0,
    staked: 0,
  });

  const needsFunds =
    session.balanceMist !== null &&
    session.balanceMist < MIN_RIDE_BALANCE_MIST;
  const stakePaid = ridePnl.staked;
  const multiplierX = ride.multiplierBps / 10_000;

  const barrierLabel =
    ride.pickedBarrier === BARRIER_UPPER
      ? `above $${ride.round?.upperBarrier.toLocaleString(undefined, { maximumFractionDigits: 2 }) ?? "—"}`
      : ride.pickedBarrier !== null
        ? `below $${ride.round?.lowerBarrier.toLocaleString(undefined, { maximumFractionDigits: 2 }) ?? "—"}`
        : "";

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#0c0c0c] text-foreground select-none">
      <div className="absolute inset-0 mx-auto md:max-w-[800px]">
        <RideChart
          callbacks={stableCallbacks}
          phase={ride.phase}
          pickedBarrier={ride.pickedBarrier}
          round={ride.round}
          segments={ride.segments}
          multiplierBps={ride.multiplierBps}
          stakePerSegmentMicroUsd={ride.stakePerSegmentMicroUsd}
          onPnlChange={setRidePnl}
          disabled={needsFunds}
        />
      </div>

      <div
        className="fixed left-0 right-0 z-[1600] flex items-start justify-between px-3 pointer-events-none gap-2"
        style={{ top: `calc(env(safe-area-inset-top) + 10px)` }}
      >
        <div className="glass-container px-3 py-2 rounded-lg font-mono">
          <div className="glass-filter" />
          <div className="glass-overlay" />
          <div className="glass-specular" />
          <div className="relative z-10 leading-tight">
            <div className="text-[9px] uppercase tracking-[0.18em] text-white/45">
              Play balance
            </div>
            <div className="text-sm font-semibold tabular-nums text-white">
              {fmtSui(session.balanceMist)} SUI
            </div>
          </div>
        </div>

        <RoundCountdown
          roundIndex={ride.round?.index ?? null}
          startedAtSegment={ride.round?.startedAtSegment ?? null}
          nextSegmentIndex={ride.nextSegmentIndex}
          roundDurationSegments={
            ride.round?.roundDurationSegments ?? 75
          }
          openWindowSegments={ride.round?.openWindowSegments ?? 13}
        />

        <div className="pointer-events-auto">
          {!needsFunds && session.balanceMist !== null ? (
            <div className="glass-container px-3 py-2 rounded-lg font-mono">
              <div className="glass-filter" />
              <div className="glass-overlay" />
              <div className="glass-specular" />
              <div className="relative z-10 text-[11px] text-emerald-400/90 uppercase tracking-wider">
                ✓ ready
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="fixed right-3 z-[1550] pointer-events-none" style={{ top: `calc(env(safe-area-inset-top) + 80px)` }}>
        <BarrierOrderbookGrid marketId={picked.market} client={session.client} />
      </div>

      {needsFunds && ride.phase === "idle" && !settlementToast ? (
        <FundCta
          balanceMist={session.balanceMist}
          address={session.address}
          onFunded={session.refreshBalance}
        />
      ) : !settlementToast ? (
        <CenterHeroV3
          needsFunds={needsFunds}
          phase={ride.phase}
          pnl={ridePnl.pnl}
          stakePaid={stakePaid}
          multiplierX={multiplierX}
          barrierLabel={barrierLabel}
          inOpenWindow={ride.inOpenWindow}
          pickedBarrier={ride.pickedBarrier}
        />
      ) : null}

      {settlementToast && (
        <div
          className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[1700] w-full max-w-[440px] px-6 text-center motion-safe:animate-[rideSettleIn_280ms_ease-out]"
          role="status"
          aria-live="polite"
        >
          <div className="text-[11px] uppercase tracking-[0.22em] mb-2 text-white/45">
            {settlementToast.kind === 1
              ? "Touch hit — jackpot"
              : settlementToast.kind === 2
                ? "Cashed out"
                : settlementToast.kind === 3
                  ? "Round ended — no touch"
                  : settlementToast.kind === 4
                    ? "Market voided — refunded"
                    : "Ride settled"}
          </div>
          <div
            className={`text-5xl font-bold leading-none ${
              settlementToast.kind === 1
                ? "text-emerald-400"
                : settlementToast.kind === 2
                  ? "text-white"
                  : settlementToast.kind === 3
                    ? "text-rose-400"
                    : "text-amber-300"
            }`}
            style={{ textShadow: "0 2px 28px rgba(0,0,0,0.7)" }}
          >
            {settlementToast.label.replace(/_/g, " ")}
          </div>
          <a
            href={`https://suiscan.xyz/testnet/tx/${settlementToast.digest}`}
            target="_blank"
            rel="noreferrer"
            className="inline-block text-xs text-white/55 mt-3 underline underline-offset-2"
          >
            view transaction →
          </a>
        </div>
      )}

      {ride.lastError && ride.phase === "idle" && (
        <div
          className="fixed left-1/2 -translate-x-1/2 z-[1650] pointer-events-none"
          style={{ bottom: `calc(env(safe-area-inset-bottom) + 18px)` }}
        >
          <div className="font-mono text-[11px] text-rose-400/85 text-center max-w-[340px] px-4">
            {ride.lastError}
          </div>
        </div>
      )}

      <style>{`
        @keyframes rideSettleIn {
          from { opacity: 0; transform: translate(-50%, calc(-50% + 10px)); }
          to   { opacity: 1; transform: translate(-50%, -50%); }
        }
        @keyframes rideBar {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(320%); }
        }
      `}</style>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Ride — feature-flag entry point.
//
// Picks V4 if any v4 market is deployed; else falls back to V3; else
// shows the empty-deployment "no markets provisioned" notice.
// ─────────────────────────────────────────────────────────────────────────
export function Ride() {
  const pickedV4 = useMemo(() => pickSegmentMarketV4(), []);
  const pickedV3 = useMemo(() => pickSegmentMarket(), []);

  if (pickedV4) return <RideV4 picked={pickedV4} />;
  if (pickedV3) return <RideV3 picked={pickedV3} />;

  return (
    <div className="fixed inset-0 bg-[#0c0c0c] text-foreground flex flex-col items-center justify-center font-mono p-6 text-center">
      <h1 className="text-2xl font-semibold mb-2">
        No segment-arcade market provisioned
      </h1>
      <p className="text-sm text-muted-foreground max-w-md">
        The touch-either arcade (doc 25) needs a bootstrapped{" "}
        <code className="text-foreground">SegmentMarketV4&lt;SUI&gt;</code>{" "}
        or, as fallback, a v3{" "}
        <code className="text-foreground">SegmentMarket&lt;SUI&gt;</code>.
        Add one to{" "}
        <code className="text-foreground">deployments/testnet.json</code>
        {" "}under the{" "}
        <code className="text-foreground">segment_markets_v4</code> or
        {" "}
        <code className="text-foreground">segment_markets</code> key and reload.
      </p>
    </div>
  );
}

export default Ride;
