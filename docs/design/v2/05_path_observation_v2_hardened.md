# PathObservation v2 — Hardened Spec (post red-team)

Status: hardened design. Supersedes `docs/design/05_path_observation_v2.md`.
Audience: anyone touching `move/sources/path_observation.move`, `move/sources/wick_oracle.move`, the keeper bot, the on-chain Lazer verifier driver (H1), or `move/sources/market.move` settlement / redeem.
Scope: the load-bearing primitive that turns oracle ticks into a binary "did the price wick past the barrier" outcome, plus the oracle plumbing that feeds it observations the path can trust.
Non-goals: range / breakout / first-touch / vol-burst markets, Aptos / Decibel adapter, D collateral. Post-MVP, do not implement here.

This document closes every unmitigated finding from `docs/redteam/03_oracle_path.md` (14 attacks) and reflects hardening tasks H1 (on-chain Lazer signature verifier as primary driver) and H8 (path observation + impact fee snapshot at settlement lock).

The single most important change vs v1: **PathObservation no longer trusts caller-supplied prices**. Every observation that mutates touch state must transit through `WickOracle.apply_observation`, which under the hardened design either (a) verifies a Pyth Lazer secp256k1 signature on-chain (primary), (b) is gated behind a 3-of-5 multisig wrapper around `KeeperCap` (fallback), or (c) is produced by `random_walk_driver` whose entropy is `sui::random::Random` and not the submitter's tx digest.

---

## 1. Header — invariants this document promises to preserve

After every state transition involving a `WickOracle` or `PathObservation`:

1. **Sticky-touch correctness.** `touched_at = Some(ts)` only if at least `MIN_TOUCH_CONFIRMATIONS = 3` consecutive in-window oracle observations crossed the buffered trigger. A single bad tick cannot lock the outcome.
2. **First-post-expiry settlement lock.** `WickOracle.settlement_observation` is the *first* observation with `timestamp_ms >= expiry_ms`. Once locked, no driver may overwrite it.
3. **Frozen extremes at expiry.** `record` and `record_range` refuse to update `max_seen` / `min_seen` / `observation_count` / `touched_at` once `clock.timestamp_ms() >= expiry_ms`. Late ticks can advance `last_seen_ms` only for housekeeping.
4. **Oracle-resident range observations.** `record_range` accepts only observations that already live in `WickOracle.recent_observations` (a bounded ring buffer). Caller cannot fabricate `PriceObservation` values.
5. **Aborted is honored end-to-end.** `market::redeem` switches on `path_observation::settlement_state`. `Aborted` triggers refund-both-sides; it never collapses to "no-touch wins."
6. **Settlement reads a snapshot.** When the path transitions from `NotReady` to `Resolved` or `Aborted`, the tuple `(max_seen, min_seen, touched_at, observation_count)` is frozen into a `PathSnapshot` field. `market::redeem` reads the snapshot, not live state. This kills all post-lock racing.
7. **Driver-kind dispatch is locked at oracle creation and never re-keyed.** Each driver has a unique `driver_kind`; the oracle records the creator-time choice and `apply_observation` rejects mismatches. Reusing a driver kind across modules is forbidden.

The collateral invariant from `AGENTS.md` (`collateral_vault == total_touch_supply == total_no_touch_supply`) is unaffected by this document but depends on `market::redeem` honoring `Aborted` — see §7.

---

## 2. WickOracle struct v2 — hardened fields, locked dispatch, post-expiry freeze

```move
public struct WickOracle has key {
    id: UID,
    underlying: String,
    /// Locked at construction. Cannot change. Drives `apply_observation` dispatch.
    driver_kind: u8,
    /// bcs-encoded driver config. Interpreted only by the matching driver
    /// module. Validated structurally at `new` time when possible.
    driver_config: vector<u8>,

    /// Most recent observation. Backwards-compatible with v1.
    latest: Option<PriceObservation>,

    /// NEW: bounded ring buffer of recent observations. `record_range` consumes
    /// from here BY REFERENCE — caller passes indices, not values. Defends
    /// against Attack 9 (price-injection by no-touch holder).
    /// Capacity = RECENT_OBS_CAPACITY (default 32).
    recent_observations: vector<PriceObservation>,
    recent_head: u64,             // ring-buffer write index

    /// NEW: locked the first time we see an observation with ts >= expiry_ms.
    /// `lock_settlement_from_latest` consumes this, NOT `latest`. Defends
    /// against Attack 3 (stale-Lazer push to game freshness window).
    settlement_observation: Option<PriceObservation>,

    settlement_price: Option<u64>,
    expiry_ms: u64,
    settlement_freshness_ms: u64,

    /// NEW: post-expiry freeze flag. Computed (`now >= expiry_ms`) but stored
    /// as a hint so off-chain readers don't need to re-derive.
    is_post_expiry: bool,
}
```

Key behaviors:

