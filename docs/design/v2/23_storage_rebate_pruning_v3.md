# 23 — Storage Rebate Pruning (v3)

**Status:** v3 architecture spec — pairs with [22 sponsored cranking](22_sponsored_cranking_v3.md) and [24 Walrus archive](24_walrus_archive_v3.md).
**Author:** Claude Opus 4.7 + Max Mohammadi, 2026-05-23.

---

## 1. The problem

`SegmentMarket.segments: Table<u64, SegmentRecord>` grows **unbounded**. Every `record_segment` call writes ~140 bytes (key + walk-state-after + extrema + timestamp + record overhead) to Move on-chain storage at ~30K MIST/byte ≈ **4M MIST per segment**, **forever**.

The smoke market (round=20) cranks 20 × 4M = 80M MIST in storage per round. At 1 round / 8 seconds = 10,800 rounds/day → **864 GB MIST = 864 SUI/day in storage write cost alone** that the protocol pays and never reclaims. At any mainnet scale, this is the dominant cost. Worse, it's **unbounded** — storage grows linearly forever.

## 2. The fix — use Sui's storage rebate

Sui's storage model is **write + rebate-on-delete**:

```
Action                  | Cost direction | Magnitude
write 1 byte to Move    | +              | ~30K MIST
delete that byte later  | -              | ~29.7K MIST (≈ 99%)
NET cost of temp storage|                | ~1% of upfront
```

The rebate is paid to `ctx.sender()` of the tx that performs the delete. **Anyone** can call a permissionless `delete` Move function and receive the rebate.

Applied to Wick: once a round is fully settled (all rides closed, no future ride can refer to those segments), the round's SegmentRecord entries are dead state. Delete them. Reclaim 99% of the storage cost.

Per-segment net cost drops from 4M to ~40K MIST. **100× cheaper.**

## 3. Mechanism — `prune_settled_segments`

### 3.1 SETTLEMENT_LAG_ROUNDS

A safety constant. We don't prune the most-recently-settled round; we wait `SETTLEMENT_LAG_ROUNDS` more rounds before pruning to absorb:
- Late-arriving abort calls (`abort_segment_ride` past the deadline)
- Any reconciliation reads from explorers / users
- Race conditions where a settle tx is in-flight but not yet committed when prune is called

```move
const SETTLEMENT_LAG_ROUNDS: u64 = 3;  // wait 3 rounds (24 s) before pruning
```

Adjustable via `RiskAdminCap` if needed (e.g. raise to 100 for a more conservative mainnet posture).

### 3.2 Move function

```move
module wick::segment_market_v3 {
    /// Permissionless. Deletes all SegmentRecord entries for the given round
    /// once it's been fully settled for SETTLEMENT_LAG_ROUNDS rounds. The
    /// caller receives the storage rebate (paid to ctx.sender()), which
    /// exceeds the gas cost of running this call → positive EV → permissionless
    /// pruner bots are a natural equilibrium with no operator action required.
    public entry fun prune_settled_segments<C>(
        market: &mut SegmentMarketV3<C>,
        round_index: u64,
        ctx: &mut TxContext,
    ) {
        // 1. Round must be old enough.
        assert!(
            round_index + SETTLEMENT_LAG_ROUNDS <= market.cached_round_index,
            ETooSoonToPrune,
        );

        // 2. All rides in that round must be closed (no open settlements).
        let unsettled = *table::borrow_with_default(
            &market.unsettled_rides_per_round, round_index, &0u64,
        );
        assert!(unsettled == 0, EUnsettledRidesRemain);

        // 3. Not already pruned (idempotency).
        assert!(
            !table::contains(&market.pruned_rounds, round_index),
            EAlreadyPruned,
        );

        // 4. Compute segment range for the round.
        let from = round_index * market.round_duration_segments;
        let to = from + market.round_duration_segments;

        // 5. Delete each SegmentRecord — Sui auto-rebates storage to ctx.sender().
        let mut k = from;
        let mut deleted_count = 0;
        while (k < to) {
            if (table::contains(&market.segments, k)) {
                let _record = table::remove(&mut market.segments, k);
                // Note: SegmentRecord has `drop` ability — Sui auto-handles
                // the storage release on out-of-scope.
                deleted_count = deleted_count + 1;
            };
            k = k + 1;
        };

        // 6. Mark round as pruned so re-prune attempts fail idempotently.
        table::add(&mut market.pruned_rounds, round_index, true);

        // 7. Emit event for indexers and pruner bots.
        sui::event::emit(SegmentsPruned {
            market_id: object::id(market),
            round_index,
            deleted_count,
            pruner: ctx.sender(),
        });
    }
}
```

### 3.3 Positive-EV economics for pruners

For the pruner (anyone running the bot):

| Action | MIST in | MIST out |
|---|---|---|
| Pay gas to call `prune_settled_segments` (single tx) | — | ~5M |
| Receive storage rebate for 20 deleted SegmentRecords | ~79M | — |
| **Net to pruner per call** | | **+74M MIST** |

A pruner bot wallet earns ~74M MIST per round it prunes. At 10,800 rounds/day, **800 SUI/day of profit** is available to whoever runs the pruner. We expect ops to run it for free as a service; if not, third-party MEV-style searchers will. The mechanism is self-incentivizing — there is no operator action required for storage to stay bounded.

## 4. Hot vs cold state — what stays on Move

After pruning, what's left on-chain per market:

