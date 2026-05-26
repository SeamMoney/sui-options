import { getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import deployment from "@/config/deployment.json";

export const NETWORK = "testnet" as const;

// v4.29 — switched from Mysten's public testnet RPC
// (https://fullnode.testnet.sui.io) to publicnode.com after the symptom:
// "Access to fetch at 'https://fullnode.testnet.sui.io/' from origin
//  'https://wick-markets.vercel.app' has been blocked by CORS policy."
// Real cause was RATE-LIMITING, not CORS — but a throttled response from
// the Mysten endpoint drops its CORS headers, and the browser reports
// the misleading CORS-block message. PublicNode allows ~10× the request
// rate before throttling and keeps CORS headers on all responses. A
// single Ride session fires 5-10 RPC calls per tap (poll events, get
// balance, sign + execute open, sign + execute close), so a user
// spamming taps would hit the Mysten throttle in seconds; PublicNode
// survives the same load comfortably.
//
// Override via VITE_SUI_TESTNET_RPC at build time if you want to point
// at your own infra (Triton, Shinami, etc.) without editing this file.
const TESTNET_RPC_URL =
  (import.meta.env?.VITE_SUI_TESTNET_RPC as string | undefined) ??
  "https://sui-testnet-rpc.publicnode.com";

export const networkConfig = {
  testnet: { network: "testnet" as const, url: TESTNET_RPC_URL },
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