- **`apply_observation` (dispatch core).** Asserts `driver_kind` match. If `obs.timestamp_ms >= expiry_ms` and `settlement_observation` is `None`, latches the observation into `settlement_observation` *atomically with* writing `latest`. Subsequent `apply_observation` calls with `obs.timestamp_ms >= expiry_ms` may still update `latest` (for off-chain telemetry) but **never overwrite** `settlement_observation`.
- **Ring buffer write.** Every accepted observation is appended to `recent_observations[recent_head % RECENT_OBS_CAPACITY]`, `recent_head++`. `path_observation::record_range` consumes by index, with on-chain bounds + monotonicity checks.
- **Driver kinds (locked, no reuse).** `driver_lazer_verified() = 0` (NEW: on-chain verifier), `driver_lazer_pull_multisig() = 1` (RENAMED: was `driver_lazer`), `driver_predict() = 2`, `driver_random_walk() = 3`. The previous `driver_lazer` value is removed; any deployed oracle with the old kind must be rotated.
- **Post-expiry freeze.** `apply_observation` accepts post-expiry ticks (needed for settlement lock) but path-side mutation logic (§5) refuses to advance `max_seen` / `min_seen` / `observation_count` / `touched_at` past `expiry_ms`.

Errors used:
```
const EWrongDriver: u64 = 0;
const EAlreadySettled: u64 = 1;
const ENotPastExpiry: u64 = 2;
const EStaleObservation: u64 = 3;
const ENoObservation: u64 = 4;
const ESettlementAlreadyLatched: u64 = 5;   // NEW
const EObservationOutOfRing: u64 = 6;       // NEW
```

---

## 3. Lazer verifier driver — primary driver, replacing the trusted pull driver

Hardening task H1: the keeper-trust pull driver is demoted to a multisig-gated fallback. The new primary driver is `wick::lazer_verifier_driver`, which verifies Pyth Lazer's secp256k1 signed updates **on-chain** before any state mutation.

### 3.1 Module shape

```move
module wick::lazer_verifier_driver;

use sui::clock::Clock;
use sui::ecdsa_k1;
use sui::hash;
use wick::price_observation::{Self, PriceObservation};
use wick::wick_oracle::{Self, WickOracle};

/// Permanent registry of trusted Lazer publisher pubkeys. AdminCap-gated
/// initially; long-term goal is an immutable on-chain mirror of Pyth Lazer's
/// publisher set, rotated only via a 7-day timelock.
public struct LazerPublisherRegistry has key {
    id: UID,
    /// Compressed secp256k1 pubkeys (33 bytes each). Order doesn't matter.
    publishers: vector<vector<u8>>,
    /// Number of distinct publisher signatures required per update.
    signature_threshold: u64,
    /// Max age of a Lazer signed update at acceptance time (default 5s).
    max_publish_age_ms: u64,
}

public struct LazerFeed has key {
    id: UID,
    oracle_id: ID,                   // 1:1 with a single WickOracle
    feed_id: u32,                    // Pyth Lazer feed identifier
    last_publish_time_ms: u64,       // strict monotonic guard
}

const ESignatureInvalid: u64 = 100;
const EThresholdNotMet: u64 = 101;
const EUnknownPublisher: u64 = 102;
const EFeedMismatch: u64 = 103;
const ENonMonotonic: u64 = 104;
const EUpdateTooStale: u64 = 105;
const EUpdateMalformed: u64 = 106;
```

### 3.2 The verifier entrypoint

```move
/// Anyone can call this. Authority comes from the signatures inside
/// `signed_update`, NOT from any cap on the caller. This is the entire point
/// of H1.
public entry fun push_verified(
    registry: &LazerPublisherRegistry,
    feed: &mut LazerFeed,
    oracle: &mut WickOracle,
    /// BCS-encoded { feed_id: u32, price: u64, exponent: i32, publish_time_ms: u64 }
    /// followed by `signature_count: u8` then `signature_count` × 65-byte
    /// (r || s || v) ECDSA signatures over keccak256(payload).
    signed_update: vector<u8>,
    clock: &Clock,
) {
    // 1. Parse payload + signatures.
    let (feed_id, price, publish_time_ms, sigs) =
        parse_signed_update(&signed_update);          // aborts EUpdateMalformed

    // 2. Bind to this feed/oracle pair.
    assert!(feed_id == feed.feed_id, EFeedMismatch);
    assert!(feed.oracle_id == object::id(oracle), EFeedMismatch);

    // 3. Freshness + monotonicity.
    let now = clock.timestamp_ms();
    assert!(now >= publish_time_ms, EUpdateTooStale);
    assert!(now - publish_time_ms <= registry.max_publish_age_ms, EUpdateTooStale);
    assert!(publish_time_ms > feed.last_publish_time_ms, ENonMonotonic);

    // 4. Verify signatures against registry. At least
    //    `registry.signature_threshold` distinct authorized publishers.
    let payload_hash = hash::keccak256(&payload_bytes(&signed_update));
    let valid = count_valid_signatures(
        &registry.publishers, &sigs, &payload_hash);  // dedup by pubkey
    assert!(valid >= registry.signature_threshold, EThresholdNotMet);

    // 5. State mutations only after all asserts.
    feed.last_publish_time_ms = publish_time_ms;
    let obs = price_observation::new(
        price, publish_time_ms, object::id(feed));
    wick_oracle::apply_observation(
        oracle, wick_oracle::driver_lazer_verified(), obs);
}
```

**Signature verification primitive.** Sui Move exposes `sui::ecdsa_k1::secp256k1_verify(signature, public_key, msg, hash_kind)`. We wrap each signature recovery + comparison in `count_valid_signatures`, dedup by pubkey to defeat double-counting, and abort on first malformed signature. Indicative cost: ~5,000 gas units per signature; threshold of 2-of-N publishers fits inside a normal Sui tx.

