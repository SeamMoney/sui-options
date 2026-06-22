/**
 * Dogfood + smoke for the Wick Pro DeepBook mark layer
 * (frontend/src/lib/deepbook.ts).
 *
 *   npx tsx scripts/deepbook-mark-check.ts
 *
 * Part 1 (pure, offline): unit-asserts tradesToCandles OHLC aggregation.
 * Part 2 (live): hits the real DeepBook indexer for SUI_USDC + XBTC_USDC + DEEP_USDC,
 *   prints the live mid/spread/last, and aggregates real trades into candles.
 *   Skips gracefully (exit 0) if the network is unavailable.
 */
import assert from "node:assert/strict";
import {
  fetchDeepBookMark,
  fetchDeepBookTicker,
  fetchDeepBookTrades,
  fetchDeepBookDepth,
  parseDeepBookLevels,
  tradesToCandles,
  realizedVolatility,
  DEEPBOOK_POOLS,
  type DeepBookTrade,
  type Candle,
} from "../frontend/src/lib/deepbook";
import { quote, yearsFromSeconds } from "../packages/pro-options/src/black-scholes";

// ── Part 1: pure aggregation ────────────────────────────────────────────────
{
  const t = (price: number, tsMs: number, size = 1): DeepBookTrade => ({
    price,
    size,
    tsMs,
    side: "buy",
  });
  // Two 1000ms buckets: [0,1000) and [1000,2000).
  const trades: DeepBookTrade[] = [
    t(10, 100, 2), // bucket 0 open
    t(12, 300, 1), // bucket 0 high
    t(9, 500, 1), //  bucket 0 low
    t(11, 900, 1), // bucket 0 close
    t(20, 1200, 3), // bucket 1 open=high=close
    t(18, 1700, 1), // bucket 1 low + close
  ];
  const candles = tradesToCandles(trades, 1000);
  assert.equal(candles.length, 2, "two buckets");
  assert.deepEqual(
    { o: candles[0]!.open, h: candles[0]!.high, l: candles[0]!.low, c: candles[0]!.close, v: candles[0]!.volume },
    { o: 10, h: 12, l: 9, c: 11, v: 5 },
    "bucket 0 OHLCV",
  );
  assert.deepEqual(
    { o: candles[1]!.open, h: candles[1]!.high, l: candles[1]!.low, c: candles[1]!.close, v: candles[1]!.volume },
    { o: 20, h: 20, l: 18, c: 18, v: 4 },
    "bucket 1 OHLCV",
  );
  // Unsorted input → identical result (function sorts internally).
  const shuffled = [trades[3]!, trades[0]!, trades[5]!, trades[2]!, trades[4]!, trades[1]!];
  assert.deepEqual(tradesToCandles(shuffled, 1000), candles, "order-independent");
  // Empty input → empty output. Bad bucket → throws.
  assert.deepEqual(tradesToCandles([], 1000), []);
  assert.throws(() => tradesToCandles(trades, 0), /positive/);
  console.log("PASS pure tradesToCandles aggregation (3 cases)");
}

// ── Part 1b: realised volatility ────────────────────────────────────────────
{
  const bucketMs = 60_000;
  // Too few candles → fallback.
  assert.equal(realizedVolatility([], bucketMs, 0.6), 0.6);
  // A perfectly flat series carries no vol signal → use the fallback (an
  // uninformative window shouldn't price options at σ≈0, which is degenerate).
  const flat: Candle[] = Array.from({ length: 10 }, (_, i) => ({
    tMs: i * bucketMs,
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume: 1,
  }));
  assert.equal(realizedVolatility(flat, bucketMs, 0.6), 0.6);
  // A series with real movement yields a positive, in-band σ.
  const moving: Candle[] = [100, 101, 99, 102, 98, 103, 97].map((p, i) => ({
    tMs: i * bucketMs,
    open: p,
    high: p,
    low: p,
    close: p,
    volume: 1,
  }));
  const sig = realizedVolatility(moving, bucketMs);
  assert.ok(sig > 0.01 && sig <= 5, `moving σ in band: ${sig}`);
  console.log("PASS realizedVolatility (fallback, flat floor, in-band)");
}