```
SegmentMarketV3<C>:
  - id, vault_id, walk (current state)
  - cached_round_index, cached_upper_barrier, cached_lower_barrier
  - exposure caps + locks + counters
  - segments: Table<u64, SegmentRecord>
      - ONLY the last (SETTLEMENT_LAG_ROUNDS + 1) rounds' segments
      - bounded size: 4 rounds × 20 segments = 80 entries max
  - pruned_rounds: Table<u64, bool>
      - 8-byte entry per pruned round → grows linearly with time
      - this IS unbounded but at 8 bytes × 10,800/day × 365 = ~30 MB/year
        = ~900K MIST/year — negligible
```

The `pruned_rounds` table is the only unbounded growth, but it's ~3 orders of magnitude smaller than the per-segment storage we'd otherwise have. Acceptable. (Could be replaced with a u64 `next_unpruned_round_index` counter if we ever care about that — pruning is monotonic.)

## 5. What about `/verify` for old rounds?

This is the key question. If we delete the SegmentRecord, can someone still verify an old ride that closed last week?

**Yes** — via the event log and (per [24](24_walrus_archive_v3.md)) the Walrus archive.

The verify flow becomes:
1. Look at `RideClosed` event → get ride params (entry segment, closed_at_ms, market_id)
2. Look at `SegmentRecorded` events between entry and close → get the segment keys
3. Replay `expand_segment` locally from segment 0 to compute the walk state at entry
4. Replay through the ride's segments to compute extrema
5. Compare to `RideClosed.settlement_kind`

Step 2 depends on event availability. Sui's archival nodes keep events for ~years, but they're indexer-dependent. For the **decentralized + permanent archive**, see [24](24_walrus_archive_v3.md) — a Walrus blob is written per round capturing the keys, so `/verify` works even if every indexer goes dark.

## 6. Cost math

Per round on a SegmentMarketV3 with sponsored cranking (per [22](22_sponsored_cranking_v3.md)):

| Component | v2 (today) | v3 (sponsored + prune) |
|---|---|---|
| Per-segment write storage | 4M MIST × 20 = 80M | 4M × 20 - 3.96M × 20 ≈ 800K |
| Per-segment computation | 1M × 20 = 20M | 1M × 20 = 20M |
| `prune_settled_segments` call (per round) | 0 (not pruned) | 5M (paid by pruner, refunded via rebate) |
| Settle + close | 10M | 10M |
| **Net per round (protocol cost)** | **110M** | **30.8M** |
| **Per day** | **1188 SUI** | **333 SUI** |
| **Per year** | **434k SUI** | **121k SUI** |

**3.6× cheaper than v2.** Combined with sponsored cranking, user-side cost is $0 and protocol cost is sustainable.

(Note: actual rebate is ~99% of write, so the "800K MIST per round" line above is 20 × ~40K = 800K. The 100× per-segment savings flows through.)

## 7. Implementation steps

1. Add `pruned_rounds: Table<u64, bool>` field to `SegmentMarketV3` struct
2. Add `unsettled_rides_per_round: Table<u64, u64>` field — bumped on `open_segment_ride`, decremented on `close_segment_ride` / `crank_expired_segment_ride` / `abort_segment_ride`
3. Define `SETTLEMENT_LAG_ROUNDS` constant in `risk_config` (admin-tunable)
4. Implement `prune_settled_segments` entry function with the asserts above
5. Add `SegmentsPruned` event for indexer pickup
6. Write tests:
   - `prune_settled_segments_succeeds_after_lag` ← happy path
   - `prune_settled_segments_aborts_when_too_soon` ← `ETooSoonToPrune`
   - `prune_settled_segments_aborts_with_unsettled_rides` ← `EUnsettledRidesRemain`
   - `prune_settled_segments_is_idempotent` ← `EAlreadyPruned`
   - `prune_settled_segments_emits_rebate` ← check `ctx.sender()` balance delta is positive
7. Write a tiny pruner bot in `keeper/src/segmentPruner.ts` — polls for prune-eligible rounds, fires the tx, takes the rebate

## 8. Open questions

- **What if SETTLEMENT_LAG_ROUNDS is too short and someone with an in-flight settlement loses?** Mitigation: the assert checks `unsettled_rides_per_round[round] == 0`, so it's not just lag — it's lag AND zero unsettled. If a ride is still unsettled after lag rounds, the assert fails and the prune is rejected.
- **What if a malicious user keeps opening ride-and-never-close to block pruning?** `abort_segment_ride` exists for exactly this — past `ABORT_SEGMENT_DEADLINE_MS`, anyone can permissionlessly abort the stuck ride and refund 1:1.
- **Does pruning break `/verify` for rides that close just before their round is pruned?** No — `/verify` reads events, not the Table. As long as the events exist (which they do permanently on Sui's archival nodes + the Walrus archive per [24](24_walrus_archive_v3.md)), pruning is transparent to `/verify`.

## 9. References

- Sui storage model + rebates: https://docs.sui.io/concepts/tokenomics/gas-in-sui#storage-rebate
- `table::remove` rebate semantics: confirmed via empirical test in Sui devnet 2026-05
- Companion: [`22_sponsored_cranking_v3.md`](22_sponsored_cranking_v3.md) — pruning makes the sponsor budget go ~3.6× further
- Companion: [`24_walrus_archive_v3.md`](24_walrus_archive_v3.md) — what to do with the segments before deleting them
