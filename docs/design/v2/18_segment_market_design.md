# 18 — Segment Market: implementation design

**Status:** implementation spec for Phases B–F of doc 17 (provably-fair arcade).
**Date:** 2026-05-22.
**Complements:** [17](./17_provably_fair_arcade.md), [17a](./17a_sui_randomness_spike.md).
**Scope:** the on-chain segment-based arcade — one new Move module (`segment_market`) plus edits to `wick.move`. The existing tick-based arcade (`ride_position`, `random_walk_driver`, `ride_market_caps`) is **preserved verbatim** so doc 17 §9 option 3 ("keep current arcade live for the demo, ship one provably-fair PoC market") is structurally available.

---

## 1. Decisions locked

These were the open architectural questions before any code. Locking them now lets B1+B2 be one coherent module rather than three half-designs that contradict at the seams.

### 1.1 Parallel module — do NOT rework `ride_position` in place

The new arcade ships as `wick::segment_market`. The existing `wick::ride_position`, `wick::ride_market_caps`, and `wick::random_walk_driver` are untouched.

**Why:** the current arcade is what doc 17 §9 option 3 demos. Reworking `ride_position` would (1) break the existing ride_position tests, (2) break the existing keeper, (3) break the current frontend, (4) force a single option (1) that doc 17's own §9 scope analysis flags as not fitting June 20 with margin. A parallel module keeps both forks open; the cost is one extra Move module (~600 lines) but zero risk to the 460 tests already green.

### 1.2 Entry-relative barrier (B4 option a)

The barrier lives **per-ride**, set at open from the entry price ± `barrier_offset_bps`. Direction (`above` / `below`) is the rider's choice at open.

**Why:** kills the doc 17 §5 selection hole structurally — moneyness is constant by construction, no bot can wait for a near-the-money entry. doc 17 §11 leans option (a). Option (b) — moneyness-gated multiplier — would require a `ride_pricing` call at entry plus a dynamic per-position multiplier, much more surface area. Entry-relative is one constant per ride and the cleanest data model.

### 1.3 Consolidated module — no separate caps / position modules

`SegmentMarket`, `SegmentRecord`, and `SegmentRidePosition` all live in `segment_market.move`. There is no `segment_ride_market_caps.move` and no `segment_ride_position.move`.

**Why:** the segment arcade has exactly one product (the ride). There is no two-sided position market on top of it (unlike `wick::market` which sits on `path_observation`). Caps are a handful of u64 fields on `SegmentMarket` — splitting them into a separate module would be ceremony for its own sake. The existing `ride_market_caps` exists because the old `ride_position` had to share caps across market types; the new arcade does not.

### 1.4 Settlement scan in-module — `path_observation` is NOT reused

doc 17 §13.4 lists `path_observation` as "REUSED UNCHANGED." That claim is wrong: `path_observation` is a *stateful tick recorder* that pulls from `WickOracle.latest()`. The segment arcade has no ticks — it has stored segment extremes. Adapting `path_observation` would either be ugly (fake ticks pushed into a WickOracle) or invasive (extend the path_observation state machine).

The clean alternative is small: a private `scan_for_touch(segments, from_idx, to_idx, barrier, direction, deadband_bps) -> bool` inside `segment_market.move`. The deadband math is lifted from `path_observation::apply_deadband_*` (≈10 lines). Total surface added: ~30 lines.

### 1.5 Cashout via segment → seconds conversion — `ride_pricing` IS reused

`ride_pricing::bachelier_cashout_factor` is collateral-agnostic and price-source-agnostic — its inputs are `(spot, barrier, sigma_bps_per_sqrt_sec, seconds_remaining)`. The segment arcade calls it with `seconds_remaining = segments_remaining × DEFAULT_SEGMENT_MS / 1000`. `DEFAULT_SEGMENT_MS = 400` per doc 17 §10. This is an approximation; B7 Monte Carlo validates the resulting vault edge.

---

## 2. Module layout

