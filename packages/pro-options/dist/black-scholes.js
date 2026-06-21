export const SECONDS_PER_YEAR = 31_557_600; // 365.25 days
/** Convert a seconds-to-expiry (T+10..60s micro-options) into BS year units. */
export function yearsFromSeconds(seconds) {
    return seconds / SECONDS_PER_YEAR;
}
/**
 * Standard normal CDF via the Abramowitz & Stegun 7.1.26 erf approximation
 * (max abs error ~1.5e-7 — ample for pricing).
 */
export function normCdf(x) {
    return 0.5 * (1 + erf(x / Math.SQRT2));
}
/** Standard normal PDF. */
export function normPdf(x) {
    return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}
function erf(x) {
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * ax);
    const y = 1 -
        ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
            t *
            Math.exp(-ax * ax);
    return sign * y;
}
function d1d2(inputs) {
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
export function price(inputs) {
    const { spot, strike, tauYears, side, rate = 0 } = inputs;
    if (tauYears <= 0)
        return intrinsic(side, strike, spot);
    const { d1, d2 } = d1d2(inputs);
    const disc = Math.exp(-rate * tauYears);
    if (side === "call") {
        return spot * normCdf(d1) - strike * disc * normCdf(d2);
    }
    return strike * disc * normCdf(-d2) - spot * normCdf(-d1);
}
/** Greeks for a single contract. Theta is per YEAR. */
export function greeks(inputs) {
    const { spot, strike, tauYears, sigma, side, rate = 0 } = inputs;
    const { d1, d2, sqrtT } = d1d2(inputs);
    if (tauYears <= 0 || sqrtT <= 0) {
        return { delta: side === "call" ? (spot > strike ? 1 : 0) : spot < strike ? -1 : 0, gamma: 0, theta: 0, vega: 0 };
    }
    const pdfD1 = normPdf(d1);
    const disc = Math.exp(-rate * tauYears);
    const gamma = pdfD1 / (spot * sigma * sqrtT);
    const vega = spot * pdfD1 * sqrtT;
    let delta;
    let theta;
    if (side === "call") {
        delta = normCdf(d1);
        theta = -(spot * pdfD1 * sigma) / (2 * sqrtT) - rate * strike * disc * normCdf(d2);
    }
    else {
        delta = normCdf(d1) - 1;
        theta = -(spot * pdfD1 * sigma) / (2 * sqrtT) + rate * strike * disc * normCdf(-d2);
    }
    return { delta, gamma, theta, vega };
}
export function quote(inputs) {
    return { premium: price(inputs), greeks: greeks(inputs) };
}
/** Cash-settled intrinsic value per contract at a given spot. */
export function intrinsic(side, strike, spot) {
    return side === "call" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
}
/**
 * Robinhood-style payoff curve: net P&L per contract across a range of expiry
 * spots, given the premium actually paid.
 */
export function payoffCurve(side, strike, premiumPaid, spotMin, spotMax, steps = 64) {
    const out = [];
    const span = spotMax - spotMin;
    for (let i = 0; i <= steps; i++) {
        const spot = spotMin + (span * i) / steps;
        out.push({ spot, pnl: intrinsic(side, strike, spot) - premiumPaid });
    }
    return out;
}
/** Breakeven spot at expiry for a long option that paid `premiumPaid`. */
export function breakeven(side, strike, premiumPaid) {
    return side === "call" ? strike + premiumPaid : strike - premiumPaid;
}
//# sourceMappingURL=black-scholes.js.map