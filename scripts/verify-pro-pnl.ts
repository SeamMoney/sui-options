/**
 * verify-pro-pnl.ts — prove Wick Pro's core promise against LIVE market data.
 *
 * Wick Pro's headline claim is "the live P&L you watch is exactly the P&L you're
 * paid." This script proves it the way scripts/verify.ts proves the Ride game's
 * provable fairness: it pulls the REAL DeepBook mark + realized σ, opens real
 * Black-Scholes calls and puts, and at a sweep of exit prices and exit times
 * asserts that the number a player WATCHES — `unrealizedPnl` (the live
 * mark-to-close) — exactly equals the number the game PAYS — `realizedPnl` of a
 * `sellToClose` at that same instant. Same formula, same inputs, every time.
 *
 * If a single (exit price, exit time) ever disagreed by more than a rounding
 * epsilon, this exits non-zero with the offending row. It never has — the live
 * read and the settlement are one function.
 *
 *   npm run verify:pro                      # against the live DeepBook indexer
 *   POOL=DEEP_USDC npm run verify:pro
 *
 * Offline (indexer unreachable) it falls back to a fixed spot/σ and still proves
 * the guarantee — the property is data-independent; live data just makes it
 * concrete.
 */
// Import the built dist directly (plain ESM with resolved .js specifiers) — the
// package's "exports" map only defines an `import` condition, which tsx's CJS
// resolver trips over. `npm run verify:pro` builds dist first.
import {
  SECONDS_PER_YEAR,
  openOption,
  price,
  realizedPnl,
  sellToClose,
  unrealizedPnl,
  type OptionSide,
} from "../packages/pro-options/dist/index.js";

const INDEXER =
  process.env.DEEPBOOK_INDEXER_URL ??
  "https://deepbook-indexer.mainnet.mystenlabs.com";
const POOL = process.env.POOL ?? "SUI_USDC";

// Same knobs WickProLive uses.
const SPREAD_BPS = 150;
const EXPIRY_SECONDS = 60;
const STAKE_USD = 5;
const BUCKET_MS = 60_000;
const EPSILON = 1e-9;