### 2.1 New files
- `move/sources/segment_market.move` — the whole on-chain surface.
- `sdk/src/segmentMarket.ts` — tx builders + read helpers + event types.
- `keeper/src/segmentCranker.ts` — the pipelined cranker (C1).
- (Frontend changes — see doc 17 §D, separate spec.)

### 2.2 Edited files
- `move/sources/wick.move` — add `bootstrap_segment_market` + entry re-exports (`open_segment_ride`, `close_segment_ride`, `crank_expired_segment_ride`, `abort_segment_ride`, `record_segment`).
- `sdk/src/index.ts` — `export * from "./segmentMarket.js"`.

### 2.3 Untouched files (load-bearing — these stay byte-for-byte stable)

`ride_position.move`, `ride_market_caps.move`, `random_walk_driver.move`, `market.move`, `path_observation.move`, `martingaler_vault.move`, `vault.move`, `wick_oracle.move`, `risk_config.move`, `global_exposure_registry.move`, `impact_fee.move`, `fee_router.move`, `bot_registry.move`, `wick_staking.move`, `wick_token.move`, `usd_price_oracle.move`, `oracle_version_lock.move`, `probability.move`, `price_observation.move`, `pull_oracle_driver.move`, `ride_pricing.move`.

Functions we *call* from existing modules (no signature changes):
`martingaler_vault::deposit_ride_escrow`, `martingaler_vault::withdraw_for_ride_settlement`, `martingaler_vault::is_market_aborted`, `martingaler_vault::treasury_value`, `usd_price_oracle::loss_micro_usd`, `wick_token::mint_to_loser`, `wick_staking::record_loss`, `bot_registry::is_eligible_for_wick`, `ride_pricing::bachelier_cashout_factor`, `ride_pricing::factor_scale`, `seeded_path::expand_segment`, `seeded_path::new_state` (or equivalent).

---

## 3. `SegmentMarket<phantom C>` — struct

```move
public struct SegmentMarket<phantom C> has key {
    id: UID,

    // ── Walk (carried across segments) ──────────────────────────────
    walk: WalkState,                  // from wick::seeded_path

    // ── Segment ledger ──────────────────────────────────────────────
    next_segment_index: u64,          // next k record_segment will create
    segments: Table<u64, SegmentRecord>,

    // ── Wake/sleep gate ─────────────────────────────────────────────
    active_ride_count: u64,           // record_segment aborts if 0

    // ── Per-market ride caps (consolidated; §1.3) ───────────────────
    barrier_offset_bps: u64,          // barrier = entry × (1 ± offset/10_000)
    multiplier_bps: u64,              // touch payout multiplier (> 10_000, < 100_000)
    deadband_bps: u64,                // segment-scan touch deadband
    sigma_bps_per_sqrt_sec: u64,      // cashout (segments → seconds conversion)
    cashout_spread_bps: u64,          // taken off the bachelier factor
    max_segments_per_ride: u64,       // hard ceiling — expired_loss past this
    abort_segment_deadline_ms: u64,   // wall-time before a missing segment aborts a ride
    min_stake_per_segment: u64,
    max_stake_per_segment: u64,
    max_concurrent_rides: u64,        // hard cap on active_ride_count
    max_rides_per_user: u64,
    per_user_open_count: Table<address, u64>,

    // ── Vault binding (immutable post-bootstrap) ────────────────────
    vault_id: ID,

    // ── Telemetry ───────────────────────────────────────────────────
    created_at_ms: u64,
}
```

**Field rationale:**
- `walk` carries `(price, momentum, vol_regime, home)` across segments. `home` is set at bootstrap from a `home_price` parameter; the walk's mean-reversion target.
- `next_segment_index` is the strict source of truth for the next k — used for no-skip / no-double / no-future asserts.
- `segments` is a `Table` (dynamic field per segment). Pruning is post-MVP; the table grows monotonically.
- `active_ride_count` is the wake/sleep gate. Bumped on open, decremented on close / expire / abort.
- The caps block consolidates what would otherwise be a separate `RideMarketCaps` object. Per-user reservation tracked in `per_user_open_count`.
- `vault_id` binds to `MartingalerVault<C>`. Asserted on every ride mutation.

