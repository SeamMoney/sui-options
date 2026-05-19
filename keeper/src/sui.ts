// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// Sui client + signer loading. Signer precedence:
//   1. KEEPER_PRIVATE_KEY_HEX env var (preferred for deploys / hackathon)
//   2. .keeper-key.json (suiprivkey1... bech32, dev fallback)

import { readFileSync, existsSync } from "node:fs";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { fromHex } from "@mysten/sui/utils";
import type { Config } from "./config.js";

interface KeyFile {
  alias?: string;
  address: string;
  privateKey: string; // suiprivkey1...
  createdAt?: string;
}

export interface LoadedSigner {
  keypair: Ed25519Keypair;
  address: string;
  source: "env" | "file";
}

/// Load a signer. Env var wins; file is a dev fallback. Back-compat alias
/// for the old `loadKeeperKey` is also exported.
export function loadKeeperSigner(cfg: Config): LoadedSigner {
  if (cfg.keeperPrivateKeyHex && cfg.keeperPrivateKeyHex.length > 0) {
    const hex = cfg.keeperPrivateKeyHex.startsWith("0x")
      ? cfg.keeperPrivateKeyHex.slice(2)
      : cfg.keeperPrivateKeyHex;
    if (hex.length !== 64) {
      throw new Error(
        `KEEPER_PRIVATE_KEY_HEX must be 32 bytes (64 hex chars), got ${hex.length}`,
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = fromHex(hex);
    } catch (err) {
      throw new Error(`KEEPER_PRIVATE_KEY_HEX is not valid hex: ${String(err)}`);
    }
    const keypair = Ed25519Keypair.fromSecretKey(bytes);
    const address = keypair.getPublicKey().toSuiAddress();
    return { keypair, address, source: "env" };
  }

  if (!existsSync(cfg.keeperKeyPath)) {
    throw new Error(
      `keeper signer missing: set KEEPER_PRIVATE_KEY_HEX (32-byte hex) ` +
        `or run \`npm run setup-key\` to create ${cfg.keeperKeyPath}`,
    );
  }
  const parsed: KeyFile = JSON.parse(readFileSync(cfg.keeperKeyPath, "utf8"));
  const { scheme, secretKey } = decodeSuiPrivateKey(parsed.privateKey);
  if (scheme !== "ED25519") {
    throw new Error(
      `unsupported scheme ${scheme} in ${cfg.keeperKeyPath} — expected ED25519`,
    );
  }
  const keypair = Ed25519Keypair.fromSecretKey(secretKey);
  const address = keypair.getPublicKey().toSuiAddress();
  if (parsed.address && parsed.address.toLowerCase() !== address.toLowerCase()) {
    throw new Error(
      `key address mismatch: file says ${parsed.address}, derived ${address}`,
    );
  }
  return { keypair, address, source: "file" };
}

export function makeClient(cfg: Config): SuiJsonRpcClient {
  return new SuiJsonRpcClient({ url: cfg.rpcUrl, network: cfg.network });
}
