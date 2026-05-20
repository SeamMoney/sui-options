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

export interface TestnetDeployment {
  network: string;
  package_id: string;
  vault_sui?: string;
  arcade_markets?: ArcadeMarketRecord[];
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
