/**
 * greeksDisplay — convert the Black-Scholes engine's raw greeks (theta per
 * YEAR, vega per 1.00 of σ) into demo-sensible quantities for a SHORT-DATED
 * (≈60s) option, where the raw annualized numbers are unintuitive.
 *
 * We surface the two greeks that actually tell the short-dated-options story:
 *  - θ as the % of PREMIUM that melts away per second (the headline for a
 *    60-second option — "your premium decays this fast just sitting there");
 *  - ν as the % the premium moves per 1 percentage-point change in the live
 *    DeepBook-derived volatility (why the σ readout matters).
 *
 * Gamma is deliberately NOT surfaced: for an ATM option seconds from expiry it
 * blows up, and the linear "Δ-change per 1% move" it implies exceeds 1 (delta
 * is bounded) — i.e. the linear approximation is invalid there, so showing it
 * would mislead rather than inform.
 */

const SECONDS_PER_YEAR = 365 * 24 * 60 * 60; // 31_536_000

/** % of the premium lost per second from time decay (always reported ≥ 0). */
export function thetaPctPerSec(thetaPerYear: number, premium: number): number {
  if (!(premium > 0) || !Number.isFinite(thetaPerYear)) return 0;
  return (Math.abs(thetaPerYear / SECONDS_PER_YEAR) / premium) * 100;
}

/** % the premium moves per 1 percentage-point (0.01) change in σ. */
export function vegaPctPerVolPoint(vega: number, premium: number): number {
  if (!(premium > 0) || !Number.isFinite(vega)) return 0;
  // vega is ∂premium/∂σ per 1.00 of σ ⇒ per 0.01 of σ is vega*0.01.
  return (Math.abs(vega * 0.01) / premium) * 100;
}

export interface GreekDisplay {
  thetaPctPerSec: number;
  vegaPctPerVolPoint: number;
}

export function displayGreeks(
  greeks: { theta: number; vega: number },
  premium: number,
): GreekDisplay {
  return {
    thetaPctPerSec: thetaPctPerSec(greeks.theta, premium),
    vegaPctPerVolPoint: vegaPctPerVolPoint(greeks.vega, premium),
  };
}
