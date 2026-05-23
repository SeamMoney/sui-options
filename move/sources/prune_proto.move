// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// PROTOTYPE for v3.4 (docs/design/v2/23_storage_rebate_pruning_v3.md).
//
// Demonstrates the storage-rebate mechanism in isolation so the v3 design
// can be validated empirically before the full segment_market_v3.move is
// written. This module is NOT used by the production segment_market — it
// is a self-contained proof-of-concept that:
//
//   1. Builds a tiny shared object (`PrunableLedger`) with a `Table<u64, BigRecord>`.
//   2. Fills the Table with N BigRecord entries (each carries ~1KB of payload
//      to make the storage cost measurable).
//   3. Exposes `prune_one(ledger, k)` — a permissionless entry that removes
//      the entry at key k. The Sui runtime auto-credits the storage rebate
//      to ctx.sender().
//   4. Tests confirm the prune logic, idempotency, and range pruning work
//      as the design doc claims.
//
// When v3.4 implementation lands as part of segment_market_v3.move, it
// follows this exact pattern: `prune_settled_segments` removes a round's
// worth of SegmentRecord entries, and the caller pockets the rebate.
//
// Design doc: docs/design/v2/23_storage_rebate_pruning_v3.md
module wick::prune_proto {
    use sui::table::{Self, Table};

    // === Errors ===
    const EAlreadyPruned: u64 = 1;

    // === Types ===

    /// A record big enough that storage cost is measurable per prune.
    /// Mirrors the shape of SegmentRecord in segment_market.move (key +
    /// state checkpoint + extrema + timestamp).
    public struct BigRecord has store, copy, drop {
        key: vector<u8>,             // 32 bytes
        payload: vector<u8>,         // ~100 bytes of synthetic data
        recorded_at_ms: u64,
        min_price: u64,
        max_price: u64,
    }

    /// A standalone shared object holding a prunable Table. Independent
    /// of SegmentMarket so this prototype doesn't perturb production code.
    public struct PrunableLedger has key {
        id: UID,
        records: Table<u64, BigRecord>,
        pruned: Table<u64, bool>,
        next_k: u64,
    }

    // === Constructors ===

    /// Permissionless. Creates a shared PrunableLedger. Real v3 has its
    /// equivalent state inside SegmentMarketV3 created via bootstrap.
    public entry fun create(ctx: &mut TxContext) {
        let ledger = PrunableLedger {
            id: object::new(ctx),
            records: table::new(ctx),
            pruned: table::new(ctx),
            next_k: 0,
        };
        sui::transfer::share_object(ledger);
    }

    /// Permissionless. Add `count` synthetic records to the ledger. The
    /// cost of this call is the storage cost we want to be able to reclaim.
    public entry fun fill(
        ledger: &mut PrunableLedger,
        count: u64,
        _ctx: &mut TxContext,
    ) {
        let mut i = 0;
        while (i < count) {
            let k = ledger.next_k + i;
            let record = BigRecord {
                key: synthetic_key(k),
                payload: synthetic_payload(k),
                recorded_at_ms: 1000 + k * 400,
                min_price: 100_000_000 + k * 100,
                max_price: 200_000_000 + k * 100,
            };
            table::add(&mut ledger.records, k, record);
            i = i + 1;
        };
        ledger.next_k = ledger.next_k + count;
    }

    /// Permissionless. Removes the record at key k. Sui auto-credits the
    /// storage rebate to ctx.sender(). Idempotent — re-pruning aborts.
    ///
    /// This is the load-bearing function for v3.4 — when production
    /// segment_market_v3 ships, `prune_settled_segments` does exactly
    /// this in a loop over a round's segment range.
    public entry fun prune_one(
        ledger: &mut PrunableLedger,
        k: u64,
        _ctx: &mut TxContext,
    ) {
        assert!(!table::contains(&ledger.pruned, k), EAlreadyPruned);

        if (table::contains(&ledger.records, k)) {
            let _record = table::remove(&mut ledger.records, k);
            // Sui auto-handles the BigRecord drop and credits the storage
            // rebate to the tx's gas object (which is ctx.sender()'s coin).
        };

        table::add(&mut ledger.pruned, k, true);
    }

    /// Permissionless. Removes records[from..to). Loop variant — proves
    /// that batched pruning aggregates the rebate, which is the v3.4
    /// economic mechanism. Each iteration's rebate flows to the same gas
    /// coin (ctx.sender()'s), so the caller's balance net-rises by
    /// approximately (deleted_count × per_record_rebate) - (loop_gas_cost).
    public entry fun prune_range(
        ledger: &mut PrunableLedger,
        from: u64,
        to: u64,
        _ctx: &mut TxContext,
    ) {
        let mut k = from;
        while (k < to) {
            if (
                table::contains(&ledger.records, k)
                    && !table::contains(&ledger.pruned, k)
            ) {
                let _record = table::remove(&mut ledger.records, k);
                table::add(&mut ledger.pruned, k, true);
            };
            k = k + 1;
        };
    }

    // === Read accessors ===

    public fun len(ledger: &PrunableLedger): u64 {
        ledger.next_k
    }

    public fun is_pruned(ledger: &PrunableLedger, k: u64): bool {
        table::contains(&ledger.pruned, k)
    }

    public fun has_record(ledger: &PrunableLedger, k: u64): bool {
        table::contains(&ledger.records, k)
    }

    // === Internals ===

    /// Synthetic 32-byte key derived from k (deterministic, no randomness
    /// dependency — this is a prototype, not production).
    fun synthetic_key(k: u64): vector<u8> {
        let mut bytes = vector::empty<u8>();
        let mut i = 0;
        while (i < 32) {
            vector::push_back(&mut bytes, ((k + i) % 256 as u8));
            i = i + 1;
        };
        bytes
    }

    /// Synthetic 100-byte payload — large enough to make per-record
    /// storage cost > 1M MIST so the rebate is empirically observable.
    fun synthetic_payload(k: u64): vector<u8> {
        let mut bytes = vector::empty<u8>();
        let mut i = 0;
        while (i < 100) {
            vector::push_back(&mut bytes, ((k * 7 + i * 3) % 256 as u8));
            i = i + 1;
        };
        bytes
    }
}