**What this kills.** Attacks 1 (compromised keeper), 2 (slow-keeper price selection — operator now has to forge signatures, not pick ticks), 3 (stale-Lazer push — pairs with §6 first-post-expiry latch), 11 (cross-driver confusion — verified-Lazer has its own kind value).

### 3.3 Multisig pull driver as fallback

`wick::pull_oracle_driver` survives, renamed conceptually to "multisig fallback." Changes vs v1:

- `KeeperCap` is wrapped in a `KeeperMultisig` object with `members: vector<address>` and `threshold: u64` (default 3-of-5).
- `push_price` requires a `MultisigApproval` resource produced by collecting `threshold` signed votes off-chain and submitting in one tx.
- `WickOracle.driver_kind` for fallback feeds is `driver_lazer_pull_multisig() = 1`, distinct from the verified driver.
- Used only as a break-glass when the verifier is degraded (e.g., publisher key rotation in flight). The README labels this loudly.

---

## 4. PathObservation v2 struct — N-consecutive ticks, Aborted state, snapshotted settlement

```move
public struct PathObservation has key {
    id: UID,
    oracle_id: ID,
    barrier: u64,                            // headline; UI shows this
    direction: u8,                           // 0=above, 1=below
    expiry_ms: u64,
    grace_ms: u64,
    buffer_bps: u64,                         // 0..=MAX_BUFFER_BPS
    min_observations: u64,                   // > 0
    observation_count: u64,

    /// NEW: random-walk-only rate limit. Lazer-verified ticks bypass entirely.
    /// Defends against Attack 10 (rate-limit DoS) by scoping rate-limit to the
    /// only driver where it makes sense.
    min_rw_record_interval_ms: u64,
    last_rw_record_call_ms: u64,

    /// NEW: consecutive-cross counter. Touch fires only when we see
    /// MIN_TOUCH_CONFIRMATIONS in a row. Defends against Attack 4 (single bad
    /// tick locks outcome).
    consecutive_cross_count: u64,
    /// NEW: confirmations required (default 3). Per-path so high-volatility
    /// underlyings can require more.
    touch_confirmations_required: u64,

    max_seen: u64,
    min_seen: u64,
    last_seen_ms: Option<u64>,
    /// First confirmed touch. Sticky once Some.
    touched_at: Option<u64>,

    /// NEW: snapshot taken at the moment settlement_state first becomes
    /// Resolved or Aborted. `market::redeem` consumes only this. Defends
    /// against Attacks 3, 7, 13 (post-lock racing).
    settlement_snapshot: Option<PathSnapshot>,
}

public struct PathSnapshot has copy, drop, store {
    state: u8,                  // SETTLEMENT_RESOLVED or SETTLEMENT_ABORTED
    max_seen: u64,
    min_seen: u64,
    touched_at: Option<u64>,
    observation_count: u64,
    locked_at_ms: u64,
}
```

State machine:

```
NotReady (state=0)
  │
  ├─ now >= expiry_ms ∧ touched_at.is_some()              → Resolved (HIT)
  ├─ now >= expiry_ms ∧ observation_count >= min_obs      → Resolved (EXPIRED-NO-TOUCH)
  └─ now >= expiry_ms + grace_ms ∧ count < min_obs        → Aborted (REFUND)
```

Once `settlement_snapshot` is `Some`, the path is *frozen for read*. No further `record` / `record_range` mutations affect outcomes (they may still be permitted as no-ops for keeper sanity).

Constants:
```
const DEFAULT_BUFFER_BPS: u64 = 10;
const DEFAULT_MIN_OBSERVATIONS: u64 = 6;
const DEFAULT_MIN_RW_RECORD_INTERVAL_MS: u64 = 250;
const DEFAULT_TOUCH_CONFIRMATIONS: u64 = 3;
const MAX_BUFFER_BPS: u64 = 1_000;
const BPS_DENOM: u128 = 10_000;

const SETTLEMENT_NOT_READY: u8 = 0;
const SETTLEMENT_RESOLVED: u8 = 1;
const SETTLEMENT_ABORTED: u8 = 2;
```

Errors:
```
const EOracleMismatch: u64 = 0;
const ENoObservation: u64 = 1;
const ENotYetExpired: u64 = 2;       // RENAMED from EAlreadyExpired (Attack 14 footgun fix)
const ERateLimited: u64 = 3;
const EInvalidDirection: u64 = 4;
const EInvalidConfig: u64 = 5;
const ENotReadyToSettle: u64 = 6;
const EInvalidRange: u64 = 7;
const ESnapshotAlreadyLocked: u64 = 8;     // NEW
const ERangeObservationNotResident: u64 = 9; // NEW
const EPostExpiryFrozen: u64 = 10;          // NEW
```

---

## 5. `record` and `record_range` — full updated functions

### 5.1 `record` — single point, oracle-driven

