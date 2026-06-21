/**
 * useRoundHost — React binding for the Pro Mode round engine.
 *
 * Creates a RoundEngine + RoundHost from a market preset, drives the host from a
 * requestAnimationFrame loop, and exposes a live snapshot (phase, spot, revealed
 * path, positions, countdown, commit/reveal) plus actions (quote / open / sell).
 * The whole game runs client-side here; the same host later runs server-side for
 * multiplayer with no change to this surface. See docs/design/v2/29.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  RoundEngine,
  RoundHost,
  pnlReturnFraction,
  roundConfigFromPreset,
  type HostEvent,
  type MarketPreset,
  type OptionPosition,
  type OptionQuote,
  type OptionSide,
  type RoundPhase,
} from "@sui-options/pro-options";

export interface UseRoundHostOptions {
  preset: MarketPreset;
  seed: number;
  lobbyMs?: number;
  liveMs?: number;
  settleMs?: number;
  steps?: number;
  stepMs?: number;
}

export interface RoundSnapshot {
  phase: RoundPhase;
  spot: number;
  /** Revealed price prefix, for charting. */
  path: number[];
  positions: OptionPosition[];
  /**
   * The ONE headline live P&L (absolute, in quote units). This is the
   * settlement-projected P&L — `intrinsic(side, strike, spot) − premium`
   * across the book at the current spot — i.e. the SAME formula and inputs
   * the round settles with. So the number shown here always converges to,
   * and at expiry equals, what the player is actually paid. (Not the
   * Black-Scholes sell-to-close mark, which carries time value + spread and
   * would mismatch the cash settlement.)
   */
  pnl: number;
  /** Total premium paid across the book — the denominator for `pnlReturn`. */
  premiumAtRisk: number;
  /** `pnl / premiumAtRisk` as a fraction (0.5 = +50%); 0 with no positions. */
  pnlReturn: number;
  commit: string;
  reveal: { seed: number; verified: boolean } | null;
  msLeftInPhase: number;
  nowMs: number;
}

export interface RoundHostApi extends RoundSnapshot {
  /** BS quote for a contract expiring `expiryInMs` from now. */
  quote: (side: OptionSide, strike: number, expiryInMs: number) => OptionQuote | null;
  /** Open a long option expiring `expiryInMs` from now. */
  openOption: (side: OptionSide, strike: number, expiryInMs: number, contracts: number) => OptionPosition | null;
  /** Sell an open position to close at the current mark. */
  sellToClose: (id: string) => void;
}

const EMPTY: RoundSnapshot = {
  phase: "lobby",
  spot: 0,
  path: [],
  positions: [],
  pnl: 0,
  premiumAtRisk: 0,
  pnlReturn: 0,
  commit: "",
  reveal: null,
  msLeftInPhase: 0,
  nowMs: 0,
};

export function useRoundHost(opts: UseRoundHostOptions): RoundHostApi {
  const { preset, seed, lobbyMs, liveMs, settleMs, steps, stepMs } = opts;
  const engineRef = useRef<RoundEngine | null>(null);
  const startRef = useRef(0);
  const revealRef = useRef<{ seed: number; verified: boolean } | null>(null);
  const idRef = useRef(0);
  const [snap, setSnap] = useState<RoundSnapshot>(EMPTY);

  useEffect(() => {
    const engine = new RoundEngine(
      roundConfigFromPreset({ preset, seed, startedAtMs: 0, lobbyMs, liveMs, settleMs, steps, stepMs }),
    );
    const host = new RoundHost(engine);
    engineRef.current = engine;
    revealRef.current = null;
    startRef.current = performance.now();

    const read = (): RoundSnapshot => {
      const t = performance.now() - startRef.current;
      const pnl = engine.livePnl(t);
      const premiumAtRisk = engine.premiumAtRisk();
      return {
        phase: engine.phase(t),
        spot: engine.spotAt(t),
        path: engine.revealedPath(t),
        positions: engine.getPositions(),
        pnl,
        premiumAtRisk,
        pnlReturn: pnlReturnFraction(pnl, premiumAtRisk),
        commit: engine.commit,
        reveal: revealRef.current,
        msLeftInPhase: engine.msLeftInPhase(t),
        nowMs: t,
      };
    };

    const off = host.on((event: HostEvent) => {
      if (event.type === "reveal-seed") revealRef.current = { seed: event.seed, verified: event.verified };
      setSnap(read());
    });

    let raf = 0;
    const loop = () => {
      host.tick(performance.now() - startRef.current);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    // Events alone are too coarse for a smooth countdown.
    const timer = window.setInterval(() => setSnap(read()), 200);
    setSnap(read());

    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(timer);
      off();
      host.stop();
      engineRef.current = null;
    };
  }, [preset, seed, lobbyMs, liveMs, settleMs, steps, stepMs]);

  const quote = useCallback<RoundHostApi["quote"]>((side, strike, expiryInMs) => {
    const engine = engineRef.current;
    if (!engine) return null;
    const t = performance.now() - startRef.current;
    return engine.quote(side, strike, t + expiryInMs, t);
  }, []);

  const openOption = useCallback<RoundHostApi["openOption"]>((side, strike, expiryInMs, contracts) => {
    const engine = engineRef.current;
    if (!engine) return null;
    const t = performance.now() - startRef.current;
    const pos = engine.open({
      id: `${side}-${Math.round(strike)}-${++idRef.current}`,
      side,
      strike,
      expiryMs: t + expiryInMs,
      contracts,
      nowMs: t,
    });
    // Refresh P&L synchronously so the headline shows the instant the
    // position is placed (mandate: "see clear live P&L IMMEDIATELY"),
    // not on the next 200ms tick.
    const pnl = engine.livePnl(t);
    const premiumAtRisk = engine.premiumAtRisk();
    setSnap((s) => ({
      ...s,
      positions: engine.getPositions(),
      pnl,
      premiumAtRisk,
      pnlReturn: pnlReturnFraction(pnl, premiumAtRisk),
    }));
    return pos;
  }, []);

  const sellToClose = useCallback<RoundHostApi["sellToClose"]>((id) => {
    const engine = engineRef.current;
    if (!engine) return;
    const t = performance.now() - startRef.current;
    engine.sellToClose(id, t);
    const pnl = engine.livePnl(t);
    const premiumAtRisk = engine.premiumAtRisk();
    setSnap((s) => ({
      ...s,
      positions: engine.getPositions(),
      pnl,
      premiumAtRisk,
      pnlReturn: pnlReturnFraction(pnl, premiumAtRisk),
    }));
  }, []);

  return { ...snap, quote, openOption, sellToClose };
}
