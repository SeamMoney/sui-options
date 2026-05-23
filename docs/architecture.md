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

## v3 architecture (design-only — not yet on testnet)

> Status: design locked 2026-05-23, implementation pending. The v2
> components described above remain the live shipped surface. v3 adds
> three new pieces alongside v2 (no breaking changes to existing
> markets). Full specs: [`design/v2/22_sponsored_cranking_v3.md`](design/v2/22_sponsored_cranking_v3.md),
> [`design/v2/23_storage_rebate_pruning_v3.md`](design/v2/23_storage_rebate_pruning_v3.md),
> [`design/v2/24_walrus_archive_v3.md`](design/v2/24_walrus_archive_v3.md).

### Sponsored cranking (doc 22)

A new `wick::sponsor` Move module + `wick::segment_market_v3` market
type + `/api/sponsor` Vercel function. Users sign their open / close /
crank intents from a burner; the sponsor service co-signs as
`gas_owner` so the sponsor wallet (funded from
`fee_router::protocol_bucket` via permissionless `harvest_to_sponsor`)
pays all cranking gas. Allowlist + per-sender rate limit + daily spend
cap enforce safety. Result: user pays $0 cranking gas.

### Storage rebate pruning (doc 23)

`segment_market_v3::prune_settled_segments` is a permissionless Move
entry that deletes a settled round's `SegmentRecord` entries from the
on-chain Table. Sui's storage rebate (~99% of write cost) pays the
caller, giving the pruner a net positive ~74M MIST per round —
self-incentivizing maintenance with no operator action. Storage stays
bounded (the only unbounded growth is a tiny `pruned_rounds: Table<u64,
bool>` marker at ~8 bytes per round).

### Walrus archive (doc 24)

Before each round's segments are pruned, an archiver bot serializes
them (BCS) and writes a single ~3-12 KB blob to **Walrus** — Sui's
decentralized blob storage. The blob ID lands on-chain via
`record_walrus_archive(round_index, walrus_blob_id)` and is stored in
`ArchiveIndex: Table<u64, vector<u8>>` (lives forever, ~40 bytes per
round). `/verify` reads from on-chain for the last few rounds (hot
path) and from Walrus for older rounds. v3.1+ enforces the
**archive-before-prune** invariant in Move (`assert!(contains(archive_index,
round))` before delete) so on-chain history cannot be lost.

### v3 lifecycle

```
bootstrap_segment_market_v3       (one-shot per collateral)
  → open_segment_ride             (user-signed, sponsor-paid gas)
  → record_segment ×N             (sponsor-paid gas, every ~400 ms)
  → close_segment_ride            (user-signed, sponsor-paid gas)
  → harvest_to_sponsor            (permissionless refill from fees)
  → record_walrus_archive(N)      (archiver bot, per round, ~3-12 KB blob)
  → prune_settled_segments(N)     (permissionless; net +74M MIST to caller)
```

The full v3 economic model (per-round costs, sponsor budget,
archiver-bot profit) is in doc 24 §7. v3 ships alongside v2 — no
breaking change to existing markets or positions; v2 markets settle
naturally and v3 markets become the default for new bootstraps once
the rollout completes.