```move
public fun record(po: &mut PathObservation, oracle: &WickOracle, clock: &Clock) {
    assert!(po.oracle_id == object::id(oracle), EOracleMismatch);

    // Rate limit applies ONLY to random-walk-backed paths. Verified-Lazer
    // ticks are signed and unforgeable, so spam doesn't help an attacker.
    let now = clock.timestamp_ms();
    if (wick_oracle::driver_kind(oracle) == wick_oracle::driver_random_walk()) {
        if (po.last_rw_record_call_ms != 0) {
            assert!(
                now - po.last_rw_record_call_ms >= po.min_rw_record_interval_ms,
                ERateLimited,
            );
        };
        po.last_rw_record_call_ms = now;
    };

    // POST-EXPIRY FREEZE: refuse to mutate touch state past expiry. Defends
    // against the no-touch holder pushing a post-expiry record() to bump
    // max_seen and reset confirm-counter logic.
    if (now >= po.expiry_ms) {
        // We accept the call as a housekeeping no-op so keepers don't error
        // out on every tick after expiry.
        return
    };

    let latest_opt = wick_oracle::latest(oracle);
    assert!(option::is_some(latest_opt), ENoObservation);
    let obs = option::borrow(latest_opt);
    let obs_ts = price_observation::timestamp_ms(obs);
    let obs_price = price_observation::price(obs);

    // Stale-tick guard.
    if (option::is_some(&po.last_seen_ms)) {
        let last = *option::borrow(&po.last_seen_ms);
        if (obs_ts <= last) return;
    };

    // Observation must also be in-window.
    if (obs_ts > po.expiry_ms) return;

    // Update extremes + counter.
    if (obs_price > po.max_seen) po.max_seen = obs_price;
    if (obs_price < po.min_seen) po.min_seen = obs_price;
    po.observation_count = po.observation_count + 1;
    po.last_seen_ms = option::some(obs_ts);

    // N-consecutive-confirmation touch logic.
    if (is_touch_price(po, obs_price)) {
        po.consecutive_cross_count = po.consecutive_cross_count + 1;
        if (po.consecutive_cross_count >= po.touch_confirmations_required
            && option::is_none(&po.touched_at)) {
            po.touched_at = option::some(obs_ts);
            sui::event::emit(BarrierTouched {
                path_id: object::id(po),
                touched_at_ms: obs_ts,
                touch_price: obs_price,
                confirmations: po.consecutive_cross_count,
            });
        };
    } else {
        // Reset on any non-crossing tick. A touch is real, sustained crossing.
        po.consecutive_cross_count = 0;
    };

    sui::event::emit(TickRecorded {
        path_id: object::id(po),
        price: obs_price,
        timestamp_ms: obs_ts,
        new_min: po.min_seen,
        new_max: po.max_seen,
        consecutive: po.consecutive_cross_count,
    });
}
```

### 5.2 `record_range` — oracle-resident observations only

Caller passes **indices into the oracle's `recent_observations` ring**, not raw `PriceObservation` values. The function takes the oracle by reference; both observations are dereferenced from oracle storage.

```move
public fun record_range(
    po: &mut PathObservation,
    oracle: &WickOracle,
    low_idx: u64,
    high_idx: u64,
    clock: &Clock,
) {
    assert!(po.oracle_id == object::id(oracle), EOracleMismatch);

    let now = clock.timestamp_ms();
    if (now >= po.expiry_ms) return;   // post-expiry freeze

    let recent = wick_oracle::recent_observations(oracle);
    let cap = vector::length(recent);
    assert!(low_idx < cap && high_idx < cap, ERangeObservationNotResident);

    let low_obs = vector::borrow(recent, low_idx);
    let high_obs = vector::borrow(recent, high_idx);
    let l_ts = price_observation::timestamp_ms(low_obs);
    let h_ts = price_observation::timestamp_ms(high_obs);

    assert!(l_ts < h_ts, EInvalidRange);
    if (option::is_some(&po.last_seen_ms)) {
        assert!(l_ts > *option::borrow(&po.last_seen_ms), EInvalidRange);
    };
    assert!(h_ts <= po.expiry_ms, EInvalidRange);

    // Apply both extremes for the bookkeeping fields.
    let lo_p = price_observation::price(low_obs);
    let hi_p = price_observation::price(high_obs);
    if (hi_p > po.max_seen) po.max_seen = hi_p;
    if (lo_p < po.min_seen) po.min_seen = lo_p;
    po.observation_count = po.observation_count + 1;

    // Touch detection. The relevant extreme depends on direction.
    let probe_price = if (po.direction == touch_above()) hi_p else lo_p;
    let probe_ts    = if (po.direction == touch_above()) h_ts else l_ts;

    if (is_touch_price(po, probe_price)) {
        // record_range collapses an entire interval. Treat it as confirming
        // (touch_confirmations_required) — a Lazer-attested high above the
        // trigger across an interval is stronger than a single tick.
        po.consecutive_cross_count = po.touch_confirmations_required;
        if (option::is_none(&po.touched_at)) {
            po.touched_at = option::some(probe_ts);
            sui::event::emit(BarrierTouched {
                path_id: object::id(po),
                touched_at_ms: probe_ts,
                touch_price: probe_price,
                confirmations: po.consecutive_cross_count,
            });
        };
    } else {
        po.consecutive_cross_count = 0;
    };

    po.last_seen_ms = option::some(h_ts);
}
```

The critical change vs v1: **observations enter `record_range` only by reference into `WickOracle.recent_observations`**, killing Attack 9. A no-touch holder cannot mint a fake `PriceObservation` and pass it in; the only way to get an observation into the ring buffer is `wick_oracle::apply_observation`, which is dispatched by `driver_kind` and (for the primary driver) requires a verified Lazer signature.

