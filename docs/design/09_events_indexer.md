# 09 — Event Schema & Indexer Architecture

> Status: design spec for the rewritten Wick contracts + the Postgres indexer + the API surface that the Vite/React frontend reads from. Anchors:
> - On-chain modules (existing): `wick_oracle`, `path_observation`, `random_walk_driver`, `pull_oracle_driver`, `vault`, `market`, `wick`.
> - On-chain modules (planned): `predict_driver`, `wick_token`, `martingaler_queue`, `fee_router`, `risk_config`, `position_token`, `lp_token`, `tournament`.
> - Off-chain: `keeper/` (TS poller already exists), `api/` (Fastify), `frontend/` (Vite+React+TS), and a new `indexer/` workspace (this doc).
> - Storage: Postgres 16 (Neon on Vercel) + Redis (Upstash on Vercel) for hot pubsub.

---

## 1. Event taxonomy

Events are grouped by domain. Every event ends up in two places:
1. The append-only `events` table (raw archive, source of truth for replay).
2. One or more **derived tables** maintained by a domain-specific projector.

The taxonomy below is also the on-chain emit boundary: every state transition that the UI cares about must emit one of these.

| Domain | Module | Events |
|---|---|---|
| Market lifecycle | `market` | `MarketCreated`, `MarketSettled`, `MarketCancelled` |
| Oracle | `wick_oracle` | `OracleCreated`, `ObservationRecorded`, `OracleSettled` |
| Path | `path_observation` | `PathCreated`, `TickRecorded`, `BarrierTouched` |
| Position | `market`, `position_token` | `PositionMinted`, `PositionRedeemed`, `PositionTransferred`, `PositionExpired` |
| Vault / Martingaler | `vault`, `martingaler_queue` | `VaultDeposit`, `VaultPayout`, `QueueEntryPushed`, `QueueEntryPaid`, `HarvestRan` |
| Token (WICK) | `wick_token` | `WickMinted`, `WickStaked`, `WickUnstaked`, `DividendsClaimed`, `MintCurveAdvanced` |
| Fees | `fee_router` | `FeeAccrued`, `FeeDistributed` |
| Tournament / gamification | `tournament` | `TournamentCreated`, `TournamentLocked`, `TournamentSettled`, `BadgeAwarded` |
| Risk | `risk_config` | `RiskParamUpdated`, `OICapHit` |

---

## 2. Event-by-event spec

