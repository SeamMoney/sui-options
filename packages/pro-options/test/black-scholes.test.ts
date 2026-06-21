/**
 * Edge-case tests for the Black-Scholes core that engine.test.ts doesn't cover
 * directly: the normal CDF/PDF accuracy, and the near-expiry / low-vol
 * degenerate regime — which is exactly where Wick Pro lives (10–60s options, so
 * tauYears ~ 1e-6 and σ√T → 0). A mis-handled degenerate branch would mis-price
 * every micro-option a judge trades.
 *
 *   tsx packages/pro-options/test/black-scholes.test.ts
 */
import assert from "node:assert/strict";
import {
  normCdf,
  normPdf,
  price,
  greeks,
  yearsFromSeconds,
  intrinsic,
  type BsInputs,
} from "../src/index";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log("pro-options black-scholes edge cases");

// ── normCdf / normPdf ────────────────────────────────────────────────────────

check("normCdf hits reference values within the erf approximation tolerance", () => {
  const tol = 2e-7;
  assert.ok(Math.abs(normCdf(0) - 0.5) < tol, "Φ(0) = 0.5");
  assert.ok(Math.abs(normCdf(1.96) - 0.9750021) < 1e-5, "Φ(1.96) ≈ 0.975");
  assert.ok(Math.abs(normCdf(-1.96) - 0.0249979) < 1e-5, "Φ(-1.96) ≈ 0.025");
  assert.ok(Math.abs(normCdf(1) - 0.8413447) < 1e-5, "Φ(1) ≈ 0.8413");
});

check("normCdf is symmetric, monotonic, and bounded in [0,1]", () => {
  for (const x of [-3, -1.5, -0.3, 0.3, 1.5, 3]) {
    assert.ok(Math.abs(normCdf(x) + normCdf(-x) - 1) < 1e-6, "Φ(x)+Φ(-x)=1");
  }
  assert.ok(normCdf(-2) < normCdf(0) && normCdf(0) < normCdf(2), "monotonic increasing");
  assert.ok(normCdf(-40) >= 0 && normCdf(40) <= 1, "stays in [0,1] at the tails");
});

check("normPdf peaks at 0 (1/√2π) and is symmetric", () => {
  assert.ok(Math.abs(normPdf(0) - 1 / Math.sqrt(2 * Math.PI)) < 1e-12);
  assert.ok(Math.abs(normPdf(1.3) - normPdf(-1.3)) < 1e-12, "even function");
  assert.ok(normPdf(6) < 1e-7, "vanishes in the tails");
});

// ── near-expiry / degenerate regime (Wick Pro's 10–60s options) ──────────────

check("a ~30s option prices essentially at intrinsic when far ITM/OTM", () => {
  const tau = yearsFromSeconds(30); // ~9.5e-7 years
  const itmCall: BsInputs = { spot: 110, strike: 100, tauYears: tau, sigma: 0.6, side: "call" };
  const otmCall: BsInputs = { spot: 90, strike: 100, tauYears: tau, sigma: 0.6, side: "call" };
  assert.ok(Math.abs(price(itmCall) - intrinsic("call", 100, 110)) < 0.5, "far ITM ≈ spot−strike");
  assert.ok(price(otmCall) < 0.5, "far OTM ≈ 0 with seconds left");
});

check("tau ≤ 0 and σ ≤ 0 collapse to intrinsic (no NaN/∞)", () => {
  const atExpiry: BsInputs = { spot: 105, strike: 100, tauYears: 0, sigma: 0.6, side: "call" };
  assert.equal(price(atExpiry), 5, "at expiry call = max(0, S−K)");
  const zeroVol: BsInputs = { spot: 105, strike: 100, tauYears: 0.001, sigma: 0, side: "call" };
  const p = price(zeroVol);
  assert.ok(Number.isFinite(p) && p >= 5 - 1e-9, "zero-vol ITM call ≈ intrinsic, finite");
  const zeroVolPut: BsInputs = { spot: 95, strike: 100, tauYears: 0.001, sigma: 0, side: "put" };
  assert.ok(Number.isFinite(price(zeroVolPut)), "zero-vol put is finite");
});

check("premiums are non-negative across a moneyness sweep", () => {
  for (const spot of [50, 80, 99, 100, 101, 120, 200]) {
    for (const side of ["call", "put"] as const) {
      const p = price({ spot, strike: 100, tauYears: yearsFromSeconds(45), sigma: 0.8, side });
      assert.ok(p >= 0 && Number.isFinite(p), `premium ≥ 0 (${side} @ ${spot})`);
    }
  }
});

// ── put greeks (engine.test covers the call side) ────────────────────────────

check("put delta sits in (−1, 0); gamma/vega match the call", () => {
  const base = { spot: 100, strike: 100, tauYears: 0.02, sigma: 0.6 };
  const put = greeks({ ...base, side: "put" });
  const call = greeks({ ...base, side: "call" });
  assert.ok(put.delta < 0 && put.delta > -1, "−1 < Δput < 0");
  // Δcall − Δput = 1 (BS identity).
  assert.ok(Math.abs(call.delta - put.delta - 1) < 1e-9, "Δcall − Δput = 1");
  assert.ok(Math.abs(put.gamma - call.gamma) < 1e-12, "gamma is side-independent");
  assert.ok(Math.abs(put.vega - call.vega) < 1e-12, "vega is side-independent");
});

console.log(`\npro-options black-scholes: ${passed} checks passed`);
