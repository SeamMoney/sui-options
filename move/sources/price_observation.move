// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Single value-type that every Wick oracle driver produces. Wick consumers
/// (PathObservation, settlement) only ever read this — they don't know which
/// driver produced it. New oracle source = new driver module + return one of
/// these.
module wick::price_observation;

/// Price scaling — 1e9, matches DeepBook Predict's FLOAT_SCALING so Wick and
/// Predict prices are interoperable without conversion.
const PRICE_SCALING: u64 = 1_000_000_000;

public struct PriceObservation has copy, drop, store {
    price: u64,
    timestamp_ms: u64,
    source_id: ID,
}

public fun new(price: u64, timestamp_ms: u64, source_id: ID): PriceObservation {
    PriceObservation { price, timestamp_ms, source_id }
}

public fun price(obs: &PriceObservation): u64 { obs.price }

public fun timestamp_ms(obs: &PriceObservation): u64 { obs.timestamp_ms }

public fun source_id(obs: &PriceObservation): ID { obs.source_id }

public fun price_scaling(): u64 { PRICE_SCALING }
