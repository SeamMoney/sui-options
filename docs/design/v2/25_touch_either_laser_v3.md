# 25 — Touch-Either + Laser Tracer + Always-Open Window

**Status:** v3 architecture spec — locks the mechanic that replaces single-barrier-pick.
**Author:** Claude Opus 4.7 + Max Mohammadi, 2026-05-23.
**Supersedes (partially):** [doc 19 §6 — barrier-pick on round-shared grid](19_round_shared_grid_design.md). Round + shared barriers stay; **what changes is what the user picks (nothing) and how the chart shows them whether they're winning (a glowing trace).**

---

## 1. The problem this fixes

Current `/ride` (deployed at `wick-markets.vercel.app`) has three compounding UX failures:

1. **"Tap upper or lower half"** is an invisible affordance. New users don't realize the chart has two zones; they tap, get no obvious feedback, and assume nothing happened.
2. **The open window is ~17% of each round** (13 of 75 segments at the B7 calibration). The screen below dominates 83% of every cycle:
   ```
   ROUND LIVE — BARRIERS LOCKED
   Wait for the next round
   the next round rolls fresh barriers in a moment
   ```
   Users land on the page, see this, conclude the app is frozen, leave.
3. **No live "am I winning?" feedback during the hold.** The PnL number ticks in the corner but the chart itself doesn't change with the player's position. The arcade thrill of "watch the line move toward the win" doesn't exist.

## 2. The fix in three sentences

- The user **does not pick a side**. Press anywhere → ride opens against BOTH barriers simultaneously. Touch EITHER side wins the jackpot.
- The chart paints a **glowing laser line** that follows the spot frame-by-frame, **color-graded by distance to the nearest barrier** — bright emerald when closing in on a win, dim rose when sitting in the middle.
- The open window becomes **always-open**. Why we can: there's no direction to front-run anymore. The user is betting volatility, not direction. Race-in advantage is gone.

## 3. What this replaces

