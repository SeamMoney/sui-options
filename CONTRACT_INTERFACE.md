# Wick Markets — Contract Interface

The **judge- and frontend-facing seam** for the Wick Move package
(`move/sources/`). Generated from the real code (`wick.move` facade +
`AGENTS.md`/`docs/architecture.md` as the architectural source of truth). The
frontend and keeper call the entry functions and read the events defined here.

> Addresses change on redeploy — always read `deployments/testnet.json` from
> disk as the runtime source of truth. The IDs below are a snapshot.

## What Wick is

Short-dated, oracle-observed **barrier options on Sui**:

- **Touch / No-Touch** — does the underlying *wick* into a barrier before expiry?
  `TOUCH` wins on a hit; `NO_TOUCH` wins if the barrier is never touched.
- **Double-No-Touch (DNT)** — a corridor: wins if price stays between two
  barriers (`STATUS_DNT_HELD`), loses if either is broken (`STATUS_DNT_BROKEN`).
- **Ride** — a streaming-touch primitive that lives only while you hold the
  screen: stake accrues per-second; a barrier touch wins, cash-out or expiry
  ends it.

Counterparty is the **MartingalerVault** (a loss-recycling LP vault), not a
peer pool. "Touch" means **the oracle's** buffered + deadbanded observation
crossed the barrier — not any off-chain tick.

## Deployed (Sui testnet) — snapshot of `deployments/testnet.json`

| | |
|---|---|
| Package | `0x1fdf784743d82c000e84154506e21daedc45bf241818fef6b28635e99e815924` |
| Publisher | `0xfad710377f820b10097f7ac445bc56e738db2bce712f898072061e0591049455` |
| Vault (SUI) | `0x73d3a17ab1e1cdc173b8cde1ae7d9789a29d1a177ebfd415196a04a6a10e5b9f` |
| Vault admin cap | `0x90245d7d154095c75dc07aa6d815d9b4df694d5a90c948a4be4f68914016b12c` |
| Coin type `C` | `0x2::sui::SUI` (markets/vault are generic over collateral `C`) |
| Clock | `0x6` |

Arcade markets (`arcade_markets[]`) ship as random-walk markets, each with its
own `market` / `oracle` / `path` / `random_walk` object IDs, e.g. `WICK-RNG-25`
(barrier 26000000, dir 0), `WICK-RNG-100` (95000000, dir 1), `WICK-RNG-1000`
(1030000000, dir 0, has `ride_caps`). Read the file for the live set.

## Object model (see `docs/architecture.md` for full structs)

- `Market<phantom C>` (`key`) — supply totals, status, payout multiplier, sigma,
  fee snapshot; references its `MartingalerVault` + `PathObservation` by `ID`.
