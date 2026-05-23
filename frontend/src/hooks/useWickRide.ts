/**
 * useWickRide — hold-to-ride, signed by the in-browser burner wallet.
 *
 * Every open_ride / close_ride is signed LOCALLY with the session keypair
 * (see useSessionWallet) and submitted straight through the SuiClient — no
 * wallet popup, no focus steal. That is the whole point: it lets the
 * press-and-hold gesture work, because nothing interrupts the hold.
 *
 * Lifecycle:
 *   press   → open_ride  (instant submit, ~1-2s on-chain confirm)
 *   hold    → poll getRidePosition every 500ms → live PnL preview
 *   release → close_ride (instant submit) → parse settlement_kind
 *
 * Because we sign directly we pass `options: { showObjectChanges, showEvents }`
 * and get the position id + settlement event back INLINE — no getTransaction
 * RPC race.
 *
 * Live PnL preview (drives the chart line + the hero number):
 *   pnl_$ = stakePaid_microUSD * (multiplier_bps - 10000) / 10000 / 1e6
 * i.e. the marginal touch profit if it touched right now. Realized PnL is
 * decided on-chain at close; the UI snaps to it after settlement.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  buildCloseRideTx,
  buildOpenRideTx,
  getRidePosition,
  settlementLabel,
  type RidePositionState,
  type SuiClient,
} from "@/lib/wickRide";
import { TESTNET_DEPLOYMENT, type ArcadeMarketRecord } from "@/lib/deployments";

const POLL_INTERVAL_MS = 500;
const DEFAULT_ESCROW_MIST = 10_000_000n; // 0.01 SUI
const DEFAULT_STAKE_RATE = 200_000n; // $0.20/sec (200_000 μUSD/sec)

export type RidePhase = "idle" | "opening" | "riding" | "closing";

export interface WickRideConfig {
  market: ArcadeMarketRecord;
  capsId: string;
  /** Burner keypair from useSessionWallet — signs every ride tx locally. */
  keypair: Ed25519Keypair;
  /** Standalone SuiClient (the burner's, from useSessionWallet). */
  client: SuiClient;
  escrowMist?: bigint;
  stakeRateMicroUsdPerSec?: bigint;
  /** Called after a settle/close so the caller can refresh the burner balance. */
  onBalanceChanged?: () => void;
}

export interface WickRideHandle {
  /** Press handler — opens a ride. Safe to call repeatedly (deduped). */
  open: () => void;
  /** Release handler — cashes out. Safe to call repeatedly (deduped). */
  close: () => void;
  /** One of idle | opening | riding | closing. */
  phase: RidePhase;
  /** Last polled on-chain position (null until first poll lands). */
  state: RidePositionState | null;
  /** Live PnL preview in $ (positive = unrealized touch profit). */
  pnl: number;
  /** Result of the most recent close. */
  lastSettlement: { kind: number; label: string; digest: string } | null;
  /** Human-readable last error, or null. */
  lastError: string | null;
}

interface CreatedObjectChange {
  type: string;
  objectType?: string;
  objectId?: string;
}

interface RideEvent {
  type?: string;
  parsedJson?: unknown;
}

