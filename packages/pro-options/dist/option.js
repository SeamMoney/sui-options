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
import { SECONDS_PER_YEAR, intrinsic, price } from "./black-scholes.js";
const bpsToFrac = (bps) => bps / 10_000;
/**
 * How many Black-Scholes "years" one real second represents. Synthetic markets
 * run on an accelerated clock so a ~60s round has meaningful price action and
 * option value; real-time (1/SECONDS_PER_YEAR) is the default for plain use.
 */
export const DEFAULT_YEARS_PER_SECOND = 1 / SECONDS_PER_YEAR;
/** Open a long option, applying the buy-side spread to the fair premium. */
export function openOption(params) {
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
export function markPerContract(pos, spot, nowMs, sigma, rate = 0, yearsPerSecond = DEFAULT_YEARS_PER_SECOND) {
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
/** Unrealized P&L for an open position at the current spot (after sell spread). */
export function unrealizedPnl(pos, spot, nowMs, sigma, spreadBps, rate = 0, yearsPerSecond = DEFAULT_YEARS_PER_SECOND) {
    if (pos.status !== "open")
        return realizedPnl(pos);
    const mark = markPerContract(pos, spot, nowMs, sigma, rate, yearsPerSecond) * (1 - bpsToFrac(spreadBps));
    return mark * pos.contracts - pos.premiumPaid;
}
/** Sell to close at the current mark (minus the sell-side spread). */
export function sellToClose(pos, spot, nowMs, sigma, spreadBps, rate = 0, yearsPerSecond = DEFAULT_YEARS_PER_SECOND) {
    if (pos.status !== "open")
        return pos;
    const mark = markPerContract(pos, spot, nowMs, sigma, rate, yearsPerSecond) * (1 - bpsToFrac(spreadBps));
    const proceeds = Math.max(0, mark) * pos.contracts;
    return { ...pos, status: "sold", closedAtMs: nowMs, proceeds };
}
/**
 * Settle at expiry against the realized spot. Cash-settled: pay intrinsic, no
 * pricing model involved. This is what the on-chain settle mirrors.
 */
export function settleAtExpiry(pos, spotAtExpiry) {
    if (pos.status !== "open")
        return pos;
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
export function realizedPnl(pos) {
    if (pos.status === "open")
        return 0;
    return (pos.proceeds ?? 0) - pos.premiumPaid;
}
/** Convenience: side-aware label for UI. */
export function sideLabel(side) {
    return side === "call" ? "Call" : "Put";
}
//# sourceMappingURL=option.js.map