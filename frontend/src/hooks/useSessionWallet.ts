/**
 * useSessionWallet — an in-browser "burner" wallet for friction-free
 * hold-to-ride gameplay.
 *
 * THE PROBLEM
 * -----------
 * Every open_ride / close_ride is an on-chain transaction. A normal wallet
 * (Slush / Dynamic) shows an approval popup per transaction, and a popup
 * steals focus — you physically cannot keep a finger held on the chart
 * through it. So "tap and hold the candle" is impossible with a popup-per-
 * action wallet.
 *
 * THE FIX
 * -------
 * Generate an ephemeral Ed25519 keypair that the frontend holds directly.
 * Fund it once (via the testnet faucet, or a transfer from a real wallet).
 * Every ride open/close is then signed LOCALLY with this keypair and
 * submitted straight through the SuiClient — zero popups, instant. The
 * hold gesture works because nothing interrupts it.
 *
 * SECURITY
 * --------
 * The secret key lives in localStorage. Worst case, a page compromise
 * drains whatever testnet SUI the burner holds (faucet-capped, ~0.05 SUI
 * of valueless testnet tokens). This is the standard "session / burner
 * wallet" pattern used by on-chain games. For mainnet you would cap the
 * burner's balance, expire it, and let the user sweep funds back to their
 * real wallet — none of which matters on testnet.
 *
 * The hook:
 *   - loads or generates a keypair, persisted under `wick.session.v1`
 *   - exposes the address, the keypair (signer), and the live SUI balance
 *   - exposes `refreshBalance()` to poke after a faucet drip / ride
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { TESTNET_RPC_URL } from "@/lib/sui";

const STORAGE_KEY = "wick.session.v1";
const BALANCE_POLL_MS = 4000;

/**
 * Standalone client — the burner does not go through dApp Kit, but it MUST
 * use the same CORS-safe RPC as the rest of the app. The burner does the
 * heaviest RPC work of any client (4s balance polls + sign/execute on every
 * ride open/close), so pointing it at the Mysten public fullnode re-triggered
 * the v4.29 throttle→CORS failure that sui.ts already moved away from. Share
 * TESTNET_RPC_URL so there is exactly one testnet endpoint in the browser.
 */
const sessionClient = new SuiJsonRpcClient({
  url: TESTNET_RPC_URL,
  network: "testnet",
});

function loadOrCreateKeypair(): Ed25519Keypair {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return Ed25519Keypair.fromSecretKey(stored);
  } catch (_err) {
    // localStorage blocked (private mode / SSR) — fall through to ephemeral.
  }
  const kp = Ed25519Keypair.generate();
  try {
    localStorage.setItem(STORAGE_KEY, kp.getSecretKey());
  } catch (_err) {
    // Non-persistent fallback — fine, the burner just won't survive reload.
  }
  return kp;
}

export interface SessionWalletOptions {
  /**
   * v4.25a — Active market's collateral type tag (e.g.
   * "0x204d...::tusd::TUSD"). When the burner has to escrow a non-SUI
   * coin to open a ride, the hook also polls that coin's balance so
   * the UI can gate on it. Omit (or pass "0x2::sui::SUI") for SUI-only
   * markets — in that case `collateralBalance` mirrors `balanceMist`.
   */
  collateralType?: string;
}

export interface SessionWallet {
  /** The burner's Sui address (0x…). */
  address: string;
  /** The signer — pass as `signer` to `client.signAndExecuteTransaction`. */
  keypair: Ed25519Keypair;
  /** Standalone testnet client the burner submits through. */
  client: SuiJsonRpcClient;
  /** Live SUI balance in MIST. `null` until the first poll lands. */
  balanceMist: bigint | null;
  /**
   * Live balance of the active market's collateral coin in RAW units
   * (e.g. for TUSD with 6 decimals, 10_000_000 = 10 TUSD). `null` until
   * the first poll lands. When the market is SUI-collateralized this
   * equals `balanceMist`.
   */
  collateralBalance: bigint | null;
  /** The coin type the collateralBalance is for. */
  collateralType: string;
  /** Poke a balance refresh (after a faucet drip or a ride settles). */
  refreshBalance: () => void;
  /** True once the keypair exists (always true after first render). */
  ready: boolean;
}

const SUI_TYPE = "0x2::sui::SUI";

export function useSessionWallet(opts?: SessionWalletOptions): SessionWallet {
  const collateralType = opts?.collateralType ?? SUI_TYPE;

  // Generate exactly once per mount; persisted across reloads via localStorage.
  const keypair = useMemo(() => loadOrCreateKeypair(), []);
  const address = useMemo(() => keypair.toSuiAddress(), [keypair]);

  const [balanceMist, setBalanceMist] = useState<bigint | null>(null);
  const [collateralBalance, setCollateralBalance] = useState<bigint | null>(null);
  const pollRef = useRef<number | null>(null);

  const refreshBalance = useCallback(() => {
    void (async () => {
      // Always fetch SUI (needed for gas regardless of market).
      try {
        const sui = await sessionClient.getBalance({ owner: address });
        const suiBal = BigInt(sui.totalBalance);
        setBalanceMist(suiBal);
        // If the market is SUI-collateralized, mirror it into collateralBalance
        // so the gate code can use one variable.
        if (collateralType === SUI_TYPE) {
          setCollateralBalance(suiBal);
        }
      } catch (err) {
        console.warn("[useSessionWallet] sui balance:", err);
      }
      // Fetch the collateral coin separately when it's not SUI.
      if (collateralType !== SUI_TYPE) {
        try {
          const coll = await sessionClient.getBalance({
            owner: address,
            coinType: collateralType,
          });
          setCollateralBalance(BigInt(coll.totalBalance));
        } catch (err) {
          console.warn("[useSessionWallet] collateral balance:", err);
        }
      }
    })();
  }, [address, collateralType]);

  useEffect(() => {
    refreshBalance();
    pollRef.current = window.setInterval(refreshBalance, BALANCE_POLL_MS);
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, [refreshBalance]);

  return {
    address,
    keypair,
    client: sessionClient,
    balanceMist,
    collateralBalance,
    collateralType,
    refreshBalance,
    ready: true,
  };
}
