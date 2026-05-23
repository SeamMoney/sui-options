// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// Keeper entrypoint. Modes:
//   tick   — one tick, exit code = 1 if any failures
//   watch  — long-running daemon; exits cleanly on SIGINT
//
// Structured logs go to stdout, one JSON object per line.

import { loadConfig } from "./config.js";
import { loadKeeperSigner, makeClient } from "./sui.js";
import { tickOnce, emitLogs, type KeeperState } from "./keeper.js";
import { findRidesOwnedBy, type RideRecord } from "./ride.js";
import { createHealth, recordTick, startHealthServer } from "./health.js";
import {
  SegmentCranker,
  parseSegmentMarketsEnv,
  type SegmentMarketBinding,
} from "./segmentCranker.js";

const cmd = process.argv[2] ?? "watch";

function log(
  level: "info" | "warn" | "error",
  action: string,
  extra: Record<string, unknown> = {},
): void {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), level, action, ...extra }),
  );
}

async function discoverKnownRides(
  client: ReturnType<typeof makeClient>,
  cfg: ReturnType<typeof loadConfig>,
): Promise<RideRecord[]> {
  const owners = (process.env.WICK_KEEPER_RIDES_OWNERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (owners.length === 0) return [];

  const out: RideRecord[] = [];
  for (const owner of owners) {
    try {
      const found = await findRidesOwnedBy(client, cfg, owner);
      log("info", "discover-rides", { owner, count: found.length });
      for (const f of found) {
        // We don't fully decode the on-chain content here — content shape
        // depends on the @mysten/sui RPC version. Owner-scoped enumeration
        // is enough for v1 demos; the keeper still asserts crankability
        // via the Move side, which is the load-bearing safety check.
        const c = (f.raw as { fields?: Record<string, unknown> } | undefined)
          ?.fields;
        if (!c) continue;
        const expiryMs = Number(
          (c["expiry_ms_cached"] as string | number | undefined) ?? 0,
        );
        const marketId = String(c["market_id"] ?? "");
        const pathId = String(c["path_id"] ?? "");
        const capsId = String(c["caps_id"] ?? "");
        const startTimeMs = Number(
          (c["start_time_ms"] as string | number | undefined) ?? 0,
        );
        if (!marketId || !pathId || !capsId) continue;
        out.push({
          id: f.id,
          user: owner,
          marketId,
          pathId,
          capsId,
          startTimeMs,
          expiryMs,
          touched: false, // assume false; Move side double-checks
          collateralType: cfg.collateralType,
        });
      }
    } catch (err) {
      log("warn", "discover-rides-failed", { owner, error: String(err) });
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const cfg = loadConfig();
  const signer = loadKeeperSigner(cfg);
  const client = makeClient(cfg);

  log("info", "boot", {
    network: cfg.network,
    package_id: cfg.packageId,
    address: signer.address,
    signer_source: signer.source,
    arcade_markets: cfg.arcadeMarkets.length,
    pull_markets: cfg.pullMarkets.length,
    vault_id: cfg.vaultId ?? null,
    registry_id: cfg.registryId ?? null,
    only_markets: cfg.onlyMarkets.length > 0 ? cfg.onlyMarkets : undefined,
  });

  if (cmd === "tick") {
    const state: KeeperState = {
      knownRides: await discoverKnownRides(client, cfg),
    };
    const result = await tickOnce(client, signer.keypair, cfg, state);
    emitLogs(result);
    process.exit(result.failed > 0 ? 1 : 0);
  }

  if (cmd === "watch") {
    const health = createHealth({
      packageId: cfg.packageId,
      network: cfg.network,
      address: signer.address,
    });
    const server = startHealthServer(health, cfg.healthPort);

    // Segment-market cranker (C1). Optional — driven by env var. Each item:
    //   "<marketId>" (uses default package + collateral) or
    //   "<marketId>@<packageId>:<collateralType>". Comma-separated.
    let segmentCranker: SegmentCranker | null = null;
    const segmentBindings: SegmentMarketBinding[] = parseSegmentMarketsEnv(
      process.env.WICK_KEEPER_SEGMENT_MARKETS,
      cfg.packageId,
      cfg.collateralType,
    );
    if (segmentBindings.length > 0) {
      segmentCranker = new SegmentCranker(client, signer.keypair, {
        intervalMs: Number(process.env.WICK_KEEPER_SEGMENT_INTERVAL_MS ?? 400),
        gasBudget: process.env.WICK_KEEPER_GAS_RECORD_SEGMENT
          ? BigInt(process.env.WICK_KEEPER_GAS_RECORD_SEGMENT)
          : undefined,
      });
      try {
        await segmentCranker.start(segmentBindings);
      } catch (err) {
        log("warn", "segment-cranker-start-failed", { error: String(err) });
      }
    }

    let stop = false;
    let backoffMs = cfg.rpcBackoffInitialMs;
    process.on("SIGINT", () => {
      log("info", "sigint", { msg: "draining current tick then exiting" });
      stop = true;
    });
    process.on("SIGTERM", () => {
      log("info", "sigterm", { msg: "draining current tick then exiting" });
      stop = true;
    });

    let state: KeeperState = { knownRides: [] };
    // Re-discover rides every N ticks to keep the list fresh without
    // hammering RPC.
    const REDISCOVER_EVERY_TICKS = 30;
    let tickCount = 0;

    while (!stop) {
      const t0 = Date.now();
      if (tickCount % REDISCOVER_EVERY_TICKS === 0) {
        try {
          state = { knownRides: await discoverKnownRides(client, cfg) };
        } catch (err) {
          log("warn", "rediscover-failed", { error: String(err) });
        }
      }
      tickCount += 1;
      try {
        const result = await tickOnce(client, signer.keypair, cfg, state);
        emitLogs(result);
        recordTick(health, result.finishedAtMs, result.failed);
        if (result.failed === 0) backoffMs = cfg.rpcBackoffInitialMs;
      } catch (err) {
        log("error", "tick-fatal", { error: String(err) });
        recordTick(health, Date.now(), 1);
        // exponential backoff (capped) on hard RPC outage
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, cfg.rpcBackoffMaxMs);
      }
      const elapsed = Date.now() - t0;
      const wait = Math.max(0, cfg.pollIntervalMs - elapsed);
      if (wait > 0 && !stop) await sleep(wait);
    }
    if (segmentCranker != null) {
      segmentCranker.stop();
    }
    server.close();
    log("info", "exit", { msg: "watch loop exited cleanly" });
    return;
  }

  log("error", "unknown-command", { cmd });
  // eslint-disable-next-line no-console
  console.error("usage: tsx src/index.ts (tick | watch)");
  process.exit(2);
}

main().catch((err) => {
  log("error", "main-uncaught", {
    error: String(err),
    stack: (err as Error).stack,
  });
  process.exit(1);
});
