// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// v3.5 — Walrus archive bot for the provably-fair arcade.
//
// Per `docs/design/v2/24_walrus_archive_v3.md`, the archiver writes a per-round
// `WickRoundArchive` BCS blob to Walrus and then calls
// `wick::segment_market_v3::record_walrus_archive` so the on-chain
// `ArchiveIndex` references the blob ID. That on-chain entry function is the
// precondition for `prune_settled_segments` (doc 23) — together the three
// pieces (sponsored cranking → archive → prune-with-rebate) form the v3
// hot/cold storage split.
//
// v3.5 status (this implementation):
//   - The Move side of v3 (`segment_market_v3` module with `archive_index`,
//     `unsettled_rides_per_round`, `pruned_rounds` fields and the
//     `record_walrus_archive` / `prune_settled_segments` entry functions) is
//     NOT YET DEPLOYED. The archiver below runs end-to-end against the v2
//     SegmentMarket: it picks rounds that are >= SETTLEMENT_LAG_ROUNDS old,
//     fetches their segment events, builds the BCS-encoded WickRoundArchive,
//     and STUBS the on-chain `record_walrus_archive` call (logs the intent
//     instead). When v3 lands, swap the stub for a real `Transaction` build
//     and the bot is wire-compatible.
//   - Walrus access is via the public HTTP publisher (doc 24 §2 / Walrus
//     docs § Storing Blobs). Default endpoint is the Mysten Labs
//     testnet publisher; override via `WALRUS_PUBLISHER_URL`. Endpoint
//     shape is `PUT /v1/blobs?epochs=N`, raw bytes in body. Response is
//     JSON with `newlyCreated.blobObject.blobId` or `alreadyCertified.blobId`.
//     blobId is base64-url-encoded (43 chars, encodes 32 bytes). We decode it
//     back to a 32-byte Uint8Array before stubbing the on-chain call so the
//     wire payload matches the `vector<u8>` (length 32) the Move ABI will
//     assert per doc 24 §5.
//
// References:
//   - docs/design/v2/24_walrus_archive_v3.md   (§3 schema, §4 flow, §5 ABI)
//   - docs/design/v2/23_storage_rebate_pruning_v3.md (the archive-before-prune
//     invariant; this archiver is its precondition)
//   - sdk/src/segmentMarket.ts                  (fetchSegments + RoundStarted)
//   - keeper/src/segmentCranker.ts              (polling-loop pattern mirrored
//     here)

import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { bcs } from "@mysten/bcs";

// ── Tunables ────────────────────────────────────────────────────────────────

/** Per doc 23 §3.1 — wait this many rounds past settle before archiving so
 *  late-arriving abort or reconciliation calls have already landed.        */
export const SETTLEMENT_LAG_ROUNDS = 3n;

/** Default Walrus testnet publisher (operated by Mysten Labs). Verified
 *  against `docs/site/static/operators.json` in MystenLabs/walrus repo. */
export const DEFAULT_WALRUS_PUBLISHER_URL =
  "https://publisher.walrus-testnet.walrus.space";

/** Default retention in Walrus epochs. Testnet epoch = 1 day. Per doc 24
 *  §9, the v3.0 mainnet default is 365 (1 year); for testnet integration
 *  smoke 14 days is plenty and keeps the publisher cost trivial.           */
export const DEFAULT_RETENTION_EPOCHS = 14;

/** How often to poll for the next archive-eligible round. The keeper's
 *  ordinary tick cadence is 2 s; this bot can sleep much longer because
 *  archive-eligible rounds appear at most one every 8 s (round duration). */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** Cooldown after any error before we resume polling. Per task brief. */
export const ERROR_BACKOFF_MS = 5_000;

/** Max event pages we'll scan to pull a round's segments. With 20 segments
 *  per round and 50 events per page, 5 pages cover ~250 events. Defensive
 *  ceiling so a wide-open run doesn't degenerate into a loop.              */
export const SEGMENT_EVENT_PAGES_MAX = 20;

