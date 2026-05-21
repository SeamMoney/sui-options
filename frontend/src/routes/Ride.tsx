/**
 * /ride — hold-to-ride touch options, friction-free.
 *
 * Interaction: press and HOLD the candle. The ride opens, stake accrues,
 * the PnL ticks live. Release to cash out. It works because every
 * open/close is signed locally by an in-browser burner wallet (see
 * useSessionWallet) — there is no wallet popup to break the hold.
 *
 * Onboarding is one tap: the burner is auto-created on load; if it's empty
 * the top-right "Get test SUI" button drips 0.05 SUI from the faucet. Then
 * you hold the candle. No wallet install, no connect, no popups.
 *
 * The screen always shows:
 *   - top-left  : burner balance
 *   - top-right : faucet button (when low) or a quiet "ready" tick
 *   - center    : the state hero — exactly what's happening, always
 *   - the candle: the full-screen hold target
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useSuiClient } from "@mysten/dapp-kit";
import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import RideChart from "@/components/RideChart";
import { FaucetButton } from "@/components/wallet/FaucetButton";
import { useWickRide, type RidePhase } from "@/hooks/useWickRide";
import { useSessionWallet } from "@/hooks/useSessionWallet";
import { TESTNET_DEPLOYMENT, type ArcadeMarketRecord } from "@/lib/deployments";

// On-chain prices (oracle, barrier, starting_price) are denominated in
// micro-USD — 1_000_000 units == $1. The seed script confirms it:
// WICK-RNG-1000 starts at 1_000_000_000 ($1000), barrier 1_030_000_000 ($1030).
const PRICE_SCALING = 1_000_000;
/** Need ~0.03 SUI to ride (0.01 escrow + gas). Below this → faucet. */
const MIN_RIDE_BALANCE_MIST = 30_000_000n;
/**
 * Ride economics for the real-time PnL preview. These mirror the on-chain
 * RideMarketCaps (bootstrap-ride-caps.sh: multiplier 20000 bps) and the
 * useWickRide stake rate (200_000 μUSD/sec = $0.20/sec). The realized
 * payout is still decided on-chain at close — this only drives the live
 * number the rider watches while holding.
 */
const RIDE_MULTIPLIER_BPS = 20_000;
const RIDE_STAKE_RATE_USD_PER_SEC = 0.2;

function pickRideEnabledMarket(): {
  market: ArcadeMarketRecord;
  capsId: string;
} | null {
  const markets = TESTNET_DEPLOYMENT.arcade_markets ?? [];
  const globalCaps = (
    TESTNET_DEPLOYMENT as unknown as { ride_caps_sui?: string }
  ).ride_caps_sui;
  if (!globalCaps) return null;
  for (let i = markets.length - 1; i >= 0; i--) {
    const m = markets[i] as ArcadeMarketRecord & { ride_caps?: string };
    if (m.ride_caps === globalCaps) return { market: m, capsId: globalCaps };
  }
  for (let i = markets.length - 1; i >= 0; i--) {
    const m = markets[i] as ArcadeMarketRecord & { ride_caps?: string };
    if (m.ride_caps) return { market: m, capsId: m.ride_caps };
  }
  return null;
}

interface OracleSnapshot {
  price: number;
  timestampMs: number;
}