Conventions:
- Move structs all carry `has copy, drop` (no `store` — events are emit-only). Where a struct is also a hot-path value object (e.g. `PriceObservation`) it gets `store`.
- Timestamps are `u64` ms since unix epoch, sourced from `Clock`.
- IDs are Sui `ID`. In TypeScript these surface as 32-byte hex strings prefixed `0x`.
- Prices are `u64` scaled to `1e9` (matches `price_observation::PRICE_SCALING`, which matches Predict's `FLOAT_SCALING`).
- Coin amounts are `u64` in the smallest unit of the collateral coin (e.g. SUI = MIST = 1e-9 SUI, USDC = 1e-6 USDC).

### 2.1 Market lifecycle

```move
public struct MarketCreated has copy, drop {
    market_id: ID,
    oracle_id: ID,
    path_id: ID,
    expiry_ms: u64,
    payout_multiplier_bps: u64,
    collateral_type: TypeName,        // <-- additive vs current spec, captures Coin<C>
    creator: address,
    seed_collateral: u64,
    name: String,
    fee_bps: u64,                     // protocol take from each open
    risk_config_id: ID,
}
```
TS: `{ marketId: string; oracleId: string; pathId: string; expiryMs: number; payoutMultiplierBps: number; collateralType: string; creator: string; seedCollateral: string; name: string; feeBps: number; riskConfigId: string; }`

Emitted by `market::create`. Consumers: **MarketsRail** (left pane of v3 layout), `/markets` REST endpoint, `markets` table insert.

```move
public struct MarketSettled has copy, drop {
    market_id: ID,
    oracle_id: ID,
    settlement_price: u64,
    touched: bool,
    settled_at_ms: u64,
    final_vault_balance: u64,
}
```
Emitted by `market::lock_settlement`. Consumers: `markets.status` flip, all open `positions.is_redeemable = true`, **TournamentLocked** check.

```move
public struct MarketCancelled has copy, drop {
    market_id: ID,
    reason: u8,                        // 0=oracle_failure, 1=admin_kill, 2=insufficient_liquidity
    cancelled_at_ms: u64,
}
```
Refund-path trigger: indexer flips all positions to `is_refundable = true`.

### 2.2 Oracle

`OracleCreated`, `ObservationRecorded`, `OracleSettled` already exist in `wick_oracle.move` — keep their shapes. Add only:

```move
public struct ObservationRejected has copy, drop {  // optional, emit on assertion-near-miss in driver
    oracle_id: ID,
    reason: u8,                        // stale | future | wrong_kind | wrong_cap
    timestamp_ms: u64,
}
```
Driver-level. Useful for the keeper-health dashboard.

### 2.3 Path

`PathCreated`, `TickRecorded`, `BarrierTouched` are shipped. The high-frequency one is `TickRecorded`: this is the firehose (random-walk markets emit one every ~5s). Indexer treats `TickRecorded` as a write to `path_observations_latest` (upsert) and an append to `path_ticks` (TimescaleDB hypertable, 24h retention). See §7 on backpressure.

### 2.4 Position

```move
public struct PositionMinted has copy, drop {
    market_id: ID,
    position_id: ID,
    side: u8,                          // 0=touch, 1=no_touch
    stake: u64,
    payout_if_win: u64,
    owner: address,
    minted_at_ms: u64,
    entry_index_price: u64,            // oracle latest at mint, for PnL math
}
```
This is `PositionOpened` in current code, renamed for taxonomy consistency. Consumers: **Positions** panel, `positions` table, **leaderboard** projector (volume credit).

```move
public struct PositionRedeemed has copy, drop {
    market_id: ID,
    position_id: ID,
    side: u8,
    payout: u64,
    won: bool,
    owner: address,
    redeemed_at_ms: u64,
}
```
Already exists. Indexer marks `positions.redeemed_at_ms`; updates `users` aggregates (lifetime volume, win count).

```move
public struct PositionTransferred has copy, drop {
    position_id: ID,
    from: address,
    to: address,
    venue: u8,                          // 0=wallet_transfer, 1=deepbook_clob
    transferred_at_ms: u64,
    price: Option<u64>,                 // sale price if venue=clob
    collateral_type: TypeName,
}
```
Emitted by `position_token::transfer` and by a DeepBook hook in `position_token::on_clob_match`. Consumers: ownership re-keying in `positions.owner`, **Activity feed**.

```move
public struct PositionExpired has copy, drop {  // mass-emit at lock_settlement
    position_id: ID,
    market_id: ID,
    side: u8,
    won: bool,
}
```
Optional bulk event (emit one per still-open position when settlement is locked) — gives the indexer a cheap O(1) signal per position rather than scanning the whole `positions` table on `MarketSettled`. Move-side this is bounded by an iteration cap; if it exceeds the cap, the indexer falls back to scanning.

### 2.5 Vault / Martingaler

```move
public struct VaultDeposit has copy, drop {
    vault_id: ID, market_id: ID, depositor: address, amount: u64, new_balance: u64,
}
public struct VaultPayout has copy, drop {
    vault_id: ID, market_id: ID, recipient: address, amount: u64, new_balance: u64,
}
```
Per-market vault is a child of `Market<C>`; indexer derives `vault_state` from the running balance.

```move
public struct QueueEntryPushed has copy, drop {
    queue_id: ID, entry_id: ID, owner: address, amount_owed: u64, queued_at_ms: u64, position_id: ID,
}
public struct QueueEntryPaid has copy, drop {
    queue_id: ID, entry_id: ID, owner: address, amount_paid: u64, paid_at_ms: u64,
}
public struct HarvestRan has copy, drop {
    queue_id: ID, harvested_amount: u64, distributed_to_treasury: u64,
    distributed_to_side_bucket: u64, distributed_to_queue: u64, ran_at_ms: u64,
}
```
Drives the **Martingaler** card on the dashboard. Latency-sensitive: queue position changes must show up in the user's wallet view within ~2s.

### 2.6 Token (WICK)

```move
public struct WickMinted has copy, drop {
    recipient: address, amount: u64, curve_step: u64, total_minted_after: u64, source: u8,
}                                       // source: 0=trade_reward, 1=lp_reward, 2=referral
public struct WickStaked    has copy, drop { staker: address, amount: u64, locked_until_ms: u64, stake_id: ID }
public struct WickUnstaked  has copy, drop { staker: address, amount: u64, stake_id: ID, unstaked_at_ms: u64 }
public struct DividendsClaimed has copy, drop {
    claimer: address, amount: u64, epoch: u64, claimed_at_ms: u64,
}
public struct MintCurveAdvanced has copy, drop {
    new_step: u64, new_emission_per_unit: u64, advanced_at_ms: u64,
}
```
Consumers: **WICK Stats** card (total minted, current curve step), per-user **Earnings** view, claim button enable/disable.

### 2.7 Fees

```move
public struct FeeAccrued    has copy, drop { router_id: ID, market_id: ID, amount: u64, collateral_type: TypeName, accrued_at_ms: u64 }
public struct FeeDistributed has copy, drop {
    router_id: ID, to_treasury: u64, to_wick_stakers: u64, to_lp: u64, to_referrer: u64,
    distributed_at_ms: u64, collateral_type: TypeName,
}
```
Drives the **Protocol Revenue** card.

### 2.8 Tournament / gamification

```move
public struct TournamentCreated has copy, drop {
    tournament_id: ID, name: String, starts_at_ms: u64, ends_at_ms: u64,
    entry_fee: u64, prize_pool_seed: u64, max_entries: u64,
}
public struct TournamentLocked has copy, drop { tournament_id: ID, locked_at_ms: u64, final_entry_count: u64 }
public struct TournamentSettled has copy, drop {
    tournament_id: ID, winners: vector<address>, prizes: vector<u64>, settled_at_ms: u64,
}
public struct BadgeAwarded has copy, drop {
    user: address, badge_kind: u8, awarded_at_ms: u64, source_event_digest: vector<u8>,
}
```
Powers the gamification surface in `docs/gamification-direction.md`.

### 2.9 Risk

```move
public struct RiskParamUpdated has copy, drop { config_id: ID, param: u8, old_value: u64, new_value: u64, updated_at_ms: u64 }
public struct OICapHit has copy, drop { market_id: ID, side: u8, attempted_payout: u64, cap: u64, attempted_at_ms: u64 }
```
`OICapHit` powers the "side full, swap to other side" UX hint in the trade ticket.

---

## 3. Derived state — Postgres schema

All tables use `bigint` for ms timestamps and `numeric(78,0)` for `u64` amounts (Postgres `bigint` overflows at `2^63`, but Sui `u64` tops at `2^64-1`; numeric is safe and lossless for BCS).

```sql
-- Append-only raw archive. Source of truth for replay.
CREATE TABLE events (
  id              bigserial PRIMARY KEY,
  tx_digest       bytea NOT NULL,
  event_seq       int   NOT NULL,
  package_id      bytea NOT NULL,
  module          text  NOT NULL,
  event_type      text  NOT NULL,                -- e.g. 'wick::market::PositionMinted'
  sender          bytea,
  timestamp_ms    bigint NOT NULL,
  checkpoint      bigint NOT NULL,
  payload         jsonb NOT NULL,
  inserted_at     timestamptz DEFAULT now(),
  UNIQUE (tx_digest, event_seq)                  -- idempotency
);
CREATE INDEX events_type_ts ON events (event_type, timestamp_ms DESC);
CREATE INDEX events_checkpoint ON events (checkpoint);

-- Indexer cursor — one row per (network, package).
CREATE TABLE indexer_cursors (
  network text, package_id bytea,
  last_checkpoint bigint NOT NULL,
  last_event_id  text NOT NULL,                  -- "{tx_digest}:{event_seq}"
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (network, package_id)
);

-- Markets — one row per Market<C>.
CREATE TABLE markets (
  market_id              bytea PRIMARY KEY,
  oracle_id              bytea NOT NULL,
  path_id                bytea NOT NULL,
  collateral_type        text  NOT NULL,
  name                   text  NOT NULL,
  underlying             text  NOT NULL,
  driver_kind            smallint NOT NULL,      -- 0=lazer 1=predict 2=random_walk
  barrier                numeric(78,0) NOT NULL,
  direction              smallint NOT NULL,      -- 0=above 1=below
  expiry_ms              bigint NOT NULL,
  payout_multiplier_bps  int NOT NULL,
  status                 text NOT NULL,          -- 'open'|'settled_touched'|'settled_no_touch'|'cancelled'
  vault_balance          numeric(78,0) NOT NULL,
  touch_exposure         numeric(78,0) NOT NULL,
  no_touch_exposure      numeric(78,0) NOT NULL,
  settlement_price       numeric(78,0),
  touched                boolean,
  settled_at_ms          bigint,
  created_at_ms          bigint NOT NULL
);
CREATE INDEX markets_status_expiry ON markets (status, expiry_ms);
CREATE INDEX markets_underlying_status ON markets (underlying, status);

CREATE TABLE positions (
  position_id        bytea PRIMARY KEY,
  market_id          bytea NOT NULL REFERENCES markets,
  owner              bytea NOT NULL,
  side               smallint NOT NULL,
  stake              numeric(78,0) NOT NULL,
  payout_if_win      numeric(78,0) NOT NULL,
  entry_index_price  numeric(78,0),
  minted_at_ms       bigint NOT NULL,
  redeemed_at_ms     bigint,
  payout             numeric(78,0),
  won                boolean,
  status             text NOT NULL                -- 'open'|'won'|'lost'|'refunded'
);
CREATE INDEX positions_owner_status ON positions (owner, status);
CREATE INDEX positions_market ON positions (market_id);

-- Latest tick per oracle (write-heavy hot path; one row per oracle_id).
CREATE TABLE path_observations (
  oracle_id      bytea PRIMARY KEY,
  path_id        bytea NOT NULL,
  latest_price   numeric(78,0) NOT NULL,
  latest_ts_ms   bigint NOT NULL,
  min_seen       numeric(78,0) NOT NULL,
  max_seen       numeric(78,0) NOT NULL,
  touched_at_ms  bigint
);

-- Tick history (TimescaleDB hypertable, 24h retention by default).
CREATE TABLE path_ticks (
  oracle_id     bytea NOT NULL,
  ts_ms         bigint NOT NULL,
  price         numeric(78,0) NOT NULL,
  PRIMARY KEY (oracle_id, ts_ms)
);
SELECT create_hypertable('path_ticks', 'ts_ms', chunk_time_interval => 3600000);
SELECT add_retention_policy('path_ticks', INTERVAL '24 hours');

-- Users — cumulative aggregates. Keyed by Sui address.
CREATE TABLE users (
  address          bytea PRIMARY KEY,
  first_seen_ms    bigint NOT NULL,
  total_volume     numeric(78,0) NOT NULL DEFAULT 0,
  total_pnl        numeric(78,0) NOT NULL DEFAULT 0,    -- signed via two cols if needed
  positions_open   int NOT NULL DEFAULT 0,
  positions_won    int NOT NULL DEFAULT 0,
  positions_lost   int NOT NULL DEFAULT 0,
  wick_balance     numeric(78,0) NOT NULL DEFAULT 0,
  wick_staked      numeric(78,0) NOT NULL DEFAULT 0,
  badges           int[] NOT NULL DEFAULT '{}'
);

CREATE TABLE vault_state (
  vault_id          bytea PRIMARY KEY,
  market_id         bytea NOT NULL,
  collateral_type   text NOT NULL,
  treasury_balance  numeric(78,0) NOT NULL,
  side_bucket       numeric(78,0) NOT NULL,
  queue_size        int NOT NULL,
  queue_total_owed  numeric(78,0) NOT NULL,
  last_harvest_ms   bigint
);

CREATE TABLE wick_minted_per_user (
  address          bytea PRIMARY KEY,
  total_minted     numeric(78,0) NOT NULL,
  trade_minted     numeric(78,0) NOT NULL,
  lp_minted        numeric(78,0) NOT NULL,
  referral_minted  numeric(78,0) NOT NULL,
  last_mint_ms     bigint
);

-- Materialised view, refreshed every 60s.
CREATE MATERIALIZED VIEW leaderboard_24h AS
  SELECT owner AS address,
         COUNT(*) FILTER (WHERE won) AS wins,
         COUNT(*) FILTER (WHERE NOT won AND status='lost') AS losses,
         SUM(payout - stake) FILTER (WHERE won) - SUM(stake) FILTER (WHERE NOT won) AS pnl_24h,
         SUM(stake) AS volume_24h
  FROM positions
  WHERE minted_at_ms > (extract(epoch from now()) - 86400)*1000
  GROUP BY owner
  ORDER BY pnl_24h DESC NULLS LAST
  LIMIT 1000;
CREATE UNIQUE INDEX leaderboard_24h_addr ON leaderboard_24h (address);

CREATE TABLE tournament_results (
  tournament_id   bytea NOT NULL,
  rank            int NOT NULL,
  address         bytea NOT NULL,
  pnl             numeric(78,0) NOT NULL,
  prize           numeric(78,0) NOT NULL,
  PRIMARY KEY (tournament_id, rank)
);
```

---

## 4. Indexer architecture

**Decision: poll `suix_queryEvents` over the public Sui fullnode. No WebSocket subscription.**

Why polling over WS:
- Sui's `subscribeEvent` over WS exists but is not delivery-guaranteed across fullnode restarts and gives no checkpoint cursor — so you'd need to back-fill anyway.
- `suix_queryEvents` returns a stable `EventID = (tx_digest, event_seq)` plus checkpoint, which is the **only** safe cursor for at-least-once + dedup semantics.
- Polling at 500ms with `cursor=last_event_id` typically returns 0–20 events per call against the public testnet fullnode under our load. CPU and RPC cost both negligible.
- Works behind any HTTP proxy (Vercel Functions, Cloudflare Workers) without sticky-WS handling.

Topology (single process, can horizontally split per-package later):
```
+-----------+   poll     +---------+    pg COPY    +----------+    NOTIFY    +-----------+
| Fullnode  | <--------- | indexer | -----------> | Postgres | -----------> | Frontend  |
| RPC       |   500ms    | (Node)  |    (txn)     |  + Redis | -- pubsub -> | (SSE/WS)  |
+-----------+            +---------+               +----------+               +-----------+
```

Loop (pseudo-Typescript):
```ts
while (true) {
  const cursor = await getCursor(packageId);
  const page = await client.queryEvents({
    query: { MoveEventModule: { package: packageId, module: '*' } },
    cursor, order: 'ascending', limit: 200,
  });
  if (page.data.length === 0) { await sleep(500); continue; }
  await db.tx(async t => {
    for (const ev of page.data) {
      // Insert into raw events table (UNIQUE (tx_digest, event_seq) makes it idempotent).
      await t.none('INSERT INTO events ... ON CONFLICT DO NOTHING', toRow(ev));
      // Dispatch to per-domain projector.
      await projectors[ev.type]?.(t, ev);
    }
    await t.none('UPDATE indexer_cursors SET last_event_id=$1, last_checkpoint=$2 WHERE ...',
                 [page.nextCursor.eventId, page.data.at(-1).checkpoint]);
  });
  await redis.publish('wick:events', JSON.stringify(page.data));
}
```

**Reorgs.** Sui has BFT finality — once a checkpoint is signed, events do not vanish. The indexer waits one checkpoint (~250ms) before treating a cursor as final by tracking `last_safe_checkpoint = currentCheckpoint - 1`. Anything beyond that is buffered in memory and held back from the projectors. In ~2 years of mainnet there has been no reorg; this is belt-and-braces only.

**Missed events.** Not possible by construction: cursor is `(tx_digest, event_seq)` and the loop only advances the cursor inside the same transaction that did the projection write. Crash → restart from the last committed cursor.

**Duplicates.** `UNIQUE (tx_digest, event_seq)` on `events`; projectors are written to be idempotent — `INSERT ... ON CONFLICT DO UPDATE` for upserts, and state-transition projectors short-circuit on terminal status (`if (positions.status != 'open') return;`).

**Cursor management.** One row per `(network, package_id)` in `indexer_cursors`. On `wick` package upgrade, the package id changes; indexer reads `published_at_checkpoint` from `deployments/testnet.json` and pre-seeds the new cursor at that checkpoint to avoid re-scanning history.

---

## 5. API surface

Fastify HTTP server in `api/`. Path prefix `/v1`. JSON in/out. SSE for streams. ~25 endpoints below.

| # | Method | Path | Reads | Notes |
|---|---|---|---|---|
| 1 | GET | `/v1/markets` | `markets` | `?status=open&underlying=BTC&limit=50` |
| 2 | GET | `/v1/markets/:id` | `markets`, `path_observations`, `vault_state` | Full detail |
| 3 | GET | `/v1/markets/:id/quote` | `markets`, `risk_config` | Returns `{touchPrice, noTouchPrice, maxStake}` for a side+stake |
| 4 | GET | `/v1/markets/:id/depth` | `positions` aggregated | `{touchOI, noTouchOI, capUtilization}` |
| 5 | GET | `/v1/markets/:id/ticks?from=&to=` | `path_ticks` | OHLC bucketed in SQL |
| 6 | GET | `/v1/markets/:id/ticks/stream` | Redis pubsub | SSE; pushes new `TickRecorded` rows |
| 7 | GET | `/v1/oracles/:id` | derived from `events` + `path_observations` | Latest price + freshness |
| 8 | GET | `/v1/positions?owner=0x..` | `positions` | Wallet's open + history |
| 9 | GET | `/v1/positions/:id` | `positions` | One position + redemption status |
| 10 | GET | `/v1/users/:addr` | `users` | Aggregates + badges |
| 11 | GET | `/v1/users/:addr/pnl?window=24h` | `positions` | Realised + unrealised |
| 12 | GET | `/v1/users/:addr/wick` | `wick_minted_per_user`, `users` | Balance, staked, claimable |
| 13 | GET | `/v1/leaderboard?window=24h` | `leaderboard_24h` | Top 100 by PnL |
| 14 | GET | `/v1/leaderboard/stream` | Redis pubsub | SSE; throttled to 1Hz |
| 15 | GET | `/v1/vault/:marketId` | `vault_state` | Treasury / sideBucket / queue |
| 16 | GET | `/v1/martingaler/:queueId/queue` | derived from queue events | Ordered list of pending entries |
| 17 | GET | `/v1/martingaler/:queueId/queue/stream` | Redis pubsub | SSE; queue position changes |
| 18 | GET | `/v1/wick/curve` | latest `MintCurveAdvanced` | Current step + emission rate |
| 19 | GET | `/v1/wick/dividends?address=` | events | Claimable amount per epoch |
| 20 | GET | `/v1/fees/summary?window=24h` | events | Total accrued + distribution split |
| 21 | GET | `/v1/tournaments` | events | List active + upcoming |
| 22 | GET | `/v1/tournaments/:id` | events + `tournament_results` | Detail + rankings |
| 23 | GET | `/v1/tournaments/:id/leaderboard/stream` | Redis pubsub | SSE; live ranks |
| 24 | GET | `/v1/badges/:addr` | events | Awarded badges with sources |
| 25 | GET | `/v1/health` | self | Indexer cursor lag, last event age, RPC ping |

All SSE endpoints emit `event: <type>\ndata: <json>\n\n` with explicit `id:` set to `tx_digest:event_seq` so clients can resume via `Last-Event-ID`.

---

## 6. Latency budget — target ≤ 2s

| Stage | p50 | p95 | Notes |
|---|---|---|---|
| Sui finality (tx → checkpoint) | 250 ms | 400 ms | Sui BFT consensus, public testnet |
| Indexer poll interval | 250 ms | 500 ms | 500ms loop, half on average |
| `suix_queryEvents` round-trip | 60 ms | 200 ms | Public fullnode |
| Projector + Postgres write (Neon, same region) | 15 ms | 60 ms | Single tx, batch of ≤20 events |
| `redis.publish` → SSE deliver | 20 ms | 80 ms | Upstash same-region |
| Browser SSE → React state → render | 30 ms | 150 ms | One render, no layout thrash |
| **End-to-end** | **~625 ms** | **~1.4 s** | Within budget |

Worst case (cold indexer, ~2 polls missed): adds ~1s. Still under the 2s SLA.

Hot path optimisation: `TickRecorded` events bypass Postgres on the read path — the API's `/ticks/stream` SSE pulls directly from Redis pubsub and the indexer writes to Postgres asynchronously (fire-and-forget for `path_ticks` rows, synchronous only for the `path_observations` upsert). This shaves ~30ms p95 per tick.

---

## 7. Backpressure

**The math.** N=100 random-walk markets at 1 tick / 5s = **20 events/s sustained** for `TickRecorded` alone. Each tick also produces an `ObservationRecorded` from the driver and possibly a `BarrierTouched`. Realistic worst case ≈ **60 events/s**.

Postgres can absorb that (commodity hardware sustains 10k+ inserts/s). The bottleneck candidates:
1. **RPC call rate** to the public fullnode. At 500ms poll cadence with batches of 200 events, headroom is 400 events/s — 7× our worst case.
2. **`UPDATE path_observations` lock contention.** 100 different oracle_ids → no row contention at 60/s. Confirmed safe.
3. **SSE fan-out.** With 1k concurrent dashboard viewers and 60 events/s, that's 60k SSE writes/s. Redis pubsub easily handles it; the bottleneck is the Node SSE process. Mitigation: throttle per-connection to **at most one tick update per oracle per 250ms** (coalesce in the SSE layer — clients only care about the latest price for the chart line).
4. **React render cost.** Per the latency table, ~30ms render. At 60 ev/s × all visible markets, the chart pane would re-render thrash. Mitigation: chart uses `requestAnimationFrame` batching; price-only updates patch the line without re-running React reconciliation (lightweight-charts is already wired this way).

Mitigations if N grows past ~500 markets:
- Shard the indexer by `event_type` prefix (one process for `path::*`, one for everything else).
- Move the `path_ticks` archive to a write-optimised store (ClickHouse cluster on a separate Vercel storage integration).
- Promote `TickRecorded` to a Vercel Queues topic with a consumer group of 4× workers.

---

## 8. Data retention

Two storage tiers:

**Hot (Postgres, indexed, online):**
- `events` — last 30 days. Indexed, queryable.
- `markets`, `positions`, `users`, `vault_state`, `wick_minted_per_user`, `tournament_results` — forever (small enough).
- `path_observations` — current state only (one row per oracle).
- `path_ticks` (TimescaleDB hypertable) — 24h, then dropped via `add_retention_policy`.
- `leaderboard_24h` — materialised view, refreshed every 60s.

**Cold (Vercel Blob, gzipped JSONL):**
- `events` older than 30 days, partitioned by day: `events/YYYY-MM-DD.jsonl.gz`.
- `path_ticks` aged out daily by a Vercel Cron job: archive previous-day chunk to Blob, drop hypertable chunk.

**Deletion rules.**
- Settled markets >30 days: keep the `markets` row (small), keep aggregated `positions` rows (small), drop tick history (large), drop raw events (already in cold storage).
- A user's `positions` rows are **never** deleted — they back the all-time PnL leaderboard and individual portfolio history.

**Cost back-of-envelope.**
- Postgres hot working set: ≤5 GB even at 1k markets / 100k positions / 30 days of events. Neon free tier or low Pro tier.
- Cold archive: ~50 KB/event × 60 ev/s × 86,400s = ~250 GB/year compressed. Vercel Blob @ $0.023/GB-month = ~$70/month at year 1, dominated by retrieval costs which are negligible (replay only).

---

## 9. Reproducibility — replay from genesis

The indexer is fully deterministic given the on-chain event log. To reproduce derived state:

1. **Drop derived tables, keep `events` empty:**
   ```bash
   pnpm --filter indexer reset --network testnet
   ```
   This truncates `markets`, `positions`, `path_observations`, `path_ticks`, `users`, `vault_state`, `wick_minted_per_user`, `tournament_results`, `events`, `indexer_cursors`.

2. **Backfill from genesis checkpoint of the package:**
   ```bash
   pnpm --filter indexer replay \
     --network testnet \
     --package $(jq -r .packageId deployments/testnet.json) \
     --from-checkpoint $(jq -r .publishedAtCheckpoint deployments/testnet.json)
   ```
   The replay script reuses the same projector functions as the live loop. It reads in batches of 1000 events from `suix_queryEvents` and applies them in order. Replaying 30 days of testnet events takes ~5 minutes on a laptop (RPC-bound).

3. **Verify.** Replay computes a SHA-256 over `(table, primary_key, row_hash)` for every projected row and writes a single `replay_state_root` into `indexer_meta`. Two replays from the same checkpoint range MUST produce identical roots — this is checked in CI nightly via `pnpm --filter indexer verify-determinism`.

4. **Cold-store replay.** If the indexer needs to replay further back than the fullnode retains (Sui pruning), the cold-store JSONL archive is the source. `pnpm --filter indexer replay --from-archive YYYY-MM-DD` streams the archived files in order with the same projectors. The state root from a cold replay must match a hot replay over the same range — verified in CI.

5. **Genesis assertion.** After replay, the indexer asserts the **collateral invariant** AGENTS.md treats as load-bearing: for every `markets` row,
   ```
   vault_balance >= max(touch_exposure, no_touch_exposure)
   ```
   plus the per-position version: `sum(payout_if_win for open positions on side S) == exposure[S]`. Any mismatch fails the replay loudly — that's a Move-side conservation bug, and shipping the indexer is gated on it.

---

## Open questions / next decisions

- **Predict route events.** `predict_driver` is unwritten; it must emit `MarketCreated` with `driver_kind=1` and continue to emit `ObservationRecorded` so the indexer doesn't need a special case. Open: do Predict's own events get re-indexed too, or do we cross-reference via `oracle_id`?
- **Multi-collateral.** `MarketCreated.collateral_type: TypeName` is the one schema-level addition that lets the indexer key vaults by `(market_id, collateral_type)` cleanly. Confirm before freezing the event shape.
- **Tournament event volumes.** If we run hourly tournaments with thousands of entries, `BadgeAwarded` could spike to >100/s briefly. Worth budgeting a short-burst capacity test before launch.
