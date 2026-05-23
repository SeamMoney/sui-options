/**
 * BarrierOrderbookGrid — the two-row "orderbook" overlay for the round.
 *
 * Doc 19 §14 + §17.5: stacks the upper-barrier OrderbookBar above the
 * lower-barrier one. Both bars read from the same on-chain SegmentMarket
 * snapshot, polled at ~1s cadence; each bar internally pulses when its
 * aggregate-stake field changes (i.e. a RideOpened/RideClosed event has
 * reconciled).
 *
 * Why we poll the snapshot directly instead of leaning on useSegmentRide:
 *   - useSegmentRide already pulls fetchSegmentMarket at 5s — too slow for
 *     the "I just saw a ride land" sensation. We poll our own copy at
 *     ~1s. (The poll is idempotent, costs one cheap getObject call,
 *     well under any rate-limit concern.)
 *   - Round-transition reset is handled by the snapshot itself — the Move
 *     module zeroes upper_aggregate_stake / lower_aggregate_stake when
 *     `ensure_round_current` rolls (doc 19 §14). We just re-render with
 *     the fresh values.
 *
 * Render budget: 1 fetch + 2 small DOM bars per poll = effectively free.
 */
import { useEffect, useRef, useState } from "react";
import {
  fetchSegmentMarket,
  type SegmentMarketSnapshot,
} from "@wick/sdk";
import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { OrderbookBar } from "@/components/OrderbookBar";

/** Snapshot-poll cadence — fast enough that opens / closes feel live, slow
 *  enough to be polite to the RPC. */
const SNAPSHOT_POLL_MS = 1000;

export interface BarrierOrderbookGridProps {
  /** The SegmentMarket<C> id to read from. */
  readonly marketId: string;
  /** Sui JSON RPC client (typically session.client from useSessionWallet). */
  readonly client: SuiJsonRpcClient;
  /** Initial snapshot — if useSegmentRide has already populated one, pass
   *  it through so the first paint isn't blank. */
  readonly initialSnapshot?: SegmentMarketSnapshot | null;
}

/** Convert max_payout_per_barrier (in display units) into the "max stake"
 *  axis bound the OrderbookBar normalises width against.
 *  max_payout = stake × multiplier_bps / 10_000   =>
 *  max_stake  = max_payout × 10_000 / multiplier_bps.
 *  When multiplier_bps is zero (shouldn't happen in a live market) we fall
 *  back to max_payout itself so we never divide by zero. */
function maxStakeFor(snapshot: SegmentMarketSnapshot): bigint {
  if (snapshot.multiplierBps === 0n) return snapshot.maxPayoutPerBarrier;
  return (snapshot.maxPayoutPerBarrier * 10_000n) / snapshot.multiplierBps;
}

export function BarrierOrderbookGrid(props: BarrierOrderbookGridProps) {
  const { marketId, client, initialSnapshot } = props;

  const [snapshot, setSnapshot] = useState<SegmentMarketSnapshot | null>(
    initialSnapshot ?? null,
  );

  // Poll loop — fetchSegmentMarket every SNAPSHOT_POLL_MS. We swap in a
  // new snapshot only when content meaningfully changed, so the pulse
  // detector inside OrderbookBar fires on real changes and stays quiet
  // when the market is idle. (We don't deep-compare every field — only
  // the four aggregates + cached round index + cached barriers, which
  // covers all visible state.)
  useEffect(() => {
    if (!marketId) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await fetchSegmentMarket(client, marketId);
        if (cancelled || !next) return;
        setSnapshot((prev) => {
          if (!prev) return next;
          if (
            prev.cachedRoundIndex === next.cachedRoundIndex &&
            prev.cachedUpperBarrier === next.cachedUpperBarrier &&
            prev.cachedLowerBarrier === next.cachedLowerBarrier &&
            prev.upperAggregateStake === next.upperAggregateStake &&
            prev.lowerAggregateStake === next.lowerAggregateStake &&
            prev.upperAggregateMaxPayout === next.upperAggregateMaxPayout &&
            prev.lowerAggregateMaxPayout === next.lowerAggregateMaxPayout &&
            prev.upperRiderCount === next.upperRiderCount &&
            prev.lowerRiderCount === next.lowerRiderCount
          ) {
            return prev;
          }
          return next;
        });
      } catch (err) {
        // Polling failures are non-fatal — keep last good snapshot.
        console.warn("[BarrierOrderbookGrid] fetchSegmentMarket:", err);
      }
    };
    void refresh();
    const id = window.setInterval(() => void refresh(), SNAPSHOT_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [client, marketId]);

  // Round-rollover pulse suppression (D6 SEV-2 #1): when the chain
  // ticks over to a new round, ensure_round_current zeroes the four
  // aggregate-stake counters and bumps cached_round_index. Without
  // this guard, the OrderbookBar pulse would fire because stake went
  // N→0 — even though no RideOpened/RideClosed actually landed. We
  // remember the last snapshot we forwarded to the bars and, on the
  // next render where prev>0, curr===0, AND roundIndex changed, mark
  // the affected side(s) as suppressPulse=true for that single update.
  // After this one-shot suppression the normal pulse-on-change
  // behavior resumes.
  //
  // The ref is written inside an effect (post-commit) so render stays
  // pure; the comparison itself is a no-op cost in render.
  const lastSnapshotRef = useRef<SegmentMarketSnapshot | null>(null);
  useEffect(() => {
    lastSnapshotRef.current = snapshot;
  }, [snapshot]);

  let suppressUpperPulse = false;
  let suppressLowerPulse = false;
  if (snapshot) {
    const prev = lastSnapshotRef.current;
    if (prev && prev.cachedRoundIndex !== snapshot.cachedRoundIndex) {
      if (
        prev.upperAggregateStake > 0n &&
        snapshot.upperAggregateStake === 0n
      ) {
        suppressUpperPulse = true;
      }
      if (
        prev.lowerAggregateStake > 0n &&
        snapshot.lowerAggregateStake === 0n
      ) {
        suppressLowerPulse = true;
      }
    }
  }

  // Empty surface until the first snapshot lands. Render nothing rather
  // than a placeholder so the chart underneath stays uncluttered.
  if (!snapshot) return null;

  const maxStake = maxStakeFor(snapshot);
  const upperIsFull =
    snapshot.upperAggregateMaxPayout >= snapshot.maxPayoutPerBarrier;
  const lowerIsFull =
    snapshot.lowerAggregateMaxPayout >= snapshot.maxPayoutPerBarrier;
  const multiplierBps = Number(snapshot.multiplierBps);

  return (
    <div className="flex flex-col gap-1.5">
      <OrderbookBar
        side="upper"
        barrierPrice={snapshot.cachedUpperBarrier}
        multiplierBps={multiplierBps}
        stakeMicroUsd={snapshot.upperAggregateStake}
        riderCount={Number(snapshot.upperRiderCount)}
        isFull={upperIsFull}
        maxStakeMicroUsd={maxStake}
        suppressPulse={suppressUpperPulse}
      />
      <OrderbookBar
        side="lower"
        barrierPrice={snapshot.cachedLowerBarrier}
        multiplierBps={multiplierBps}
        stakeMicroUsd={snapshot.lowerAggregateStake}
        riderCount={Number(snapshot.lowerRiderCount)}
        isFull={lowerIsFull}
        maxStakeMicroUsd={maxStake}
        suppressPulse={suppressLowerPulse}
      />
    </div>
  );
}

export default BarrierOrderbookGrid;