---

## 4. `SegmentRecord` — struct

```move
public struct SegmentRecord has store, copy, drop {
    key: vector<u8>,                  // 32 bytes — the segment_key drawn from sui::random
    state_after: WalkState,           // checkpoint of walk after expand_segment
    min_price: u64,                   // segment min — for the settlement scan
    max_price: u64,                   // segment max — for the settlement scan
    recorded_at_ms: u64,              // for the abort-deadline check (B5)
}
```

`state_after` is recomputable from `key + state_before` by any client, but storing it on-chain means settlement scans don't re-run `expand_segment`. ~70 bytes per segment; trivial at any reasonable horizon.

---

## 5. `SegmentRidePosition` — struct

```move
public struct SegmentRidePosition has key, store {
    id: UID,
    user: address,
    market_id: ID,                    // SegmentMarket<C> ID

    // Entry — entry-relative barrier (§1.2)
    entry_segment_index: u64,         // = market.next_segment_index AT OPEN
    entry_price: u64,                 // = market.walk.price AT OPEN
    barrier: u64,                     // = entry_price × (1 ± offset / 10_000)
    direction: u8,                    // 0 = ABOVE (price rises to barrier), 1 = BELOW

    // Stake (per-segment, §1.3)
    stake_per_segment: u64,           // captured at open from market caps range
    escrowed: u64,                    // ≥ stake_per_segment × max_segments_per_ride
    multiplier_bps: u64,              // captured at open — immutable for lifetime

    // WICK mint eligibility (snapshotted at open per existing pattern)
    is_bot_eligible: bool,

    // Settlement
    closed: bool,
    closed_at_ms: u64,
    settlement_kind: u8,
    collateral: TypeName,
}
```

Settlement kinds match the existing `ride_position` values (re-defined locally to keep modules decoupled):

| | value | meaning |
|---|---|---|
| `SETTLEMENT_OPEN` | 0 | unsettled |
| `SETTLEMENT_TOUCH_WIN` | 1 | barrier crossed in a held segment → leveraged payout |
| `SETTLEMENT_CASHOUT` | 2 | voluntary close before touch → bachelier factor × stake |
| `SETTLEMENT_EXPIRED_LOSS` | 3 | held past `max_segments_per_ride` without a touch → stake forfeit |
| `SETTLEMENT_ABORTED_REFUND` | 4 | market-side abort → 1:1 refund |

---

## 6. Lifecycle and function signatures

### 6.1 `new_segment_market<C>` (admin-side, called from `wick.move`'s `bootstrap_segment_market`)

```move
public fun new_segment_market<C>(
    vault: &MartingalerVault<C>,
    home_price: u64,
    barrier_offset_bps: u64,
    multiplier_bps: u64,
    deadband_bps: u64,
    sigma_bps_per_sqrt_sec: u64,
    cashout_spread_bps: u64,
    max_segments_per_ride: u64,
    abort_segment_deadline_ms: u64,
    min_stake_per_segment: u64,
    max_stake_per_segment: u64,
    max_concurrent_rides: u64,
    max_rides_per_user: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): SegmentMarket<C>
```

Asserts: multipliers in `(10_000, 100_000)`, bps in `[0, 10_000]`, stake range valid, sigma > 0, max_segments > 0. Initialises `walk = WalkState { price: home_price, home: home_price, vol_regime: 1_000_000, momentum: zero }`, `next_segment_index = 0`, `active_ride_count = 0`. Emits `SegmentMarketCreated`. Shared via `share_segment_market`.

### 6.2 `record_segment<C>` — constant-gas, the load-bearing fn

```move
public entry fun record_segment<C>(
    market: &mut SegmentMarket<C>,
    r: &Random,
    clock: &Clock,
    ctx: &mut TxContext,
)
```

Body, top-to-bottom — no value-dependent control flow at this level (see §14):

