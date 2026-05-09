/// Wick Markets — touch / no-touch options on Sui.
///
/// Primary collateral invariant:
///   while ACTIVE   → collateral_vault.value() == total_touch_supply == total_no_touch_supply
///   after HIT      → collateral_vault.value() == total_touch_supply
///   after EXPIRED  → collateral_vault.value() == total_no_touch_supply
///
/// Day-1 surface: structs, accessors, `create_market`.
/// Day-2 surface: paired-claim mint, CPMM trading, redemption, settlement.
module wick::wick;

use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;
use wick::oracle_adapter::{Self, MockOracle};

// === Status codes ===
const STATUS_ACTIVE: u8 = 0;
const STATUS_HIT: u8 = 1;
const STATUS_EXPIRED: u8 = 2;

// === Side codes ===
const SIDE_TOUCH: u8 = 0;
const SIDE_NO_TOUCH: u8 = 1;

// === Direction codes ===
const DIR_ABOVE: u8 = 0;
const DIR_BELOW: u8 = 1;

// === BPS ===
const BPS_DENOMINATOR: u128 = 10_000;

// === Error codes ===
// Annotated with #[error] so tests can reference them by name in
// `expected_failure(abort_code = ::wick::wick::E_X)` and so runtime errors
// carry a human-readable message alongside the numeric code.

#[error(code = 1)]
const E_ZERO_BARRIER: vector<u8> = b"barrier price must be > 0";

#[error(code = 2)]
const E_PAST_EXPIRY: vector<u8> = b"expiry must be strictly in the future";

#[error(code = 3)]
const E_ZERO_COLLATERAL: vector<u8> = b"collateral payment must be > 0";

#[error(code = 4)]
const E_INVALID_DIRECTION: vector<u8> = b"direction must be DIR_ABOVE or DIR_BELOW";

#[error(code = 5)]
const E_INVALID_FEE: vector<u8> = b"fee_bps must be <= 10_000";

#[error(code = 6)]
const E_NOT_ACTIVE: vector<u8> = b"market is not active";

#[error(code = 7)]
const E_PAST_EXPIRY_TRADE: vector<u8> = b"market expiry has passed";

#[error(code = 8)]
const E_WRONG_MARKET: vector<u8> = b"position belongs to a different market";

#[error(code = 9)]
const E_WRONG_SIDE: vector<u8> = b"position is on the wrong side";

#[error(code = 10)]
const E_AMOUNT_MISMATCH: vector<u8> = b"complete-set redeem requires equal TOUCH and NO_TOUCH amounts";

#[error(code = 11)]
const E_BARRIER_NOT_CROSSED: vector<u8> = b"oracle has not crossed the barrier";

#[error(code = 12)]
const E_NOT_EXPIRED: vector<u8> = b"market has not yet reached expiry";

#[error(code = 13)]
const E_LOSING_SIDE: vector<u8> = b"position is on the losing side";

#[error(code = 14)]
const E_INSUFFICIENT_OUTPUT: vector<u8> = b"swap output amount is zero";

#[error(code = 15)]
const E_STILL_ACTIVE: vector<u8> = b"market is still active; settlement required before redeem_winner";

#[error(code = 16)]
const E_LP_STILL_ACTIVE: vector<u8> = b"market is still active; settlement required before redeem_lp";

#[error(code = 17)]
const E_LP_NO_SHARES: vector<u8> = b"lp position has zero shares";

// === Public structs ===

/// A touch / no-touch market on a single oracle-observed price barrier.
public struct Market<phantom C> has key {
    id: UID,
    /// Opaque oracle key (e.g. b"BTC/USD"). Indexed by frontend and keeper.
    asset_id: vector<u8>,
    /// DIR_ABOVE: TOUCH wins iff oracle price >= barrier_price before expiry.
    /// DIR_BELOW: TOUCH wins iff oracle price <= barrier_price before expiry.
    direction: u8,
    barrier_price: u64,
    expiry_ms: u64,
    status: u8,
    /// All collateral lives here. value() satisfies the invariant per status.
    collateral_vault: Balance<C>,
    /// CPMM reserves. Reserves are part of `total_*_supply`; the AMM is
    /// just inventory holding claim units.
    touch_reserve: u64,
    no_touch_reserve: u64,
    /// Total outstanding claim supply on each side. Decrements on redeem.
    total_touch_supply: u64,
    total_no_touch_supply: u64,
    /// LP shares outstanding. Day 1 mints all to the creator.
    lp_supply: u64,
    fee_bps: u64,
}

