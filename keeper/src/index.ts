import { loadConfig } from "./config.js";
import { loadKeeperKey, makeClient } from "./sui.js";
import { tickOnce } from "./keeper.js";

const cmd = process.argv[2] ?? "tick";

async function main() {
  const cfg = loadConfig();
  const { keypair, address } = loadKeeperKey(cfg.keeperKeyPath);
  const client = makeClient(cfg);

  console.log(`[wick-keeper] network=${cfg.network} package=${cfg.packageId}`);
  console.log(`[wick-keeper] address=${address}`);
  if (cfg.onlyMarkets.length > 0) {
    console.log(`[wick-keeper] filter: only markets ${cfg.onlyMarkets.join(", ")}`);
  }

  if (cmd === "tick") {
    const r = await tickOnce(client, keypair, cfg);
    console.log(`[tick] planned=${r.planned} ok=${r.succeeded} fail=${r.failed}`);
    for (const d of r.details) console.log(`  ${d}`);
    process.exit(r.failed > 0 ? 1 : 0);
  }

  if (cmd === "watch") {
    console.log(`[watch] poll every ${cfg.pollIntervalMs}ms`);
    let stop = false;
    process.on("SIGINT", () => {
      console.log("\n[watch] received SIGINT; finishing current tick then exiting");
      stop = true;
    });
    while (!stop) {
      const t0 = Date.now();
      try {
        const r = await tickOnce(client, keypair, cfg);
        if (r.planned > 0 || r.failed > 0) {
          console.log(`[tick ${new Date().toISOString()}] planned=${r.planned} ok=${r.succeeded} fail=${r.failed}`);
          for (const d of r.details) console.log(`  ${d}`);
        }
      } catch (err) {
        console.error(`[tick] error: ${(err as Error).message}`);
      }
      const elapsed = Date.now() - t0;
      const wait = Math.max(0, cfg.pollIntervalMs - elapsed);
      if (wait > 0 && !stop) await new Promise((r) => setTimeout(r, wait));
    }
    console.log("[watch] exited cleanly.");
    return;
  }

  console.error(`unknown command: ${cmd}`);
  console.error("usage: tsx src/index.ts (tick | watch)");
  process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
