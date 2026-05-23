# 19 — Round-based shared barrier grid + orderbook overlay

**Status:** supersedes **doc 18 §1.2 only**; the rest of doc 18 stands.
**Date:** 2026-05-22.
**Complements:** [17](./17_provably_fair_arcade.md), [17a](./17a_sui_randomness_spike.md), [18](./18_segment_market_design.md).
**Scope:** redesigns the arcade's barrier model from per-rider entry-relative (doc 18 §1.2) to **round-based shared grid with two barriers + a live orderbook overlay**. Everything else in doc 18 — module layout, vault hooks, constant-gas `record_segment`, the crank's SEV-1 guard, the `seeded_path` integration — carries through unchanged.

---

## 1. The product, in one paragraph

One chart per market. Every 30 seconds, **two shared barriers materialise** — one above and one below the current spot, both at ±5% (parameter). Everyone watching sees the same two barriers. For the **first 5 seconds of each round**, riders pick a barrier and commit a stake; after that, the open window closes and no new opens are allowed for the round. The round plays out the remaining 25 seconds. Each barrier shows a **live orderbook bar** — aggregate stake currently committed to that barrier — pulsing as riders open and close. When the round ends, any still-open rides settle (touch_win, late cashout, or expired_loss), the chart shows the result for a beat, and the next round rolls fresh barriers from the new spot.

## 2. Why this design (vs entry-relative)

doc 18 §1.2 picked entry-relative because it kills moneyness selection structurally: every rider opens at the same %-distance from spot. That works, but **it forces every rider to see a different barrier line** — which kills the social/spectator dimension entirely. There is nothing to aggregate, no shared focal point, no orderbook to render.

The round-based design solves moneyness differently: barriers are fixed at round start at a fixed % from spot, and the **open window is short enough (3–5s) that spot cannot drift meaningfully within it**. Every rider in the same round opens at the same moneyness across both barriers. **Selection is closed by the open-window mechanic, not by per-rider barriers.** Per-rider barriers become unnecessary, and we gain shared barriers — which makes orderbook overlays and communal experience structurally possible.

**Structural bonus:** the two-barrier shared grid **mirrors the existing pro-mode DNT corridor** (`path_observation::new_dnt`). DNT pro = "bet price stays *between* the two barriers" (no-touch both). Arcade round = "bet price *wicks* one of the two barriers" (touch one). Same chart layout, complementary mechanics, visual consistency across the whole product.

## 3. What changes from doc 18

**`SegmentMarket<C>` gains** (only additions, no removals):
- Round state: round-duration constants + cached round info (index, start segment, computed barriers)
- Per-barrier exposure trackers: aggregate stake + max payout + rider count, per barrier per round, reset on round roll
- Per-barrier cap

**`SegmentRidePosition` loses** doc 18's entry-relative fields (`entry_price`, `barrier`, `direction` as offset-from-entry) and gains:
- `round_index: u64`
- `barrier_index: u8` (0 = upper, 1 = lower)

The barrier value itself is no longer stored on the position — it's looked up from `market.cached_*_barrier` at settlement time. Removing redundancy.

**`open_segment_ride` gains** an open-window assertion, a barrier-index validation, and a per-barrier exposure increment + cap check.

**Everything else from doc 18 carries unchanged:** the vault hooks, the WICK mint + record_loss pattern, the constant-gas `record_segment`, the crank's SEV-1 treasury guard, the `seeded_path` integration, the cashout via `ride_pricing` with the segment→seconds conversion.

## 4. Constants and parameters (per-market, set at bootstrap)

Round shape (LOCKED, B7-validated):
- `ROUND_DURATION_SEGMENTS: u64 = 75` → 30 seconds at 400 ms/segment
- `OPEN_WINDOW_SEGMENTS: u64 = 13` → ~5.2 seconds open window
- `MAX_PAYOUT_PER_BARRIER` — per-market cap. Provisional 10% of seed treasury — B7 confirmed the cap is a hard ceiling with zero violations across 2 000 saturating rounds (see `15_montecarlo_validation_report.md` §12.3).

