import { useEffect, useMemo, useState, type ReactNode } from "react";
import { DynamicConnectButton } from "@/components/wallet/DynamicConnectButton";
import { TapprPriceStage } from "@/components/market/TapprPriceStage";
import { TapprTradePanel } from "@/components/market/TapprTradePanel";
import { PortfolioPanel } from "@/components/portfolio/PortfolioPanel";
import { STUB_MARKETS, type MarketSnapshot } from "@/fixtures/markets";
import { useLiveMarkets } from "@/hooks/useLiveMarkets";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useWalletBalance } from "@/hooks/useWalletBalance";
import { RideTest } from "@/routes/RideTest";
import { Ride } from "@/routes/Ride";
import { explorerObjectUrl, NETWORK, PACKAGE_ID } from "@/lib/sui";
import { formatSui, shortAddr, timeUntil } from "@/lib/format";
import { cn } from "@/lib/utils";
import { impliedTouchPrice } from "@wick/sdk";

// Minimal pathname-based routing for the /ride-test spike and the /ride
// demo surface. Avoids pulling in a router lib. The Vercel SPA rewrite in
// vercel.json (if deployed) serves index.html for non-asset paths;
// computed once at module load (no hash routing / SPA nav within these
// pages).
const PATHNAME = typeof window !== "undefined" ? window.location.pathname : "/";
const IS_RIDE_TEST_ROUTE = PATHNAME === "/ride-test";
const IS_RIDE_ROUTE = PATHNAME === "/ride";

export default function App() {
  if (IS_RIDE_TEST_ROUTE) return <RideTest />;
  if (IS_RIDE_ROUTE) return <Ride />;
  return <MainApp />;
}

function MainApp() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(Date.now());
  const [tab, setTab] = useState<"tap" | "portfolio">("tap");
  const live = useLiveMarkets();
  const portfolio = usePortfolio();
  const balance = useWalletBalance();

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

  if (tab === "portfolio") {
    return (
      <div className="h-dvh bg-background text-foreground">
        <TapprHeader
          activeTab={tab}
          onTabChange={setTab}
          isLive={isLive}
          marketsCount={markets.length}
        />
        <PortfolioPanel />
      </div>
    );
  }

  return (
    <div className="h-dvh overflow-y-auto bg-background text-foreground">
      <TapprHeader
        activeTab={tab}
        onTabChange={setTab}
        isLive={isLive}
        marketsCount={markets.length}
      />
      <main className="mx-auto grid w-full max-w-[1780px] gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_420px]">
        <section className="flex min-w-0 flex-col gap-4">
          <AssetStrip
            markets={markets}
            selectedId={selected.id}
            onSelect={setSelectedId}
          />
          <TapprPriceStage market={selected} />
          <TapprTradePanel market={selected} isLive={isLive} />
        </section>

        <TapprRightRail
          balanceMist={balance.data?.total ?? null}
          portfolioCount={portfolioCount}
          market={selected}
          nowMs={nowMs}
        />
      </main>
    </div>
  );
}

function TapprHeader(props: {
  activeTab: "tap" | "portfolio";
  onTabChange: (tab: "tap" | "portfolio") => void;
  isLive: boolean;
  marketsCount: number;
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/95 px-4">
      <div className="mx-auto flex h-20 max-w-[1780px] items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="grid size-12 place-items-center rounded-lg bg-sky-400 text-sky-950 shadow-md shadow-sky-400/25">
            <span className="text-xl font-black">☤</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="text-2xl font-bold">Wick</div>
            <span className="rounded-md bg-sky-400/16 px-2 py-1 font-mono text-xs font-bold text-sky-300">
              SUI
            </span>
            <span
              className={cn(
                "rounded-md border px-2 py-1 font-mono text-xs font-bold",
                props.isLive
                  ? "border-emerald-400/30 text-emerald-400"
                  : "border-amber-400/30 text-amber-300",
              )}
            >
              {props.isLive ? `LIVE · ${props.marketsCount}` : "TESTNET"}
            </span>
          </div>
        </div>

        <nav className="hidden items-center gap-10 text-base font-medium text-muted-foreground md:flex">
          <button
            type="button"
            onClick={() => props.onTabChange("tap")}
            className={cn(
              "hover:text-foreground",
              props.activeTab === "tap" && "text-foreground",
            )}
          >
            Tap
          </button>
          <a href="/ride" className="hover:text-foreground">
            Ride
          </a>
          <button
            type="button"
            onClick={() => props.onTabChange("portfolio")}
            className={cn(
              "hover:text-foreground",
              props.activeTab === "portfolio" && "text-foreground",
            )}
          >
            Portfolio
          </button>
          <a
            href={explorerObjectUrl(PACKAGE_ID)}
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground"
            title={PACKAGE_ID}
          >
            pkg {shortAddr(PACKAGE_ID, 4, 4)}
          </a>
        </nav>

        <div className="flex items-center gap-3">
          <span className="hidden font-mono text-xs text-muted-foreground xl:inline">
            {NETWORK}
          </span>
          <DynamicConnectButton />
        </div>
      </div>
    </header>
  );
}

