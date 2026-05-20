/**
 * /ride — the demo surface. A fullscreen candle chart with a press-and-hold
 * gesture that opens / closes real on-chain Wick rides on Sui testnet.
 *
 * Lifecycle:
 *   page mount → poll oracle for live spot (every 1.5s, throttled)
 *   user presses → useWickRide opens an on-chain ride
 *   user holds → useWickRide polls RidePosition every 500ms for live PnL
 *   user releases → close_ride lands → settlement banner appears
 *
 * Wallet flow: the canvas renders immediately. If no wallet is connected
 * when the user presses, we surface a toast + show a connect button —
 * we never block the chart behind a modal.
 *
 * Market: the latest WICK-RNG-1000 in `deployments/testnet.json` (the one
 * with `ride_caps_sui` provisioned).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ConnectButton, useSuiClient } from "@mysten/dapp-kit";
import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import RideChart from "@/components/RideChart";
import { useWickRide } from "@/hooks/useWickRide";
import { TESTNET_DEPLOYMENT, type ArcadeMarketRecord } from "@/lib/deployments";

const PRICE_SCALING = 1_000_000_000;

/**
 * Pick the latest arcade market that has `ride_caps` provisioned. The newest
 * such record (last in the array) is what the publish script seeds.
 */
function pickRideEnabledMarket(): {
  market: ArcadeMarketRecord;
  capsId: string;
} | null {
  const markets = TESTNET_DEPLOYMENT.arcade_markets ?? [];
  // Look for the one matching the global `ride_caps_sui` cap.
  const globalCaps = (
    TESTNET_DEPLOYMENT as unknown as { ride_caps_sui?: string }
  ).ride_caps_sui;
  if (!globalCaps) return null;
  // Walk in reverse — newest first.
  for (let i = markets.length - 1; i >= 0; i--) {
    const m = markets[i] as ArcadeMarketRecord & { ride_caps?: string };
    if (m.ride_caps === globalCaps) {
      return { market: m, capsId: globalCaps };
    }
  }
  // Fallback: any market that has its own ride_caps
  for (let i = markets.length - 1; i >= 0; i--) {
    const m = markets[i] as ArcadeMarketRecord & { ride_caps?: string };
    if (m.ride_caps) {
      return { market: m, capsId: m.ride_caps };
    }
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
          | { fields?: { vec?: Array<{ fields?: { price?: string; timestamp_ms?: string } }> } }
          | undefined;
        // `Option<PriceObservation>` is encoded as `{ vec: [obs?] }` in
        // dApp Kit's content shape. Empty array = none.
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

export function Ride() {
  const picked = useMemo(() => pickRideEnabledMarket(), []);
  const oracle = useLiveOraclePrice(picked?.market.oracle);
  const ride = useWickRide(
    picked
      ? { market: picked.market, capsId: picked.capsId }
      : // Fallback shape — useWickRide will refuse to open if capsId is empty.
        {
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
        },
  );

  const callbacksRef = useRef({ onPress: ride.open, onRelease: ride.close });
  useEffect(() => {
    callbacksRef.current.onPress = ride.open;
    callbacksRef.current.onRelease = ride.close;
  }, [ride.open, ride.close]);
  // Stable callback object that always calls the latest open/close.
  const stableCallbacks = useMemo(
    () => ({
      onPress: () => callbacksRef.current.onPress(),
      onRelease: () => callbacksRef.current.onRelease(),
    }),
    [],
  );

  if (!picked) {
    return (
      <div className="fixed inset-0 bg-background text-foreground flex flex-col items-center justify-center font-mono p-6 text-center">
        <h1 className="text-2xl font-semibold mb-2">No ride market provisioned</h1>
        <p className="text-sm text-muted-foreground max-w-md">
          deployments/testnet.json does not have a market with{" "}
          <code className="text-foreground">ride_caps</code> set. Run the bootstrap
          script to seed a RideMarketCaps for an arcade market.
        </p>
      </div>
    );
  }

  // Display values — barrier comes in oracle-scaled units (1e9), same as price.
  const barrierDisplay = picked.market.barrier / PRICE_SCALING;
  const spotDisplay = oracle?.price;

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#0c0c0c] text-foreground">
      <RideChart
        callbacks={stableCallbacks}
        isHolding={ride.isHolding}
        pnl={ride.pnl}
        liveSpot={spotDisplay}
        barrier={barrierDisplay}
        barrierDirection={picked.market.direction === 1 ? 1 : 0}
        disabled={ride.isPending && !ride.isHolding}
      />

      {/* Header — sits above the canvas, doesn't block touch */}
      <div className="absolute top-0 right-0 z-[1600] p-3 pointer-events-none">
        <div className="flex items-start gap-2 pointer-events-auto">
          {!ride.hasAccount && (
            <ConnectButton connectText="Connect" />
          )}
        </div>
      </div>

      {/* Market label — bottom-left over the canvas */}
      <div
        className="absolute z-[1500] pointer-events-none"
        style={{
          left: 19,
          bottom: `calc(env(safe-area-inset-bottom) + 16px)`,
        }}
      >
        <div className="font-mono text-[10px] uppercase tracking-[0.15em] text-white/50">
          {picked.market.name}
        </div>
        <div className="font-mono text-[11px] text-white/70 mt-0.5">
          barrier{" "}
          <span className="text-white">
            ${barrierDisplay < 100 ? barrierDisplay.toFixed(2) : barrierDisplay.toFixed(0)}
          </span>
          {" · "}
          {picked.market.direction === 0 ? "touch from below" : "touch from above"}
        </div>
        {spotDisplay !== undefined && (
          <div className="font-mono text-[11px] text-white/50 mt-0.5">
            spot{" "}
            <span className="text-white/80">
              ${spotDisplay < 100 ? spotDisplay.toFixed(2) : spotDisplay.toFixed(0)}
            </span>
          </div>
        )}
      </div>

      {/* Settlement banner — top-center over the canvas */}
      {ride.lastSettlement && (
        <div
          className="absolute z-[1600] left-1/2 -translate-x-1/2 pointer-events-none"
          style={{ top: `calc(env(safe-area-inset-top) + 12px)` }}
        >
          <div
            className={`glass-container pointer-events-auto px-4 py-2 font-mono text-xs rounded-md ${
              ride.lastSettlement.kind === 1
                ? "text-[color:var(--color-touch)]"
                : ride.lastSettlement.kind === 2
                  ? "text-foreground"
                  : "text-[color:var(--color-warning)]"
            }`}
            style={{
              background:
                ride.lastSettlement.kind === 1
                  ? "rgba(0, 255, 136, 0.12)"
                  : "rgba(255, 255, 255, 0.08)",
            }}
          >
            <div className="glass-filter" />
            <div className="glass-overlay" />
            <div className="glass-specular" />
            <div className="glass-content !justify-start gap-3 relative z-10">
              <span className="uppercase tracking-wider">
                {ride.lastSettlement.label.replace(/_/g, " ")}
              </span>
              <a
                href={`https://suiscan.xyz/testnet/tx/${ride.lastSettlement.digest}`}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:opacity-80 text-white/70"
                onClick={(e) => e.stopPropagation()}
              >
                view tx
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Tap-to-ride hint when idle and connected */}
      {ride.hasAccount && !ride.isHolding && !ride.lastSettlement && (
        <div
          className="absolute z-[1400] left-1/2 -translate-x-1/2 bottom-[35%] pointer-events-none"
          style={{ animation: "rideHint 2.4s ease-in-out infinite" }}
        >
          <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-white/40">
            press &amp; hold to ride
          </div>
        </div>
      )}

      <style>{`
        @keyframes rideHint {
          0%, 100% { opacity: 0.55; transform: translate(-50%, 0); }
          50%      { opacity: 1;    transform: translate(-50%, -4px); }
        }
      `}</style>
    </div>
  );
}

export default Ride;
