import { type MarketSnapshot, impliedTouchPrice } from "@/fixtures/markets";
import { formatPriceCents, timeUntil } from "@/lib/format";
import { cn } from "@/lib/utils";

interface MarketRowProps {
  market: MarketSnapshot;
  selected: boolean;
  nowMs: number;
  onSelect: (id: string) => void;
}

export function MarketRow({ market, selected, nowMs, onSelect }: MarketRowProps) {
  const touchProb = impliedTouchPrice(market.touchReserve, market.noTouchReserve);
  const noTouchProb = 1 - touchProb;
  const tt = timeUntil(market.expiryMs, nowMs);

  return (
    <button
      onClick={() => onSelect(market.id)}
      className={cn(
        "w-full text-left flex flex-col gap-1.5 px-3 py-2.5 border-b border-border transition-colors",
        selected ? "bg-accent/40" : "hover:bg-accent/15",
      )}
    >
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2 font-medium">
          <span>{prettyAsset(market.asset)}</span>
          <span
            className={cn(
              "text-base leading-none",
              market.direction === "ABOVE" ? "text-touch" : "text-no-touch",
            )}
          >
            {market.direction === "ABOVE" ? "↑" : "↓"}
          </span>
          <span className="font-mono tabular-nums">
            {formatPriceCents(market.barrier)}
          </span>
        </div>
        <span
          className={cn(
            "font-mono text-[11px] tabular-nums",
            tt.expired
              ? "text-no-touch"
              : tt.label.startsWith("0m")
                ? "text-warning"
                : "text-muted-foreground",
          )}
        >
          {tt.label}
        </span>
      </div>

      <div className="flex items-stretch h-5 rounded-sm overflow-hidden bg-muted">
        <div
          className="bg-touch flex items-center pl-1.5 transition-all"
          style={{ width: `${touchProb * 100}%` }}
        >
          {touchProb > 0.18 && (
            <span className="font-mono text-[10px] font-semibold text-success-foreground tabular-nums">
              {Math.round(touchProb * 100)}
            </span>
          )}
        </div>
        <div
          className="bg-no-touch flex items-center justify-end pr-1.5 transition-all"
          style={{ width: `${noTouchProb * 100}%` }}
        >
          {noTouchProb > 0.18 && (
            <span className="font-mono text-[10px] font-semibold text-destructive-foreground tabular-nums">
              {Math.round(noTouchProb * 100)}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between text-[10px] text-muted-foreground font-mono tabular-nums">
        <span>spot {formatPriceCents(market.underlyingPrice)}</span>
        <span>
          {market.direction === "ABOVE" ? "+" : "−"}
          {Math.abs(
            ((market.barrier - market.underlyingPrice) /
              market.underlyingPrice) *
              100,
          ).toFixed(2)}
          %
        </span>
      </div>
    </button>
  );
}

function prettyAsset(asset: string) {
  return asset.split("/")[0];
}
