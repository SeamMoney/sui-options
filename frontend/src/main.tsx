import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SuiClientProvider, WalletProvider } from "@mysten/dapp-kit";
import { networkConfig, NETWORK } from "@/lib/sui";
import { ToastProvider } from "@/components/ui/toaster";
import { DynamicProvider } from "@/providers/DynamicProvider";
import { DynamicWalletStandardBridge } from "@/providers/DynamicWalletStandardBridge";
import App from "@/App";
import "@/index.css";

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/*
      Provider order matters:
        DynamicProvider                  — auth + key custody (social login)
          QueryClientProvider            — TanStack Query (shared cache)
            SuiClientProvider            — Sui RPC URL (testnet)
              WalletProvider autoConnect — Wallet-Standard wallet registry;
                                           auto-picks the Dynamic-backed
                                           wallet that the bridge registers
              DynamicWalletStandardBridge — registers Dynamic with the Sui
                                           Wallet Standard so dApp Kit picks
                                           it up. Must live *inside* both
                                           DynamicProvider (for context) and
                                           WalletProvider (so register events
                                           are heard).
    */}
    <DynamicProvider>
      <QueryClientProvider client={queryClient}>
        <SuiClientProvider networks={networkConfig} defaultNetwork={NETWORK}>
          <WalletProvider autoConnect>
            <DynamicWalletStandardBridge />
            <ToastProvider>
              <App />
            </ToastProvider>
          </WalletProvider>
        </SuiClientProvider>
      </QueryClientProvider>
    </DynamicProvider>
  </StrictMode>,
);
