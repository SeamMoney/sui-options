// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Driver: keeper-pushed price feed. A `KeeperCap` holder pushes
/// `(price, timestamp_ms, attestation)` into the WickOracle. The keeper does
/// upstream verification (Pyth Lazer signed-update parsing, Switchboard
/// aggregator reads, anything) off-chain. On-chain trust scope is one cap.
///
/// This is the load-bearing driver for SUI (Lazer feed 11) and SP500 (Lazer
/// feed 3145) today. The future stricter driver `lazer_verifier_driver`
/// will replace `KeeperCap` trust with on-chain secp256k1 verification of
/// Lazer signed updates — same WickOracle interface, no other code changes.
///
/// Honesty contract: the `attestation` field is recorded in events so anyone
/// can independently verify the keeper pushed the same payload Pyth Lazer
/// signed for that timestamp. Bad keepers are observable.
module wick::pull_oracle_driver;

use std::string::String;
use sui::bcs;
use sui::clock::Clock;
use wick::price_observation;
use wick::wick_oracle::{Self, WickOracle};

const ENotPullDriver: u64 = 0;
const EConfigOracleMismatch: u64 = 1;
const ENonMonotonicTimestamp: u64 = 2;
const EFutureTimestamp: u64 = 3;
const EWrongCap: u64 = 4;

/// Maximum allowed clock-skew between caller's clock and the timestamp the
/// keeper pushes — guards against far-future stamps that would unfairly
/// pre-settle markets.
const MAX_FUTURE_SKEW_MS: u64 = 30_000;

/// Per-feed pull state. Mirrors what an upstream Pyth/Switchboard read
/// would expose: latest price + timestamp the keeper has cranked, plus the
/// cap that owns push rights for this feed.
public struct PullFeed has key {
    id: UID,
    /// The WickOracle this feed drives.
    oracle_id: ID,
    /// Identifier of the upstream feed (e.g. "pyth-lazer:11" for SUI/USD).
    /// Recorded for observability; not interpreted on-chain.
    upstream_id: String,
    /// Cap that authorizes pushes to this feed.
    keeper_cap_id: ID,
    /// Latest pushed observation timestamp; pushes must strictly increase.
    last_pushed_ms: u64,
}

/// Capability that authorizes pushes to one or more PullFeeds. Issued at
/// feed creation time; owner is the keeper.
public struct KeeperCap has key, store {
    id: UID,
}

public struct PullFeedCreated has copy, drop {
    feed_id: ID,
    oracle_id: ID,
    upstream_id: String,
    keeper_cap_id: ID,
}

public struct PricePushed has copy, drop {
    feed_id: ID,
    oracle_id: ID,
    keeper: address,
    price: u64,
    timestamp_ms: u64,
    /// Opaque upstream-attestation bytes (e.g. the raw Pyth Lazer signed
    /// update) for off-chain auditors to reproduce the keeper's read.
    attestation: vector<u8>,
}

/// Mint a fresh KeeperCap. Anyone can do this — the cap only matters because
/// a PullFeed pins to a specific cap_id. Transfer to whichever address you
/// want to run as keeper.
public fun new_keeper_cap(ctx: &mut TxContext): KeeperCap {
    KeeperCap { id: object::new(ctx) }
}

/// Build the WickOracle and PullFeed paired together. WickOracle.driver_kind
/// = lazer (we reuse the Lazer kind for the keeper-pull form so a future
/// on-chain Lazer verifier can swap in transparently). driver_config carries
/// the bcs-encoded PullFeed id, asserted on every push.
public fun create_market(
    underlying: String,
    upstream_id: String,
    keeper_cap: &KeeperCap,
    expiry_ms: u64,
    settlement_freshness_ms: u64,
    ctx: &mut TxContext,
): (WickOracle, PullFeed) {
    let feed_uid = object::new(ctx);
    let feed_id = feed_uid.to_inner();
    let driver_config = bcs::to_bytes(&feed_id);
    let oracle = wick_oracle::new(
        underlying,
        wick_oracle::driver_lazer(),
        driver_config,
        expiry_ms,
        settlement_freshness_ms,
        ctx,
    );
    let oracle_id = object::id(&oracle);
    let feed = PullFeed {
        id: feed_uid,
        oracle_id,
        upstream_id,
        keeper_cap_id: object::id(keeper_cap),
        last_pushed_ms: 0,
    };
    sui::event::emit(PullFeedCreated {
        feed_id,
        oracle_id,
        upstream_id: feed.upstream_id,
        keeper_cap_id: feed.keeper_cap_id,
    });
    (oracle, feed)
}

public fun share_feed(feed: PullFeed) {
    transfer::share_object(feed);
}

/// Push a new observation. Aborts on cap mismatch, oracle mismatch,
/// non-monotonic timestamp, or far-future timestamp.
public fun push_price(
    feed: &mut PullFeed,
    oracle: &mut WickOracle,
    cap: &KeeperCap,
    price: u64,
    timestamp_ms: u64,
    attestation: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(wick_oracle::driver_kind(oracle) == wick_oracle::driver_lazer(), ENotPullDriver);
    assert!(feed.oracle_id == object::id(oracle), EConfigOracleMismatch);
    assert!(feed.keeper_cap_id == object::id(cap), EWrongCap);
    assert!(timestamp_ms > feed.last_pushed_ms, ENonMonotonicTimestamp);
    let now = clock.timestamp_ms();
    assert!(timestamp_ms <= now + MAX_FUTURE_SKEW_MS, EFutureTimestamp);

    feed.last_pushed_ms = timestamp_ms;
    let obs = price_observation::new(price, timestamp_ms, object::id(oracle));
    wick_oracle::apply_observation(oracle, wick_oracle::driver_lazer(), obs);

    sui::event::emit(PricePushed {
        feed_id: object::id(feed),
        oracle_id: object::id(oracle),
        keeper: tx_context::sender(ctx),
        price,
        timestamp_ms,
        attestation,
    });
}

// === Reads ===

public fun oracle_id(feed: &PullFeed): ID { feed.oracle_id }
public fun upstream_id(feed: &PullFeed): &String { &feed.upstream_id }
public fun keeper_cap_id(feed: &PullFeed): ID { feed.keeper_cap_id }
public fun last_pushed_ms(feed: &PullFeed): u64 { feed.last_pushed_ms }

// === Test-only ===

#[test_only]
public fun new_for_testing(
    underlying: String,
    upstream_id: String,
    expiry_ms: u64,
    ctx: &mut TxContext,
): (WickOracle, PullFeed, KeeperCap) {
    let cap = new_keeper_cap(ctx);
    let (oracle, feed) = create_market(underlying, upstream_id, &cap, expiry_ms, 60_000, ctx);
    (oracle, feed, cap)
}
