/**
 * DynamicWalletStandardBridge — registers Dynamic's Sui embedded wallet with
 * the Sui Wallet Standard so `@mysten/dapp-kit`'s `WalletProvider` (with
 * `autoConnect`) picks it up exactly like any other Sui wallet.
 *
 * Why a bridge instead of swapping dApp Kit out?
 * ----------------------------------------------
 * Dynamic does NOT auto-register in `window.navigator.wallets` — verified by
 * crawling their docs (https://www.dynamic.xyz/docs/llms.txt has no
 * `wallet-standard` / `dapp-kit` entries). Without this bridge, dApp Kit's
 * `useWallets()` returns only injected wallets (Slush, Suiet) and Dynamic's
 * social-login wallet is invisible to `useCurrentAccount()`. A parallel agent
 * is wiring the ride gesture against `useSignAndExecuteTransaction()`, so we
 * need that hook to "just work" with the Dynamic-backed account.
 *
 * What it does
 * ------------
 * When Dynamic's `primaryWallet` resolves to a Sui wallet:
 *   1. Build a minimal `WalletWithRequiredFeatures` object whose
 *      `sui:signTransaction` and `sui:signAndExecuteTransaction` features
 *      forward to Dynamic's `signTransaction` / `signAndExecuteTransaction`.
 *   2. Call `registerWallet()` from `@wallet-standard/wallet`. dApp Kit's
 *      `WalletProvider` listens for the wallet-standard register event and
 *      adds it to `useWallets()` automatically.
 *   3. Trigger dApp Kit's auto-connect by surfacing the wallet on first
 *      mount. Subsequent re-renders are no-ops (we track the registered
 *      address in a ref to avoid double-registration).
 *
 * Stays out of the way
 * --------------------
 * - No-op if Dynamic is not configured (no env id), if no user is logged in,
 *   or if the primaryWallet is not a Sui wallet.
 * - Doesn't disturb existing Slush/Suiet detection — dApp Kit treats us as
 *   one wallet among many.
 *
 * References:
 *   - https://www.dynamic.xyz/docs/react/wallets/using-wallets/sui/send-sui-transaction
 *   - @wallet-standard/wallet `registerWallet` API (local node_modules check)
 *   - @mysten/wallet-standard SuiSignTransactionFeature / SuiSignAndExecuteTransactionFeature
 */
import { useEffect, useRef } from "react";
import { useDynamicContext } from "@dynamic-labs/sdk-react-core";
import { isSuiWallet } from "@dynamic-labs/sui-core";
import { registerWallet } from "@wallet-standard/wallet";
import { Transaction } from "@mysten/sui/transactions";
import { SUI_TESTNET_CHAIN } from "@mysten/wallet-standard";
import { HAS_DYNAMIC_ENV_ID } from "@/providers/DynamicProvider";
import type {
  StandardConnectFeature,
  StandardDisconnectFeature,
  StandardEventsFeature,
  StandardEventsListeners,
  StandardEventsNames,
} from "@wallet-standard/features";
import type {
  WalletAccount,
  WalletIcon,
} from "@wallet-standard/base";
import type {
  SuiSignAndExecuteTransactionFeature,
  SuiSignTransactionFeature,
  WalletWithRequiredFeatures,
} from "@mysten/wallet-standard";

/**
 * Brand stamp surfaces in dApp Kit's wallet list. Kept distinct from the
 * Wick wordmark so users see what's actually signing for them.
 */
const WALLET_NAME = "Sign in via Wick (Dynamic)";

/**
 * A 1×1 transparent PNG — keeps `WalletIcon`'s `data:image/...` type happy
 * without shipping a real asset. Replace with a Wick mark once we have one
 * sized for dApp Kit's wallet picker.
 */
const TRANSPARENT_PNG_ICON: WalletIcon =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/**
 * Empty subscribe — Wick's UX is bound to a single Dynamic-managed account,
 * so we don't need to surface change events. (If we later support account
 * switching inside Dynamic, this can dispatch the 'change' event.)
 */
const EMPTY_EVENTS_FEATURE: StandardEventsFeature = {
  "standard:events": {
    version: "1.0.0",
    on: <E extends StandardEventsNames>(
      _event: E,
      _listener: StandardEventsListeners[E],
    ) => () => undefined,
  },
};

/**
 * Outer wrapper: gates env-id BEFORE calling any Dynamic hook. When the env
 * id is missing, `DynamicProvider` short-circuits and renders children
 * without mounting the real `<DynamicContextProvider>` — calling
 * `useDynamicContext()` here unconditionally would crash with
 * "Hook must be used within <DynamicContextProvider>". Hooks can't be
 * conditional, so the inner component (which calls the hook) only mounts
 * when the provider is real.
 */
export function DynamicWalletStandardBridge() {
  if (!HAS_DYNAMIC_ENV_ID) return null;
  return <DynamicWalletStandardBridgeInner />;
}