---

## 6. Settlement lock semantics — first post-expiry observation, deterministic

The hardened `lock_settlement_from_latest` reads `settlement_observation`, not `latest`:

```move
public fun lock_settlement_from_latest(oracle: &mut WickOracle, clock: &Clock) {
    assert!(option::is_none(&oracle.settlement_price), EAlreadySettled);
    let now = clock.timestamp_ms();
    assert!(now >= oracle.expiry_ms, ENotPastExpiry);
    assert!(option::is_some(&oracle.settlement_observation), ENoObservation);

    let obs = option::borrow(&oracle.settlement_observation);
    let obs_ts = price_observation::timestamp_ms(obs);
    // Freshness still enforced relative to when the FIRST post-expiry obs was
    // latched, not relative to "now." This means a slow cranker can't burn
    // through the freshness window after settlement_observation was latched.
    assert!(now - obs_ts <= oracle.settlement_freshness_ms, EStaleObservation);

    let settle = price_observation::price(obs);
    oracle.settlement_price = option::some(settle);
    sui::event::emit(OracleSettled {
        oracle_id: object::id(oracle),
        settlement_price: settle,
        settled_at_ms: now,
    });
}
```

The latching happens inside `apply_observation` the moment any driver writes an observation with `timestamp_ms >= expiry_ms`. After that point:

- `latest` may continue to update (off-chain telemetry).
- `settlement_observation` is immutable.
- `lock_settlement_from_latest` is a pure read-the-latched-obs operation.

**Path-side settlement snapshot.** The first time `settlement_state(po, clock)` would return `Resolved` or `Aborted`, the next state-changing call latches `settlement_snapshot`:

```move
public fun lock_settlement_snapshot(po: &mut PathObservation, clock: &Clock) {
    assert!(option::is_none(&po.settlement_snapshot), ESnapshotAlreadyLocked);
    let state = compute_settlement_state(po, clock);
    assert!(state != SETTLEMENT_NOT_READY, ENotReadyToSettle);
    po.settlement_snapshot = option::some(PathSnapshot {
        state,
        max_seen: po.max_seen,
        min_seen: po.min_seen,
        touched_at: po.touched_at,
        observation_count: po.observation_count,
        locked_at_ms: clock.timestamp_ms(),
    });
    sui::event::emit(PathSettlementLocked {
        path_id: object::id(po),
        state,
        touched: option::is_some(&po.touched_at),
    });
}
```

This is a permissionless one-shot call. `market::settle_market` invokes it as the first thing it does. After lock, all subsequent reads consumed by `redeem` come from the snapshot.

---

## 7. `market::redeem` interaction — honor Aborted, read snapshot

This addresses Attack 14 directly. Today `wick::market::redeem` does:

```
won = (side == TOUCH && touched) || (side == NO_TOUCH && !touched)
```

…with no awareness of `Aborted`. Under v2 hardened:

```move
public fun redeem<C>(
    market: &mut Market<C>,
    path: &PathObservation,
    position: Position,
    ctx: &mut TxContext,
): Coin<C> {
    assert!(market.id == position.market_id, EMarketMismatch);
    let snap_opt = path_observation::settlement_snapshot(path);
    assert!(option::is_some(snap_opt), ENotReadyToSettle);
    let snap = option::borrow(snap_opt);

    if (path_observation::snapshot_state(snap) == SETTLEMENT_ABORTED) {
        // Aborted path: refund 1:1 to BOTH sides. No winner.
        return refund_one_to_one(market, position, ctx)
    };

    // Resolved path: read touched_at FROM SNAPSHOT, not live state.
    let touched = option::is_some(&path_observation::snapshot_touched_at(snap));
    let side = position.side;
    let won = (side == TOUCH && touched) || (side == NO_TOUCH && !touched);
    if (won) payout_winner(market, position, ctx)
    else     burn_losing_position(market, position, ctx)
}
```

`refund_one_to_one` returns the position holder's `amount` of `C` from the collateral vault, decrementing whichever supply (touch or no_touch) the position belonged to. The collateral invariant holds because both sides drain proportionally.

`market::settle_market` (cranked once per market post-expiry) calls `path_observation::lock_settlement_snapshot(path, clock)` exactly once and then transitions `Market.status` to one of `{HIT, EXPIRED, ABORTED}` based on the snapshot. `redeem` is gated on `status != Active`.

Idempotency: `lock_settlement_snapshot` aborts on second call (`ESnapshotAlreadyLocked`), and `market::settle_market` is itself idempotent (returns early if `status != Active`). No double-payout path.

---

## 8. Random-walk driver — `sui::random::Random` instead of `fresh_object_address`

(Out-of-band but in scope for the hardened path subsystem because random-walk is a driver kind.)

Replace the `tick` PRNG mix `sha2_256(nonce || clock_ms || fresh_object_address(ctx))` with `sui::random::Random`:

```move
use sui::random::{Self, Random, RandomGenerator};

public entry fun tick(
    rw: &mut RandomWalk,
    oracle: &mut WickOracle,
    r: &Random,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let now = clock.timestamp_ms();
    assert!(now > rw.last_tick_ms, ETooSoon);          // Attack 6 + 12 fix
    let mut gen = random::new_generator(r, ctx);
    let delta_bps = random::generate_u64_in_range(&mut gen, 0, MAX_DELTA_BPS) as i128;
    // ... apply walk, write observation ...
    rw.last_tick_ms = now;
}
```

