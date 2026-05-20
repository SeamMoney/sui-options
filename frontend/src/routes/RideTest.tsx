/**
 * /ride-test — hackathon de-risking spike.
 *
 * Validates the open_ride → poll → close_ride flow on a live testnet arcade
 * market BEFORE we wire the real gesture UI. Not part of the demo surface.
 *
 * Depends on `@/lib/wickRide` (built by a parallel agent) — a stub lives in
 * the same path so this page compiles even when the real wrapper has not
 * landed yet. The buttons will error visibly at runtime; that is intended.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ConnectButton,
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Button } from "@/components/ui/button";
import {
  buildCloseRideTx,
  buildOpenRideTx,
  getRidePosition,
  settlementLabel,
  type RidePositionState,
  type SuiClient,
} from "@/lib/wickRide";
import {
  pickArcadeMarket,
  TESTNET_DEPLOYMENT,
  type ArcadeMarketRecord,
} from "@/lib/deployments";
import { explorerObjectUrl, explorerTxUrl } from "@/lib/sui";
import { formatSui, shortAddr } from "@/lib/format";

/** Fixed test parameters per the spike spec. */
const TEST_ESCROW_MIST = 50_000_000n; // 0.05 SUI
const TEST_STAKE_RATE_MICRO_USD_PER_SEC = 1_000_000n; // $1/sec
const POLL_INTERVAL_MS = 500;

interface LogEntry {
  ts: number;
  level: "info" | "ok" | "warn" | "err";
  msg: string;
  digest?: string;
}

