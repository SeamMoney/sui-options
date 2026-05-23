# 24 — Walrus Archive (v3)

**Status:** v3 architecture spec — pairs with [22 sponsored cranking](22_sponsored_cranking_v3.md) and [23 storage rebate pruning](23_storage_rebate_pruning_v3.md).
**Author:** Claude Opus 4.7 + Max Mohammadi, 2026-05-23.

---

## 1. The problem

Once [23](23_storage_rebate_pruning_v3.md) is live, segment data leaves on-chain Move storage 3 rounds after the round settles. Where does `/verify` read those segments from when verifying an old ride?

Two existing answers, both imperfect:

| Source | Pros | Cons |
|---|---|---|
| **Sui events** (`SegmentRecorded`) | Free, on chain, durable | Indexer-dependent. Most full nodes prune events after ~30 days; only archival nodes keep them. Centralization risk if archival nodes coordinate to drop. No SLA. |
| **Indexer service** (custom, e.g. our `keeper/`) | Controllable retention | Operator-dependent. If we stop running it, history dies. Defeats the "permanent fair archive" claim. |

We need **a third source that is decentralized, permanent, and cheap**. That's Walrus.

## 2. Walrus primer (what it is)

Walrus is Sui's decentralized blob storage protocol, launched early 2026. Properties:

- **Erasure-coded** across N storage nodes (Reed-Solomon-like). Survives node loss up to a threshold.
- **On-chain blob references** — a `Blob` object on Sui points to a Walrus blob ID.
- **Cheap** — pricing is per-byte-per-epoch (configurable retention from a few days to perpetual).
- **Permissionless reads** — anyone can fetch a blob from any storage node.
- **Cryptographic integrity** — blob ID is a hash; tampering is detectable.

For Wick: a few KB per round, written once at round-end, kept perpetually. Storage cost per round ≈ low single-digit MIST equivalent. Reads are HTTP GETs from any Walrus node.

## 3. The archive format

Per round, one blob with the schema:

```
WickRoundArchive {
  schema_version: u8,          // 1
  market_id: vector<u8>,       // 32-byte object ID
  round_index: u64,
  round_started_at_ms: u64,
  round_started_at_segment: u64,
  round_duration_segments: u64,
  upper_barrier: u64,
  lower_barrier: u64,
  segments: vector<SegmentArchiveEntry>,
  walk_state_at_round_start: WalkState,   // for replay seed
  closed_at_ms_for_round: u64,
}

SegmentArchiveEntry {
  k: u64,                       // segment index (round_start + i)
  key: vector<u8>,              // 32-byte randomness key
  recorded_at_ms: u64,
  segment_min: u64,             // for fast extrema lookup
  segment_max: u64,
  state_after: WalkState,       // for partial-round /verify
}
```

Serialized via BCS. A round=20 archive is ~3 KB. A round=75 archive is ~12 KB. Both trivially small.

## 4. The flow

```
─ during round N ──────────────────────────────────────────────────────────
  keeper / D4 / sponsor cranks record_segment 20× → events emitted
                                                  → table::add to segments

─ at round N end (~8s later) ──────────────────────────────────────────────
  any user opens a new ride in round N+1 — triggers ensure_round_current
                                          → cached_round_index = N+1

─ round N+1 settles ───────────────────────────────────────────────────────
  all rides in round N close → unsettled_rides_per_round[N] = 0

─ ~24s after round N end (SETTLEMENT_LAG_ROUNDS = 3 rounds × 8s) ──────────
  permissionless archiver bot runs:

    1. Reads segments[N×20..N×20+20] from on-chain
    2. Reads RoundStarted event for round N (barrier prices, segment index)
    3. Constructs WickRoundArchive { ... }
    4. Serializes via BCS
    5. Calls walrus::write_blob(archive_bytes, RETENTION_EPOCHS)
       → receives walrus_blob_id (32 bytes)
    6. Calls wick::segment_market_v3::record_walrus_archive(
         market, N, walrus_blob_id
       )  → emits RoundArchived event + stores blob_id in a small archive_index Table
    7. Calls wick::segment_market_v3::prune_settled_segments(market, N)
       → deletes segments[N×20..N×20+20] from on-chain
       → receives ~80M MIST storage rebate
       → net profit after Walrus write fee + gas: ~70M MIST per round
```

## 5. Move-side surface

```move
module wick::segment_market_v3 {
    /// Mapping from round_index → Walrus blob ID for that round's archive.
    /// Written by archiver bots; read by /verify and explorers.
    public struct ArchiveIndex has store {
        entries: Table<u64, vector<u8>>,  // round_index → walrus_blob_id (32B)
    }

    /// Permissionless. Records the Walrus blob ID for a round's archive
    /// after the archiver bot has uploaded it. Must be called BEFORE
    /// prune_settled_segments for that round (so the on-chain index is
    /// always populated when on-chain segments are deleted).
    public entry fun record_walrus_archive<C>(
        market: &mut SegmentMarketV3<C>,
        round_index: u64,
        walrus_blob_id: vector<u8>,
        ctx: &mut TxContext,
    ) {
        assert!(vector::length(&walrus_blob_id) == 32, EInvalidBlobId);
        assert!(
            !table::contains(&market.archive_index.entries, round_index),
            EArchiveAlreadyRecorded,
        );

        table::add(&mut market.archive_index.entries, round_index, walrus_blob_id);

        sui::event::emit(RoundArchived {
            market_id: object::id(market),
            round_index,
            walrus_blob_id,
            archiver: ctx.sender(),
        });
    }
}
```

