import { useEffect, useMemo, useState } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
} from "@mysten/dapp-kit";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type MarketSnapshot,
  type Side,
  impliedTouchPrice,
} from "@/fixtures/markets";
import { formatSui } from "@/lib/format";
import { cn } from "@/lib/utils";
import { buildBuyTx } from "@wick/sdk";
import { explorerTxUrl, PACKAGE_ID, COLLATERAL_TYPE, NETWORK } from "@/lib/sui";
import { useToast } from "@/components/ui/toaster";
import { useWalletBalance } from "@/hooks/useWalletBalance";

/** Conservative gas headroom we keep above the bet amount before submitting. */
const GAS_HEADROOM_MIST = 50_000_000n;  // 0.05 SUI

interface TradePanelProps {
  market: MarketSnapshot;
  isLive?: boolean;
}

function cpmmOut(inAmt: number, inReserve: number, outReserve: number, feeBps: number) {
  if (inAmt <= 0) return 0;
  const inEff = (inAmt * (10_000 - feeBps)) / 10_000;
  const out = (outReserve * inEff) / (inReserve + inEff);
  return Math.floor(out);
}

const PRESETS = [
  { label: "1K", value: 1_000 },
  { label: "10K", value: 10_000 },
  { label: "100K", value: 100_000 },
  { label: "1M", value: 1_000_000 },
];

export function TradePanel({ market, isLive }: TradePanelProps) {
  const [side, setSide] = useState<Side>("TOUCH");
  const [risk, setRisk] = useState<number>(100_000);
  const account = useCurrentAccount();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { mutate: signAndExecute, isPending } = useSignAndExecuteTransaction();
  const balance = useWalletBalance();

  const riskMist = BigInt(risk);
  const requiredMist = riskMist + GAS_HEADROOM_MIST;
  const totalSui = balance.data?.total ?? 0n;
  const largestCoin = balance.data?.largest ?? 0n;
  const dryWallet = !!account && balance.isFetched && totalSui === 0n;
  const insufficient =
    !!account && balance.isFetched && totalSui > 0n && totalSui < requiredMist;
  // Sui needs at least one coin big enough to cover risk + gas. We can't
  // assume the wallet auto-merges before signing.
  const noFatCoin =
    !!account && balance.isFetched && totalSui >= requiredMist && largestCoin < requiredMist;

  const canSubmit =
    isLive &&
    !!account &&
    market.status === "ACTIVE" &&
    risk > 0 &&
    !isPending &&
    !dryWallet &&
    !insufficient &&
    !noFatCoin;

  const submit = () => {
    if (!canSubmit || !account) return;
    const toastId = toast.push({
      title: `Sign · ${side === "TOUCH" ? "Will hit" : "Won't hit"}`,
      description: `${formatSui(risk)} SUI on ${market.asset} ${market.direction === "ABOVE" ? "≥" : "≤"} ${market.barrier.toLocaleString()}`,
      tone: "pending",
    });
    const tx = buildBuyTx({
      packageId: PACKAGE_ID,
      collateralType: COLLATERAL_TYPE,
      sender: account.address,
      marketId: market.id,
      side,
      riskMist: BigInt(risk),
    });
    signAndExecute(
      { transaction: tx },
      {
        onSuccess: (res) => {
          toast.update(toastId, {
            title: "Bet placed",
            description: `${formatSui(risk)} SUI · ${side}`,
            tone: "success",
            href: explorerTxUrl(res.digest),
            hrefLabel: "view tx",
            ttlMs: 7000,
          });
          queryClient.invalidateQueries({ queryKey: ["wick", "markets", PACKAGE_ID] });
          queryClient.invalidateQueries({ queryKey: ["wick", "portfolio"] });
        },
        onError: (err) => {
          toast.update(toastId, {
            title: "Bet failed",
            description: (err as Error).message,
            tone: "error",
            ttlMs: 10000,
          });
        },
      },
    );
  };

  const sliderMax = Math.max(
    1_000_000,
    Math.min(market.touchReserve, market.noTouchReserve),
  );

  useEffect(() => {
    setRisk((r) => Math.min(r, sliderMax));
  }, [market.id, sliderMax]);

  const touchOdds = impliedTouchPrice(market.touchReserve, market.noTouchReserve);
  const noTouchOdds = 1 - touchOdds;

  const preview = useMemo(() => {
    if (!risk) return null;
    const wantedReserve =
      side === "TOUCH" ? market.touchReserve : market.noTouchReserve;
    const otherReserve =
      side === "TOUCH" ? market.noTouchReserve : market.touchReserve;
    const x = cpmmOut(risk, otherReserve, wantedReserve, market.fee_bps);
    const positionAmount = risk + x;
    return {
      positionAmount,
      win: positionAmount - risk,
      lose: risk,
    };
  }, [risk, side, market]);

  return (
    <div className="border-t border-border bg-card flex flex-col">
      <div className="grid grid-cols-2">
        <SideTab
          tone="touch"
          active={side === "TOUCH"}
          onClick={() => setSide("TOUCH")}
          label="Will hit"
          odds={touchOdds}
        />
        <SideTab
          tone="noTouch"
          active={side === "NO_TOUCH"}
          onClick={() => setSide("NO_TOUCH")}
          label="Won't hit"
          odds={noTouchOdds}
        />
      </div>

      <div className="px-4 py-3 flex items-center gap-3 border-t border-border">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground shrink-0">
          Risk
        </span>
        <input
          type="range"
          min={0}
          max={sliderMax}
          step={Math.max(1, Math.floor(sliderMax / 200))}
          value={risk}
          onChange={(e) => setRisk(Number(e.target.value))}
          className="flex-1 accent-foreground"
        />
        <div className="relative w-32">
          <Input
            value={risk.toString()}
            onChange={(e) =>
              setRisk(Number(e.target.value.replace(/[^0-9]/g, "")) || 0)
            }
            inputMode="numeric"
            className="pr-12 h-8 text-right"
          />
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground font-mono">
            MIST
          </span>
        </div>
        <div className="flex gap-1">
          {PRESETS.map((p) => (
            <Button
              key={p.label}
              variant="ghost"
              size="sm"
              onClick={() => setRisk(p.value)}
              className="h-7 px-2 text-[10px] font-mono"
            >
              {p.label}
            </Button>
          ))}
        </div>
        <span className="text-[10px] text-muted-foreground font-mono shrink-0 w-20 text-right">
          {formatSui(risk)} SUI
        </span>
      </div>

      {preview && preview.positionAmount > 0 && (
        <div className="px-4 pb-3 flex flex-col gap-1.5">
          <PayoffBar
            label="Win"
            tone="touch"
            amount={preview.win}
            unit="MIST"
            fill={preview.win / Math.max(preview.win, preview.lose)}
          />
          <PayoffBar
            label="Lose"
            tone="noTouch"
            amount={-preview.lose}
            unit="MIST"
            fill={preview.lose / Math.max(preview.win, preview.lose)}
          />
        </div>
      )}

      {account && (
        <div className="px-4 pb-2 flex items-center justify-between text-[10px] font-mono">
          <span className="text-muted-foreground">
            wallet bal{" "}
            <span className="text-foreground tabular-nums">
              {formatSui(totalSui.toString())} SUI
            </span>
          </span>
          {dryWallet && (
            <a
              href={`https://faucet.sui.io/?address=${account.address}&network=${NETWORK}`}
              target="_blank"
              rel="noreferrer"
              className="text-[color:var(--color-warning)] underline underline-offset-2 hover:opacity-80"
            >
              get testnet SUI →
            </a>
          )}
          {insufficient && !dryWallet && (
            <span className="text-[color:var(--color-no-touch)]">
              need {formatSui(requiredMist.toString())} SUI (risk + gas)
            </span>
          )}
          {noFatCoin && !insufficient && (
            <span className="text-[color:var(--color-warning)]">
              largest coin {formatSui(largestCoin.toString())} SUI &lt; risk + gas
            </span>
          )}
        </div>
      )}

      <Button
        variant={side === "TOUCH" ? "touch" : "noTouch"}
        size="xl"
        disabled={!canSubmit}
        onClick={submit}
        className="rounded-none font-mono text-base h-12"
      >
        {!isLive
          ? "Stub data — no live markets to bet on"
          : !account
            ? "Connect wallet"
            : market.status !== "ACTIVE"
              ? `Market ${market.status}`
              : isPending
                ? "Signing…"
                : dryWallet
                  ? "Wallet has no SUI"
                  : insufficient
                    ? "Insufficient balance"
                    : noFatCoin
                      ? "No single coin big enough"
                      : side === "TOUCH"
                        ? "Bet · Will hit"
                        : "Bet · Won't hit"}
        {isLive &&
          account &&
          market.status === "ACTIVE" &&
          !isPending &&
          !dryWallet &&
          !insufficient &&
          !noFatCoin &&
          preview &&
          preview.positionAmount > 0 && (
            <span className="ml-2 opacity-80 font-mono text-sm">
              {formatSui(risk)} → {formatSui(preview.positionAmount)} SUI
            </span>
          )}
      </Button>
    </div>
  );
}

