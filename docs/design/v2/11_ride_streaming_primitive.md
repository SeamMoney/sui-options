# Streaming Touch Ride Primitive (v2)

> **Status:** v2 design. Self-contained spec for implementers.
> **Scope:** Arcade markets only (random-walk). Discrete touch options remain
> on BTC/SUI/SP500 markets unchanged.
> **Pairs with:** `01_martingaler_accounting_v2.md`, `02_asymmetric_impact_fee_v2.md`,
> `04_solvency_v2.md`, `05_path_observation_v2_hardened.md`,
> `00_reconciliation.md`.

---

## 1. What it is

A streaming touch option primitive. The user opens a "ride" by committing
to pay a per-second stake rate; the position exists only while held; payout
is **fixed at multiplier × accumulated_stake** if the barrier is touched
during the hold window, **cashout × accumulated_stake × live_factor** on
voluntary release, **zero** if held past round end without touch.

The math is the same digital-touch payoff structure as our discrete
options. The novelty is *continuous early exercise with streaming premium*
— the user's position renews itself each tick.

This is NOT a perp. The payoff is binary (touch or not). The "ride" is a
metaphor for the continuous-premium-payment model, not for linear PnL.

## 2. Module inventory

```
NEW:
  wick::ride_position       (~250 LOC)   Position object + lifecycle
  wick::ride_pricing        (~150 LOC)   Bachelier cashout factor in u64 fixed-point
  wick::ride_market_caps    (~100 LOC)   Per-market concurrent-stake cap enforcement

MODIFIED:
  wick::market              add `is_streaming: bool` + stake_rate config
  wick::path_observation    expose `touched_at` for ride consumption (already done)
  wick::martingaler_vault   accept ride payouts via standard payout flow
  wick::wick_token          mint on forfeit portion of ride

KEEPER:
  ride_settler              cranks expired rides for storage rebate
```

Total new Move: ~500 LOC. Total modifications: ~100 LOC.

## 3. Types

```move
module wick::ride_position;

use std::type_name::TypeName;
use sui::clock::Clock;

public struct RidePosition has key, store {
    id: UID,
    user: address,
    market_id: ID,
    path_id: ID,
    /// Payout multiplier on touch, fixed at market-create. e.g. 30_000 = 3.0x.
    multiplier_bps: u64,
    /// User-chosen rate, e.g. 1_000_000 (1e6 micro-USD = $1/sec) up to a cap.
    stake_rate_micro_usd_per_sec: u64,
    /// Wall-clock open time.
    start_time_ms: u64,
    /// Vault-escrowed maximum the user authorized at open (>= max possible accumulated stake).
    escrowed: u64,
    /// Settlement type once closed.
    closed: bool,
    closed_at_ms: u64,
    /// Captured at close — never read live state after this point (see §5).
    settlement_kind: u8,    // 0=open, 1=touch_win, 2=cashout, 3=expired_loss
    collateral: TypeName,
}

/// Lightweight per-market state extending Market<C>.
public struct RideMarketState has store {
    is_streaming: bool,
    /// Max sum of escrowed across all open rides on this market.
    max_concurrent_escrow: u64,
    /// Live tracker, updated on open/close.
    current_concurrent_escrow: u64,
    /// Min/max stake rates user can pick.
    min_stake_rate: u64,
    max_stake_rate: u64,
    /// Volatility constant for Bachelier pricing (annualized, bps).
    sigma_bps: u64,
    /// Cashout spread that goes to vault. e.g. 500 bps = 5% LP edge per cashout.
    cashout_spread_bps: u64,
}
```

## 4. State machine

```
                                    ┌────────────┐
                  open_ride()       │            │
   user ───────────────────────►   │   OPEN     │
                                    │            │
                                    └──────┬─────┘
                                           │
              ┌────────────────────────────┼────────────────────────────┐
              │                            │                            │
   ┌──────────▼─────────┐    ┌─────────────▼─────────────┐    ┌─────────▼──────────┐
   │ touch_fires_during │    │   user calls close_ride() │    │ market expires +   │
   │   user's window    │    │   while holding           │    │ user still holding │
   └──────────┬─────────┘    └─────────────┬─────────────┘    └─────────┬──────────┘
              │                            │                            │
              ▼                            ▼                            ▼
        ┌──────────┐               ┌──────────────┐             ┌────────────────┐
        │ TOUCH    │               │   CASHOUT    │             │ EXPIRED_LOSS   │
        │ payout = │               │ payout =     │             │ payout = 0     │
        │ stake ×  │               │ stake_paid × │             │ stake_paid     │
        │ mult     │               │ live_factor  │             │ forfeit        │
        │          │               │ × (1-spread) │             │                │
        └──────────┘               └──────────────┘             └────────────────┘
```

