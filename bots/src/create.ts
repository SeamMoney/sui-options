import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  buildCreateMarketTx,
  type Direction,
} from "@wick/sdk";
import type { BotsConfig } from "./config.js";
import type { Personality } from "./personalities.js";
import { signAndExecute, randomBigintBetween, randomNumberBetween, pickRandom } from "./sui-helpers.js";
import { findOrCreateOracle } from "./oracle.js";

interface AssetSpec {
  asset: string;
  defaultPrice: number;       // initial oracle price if a fresh oracle is needed
}

const ASSET_SPECS: AssetSpec[] = [
  { asset: "BTC/USD", defaultPrice: 100 },
  { asset: "SUI/USD", defaultPrice: 5_300 },
  { asset: "ETH/USD", defaultPrice: 3_500 },
];

export interface CreatedMarket {
  digest: string;
  marketId: string;
  asset: string;
  direction: Direction;
  barrier: bigint;
  expiryMs: bigint;
  oracleId: string;
}

/**
 * Open a fresh market against an existing or newly-created oracle for the
 * chosen asset. The barrier sits within ±20% of the live oracle price so
 * the keeper has a plausible chance of either marking it HIT or letting
 * it expire. Direction follows the bot's personality bias.
 */
export async function createMarket(
  client: SuiJsonRpcClient,
  signer: Ed25519Keypair,
  cfg: BotsConfig,
  personality: Personality,
): Promise<CreatedMarket> {
  const sender = signer.getPublicKey().toSuiAddress();
  const spec = pickRandom(ASSET_SPECS);

  const oracle = await findOrCreateOracle(
    client, signer, cfg, spec.asset, BigInt(spec.defaultPrice),
  );

  const direction: Direction =
    personality.createDirection === "RANDOM"
      ? (Math.random() < 0.5 ? "ABOVE" : "BELOW")
      : personality.createDirection;

  // Barrier sits 5–20% away from the oracle price, in the chosen direction.
  // ABOVE markets: barrier > oracle, so TOUCH wins on a price spike.
  // BELOW markets: barrier < oracle, so TOUCH wins on a drop.
  const driftPct = randomNumberBetween(5, 20) / 100;
  const barrierNum =
    direction === "ABOVE"
      ? Math.ceil(oracle.price * (1 + driftPct))
      : Math.max(1, Math.floor(oracle.price * (1 - driftPct)));
  const barrier = BigInt(barrierNum);

  const expirySec = randomNumberBetween(cfg.expiryMinSeconds, cfg.expiryMaxSeconds);
  const expiryMs = BigInt(Date.now() + expirySec * 1000);
  const seedMist = randomBigintBetween(cfg.seedMistMin, cfg.seedMistMax);

  const tx = buildCreateMarketTx({
    packageId: cfg.packageId,
    collateralType: cfg.collateralType,
    sender,
    asset: spec.asset,
    direction,
    barrier,
    expiryMs,
    feeBps: cfg.feeBps,
    seedMist,
  });
  const { digest, objectChanges } = await signAndExecute(client, signer, tx, cfg);
  let marketId = "";
  for (const c of objectChanges as { type?: string; objectType?: string; objectId?: string }[]) {
    if (c.type === "created" && c.objectType?.includes("::wick::Market<") && c.objectId) {
      marketId = c.objectId;
      break;
    }
  }
  if (!marketId) throw new Error(`create_market tx ${digest} produced no Market<C>`);
  return { digest, marketId, asset: spec.asset, direction, barrier, expiryMs, oracleId: oracle.id };
}
