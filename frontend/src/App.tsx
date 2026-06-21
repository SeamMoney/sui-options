import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { TopBar, type TopBarTab } from "@/components/layout/TopBar";
import { MarketsRail } from "@/components/market/MarketsRail";
import { MarketHeader } from "@/components/market/MarketHeader";
import { TradePanel } from "@/components/market/TradePanel";
import { PriceChart } from "@/components/market/PriceChart";
import { PortfolioPanel } from "@/components/portfolio/PortfolioPanel";
import { STUB_MARKETS, type MarketSnapshot } from "@/fixtures/markets";
import { useLiveMarkets } from "@/hooks/useLiveMarkets";
import { usePortfolio } from "@/hooks/usePortfolio";
import { Ride } from "@/routes/Ride";

// The headline `/` (and `/degen`) route is `Ride`, so it stays eagerly
// imported — it's what a judge hits cold and it must paint instantly.
// Every other route is a separate destination reached only by an explicit
// URL, so we lazy-load them: that keeps the candle-vision scanner (gsap +
// motion + the candle-vision lib), the docs grid, the provable-fairness
// verifier, and the pro terminal OUT of the entry chunk the ride page
// downloads. Pre-split, all of that rode along in one ~3.4 MB bundle.
const CandleVision = lazy(() =>
  import("@/routes/CandleVision").then((m) => ({ default: m.CandleVision })),
);
const Docs = lazy(() => import("@/routes/Docs").then((m) => ({ default: m.Docs })));
const Verify = lazy(() => import("@/routes/Verify").then((m) => ({ default: m.Verify })));
const RideTest = lazy(() =>
  import("@/routes/RideTest").then((m) => ({ default: m.RideTest })),
);
// Wick Pro — Black-Scholes options on a live DeepBook mark (the submission
// game). Lazy so its pro-options engine + DeepBook layer stay out of the
// ride entry chunk.
const Pro = lazy(() => import("@/routes/Pro").then((m) => ({ default: m.Pro })));

// Minimal pathname-based routing. Computed once at module load (no hash
// routing / SPA nav within these pages — the Vercel SPA rewrite in
// vercel.json serves index.html for non-asset paths so reload works).
//
// 2026-05-24 — flipped: `/` is the game now (Ride). The legacy touch-
// trading shell (MainApp) moved to `/pro`. The old `/ride` URL still
// renders Ride for any external links / bookmarks that point at it.
// User: "Just make ride the main page and have the other stuff be on /pro".
const PATHNAME = typeof window !== "undefined" ? window.location.pathname : "/";
const IS_RIDE_TEST_ROUTE = PATHNAME === "/ride-test";
const IS_PRO_ROUTE = PATHNAME === "/pro";
// The legacy touch-trading terminal (MainApp) kept reachable for reference.
const IS_TERMINAL_ROUTE = PATHNAME === "/terminal";
const IS_CANDLE_VISION_ROUTE = PATHNAME === "/candle-vision";
const IS_DEGEN_ROUTE = PATHNAME === "/degen";
const IS_DOCS_ROUTE = PATHNAME === "/docs" || PATHNAME.startsWith("/docs/");
const IS_VERIFY_ROUTE = PATHNAME === "/verify";

// Tiny full-screen fallback while a lazy route chunk streams in. Kept
// dark + centered so it reads as "loading", never as a broken white flash.
function RouteFallback() {
  return (
    <div className="h-full w-full flex items-center justify-center bg-background text-foreground/40 text-sm font-mono tracking-wide">
      loading…
    </div>
  );
}

export default function App() {
  // Non-default routes are lazy chunks, so each needs a Suspense boundary.
  if (IS_VERIFY_ROUTE)
    return (
      <Suspense fallback={<RouteFallback />}>
        <Verify />
      </Suspense>
    ); // in-browser provable-fairness replay
  if (IS_DOCS_ROUTE)
    return (
      <Suspense fallback={<RouteFallback />}>
        <Docs path={PATHNAME} />
      </Suspense>
    ); // docs grid + topic pages (chaos-feed)
  if (IS_DEGEN_ROUTE) return <Ride />; // degen tap-hold app
  if (IS_CANDLE_VISION_ROUTE)
    return (
      <Suspense fallback={<RouteFallback />}>
        <CandleVision />
      </Suspense>
    );
  if (IS_RIDE_TEST_ROUTE)
    return (
      <Suspense fallback={<RouteFallback />}>
        <RideTest />
      </Suspense>
    );
  if (IS_PRO_ROUTE)
    return (
      <Suspense fallback={<RouteFallback />}>
        <Pro />
      </Suspense>
    ); // Wick Pro — the Black-Scholes options game (the submission)
  if (IS_TERMINAL_ROUTE) return <MainApp />; // legacy touch-trading terminal
  return <Ride />; // default
}

function MainApp() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(Date.now());
  const [tab, setTab] = useState<TopBarTab>("trade");
  const live = useLiveMarkets();
  const portfolio = usePortfolio();

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const { markets, isLive } = useMemo<{ markets: MarketSnapshot[]; isLive: boolean }>(() => {
    const liveMarkets = live.data ?? [];
    if (liveMarkets.length > 0) return { markets: liveMarkets, isLive: true };
    return { markets: STUB_MARKETS, isLive: false };
  }, [live.data]);

  const selected =
    markets.find((m) => m.id === selectedId) ?? markets[0]!;

  useEffect(() => {
    if (!markets.find((m) => m.id === selectedId)) {
      setSelectedId(markets[0]?.id ?? null);
    }
  }, [markets, selectedId]);

  const portfolioCount =
    (portfolio.data?.positions.length ?? 0) + (portfolio.data?.lpPositions.length ?? 0);

  return (
    <div className="h-full flex flex-col bg-background text-foreground">
      <TopBar
        isLive={isLive}
        marketsLoading={live.isLoading}
        marketsCount={markets.length}
        tab={tab}
        onTabChange={setTab}
        portfolioCount={portfolioCount}
      />
      <main className="flex-1 flex min-h-0">
        {tab === "trade" ? (
          <>
            <MarketsRail
              markets={markets}
              selectedId={selected.id}
              nowMs={nowMs}
              onSelect={setSelectedId}
            />
            <section className="flex-1 flex flex-col min-w-0">
              <MarketHeader market={selected} nowMs={nowMs} />
              <PriceChart market={selected} />
              <TradePanel market={selected} isLive={isLive} />
            </section>
          </>
        ) : (
          <section className="flex-1 flex flex-col min-w-0">
            <PortfolioPanel />
          </section>
        )}
      </main>
    </div>
  );
}
