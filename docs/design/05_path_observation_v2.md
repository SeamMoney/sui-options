# PathObservation v2 — Touch Detection Spec

Status: design draft
Audience: anyone touching `move/sources/path_observation.move`, the keeper, or settlement
Scope: load-bearing primitive that turns oracle ticks into a binary "did the price wick past the barrier" outcome
Non-goals: range / breakout, first-touch, vol-burst (post-MVP)

## 0. Motivation and v1 recap

v1 records `min_seen` / `max_seen` and a sticky `touched_at`, fires touch on `obs_price >= barrier` (above) or `obs_price <= barrier` (below), and lets `touch_outcome` resolve after expiry. It is correct for happy-path keepers and identical-tick streams. But it has six load-bearing holes that make it unsafe to wire into real money:

1. **Empty-path bias.** Zero ticks → no-touch wins. Asymmetric and exploitable by a keeper who simply doesn't tick.
2. **Oracle latency.** A 5s gap between Lazer ticks can miss touches that print on Binance.
3. **Jitter / dust.** A one-microsecond blip at exactly the barrier shouldn't pay out a touch.
4. **Rounding.** With 1e9 scaling and `>=` semantics, sub-cent moves can decide a market.
5. **MEV.** Whoever lands the first crossing tick decides the outcome.
6. **Settlement handoff.** No defined predicate for "this PathObservation is ready to settle"; markets currently just call `touch_outcome` after expiry.

v2 fixes all six with explicit, testable rules.

## 1. `barrier_buffer_bps` — minimum touch margin

Barrier crossings must clear a configurable buffer to count. The barrier the keeper, UI, and oracle quote stays the *headline* number; the *effective trigger* is shifted outward by `buffer_bps`.

Effective trigger:

```
touch_above:  effective_trigger = barrier × (10_000 + buffer_bps) / 10_000
touch_below:  effective_trigger = barrier × (10_000 − buffer_bps) / 10_000
touch fires when:
  above: obs_price >= effective_trigger
  below: obs_price <= effective_trigger
```

Default: **`buffer_bps = 10`** (10 bps, 0.10%). Justification:

- Pyth Lazer's 1σ noise on BTC/SUI/ETH at 100ms intervals sits comfortably under 5 bps in normal regimes. 10 bps buys a 2σ margin against quote noise without making the product feel "wide."
- A trader pricing a touch on BTC at $100,000 sees the trigger at $100,100. At weekly notional sizes of $5–$20 this is the right order of magnitude — the buffer is visible but not punitive.
- Multiplication is in u128 to avoid u64 overflow at large prices: `((barrier as u128) * (10_000 + buffer_bps as u128)) / 10_000` then narrow back. Reject `buffer_bps > 1_000` (10%) at construction; anything bigger is almost certainly a config error.
- Stored on the path, not the oracle, because two paths on the same oracle (different barriers / directions) can want different sensitivities.

Headline `barrier` remains what the UI displays and what `mark_hit` events reference. Only the matching predicate uses the shifted value.

## 2. Minimum observations required

`min_observations: u64` (default **N = 6**) is required before settlement may resolve. Justification: at a 5-second keeper cadence over a 60s minimum window, six ticks is a 30-second floor — long enough that "no ticks" is keeper failure, not a normal state. Counted as `observation_count`, incremented exactly once per non-stale `record` call.

Two failure paths to define:

- **Happy.** `observation_count >= min_observations` *and* `clock.timestamp_ms() >= expiry_ms` → `can_settle` is true. Settlement reads `touched_at`.
- **Insufficient observations after expiry.** If `clock.timestamp_ms() >= expiry_ms + grace_ms` (grace `= 5 × settlement_freshness_ms`, default 5 minutes) *and* `observation_count < min_observations`, the path enters `Aborted` status. Settlement returns funds 1:1 to TOUCH and NO_TOUCH holders via `wick::market::refund_aborted` (no winner, no loser). This protects against keeper-failure outcomes being decided by chance.

The grace window also prevents a griefer from racing settlement before the keeper can backfill ticks.

## 3. Latency / interpolation between ticks

Pick **(c) require keeper to push high+low between ticks** — but make it backward compatible.

Rationale:

