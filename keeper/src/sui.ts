import { readFileSync } from "node:fs";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import type { Config } from "./config.js";

interface KeyFile {
  alias?: string;
  address: string;
  privateKey: string;  // suiprivkey1...
  createdAt?: string;
}

export function loadKeeperKey(path: string): { keypair: Ed25519Keypair; address: string } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `keeper key not found at ${path}. Run \`pnpm setup-key\` (or \`npm run setup-key\`) to create one, then fund it from your CLI wallet.`,
    );
  }
  const parsed: KeyFile = JSON.parse(raw);
  const { scheme, secretKey } = decodeSuiPrivateKey(parsed.privateKey);
  if (scheme !== "ED25519") {
    throw new Error(`unsupported key scheme ${scheme} in ${path} — expected ED25519`);
  }
  const keypair = Ed25519Keypair.fromSecretKey(secretKey);
  const address = keypair.getPublicKey().toSuiAddress();
  if (parsed.address && parsed.address.toLowerCase() !== address.toLowerCase()) {
    throw new Error(
      `keeper key address mismatch: file says ${parsed.address}, derived ${address}`,
    );
  }
  return { keypair, address };
}

export function makeClient(cfg: Config): SuiJsonRpcClient {
  return new SuiJsonRpcClient({ url: cfg.rpcUrl, network: cfg.network });
}
