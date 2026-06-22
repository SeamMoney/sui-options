// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// WICK — fair-launch fee-claim token.
///
/// Per docs/design/v2/03_wick_tokenomics_v2.md + reconciliation §12.
///
/// Properties:
///   - Supply starts at zero. No premint, no team allocation, no VC, no airdrop.
///   - Mint trigger: trader's losing close (called via mint_to_loser by market/ride).
///   - Mint curve: flat = 100 WICK / $1 of LP gain while HWM < $20k threshold;
///     decays as flat × (S/(S+H))² where S = $1.2M, H = HWM − $20k (above threshold).
///   - HWM is strict-monotone — never decreases (kills mint-loop attacks).
///   - Genesis dampener: $50/address/day cap for first 7 days post-deploy
///     (kills whale front-run on flat region).
///   - Bot-trader exclusion: eligible_for_wick_mint flag set false at trade
///     open for protocol-bot-registered addresses.
///   - Pyth-snapshot price-at-trade-settlement-time captured by caller and
///     passed in as loss_usd_micro (1e6 micro-USD units).
#[allow(unused_const, deprecated_usage)]
module wick::wick_token;

use sui::clock::Clock;
use sui::coin::{Self, TreasuryCap};
use sui::table::{Self, Table};

const EZeroAmount: u64 = 0;
const EBotIneligible: u64 = 1;
const EAlreadyInitialized: u64 = 2;
const ENotAdmin: u64 = 3;

const ONE_DAY_MS: u64 = 86_400_000;
const SEVEN_DAYS_MS: u64 = 7 * ONE_DAY_MS;

// === The token (one-time witness) ===

public struct WICK_TOKEN has drop {}

// === State ===

public struct WickTokenState has key {
    id: UID,
    treasury_cap: TreasuryCap<WICK_TOKEN>,
    /// Strict-monotone high-water-mark of cumulative LP gain (USD micro-units = 1e6).
    /// Never decreases. Drives the mint curve decay.
    hwm_lp_gain_micro_usd: u128,
    /// Wall-clock anchor for the genesis dampener window.
    genesis_start_ms: u64,
    /// Daily per-address mint cap during dampener window (in micro-USD).
    daily_mint_cap_micro_usd: u64,
    /// (address, day_index) → cumulative micro-USD minted that day.
    daily_mints: Table<DailyKey, u64>,
    /// Curve parameters (immutable post-init).
    flat_rate: u64,                  // WICK micro-units per $1 of LP gain (default 100 × 1e9 = 1e11)
    threshold_micro_usd: u64,        // flat region cap (default $20k = 20e9)
    decay_scale_micro_usd: u64,      // S in (S/(S+H))² (default $1.2M = 1.2e12)
    /// Lifetime telemetry.
    cumulative_minted: u128,
    cumulative_loss_consumed: u128,
}

public struct DailyKey has copy, drop, store {
    addr: address,
    day_index: u64,
}

public struct WickAdminCap has key, store {
    id: UID,
    state_id: ID,
}

// === Events ===

public struct WickInitialized has copy, drop {
    state_id: ID,
    flat_rate: u64,
    threshold_micro_usd: u64,
    decay_scale_micro_usd: u64,
    genesis_start_ms: u64,
}

public struct WickMinted has copy, drop {
    state_id: ID,
    loser: address,
    loss_micro_usd: u64,
    rate_per_dollar: u64,
    minted_amount: u64,
    new_hwm_micro_usd: u128,
    dampener_active: bool,
}

public struct WickMintRejectedByDampener has copy, drop {
    state_id: ID,
    loser: address,
    requested_micro_usd: u64,
    allowed_micro_usd: u64,
}

// === Init ===

