// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// External price source for pull-oracle markets. v1 uses Coinbase REST
// `/v2/prices/<PAIR>/spot`. SUI is available there as SUI-USD; we keep a
// CoinGecko fallback for safety.

const COINBASE_BASE = "https://api.coinbase.com/v2/prices";
const COINGECKO_SUI =
  "https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd";

export interface PriceQuote {
  /// USD price as a decimal number.
  price: number;
  /// Source identifier ("coinbase", "coingecko"). Recorded in attestation.
  source: string;
  /// Off-chain timestamp_ms when this quote was fetched.
  fetchedAtMs: number;
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`http ${res.status} from ${url}`);
  }
  return res.json();
}

async function fetchCoinbase(pair: string, signal?: AbortSignal): Promise<PriceQuote> {
  const data = await fetchJson(`${COINBASE_BASE}/${pair}/spot`, signal);
  // shape: { data: { base, currency, amount } }
  const obj = data as { data?: { amount?: string } };
  const amt = obj?.data?.amount;
  if (typeof amt !== "string") {
    throw new Error(`unexpected coinbase response for ${pair}: ${JSON.stringify(data)}`);
  }
  const price = Number(amt);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`coinbase ${pair} returned non-positive price: ${amt}`);
  }
  return { price, source: "coinbase", fetchedAtMs: Date.now() };
}

async function fetchCoingeckoSui(signal?: AbortSignal): Promise<PriceQuote> {
  const data = await fetchJson(COINGECKO_SUI, signal);
  const obj = data as { sui?: { usd?: number } };
  const v = obj?.sui?.usd;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new Error(`coingecko sui: ${JSON.stringify(data)}`);
  }
  return { price: v, source: "coingecko", fetchedAtMs: Date.now() };
}

/// Resolve an `upstream` identifier (e.g. "coinbase:BTC-USD") to a quote.
/// Throws on unrecognized upstream or network failure (caller decides).
export async function fetchPrice(
  upstream: string,
  signal?: AbortSignal,
): Promise<PriceQuote> {
  const [provider, pair] = upstream.split(":");
  if (provider === "coinbase" && pair) {
    try {
      return await fetchCoinbase(pair, signal);
    } catch (err) {
      if (pair === "SUI-USD") {
        return await fetchCoingeckoSui(signal);
      }
      throw err;
    }
  }
  if (provider === "coingecko" && pair === "SUI-USD") {
    return await fetchCoingeckoSui(signal);
  }
  throw new Error(`unknown upstream price source: ${upstream}`);
}

/// Scale a USD price to the oracle's micro-units (default 1e6 = USDC/USDT).
export function scalePrice(priceUsd: number, decimals: number): bigint {
  const factor = 10 ** decimals;
  // round-half-up — defensive against floating-point representation
  return BigInt(Math.round(priceUsd * factor));
}