Settlement kind is captured at close. Once `closed = true`, the position is
frozen and only consumes one more tx to burn + return Coin.

## 5. The race-condition rule (load-bearing)

The single race we have to spec: user calls `close_ride()` in the same
checkpoint that an oracle tick lands which would set `path.touched_at`.

**Rule:** *Touch wins ties.* Specifically: `close_ride()` reads
`path.touched_at`. If `touched_at` is Some AND
`touched_at >= ride.start_time_ms`, then settlement is TOUCH regardless of
user's intent. The user receives `escrowed × multiplier_bps / 10_000`.

This is enforceable because Sui's object model serializes reads — the
on-chain tick processing that sets `touched_at` runs in the same checkpoint
BEFORE any tx that reads the resulting state. The user cannot "snipe-cash-out"
right at a touch firing.

We document this in the UI: *"Touch always wins. If the line fires while
you hold, you win — even if you tried to release at the same moment."*

## 6. Key functions

### 6.1 Opening a ride

```move
public fun open_ride<C>(
    market: &mut Market<C>,
    path: &PathObservation,
    rate_micro_usd_per_sec: u64,
    max_escrow: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): RidePosition {
    // Preconditions
    assert!(market.is_streaming(), ENotStreaming);
    assert!(rate_micro_usd_per_sec >= market.min_rate(), ERateTooLow);
    assert!(rate_micro_usd_per_sec <= market.max_rate(), ERateTooHigh);
    assert!(clock.timestamp_ms() < path.expiry_ms(), EAfterExpiry);
    assert!(!path.is_aborted(), EPathAborted);

    let escrow_amount = max_escrow.value();
    // The escrowed amount must cover worst-case stake_paid if held to expiry
    let max_seconds = (path.expiry_ms() - clock.timestamp_ms()) / 1000;
    let max_stake_at_expiry = mul_div(rate_micro_usd_per_sec, max_seconds, 1_000_000);
    assert!(escrow_amount >= max_stake_at_expiry, EInsufficientEscrow);

    // Concurrent-escrow cap check (per-market)
    let new_total = market.ride_state().current_concurrent_escrow + escrow_amount;
    assert!(new_total <= market.ride_state().max_concurrent_escrow, EMarketRideCapExceeded);

    // Move escrow into vault
    martingaler_vault::deposit_ride_escrow<C>(vault, max_escrow);
    market.ride_state_mut().current_concurrent_escrow = new_total;

    RidePosition {
        id: object::new(ctx),
        user: ctx.sender(),
        market_id: object::id(market),
        path_id: object::id(path),
        multiplier_bps: market.payout_multiplier_bps(),
        stake_rate_micro_usd_per_sec: rate_micro_usd_per_sec,
        start_time_ms: clock.timestamp_ms(),
        escrowed: escrow_amount,
        closed: false,
        closed_at_ms: 0,
        settlement_kind: 0,
        collateral: type_name::with_defining_ids<C>(),
    }
}
```

### 6.2 Voluntary close (the cashout path)

