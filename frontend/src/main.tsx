import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toaster";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import App from "@/App";
import "@/index.css";

const queryClient = new QueryClient();

// The wallet/auth stack (Dynamic Labs social-login SDK + dapp-kit) is the
// bulk of the app's JS. The Wick Pro submission (/pro) is a client-side
// options game on the live DeepBook mark — it uses NO wallet — so it skips
// that stack entirely and becomes interactive far sooner. Every other route
// (the Ride game's session wallet + faucet) lazy-loads it.
const WalletProviders = lazy(() =>
  import("@/providers/WalletProviders").then((m) => ({ default: m.WalletProviders })),
);

const PATHNAME = typeof window !== "undefined" ? window.location.pathname : "/";
// Only the Ride game (its session wallet + faucet) actually uses the wallet.
// Every other route — the Wick Pro submission (/pro, /pro-sim), the provable-
// fairness verifier, docs, candle-vision, the coach — is wallet-free and skips
// the heavy Dynamic + dapp-kit stack entirely, so they all load fast.
const WALLET_ROUTES = new Set(["/", "/ride", "/degen", "/ride-test"]);
const NEEDS_WALLET = WALLET_ROUTES.has(PATHNAME);

// On wallet routes, kick off the wallet-stack + Ride downloads immediately
// (in parallel with React init) instead of waiting for the Suspense boundary
// to request them — this hides the extra round-trip the lazy split would
// otherwise add to the landing page's time-to-interactive.
if (NEEDS_WALLET && typeof window !== "undefined") {
  void import("@/providers/WalletProviders");
  void import("@/routes/Ride");
}

// Dark, full-screen hold while the wallet chunk streams in on wallet routes —
// never a white flash.
function BootFallback() {
  return <div style={{ height: "100%", background: "#0a0a0a" }} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary surface="Wick app">
      {NEEDS_WALLET ? (
        <Suspense fallback={<BootFallback />}>
          <WalletProviders queryClient={queryClient}>
            <ToastProvider>
              <App />
            </ToastProvider>
          </WalletProviders>
        </Suspense>
      ) : (
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <App />
          </ToastProvider>
        </QueryClientProvider>
      )}
    </ErrorBoundary>
  </StrictMode>,
);
