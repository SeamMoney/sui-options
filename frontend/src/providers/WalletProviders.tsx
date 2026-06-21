/**
 * WalletProviders — the wallet/auth provider stack, split out of main.tsx so
 * it can be lazy-loaded and mounted ONLY on routes that actually use the
 * wallet (the Ride game's session wallet + faucet).
 *
 * The Wick Pro submission (/pro) is a client-side options game on the live
 * DeepBook mark — it touches no wallet at all — so it skips this entire stack
 * (Dynamic Labs social-login SDK + dapp-kit), which is the bulk of the JS, and
 * paints/responds far sooner. See main.tsx.
 *
 * The nesting here is IDENTICAL to the original main.tsx tree, so wallet
 * behaviour (autoConnect, the Dynamic↔Wallet-Standard bridge registration
 * order, the inner error boundary) is unchanged.
 */
import type { ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import { SuiClientProvider, WalletProvider } from "@mysten/dapp-kit";
import { networkConfig, NETWORK } from "@/lib/sui";
import { DynamicProvider } from "@/providers/DynamicProvider";
import { DynamicWalletStandardBridge } from "@/providers/DynamicWalletStandardBridge";
import { ErrorBoundary } from "@/components/ErrorBoundary";

export function WalletProviders({
  queryClient,
  children,
}: {
  queryClient: QueryClient;
  children: ReactNode;
}) {
  return (
    <DynamicProvider>
      <QueryClientProvider client={queryClient}>
        <SuiClientProvider networks={networkConfig} defaultNetwork={NETWORK}>
          <WalletProvider autoConnect>
            {/* Inner boundary around the wallet bridge — a buggy wallet
                extension's synchronous throw during register-event delivery
                falls here without taking the rest of the app down. */}
            <ErrorBoundary surface="Wallet bridge">
              <DynamicWalletStandardBridge />
            </ErrorBoundary>
            {children}
          </WalletProvider>
        </SuiClientProvider>
      </QueryClientProvider>
    </DynamicProvider>
  );
}

export default WalletProviders;