// ── BCS schema — must match doc 24 §3 exactly ───────────────────────────────
//
// SegmentArchiveEntry — one segment per round.
// All u64 fields serialize as 8 bytes LE. vector<u8> uses a ULEB128 length
// prefix then raw bytes. Schema versioning lives in the outer WickRoundArchive
// via `schema_version: u8 = 1`.

/** Sign-magnitude integer carried through the walk state. Matches
 *  `seeded_path::Signed { neg: bool, mag: u128 }`. */
export const SignedBCS = bcs.struct("Signed", {
  neg: bcs.bool(),
  mag: bcs.u128(),
});

/** The walk state checkpoint, matching `seeded_path::WalkState`. The
 *  archived `state_after` lets `/verify` deterministically replay from any
 *  round boundary without scanning every prior segment.                    */
export const WalkStateBCS = bcs.struct("WalkState", {
  price: bcs.u64(),
  momentum: SignedBCS,
  vol_regime: bcs.u64(),
  home: bcs.u64(),
  pattern_id: bcs.u8(),
  candles_remaining: bcs.u8(),
});

/** One segment entry in the archive — corresponds to a SegmentRecord on
 *  chain, with the post-walk state added so partial-round /verify works.  */
export const SegmentArchiveEntryBCS = bcs.struct("SegmentArchiveEntry", {
  k: bcs.u64(),
  key: bcs.vector(bcs.u8()),    // 32-byte randomness key
  recorded_at_ms: bcs.u64(),
  segment_min: bcs.u64(),
  segment_max: bcs.u64(),
  state_after: WalkStateBCS,
});

/** The per-round archive blob written to Walrus. */
export const WickRoundArchiveBCS = bcs.struct("WickRoundArchive", {
  schema_version: bcs.u8(),
  market_id: bcs.vector(bcs.u8()),         // 32-byte object ID
  round_index: bcs.u64(),
  round_started_at_ms: bcs.u64(),
  round_started_at_segment: bcs.u64(),
  round_duration_segments: bcs.u64(),
  upper_barrier: bcs.u64(),
  lower_barrier: bcs.u64(),
  segments: bcs.vector(SegmentArchiveEntryBCS),
  walk_state_at_round_start: WalkStateBCS,
  closed_at_ms_for_round: bcs.u64(),
});

// Typed shape inferred from the BCS schema — useful for tests / downstream.
export interface WalkStatePayload {
  price: string | bigint;
  momentum: { neg: boolean; mag: string | bigint };
  vol_regime: string | bigint;
  home: string | bigint;
  pattern_id: number;
  candles_remaining: number;
}

export interface SegmentArchiveEntryPayload {
  k: string | bigint;
  key: Iterable<number> & { length: number };
  recorded_at_ms: string | bigint;
  segment_min: string | bigint;
  segment_max: string | bigint;
  state_after: WalkStatePayload;
}

