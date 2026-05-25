# 26 — Rug-Pull House Edge for V4

**Status:** Design spec — not implemented.
**Author:** Claude Opus 4.7 + Max Mohammadi, 2026-05-24
**Inspiration:** `/Users/maxmohammadi/cash-trading-game/price_simulator.py`
  (BASE_RUG_CHANCE = 0.0001 per candle, 75% loss if holding when rug fires).

---

## 1. The problem

`scripts/simulate_v4_house_edge.py` on the live TUSD market shows
**-43% house edge** on hold-to-expiry. At sigma 100 bps/√s + ±10% barriers
+ intra-segment min/max touch detection, touch rate is ~82% per 30s
round. Break-even multiplier = 1/0.82 ≈ 1.22×, but live multiplier is
1.75×. Protocol bleeds.

**User's constraint:** keep the chart visually wild — don't drop the
vol. Add a house-edge mechanism *layered on top* of the existing walk.

## 2. The mechanism: per-segment rug-pull

Every time `record_segment_v4` records a new segment, it ALSO rolls a
deterministic dice. With probability `rug_chance_bps / 10000`, a **rug
event** fires:

1. Market enters `RUGGED` state for the current round.
2. ALL active rides on this market settle as `EXPIRED_LOSS` immediately
   — user loses full escrow.
3. Chart fires a `RugFiredV4` event so the frontend can render a
   visual "MARKET HALT" (red flash, screen shake, sad sound).
4. Next segment proceeds normally. Round-roll clears the rugged flag.

Users without an active ride at rug time are unaffected. Users who
release BEFORE the rug fires settle normally (touch / cashout / expire).

### 2.1 Why this works

Monte Carlo (5k rounds each, current ±10% / 1.75× kept):

| rug % per segment | touch % | rug % | expire % | house edge |
|---:|---:|---:|---:|---:|
| 0.0% (today) | 81.6% | — | 18.4% | **−43%** |
| 0.5% | 71% | 17% | 13% | −24% |
| 1.0% | 63% | 29% | 9% | −10% |
| **1.5%** | **55%** | **40%** | **5%** | **+3.4%** ★ |
| 2.0% | 49% | 47% | 5% | +15% |
| 3.0% | 41% | 58% | 2% | +29% |

Sweet spot: **`rug_chance_bps = 150` (1.5% per segment).** ~40% of
rounds get rugged at some point; remaining 60% pay out cleanly.
Protocol takes a 3.4% edge — small enough that the game feels
generous, large enough to be sustainable indefinitely.

### 2.2 Why deterministic randomness

`sui::random` is expensive and overkill. We derive the rug roll from
hash(segment_key || market_id || round_index). This is:
- Deterministic — provably fair, replayable via `/verify`
- Cheap — single keccak256 call, ~1k gas
- Unpredictable to the user — they can't see the next segment's key
  until the cranker emits it

## 3. Move changes (Phase 1 — ~2 hours)

### 3.1 `wick::segment_market_v4` struct additions

```move
public struct SegmentMarketV4<phantom C> has key {
    // ... existing fields ...

    // v4.26 — rug pull config + state
    rug_chance_bps: u64,        // 150 = 1.5% per segment, set at bootstrap
    rugged_at_segment: Option<u64>, // Some(seg_idx) once rugged this round, None on round-roll
}
```

### 3.2 New helper: `roll_rug`

```move
fun roll_rug<C>(
    market: &SegmentMarketV4<C>,
    segment_key: vector<u8>,
): bool {
    if (market.rug_chance_bps == 0) return false;
    let market_id_bytes = object::id_bytes(market);
    let round_bytes = bcs::to_bytes(&market.cached_round_index);
    let mut h = vector::empty();
    vector::append(&mut h, segment_key);
    vector::append(&mut h, market_id_bytes);
    vector::append(&mut h, round_bytes);
    let digest = hash::keccak256(&h);
    let roll = bytes_to_u64_le(digest, 0) % 10_000;
    roll < market.rug_chance_bps
}
```

### 3.3 Modify `record_segment_v4`

After the price walk + barrier-touch check, BEFORE returning:

