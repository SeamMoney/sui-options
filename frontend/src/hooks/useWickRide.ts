/**
 * useWickRide — bridges press/release gestures to on-chain ride PTBs.
 *
 * Lifecycle:
 *   press → buildOpenRideTx → sign → extract RidePosition id from objectChanges
 *   while held → poll getRidePosition every 500ms → compute live PnL preview
 *   release → buildCloseRideTx → sign → parse settlement_kind for UI animation
 *
 * The wrapper (wickRide.ts) already does the heavy lifting: it computes
 * `stakePaid` client-side against Date.now() so we can render a smooth
 * "burn" curve without re-implementing the math.
 *
 * Live PnL approximation (what we report to useRideGesture for the chart
 * line color + the PnL overlay):
 *   pnl_micro_usd = (stakePaid * (multiplier_bps - 10000)) / 10000
 *                 — i.e. the multiplier marginal profit if we touched now.
 * Realized PnL is decided on-chain at close; the chart shows an honest
 * "potential touch payout vs. burn" gauge while held. After close, the UI
 * snaps to the on-chain settlement value.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import {
  buildCloseRideTx,
  buildOpenRideTx,
  getRidePosition,
  settlementLabel,
  type RidePositionState,
  type SuiClient,
} from "@/lib/wickRide";
import { TESTNET_DEPLOYMENT, type ArcadeMarketRecord } from "@/lib/deployments";
import { useToast } from "@/components/ui/toaster";

const POLL_INTERVAL_MS = 500;

export interface WickRideConfig {
  /** The arcade market we ride against. Pull from `pickArcadeMarket`. */
  market: ArcadeMarketRecord;
  /** Per-market `RideMarketCaps` id. Lives at `deployments/testnet.json#ride_caps_sui`. */
  capsId: string;
  /** MIST escrow to lock per ride. Default per spec: 10_000_000n (0.01 SUI). */
  escrowMist?: bigint;
  /** μUSD/sec stake-rate. Default per spec: 200_000n ($0.20/s). */
  stakeRateMicroUsdPerSec?: bigint;
}

export interface WickRideHandle {
  /** Call when the user presses the canvas. */
  open: () => void;
  /** Call when the user releases. */
  close: () => void;
  /** True while a ride is open or polling. */
  isHolding: boolean;
  /** Last polled state (null until first poll lands). */
  state: RidePositionState | null;
  /** Current live PnL preview in $ (positive = unrealized touch profit). */
  pnl: number;
  /** Result of the most recent close, for the UI to animate over. */
  lastSettlement: { kind: number; label: string; digest: string } | null;
  /** True while open/close txs are signing. */
  isPending: boolean;
  /** Has the user connected a wallet? */
  hasAccount: boolean;
  /** Last error (shown in a toast already, but useful for inline UI). */
  lastError: string | null;
}

const DEFAULT_ESCROW_MIST = 10_000_000n; // 0.01 SUI
const DEFAULT_STAKE_RATE = 200_000n; // $0.20/sec (200_000 μUSD/sec)

