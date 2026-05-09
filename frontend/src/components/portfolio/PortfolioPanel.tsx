import { useMemo, useState } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
} from "@mysten/dapp-kit";
import { useQueryClient } from "@tanstack/react-query";
import {
  buildRedeemWinnerTx,
  buildRedeemLpTx,
  type LpPositionSnapshot,
  type MarketSnapshot,
  type PositionSnapshot,
} from "@wick/sdk";
import { Button } from "@/components/ui/button";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useLiveMarkets } from "@/hooks/useLiveMarkets";
import { useToast } from "@/components/ui/toaster";
import {
  COLLATERAL_TYPE,
  PACKAGE_ID,
  explorerObjectUrl,
  explorerTxUrl,
} from "@/lib/sui";
import { formatSui, shortAddr } from "@/lib/format";
import { cn } from "@/lib/utils";

export function PortfolioPanel() {
  const account = useCurrentAccount();
  const portfolio = usePortfolio();
  const live = useLiveMarkets();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { mutate: signAndExecute, isPending } = useSignAndExecuteTransaction();
  const [pendingId, setPendingId] = useState<string | null>(null);

  const marketsById = useMemo(() => {
    const map = new Map<string, MarketSnapshot>();
    for (const m of live.data ?? []) map.set(m.id, m);
    return map;
  }, [live.data]);

  if (!account) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm font-mono">
        Connect a wallet to see your positions.
      </div>
    );
  }

  const positions = portfolio.data?.positions ?? [];
  const lpPositions = portfolio.data?.lpPositions ?? [];

  const settledPositions = positions.filter((p) => {
    const m = marketsById.get(p.marketId);
    if (!m) return false;
    if (m.status === "HIT" && p.side === "TOUCH") return true;
    if (m.status === "EXPIRED" && p.side === "NO_TOUCH") return true;
    return false;
  });
  const activePositions = positions.filter(
    (p) => marketsById.get(p.marketId)?.status === "ACTIVE",
  );
  const losingPositions = positions.filter((p) => {
    const m = marketsById.get(p.marketId);
    if (!m) return false;
    if (m.status === "HIT" && p.side === "NO_TOUCH") return true;
    if (m.status === "EXPIRED" && p.side === "TOUCH") return true;
    return false;
  });

  const settledLp = lpPositions.filter(
    (l) => marketsById.get(l.marketId)?.status !== "ACTIVE",
  );
  const activeLp = lpPositions.filter(
    (l) => marketsById.get(l.marketId)?.status === "ACTIVE",
  );

  const onRedeemWinner = (p: PositionSnapshot) => {
    const m = marketsById.get(p.marketId);
    if (!m || !account) return;
    setPendingId(p.id);
    const toastId = toast.push({
      title: "Sign · redeem winner",
      description: `${formatSui(p.amount)} SUI · ${p.side}`,
      tone: "pending",
    });
    const tx = buildRedeemWinnerTx({
      packageId: PACKAGE_ID,
      collateralType: m.collateralType ?? COLLATERAL_TYPE,
      sender: account.address,
      marketId: p.marketId,
      positionId: p.id,
    });
    signAndExecute(
      { transaction: tx },
      {
        onSuccess: (res) => {
          toast.update(toastId, {
            title: "Payout claimed",
            description: `${formatSui(p.amount)} SUI`,
            tone: "success",
            href: explorerTxUrl(res.digest),
            hrefLabel: "view tx",
            ttlMs: 7000,
          });
          setPendingId(null);
          queryClient.invalidateQueries({ queryKey: ["wick", "portfolio"] });
          queryClient.invalidateQueries({ queryKey: ["wick", "markets"] });
        },
        onError: (err) => {
          toast.update(toastId, {
            title: "Redeem failed",
            description: (err as Error).message,
            tone: "error",
            ttlMs: 10000,
          });
          setPendingId(null);
        },
      },
    );
  };

  const onRedeemLp = (l: LpPositionSnapshot) => {
    const m = marketsById.get(l.marketId);
    if (!m || !account) return;
    setPendingId(l.id);
    const toastId = toast.push({
      title: "Sign · LP claim",
      description: `${l.shares.toLocaleString()} shares`,
      tone: "pending",
    });
    const tx = buildRedeemLpTx({
      packageId: PACKAGE_ID,
      collateralType: m.collateralType ?? COLLATERAL_TYPE,
      sender: account.address,
      marketId: l.marketId,
      lpPositionId: l.id,
    });
    signAndExecute(
      { transaction: tx },
      {
        onSuccess: (res) => {
          toast.update(toastId, {
            title: "LP claim sent",
            description: `${l.shares.toLocaleString()} shares burned`,
            tone: "success",
            href: explorerTxUrl(res.digest),
            hrefLabel: "view tx",
            ttlMs: 7000,
          });
          setPendingId(null);
          queryClient.invalidateQueries({ queryKey: ["wick", "portfolio"] });
          queryClient.invalidateQueries({ queryKey: ["wick", "markets"] });
        },
        onError: (err) => {
          toast.update(toastId, {
            title: "LP claim failed",
            description: (err as Error).message,
            tone: "error",
            ttlMs: 10000,
          });
          setPendingId(null);
        },
      },
    );
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-6 font-mono text-sm">
      <Section
        title="Redeemable winners"
        subtitle="market settled in your side's favor — claim payout"
      >
        {settledPositions.length === 0 ? (
          <Empty>No winning positions to redeem right now.</Empty>
        ) : (
          settledPositions.map((p) => (
            <PositionRow
              key={p.id}
              position={p}
              market={marketsById.get(p.marketId) ?? null}
              action={
                <Button
                  size="sm"
                  variant="touch"
                  disabled={isPending}
                  onClick={() => onRedeemWinner(p)}
                  className="font-mono text-xs"
                >
                  {pendingId === p.id ? "Signing…" : "Redeem"}
                </Button>
              }
            />
          ))
        )}
      </Section>

      <Section title="Open positions" subtitle="market still active">
        {activePositions.length === 0 ? (
          <Empty>No open positions.</Empty>
        ) : (
          activePositions.map((p) => (
            <PositionRow
              key={p.id}
              position={p}
              market={marketsById.get(p.marketId) ?? null}
            />
          ))
        )}
      </Section>

      {losingPositions.length > 0 && (
        <Section title="Settled losers" subtitle="no payout — kept for record">
          {losingPositions.map((p) => (
            <PositionRow
              key={p.id}
              position={p}
              market={marketsById.get(p.marketId) ?? null}
              dim
            />
          ))}
        </Section>
      )}

      <Section
        title="LP shares — redeemable"
        subtitle="settled markets, claim winning-side reserve"
      >
        {settledLp.length === 0 ? (
          <Empty>No redeemable LP claims.</Empty>
        ) : (
          settledLp.map((l) => (
            <LpRow
              key={l.id}
              lp={l}
              market={marketsById.get(l.marketId) ?? null}
              action={
                <Button
                  size="sm"
                  variant="touch"
                  disabled={isPending}
                  onClick={() => onRedeemLp(l)}
                  className="font-mono text-xs"
                >
                  {pendingId === l.id ? "Signing…" : "Claim"}
                </Button>
              }
            />
          ))
        )}
      </Section>

      {activeLp.length > 0 && (
        <Section title="LP shares — locked" subtitle="market still active">
          {activeLp.map((l) => (
            <LpRow
              key={l.id}
              lp={l}
              market={marketsById.get(l.marketId) ?? null}
              dim
            />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-baseline gap-3 mb-2">
        <h3 className="text-xs uppercase tracking-wider text-foreground">{title}</h3>
        {subtitle && (
          <span className="text-[10px] text-muted-foreground">{subtitle}</span>
        )}
      </div>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] text-muted-foreground py-2 px-3 bg-card/40 rounded-sm">
      {children}
    </div>
  );
}

function PositionRow({
  position,
  market,
  action,
  dim,
}: {
  position: PositionSnapshot;
  market: MarketSnapshot | null;
  action?: React.ReactNode;
  dim?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[1fr_auto_auto_auto] gap-3 items-center px-3 py-2 bg-card/60 rounded-sm border border-border/40",
        dim && "opacity-50",
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[11px]">
          <a
            href={explorerObjectUrl(position.id)}
            target="_blank"
            rel="noreferrer"
            className="underline-offset-2 hover:underline text-foreground"
          >
            {shortAddr(position.id, 6, 4)}
          </a>
          <span
            className={cn(
              "px-1.5 py-0.5 text-[9px] rounded-sm uppercase tracking-wider",
              position.side === "TOUCH"
                ? "text-[color:var(--color-touch)] border border-[color:var(--color-touch)]/40"
                : "text-[color:var(--color-no-touch)] border border-[color:var(--color-no-touch)]/40",
            )}
          >
            {position.side}
          </span>
          {market && (
            <span className="text-[10px] text-muted-foreground">
              {market.asset} {market.direction === "ABOVE" ? "≥" : "≤"}{" "}
              {market.barrier.toLocaleString()}
            </span>
          )}
        </div>
        {market && (
          <div className="text-[10px] text-muted-foreground mt-0.5">
            status:{" "}
            <span
              className={cn(
                market.status === "HIT" && "text-[color:var(--color-touch)]",
                market.status === "EXPIRED" && "text-[color:var(--color-no-touch)]",
              )}
            >
              {market.status}
            </span>
          </div>
        )}
      </div>
      <div className="text-right text-[11px] tabular-nums">
        {formatSui(position.amount)} SUI
      </div>
      <div className="text-right text-[10px] text-muted-foreground tabular-nums w-24">
        {position.amount.toLocaleString()} mist
      </div>
      <div className="w-20 text-right">{action}</div>
    </div>
  );
}

function LpRow({
  lp,
  market,
  action,
  dim,
}: {
  lp: LpPositionSnapshot;
  market: MarketSnapshot | null;
  action?: React.ReactNode;
  dim?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[1fr_auto_auto_auto] gap-3 items-center px-3 py-2 bg-card/60 rounded-sm border border-border/40",
        dim && "opacity-50",
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[11px]">
          <a
            href={explorerObjectUrl(lp.id)}
            target="_blank"
            rel="noreferrer"
            className="underline-offset-2 hover:underline text-foreground"
          >
            {shortAddr(lp.id, 6, 4)}
          </a>
          <span className="px-1.5 py-0.5 text-[9px] rounded-sm uppercase tracking-wider text-foreground border border-border">
            LP
          </span>
          {market && (
            <span className="text-[10px] text-muted-foreground">
              {market.asset} {market.direction === "ABOVE" ? "≥" : "≤"}{" "}
              {market.barrier.toLocaleString()}
            </span>
          )}
        </div>
        {market && (
          <div className="text-[10px] text-muted-foreground mt-0.5">
            status:{" "}
            <span
              className={cn(
                market.status === "HIT" && "text-[color:var(--color-touch)]",
                market.status === "EXPIRED" && "text-[color:var(--color-no-touch)]",
              )}
            >
              {market.status}
            </span>
          </div>
        )}
      </div>
      <div className="text-right text-[11px] tabular-nums">
        {lp.shares.toLocaleString()} shares
      </div>
      <div className="text-right text-[10px] text-muted-foreground tabular-nums w-24">
        {market ? `pool ${market.lpSupply.toLocaleString()}` : ""}
      </div>
      <div className="w-20 text-right">{action}</div>
    </div>
  );
}
