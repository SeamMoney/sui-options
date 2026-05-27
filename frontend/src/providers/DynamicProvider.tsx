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
 * v4.31g — DROPPED the shared demo-snap fallback. Without VITE_DYNAMIC_ENVIRONMENT_ID
 * configured, we now do NOT mount DynamicContextProvider at all. Reason:
 * the previous default (`25f40019…`) is a shared demo snap whose origin
 * whitelist does NOT include `wick-markets.vercel.app`, so every page
 * load fired a wall of CORS errors against `app.dynamicauth.com` while
 * the Dynamic SDK tried to fetch /sdkSettings, /nonce, /settings — none
 * of which it could ever reach. The errors didn't affect Wick's session-
 * wallet flow but spammed the console relentlessly and confused users
 * who thought their game was broken.
 *
 * To wire up real Dynamic auth, create a project at https://app.dynamic.xyz,
 * enable the Sui chain, add `https://wick-markets.vercel.app` (and any
 * preview URLs) under Security → CORS origins, then set the env var in
 * Vercel → Project → Settings → Environment Variables:
 *
 *   VITE_DYNAMIC_ENVIRONMENT_ID=<your-env-id-uuid>
 *
 * Trigger a redeploy and the `Sign in` button (DynamicConnectButton)
 * will start opening the real Dynamic modal.
 */
const CONFIGURED_DYNAMIC_ENV_ID = (
  import.meta.env.VITE_DYNAMIC_ENVIRONMENT_ID ?? ""
) as string;
const DYNAMIC_ENV_ID = CONFIGURED_DYNAMIC_ENV_ID.trim();

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
        // covers BOTH injected Sui wallets (Slush, Suiet, every Sui
        // wallet-standard wallet) AND Dynamic's embedded social-login
        // wallets — they're surfaced together in the same modal.
        walletConnectors: [SuiWalletConnectors],
        // v4.31i — switched from "connect-and-sign" to "connect-only".
        // User report 2026-05-26: "when I click sign in with gmail it
        // logs me in and opens the modal again and says choose wallet."
        // "connect-and-sign" makes Dynamic require BOTH an auth method
        // AND a wallet (so after Google login the modal re-opens asking
        // which Sui wallet to attach). "connect-only" treats the social
        // login itself as the connect step and Dynamic auto-derives a
        // Sui embedded wallet for the user — no second prompt.
        initialAuthenticationMode: "connect-only",
        appName: "Wick Markets",
      }}
      theme="light"
    >
      {children}
    </DynamicContextProvider>
  );
}
