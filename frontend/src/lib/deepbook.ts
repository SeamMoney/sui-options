/**
 * Live DeepBook mark — the price source for Wick Pro.
 *
 * Wick Pro prices Black-Scholes options off a REAL on-chain CLOB mark
 * (DeepBook v3: SUI_USDC / DEEP_USDC) instead of a synthetic path. This module
 * is the single I/O boundary to the public DeepBook indexer:
 *
 *   - fetchDeepBookMark(pool)   → top-of-book mid (the spot S we price against)
 *   - fetchDeepBookTicker(pool) → last trade + 24h volume
 *   - fetchDeepBookTrades(pool) → recent trades (for the CandleVision panel)
 *   - tradesToCandles(...)      → pure OHLC aggregation (unit-tested)
 *
 * Everything here is framework-agnostic and side-effect-free except the three
 * `fetch` calls. The React polling wrapper lives in
 * hooks/useDeepBookMark.ts.
 *
 * Indexer reference: https://docs.sui.io/standards/deepbookv3-indexer
 */

/**
 * Public DeepBook v3 indexer. Mainnet is used as the price *reference* even
 * though Wick settles on testnet — testnet has no liquid CLOB to mark against,
 * and the mark is a read-only oracle, never a settlement venue. Override with
 * VITE_DEEPBOOK_INDEXER_URL.
 */
export const DEEPBOOK_INDEXER_URL: string =
  (import.meta.env?.VITE_DEEPBOOK_INDEXER_URL as string | undefined) ??
  "https://deepbook-indexer.mainnet.mystenlabs.com";

export interface DeepBookPool {
  /** Indexer pool name, e.g. "SUI_USDC". */
  readonly name: string;
  /** Base asset ticker, e.g. "SUI". */
  readonly base: string;
  /** Quote asset ticker, e.g. "USDC". */
  readonly quote: string;
  /** Short display label for the underlying. */
  readonly label: string;
  /** On-chain DeepBook v3 pool object id (mainnet) — the mid is read from this
   *  real CLOB; link it on an explorer to prove the mark isn't fabricated. */
  readonly poolId: string;
}

/** The pools Wick Pro can mark against. SUI_USDC is the default (deepest).
 *  Consumers iterate Object.keys(DEEPBOOK_POOLS) (the /pro asset toggle, the
 *  check:deepbook smoke), so adding a pool here auto-wires a new asset tab. */
export const DEEPBOOK_POOLS = {
  SUI_USDC: { name: "SUI_USDC", base: "SUI", quote: "USDC", label: "SUI", poolId: "0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407" },
  XBTC_USDC: { name: "XBTC_USDC", base: "XBTC", quote: "USDC", label: "BTC", poolId: "0x20b9a3ec7a02d4f344aa1ebc5774b7b0ccafa9a5d76230662fdc0300bb215307" },
  DEEP_USDC: { name: "DEEP_USDC", base: "DEEP", quote: "USDC", label: "DEEP", poolId: "0xf948981b806057580f91622417534f491da5f61aeaf33d0ed8e69fd5691c95ce" },
} as const satisfies Record<string, DeepBookPool>;

/** Explorer URL for a pool's on-chain DeepBook object (mainnet CLOB). */
export function deepBookPoolExplorerUrl(pool: DeepBookPoolName): string {
  return `https://suiscan.xyz/mainnet/object/${DEEPBOOK_POOLS[pool].poolId}`;
}

export type DeepBookPoolName = keyof typeof DEEPBOOK_POOLS;

export const DEFAULT_POOL: DeepBookPoolName = "SUI_USDC";

/** Top-of-book snapshot — the live spot we price options against. */
export interface DeepBookMark {
  readonly pool: string;
  /** (bestBid + bestAsk) / 2 — the option-pricing spot S. */
  readonly mid: number;
  readonly bid: number;
  readonly ask: number;
  /** Bid/ask spread in basis points of the mid. */
  readonly spreadBps: number;
  /** Indexer book timestamp (ms), or fetch time if absent. */
  readonly tsMs: number;
}

