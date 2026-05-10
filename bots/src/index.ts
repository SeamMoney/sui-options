/**
 * Entry point — boots all four personality bots in parallel.
 *
 *   tsx src/index.ts          long-running loop
 *   tsx src/index.ts tick     one pass per bot, then exit
 */

import { loadConfig } from "./config.js";
import { loadAllBotKeys } from "./keys.js";
import { personalityFor } from "./personalities.js";
import { Bot } from "./bot.js";
import { makeClient, totalSuiMist, sleep } from "./sui-helpers.js";

async function main() {
  const cmd = process.argv[2] ?? "run";
  const cfg = loadConfig();
  const client = makeClient(cfg);
  const keys = loadAllBotKeys(cfg.keyDir);

  console.log(`[bots] network=${cfg.network} package=${cfg.packageId}`);
  console.log(`[bots] poll=${cfg.pollIntervalMs}ms jitter=±${cfg.jitterMs}ms aggregate≈${(keys.length * 1000 / cfg.pollIntervalMs).toFixed(2)} trades/sec`);
  for (const k of keys) {
    const bal = await totalSuiMist(client, k.address);
    console.log(`  ${k.personality.padEnd(12)} ${k.address}  balance=${(Number(bal) / 1e9).toFixed(6)} SUI`);
  }

  const bots = keys.map(
    (k) =>
      new Bot({
        key: k,
        personality: personalityFor(k.personality),
        client,
        cfg,
      }),
  );

  if (cmd === "tick") {
    for (const b of bots) await b.tick();
    console.log("[bots] one-pass complete:");
    for (const b of bots) {
      console.log(
        `  ${b.personality.name.padEnd(12)} trades=${b.stats.trades} creates=${b.stats.creates} errors=${b.stats.errors}`,
      );
    }
    return;
  }

  if (cmd !== "run") {
    console.error(`unknown command: ${cmd}`);
    console.error("usage: tsx src/index.ts (run | tick)");
    process.exit(2);
  }

  const stopSignal = { stop: false };
  process.on("SIGINT", () => {
    console.log("\n[bots] received SIGINT; finishing current ticks then exiting");
    stopSignal.stop = true;
  });

  // Stagger the starts so we don't fire 4 simultaneous calls every cycle.
  const stagger = Math.floor(cfg.pollIntervalMs / bots.length);
  const runners = bots.map(async (b, i) => {
    await sleep(i * stagger);
    return b.run(stopSignal);
  });

  // Periodic stats line so an operator watching the log sees the fleet's pace.
  const statsInterval = setInterval(() => {
    if (stopSignal.stop) return;
    const totals = bots.reduce(
      (acc, b) => ({
        trades: acc.trades + b.stats.trades,
        creates: acc.creates + b.stats.creates,
        errors: acc.errors + b.stats.errors,
      }),
      { trades: 0, creates: 0, errors: 0 },
    );
    console.log(
      `[bots] totals trades=${totals.trades} creates=${totals.creates} errors=${totals.errors}`,
    );
  }, 30_000);

  try {
    await Promise.all(runners);
  } finally {
    clearInterval(statsInterval);
  }
  console.log("[bots] exited cleanly.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
