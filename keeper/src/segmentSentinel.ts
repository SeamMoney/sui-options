// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// v3.6 — Sponsored sentinel runner. The production version of
// scripts/sentinel-runner.sh (which ships at commit 09c53b1 and runs from the
// operator's laptop, debiting their wallet). This subsystem opens-closes a
// tiny "sentinel" ride on a SegmentMarket once per round to keep the wake
// gate satisfied — `record_segment` aborts with `ENoActiveRides (=14)` when
// `active_ride_count == 0`, so without a constant sentinel the segment chart
// freezes whenever no human is riding.
//
// Difference from the bash bridge:
//   - scripts/sentinel-runner.sh signs + submits from the operator's `sui
//     client active-address`. Gas comes out of that wallet. Limited to demo
//     windows because the wallet drains in minutes.
//   - This module signs as the SENTINEL but ships the tx through
//     /api/sponsor (doc 22 §3.3, shipped at commit 69c02da). The sponsor
//     service co-signs as `gas_owner` so gas is debited from the protocol's
//     sponsor wallet (funded from fee_router::protocol_bucket via
//     `wick::sponsor::harvest_to_sponsor`, shipped at commit 1244648).
//     That makes 24/7 sentinel operation a protocol expense, not an
//     operator expense.
//
// References:
//   - docs/design/v2/22_sponsored_cranking_v3.md §3 (whole architecture),
//     §3.3 (sponsor service request shape), §3.6 deferred → §6 day 7
//     ("Sentinel runner (Node script on a Fly machine) → keep V3 chart
//     alive 24/7").
//   - scripts/sentinel-runner.sh (bash bridge — port the round-window math).
//   - keeper/src/segmentCranker.ts (cranker subsystem — mirror structure).
//   - keeper/src/segmentArchiver.ts (also env-driven; mirror env-wiring
//     pattern lines 124-145 of keeper/src/index.ts).
//   - api/sponsor.ts (the /api/sponsor service shipped at commit 69c02da
//     by Codex v3.2 — the request body shape is { sender, txBytes, userSig }
//     as base64 strings, both txBytes and userSig).
//
// Important non-fabrication notes:
//   * The sponsor allowlist (api/sponsor.ts line 21-26) is hardcoded to
//     `segment_market_v3::{record_segment, open_segment_ride,
//     close_segment_ride}`. The v3 module is NOT YET DEPLOYED on testnet
//     (per the v3.6 task brief). This sentinel deliberately targets the
//     v2 router (`wick::open_segment_ride` / `wick::close_segment_ride`)
//     so that AT MINIMUM the sentinel can be smoke-tested against the v2
//     market. The /api/sponsor service will respond 403
//     ("MoveCall is not on the Wick SegmentMarketV3 allowlist") in that
//     case. That's the expected flow-validation signal during v2-bridge
//     era. When v3 deploys, the targets here flip to
//     `wick::segment_market_v3::open_segment_ride` etc.
//   * The sponsor may also return 503 ("sponsor wallet is not configured")
//     if WICK_SPONSOR_PRIVATE_KEY isn't set in Vercel env. That's also
//     expected during early integration. The sentinel logs all of these
//     and keeps looping — it never crashes.
//
// Loop logic (mirrors scripts/sentinel-runner.sh):
//   1. Read SegmentMarket snapshot (active_ride_count, cached_round_*,
//      round_duration_segments, open_window_segments, next_segment_index,
//      min_stake_per_segment).
//   2. If active_ride_count > 0 → sleep one round; someone else is riding.
//   3. Compute segments_into_round = next_segment_index -
//      cached_round_started_at_segment.
//   4. If segments_into_round >= open_window_segments → sleep to next
//      round; open window closed.
//   5. Build open_segment_ride PTB (via /api/sponsor), capture ride id from
//      RideOpened event.
//   6. Sleep (round_duration_segments - WAIT_SLACK_SEGMENTS) × 400 ms — wait
//      out the round, leaving a small slack so we don't get auto-cranked
//      into EXPIRED_LOSS (which would burn the sponsor budget).
//   7. Build close_segment_ride PTB (via /api/sponsor).
//   8. Loop.
//
// Robustness:
//   - Any error in any step → log warn + sleep errorBackoffMs (5s default) +
//     retry. Never crashes.
//   - On SIGINT / stop(): if a ride is in flight, attempts to close it via
//     /api/sponsor before returning. Best-effort — a 1-attempt close;
//     keepers are usually restarted via systemd and the next start will
//     either find the close-by-expiry (EXPIRED_LOSS) already settled the
//     ride or will abort it once past `abort_segment_deadline_ms`.

import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID, toBase64 } from "@mysten/sui/utils";

