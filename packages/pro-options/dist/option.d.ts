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