/// Module initializer — runs once at publish. Creates the WICK currency and
/// wraps the TreasuryCap inside WickTokenState (so only this module can mint).
fun init(witness: WICK_TOKEN, ctx: &mut TxContext) {
    let (treasury_cap, metadata) = coin::create_currency<WICK_TOKEN>(
        witness,
        9,
        b"WICK",
        b"Wick",
        b"Wick Markets fee-claim token. Minted only on losing trades. Stake to earn protocol fees.",
        option::none(),
        ctx,
    );
    transfer::public_freeze_object(metadata);

    // Defaults from reconciliation/tokenomics_v2 (scaled 100x down for hackathon):
    // flat = 100 WICK / $1 = 100e9 (with 9 decimals on WICK) per 1e6 micro-USD = 100_000 micro-WICK per micro-USD
    // To keep math simple: rate = WICK whole units per micro-USD (i.e. 100 WICK per 1e6 micro-USD = 100 / 1e6 = 1e-4)
    // Let's store flat_rate as MILLIWICK per MICRO-USD to keep u64 math clean.
    // 100 WICK = 100 × 1e9 = 1e11 base units of WICK.
    // Per 1e6 micro-USD, we want 1e11 base WICK: rate = 1e11 / 1e6 = 1e5 base WICK per micro-USD.
    let flat_rate = 100_000;
    let threshold_micro_usd = 20_000_000_000;       // $20k = 20e9 micro-USD
    let decay_scale_micro_usd = 1_200_000_000_000;  // $1.2M = 1.2e12 micro-USD

    let state = WickTokenState {
        id: object::new(ctx),
        treasury_cap,
        hwm_lp_gain_micro_usd: 0,
        genesis_start_ms: 0,  // patched on first init_genesis call
        daily_mint_cap_micro_usd: 50_000_000,  // $50/day
        daily_mints: table::new(ctx),
        flat_rate,
        threshold_micro_usd,
        decay_scale_micro_usd,
        cumulative_minted: 0,
        cumulative_loss_consumed: 0,
    };

    sui::event::emit(WickInitialized {
        state_id: object::id(&state),
        flat_rate,
        threshold_micro_usd,
        decay_scale_micro_usd,
        genesis_start_ms: 0,
    });

    let cap = WickAdminCap { id: object::new(ctx), state_id: object::id(&state) };
    transfer::public_transfer(cap, ctx.sender());
    transfer::share_object(state);
}

/// Set the genesis_start_ms to the current clock. Must be called once
/// after publish + before any mints. Idempotent: if already set, no-op.
public fun init_genesis(
    cap: &WickAdminCap,
    state: &mut WickTokenState,
    clock: &Clock,
) {
    assert!(cap.state_id == object::id(state), ENotAdmin);
    if (state.genesis_start_ms == 0) {
        state.genesis_start_ms = clock.timestamp_ms();
    };
}

// === Reads ===

public fun hwm_lp_gain_micro_usd(s: &WickTokenState): u128 { s.hwm_lp_gain_micro_usd }
public fun genesis_start_ms(s: &WickTokenState): u64 { s.genesis_start_ms }
public fun daily_mint_cap_micro_usd(s: &WickTokenState): u64 { s.daily_mint_cap_micro_usd }
public fun flat_rate(s: &WickTokenState): u64 { s.flat_rate }
public fun threshold_micro_usd(s: &WickTokenState): u64 { s.threshold_micro_usd }
public fun decay_scale_micro_usd(s: &WickTokenState): u64 { s.decay_scale_micro_usd }
public fun cumulative_minted(s: &WickTokenState): u128 { s.cumulative_minted }
public fun cumulative_loss_consumed(s: &WickTokenState): u128 { s.cumulative_loss_consumed }
public fun total_supply(s: &WickTokenState): u64 { coin::total_supply(&s.treasury_cap) }

/// Returns current rate in base WICK per micro-USD (matches flat_rate units).
public fun current_rate_per_micro_usd(state: &WickTokenState): u64 {
    if (state.hwm_lp_gain_micro_usd < (state.threshold_micro_usd as u128)) {
        state.flat_rate
    } else {
        let h_above_threshold = state.hwm_lp_gain_micro_usd - (state.threshold_micro_usd as u128);
        let s = state.decay_scale_micro_usd as u128;
        let s_plus_h = s + h_above_threshold;
        // rate = flat × s² / (s+h)²
        let s_squared = s * s;
        let s_plus_h_squared = s_plus_h * s_plus_h;
        let rate_u128 = (state.flat_rate as u128) * s_squared / s_plus_h_squared;
        rate_u128 as u64
    }
}

/// Whether dampener is currently active (within 7-day window post-genesis).
public fun is_dampener_active(state: &WickTokenState, clock: &Clock): bool {
    if (state.genesis_start_ms == 0) return false;
    let now = clock.timestamp_ms();
    now < state.genesis_start_ms + SEVEN_DAYS_MS
}

// === Mint ===