function AssetStrip(props: {
  markets: MarketSnapshot[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="grid gap-2 rounded-lg border border-border bg-card/35 p-1 md:grid-cols-3">
      {props.markets.slice(0, 3).map((market) => {
        const active = market.id === props.selectedId;
        const distance =
          ((market.barrier - market.underlyingPrice) / market.underlyingPrice) * 100;
        return (
          <button
            key={market.id}
            type="button"
            onClick={() => props.onSelect(market.id)}
            className={cn(
              "rounded-md px-4 py-3 text-left transition-colors",
              active ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/50",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold uppercase">
                  {market.asset}
                </div>
                <div className="font-mono text-xl font-bold tabular-nums">
                  {market.underlyingPrice.toLocaleString()}
                </div>
              </div>
              <div
                className={cn(
                  "font-mono text-sm tabular-nums",
                  distance >= 0 ? "text-emerald-400" : "text-rose-400",
                )}
              >
                {distance >= 0 ? "▲" : "▼"} {Math.abs(distance).toFixed(2)}%
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function TapprRightRail(props: {
  balanceMist: bigint | null;
  portfolioCount: number;
  market: MarketSnapshot;
  nowMs: number;
}) {
  const touch = impliedTouchPrice(
    props.market.touchReserve,
    props.market.noTouchReserve,
  );
  const expiry = timeUntil(props.market.expiryMs, props.nowMs);
  return (
    <aside className="flex min-w-0 flex-col gap-3">
      <RailCard label="Balance">
        <div className="font-mono text-3xl font-bold tabular-nums">
          {props.balanceMist === null ? "Connect" : `${formatSui(props.balanceMist)} SUI`}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">testnet SUI</div>
      </RailCard>
      <RailCard label="Market">
        <div className="grid grid-cols-2 gap-2 text-sm">
          <Metric label="Will hit" value={`${Math.round(touch * 100)}%`} tone="up" />
          <Metric label="Won't hit" value={`${Math.round((1 - touch) * 100)}%`} tone="down" />
          <Metric label="Ends" value={expiry.label} />
          <Metric label="Positions" value={String(props.portfolioCount)} />
        </div>
      </RailCard>
      <RailCard label="Your recent taps" right="0">
        <div className="py-10 text-center text-sm text-muted-foreground">
          no settled taps yet
        </div>
      </RailCard>
      <RailCard label="Leaderboard · 24h" right="testnet">
        <div className="space-y-3">
          {["smartmoney.sui", "ohm.sui", "moonwick", "ser.tap", "vega"].map(
            (name, idx) => (
              <div key={name} className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      "w-5 text-center font-mono text-xs font-bold",
                      idx === 0
                        ? "text-amber-300"
                        : idx === 1
                          ? "text-zinc-300"
                          : idx === 2
                            ? "text-amber-600"
                            : "text-muted-foreground",
                    )}
                  >
                    {idx + 1}
                  </span>
                  <div>
                    <div className="text-sm font-semibold">{name}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">
                      pending indexer
                    </div>
                  </div>
                </div>
                <div className="font-mono text-sm font-bold text-emerald-400">
                  --
                </div>
              </div>
            ),
          )}
        </div>
      </RailCard>
    </aside>
  );
}

function RailCard(props: {
  label: string;
  right?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card/35 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-[11px] font-bold uppercase text-muted-foreground">
          {props.label}
        </div>
        {props.right ? (
          <div className="font-mono text-[11px] text-muted-foreground">
            {props.right}
          </div>
        ) : null}
      </div>
      {props.children}
    </section>
  );
}

function Metric(props: {
  label: string;
  value: string;
  tone?: "up" | "down";
}) {
  return (
    <div className="rounded-md bg-secondary/35 p-2">
      <div className="text-[11px] text-muted-foreground">{props.label}</div>
      <div
        className={cn(
          "font-mono text-lg font-bold tabular-nums",
          props.tone === "up" && "text-emerald-400",
          props.tone === "down" && "text-rose-400",
        )}
      >
        {props.value}
      </div>
    </div>
  );
}