export function RideTest() {
  const account = useCurrentAccount();
  // dApp Kit returns the full-RPC client. wickRide's `SuiClient` is an alias
  // for `SuiJsonRpcClient` so a single cast covers both call sites.
  const sui = useSuiClient() as unknown as SuiJsonRpcClient & SuiClient;
  const { mutate: signAndExecute, isPending } = useSignAndExecuteTransaction();

  const packageId = TESTNET_DEPLOYMENT.package_id;
  const vaultId = TESTNET_DEPLOYMENT.vault_sui;
  const botRegistryId = TESTNET_DEPLOYMENT.bot_registry;
  const priceOracleId = TESTNET_DEPLOYMENT.usd_price_oracle;
  const wickTokenStateId = TESTNET_DEPLOYMENT.wick_token_state;
  const wickStakingPoolId = TESTNET_DEPLOYMENT.wick_staking_pool;

  const market = useMemo<ArcadeMarketRecord | null>(
    () => pickArcadeMarket(),
    [],
  );

  // Caps id is per-market and is not yet recorded in deployments/testnet.json.
  // The on-chain bootstrap (ride_market_caps::new + share) is a separate task.
  // Surface "not bootstrapped" until the ID lands.
  const capsId = (TESTNET_DEPLOYMENT as unknown as { ride_caps_sui?: string })
    .ride_caps_sui;
  const bootstrapped = Boolean(
    market &&
      vaultId &&
      capsId &&
      botRegistryId &&
      priceOracleId &&
      wickTokenStateId &&
      wickStakingPoolId,
  );

  const [positionId, setPositionId] = useState<string | null>(null);
  const [state, setState] = useState<RidePositionState | null>(null);
  const [closing, setClosing] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const counter = useRef(0);

  const append = useCallback((e: Omit<LogEntry, "ts">) => {
    counter.current += 1;
    setLog((cur) => [...cur, { ...e, ts: Date.now() }].slice(-100));
  }, []);

  // Poll the on-chain ride position state.
  useEffect(() => {
    if (!positionId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await getRidePosition(sui, positionId);
        if (!cancelled) setState(next);
      } catch (err) {
        if (!cancelled)
          append({ level: "warn", msg: `poll error: ${(err as Error).message}` });
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [positionId, sui, append]);

  const handleOpen = useCallback(() => {
    if (
      !account ||
      !market ||
      !vaultId ||
      !capsId ||
      !botRegistryId
    ) {
      append({
        level: "warn",
        msg: "cannot open: missing account or deployment fields",
      });
      return;
    }
    append({ level: "info", msg: "building open_ride tx…" });
    let tx;
    try {
      tx = buildOpenRideTx(
        {
          marketId: market.market,
          capsId,
          vaultId,
          oracleId: market.oracle,
          pathId: market.path,
          escrowMist: TEST_ESCROW_MIST,
          stakeRateMicroUsdPerSec: TEST_STAKE_RATE_MICRO_USD_PER_SEC,
          botRegistryId,
        },
        packageId,
        { kind: "Split", from: "gas", amount: TEST_ESCROW_MIST },
      );
    } catch (err) {
      append({ level: "err", msg: `buildOpenRideTx threw: ${(err as Error).message}` });
      return;
    }
    signAndExecute(
      { transaction: tx },
      {
        onSuccess: (res) => {
          append({ level: "ok", msg: `open_ride submitted`, digest: res.digest });
          // Re-fetch the tx for objectChanges so we can grab the RidePosition id.
          void sui
            .getTransactionBlock({
              digest: res.digest,
              options: { showObjectChanges: true, showEffects: true },
            })
            .then((tx) => {
              const created = tx.objectChanges?.find(
                (c) =>
                  c.type === "created" &&
                  "objectType" in c &&
                  c.objectType.includes("::ride_position::RidePosition"),
              );
              if (created && "objectId" in created) {
                setPositionId(created.objectId);
                append({
                  level: "ok",
                  msg: `RidePosition created: ${shortAddr(created.objectId)}`,
                });
              } else {
                append({
                  level: "warn",
                  msg: "no RidePosition objectChange found in tx response",
                });
              }
            })
            .catch((err) =>
              append({
                level: "warn",
                msg: `fetch tx failed: ${(err as Error).message}`,
              }),
            );
        },
        onError: (err) => {
          append({ level: "err", msg: `open_ride failed: ${err.message}` });
        },
      },
    );
  }, [
    account,
    market,
    vaultId,
    capsId,
    botRegistryId,
    packageId,
    signAndExecute,
    sui,
    append,
  ]);

  const handleClose = useCallback(() => {
    if (
      !positionId ||
      !market ||
      !vaultId ||
      !capsId ||
      !priceOracleId ||
      !wickTokenStateId ||
      !wickStakingPoolId
    ) {
      return;
    }
    setClosing(true);
    append({ level: "info", msg: "building close_ride tx…" });
    let tx;
    try {
      tx = buildCloseRideTx(
        {
          marketId: market.market,
          capsId,
          vaultId,
          oracleId: market.oracle,
          pathId: market.path,
          positionId,
          priceOracleId,
          wickTokenStateId,
          wickStakingPoolId,
        },
        packageId,
      );
    } catch (err) {
      append({ level: "err", msg: `buildCloseRideTx threw: ${(err as Error).message}` });
      setClosing(false);
      return;
    }
    signAndExecute(
      { transaction: tx },
      {
        onSuccess: (res) => {
          append({ level: "ok", msg: "close_ride submitted", digest: res.digest });
          setClosing(false);
        },
        onError: (err) => {
          append({ level: "err", msg: `close_ride failed: ${err.message}` });
          setClosing(false);
        },
      },
    );
  }, [
    positionId,
    market,
    vaultId,
    capsId,
    priceOracleId,
    wickTokenStateId,
    wickStakingPoolId,
    packageId,
    signAndExecute,
    append,
  ]);

  return (
    <div className="min-h-full bg-background text-foreground font-mono p-6">
      <header className="flex items-center justify-between border-b border-border pb-4 mb-6">
        <div>
          <h1 className="text-lg font-semibold">
            Ride Test — Sui Integration Spike
          </h1>
          <p className="text-[11px] text-muted-foreground mt-1">
            open_ride → poll state → close_ride against an arcade market on{" "}
            {TESTNET_DEPLOYMENT.network}. Not part of the demo.
          </p>
        </div>
        <ConnectButton connectText="Connect wallet" />
      </header>

      {!account ? (
        <div className="rounded-sm border border-border bg-card p-6 text-center text-sm text-muted-foreground">
          Connect a Sui wallet to begin.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <section>
            <h2 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
              Target market
            </h2>
            {bootstrapped && market ? (
              <IdTable
                rows={[
                  ["name", market.name],
                  ["market", market.market],
                  ["oracle", market.oracle],
                  ["path", market.path],
                  ["vault", vaultId!],
                  ["caps", capsId!],
                  ["bot_registry", botRegistryId!],
                  ["usd_price_oracle", priceOracleId!],
                  ["wick_token_state", wickTokenStateId!],
                  ["wick_staking_pool", wickStakingPoolId!],
                  ["package", packageId],
                ]}
              />
            ) : (
              <div className="rounded-sm border border-[color:var(--color-warning)]/40 bg-card p-4 text-[11px] text-[color:var(--color-warning)]">
                not bootstrapped — missing fields:
                <ul className="mt-2 ml-4 list-disc text-muted-foreground">
                  {!market && <li>no arcade_markets in deployments/testnet.json</li>}
                  {!vaultId && <li>no vault_sui in deployments/testnet.json</li>}
                  {!capsId && (
                    <li>
                      no ride_caps_sui in deployments/testnet.json (add after
                      bootstrap_ride_market_caps)
                    </li>
                  )}
                  {!botRegistryId && <li>no bot_registry in deployments/testnet.json</li>}
                  {!priceOracleId && <li>no usd_price_oracle in deployments/testnet.json</li>}
                  {!wickTokenStateId && <li>no wick_token_state in deployments/testnet.json</li>}
                  {!wickStakingPoolId && <li>no wick_staking_pool in deployments/testnet.json</li>}
                </ul>
              </div>
            )}

            <div className="mt-4 flex flex-col gap-2">
              <Button
                onClick={handleOpen}
                disabled={!bootstrapped || isPending || !!positionId}
                className="font-mono"
              >
                {isPending && !closing
                  ? "Signing…"
                  : positionId
                    ? "Ride open — close it below"
                    : `Open 5-second test ride (${formatSui(TEST_ESCROW_MIST.toString())} SUI)`}
              </Button>
              {positionId && (
                <Button
                  variant="destructive"
                  onClick={handleClose}
                  disabled={closing || isPending}
                  className="font-mono"
                >
                  {closing || isPending ? "Signing…" : "Close ride"}
                </Button>
              )}
            </div>
          </section>

          <section>
            <h2 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
              Ride position state{" "}
              {positionId && (
                <span className="text-foreground/60 normal-case">
                  · polling every {POLL_INTERVAL_MS}ms
                </span>
              )}
            </h2>
            {!positionId ? (
              <div className="rounded-sm border border-border bg-card p-4 text-[11px] text-muted-foreground">
                No position yet — open a ride to start polling.
              </div>
            ) : !state ? (
              <div className="rounded-sm border border-border bg-card p-4 text-[11px] text-muted-foreground">
                position id captured ({shortAddr(positionId)}) — waiting for
                first read…
              </div>
            ) : (
              <IdTable
                rows={[
                  ["positionId", state.positionId],
                  ["user", state.user],
                  ["marketId", state.marketId],
                  ["pathId", state.pathId],
                  ["capsId", state.capsId],
                  [
                    "stake_paid (mist, computed)",
                    state.stakePaid.toString(),
                  ],
                  ["escrowed (mist)", state.escrowed.toString()],
                  [
                    "stake_rate (μusd/sec)",
                    state.stakeRateMicroUsdPerSec.toString(),
                  ],
                  ["start_time_ms", state.startTimeMs.toString()],
                  ["multiplier_bps", state.multiplierBps.toString()],
                  ["is_bot_eligible", state.isBotEligible ? "true" : "false"],
                  ["closed", state.closed ? "true" : "false"],
                  ["closed_at_ms", state.closedAtMs.toString()],
                  [
                    "settlement_kind",
                    `${state.settlementKind} (${settlementLabel(state.settlementKind)})`,
                  ],
                ]}
              />
            )}
          </section>
        </div>
      )}

      <section className="mt-8">
        <h2 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
          Status log
        </h2>
        <div className="rounded-sm border border-border bg-card max-h-64 overflow-auto">
          {log.length === 0 ? (
            <div className="p-3 text-[11px] text-muted-foreground">
              No events yet.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {log.map((e, i) => (
                <li
                  key={`${e.ts}-${i}`}
                  className="px-3 py-1.5 text-[11px] flex items-baseline gap-3"
                >
                  <span className="text-muted-foreground tabular-nums shrink-0">
                    {new Date(e.ts).toLocaleTimeString()}
                  </span>
                  <span className={`shrink-0 ${toneFor(e.level)}`}>
                    {e.level.toUpperCase()}
                  </span>
                  <span className="text-foreground break-all">{e.msg}</span>
                  {e.digest && (
                    <a
                      className="ml-auto underline underline-offset-2 text-muted-foreground hover:text-foreground shrink-0"
                      href={explorerTxUrl(e.digest)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      tx
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function toneFor(level: LogEntry["level"]): string {
  switch (level) {
    case "ok":
      return "text-[color:var(--color-touch)]";
    case "warn":
      return "text-[color:var(--color-warning)]";
    case "err":
      return "text-[color:var(--color-no-touch)]";
    default:
      return "text-muted-foreground";
  }
}

function IdTable({ rows }: { rows: [string, string][] }) {
  return (
    <div className="rounded-sm border border-border bg-card text-[11px]">
      <table className="w-full">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} className="border-b border-border last:border-b-0">
              <td className="px-3 py-1.5 text-muted-foreground w-44 align-top">
                {k}
              </td>
              <td className="px-3 py-1.5 break-all">
                {v.startsWith("0x") ? (
                  <a
                    href={explorerObjectUrl(v)}
                    target="_blank"
                    rel="noreferrer"
                    className="underline-offset-2 hover:underline"
                  >
                    {v}
                  </a>
                ) : (
                  v
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
