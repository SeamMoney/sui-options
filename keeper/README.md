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

## Walrus archiver (v3.5, optional)

Permissionless bot that uploads per-round segment archives to
[Walrus](https://docs.wal.app/) for the v3 hot/cold storage split described
in `docs/design/v2/24_walrus_archive_v3.md` (the archive) and `23_storage_rebate_pruning_v3.md`
(the prune that follows). Encodes a `WickRoundArchive` BCS blob per settled
round and PUTs it to a Walrus publisher.

Enable it by listing markets in `WICK_KEEPER_ARCHIVER_MARKETS`:

```bash
# one market, default package + collateral from deployments/testnet.json
export WICK_KEEPER_ARCHIVER_MARKETS=0xmarket1

# many markets, possibly on different packages
export WICK_KEEPER_ARCHIVER_MARKETS=0xmarket1,0xmarket2@0xpkg:0x2::sui::SUI
```

| Var                                    | Default                                                  | Notes |
|----------------------------------------|----------------------------------------------------------|-------|
| `WICK_KEEPER_ARCHIVER_MARKETS`         | (empty — bot disabled)                                   | comma-separated `<marketId>[@<packageId>[:<collateral>]]` |
| `WALRUS_PUBLISHER_URL`                 | `https://publisher.walrus-testnet.walrus.space`          | Mysten Labs public testnet publisher (verified against MystenLabs/walrus operators.json) |
| `WALRUS_RETENTION_EPOCHS`              | `14`                                                     | Walrus testnet epoch = 1 day; doc 24 §9 lists 365 as the v3.0 mainnet default |
| `WICK_KEEPER_ARCHIVER_POLL_MS`         | `5000`                                                   | scan cadence for archive-eligible rounds |

The bot polls every market it covers. For each market it reads
`SegmentMarket.cached_round_index` and considers the highest round `R` such
that `R + SETTLEMENT_LAG_ROUNDS (=3) <= cached_round_index` an archive
candidate. If `R` hasn't been archived yet, the bot:

1. Pulls `SegmentRecorded` events for `[R*duration .. R*duration+duration)`.
2. Pulls the `RoundStarted` event for `R` (barrier prices, start segment).
3. Reads each segment's `state_after` walk checkpoint via Sui dynamic-field
   lookup on the `segments: Table<u64, SegmentRecord>` field.
4. BCS-encodes the `WickRoundArchive` per doc 24 §3.
5. PUTs the bytes to the Walrus publisher (`PUT /v1/blobs?epochs=N`).
6. **Stubs** the on-chain `record_walrus_archive` call — logs
   `WOULD CALL <pkg>::segment_market_v3::record_walrus_archive(market, R, blobId)`.

The stub is deliberate. The v3 Move surface (`segment_market_v3` with the
`archive_index`, `unsettled_rides_per_round`, `pruned_rounds` fields and the
`record_walrus_archive` / `prune_settled_segments` entry functions documented
in `docs/design/v2/24_walrus_archive_v3.md` §5 + `23_storage_rebate_pruning_v3.md`
§3.2) is not yet implemented. The v2 `SegmentMarket` doesn't have those
fields, so calling a non-existent entry function would just bounce. When v3
lands, swap the log line for a real PTB build — every arg the call needs is
already captured in the stub's `detail.args` payload.

### The archive-before-prune invariant

Per doc 23 §8: `prune_settled_segments(R)` MUST NOT execute unless
`record_walrus_archive(R)` has already landed. This is the load-bearing
safety property of v3 — once segments are deleted from on-chain Move
storage, the Walrus blob is the only durable record. The archiver bot is
the producer of `record_walrus_archive` calls; the pruner bot is its
consumer. v3.0 enforces ordering in the bot (this archiver runs the archive
side and a future `segmentPruner.ts` reads `archive_index` before pruning);
v3.1 lifts the assert into Move so external pruners can't skip it.

### Manual smoke

Until v3 ships, the archiver's loop is observable but won't change on-chain
state:

```bash
export WICK_KEEPER_ARCHIVER_MARKETS=0xyour_smoke_market_id
npm run watch   # NDJSON logs — look for action=segment-archiver.*
```

If the market's `cached_round_index < SETTLEMENT_LAG_ROUNDS`, you'll see
`segment-archiver.no-eligible-round` on each poll — that's the bot
deciding the market is too young to archive. Once the market crosses the
lag, you'll see `segment-archiver.archive-begin → .serialized → .walrus-stored
→ .record-walrus-archive-stub`. The loop is failure-tolerant: any error in
the chain pauses one poll cycle and resumes on the next tick. Never crashes.

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
| `WICK_KEEPER_ARCHIVER_MARKETS`       | (empty)                                  | enable Walrus archiver bot (v3.5) |
| `WALRUS_PUBLISHER_URL`               | `https://publisher.walrus-testnet.walrus.space` | Walrus publisher endpoint |
| `WALRUS_RETENTION_EPOCHS`            | `14`                                     | blob lifetime in Walrus epochs (testnet = 1d) |
| `WICK_KEEPER_ARCHIVER_POLL_MS`       | `5000`                                   | archiver eligibility-scan cadence |

## Logs

Structured JSON, one line per event. Schema:

```json
{ "ts":"...","level":"info","action":"lock-and-settle","market_id":"0x...","tx_digest":"...","gas_used":"123","duration_ms":42 }
```

Per-tick summary:

```json
{ "ts":"...","action":"tick-summary","duration_ms":1234,"actions":5,"succeeded":4,"skipped_idempotent":1,"failed":0 }
```
