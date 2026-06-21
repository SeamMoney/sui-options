# Wick Markets — Move package (`wick`)

The on-chain contracts for **Wick Markets**: short-dated **touch / no-touch** binary options,
**double-no-touch (DNT)** corridor exotics, a **streaming "Ride"** barrier game, and a
**provably-fair on-chain random-walk arcade** — on Sui.

One published package, single `wick::` address space, Sui Move 2024 edition.

| | |
|---|---|
| **Live (testnet)** | `0x1fdf784743d82c000e84154506e21daedc45bf241818fef6b28635e99e815924` (v4.26) — [SuiScan](https://suiscan.xyz/testnet/object/0x1fdf784743d82c000e84154506e21daedc45bf241818fef6b28635e99e815924) |
| **Build** | `sui move build` → clean (0 errors) |
| **Tests** | `sui move test` → **553 / 553 pass** |

> Addresses for every object (vaults, oracles, markets, registries) live in
> `../deployments/testnet.json` — always read it from disk; the README can lag a redeploy.

## Quick start

```bash
cd move
sui move build      # compile the package
sui move test       # 553 unit + property + conformance tests
```

The conformance suite (`tests/seeded_path_conformance.move`, 200 vectors) proves the on-chain
random walk is **byte-identical** to the TypeScript SDK (`../sdk`), so the provably-fair arcade
can be replayed and verified off-chain without trusting any indexer.

## The load-bearing invariant

After **every** state transition in a Wick-native market:

```
collateral_vault == total_touch_supply == total_no_touch_supply
```

The vault/market test suites (`tests/martingaler_vault_tests.move`, `tests/market_tests.move`,
`tests/segment_market_v4_tests.move`, …) assert it after each transition. Bugs here are direct
loss-of-funds, so the full suite must pass before any commit.

## Safety properties the package enforces

- A market cannot settle both ways (HIT and EXPIRED are mutually exclusive; likewise DNT_HELD vs DNT_BROKEN).
- Settlement is idempotent — repeat calls are no-ops or revert, never re-mutate.
- `redeem` cannot double-pay (the `Position` UID is consumed on payout); the losing side cannot redeem.
- `lock_and_settle` is atomic — snapshot, status, fee accrual, and lock release commit in one tx.
- Aborted markets refund 1:1, never 2:1. Ride: touch wins ties at the `close_ride` boundary; aborted refund is 1:1.

## Lifecycle

```
bootstrap_vault → seed_vault                       # once per collateral
bootstrap_*_market (touch / no-touch / dnt)        # per market
  → open            (depositor stakes into a Position)
  → tick            (keeper records oracle ticks into PathObservation)
  → lock_and_settle (permissionless; atomic snapshot + status + lock release)
  → redeem          (winner burns Position, vault pays out)

# streaming Ride:        open_ride → (close_ride | crank_expired_ride)
# provably-fair arcade:  segment_market_v4 — round-based shared barriers, touch-either window
```

## Modules (26)

**Market core** — `market` (touch/no-touch, shared `MartingalerVault<C>`), `path_observation`
(oracle-tick → barrier-cross outcome, buffer + deadband anti-jitter, single & DNT), `vault`
(generic per-market collateral vault).

**Loss-recycling LP vault, fees & risk** — `martingaler_vault` (one mega-pool per collateral,
bootstraps from trader losses, FIFO debt queue, per-market settlement locks), `fee_router`
(LP / protocol / staker / insurance buckets), `impact_fee` (asymmetric, charged only on winning
closes), `risk_config` (parameter registry with Move-enforced bounds).

**Exposure & safety registries** — `global_exposure_registry` (probability-weighted OI cap;
kills cross-market barrier-stacking), `bot_registry` (mint-exclusion list), `oracle_version_lock`
(pins the DeepBook Predict version the BTC route trusts; fail-closed on upgrade).

**Oracle layer (driver-agnostic)** — `wick_oracle` (per-market registry), `price_observation`
(the one value-type every driver emits), `pull_oracle_driver` (keeper-pushed signed feed),
`random_walk_driver` (synthetic on-chain price for 24/7 markets), `usd_price_oracle` (micro-USD
collateral pricing for ride stake-rates).

**Probability** — `probability` (Bachelier first-passage; shared by the OI cap, impact fee, and ride cashout).

**Ride — streaming touch** — `ride_position` (stake accrues per-second while held), `ride_pricing`
(Bachelier cashout factor), `ride_market_caps` (per-market concurrent-escrow caps).

**Provably-fair arcade** — `seeded_path` (deterministic commit–reveal price walk, TS↔Move identical),
`segment_market` (round-based shared barriers), `segment_market_v4` (touch-either + always-open window,
with the per-segment rug-pull house edge).

**WICK token & staking** — `wick_token` (fair-launch fee-claim token), `wick_staking` (stake WICK
for protocol-fee dividends), `wick` (top-level orchestration).

**v3 roadmap (landed, gated)** — `sponsor` (sponsored-cranking gas tank — players crank with no gas
of their own).

See `../AGENTS.md` for the full object model and `../docs/design/v2/` for per-feature design specs.
