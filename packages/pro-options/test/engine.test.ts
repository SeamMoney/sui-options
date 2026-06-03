import assert from "node:assert/strict";
import {
  breakeven,
  commit,
  generatePath,
  greeks,
  intrinsic,
  openOption,
  pathToCandles,
  payoffCurve,
  price,
  realizedPnl,
  revealedSteps,
  roundPhase,
  sellToClose,
  settleAtExpiry,
  yearsFromSeconds,
  type RoundConfig,
} from "../src/index";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log("pro-options engine");

// ── Black-Scholes ──────────────────────────────────────────────────────────
check("BS call matches textbook (S=K=100, τ=1y, σ=0.2, r=0 → ~7.97)", () => {
  const call = price({ spot: 100, strike: 100, tauYears: 1, sigma: 0.2, side: "call", rate: 0 });
  assert.ok(Math.abs(call - 7.9656) < 0.02, `got ${call}`);
});

check("put-call parity (S=K, r=0 ⇒ put == call)", () => {
  const args = { spot: 100, strike: 100, tauYears: 1, sigma: 0.2, rate: 0 } as const;
  const call = price({ ...args, side: "call" });
  const put = price({ ...args, side: "put" });
  assert.ok(Math.abs(call - put) < 1e-9, `call ${call} put ${put}`);
});

check("intrinsic is correct for calls and puts", () => {
  assert.equal(intrinsic("call", 100, 110), 10);
  assert.equal(intrinsic("call", 100, 90), 0);
  assert.equal(intrinsic("put", 100, 90), 10);
  assert.equal(intrinsic("put", 100, 110), 0);
});

check("at expiry, price == intrinsic", () => {
  assert.equal(price({ spot: 110, strike: 100, tauYears: 0, sigma: 0.6, side: "call" }), 10);
  assert.equal(price({ spot: 90, strike: 100, tauYears: 0, sigma: 0.6, side: "call" }), 0);
});

check("greeks are well-signed (call: 0<Δ<1, Γ>0, vega>0, Θ<0)", () => {
  const g = greeks({ spot: 100, strike: 100, tauYears: 1, sigma: 0.2, side: "call", rate: 0 });
  assert.ok(g.delta > 0 && g.delta < 1, `delta ${g.delta}`);
  assert.ok(Math.abs(g.delta - 0.5398) < 0.01, `delta ${g.delta}`); // N(d1), d1=0.1
  assert.ok(g.gamma > 0, `gamma ${g.gamma}`);
  assert.ok(g.vega > 0, `vega ${g.vega}`);
  assert.ok(g.theta < 0, `theta ${g.theta}`);
  const pg = greeks({ spot: 100, strike: 100, tauYears: 1, sigma: 0.2, side: "put", rate: 0 });
  assert.ok(pg.delta < 0 && pg.delta > -1, `put delta ${pg.delta}`);
});

check("payoff curve & breakeven line up", () => {
  const curve = payoffCurve("call", 100, 5, 80, 120, 40);
  assert.equal(curve.length, 41);
  assert.equal(curve[0].pnl, -5); // deep OTM → lose premium
  const be = breakeven("call", 100, 5);
  assert.equal(be, 105);
  assert.ok(Math.abs(intrinsic("call", 100, be) - 5) < 1e-9); // intrinsic at breakeven == premium
});

// ── Option lifecycle ───────────────────────────────────────────────────────
const SIGMA = 0.6;
const T0 = 1_000_000;
const expiryMs = T0 + 60_000;
const tauYears = yearsFromSeconds(60);
const fair = price({ spot: 100, strike: 100, tauYears, sigma: SIGMA, side: "call" });

check("openOption applies the buy-side spread (pays more than fair)", () => {
  const pos = openOption({ id: "a", side: "call", strike: 100, openedAtMs: T0, expiryMs, contracts: 2, fairPremium: fair, spreadBps: 100 });
  assert.ok(pos.premiumPaid > fair * 2, "should pay above fair");
  assert.ok(Math.abs(pos.premiumPaid - fair * 1.01 * 2) < 1e-9);
});

