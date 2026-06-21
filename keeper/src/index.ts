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
import { SegmentArchiver } from "./segmentArchiver.js";
import {
  SegmentSentinel,
  parseSentinelMarketsEnv,
  DEFAULT_SPONSOR_URL,
} from "./segmentSentinel.js";

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
  // Last-resort safety net so a single stray async error can't silently kill
  // the keeper mid-demo. The crank scheduler and event poller fire promises
  // fire-and-forget (segmentCranker.ts) and run on setInterval timers; a
  // rejection that escapes their own `.catch` would, under Node ≥15, crash the
  // whole process by default — stopping all cranking and stalling live rides.
  // We log it and keep going. An `uncaughtException` (synchronous, process may
  // be in a bad state) we log and exit non-zero so a supervisor restarts a
  // clean keeper rather than limping on corrupt state.
  process.on("unhandledRejection", (reason) => {
    log("error", "unhandled-rejection", { error: String(reason) });
  });
  process.on("uncaughtException", (err) => {
    log("error", "uncaught-exception", { error: String(err) });
    process.exit(1);
  });

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
    //   WICK_KEEPER_SEGMENT_MARKETS        → v3 markets (legacy)
    //   WICK_KEEPER_SEGMENT_MARKETS_V4     → v4 markets (all live markets)
    // Both feed one cranker; v4 bindings crank record_segment_v4 + track the
    // *_V4 events. For TUSD markets pass the type arg, e.g.
    //   "<market>@<pkg>:0x204d…::tusd::TUSD".
    let segmentCranker: SegmentCranker | null = null;
    const segmentBindings: SegmentMarketBinding[] = [
      ...parseSegmentMarketsEnv(
        process.env.WICK_KEEPER_SEGMENT_MARKETS,
        cfg.packageId,
        cfg.collateralType,
        "v3",
      ),
      ...parseSegmentMarketsEnv(
        process.env.WICK_KEEPER_SEGMENT_MARKETS_V4,
        cfg.packageId,
        cfg.collateralType,
        "v4",
      ),
    ];
    // v4 auto-discovery: WICK_KEEPER_SEGMENT_V4_AUTO=1 cranks every
    // segment_markets_v4[] entry in the deployment manifest — so
    // `keeper:watch` keeps all live charts alive without hand-listing ids.
    // Each market's own collateral is honored (SUI or TUSD). Deduped against
    // any explicit env bindings above.
    if (/^(1|true|yes)$/i.test(process.env.WICK_KEEPER_SEGMENT_V4_AUTO ?? "")) {
      const seen = new Set(segmentBindings.map((b) => b.marketId));
      for (const r of cfg.deployment.segment_markets_v4 ?? []) {
        if (!r.market || seen.has(r.market)) continue;
        seen.add(r.market);
        segmentBindings.push({
          marketId: r.market,
          packageId: cfg.packageId,
          collateralType: r.collateral ?? cfg.collateralType,
          version: "v4",
        });
      }
    }
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

    // v3.5 — Walrus archive bot. Optional, env-driven. Each item:
    //   "<marketId>" (uses default package) or
    //   "<marketId>@<packageId>". Comma-separated.
    //
    // Per docs/design/v2/24_walrus_archive_v3.md, the bot polls every market,
    // detects archive-eligible rounds (R + SETTLEMENT_LAG_ROUNDS <=
    // cached_round_index), uploads a BCS-encoded WickRoundArchive to a
    // Walrus publisher, then STUBS the on-chain record_walrus_archive call
    // (until the v3 Move surface ships).
    const archivers: SegmentArchiver[] = [];
    const archiverBindings = parseSegmentMarketsEnv(
      process.env.WICK_KEEPER_ARCHIVER_MARKETS,
      cfg.packageId,
      cfg.collateralType,
    );
    if (archiverBindings.length > 0) {
      const walrusEndpoint = process.env.WALRUS_PUBLISHER_URL;
      const retentionEpochs = process.env.WALRUS_RETENTION_EPOCHS
        ? Number(process.env.WALRUS_RETENTION_EPOCHS)
        : undefined;
      const pollIntervalMs = process.env.WICK_KEEPER_ARCHIVER_POLL_MS
        ? Number(process.env.WICK_KEEPER_ARCHIVER_POLL_MS)
        : undefined;
      for (const b of archiverBindings) {
        const archiver = new SegmentArchiver(client, signer.keypair, {
          marketId: b.marketId,
          packageId: b.packageId,
          walrusEndpoint,
          retentionEpochs,
          pollIntervalMs,
        });
        try {
          await archiver.start();
          archivers.push(archiver);
        } catch (err) {
          log("warn", "segment-archiver-start-failed", {
            market_id: b.marketId,
            error: String(err),
          });
        }
      }
    }

    // v3.6 — Sponsored sentinel runner. Optional, env-driven. Each item:
    //   "<marketId>" (uses default package + collateral) or
    //   "<marketId>@<packageId>:<collateralType>". Comma-separated.
    //
    // The sentinel opens-closes a tiny sentinel ride per round on each market
    // via /api/sponsor (doc 22 §3.3), so the segment-market wake gate is
    // always satisfied and the chart keeps rendering even when no human is
    // riding. Funded from the protocol's sponsor budget, not the operator's
    // wallet. /api/sponsor still enforces the v3 router + SegmentMarketV3
    // market-object allowlist before co-signing.
    const sentinels: SegmentSentinel[] = [];
    const sentinelBindings = parseSentinelMarketsEnv(
      process.env.WICK_KEEPER_SENTINEL_MARKETS,
      cfg.packageId,
      cfg.collateralType,
    );
    if (sentinelBindings.length > 0) {
      const sponsorUrl = process.env.WICK_SPONSOR_URL ?? DEFAULT_SPONSOR_URL;
      const sponsorAddress = process.env.WICK_SPONSOR_ADDRESS;
      const sentinelInterval = process.env.WICK_KEEPER_SENTINEL_INTERVAL_MS
        ? Number(process.env.WICK_KEEPER_SENTINEL_INTERVAL_MS)
        : undefined;
      const sentinelBarrierRaw = process.env.WICK_KEEPER_SENTINEL_BARRIER;
      const sentinelBarrier =
        sentinelBarrierRaw === "1" ? 1 : sentinelBarrierRaw === "0" ? 0 : undefined;
      const sentinelGas = process.env.WICK_KEEPER_SENTINEL_GAS
        ? BigInt(process.env.WICK_KEEPER_SENTINEL_GAS)
        : undefined;

      // The sentinel needs every shared singleton involved in open + close.
      // Surface missing ids loudly so operators see what's wrong without
      // having to read the source.
      const missingShared: string[] = [];
      if (!sponsorAddress) missingShared.push("WICK_SPONSOR_ADDRESS");
      if (!cfg.botRegistryId) missingShared.push("bot_registry (env WICK_KEEPER_BOT_REGISTRY)");
      if (!cfg.usdPriceOracleId) missingShared.push("usd_price_oracle (env WICK_KEEPER_USD_PRICE_ORACLE)");
      if (!cfg.wickTokenStateId) missingShared.push("wick_token_state (env WICK_KEEPER_WICK_STATE)");
      if (!cfg.stakingPoolId) missingShared.push("staking_pool (env WICK_KEEPER_STAKING_POOL)");
      if (missingShared.length > 0) {
        log("warn", "segment-sentinel-skip", {
          msg:
            "WICK_KEEPER_SENTINEL_MARKETS is set but required ids are missing; " +
            "sentinel disabled. Set the missing ids and restart.",
          missing: missingShared,
        });
      } else {
        const segmentMarketRecords = cfg.deployment.segment_markets ?? [];
        for (const b of sentinelBindings) {
          // Prefer per-market vault from segment_markets[]; fall back to
          // the global vault binding (cfg.vaultId / vault_sui).
          const perMarketVault = segmentMarketRecords
            .find((r) => r.market === b.marketId)?.vault;
          const vaultId = perMarketVault ?? cfg.vaultId;
          if (!vaultId) {
            log("warn", "segment-sentinel-no-vault", {
              market_id: b.marketId,
              msg:
                "no vault id resolvable for this market; set WICK_KEEPER_VAULT " +
                "or add a deployments/testnet.json segment_markets[] entry",
            });
            continue;
          }
          const sentinel = new SegmentSentinel(client, signer.keypair, {
            marketId: b.marketId,
            vaultId,
            botRegistryId: cfg.botRegistryId!,
            priceOracleId: cfg.usdPriceOracleId!,
            tokenStateId: cfg.wickTokenStateId!,
            stakingPoolId: cfg.stakingPoolId!,
            packageId: b.packageId,
            collateralType: b.collateralType,
            sponsorUrl,
            sponsorAddress: sponsorAddress!,
            ...(sentinelInterval !== undefined ? { intervalMs: sentinelInterval } : {}),
            ...(sentinelBarrier !== undefined ? { barrierIndex: sentinelBarrier } : {}),
            ...(sentinelGas !== undefined ? { gasBudget: sentinelGas } : {}),
          });
          try {
            await sentinel.start();
            sentinels.push(sentinel);
          } catch (err) {
            log("warn", "segment-sentinel-start-failed", {
              market_id: b.marketId,
              error: String(err),
            });
          }
        }
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
    for (const a of archivers) {
      try {
        a.stop();
      } catch (err) {
        log("warn", "segment-archiver-stop-failed", { error: String(err) });
      }
    }
    // v3.6 — drain sentinels. stop() awaits the in-flight close attempt.
    await Promise.all(
      sentinels.map(async (s) => {
        try {
          await s.stop();
        } catch (err) {
          log("warn", "segment-sentinel-stop-failed", { error: String(err) });
        }
      }),
    );
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
