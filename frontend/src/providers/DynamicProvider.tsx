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
 * The Dynamic environment ID defaults to the Sui-enabled Dynamic demo snap
 * shared for the hackathon wallet flow. Override it with
 * `VITE_DYNAMIC_ENVIRONMENT_ID` for a Wick-owned Dynamic dashboard project.
 *
 * In a Wick-owned Dynamic dashboard, the Sui chain must also be enabled at
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
 * Decoded from https://go.dynamic.xyz/4a8HgrV. The snap enables Sui, social
 * login providers, and connect-and-sign mode for the demo wallet flow.
 */
const DYNAMIC_DEMO_ENV_ID = "25f40019-73a6-40bc-a4e1-d4ed2b16a2fd";

/**
 * Vite injects `import.meta.env.*` at build time; the cast is here only to
 * dodge `tsc --noEmit` strictness in projects that haven't generated a
 * `vite-env.d.ts` for the keys we read. Both at build and at runtime the
 * value is `string | undefined`.
 */
const CONFIGURED_DYNAMIC_ENV_ID = (
  import.meta.env.VITE_DYNAMIC_ENVIRONMENT_ID ?? ""
) as string;
const DYNAMIC_ENV_ID = CONFIGURED_DYNAMIC_ENV_ID.trim() || DYNAMIC_DEMO_ENV_ID;

/**
 * Sentinel exposed to the rest of the app so the Connect button can decide
 * whether the Dynamic provider is mounted.
 */
export const HAS_DYNAMIC_ENV_ID = DYNAMIC_ENV_ID.length > 0;

/**
 * Dynamic refuses to mount without an environment id. The shared demo snap
 * gives Wick a default Sui-enabled environment for hackathon demos while
 * preserving `VITE_DYNAMIC_ENVIRONMENT_ID` as the production override.
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
        // Match the shared Dynamic snap's wallet mode.
        initialAuthenticationMode: "connect-and-sign",
        appName: "Wick Markets",
      }}
      theme="light"
    >
      {children}
    </DynamicContextProvider>
  );
}