1. `assert!(market.active_ride_count > 0, ENoActiveRides)` — wake gate.
2. `let mut gen = sui::random::new_generator(r, ctx);`
3. `let key = sui::random::generate_bytes(&mut gen, 32);` — 32-byte draw.
4. `let (_candles, new_walk, smin, smax) = seeded_path::expand_segment(market.walk, key);` — runs the walk. Candles are discarded; only extremes matter on-chain.
5. `let k = market.next_segment_index;`
6. `table::add(&mut market.segments, k, SegmentRecord { key, state_after: new_walk, min_price: smin, max_price: smax, recorded_at_ms: clock.timestamp_ms() });`
7. `market.walk = new_walk;`
8. `market.next_segment_index = k + 1;`
9. Emit `SegmentRecorded { market_id, k, key, smin, smax }`.

### 6.3 `open_segment_ride<C>`

```move
public fun open_segment_ride<C>(
    market: &mut SegmentMarket<C>,
    vault: &mut MartingalerVault<C>,
    bot_registry: &BotRegistry,
    direction: u8,
    stake_per_segment: u64,
    escrow: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): SegmentRidePosition
```

Asserts:
- `market.vault_id == object::id(vault)` — vault binding.
- `direction in {0, 1}`.
- `stake_per_segment in [min, max]` from caps.
- `escrow.value() >= stake_per_segment × max_segments_per_ride` — full escrow up-front.
- `market.active_ride_count < market.max_concurrent_rides`.
- `per_user_open_count[user] < market.max_rides_per_user`.
- `!mv::is_market_aborted(vault, market_id)`.

Sets `entry_segment_index = market.next_segment_index`, `entry_price = market.walk.price`, computes `barrier` from offset + direction, captures `multiplier_bps` and `is_bot_eligible`, bumps `active_ride_count` and `per_user_open_count`, escrows via `mv::deposit_ride_escrow`. Emits `RideOpened`.

### 6.4 `close_segment_ride<C>`

```move
public fun close_segment_ride<C>(
    ride: &mut SegmentRidePosition,
    market: &mut SegmentMarket<C>,
    vault: &mut MartingalerVault<C>,
    price_oracle: &UsdPriceOracle,
    token_state: &mut WickTokenState,
    staking_pool: &mut WickStakingPool,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C>
```

Settlement decision (in order):

1. **Aborted check** — `mv::is_market_aborted(vault, market_id)` → `SETTLEMENT_ABORTED_REFUND`, 1:1 refund.
2. **Touch scan** — `scan_for_touch(market, entry_segment_index, market.next_segment_index, ride.barrier, ride.direction)` → `SETTLEMENT_TOUCH_WIN`, payout = `stake_paid × multiplier_bps / 10_000`.
3. **Max-segments check** — `(market.next_segment_index - entry_segment_index) >= max_segments_per_ride` → `SETTLEMENT_EXPIRED_LOSS`.
4. **Cashout** — bachelier factor × stake_paid × (1 - spread). Path-of-default for voluntary close before touch.

In all cases:
- `segments_held = market.next_segment_index - ride.entry_segment_index` (clamped to `max_segments_per_ride`).
- `stake_paid = segments_held × ride.stake_per_segment` (clamped to `ride.escrowed`).
- `total_to_user = payout + (escrowed - stake_paid)`.
- Withdraw via `mv::withdraw_for_ride_settlement`.
- On forfeit ≠ `ABORTED_REFUND`: `loss_micro_usd = upo::loss_micro_usd(price_oracle, forfeit, …)`; `ws::record_loss`; `wt::mint_to_loser`.
- Decrement `active_ride_count` and `per_user_open_count`.
- Mark closed, emit `RideClosed`.

### 6.5 `crank_expired_segment_ride<C>` (permissionless)

