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
import { useEffect, useMemo, useRef, useState } from "react";
import RideChart from "@/components/RideChart";
import RideChartV4 from "@/components/RideChartV4";
import { RugFeed } from "@/components/RugFeed";
import { DynamicConnectButton } from "@/components/wallet/DynamicConnectButton";
import { RegimeBadge } from "@/components/RegimeBadge";
import { FaucetButton } from "@/components/wallet/FaucetButton";
import { RoundCountdown } from "@/components/RoundCountdown";
import { BarrierOrderbookGrid } from "@/components/BarrierOrderbookGrid";
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
 * Minimum SUI balance to allow a ride.
 *
 * v4.25b — dropped 25M → 10M (0.025 → 0.01 SUI). The old 25M number
 * assumed escrow was paid in SUI; on the TUSD market that's wrong
 * (escrow is TUSD now, SUI only pays gas). One open or close tx costs
 * ~5-10M MIST in gas measured on chain. 10M MIST is just above what
 * one tx genuinely needs. User feedback: "if you dont have any SUI to
 * pay for gas + make your bet, then why would you be allowed to touch?"
 * — so the gate stays, but the threshold now matches real gas cost.
 * The TUSD-side escrow has its own collateral gate computed from the
 * market's own params (escrowThresholdRaw).
 */
const MIN_RIDE_BALANCE_MIST = 10_000_000n;

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

type SettlementToast = {
  kind: number;
  label: string;
  digest: string;
  /** doc 26 §5.1 — set to "rugged" when kind=3 fired in a rugged round. */
  settlementSubKind?: "rugged";
  /** v4.31d — chain-attested stake (raw micro-USD), from RideClosedV4. */
  stakePaidRaw?: bigint;
  /** v4.31d — chain-attested payout (raw micro-USD), from RideClosedV4. */
  payoutRaw?: bigint;
};

