import { ScrollArea } from "@/components/ui/scroll-area";
import { type MarketSnapshot } from "@/fixtures/markets";
import { MarketRow } from "@/components/market/MarketRow";

interface MarketsRailProps {
  markets: MarketSnapshot[];
  selectedId: string;
  nowMs: number;
  onSelect: (id: string) => void;
}

export function MarketsRail({
  markets,
  selectedId,
  nowMs,
  onSelect,
}: MarketsRailProps) {
  const active = markets.filter((m) => m.status === "ACTIVE");
  return (
    <aside className="w-72 shrink-0 bg-card border-r border-border flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Markets
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {active.length}
        </span>
      </div>
      <ScrollArea className="flex-1">
        <div>
          {active.map((m) => (
            <MarketRow
              key={m.id}
              market={m}
              selected={m.id === selectedId}
              nowMs={nowMs}
              onSelect={onSelect}
            />
          ))}
        </div>
      </ScrollArea>
    </aside>
  );
}
