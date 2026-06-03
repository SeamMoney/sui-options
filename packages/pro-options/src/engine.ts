/**
 * RoundEngine — the headless spine of Pro Mode.
 *
 * Ties the primitives (path + Black-Scholes + option lifecycle + round clock)
 * into one playable round: generate & commit the path, run the lobby→live→settle
 * clock, quote/open/mark/sell/settle options against the progressively-revealed
 * price, and tally player vs house P&L. This is what the UI, the multiplayer
 * server, and the on-chain settlement all wrap. See docs/design/v2/28.
 */
import { SECONDS_PER_YEAR, quote as bsQuote } from "./black-scholes";
import { openOption, realizedPnl, sellToClose as sellPos, settleAtExpiry } from "./option";
import { generatePath } from "./path";
import { commit as commitFn, phaseRemainingMs, revealedSteps, roundPhase, type RoundConfig, type RoundPhase } from "./round";
import type { OptionPosition, OptionQuote, OptionSide } from "./types";

/** A synthetic market's "personality". */
export interface MarketConfig {
  id: string;
  label: string;
  startPrice: number;
  sigmaAnnual: number;
  driftAnnual: number;
  rugChanceBps?: number;
  rugDownPct?: number;
}

export interface RoundEngineConfig {
  market: MarketConfig;
  round: RoundConfig;
  seed: number;
  /** Price steps revealed across the live phase. */
  steps: number;
  /** Wall-clock ms per price step (for GBM dt). */
  stepMs: number;
  /** House spread (vig), in basis points. */
  spreadBps: number;
  /**
   * BS "years" per real second — the accelerated clock. Omit for real-time.
   * Sized so a ~60s round has a lively chart and option premiums with real
   * time value (e.g. ~0.002 ≈ a 60s round feeling like ~1 trading month).
   */
  yearsPerSecond?: number;
}

export interface OpenOrder {
  id: string;
  side: OptionSide;
  strike: number;
  expiryMs: number;
  contracts: number;
  nowMs: number;
}

export class RoundEngine {
  readonly commit: string;
  private readonly path: number[];
  private readonly positions = new Map<string, OptionPosition>();
  private readonly paramsJson: string;
  private readonly yps: number;

  constructor(private readonly cfg: RoundEngineConfig) {
    const { market, seed, steps, stepMs } = cfg;
    this.yps = cfg.yearsPerSecond ?? 1 / SECONDS_PER_YEAR;
    this.paramsJson = JSON.stringify({
      startPrice: market.startPrice,
      sigmaAnnual: market.sigmaAnnual,
      driftAnnual: market.driftAnnual,
      rugChanceBps: market.rugChanceBps ?? 0,
      rugDownPct: market.rugDownPct ?? 0,
      steps,
      stepMs,
      yearsPerSecond: this.yps,
    });
    this.path = generatePath({
      seed,
      steps,
      startPrice: market.startPrice,
      sigmaAnnual: market.sigmaAnnual,
      driftAnnual: market.driftAnnual,
      stepMs,
      yearsPerSecond: this.yps,
      rugChanceBps: market.rugChanceBps,
      rugDownPct: market.rugDownPct,
    });
    this.commit = commitFn(seed, this.paramsJson);
  }

  phase(nowMs: number): RoundPhase {
    return roundPhase(this.cfg.round, nowMs);
  }

  /** Milliseconds left in the current phase (for countdowns). */
  msLeftInPhase(nowMs: number): number {
    return phaseRemainingMs(this.cfg.round, nowMs);
  }

  /** Spot visible at `nowMs` — revealed progressively during the live phase. */
  spotAt(nowMs: number): number {
    const idx = revealedSteps(this.cfg.round, nowMs, this.cfg.steps);
    return this.path[Math.min(idx, this.cfg.steps)];
  }

  /** Total price steps in the round. */
  get steps(): number {
    return this.cfg.steps;
  }

  /** How many price steps are revealed at `nowMs` (0 in lobby, all once live ends). */
  revealedCount(nowMs: number): number {
    return revealedSteps(this.cfg.round, nowMs, this.cfg.steps);
  }

  /** The revealed price prefix at `nowMs` (for charting). */
  revealedPath(nowMs: number): number[] {
    const idx = Math.min(this.revealedCount(nowMs), this.cfg.steps);
    return this.path.slice(0, idx + 1);
  }

  /** Live BS quote for a prospective contract at `nowMs`. */
  quote(side: OptionSide, strike: number, expiryMs: number, nowMs: number): OptionQuote {
    const tauSeconds = Math.max(0, (expiryMs - nowMs) / 1000);
    return bsQuote({
      spot: this.spotAt(nowMs),
      strike,
      tauYears: tauSeconds * this.yps,
      sigma: this.cfg.market.sigmaAnnual,
      side,
    });
  }

  /** Open a long option at the current quote + buy-side spread. */
  open(order: OpenOrder): OptionPosition {
    const q = this.quote(order.side, order.strike, order.expiryMs, order.nowMs);
    const pos = openOption({
      id: order.id,
      side: order.side,
      strike: order.strike,
      openedAtMs: order.nowMs,
      expiryMs: order.expiryMs,
      contracts: order.contracts,
      fairPremium: q.premium,
      spreadBps: this.cfg.spreadBps,
    });
    this.positions.set(pos.id, pos);
    return pos;
  }

  /** Sell an open position to close at the current mark (minus sell spread). */
  sellToClose(id: string, nowMs: number): OptionPosition | null {
    const pos = this.positions.get(id);
    if (!pos || pos.status !== "open") return pos ?? null;
    const closed = sellPos(pos, this.spotAt(nowMs), nowMs, this.cfg.market.sigmaAnnual, this.cfg.spreadBps, 0, this.yps);
    this.positions.set(id, closed);
    return closed;
  }

  /** Settle every open position whose expiry has passed, against the revealed path. */
  settleExpired(nowMs: number): OptionPosition[] {
    const settled: OptionPosition[] = [];
    for (const pos of this.positions.values()) {
      if (pos.status === "open" && pos.expiryMs <= nowMs) {
        const done = settleAtExpiry(pos, this.spotAt(pos.expiryMs));
        this.positions.set(pos.id, done);
        settled.push(done);
      }
    }
    return settled;
  }

  /** End-of-round sweep: settle anything still open at its expiry. */
  settleAll(): OptionPosition[] {
    const settled: OptionPosition[] = [];
    for (const pos of this.positions.values()) {
      if (pos.status === "open") {
        const done = settleAtExpiry(pos, this.spotAt(pos.expiryMs));
        this.positions.set(pos.id, done);
        settled.push(done);
      }
    }
    return settled;
  }

  getPositions(): OptionPosition[] {
    return [...this.positions.values()];
  }

  /** Total realized P&L across all closed player positions. */
  playerPnl(): number {
    let total = 0;
    for (const pos of this.positions.values()) total += realizedPnl(pos);
    return total;
  }

  /** The house is the counterparty: house P&L = −player P&L. */
  housePnl(): number {
    return -this.playerPnl();
  }

  /** Reveal the seed and verify the streamed path matched the commit. */
  reveal(): { seed: number; verified: boolean } {
    const recomputed = commitFn(this.cfg.seed, this.paramsJson);
    return { seed: this.cfg.seed, verified: recomputed === this.commit };
  }
}