function useAutoDismissSettlement(
  settlement: SettlementToast | null,
  ttlMs = 6000,
): SettlementToast | null {
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
  /** True once the market snapshot has loaded — gates the "TAP AND HOLD" copy. */
  isReady: boolean;
  /** Last closed-ride PnL, shown briefly in idle state after release. */
  lastClosedPnl: number | null;
  /** Mobile-safe fallback when the touchend gesture misses. */
  onCashOut: () => void;
}) {
  const { needsFunds, phase, pnl, stakePaid, multiplierX, isReady, lastClosedPnl, onCashOut } = props;

  let kicker = "";
  let big = "";
  let sub = "";
  let tone: "neutral" | "amber" | "win" | "loss" = "neutral";

  if (needsFunds && phase === "idle") {
    kicker = "One tap to start";
    big = "Get free funds";
    sub = "tap “Get free funds”, top-right — SUI for gas + TUSD to bet, no wallet";
    tone = "amber";
  } else if (phase === "idle" && lastClosedPnl !== null) {
    // v4.23: PnL flash immediately after release. User said "as soon as
    // I stop holding and let go it should stop saying cashout. it should
    // say what my PNL was. and then it should go right back to saying
    // tap and hold." This is the brief PnL display before reverting
    // to the TAP AND HOLD invitation (RideV4 clears lastClosedPnl
    // after ~2.5s).
    const winning = lastClosedPnl >= 0;
    kicker = winning ? "Ride closed — nice" : "Ride closed";
    big = winning ? `+$${lastClosedPnl.toFixed(2)}` : `-$${Math.abs(lastClosedPnl).toFixed(2)}`;
    sub = "ready when you are — tap and hold again";
    tone = winning ? "win" : "loss";
  } else if (phase === "idle" && !isReady) {
    kicker = "Loading market";
    big = "Connecting…";
    sub = "one second — fetching the round";
    tone = "neutral";
  } else if (phase === "idle") {
    kicker = "⚡  Tap and hold to ride";
    big = "TAP AND HOLD";
    // v4.23: more explicit about the touch-either mechanic. User said
    // "I want it to be more clear about which direction you want to go
    // because right now it seems like I make positive pnl if it goes any
    // direction" — that's CORRECT (touch-either wins both ways). Just
    // need to make the mechanic legible.
    sub = isReady
      ? `Hold to bet price touches the GREEN or RED line — ${multiplierX.toFixed(2)}× payout. ~1.5% per second the market HALTS and wipes open rides. House edge: ~3.9%.`
      : "Hold to bet price touches the GREEN or RED line. ~1.5% per second the market HALTS and wipes open rides. House edge: ~3.9%.";
    tone = "amber";
  } else if (phase === "opening") {
    kicker = "Opening your ride";
    big = "Keep holding…";
    sub = "your position is going on-chain — ~1-2 seconds";
  } else if (phase === "riding") {
    // v4.23: clearer "let go to close" copy + explicit reminder that
    // EITHER side wins so the user understands why their PnL goes up
    // regardless of direction.
    kicker = "LET GO TO CLOSE";
    big = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
    tone = pnl >= 0 ? "win" : "loss";
    sub = `Either GREEN or RED touch wins ${multiplierX.toFixed(2)}× · $${stakePaid.toFixed(2)} staked`;
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
      {/* v4.19 audit P0-6: only mount cash-out when an actual position
          exists (riding or closing). During "opening" the position
          isn't on chain yet — queued closes there evaporate silently
          if the open then fails. */}
      {(phase === "riding" || phase === "closing") && (
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
        Get free test funds
      </div>
      <div className="text-xs text-white/60 mb-5 leading-relaxed">
        You have {fmtSui(props.balanceMist)} SUI. One tap drips 0.2 SUI (for
        network fees) + 10 TUSD (the stake currency). Free testnet only — no
        wallet required. Heads up: ~1.5% per second the market may HALT and
        wipe your ride. That's the house's edge.
      </div>
      <div className="flex flex-col items-center gap-3">
        <FaucetButton
          recipient={props.address}
          onFunded={props.onFunded}
          size="lg"
          label="Get free funds"
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
  // v4.25a — pass the active market's collateral type so the session
  // wallet polls both SUI (gas) AND the collateral coin (escrow). On a
  // TUSD market this is what lets the UI gate on TUSD funding, not just
  // SUI. Without this the user could see "0.2 SUI ✓ ready" with 0 TUSD,
  // tap, and immediately fail at chain time.
  const session = useSessionWallet({ collateralType: picked.collateral });

  // v4.30 — bump per-segment stake to the market's max. The default in
  // useSegmentRideV4 falls back to MIN stake (10000 micro-USD/sec =
  // $0.75/ride), which produces variance so small the player can't feel
  // the +3.93% house edge: max win ≈ $0.56, max loss ≈ $0.75. User
  // report 2026-05-25: "I dont really lose money ever ... my balance
  // would always just go back to 40 TUSD." Using max stake = ~10× the
  // min ($0.15/sec = $11.25/ride at the current testnet market) makes
  // both wins and losses ~10× more visible. Still within the per-round
  // payout cap ($500), still safe for the vault.
  const stakePerSegmentMicroUsd = useMemo(() => {
    const max = picked?.max_stake_per_segment;
    const min = picked?.min_stake_per_segment;
    if (typeof max === "number" && max > 0) return BigInt(max);
    if (typeof min === "number" && min > 0) return BigInt(min) * 10n;
    return undefined; // hook falls back to market snapshot's min
  }, [picked]);

  const ride = useSegmentRideV4({
    market: picked,
    keypair: session.keypair,
    client: session.client,
    onBalanceChanged: session.refreshBalance,
    stakePerSegmentMicroUsd,
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

  // v4.23 — capture the PnL at the moment of release so the hero can
  // flash it briefly (user feedback: "as soon as I stop holding and let
  // go it should ... say what my PNL was. and then it should go right
  // back to saying tap and hold"). The flash auto-clears after 2.5s.
  const [lastClosedPnl, setLastClosedPnl] = useState<number | null>(null);
  const lastPhaseRef = useRef<RidePhase>(ride.phase);
  const livePnlRef = useRef(0);
  useEffect(() => {
    livePnlRef.current = ridePnl.pnl;
  }, [ridePnl.pnl]);
  useEffect(() => {
    const prev = lastPhaseRef.current;
    const next = ride.phase;
    if ((prev === "riding" || prev === "opening" || prev === "closing") && next === "idle") {
      setLastClosedPnl(livePnlRef.current);
      const id = window.setTimeout(() => setLastClosedPnl(null), 2500);
      lastPhaseRef.current = next;
      return () => window.clearTimeout(id);
    }
    lastPhaseRef.current = next;
  }, [ride.phase]);

  // v4.25a — collateral-aware funding gate. The user needs BOTH:
  //   - SUI for gas (~MIN_RIDE_BALANCE_MIST)
  //   - the market's collateral coin for escrow (~stake × round × 1.1)
  // Compute the escrow threshold from the picked market so it stays in
  // sync if the bootstrap params change (no more hardcoded magic numbers).
  const escrowThresholdRaw = useMemo(
    () => {
      // v4.31b — gate uses MAX stake to match the actual ride escrow.
      // useSegmentRideV4 is wired (v4.30) to use max_stake_per_segment
      // as the per-second stake, so escrow per ride is
      // max_stake × round_duration × 1.1. If the gate uses MIN stake
      // (the old behavior), the wallet looks "ready" at the gate but
      // the actual open_segment_ride_v4 tx aborts for insufficient
      // collateral. User report 2026-05-26:
      // > "I tried to play ... it said I didn't have enough, click
      // >  here. But then I can't actually click any button."
      // The gate said ready ($0.825 threshold against $4 TUSD), the
      // tx demanded $12.375, the error toast told them to drip more —
      // but the FundCta with the drip button stays hidden when the
      // gate thinks funds are OK. Bumping the threshold to match the
      // ride's actual escrow surfaces the FundCta when it should.
      //
      // Falls back to min_stake_per_segment when max is unknown.
      const stakePerSeg = BigInt(
        picked.max_stake_per_segment
          ?? picked.min_stake_per_segment
          ?? 10_000,
      );
      const roundDuration = BigInt(picked.round_duration_segments ?? 75);
      return (stakePerSeg * roundDuration * 11n) / 10n;
    },
    [picked.max_stake_per_segment, picked.min_stake_per_segment, picked.round_duration_segments],
  );
  const isSuiCollateral = picked.collateral === "0x2::sui::SUI";
  // Format collateral balance. TUSD is 6 decimals; SUI is 9. We don't
  // know decimals for arbitrary coins so default to 6 for non-SUI (TUSD
  // is the only non-SUI we ship right now).
  const collateralLabel = isSuiCollateral ? "SUI" : "TUSD";
  const collateralDecimals = isSuiCollateral ? 9 : 6;
  const fmtCollateral = (raw: bigint | null): string => {
    if (raw === null) return "…";
    return (Number(raw) / 10 ** collateralDecimals).toFixed(
      collateralDecimals === 6 ? 2 : 3,
    );
  };
  const needsSui =
    session.balanceMist !== null &&
    session.balanceMist < MIN_RIDE_BALANCE_MIST;
  const needsCollateral =
    !isSuiCollateral &&
    session.collateralBalance !== null &&
    session.collateralBalance < escrowThresholdRaw;
  const needsFunds = needsSui || needsCollateral;
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
          rugFiredAtMs={ride.rugFiredAtMs}
          marketId={picked.market}
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
              {isSuiCollateral ? (
                <>{fmtSui(session.balanceMist)} SUI</>
              ) : (
                <>
                  {fmtCollateral(session.collateralBalance)}{" "}
                  <span className="text-white/55">{collateralLabel}</span>
                  <span className="text-white/35 text-[10px] ml-1.5">
                    · {fmtSui(session.balanceMist)} SUI
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        {/*
         * V4 declutter: the top-bar RoundCountdown + the right-rail
         * BarrierFlowV4 panel were both dropped (user 2026-05-24:
         * "Just fucking delete that thing its not useful"). Round
         * countdown and barrier prices show in-canvas via drawBarriers
         * so they don't compete with the chart for real estate.
         */}

        <div className="pointer-events-auto flex items-center gap-2">
          {/* v4.31g — Dynamic Sign-in button. Renders nothing unless
              VITE_DYNAMIC_ENVIRONMENT_ID is configured (see
              DynamicProvider.tsx). When wired up, this is the
              entry point for social-login auth. */}
          <DynamicConnectButton />
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
          isReady={ride.round !== null}
          lastClosedPnl={lastClosedPnl}
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
                : settlementToast.kind === 3 &&
                    settlementToast.settlementSubKind === "rugged"
                  ? "1.5% per-second roll fired · house edge ~3.9%"
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
          {/* v4.31d — chain-attested net amount + stake/paid breakdown.
              User report 2026-05-26: "my balance isnt changing
              accurately to the trades and the pnl I am getting." Live
              PnL preview is client-computed; settlement toast only
              showed the kind ("TOUCH WIN"); balance pill lags ~5s.
              Three views, nothing to reconcile against. Surfacing the
              real chain numbers from RideClosedV4 closes the loop. */}
          {settlementToast.stakePaidRaw !== undefined &&
            settlementToast.payoutRaw !== undefined && (() => {
              const netRaw = settlementToast.payoutRaw - settlementToast.stakePaidRaw;
              const netUsd = Number(netRaw) / 1_000_000;
              const sign = netRaw > 0n ? "+" : netRaw < 0n ? "−" : "";
              const tone = netRaw > 0n
                ? "text-emerald-300"
                : netRaw < 0n
                  ? "text-rose-300"
                  : "text-white/60";
              return (
                <>
                  <div className={`mt-3 text-2xl font-mono tabular-nums ${tone}`}>
                    {sign}${Math.abs(netUsd).toFixed(2)} TUSD
                  </div>
                  <div className="mt-1 text-[11px] text-white/40 font-mono tabular-nums">
                    stake ${(Number(settlementToast.stakePaidRaw) / 1_000_000).toFixed(2)}
                    {" → "}
                    paid ${(Number(settlementToast.payoutRaw) / 1_000_000).toFixed(2)}
                  </div>
                </>
              );
            })()}
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

      {/* ── Error toast ─────────────────────────────────────────────────
          v4.19 audit P0-5 + P1-10: was rendered ONLY when
          phase === "idle" + as a tiny 11px line floating at the
          bottom of a busy chart — easily missed, and suppressed exactly
          when most needed (the orphan-ride sweep sets phase=riding
          AND lastError simultaneously, so the user could never see the
          "you had a ride open" message that was supposed to surface).
          Now: rendered in all phases, with a real background and a
          dismiss button. */}
      {ride.lastError && (
        <div
          className="fixed left-1/2 -translate-x-1/2 z-[1650] pointer-events-auto"
          style={{ bottom: `calc(env(safe-area-inset-bottom) + 18px)` }}
        >
          <div className="glass-container px-4 py-2 rounded-lg flex items-center gap-3 max-w-[460px]">
            <div className="glass-filter" />
            <div className="glass-overlay" />
            <div className="glass-specular" />
            <div className="relative z-10 flex items-center gap-3">
              <div className="font-mono text-[12px] text-rose-300 leading-snug">
                {ride.lastError}
              </div>
              {/* v4.31b — if the failure looks fund-related, surface an
                  inline faucet button. Previously the error text said
                  "tap Get test SUI" but the button only lived inside
                  the FundCta (full-screen onboard), which is hidden
                  whenever the funding GATE thinks balances are OK —
                  and the gate's threshold was lower than the actual
                  per-ride escrow, so users saw the error without any
                  clickable funding action. */}
              {/funds|insufficient|gas|balance|TUSD|drip/i.test(ride.lastError) ? (
                <FaucetButton
                  recipient={session.address}
                  onFunded={() => {
                    session.refreshBalance();
                    // v4.31c — clear the stale error so the user knows
                    // the drip landed. Without this the toast keeps
                    // saying "Not enough" forever and the user thinks
                    // the Drip button "did nothing".
                    ride.clearLastError?.();
                  }}
                  size="sm"
                  label="Drip"
                />
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* ── Live MARKET HALT feed (v4.26 — visible to spectators) ─────── */}
      <RugFeed
        marketId={picked.market}
        packageId={TESTNET_DEPLOYMENT.package_id}
        client={session.client}
      />

      {/* ── v4.31 — per-round drift regime badge ─────────────────────── */}
      <RegimeBadge
        marketId={picked.market}
        roundIndex={ride.round?.index ?? null}
      />

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
    <div className="fixed inset-0 bg-[#0c0c0c] text-foreground flex flex-col items-center justify-center p-6 text-center">
      <div className="text-2xl font-semibold mb-2">Wick is between rounds</div>
      <p className="text-sm text-white/60 max-w-md mb-5">
        We're rebooting the market — back in a minute. Refresh to retry.
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="px-5 py-2 rounded-md bg-white text-zinc-950 text-sm font-semibold"
      >
        Refresh
      </button>
    </div>
  );
}

export default Ride;
