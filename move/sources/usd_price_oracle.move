// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// USD price oracle for collateral types. Returns micro-USD per whole unit
/// of a collateral coin, with staleness tracking.
///
/// FEED MODEL: an off-chain keeper polls a public price source (CoinGecko,
/// Coinbase, Binance) every few seconds and pushes the latest mid-price
/// here via admin cap. NO on-chain Pyth Lazer signature verification — that
/// requires paying for Pyth's signed-update service which is out of MVP
/// scope. The trust model is "admin cap holder is honest"; for hackathon
/// the admin cap lives on the keeper multisig.
///
/// CALLERS read `loss_micro_usd<C>(oracle, stake_base, clock, staleness_max)`
/// which auto-returns 0 if the price is stale or unset. Downstream
/// (wick_token::mint_to_loser, wick_staking::record_loss) treat 0 as a
/// graceful no-op (no WICK minted, no loss recorded). This means a stale
/// oracle FAILS CLOSED for tokenomics — the worst case is "no WICK minted
/// for this loss," not "wrong WICK amount minted."
module wick::usd_price_oracle;

use std::type_name::{Self, TypeName};
use sui::clock::Clock;
use sui::table::{Self, Table};

// === Errors ===
const ENotAdmin: u64 = 0;
const EZeroDecimals: u64 = 1;
const EZeroPrice: u64 = 2;
const EUnsetPrice: u64 = 3;

// === Default staleness (10 minutes for a hackathon-grade poll keeper) ===
const DEFAULT_MAX_STALENESS_MS: u64 = 600_000;

// === Types ===

public struct PriceEntry has copy, drop, store {
    /// e.g. SUI = $5.00 → 5_000_000 micro-USD
    micro_usd_per_whole: u64,
    /// e.g. SUI = 9, USDC = 6
    decimals: u8,
    /// Wall-clock timestamp of the most recent push.
    last_update_ms: u64,
}

public struct UsdPriceOracle has key {
    id: UID,
    /// TypeName<C> → PriceEntry
    prices: Table<TypeName, PriceEntry>,
}

public struct PriceAdminCap has key, store {
    id: UID,
    oracle_id: ID,
}

// === Events ===

public struct OracleInitialized has copy, drop {
    oracle_id: ID,
}

public struct PriceUpdated has copy, drop {
    oracle_id: ID,
    currency: TypeName,
    micro_usd_per_whole: u64,
    decimals: u8,
    update_ms: u64,
}

// === Init ===

public fun init_oracle(ctx: &mut TxContext): PriceAdminCap {
    let oracle = UsdPriceOracle {
        id: object::new(ctx),
        prices: table::new(ctx),
    };
    let oracle_id = object::id(&oracle);
    sui::event::emit(OracleInitialized { oracle_id });
    let cap = PriceAdminCap { id: object::new(ctx), oracle_id };
    transfer::share_object(oracle);
    cap
}

// === Admin: keeper pushes prices ===

public fun set_price<C>(
    cap: &PriceAdminCap,
    oracle: &mut UsdPriceOracle,
    micro_usd_per_whole: u64,
    decimals: u8,
    clock: &Clock,
) {
    assert!(cap.oracle_id == object::id(oracle), ENotAdmin);
    assert!(decimals > 0, EZeroDecimals);
    assert!(micro_usd_per_whole > 0, EZeroPrice);
    let now = clock.timestamp_ms();
    let key = type_name::with_defining_ids<C>();
    let entry = PriceEntry { micro_usd_per_whole, decimals, last_update_ms: now };
    if (table::contains(&oracle.prices, key)) {
        let e: &mut PriceEntry = table::borrow_mut(&mut oracle.prices, key);
        *e = entry;
    } else {
        table::add(&mut oracle.prices, key, entry);
    };
    sui::event::emit(PriceUpdated {
        oracle_id: object::id(oracle),
        currency: key,
        micro_usd_per_whole,
        decimals,
        update_ms: now,
    });
}

// === Reads ===

public fun has_price<C>(oracle: &UsdPriceOracle): bool {
    table::contains(&oracle.prices, type_name::with_defining_ids<C>())
}

public fun price_entry<C>(oracle: &UsdPriceOracle): PriceEntry {
    let key = type_name::with_defining_ids<C>();
    assert!(table::contains(&oracle.prices, key), EUnsetPrice);
    *table::borrow(&oracle.prices, key)
}

public fun is_fresh<C>(oracle: &UsdPriceOracle, clock: &Clock, max_staleness_ms: u64): bool {
    let key = type_name::with_defining_ids<C>();
    if (!table::contains(&oracle.prices, key)) return false;
    let e = table::borrow(&oracle.prices, key);
    let now = clock.timestamp_ms();
    now <= e.last_update_ms + max_staleness_ms
}

/// Convert a stake amount (in collateral C base units) to micro-USD.
/// Returns 0 if price unset OR stale beyond `max_staleness_ms`. Caller
/// (mint_to_loser / record_loss) treats 0 as a graceful no-op.
public fun loss_micro_usd<C>(
    oracle: &UsdPriceOracle,
    stake_base: u64,
    clock: &Clock,
    max_staleness_ms: u64,
): u64 {
    if (stake_base == 0) return 0;
    let key = type_name::with_defining_ids<C>();
    if (!table::contains(&oracle.prices, key)) return 0;
    let e = table::borrow(&oracle.prices, key);
    let now = clock.timestamp_ms();
    if (now > e.last_update_ms + max_staleness_ms) return 0;
    // micro_usd = stake_base × micro_usd_per_whole / 10^decimals
    // Promote to u128 to avoid overflow on the multiply, then scale down.
    let pow10 = pow10_u128(e.decimals);
    let scaled = (stake_base as u128) * (e.micro_usd_per_whole as u128);
    (scaled / pow10) as u64
}

public fun default_max_staleness_ms(): u64 { DEFAULT_MAX_STALENESS_MS }
public fun price_micro_usd_per_whole(e: &PriceEntry): u64 { e.micro_usd_per_whole }
public fun price_decimals(e: &PriceEntry): u8 { e.decimals }
public fun price_last_update_ms(e: &PriceEntry): u64 { e.last_update_ms }

// === Helpers ===

fun pow10_u128(d: u8): u128 {
    let mut p: u128 = 1;
    let mut i: u8 = 0;
    while (i < d) {
        p = p * 10;
        i = i + 1;
    };
    p
}

// === Test helpers ===

#[test_only]
public fun init_for_testing(ctx: &mut TxContext): (UsdPriceOracle, PriceAdminCap) {
    let oracle = UsdPriceOracle {
        id: object::new(ctx),
        prices: table::new(ctx),
    };
    let cap = PriceAdminCap { id: object::new(ctx), oracle_id: object::id(&oracle) };
    (oracle, cap)
}