- `Position` (`key, store`) — `side`, `stake`, `payout_if_win`, `pwe_at_open`;
  consumed on redeem (so a winner can't double-pay).
- `RidePosition` (`key, store`) — streaming touch; `multiplier_bps`,
  `stake_rate_micro_usd_per_sec`, `escrowed`, settlement enum
  (`OPEN / TOUCH_WIN / CASHOUT / EXPIRED_LOSS / ABORTED_REFUND`).
- `PathObservation` (`key`, shared) — oracle barrier-cross record with
  `buffer_bps` + `deadband_bps` anti-jitter; `new`/`new_dnt*` constructors.
- `MartingalerVault<C>` (`key`) — treasury, side buckets, per-market settlement
  locks + abort pools, FIFO claim queue, fee buckets.
- `RiskConfig`, `FeeRouter<C>`, `GlobalExposureRegistry`, `BotRegistry`,
  `WickOracle`, `UsdPriceOracle`, `RideMarketCaps`, `WickTokenState`,
  `WickStakingPool` — global/per-collateral support objects.

## Lifecycle

```
bootstrap_vault → seed_vault                       // once per collateral C
bootstrap_random_walk_market | bootstrap_pull_market   // per market
  → open_touch / open_no_touch  (stake → Position)     // many traders
  → (keeper ticks the oracle into PathObservation)
  → lock_and_settle             (permissionless, atomic)
  → redeem                      (winner burns Position; vault pays)
Rides:  open_ride → (close_ride | crank_expired_ride)
```

## Entry functions — `wick::wick` facade (exact signatures)

```move
// --- vault (admin bootstrap) ---
public entry fun bootstrap_vault<C>(ctx)                       // → VaultAdminCap to sender
public entry fun seed_vault<C>(vault: &mut MartingalerVault<C>, seed: Coin<C>, clock, ctx)

// --- market creation (admin) ---
public entry fun bootstrap_random_walk_market<C>(             // synthetic-RNG arcade market
  name, underlying, starting_price, vol_bps, barrier, direction, expiry_ms,
  settlement_freshness_ms, payout_multiplier_bps, correlation_bucket_id,
  vault_side, vault: &MartingalerVault<C>, clock, ctx)
public entry fun bootstrap_pull_market<C>(                    // keeper-fed (BTC/ETH/SUI/SP500)
  name, underlying, upstream_id, keeper_cap: &KeeperCap, barrier, direction,
  expiry_ms, settlement_freshness_ms, payout_multiplier_bps, correlation_bucket_id,
  vault_side, vault: &MartingalerVault<C>, ctx)

// --- trade ---
public fun open_touch<C>(market, vault, risk_config, registry, bot_registry,
  path, stake: Coin<C>, spot, clock, ctx): Position           // side = TOUCH
public fun open_no_touch<C>(/* same args */): Position         // side = NO_TOUCH
public fun redeem<C>(market, vault, risk_config, fee_router, wick_state,
  staking_pool, price_oracle, position: Position, clock, ctx): Coin<C>

// --- settle (permissionless, atomic snapshot + status + lock release) ---
public fun lock_and_settle<C>(market, vault, path, oracle, registry, clock, ctx)
public fun recover_aborted_seed<C>(cap: &VaultAdminCap, vault, market)  // admin anti-rug

// --- ride (streaming touch) ---
public fun open_ride<C>(caps: &mut RideMarketCaps, path, vault, bot_registry,
  rate_micro_usd_per_sec, escrow: Coin<C>, clock, ctx): RidePosition
public fun close_ride<C>(ride, caps, path, oracle, vault, price_oracle,
  token_state, staking_pool, clock, ctx): Coin<C>
public fun crank_expired_ride<C>(ride, caps, path, vault, price_oracle,
  token_state, staking_pool, clock, ctx): Coin<C>
```

Sides: `market::side_touch()`, `market::side_no_touch()` (=1),
`market::vault_side_none()` (=255, allow both sides). `direction` selects which
crossing of `barrier` counts as a touch.

**Segment-market arcade + v3/v4:** the facade also exposes
`bootstrap_segment_market[_v3|_v4]`, `open/close/crank/abort_segment_ride[_v3|_v4]`,
`record_segment*`, and (design-only, **not yet on testnet**)
`record_walrus_archive_*` / `prune_settled_segments_*` / `harvest_to_sponsor`.
Per AGENTS.md, the **shipped v2 surface is the list above**; treat v3 sponsor /
Walrus / pruning as roadmap.

## Events (subscribe for the live feed / `/verify`)

`MarketCreated`, `PositionOpened`, `BarrierTouched`, `OracleSettled`,
`MarketSettled`, `PositionRedeemed`, `RideOpened`, `RideClosed`,
`LockInitialized`, `PathSettlementLocked`, `SettlementLockReserved`,
`SettlementLockReleased`, `AbortRefundPoolFunded`, `AbortRefundClaimed`,
`SegmentMarketCreated` — all `copy, drop`.

## Settlement & payout

- A `Position` fixes `payout_if_win` at open (from the market's
  `payout_multiplier_bps` and the probability-weighted entry `pwe_at_open`). On
  settle the winning side redeems `payout_if_win`; the losing side gets nothing.
  The **MartingalerVault** is the counterparty and absorbs the PnL.
- Status is mutually exclusive — touch settles `HIT` xor `EXPIRED`; DNT settles
  `DNT_HELD` (5) xor `DNT_BROKEN` (6). Settlement is **atomic + idempotent**.
- Fees route via `FeeRouter` into protocol / staker / insurance buckets; the DNT
  path adds an asymmetric **impact fee** (`decisiveness_bps_for_side`).
- **Aborted** markets refund depositors **1:1** (never 2:1); admin can recover
  only stranded seed back to the vault treasury.

## Safety invariants (load-bearing — enforced + tested)

- **Collateral invariant**, after every transition:
  `collateral_vault == total_touch_supply == total_no_touch_supply`
  (`move/tests/invariants.move`). Violations are direct loss-of-funds.
- A market cannot settle both ways; settlement is idempotent; redeem consumes the
  `Position` UID so it can't double-pay; the losing side cannot redeem;
  `lock_and_settle` commits snapshot + status + fee + lock-release atomically.
- Rides: touch wins ties at the `close_ride` boundary; aborted refund is 1:1.

## Build / test

```bash
cd move && sui move test            # the invariant + DNT + probability suites
./scripts/agent-preflight.sh        # gate: sui move test + frontend/keeper tsc --noEmit
```

The deployed package corresponds to this source. Demo is **testnet only**.
