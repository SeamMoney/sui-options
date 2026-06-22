/**
 * Unit test for Wick Pro's core promise — "the number you watch is the number
 * you're paid" — offline. verify-pro-pnl.ts asserts this against LIVE DeepBook
 * data, so a judge can't confirm it cold; but the identity (watched unrealized
 * P&L == realized settlement P&L at exit) is a property of the pricing functions,
 * INDEPENDENT of the live spot — the live spot only sets the base. So we replay
 * the exact (side × move × time) grid the script uses, with a fixed spot, and
 * assert watched == paid everywhere. This is the /pro analogue of the seeded-path
 * / Bachelier golden vectors: it locks live==settlement in CI without a network.
 *
 * Run: npx tsx --test scripts/verify-pro-pnl.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  SECONDS_PER_YEAR,
  openOption,
  price,
  realizedPnl,
  sellToClose,
  unrealizedPnl,
  type OptionSide,
} from "../packages/pro-options/src/index";

// The same knobs WickProLive / verify-pro-pnl.ts use.
const SPREAD_BPS = 150;
const EXPIRY_SECONDS = 60;
const STAKE_USD = 5;
const EPSILON = 1e-9;
const tauYears = EXPIRY_SECONDS / SECONDS_PER_YEAR;
const openedAtMs = 1_000_000;
const expiryMs = openedAtMs + EXPIRY_SECONDS * 1000;
const exitMoves = [-0.03, -0.01, -0.001, 0, 0.001, 0.01, 0.03];
const exitTimes = [10, 30, 59, 60]; // 60s = expiry, τ=0

// A few (spot, sigma) regimes — the identity must hold for ALL of them, proving
// it's structural (one function for display + settlement), not spot-specific.
const REGIMES: Array<{ spot: number; sigma: number }> = [
  { spot: 1.0, sigma: 0.6 },
  { spot: 0.707, sigma: 0.9 },
  { spot: 142.5, sigma: 0.35 },
];

test("/pro: live P&L == settlement P&L for every (regime × side × move × time)", () => {
  let checks = 0;
  for (const { spot: S, sigma } of REGIMES) {
    for (const side of ["call", "put"] as OptionSide[]) {
      const fair = price({ spot: S, strike: S, tauYears, sigma, side });
      assert.ok(fair > 0, `${side} premium must be positive (S=${S}, σ=${sigma})`);
      const perContract = fair * (1 + SPREAD_BPS / 10_000);
      const contracts = STAKE_USD / perContract;
      const pos = openOption({
        id: side, side, strike: S, openedAtMs, expiryMs, contracts,
        fairPremium: fair, spreadBps: SPREAD_BPS,
      });
      for (const move of exitMoves) {
        const exitSpot = S * (1 + move);
        for (const secs of exitTimes) {
          const nowMs = openedAtMs + secs * 1000;
          const watched = unrealizedPnl(pos, exitSpot, nowMs, sigma, SPREAD_BPS);
          const paid = realizedPnl(sellToClose(pos, exitSpot, nowMs, sigma, SPREAD_BPS));
          assert.ok(
            Math.abs(watched - paid) < EPSILON,
            `S=${S} σ=${sigma} ${side} move=${move} t=${secs}s: watched ${watched} != paid ${paid}`,
          );
          checks++;
        }
      }
    }
  }
  assert.equal(checks, REGIMES.length * 2 * exitMoves.length * exitTimes.length);
});