/// A user's holding of one market side.
public struct Position has key, store {
    id: UID,
    market_id: ID,
    side: u8,
    amount: u64,
}

/// LP share in a market's AMM reserves.
public struct LpPosition has key, store {
    id: UID,
    market_id: ID,
    shares: u64,
}

// === Events ===
//
// Indexer / keeper / frontend listen to these. Field names are stable —
// renaming is a breaking event-schema change for any external consumer.

public struct MarketCreated has copy, drop {
    market_id: ID,
    creator: address,
    asset_id: vector<u8>,
    direction: u8,
    barrier_price: u64,
    expiry_ms: u64,
    fee_bps: u64,
    seed: u64,
}

public struct PositionOpened has copy, drop {
    market_id: ID,
    position_id: ID,
    trader: address,
    side: u8,
    payment: u64,
    amount: u64,
}

public struct Swapped has copy, drop {
    market_id: ID,
    trader: address,
    in_side: u8,
    in_amount: u64,
    out_amount: u64,
    new_position_id: ID,
}

public struct CompleteSetRedeemed has copy, drop {
    market_id: ID,
    trader: address,
    amount: u64,
}

public struct MarkedHit has copy, drop {
    market_id: ID,
    oracle_price: u64,
    barrier_price: u64,
    direction: u8,
    timestamp_ms: u64,
}

public struct SettledExpired has copy, drop {
    market_id: ID,
    expiry_ms: u64,
    timestamp_ms: u64,
}

public struct WinnerRedeemed has copy, drop {
    market_id: ID,
    trader: address,
    side: u8,
    amount: u64,
}

public struct LpRedeemed has copy, drop {
    market_id: ID,
    lp_provider: address,
    shares: u64,
    claim: u64,
}

// === Read-only accessors ===

public fun status<C>(m: &Market<C>): u8 { m.status }
public fun direction<C>(m: &Market<C>): u8 { m.direction }
public fun barrier<C>(m: &Market<C>): u64 { m.barrier_price }
public fun expiry_ms<C>(m: &Market<C>): u64 { m.expiry_ms }
public fun fee_bps<C>(m: &Market<C>): u64 { m.fee_bps }
public fun touch_reserve<C>(m: &Market<C>): u64 { m.touch_reserve }
public fun no_touch_reserve<C>(m: &Market<C>): u64 { m.no_touch_reserve }
public fun total_touch_supply<C>(m: &Market<C>): u64 { m.total_touch_supply }
public fun total_no_touch_supply<C>(m: &Market<C>): u64 { m.total_no_touch_supply }
public fun lp_supply<C>(m: &Market<C>): u64 { m.lp_supply }
public fun collateral_value<C>(m: &Market<C>): u64 { m.collateral_vault.value() }
public fun asset_id<C>(m: &Market<C>): &vector<u8> { &m.asset_id }

public fun position_side(p: &Position): u8 { p.side }
public fun position_amount(p: &Position): u64 { p.amount }
public fun position_market_id(p: &Position): ID { p.market_id }

public fun lp_shares(p: &LpPosition): u64 { p.shares }
public fun lp_market_id(p: &LpPosition): ID { p.market_id }

// === Constants exposed to other modules and tests ===

public fun status_active(): u8 { STATUS_ACTIVE }
public fun status_hit(): u8 { STATUS_HIT }
public fun status_expired(): u8 { STATUS_EXPIRED }

public fun side_touch(): u8 { SIDE_TOUCH }
public fun side_no_touch(): u8 { SIDE_NO_TOUCH }

public fun dir_above(): u8 { DIR_ABOVE }
public fun dir_below(): u8 { DIR_BELOW }

// === Entry: create_market ===