Economic shape (**RECALIBRATION REQUIRED before any bootstrap script ships**):
- `BARRIER_OFFSET_BPS` — provisional 500 (±5%). **DO NOT SHIP at 500.**
- `MULTIPLIER_BPS` — provisional 20_000 (2×). **DO NOT SHIP at 20_000.**

B7 (see `15_montecarlo_validation_report.md` §§12.1–12.2) measured realised P(touch) = 86% and vault edge = **−71.66% per $ staked** at ±5% / 2× — catastrophic bleed. A first-pass over-corrected recommendation (±15% × 1.10×) would land near +67% vault edge — equally broken in the opposite direction (user bleed). The actual recalibration requires a JOINT sweep over `(BARRIER_OFFSET_BPS, MULTIPLIER_BPS)` to find the Pareto-optimal point. That sweep is a B7 follow-up extending `scripts/simulate_segment_protocol.py`; updated §4 values land in `15_montecarlo_validation_report.md` §12.4 + an amendment here when the sweep returns.

## 4a. The excitement ↔ house-edge tradeoff

`P(touch)` is determined by barrier distance vs walk volatility. **Multiplier doesn't change it.**
`Vault edge ≈ 1 − MULTIPLIER × P(touch)`.

This means a meaningful multiplier (M ≥ 1.5×) requires `P(touch) ≤ ~60%` — which means barriers must be WIDE relative to the walk's per-round drift (~11% stdev over 30 s on `seeded_path`).

Three product flavours, mapped to the tradeoff:

| Flavour | M × P(touch) | Vault edge | Player feel |
|---|---|---|---|
| Lottery | 3× × 25% | +25% | mostly losses + occasional jackpots — addictive but punishing |
| **Coin-flip** | **1.8× × 50%** | **+10%** | **roughly 50/50 with a meaningful payout — best general appeal** |
| Grind | 1.1× × 85% | +6% | constant $0.10 wins on $1 — stable but dull |

The **cashout mechanic** (Bachelier-fair value mid-ride via `ride_pricing`) softens the loss-feel: players who pull out before round end don't experience non-touching rounds as total losses. This shifts perceived experience toward the Coin-flip column even at slightly higher multipliers — so a 2× × 55 % market may feel right AND leave a healthy edge.

The B7 joint sweep targets the Coin-flip region. Until it lands, do not bootstrap a market with §4's provisional numbers.

## 5. `SegmentMarket<phantom C>` — full revised struct

```move
public struct SegmentMarket<phantom C> has key {
    id: UID,

    // ── Walk (doc 18 §3) ────────────────────────────────────────────
    walk: WalkState,
    next_segment_index: u64,
    segments: Table<u64, SegmentRecord>,

    // ── Wake/sleep gate (doc 18 §3) ─────────────────────────────────
    active_ride_count: u64,

    // ── NEW: round + shared grid configuration ──────────────────────
    round_duration_segments: u64,             // const post-bootstrap
    open_window_segments: u64,                // const post-bootstrap
    barrier_offset_bps: u64,                  // const; ± from spot at round start
    multiplier_bps: u64,                      // const; shared across both barriers
    max_payout_per_barrier: u64,              // const; per-barrier liability cap

    // ── NEW: cached current-round state (lazy-rolled) ───────────────
    cached_round_index: u64,
    cached_round_started_at_segment: u64,
    cached_upper_barrier: u64,
    cached_lower_barrier: u64,

    // ── NEW: per-barrier per-round trackers (reset on round roll) ───
    upper_aggregate_stake: u64,               // sum of escrowed for open upper rides
    lower_aggregate_stake: u64,
    upper_aggregate_max_payout: u64,          // sum of escrowed × multiplier — for cap
    lower_aggregate_max_payout: u64,
    upper_rider_count: u64,                   // for spectator UX
    lower_rider_count: u64,

    // ── Remaining doc 18 fields (still apply) ───────────────────────
    deadband_bps: u64,
    sigma_bps_per_sqrt_sec: u64,
    cashout_spread_bps: u64,
    abort_segment_deadline_ms: u64,
    min_stake_per_segment: u64,
    max_stake_per_segment: u64,
    max_concurrent_rides: u64,
    max_rides_per_user: u64,
    per_user_open_count: Table<address, u64>,

    // ── Vault binding (immutable post-bootstrap) ────────────────────
    vault_id: ID,
    created_at_ms: u64,
}
```

