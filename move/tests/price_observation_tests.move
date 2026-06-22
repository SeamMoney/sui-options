// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Direct unit tests for `wick::price_observation` — the value-type every
/// oracle driver emits and every consumer reads. Trivial, but completes direct
/// coverage of the oracle path and locks the load-bearing `price_scaling`
/// constant (1e9) that keeps Wick and DeepBook-Predict prices interoperable.
#[test_only]
module wick::price_observation_tests;

use wick::price_observation as po;

#[test]
fun new_round_trips_fields() {
    let id = object::id_from_address(@0xCAFE);
    let obs = po::new(123_456, 789, id);
    assert!(po::price(&obs) == 123_456, 0);
    assert!(po::timestamp_ms(&obs) == 789, 1);
    assert!(po::source_id(&obs) == id, 2);
}

// Load-bearing invariant: price_scaling MUST equal DeepBook Predict's
// FLOAT_SCALING (1e9) so Wick and Predict prices are interoperable without
// conversion. A silent change here would desync every cross-quoted price.
#[test]
fun price_scaling_is_1e9_for_predict_interop() {
    assert!(po::price_scaling() == 1_000_000_000, 0);
}

#[test]
fun observation_is_copyable() {
    let id = object::id_from_address(@0xBEEF);
    let obs = po::new(42, 7, id);
    let a = obs;
    let b = obs; // PriceObservation has `copy`
    assert!(po::price(&a) == po::price(&b), 0);
    assert!(po::source_id(&a) == po::source_id(&b), 1);
}