## 6. `/verify` flow with the archive

```typescript
// scripts/verify.ts (v3 update)
async function getSegmentsForRound(market: SegmentMarketV3, round: number) {
  // 1. Try on-chain (hot path — last 4 rounds)
  if (round + SETTLEMENT_LAG_ROUNDS >= market.cached_round_index) {
    return readFromTable(market, round);
  }

  // 2. Fall back to Walrus archive
  const blobId = await readArchiveIndex(market, round);
  if (!blobId) {
    throw new Error(`No Walrus archive for round ${round}`);
  }
  const archiveBytes = await fetchWalrusBlob(blobId);
  const archive = bcs.deserialize(archiveBytes, WickRoundArchive);
  return archive.segments;
}
```

The "no archive" case happens only if the archiver bot didn't run — in which case `prune_settled_segments` (per [23](23_storage_rebate_pruning_v3.md)) wouldn't have completed either (because the archive index entry is a precondition for pruning in v3.1+ — see §8 below). So in steady state, archive is always present.

## 7. Per-round cost math (the full v3 picture)

Combining [22] (sponsored) + [23] (prune) + [24] (Walrus):

| Component | Cost | Direction |
|---|---|---|
| 20× `record_segment` (sponsored) | ~120M MIST | from sponsor wallet |
| `record_walrus_archive` | ~5M MIST | from archiver wallet |
| Walrus write fee (12 KB, 1-year retention) | ~50K MIST equivalent | from archiver wallet |
| `prune_settled_segments` | ~5M MIST gas | from archiver wallet |
| Storage rebate on prune (20 × 4M × 99%) | ~79M MIST | TO archiver wallet |
| Settle + close (sponsored) | ~10M MIST | from sponsor wallet |
| **Sponsor net per round** | **130M MIST** | (cranking + settle) |
| **Archiver net per round** | **+69M MIST profit** | (rebate - all fees) |

Sponsor cost: 130M MIST × 10,800 rounds/day = **~1,400 SUI/day**. Funded from protocol fees per [22](22_sponsored_cranking_v3.md).

Archiver: positive-EV. Will be run by whoever wants the profit. No protocol action required.

(For comparison, v2 was ~110M MIST per round, ALL of which the protocol or user paid, AND it was permanent storage. v3 is similar magnitude per round but trades permanent on-chain growth for a permanent decentralized Walrus archive, plus shifts user cost to zero via sponsorship.)

## 8. Ordering invariant: archive before prune

A safety property: `prune_settled_segments` must not run for round N unless `record_walrus_archive(N)` has already landed.

In v3.0 we enforce this in the archiver bot only (it runs `record_walrus_archive` first, `prune_settled_segments` second, as one PTB or two sequential txs).

In v3.1 we lift it into Move:

```move
public entry fun prune_settled_segments<C>(market, round_index, ctx) {
    // ... existing asserts ...

    // V3.1: enforce archive-before-prune.
    assert!(
        table::contains(&market.archive_index.entries, round_index),
        ENoWalrusArchive,
    );
    // ... proceed with delete ...
}
```

This makes data loss impossible. The trade-off: if Walrus is down when the archiver runs, no pruning happens that day — storage piles up temporarily. Acceptable for a brief Walrus outage; if Walrus is permanently dead the entire archive strategy needs revisiting anyway.

## 9. Retention policy

Walrus blobs are paid-per-epoch. Pick retention:

| Retention | Per-archive cost | Justification |
|---|---|---|
| 1 epoch (~1 day) | ~5K MIST eq | Bad — archive disappears tomorrow |
| 30 days | ~150K MIST eq | OK for testnet experiments |
| **1 year** | **~2M MIST eq** | **v3.0 default — covers any reasonable verify horizon** |
| Perpetual (max) | ~50M MIST eq | Mainnet eventual goal once economics justify |

The blob ID stays in the on-chain `ArchiveIndex` forever; only the actual blob expires. If we extend retention later, the same blob ID rehydrates (we just re-pay storage fee).

## 10. Open questions

- **Walrus availability.** Mainnet readiness on Walrus side. We should run a Walrus testnet integration test before committing v3 to mainnet.
- **Schema versioning.** `schema_version: u8` in the archive lets us migrate. v2 schemas would need a translator in `/verify`.
- **Blob ID storage as `vector<u8>` vs typed.** v3.0 keeps it as raw `vector<u8>` for forward compatibility. v3.1 may upgrade to a typed `WalrusBlobRef` struct if Walrus emits one.
- **Archive index growth.** `archive_index: Table<u64, vector<u8>>` is ~40 bytes per round × 365 × 5 years = 73 KB total — negligible. Lives forever.

## 11. References

- Walrus docs: https://docs.walrus.site/
- Sui storage rebate model: https://docs.sui.io/concepts/tokenomics/gas-in-sui#storage-rebate
- BCS serialization: https://docs.sui.io/standard-library/sui/bcs
- Companion: [`22_sponsored_cranking_v3.md`](22_sponsored_cranking_v3.md) — pays for the cranking that produces these archives
- Companion: [`23_storage_rebate_pruning_v3.md`](23_storage_rebate_pruning_v3.md) — the pruning step that this doc's archive guards