```move
public fun close_ride<C>(
    ride: &mut RidePosition,
    market: &mut Market<C>,
    path: &PathObservation,
    oracle: &WickOracle,
    vault: &mut MartingalerVault<C>,
    fee_router: &mut FeeRouter<C>,
    token_state: &mut WickTokenState,
    clock: &Clock,
    ctx: &TxContext,
): Coin<C> {
    assert!(!ride.closed, EAlreadyClosed);
    let now = clock.timestamp_ms();
    let elapsed_sec = (now - ride.start_time_ms) / 1000;
    let stake_paid = mul_div(ride.stake_rate_micro_usd_per_sec, elapsed_sec, 1_000_000);
    let stake_paid_capped = std::u64::min!(stake_paid, ride.escrowed);

    // RACE-RESOLUTION RULE: touch wins ties
    let (payout, kind) = if (path::touched_during(path, ride.start_time_ms, now)) {
        // Touch fires during window
        let p = mul_div(stake_paid_capped, ride.multiplier_bps, 10_000);
        (p, 1u8)  // touch_win
    } else if (now >= path::expiry_ms(path)) {
        // Expired without touch — full forfeit
        (0, 3u8)  // expired_loss
    } else {
        // Cashout at live factor
        let spot = oracle::latest_price(oracle);
        let factor = ride_pricing::bachelier_cashout_factor(
            spot,
            path::barrier(path),
            market.ride_state().sigma_bps,
            (path::expiry_ms(path) - now) / 1000,
        );  // returns 1e9 fixed-point
        let live_payout = mul_div(stake_paid_capped, factor, 1_000_000_000);
        let live_payout_after_spread = mul_div(
            live_payout,
            10_000 - market.ride_state().cashout_spread_bps,
            10_000,
        );
        // Apply max(live_payout_after_spread, refund_floor) to never pay <0
        // Apply min(payout, stake_paid_capped × multiplier) to bound upside
        let p = std::u64::min!(
            mul_div(stake_paid_capped, ride.multiplier_bps, 10_000),
            live_payout_after_spread,
        );
        (p, 2u8)  // cashout
    };

    // Settle: payout to user, remainder of escrow back to vault, premium to fee_router
    let forfeit = ride.escrowed - payout;
    let payout_coin = martingaler_vault::withdraw_for_ride_settlement<C>(vault, payout, ctx);

    // Fee routing: spread captured for LP/staker/insurance buckets per fee_router
    fee_router::accrue<C>(fee_router, ride.market_id, forfeit);

    // WICK mint on the forfeit portion (proportional to loss)
    let collateral_loss_usd = mul_div_pyth_normalize<C>(forfeit);
    wick_token::mint_to_loser(
        token_state,
        ride.user,
        collateral_loss_usd,
        clock,
    );

    market.ride_state_mut().current_concurrent_escrow =
        market.ride_state().current_concurrent_escrow - ride.escrowed;

    ride.closed = true;
    ride.closed_at_ms = now;
    ride.settlement_kind = kind;

    payout_coin
}
```

### 6.3 Crank expired rides (permissionless)

```move
/// Anyone can crank a position whose market has expired and user hasn't closed.
/// Awards a small gas bounty from the forfeit.
public fun crank_expired_ride<C>(
    ride: &mut RidePosition,
    market: &mut Market<C>,
    path: &PathObservation,
    vault: &mut MartingalerVault<C>,
    fee_router: &mut FeeRouter<C>,
    token_state: &mut WickTokenState,
    clock: &Clock,
    ctx: &TxContext,
): Coin<C> {
    assert!(!ride.closed, EAlreadyClosed);
    let now = clock.timestamp_ms();
    assert!(now >= path::expiry_ms(path), ENotExpired);

    // Same settlement logic as close_ride, but bounty splits 50 bps to caller
    // ...
}
```

## 7. Bachelier cashout factor

```move
module wick::ride_pricing;

/// Returns the cashout factor in 1e9 fixed-point.
/// factor = 2 × Φ(-|barrier - spot| / (σ × sqrt(seconds_remaining)))
/// where σ is the per-second volatility derived from market.sigma_bps.
public fun bachelier_cashout_factor(
    spot: u64,
    barrier: u64,
    sigma_bps: u64,        // basis-points per √second
    seconds_remaining: u64,
): u64 {
    if (seconds_remaining == 0) return 0;

    // distance in barrier-units
    let dist = if (spot > barrier) spot - barrier else barrier - spot;

    // sigma × sqrt(seconds)
    let sqrt_seconds = isqrt_u64(seconds_remaining);
    let sigma_total = mul_div(sigma_bps, sqrt_seconds, 1);

    // z = dist / sigma_total, scaled to lookup-table index
    let z_bps = mul_div(dist, 10_000, sigma_total);

    // 2 × Φ(-z) from 32-entry lookup
    let phi_neg = phi_negative_lookup(z_bps);
    mul_div(phi_neg, 2, 1)
}

/// 32-entry lookup for Φ(-z) where z is in bps.
/// Reuses the table from solvency_v2 §4.
fun phi_negative_lookup(z_bps: u64): u64 {
    // identical to GlobalExposureRegistry's first-passage lookup
    // ...
}
```

## 8. Risk parameters

| Parameter | Value | Rationale |
|---|---|---|
| `max_concurrent_escrow_per_market` | `vault.V_eff × 5%` | Bounded fraction of vault at risk per market simultaneously |
| `max_per_user_per_market` | `vault.V_eff × 0.5%` | Anti-whale per user |
| `min_stake_rate` | $0.50/sec | Below this, gas dominates |
| `max_stake_rate` | $10/sec | Anti-whale per second |
| `multiplier_bps` | 30_000 (3.0x) | Default; per-market configurable |
| `cashout_spread_bps` | 500 (5%) | LP edge on each cashout |
| `sigma_bps_per_sqrt_sec` | derived per market | Random-walk markets have known σ; real markets use rolling estimate |
| `gas_bounty_bps` | 50 (0.5%) | Of forfeit, paid to crank caller |