| | Today (`segment_market_v3` shipped 2026-05-23) | After v3.5 (this doc) |
|---|---|---|
| **`open_segment_ride` ABI** | takes `barrier_index: u8` (0=upper, 1=lower) | drop the parameter; rides are direction-neutral |
| **`SegmentRidePosition`** | has `barrier_index` + `barrier_price` (the picked barrier's price) | has `upper_barrier_price` + `lower_barrier_price` (both, snapshotted at open) |
| **Per-barrier aggregate trackers** | `upper_aggregate_stake` + `upper_aggregate_max_payout` + `upper_rider_count` AND the same for lower | merged into `either_aggregate_stake` + `either_aggregate_max_payout` + `either_rider_count` |
| **Per-barrier exposure cap** | `max_payout_per_barrier` (per side, independent) | `max_payout_per_round` (one cap, shared) — vault doesn't care which side touches |
| **`scan_for_touch`** | scans either upper-touch OR lower-touch depending on the ride's `barrier_index` | scans both. Returns true if EITHER side touched in the window. |
| **Open window** | `open_window_segments` config (e.g. 13 of 75) | drop the gate entirely — every segment is open. Bootstrap script no longer needs `OPEN_WINDOW_SEGMENTS`. |
| **`ensure_round_current`** | resets per-barrier trackers at round roll | resets per-round trackers (single bucket) |
| **Front-end gesture** | tap upper half → highlight upper barrier; tap lower half → highlight lower; THEN press-and-hold | press-and-hold anywhere → ride opens immediately |
| **Front-end chart overlay** | candles + two dotted barrier lines | candles + two SOLID barrier lines + a glowing **laser trace** of the spot, color-graded by proximity |
| **"Wait for next round" hero** | 83% of the time | **deleted forever** |

## 4. Move-side spec

### 4.1 New module: `wick::segment_market_v4`

Cloning the v3 module is simpler than evolving it (avoids API breaks for the ~3 markets already alive on testnet under v3). Keep `segment_market_v3` for any v3 markets that exist; new bootstraps use v4.

```move
public struct SegmentMarketV4<phantom C> has key {
    id: UID,

    // ── Walk (carried across segments) — unchanged from v3 ─────────────────
    walk: WalkState,

    // ── Segment ledger — unchanged from v3 ──────────────────────────────────
    next_segment_index: u64,
    segments: Table<u64, SegmentRecord>,
    pruned_rounds: Table<u64, bool>,
    archive_index: Table<u64, vector<u8>>,

    // ── Wake gate — unchanged ───────────────────────────────────────────────
    active_ride_count: u64,

    // ── Round + shared grid (immutable post-bootstrap) ──────────────────────
    round_duration_segments: u64,
    barrier_offset_bps: u64,
    multiplier_bps: u64,
    max_payout_per_round: u64,        // ← was max_payout_per_barrier; now shared

    // ── Cached round state (lazy-rolled by ensure_round_current) ────────────
    cached_round_index: u64,
    cached_round_started_at_segment: u64,
    cached_upper_barrier: u64,
    cached_lower_barrier: u64,

    // ── Per-round aggregate (single bucket, no upper/lower split) ───────────
    either_aggregate_stake: u64,
    either_aggregate_max_payout: u64,
    either_rider_count: u64,

    // ── Settlement bookkeeping for prune (unchanged from v3) ────────────────
    unsettled_rides_per_round: Table<u64, u64>,

    // ── Caps + scan knobs ───────────────────────────────────────────────────
    deadband_bps: u64,
    sigma_bps_per_sqrt_sec: u64,
    cashout_spread_bps: u64,
    abort_segment_deadline_ms: u64,
    min_stake_per_segment: u64,
    max_stake_per_segment: u64,
    max_concurrent_rides: u64,
    max_rides_per_user: u64,
    per_user_open_count: Table<address, u64>,

    // ── Vault binding + telemetry ───────────────────────────────────────────
    vault_id: ID,
    created_at_ms: u64,

    // NOTE: open_window_segments DELETED. No window gate.
}

public struct SegmentRidePositionV4 has key, store {
    id: UID,
    user: address,
    market_id: ID,
    round_index: u64,
    entry_segment_index: u64,

    // BOTH barriers snapshotted at open (no barrier_index)
    upper_barrier_price: u64,
    lower_barrier_price: u64,

    multiplier_bps: u64,
    stake_per_segment: u64,
    escrowed: u64,
    is_bot_eligible: bool,
    opened_at_ms: u64,
    closed: bool,
    closed_at_ms: u64,
    settlement_kind: u8,
    collateral: TypeName,
}
```

### 4.2 `open_segment_ride_v4`

```move
public fun open_segment_ride_v4<C>(
    market: &mut SegmentMarketV4<C>,
    vault: &mut MartingalerVault<C>,
    bot_registry: &BotRegistry,
    // NO barrier_index parameter — gone.
    stake_per_segment: u64,
    escrow: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): SegmentRidePositionV4 {
    // Same asserts as v3 EXCEPT:
    //   - drop open-window check (no window any more)
    //   - drop per-barrier-index validation
    // The cap check uses either_aggregate_max_payout against
    // max_payout_per_round.

    // Bump either_aggregate trackers (not upper/lower separately).
    market.either_aggregate_stake = market.either_aggregate_stake + escrow_amount;
    market.either_aggregate_max_payout =
        market.either_aggregate_max_payout + this_ride_max_payout;
    market.either_rider_count = market.either_rider_count + 1;

    // Snapshot BOTH barrier prices (not just one).
    let ride = SegmentRidePositionV4 {
        ...
        upper_barrier_price: market.cached_upper_barrier,
        lower_barrier_price: market.cached_lower_barrier,
        ...
    };
}
```

### 4.3 `close_segment_ride_v4` / `crank_expired_segment_ride_v4`

Settlement logic — the only real change is in `scan_for_either_touch`:

```move
/// Returns true if ANY segment in [from_idx, to_idx) had max_price >=
/// effective_upper_barrier OR min_price <= effective_lower_barrier.
/// Direction-neutral: either side triggers.
fun scan_for_either_touch<C>(
    market: &SegmentMarketV4<C>,
    from_idx: u64,
    to_idx: u64,
    upper_barrier: u64,
    lower_barrier: u64,
): bool {
    let upper_with_deadband = add_deadband_up(upper_barrier, market.deadband_bps);
    let lower_with_deadband = sub_deadband_down(lower_barrier, market.deadband_bps);
    let mut k = from_idx;
    while (k < to_idx) {
        if (table::contains(&market.segments, k)) {
            let r = table::borrow(&market.segments, k);
            if (r.max_price >= upper_with_deadband) return true;
            if (r.min_price <= lower_with_deadband) return true;
        };
        k = k + 1;
    };
    false
}
```

Settlement outcomes are unchanged:
- TOUCH_WIN — if `scan_for_either_touch` returns true
- CASHOUT — Bachelier on the closer of the two barriers
- EXPIRED_LOSS — neither side touched and round expired

### 4.4 New events

```move
public struct RideOpenedV4 has copy, drop {
    ride_id: ID,
    user: address,
    market_id: ID,
    round_index: u64,
    entry_segment_index: u64,
    upper_barrier_price: u64,
    lower_barrier_price: u64,
    stake_per_segment: u64,
    multiplier_bps: u64,
    opened_at_ms: u64,
}

public struct RideClosedV4 has copy, drop {
    ride_id: ID,
    market_id: ID,
    round_index: u64,
    settlement_kind: u8,
    closed_at_ms: u64,
    payout: u64,
    touched_side: u8,        // 0 = upper, 1 = lower, 2 = none (cashout/expired)
}
```

### 4.5 Bootstrap

`scripts/bootstrap-segment-market-v4.sh`:
- Same B7 params (round=75, barrier=±10%, mult=1.75x)
- `max_payout_per_round` replaces `max_payout_per_barrier` (just rename)
- **No `OPEN_WINDOW_SEGMENTS` env var** — gone
- Same self-consistency check as v3 (refuse to bootstrap if min-stake ride exceeds cap)

## 5. Frontend-side spec

### 5.1 Gesture

```
PRESS anywhere on the chart pane
  → useSegmentRide.open() with NO barrier_index
  → optimistic UI flips to "opening…"
  → buildOpenSegmentRideV4Tx + sponsored submit
  → confirmed in ~1-2s, ride.barrier_index = "both"

HOLD
  → chart fills with candles at 400ms cadence (unchanged)
  → LASER TRACE renders on top (see §5.2)
  → live PnL updates in corner (existing)

RELEASE
  → useSegmentRide.close() — optimistic "closing…"
  → buildCloseSegmentRideV4Tx + sponsored submit
  → settlement_kind comes back: TOUCH_WIN / CASHOUT / EXPIRED_LOSS
```

### 5.2 The laser tracer (the new visual)

A new component overlay in `useRideGesture.ts`'s p5 draw loop:

```typescript
function drawLaserTrace(p, candles, upperBarrier, lowerBarrier, chartArea) {
  if (candles.length < 2) return;

  const N = candles.length;
  const points = candles.map(c => ({
    x: candleXAt(c.index),
    y: priceToY(c.close),
    proximity: nearestBarrierProximity(c.close, upperBarrier, lowerBarrier),
    // proximity ∈ [0, 1]: 0 = AT a barrier (max win), 1 = exactly midpoint (max loss)
  }));

  // Glow first (low-alpha thick stroke under the line)
  for (let i = 1; i < N; i++) {
    const p0 = points[i - 1], p1 = points[i];
    const prox = (p0.proximity + p1.proximity) / 2;
    // Color: emerald at prox=0, mid-yellow at prox=0.5, rose at prox=1
    const [r, g, b] = lerpColor3(
      [16, 185, 129],   // emerald-500 (winning)
      [245, 158, 11],   // amber-500 (neutral)
      [244, 63, 94],    // rose-500 (losing)
      prox,
    );
    const alpha = 60 + (1 - prox) * 80;  // brighter when winning
    p.stroke(r, g, b, alpha);
    p.strokeWeight(8);  // thick, glowy
    p.line(p0.x, p0.y, p1.x, p1.y);
  }

  // Then the crisp line on top
  for (let i = 1; i < N; i++) {
    const p0 = points[i - 1], p1 = points[i];
    const prox = (p0.proximity + p1.proximity) / 2;
    const [r, g, b] = lerpColor3([16, 185, 129], [245, 158, 11], [244, 63, 94], prox);
    p.stroke(r, g, b, 220);
    p.strokeWeight(2);
    p.line(p0.x, p0.y, p1.x, p1.y);
  }

  // Final dot at the live spot — pulses when close to a barrier
  const last = points[N - 1];
  const radius = 6 + (1 - last.proximity) * 6 + Math.sin(p.millis() * 0.008) * 1.5;
  p.fill(...lerpColor3([16, 185, 129], [245, 158, 11], [244, 63, 94], last.proximity), 255);
  p.noStroke();
  p.circle(last.x, last.y, radius * 2);
}

function nearestBarrierProximity(spot: number, upper: number, lower: number): number {
  const distUp = Math.max(0, (upper - spot) / (upper - lower) * 2);     // 0 at upper, 1 at midpoint
  const distDn = Math.max(0, (spot - lower) / (upper - lower) * 2);     // 0 at lower, 1 at midpoint
  return Math.min(distUp, distDn);  // proximity to NEAREST barrier
}
```

### 5.3 Right-rail "barrier flow"

Today:
```
UPPER  $1,100  1.75×  1 RIDER  $20.00
LOWER  $900    1.75×  0 RIDERS $0.00
```

After v4:
```
ROUND #47 · 4.2s left
─────────────────────────
LIVE RIDERS    7
TOTAL STAKED   $156.20
JACKPOT        $87.50   (multiplier × your escrow)

UPPER  $1,100   (3.4% away)
LOWER  $900     (5.1% away)
```

One merged pool. Distance-to-barrier displayed for awareness.

### 5.4 Center hero — what replaces "Wait for the next round"

Since there's no "waiting" state any more, the center hero becomes the **press-to-ride invitation**:

```
                                ⚡
                       TAP AND HOLD TO RIDE
              press anywhere — touch either side wins 1.75×
```

When a ride is active:

```
                          [BIG PnL NUMBER]
                          +$0.42
                       (proximity-colored)
              hold for jackpot · release to cash out
```

When all rides settled:

```
                          [HOLD INVITE again]
```

No more "barriers locked." No more "wait." Always actionable.

## 6. Migration

V4 ships **alongside** v2 + v3. No breaking change.

| Day | Work |
|---|---|
| 1 | This doc + `scripts/bootstrap-segment-market-v4.sh` |
| 2-3 | `wick::segment_market_v4` Move module (clone of v3 + ABI changes per §4) |
| 4 | SDK helpers (`buildOpenSegmentRideV4Tx`, …) |
| 5 | Frontend laser tracer + always-open gesture + right-rail merge |
| 6 | Reviewer agents on Move + frontend |
| 7 | Bootstrap V4 market on testnet, smoke, frontend feature-flag toggle |
| 8 | V3 deprecation — frontend's `pickSegmentMarket` prefers V4 markets |

## 7. What this does NOT change

- The deterministic walk (`seeded_path::expand_segment`) — same byte-identical math
- The provably-fair claim — `/verify` reads the same events, replays the same walk
- Sponsored cranking — V4 routes through `/api/sponsor` exactly like V3
- Walrus archive + storage rebate pruning — V4 inherits both verbatim
- Vault solvency math — `max_payout_per_round` is the same magnitude as the old `max_payout_per_barrier × 2`, just merged into one bucket
- Bachelier cashout formula — same; computes against the NEARER barrier
- B7 economic calibration — V4 markets use the same B7-derived (±10%, 1.75×) parameters

## 8. Cost / risk

- Net Move LOC: ~1500 (v4 module + tests)
- Net frontend LOC: ~400 (laser tracer + gesture + right-rail tweaks + hero copy)
- Move tests target: 25+ for the v4 module specifically; full suite stays at current 525 + 25 = 550+
- Testnet deploy: same upgrade cost as any other Move package change (~0.7 SUI)
- Risk: low. V4 doesn't touch v2 or v3 modules. Live testnet markets keep working.

## 9. Open questions

- **What happens if both barriers touch in the same segment?** Settlement should be TOUCH_WIN with `touched_side = whichever_higher_extreme_came_first`. Not critical for correctness — both win at the same multiplier — but worth deciding for UI.
- **Per-user concurrent ride cap?** Today: `max_rides_per_user = 5`. Keep at 5 for v4? Probably yes.
- **DNT mode on top of v4?** Doc 26 (future). The v4 module is single-position-touch-either; DNT (corridor stays inside) is a separate product surface. Don't conflate.
- **Multi-level ladder?** Doc 27 (future). V4 keeps single-level (one upper + one lower per round). Adding a ladder of barriers (±2%/±5%/±10%/±20%) is a separate evolution.

## 10. References

- [`19_round_shared_grid_design.md`](19_round_shared_grid_design.md) — the prior shared-barrier-grid design this supersedes the picking-mechanic of (but inherits the round structure)
- [`22_sponsored_cranking_v3.md`](22_sponsored_cranking_v3.md) — sponsored cranking that V4 inherits
- [`23_storage_rebate_pruning_v3.md`](23_storage_rebate_pruning_v3.md) — pruning that V4 inherits
- [`24_walrus_archive_v3.md`](24_walrus_archive_v3.md) — Walrus archive that V4 inherits
- Live testnet (V3 markets — to be deprecated): `deployments/testnet.json` `segment_markets[]`
