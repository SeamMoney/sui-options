/**
 * Dynamic.xyz embedded-wallet provider — Wick Markets.
 *
 * Wraps the app in `DynamicContextProvider` so judges can sign in with
 * Google / Apple / GitHub / email and have a Sui wallet derived in seconds —
 * no Slush install, no faucet visit.
 *
 * Topology
 * --------
 * We keep `@mysten/dapp-kit` as the canonical wallet hook surface across the
 * app (a parallel agent is wiring the ride gesture against its hooks).
 * Dynamic sits *above* dApp Kit, providing auth + key custody, and a small
 * bridge (`DynamicWalletStandardBridge`) registers Dynamic's Sui wallet
 * against the Sui Wallet Standard so dApp Kit's `WalletProvider autoConnect`
 * picks it up transparently. Net effect:
 *
 *     useCurrentAccount()                -> returns Dynamic's Sui account
 *     useSignAndExecuteTransaction()     -> proxies into Dynamic's signer
 *     useSuiClient()                     -> unchanged (still our RPC URL)
 *
 * Environment
 * -----------
 * The Dynamic environment ID must be supplied via `VITE_DYNAMIC_ENVIRONMENT_ID`.
 * Register the app at https://app.dynamic.xyz/dashboard/developer/api and
 * paste the env id into `frontend/.env.local`. If unset, the provider still
 * renders (no crash) but the Connect button surfaces a clear "missing env id"
 * message — the rest of the app (markets, charts, ride-test) keeps working
 * via dApp Kit's existing wallet connectors (Slush, etc).
 *
 * The Sui chain must also be enabled in the Dynamic dashboard at
 * https://app.dynamic.xyz/dashboard/chains-and-networks#sui before the
 * SuiWalletConnectors do anything.
 *
 * References (verified against live docs, 2026-05):
 *   - https://www.dynamic.xyz/docs/react/reference/quickstart
 *   - https://www.dynamic.xyz/docs/react/wallets/using-wallets/sui/using-sui-wallets
 *   - https://www.dynamic.xyz/docs/javascript/reference/sui/adding-sui-extension
 */
import type { ReactNode } from "react";
import { DynamicContextProvider } from "@dynamic-labs/sdk-react-core";
import { SuiWalletConnectors } from "@dynamic-labs/sui";

/**
 * Vite injects `import.meta.env.*` at build time; the cast is here only to
 * dodge `tsc --noEmit` strictness in projects that haven't generated a
 * `vite-env.d.ts` for the keys we read. Both at build and at runtime the
 * value is `string | undefined`.
 */
const DYNAMIC_ENV_ID = (import.meta.env.VITE_DYNAMIC_ENVIRONMENT_ID ?? "") as string;

/**
 * Sentinel exposed to the rest of the app so the Connect button can render
 * a helpful "set VITE_DYNAMIC_ENVIRONMENT_ID" message instead of silently
 * throwing inside Dynamic's modal.
 */
export const HAS_DYNAMIC_ENV_ID = DYNAMIC_ENV_ID.length > 0;

/**
 * Dynamic refuses to mount without an environment id (it logs a hard error
 * and the modal never opens). To keep the dev server bootable for the rest
 * of the app, swap in a no-op fallback when the id is missing — the parallel
 * agent's `/ride-test` page still works via dApp Kit's other connectors,
 * and the Connect button shows the env-id hint instead of opening Dynamic.
 */
export function DynamicProvider({ children }: { children: ReactNode }) {
  if (!HAS_DYNAMIC_ENV_ID) {
    return <>{children}</>;
  }
  return (
    <DynamicContextProvider
      settings={{
        environmentId: DYNAMIC_ENV_ID,
        // Sui-only for now — Wick is single-chain. Add EthereumWalletConnectors
        // here later if/when we list on an EVM chain. SuiWalletConnectors
        // covers both injected Sui wallets (Slush, Suiet) and Dynamic's
        // embedded social-login wallets.
        walletConnectors: [SuiWalletConnectors],
        // `connect-only` skips the extra signature step on first login —
        // judges hit "Continue with Google" and land in the app, no second
        // modal. Switch to `connect-and-sign` later if we want to gate
        // off-chain features behind an ownership proof.
        initialAuthenticationMode: "connect-only",
        appName: "Wick Markets",
      }}
    >
      {children}
    </DynamicContextProvider>
  );
}