```move
if (option::is_none(&market.rugged_at_segment)
    && roll_rug(market, segment_key)) {
    market.rugged_at_segment = option::some(market.cumulative_segment_index);
    event::emit(RugFiredV4 {
        market_id: object::id(market),
        round_index: market.cached_round_index,
        segment_index: market.cumulative_segment_index,
    });
    // NOTE: rides settle on close, not here. close_segment_ride_v4
    // sees rugged_at_segment and routes to EXPIRED_LOSS.
};
```

We DO NOT iterate active rides inside `record_segment_v4`. Reasons:
1. Per-tx gas budget tight on Sui
2. Lazy settlement at close time = no iteration cap
3. Frontend can show the rug event immediately via the emitted event;
   close fires normally from the user/sponsor

### 3.4 Modify `close_segment_ride_v4`

```move
let settlement = if (option::is_some(&market.rugged_at_segment)) {
    let rugged_seg = *option::borrow(&market.rugged_at_segment);
    if (ride.opened_at_segment <= rugged_seg) {
        SETTLEMENT_EXPIRED_LOSS  // ride was open when rug fired
    } else {
        // Ride opened AFTER the rug; weird edge case, treat as normal
        compute_normal_settlement(...)
    }
} else {
    compute_normal_settlement(...)
};
```

### 3.5 Modify `roll_round` (round transition)

When a new round starts, clear the rugged flag:

```move
market.rugged_at_segment = option::none();
```

### 3.6 New event

```move
public struct RugFiredV4 has copy, drop {
    market_id: ID,
    round_index: u64,
    segment_index: u64,
}
```

### 3.7 Update bootstrap

```move
public entry fun bootstrap_segment_market_v4<C>(
    // ... existing params ...
    rug_chance_bps: u64,  // NEW: 150 = 1.5% sweet spot
    // ...
)
```

This is an additive change to the function signature. Existing markets
on chain don't have rug enabled (rug_chance_bps = 0, rugged_at_segment =
None) so they behave identically to today.

### 3.8 Tests

- `test_rug_fires_at_expected_rate`: Monte Carlo in Move — N segments
  with rug_chance_bps=1500, assert ~15% fire rate.
- `test_rug_settles_ride_as_loss`: Open ride, force-rug, close, expect
  EXPIRED_LOSS.
- `test_rug_does_not_double_fire_per_round`: Once rugged, second rug
  attempt in same round is no-op.
- `test_round_roll_clears_rug`: Round transitions reset rugged_at_segment.
- `test_rug_chance_zero_is_disabled`: rug_chance_bps=0 → never fires.
- `test_close_after_rug_settles_as_loss_even_on_touch`: Even if price
  touched after rug, settlement is RUG_LOSS.

Existing 547 invariant tests should pass unchanged (collateral invariant
holds — rugged escrow goes to vault).

## 4. SDK changes (Phase 2a — ~30 min)

### 4.1 `sdk/src/segmentMarketV4.ts`

- Add `RugFiredV4Event` type:
  ```ts
  export interface RugFiredV4Event {
    marketId: string;
    roundIndex: bigint;
    segmentIndex: bigint;
  }
  ```
- Export a subscriber: `subscribeRugFiredV4(client, marketId, callback)`
- `buildBootstrapSegmentMarketV4Tx` takes new `rugChanceBps: number` arg

### 4.2 deployment record type

`SegmentMarketV4Record` adds:
```ts
rug_chance_bps?: number;
```

## 5. Frontend changes (Phase 2b — ~1.5 hours)

### 5.1 `useSegmentRideV4`

- Subscribe to `RugFiredV4` events alongside `SegmentRecordedV4`
- Maintain `lastRugSegment: bigint | null` state
- Expose `rugFiredAtMs: number | null` for the chart hook
- When close completes after rug, settlement event will carry RUGGED
  kind — render it differently

### 5.2 `useRideGestureV4` (chart)

- New prop: `rugFiredAtMs: number | null`
- On change to non-null: trigger `lossFlash = 255`, `screenShake = 30`,
  text overlay "💥 MARKET HALT" for 1.5s, play loss audio
- Reuses the existing FX state machine — small additive change

### 5.3 `CenterHeroV4`

- New settlement kind to handle in the toast:
  ```ts
  if (settlementToast.kind === SETTLEMENT_RUGGED_LOSS) {
    return "💥 MARKET HALT — ride wiped";
  }
  ```