/// Create a new touch/no-touch market and seed it with paired claims.
///
/// At construction:
///   collateral_value == total_touch_supply == total_no_touch_supply == n
///   touch_reserve == no_touch_reserve == n  (50/50 implied price)
///   lp_supply == n  (all LP to creator)
#[allow(lint(self_transfer))]
public fun create_market<C>(
    asset_id: vector<u8>,
    direction: u8,
    barrier_price: u64,
    expiry_ms: u64,
    fee_bps: u64,
    seed: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(barrier_price > 0, E_ZERO_BARRIER);
    assert!(expiry_ms > clock.timestamp_ms(), E_PAST_EXPIRY);
    assert!(direction == DIR_ABOVE || direction == DIR_BELOW, E_INVALID_DIRECTION);
    assert!(fee_bps <= 10_000, E_INVALID_FEE);

    let seed_balance = coin::into_balance(seed);
    let n = balance::value(&seed_balance);
    assert!(n > 0, E_ZERO_COLLATERAL);

    let market = Market<C> {
        id: object::new(ctx),
        asset_id,
        direction,
        barrier_price,
        expiry_ms,
        status: STATUS_ACTIVE,
        collateral_vault: seed_balance,
        touch_reserve: n,
        no_touch_reserve: n,
        total_touch_supply: n,
        total_no_touch_supply: n,
        lp_supply: n,
        fee_bps,
    };
    let market_id = object::id(&market);

    let lp = LpPosition {
        id: object::new(ctx),
        market_id,
        shares: n,
    };

    event::emit(MarketCreated {
        market_id,
        creator: ctx.sender(),
        asset_id: market.asset_id,
        direction,
        barrier_price,
        expiry_ms,
        fee_bps,
        seed: n,
    });

    transfer::public_transfer(lp, ctx.sender());
    transfer::share_object(market);
}

// === Internal helpers ===

/// Mint a complete set of size N. Vault grows by N; both supplies grow by N.
/// Returns N. The invariant is preserved when only this function mutates.
fun mint_complete_set<C>(market: &mut Market<C>, payment: Balance<C>): u64 {
    let n = balance::value(&payment);
    market.collateral_vault.join(payment);
    market.total_touch_supply = market.total_touch_supply + n;
    market.total_no_touch_supply = market.total_no_touch_supply + n;
    n
}

/// CPMM output amount given input, reserves, and fee in bps.
/// Fee is taken on the input: `in_eff = in * (10000 - fee) / 10000`.
/// The CALLER updates reserves: `in_reserve += in (gross)`, `out_reserve -= out`.
/// Charging fee on the input while pushing the gross input into the reserve
/// is what lets LPs accrue fees as inventory.
fun cpmm_out(in_amt: u64, in_reserve: u64, out_reserve: u64, fee_bps: u64): u64 {
    let in_amt_128 = in_amt as u128;
    let in_res_128 = in_reserve as u128;
    let out_res_128 = out_reserve as u128;
    let fee_128 = fee_bps as u128;
    let in_eff = in_amt_128 * (BPS_DENOMINATOR - fee_128) / BPS_DENOMINATOR;
    let out = out_res_128 * in_eff / (in_res_128 + in_eff);
    out as u64
}

// === Public: buy_touch / buy_no_touch ===

/// Mint a complete set of N from `payment`, dump the unwanted (NO_TOUCH) half
/// into the AMM reserve, swap it via the CPMM to extract X TOUCH from the
/// reserve, return Position{TOUCH, N+X}.
///
/// Net for the user: pays N collateral, holds N+X TOUCH. Profit if HIT is X.
public fun buy_touch<C>(
    market: &mut Market<C>,
    payment: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): Position {
    assert!(market.status == STATUS_ACTIVE, E_NOT_ACTIVE);
    assert!(clock.timestamp_ms() < market.expiry_ms, E_PAST_EXPIRY_TRADE);

    let payment_balance = coin::into_balance(payment);
    let n = mint_complete_set(market, payment_balance);
    assert!(n > 0, E_ZERO_COLLATERAL);

    // Sell n NO_TOUCH into reserve, get x TOUCH out. x can be 0 if reserves are
    // very thin or input is tiny — that's a no-op trade, not an error.
    let x = cpmm_out(n, market.no_touch_reserve, market.touch_reserve, market.fee_bps);
    market.no_touch_reserve = market.no_touch_reserve + n;
    market.touch_reserve = market.touch_reserve - x;

    let pos = Position {
        id: object::new(ctx),
        market_id: object::id(market),
        side: SIDE_TOUCH,
        amount: n + x,
    };
    event::emit(PositionOpened {
        market_id: object::id(market),
        position_id: object::id(&pos),
        trader: ctx.sender(),
        side: SIDE_TOUCH,
        payment: n,
        amount: n + x,
    });
    pos
}

