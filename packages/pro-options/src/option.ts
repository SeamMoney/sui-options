/**
 * Option position lifecycle for Pro Mode.
 *
 *   open ──sell-to-close (mark)──▶ sold
 *    └────────at expiry──────────▶ settled_itm | expired_worthless
 *
 * The house spread (vig) is applied symmetrically: the buyer pays fair × (1 +
 * s) on open and receives mark × (1 − s) on a sell-to-close. That spread is the
 * transparent, legible part of the house edge (the mild rug is separate, in the
 * path layer). See docs/design/v2/28.
 */
import { SECONDS_PER_YEAR, intrinsic, price } from "./black-scholes";
import type { OpenOptionParams, OptionPosition, OptionSide } from "./types";

const bpsToFrac = (bps: number) => bps / 10_000;

/**
 * How many Black-Scholes "years" one real second represents. Synthetic markets
 * run on an accelerated clock so a ~60s round has meaningful price action and
 * option value; real-time (1/SECONDS_PER_YEAR) is the default for plain use.
 */
export const DEFAULT_YEARS_PER_SECOND = 1 / SECONDS_PER_YEAR;

/** Open a long option, applying the buy-side spread to the fair premium. */
export function openOption(params: OpenOptionParams): OptionPosition {
  const { id, side, strike, openedAtMs, expiryMs, contracts, fairPremium, spreadBps } = params;
  const perContract = fairPremium * (1 + bpsToFrac(spreadBps));
  return {
    id,
    side,
    strike,
    openedAtMs,
    expiryMs,
    contracts,
    premiumPaid: perContract * contracts,
    status: "open",
  };
}

/**
 * Live mark per contract (mid, before spread) at the current spot. Used for the
 * Live-round P&L readout and as the basis for a sell-to-close quote.
 */
export function markPerContract(
  pos: Pick<OptionPosition, "side" | "strike" | "expiryMs">,
  spot: number,
  nowMs: number,
  sigma: number,
  rate = 0,
  yearsPerSecond = DEFAULT_YEARS_PER_SECOND,
): number {
  const tauSeconds = Math.max(0, (pos.expiryMs - nowMs) / 1000);
  return price({
    spot,
    strike: pos.strike,
    tauYears: tauSeconds * yearsPerSecond,
    sigma,
    side: pos.side,
    rate,
  });
}

/**
 * Settlement-projected P&L: what the position would realize if the round
 * settled at `spot` RIGHT NOW. This is the headline "Live P&L" for a
 * hold-to-expiry round.
 *
 * It deliberately uses the EXACT formula `settleAtExpiry` → `realizedPnl`
 * uses — `intrinsic(side, strike, spot) × contracts − premiumPaid` — fed
 * with the live spot. Because the live readout and the settlement share one
 * formula and one set of inputs, the number a player watches converges to,
 * and at expiry EQUALS, the realized settlement. No trust gap.
 *
 * Contrast `unrealizedPnl` below, which marks to the Black-Scholes
 * sell-to-close value: that carries time-value + the sell-side spread, so it
 * will NOT match the intrinsic cash settlement. Use `unrealizedPnl` only to
 * quote an early sell-to-close; use this for the "your P&L" headline.
 *
 * For a closed position it returns the already-realized P&L, so callers can
 * sum a mixed book without branching.
 */
export function settlementPnlAtSpot(pos: OptionPosition, spot: number): number {
  if (pos.status !== "open") return realizedPnl(pos);
  const value = intrinsic(pos.side, pos.strike, spot);
  return value * pos.contracts - pos.premiumPaid;
}

/**
 * Return on premium for a P&L figure, as a fraction (0.5 = +50%). The natural
 * denominator for an option is the premium at risk. Returns 0 when no premium
 * was paid (avoids divide-by-zero for the empty/edge case).
 */
export function pnlReturnFraction(pnl: number, premiumPaid: number): number {
  return premiumPaid > 0 ? pnl / premiumPaid : 0;
}

/** Unrealized P&L for an open position at the current spot (after sell spread). */
export function unrealizedPnl(
  pos: OptionPosition,
  spot: number,
  nowMs: number,
  sigma: number,
  spreadBps: number,
  rate = 0,
  yearsPerSecond = DEFAULT_YEARS_PER_SECOND,
): number {
  if (pos.status !== "open") return realizedPnl(pos);
  const mark = markPerContract(pos, spot, nowMs, sigma, rate, yearsPerSecond) * (1 - bpsToFrac(spreadBps));
  return mark * pos.contracts - pos.premiumPaid;
}

/** Sell to close at the current mark (minus the sell-side spread). */
export function sellToClose(
  pos: OptionPosition,
  spot: number,
  nowMs: number,
  sigma: number,
  spreadBps: number,
  rate = 0,
  yearsPerSecond = DEFAULT_YEARS_PER_SECOND,
): OptionPosition {
  if (pos.status !== "open") return pos;
  const mark = markPerContract(pos, spot, nowMs, sigma, rate, yearsPerSecond) * (1 - bpsToFrac(spreadBps));
  const proceeds = Math.max(0, mark) * pos.contracts;
  return { ...pos, status: "sold", closedAtMs: nowMs, proceeds };
}

/**
 * Settle at expiry against the realized spot. Cash-settled: pay intrinsic, no
 * pricing model involved. This is what the on-chain settle mirrors.
 */
export function settleAtExpiry(pos: OptionPosition, spotAtExpiry: number): OptionPosition {
  if (pos.status !== "open") return pos;
  const value = intrinsic(pos.side, pos.strike, spotAtExpiry);
  const proceeds = value * pos.contracts;
  return {
    ...pos,
    status: proceeds > 0 ? "settled_itm" : "expired_worthless",
    closedAtMs: pos.expiryMs,
    proceeds,
  };
}

/** Realized P&L for a closed position (0 net for a still-open one). */
export function realizedPnl(pos: OptionPosition): number {
  if (pos.status === "open") return 0;
  return (pos.proceeds ?? 0) - pos.premiumPaid;
}

/** Convenience: side-aware label for UI. */
export function sideLabel(side: OptionSide): string {
  return side === "call" ? "Call" : "Put";
}
