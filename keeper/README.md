# Wick Keeper

Permissionless cranking daemon for [Wick Markets](../README.md). Targets the
**post-C.3 Move ABI**: `random_walk_driver::tick`, `pull_oracle_driver::push_price`,
`wick::lock_and_settle<C>`, and `wick::crank_expired_ride<C>`.

The keeper is permissionless on chain — anyone can run one. It holds its own
keypair only to pay gas; it never touches LP shares or user positions.

## What it does, per 2-second tick

1. **Arcade markets** (random-walk underlying): one PTB per market that
   `random_walk_driver::tick`s the PRNG and `path_observation::record`s the
   new observation.
2. **Pull-oracle markets** (BTC, SUI): fetches a live price from Coinbase
   (`/v2/prices/<PAIR>/spot`), then one PTB that `pull_oracle_driver::push_price`s
   and `path_observation::record`s.
3. **Drain window** (`[expiry, expiry+5s)`): calls
   `path_observation::record_during_drain` so any mempool-delayed pre-expiry
   ticks land before snapshot lock.
4. **Settlement**: once `now >= expiry + drain_ms`, calls
   `wick::lock_and_settle<C>`. The Move side is idempotent — repeat calls
   on already-settled markets return early.
5. **Expired rides**: for known `RidePosition` IDs (see below), if the
   barrier did NOT touch during the ride window, calls
   `wick::crank_expired_ride<C>` and collects the 50-bps bounty.

## Setup

```bash
cd keeper
npm install
```

Provide a signer one of two ways:

```bash
# preferred (CI / hackathon)
export KEEPER_PRIVATE_KEY_HEX=<32-byte hex, no 0x prefix>

# OR (dev)
npm run setup-key   # writes ./.keeper-key.json
```

Fund the address with at least 0.5 SUI on testnet (each tick costs
~0.05 SUI; settlement ~0.3 SUI).

## Running

```bash
# one-shot (CI / cron) — exits 1 on any tx failure
npm run tick

# long-running daemon — recommended for testnet demos
npm run watch
```

Health endpoint: `GET http://localhost:8080/healthz` returns
`{ ok, last_tick_ms, errors_last_5m, package_id, network, address }`.

## Required object IDs

The keeper reads market info from `deployments/testnet.json` (the artifact
written by `scripts/seed-arcade-markets.sh`). For `lock_and_settle` and
ride cranks it also needs these shared singleton IDs — provided via either
the manifest or env vars:

| Manifest field         | Env override                      | Needed for                |
|------------------------|-----------------------------------|---------------------------|
| `vault_sui`            | `WICK_KEEPER_VAULT`               | settlement, ride crank    |
| `registry`             | `WICK_KEEPER_REGISTRY`            | settlement                |
| `risk_config`          | `WICK_KEEPER_RISK_CONFIG`         | (reserved)                |
| `bot_registry`         | `WICK_KEEPER_BOT_REGISTRY`        | (reserved)                |
| `fee_router_sui`       | `WICK_KEEPER_FEE_ROUTER`          | (reserved)                |
| `usd_price_oracle`     | `WICK_KEEPER_USD_PRICE_ORACLE`    | ride crank                |
| `wick_token_state`     | `WICK_KEEPER_WICK_STATE`          | ride crank                |
| `staking_pool`         | `WICK_KEEPER_STAKING_POOL`        | ride crank                |
| `keeper_cap`           | `WICK_KEEPER_CAP`                 | pull-oracle pushes        |

If a required ID is missing, the keeper will log a structured error and
skip that action — other markets continue to settle.

## Pull-oracle markets

The seed script doesn't yet record pull markets. Drop a sidecar JSON file
and point the keeper at it:

```bash
export WICK_KEEPER_PULL_MARKETS_PATH=deployments/pull-markets.testnet.json
```

Shape:

```json
[
  {
    "name": "WICK-BTC-100k",
    "market":   "0x...",
    "oracle":   "0x...",
    "path":     "0x...",
    "feed":     "0x...",
    "upstream": "coinbase:BTC-USD",
    "decimals": 6,
    "expiry_ms": 1763517600000
  }
]
```

## Ride cranking (v1 limitation)

`RidePosition` is an owned object, so the keeper cannot enumerate "all open
rides on chain" via plain RPC. v1 supports a comma-separated owner allowlist
that the keeper polls each tick:

```bash
export WICK_KEEPER_RIDES_OWNERS=0xowner1,0xowner2
```

For full coverage, a side-table indexer reading `RideOpened` events is
needed — flagged in the source. The Move side has the load-bearing checks
(`touched_during`, treasury sufficiency, `EAlreadyClosed`); the keeper just
schedules attempts.

## All env vars

| Var                                  | Default                                  | Notes |
|--------------------------------------|------------------------------------------|-------|
| `KEEPER_PRIVATE_KEY_HEX`             | (none)                                   | preferred signer |
| `WICK_KEEPER_KEY_PATH`               | `./.keeper-key.json`                     | dev fallback signer |
| `WICK_KEEPER_DEPLOYMENT_PATH`        | `<repo>/deployments/testnet.json`        | override manifest path |
| `WICK_KEEPER_PULL_MARKETS_PATH`      | (none)                                   | sidecar pull-market list |
| `WICK_KEEPER_RPC`                    | derived from network                     | override RPC URL |
| `WICK_KEEPER_COLLATERAL`             | `0x2::sui::SUI`                          | type arg for `<C>` |
| `WICK_KEEPER_POLL_MS`                | `2000`                                   | watch-mode tick interval |
| `WICK_KEEPER_ITERATION_TIMEOUT_MS`   | `60000`                                  | per-tick deadline |
| `WICK_KEEPER_BACKOFF_INITIAL_MS`     | `500`                                    | RPC failure backoff |
| `WICK_KEEPER_BACKOFF_MAX_MS`         | `30000`                                  | RPC backoff cap |
| `WICK_KEEPER_GAS_TICK`               | `50000000`                               | gas for tick+record |
| `WICK_KEEPER_GAS_SETTLE`             | `300000000`                              | gas for `lock_and_settle` |
| `WICK_KEEPER_GAS_CRANK`              | `300000000`                              | gas for `crank_expired_ride` |
| `WICK_KEEPER_HEALTH_PORT`            | `8080`                                   | /healthz port |
| `WICK_KEEPER_MARKETS`                | (empty)                                  | comma-sep market filter |
| `WICK_KEEPER_RIDES_OWNERS`           | (empty)                                  | owners to scan for rides |
| `WICK_KEEPER_DISABLE_RW_TICKS`       | `0`                                      | skip arcade ticks |
| `WICK_KEEPER_DISABLE_PULL_PUSHES`    | `0`                                      | skip pull pushes |
| `WICK_KEEPER_DISABLE_RIDE_CRANKS`    | `0`                                      | skip ride cranks |

## Logs

Structured JSON, one line per event. Schema:

```json
{ "ts":"...","level":"info","action":"lock-and-settle","market_id":"0x...","tx_digest":"...","gas_used":"123","duration_ms":42 }
```

Per-tick summary:

```json
{ "ts":"...","action":"tick-summary","duration_ms":1234,"actions":5,"succeeded":4,"skipped_idempotent":1,"failed":0 }
```
