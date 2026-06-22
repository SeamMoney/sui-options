/**
 * Direct contract tests for the public pro-options primitives the /pro
 * submission displays + relies on, which the engine/host suites only exercise
 * transitively: quote (the BS premium/greeks on the UP/DOWN buttons),
 * liveStartMs/phaseRemainingMs (the round countdown), makeRng (the deterministic
 * commit-reveal RNG), and markPerContract/unrealizedPnl (the live mark + P&L).
 *
 *   npx tsx --test packages/pro-options/test/primitives.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  quote,
  liveStartMs,
  phaseRemainingMs,
  makeRng,
  markPerContract,
  unrealizedPnl,
  intrinsic,
  type RoundConfig,
} from "../src/index.js";

const approx = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${a} ≈ ${b} (±${tol})`);

// ── quote (Black-Scholes) ───────────────────────────────────────────────────
test("quote: ATM call matches the textbook value (S=K=100, τ=1y, σ=0.2, r=0 → ~7.97)", () => {
  const q = quote({ spot: 100, strike: 100, tauYears: 1, sigma: 0.2, side: "call" });
  approx(q.premium, 7.97, 0.05, "ATM call premium");
  assert.ok(q.greeks.delta > 0 && q.greeks.delta < 1, "call delta in (0,1)");
  assert.ok(q.greeks.gamma > 0, "gamma > 0");
  assert.ok(q.greeks.vega > 0, "vega > 0");
});

test("quote: put-call parity holds at S=K, r=0 (call premium == put premium)", () => {
  const c = quote({ spot: 100, strike: 100, tauYears: 0.5, sigma: 0.3, side: "call" });
  const p = quote({ spot: 100, strike: 100, tauYears: 0.5, sigma: 0.3, side: "put" });
  approx(c.premium, p.premium, 1e-6, "ATM call==put at r=0");
  assert.ok(p.greeks.delta < 0 && p.greeks.delta > -1, "put delta in (-1,0)");
});

test("quote: at zero time-to-expiry the premium collapses to intrinsic", () => {
  const itm = quote({ spot: 120, strike: 100, tauYears: 0, sigma: 0.2, side: "call" });
  approx(itm.premium, intrinsic("call", 100, 120), 1e-9, "expiry call == intrinsic");
  const otm = quote({ spot: 90, strike: 100, tauYears: 0, sigma: 0.2, side: "call" });
  approx(otm.premium, 0, 1e-9, "OTM at expiry worthless");
});

// ── round clock ─────────────────────────────────────────────────────────────
const CFG: RoundConfig = { startedAtMs: 1_000, lobbyMs: 3_000, liveMs: 75_000, settleMs: 4_000 };

test("liveStartMs = startedAt + lobby", () => {
  assert.equal(liveStartMs(CFG), 1_000 + 3_000);
});

test("phaseRemainingMs counts down within each phase and is 0 past results", () => {
  assert.equal(phaseRemainingMs(CFG, 1_000), 3_000, "full lobby remaining at t0");
  assert.equal(phaseRemainingMs(CFG, 1_000 + 1_000), 2_000, "mid-lobby");
  assert.equal(phaseRemainingMs(CFG, 1_000 + 3_000), 75_000, "live just started → full live remaining");
  assert.equal(phaseRemainingMs(CFG, 1_000 + 3_000 + 75_000), 4_000, "settle just started");
  assert.equal(phaseRemainingMs(CFG, 1_000 + 3_000 + 75_000 + 4_000), 0, "results → 0");
  assert.equal(phaseRemainingMs(CFG, 10_000_000), 0, "far future → 0");
});

// ── makeRng (commit-reveal determinism) ─────────────────────────────────────
test("makeRng is deterministic per seed and seed-sensitive, in [0,1)", () => {
  const a = makeRng(12345);
  const b = makeRng(12345);
  const seqA = Array.from({ length: 8 }, () => a());
  const seqB = Array.from({ length: 8 }, () => b());
  assert.deepEqual(seqA, seqB, "same seed → identical stream (commit-reveal)");
  for (const x of seqA) assert.ok(x >= 0 && x < 1, "draw in [0,1)");
  const c = makeRng(12346);
  const seqC = Array.from({ length: 8 }, () => c());
  assert.notDeepEqual(seqA, seqC, "different seed → different stream");
});

// ── option mark + live P&L ──────────────────────────────────────────────────
test("markPerContract: carries time value before expiry, == intrinsic AT expiry", () => {
  const pos = { side: "call" as const, strike: 100, expiryMs: 60_000 };
  const sigma = 0.5;
  // Use yearsPerSecond = 1/60 so the 60s expiry maps to a 1-year tau, giving a
  // clearly-measurable time value (the default real-time scale makes a 60s
  // option ~all-intrinsic — see the micro-option test below).
  const before = markPerContract(pos, /*spot*/ 110, /*now*/ 0, sigma, 0, 1 / 60);
  assert.ok(before > intrinsic("call", 100, 110), "mark > intrinsic before expiry (time value)");
  const atExpiry = markPerContract(pos, 110, /*now*/ 60_000, sigma, 0, 1 / 60);
  approx(atExpiry, intrinsic("call", 100, 110), 1e-6, "mark == intrinsic at expiry (tau→0)");
});

test("markPerContract: a real-time 60s ITM option is ~all intrinsic (micro-tau regime)", () => {
  // The regime /pro actually runs in: with DEFAULT_YEARS_PER_SECOND a 60s
  // option has negligible time value, so the mark sits within a cent of
  // intrinsic — which is exactly why the live P&L tracks settlement so tightly.
  const pos = { side: "call" as const, strike: 100, expiryMs: 60_000 };
  const mark = markPerContract(pos, 110, 0, /*sigma*/ 0.5);
  const intr = intrinsic("call", 100, 110);
  assert.ok(mark >= intr - 1e-9, "never below intrinsic");
  approx(mark, intr, 0.1, "60s mark ≈ intrinsic (sub-cent time value)");
});

test("unrealizedPnl: open position marks to sell-side (spread reduces it); profit when deep ITM", () => {
  const pos = {
    side: "call" as const,
    strike: 100,
    expiryMs: 60_000,
    status: "open" as const,
    contracts: 1,
    premiumPaid: 5,
  };
  const noSpread = unrealizedPnl(pos, 130, 0, 0.4, /*spreadBps*/ 0);
  const withSpread = unrealizedPnl(pos, 130, 0, 0.4, /*spreadBps*/ 200);
  assert.ok(noSpread > 0, "deep-ITM open call is in profit vs $5 premium");
  assert.ok(withSpread < noSpread, "the 2% sell spread reduces unrealized P&L");
});