/// Symmetric of `buy_touch` for the NO_TOUCH side.
public fun buy_no_touch<C>(
    market: &mut Market<C>,
    payment: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): Position {
    assert!(market.status == STATUS_ACTIVE, E_NOT_ACTIVE);
    assert!(clock.timestamp_ms() < market.expiry_ms, E_PAST_EXPIRY_TRADE);

    let payment_balance = coin::into_balance(payment);
    let n = mint_complete_set(market, payment_balance);
    assert!(n > 0, E_ZERO_COLLATERAL);

    let x = cpmm_out(n, market.touch_reserve, market.no_touch_reserve, market.fee_bps);
    market.touch_reserve = market.touch_reserve + n;
    market.no_touch_reserve = market.no_touch_reserve - x;

    let pos = Position {
        id: object::new(ctx),
        market_id: object::id(market),
        side: SIDE_NO_TOUCH,
        amount: n + x,
    };
    event::emit(PositionOpened {
        market_id: object::id(market),
        position_id: object::id(&pos),
        trader: ctx.sender(),
        side: SIDE_NO_TOUCH,
        payment: n,
        amount: n + x,
    });
    pos
}

// === Public: pure CPMM swaps ===

public fun swap_touch_for_no_touch<C>(
    market: &mut Market<C>,
    in_pos: Position,
    clock: &Clock,
    ctx: &mut TxContext,
): Position {
    assert!(market.status == STATUS_ACTIVE, E_NOT_ACTIVE);
    assert!(clock.timestamp_ms() < market.expiry_ms, E_PAST_EXPIRY_TRADE);
    assert!(in_pos.market_id == object::id(market), E_WRONG_MARKET);
    assert!(in_pos.side == SIDE_TOUCH, E_WRONG_SIDE);

    let Position { id, market_id: _, side: _, amount: in_amt } = in_pos;
    object::delete(id);

    let out = cpmm_out(in_amt, market.touch_reserve, market.no_touch_reserve, market.fee_bps);
    assert!(out > 0, E_INSUFFICIENT_OUTPUT);
    market.touch_reserve = market.touch_reserve + in_amt;
    market.no_touch_reserve = market.no_touch_reserve - out;

    let new_pos = Position {
        id: object::new(ctx),
        market_id: object::id(market),
        side: SIDE_NO_TOUCH,
        amount: out,
    };
    event::emit(Swapped {
        market_id: object::id(market),
        trader: ctx.sender(),
        in_side: SIDE_TOUCH,
        in_amount: in_amt,
        out_amount: out,
        new_position_id: object::id(&new_pos),
    });
    new_pos
}

public fun swap_no_touch_for_touch<C>(
    market: &mut Market<C>,
    in_pos: Position,
    clock: &Clock,
    ctx: &mut TxContext,
): Position {
    assert!(market.status == STATUS_ACTIVE, E_NOT_ACTIVE);
    assert!(clock.timestamp_ms() < market.expiry_ms, E_PAST_EXPIRY_TRADE);
    assert!(in_pos.market_id == object::id(market), E_WRONG_MARKET);
    assert!(in_pos.side == SIDE_NO_TOUCH, E_WRONG_SIDE);

    let Position { id, market_id: _, side: _, amount: in_amt } = in_pos;
    object::delete(id);

    let out = cpmm_out(in_amt, market.no_touch_reserve, market.touch_reserve, market.fee_bps);
    assert!(out > 0, E_INSUFFICIENT_OUTPUT);
    market.no_touch_reserve = market.no_touch_reserve + in_amt;
    market.touch_reserve = market.touch_reserve - out;

    let new_pos = Position {
        id: object::new(ctx),
        market_id: object::id(market),
        side: SIDE_TOUCH,
        amount: out,
    };
    event::emit(Swapped {
        market_id: object::id(market),
        trader: ctx.sender(),
        in_side: SIDE_NO_TOUCH,
        in_amount: in_amt,
        out_amount: out,
        new_position_id: object::id(&new_pos),
    });
    new_pos
}

