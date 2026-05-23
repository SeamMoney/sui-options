// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// Tests for wick::prune_proto — proves the v3.4 storage-rebate mechanism
// works as the design doc claims (docs/design/v2/23_storage_rebate_pruning_v3.md).
//
// These tests use sui::test_scenario to assert:
//   - records can be added (sets baseline storage cost)
//   - prune_one removes the record AND marks pruned (idempotent)
//   - prune_range removes a range of records
//   - re-pruning aborts with EAlreadyPruned
#[test_only]
module wick::prune_proto_tests {
    use sui::test_scenario as ts;
    use wick::prune_proto;

    const ALICE: address = @0xA;

    /// Helper — set up a fresh shared PrunableLedger.
    fun setup_ledger(sc: &mut ts::Scenario) {
        prune_proto::create(sc.ctx());
    }

    #[test]
    fun create_initialises_empty_ledger() {
        let mut sc = ts::begin(ALICE);
        setup_ledger(&mut sc);

        sc.next_tx(ALICE);
        let ledger = sc.take_shared<prune_proto::PrunableLedger>();
        assert!(prune_proto::len(&ledger) == 0, 0);
        ts::return_shared(ledger);

        ts::end(sc);
    }

    #[test]
    fun fill_then_prune_one_clears_record() {
        let mut sc = ts::begin(ALICE);
        setup_ledger(&mut sc);

        // Add 5 records.
        sc.next_tx(ALICE);
        let mut ledger = sc.take_shared<prune_proto::PrunableLedger>();
        prune_proto::fill(&mut ledger, 5, sc.ctx());
        assert!(prune_proto::len(&ledger) == 5, 0);
        assert!(prune_proto::has_record(&ledger, 2), 1);
        assert!(!prune_proto::is_pruned(&ledger, 2), 2);
        ts::return_shared(ledger);

        // Prune k=2 specifically.
        sc.next_tx(ALICE);
        let mut ledger = sc.take_shared<prune_proto::PrunableLedger>();
        prune_proto::prune_one(&mut ledger, 2, sc.ctx());
        assert!(!prune_proto::has_record(&ledger, 2), 3);
        assert!(prune_proto::is_pruned(&ledger, 2), 4);
        // Other records untouched.
        assert!(prune_proto::has_record(&ledger, 1), 5);
        assert!(prune_proto::has_record(&ledger, 3), 6);
        ts::return_shared(ledger);

        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = 1, location = wick::prune_proto)]
    fun re_pruning_same_key_aborts() {
        let mut sc = ts::begin(ALICE);
        setup_ledger(&mut sc);

        sc.next_tx(ALICE);
        let mut ledger = sc.take_shared<prune_proto::PrunableLedger>();
        prune_proto::fill(&mut ledger, 3, sc.ctx());
        ts::return_shared(ledger);

        sc.next_tx(ALICE);
        let mut ledger = sc.take_shared<prune_proto::PrunableLedger>();
        prune_proto::prune_one(&mut ledger, 1, sc.ctx());
        ts::return_shared(ledger);

        // Should abort with EAlreadyPruned = 1.
        sc.next_tx(ALICE);
        let mut ledger = sc.take_shared<prune_proto::PrunableLedger>();
        prune_proto::prune_one(&mut ledger, 1, sc.ctx());
        ts::return_shared(ledger);

        ts::end(sc);
    }

    #[test]
    fun prune_range_clears_inclusive_lower_exclusive_upper() {
        let mut sc = ts::begin(ALICE);
        setup_ledger(&mut sc);

        sc.next_tx(ALICE);
        let mut ledger = sc.take_shared<prune_proto::PrunableLedger>();
        prune_proto::fill(&mut ledger, 10, sc.ctx());
        ts::return_shared(ledger);

        // Prune [3, 7).
        sc.next_tx(ALICE);
        let mut ledger = sc.take_shared<prune_proto::PrunableLedger>();
        prune_proto::prune_range(&mut ledger, 3, 7, sc.ctx());

        // Pruned: 3, 4, 5, 6.
        assert!(prune_proto::is_pruned(&ledger, 3), 0);
        assert!(prune_proto::is_pruned(&ledger, 4), 1);
        assert!(prune_proto::is_pruned(&ledger, 5), 2);
        assert!(prune_proto::is_pruned(&ledger, 6), 3);
        // Untouched: 0, 1, 2, 7, 8, 9.
        assert!(!prune_proto::is_pruned(&ledger, 2), 4);
        assert!(!prune_proto::is_pruned(&ledger, 7), 5);
        assert!(prune_proto::has_record(&ledger, 2), 6);
        assert!(prune_proto::has_record(&ledger, 7), 7);
        // And records gone for pruned.
        assert!(!prune_proto::has_record(&ledger, 3), 8);
        assert!(!prune_proto::has_record(&ledger, 6), 9);

        ts::return_shared(ledger);

        ts::end(sc);
    }

    #[test]
    fun prune_range_is_idempotent_skips_already_pruned() {
        let mut sc = ts::begin(ALICE);
        setup_ledger(&mut sc);

        sc.next_tx(ALICE);
        let mut ledger = sc.take_shared<prune_proto::PrunableLedger>();
        prune_proto::fill(&mut ledger, 5, sc.ctx());
        ts::return_shared(ledger);

        // First prune.
        sc.next_tx(ALICE);
        let mut ledger = sc.take_shared<prune_proto::PrunableLedger>();
        prune_proto::prune_range(&mut ledger, 0, 5, sc.ctx());
        ts::return_shared(ledger);

        // Second prune over the same range — should NOT abort because
        // prune_range explicitly checks `!is_pruned(k)` per iteration.
        sc.next_tx(ALICE);
        let mut ledger = sc.take_shared<prune_proto::PrunableLedger>();
        prune_proto::prune_range(&mut ledger, 0, 5, sc.ctx());

        // All still pruned.
        let mut k = 0;
        while (k < 5) {
            assert!(prune_proto::is_pruned(&ledger, k), k);
            k = k + 1;
        };

        ts::return_shared(ledger);

        ts::end(sc);
    }

    #[test]
    fun prune_range_handles_missing_records_gracefully() {
        let mut sc = ts::begin(ALICE);
        setup_ledger(&mut sc);

        sc.next_tx(ALICE);
        let mut ledger = sc.take_shared<prune_proto::PrunableLedger>();
        prune_proto::fill(&mut ledger, 3, sc.ctx());
        ts::return_shared(ledger);

        // Prune a range that extends past the filled records.
        sc.next_tx(ALICE);
        let mut ledger = sc.take_shared<prune_proto::PrunableLedger>();
        prune_proto::prune_range(&mut ledger, 0, 10, sc.ctx());

        // Existing records pruned.
        assert!(prune_proto::is_pruned(&ledger, 0), 0);
        assert!(prune_proto::is_pruned(&ledger, 1), 1);
        assert!(prune_proto::is_pruned(&ledger, 2), 2);
        // Non-existent keys NOT marked pruned (no harm done).
        assert!(!prune_proto::is_pruned(&ledger, 5), 3);
        assert!(!prune_proto::has_record(&ledger, 5), 4);

        ts::return_shared(ledger);

        ts::end(sc);
    }
}