Same shape as the existing `ride_position::crank_expired_ride`:
- Asserts `segments_held >= max_segments_per_ride` AND `!scan_for_touch(... in window)`.
- 50 bps bounty (`CRANK_BOUNTY_BPS = 50`) of `stake_paid` to the cranker; the rest of the user's refund transferred to the user.
- WICK mint on the `forfeit_after_bounty` portion.
- **Treasury-cover guard (SEV-1 preservation):** assert `mv::treasury_value(vault) >= user_refund + bounty` BEFORE withdrawal. Otherwise `mv::withdraw_for_ride_settlement` would queue the shortfall under the cranker's ctx — the user's refund would end up with the cranker. If this assertion fails, the user must self-close (`close_segment_ride` queues under the user's ctx, which is correct).

### 6.6 `abort_segment_ride<C>` (B5)

```move
public fun abort_segment_ride<C>(
    ride: &mut SegmentRidePosition,
    market: &mut SegmentMarket<C>,
    vault: &mut MartingalerVault<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C>
```

Permissionless. Asserts: the segment the rider is waiting on is past its abort deadline — `clock.timestamp_ms() >= ride.opened_at_ms + market.abort_segment_deadline_ms` AND `market.next_segment_index == ride.entry_segment_index` (no progress at all). Refunds escrow 1:1 via `mv::withdraw_for_ride_settlement`. No WICK mint (no loss). Marks `SETTLEMENT_ABORTED_REFUND`. Decrements counts.

(Note: `opened_at_ms` may need to be a field on `SegmentRidePosition` for this; add it.)

---

## 7. Settlement: the segment scan

```move
fun scan_for_touch<C>(
    market: &SegmentMarket<C>,
    from_idx: u64,
    to_idx: u64,
    barrier: u64,
    direction: u8,
): bool {
    let deadband_bps = market.deadband_bps;
    let mut k = from_idx;
    while (k < to_idx) {
        if (table::contains(&market.segments, k)) {
            let seg = table::borrow(&market.segments, k);
            if (direction == DIRECTION_ABOVE) {
                let eff = add_deadband_up(barrier, deadband_bps);
                if (seg.max_price >= eff) return true;
            } else {
                let eff = sub_deadband_down(barrier, deadband_bps);
                if (seg.min_price <= eff) return true;
            };
        };
        k = k + 1;
    };
    false
}
```

`add_deadband_up` / `sub_deadband_down` are lifted from `path_observation::apply_deadband_*` (~10 lines each). The deadband margin is `barrier × deadband_bps / 10_000`, sized off the barrier so the filter shape is stable.

---

## 8. Wake/sleep gate — semantics

- `open_segment_ride` increments `active_ride_count`.
- `close_segment_ride` / `crank_expired_segment_ride` / `abort_segment_ride` decrement.
- `record_segment` asserts `active_ride_count > 0`.

Edge cases:
- A user opens; keeper sees `active > 0` next pump; cranks segment `k = entry_segment_index`; rider rides that segment. ✓
- Last rider closes during segment k; `record_segment(k+1)` fails (active is now 0). The chain pauses cleanly. Next opener resumes.
- Race: opener and closer in the same block — Move serialises shared-object mutations. Whichever lands first decides.

---

## 9. Cashout — segments → seconds conversion (§1.5)

```move
let segments_held = market.next_segment_index - ride.entry_segment_index;
let segments_remaining = if (market.max_segments_per_ride > segments_held) {
    market.max_segments_per_ride - segments_held
} else { 0 };
let seconds_remaining = segments_remaining * DEFAULT_SEGMENT_MS / 1000;
let factor = ride_pricing::bachelier_cashout_factor(
    market.walk.price,
    ride.barrier,
    market.sigma_bps_per_sqrt_sec,
    seconds_remaining,
);
let raw_payout = stake_paid * factor / ride_pricing::factor_scale();
let after_spread = raw_payout * (10_000 - market.cashout_spread_bps) / 10_000;
let payout = min(after_spread, stake_paid);  // cap at stake (factor ≤ 1)
```

`DEFAULT_SEGMENT_MS = 400` from doc 17 §10. Calibration of `sigma_bps_per_sqrt_sec` for this conversion is a B7 Monte Carlo task.

---

## 10. Vault interactions

The existing `MartingalerVault<C>` has exactly the hooks we need:
- `deposit_ride_escrow<C>(vault, escrow)` — escrow into treasury. *Reused as-is.*
- `withdraw_for_ride_settlement<C>(vault, amount, ctx) -> Coin<C>` — pay from treasury, queue shortfall under `ctx.sender()`. *Reused as-is.*
- `is_market_aborted<C>(vault, market_id) -> bool` — abort check. *Reused as-is.*
- `treasury_value<C>(vault) -> u64` — for the crank guard (§6.5).

**No vault changes needed.** The vault is collateral-typed; we bind by `vault_id` at bootstrap and assert on every ride mutation.

---

## 11. `@wick/sdk` additions (`sdk/src/segmentMarket.ts`)

Tx builders:
- `tx.bootstrapSegmentMarket(args)` — admin.
- `tx.recordSegment(marketId)` — cranker.
- `tx.openSegmentRide(args)` — user.
- `tx.closeSegmentRide(args)` — user.
- `tx.crankExpiredSegmentRide(args)` — anyone.
- `tx.abortSegmentRide(args)` — anyone after deadline.

Reads:
- `fetchSegmentMarket(client, id): Promise<SegmentMarketState>`
- `fetchSegments(client, marketId, fromIdx, toIdx): Promise<SegmentRecord[]>` (used by the frontend chart + `/verify`).
- `fetchSegmentRidePosition(client, id): Promise<SegmentRidePositionState>`

Event types (parsed from Move events):
- `SegmentMarketCreated`, `SegmentRecorded`, `RideOpened`, `RideClosed`.

---

## 12. Cranker interface (C1)

`keeper/src/segmentCranker.ts`:
- Subscribes to `RideOpened` / `RideClosed` events to track `active_ride_count` locally (avoids fetching the market every tick).
- While `active > 0`: pipelined `tx.recordSegment(marketId)` submissions at the target cadence (~400 ms). Does **not** wait for confirmation between submissions.
- Permissionless — anyone (incl. the frontend client) can call `record_segment`; the keeper is just the *normal* runner.

---

## 13. Frontend integration outline

Per doc 17 §D — separate spec, but the integration contract is:
- Frontend subscribes to `SegmentRecorded` events.
- On event: appends to a local segment ring buffer, runs `seededPath.expandSegment(walk_state_before, key)` to get the 6 candles, renders.
- The walk state for segment k+1 = `segments[k].state_after`. Frontend keeps the rolling state.
- `open_segment_ride` / `close_segment_ride` invoked from the gesture handler with optimistic UI (doc 17 §14.5).

---

## 14. Constant-gas plan for `record_segment`

Per doc 17a, `record_segment` must be constant-gas (no value-dependent control flow). Per-call inputs that vary: the drawn `segment_key`.

The body breakdown:
- `assert!(active > 0)` — value-independent. ✓
- `generate_bytes(32)` — constant cost.
- `expand_segment(walk, key)` — **has value-dependent branches** inside (vol-regime jump 4%, fat-tail tick 7%). Each branch adds work. Per-segment gas variance: a few percent at most (doc 17 §6.1 analysis).
- `table::add` — constant cost on Sui (dynamic field write is O(1)).
- `market.walk = new_walk` and `next_segment_index += 1` — constant.

The only value-dependent gas variance is inside `expand_segment`. **Mitigation:** the E3 adversarial test (§15.4) measures the actual gas spread across 10k keys and asserts it is within VM noise. If the spread proves exploitable, the fallback is to pad the cold branches with no-op work to flatten cost. No `if (key_low_bit == 0) { … } else { … }`-style branches are introduced at the `record_segment` level itself.

---

## 15. Tests

### 15.1 Internal Move tests (in `segment_market.move`)
- `bootstrap_emits_initial_state` — `next_segment_index = 0`, `active = 0`, walk seeded correctly.
- `record_segment_sleep_gate` — fails with `active = 0`; succeeds after `open_segment_ride` bumps `active`.
- `record_segment_deterministic` — same key → same `SegmentRecord` stored.
- `scan_for_touch_*` — hand-crafted segments, both directions, deadband on/off.
- `open_segment_ride_basics` — entry index captured, barrier computed correctly, escrow guard.
- `close_segment_ride_touch_win` — hand-set a touching segment, close, assert payout = stake × multiplier.
- `close_segment_ride_cashout` — close before any touch, assert factor logic.
- `crank_expired_no_touch` — segments held ≥ max, no touch, expired_loss path.
- `crank_expired_refuses_on_in_window_touch` — preserves the existing `ETouchedMustSelfClose` rule.
- `crank_refuses_when_treasury_short` — preserves the SEV-1 fix (§6.5).
- `abort_segment_ride_deadline` — past deadline + missing segment → refund.

### 15.2 Property tests (B6, separate `tests/segment_market_props.move`)
- Collateral invariant — vault treasury never less than open escrow total.
- Settle idempotency — close twice aborts cleanly.
- Per-segment stake math — `stake_paid = segments_held × stake_per_segment` (clamped).
- Per-user cap — concurrent opens past `max_rides_per_user` rejected.

### 15.3 Monte Carlo (B7)
- `scripts/simulate_segment_protocol.py` — simulate N rides with the integer walk + entry-relative barrier + per-segment stake. Output: realized house edge, vault solvency distribution.
- Acceptance: defensible vault edge over 10k+ simulations.
- Updates `15_montecarlo_validation_report.md` with a new section.

### 15.4 E2E replay — spine test 2 (E2)
- Deploy locally → record N segments → close ride → off-chain TS replay using `seededPath.ts` + the stored keys → assert the same touch / no-touch verdict as the on-chain `close_segment_ride`.

### 15.5 Adversarial (E3)
- Test-and-abort grinder against `record_segment` — should be impossible per doc 17a (single-command-after-Random rule).
- Gas-spread measurement: 10k `record_segment` calls with varied keys, measure variance. Assert within VM noise. Discharges A0.
- Stalled keeper → player cranks own `record_segment` + `close_segment_ride` (permissionless self-heal).
- Concurrent opens vs `max_concurrent_rides`.
- Keeper killed mid-stream → resume cleanly.

---

## 16. Implementation order

1. **This doc — DONE.**
2. **`segment_market.move`** (B1 + B2 + B3 + B4 + B5 — one module): struct + bootstrap + record_segment + open / close / crank_expired / abort. Inline tests (§15.1).
3. **`wick.move` edits** — entry re-exports + `bootstrap_segment_market`.
4. **`sdk/src/segmentMarket.ts`** — tx builders + reads.
5. **B6 property tests** (separate test file).
6. **B7 Monte Carlo** (Python — parallelisable with steps 7–9).
7. **C1 cranker** in `keeper/`.
8. **D series** (frontend — separate spec per doc 17 §D).
9. **E1 /verify** CLI.
10. **E2 E2E replay test.**
11. **E3 adversarial + gas-spread measurement.**
12. **F1 deploy + smoke + threat-model update.**

The pattern engine (#139, #140, D5) is orthogonal — parallelisable with steps 2–9 if time permits.

---

## 17. Open implementation choices (deferred, not blocking)

- **Segment pruning** — `segments` table grows monotonically. Post-MVP, add admin-gated `prune_segments_below(idx)` once no open rides reference indices below idx.
- **Exact `abort_segment_deadline_ms`** — provisional **30 000 ms** (30 s). Tune in C1 once we know real keeper cadence variance.
- **`DEFAULT_SEGMENT_MS` placement** — provisional **400** per doc 17 §10. Hard-coded for now; could become a per-market field for future flexibility.
- **`max_segments_per_ride`** — provisional **~150** (≈ 1 minute at 0.4 s/segment). Calibrated in B7.
- **Per-user reservation policy** — currently just open-count. Could move to micro-USD-based per-user cap. Defer.
- **`opened_at_ms` field on SegmentRidePosition** — added for the abort-deadline check (§6.6). Confirm at implementation.