// === Public: redeem_complete_set (pre-settlement) ===

/// Burn equal TOUCH and NO_TOUCH positions, withdraw the matching amount from
/// the vault. Both supplies decrement by N. Invariant preserved.
///
/// Day-1 MVP requires exact equality. Splitting Positions for partial redemption
/// is post-MVP.
public fun redeem_complete_set<C>(
    market: &mut Market<C>,
    touch_pos: Position,
    no_touch_pos: Position,
    ctx: &mut TxContext,
): Coin<C> {
    let mid = object::id(market);
    assert!(touch_pos.market_id == mid, E_WRONG_MARKET);
    assert!(no_touch_pos.market_id == mid, E_WRONG_MARKET);
    assert!(touch_pos.side == SIDE_TOUCH, E_WRONG_SIDE);
    assert!(no_touch_pos.side == SIDE_NO_TOUCH, E_WRONG_SIDE);
    assert!(touch_pos.amount == no_touch_pos.amount, E_AMOUNT_MISMATCH);

    let n = touch_pos.amount;

    let Position { id: tid, market_id: _, side: _, amount: _ } = touch_pos;
    let Position { id: nid, market_id: _, side: _, amount: _ } = no_touch_pos;
    object::delete(tid);
    object::delete(nid);

    market.total_touch_supply = market.total_touch_supply - n;
    market.total_no_touch_supply = market.total_no_touch_supply - n;
    let withdraw = market.collateral_vault.split(n);
    event::emit(CompleteSetRedeemed {
        market_id: object::id(market),
        trader: ctx.sender(),
        amount: n,
    });
    coin::from_balance(withdraw, ctx)
}

// === Public: settlement ===

/// Permissionless. Asserts the market is still ACTIVE, not past expiry, and
/// the oracle has crossed the barrier in the market's direction. Sets HIT.
/// Idempotent: a second call hits the !ACTIVE guard and reverts cleanly.
public fun mark_hit<C>(market: &mut Market<C>, oracle: &MockOracle, clock: &Clock) {
    assert!(market.status == STATUS_ACTIVE, E_NOT_ACTIVE);
    assert!(clock.timestamp_ms() < market.expiry_ms, E_PAST_EXPIRY_TRADE);
    assert!(
        oracle_adapter::barrier_crossed(oracle, market.direction, market.barrier_price),
        E_BARRIER_NOT_CROSSED,
    );
    market.status = STATUS_HIT;
    event::emit(MarkedHit {
        market_id: object::id(market),
        oracle_price: oracle_adapter::get_price(oracle),
        barrier_price: market.barrier_price,
        direction: market.direction,
        timestamp_ms: clock.timestamp_ms(),
    });
}

/// Permissionless. Asserts the market is still ACTIVE and now >= expiry. Sets EXPIRED.
public fun settle_expired<C>(market: &mut Market<C>, clock: &Clock) {
    assert!(market.status == STATUS_ACTIVE, E_NOT_ACTIVE);
    assert!(clock.timestamp_ms() >= market.expiry_ms, E_NOT_EXPIRED);
    market.status = STATUS_EXPIRED;
    event::emit(SettledExpired {
        market_id: object::id(market),
        expiry_ms: market.expiry_ms,
        timestamp_ms: clock.timestamp_ms(),
    });
}