export interface DeepBookTicker {
  readonly pool: string;
  readonly lastPrice: number;
  readonly baseVolume: number;
  readonly quoteVolume: number;
  readonly isFrozen: boolean;
}

export interface DeepBookTrade {
  readonly price: number;
  /** Size in base units. */
  readonly size: number;
  readonly tsMs: number;
  readonly side: "buy" | "sell";
}

export interface Candle {
  /** Bucket start (ms). */
  readonly tMs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(`${DEEPBOOK_INDEXER_URL}${path}`, { signal });
  if (!res.ok) {
    throw new Error(`deepbook ${path} → HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Top-of-book mid for a pool. Throws on an empty book or a non-2xx — callers
 * (the React hook) decide how to surface that.
 */
export async function fetchDeepBookMark(
  pool: string,
  signal?: AbortSignal,
): Promise<DeepBookMark> {
  const data = (await getJson(`/orderbook/${pool}?level=1`, signal)) as {
    bids?: [string, string][];
    asks?: [string, string][];
    timestamp?: string | number;
  };
  const bids = data.bids ?? [];
  const asks = data.asks ?? [];
  if (bids.length === 0 || asks.length === 0) {
    throw new Error(`deepbook ${pool}: empty order book`);
  }
  const bid = Number(bids[0]![0]);
  const ask = Number(asks[0]![0]);
  // Guard non-finite / non-positive top-of-book (matches the filtering in
  // fetchDeepBookDepth/Trades). Without this, a malformed/null price string from
  // the indexer yields mid=NaN, which propagates to a literal "$NaN" header + bet
  // buttons + "+$NaN" P&L on /pro — and the cold-start fallback never fires (it
  // checks `=== null`, and NaN !== null). Throwing flips the hook to stale/cold-start.
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
    throw new Error(
      `deepbook ${pool}: malformed top-of-book price (bid=${bids[0]![0]}, ask=${asks[0]![0]})`,
    );
  }
  const mid = (bid + ask) / 2;
  const spreadBps = mid > 0 ? ((ask - bid) / mid) * 10_000 : 0;
  const tsMs = Number(data.timestamp) || Date.now();
  return { pool, mid, bid, ask, spreadBps, tsMs };
}

/** 24h ticker (last price + volumes) for a pool. */
export async function fetchDeepBookTicker(
  pool: string,
  signal?: AbortSignal,
): Promise<DeepBookTicker> {
  const all = (await getJson(`/ticker`, signal)) as Record<
    string,
    {
      last_price?: number;
      base_volume?: number;
      quote_volume?: number;
      isFrozen?: number;
    }
  >;
  const t = all[pool];
  if (!t) throw new Error(`deepbook ticker: pool ${pool} not found`);
  return {
    pool,
    lastPrice: Number(t.last_price) || 0,
    baseVolume: Number(t.base_volume) || 0,
    quoteVolume: Number(t.quote_volume) || 0,
    isFrozen: Boolean(t.isFrozen),
  };
}

/** One price level in the order book. */
export interface DeepBookLevel {
  readonly price: number;
  /** Resting size at this level, in base units. */
  readonly size: number;
}

/** Top-of-book depth — the real on-chain CLOB ladder (proof of liquidity). */
export interface DeepBookDepth {
  readonly pool: string;
  /** Bids, best (highest) first. */
  readonly bids: DeepBookLevel[];
  /** Asks, best (lowest) first. */
  readonly asks: DeepBookLevel[];
  readonly tsMs: number;
}

/**
 * Top `levels` bids and asks from the DeepBook order book — the real resting
 * liquidity, for a "this is a live on-chain CLOB" depth ladder.
 */
export async function fetchDeepBookDepth(
  pool: string,
  levels = 5,
  signal?: AbortSignal,
): Promise<DeepBookDepth> {
  const data = (await getJson(
    `/orderbook/${pool}?level=2&depth=${levels * 2}`,
    signal,
  )) as {
    bids?: [string, string][];
    asks?: [string, string][];
    timestamp?: string | number;
  };
  const parse = (rows: [string, string][] | undefined): DeepBookLevel[] =>
    (rows ?? [])
      .map(([p, s]): DeepBookLevel => ({ price: Number(p), size: Number(s) }))
      .filter((l) => Number.isFinite(l.price) && l.price > 0)
      .slice(0, levels);
  return {
    pool,
    bids: parse(data.bids),
    asks: parse(data.asks),
    tsMs: Number(data.timestamp) || Date.now(),
  };
}

/** Recent trades, oldest-first, for candle aggregation. */
export async function fetchDeepBookTrades(
  pool: string,
  limit = 200,
  signal?: AbortSignal,
): Promise<DeepBookTrade[]> {
  const raw = (await getJson(
    `/trades/${pool}?limit=${limit}`,
    signal,
  )) as Array<{
    price?: number | string;
    base_volume?: number | string;
    timestamp?: number | string;
    type?: string;
  }>;
  return raw
    .map((t): DeepBookTrade | null => {
      const price = Number(t.price);
      const tsMs = Number(t.timestamp);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(tsMs)) {
        return null;
      }
      return {
        price,
        size: Number(t.base_volume) || 0,
        tsMs,
        side: t.type === "buy" ? "buy" : "sell",
      };
    })
    .filter((t): t is DeepBookTrade => t !== null)
    .sort((a, b) => a.tsMs - b.tsMs);
}

/**
 * Aggregate trades into fixed-width OHLC candles. Pure — unit-tested in
 * deepbook.test.ts. Buckets are aligned to `bucketMs` (epoch-anchored) so two
 * clients aggregating the same trades produce identical candles. Empty input →
 * empty output.
 */
/** Seconds in a year (365.25d) — matches @sui-options/pro-options BS convention. */
export const SECONDS_PER_YEAR = 31_557_600;

/**
 * Annualised realised volatility (σ) from a candle series — the missing input
 * that makes Wick Pro's Black-Scholes premiums *real* rather than a guessed
 * constant. σ = stdev(log close-to-close returns) × √(periods per year), where
 * the period length is inferred from the candle spacing (`bucketMs`).
 *
 * Pure + unit-tested. Returns `fallback` (default 0.6 ≈ a plausible crypto vol)
 * when there are too few candles to estimate, so callers always have a usable
 * σ to price with. Clamped to a sane [0.01, 5] band against degenerate inputs.
 */
export function realizedVolatility(
  candles: readonly Candle[],
  bucketMs: number,
  fallback = 0.6,
): number {
  if (bucketMs <= 0) throw new Error("bucketMs must be positive");
  const closes = candles.map((c) => c.close).filter((p) => p > 0);
  if (closes.length < 3) return fallback;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    rets.push(Math.log(closes[i]! / closes[i - 1]!));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance =
    rets.reduce((a, r) => a + (r - mean) * (r - mean), 0) /
    Math.max(1, rets.length - 1);
  const sigmaPerPeriod = Math.sqrt(variance);
  const periodsPerYear = SECONDS_PER_YEAR / (bucketMs / 1000);
  const annual = sigmaPerPeriod * Math.sqrt(periodsPerYear);
  if (!Number.isFinite(annual) || annual <= 0) return fallback;
  return Math.min(5, Math.max(0.01, annual));
}

export function tradesToCandles(
  trades: readonly DeepBookTrade[],
  bucketMs: number,
): Candle[] {
  if (bucketMs <= 0) throw new Error("bucketMs must be positive");
  const byBucket = new Map<number, Candle>();
  // trades may arrive unsorted; sort a copy so bucket open/close are correct.
  const sorted = [...trades].sort((a, b) => a.tsMs - b.tsMs);
  for (const t of sorted) {
    const tMs = Math.floor(t.tsMs / bucketMs) * bucketMs;
    const existing = byBucket.get(tMs);
    if (!existing) {
      byBucket.set(tMs, {
        tMs,
        open: t.price,
        high: t.price,
        low: t.price,
        close: t.price,
        volume: t.size,
      });
    } else {
      byBucket.set(tMs, {
        tMs,
        open: existing.open,
        high: Math.max(existing.high, t.price),
        low: Math.min(existing.low, t.price),
        close: t.price,
        volume: existing.volume + t.size,
      });
    }
  }
  return [...byBucket.values()].sort((a, b) => a.tMs - b.tMs);
}