- (a) point-only is the cheapest but bakes in the latency hole.
- (b) on-chain linear interpolation is a fiction (BTC didn't actually trace a line) and creates an MEV surface (a malicious tick at the right time *invents* a touch).
- (c) preserves on-chain truth: every recorded crossing corresponds to a real oracle observation. The keeper's job grows: between every two consumed ticks, push a `record_range(po, oracle, low, high, ts_low, ts_high, attestation, clock)` call with two attested observations from the upstream feed (Lazer aggregate min/max for the interval).

API shape:

```move
public fun record(po, oracle, clock);                       // single point, as v1
public fun record_range(po, oracle, low_obs, high_obs, clock);  // attested range
```

`record_range` consumes two `PriceObservation`s already-applied to the WickOracle (via Lazer's range-attestation extension). Both observations must:

- carry `timestamp_ms` strictly between `last_seen_ms` and the current `latest`
- be signed/attested by the same driver kind as the oracle
- pass the same buffer logic — the *high* counts for touch-above, the *low* for touch-below

Until the Lazer range extension ships, `record_range` is unimplemented and the keeper documents the latency-gap risk in the README. v2's design doesn't *depend* on it — it slots in cleanly when ready.

## 4. Permissionless ticking — abuse surface

Anyone calls `record`. Where can this hurt?

- **Stale-tick spam.** Already a no-op (`obs_ts <= last_seen_ms`). Unchanged.
- **Forced gas burn.** Permissionless callers pay their own gas; the path object only mutates if `obs_ts` advanced. Bounded by oracle update frequency.
- **Race to land the touch tick.** Whoever gets the touch-firing transaction in first sets `touched_at` to *that observation's timestamp*, but the **observation's price is the oracle's, not the caller's**. So spam doesn't change the outcome — it can only race to *be* the recorder. No payment to the recorder, no incentive.
- **Tick-ordering manipulation.** Two callers race to record different observations. Both observations come from the same WickOracle's `latest` slot, which is single-valued — they're racing to record the same data. No divergence.

Protections we *do* keep:

- **Per-oracle dedup** (already in v1 via `obs_ts <= last_seen_ms`).
- **`min_record_interval_ms` rate limit** (default 250 ms) — reject `record` if `clock.timestamp_ms() - last_record_call_ms < min_record_interval_ms`. Bounds the per-block call rate so a malicious caller can't fill a block with no-op ticks against this object. Stored on the path.
- **No bonding, no auctions.** The recorder has no edge; bonding is overkill. Keeper-bot bonding is reconsidered if/when we move to incentivized cranks.

## 5. Settlement interaction with WickOracle

Two distinct settlements: the *path* settles the touch outcome; the *oracle* settles a single closing price. They are independent and both must resolve.

`path_observation::can_settle(po, clock): bool` returns true iff:

```
clock.timestamp_ms() >= po.expiry_ms
  AND
( po.observation_count >= po.min_observations
    OR po.is_touched()                            // touch is sticky and proven; resolve early-OK at expiry
    OR clock.timestamp_ms() >= po.expiry_ms + po.grace_ms )  // grace lapsed → aborted path
```

Three settlement states exposed:

```move
public fun settlement_state(po, clock): u8
// 0 = NotReady, 1 = Resolved, 2 = Aborted
```

- **Resolved.** Read `touch_outcome(po, clock)`; market's `mark_hit` / `settle_expired` consumes it.
- **Aborted.** `market::refund_aborted` returns collateral 1:1.

**Contract with WickOracle.** PathObservation does not call WickOracle. It only *reads* `latest`. The settlement order in `wick::settle`:

1. Caller cranks `wick_oracle::lock_settlement_from_latest` first. This needs a fresh post-expiry observation per the existing `settlement_freshness_ms` rule. The locked observation is the **first observation with `timestamp_ms >= expiry_ms`** within the freshness window — i.e., post-expiry first, not "at expiry" or "latest." This is already what v1 enforces (`obs_ts >= oracle.expiry_ms`), and PathObservation v2 does not change it.
2. Caller calls `path_observation::can_settle`; if true, `market::settle_market(market, path, oracle, clock)` runs.
3. The path consumes its own state — touch was decided in-window via `record` calls — and the settlement-locked oracle price is used only for *closing-price-dependent* features (none in MVP). Touch markets do not read `settlement_price` for the touch decision.

This separation keeps PathObservation honest: the touch question is "did any in-window observation cross the buffered barrier," not "what was the closing price."

## 6. Edge cases — exhaustive list

| # | Case | v2 behavior |
|---|------|---|
| 1 | `obs_price == barrier` exactly | Does NOT touch (buffer requires strictly past `barrier × (1 ± buffer_bps/10_000)`). With `buffer_bps = 0`, falls back to `>=` / `<=` — explicit and tested. |
| 2 | Observation `ts == expiry_ms` | Counts. Window is `[oracle.created_ms, expiry_ms]` inclusive on both ends. |
| 3 | Two observations with identical `ts` | Second is rejected as stale (`obs_ts <= last_seen_ms`). Single source of truth = oracle `latest`. |
| 4 | Negative-direction confusion | `direction` ∈ `{0, 1}` checked at `new`. Any other value aborts `EInvalidDirection`. |
| 5 | Observations recorded out of order (keeper retry) | Older observation is stale → no-op. New `record_range` requires `low.ts < high.ts` and both `> last_seen_ms`. |
| 6 | Same observation recorded twice | No-op; `obs_ts == last_seen_ms` is rejected. |
| 7 | Recording on a settled oracle | Allowed but no-op: `WickOracle.latest` won't advance after settlement (no driver `apply_observation` accepted post-`settlement_price`). PathObservation just sees stale ticks. |
| 8 | Recording past `expiry_ms` | Accept the observation but clamp `effective_ts = min(obs_ts, expiry_ms)` and only count it if `obs_ts <= expiry_ms + grace_ms`. Bound `observation_count` increment to in-window ticks only. |
| 9 | First observation is a touch | Allowed; `min_observations` still required for `can_settle` (but a touch is sticky, so as soon as `expiry_ms` is past, settlement resolves Touch). |
| 10 | `min_observations == 0` | Rejected at `new` (`EInvalidConfig`). Force a real floor. |
| 11 | `buffer_bps > 1_000` | Rejected at `new`. |
| 12 | `barrier == 0` | Rejected at `new`. |
| 13 | Rate-limit collision (two callers in same ms) | Second aborts `ERateLimited`; transaction rolls back, no state mutation. |
| 14 | Clock drift (clock.now < obs.ts) | Allowed — observation timestamp wins for window membership. Clock is only read for settlement-side gating. |
| 15 | Underflow on `barrier × (10_000 - buffer_bps)` for touch-below | Use u128 arithmetic; `buffer_bps <= 1_000` keeps multiplier `>= 9_000`, so no underflow. |
| 16 | Settlement called before `can_settle` true | Aborts `ENotReadyToSettle`. |
| 17 | Settlement called after `can_settle` true but oracle not yet locked | Path resolves anyway; oracle settlement is decoupled (no read of `settlement_price` for touch markets). |
| 18 | Path attached to oracle whose `expiry_ms` was post-construction (impossible today, but) | `expiry_ms` is snapshotted at `new`; later changes (none possible in current oracle) would not affect the path. |

## 7. MEV analysis

Surface area, ordered by severity:

**(a) Race to be the touch-firing recorder.** Multiple bots try to land the same crossing observation. Outcome: identical state mutation regardless of who wins. *No edge.* The recorder doesn't get paid, can't shift the price, and can't pick which observation to record (there's only one `latest`). Gas-only cost.

**(b) Trader-side sandwich around `record`.** Trader sees a tick about to cross, opens a Touch position, then lands the `record` call. *Mitigated* by the buffer (the move has to clear `barrier × (1 + buffer_bps/10_000)`) and by AMM swap fees + slippage. Also mitigated by the fact that the relevant oracle observation must already be present in the WickOracle — the trader doesn't get to invent it. The window for this attack is one block.

**(c) Builder/validator ordering.** A Sui validator could reorder `record` against trades within their epoch. This is the same MEV every Sui DEX faces; not unique to Wick. Mitigations are general (private mempools, fair-ordering); we don't add path-specific defense.

**(d) Just-in-time barrier opening.** Permissionless `wick::create_*_market` means anyone can open a market with a barrier `epsilon` from the current price right before an expected tick. *Mitigated* at the market-creation layer, not here: enforce `min_window_ms` and `min_barrier_distance_bps` from current oracle price. Documented dependency, not implemented in PathObservation.

**(e) Aborted-path griefing.** A griefer suppresses ticks (e.g., DDoSes the keeper) hoping for an `Aborted` outcome that refunds. *Mitigated* by permissionless ticking (anyone can crank) plus the grace window. Cost-of-attack scales with how many independent recorders exist.

**Mitigations chosen:**
- Buffer (Section 1).
- Min-observations + grace (Section 2).
- Rate limit (Section 4).
- *Not* commit-reveal: adds 1+ block of latency to every tick, which kills the responsiveness Wick is sold on. The "race to record" attack doesn't actually have an edge, so the cure is worse than the disease.
- *Not* bonded keeper: permissionless cranking is a feature; bonding centralizes.
- *Not* auction: there's nothing to auction (no recorder reward).

Net: the load-bearing MEV defense is the buffer + min-observations. Both are explicit and tunable per market.

## 8. Move pseudocode

```move
module wick::path_observation;

use sui::clock::Clock;
use wick::price_observation::{Self, PriceObservation};
use wick::wick_oracle::{Self, WickOracle};

// === Errors ===
const EOracleMismatch: u64 = 0;
const ENoObservation: u64 = 1;
const EAlreadyExpired: u64 = 2;
const ERateLimited: u64 = 3;
const EInvalidDirection: u64 = 4;
const EInvalidConfig: u64 = 5;
const ENotReadyToSettle: u64 = 6;
const EInvalidRange: u64 = 7;

// === Constants ===
const DEFAULT_BUFFER_BPS: u64 = 10;
const DEFAULT_MIN_OBSERVATIONS: u64 = 6;
const DEFAULT_MIN_RECORD_INTERVAL_MS: u64 = 250;
const DEFAULT_GRACE_MULTIPLIER: u64 = 5; // grace = 5 × oracle.settlement_freshness_ms
const MAX_BUFFER_BPS: u64 = 1_000; // 10%
const BPS_DENOM: u128 = 10_000;

// settlement_state values
const SETTLEMENT_NOT_READY: u8 = 0;
const SETTLEMENT_RESOLVED: u8 = 1;
const SETTLEMENT_ABORTED: u8 = 2;

public fun touch_above(): u8 { 0 }
public fun touch_below(): u8 { 1 }

public struct PathObservation has key {
    id: UID,
    oracle_id: ID,
    barrier: u64,                 // headline; UI shows this
    direction: u8,
    expiry_ms: u64,
    grace_ms: u64,                // window past expiry that abort logic uses
    buffer_bps: u64,              // 0..=MAX_BUFFER_BPS
    min_observations: u64,        // > 0
    min_record_interval_ms: u64,  // >= 0
    observation_count: u64,
    last_record_call_ms: u64,     // wall clock of most recent record call
    max_seen: u64,
    min_seen: u64,
    last_seen_ms: Option<u64>,
    touched_at: Option<u64>,
}

public fun new(
    oracle: &WickOracle,
    barrier: u64,
    direction: u8,
    buffer_bps: u64,
    min_observations: u64,
    min_record_interval_ms: u64,
    grace_ms: u64,
    ctx: &mut TxContext,
): PathObservation {
    assert!(barrier > 0, EInvalidConfig);
    assert!(direction == touch_above() || direction == touch_below(), EInvalidDirection);
    assert!(buffer_bps <= MAX_BUFFER_BPS, EInvalidConfig);
    assert!(min_observations > 0, EInvalidConfig);
    let po = PathObservation {
        id: object::new(ctx),
        oracle_id: object::id(oracle),
        barrier,
        direction,
        expiry_ms: wick_oracle::expiry_ms(oracle),
        grace_ms,
        buffer_bps,
        min_observations,
        min_record_interval_ms,
        observation_count: 0,
        last_record_call_ms: 0,
        max_seen: 0,
        min_seen: 18446744073709551615,
        last_seen_ms: option::none(),
        touched_at: option::none(),
    };
    sui::event::emit(PathCreated { /* … */ });
    po
}

/// Convenience constructor with sensible defaults.
public fun new_with_defaults(
    oracle: &WickOracle, barrier: u64, direction: u8, ctx: &mut TxContext,
): PathObservation {
    let grace = DEFAULT_GRACE_MULTIPLIER * 60_000; // tune from oracle in caller
    new(oracle, barrier, direction,
        DEFAULT_BUFFER_BPS, DEFAULT_MIN_OBSERVATIONS,
        DEFAULT_MIN_RECORD_INTERVAL_MS, grace, ctx)
}

// === Effective trigger (pure) ===
fun effective_trigger(po: &PathObservation): u64 {
    let b = po.barrier as u128;
    let triggered = if (po.direction == touch_above()) {
        (b * (BPS_DENOM + (po.buffer_bps as u128))) / BPS_DENOM
    } else {
        (b * (BPS_DENOM - (po.buffer_bps as u128))) / BPS_DENOM
    };
    triggered as u64
}

fun is_touch_price(po: &PathObservation, price: u64): bool {
    let trigger = effective_trigger(po);
    if (po.direction == touch_above()) price >= trigger
    else price <= trigger
}

// === Record — single point ===
public fun record(po: &mut PathObservation, oracle: &WickOracle, clock: &Clock) {
    assert!(po.oracle_id == object::id(oracle), EOracleMismatch);
    let now = clock.timestamp_ms();
    if (po.last_record_call_ms != 0) {
        assert!(now - po.last_record_call_ms >= po.min_record_interval_ms, ERateLimited);
    };
    po.last_record_call_ms = now;

    let latest = wick_oracle::latest(oracle);
    assert!(option::is_some(latest), ENoObservation);
    let obs = option::borrow(latest);
    let obs_ts = price_observation::timestamp_ms(obs);
    let obs_price = price_observation::price(obs);

    if (option::is_some(&po.last_seen_ms)) {
        let last = *option::borrow(&po.last_seen_ms);
        if (obs_ts <= last) return;
    };

    let in_window = obs_ts <= po.expiry_ms;
    let effective_ts = if (obs_ts > po.expiry_ms) po.expiry_ms else obs_ts;

    if (in_window) {
        if (obs_price > po.max_seen) po.max_seen = obs_price;
        if (obs_price < po.min_seen) po.min_seen = obs_price;
        po.observation_count = po.observation_count + 1;

        if (is_touch_price(po, obs_price) && option::is_none(&po.touched_at)) {
            po.touched_at = option::some(effective_ts);
            sui::event::emit(BarrierTouched { /* … */ });
        };
    };
    po.last_seen_ms = option::some(effective_ts);
    sui::event::emit(TickRecorded { /* … */ });
}

/// Range record — two attested observations spanning a (low, high) interval
/// the keeper observed from the upstream feed. Both must postdate last_seen.
public fun record_range(
    po: &mut PathObservation, oracle: &WickOracle,
    low_obs: PriceObservation, high_obs: PriceObservation,
    clock: &Clock,
) {
    assert!(po.oracle_id == object::id(oracle), EOracleMismatch);
    let l_ts = price_observation::timestamp_ms(&low_obs);
    let h_ts = price_observation::timestamp_ms(&high_obs);
    assert!(l_ts < h_ts, EInvalidRange);
    if (option::is_some(&po.last_seen_ms)) {
        assert!(l_ts > *option::borrow(&po.last_seen_ms), EInvalidRange);
    };
    // Apply the relevant extreme based on direction.
    let probe_price = if (po.direction == touch_above())
        price_observation::price(&high_obs) else price_observation::price(&low_obs);
    let probe_ts = if (po.direction == touch_above()) h_ts else l_ts;
    let in_window = probe_ts <= po.expiry_ms;
    let effective_ts = if (probe_ts > po.expiry_ms) po.expiry_ms else probe_ts;
    if (in_window && is_touch_price(po, probe_price) && option::is_none(&po.touched_at)) {
        po.touched_at = option::some(effective_ts);
        sui::event::emit(BarrierTouched { /* … */ });
    };
    po.observation_count = po.observation_count + 1;
    po.last_seen_ms = option::some(h_ts);
}

// === Settlement predicate ===
public fun can_settle(po: &PathObservation, clock: &Clock): bool {
    let now = clock.timestamp_ms();
    if (now < po.expiry_ms) return false;
    if (option::is_some(&po.touched_at)) return true;
    if (po.observation_count >= po.min_observations) return true;
    now >= po.expiry_ms + po.grace_ms
}

public fun settlement_state(po: &PathObservation, clock: &Clock): u8 {
    let now = clock.timestamp_ms();
    if (now < po.expiry_ms) return SETTLEMENT_NOT_READY;
    if (option::is_some(&po.touched_at)) return SETTLEMENT_RESOLVED;
    if (po.observation_count >= po.min_observations) return SETTLEMENT_RESOLVED;
    if (now >= po.expiry_ms + po.grace_ms) return SETTLEMENT_ABORTED;
    SETTLEMENT_NOT_READY
}

public fun touch_outcome(po: &PathObservation, clock: &Clock): bool {
    assert!(can_settle(po, clock), ENotReadyToSettle);
    option::is_some(&po.touched_at)
}

public fun is_aborted(po: &PathObservation, clock: &Clock): bool {
    settlement_state(po, clock) == SETTLEMENT_ABORTED
}

// Existing reads stay (oracle_id, barrier, direction, expiry_ms,
// max_seen, min_seen, last_seen_ms, touched_at, is_touched) +
// observation_count, buffer_bps, min_observations, effective_trigger.
```

`market::settle_market` switches on `settlement_state`:

```move
let state = path_observation::settlement_state(path, clock);
if (state == 1) { /* HIT or EXPIRED based on touch_outcome */ }
else if (state == 2) { market::refund_aborted(market, ctx) }
else { abort ENotReadyToSettle }
```

## 9. Test scenarios

| # | Test | Setup → Expected |
|---|------|---|
| 1 | `buffer_skips_at_barrier` | barrier=100, buffer=10 bps, push obs=100. → not touched. |
| 2 | `buffer_fires_above_buffer` | barrier=100, buffer=10 bps, push obs=100.10. → touched (above). |
| 3 | `buffer_below_symmetry` | direction=below, barrier=100, buffer=25 bps, push obs=99.74. → not touched. obs=99.75. → touched. |
| 4 | `buffer_zero_legacy_compat` | buffer=0, push obs==barrier. → touched (back-compat with v1 semantics). |
| 5 | `min_obs_blocks_settle` | min=6, record 5 ticks, advance past expiry. → `can_settle == false`. Record 6th. → `can_settle == true`. |
| 6 | `min_obs_aborts_after_grace` | min=6, record 2 ticks, advance past expiry+grace. → `settlement_state == ABORTED`, `touch_outcome` aborts. |
| 7 | `touched_short_circuits_min_obs` | min=6, record 1 ticks that touches, advance past expiry. → `can_settle == true` (touch is proven). |
| 8 | `rate_limit_rejects_burst` | min_interval=250ms, two `record` calls 100ms apart. → second aborts `ERateLimited`. |
| 9 | `rate_limit_allows_after_window` | min_interval=250ms, two calls 300ms apart. → both succeed. |
| 10 | `out_of_order_observation_is_noop` | Record obs ts=1000. Apply older obs ts=900 to oracle. → `record` is no-op, `observation_count` unchanged. |
| 11 | `same_observation_twice_is_noop` | Record obs ts=1000. Call `record` again with same `latest`. → no-op, `observation_count` unchanged. |
| 12 | `post_expiry_record_does_not_count` | obs ts > expiry_ms, push to oracle, call record. → `observation_count` unchanged, `last_seen_ms` clamped to expiry. |
| 13 | `record_range_attested_high_fires_touch` | direction=above, last_seen=1000, push range (low=ts1500/p99, high=ts1800/p101). barrier=100, buffer=0. → touched_at = 1800. |
| 14 | `record_range_rejects_overlap` | last_seen=2000, range low.ts=1500. → aborts `EInvalidRange`. |
| 15 | `settlement_handoff_decouples_from_oracle_lock` | path resolves before `wick_oracle::lock_settlement_from_latest` is called. → `market::settle_market` succeeds and treats touch outcome independently of `WickOracle.settlement_price`. |

Bonus (optional, write if time): `invalid_direction_aborts`, `barrier_zero_aborts`, `buffer_above_max_aborts`, `effective_trigger_no_overflow_at_u64_max_barrier`, `touch_below_underflow_safety_at_full_buffer`.

## 10. Open questions

- Should `min_observations` scale with window length? (e.g., 1 obs per 5s of window). Defer until we have telemetry on real keeper cadence.
- Should `record_range` require an explicit attestation byte string from Lazer? Probably yes once Lazer ships range proofs; design matches the eventual API.
- Refund accounting for aborted markets: 1:1 by collateral or pro-rata by fees collected? Spec'd 1:1; revisit when fee model lands.