/// Burn a winning Position, withdraw `amount` collateral from the vault.
///   HIT     → only TOUCH redeems, decrements TOUCH supply.
///   EXPIRED → only NO_TOUCH redeems, decrements NO_TOUCH supply.
///   ACTIVE  → aborts (use redeem_complete_set instead).
public fun redeem_winner<C>(
    market: &mut Market<C>,
    pos: Position,
    ctx: &mut TxContext,
): Coin<C> {
    assert!(pos.market_id == object::id(market), E_WRONG_MARKET);

    if (market.status == STATUS_HIT) {
        assert!(pos.side == SIDE_TOUCH, E_LOSING_SIDE);
        market.total_touch_supply = market.total_touch_supply - pos.amount;
    } else if (market.status == STATUS_EXPIRED) {
        assert!(pos.side == SIDE_NO_TOUCH, E_LOSING_SIDE);
        market.total_no_touch_supply = market.total_no_touch_supply - pos.amount;
    } else {
        abort E_STILL_ACTIVE
    };

    let pos_side = pos.side;
    let Position { id, market_id: _, side: _, amount } = pos;
    object::delete(id);

    let withdraw = market.collateral_vault.split(amount);
    event::emit(WinnerRedeemed {
        market_id: object::id(market),
        trader: ctx.sender(),
        side: pos_side,
        amount,
    });
    coin::from_balance(withdraw, ctx)
}

/// After settlement, an LP burns shares for a pro-rata slice of the
/// winning side's reserve (which is the only economically-valuable inventory
/// the AMM still holds — the losing-side reserve is stranded).
///
/// Math:
///   winning_reserve = touch_reserve  if HIT
///                   = no_touch_reserve if EXPIRED
///   claim = lp.shares * winning_reserve / lp_supply        (u128 intermediate)
///
/// Effects:
///   vault -= claim
///   winning_reserve -= claim
///   winning_supply  -= claim    (the AMM-held winning supply we just paid out)
///   lp_supply       -= lp.shares
///
/// Invariant after a single LP redemption:
///   HIT     → vault == total_touch_supply       (still equals; both decreased by `claim`)
///   EXPIRED → vault == total_no_touch_supply    (same)
///
/// After ALL winners + ALL LPs have redeemed, vault drains to 0 and the
/// winning supply also reaches 0. The losing supply and reserve remain stranded
/// (correctly — those represent zero-value losing claims).
public fun redeem_lp<C>(
    market: &mut Market<C>,
    lp: LpPosition,
    ctx: &mut TxContext,
): Coin<C> {
    assert!(lp.market_id == object::id(market), E_WRONG_MARKET);
    assert!(lp.shares > 0, E_LP_NO_SHARES);
    assert!(
        market.status == STATUS_HIT || market.status == STATUS_EXPIRED,
        E_LP_STILL_ACTIVE,
    );

    let LpPosition { id, market_id: _, shares } = lp;
    object::delete(id);

    let winning_reserve: u64 = if (market.status == STATUS_HIT) {
        market.touch_reserve
    } else {
        market.no_touch_reserve
    };

    // u128 to avoid overflow: shares (u64) * reserve (u64) can exceed u64 max.
    let claim_128 =
        (shares as u128) * (winning_reserve as u128) / (market.lp_supply as u128);
    let claim = claim_128 as u64;

    market.lp_supply = market.lp_supply - shares;

    if (market.status == STATUS_HIT) {
        market.touch_reserve = market.touch_reserve - claim;
        market.total_touch_supply = market.total_touch_supply - claim;
    } else {
        market.no_touch_reserve = market.no_touch_reserve - claim;
        market.total_no_touch_supply = market.total_no_touch_supply - claim;
    };

    let withdraw = market.collateral_vault.split(claim);
    event::emit(LpRedeemed {
        market_id: object::id(market),
        lp_provider: ctx.sender(),
        shares,
        claim,
    });
    coin::from_balance(withdraw, ctx)
}

// === Test-only constructors ===

/// Mint two perfectly-equal Positions of size N from `payment`. Used by tests
/// that exercise `redeem_complete_set` without going through the AMM (which
/// would produce off-by-one amounts due to fees).
#[test_only]
public fun mint_complete_set_for_testing<C>(
    market: &mut Market<C>,
    payment: Coin<C>,
    ctx: &mut TxContext,
): (Position, Position) {
    let bal = coin::into_balance(payment);
    let n = mint_complete_set(market, bal);
    let mid = object::id(market);
    let touch_pos = Position {
        id: object::new(ctx),
        market_id: mid,
        side: SIDE_TOUCH,
        amount: n,
    };
    let no_touch_pos = Position {
        id: object::new(ctx),
        market_id: mid,
        side: SIDE_NO_TOUCH,
        amount: n,
    };
    (touch_pos, no_touch_pos)
}