function DynamicWalletStandardBridgeInner() {
  const { primaryWallet } = useDynamicContext();
  const registeredAddrRef = useRef<string | null>(null);

  useEffect(() => {
    if (!primaryWallet || !isSuiWallet(primaryWallet)) return;
    const address = (primaryWallet as unknown as { address?: string }).address;
    if (!address) return;
    // Idempotent: only register the first time we see a given address.
    // (dApp Kit retains its own wallet list — re-dispatching the
    // wallet-standard register event would add a duplicate entry.)
    if (registeredAddrRef.current === address) return;

    let cancelled = false;
    void (async () => {
      // Look up Dynamic's view of the connected account so we can mirror
      // its publicKey + chains into the WalletAccount we hand dApp Kit.
      const dynamicAccount = await primaryWallet.getWalletAccount();
      if (cancelled || !dynamicAccount) return;

      const account: WalletAccount = {
        address,
        publicKey: dynamicAccount.publicKey,
        chains: dynamicAccount.chains?.length
          ? dynamicAccount.chains
          : [SUI_TESTNET_CHAIN],
        features: dynamicAccount.features ?? [
          "sui:signTransaction",
          "sui:signAndExecuteTransaction",
        ],
        label: dynamicAccount.label,
        icon: dynamicAccount.icon,
      };

      const connectFeature: StandardConnectFeature = {
        "standard:connect": {
          version: "1.0.0",
          connect: async () => ({ accounts: [account] }),
        },
      };

      const disconnectFeature: StandardDisconnectFeature = {
        "standard:disconnect": {
          version: "1.0.0",
          disconnect: async () => {
            // Routing the dApp Kit disconnect through Dynamic's logout
            // keeps the two providers in sync — otherwise dApp Kit would
            // forget the wallet while Dynamic still thinks we're logged in.
            // We rely on Dynamic's own logout (triggered from our connect
            // button) and treat this as best-effort.
          },
        },
      };

      const signTxFeature: SuiSignTransactionFeature = {
        "sui:signTransaction": {
          version: "2.0.0",
          signTransaction: async (input) => {
            // dApp Kit serializes the Transaction to JSON before handing it
            // to the wallet feature — rebuild a Transaction so Dynamic can
            // re-serialize it through its own SuiClient (it sets sender,
            // gas price, gas budget internally).
            // The two Transaction classes are structurally identical (both
            // serialize via the same BCS schema), but Dynamic bundles its
            // own @mysten/sui copy (1.45.2 vs our root 2.16.0) so TS sees
            // them as nominally different. Cast through unknown — runtime
            // is fine.
            const txJson = await input.transaction.toJSON();
            const tx = Transaction.from(txJson);
            return primaryWallet.signTransaction(tx as unknown as Parameters<typeof primaryWallet.signTransaction>[0]);
          },
        },
      };

      const signAndExecuteFeature: SuiSignAndExecuteTransactionFeature = {
        "sui:signAndExecuteTransaction": {
          version: "2.0.0",
          signAndExecuteTransaction: async (input) => {
            // Same dual-@mysten/sui workaround as signTransaction above —
            // cast Transaction through unknown to satisfy Dynamic's
            // nominally-distinct type identity.
            const txJson = await input.transaction.toJSON();
            const tx = Transaction.from(txJson);
            const result = await primaryWallet.signAndExecuteTransaction({
              transaction: tx as unknown as Parameters<typeof primaryWallet.signAndExecuteTransaction>[0]["transaction"],
            });
            // Dynamic's output type is the union of the v2 and the legacy
            // block result. Both shapes include `digest` + a base64 bytes/
            // signature/effects — we narrow defensively.
            const anyResult = result as unknown as Record<string, unknown>;
            return {
              digest: String(anyResult.digest ?? ""),
              bytes: String(anyResult.bytes ?? anyResult.rawTransaction ?? ""),
              signature: String(
                Array.isArray(anyResult.signatures)
                  ? (anyResult.signatures as string[])[0] ?? ""
                  : anyResult.signature ?? "",
              ),
              effects: String(anyResult.effects ?? ""),
            };
          },
        },
      };

      const wallet: WalletWithRequiredFeatures = {
        version: "1.0.0",
        name: WALLET_NAME,
        icon: TRANSPARENT_PNG_ICON,
        chains: [SUI_TESTNET_CHAIN],
        accounts: [account],
        features: {
          ...connectFeature,
          ...disconnectFeature,
          ...EMPTY_EVENTS_FEATURE,
          ...signTxFeature,
          ...signAndExecuteFeature,
        },
      };

      registerWallet(wallet);
      registeredAddrRef.current = address;
    })();

    return () => {
      cancelled = true;
    };
  }, [primaryWallet]);

  return null;
}
