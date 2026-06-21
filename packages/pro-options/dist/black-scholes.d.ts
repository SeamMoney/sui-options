/**
 * Black-Scholes pricing for Pro Mode.
 *
 * This is the OFF-CHAIN pricing engine (premiums, Greeks, payoff curves, live
 * mark). Settlement never re-runs this — a cash-settled option just pays its
 * intrinsic value against the realized path. See docs/design/v2/28.
 */
import type { BsInputs, Greeks, OptionQuote, OptionSide, PayoffPoint } from "./types";
export declare const SECONDS_PER_YEAR = 31557600;
/** Convert a seconds-to-expiry (T+10..60s micro-options) into BS year units. */
export declare function yearsFromSeconds(seconds: number): number;
/**
 * Standard normal CDF via the Abramowitz & Stegun 7.1.26 erf approximation
 * (max abs error ~1.5e-7 — ample for pricing).
 */
export declare function normCdf(x: number): number;
/** Standard normal PDF. */
export declare function normPdf(x: number): number;
/** Fair (mid) premium per contract. */
export declare function price(inputs: BsInputs): number;
/** Greeks for a single contract. Theta is per YEAR. */
export declare function greeks(inputs: BsInputs): Greeks;
export declare function quote(inputs: BsInputs): OptionQuote;
/** Cash-settled intrinsic value per contract at a given spot. */
export declare function intrinsic(side: OptionSide, strike: number, spot: number): number;
/**
 * Robinhood-style payoff curve: net P&L per contract across a range of expiry
 * spots, given the premium actually paid.
 */
export declare function payoffCurve(side: OptionSide, strike: number, premiumPaid: number, spotMin: number, spotMax: number, steps?: number): PayoffPoint[];
/** Breakeven spot at expiry for a long option that paid `premiumPaid`. */
export declare function breakeven(side: OptionSide, strike: number, premiumPaid: number): number;
//# sourceMappingURL=black-scholes.d.ts.map