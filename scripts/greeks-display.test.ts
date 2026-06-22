/**
 * Offline test for the short-dated greek display conversions
 * (frontend/src/lib/greeksDisplay.ts). Getting units wrong here would MISLEAD
 * on the /coach desk (the exact failure mode that bit the rug verifier), so pin
 * the math: explicit known-value checks + an integration check that the real
 * Black-Scholes greeks for a 60-second ATM option convert to sane ranges.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  thetaPctPerSec,
  vegaPctPerVolPoint,
  displayGreeks,
} from "../frontend/src/lib/greeksDisplay.ts";
import { greeks, price } from "../packages/pro-options/src/black-scholes.js";

test("thetaPctPerSec: % of premium melted per second", () => {
  // theta = -31_536_000/yr (= -1/sec), premium = 1 ⇒ 100%/sec.
  assert.equal(thetaPctPerSec(-31_536_000, 1), 100);
  // half that decay rate ⇒ 50%/sec; sign-agnostic.
  assert.equal(thetaPctPerSec(15_768_000, 1), 50);
  // guards: zero/insane premium or non-finite theta ⇒ 0, never NaN/Infinity.
  assert.equal(thetaPctPerSec(-100, 0), 0);
  assert.equal(thetaPctPerSec(Number.NaN, 1), 0);
});

test("vegaPctPerVolPoint: % premium moved per 1 vol-point", () => {
  // vega = 100/σ-unit, premium = 1 ⇒ per 0.01 σ moves 1.0 ⇒ 100% of premium.
  assert.equal(vegaPctPerVolPoint(100, 1), 100);
  assert.equal(vegaPctPerVolPoint(50, 1), 50);
  assert.equal(vegaPctPerVolPoint(10, 0), 0);
});

test("real 60s ATM greeks convert to sane, finite ranges", () => {
  const tauYears = 60 / 31_536_000; // 60 seconds
  const inputs = { spot: 100, strike: 100, tauYears, sigma: 0.6, side: "call" as const };
  const g = greeks(inputs);
  const premium = price(inputs);
  const d = displayGreeks(g, premium);
  // Both finite, non-negative, and not absurd (a 60s option decays fast but a
  // sane %/s, and vega is a modest % of premium).
  for (const v of [d.thetaPctPerSec, d.vegaPctPerVolPoint]) {
    assert.ok(Number.isFinite(v) && v >= 0, `non-finite/negative: ${v}`);
  }
  assert.ok(d.thetaPctPerSec > 0 && d.thetaPctPerSec < 50, `theta %/s out of range: ${d.thetaPctPerSec}`);
  assert.ok(d.vegaPctPerVolPoint > 0 && d.vegaPctPerVolPoint < 100, `vega %/pt out of range: ${d.vegaPctPerVolPoint}`);
});