export function useWickRide(config: WickRideConfig): WickRideHandle {
  const account = useCurrentAccount();
  const sui = useSuiClient() as unknown as SuiJsonRpcClient & SuiClient;
  const { mutate: signAndExecute, isPending } = useSignAndExecuteTransaction();
  const toast = useToast();

  const escrowMist = config.escrowMist ?? DEFAULT_ESCROW_MIST;
  const stakeRateMicroUsdPerSec =
    config.stakeRateMicroUsdPerSec ?? DEFAULT_STAKE_RATE;

  const packageId = TESTNET_DEPLOYMENT.package_id;
  const vaultId = TESTNET_DEPLOYMENT.vault_sui;
  const botRegistryId = TESTNET_DEPLOYMENT.bot_registry;
  const priceOracleId = TESTNET_DEPLOYMENT.usd_price_oracle;
  const wickTokenStateId = TESTNET_DEPLOYMENT.wick_token_state;
  const wickStakingPoolId = TESTNET_DEPLOYMENT.wick_staking_pool;

  const [positionId, setPositionId] = useState<string | null>(null);
  const [state, setState] = useState<RidePositionState | null>(null);
  const [pnl, setPnl] = useState<number>(0);
  const [lastSettlement, setLastSettlement] = useState<
    { kind: number; label: string; digest: string } | null
  >(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [isHolding, setIsHolding] = useState<boolean>(false);

  // Guard against double-open from rapid taps on iOS.
  const openInFlightRef = useRef(false);

  // Poll the on-chain RidePosition while open.
  useEffect(() => {
    if (!positionId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await getRidePosition(sui, positionId);
        if (cancelled) return;
        setState(next);
        if (next) {
          // Live PnL preview: marginal touch profit vs. burn.
          // multiplier_bps == 10000 → break-even at touch. Above is profit.
          const stakePaidMicroUsd = Number(next.stakePaid);
          const multBps = next.multiplierBps;
          const marginal = (stakePaidMicroUsd * (multBps - 10000)) / 10000;
          // μUSD → $
          setPnl(marginal / 1_000_000);
        }
      } catch (err) {
        if (!cancelled) {
          // Polling errors are non-fatal — don't toast every 500ms.
          console.warn("[useWickRide] poll error:", err);
        }
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [positionId, sui]);

  const open = useCallback(() => {
    if (!account) {
      setLastError("Connect a Sui wallet to ride");
      toast.push({
        title: "Wallet not connected",
        description: "Connect a Sui wallet to open a ride.",
        tone: "error",
        ttlMs: 4000,
      });
      return;
    }
    if (openInFlightRef.current || positionId) return;
    if (!vaultId || !botRegistryId) {
      const msg = "Deployment is missing required ids (vault_sui / bot_registry).";
      setLastError(msg);
      toast.push({ title: "Cannot open ride", description: msg, tone: "error" });
      return;
    }
    openInFlightRef.current = true;
    setIsHolding(true);
    setLastSettlement(null);
    setLastError(null);
    let tx;
    try {
      tx = buildOpenRideTx(
        {
          marketId: config.market.market,
          capsId: config.capsId,
          vaultId,
          oracleId: config.market.oracle,
          pathId: config.market.path,
          escrowMist,
          stakeRateMicroUsdPerSec,
          botRegistryId,
        },
        packageId,
        { kind: "Split", from: "gas", amount: escrowMist },
      );
    } catch (err) {
      openInFlightRef.current = false;
      setIsHolding(false);
      const msg = (err as Error).message;
      setLastError(msg);
      toast.push({ title: "Failed to build open_ride", description: msg, tone: "error" });
      return;
    }
    signAndExecute(
      { transaction: tx },
      {
        onSuccess: (res) => {
          void sui
            .getTransactionBlock({
              digest: res.digest,
              options: { showObjectChanges: true, showEffects: true },
            })
            .then((tx) => {
              openInFlightRef.current = false;
              const created = tx.objectChanges?.find(
                (c) =>
                  c.type === "created" &&
                  "objectType" in c &&
                  c.objectType.includes("::ride_position::RidePosition"),
              );
              if (created && "objectId" in created) {
                setPositionId(created.objectId);
              } else {
                setIsHolding(false);
                setLastError("RidePosition not found in tx response");
                toast.push({
                  title: "Open succeeded but RidePosition not found",
                  description: "Check the tx in explorer.",
                  tone: "error",
                });
              }
            })
            .catch((err) => {
              openInFlightRef.current = false;
              setIsHolding(false);
              const msg = (err as Error).message;
              setLastError(msg);
              toast.push({
                title: "Failed to fetch open_ride tx",
                description: msg,
                tone: "error",
              });
            });
        },
        onError: (err) => {
          openInFlightRef.current = false;
          setIsHolding(false);
          const msg = err.message;
          setLastError(msg);
          toast.push({
            title: "open_ride failed",
            description: msg,
            tone: "error",
            ttlMs: 6000,
          });
        },
      },
    );
  }, [
    account,
    positionId,
    vaultId,
    botRegistryId,
    config.capsId,
    config.market.market,
    config.market.oracle,
    config.market.path,
    escrowMist,
    stakeRateMicroUsdPerSec,
    packageId,
    signAndExecute,
    sui,
    toast,
  ]);

  const close = useCallback(() => {
    if (!positionId) {
      // Press-release before open landed — ignore.
      setIsHolding(false);
      return;
    }
    if (
      !vaultId ||
      !priceOracleId ||
      !wickTokenStateId ||
      !wickStakingPoolId
    ) {
      const msg = "Deployment is missing required ids for close_ride.";
      setLastError(msg);
      toast.push({ title: "Cannot close ride", description: msg, tone: "error" });
      return;
    }
    let tx;
    try {
      tx = buildCloseRideTx(
        {
          marketId: config.market.market,
          capsId: config.capsId,
          vaultId,
          oracleId: config.market.oracle,
          pathId: config.market.path,
          positionId,
          priceOracleId,
          wickTokenStateId,
          wickStakingPoolId,
        },
        packageId,
      );
    } catch (err) {
      const msg = (err as Error).message;
      setLastError(msg);
      toast.push({ title: "Failed to build close_ride", description: msg, tone: "error" });
      return;
    }
    signAndExecute(
      { transaction: tx },
      {
        onSuccess: (res) => {
          // Fetch the tx for events so we can decode settlement_kind.
          void sui
            .getTransactionBlock({
              digest: res.digest,
              options: { showEvents: true },
            })
            .then((txResp) => {
              const ev = txResp.events?.find((e) =>
                e.type.includes("::ride_position::RideClosed"),
              );
              let kind = -1;
              if (ev && ev.parsedJson && typeof ev.parsedJson === "object") {
                const fields = ev.parsedJson as { settlement_kind?: number | string };
                if (fields.settlement_kind !== undefined) {
                  kind = Number(fields.settlement_kind);
                }
              }
              if (kind < 0) {
                // Fall back to the on-chain state — re-fetch once.
                void getRidePosition(sui, positionId).then((s) => {
                  if (s) {
                    setLastSettlement({
                      kind: s.settlementKind,
                      label: settlementLabel(s.settlementKind),
                      digest: res.digest,
                    });
                  }
                });
              } else {
                setLastSettlement({
                  kind,
                  label: settlementLabel(kind),
                  digest: res.digest,
                });
                toast.push({
                  title: `Settled: ${settlementLabel(kind)}`,
                  description: `Tap to view on explorer`,
                  href: `https://suiscan.xyz/testnet/tx/${res.digest}`,
                  hrefLabel: "view tx",
                  tone: kind === 1 ? "success" : "info",
                  ttlMs: 8000,
                });
              }
              setPositionId(null);
              setState(null);
              setPnl(0);
              setIsHolding(false);
            })
            .catch((err) => {
              setPositionId(null);
              setState(null);
              setPnl(0);
              setIsHolding(false);
              console.warn("[useWickRide] close tx fetch:", err);
            });
        },
        onError: (err) => {
          const msg = err.message;
          setLastError(msg);
          toast.push({
            title: "close_ride failed",
            description: msg,
            tone: "error",
            ttlMs: 6000,
          });
          // Don't clear positionId — let user retry.
        },
      },
    );
  }, [
    positionId,
    vaultId,
    priceOracleId,
    wickTokenStateId,
    wickStakingPoolId,
    config.capsId,
    config.market.market,
    config.market.oracle,
    config.market.path,
    packageId,
    signAndExecute,
    sui,
    toast,
  ]);

  return {
    open,
    close,
    isHolding,
    state,
    pnl,
    lastSettlement,
    isPending,
    hasAccount: !!account,
    lastError,
  };
}