check("settle ITM pays intrinsic; OTM expires worthless", () => {
  const base = openOption({ id: "b", side: "call", strike: 100, openedAtMs: T0, expiryMs, contracts: 1, fairPremium: fair, spreadBps: 100 });
  const itm = settleAtExpiry(base, 110);
  assert.equal(itm.status, "settled_itm");
  assert.equal(itm.proceeds, 10);
  const otm = settleAtExpiry(base, 95);
  assert.equal(otm.status, "expired_worthless");
  assert.equal(otm.proceeds, 0);
});

check("sell-to-close marks the position and the spread is a round-trip loss", () => {
  const pos = openOption({ id: "c", side: "call", strike: 100, openedAtMs: T0, expiryMs, contracts: 1, fairPremium: fair, spreadBps: 100 });
  // Sell immediately at the same spot/time: pure spread cost, no market move.
  const sold = sellToClose(pos, 100, T0, SIGMA, 100);
  assert.equal(sold.status, "sold");
  assert.ok((sold.proceeds ?? 0) < pos.premiumPaid, "round-trip should lose the spread");
  assert.ok(realizedPnl(sold) < 0, "house edge: immediate round-trip is negative");
});

check("settle is idempotent (re-settling a closed position is a no-op)", () => {
  const pos = openOption({ id: "d", side: "put", strike: 100, openedAtMs: T0, expiryMs, contracts: 1, fairPremium: fair, spreadBps: 0 });
  const once = settleAtExpiry(pos, 80);
  const twice = settleAtExpiry(once, 80);
  assert.deepEqual(once, twice);
});

// ── Deterministic paths ────────────────────────────────────────────────────
const baseParams = { seed: 12345, steps: 300, startPrice: 100, driftAnnual: 0, sigmaAnnual: 0.8, stepMs: 200 };

check("same seed + params ⇒ identical path (commit-reveal verifiable)", () => {
  assert.deepEqual(generatePath(baseParams), generatePath({ ...baseParams }));
});

check("different seed ⇒ different path", () => {
  const a = generatePath(baseParams);
  const b = generatePath({ ...baseParams, seed: 999 });
  assert.notDeepEqual(a, b);
  assert.equal(a.length, baseParams.steps + 1);
});

check("rug biases the realized path downward", () => {
  const clean = generatePath({ ...baseParams, rugChanceBps: 0 });
  const rugged = generatePath({ ...baseParams, rugChanceBps: 400, rugDownPct: 0.06 });
  assert.ok(rugged[rugged.length - 1] < clean[clean.length - 1], `rugged ${rugged.at(-1)} vs clean ${clean.at(-1)}`);
});

check("pathToCandles produces valid OHLC", () => {
  const prices = generatePath(baseParams);
  const candles = pathToCandles(prices, 10, 0, 1);
  assert.ok(candles.length > 0);
  for (const c of candles) {
    assert.ok(c.high >= Math.max(c.open, c.close) - 1e-9, "high bounds body");
    assert.ok(c.low <= Math.min(c.open, c.close) + 1e-9, "low bounds body");
  }
});

// ── Round clock ────────────────────────────────────────────────────────────
const round: RoundConfig = { startedAtMs: 0, lobbyMs: 60_000, liveMs: 90_000, settleMs: 5_000 };

check("round phases advance lobby → live → settle → results", () => {
  assert.equal(roundPhase(round, 1_000), "lobby");
  assert.equal(roundPhase(round, 60_001), "live");
  assert.equal(roundPhase(round, 150_001), "settle");
  assert.equal(roundPhase(round, 156_000), "results");
});

check("revealedSteps is 0 in lobby and full at live end, monotonic between", () => {
  assert.equal(revealedSteps(round, 30_000, 100), 0);
  assert.equal(revealedSteps(round, 60_000 + 45_000, 100), 50);
  assert.equal(revealedSteps(round, 60_000 + 90_000, 100), 100);
  assert.ok(revealedSteps(round, 60_000 + 30_000, 100) <= revealedSteps(round, 60_000 + 60_000, 100));
});

check("commit is deterministic and seed-sensitive", () => {
  assert.equal(commit(1, "{}"), commit(1, "{}"));
  assert.notEqual(commit(1, "{}"), commit(2, "{}"));
});

console.log(`\n${passed} checks passed`);
