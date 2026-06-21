import type { OpenOptionParams, OptionPosition, OptionSide } from "./types";
/**
 * How many Black-Scholes "years" one real second represents. Synthetic markets
 * run on an accelerated clock so a ~60s round has meaningful price action and
 * option value; real-time (1/SECONDS_PER_YEAR) is the default for plain use.
 */
export declare const DEFAULT_YEARS_PER_SECOND: number;
/** Open a long option, applying the buy-side spread to the fair premium. */
export declare function openOption(params: OpenOptionParams): OptionPosition;
/**
 * Live mark per contract (mid, before spread) at the current spot. Used for the
 * Live-round P&L readout and as the basis for a sell-to-close quote.
 */
export declare function markPerContract(pos: Pick<OptionPosition, "side" | "strike" | "expiryMs">, spot: number, nowMs: number, sigma: number, rate?: number, yearsPerSecond?: number): number;
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
export declare function settlementPnlAtSpot(pos: OptionPosition, spot: number): number;
/**
 * Return on premium for a P&L figure, as a fraction (0.5 = +50%). The natural
 * denominator for an option is the premium at risk. Returns 0 when no premium
 * was paid (avoids divide-by-zero for the empty/edge case).
 */
export declare function pnlReturnFraction(pnl: number, premiumPaid: number): number;
/** Unrealized P&L for an open position at the current spot (after sell spread). */
export declare function unrealizedPnl(pos: OptionPosition, spot: number, nowMs: number, sigma: number, spreadBps: number, rate?: number, yearsPerSecond?: number): number;
/** Sell to close at the current mark (minus the sell-side spread). */
export declare function sellToClose(pos: OptionPosition, spot: number, nowMs: number, sigma: number, spreadBps: number, rate?: number, yearsPerSecond?: number): OptionPosition;
/**
 * Settle at expiry against the realized spot. Cash-settled: pay intrinsic, no
 * pricing model involved. This is what the on-chain settle mirrors.
 */
export declare function settleAtExpiry(pos: OptionPosition, spotAtExpiry: number): OptionPosition;
/** Realized P&L for a closed position (0 net for a still-open one). */
export declare function realizedPnl(pos: OptionPosition): number;
/** Convenience: side-aware label for UI. */
export declare function sideLabel(side: OptionSide): string;
//# sourceMappingURL=option.d.ts.map