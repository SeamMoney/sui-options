/**
 * Generate (or reuse) one keypair per bot personality, then top each one up
 * with SUI from the local CLI's *active* address. The active address is
 * expected to be the deployer / liquidity provider (`alice`) but the script
 * is symmetric: whoever's currently active pays.
 *
 * Subcommands:
 *   (none) | setup    generate-or-reuse keys, then fund every bot below floor
 *   fund-only          fund only (don't generate)
 *   balances           print every bot's address + SUI balance
 */

import { execSync } from "node:child_process";
import { loadConfig } from "./config.js";
import { generateBotKeys, loadAllBotKeys } from "./keys.js";
import { makeClient, totalSuiMist } from "./sui-helpers.js";

interface SuiGasCoin {
  gasCoinId: string;
  mistBalance: string | number;
}

function suiCliAvailable(): boolean {
  try {
    execSync("sui --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function activeCliAddress(): string {
  return execSync("sui client active-address", { encoding: "utf8" }).trim();
}

function biggestGasCoin(): { id: string; mist: bigint } {
  const raw = execSync("sui client gas --json", { encoding: "utf8" });
  const coins: SuiGasCoin[] = JSON.parse(raw);
  if (coins.length === 0) throw new Error("active CLI address has no SUI gas coins");
  const sorted = [...coins].sort((a, b) => Number(BigInt(b.mistBalance) - BigInt(a.mistBalance)));
  const top = sorted[0]!;
  return { id: top.gasCoinId, mist: BigInt(top.mistBalance) };
}

function fmtSui(mist: bigint): string {
  const s = (Number(mist) / 1e9).toFixed(6);
  return `${s.padStart(11)} SUI`;
}

function payManyFromActive(
  recipients: { address: string; amountMist: bigint }[],
  gasBudgetMist: bigint,
): string {
  if (recipients.length === 0) return "";

  // pay-sui uses one input coin and splits across recipients in a single tx.
  // We need the input coin's balance to exceed sum(amounts) + gas_budget.
  const need = recipients.reduce((acc, r) => acc + r.amountMist, 0n) + gasBudgetMist;
  const gas = biggestGasCoin();
  if (gas.mist < need) {
    throw new Error(
      `active CLI address gas coin too small: have ${gas.mist} mist, need ${need} mist. ` +
      `merge / faucet first, or lower WICK_BOTS_FUND_PER_BOT.`,
    );
  }

  const addrs = recipients.map((r) => r.address).join(" ");
  const amounts = recipients.map((r) => r.amountMist.toString()).join(" ");
  const cmd =
    `sui client pay-sui ` +
    `--input-coins ${gas.id} ` +
    `--recipients ${addrs} ` +
    `--amounts ${amounts} ` +
    `--gas-budget ${gasBudgetMist} ` +
    `--json`;
  // We capture combined output and then strip any preamble before JSON.
  const out = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const jsonStart = out.indexOf("{");
  if (jsonStart < 0) throw new Error(`pay-sui returned no JSON:\n${out}`);
  const parsed = JSON.parse(out.slice(jsonStart));
  return String(parsed.digest ?? "");
}

async function main() {
  const subcmd = process.argv[2] ?? "setup";
  const cfg = loadConfig();
  const client = makeClient(cfg);

  if (subcmd === "balances") {
    const keys = loadAllBotKeys(cfg.keyDir);
    console.log(`[bots] keyDir=${cfg.keyDir} network=${cfg.network}`);
    for (const k of keys) {
      const bal = await totalSuiMist(client, k.address);
      console.log(`  ${k.personality.padEnd(12)} ${k.address}  ${fmtSui(bal)}`);
    }
    return;
  }

  if (subcmd !== "setup" && subcmd !== "fund-only") {
    console.error(`unknown subcommand: ${subcmd}`);
    console.error("usage: setup-bots.ts [setup | fund-only | balances]");
    process.exit(2);
  }

  if (!suiCliAvailable()) {
    throw new Error("`sui` CLI not found on PATH; required to fund bots from the active address.");
  }

  const keys = subcmd === "setup" ? generateBotKeys(cfg.keyDir, false) : loadAllBotKeys(cfg.keyDir);
  console.log(`[bots] keyDir=${cfg.keyDir}`);
  for (const k of keys) console.log(`  ${k.personality.padEnd(12)} ${k.address}`);

  const funder = activeCliAddress();
  console.log(`[bots] funder (active CLI address): ${funder}`);

  const need: { address: string; amountMist: bigint }[] = [];
  for (const k of keys) {
    const bal = await totalSuiMist(client, k.address);
    if (bal < cfg.fundFloorMist) {
      const topup = cfg.fundPerBotMist - bal;
      need.push({ address: k.address, amountMist: topup > 0n ? topup : cfg.fundPerBotMist });
      console.log(
        `  ${k.personality.padEnd(12)} balance=${fmtSui(bal)} below floor → topup ${fmtSui(topup)}`,
      );
    } else {
      console.log(`  ${k.personality.padEnd(12)} balance=${fmtSui(bal)} ok`);
    }
  }

  if (need.length === 0) {
    console.log("[bots] all bots above funding floor — no transfers needed.");
    return;
  }

  console.log(`[bots] funding ${need.length} bots in one pay-sui tx...`);
  const digest = payManyFromActive(need, 50_000_000n);
  console.log(`[bots] digest: ${digest}`);

  // Print final balances for confirmation.
  console.log("[bots] post-fund balances:");
  for (const k of keys) {
    const bal = await totalSuiMist(client, k.address);
    console.log(`  ${k.personality.padEnd(12)} ${k.address}  ${fmtSui(bal)}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
