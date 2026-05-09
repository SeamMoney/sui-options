import {
  type MarketSnapshot,
  impliedTouchPrice,
} from "@/fixtures/markets";
import { formatPriceCents, timeUntil } from "@/lib/format";
import { cn } from "@/lib/utils";

interface MarketHeaderProps {
  market: MarketSnapshot;
  nowMs: number;
}

export function MarketHeader({ market, nowMs }: MarketHeaderProps) {
  const touch = impliedTouchPrice(market.touchReserve, market.noTouchReserve);
  const tt = timeUntil(market.expiryMs, nowMs);
  const distancePct =
    ((market.barrier - market.underlyingPrice) / market.underlyingPrice) * 100;

  return (
    <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-card/40">
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-2.5">
          <span className="text-base font-semibold">
            {prettyAsset(market.asset)}
          </span>
          <span
            className={cn(
              "text-2xl leading-none",
              market.direction === "ABOVE" ? "text-touch" : "text-no-touch",
            )}
          >
            {market.direction === "ABOVE" ? "↑" : "↓"}
          </span>
          <span className="font-mono text-base tabular-nums">
            {formatPriceCents(market.barrier)}
          </span>
        </div>

        <div className="h-6 w-px bg-border" />

        <Chip label="Spot" value={formatPriceCents(market.underlyingPrice)} />
        <Chip
          label="Δ"
          value={`${distancePct >= 0 ? "+" : ""}${distancePct.toFixed(2)}%`}
          tone={
            Math.abs(distancePct) < 0.5
              ? "warning"
              : distancePct >= 0
                ? "touch"
                : "noTouch"
          }
        />
        <Chip
          label="Ends"
          value={tt.label}
          tone={
            tt.expired
              ? "noTouch"
              : tt.label.startsWith("0m")
                ? "warning"
                : undefined
          }
        />
        <Chip label="Fee" value={`${(market.fee_bps / 100).toFixed(2)}%`} />
      </div>

      <div className="flex items-stretch gap-px rounded-sm overflow-hidden bg-muted h-9 w-56">
        <div
          className="bg-touch flex flex-col items-center justify-center px-2 transition-all"
          style={{ width: `${touch * 100}%` }}
        >
          {touch > 0.15 && (
            <span className="font-mono text-xs font-semibold text-success-foreground tabular-nums leading-tight">
              {Math.round(touch * 100)}
            </span>
          )}
        </div>
        <div
          className="bg-no-touch flex flex-col items-center justify-center px-2 transition-all"
          style={{ width: `${(1 - touch) * 100}%` }}
        >
          {1 - touch > 0.15 && (
            <span className="font-mono text-xs font-semibold text-destructive-foreground tabular-nums leading-tight">
              {Math.round((1 - touch) * 100)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function Chip({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "touch" | "noTouch" | "warning";
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "font-mono text-xs tabular-nums",
          tone === "touch" && "text-touch",
          tone === "noTouch" && "text-no-touch",
          tone === "warning" && "text-warning",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function prettyAsset(asset: string) {
  return asset.split("/")[0];
}
