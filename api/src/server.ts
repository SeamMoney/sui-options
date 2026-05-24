import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { isValidSuiAddress, isValidSuiObjectId } from "@mysten/sui/utils";
import { WickClient, type Deployment } from "@wick/sdk";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";

const deployment: Deployment = JSON.parse(
  readFileSync(resolve(repoRoot, "deployments", "testnet.json"), "utf8"),
);

const RPC_FOR: Record<Deployment["network"], string> = {
  mainnet: "https://fullnode.mainnet.sui.io:443",
  testnet: "https://fullnode.testnet.sui.io:443",
  devnet: "https://fullnode.devnet.sui.io:443",
  localnet: "http://127.0.0.1:9000",
};

const rpcUrl = process.env.WICK_API_RPC ?? RPC_FOR[deployment.network];
const sui = new SuiJsonRpcClient({
  network: deployment.network,
  url: rpcUrl,
});
const wick = new WickClient({ sui, deployment });

const app = Fastify({ logger: { level: "info" } });
await app.register(cors, { origin: true });

app.get("/health", async () => ({
  status: "ok",
  network: deployment.network,
  package_id: deployment.package_id,
  ts: new Date().toISOString(),
}));

app.get("/deployment", async () => deployment);

app.get<{ Querystring: { collateral_type?: string } }>("/markets", async (req) => {
  const collateralType = req.query.collateral_type;
  const markets = await wick.listMarkets(collateralType ? { collateralType } : undefined);
  return { count: markets.length, markets };
});

app.get<{ Params: { id: string } }>("/markets/:id", async (req, reply) => {
  if (!isValidSuiObjectId(req.params.id)) {
    return reply.code(400).send({ error: "invalid object id" });
  }
  const market = await wick.getMarket(req.params.id);
  if (!market) return reply.code(404).send({ error: "market not found" });
  return market;
});

app.get<{ Params: { address: string } }>("/positions/:address", async (req, reply) => {
  if (!isValidSuiAddress(req.params.address)) {
    return reply.code(400).send({ error: "invalid address" });
  }
  const positions = await wick.listPositions(req.params.address);
  const lp = await wick.listLpPositions(req.params.address);
  return { positions, lp_positions: lp };
});

app.get("/oracles", async () => {
  const oracles = await wick.listOracles();
  return { count: oracles.length, oracles };
});

app.get<{ Querystring: { asset: string } }>("/oracles/by-asset", async (req, reply) => {
  if (!req.query.asset) return reply.code(400).send({ error: "asset query required" });
  const oracle = await wick.findOracleForAsset(req.query.asset);
  if (!oracle) return reply.code(404).send({ error: "no oracle for asset" });
  return oracle;
});

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`@wick/api listening on http://${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
