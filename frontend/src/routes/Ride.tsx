/**
 * /ride — round-based segment-arcade (doc 19), friction-free hold-to-ride.
 *
 * Interaction model:
 *   1. Each 30-second round materialises TWO shared barriers (upper / lower).
 *   2. The first ~5.2 s of each round is the OPEN WINDOW — pick a barrier
 *      (tap the upper or lower half of the chart) and press-and-hold to
 *      open a ride against it.
 *   3. While riding, the price wicks toward your barrier; release to cash
 *      out, or hold to round end (TOUCH_WIN if it touches, else
 *      EXPIRED_LOSS unless you cashed out).
 *
 * Architecture (doc 17 §15.1, doc 19 §17.5):
 *   - `useSegmentRide` owns the on-chain lifecycle, subscribes to round +
 *     segment events, and decides phase transitions optimistically.
 *   - `useRideGesture` renders the chart by replaying segment keys through
 *     `seededPath.expandSegment` — the chart is the genuinely on-chain
 *     price, not a Math.random walk.
 *   - The burner wallet (`useSessionWallet`) signs locally so the gesture
 *     hold is never interrupted by a wallet popup.
 *
 * The screen shows:
 *   - top-left  : burner balance
 *   - top-mid   : RoundCountdown (round # + open-window + round timer)
 *   - top-right : faucet button (when low) or a quiet "ready" tick
 *   - center    : the state hero — exactly what's happening, always
 *   - the chart : the full-screen barrier-picker + hold target
 */
import { useEffect, useMemo, useState } from "react";
import RideChart from "@/components/RideChart";
import { FaucetButton } from "@/components/wallet/FaucetButton";
import { RoundCountdown } from "@/components/RoundCountdown";
import { BarrierOrderbookGrid } from "@/components/BarrierOrderbookGrid";
import { useSegmentRide } from "@/hooks/useSegmentRide";
import type { RidePhase } from "@/hooks/useRideGesture";
import { useSessionWallet } from "@/hooks/useSessionWallet";
import {
  TESTNET_DEPLOYMENT,
  type SegmentMarketRecord,
} from "@/lib/deployments";
import { BARRIER_UPPER, type BarrierIndex } from "@wick/sdk";

/** Need ~0.05 SUI to ride one round (escrow + gas). Below this → faucet. */
const MIN_RIDE_BALANCE_MIST = 50_000_000n;

/** Pick a segment market from the deployment — first one wins. */
function pickSegmentMarket(): SegmentMarketRecord | null {
  const markets = TESTNET_DEPLOYMENT.segment_markets ?? [];
  if (markets.length === 0) return null;
  return markets[0] ?? null;
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

/** Center hero — the single source of truth for "what's happening now". */
function CenterHero(props: {
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

export function Ride() {
  const picked = useMemo(() => pickSegmentMarket(), []);
  const session = useSessionWallet();

  // A zeroed fallback so we can call useSegmentRide unconditionally
  // (React rule of hooks) when no segment market is provisioned.
  const fallbackMarket: SegmentMarketRecord = {
    name: "(none)",
    market: "",
    collateral: "0x2::sui::SUI",
    vault: TESTNET_DEPLOYMENT.vault_sui ?? "",
    home_price: 1_000_000_000,
  };

  const ride = useSegmentRide({
    market: picked ?? fallbackMarket,
    keypair: session.keypair,
    client: session.client,
    onBalanceChanged: session.refreshBalance,
  });

  // The gesture's onOpen → useSegmentRide.open. Also updates the picked
  // barrier so the chart hook can render the picked-zone highlight.
  const stableCallbacks = useMemo(
    () => ({
      onOpen: (barrierIndex: BarrierIndex, barrierPrice: number) => {
        ride.pickBarrier(barrierIndex);
        ride.open(barrierIndex, barrierPrice);
      },
      onClose: () => ride.close(),
      onStall: () => ride.triggerStallCrank(),
    }),
    // ride is rebuilt every render; keep callbacks stable across renders
    // by wrapping each in a ref. (The callback is invoked from inside a
    // closed-over p5 sketch — we must not recreate the closure each render.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  // Update the ref every render so the closure sees the latest callbacks.
  // The actual closure inside the gesture hook reads through callbacksRef
  // (set by an effect in useRideGesture), so React's "stale closure"
  // concern doesn't apply here — the gesture hook re-pipes callbacks.
  // We still memoize the outer object so useRideGesture doesn't re-set its
  // ref on every render.
  // (No-op block above is intentional — keeps the lint comment + intent.)

  const settlementToast = useAutoDismissSettlement(ride.lastSettlement);

  // Live PnL — computed inside the gesture hook from the candle stream,
  // surfaced here for the center hero.
  const [ridePnl, setRidePnl] = useState<{ pnl: number; staked: number }>({
    pnl: 0,
    staked: 0,
  });

  if (!picked) {
    return (
      <div className="fixed inset-0 bg-[#0c0c0c] text-foreground flex flex-col items-center justify-center font-mono p-6 text-center">
        <h1 className="text-2xl font-semibold mb-2">
          No segment-arcade market provisioned
        </h1>
        <p className="text-sm text-muted-foreground max-w-md">
          The round-based shared-grid arcade (doc 19) needs a bootstrapped{" "}
          <code className="text-foreground">SegmentMarket&lt;SUI&gt;</code>.
          Add one to{" "}
          <code className="text-foreground">deployments/testnet.json</code>
          {" "}under the{" "}
          <code className="text-foreground">segment_markets</code> key (
          name, market, collateral, vault, home_price) and reload.
        </p>
      </div>
    );
  }

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
      {/* ── The chart — full-screen barrier-picker + hold target ─────────── */}
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

      {/* ── Top bar — balance · round countdown · faucet ─────────────────── */}
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

        {/* Round indicator — center, always visible */}
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

      {/* ── Right edge: barrier orderbook (doc 19 §14) ───────────────────── */}
      <div className="fixed right-3 z-[1550] pointer-events-none" style={{ top: `calc(env(safe-area-inset-top) + 80px)` }}>
        <BarrierOrderbookGrid marketId={picked.market} client={session.client} />
      </div>

      {/* ── Center: fund CTA when broke, else the state hero ─────────────── */}
      {needsFunds && ride.phase === "idle" && !settlementToast ? (
        <FundCta
          balanceMist={session.balanceMist}
          address={session.address}
          onFunded={session.refreshBalance}
        />
      ) : !settlementToast ? (
        <CenterHero
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

      {/* ── Settlement result ───────────────────────────────────────────── */}
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

      {/* ── Error line ──────────────────────────────────────────────────── */}
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

export default Ride;
