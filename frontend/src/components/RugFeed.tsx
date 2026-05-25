/**
 * RugFeed — live "MARKET HALT" feed for the v4.26 rug-pull demo.
 *
 * Before this panel, a rug fire was invisible to anyone who wasn't the
 * single user holding the screen at the moment it landed. Spectators
 * (judges, demo audience, anyone watching the chart at the same time as
 * the active rider) had no on-screen confirmation that the round just
 * died. This panel makes the rug visible to ALL viewers of `/ride`.
 *
 * It subscribes to `RugFiredV4` events for the active market, keeps the
 * last 10 fires in component-local state, and renders a small fixed-
 * positioned glass panel in the bottom-left of the screen. The panel
 * is strictly read-only — `pointer-events-none` lets the chart underneath
 * keep receiving the press-anywhere gesture untouched.
 *
 * Subscription pattern mirrors `useSegmentRideV4`'s rug-fire effect
 * (frontend/src/hooks/useSegmentRideV4.ts §"Rug-fire subscription") so
 * the cleanup contract is identical: `subscribeRugFiredV4` returns an
 * unsubscribe fn, we call it from the effect's return.
 *
 * Visual styling mirrors `BarrierFlowV4` (glass-container + glass-filter
 * + glass-overlay + glass-specular stack, font-mono uppercase microcopy,
 * tabular-nums for tickers). z-index 1550 keeps the panel just under
 * the top bar (1600) and well below the settlement toast (1700) — same
 * height in the stack as the deleted right-rail BarrierFlowV4 panel.
 */
import { useEffect, useState } from "react";
import {
  subscribeRugFiredV4,
  type RugFiredV4Event,
} from "@wick/sdk";
import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

/** Cap on visible entries — oldest dropped past this. */
const MAX_VISIBLE_RUGS = 10;
/** Tick cadence (ms) for the "Xs ago" labels. */
const AGE_TICK_MS = 1000;

export interface RugFeedProps {
  /** SegmentMarketV4<C> id whose RugFiredV4 events we subscribe to. */
  readonly marketId: string;
  /** Wick package id — supplies the event type tag for queryEvents. */
  readonly packageId: string;
  /** Sui JSON RPC client (typically session.client). */
  readonly client: SuiJsonRpcClient;
}

/**
 * Format the wallclock delta between `now` and the event's `timestampMs`
 * as a compact "Xs ago" / "Xm ago" / "Xh ago" string. Negative deltas
 * (event clock slightly ahead of wallclock — possible on freshly-landed
 * events) clamp to "just now".
 */
function formatAge(nowMs: number, eventMs: number): string {
  const deltaMs = Math.max(0, nowMs - eventMs);
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 1) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

export function RugFeed(props: RugFeedProps) {
  const { marketId, packageId, client } = props;

  // Most-recent first. We append on the front and slice the tail past
  // MAX_VISIBLE_RUGS so the panel never grows unbounded.
  const [rugs, setRugs] = useState<RugFiredV4Event[]>([]);
  // `loaded` flips true on the FIRST subscriber callback fire (whether
  // the page is fresh or we just saw a rug). Until then we render
  // "Loading…" — the subscriber polls once on mount, so this resolves
  // within ~350 ms even when there are zero events historically.
  const [loaded, setLoaded] = useState(false);
  // Ticker so the "Xs ago" labels stay live without us re-subscribing.
  const [, setNowTick] = useState(0);

  // ── Subscribe to RugFiredV4 ─────────────────────────────────────────
  // Mirrors the cleanup contract in useSegmentRideV4's rug-fire effect.
  useEffect(() => {
    if (!packageId || !marketId) return;
    let cancelled = false;
    // The subscriber polls once at mount; this timer marks the panel
    // as "loaded" shortly after so we transition out of the Loading
    // state even when the on-chain history has zero rugs to surface.
    const loadedTimer = window.setTimeout(() => {
      if (!cancelled) setLoaded(true);
    }, 600);
    const unsubscribe = subscribeRugFiredV4(
      client,
      marketId,
      packageId,
      (event: RugFiredV4Event) => {
        if (cancelled) return;
        setLoaded(true);
        setRugs((prev) => {
          // Dedupe on (digest + segmentIndex) — subscribeRugFiredV4
          // already dedupes by digest+eventSeq, but defending against
          // an in-flight re-render burst is cheap.
          const key = `${event.digest}:${event.segmentIndex.toString()}`;
          for (const r of prev) {
            const rk = `${r.digest}:${r.segmentIndex.toString()}`;
            if (rk === key) return prev;
          }
          const next = [event, ...prev];
          if (next.length > MAX_VISIBLE_RUGS) {
            return next.slice(0, MAX_VISIBLE_RUGS);
          }
          return next;
        });
      },
    );
    return () => {
      cancelled = true;
      window.clearTimeout(loadedTimer);
      unsubscribe();
    };
  }, [client, marketId, packageId]);

  // ── Tick the "Xs ago" labels once a second ─────────────────────────
  useEffect(() => {
    const id = window.setInterval(() => {
      setNowTick((t) => (t + 1) % 1024);
    }, AGE_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const nowMs = Date.now();

  return (
    <div
      className="fixed bottom-3 left-3 z-[1550] pointer-events-none"
      aria-hidden
    >
      <div className="glass-container px-3 py-2.5 rounded-lg font-mono select-none min-w-[180px] max-w-[220px]">
        <div className="glass-filter" />
        <div className="glass-overlay" />
        <div className="glass-specular" />
        <div className="relative z-10 leading-tight">
          {/* Header */}
          <div className="flex items-baseline justify-between mb-2">
            <div className="text-[9px] uppercase tracking-[0.18em] text-white/45">
              Market halts
            </div>
            <div className="text-[9px] uppercase tracking-[0.14em] text-rose-400/70 tabular-nums">
              {rugs.length > 0 ? `${rugs.length}` : ""}
            </div>
          </div>

          {/* Body */}
          {!loaded ? (
            <div className="text-[10px] text-white/35 uppercase tracking-wider">
              Loading…
            </div>
          ) : rugs.length === 0 ? (
            <div className="text-[10px] text-white/35 leading-snug">
              💀 No rugs yet — be the first
            </div>
          ) : (
            <ul className="space-y-1">
              {rugs.map((rug) => {
                const key = `${rug.digest}:${rug.segmentIndex.toString()}`;
                return (
                  <li
                    key={key}
                    className="flex items-baseline justify-between gap-2 text-[10px] tabular-nums"
                  >
                    <span className="text-rose-300/90">
                      💥 R{rug.roundIndex.toString()}{" "}
                      <span className="text-white/55">
                        S{rug.segmentIndex.toString()}
                      </span>
                    </span>
                    <span className="text-white/40 text-[9px]">
                      {formatAge(nowMs, rug.timestampMs)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export default RugFeed;
