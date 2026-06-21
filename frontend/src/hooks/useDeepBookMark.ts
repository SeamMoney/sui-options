/**
 * useDeepBookMark — live top-of-book mark for a DeepBook pool.
 *
 * Polls fetchDeepBookMark on an interval and exposes the latest mid plus a
 * coarse connection status, so Wick Pro can price options against a moving
 * real-CLOB spot. Keeps the last good mark visible through a transient fetch
 * error (status flips to "stale") rather than blanking the price.
 */
import { useEffect, useRef, useState } from "react";
import {
  fetchDeepBookMark,
  type DeepBookMark,
  type DeepBookPoolName,
  DEEPBOOK_POOLS,
} from "@/lib/deepbook";

export type DeepBookMarkStatus = "connecting" | "live" | "stale";

export interface UseDeepBookMarkResult {
  readonly mark: DeepBookMark | null;
  readonly status: DeepBookMarkStatus;
  /** Last error message, if the most recent poll failed. */
  readonly error: string | null;
}

/**
 * @param pool      pool name (defaults to SUI_USDC)
 * @param pollMs    poll cadence; 2s is well within the indexer's tolerance
 */
export function useDeepBookMark(
  pool: DeepBookPoolName = "SUI_USDC",
  pollMs = 2000,
): UseDeepBookMarkResult {
  const [mark, setMark] = useState<DeepBookMark | null>(null);
  const [status, setStatus] = useState<DeepBookMarkStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  // Hold the latest mark across re-renders so a failed poll can keep it shown.
  const lastMark = useRef<DeepBookMark | null>(null);

  useEffect(() => {
    const poolName = DEEPBOOK_POOLS[pool].name;
    let cancelled = false;
    const controller = new AbortController();

    // Reset to "connecting" when the pool changes.
    setStatus(lastMark.current ? "stale" : "connecting");

    const tick = async () => {
      try {
        const next = await fetchDeepBookMark(poolName, controller.signal);
        if (cancelled) return;
        lastMark.current = next;
        setMark(next);
        setStatus("live");
        setError(null);
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        // Keep the last good mark, just mark it stale.
        setStatus(lastMark.current ? "stale" : "connecting");
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
  }, [pool, pollMs]);

  return { mark, status, error };
}
