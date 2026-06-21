/**
 * Dogfood + smoke for the Wick Pro DeepBook mark layer
 * (frontend/src/lib/deepbook.ts).
 *
 *   npx tsx scripts/deepbook-mark-check.ts
 *
 * Part 1 (pure, offline): unit-asserts tradesToCandles OHLC aggregation.
 * Part 2 (live): hits the real DeepBook indexer for SUI_USDC + DEEP_USDC,
 *   prints the live mid/spread/last, and aggregates real trades into candles.
 *   Skips gracefully (exit 0) if the network is unavailable.
 */
import assert from "node:assert/strict";
import {
  fetchDeepBookMark,
  fetchDeepBookTicker,
  fetchDeepBookTrades,
  tradesToCandles,
  DEEPBOOK_POOLS,
  type DeepBookTrade,
} from "../frontend/src/lib/deepbook";

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

// ── Part 2: live indexer ────────────────────────────────────────────────────
async function live() {
  for (const pool of Object.values(DEEPBOOK_POOLS)) {
    const mark = await fetchDeepBookMark(pool.name);
    assert.ok(mark.mid > 0, `${pool.name} mid > 0`);
    assert.ok(mark.ask >= mark.bid, `${pool.name} ask >= bid`);
    const ticker = await fetchDeepBookTicker(pool.name);
    assert.ok(ticker.lastPrice > 0, `${pool.name} last > 0`);
    const trades = await fetchDeepBookTrades(pool.name, 200);
    const candles = tradesToCandles(trades, 60_000); // 1m candles
    console.log(
      `LIVE ${pool.name.padEnd(10)} mid=${mark.mid.toFixed(5)} ` +
        `spread=${mark.spreadBps.toFixed(1)}bps last=${ticker.lastPrice} ` +
        `trades=${trades.length} candles(1m)=${candles.length}`,
    );
    assert.ok(trades.length === 0 || candles.length > 0, "trades → candles");
  }
  console.log("PASS live DeepBook mark (SUI_USDC + DEEP_USDC)");
}

void (async () => {
  try {
    await live();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/fetch failed|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network/i.test(msg)) {
      console.log(`SKIP live check (network unavailable): ${msg}`);
    } else {
      console.error("FAIL live check:", msg);
      process.exit(1);
    }
  }
})();