`sui::random::Random` is a system-managed shared object that is unbiasable by validators within the BFT assumption and not foreseeable by transaction submitters. This kills Attack 5 (seed grinding) and Attack 6 (PTB tick reuse) at the root.

---

## 9. Mitigated attack table — all 14 attacks from `redteam/03_oracle_path.md`

| # | Attack | Mitigation in v2 hardened | Section |
|---|--------|---------------------------|---------|
| 1 | Compromised KeeperCap silently rewrites the truth | Primary driver is `lazer_verifier_driver` with on-chain secp256k1 verification of Pyth Lazer signatures; pull driver demoted to 3-of-5 multisig fallback with distinct `driver_kind` | §3 |
| 2 | Slow-keeper price selection | Verifier accepts only signed Lazer updates; operator cannot withhold ticks because anyone can submit a verified update; `record_range` consumes oracle-resident observations | §3, §5.2 |
| 3 | Stale-Lazer push to game freshness window | `settlement_observation` latched at *first* post-expiry observation in `apply_observation`; `lock_settlement_from_latest` reads the latch, never the live `latest` | §2, §6 |
| 4 | Sticky `touched_at` from a single bad tick | `MIN_TOUCH_CONFIRMATIONS = 3` consecutive crossing ticks required; counter resets on any non-crossing tick | §4, §5.1 |
| 5 | Random-walk seed grinding by market creator | `sui::random::Random` replaces `fresh_object_address` as entropy source | §8 |
| 6 | Same-tx tick reuse across PTBs | `tick` asserts `now > rw.last_tick_ms`; `sui::random::Random` is unforeseeable in PTB dry-run | §8 |
| 7 | Race-to-record front-running of touch tick | (a) `record` cannot fire touch on a single tick — needs 3 consecutive; (b) `market::open` rejects new positions when latest oracle obs already satisfies the buffered trigger; (c) snapshotted settlement reads | §4, §7, market.move addendum |
| 8 | Min-observations grief to force Aborted refund | Rate limit no longer per-path-blocking for verified-Lazer ticks; multiple geographically distributed verifier callers can crank; lower min_obs defaults documented | §5.1 |
| 9 | `record_range` price-injection by no-touch holder | `record_range` consumes `(low_idx, high_idx)` into `WickOracle.recent_observations` *by reference*; cannot fabricate `PriceObservation` values | §5.2 |
| 10 | Rate-limit bypass via multi-wallet front-running | Rate limit removed for verifier-driven and multisig-pull paths; retained only for random-walk paths where there's no attacker edge from spam | §5.1 |
| 11 | Spurious cross-oracle write via driver-kind confusion | Each driver gets a unique `driver_kind` value; verified-Lazer = 0, multisig-pull = 1, predict = 2, random-walk = 3; no reuse | §2 |
| 12 | Multi-tick spam in one block | `tick` asserts `now > last_tick_ms` (one tick per millisecond max); `sui::random::Random` doesn't permit deterministic foresight anyway | §8 |
| 13 | Oracle settlement-lock race for closing-price markets | First-post-expiry latch (§3) means there's only one settlement candidate; `lock_settlement_from_latest` is read-only over the latched value | §6 |
| 14 | `EAlreadyExpired` confusion + `touch_outcome` boolean ambiguity | Constant renamed `ENotYetExpired`; `market::redeem` switches on `settlement_state`; `Aborted` triggers `refund_one_to_one` with no winner | §4, §7 |

All 14 attacks have explicit mitigations in this document. Six required new on-chain code (the verifier, the snapshot, the ring buffer, the consecutive-counter, the first-post-expiry latch, the random-walk PRNG swap). Eight required structural changes (driver kinds, error renames, redeem-side switch, post-expiry freeze, rate-limit scoping, ring-buffer-by-reference, multisig wrapping, doc honesty).

---

## 10. Move pseudocode — full v2 module bodies