function useLiveOraclePrice(oracleId: string | undefined): OracleSnapshot | null {
  const sui = useSuiClient() as unknown as SuiJsonRpcClient;
  const [snap, setSnap] = useState<OracleSnapshot | null>(null);
  useEffect(() => {
    if (!oracleId) return;
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const obj = await sui.getObject({
          id: oracleId,
          options: { showContent: true },
        });
        if (cancelled) return;
        const c = obj.data?.content;
        if (!c || c.dataType !== "moveObject") return;
        const fields = (c as { fields: Record<string, unknown> }).fields;
        const latest = fields.latest as
          | {
              fields?: {
                vec?: Array<{
                  fields?: { price?: string; timestamp_ms?: string };
                }>;
              };
            }
          | undefined;
        const obs = latest?.fields?.vec?.[0]?.fields;
        if (!obs?.price) return;
        const price = Number(obs.price) / PRICE_SCALING;
        const tsMs = obs.timestamp_ms ? Number(obs.timestamp_ms) : Date.now();
        setSnap({ price, timestampMs: tsMs });
      } catch (err) {
        console.warn("[useLiveOraclePrice]", err);
      }
    };
    void fetchOnce();
    const id = window.setInterval(() => void fetchOnce(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [sui, oracleId]);
  return snap;
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
  multiplierX: number | null;
  barrierLabel: string;
  spotLabel: string;
}) {
  const {
    needsFunds,
    phase,
    pnl,
    stakePaid,
    multiplierX,
    barrierLabel,
    spotLabel,
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
    kicker = `Touch ${barrierLabel}${
      multiplierX ? ` · ${multiplierX.toFixed(1)}× payout` : ""
    }`;
    big = "Hold the chart to ride";
    sub = `spot ${spotLabel} — press and hold, release to cash out`;
  } else if (phase === "opening") {
    kicker = "Opening your ride";
    big = "Keep holding…";
    sub = "your position is going on-chain — ~1-2 seconds";
  } else if (phase === "riding") {
    kicker = "You're riding — release to cash out";
    big = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
    tone = pnl >= 0 ? "win" : "loss";
    sub = multiplierX
      ? `$${stakePaid.toFixed(2)} staked · ${multiplierX.toFixed(
          1,
        )}× if it touches`
      : `$${stakePaid.toFixed(2)} staked`;
  } else {
    // closing
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

export function Ride() {
  const picked = useMemo(() => pickRideEnabledMarket(), []);
  const oracle = useLiveOraclePrice(picked?.market.oracle);
  const session = useSessionWallet();

  const ride = useWickRide(
    picked
      ? {
          market: picked.market,
          capsId: picked.capsId,
          keypair: session.keypair,
          client: session.client,
          onBalanceChanged: session.refreshBalance,
        }
      : {
          market: {
            name: "(none)",
            market: "",
            oracle: "",
            path: "",
            random_walk: "",
            barrier: 0,
            direction: 0,
            expiry_ms: 0,
          },
          capsId: "",
          keypair: session.keypair,
          client: session.client,
          onBalanceChanged: session.refreshBalance,
        },
  );

  // True hold-to-ride. press → open, release → close. No popup ever
  // interrupts (the burner signs locally), so the finger stays down.
  const fnRef = useRef({ open: ride.open, close: ride.close });
  useEffect(() => {
    fnRef.current.open = ride.open;
    fnRef.current.close = ride.close;
  }, [ride.open, ride.close]);
  const stableCallbacks = useMemo(
    () => ({
      onPress: () => fnRef.current.open(),
      onRelease: () => fnRef.current.close(),
    }),
    [],
  );

  const settlementToast = useAutoDismissSettlement(ride.lastSettlement);

  // Live PnL — computed inside RideChart from the chart the rider is
  // actually watching (zero-latency), surfaced here for the center hero.
  const [ridePnl, setRidePnl] = useState<{ pnl: number; staked: number }>({
    pnl: 0,
    staked: 0,
  });

  if (!picked) {
    return (
      <div className="fixed inset-0 bg-[#0c0c0c] text-foreground flex flex-col items-center justify-center font-mono p-6 text-center">
        <h1 className="text-2xl font-semibold mb-2">No ride market live</h1>
        <p className="text-sm text-muted-foreground max-w-md">
          No arcade market with ride caps is provisioned. Re-run{" "}
          <code className="text-foreground">
            scripts/bootstrap-ride-caps.sh
          </code>
          .
        </p>
      </div>
    );
  }

  const barrierDisplay = picked.market.barrier / PRICE_SCALING;
  const barrierLabel = `${
    picked.market.direction === 1 ? "below" : "above"
  } $${barrierDisplay.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })}`;
  const spotLabel = oracle?.price
    ? `$${oracle.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
    : "—";

  const needsFunds =
    session.balanceMist !== null &&
    session.balanceMist < MIN_RIDE_BALANCE_MIST;

  const stakePaid = ridePnl.staked;
  const multiplierX = RIDE_MULTIPLIER_BPS / 10_000;

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#0c0c0c] text-foreground select-none">
      {/* ── The chart — full-screen hold target ─────────────────────────── */}
      <div className="absolute inset-0 mx-auto md:max-w-[800px]">
        <RideChart
          callbacks={stableCallbacks}
          isHolding={ride.phase === "riding"}
          liveSpot={oracle?.price}
          barrier={barrierDisplay}
          barrierDirection={picked.market.direction === 1 ? 1 : 0}
          multiplierBps={RIDE_MULTIPLIER_BPS}
          stakeRatePerSec={RIDE_STAKE_RATE_USD_PER_SEC}
          onPnlChange={setRidePnl}
        />
      </div>

      {/* ── Top bar — balance left, faucet right ────────────────────────── */}
      <div
        className="fixed left-0 right-0 z-[1600] flex items-start justify-between px-3 pointer-events-none"
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

        <div className="pointer-events-auto">
          {needsFunds ? (
            <FaucetButton
              recipient={session.address}
              onFunded={session.refreshBalance}
            />
          ) : session.balanceMist !== null ? (
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

      {/* ── Center hero ─────────────────────────────────────────────────── */}
      {!settlementToast && (
        <CenterHero
          needsFunds={needsFunds}
          phase={ride.phase}
          pnl={ridePnl.pnl}
          stakePaid={stakePaid}
          multiplierX={multiplierX}
          barrierLabel={barrierLabel}
          spotLabel={spotLabel}
        />
      )}

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