interface Live {
  spot: number;
  sigma: number;
  source: string;
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${INDEXER}${path}`);
  if (!res.ok) throw new Error(`deepbook ${path} → HTTP ${res.status}`);
  return res.json();
}

/** Annualized realized vol from 60s close-to-close log returns. */
function realizedVol(closes: number[]): number {
  const c = closes.filter((p) => p > 0);
  if (c.length < 3) return 0.6;
  const rets: number[] = [];
  for (let i = 1; i < c.length; i++) rets.push(Math.log(c[i]! / c[i - 1]!));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance =
    rets.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  const perPeriod = Math.sqrt(variance);
  const periodsPerYear = SECONDS_PER_YEAR / (BUCKET_MS / 1000);
  const annual = perPeriod * Math.sqrt(periodsPerYear);
  if (!Number.isFinite(annual) || annual <= 0) return 0.6;
  return Math.min(5, Math.max(0.01, annual));
}

async function fetchLive(): Promise<Live> {
  try {
    const ob = (await getJson(`/orderbook/${POOL}?level=1`)) as {
      bids?: [string, string][];
      asks?: [string, string][];
    };
    const bid = Number(ob.bids?.[0]?.[0]);
    const ask = Number(ob.asks?.[0]?.[0]);
    if (!(bid > 0) || !(ask > 0)) throw new Error("empty book");
    const spot = (bid + ask) / 2;

    const trades = (await getJson(`/trades/${POOL}?limit=500`)) as Array<{
      price?: number | string;
      timestamp?: number | string;
    }>;
    // Bucket trade prices into 60s candles → closes, for realized σ.
    const byBucket = new Map<number, number>(); // bucket → last price (close)
    for (const t of trades
      .map((t) => ({ p: Number(t.price), ts: Number(t.timestamp) }))
      .filter((t) => t.p > 0 && Number.isFinite(t.ts))
      .sort((a, b) => a.ts - b.ts)) {
      byBucket.set(Math.floor(t.ts / BUCKET_MS) * BUCKET_MS, t.p);
    }
    const sigma = realizedVol([...byBucket.values()]);
    return { spot, sigma, source: `live DeepBook ${POOL}` };
  } catch (err) {
    return {
      spot: POOL === "DEEP_USDC" ? 0.0167 : 0.707,
      sigma: 0.5,
      source: `offline fallback (indexer unreachable: ${String(err)})`,
    };
  }
}

function fmt(n: number, dp = 4): string {
  return (n < 0 ? "−" : " ") + Math.abs(n).toFixed(dp);
}

async function main() {
  const live = await fetchLive();
  const { spot: S, sigma } = live;

  console.log("Wick Pro — live P&L == settlement proof");
  console.log(`source:  ${live.source}`);
  console.log(`spot:    ${S}   σ: ${(sigma * 100).toFixed(1)}%   spread: ${SPREAD_BPS}bps   expiry: ${EXPIRY_SECONDS}s`);
  console.log("");
  console.log("Opens an ATM $" + STAKE_USD + " call and put at the live mark, then at a sweep of");
  console.log("exit prices × exit times asserts the WATCHED live P&L equals the PAID settlement.");
  console.log("");
  console.log("side  exitSpot   t(s)   live P&L   settled P&L   match");
  console.log("----  --------   ----   --------   -----------   -----");

  const tauYears = EXPIRY_SECONDS / SECONDS_PER_YEAR;
  const openedAtMs = 1_000_000; // fixed virtual clock — determinism, no Date.now()
  const expiryMs = openedAtMs + EXPIRY_SECONDS * 1000;

  const exitMoves = [-0.03, -0.01, -0.001, 0, 0.001, 0.01, 0.03];
  const exitTimes = [10, 30, 59, 60]; // seconds elapsed (60 = expiry, τ=0)
  let checks = 0;
  let fails = 0;

  for (const side of ["call", "put"] as OptionSide[]) {
    const fair = price({ spot: S, strike: S, tauYears, sigma, side });
    if (!(fair > 0)) {
      console.error(`  premium for ${side} is non-positive (σ or τ degenerate)`);
      fails++;
      continue;
    }
    const perContract = fair * (1 + SPREAD_BPS / 10_000);
    const contracts = STAKE_USD / perContract; // premiumPaid == STAKE_USD
    const pos = openOption({
      id: `${side}`,
      side,
      strike: S,
      openedAtMs,
      expiryMs,
      contracts,
      fairPremium: fair,
      spreadBps: SPREAD_BPS,
    });

    for (const move of exitMoves) {
      const exitSpot = S * (1 + move);
      for (const secs of exitTimes) {
        const nowMs = openedAtMs + secs * 1000;
        // What the player WATCHES (the headline, mark-to-close):
        const watched = unrealizedPnl(pos, exitSpot, nowMs, sigma, SPREAD_BPS);
        // What the game PAYS if they exit there (CLOSE, or auto-settle at τ=0):
        const paid = realizedPnl(sellToClose(pos, exitSpot, nowMs, sigma, SPREAD_BPS));
        const match = Math.abs(watched - paid) < EPSILON;
        checks++;
        if (!match) fails++;
        if (!match || secs === 60) {
          // Print every expiry row + any mismatch.
          console.log(
            `${side.padEnd(4)}  ${exitSpot.toFixed(5).padStart(8)}   ${String(secs).padStart(4)}   ${fmt(watched).padStart(8)}   ${fmt(paid).padStart(11)}   ${match ? "ok" : "FAIL"}`,
          );
        }
      }
    }
  }

  console.log("");
  if (fails === 0) {
    console.log(`PASS — ${checks}/${checks} (price × time × side) scenarios: live P&L == settlement, to ${EPSILON}.`);
    console.log("The number you watch is the number you're paid. By construction, not by promise.");
    process.exit(0);
  } else {
    console.error(`FAIL — ${fails}/${checks} scenarios diverged. live P&L ≠ settlement.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("verify-pro-pnl: unexpected error", err);
  process.exit(1);
});