Removed vs doc 18: `max_segments_per_ride` (replaced by `round_duration_segments` — a ride lives exactly one round, no more). `barrier_offset_bps` was per-rider conceptually in doc 18; now per-market.

## 6. `SegmentRidePosition` — revised

```move
public struct SegmentRidePosition has key, store {
    id: UID,
    user: address,
    market_id: ID,

    // ── Round binding (NEW; replaces entry-relative fields) ─────────
    round_index: u64,
    entry_segment_index: u64,                 // = market.next_segment_index AT OPEN
    barrier_index: u8,                        // 0 = upper, 1 = lower
    multiplier_bps: u64,                      // captured at open

    // ── Stake (doc 18 §5) ──────────────────────────────────────────
    stake_per_segment: u64,
    escrowed: u64,                            // ≥ stake_per_segment × round_duration_segments
    is_bot_eligible: bool,

    // ── Settlement ─────────────────────────────────────────────────
    opened_at_ms: u64,                        // for abort-deadline check
    closed: bool,
    closed_at_ms: u64,
    settlement_kind: u8,                      // same constants as doc 18 §5
    collateral: TypeName,
}
```

No `entry_price`, no per-rider `barrier`, no per-rider `direction`. The barrier value is looked up from `market.cached_*_barrier` at settlement time using `barrier_index`.

## 7. Round lifecycle

### 7.1 `ensure_round_current` — the lazy-roll helper

```move
fun ensure_round_current<C>(market: &mut SegmentMarket<C>) {
    let next_idx = market.next_segment_index;
    let current_round = next_idx / market.round_duration_segments;
    if (current_round <= market.cached_round_index) return;

    market.cached_round_index = current_round;
    market.cached_round_started_at_segment = current_round * market.round_duration_segments;

    // Barriers from the current walk price (price after most recent segment)
    let spot = market.walk.price;
    let offset = ((spot as u128) * (market.barrier_offset_bps as u128) / 10_000) as u64;
    market.cached_upper_barrier = spot + offset;
    market.cached_lower_barrier = if (spot > offset) spot - offset else 1;

    // Reset per-barrier trackers
    market.upper_aggregate_stake = 0;
    market.lower_aggregate_stake = 0;
    market.upper_aggregate_max_payout = 0;
    market.lower_aggregate_max_payout = 0;
    market.upper_rider_count = 0;
    market.lower_rider_count = 0;

    sui::event::emit(RoundStarted {
        market_id: object::id(market),
        round_index: current_round,
        upper_barrier: market.cached_upper_barrier,
        lower_barrier: market.cached_lower_barrier,
        started_at_segment: market.cached_round_started_at_segment,
        spot_at_roll: spot,
    });
}
```

Called by **every entry point that needs round state** — `record_segment` (every call; cheap no-op when already current) and `open_segment_ride` (to bind the new ride to the current round).

### 7.2 Bootstrap initial round

At `new_segment_market`, set `cached_round_index = 0`, `cached_round_started_at_segment = 0`, pre-compute `cached_upper_barrier` / `cached_lower_barrier` from the initial `home_price`. So round 0 has valid barriers and `ensure_round_current` is a no-op for the first round.

### 7.3 Round states for a rider

| Segments since round start | Round state | Open allowed? | Close allowed? |
|---|---|---|---|
| `[0, open_window_segments)` | OPEN | yes | yes |
| `[open_window_segments, round_duration_segments)` | LIVE | no | yes (cashout / touch_win) |
| `≥ round_duration_segments` | ENDED | no | yes (crank_expired) |