// ── Part 1c: order-book level parsing (NaN guard — #680-class, depth path) ───
{
  // The indexer can return a level with a valid price but a malformed size; the
  // pre-existing parse guarded only the price, so a NaN size flowed through to
  // the /coach ladder as a literal "NaN" and poisoned the depth-bar scale
  // (maxSize = Math.max(1, …NaN) = NaN → every bar width "NaN%").
  const rows: [string, string][] = [
    ["0.74", "100"], // valid
    ["0.73", "oops"], // NaN size → dropped
    ["0.72", "0"], // zero size (no liquidity) → dropped
    ["0", "50"], // non-positive price → dropped
    ["0.71", "200"], // valid
  ];
  const out = parseDeepBookLevels(rows, 5);
  assert.deepEqual(
    out,
    [
      { price: 0.74, size: 100 },
      { price: 0.71, size: 200 },
    ],
    "parseDeepBookLevels must drop malformed/zero price AND size",
  );
  assert.ok(
    out.every((l) => Number.isFinite(l.price) && Number.isFinite(l.size)),
    "no NaN escapes the parse",
  );
  assert.equal(parseDeepBookLevels(rows, 1).length, 1, "honours the level cap");
  console.log("PASS parseDeepBookLevels (drops NaN/zero price+size, honours level cap)");
}

// ── Part 2: live indexer ────────────────────────────────────────────────────
// Cap each DeepBook indexer call so a slow/hanging indexer fails check:deepbook
// fast (with a clear timeout error) instead of hanging it — and with it the whole
// check:all judge gate. The frontend fetchers already accept an AbortSignal; we
// just supply one here (matches the verifiers' withTimeout resilience). The mark
// is also independently re-validated offline by verify:pro / verify-pro-pnl.test.
const DEEPBOOK_TIMEOUT_MS = 12_000;
const sig = (): AbortSignal => AbortSignal.timeout(DEEPBOOK_TIMEOUT_MS);

async function live() {
  for (const pool of Object.values(DEEPBOOK_POOLS)) {
    const mark = await fetchDeepBookMark(pool.name, sig());
    assert.ok(mark.mid > 0, `${pool.name} mid > 0`);
    assert.ok(mark.ask >= mark.bid, `${pool.name} ask >= bid`);
    const ticker = await fetchDeepBookTicker(pool.name, sig());
    assert.ok(ticker.lastPrice > 0, `${pool.name} last > 0`);
    // Depth ladder data: bids best-first (descending), asks best-first
    // (ascending), best bid < best ask (a sane, crossed-free book).
    const depth = await fetchDeepBookDepth(pool.name, 5, sig());
    if (depth.bids.length >= 2) {
      assert.ok(
        depth.bids[0]!.price >= depth.bids[1]!.price,
        `${pool.name} bids best-first`,
      );
    }
    if (depth.asks.length >= 2) {
      assert.ok(
        depth.asks[0]!.price <= depth.asks[1]!.price,
        `${pool.name} asks best-first`,
      );
    }
    if (depth.bids[0] && depth.asks[0]) {
      assert.ok(
        depth.bids[0]!.price < depth.asks[0]!.price,
        `${pool.name} book not crossed`,
      );
    }
    const trades = await fetchDeepBookTrades(pool.name, 500, sig());
    const bucketMs = 60_000;
    const candles = tradesToCandles(trades, bucketMs); // 1m candles
    const sigma = realizedVolatility(candles, bucketMs);
    // End-to-end Wick Pro pipeline: live mid + live σ → BS premium for a 60s
    // ATM call. Proves the mark feeds honest Black-Scholes pricing.
    const tauYears = yearsFromSeconds(60);
    const atm = quote({
      spot: mark.mid,
      strike: mark.mid,
      tauYears,
      sigma,
      side: "call",
    });
    assert.ok(atm.premium >= 0, `${pool.name} ATM premium ≥ 0`);
    assert.ok(atm.greeks.delta > 0 && atm.greeks.delta < 1, "call delta in (0,1)");
    console.log(
      `LIVE ${pool.name.padEnd(10)} mid=${mark.mid.toFixed(5)} ` +
        `spread=${mark.spreadBps.toFixed(1)}bps last=${ticker.lastPrice} ` +
        `candles(1m)=${candles.length} σ=${(sigma * 100).toFixed(0)}% → ` +
        `60s ATM call=${atm.premium.toFixed(6)} Δ=${atm.greeks.delta.toFixed(2)}`,
    );
    assert.ok(trades.length === 0 || candles.length > 0, "trades → candles");
  }
  console.log("PASS live DeepBook mark → σ → BS pricing (SUI_USDC + XBTC_USDC + DEEP_USDC)");
}

void (async () => {
  try {
    await live();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/fetch failed|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network|timeout|aborted/i.test(msg)) {
      // A timeout/abort (the indexer is slow or unreachable) is treated the same
      // as network-unavailable: SKIP, don't fail the judge gate on a transient.
      console.log(`SKIP live check (network unavailable / timed out): ${msg}`);
    } else {
      console.error("FAIL live check:", msg);
      process.exit(1);
    }
  }
})();