### 5.4 Copy update

- Subtitle on idle TAP AND HOLD now includes:
  "Hold to bet price touches a line. ~1.5% per second the market may
  HALT and wipe out open rides — that's the house's edge."
- Honest about the rug mechanism so users aren't surprised

## 6. Bootstrap + deploy plan (Phase 1.5 — ~30 min)

### 6.1 Move upgrade

- `sui client upgrade --upgrade-capability $UPGRADE_CAP` from publisher
- Cost: ~0.5 SUI for storage + computation
- New package id, recorded in `deployments.json` upgrade_history

### 6.2 New TUSD market

- Run `scripts/bootstrap-tusd-market.sh` with new `RUG_CHANCE_BPS=150`
  env var
- Same vault (`vault_tusd`), same TUSD type, new SegmentMarketV4 id
- Append to `segment_markets_v4` so `pickSegmentMarketV4` auto-picks
- Old TUSD market stays alive but unused on the frontend
- Cost: ~0.1 SUI

### 6.3 Frontend deploy

- v4.26 bundle ships with rug event subscriber + FX
- Auto-deploys to Vercel from main commit

## 7. Risks / edge cases

| Risk | Mitigation |
|---|---|
| Rug fires while user has tx in flight (open or close) | Optimistic UI shows MARKET HALT; on-chain close routes to EXPIRED_LOSS deterministically. No double-spend. |
| Two rugs in one round (rug_roll fires twice) | `option::is_none` check before setting; second roll is no-op. |
| User opens ride AFTER rug fires this round | Normal settlement path (ride opened post-rug). Edge case but math holds. |
| Cranker not running → segments not advancing → no rugs → 0 house edge | Same problem as before. Cranker uptime is separate concern. |
| All 547 existing Move tests | Rug defaults to 0; old behavior preserved. Should pass unchanged. |
| Frontend doesn't catch RugFiredV4 event | Close still settles correctly on chain (lazy settlement). Visual FX is missed but money is right. |
| User audits chain → finds rug roll | That's the POINT. Rug is provably-fair, replayable via /verify. README + this spec document the math. |

## 8. Total cost estimate

| Phase | Time | SUI cost |
|---|---:|---:|
| 1. Move changes + tests | 2h | 0 (local) |
| 1.5 Upgrade + bootstrap | 30m | ~0.6 SUI |
| 2a SDK | 30m | 0 |
| 2b Frontend hook + FX | 1.5h | 0 |
| 3. Verify on chain | 30m | ~0.05 SUI |
| **TOTAL** | **~5h** | **~0.65 SUI** |

Honest revision of my earlier "~2 hr" estimate — that was wrong.
Real number is 4-5 hours of focused work.

## 9. What this DOESN'T change

- Walk math: unchanged. Chart looks identical between rug events.
- Vault accounting / collateral invariant: unchanged. Rug just routes
  more escrow to the vault.
- Touch-either game design: unchanged. Touch still wins jackpot.
- 30-second rounds: unchanged.
- Multiplier 1.75×: unchanged.
- Bai Jamjuree font: unchanged.

## 10. Open questions

1. **Visual naming.** "RUG" is on-brand crypto but might confuse a
   first-timer. Alternatives: "MARKET HALT", "FLASH CRASH",
   "LIQUIDATION CASCADE". User used "rug" + "liquidation" — recommend
   "MARKET HALT" in UI (clear) + "rug" in code/docs (memorable).
2. **Should the rug chance be visible to the user?**
   - Show: honest, builds trust ("1.5% per second")
   - Hide: more dramatic when it happens
   - Recommend: SHOW. Wick's value prop is "provably fair."
3. **Rug aftermath UX.** After a rug-loss settlement, should we
   auto-open a fresh ride OR just sit on TAP AND HOLD?
   - Recommend: TAP AND HOLD. User decides if they want to keep playing.
4. **Cap on losses per round.** If user opens, gets rugged, opens again
   in same round, rugged again → unlimited losses. Should we limit to
   1 rug per round per user?
   - Recommend: cap at 1. Once rugged in a round, user can't open
     another ride until next round. Enforced on chain.