```move
module wick::path_observation;

use sui::clock::Clock;
use wick::price_observation;
use wick::wick_oracle::{Self, WickOracle};

// === Errors ===
const EOracleMismatch: u64 = 0;
const ENoObservation: u64 = 1;
const ENotYetExpired: u64 = 2;
const ERateLimited: u64 = 3;
const EInvalidDirection: u64 = 4;
const EInvalidConfig: u64 = 5;
const ENotReadyToSettle: u64 = 6;
const EInvalidRange: u64 = 7;
const ESnapshotAlreadyLocked: u64 = 8;
const ERangeObservationNotResident: u64 = 9;
const EPostExpiryFrozen: u64 = 10;

// === Constants ===
const DEFAULT_BUFFER_BPS: u64 = 10;
const DEFAULT_MIN_OBSERVATIONS: u64 = 6;
const DEFAULT_MIN_RW_RECORD_INTERVAL_MS: u64 = 250;
const DEFAULT_TOUCH_CONFIRMATIONS: u64 = 3;
const MAX_BUFFER_BPS: u64 = 1_000;
const BPS_DENOM: u128 = 10_000;

const SETTLEMENT_NOT_READY: u8 = 0;
const SETTLEMENT_RESOLVED: u8 = 1;
const SETTLEMENT_ABORTED: u8 = 2;

public fun touch_above(): u8 { 0 }
public fun touch_below(): u8 { 1 }

public struct PathObservation has key { /* …see §4… */ }
public struct PathSnapshot has copy, drop, store { /* …see §4… */ }

public struct PathCreated has copy, drop {
    path_id: ID, oracle_id: ID, barrier: u64, direction: u8, expiry_ms: u64,
}
public struct TickRecorded has copy, drop {
    path_id: ID, price: u64, timestamp_ms: u64,
    new_min: u64, new_max: u64, consecutive: u64,
}
public struct BarrierTouched has copy, drop {
    path_id: ID, touched_at_ms: u64, touch_price: u64, confirmations: u64,
}
public struct PathSettlementLocked has copy, drop {
    path_id: ID, state: u8, touched: bool,
}

public fun new(
    oracle: &WickOracle,
    barrier: u64, direction: u8,
    buffer_bps: u64, min_observations: u64,
    min_rw_record_interval_ms: u64, grace_ms: u64,
    touch_confirmations_required: u64,
    ctx: &mut TxContext,
): PathObservation {
    assert!(barrier > 0, EInvalidConfig);
    assert!(direction == touch_above() || direction == touch_below(), EInvalidDirection);
    assert!(buffer_bps <= MAX_BUFFER_BPS, EInvalidConfig);
    assert!(min_observations > 0, EInvalidConfig);
    assert!(touch_confirmations_required >= 1, EInvalidConfig);
    PathObservation {
        id: object::new(ctx),
        oracle_id: object::id(oracle),
        barrier, direction,
        expiry_ms: wick_oracle::expiry_ms(oracle),
        grace_ms, buffer_bps,
        min_observations,
        observation_count: 0,
        min_rw_record_interval_ms,
        last_rw_record_call_ms: 0,
        consecutive_cross_count: 0,
        touch_confirmations_required,
        max_seen: 0,
        min_seen: 18_446_744_073_709_551_615,
        last_seen_ms: option::none(),
        touched_at: option::none(),
        settlement_snapshot: option::none(),
    }
}

public fun new_with_defaults(
    oracle: &WickOracle, barrier: u64, direction: u8, ctx: &mut TxContext,
): PathObservation {
    new(oracle, barrier, direction,
        DEFAULT_BUFFER_BPS, DEFAULT_MIN_OBSERVATIONS,
        DEFAULT_MIN_RW_RECORD_INTERVAL_MS,
        DEFAULT_GRACE_MULTIPLIER * 60_000,
        DEFAULT_TOUCH_CONFIRMATIONS,
        ctx)
}

// effective_trigger / is_touch_price / record / record_range — see §5.

fun compute_settlement_state(po: &PathObservation, clock: &Clock): u8 {
    let now = clock.timestamp_ms();
    if (now < po.expiry_ms) return SETTLEMENT_NOT_READY;
    if (option::is_some(&po.touched_at)) return SETTLEMENT_RESOLVED;
    if (po.observation_count >= po.min_observations) return SETTLEMENT_RESOLVED;
    if (now >= po.expiry_ms + po.grace_ms) return SETTLEMENT_ABORTED;
    SETTLEMENT_NOT_READY
}

public fun settlement_state(po: &PathObservation, clock: &Clock): u8 {
    if (option::is_some(&po.settlement_snapshot)) {
        return po.settlement_snapshot.borrow().state;
    };
    compute_settlement_state(po, clock)
}

public fun lock_settlement_snapshot(po: &mut PathObservation, clock: &Clock) {
    assert!(option::is_none(&po.settlement_snapshot), ESnapshotAlreadyLocked);
    let state = compute_settlement_state(po, clock);
    assert!(state != SETTLEMENT_NOT_READY, ENotReadyToSettle);
    po.settlement_snapshot = option::some(PathSnapshot {
        state, max_seen: po.max_seen, min_seen: po.min_seen,
        touched_at: po.touched_at,
        observation_count: po.observation_count,
        locked_at_ms: clock.timestamp_ms(),
    });
    sui::event::emit(PathSettlementLocked {
        path_id: object::id(po), state,
        touched: option::is_some(&po.touched_at),
    });
}

public fun touch_outcome(po: &PathObservation, clock: &Clock): bool {
    let st = settlement_state(po, clock);
    assert!(st == SETTLEMENT_RESOLVED, ENotReadyToSettle);
    if (option::is_some(&po.settlement_snapshot)) {
        option::is_some(&po.settlement_snapshot.borrow().touched_at)
    } else {
        option::is_some(&po.touched_at)
    }
}

public fun settlement_snapshot(po: &PathObservation): &Option<PathSnapshot> {
    &po.settlement_snapshot
}
public fun snapshot_state(s: &PathSnapshot): u8 { s.state }
public fun snapshot_touched_at(s: &PathSnapshot): &Option<u64> { &s.touched_at }
public fun snapshot_max_seen(s: &PathSnapshot): u64 { s.max_seen }
public fun snapshot_min_seen(s: &PathSnapshot): u64 { s.min_seen }
```

---

## 11. Test scenarios — 18 total (12 from v1 + 6 new for hardening)

