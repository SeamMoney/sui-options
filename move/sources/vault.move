// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Generic single-collateral vault used by Wick-native markets. Holds all
/// collateral for one market — bettor stakes flow in, winner payouts flow
/// out. The Predict-backed BTC route does NOT use this; it uses Predict's
/// own Vault.
///
/// Conservation property (load-bearing): for each Wick-native market,
/// `vault.balance == sum(open positions × payout_multiplier_bps / 10_000)`.
/// Verified by the market module's tests, not enforced here directly.
module wick::vault;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};

const EZeroAmount: u64 = 0;
const EInsufficientBalance: u64 = 1;

public struct Vault<phantom C> has store {
    balance: Balance<C>,
}

public(package) fun new<C>(): Vault<C> {
    Vault { balance: balance::zero<C>() }
}

public(package) fun deposit<C>(vault: &mut Vault<C>, coin: Coin<C>) {
    let amount = coin.value();
    assert!(amount > 0, EZeroAmount);
    balance::join(&mut vault.balance, coin.into_balance());
}

public(package) fun deposit_balance<C>(vault: &mut Vault<C>, b: Balance<C>) {
    balance::join(&mut vault.balance, b);
}

public(package) fun withdraw<C>(vault: &mut Vault<C>, amount: u64, ctx: &mut TxContext): Coin<C> {
    assert!(amount > 0, EZeroAmount);
    assert!(balance::value(&vault.balance) >= amount, EInsufficientBalance);
    coin::from_balance(balance::split(&mut vault.balance, amount), ctx)
}

public fun balance<C>(vault: &Vault<C>): u64 {
    balance::value(&vault.balance)
}

public(package) fun destroy_empty<C>(vault: Vault<C>) {
    let Vault { balance: b } = vault;
    balance::destroy_zero(b);
}