function SideTab({
  tone,
  active,
  onClick,
  label,
  odds,
}: {
  tone: "touch" | "noTouch";
  active: boolean;
  onClick: () => void;
  label: string;
  odds: number;
}) {
  const baseClasses = cn(
    "flex flex-col items-center justify-center gap-0.5 py-3 transition-colors",
    tone === "touch"
      ? active
        ? "bg-touch text-success-foreground"
        : "hover:bg-touch/10 text-touch"
      : active
        ? "bg-no-touch text-destructive-foreground"
        : "hover:bg-no-touch/10 text-no-touch",
  );
  return (
    <button onClick={onClick} className={baseClasses}>
      <span className="text-[10px] uppercase tracking-wider opacity-80">
        {label}
      </span>
      <span className="font-mono text-2xl font-semibold tabular-nums leading-none">
        {Math.round(odds * 100)}
        <span className="text-base ml-0.5 opacity-80">%</span>
      </span>
    </button>
  );
}

function PayoffBar({
  label,
  tone,
  amount,
  unit,
  fill,
}: {
  label: string;
  tone: "touch" | "noTouch";
  amount: number;
  unit: string;
  fill: number;
}) {
  return (
    <div className="flex items-center gap-3">
      <span
        className={cn(
          "text-[10px] uppercase tracking-wider w-8 shrink-0",
          tone === "touch" ? "text-touch" : "text-no-touch",
        )}
      >
        {label}
      </span>
      <div className="flex-1 h-5 bg-muted rounded-sm overflow-hidden">
        <div
          className={cn(
            "h-full transition-all",
            tone === "touch" ? "bg-touch" : "bg-no-touch",
          )}
          style={{ width: `${Math.max(2, Math.min(100, fill * 100))}%` }}
        />
      </div>
      <span
        className={cn(
          "font-mono text-sm tabular-nums w-32 text-right",
          tone === "touch" ? "text-touch" : "text-no-touch",
        )}
      >
        {amount >= 0 ? "+" : ""}
        {amount.toLocaleString()} {unit}
      </span>
    </div>
  );
}