| # | Test | Setup → Expected |
|---|------|---|
| 1 | `buffer_skips_at_barrier` | barrier=100, buffer=10 bps, push obs=100. → not touched. |
| 2 | `buffer_fires_above_buffer_after_3_confirmations` | barrier=100, buffer=10 bps, push obs=100.10 three times. → touched on 3rd. |
| 3 | `buffer_below_symmetry` | direction=below, barrier=100, buffer=25 bps, 3× obs=99.74. → not touched. 3× obs=99.75. → touched. |
| 4 | `buffer_zero_legacy_compat` | buffer=0, 3× obs==barrier. → touched. |
| 5 | `min_obs_blocks_settle` | min=6, 5 ticks, advance past expiry. → `settlement_state == NotReady`. 6th tick. → `Resolved`. |
| 6 | `min_obs_aborts_after_grace` | min=6, 2 ticks, advance past expiry+grace. → `Aborted`. |
| 7 | `touched_short_circuits_min_obs` | 3 consecutive touch ticks, then expiry. → `Resolved (touched)`. |
| 8 | `rate_limit_only_for_random_walk` | RW driver, 250ms limit, two `record` calls 100ms apart. → second aborts `ERateLimited`. Same scenario on Lazer driver. → both succeed. |
| 9 | `rate_limit_allows_after_window` | RW driver, two RW calls 300ms apart. → both succeed. |
| 10 | `out_of_order_observation_is_noop` | record obs ts=1000. apply older obs ts=900 to oracle. → no-op. |
| 11 | `same_observation_twice_is_noop` | record obs ts=1000. call `record` again. → no-op. |
| 12 | `post_expiry_record_is_pure_noop` | obs ts > expiry, call record. → `observation_count`, `max_seen`, `touched_at` all unchanged. |
| 13 | **`single_bad_tick_does_not_lock_outcome`** (NEW Attack 4) | One spike obs above trigger followed by 5 obs below. → `touched_at == None`, `consecutive_cross_count == 0`. |
| 14 | **`record_range_rejects_non_resident_observation`** (NEW Attack 9) | call `record_range` with `low_idx == 9999`. → aborts `ERangeObservationNotResident`. |
| 15 | **`record_range_consumes_ring_indices_only`** (NEW Attack 9) | apply 5 observations through `apply_observation`; `record_range(low_idx=1, high_idx=3)` with high_obs.price > trigger. → `touched_at` set to high_obs.ts, snapshot reflects max_seen=high price. |
| 16 | **`settlement_lock_uses_first_post_expiry_obs`** (NEW Attack 3) | Push obs at ts=expiry+1 (price=P_first), then ts=expiry+30s (price=P_extreme). Call `lock_settlement_from_latest`. → `settlement_price == P_first`. |
| 17 | **`market_redeem_refunds_aborted`** (NEW Attack 14) | path enters `Aborted`, lock_settlement_snapshot, TOUCH and NO_TOUCH holders both call `redeem`. → both receive 1:1 refund; collateral_vault drains to zero; invariant holds. |
| 18 | **`snapshot_freezes_outcome_against_post_lock_writes`** (NEW H8) | resolve a no-touch path, lock snapshot, attempt to push a fake "touch" through `apply_observation` post-lock. → `redeem` for NO_TOUCH still wins; snapshot path values unchanged. |

Bonus (write if time): `invalid_direction_aborts`, `barrier_zero_aborts`, `buffer_above_max_aborts`, `effective_trigger_no_overflow_at_u64_max_barrier`, `touch_below_underflow_safety_at_full_buffer`, `lazer_verifier_rejects_unsigned_update`, `lazer_verifier_rejects_below_threshold_signatures`, `lazer_verifier_rejects_replay_with_old_publish_time`, `random_walk_tick_rejects_same_ms_repeat`.

---

## 12. Open questions (deferred, not blocking ship)

- **Publisher-set rotation cadence.** 7-day timelock or AdminCap with a 24-hour grace? Punted to H9 (AdminCap hard caps).
- **Ring-buffer capacity tuning.** 32 entries comfortably covers a 30-second range gap at 10 Hz Lazer. If Predict integration adds a slower second source, consider 128.
- **Aborted refund accounting.** 1:1 by collateral. Fee handling on aborted markets (return fees? keep in insurance fund?) is decided in H10.
- **Multisig fallback scope.** Should multisig-pull be allowed at all in production, or only on testnet behind a feature flag? Argument for testnet-only: any unverified path is a footgun. Argument for keeping it: publisher key emergencies. Recommend: keep, but mark each oracle's `driver_kind` clearly in the UI ("verified" vs "multisig-fallback") so traders can self-select.

---

## 13. Compatibility notes for downstream agents

- `wick::market` must be updated to call `path_observation::lock_settlement_snapshot` in `settle_market`, then read snapshot fields in `redeem`. See task #87 (Phase C.3) and task #105 (H8).
- The keeper bot must learn three things: how to submit a verified Lazer update (no cap needed), how to call `lock_settlement_snapshot` once `settlement_state` first transitions, and how to call `lock_settlement_from_latest` (unchanged signature, new latch semantics).
- The frontend should label markets by `driver_kind` and surface `settlement_state` ∈ {NotReady, Resolved, Aborted} so an aborted market's UI is unambiguous (badge: "REFUND — keeper outage").
- Indexer events to add to schema: `PathSettlementLocked`, `BarrierTouched.confirmations`, `TickRecorded.consecutive`, `OracleSettled.settled_at_ms` (already present).

End of v2 hardened spec.
