/**
 * Live testnet artifact loader.
 *
 * Reads from `deployments/testnet.json` at the repo root — the source of
 * truth that the publish scripts and Move/keeper agree on. The legacy
 * `frontend/src/config/deployment.json` predates the arcade/ride deploy
 * and does not have `arcade_markets`, so it is not used here.
 */
import testnet from "../../../deployments/testnet.json";

export interface ArcadeMarketRecord {
  name: string;
  market: string;
  oracle: string;
  path: string;
  random_walk: string;
  barrier: number;
  direction: number;
  expiry_ms: number;
}

/**
 * Per doc 19 — a SegmentMarket<C> singleton; one round-based barrier-grid
 * arcade market per (collateral, instance). The fields here are a subset
 * of what `bootstrap_segment_market` accepts — only what the frontend
 * needs at runtime; the rest is read on demand via `fetchSegmentMarket`.
 */
export interface SegmentMarketRecord {
  name: string;
  /** Segment market ABI generation. Defaults to 2 when omitted. */
  version?: 2 | 3;
  /** Shared SegmentMarket<C> object id. */
  market: string;
  /** Collateral type tag, e.g. `0x2::sui::SUI`. */
  collateral: string;
  /** Vault the market binds to (`vault_sui` for SUI). */
  vault: string;
  /** Walk home price in micro-USD (display anchor pre-first-segment). */
  home_price: number;
}

/**
 * Per doc 25 — a SegmentMarketV4<C> singleton; the touch-either, always-open
 * evolution of v3. Same shape as `SegmentMarketRecord` minus
 * `open_window_segments` (always-open) and renaming `max_payout_per_barrier`
 * → `max_payout_per_round`. The frontend reads only the small subset here at
 * runtime; the rest is read on demand via `fetchSegmentMarketV4`.
 */
export interface SegmentMarketV4Record {
  name: string;
  /** Shared SegmentMarketV4<C> object id. */
  market: string;
  /** Collateral type tag, e.g. `0x2::sui::SUI`. */
  collateral: string;
  /** Vault the market binds to (`vault_sui` for SUI). */
  vault: string;
  /** Walk home price in micro-USD (display anchor pre-first-segment). */
  home_price: number;
}

export interface TestnetDeployment {
  network: string;
  package_id: string;
  vault_sui?: string;
  arcade_markets?: ArcadeMarketRecord[];
  segment_markets?: SegmentMarketRecord[];
  /** doc 25 — v4 touch-either always-open markets. Empty until v4 deploys. */
  segment_markets_v4?: SegmentMarketV4Record[];
  risk_config?: string;
  global_exposure_registry?: string;
  bot_registry?: string;
  fee_router_sui?: string;
  usd_price_oracle?: string;
  wick_staking_pool?: string;
  wick_token_state?: string;
}

export const TESTNET_DEPLOYMENT = testnet as TestnetDeployment;

/**
 * Returns the first available arcade market for ride-test smoke tests,
 * preferring not-yet-expired markets when wall-clock data is available.
 */
export function pickArcadeMarket(
  deployment: TestnetDeployment = TESTNET_DEPLOYMENT,
  nowMs: number = Date.now(),
): ArcadeMarketRecord | null {
  const markets = deployment.arcade_markets ?? [];
  if (markets.length === 0) return null;
  const live = markets.find((m) => m.expiry_ms > nowMs);
  return live ?? markets[0]!;
}
