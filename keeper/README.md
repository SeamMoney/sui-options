# Wick Keeper

Permissionless cranking daemon for [Wick Markets](../README.md). Two jobs:

1. **Touch / no-touch + ride markets** — `random_walk_driver::tick`,
   `pull_oracle_driver::push_price`, `wick::lock_and_settle<C>`,
   `wick::crank_expired_ride<C>`.
2. **The live `/ride` segment chart** — pumps `wick::record_segment<C>` at
   400 ms via the [`SegmentCranker`](#segment-market-cranking--the-live-ride-chart),
   with a sponsored `SegmentSentinel` keeping the chart awake between players.

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

## Segment-market cranking — the live `/ride` chart

The shipped ride (`/ride`, `wick::segment_market_v4`) streams a provably-fair
candle chart by recording one **segment** every 400 ms. Two keeper subsystems
keep that chart alive; both are on by default in `watch` mode once their market
list is set.

### `SegmentCranker` — pump `record_segment`

`record_segment` has a wake/sleep gate: it aborts with `ENoActiveRides (=14)`
when `active_ride_count == 0`. The cranker pumps `wick::record_segment<C>` at a
~400 ms cadence **whenever a market has at least one open ride**, and goes quiet
otherwise so dormant markets don't burn gas. It tracks `active_ride_count`
locally off `RideOpened` / `RideClosed` event polling (no per-tick market read)
and pipelines submissions fire-and-forget behind a small in-flight cap.

```bash
# comma-separated <marketId>[@<packageId>[:<collateral>]] — package + collateral
# default to deployments/testnet.json + 0x2::sui::SUI when omitted.
export WICK_KEEPER_SEGMENT_MARKETS=0xmarket1,0xmarket2@0xpkg:0x2::sui::SUI

# v4 markets (all LIVE markets are v4 — touch-either + rug). Cranks
# `record_segment_v4` and tracks the `*_V4` events. For TUSD pass the type arg:
export WICK_KEEPER_SEGMENT_MARKETS_V4=0x54e9…@0x1fdf…:0x204d…::tusd::TUSD
```

| Var                              | Default | Notes |
|----------------------------------|---------|-------|
| `WICK_KEEPER_SEGMENT_MARKETS`    | (empty — cranker off) | **v3** markets to crank (`record_segment`) |
| `WICK_KEEPER_SEGMENT_MARKETS_V4` | (empty) | **v4** markets to crank (`record_segment_v4`) — the live module |
| `WICK_KEEPER_SEGMENT_V4_AUTO`     | (off)   | `1` → auto-crank every `segment_markets_v4[]` in the deployment manifest (each market's own collateral); no need to list ids |
| `WICK_KEEPER_SEGMENT_INTERVAL_MS`| `400`   | per-market crank cadence (the chain hard-codes 400 ms / segment) |
| `WICK_KEEPER_GAS_RECORD_SEGMENT` | —       | optional per-tx gas budget override |

Both env vars feed one cranker; v3 and v4 markets can run side by side. The
`scripts/sentinel-v4-fast.mjs` + `chart-keeper.sh` path is the lighter-weight
demo alternative; this keeper is the production cranker.

### `SegmentSentinel` — keep the gate satisfied between players (sponsored)

So the chart never freezes when no human is riding, the sentinel opens and
closes one tiny ride per round to hold `active_ride_count > 0`. It signs as the
sentinel but ships the tx through **`/api/sponsor`** (doc 22), so gas is debited
from the protocol sponsor wallet rather than the operator's — the production
replacement for the laptop-bound `scripts/sentinel-runner.sh`.

```bash
export WICK_KEEPER_SENTINEL_MARKETS=0xmarket1
export WICK_SPONSOR_URL=https://<deployment>/api/sponsor   # co-signs gas
```

| Var                               | Default | Notes |
|-----------------------------------|---------|-------|
| `WICK_KEEPER_SENTINEL_MARKETS`    | (empty — sentinel off) | markets to keep awake |
| `WICK_KEEPER_SENTINEL_INTERVAL_MS`| `1000`  | round-scan cadence |
| `WICK_KEEPER_SENTINEL_BARRIER`    | —       | optional barrier override for the sentinel ride |
| `WICK_SPONSOR_URL`                | (doc 22 default) | sponsor service that co-signs as `gas_owner` |

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

## Sponsored sentinel runner (v3.6, optional)

The 24/7 production successor to [`scripts/sentinel-runner.sh`](../scripts/sentinel-runner.sh).
That bash bridge is a tonight-demo tool: it opens-closes a tiny sentinel ride
each round from the operator's `sui client active-address`, debiting the
operator's wallet for gas. The wallet drains in minutes; it cannot run
unattended.

This v3.6 module does the same dance but routes every PTB through
[`/api/sponsor`](../api/sponsor.ts) (doc 22 §3.3, shipped at commit `69c02da`).
The sentinel signs as sender; the Vercel sponsor service co-signs as `gas_owner`
and the protocol's sponsor wallet pays for gas — refilled permissionlessly from
`fee_router::protocol_bucket` via `wick::sponsor::harvest_to_sponsor`
(shipped at commit `1244648`). The result: operator-free 24/7 chart liveness.

Enable it by listing markets in `WICK_KEEPER_SENTINEL_MARKETS`:

```bash
# one market, default package + collateral
export WICK_KEEPER_SENTINEL_MARKETS=0xmarket1
export WICK_SPONSOR_ADDRESS=0xsponsor   # the address derived from WICK_SPONSOR_PRIVATE_KEY in Vercel
export WICK_SPONSOR_URL=https://wick-markets.vercel.app/api/sponsor

# many markets, possibly on different packages
export WICK_KEEPER_SENTINEL_MARKETS=0xmarket1,0xmarket2@0xpkg:0x2::sui::SUI
```

| Var                                     | Default                                                  | Notes |
|-----------------------------------------|----------------------------------------------------------|-------|
| `WICK_KEEPER_SENTINEL_MARKETS`          | (empty — bot disabled)                                   | comma-separated `<marketId>[@<packageId>[:<collateral>]]` |
| `WICK_SPONSOR_URL`                      | `https://wick-markets.vercel.app/api/sponsor`            | /api/sponsor endpoint |
| `WICK_SPONSOR_ADDRESS`                  | (required)                                               | Sponsor wallet address — must match the wallet derived from `WICK_SPONSOR_PRIVATE_KEY` in Vercel env. The keeper never holds the sponsor's private key. |
| `WICK_KEEPER_SENTINEL_INTERVAL_MS`      | `1000`                                                   | Floor cadence between snapshot reads when there's nothing to do |
| `WICK_KEEPER_SENTINEL_BARRIER`          | `0` (upper)                                              | `0` = upper barrier, `1` = lower. Choice is arbitrary; sentinel is a backstop, not a position. |
| `WICK_KEEPER_SENTINEL_GAS`              | `200000000`                                              | Per-PTB gas budget in MIST (the sponsor pays, but the budget still has to fit the network ceiling) |

The bot also needs the standard shared singleton ids that `open_segment_ride`
and `close_segment_ride` require: `bot_registry`, `usd_price_oracle`,
`wick_token_state`, `staking_pool`. These are picked up from
`deployments/testnet.json` or the corresponding `WICK_KEEPER_*` overrides
listed in the "Required object IDs" table above. If any are missing the
keeper logs `segment-sentinel-skip` with the missing list and continues
running the rest of the subsystems.

### Lifecycle

For each market in `WICK_KEEPER_SENTINEL_MARKETS`, every loop iteration:

1. Snapshot the market — read `active_ride_count`, `cached_round_*`,
   `round_duration_segments`, `open_window_segments`, `next_segment_index`,
   `min_stake_per_segment`.
2. If `active_ride_count > 0` → sleep one round; another rider is already
   keeping the chart alive.
3. If we're past `open_window_segments` of the current round → sleep to
   the next round.
4. Otherwise build `wick::open_segment_ride_v3<C>` PTB, sign locally,
   POST `{ sender, txBytes, userSig }` to `/api/sponsor`. On success,
   pull the ride id from the `RideOpened` event in the open tx.
5. Sleep `(round_duration_segments - 2) × 400ms` — close just before
   round-end so we don't drop into `EXPIRED_LOSS` (which would burn the
   sponsor budget).
6. Build `wick::close_segment_ride_v3<C>` PTB, sign, POST to `/api/sponsor`.

On SIGINT/SIGTERM the keeper drains the current step, then if a ride is
still in flight attempts a best-effort sponsored close before exit.

### Run alongside cranker + archiver for full v3 operations

The three v3 subsystems compose:

```bash
# Full-stack v3 keeper — sentinel keeps the chart alive,
# cranker pumps record_segment while rides are open,
# archiver writes settled rounds to Walrus.
export WICK_KEEPER_SEGMENT_MARKETS=0xmarket
export WICK_KEEPER_SENTINEL_MARKETS=0xmarket
export WICK_KEEPER_ARCHIVER_MARKETS=0xmarket
export WICK_SPONSOR_ADDRESS=0xsponsor
npm run watch
```

### Sponsor rejection signals

The sentinel targets the v3 router functions in `wick.move`; `/api/sponsor`
then verifies the market argument is a `segment_market_v3::SegmentMarketV3<C>`
object from the configured package. **HTTP 403** means the PTB failed that
allowlist or gas-owner check. **HTTP 503** usually means the sponsor wallet env
or daily spend cap is unavailable.

### Manual smoke

```bash
export WICK_KEEPER_SENTINEL_MARKETS=0xyour_smoke_segment_market_id
export WICK_SPONSOR_ADDRESS=0xsponsor_addr_from_vercel_env
npm run watch    # NDJSON logs — look for action=segment-sentinel.*
```

You should see:

- `segment-sentinel.start` — boot log with sender, sponsor, sponsor URL,
  package id, collateral type, and router targets.
- One of `segment-sentinel.skip-active` (someone else riding),
  `segment-sentinel.skip-window-closed` (waiting for next round), or
  `segment-sentinel.error` carrying a sponsor rejection/degraded response.
- On a funded v3 market: `segment-sentinel.open-ok → ...close-ok` once per
  round forever.

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
| `WICK_KEEPER_SEGMENT_MARKETS`        | (empty)                                  | enable segment-cranker (v3 / C1) |
| `WICK_KEEPER_SEGMENT_INTERVAL_MS`    | `400`                                    | cranker per-market submit cadence |
| `WICK_KEEPER_GAS_RECORD_SEGMENT`     | `20000000`                               | cranker per-tx gas budget |
| `WICK_KEEPER_SENTINEL_MARKETS`       | (empty)                                  | enable sponsored sentinel runner (v3.6) |
| `WICK_SPONSOR_URL`                   | `https://wick-markets.vercel.app/api/sponsor` | /api/sponsor endpoint |
| `WICK_SPONSOR_ADDRESS`               | (required when sentinel enabled)         | sponsor wallet address — must match `WICK_SPONSOR_PRIVATE_KEY` on Vercel |
| `WICK_KEEPER_SENTINEL_INTERVAL_MS`   | `1000`                                   | sentinel floor cadence between snapshot reads |
| `WICK_KEEPER_SENTINEL_BARRIER`       | `0` (upper)                              | sentinel barrier choice (0/1) |
| `WICK_KEEPER_SENTINEL_GAS`           | `200000000`                              | sentinel per-PTB gas budget (sponsor pays) |

## Logs

Structured JSON, one line per event. Schema:

```json
{ "ts":"...","level":"info","action":"lock-and-settle","market_id":"0x...","tx_digest":"...","gas_used":"123","duration_ms":42 }
```

Per-tick summary:

```json
{ "ts":"...","action":"tick-summary","duration_ms":1234,"actions":5,"succeeded":4,"skipped_idempotent":1,"failed":0 }
```