The states are *implicit* in `next_segment_index - cached_round_started_at_segment`; no separate enum needed on chain.

## 8. `open_segment_ride` — revised entry point

```move
public fun open_segment_ride<C>(
    market: &mut SegmentMarket<C>,
    vault: &mut MartingalerVault<C>,
    bot_registry: &BotRegistry,
    barrier_index: u8,                  // 0 = upper, 1 = lower
    stake_per_segment: u64,
    escrow: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): SegmentRidePosition
```

Body (top-to-bottom):

1. `assert!(market.vault_id == object::id(vault))` — vault binding.
2. `assert!(barrier_index == 0 || barrier_index == 1)` — valid barrier.
3. `ensure_round_current(market)` — lazy-roll the round if needed.
4. **Open-window assertion**: `(next_segment_index - cached_round_started_at_segment) < open_window_segments`.
5. Stake range check: `stake_per_segment` in `[min, max]`.
6. Escrow capacity check: `escrow.value() >= stake_per_segment × round_duration_segments`.
7. Global concurrency cap: `active_ride_count < max_concurrent_rides`.
8. Per-user cap: `per_user_open_count[user] < max_rides_per_user`.
9. Vault-aborted check: `!mv::is_market_aborted(vault, market_id)`.
10. **Per-barrier cap check**: `aggregate_max_payout + (escrowed × multiplier / 10_000) ≤ max_payout_per_barrier` on the chosen barrier.
11. Bump per-barrier trackers (stake, max_payout, rider_count) for the chosen barrier.
12. Bump `active_ride_count` and `per_user_open_count[user]`.
13. Escrow via `mv::deposit_ride_escrow(vault, escrow)`.
14. Snapshot `is_bot_eligible` via `br::is_eligible_for_wick`.
15. Construct `SegmentRidePosition { round_index: cached_round_index, entry_segment_index: next_segment_index, barrier_index, multiplier_bps: market.multiplier_bps, … }`.
16. Emit `RideOpened` (includes `round_index`, `barrier_index`, the actual `barrier_price` for client-side display).

## 9. `close_segment_ride` — settlement decision

Same shape as doc 18 §6.4. Decision order:

1. **Aborted check** — `mv::is_market_aborted(vault, market_id)` → `SETTLEMENT_ABORTED_REFUND`, 1:1 refund.
2. **Touch scan** — `scan_for_touch(market.segments, entry_segment_index, current_segment, ride_barrier, ride_direction)`. Touch fires → `SETTLEMENT_TOUCH_WIN`, payout = `stake_paid × multiplier_bps / 10_000`.
3. **Round-end check** — `(next_segment_index - cached_round_started_at_segment) >= round_duration_segments` AND no touch → `SETTLEMENT_EXPIRED_LOSS`. Stake forfeit.
4. **Cashout** — within the round AND no touch → bachelier factor × `stake_paid` × `(1 - cashout_spread_bps / 10_000)`.

The ride's barrier (for the scan + cashout) is derived from `barrier_index`:
- `0` → `market.cached_upper_barrier`, direction = `ABOVE`
- `1` → `market.cached_lower_barrier`, direction = `BELOW`

`stake_paid = min(segments_held × stake_per_segment, escrowed)` where `segments_held = min(next_segment_index - entry_segment_index, round_duration_segments)`. Total to user = `payout + (escrowed - stake_paid)`. Withdrawal via `mv::withdraw_for_ride_settlement`. On forfeit ≠ `ABORTED_REFUND`: WICK mint + `record_loss` (same pattern as doc 18). **Decrement per-barrier trackers** on close, plus `active_ride_count` and `per_user_open_count`. Mark closed, emit `RideClosed { barrier_index, … }`.

## 10. `crank_expired_segment_ride` — permissionless

