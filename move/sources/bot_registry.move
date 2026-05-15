// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Registry of addresses flagged as bots (excluded from WICK token mint
/// per tokenomics_v2 §4.4 to prevent yield farming).
///
/// EMPTY-DEFAULT model: every address is eligible until admin marks it.
/// This is intentional — at hackathon scale we mark bots after observing
/// suspicious volume patterns. Pre-MVP automated detection is out of scope.
///
/// CRITICAL: callers MUST snapshot eligibility at OPEN time into the
/// Position object (`Position.is_bot_eligible: bool`) and read from there
/// at redeem. Reading the registry at redeem-time would let a freshly-
/// flagged bot's outstanding positions still mint WICK on close.
module wick::bot_registry;

use sui::vec_set::{Self, VecSet};

// === Errors ===
const ENotAdmin: u64 = 0;
const ENotMarked: u64 = 1;

public struct BotRegistry has key {
    id: UID,
    bots: VecSet<address>,
}

public struct BotAdminCap has key, store {
    id: UID,
    registry_id: ID,
}

// === Events ===

public struct BotRegistryInitialized has copy, drop {
    registry_id: ID,
}

public struct BotMarked has copy, drop {
    registry_id: ID,
    addr: address,
}

public struct BotUnmarked has copy, drop {
    registry_id: ID,
    addr: address,
}

// === Init ===

public fun init_registry(ctx: &mut TxContext): BotAdminCap {
    let reg = BotRegistry {
        id: object::new(ctx),
        bots: vec_set::empty(),
    };
    let registry_id = object::id(&reg);
    sui::event::emit(BotRegistryInitialized { registry_id });
    let cap = BotAdminCap { id: object::new(ctx), registry_id };
    transfer::share_object(reg);
    cap
}

// === Admin ===

public fun mark_bot(cap: &BotAdminCap, reg: &mut BotRegistry, addr: address) {
    assert!(cap.registry_id == object::id(reg), ENotAdmin);
    if (!vec_set::contains(&reg.bots, &addr)) {
        vec_set::insert(&mut reg.bots, addr);
        sui::event::emit(BotMarked { registry_id: object::id(reg), addr });
    };
}

public fun unmark_bot(cap: &BotAdminCap, reg: &mut BotRegistry, addr: address) {
    assert!(cap.registry_id == object::id(reg), ENotAdmin);
    assert!(vec_set::contains(&reg.bots, &addr), ENotMarked);
    vec_set::remove(&mut reg.bots, &addr);
    sui::event::emit(BotUnmarked { registry_id: object::id(reg), addr });
}

// === Reads ===

/// True if address is eligible for WICK mint (i.e., NOT in the bot set).
public fun is_eligible_for_wick(reg: &BotRegistry, addr: address): bool {
    !vec_set::contains(&reg.bots, &addr)
}

public fun is_marked_bot(reg: &BotRegistry, addr: address): bool {
    vec_set::contains(&reg.bots, &addr)
}

public fun bot_count(reg: &BotRegistry): u64 { vec_set::size(&reg.bots) }

// === Test helpers ===

#[test_only]
public fun init_for_testing(ctx: &mut TxContext): (BotRegistry, BotAdminCap) {
    let reg = BotRegistry {
        id: object::new(ctx),
        bots: vec_set::empty(),
    };
    let cap = BotAdminCap { id: object::new(ctx), registry_id: object::id(&reg) };
    (reg, cap)
}