export function useWickRide(config: WickRideConfig): WickRideHandle {
  const { keypair, client } = config;
  const escrowMist = config.escrowMist ?? DEFAULT_ESCROW_MIST;
  const stakeRateMicroUsdPerSec =
    config.stakeRateMicroUsdPerSec ?? DEFAULT_STAKE_RATE;

  // The deployment artifact always carries these once the singletons are
  // bootstrapped; the `?? ""` keeps TS happy (the optional artifact type)
  // and the build functions / Move calls fail loudly if one is ever blank.
  const packageId = TESTNET_DEPLOYMENT.package_id ?? "";
  const vaultId = TESTNET_DEPLOYMENT.vault_sui ?? "";
  const botRegistryId = TESTNET_DEPLOYMENT.bot_registry ?? "";
  const priceOracleId = TESTNET_DEPLOYMENT.usd_price_oracle ?? "";
  const wickTokenStateId = TESTNET_DEPLOYMENT.wick_token_state ?? "";
  const wickStakingPoolId = TESTNET_DEPLOYMENT.wick_staking_pool ?? "";

  const [phase, setPhase] = useState<RidePhase>("idle");
  const [positionId, setPositionId] = useState<string | null>(null);
  const [state, setState] = useState<RidePositionState | null>(null);
  const [pnl, setPnl] = useState<number>(0);
  const [lastSettlement, setLastSettlement] = useState<
    { kind: number; label: string; digest: string } | null
  >(null);
  const [lastError, setLastError] = useState<string | null>(null);

  // Single-flight guards — the gesture layer can fire press/release twice
  // on iOS hybrids; never let that double-submit.
  const busyRef = useRef(false);
  // If the user releases before the open tx confirms, queue the close.
  const closeQueuedRef = useRef(false);
  const onBalanceChanged = config.onBalanceChanged;

  // ── Poll the on-chain RidePosition while a ride is open ────────────────
  useEffect(() => {
    if (!positionId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await getRidePosition(client, positionId);
        if (cancelled) return;
        setState(next);
        if (next) {
          const stakePaidMicroUsd = Number(next.stakePaid);
          const marginal =
            (stakePaidMicroUsd * (next.multiplierBps - 10000)) / 10000;
          setPnl(marginal / 1_000_000);
        }
      } catch (err) {
        if (!cancelled) console.warn("[useWickRide] poll:", err);
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [positionId, client]);

  // ── close (declared first so open's queued-close can call it) ─────────
  const closeRef = useRef<() => void>(() => {});

  const open = useCallback(() => {
    if (busyRef.current || positionId) return;
    busyRef.current = true;
    closeQueuedRef.current = false;
    setLastError(null);
    setLastSettlement(null);
    setPhase("opening");

    void (async () => {
      try {
        const tx = buildOpenRideTx(
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
        const res = await client.signAndExecuteTransaction({
          signer: keypair,
          transaction: tx,
          options: { showObjectChanges: true, showEffects: true },
        });
        const created = (res.objectChanges as CreatedObjectChange[] | undefined)
          ?.find(
            (c) =>
              c.type === "created" &&
              typeof c.objectType === "string" &&
              c.objectType.includes("::ride_position::RidePosition"),
          );
        if (!created?.objectId) {
          throw new Error("RidePosition not found in tx result");
        }
        setPositionId(created.objectId);
        setPhase("riding");
        onBalanceChanged?.();
        busyRef.current = false;
        // If the user already let go, close immediately.
        if (closeQueuedRef.current) {
          closeQueuedRef.current = false;
          closeRef.current();
        }
      } catch (err) {
        busyRef.current = false;
        closeQueuedRef.current = false;
        setPhase("idle");
        const msg = (err as Error).message ?? "open failed";
        setLastError(
          /insufficient|gas|balance|InsufficientGas/i.test(msg)
            ? "Not enough test SUI — tap Get test SUI."
            : msg,
        );
        console.warn("[useWickRide] open:", err);
      }
    })();
  }, [
    positionId,
    config.market.market,
    config.market.oracle,
    config.market.path,
    config.capsId,
    vaultId,
    botRegistryId,
    escrowMist,
    stakeRateMicroUsdPerSec,
    packageId,
    keypair,
    client,
    onBalanceChanged,
  ]);

  const close = useCallback(() => {
    // Released before the open tx confirmed — queue it; open's success
    // handler will fire close once the position exists.
    if (phase === "opening" && !positionId) {
      closeQueuedRef.current = true;
      return;
    }
    if (!positionId) return;
    if (busyRef.current) return;
    busyRef.current = true;
    setPhase("closing");

    void (async () => {
      try {
        const tx = buildCloseRideTx(
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
        const res = await client.signAndExecuteTransaction({
          signer: keypair,
          transaction: tx,
          options: { showEvents: true, showEffects: true },
        });
        const ev = (res.events as RideEvent[] | undefined)?.find((e) =>
          (e.type ?? "").includes("::ride_position::RideClosed"),
        );
        let kind = -1;
        if (ev?.parsedJson && typeof ev.parsedJson === "object") {
          const f = ev.parsedJson as { settlement_kind?: number | string };
          if (f.settlement_kind !== undefined) kind = Number(f.settlement_kind);
        }
        setLastSettlement({
          kind,
          label: kind >= 0 ? settlementLabel(kind) : "settled",
          digest: res.digest,
        });
        setPositionId(null);
        setState(null);
        setPnl(0);
        setPhase("idle");
        onBalanceChanged?.();
        busyRef.current = false;
      } catch (err) {
        busyRef.current = false;
        // Close failed — stay in "riding" so the user can release again.
        setPhase("riding");
        const msg = (err as Error).message ?? "cash-out failed";
        setLastError(msg);
        console.warn("[useWickRide] close:", err);
      }
    })();
  }, [
    phase,
    positionId,
    config.market.market,
    config.market.oracle,
    config.market.path,
    config.capsId,
    vaultId,
    priceOracleId,
    wickTokenStateId,
    wickStakingPoolId,
    packageId,
    keypair,
    client,
    onBalanceChanged,
  ]);

  useEffect(() => {
    closeRef.current = close;
  }, [close]);

  return { open, close, phase, state, pnl, lastSettlement, lastError };
}