Same as doc 18 §6.5. Asserts round ended AND no touch. 50 bps bounty to cranker. **SEV-1 treasury-cover guard preserved** — refuses if `treasury_value < user_refund + bounty`, else the user's refund queues under the cranker's ctx. WICK mint on the forfeit-after-bounty portion. Decrement per-barrier trackers + counts.

## 11. `abort_segment_ride` (B5)

Same as doc 18 §6.6. Past `abort_segment_deadline_ms` without any segment recorded → 1:1 refund. No WICK mint.

## 12. Settlement scan (per-barrier)

The `scan_for_touch` helper from doc 18 §7 — unchanged. Called with the ride's chosen barrier + direction.

## 13. Vault interactions

Zero changes from doc 18 §10. `MartingalerVault<C>`'s `deposit_ride_escrow`, `withdraw_for_ride_settlement`, `is_market_aborted`, `treasury_value` all reused as-is.

## 14. Events for the orderbook overlay

| Event | When emitted | Carries |
|---|---|---|
| `RoundStarted` | `ensure_round_current` rolls | `round_index`, `upper_barrier`, `lower_barrier`, `started_at_segment`, `spot_at_roll` |
| `SegmentRecorded` | `record_segment` stores | `k`, `key`, `min`, `max` (doc 18 §6.2) |
| `RideOpened` | `open_segment_ride` succeeds | `ride_id`, `user`, `round_index`, `barrier_index`, `barrier_price`, `stake_per_segment`, `escrowed`, `opened_at_ms` |
| `RideClosed` | `close_segment_ride` / crank / abort settles | `ride_id`, `round_index`, `barrier_index`, `settlement_kind`, `stake_paid`, `payout`, `forfeit`, `bounty`, `closed_at_ms` |

The frontend aggregates `RideOpened` / `RideClosed` into per-barrier per-round live exposure for the orderbook bars. The on-chain `upper_aggregate_stake` / `lower_aggregate_stake` fields are authoritative — the frontend can poll them via SDK reads to reconcile.

## 15. `@wick/sdk` additions (extends doc 18 §11)

Tx builders:
- `tx.bootstrapSegmentMarket(args)` — extended args for `roundDurationSegments`, `openWindowSegments`, `barrierOffsetBps`, `maxPayoutPerBarrier`
- `tx.recordSegment(marketId)` — unchanged
- `tx.openSegmentRide(marketId, barrierIndex, stakePerSegment, escrow)` — `barrierIndex: 0 | 1` is the new dimension
- `tx.closeSegmentRide(rideId, marketId)` — unchanged signature; settlement decision is on-chain
- `tx.crankExpiredSegmentRide(rideId, marketId)` — unchanged
- `tx.abortSegmentRide(rideId, marketId)` — unchanged

Reads:
- `fetchSegmentMarket(client, id)` — returns the extended state (cached round, both barriers, aggregate fields)
- `fetchSegments(...)` — unchanged
- `fetchRidePosition(...)` — includes `round_index`, `barrier_index`

Event types added: `RoundStarted`. `RideOpened` / `RideClosed` extended with new fields.

## 16. Tests (extends doc 18 §15)

### 16.1 New internal Move tests
- `round_rolls_at_boundary` — `record_segment` past `round_duration_segments` → new `round_index`, fresh barriers
- `round_barriers_match_spot_at_roll` — barriers computed correctly from `walk.price`
- `per_barrier_trackers_reset_on_roll` — aggregates zeroed on round transition
- `open_in_window_succeeds` — open with `segments_into_round < open_window` succeeds
- `open_after_window_fails` — open with `segments_into_round >= open_window` aborts
- `barrier_full_rejects_open` — open that would push `aggregate_max_payout > cap` aborts
- `barrier_index_validates` — `barrier_index ∉ {0,1}` aborts
- `close_uses_cached_barrier` — settle reads correct barrier based on `barrier_index`
- `cashout_segments_remaining_correct` — `segments_remaining = round_end - current`
- `expired_at_round_end` — open ride at round end with no touch → `EXPIRED_LOSS` via crank
- `per_barrier_trackers_decrement_on_close`

