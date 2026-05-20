import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { DynamicConnectButton } from "@/components/wallet/DynamicConnectButton";
import { PACKAGE_ID, NETWORK, explorerObjectUrl } from "@/lib/sui";
import { shortAddr } from "@/lib/format";

export type TopBarTab = "trade" | "portfolio";

interface TopBarProps {
  isLive?: boolean;
  marketsLoading?: boolean;
  marketsCount?: number;
  tab?: TopBarTab;
  onTabChange?: (t: TopBarTab) => void;
  portfolioCount?: number;
}

export function TopBar({
  isLive,
  marketsLoading,
  marketsCount,
  tab = "trade",
  onTabChange,
  portfolioCount,
}: TopBarProps = {}) {
  return (
    <header className="flex items-center justify-between h-12 px-4 border-b border-border bg-card/50">
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-2">
          <div className="size-5 rounded-sm bg-foreground text-background grid place-items-center font-mono text-[10px] font-bold">
            ☤
          </div>
          <div className="font-mono font-semibold text-sm tracking-tight">
            wick<span className="text-muted-foreground">.markets</span>
          </div>
          <Badge variant="outline" className="ml-1 uppercase text-[9px]">
            {NETWORK}
          </Badge>
          {marketsLoading ? (
            <Badge variant="outline" className="ml-1 uppercase text-[9px] text-muted-foreground">
              loading…
            </Badge>
          ) : isLive ? (
            <Badge variant="outline" className="ml-1 uppercase text-[9px] text-[color:var(--color-touch)] border-[color:var(--color-touch)]/40">
              live · {marketsCount ?? 0}
            </Badge>
          ) : (
            <Badge variant="outline" className="ml-1 uppercase text-[9px] text-[color:var(--color-warning)] border-[color:var(--color-warning)]/40">
              stub
            </Badge>
          )}
        </div>

        <Tabs value={tab} onValueChange={(v) => onTabChange?.(v as TopBarTab)}>
          <TabsList>
            <TabsTrigger value="trade">Touch trading</TabsTrigger>
            <TabsTrigger value="portfolio">
              Portfolio
              {typeof portfolioCount === "number" && portfolioCount > 0 && (
                <span className="ml-1.5 px-1 py-0.5 text-[9px] rounded-sm bg-foreground/10 text-foreground tabular-nums">
                  {portfolioCount}
                </span>
              )}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="flex items-center gap-3">
        <a
          href={explorerObjectUrl(PACKAGE_ID)}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-muted-foreground hover:text-foreground font-mono"
          title={PACKAGE_ID}
        >
          pkg {shortAddr(PACKAGE_ID, 4, 4)}
        </a>
        <DynamicConnectButton />
      </div>
    </header>
  );
}
