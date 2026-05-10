import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import type { BotKey } from "./keys.js";
import type { BotsConfig } from "./config.js";
import type { Personality } from "./personalities.js";
import { jitter, sleep, totalSuiMist } from "./sui-helpers.js";
import { makeWickClient } from "./oracle.js";
import { tradableMarkets, pickMarket, placeTrade } from "./trade.js";
import { createMarket } from "./create.js";

export interface BotStats {
  trades: number;
  creates: number;
  errors: number;
  lastError?: string;
}

export class Bot {
  readonly key: BotKey;
  readonly personality: Personality;
  readonly stats: BotStats = { trades: 0, creates: 0, errors: 0 };
  private readonly client: SuiJsonRpcClient;
  private readonly cfg: BotsConfig;
  private tickCount = 0;

  constructor(opts: {
    key: BotKey;
    personality: Personality;
    client: SuiJsonRpcClient;
    cfg: BotsConfig;
  }) {
    this.key = opts.key;
    this.personality = opts.personality;
    this.client = opts.client;
    this.cfg = opts.cfg;
  }

  /** One pass: maybe create a market, then place one trade. */
  async tick(): Promise<void> {
    this.tickCount++;

    // Cheap balance guard: if too low to cover gas + risk, log and skip.
    const bal = await totalSuiMist(this.client, this.key.address);
    const need = this.cfg.gasBudget + this.cfg.riskMistMax;
    if (bal < need) {
      this.log(`balance ${bal} < gas+risk ${need}; skipping (top up via setup-bots fund-only)`);
      return;
    }

    // Periodically (and only if this personality creates), open a fresh market.
    const shouldCreate =
      this.personality.creates &&
      this.tickCount % this.cfg.createMarketEveryNTicks === 0;
    if (shouldCreate) {
      try {
        const m = await createMarket(this.client, this.key.keypair, this.cfg, this.personality);
        this.stats.creates++;
        this.log(
          `CREATE ${m.asset} ${m.direction} @${m.barrier} expires=${new Date(Number(m.expiryMs)).toISOString()} market=${m.marketId} digest=${m.digest}`,
        );
      } catch (err) {
        this.stats.errors++;
        this.stats.lastError = (err as Error).message;
        this.log(`CREATE error: ${this.stats.lastError}`);
      }
    }

    // Always place a trade if there's a tradable market.
    const wick = makeWickClient(this.client, this.cfg);
    const all = await wick.listMarkets({ collateralType: this.cfg.collateralType });
    const tradable = tradableMarkets(all, Date.now());
    const target = pickMarket(tradable, this.personality);
    if (!target) {
      const active = all.filter((m: { status: string }) => m.status === "ACTIVE").length;
      this.log(`no tradable market (active=${active})`);
      return;
    }
    try {
      const r = await placeTrade(this.client, this.key.keypair, this.cfg, target, this.personality);
      this.stats.trades++;
      this.log(
        `TRADE ${r.side} risk=${r.riskMist}mist market=${r.marketId} digest=${r.digest}`,
      );
    } catch (err) {
      this.stats.errors++;
      this.stats.lastError = (err as Error).message;
      this.log(`TRADE error: ${this.stats.lastError}`);
    }
  }

  /** Long-running loop with jittered sleep between ticks. */
  async run(stopSignal: { stop: boolean }): Promise<void> {
    while (!stopSignal.stop) {
      const t0 = Date.now();
      try {
        await this.tick();
      } catch (err) {
        this.stats.errors++;
        this.stats.lastError = (err as Error).message;
        this.log(`tick error: ${this.stats.lastError}`);
      }
      const elapsed = Date.now() - t0;
      const wait = Math.max(0, jitter(this.cfg.pollIntervalMs, this.cfg.jitterMs) - elapsed);
      if (wait > 0 && !stopSignal.stop) await sleep(wait);
    }
  }

  private log(msg: string): void {
    console.log(`[${this.personality.name}] ${msg}`);
  }
}