### 16.2 Property tests (B6, additions)
- **Per-barrier cap invariant**: `sum(open ride max_payouts on barrier b) ≤ max_payout_per_barrier`
- **Round-binding invariant**: every open ride's `round_index == cached_round_index when opened`
- **Aggregate stake invariant**: `sum(open ride escrowed on barrier b) == per-barrier aggregate_stake`

### 16.3 Monte Carlo (B7 extends)
- **Per-tier multiplier calibration** — symmetric ±5% v1: validate 2× multiplier produces positive vault edge.
- **Open-window selection sim** — bots try to open at end of open window when spot has drifted; measure realised edge.
- **Per-barrier cap pile-on** — simulate mass concurrent opens; assert vault liability bounded by `max_payout_per_barrier × 2`.

## 17. How this connects to the entire codebase

The user explicitly asked for this. It is the most important section.

### 17.1 Modules created NEW for the segment arcade
- `move/sources/segment_market.move` — one consolidated module per doc 18 §1.3, extended per this doc.
- `sdk/src/segmentMarket.ts` — tx builders, reads, event types (incl. `RoundStarted`).
- `keeper/src/segmentCranker.ts` — pipelined `record_segment` cranker.

### 17.2 Existing Move modules CALLED but UNCHANGED
| Module | What we call | Why |
|---|---|---|
| `seeded_path.move` | `expand_segment`, `WalkState`, `keystream_word` | The deterministic walk. Integrated unchanged. |
| `martingaler_vault.move` | `deposit_ride_escrow`, `withdraw_for_ride_settlement`, `is_market_aborted`, `treasury_value` | Vault is collateral-typed; we bind via `vault_id`. |
| `usd_price_oracle.move` | `loss_micro_usd` | For WICK mint sizing on losses. |
| `wick_token.move` | `mint_to_loser` | Console-prize WICK to losers. |
| `wick_staking.move` | `record_loss` | Loss tracking for staker fee share. |
| `bot_registry.move` | `is_eligible_for_wick` snapshot at open | Anti-bot WICK mint. |
| `ride_pricing.move` | `bachelier_cashout_factor`, `factor_scale` | Cashout pricing with segment→seconds conversion. |

### 17.3 Existing Move modules NOT used by the segment arcade
| Module | Why not used |
|---|---|
| `path_observation.move` | Tick-based touch detector; segments have extremes not ticks. Inline `scan_for_touch` instead (doc 18 §1.4). |
| `ride_position.move` | The existing tick-based arcade. **Parallel module per doc 18 §1.1.** Untouched. |
| `ride_market_caps.move` | The existing arcade's caps. Untouched. New arcade's caps live on `SegmentMarket` directly (doc 18 §1.3). |
| `random_walk_driver.move` | The existing arcade's price source. Untouched. |
| `market.move`, `pull_oracle_driver.move`, `wick_oracle.move`, `price_observation.move`, `oracle_version_lock.move`, `probability.move`, `risk_config.move`, `global_exposure_registry.move`, `impact_fee.move`, `fee_router.move`, `oracle_version_lock.move` | Touch / no-touch markets and infrastructure. Their own track. Untouched. |

### 17.4 `wick.move` (the entrypoint router) — small additions

Adds:
- `bootstrap_segment_market` — admin entry constructing the new market type.
- `open_segment_ride`, `close_segment_ride`, `crank_expired_segment_ride`, `abort_segment_ride`, `record_segment` — entry re-exports.

Removes nothing. The existing `bootstrap_random_walk_market`, `bootstrap_pull_market`, `open_touch`, `open_no_touch`, `redeem`, `lock_and_settle`, `open_ride`, `close_ride`, `crank_expired_ride`, `recover_aborted_seed` all stay. The current arcade and the new arcade coexist.

### 17.5 Frontend integration

