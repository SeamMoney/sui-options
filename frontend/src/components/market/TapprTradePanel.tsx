import { useEffect, useMemo, useState } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
} from "@mysten/dapp-kit";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toaster";
import { useWalletBalance } from "@/hooks/useWalletBalance";
import { formatSui } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  COLLATERAL_TYPE,
  NETWORK,
  PACKAGE_ID,
  explorerTxUrl,
} from "@/lib/sui";
import {
  type MarketSnapshot,
  type Side,
  impliedTouchPrice,
} from "@/fixtures/markets";
import { buildBuyTx } from "@wick/sdk";

const GAS_HEADROOM_MIST = 50_000_000n;

const STAKES = [
  { label: "1K", value: 1_000 },
  { label: "10K", value: 10_000 },
  { label: "100K", value: 100_000 },
  { label: "1M", value: 1_000_000 },
  { label: "5M", value: 5_000_000 },
];

function cpmmOut(inAmt: number, inReserve: number, outReserve: number, feeBps: number) {
  if (inAmt <= 0) return 0;
  const inEff = (inAmt * (10_000 - feeBps)) / 10_000;
  return Math.floor((outReserve * inEff) / (inReserve + inEff));
}

interface TapprTradePanelProps {
  market: MarketSnapshot;
  isLive?: boolean;
}

export function TapprTradePanel({ market, isLive }: TapprTradePanelProps) {
  const [side, setSide] = useState<Side>("TOUCH");
  const [risk, setRisk] = useState(STAKES[2]?.value ?? 100_000);
  const account = useCurrentAccount();
  const queryClient = useQueryClient();
  const toast = useToast();
  const balance = useWalletBalance();
  const { mutate: signAndExecute, isPending } = useSignAndExecuteTransaction();

  const touchOdds = impliedTouchPrice(market.touchReserve, market.noTouchReserve);
  const noTouchOdds = 1 - touchOdds;
  const riskMist = BigInt(risk);
  const requiredMist = riskMist + GAS_HEADROOM_MIST;
  const totalSui = balance.data?.total ?? 0n;
  const largestCoin = balance.data?.largest ?? 0n;
  const dryWallet = !!account && balance.isFetched && totalSui === 0n;
  const insufficient =
    !!account && balance.isFetched && totalSui > 0n && totalSui < requiredMist;
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

  useEffect(() => {
    setSide("TOUCH");
  }, [market.id]);

  const preview = useMemo(() => {
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
  }, [market, risk, side]);

  const submit = () => {
    if (!canSubmit || !account) return;
    const toastId = toast.push({
      title: `Sign · ${side === "TOUCH" ? "Will hit" : "Won't hit"}`,
      description: `${formatSui(risk)} SUI on ${market.asset}`,
      tone: "pending",
    });
    const tx = buildBuyTx({
      packageId: PACKAGE_ID,
      collateralType: COLLATERAL_TYPE,
      sender: account.address,
      marketId: market.id,
      side,
      riskMist,
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

  const submitText = !isLive
    ? "Live markets unavailable"
    : !account
      ? "Connect wallet"
      : market.status !== "ACTIVE"
        ? `Market ${market.status.toLowerCase()}`
        : isPending
          ? "Signing..."
          : dryWallet
            ? "Wallet has no SUI"
            : insufficient
              ? "Insufficient balance"
              : noFatCoin
                ? "Coin split too small"
                : side === "TOUCH"
                  ? "Bet · Will hit"
                  : "Bet · Won't hit";

  return (
    <div className="rounded-lg border border-border bg-card/40 p-3">
      <div className="mb-3 grid grid-cols-2 gap-2">
        <SideButton
          label="Will hit"
          odds={touchOdds}
          active={side === "TOUCH"}
          tone="touch"
          onClick={() => setSide("TOUCH")}
        />
        <SideButton
          label="Won't hit"
          odds={noTouchOdds}
          active={side === "NO_TOUCH"}
          tone="noTouch"
          onClick={() => setSide("NO_TOUCH")}
        />
      </div>

      <div className="mb-2 flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase text-muted-foreground">
          Stake per tap
        </div>
        <div className="font-mono text-[11px] text-muted-foreground tabular-nums">
          available · {formatSui(totalSui.toString())} SUI
        </div>
      </div>

      <div className="grid grid-cols-5 gap-2">
        {STAKES.map((stake) => {
          const active = risk === stake.value;
          return (
            <button
              key={stake.label}
              type="button"
              onClick={() => setRisk(stake.value)}
              className={cn(
                "rounded-lg border px-2 py-3 font-mono text-sm font-semibold transition-colors",
                active
                  ? "border-sky-400 bg-sky-400/15 text-sky-300"
                  : "border-border bg-secondary/35 text-foreground/80 hover:bg-secondary",
              )}
            >
              {stake.label}
            </button>
          );
        })}
      </div>

      <div className="mt-3 grid gap-2 text-xs md:grid-cols-2">
        <div className="rounded-md bg-secondary/35 p-2">
          <div className="text-muted-foreground">Win</div>
          <div className="font-mono text-emerald-400 tabular-nums">
            +{preview.win.toLocaleString()} MIST
          </div>
        </div>
        <div className="rounded-md bg-secondary/35 p-2">
          <div className="text-muted-foreground">Lose</div>
          <div className="font-mono text-rose-400 tabular-nums">
            -{preview.lose.toLocaleString()} MIST
          </div>
        </div>
      </div>

      {account && (dryWallet || insufficient || noFatCoin) ? (
        <div className="mt-2 text-xs text-warning">
          {dryWallet ? (
            <a
              href={`https://faucet.sui.io/?address=${account.address}&network=${NETWORK}`}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              Get testnet SUI
            </a>
          ) : insufficient ? (
            <>Need {formatSui(requiredMist.toString())} SUI including gas.</>
          ) : (
            <>Largest coin is below risk plus gas.</>
          )}
        </div>
      ) : null}

      <Button
        size="xl"
        disabled={!canSubmit}
        onClick={submit}
        className={cn(
          "mt-3 h-12 w-full rounded-lg font-mono text-base",
          side === "TOUCH"
            ? "bg-emerald-400 text-emerald-950 hover:bg-emerald-300"
            : "bg-rose-400 text-rose-950 hover:bg-rose-300",
        )}
      >
        {submitText}
        {canSubmit ? (
          <span className="opacity-75">
            {formatSui(risk)} → {formatSui(preview.positionAmount)} SUI
          </span>
        ) : null}
      </Button>
    </div>
  );
}

function SideButton(props: {
  label: string;
  odds: number;
  active: boolean;
  tone: "touch" | "noTouch";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        "rounded-lg border p-3 text-left transition-colors",
        props.active
          ? props.tone === "touch"
            ? "border-emerald-400 bg-emerald-400/16"
            : "border-rose-400 bg-rose-400/16"
          : "border-border bg-secondary/30 hover:bg-secondary/55",
      )}
    >
      <div
        className={cn(
          "text-[11px] font-semibold uppercase",
          props.tone === "touch" ? "text-emerald-400" : "text-rose-400",
        )}
      >
        {props.label}
      </div>
      <div className="font-mono text-2xl font-bold tabular-nums">
        {Math.round(props.odds * 100)}
        <span className="text-base text-muted-foreground">%</span>
      </div>
    </button>
  );
}

export default TapprTradePanel;
