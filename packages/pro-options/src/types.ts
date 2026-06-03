/** Pro Mode options engine — shared types. */

export type OptionSide = "call" | "put";

/**
 * Position lifecycle:
 *  open ──sell-to-close──▶ sold
 *   └────at expiry────────▶ settled_itm | expired_worthless
 */
export type OptionStatus = "open" | "sold" | "settled_itm" | "expired_worthless";

/** Inputs to the Black-Scholes engine. Time is in YEARS, sigma is annualized. */
export interface BsInputs {
  spot: number;
  strike: number;
  /** Time to expiry in years. Use `yearsFromSeconds` to convert. */
  tauYears: number;
  /** Annualized volatility (e.g. 0.6 = 60%). */
  sigma: number;
  side: OptionSide;
  /** Risk-free rate, annualized. Synthetic markets use 0. */
  rate?: number;
}

export interface Greeks {
  /** ∂price/∂spot. */
  delta: number;
  /** ∂²price/∂spot². */
  gamma: number;
  /** ∂price/∂time, per YEAR (negative for long options). */
  theta: number;
  /** ∂price/∂sigma, per 1.0 of vol. */
  vega: number;
}

export interface OptionQuote {
  /** Fair (mid) premium per contract, before any spread. */
  premium: number;
  greeks: Greeks;
}

/** A single point on a Robinhood-style payoff curve. */
export interface PayoffPoint {
  spot: number;
  /** Net P&L per contract at this expiry spot (payoff − premium paid). */
  pnl: number;
}

export interface OpenOptionParams {
  id: string;
  side: OptionSide;
  strike: number;
  openedAtMs: number;
  expiryMs: number;
  contracts: number;
  /** Fair premium per contract at open (from the BS engine). */
  fairPremium: number;
  /** House spread in basis points applied to the buyer (pays more). */
  spreadBps: number;
}

export interface OptionPosition {
  id: string;
  side: OptionSide;
  strike: number;
  openedAtMs: number;
  expiryMs: number;
  contracts: number;
  /** Total premium actually paid (fair × (1 + spread) × contracts). */
  premiumPaid: number;
  status: OptionStatus;
  closedAtMs?: number;
  /** Total cash returned to the holder (sell mark or settlement intrinsic). */
  proceeds?: number;
}