`frontend/src/hooks/useRideGesture.ts` — **substantial rewrite** for the new arcade mode. New responsibilities:
- Subscribe to `RoundStarted`, `RideOpened`, `RideClosed`, `SegmentRecorded` events for the active market.
- Maintain local round state (round_index, open_window state, current barriers).
- Maintain local orderbook state (per-barrier aggregate stake from event aggregation; reconcile via SDK reads).
- Render candles by running `seededPath.expandSegment` over fetched on-chain keys.
- Render barrier lines + orderbook bars + countdown.
- Gesture: barrier-picker UI (tap upper or lower zone of chart to select) + press-and-hold to commit during open window. Optimistic UI per doc 17 §14.5.

`frontend/src/routes/Ride.tsx` — main route; mostly hosts `useRideGesture` plus the new visual layer.

New components:
- `BarrierGrid.tsx` — renders the two barriers with their multipliers + (linked) `OrderbookBar` per barrier.
- `RoundCountdown.tsx` — open-window timer + round timer + "ROUND N LIVE" indicator.
- `OrderbookBar.tsx` — the per-barrier sideways bar, animated pulse on event arrivals, "barrier full" state.

### 17.6 Keeper

`keeper/src/segmentCranker.ts` — pipelined `record_segment` invocations at ~400 ms target cadence, crank-only-while-active. Subscribes to `RideOpened` / `RideClosed` to track `active_ride_count` locally without polling the market every tick.

### 17.7 Cross-language conformance

The walk + segment determinism (doc 17 §8 spine test 1) carries through unchanged — `seeded_path::expand_segment` is the same function; the conformance harness applies as-is. Round mechanics + per-barrier exposure are application-level state on top of the deterministic walk, not part of the walk itself.

The E2E replay test (doc 17 §8 spine test 2) extends to round-aware replay: read on-chain `RoundStarted` events to know each round's barriers; replay `SegmentRecorded` keys through `seededPath`; for each ride, check that the off-chain settlement decision (touch / cashout / expired) matches the on-chain `close_segment_ride` outcome.

## 18. Implementation order (revises doc 18 §16)

1. **This doc — DONE.**
2. **`segment_market.move`** — full module per doc 18 §3–§9 + this doc's round mechanics + per-barrier exposure tracking. Inline tests for round transitions, open-window enforcement, per-barrier caps, scan, cashout, crank_expired, abort.
3. **`wick.move` edits** — entry re-exports + `bootstrap_segment_market` (with the extended args from §15).
4. **`sdk/src/segmentMarket.ts`** — tx builders + reads + event types (incl. `RoundStarted`).
5. **B6 property tests** — incl. per-barrier cap invariant + round-binding invariant + aggregate stake invariant.
6. **B7 Monte Carlo** — per-tier multiplier calibration + open-window selection sim + per-barrier cap pile-on validation.
7. **C1 cranker** in `keeper/`.
8. **D series** — frontend. **D6 (orderbook overlay)** is a new task on top of D1–D5.
9. **E1 `/verify`** — round-aware replay CLI.
10. **E2 E2E replay test** — extended per §17.7.
11. **E3 adversarial** — open-window race tests, per-barrier cap exhaustion tests, multi-barrier selection bots.
12. **F1 deploy + smoke + threat-model update.**

Pattern engine (#139, #140, D5) remains orthogonal — parallelizable.

## 19. Open implementation choices (deferred, not blocking)

- **Asymmetric barrier offsets** (e.g., +3% upper / −7% lower for skewed markets) — post-v1.
- **More than 2 barriers per round** (3-tier / 5-tier slot paylines) — easy extension once v1 ships: per-barrier arrays instead of upper/lower scalars.
- **Open-window length** — provisional 13 segments (5.2s). Tuned in B7 against bot-selection sims.
- **Per-barrier cap exact value** — provisional 10% of treasury at market creation. Could be dynamic (recomputed each round as 10% of current treasury). v1 is static.
- **Orderbook bar event vs poll** — frontend may use event aggregation alone or poll on-chain aggregate fields for reconciliation. Decide during D6.
- **Per-round result animation** — end-of-round transition flash, win/loss summary screen. Polish, post-v1.