// ── Tunables ────────────────────────────────────────────────────────────────

/** Default /api/sponsor URL — overridable per-instance + via env var in the
 *  keeper entrypoint. Mirrors the example in doc 22 §3.4. */
export const DEFAULT_SPONSOR_URL =
  "https://wick-markets.vercel.app/api/sponsor";

/** Segment cadence per the on-chain `record_segment` design (doc 17 §10 +
 *  18_segment_market_design.md §3). The chain hard-codes 400 ms per segment;
 *  it's only used here for round-duration math. */
export const SEGMENT_MS = 400;

/** Close N segments before round-end so we don't run into the EXPIRED_LOSS
 *  cliff. Matches the bash sentinel's WAIT_SLACK_SEGMENTS default of 2. */
export const DEFAULT_WAIT_SLACK_SEGMENTS = 2;

/** Default barrier — 0 = upper. The choice is arbitrary for the sentinel
 *  (it's a backstop, not a position); the bash bridge defaults to upper too. */
export const DEFAULT_BARRIER_INDEX = 0 as const;

/** Loop cadence between full open-close cycles. Mostly fed by round_ms
 *  computed from on-chain config; this is the floor between consecutive
 *  market-snapshot reads when we have nothing to do. */
export const DEFAULT_POLL_INTERVAL_MS = 1_000;

/** Backoff after a tx-submission error (5 s per task brief). */
export const DEFAULT_ERROR_BACKOFF_MS = 5_000;

/** Generous gas budget per open or close PTB. The bash script sets 200M MIST
 *  (0.2 SUI) which mirrors segment-smoke.sh. The sponsor pays this — the
 *  sentinel signer never holds gas — but the budget still has to fit the
 *  network's gas-price ceiling. */
export const DEFAULT_GAS_BUDGET = 200_000_000n;

/** HTTP timeout for /api/sponsor calls. Vercel serverless cold-starts may
 *  push past 1 s; 15 s gives slack without hanging the loop forever on a
 *  dropped connection. */
export const DEFAULT_SPONSOR_TIMEOUT_MS = 15_000;

// ── Public API ──────────────────────────────────────────────────────────────

export type SentinelBarrierIndex = 0 | 1;

