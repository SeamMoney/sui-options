import { getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import deployment from "@/config/deployment.json";

export const NETWORK = "testnet" as const;

export const networkConfig = {
  testnet: { network: "testnet" as const, url: getJsonRpcFullnodeUrl("testnet") },
  mainnet: { network: "mainnet" as const, url: getJsonRpcFullnodeUrl("mainnet") },
};

// Live deployment from move/.
// `package_id` = published-at (use as `target` in PTB move calls).
// `original_id` = type-identity (use to construct type tags like `<original>::wick::Market<...>`).
export const PACKAGE_ID = deployment.package_id;
export const ORIGINAL_ID = deployment.original_id;

export const COLLATERAL_TYPE = "0x2::sui::SUI";

export const MARKET_TYPE = `${ORIGINAL_ID}::wick::Market<${COLLATERAL_TYPE}>`;
export const POSITION_TYPE = `${ORIGINAL_ID}::wick::Position`;
export const LP_POSITION_TYPE = `${ORIGINAL_ID}::wick::LpPosition`;
export const ORACLE_TYPE = `${ORIGINAL_ID}::oracle_adapter::MockOracle`;

export const explorerObjectUrl = (id: string) =>
  `https://suiscan.xyz/${NETWORK}/object/${id}`;

export const explorerTxUrl = (digest: string) =>
  `https://suiscan.xyz/${NETWORK}/tx/${digest}`;
