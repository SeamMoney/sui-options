import { useEffect, useMemo, useState } from "react";
import { TopBar, type TopBarTab } from "@/components/layout/TopBar";
import { MarketsRail } from "@/components/market/MarketsRail";
import { MarketHeader } from "@/components/market/MarketHeader";
import { TradePanel } from "@/components/market/TradePanel";
import { PriceChart } from "@/components/market/PriceChart";
import { PortfolioPanel } from "@/components/portfolio/PortfolioPanel";
import { STUB_MARKETS, type MarketSnapshot } from "@/fixtures/markets";
import { useLiveMarkets } from "@/hooks/useLiveMarkets";
import { usePortfolio } from "@/hooks/usePortfolio";
import { RideTest } from "@/routes/RideTest";

// Minimal pathname-based routing for the /ride-test spike. Avoids pulling
// in a router lib for a one-page debug surface. Vercel SPA rewrite in
// vercel.json already serves index.html for non-asset paths. Computed once
// at module load (no hash routing / SPA nav within the test page).
const IS_RIDE_TEST_ROUTE =
  typeof window !== "undefined" && window.location.pathname === "/ride-test";

export default function App() {
  if (IS_RIDE_TEST_ROUTE) return <RideTest />;
  return <MainApp />;
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