export interface SegmentSentinelOptions {
  /** Shared SegmentMarket<C> id. Required. */
  marketId: string;
  /** Shared MartingalerVault<C> id this market binds to. Required. */
  vaultId: string;
  /** Shared BotRegistry id — required by `open_segment_ride`. */
  botRegistryId: string;
  /** Shared UsdPriceOracle id — required by `close_segment_ride`. */
  priceOracleId: string;
  /** Shared WickTokenState id — required by `close_segment_ride`. */
  tokenStateId: string;
  /** Shared WickStakingPool id — required by `close_segment_ride`. */
  stakingPoolId: string;
  /** Wick package id — current `package_id` from deployments JSON. */
  packageId: string;
  /** Move type-arg for `<C>` — e.g. "0x2::sui::SUI". */
  collateralType: string;
  /** /api/sponsor endpoint. Defaults to DEFAULT_SPONSOR_URL. */
  sponsorUrl?: string;
  /** Sponsor address — needed because Transaction.setGasOwner must match
   *  the sponsor wallet on the Vercel side. If absent, the sponsor service
   *  will reject the call with 403 ("gas owner must be the sponsor"). */
  sponsorAddress: string;
  /** Floor cadence (ms) between snapshots when there's nothing to do. */
  intervalMs?: number;
  /** Default barrier (0 = upper, 1 = lower). */
  barrierIndex?: SentinelBarrierIndex;
  /** Segments to close early before round end. Default 2. */
  waitSlackSegments?: number;
  /** Per-PTB gas budget. Default 200M MIST. */
  gasBudget?: bigint;
  /** Error backoff (ms) before retrying after any thrown error. Default 5s. */
  errorBackoffMs?: number;
  /** HTTP timeout for /api/sponsor. Default 15s. */
  sponsorTimeoutMs?: number;
  /** Custom log sink. Default NDJSON to stdout, matching the rest of keeper. */
  log?: (entry: SegmentSentinelLogEntry) => void;
  /** Override fetch (e.g. for tests). Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

export interface SegmentSentinelLogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  action: string;
  market_id?: string;
  tx_digest?: string;
  ride_id?: string;
  error?: string;
  msg?: string;
  detail?: Record<string, unknown>;
}

export interface SegmentSentinelStatus {
  marketId: string;
  packageId: string;
  collateralType: string;
  running: boolean;
  currentRideId: string | null;
  loopsTotal: number;
  opensTotal: number;
  closesTotal: number;
  errorsTotal: number;
  lastErrorTsMs: number;
  lastErrorMessage: string | null;
  lastOpenDigest: string | null;
  lastCloseDigest: string | null;
  lastSnapshotTsMs: number;
}

/** Read-only market shape this sentinel cares about — kept locally so this
 *  module remains sdk/-free (mirrors segmentCranker.ts policy). */
export interface SentinelMarketSnapshot {
  activeRideCount: bigint;
  nextSegmentIndex: bigint;
  cachedRoundIndex: bigint;
  cachedRoundStartedAtSegment: bigint;
  roundDurationSegments: bigint;
  openWindowSegments: bigint;
  minStakePerSegment: bigint;
}

/** Outcome of a /api/sponsor POST. Distinguishes the four cases the sentinel
 *  cares about: success (200), allowlist/auth failure (403), rate-limit
 *  (429), service degraded (503), other (400 / 4xx / 5xx / network). */
export type SponsorCallOutcome =
  | { kind: "ok"; digest: string }
  | { kind: "rejected"; status: number; error: string }
  | { kind: "rate-limited"; status: 429; retryAfterMs: number }
  | { kind: "degraded"; status: number; error: string }
  | { kind: "transport-error"; error: string };

// ── PTB builders — mirror sdk/src/segmentMarket.ts builders ─────────────────
// Kept local per the same rule the cranker + archiver follow (the SDK is the
// canonical reference and is allowed to diverge; the keeper deliberately
// re-implements to stay sdk/-free).

export function buildOpenSentinelRideTx(args: {
  packageId: string;
  collateralType: string;
  marketId: string;
  vaultId: string;
  botRegistryId: string;
  barrierIndex: SentinelBarrierIndex;
  stakePerSegment: bigint;
  escrowMist: bigint;
  sender: string;
  sponsorAddress: string;
  gasBudget: bigint;
}): Transaction {
  if (args.escrowMist <= 0n) throw new Error("escrowMist must be > 0");
  if (args.stakePerSegment <= 0n) throw new Error("stakePerSegment must be > 0");
  const tx = new Transaction();
  // The user (sentinel) signs intent; the sponsor signs gas. Both must be
  // set BEFORE build() — the Move ABI looks at ctx.sender(), the Sui
  // protocol enforces gas_owner against the sponsor's signature.
  tx.setSender(args.sender);
  tx.setGasOwner(args.sponsorAddress);
  tx.setGasBudget(args.gasBudget);
  const [escrow] = tx.splitCoins(tx.gas, [tx.pure.u64(args.escrowMist)]);
  const ride = tx.moveCall({
    target: `${args.packageId}::wick::open_segment_ride`,
    typeArguments: [args.collateralType],
    arguments: [
      tx.object(args.marketId),
      tx.object(args.vaultId),
      tx.object(args.botRegistryId),
      tx.pure.u8(args.barrierIndex),
      tx.pure.u64(args.stakePerSegment),
      escrow,
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  tx.transferObjects([ride], tx.pure.address(args.sender));
  return tx;
}

export function buildCloseSentinelRideTx(args: {
  packageId: string;
  collateralType: string;
  rideId: string;
  marketId: string;
  vaultId: string;
  priceOracleId: string;
  tokenStateId: string;
  stakingPoolId: string;
  sender: string;
  sponsorAddress: string;
  gasBudget: bigint;
}): Transaction {
  const tx = new Transaction();
  tx.setSender(args.sender);
  tx.setGasOwner(args.sponsorAddress);
  tx.setGasBudget(args.gasBudget);
  const payout = tx.moveCall({
    target: `${args.packageId}::wick::close_segment_ride`,
    typeArguments: [args.collateralType],
    arguments: [
      tx.object(args.rideId),
      tx.object(args.marketId),
      tx.object(args.vaultId),
      tx.object(args.priceOracleId),
      tx.object(args.tokenStateId),
      tx.object(args.stakingPoolId),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  tx.transferObjects([payout], tx.pure.address(args.sender));
  return tx;
}

// ── The sentinel ────────────────────────────────────────────────────────────

export class SegmentSentinel {
  private readonly client: SuiJsonRpcClient;
  private readonly signer: Ed25519Keypair;
  private readonly senderAddress: string;
  private readonly opts: Required<
    Omit<SegmentSentinelOptions, "log" | "fetch" | "sponsorUrl">
  > & {
    sponsorUrl: string;
    log: (e: SegmentSentinelLogEntry) => void;
    fetch: typeof globalThis.fetch;
  };

  private running = false;
  private stopRequested = false;
  private loopPromise: Promise<void> | null = null;
  private currentRideId: string | null = null;
  private sleepResolver: (() => void) | null = null;

  // Telemetry
  private loopsTotal = 0;
  private opensTotal = 0;
  private closesTotal = 0;
  private errorsTotal = 0;
  private lastErrorTsMs = 0;
  private lastErrorMessage: string | null = null;
  private lastOpenDigest: string | null = null;
  private lastCloseDigest: string | null = null;
  private lastSnapshotTsMs = 0;

  constructor(
    client: SuiJsonRpcClient,
    signer: Ed25519Keypair,
    opts: SegmentSentinelOptions,
  ) {
    if (!opts.marketId) throw new Error("segmentSentinel: marketId is required");
    if (!opts.vaultId) throw new Error("segmentSentinel: vaultId is required");
    if (!opts.botRegistryId) throw new Error("segmentSentinel: botRegistryId is required");
    if (!opts.priceOracleId) throw new Error("segmentSentinel: priceOracleId is required");
    if (!opts.tokenStateId) throw new Error("segmentSentinel: tokenStateId is required");
    if (!opts.stakingPoolId) throw new Error("segmentSentinel: stakingPoolId is required");
    if (!opts.packageId) throw new Error("segmentSentinel: packageId is required");
    if (!opts.collateralType) throw new Error("segmentSentinel: collateralType is required");
    if (!opts.sponsorAddress) {
      throw new Error("segmentSentinel: sponsorAddress is required (Transaction.setGasOwner)");
    }
    this.client = client;
    this.signer = signer;
    this.senderAddress = signer.getPublicKey().toSuiAddress();
    this.opts = {
      marketId: opts.marketId,
      vaultId: opts.vaultId,
      botRegistryId: opts.botRegistryId,
      priceOracleId: opts.priceOracleId,
      tokenStateId: opts.tokenStateId,
      stakingPoolId: opts.stakingPoolId,
      packageId: opts.packageId,
      collateralType: opts.collateralType,
      sponsorAddress: opts.sponsorAddress,
      sponsorUrl: opts.sponsorUrl ?? DEFAULT_SPONSOR_URL,
      intervalMs: opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      barrierIndex: opts.barrierIndex ?? DEFAULT_BARRIER_INDEX,
      waitSlackSegments: opts.waitSlackSegments ?? DEFAULT_WAIT_SLACK_SEGMENTS,
      gasBudget: opts.gasBudget ?? DEFAULT_GAS_BUDGET,
      errorBackoffMs: opts.errorBackoffMs ?? DEFAULT_ERROR_BACKOFF_MS,
      sponsorTimeoutMs: opts.sponsorTimeoutMs ?? DEFAULT_SPONSOR_TIMEOUT_MS,
      log: opts.log ?? defaultLogger,
      fetch: opts.fetch ?? globalThis.fetch.bind(globalThis),
    };
  }

  /** Begin the open-close loop. Safe to call once — a second call is a
   *  no-op while already running. Returns once the initial state is logged;
   *  the loop runs in the background. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.opts.log({
      ts: nowIso(),
      level: "info",
      action: "segment-sentinel.start",
      market_id: this.opts.marketId,
      detail: {
        sender: this.senderAddress,
        sponsor_address: this.opts.sponsorAddress,
        sponsor_url: this.opts.sponsorUrl,
        package_id: this.opts.packageId,
        collateral_type: this.opts.collateralType,
        barrier_index: this.opts.barrierIndex,
        wait_slack_segments: this.opts.waitSlackSegments,
        gas_budget_mist: this.opts.gasBudget.toString(),
        interval_ms: this.opts.intervalMs,
        // Important visibility for first-time integration — call this out
        // so operators don't get confused by 403 responses on the v2 bridge.
        note:
          "PTBs target `wick::open_segment_ride` / `wick::close_segment_ride` " +
          "(v2 router). /api/sponsor's allowlist requires `segment_market_v3` " +
          "— expect 403 responses until v3 ships. See keeper/src/segmentSentinel.ts " +
          "header for context.",
      },
    });
    this.loopPromise = this.runLoop();
  }

  /** Stop the loop. If a ride is in flight, attempts a best-effort
   *  graceful close via /api/sponsor before returning. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopRequested = true;
    // Wake any sleep that's mid-flight so the loop notices stopRequested.
    if (this.sleepResolver) {
      this.sleepResolver();
      this.sleepResolver = null;
    }
    // Drain the loop. The loop sees stopRequested and breaks out after the
    // current step finishes — but it does NOT auto-close. We trigger that
    // explicitly here so callers can await the close attempt.
    if (this.loopPromise) {
      try { await this.loopPromise; } catch { /* logged by the loop */ }
      this.loopPromise = null;
    }
    if (this.currentRideId) {
      const ride = this.currentRideId;
      this.opts.log({
        ts: nowIso(),
        level: "warn",
        action: "segment-sentinel.shutdown-close-begin",
        market_id: this.opts.marketId,
        ride_id: ride,
        msg: "ride in flight at shutdown — attempting graceful close via /api/sponsor",
      });
      const out = await this.attemptClose(ride).catch((err) => ({
        kind: "transport-error" as const,
        error: (err as Error)?.message ?? String(err),
      }));
      if (out.kind === "ok") {
        this.opts.log({
          ts: nowIso(),
          level: "info",
          action: "segment-sentinel.shutdown-close-ok",
          market_id: this.opts.marketId,
          ride_id: ride,
          tx_digest: out.digest,
        });
        this.currentRideId = null;
      } else {
        this.opts.log({
          ts: nowIso(),
          level: "warn",
          action: "segment-sentinel.shutdown-close-failed",
          market_id: this.opts.marketId,
          ride_id: ride,
          error: outcomeError(out),
          msg:
            "ride remains open; expect EXPIRED_LOSS on next round end, or run " +
            "scripts/segment-smoke.sh / sentinel-runner.sh to recover.",
        });
      }
    }
    this.running = false;
    this.opts.log({
      ts: nowIso(),
      level: "info",
      action: "segment-sentinel.stop",
      market_id: this.opts.marketId,
      detail: {
        loops_total: this.loopsTotal,
        opens_total: this.opensTotal,
        closes_total: this.closesTotal,
        errors_total: this.errorsTotal,
      },
    });
  }

  status(): SegmentSentinelStatus {
    return {
      marketId: this.opts.marketId,
      packageId: this.opts.packageId,
      collateralType: this.opts.collateralType,
      running: this.running,
      currentRideId: this.currentRideId,
      loopsTotal: this.loopsTotal,
      opensTotal: this.opensTotal,
      closesTotal: this.closesTotal,
      errorsTotal: this.errorsTotal,
      lastErrorTsMs: this.lastErrorTsMs,
      lastErrorMessage: this.lastErrorMessage,
      lastOpenDigest: this.lastOpenDigest,
      lastCloseDigest: this.lastCloseDigest,
      lastSnapshotTsMs: this.lastSnapshotTsMs,
    };
  }

  // ── Loop ────────────────────────────────────────────────────────────────

  private async runLoop(): Promise<void> {
    while (!this.stopRequested) {
      this.loopsTotal += 1;
      try {
        await this.runOneIteration();
      } catch (err) {
        this.recordError(`loop iteration: ${(err as Error)?.message ?? String(err)}`);
        await this.sleep(this.opts.errorBackoffMs);
      }
    }
  }

  private async runOneIteration(): Promise<void> {
    // (a) Read SegmentMarket state.
    const snap = await this.readMarketSnapshot();
    if (!snap) {
      this.recordError(`market ${this.opts.marketId} not found or wrong type`);
      await this.sleep(this.opts.errorBackoffMs);
      return;
    }
    this.lastSnapshotTsMs = Date.now();

    const roundDurationSegments = snap.roundDurationSegments;
    const openWindowSegments = snap.openWindowSegments;
    const minStakePerSegment = snap.minStakePerSegment;
    if (
      roundDurationSegments <= 0n ||
      openWindowSegments <= 0n ||
      minStakePerSegment <= 0n
    ) {
      this.recordError(
        `market has invalid config: ` +
          `round_duration_segments=${roundDurationSegments}, ` +
          `open_window_segments=${openWindowSegments}, ` +
          `min_stake_per_segment=${minStakePerSegment}`,
      );
      await this.sleep(this.opts.errorBackoffMs);
      return;
    }
    const roundMs = Number(roundDurationSegments) * SEGMENT_MS;

    // (b) Someone else is already riding → no need to sentinel this round.
    if (snap.activeRideCount > 0n) {
      this.opts.log({
        ts: nowIso(),
        level: "info",
        action: "segment-sentinel.skip-active",
        market_id: this.opts.marketId,
        detail: {
          active_ride_count: snap.activeRideCount.toString(),
          msg: "another ride is open — sleeping one round",
        },
      });
      await this.sleep(roundMs);
      return;
    }

    // (c) Compute segments_into_round.
    const segsInto = snap.nextSegmentIndex - snap.cachedRoundStartedAtSegment;
    // Defensive clamp — shouldn't go negative but be permissive in case
    // the lazy-roll hasn't run yet for this market.
    const segsIntoRound = segsInto < 0n ? 0n : segsInto;

    // (d) Open window closed → sleep to next round.
    if (segsIntoRound >= openWindowSegments) {
      const segsToNext = roundDurationSegments - segsIntoRound;
      const waitSegs = segsToNext < 1n ? 1n : segsToNext;
      const waitMs = Number(waitSegs) * SEGMENT_MS;
      this.opts.log({
        ts: nowIso(),
        level: "info",
        action: "segment-sentinel.skip-window-closed",
        market_id: this.opts.marketId,
        detail: {
          segs_into_round: segsIntoRound.toString(),
          open_window_segments: openWindowSegments.toString(),
          wait_ms: waitMs,
        },
      });
      await this.sleep(waitMs);
      return;
    }

    // (e) Build + sign + sponsor the OPEN ride.
    const stakePerSegment = minStakePerSegment;
    // Escrow = stake_per_segment × round_duration_segments (Move side asserts
    // exactly this lower bound; matches the bash sentinel's math).
    const escrowMist = stakePerSegment * roundDurationSegments;

    const openTx = buildOpenSentinelRideTx({
      packageId: this.opts.packageId,
      collateralType: this.opts.collateralType,
      marketId: this.opts.marketId,
      vaultId: this.opts.vaultId,
      botRegistryId: this.opts.botRegistryId,
      barrierIndex: this.opts.barrierIndex,
      stakePerSegment,
      escrowMist,
      sender: this.senderAddress,
      sponsorAddress: this.opts.sponsorAddress,
      gasBudget: this.opts.gasBudget,
    });

    const openOutcome = await this.signAndSponsor(openTx, "open");
    if (openOutcome.kind !== "ok") {
      this.recordError(
        `open via /api/sponsor: ${outcomeError(openOutcome)}`,
      );
      await this.sleep(this.opts.errorBackoffMs);
      return;
    }
    this.lastOpenDigest = openOutcome.digest;
    this.opensTotal += 1;

    // (f) Capture ride id from RideOpened event. The sponsor service
    // returns only { digest }; we have to fetch the tx to recover the
    // event payload. Failure here is non-fatal — we still sleep through
    // the round, then proceed to close. The close PTB needs the ride id
    // though, so if extraction fails we have to give up on this round.
    let rideId: string | null;
    try {
      rideId = await this.extractRideIdFromOpen(openOutcome.digest);
    } catch (err) {
      this.recordError(
        `extract ride id from open digest ${openOutcome.digest}: ` +
          ((err as Error)?.message ?? String(err)),
      );
      await this.sleep(this.opts.errorBackoffMs);
      return;
    }
    if (!rideId) {
      this.recordError(
        `RideOpened event not found in tx ${openOutcome.digest}; cannot close this round`,
      );
      // Sleep one full round so the in-flight ride drains via EXPIRED_LOSS
      // (or stays parked — `crank_expired_segment_ride` is permissionless).
      await this.sleep(roundMs);
      return;
    }
    this.currentRideId = rideId;
    this.opts.log({
      ts: nowIso(),
      level: "info",
      action: "segment-sentinel.open-ok",
      market_id: this.opts.marketId,
      ride_id: rideId,
      tx_digest: openOutcome.digest,
      detail: {
        stake_per_segment: stakePerSegment.toString(),
        escrow_mist: escrowMist.toString(),
        barrier_index: this.opts.barrierIndex,
      },
    });

    // (g) Hold the ride for (round_duration - wait_slack) × 400 ms. Allow
    // stop() to wake us early.
    const slack = BigInt(this.opts.waitSlackSegments);
    const holdSegs = roundDurationSegments > slack
      ? roundDurationSegments - slack
      : 1n;
    const holdMs = Number(holdSegs) * SEGMENT_MS;
    await this.sleep(holdMs);
    if (this.stopRequested) {
      // stop() drains the in-flight ride after the loop exits — leave
      // currentRideId set so the shutdown-close path fires.
      return;
    }

    // (h) Close.
    const closeOutcome = await this.attemptClose(rideId);
    if (closeOutcome.kind !== "ok") {
      this.recordError(
        `close ride ${rideId} via /api/sponsor: ${outcomeError(closeOutcome)}`,
      );
      // Don't clear currentRideId — the shutdown trap or next loop tick
      // gets another chance.
      await this.sleep(this.opts.errorBackoffMs);
      return;
    }
    this.lastCloseDigest = closeOutcome.digest;
    this.closesTotal += 1;
    this.opts.log({
      ts: nowIso(),
      level: "info",
      action: "segment-sentinel.close-ok",
      market_id: this.opts.marketId,
      ride_id: rideId,
      tx_digest: closeOutcome.digest,
    });
    this.currentRideId = null;
  }

  /** Build + sign + sponsor a close for an existing ride. Idempotent in
   *  the sense that on chain `close_segment_ride` aborts with `EAlreadyClosed`
   *  if the ride was already closed (e.g. by a permissionless crank). */
  private async attemptClose(rideId: string): Promise<SponsorCallOutcome> {
    const tx = buildCloseSentinelRideTx({
      packageId: this.opts.packageId,
      collateralType: this.opts.collateralType,
      rideId,
      marketId: this.opts.marketId,
      vaultId: this.opts.vaultId,
      priceOracleId: this.opts.priceOracleId,
      tokenStateId: this.opts.tokenStateId,
      stakingPoolId: this.opts.stakingPoolId,
      sender: this.senderAddress,
      sponsorAddress: this.opts.sponsorAddress,
      gasBudget: this.opts.gasBudget,
    });
    return this.signAndSponsor(tx, "close");
  }

  // ── /api/sponsor transport ──────────────────────────────────────────────

  /** Build the BCS tx bytes, sign as sender, POST to /api/sponsor. */
  private async signAndSponsor(
    tx: Transaction,
    kind: "open" | "close",
  ): Promise<SponsorCallOutcome> {
    let txBytes: Uint8Array;
    try {
      // Passing `client` lets the SDK fetch any remaining protocol config
      // (gas price, etc.) it needs to finalize the TransactionData blob.
      txBytes = await tx.build({ client: this.client });
    } catch (err) {
      return {
        kind: "transport-error",
        error: `build ${kind} tx: ${(err as Error)?.message ?? String(err)}`,
      };
    }
    let userSig: string;
    try {
      // SignatureWithBytes.signature is already base64 — matches the
      // shape /api/sponsor expects after decodeBase64Field.
      const signed = await this.signer.signTransaction(txBytes);
      userSig = signed.signature;
    } catch (err) {
      return {
        kind: "transport-error",
        error: `sign ${kind} tx: ${(err as Error)?.message ?? String(err)}`,
      };
    }

    const body = JSON.stringify({
      sender: this.senderAddress,
      txBytes: toBase64(txBytes),
      userSig,
    });

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.opts.sponsorTimeoutMs,
    );
    let res: Response;
    try {
      res = await this.opts.fetch(this.opts.sponsorUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      return {
        kind: "transport-error",
        error: `POST ${this.opts.sponsorUrl}: ${(err as Error)?.message ?? String(err)}`,
      };
    } finally {
      clearTimeout(timer);
    }

    let parsed: Record<string, unknown> = {};
    try {
      parsed = (await res.json()) as Record<string, unknown>;
    } catch {
      // Fall through with empty body — Vercel sometimes returns plain text.
    }

    if (res.status === 200) {
      const digest = typeof parsed["digest"] === "string"
        ? (parsed["digest"] as string)
        : "";
      if (!digest) {
        return {
          kind: "degraded",
          status: 200,
          error: "sponsor returned 200 without a digest",
        };
      }
      return { kind: "ok", digest };
    }
    const errStr = typeof parsed["error"] === "string"
      ? (parsed["error"] as string)
      : `HTTP ${res.status}`;
    if (res.status === 429) {
      const ra = parsed["retry_after_ms"];
      const retryAfterMs = typeof ra === "number" ? ra : 60_000;
      return { kind: "rate-limited", status: 429, retryAfterMs };
    }
    if (res.status === 403 || res.status === 400) {
      return { kind: "rejected", status: res.status, error: errStr };
    }
    if (res.status === 503 || res.status === 502 || res.status === 504) {
      return { kind: "degraded", status: res.status, error: errStr };
    }
    return { kind: "rejected", status: res.status, error: errStr };
  }

  // ── On-chain reads ──────────────────────────────────────────────────────

  /** Read the slice of SegmentMarket fields we need. Same pattern as the
   *  archiver's readMarketSnapshot, scoped wider for sentinel needs. */
  private async readMarketSnapshot(): Promise<SentinelMarketSnapshot | null> {
    const o = await this.client.getObject({
      id: this.opts.marketId,
      options: { showContent: true, showType: true },
    });
    if (!o.data || o.data.content?.dataType !== "moveObject") return null;
    const content = o.data.content as {
      fields: Record<string, unknown>;
      type: string;
    };
    if (!/::segment_market::SegmentMarket<.+>$/.test(content.type)) return null;
    const f = content.fields;
    return {
      activeRideCount: asBigInt(f.active_ride_count),
      nextSegmentIndex: asBigInt(f.next_segment_index),
      cachedRoundIndex: asBigInt(f.cached_round_index),
      cachedRoundStartedAtSegment: asBigInt(f.cached_round_started_at_segment),
      roundDurationSegments: asBigInt(f.round_duration_segments),
      openWindowSegments: asBigInt(f.open_window_segments),
      minStakePerSegment: asBigInt(f.min_stake_per_segment),
    };
  }

  /** Pull the open tx's RideOpened event to recover the ride id. The
   *  sponsor service swallows the events; we re-fetch via getTransactionBlock
   *  with showEvents:true. */
  private async extractRideIdFromOpen(digest: string): Promise<string | null> {
    const tb = await this.client.getTransactionBlock({
      digest,
      options: { showEvents: true, showObjectChanges: true },
    });
    const events = (tb.events ?? []) as Array<{
      type?: string;
      parsedJson?: Record<string, unknown>;
    }>;
    for (const ev of events) {
      if (typeof ev.type === "string" && ev.type.endsWith("::segment_market::RideOpened")) {
        const j = ev.parsedJson ?? {};
        const ride = j["ride_id"];
        if (typeof ride === "string" && ride.length > 0) return ride;
      }
    }
    // Fall back to objectChanges — SegmentRidePosition gets created here.
    const changes = (tb.objectChanges ?? []) as Array<{
      type?: string;
      objectType?: string;
      objectId?: string;
    }>;
    for (const c of changes) {
      if (
        c.type === "created" &&
        typeof c.objectType === "string" &&
        c.objectType.endsWith("::segment_market::SegmentRidePosition") &&
        typeof c.objectId === "string"
      ) {
        return c.objectId;
      }
    }
    return null;
  }

  // ── Plumbing ────────────────────────────────────────────────────────────

  private recordError(message: string): void {
    this.errorsTotal += 1;
    this.lastErrorTsMs = Date.now();
    this.lastErrorMessage = message;
    this.opts.log({
      ts: nowIso(),
      level: "warn",
      action: "segment-sentinel.error",
      market_id: this.opts.marketId,
      error: message,
    });
  }

  /** Sleep ms with wake-on-stop. Replaces the old setInterval pattern from
   *  the cranker because the sentinel's natural rhythm is sequential
   *  (open → wait round → close), not a fixed-cadence beat. */
  private sleep(ms: number): Promise<void> {
    if (ms <= 0 || this.stopRequested) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        if (this.sleepResolver === done) this.sleepResolver = null;
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(done, ms);
      if (typeof t.unref === "function") t.unref();
      this.sleepResolver = done;
    });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function asBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string" && v.length > 0) return BigInt(v);
  return 0n;
}

function outcomeError(o: SponsorCallOutcome): string {
  switch (o.kind) {
    case "ok": return "ok";
    case "rejected": return `${o.status}: ${o.error}`;
    case "rate-limited": return `429 rate-limited (retry in ${o.retryAfterMs}ms)`;
    case "degraded": return `${o.status}: ${o.error}`;
    case "transport-error": return `transport: ${o.error}`;
  }
}

function defaultLogger(entry: SegmentSentinelLogEntry): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
}

function nowIso(): string {
  return new Date().toISOString();
}

// ── Config helper — parse a comma-separated WICK_KEEPER_SENTINEL_MARKETS ────
//
// Two accepted shapes per item:
//   "<marketId>"                  — uses default package + collateral
//   "<marketId>@<packageId>:<collateralType>"
//
// Mirrors parseSegmentMarketsEnv in segmentCranker.ts. The wiring in
// keeper/src/index.ts pairs each binding with the shared singleton ids
// pulled from the keeper config (vault, bot_registry, price_oracle,
// wick_token_state, staking_pool).

export interface SentinelMarketBinding {
  marketId: string;
  packageId: string;
  collateralType: string;
}

export function parseSentinelMarketsEnv(
  raw: string | undefined,
  defaultPackageId: string,
  defaultCollateralType = "0x2::sui::SUI",
): SentinelMarketBinding[] {
  if (!raw || raw.trim().length === 0) return [];
  const out: SentinelMarketBinding[] = [];
  for (const item of raw.split(",")) {
    const trimmed = item.trim();
    if (trimmed.length === 0) continue;
    const atIdx = trimmed.indexOf("@");
    if (atIdx < 0) {
      out.push({
        marketId: trimmed,
        packageId: defaultPackageId,
        collateralType: defaultCollateralType,
      });
      continue;
    }
    const marketId = trimmed.slice(0, atIdx).trim();
    const rest = trimmed.slice(atIdx + 1).trim();
    const colonIdx = rest.indexOf(":");
    if (colonIdx < 0) {
      out.push({
        marketId,
        packageId: rest,
        collateralType: defaultCollateralType,
      });
      continue;
    }
    const packageId = rest.slice(0, colonIdx).trim();
    const collateralType = rest.slice(colonIdx + 1).trim();
    out.push({ marketId, packageId, collateralType });
  }
  return out;
}