/// Called by market/ride modules on a losing settlement. `loss_micro_usd`
/// is the USD-equivalent (Pyth-snapshotted at trade-settlement time per
/// reconciliation §12) of the protocol's gain from this loss.
///
/// Returns the actual WICK amount minted (could be < requested if dampener
/// caps the user's daily mint, or 0 if bot-ineligible).
///
/// Per reconciliation §12: only mints when Wick reserve covered the
/// shortfall (i.e. Wick experienced an actual gain). Caller is responsible
/// for that check.
public(package) fun mint_to_loser(
    state: &mut WickTokenState,
    loser: address,
    loss_micro_usd: u64,
    is_bot_eligible: bool,
    clock: &Clock,
    ctx: &mut TxContext,
): u64 {
    if (loss_micro_usd == 0) return 0;
    if (!is_bot_eligible) return 0;  // bot-trader exclusion

    let now = clock.timestamp_ms();
    let dampener_active = is_dampener_active(state, clock);

    // Compute allowed loss after dampener cap
    let allowed_loss = if (dampener_active) {
        let day_index = (now - state.genesis_start_ms) / ONE_DAY_MS;
        let key = DailyKey { addr: loser, day_index };
        let prior_minted = if (table::contains(&state.daily_mints, key)) {
            *table::borrow(&state.daily_mints, key)
        } else { 0 };
        let cap_remaining = if (state.daily_mint_cap_micro_usd > prior_minted) {
            state.daily_mint_cap_micro_usd - prior_minted
        } else { 0 };
        let allowed = if (loss_micro_usd > cap_remaining) cap_remaining else loss_micro_usd;
        if (allowed > 0) {
            if (table::contains(&state.daily_mints, key)) {
                let v = table::borrow_mut(&mut state.daily_mints, key);
                *v = *v + allowed;
            } else {
                table::add(&mut state.daily_mints, key, allowed);
            };
        };
        if (allowed < loss_micro_usd) {
            sui::event::emit(WickMintRejectedByDampener {
                state_id: object::id(state),
                loser,
                requested_micro_usd: loss_micro_usd,
                allowed_micro_usd: allowed,
            });
        };
        allowed
    } else {
        loss_micro_usd
    };

    if (allowed_loss == 0) return 0;

    let rate = current_rate_per_micro_usd(state);
    let mint_amount = ((allowed_loss as u128) * (rate as u128)) as u64;

    if (mint_amount > 0) {
        let minted_coin = coin::mint(&mut state.treasury_cap, mint_amount, ctx);
        transfer::public_transfer(minted_coin, loser);
    };

    // Strict-monotone HWM update — only ever increases
    state.hwm_lp_gain_micro_usd = state.hwm_lp_gain_micro_usd + (allowed_loss as u128);
    state.cumulative_minted = state.cumulative_minted + (mint_amount as u128);
    state.cumulative_loss_consumed = state.cumulative_loss_consumed + (allowed_loss as u128);

    sui::event::emit(WickMinted {
        state_id: object::id(state),
        loser,
        loss_micro_usd: allowed_loss,
        rate_per_dollar: rate,
        minted_amount: mint_amount,
        new_hwm_micro_usd: state.hwm_lp_gain_micro_usd,
        dampener_active,
    });

    mint_amount
}

// === Test helpers ===

#[test_only]
public fun init_for_testing(ctx: &mut TxContext): (WickTokenState, WickAdminCap) {
    let treasury_cap = coin::create_treasury_cap_for_testing<WICK_TOKEN>(ctx);
    let state = WickTokenState {
        id: object::new(ctx),
        treasury_cap,
        hwm_lp_gain_micro_usd: 0,
        genesis_start_ms: 0,
        daily_mint_cap_micro_usd: 50_000_000,
        daily_mints: table::new(ctx),
        flat_rate: 100_000,
        threshold_micro_usd: 20_000_000_000,
        decay_scale_micro_usd: 1_200_000_000_000,
        cumulative_minted: 0,
        cumulative_loss_consumed: 0,
    };
    let cap = WickAdminCap { id: object::new(ctx), state_id: object::id(&state) };
    (state, cap)
}

#[test_only]
public fun test_mint_to_loser(
    state: &mut WickTokenState,
    loser: address,
    loss_micro_usd: u64,
    is_bot_eligible: bool,
    clock: &Clock,
    ctx: &mut TxContext,
): u64 {
    mint_to_loser(state, loser, loss_micro_usd, is_bot_eligible, clock, ctx)
}

#[test_only]
public fun seven_days_ms(): u64 { SEVEN_DAYS_MS }
