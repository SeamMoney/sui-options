import { writeFileSync, existsSync } from "node:fs";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { loadConfig } from "./config.js";

const cfg = loadConfig();

if (existsSync(cfg.keeperKeyPath)) {
  console.error(`refusing to overwrite ${cfg.keeperKeyPath}`);
  console.error("delete the file first if you really want a new key.");
  process.exit(2);
}

const kp = Ed25519Keypair.generate();
const address = kp.getPublicKey().toSuiAddress();
const payload = {
  alias: "wick-keeper",
  address,
  privateKey: kp.getSecretKey(),
  createdAt: new Date().toISOString(),
};

writeFileSync(cfg.keeperKeyPath, JSON.stringify(payload, null, 2));
console.log(`wrote keeper key to ${cfg.keeperKeyPath}`);
console.log(`address: ${address}`);
console.log("");
console.log("next: fund this address with at least 0.1 SUI on the deployment network.");
console.log(`    sui client switch --address <funded-cli-address>`);
console.log(`    sui client pay-sui --input-coins <coin-id> --recipients ${address} --amounts 100000000 --gas-budget 5000000`);
