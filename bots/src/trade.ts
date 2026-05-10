import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  buildBuyTx,
  type MarketSnapshot,
} from "@wick/sdk";
import type { BotsConfig } from "./config.js";
import type { Personality } from "./personalities.js";
import { signAndExecute, randomBigintBetween, pickRandom } from "./sui-helpers.js";

export function tradableMarkets(markets: MarketSnapshot[], nowMs: number): MarketSnapshot[] {
  // Drop ACTIVE markets too close to expiry — they're about to settle and
  // we don't want positions stranded by a race with the keeper.
  const buffer = 30_000;
  return markets.filter(
    (m) =>
      m.status === "ACTIVE" &&
      m.expiryMs - nowMs > buffer &&
      m.collateralType === defaultCollateralType(),
  );
}

export function defaultCollateralType(): string {
  return "0x2::sui::SUI";
}

/**
 * Pick a market for this bot to trade on. Bots don't need a sophisticated
 * selection — random across tradable markets is fine for organic activity,
 * but we lightly bias each personality toward markets that match its bias
 * to avoid every bot piling onto the same market each tick.
 */
export function pickMarket(
  markets: MarketSnapshot[],
  personality: Personality,
): MarketSnapshot | null {
  if (markets.length === 0) return null;
  // Weighted preference: e.g. bull prefers ABOVE markets but will still
  // touch BELOW ones occasionally for variety.
  const preferred = markets.filter((m) => {
    if (personality.name === "bull") return m.direction === "ABOVE";
    if (personality.name === "bear") return m.direction === "BELOW";
    return true;
  });
  if (preferred.length > 0 && Math.random() < 0.7) return pickRandom(preferred);
  return pickRandom(markets);
}

/**
 * Cap the trade so the AMM doesn't get pushed too hard. The CPMM is small
 * (seeds are ~200k mist) so we keep risk between 5% and 25% of the smaller
 * reserve, clipped by the configured min/max.
 */
export function sizeTrade(
  market: MarketSnapshot,
  cfg: BotsConfig,
): bigint {
  const minReserve = Math.min(market.touchReserve, market.noTouchReserve);
  const fivePct = BigInt(Math.max(1, Math.floor(minReserve * 0.05)));
  const twentyFivePct = BigInt(Math.max(1, Math.floor(minReserve * 0.25)));
  const lo = max(cfg.riskMistMin, fivePct);
  const hi = min(cfg.riskMistMax, twentyFivePct < lo ? lo : twentyFivePct);
  return randomBigintBetween(lo, hi <= lo ? lo + 1n : hi);
}

function min(a: bigint, b: bigint): bigint { return a < b ? a : b; }
function max(a: bigint, b: bigint): bigint { return a > b ? a : b; }

export interface TradeResult {
  digest: string;
  marketId: string;
  side: "TOUCH" | "NO_TOUCH";
  riskMist: bigint;
}

export async function placeTrade(
  client: SuiJsonRpcClient,
  signer: Ed25519Keypair,
  cfg: BotsConfig,
  market: MarketSnapshot,
  personality: Personality,
): Promise<TradeResult> {
  const sender = signer.getPublicKey().toSuiAddress();
  const side = personality.pickSide(market);
  const riskMist = sizeTrade(market, cfg);
  const tx = buildBuyTx({
    packageId: cfg.packageId,
    collateralType: market.collateralType,
    sender,
    marketId: market.id,
    side,
    riskMist,
  });
  const { digest } = await signAndExecute(client, signer, tx, cfg);
  return { digest, marketId: market.id, side, riskMist };
}
