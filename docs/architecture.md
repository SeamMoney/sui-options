# Architecture

## System Components

```text
Move package
  Market object
  Position objects
  AMM accounting
  Settlement functions
  Mock oracle adapter

Frontend
  Market browser
  Create market form
  Trading ticket
  Portfolio and redemption

Keeper
  Watches oracle/indexed prices
  Calls mark_hit when barrier is crossed

Research adapters
  DeepBook Predict testnet API/display
  Future Decibel/Aptos adapter
```

## Market Model

The first implementation should use dynamic Sui objects instead of creating a new `Coin<T>` type for every market.

```move
public struct Market<phantom C> has key {
    id: UID,
    asset_id: vector<u8>,
    direction: u8,
    barrier_price: u64,
    expiry_ms: u64,
    status: u8,
    collateral_vault: Balance<C>,
    touch_reserve: u64,
    no_touch_reserve: u64,
    total_touch_supply: u64,
    total_no_touch_supply: u64,
    lp_supply: u64,
    fee_bps: u64,
}
```

User position object:

```move
public struct Position has key, store {
    id: UID,
    market_id: ID,
    side: u8,
    amount: u64,
}
```

LP position object:

```move
public struct LpPosition has key, store {
    id: UID,
    market_id: ID,
    shares: u64,
}
```

## Lifecycle

### Create

Creator chooses asset, direction, barrier, expiry, and seed collateral.

The contract:

- validates expiry is future
- validates barrier is nonzero
- deposits collateral
- creates equal TOUCH and NO_TOUCH supply
- places both sides into the AMM reserves
- returns an LP position to creator

### Trade

Users buy one side by depositing collateral. Internally this can be modeled as:

1. Deposit collateral.
2. Mint complete set.
3. Send wanted side to user.
4. Send unwanted side to AMM reserve.

Users can also swap one side for the other using CPMM reserves.

### Redeem Complete Set

Before settlement, a user with equal TOUCH and NO_TOUCH can burn both and withdraw collateral.

### Mark Hit

If market is active and oracle price crosses the barrier before expiry, anyone can call `mark_hit`.

Status becomes `HIT`.

### Expire

If market is active and current time is past expiry, anyone can call `settle_expired`.

Status becomes `EXPIRED`.

### Redeem Winner

After settlement:

- `TOUCH` redeems if status is `HIT`.
- `NO_TOUCH` redeems if status is `EXPIRED`.

## Invariants

Primary invariant:

```text
collateral_vault == total_touch_supply == total_no_touch_supply
```

After settlement, redemption drains collateral against the winning-side outstanding amount.

Important safety properties:

- market cannot settle both ways
- settlement is idempotent
- repeated redemption cannot double-pay
- losing side cannot redeem
- complete-set redemption cannot bypass settlement rules

## Oracle Adapter

Use an adapter boundary so the product does not get locked to one integration during the hackathon.

MVP adapter options:

```text
MockOracleAdapter
  deterministic tests and demo fallback

DeepBookPredictAdapter
  production direction: on-chain read if available, indexed price for frontend and keeper
```

The product definition must be explicit:

```text
Touch means oracle-observed touch.
```