export interface WickRoundArchivePayload {
  schema_version: number;
  market_id: Iterable<number> & { length: number };
  round_index: string | bigint;
  round_started_at_ms: string | bigint;
  round_started_at_segment: string | bigint;
  round_duration_segments: string | bigint;
  upper_barrier: string | bigint;
  lower_barrier: string | bigint;
  segments: Iterable<SegmentArchiveEntryPayload> & { length: number };
  walk_state_at_round_start: WalkStatePayload;
  closed_at_ms_for_round: string | bigint;
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface SegmentArchiverOptions {
  /** The shared SegmentMarket<C> id this archiver covers. */
  marketId: string;
  /** Walrus publisher base URL. Default Mysten Labs testnet publisher. */
  walrusEndpoint?: string;
  /** Retention in Walrus epochs (testnet = 1 day each). Default 14. */
  retentionEpochs?: number;
  /** Poll cadence in ms between eligibility scans. Default 5_000. */
  pollIntervalMs?: number;
  /** Cooldown after a failure before re-arming. Default 5_000. */
  errorBackoffMs?: number;
  /** Wick package id — needed to query SegmentRecorded events. */
  packageId: string;
  /** Custom log sink. Default NDJSON to stdout, matching the keeper. */
  log?: (entry: SegmentArchiverLogEntry) => void;
  /** Override fetch (e.g. for tests). Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

export interface SegmentArchiverLogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  action: string;
  market_id?: string;
  round_index?: string;
  blob_id?: string;
  error?: string;
  msg?: string;
  detail?: Record<string, unknown>;
}

/** End-to-end snapshot of the archiver's last decision. Useful for tests
 *  and for the health endpoint. */
export interface SegmentArchiverStatus {
  marketId: string;
  running: boolean;
  lastEligibleRound: bigint | null;
  lastArchivedRound: bigint | null;
  lastBlobId: string | null;
  lastErrorMessage: string | null;
  lastErrorTsMs: number;
  pollCount: number;
  archivesTotal: number;
}

/**
 * The Walrus archiver bot. Watches one SegmentMarket; for every round R that
 * is `>= SETTLEMENT_LAG_ROUNDS` behind the current `cached_round_index`,
 * fetches the round's segment events + RoundStarted event, BCS-encodes the
 * `WickRoundArchive` per doc 24 §3, PUTs the blob to a Walrus publisher,
 * and STUBS the `record_walrus_archive` on-chain call (which doesn't exist
 * yet — v3 Move work is the parallel track). Idempotent: won't re-archive a
 * round it has already archived locally; on chain idempotency arrives with
 * the v3 `ArchiveIndex.entries` table assert.
 *
 * The bot never crashes. Any unhandled error pauses one poll cycle, logs at
 * `warn`, and we resume on the next interval.
 */
export class SegmentArchiver {
  private readonly client: SuiJsonRpcClient;
  // Kept for the v3-ready record_walrus_archive call site (currently stubbed).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private readonly signer: Ed25519Keypair;
  private readonly opts: Required<
    Omit<SegmentArchiverOptions, "log" | "fetch">
  > & {
    log: (e: SegmentArchiverLogEntry) => void;
    fetch: typeof globalThis.fetch;
  };
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  // Local de-dup: rounds we've already archived this process lifetime. The
  // on-chain ArchiveIndex (v3.1) is the durable source of truth; this
  // in-memory set just avoids re-spamming Walrus during the v2-bridge era.
  private readonly archived = new Set<string>();
  private lastEligibleRound: bigint | null = null;
  private lastArchivedRound: bigint | null = null;
  private lastBlobId: string | null = null;
  private lastErrorMessage: string | null = null;
  private lastErrorTsMs = 0;
  private pollCount = 0;
  private archivesTotal = 0;

  constructor(
    client: SuiJsonRpcClient,
    signer: Ed25519Keypair,
    opts: SegmentArchiverOptions,
  ) {
    if (!opts.marketId) throw new Error("segmentArchiver: marketId is required");
    if (!opts.packageId) throw new Error("segmentArchiver: packageId is required");
    this.client = client;
    this.signer = signer;
    this.opts = {
      marketId: opts.marketId,
      packageId: opts.packageId,
      walrusEndpoint:
        opts.walrusEndpoint ?? DEFAULT_WALRUS_PUBLISHER_URL,
      retentionEpochs: opts.retentionEpochs ?? DEFAULT_RETENTION_EPOCHS,
      pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      errorBackoffMs: opts.errorBackoffMs ?? ERROR_BACKOFF_MS,
      log: opts.log ?? defaultLogger,
      fetch: opts.fetch ?? globalThis.fetch.bind(globalThis),
    };
  }

  /** Begin polling. Safe to call repeatedly; subsequent calls are no-ops if
   * a poller is already armed for this market. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.opts.log({
      ts: nowIso(),
      level: "info",
      action: "segment-archiver.start",
      market_id: this.opts.marketId,
      detail: {
        walrus_endpoint: this.opts.walrusEndpoint,
        retention_epochs: this.opts.retentionEpochs,
        poll_interval_ms: this.opts.pollIntervalMs,
        package_id: this.opts.packageId,
      },
    });
    // Run one tick eagerly so a single-shot demo doesn't have to wait the
    // first poll interval. Errors are logged inside the tick — never thrown.
    void this.tickOnce();
    this.timer = setInterval(() => {
      void this.tickOnce();
    }, this.opts.pollIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** Stop polling. In-flight requests aren't cancelled — Sui RPC and Walrus
   * publisher PUTs are short. */
  stop(): void {
    this.running = false;
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.opts.log({
      ts: nowIso(),
      level: "info",
      action: "segment-archiver.stop",
      market_id: this.opts.marketId,
    });
  }

  /** Snapshot for inspection / health. */
  status(): SegmentArchiverStatus {
    return {
      marketId: this.opts.marketId,
      running: this.running,
      lastEligibleRound: this.lastEligibleRound,
      lastArchivedRound: this.lastArchivedRound,
      lastBlobId: this.lastBlobId,
      lastErrorMessage: this.lastErrorMessage,
      lastErrorTsMs: this.lastErrorTsMs,
      pollCount: this.pollCount,
      archivesTotal: this.archivesTotal,
    };
  }

  /** Run one full eligibility scan + archive cycle. Public so tests can
   * drive it deterministically. */
  async tickOnce(): Promise<void> {
    if (!this.running) return;
    this.pollCount += 1;
    try {
      const market = await this.readMarketSnapshot();
      if (market == null) {
        // Market isn't readable — could be a wrong id, race during creation,
        // or RPC blip. Log warn so it's visible without crashing.
        this.recordError(`market ${this.opts.marketId} not found`);
        return;
      }
      const cachedRound = market.cachedRoundIndex;
      const duration = market.roundDurationSegments;
      if (duration <= 0n) {
        this.recordError(`market reports round_duration_segments=${duration}`);
        return;
      }
      // The candidate is the highest round R such that
      //   R + SETTLEMENT_LAG_ROUNDS <= cachedRound
      // i.e. R = cachedRound - SETTLEMENT_LAG_ROUNDS. (Doc 23 §3.2 and doc 24
      // §4. v3.1 also requires unsettled_rides_per_round[R] == 0, but that
      // field is the v3 Move surface — we'll wire it once the module lands.)
      if (cachedRound < SETTLEMENT_LAG_ROUNDS) {
        // Market hasn't accumulated enough rounds to archive any of them yet.
        this.opts.log({
          ts: nowIso(),
          level: "info",
          action: "segment-archiver.no-eligible-round",
          market_id: this.opts.marketId,
          detail: {
            cached_round_index: cachedRound.toString(),
            settlement_lag_rounds: SETTLEMENT_LAG_ROUNDS.toString(),
            reason: "cached_round_index below lag — too early",
          },
        });
        return;
      }
      const candidate = cachedRound - SETTLEMENT_LAG_ROUNDS;
      this.lastEligibleRound = candidate;
      if (this.archived.has(candidate.toString())) {
        // Already archived in this process — nothing to do. (When v3.1's
        // ArchiveIndex lands, switch to reading it from chain instead.)
        return;
      }
      await this.archiveRound(
        candidate,
        duration,
        market.cachedRoundStartedAtSegment,
      );
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      this.recordError(`tick error: ${msg}`);
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async archiveRound(
    roundIndex: bigint,
    durationSegments: bigint,
    currentRoundStartSegment: bigint,
  ): Promise<void> {
    // (a) Fetch the segments for this round. Doc 24 §4 says
    //     segments[N*duration..N*duration+duration]. The round's first
    //     segment index is round_index * duration_segments — this is
    //     consistent with how `cached_round_started_at_segment` is set in
    //     `ensure_round_current` on the Move side.
    const fromK = roundIndex * durationSegments;
    const toK = fromK + durationSegments;
    this.opts.log({
      ts: nowIso(),
      level: "info",
      action: "segment-archiver.archive-begin",
      market_id: this.opts.marketId,
      round_index: roundIndex.toString(),
      detail: {
        from_k: fromK.toString(),
        to_k: toK.toString(),
        current_round_start_segment: currentRoundStartSegment.toString(),
      },
    });

    const segments = await this.fetchSegmentsForRound(fromK, toK);
    if (segments.length === 0) {
      // Empty result means we couldn't find the events. Either the round was
      // pruned already (impossible pre-v3 but possible once segments_v3 ships
      // and another archiver beat us) or events aren't indexed yet. Log
      // warn and try the next poll.
      this.recordError(
        `no SegmentRecorded events found for round ${roundIndex.toString()} (k=${fromK.toString()}..${toK.toString()})`,
      );
      return;
    }

    // (b) RoundStarted event — needed for barrier prices and round-start
    //     timestamp. If we can't find it, fall back to zeros and continue;
    //     the schema lets /verify spot the absence and reject — better than
    //     a permanent gap.
    const roundStarted = await this.fetchRoundStartedEvent(roundIndex);
    const upper = roundStarted?.upperBarrier ?? 0n;
    const lower = roundStarted?.lowerBarrier ?? 0n;
    const roundStartedAtMs = roundStarted?.recordedAtMs ?? 0n;
    const roundStartedAtSegment = roundStarted?.startedAtSegment ?? fromK;
    if (roundStarted == null) {
      this.opts.log({
        ts: nowIso(),
        level: "warn",
        action: "segment-archiver.round-started-missing",
        market_id: this.opts.marketId,
        round_index: roundIndex.toString(),
        msg: "RoundStarted event not found — archiving with zero barriers",
      });
    }

    // (c) Build the WickRoundArchive payload. The first segment's `state_after`
    //     is *one segment after* round start, so we use it as a stand-in for
    //     `walk_state_at_round_start` if a true checkpoint is unavailable.
    //     When v3.1 ships, the Move side will write a per-round checkpoint
    //     directly; until then this is the best deterministic source.
    const walkAtStart =
      segments[0]?.stateAfter ?? zeroWalkState();
    const closedAtMs =
      segments[segments.length - 1]?.recordedAtMs ?? 0n;
    const archive: WickRoundArchivePayload = {
      schema_version: 1,
      market_id: hexToBytes(this.opts.marketId),
      round_index: roundIndex,
      round_started_at_ms: roundStartedAtMs,
      round_started_at_segment: roundStartedAtSegment,
      round_duration_segments: durationSegments,
      upper_barrier: upper,
      lower_barrier: lower,
      segments: segments.map((s) => ({
        k: s.k,
        key: s.key,
        recorded_at_ms: s.recordedAtMs,
        segment_min: s.minPrice,
        segment_max: s.maxPrice,
        state_after: s.stateAfter,
      })),
      walk_state_at_round_start: walkAtStart,
      closed_at_ms_for_round: closedAtMs,
    };

    // (d) BCS serialize.
    const bytes = WickRoundArchiveBCS.serialize(archive).toBytes();
    this.opts.log({
      ts: nowIso(),
      level: "info",
      action: "segment-archiver.serialized",
      market_id: this.opts.marketId,
      round_index: roundIndex.toString(),
      detail: {
        segments_count: segments.length,
        bytes_len: bytes.byteLength,
      },
    });

    // (e) PUT the bytes to the Walrus publisher.
    const blobIdB64 = await this.putWalrusBlob(bytes);
    const blobIdBytes = base64urlDecode(blobIdB64);
    if (blobIdBytes.length !== 32) {
      // Defensive — the Walrus blobId is documented to be 32 bytes. If we
      // get a different length, refuse to call the (future) on-chain
      // record_walrus_archive: the EInvalidBlobId assert in doc 24 §5 would
      // reject it anyway, but we'd rather fail loudly here.
      this.recordError(
        `walrus returned a blobId with ${blobIdBytes.length} bytes, expected 32`,
      );
      return;
    }
    this.lastBlobId = blobIdB64;
    this.opts.log({
      ts: nowIso(),
      level: "info",
      action: "segment-archiver.walrus-stored",
      market_id: this.opts.marketId,
      round_index: roundIndex.toString(),
      blob_id: blobIdB64,
      detail: {
        blob_id_hex: bytesToHex(blobIdBytes),
        bytes_len: bytes.byteLength,
        retention_epochs: this.opts.retentionEpochs,
      },
    });

    // (f) Stub the on-chain `record_walrus_archive` call. Doc 24 §5:
    //
    //   wick::segment_market_v3::record_walrus_archive(
    //     market, round_index, walrus_blob_id
    //   )
    //
    // We log a "WOULD CALL ..." line that captures every arg the future
    // Transaction will pass, so when v3 lands the swap is mechanical.
    this.opts.log({
      ts: nowIso(),
      level: "info",
      action: "segment-archiver.record-walrus-archive-stub",
      market_id: this.opts.marketId,
      round_index: roundIndex.toString(),
      blob_id: blobIdB64,
      msg:
        `WOULD CALL ${this.opts.packageId}::segment_market_v3::record_walrus_archive(` +
        `market=${this.opts.marketId}, round=${roundIndex.toString()}, ` +
        `walrus_blob_id=0x${bytesToHex(blobIdBytes)}) — ` +
        `module not deployed yet; see docs/design/v2/24_walrus_archive_v3.md §5`,
      detail: {
        target: `${this.opts.packageId}::segment_market_v3::record_walrus_archive`,
        args: {
          market_id: this.opts.marketId,
          round_index: roundIndex.toString(),
          walrus_blob_id_hex: bytesToHex(blobIdBytes),
          walrus_blob_id_b64url: blobIdB64,
        },
      },
    });

    // Mark archived locally so we don't re-spam Walrus on the next poll.
    this.archived.add(roundIndex.toString());
    this.lastArchivedRound = roundIndex;
    this.archivesTotal += 1;
  }

  /** Read just the SegmentMarket fields we need. Lighter than the SDK's
   * `fetchSegmentMarket` so this module stays sdk/-free. */
  private async readMarketSnapshot(): Promise<{
    cachedRoundIndex: bigint;
    cachedRoundStartedAtSegment: bigint;
    roundDurationSegments: bigint;
  } | null> {
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
      cachedRoundIndex: asBigInt(f.cached_round_index),
      cachedRoundStartedAtSegment: asBigInt(f.cached_round_started_at_segment),
      roundDurationSegments: asBigInt(f.round_duration_segments),
    };
  }

  /** Pull all SegmentRecorded events for [fromK, toK) on this market and
   * augment each with the dynamic-field-read `state_after` walk checkpoint
   * (the event itself only carries k / key / min / max / ts). */
  private async fetchSegmentsForRound(
    fromK: bigint,
    toK: bigint,
  ): Promise<ArchivedSegment[]> {
    const wanted = new Set<string>();
    for (let k = fromK; k < toK; k = k + 1n) wanted.add(k.toString());

    const found: Map<string, Omit<ArchivedSegment, "stateAfter">> = new Map();
    const eventType = `${this.opts.packageId}::segment_market::SegmentRecorded`;
    let cursor: { txDigest: string; eventSeq: string } | null = null;
    for (let p = 0; p < SEGMENT_EVENT_PAGES_MAX; p++) {
      const page = await this.client.queryEvents({
        query: { MoveEventType: eventType },
        cursor,
        limit: 50,
        order: "descending",
      });
      for (const ev of page.data) {
        const j = (ev.parsedJson ?? {}) as Record<string, unknown>;
        const mid = String(j["market_id"] ?? "");
        if (mid !== this.opts.marketId) continue;
        const kStr = String(j["k"] ?? "");
        if (!wanted.has(kStr)) continue;
        found.set(kStr, {
          k: asBigInt(j["k"]),
          key: parseKeyBytes(j["key"]),
          minPrice: asBigInt(j["min_price"]),
          maxPrice: asBigInt(j["max_price"]),
          recordedAtMs: asBigInt(j["recorded_at_ms"]),
        });
      }
      if (wanted.size === found.size) break;
      if (!page.hasNextPage || !page.nextCursor) break;
      cursor = page.nextCursor as { txDigest: string; eventSeq: string };
    }

    // Augment with state_after read from the on-chain Table. The Table's
    // parent id is the SegmentMarket UID; entries are dynamic fields keyed
    // by u64. If the segments have already been pruned (post-v3), we'll
    // miss state_after — fill zeros and let /verify decide.
    const out: ArchivedSegment[] = [];
    for (const k of [...found.keys()].sort((a, b) =>
      BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0,
    )) {
      const ev = found.get(k)!;
      const stateAfter = await this.readSegmentStateAfter(k);
      out.push({ ...ev, stateAfter });
    }
    return out;
  }

  /** Read SegmentRecord.state_after from chain via the segments Table.
   * Best-effort — pruned entries return a zero WalkState. */
  private async readSegmentStateAfter(kStr: string): Promise<WalkStatePayload> {
    try {
      const res = await this.client.getDynamicFieldObject({
        parentId: this.opts.marketId,
        name: { type: "u64", value: kStr },
      });
      const data = res.data;
      if (!data || data.content?.dataType !== "moveObject") {
        return zeroWalkState();
      }
      const content = data.content as { fields: Record<string, unknown> };
      // Dynamic-field-on-Table wraps the value under `.value.fields`.
      const valueWrapper = (content.fields["value"] as
        | Record<string, unknown>
        | undefined);
      const valueFields = (valueWrapper?.["fields"] as
        | Record<string, unknown>
        | undefined) ?? valueWrapper;
      if (!valueFields) return zeroWalkState();
      const sa = (valueFields["state_after"] as
        | Record<string, unknown>
        | undefined);
      const saFields = (sa?.["fields"] as
        | Record<string, unknown>
        | undefined) ?? sa;
      if (!saFields) return zeroWalkState();
      return walkStateFromFields(saFields);
    } catch {
      return zeroWalkState();
    }
  }

  /** Pull the RoundStarted event for this round. Walks back through the
   * event stream; bounded by SEGMENT_EVENT_PAGES_MAX so a missing event
   * never hangs the loop. */
  private async fetchRoundStartedEvent(
    roundIndex: bigint,
  ): Promise<RoundStartedEventLite | null> {
    const eventType = `${this.opts.packageId}::segment_market::RoundStarted`;
    let cursor: { txDigest: string; eventSeq: string } | null = null;
    for (let p = 0; p < SEGMENT_EVENT_PAGES_MAX; p++) {
      const page = await this.client.queryEvents({
        query: { MoveEventType: eventType },
        cursor,
        limit: 50,
        order: "descending",
      });
      for (const ev of page.data) {
        const j = (ev.parsedJson ?? {}) as Record<string, unknown>;
        const mid = String(j["market_id"] ?? "");
        if (mid !== this.opts.marketId) continue;
        const r = asBigInt(j["round_index"]);
        if (r !== roundIndex) continue;
        // recorded_at_ms isn't in RoundStarted directly — we fall back to
        // the event's timestamp on the envelope (string ms since epoch).
        const tsMs = ev.timestampMs ? BigInt(ev.timestampMs) : 0n;
        return {
          upperBarrier: asBigInt(j["upper_barrier"]),
          lowerBarrier: asBigInt(j["lower_barrier"]),
          startedAtSegment: asBigInt(j["started_at_segment"]),
          recordedAtMs: tsMs,
        };
      }
      if (!page.hasNextPage || !page.nextCursor) break;
      cursor = page.nextCursor as { txDigest: string; eventSeq: string };
    }
    return null;
  }

  /** PUT the BCS bytes to the configured Walrus publisher. Returns the
   * base64url blobId from `newlyCreated.blobObject.blobId` or
   * `alreadyCertified.blobId`. */
  private async putWalrusBlob(bytes: Uint8Array): Promise<string> {
    const url = new URL("/v1/blobs", this.opts.walrusEndpoint);
    url.searchParams.set("epochs", String(this.opts.retentionEpochs));
    const res = await this.opts.fetch(url.toString(), {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `walrus publisher PUT failed: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as WalrusStoreResponse;
    const newlyId = json?.newlyCreated?.blobObject?.blobId;
    if (typeof newlyId === "string" && newlyId.length > 0) return newlyId;
    const alreadyId = json?.alreadyCertified?.blobId;
    if (typeof alreadyId === "string" && alreadyId.length > 0) return alreadyId;
    throw new Error(
      `walrus publisher response missing blobId: ${JSON.stringify(json).slice(0, 200)}`,
    );
  }

  private recordError(message: string): void {
    this.lastErrorMessage = message;
    this.lastErrorTsMs = Date.now();
    this.opts.log({
      ts: nowIso(),
      level: "warn",
      action: "segment-archiver.error",
      market_id: this.opts.marketId,
      error: message,
    });
  }
}

// ── Helper types ────────────────────────────────────────────────────────────

interface ArchivedSegment {
  k: bigint;
  key: Uint8Array;
  recordedAtMs: bigint;
  minPrice: bigint;
  maxPrice: bigint;
  stateAfter: WalkStatePayload;
}

interface RoundStartedEventLite {
  upperBarrier: bigint;
  lowerBarrier: bigint;
  startedAtSegment: bigint;
  /** Filled from event envelope `timestampMs`; the inner payload doesn't
   * carry a `recorded_at_ms` on RoundStarted in the v2 ABI. */
  recordedAtMs: bigint;
}

interface WalrusStoreResponse {
  newlyCreated?: {
    blobObject?: {
      blobId?: string;
    };
  };
  alreadyCertified?: {
    blobId?: string;
  };
}

// ── Pure helpers ────────────────────────────────────────────────────────────

function asBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string" && v.length > 0) return BigInt(v);
  return 0n;
}

function parseKeyBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return new Uint8Array(v as number[]);
  if (typeof v === "string") {
    const hex = v.startsWith("0x") ? v.slice(2) : v;
    if (hex.length === 0) return new Uint8Array();
    if (hex.length % 2 !== 0) return new Uint8Array();
    return hexToBytes(`0x${hex}`);
  }
  return new Uint8Array();
}

export function hexToBytes(hex: string): Uint8Array {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (stripped.length === 0) return new Uint8Array();
  if (stripped.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd-length input "${hex}"`);
  }
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    s += b.toString(16).padStart(2, "0");
  }
  return s;
}

/** RFC 4648 §5 base64url decode (no padding). Walrus uses unpadded
 * base64url for blobIds — 32 bytes encodes to 43 chars. */
export function base64urlDecode(s: string): Uint8Array {
  // Convert base64url -> base64 by swapping URL-safe characters and padding.
  let base64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (base64.length % 4)) % 4;
  base64 += "=".repeat(padLen);
  // Node's Buffer is available — and faster — but to stay portable we use
  // atob, which exists in modern Node and browsers.
  if (typeof atob === "function") {
    const bin = atob(base64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Fallback — should never hit on Node 18+.
  return new Uint8Array(Buffer.from(base64, "base64"));
}

function walkStateFromFields(f: Record<string, unknown>): WalkStatePayload {
  const momentumField = (f["momentum"] as
    | { fields?: Record<string, unknown> }
    | undefined);
  const mom = momentumField?.fields ?? momentumField ?? {};
  return {
    price: asBigInt(f["price"]),
    momentum: {
      neg: Boolean((mom as Record<string, unknown>)["neg"]),
      mag: asBigInt((mom as Record<string, unknown>)["mag"]),
    },
    vol_regime: asBigInt(f["vol_regime"]),
    home: asBigInt(f["home"]),
    pattern_id: Number(f["pattern_id"] ?? 0),
    candles_remaining: Number(f["candles_remaining"] ?? 0),
  };
}

function zeroWalkState(): WalkStatePayload {
  return {
    price: 0n,
    momentum: { neg: false, mag: 0n },
    vol_regime: 0n,
    home: 0n,
    pattern_id: 0,
    candles_remaining: 0,
  };
}

function defaultLogger(entry: SegmentArchiverLogEntry): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
}

function nowIso(): string {
  return new Date().toISOString();
}
