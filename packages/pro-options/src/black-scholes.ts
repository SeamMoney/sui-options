/**
 * Black-Scholes pricing for Pro Mode.
 *
 * This is the OFF-CHAIN pricing engine (premiums, Greeks, payoff curves, live
 * mark). Settlement never re-runs this — a cash-settled option just pays its
 * intrinsic value against the realized path. See docs/design/v2/28.
 */
import type { BsInputs, Greeks, OptionQuote, OptionSide, PayoffPoint } from "./types";

export const SECONDS_PER_YEAR = 31_557_600; // 365.25 days

/** Convert a seconds-to-expiry (T+10..60s micro-options) into BS year units. */
export function yearsFromSeconds(seconds: number): number {
  return seconds / SECONDS_PER_YEAR;
}

/**
 * Standard normal CDF via the Abramowitz & Stegun 7.1.26 erf approximation
 * (max abs error ~1.5e-7 — ample for pricing).
 */
export function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** Standard normal PDF. */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

function d1d2(inputs: BsInputs): { d1: number; d2: number; sqrtT: number } {
  const { spot, strike, tauYears, sigma, rate = 0 } = inputs;
  const sqrtT = Math.sqrt(Math.max(tauYears, 0));
  const vol = sigma * sqrtT;
  // Degenerate at/near expiry or zero vol: d1/d2 → ±∞ depending on moneyness.
  if (vol <= 1e-12) {
    const inTheMoney = spot > strike;
    const big = inTheMoney ? Infinity : -Infinity;
    return { d1: big, d2: big, sqrtT };
  }
  const d1 = (Math.log(spot / strike) + (rate + 0.5 * sigma * sigma) * tauYears) / vol;
  const d2 = d1 - vol;
  return { d1, d2, sqrtT };
}

/** Fair (mid) premium per contract. */
export function price(inputs: BsInputs): number {
  const { spot, strike, tauYears, side, rate = 0 } = inputs;
  if (tauYears <= 0) return intrinsic(side, strike, spot);
  const { d1, d2 } = d1d2(inputs);
  const disc = Math.exp(-rate * tauYears);
  if (side === "call") {
    return spot * normCdf(d1) - strike * disc * normCdf(d2);
  }
  return strike * disc * normCdf(-d2) - spot * normCdf(-d1);
}

/** Greeks for a single contract. Theta is per YEAR. */
export function greeks(inputs: BsInputs): Greeks {
  const { spot, strike, tauYears, sigma, side, rate = 0 } = inputs;
  const { d1, d2, sqrtT } = d1d2(inputs);
  if (tauYears <= 0 || sqrtT <= 0) {
    return { delta: side === "call" ? (spot > strike ? 1 : 0) : spot < strike ? -1 : 0, gamma: 0, theta: 0, vega: 0 };
  }
  const pdfD1 = normPdf(d1);
  const disc = Math.exp(-rate * tauYears);
  const gamma = pdfD1 / (spot * sigma * sqrtT);
  const vega = spot * pdfD1 * sqrtT;
  let delta: number;
  let theta: number;
  if (side === "call") {
    delta = normCdf(d1);
    theta = -(spot * pdfD1 * sigma) / (2 * sqrtT) - rate * strike * disc * normCdf(d2);
  } else {
    delta = normCdf(d1) - 1;
    theta = -(spot * pdfD1 * sigma) / (2 * sqrtT) + rate * strike * disc * normCdf(-d2);
  }
  return { delta, gamma, theta, vega };
}

export function quote(inputs: BsInputs): OptionQuote {
  return { premium: price(inputs), greeks: greeks(inputs) };
}

/** Cash-settled intrinsic value per contract at a given spot. */
export function intrinsic(side: OptionSide, strike: number, spot: number): number {
  return side === "call" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
}

/**
 * Robinhood-style payoff curve: net P&L per contract across a range of expiry
 * spots, given the premium actually paid.
 */
export function payoffCurve(
  side: OptionSide,
  strike: number,
  premiumPaid: number,
  spotMin: number,
  spotMax: number,
  steps = 64,
): PayoffPoint[] {
  const out: PayoffPoint[] = [];
  const span = spotMax - spotMin;
  for (let i = 0; i <= steps; i++) {
    const spot = spotMin + (span * i) / steps;
    out.push({ spot, pnl: intrinsic(side, strike, spot) - premiumPaid });
  }
  return out;
}

/** Breakeven spot at expiry for a long option that paid `premiumPaid`. */
export function breakeven(side: OptionSide, strike: number, premiumPaid: number): number {
  return side === "call" ? strike + premiumPaid : strike - premiumPaid;
}
