/**
 * useDeepBookCandles — live OHLC candles + realised volatility for a DeepBook
 * pool, for the Wick Pro chart / CandleVision panel and honest BS pricing.
 *
 * Polls recent trades, aggregates them into fixed-width candles (epoch-aligned,
 * so every client sees the same bars), trims to a rolling window, and derives an
 * annualised σ from the series. σ is the input Wick Pro feeds to
 * `@sui-options/pro-options`'s `quote()` so premiums reflect the real
 * underlying's volatility instead of a guessed constant.
 *
 * Builds on the data layer in lib/deepbook.ts; pairs with useDeepBookMark
 * (top-of-book spot).
 */
import { useEffect, useRef, useState } from "react";
import {
  fetchDeepBookTrades,
  tradesToCandles,
  realizedVolatility,
  type Candle,
  type DeepBookPoolName,
  DEEPBOOK_POOLS,
} from "@/lib/deepbook";

export type DeepBookCandlesStatus = "connecting" | "live" | "stale";

export interface UseDeepBookCandlesResult {
  readonly candles: Candle[];
  /** Annualised realised volatility from the series — feed to BS `quote()`. */
  readonly sigma: number;
  readonly status: DeepBookCandlesStatus;
  readonly error: string | null;
}

export interface UseDeepBookCandlesOptions {
  /** Candle width in ms (default 60s). */
  readonly bucketMs?: number;
  /** Rolling window kept in state (default 90 minutes). */
  readonly windowMs?: number;
  /** Poll cadence (default 5s). */
  readonly pollMs?: number;
  /** Trades pulled per poll (default 500, the indexer max-ish). */
  readonly tradeLimit?: number;
}

export function useDeepBookCandles(
  pool: DeepBookPoolName = "SUI_USDC",
  options: UseDeepBookCandlesOptions = {},
): UseDeepBookCandlesResult {
  const bucketMs = options.bucketMs ?? 60_000;
  const windowMs = options.windowMs ?? 90 * 60_000;
  const pollMs = options.pollMs ?? 5_000;
  const tradeLimit = options.tradeLimit ?? 500;

  const [candles, setCandles] = useState<Candle[]>([]);
  const [sigma, setSigma] = useState<number>(0.6);
  const [status, setStatus] = useState<DeepBookCandlesStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const haveData = useRef(false);

  useEffect(() => {
    const poolName = DEEPBOOK_POOLS[pool].name;
    let cancelled = false;
    const controller = new AbortController();
    setStatus(haveData.current ? "stale" : "connecting");

    const tick = async () => {
      try {
        const trades = await fetchDeepBookTrades(
          poolName,
          tradeLimit,
          controller.signal,
        );
        if (cancelled) return;
        const all = tradesToCandles(trades, bucketMs);
        // Trim to the rolling window relative to the latest bar.
        const latest = all.length > 0 ? all[all.length - 1]!.tMs : 0;
        const kept = all.filter((c) => c.tMs >= latest - windowMs);
        haveData.current = kept.length > 0;
        setCandles(kept);
        setSigma(realizedVolatility(kept, bucketMs));
        setStatus("live");
        setError(null);
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setStatus(haveData.current ? "stale" : "connecting");
        setError(err instanceof Error ? err.message : String(err));
      }
    };

    void tick();
    const id = window.setInterval(() => void tick(), pollMs);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(id);
    };
  }, [pool, bucketMs, windowMs, pollMs, tradeLimit]);

  return { candles, sigma, status, error };
}