## 9. Integration with existing modules

**`martingaler_vault`** (1 new function):
```move
public fun deposit_ride_escrow<C>(vault: &mut MartingalerVault<C>, coin: Coin<C>);
public fun withdraw_for_ride_settlement<C>(...): Coin<C>;
```
Escrow is held in `treasury` (not `settlement_lock` — those are for discrete
markets only). Withdrawal goes through standard auto-harvest flow (queue-head
priority preserved).

**`fee_router`** unchanged. Cashout spread routes through standard accrue.
Forfeit on expired loss routes through accrue as well.

**`wick_token`**: mint event fires on the forfeit portion of every closure
that isn't a touch win. Mint amount uses Pyth-snapshotted USD value of
forfeit per `wick_tokenomics_v2.md §6`.

**`path_observation v2`**: needs one new helper:
```move
public fun touched_during(
    path: &PathObservation,
    start_time_ms: u64,
    end_time_ms: u64,
): bool {
    match (&path.touched_at) {
        option::some(t) => *t >= start_time_ms && *t <= end_time_ms,
        option::none => false,
    }
}
```
This is just a read on existing state. No new write logic.

**`market.move`**: add `RideMarketState` field. New constructor variant
`create_streaming_market<C>(...)` distinguishes from `create_market<C>`. The
existing discrete open/close paths assert `!is_streaming`. The ride paths
assert `is_streaming`.

## 10. Edge cases

| Case | Resolution |
|---|---|
| User opens ride with rate > max_rate | abort `ERateTooHigh` |
| User opens with insufficient escrow | abort `EInsufficientEscrow` |
| Market is in `Aborted` state | abort `EPathAborted` at open; close pays 1:1 refund |
| Market wind-down active per solvency v2 §6 | abort new opens; existing rides can close normally |
| User holds across path-observation `record_range` post-expiry | only ticks < expiry count for touched_during; clamped |
| Multiple rides from same user on same market | allowed up to `max_per_user_per_market` cap |
| Ride object transferred to another wallet | new holder can close; payout goes to new holder |
| Path enters `Aborted` while ride is open | close pays back escrow 1:1, no spread |
| sigma_bps misconfigured to 0 | abort at market create |
| User opens with 0 escrow | abort `EZeroAmount` |
| Concurrent crank + close in same checkpoint | crank reverts after close lands (object already mutated) |

## 11. Test plan (15 tests)

1. open_ride mints position with correct fields
2. close_ride before touch returns cashout factor × stake_paid
3. close_ride after touch returns max payout (touch_win)
4. close_ride after expiry returns zero (expired_loss)
5. concurrent-escrow cap reverts excess opens
6. per-user cap reverts second open beyond cap
7. race-resolution: close_ride in same checkpoint as touch tick → touch wins
8. crank_expired_ride pays bounty to caller, settles position
9. invalid rate (above max) reverts
10. insufficient escrow reverts
11. Aborted path → refund 1:1 on close
12. wind-down active → new opens reject, existing can close
13. WICK minted proportional to forfeit
14. multiple rides per user accounted correctly
15. cashout_factor monotonically decreases as time → expiry (no touch case)

## 12. Implementation order

Phase A.5 (after Phase A.4 fee_router):
1. `wick::ride_pricing` — Bachelier formula + lookup. Standalone. Testable in isolation.
2. `wick::ride_market_caps` — concurrent-escrow cap struct + asserts.
3. `wick::ride_position` — open/close/crank entry points.
4. `path_observation::touched_during` helper.
5. `market::create_streaming_market` constructor variant.
6. Integration tests with all 15 scenarios.

Phase C.4 (after Phase C.3 market refactor):
7. SDK functions: `buildOpenRideTx`, `buildCloseRideTx`.
8. Frontend ride hooks: `useRidePosition`, `useLiveCashoutFactor` (computes
   factor client-side for display; contract authoritative on close).
9. Gesture UI from `01_degen_simple_mode_v2.md` wired to ride lifecycle.
10. Tournament markets configured as streaming.

Estimated effort: 8-12 hours Move work, 6-8 hours frontend work.

## 13. What this doesn't change

- Discrete markets (BTC, SUI, SP500) operate unchanged per `01_martingaler_v2.md`.
- Predict route (BTC via DeepBook) unchanged. Predict is round-bound discrete only.
- Fee router buckets, WICK mint curve, threat model — all unchanged.
- Tournament structure unchanged (tournaments are random-walk → streaming).
- CLOB secondary market is for discrete positions only. RidePositions are
  `key, store` so they can be transferred but not Coin-typed.
