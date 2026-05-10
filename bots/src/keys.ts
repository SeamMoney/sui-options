import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import type { PersonalityName } from "./personalities.js";
import { PERSONALITIES } from "./personalities.js";

interface KeyFile {
  alias: string;
  personality: PersonalityName;
  address: string;
  privateKey: string;  // suiprivkey1...
  createdAt: string;
}

export interface BotKey {
  personality: PersonalityName;
  address: string;
  keypair: Ed25519Keypair;
  path: string;
}

function keyFileFor(personality: PersonalityName, dir: string): string {
  return resolve(dir, `${personality}.json`);
}

export function ensureKeyDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function generateBotKeys(dir: string, overwrite = false): BotKey[] {
  ensureKeyDir(dir);
  const out: BotKey[] = [];
  for (const p of PERSONALITIES) {
    const path = keyFileFor(p.name, dir);
    if (existsSync(path) && !overwrite) {
      out.push(loadBotKey(path));
      continue;
    }
    const kp = Ed25519Keypair.generate();
    const address = kp.getPublicKey().toSuiAddress();
    const payload: KeyFile = {
      alias: `wick-bot-${p.name}`,
      personality: p.name,
      address,
      privateKey: kp.getSecretKey(),
      createdAt: new Date().toISOString(),
    };
    writeFileSync(path, JSON.stringify(payload, null, 2));
    out.push({ personality: p.name, address, keypair: kp, path });
  }
  return out;
}

export function loadBotKey(path: string): BotKey {
  const parsed: KeyFile = JSON.parse(readFileSync(path, "utf8"));
  const { scheme, secretKey } = decodeSuiPrivateKey(parsed.privateKey);
  if (scheme !== "ED25519") {
    throw new Error(`unsupported key scheme ${scheme} in ${path} — expected ED25519`);
  }
  const keypair = Ed25519Keypair.fromSecretKey(secretKey);
  const address = keypair.getPublicKey().toSuiAddress();
  if (parsed.address && parsed.address.toLowerCase() !== address.toLowerCase()) {
    throw new Error(`address mismatch: file says ${parsed.address}, derived ${address}`);
  }
  return { personality: parsed.personality, address, keypair, path };
}

export function loadAllBotKeys(dir: string): BotKey[] {
  if (!existsSync(dir)) {
    throw new Error(`bot key dir ${dir} not found. run: npm -w wick-bots run setup`);
  }
  const out: BotKey[] = [];
  for (const p of PERSONALITIES) {
    const path = keyFileFor(p.name, dir);
    if (!existsSync(path)) {
      throw new Error(`missing key for ${p.name} at ${path}. run: npm -w wick-bots run setup`);
    }
    out.push(loadBotKey(path));
  }
  // Sanity: warn on any stray files we don't recognize.
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const known = PERSONALITIES.some((p) => `${p.name}.json` === f);
    if (!known) console.warn(`[bots] ignoring unknown key file ${join(dir, f)}`);
  }
  return out;
}
