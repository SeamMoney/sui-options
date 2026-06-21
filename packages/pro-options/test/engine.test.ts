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
  settlementPnlAtSpot,
  pnlReturnFraction,
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

// ── Live P&L == settlement (the trust-critical guarantee) ───────────────────
// The headline live readout MUST be the same number the settlement realizes,
// so a player never watches one P&L and gets paid another. settlementPnlAtSpot
// is the live readout; settleAtExpiry → realizedPnl is the settlement. They
// must agree at EVERY spot, for both sides, ITM and OTM, any contract count.
check("live P&L == realized settlement at every spot (call & put, ITM/OTM)", () => {
  for (const side of ["call", "put"] as const) {
    for (const contracts of [1, 3, 7.5]) {
      const pos = openOption({
        id: `m-${side}-${contracts}`, side, strike: 100, openedAtMs: T0,
        expiryMs, contracts, fairPremium: fair, spreadBps: 100,
      });
      for (const spot of [60, 80, 95, 99.99, 100, 100.01, 105, 120, 175]) {
        const live = settlementPnlAtSpot(pos, spot);
        const settled = realizedPnl(settleAtExpiry(pos, spot));
        assert.ok(
          Math.abs(live - settled) < 1e-9,
          `${side} ${contracts}c @ ${spot}: live ${live} != settled ${settled}`,
        );
      }
    }
  }
});

check("settlementPnlAtSpot of a closed position returns its realized P&L", () => {
  const pos = openOption({ id: "closed", side: "call", strike: 100, openedAtMs: T0, expiryMs, contracts: 1, fairPremium: fair, spreadBps: 100 });
  const settled = settleAtExpiry(pos, 130);
  // Spot argument is ignored once closed — it reads the realized proceeds.
  assert.equal(settlementPnlAtSpot(settled, 999), realizedPnl(settled));
  assert.equal(settlementPnlAtSpot(settled, 0), realizedPnl(settled));
});

check("pnlReturnFraction is P&L over premium (and 0 when no premium)", () => {
  const pos = openOption({ id: "ret", side: "call", strike: 100, openedAtMs: T0, expiryMs, contracts: 1, fairPremium: fair, spreadBps: 100 });
  const pnl = settlementPnlAtSpot(pos, 100 + pos.premiumPaid + 5);
  assert.ok(Math.abs(pnlReturnFraction(pnl, pos.premiumPaid) - pnl / pos.premiumPaid) < 1e-12);
  assert.equal(pnlReturnFraction(123, 0), 0);
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
