# 02 v2 — Asymmetric Impact Fee for Touch / No-Touch Options (Hardened)

**Status:** v2 hardened spec, ready for implementation (task H8).
**Owner:** protocol design.
**Supersedes:** v1 of 2026-05-11 (`docs/design/02_asymmetric_impact_fee.md`).
**Mitigates redteam findings #1–#12** from `docs/redteam/04_impact_fee.md`.
**Scope:** Wick-native markets (`market.move`). Predict-backed BTC route inherits its own fee schedule from DeepBook Predict and is out of scope here.

---

## 0. Why v2 exists

The v1 formula `f(m, v) = b + (cap − b) · m/(m + m0) · √v` is structurally sound — monotone in both inputs, capped, smooth, no piecewise branches. But v1 made three load-bearing assumptions that the v1 implementation could not honor:

1. *"Exposure is fixed at settlement"* — the implementation decremented exposure inline with every `redeem`, so fee inputs read different state for the first vs. last winner (Attacks 3, 5, 11).
2. *"`max_seen` reflects the live window"* — the implementation accepted permissionless `record()` calls after expiry, letting no-touch winners suppress decisiveness (Attack 1).
3. *"`v` is computed against this market's exposure"* — the per-market scope let an attacker rebroadcast risk across correlated markets on the same underlying (Attack 6); the same per-market scope let dust Sybils on the opposite side deflate `v` (Attack 2).

v2 keeps the v1 *shape* and *parameters* unchanged. What v2 changes:

- All fee inputs are read from a **`FeeSnapshot` object** captured atomically at `lock_settlement` time. After lock, no permissionless action can change a fee input.
- The `PathObservation` is **frozen** at expiry: post-expiry `record()` becomes a no-op for `max_seen`/`min_seen`/`touched_at`. Late ticks cannot rewrite history.
- The vulnerability denominator reads from a **`GlobalExposureRegistry<U>`** keyed by underlying `U`, not from per-market state. Cross-market arb is now self-defeating.
- Exposures fed into `v` are **probability-weighted**: cheap deep-OTM positions count for less, so they cannot pad the denominator without paying for it.
- A Sybil floor: positions below `MIN_EXPOSURE_STAKE` (default $10) do **not** count toward the denominator at all, and exposure deltas are EWMA-smoothed so single-tx dust cannot move `v` instantly.
- The combined off-fee from staking + any other discount is hard-capped at **30 % of the base fee** (so realised `f ≥ 0.7 · b ≈ 35 bps`).
- `isqrt` rounding direction is **explicit (round-down)** and the final fee divisor uses **ceiling division**, so the protocol takes the rounding margin in its favor.
- Multi-leg PTB spreads are defined: **each leg pays independently** (no automatic netting in MVP), and there is a `linked_redeem` opt-in path that nets fees on declared spreads.

---

## 1. Fee inputs at snapshot time

### 1.1 What gets captured at `lock_settlement`

`lock_settlement` is the once-per-market entrypoint that is callable by anyone after `expiry_ms`. v2 makes it the *single* point where every value the fee function will ever read is materialised. The function constructs a `FeeSnapshot` and freezes it onto the market.

```move
public struct FeeSnapshot has copy, drop, store {
    // --- decisiveness inputs (frozen path) ---
    final_max_seen: u64,        // path's max_seen at lock; immutable thereafter
    final_min_seen: u64,        // path's min_seen at lock; immutable thereafter
    final_touched_at: Option<u64>,  // touch trigger time, frozen
    barrier: u64,               // copied for self-containment (path may be GC'd)
    direction: u8,              // touch_above | touch_below

    // --- vulnerability inputs (frozen exposure, both sides, both markets and global) ---
    touch_exposure_local: u64,        // this market only
    no_touch_exposure_local: u64,     // this market only
    touch_exposure_global: u128,      // sum across all live markets on same underlying+side
    no_touch_exposure_global: u128,   // ditto
    pwe_touch_global: u128,           // probability-weighted touch exposure (see §3.3)
    pwe_no_touch_global: u128,        // probability-weighted no-touch exposure

    // --- canonical winner side (so apply_fee can validate) ---
    winning_side: u8,           // SIDE_TOUCH or SIDE_NO_TOUCH; mutually exclusive
    settled_at_ms: u64,         // for telemetry
    snapshot_version: u8,       // = 1; bump if FeeSnapshot layout changes
}
```

`FeeSnapshot` is `copy, drop, store`. It lives as a **non-optional field on `Market<C>`** rather than a separate object: `lock_settlement` mutates the market once, then `redeem_winner` reads the snapshot field. This is identical in gas to the existing `MarketStatus` field and avoids a second shared-object access in the hot redeem path.

```move
public struct Market<phantom C> has key {
    id: UID,
    // ...existing fields...
    status: MarketStatus,            // CREATED | LIVE | LOCKED_HIT | LOCKED_EXPIRED
    fee_params: FeeParams,
    fee_snapshot: Option<FeeSnapshot>,  // populated by lock_settlement; read by redeem
    // ...
}
```

`Option<FeeSnapshot>`: `None` while the market is live, `Some(snap)` after lock. `redeem_winner` aborts if the snapshot is `None` (same precondition as `status != LIVE`).

### 1.2 The values, where they come from

| Snapshot field | Source at lock time | Why captured |
|---|---|---|
| `final_max_seen`, `final_min_seen` | `path_observation::max_seen / min_seen` after the **freeze step** (§2) | Fee reads here, not live path. Closes Attack 1 (post-expiry inflation) and Attack 11 (path mutation racing redemptions). |
| `final_touched_at` | `path_observation::touched_at` after freeze | Mutually exclusive with `LOCKED_EXPIRED`; redeem uses this to determine winning side. |
| `barrier`, `direction` | Copied off the `PathObservation` | Self-contained: lets us drop the path object after final no-touch holder redeems. |
| `touch_exposure_local`, `no_touch_exposure_local` | `market::touch_exposure / no_touch_exposure` | For telemetry/debug only; fee uses globals. |
| `touch_exposure_global`, `no_touch_exposure_global` | `GlobalExposureRegistry<U>::touch_total / no_touch_total` for this market's underlying | Closes Attack 6 (cross-market arb). |
| `pwe_touch_global`, `pwe_no_touch_global` | `GlobalExposureRegistry<U>::pwe_touch / pwe_no_touch` | Probability-weighted; closes Attack 6's "pad the same side" subvariant and Attack 2's deep-OTM hedge. |
| `winning_side` | Derived from `final_touched_at.is_some()` and `direction` | Settles the side once; redeem need not re-derive. |
| `settled_at_ms` | `clock::timestamp_ms` at lock | Telemetry. Not read by `compute_fee_bps`. |

**Critical invariants enforced at lock:**

- `lock_settlement` aborts unless `now >= expiry_ms` AND `market.status == LIVE` AND `market.fee_snapshot.is_none()`.
- `lock_settlement` calls `path_observation::freeze(path, ctx)` *before* reading `max_seen`/`min_seen`. The freeze flips a `frozen: bool` flag on the path; subsequent `record()` calls become no-ops for `max_seen`/`min_seen`/`touched_at`.
- `lock_settlement` aborts if the market's underlying is not registered in `GlobalExposureRegistry<U>`.
- `lock_settlement` is **idempotent** by construction: `is_none()` precondition + `option::fill` ensures it can be called at most once successfully.

---

## 2. Path observation freezes at expiry

v1 `path_observation::record()` clamped post-expiry timestamps but still let `max_seen` and `min_seen` ratchet on any submitted observation. v2 makes the freeze explicit and structural.

### 2.1 New field: `frozen: bool`

```move
public struct PathObservation has key, store {
    id: UID,
    market_id: ID,
    barrier: u64,
    direction: u8,
    expiry_ms: u64,
    max_seen: u64,
    min_seen: u64,
    touched_at: Option<u64>,
    last_seen_ms: Option<u64>,
    frozen: bool,             // NEW: true after lock_settlement
}
```

`frozen` is initialised to `false` at `path_observation::new` and flipped to `true` exactly once by `path_observation::freeze`, which is `friend market` (only `market::lock_settlement` may call it).

### 2.2 `record()` becomes a no-op when frozen

```move
public fun record(
    po: &mut PathObservation,
    oracle: &WickOracle,
    clock: &Clock,
) {
    if (po.frozen) return;          // NEW: hard short-circuit
    let now = clock::timestamp_ms(clock);
    if (now >= po.expiry_ms) return;  // NEW: refuse all updates after expiry
    // ...existing observation/clamping logic...
}
```

Two layered guards:

1. `now >= expiry_ms` — the *clock-based* guard. Even if the keeper is slow to call `freeze`, no one can ratchet `max_seen` past expiry.
2. `frozen` — the *state-based* guard. After lock, even if the clock somehow regressed (consensus replay, dev `set_for_testing`), the path is immutable.

This kills Attack 1 (post-expiry `record()` inflation) at the source. Attack 4 (deadband-graze via withholding ticks) is also partially mitigated because the keeper's last pre-expiry tick is the *true* `max_seen`, but Attack 4's structural fix lives in `path_observation` v2 (post-cross window) and is out of scope here.

---

## 3. The v2 formula

### 3.1 Same shape, snapshot-derived inputs

```
f(m, v) = b + (cap − b) · g(m) · √v_clamped
g(m)    = m / (m + m0)
```

with parameters unchanged from v1:

```
b   = 50  bps      (fee_base_bps)
cap = 450 bps      (fee_cap_bps)
m0  = 50  bps      (fee_m0_bps)
```

What changed are the **inputs** `m` and `v`:

```
m = excursion(snapshot) / snapshot.barrier        (in bps; see §3.2)
v = position.payout_if_win / max(PWE_T, PWE_NT)   (in bps; see §3.3)
```

where `PWE_T = max(snapshot.pwe_touch_global, MIN_DENOM)` and `PWE_NT = max(snapshot.pwe_no_touch_global, MIN_DENOM)` (the floor `MIN_DENOM` prevents division by zero and is set to `1`, denominated in collateral micro-units).

### 3.2 Decisiveness with frozen extremes

For touch-side wins (snapshot.winning_side == SIDE_TOUCH):

```
if direction == TOUCH_ABOVE:
    excursion = max(0, snapshot.final_max_seen - snapshot.barrier)
else: // TOUCH_BELOW
    excursion = max(0, snapshot.barrier - snapshot.final_min_seen)
```

For no-touch wins (snapshot.winning_side == SIDE_NO_TOUCH):

```
if direction == TOUCH_ABOVE:
    excursion = max(0, snapshot.barrier - snapshot.final_max_seen)
else: // TOUCH_BELOW
    excursion = max(0, snapshot.final_min_seen - snapshot.barrier)
```

`m_bps = (excursion · 10_000) / barrier` in `u128`, truncated to `u64`, capped at `BPS_DENOM`.

### 3.3 Probability-weighted global exposure

The denominator of `v` reads from the **`GlobalExposureRegistry<U>`** snapshot, not from the per-market field. The registry is a shared object keyed by the underlying:

```move
public struct GlobalExposureRegistry<phantom U> has key {
    id: UID,
    // raw exposure totals — sum of payout_if_win across all live markets on U
    touch_total: u128,
    no_touch_total: u128,
    // probability-weighted exposure totals
    pwe_touch: u128,        // Σ payout_if_win · p_touch(market)
    pwe_no_touch: u128,     // Σ payout_if_win · (1 − p_touch(market))
    // EWMA state (see §3.4) — smooths exposure deltas to defeat dust manipulation
    pwe_touch_ewma: u128,
    pwe_no_touch_ewma: u128,
    last_update_ms: u64,
    // half-life parameter for EWMA, in ms; default 60_000 (1 minute)
    half_life_ms: u64,
}
```

Each `market::open_position` updates the registry *atomically with the open*: it adds `payout_if_win · p_touch` to `pwe_touch` (or symmetric for no-touch), and recomputes the EWMA. Each `market::redeem_winner` and `market::redeem_complete_set` updates the registry symmetrically on close.

`p_touch` is the **current touch probability** for the market, computed as:

```
p_touch_bps = 10_000 / payout_multiplier_bps · 10_000 = 10^8 / payout_multiplier_bps
```

so a market quoting `payout_multiplier_bps = 18_000` (1.8×) gives `p_touch_bps ≈ 5_555` (≈ 55.55 %). This makes deep-OTM markets contribute proportionally less to the denominator: a market quoting 10× pays only 10 % weight.

For `lock_settlement`, the snapshot copies whichever value of `pwe_touch_ewma` / `pwe_no_touch_ewma` is current. The fee uses the EWMA values, *not* the raw totals — see §3.4 for why.

**Why probability-weight?** A $1M no-touch position in a barrier that's clearly OTM pays a tiny premium (say $20k stake for $1M payout, multiplier 50×). Without weighting, that $1M exposure deflates `v` for every winning touch on every other market on the same underlying — but the LP's *real* risk on that no-touch is only $20k (the stake the LP receives if it loses). Weighting by `1 − p_touch` makes the contribution to no-touch exposure proportional to actual LP risk.

### 3.4 EWMA smoothing and the Sybil floor

The registry's `pwe_touch_ewma` and `pwe_no_touch_ewma` are **exponential moving averages** of the raw `pwe_touch` / `pwe_no_touch`. On every update:

```
dt = now - last_update_ms
α  = 1 − exp(−dt · ln 2 / half_life_ms)    // approximated by a u128 fixed-point
ewma_new = ewma_old + α · (pwe_raw - ewma_old)
last_update_ms = now
```

With `half_life_ms = 60_000` (1 minute), a dust position opened in the last second contributes ~1.1 % of its raw weight to the EWMA. The EWMA is what `lock_settlement` snapshots into `pwe_touch_global` / `pwe_no_touch_global`. So a Sybil dust pad opened seconds before expiry has near-zero effect on `v`.

The EWMA is computed in u128 fixed-point with a base-2 approximation of `α`:

```
α_bps ≈ min(10_000, dt · 10_000 / half_life_ms)   // linear floor: under-weights short bursts
```

(The linear approximation is conservative — it slightly under-weights very-recent updates, which is what we want against Sybils.)

**Sybil floor.** Any position with `payout_if_win < MIN_EXPOSURE_PAYOUT` (default `MIN_EXPOSURE_PAYOUT = 10 · 10^6` micro-USDC = $10) is **excluded from the registry update**. The position can still be opened and redeemed normally, but it never moves `v`. This makes Sybil dust strictly economically worthless for the purpose of fee manipulation.

### 3.5 Stacked-discount cap

WICK staking discounts (per `docs/design/03_wick_tokenomics.md` §4.1) and any other future on-chain discount sources (loyalty rebates, market-maker programmes) reduce the realised fee through `apply_fee`. v2 hard-caps the *combined* discount at **30 % of the base fee** (`b`):

```
discount_bps_capped = min(discount_bps_total, b · 30 / 100)   // i.e. 15 bps cap on a 50-bps base
realised_f_bps = max(b - discount_bps_capped, b · 70 / 100)   // i.e. floor of 35 bps
```

So even a maxed staker stacking every available rebate cannot drop the fee below 35 bps. The cap is per-position, applied after `compute_fee_bps`, before the gross→net haircut.

---

## 4. Cross-market vulnerability registry

### 4.1 The registry object

```move
public struct GlobalExposureRegistry<phantom U> has key {
    id: UID,
    touch_total: u128,
    no_touch_total: u128,
    pwe_touch: u128,
    pwe_no_touch: u128,
    pwe_touch_ewma: u128,
    pwe_no_touch_ewma: u128,
    last_update_ms: u64,
    half_life_ms: u64,
    // governance:
    paused: bool,
    admin: address,
}
```

One registry per underlying type `U` (BTC, SUI, SP500, RANDOM_WALK_K). Created once at protocol bootstrap by `wick::registry::create_for_underlying<U>(admin, ctx)`. Stored as a shared object so any market on `U` can mutate it.

### 4.2 Write path

`market::open_position` is augmented:

```move
public fun open_position<C, U>(
    market: &mut Market<C>,
    registry: &mut GlobalExposureRegistry<U>,
    side: u8,
    stake: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): Position {
    // ...existing balance checks, exposure update, mint...
    let payout = mul_bps(coin::value(&stake), market.payout_multiplier_bps);
    if (payout >= MIN_EXPOSURE_PAYOUT) {
        registry::record_open(registry, market.payout_multiplier_bps, side, payout, clock);
    };
    // ...
}
```

`registry::record_open` adds `payout` to `touch_total`/`no_touch_total`, adds `payout · p_touch` to `pwe_touch`/`pwe_no_touch`, and updates the EWMA.

`market::redeem_winner` and `market::redeem_complete_set` symmetrically call `registry::record_close` with the appropriate side and payout. Note: `record_close` decrements only **after the fee snapshot has been read** for that position; the snapshot was taken at `lock_settlement` so there is no race.

### 4.3 Read path

`lock_settlement` reads from the registry once:

```move
let snap = FeeSnapshot {
    // ...path fields from path_observation::freeze_and_read...
    touch_exposure_global: registry::touch_total(registry),
    no_touch_exposure_global: registry::no_touch_total(registry),
    pwe_touch_global: registry::pwe_touch_ewma(registry),
    pwe_no_touch_global: registry::pwe_no_touch_ewma(registry),
    // ...
};
option::fill(&mut market.fee_snapshot, snap);
```

The registry is now decoupled: subsequent opens/closes on other markets continue to mutate the registry, but this market's snapshot is frozen.

### 4.4 Markets share an underlying — the "U" parameter

`market::create<C, U>` requires an explicit underlying type `U`. The `GlobalExposureRegistry<U>` for that `U` must already exist. We bind the market to the registry at creation by storing `registry_id: ID` on the market; subsequent `open_position` / `lock_settlement` calls assert `object::id(registry) == market.registry_id`. This prevents an attacker from passing a wrong-underlying registry to a market.

For `RANDOM_WALK_K` markets the underlying is a *per-driver* type, so the random-walk arcade markets share a registry only with each other (not with BTC), as desired.

---

## 5. Bounds proof for the v2 formula

Let `f(m, v) = b + (cap − b) · g(m) · √v_clamped` with `g(m) = m/(m + m0)` and `v_clamped = min(v, 1)`. All parameters in `[0, 1]`, `b < cap < 1`, `m0 > 0`. We re-prove every property from v1 §4 with the new snapshot-derived inputs.

### 5.1 Maximum fee

`g(m) ∈ [0, 1)` for finite `m` (asymptote at 1). `√v_clamped ∈ [0, 1]`. So:

```
f(m, v) ≤ b + (cap − b) · 1 · 1 = cap
```

Strict inequality unless the asymptote is approached, but `min(f, cap)` clamp in code makes the bound hold exactly.

After the stacked-discount step (§3.5), the realised fee is `max(b · 0.7, f − discount_capped) ≤ cap`. So the upper bound is unchanged.

### 5.2 Minimum fee

`f(m, v) ≥ b` from non-negativity of the second term. After stacked discount, realised `f ≥ b · 0.7 = 35 bps`. So the absolute floor is **35 bps** (was 50 bps in v1; the loosening is intentional to allow staker rebates to bite).

### 5.3 Monotonicity in vulnerability — does it still hold under PWE?

Fix `m`. The denominator of `v` is `max(PWE_T, PWE_NT)`, which depends on the *whole book*, not just this position. Increasing this position's payout `P` increases `v` because:

```
v = P / max(PWE_T, PWE_NT)
```

Suppose this position is on the touch side. Then opening it increased `pwe_touch` by `P · p_touch_market`. So `PWE_T` post-open = `PWE_T_pre + P · p_touch`. Then:

```
v(P) = P / max(PWE_T_pre + P · p_touch, PWE_NT)
```

If `PWE_NT ≤ PWE_T_pre + P · p_touch` (touch is the binding side):

```
dv/dP = [max(...)·1 − P · p_touch] / max(...)²
      = [PWE_T_pre + P · p_touch − P · p_touch] / max(...)²
      = PWE_T_pre / max(...)²  ≥ 0
```

If `PWE_NT > PWE_T_pre + P · p_touch` (no-touch is binding):

```
dv/dP = 1 / PWE_NT  > 0
```

Either way `dv/dP ≥ 0`, with equality only at `PWE_T_pre = 0` (the cold-start case where this is the *only* position on its side and the opposite side has no exposure). In that cold-start case `v = P / P · p_touch = 1/p_touch ≥ 1`, which clamps to 1. The position pays the cap.

**Conclusion:** monotone non-decreasing in own size, just like v1. There is still no size-splitting trick.

### 5.4 Monotonicity in decisiveness

`m` depends only on `final_max_seen` / `final_min_seen` and `barrier`, all snapshotted. `dg/dm = m0/(m+m0)² > 0`. So `df/dm > 0` for `v > 0`. Identical to v1.

### 5.5 Smoothness

Same argument as v1. `g` is C¹ on `[0, ∞)`, `√v` is C¹ on `(0, ∞)` and continuous at 0 (we early-return `f = b` at `v = 0`). The stacked-discount and the final clamp introduce one piecewise point each, but both are at boundary values of `f` (either `cap` or `b · 0.7`), and both are non-strict — i.e. the function is continuous, not C¹, at those points. Acceptable.

### 5.6 Cross-market fairness

A position of payout `P` on market A and one of payout `P` on market B (same underlying, same side, same `m`) now see the *same* `v`, because both read the same global denominator. v1 violated this; v2 restores it. This is the structural fix for Attack 6.

### 5.7 Sybil resistance

A dust opener with `payout < MIN_EXPOSURE_PAYOUT` does not modify `pwe_touch` / `pwe_no_touch`, so `v` is unchanged. For dust *above* the floor but opened just before lock, the EWMA delta `α ≈ dt/half_life` is small, so the impact on `pwe_*_ewma` is negligible. Both Attack 2 and Attack 10 are neutralised structurally.

---

## 6. Twelve worked numerical examples

Conventions: USDC-collateralised market on BTC, `payout_multiplier_bps = 18_000` (1.8×), barrier $50,000 (units of $1, scaled out for clarity), `fee_params = (b=50, cap=450, m0=50)`.

For each scenario we show the **v1 fee** that the attack achieved and the **v2 fee** the snapshot-based design enforces.

### Scenario 1 — Attack 1: post-expiry `record()` inflates `max_seen`

No-touch winner, true `max_seen = $47,500` (closest_approach = $2,500, m = 500 bps), `v = 0.10`. Attacker calls `record()` after expiry with a $49,950 oracle tick.

- **v1**: post-expiry record sets `max_seen = $49,950`, m drops to 10 bps, fee drops from 165 bps → **71 bps**.
- **v2**: `path.frozen = true` after `lock_settlement`; `record()` is a no-op. `final_max_seen = $47,500`, m = 500 bps, fee = **165 bps**. Attack defeated.

### Scenario 2 — Attack 2: Sybil dust on opposite side

Real touch position $5k stake, $9k payout, decisive m = 300 bps. Attacker opens $1M no-touch from a Sybil.

- **v1**: `v = 9000/1.8M = 0.005`, fee = **74 bps**.
- **v2**: $1M no-touch contributes `payout · (1 − p_touch) = 1.8M · 0.444 = $800k` to `pwe_no_touch`. But the $1M is opened seconds before expiry, so EWMA delta `α ≈ 0.011`, contributing only ~$8.9k to `pwe_no_touch_ewma`. Real position sees `v = 9000 / max(pwe_T, pwe_NT_baseline + 8.9k) ≈ 9000/9000 = 1.0`. Fee = **393 bps**. Attack defeated.

### Scenario 3 — Attack 3: mid-redemption sequencing

10 winners of $1k each, `touch_exp = $10k`, `no_touch_exp = $5k`. First vs last redeemer.

- **v1**: first redeemer `v = 0.10`, fee **158 bps**; last redeemer (after exposure decrements to $1k) `v = 0.20`, fee **203 bps**. 28 % swing.
- **v2**: both read `snap.pwe_touch_global` taken at lock; both see the same `v = 0.10`; both pay **158 bps**. Attack defeated.

### Scenario 4 — Attack 4: deadband-graze via single `record()` at `barrier + 1`

Touch winner, `excursion = 1` price-unit, true `m_bps = 0` after truncation.

- **v1**: m = 0, g(0) = 0, fee = **50 bps** floor regardless of true wick magnitude.
- **v2**: snapshot still records the truncated m, so this individual graze still pays the floor. *Mitigation lives in `path_observation` v2 (post-cross window) — out of scope here.* Documented as known residual; severity downgraded because (a) it requires precise tick control which is hard outside the random-walk arcade, and (b) attack 9's structural fix (VRF-driven random walk) closes the arcade variant.

### Scenario 5 — Attack 5: last-redeemer divides by zero

Two winners, $1k each, no opposite-side exposure. Bob is last.

- **v1**: Bob's redeem decrements `touch_exp` to 0 first, fee module reads `denom = 0`, falls into the `v_bps = 0` branch, fee = **50 bps**.
- **v2**: Bob reads `snap.pwe_touch_global = $1.8k` (snapshotted before any redemption). `v = 1800/1800 = 1.0`. Fee = **393 bps**. Attack defeated. (Also: the `denom == 0` branch is removed; replaced with `denom = max(MIN_DENOM, denom)` so a true zero is impossible.)

### Scenario 6 — Attack 6: cross-market correlated arbitrage

Trader has $50k touch view. Markets: A (barrier $50k, deep $1M book), B (barrier $49k, $20k book). BTC pumps to $51k.

- **v1**: opening on A → `v_A = 0.018`, fee **93 bps**. Opening on B → `v_B = 0.90`, fee **388 bps**. 4.2× difference.
- **v2**: both A and B see `pwe_touch_global = $1M + $20k = $1.02M`. Position of $50k payout: `v = 50k/1.02M = 0.049` on either market. Fee on either is `f = 50 + 400 · g(m) · √0.049`. With m = 200 bps on A and 408 bps on B, `g_A = 0.80`, `g_B = 0.891`. `√0.049 ≈ 0.221`. Fee_A = **121 bps**, Fee_B = **129 bps**. The 4.2× arb shrinks to 1.07×, all of which is the genuine decisiveness difference. Attack defeated.

### Scenario 7 — Attack 6 same-side Sybil padding (large book of dust)

Attacker opens 5,000 Sybil positions of $1 each on the same side as their real $50k position. Goal: inflate `pwe_touch_global` to deflate own `v`.

- **v1**: `pwe_touch = 50k + 5,000 · $1.8 = $59k`. Real `v = 50k/59k = 0.85`, fee **373 bps** (modest reduction from $50k-only baseline).
- **v2**: each Sybil's `payout = $1.80 < MIN_EXPOSURE_PAYOUT = $10`, so registry updates skip them. `pwe_touch` unchanged. Real position pays the same as without padding. Attack defeated.

### Scenario 8 — Attack 8: WICK staking + cross-market arb stacked

Platinum staker (20 bps discount) executes Attack 6, lands on `f = 85 bps` raw, then applies discount.

- **v1**: 85 − 20 = **65 bps**. With cap-rate target of 393 bps, that's 83 % bypass.
- **v2**: Attack 6 is structurally closed (see Scenario 6), so raw fee is **121 bps**. Stacked-discount cap: `discount_capped = min(20, b · 30 / 100) = min(20, 15) = 15 bps`. Realised fee = `max(121 − 15, b · 0.7) = max(106, 35) = `**106 bps**. Designed-vs-realised gap: 15 bps (the legitimate staker rebate), not 308 bps.

### Scenario 9 — Attack 9: PTB atomic spread on random-walk

Attacker pre-computes random-walk crossings, opens just before, redeems just after.

- **v1**: each cycle pays floor 50 bps via deadband-graze.
- **v2**: snapshot fixes the floor at 50 bps for grazes (see Scenario 4 — same residual). However, the *next* cycle's open/close updates the registry, so by the time the *next* lock_settlement happens, `pwe_touch_ewma` has had time to decay. This means within a single block's cycle the fee is still floor-bounded. **Out-of-scope structural fix:** random-walk driver moves to commit-reveal seed (separate task in `path_observation` v2 / random-walk v2). v2 fee module marks this as a residual handled elsewhere.

### Scenario 10 — Attack 10: last-second opposite-side open

Bob has $10k touch; opens $1M no-touch in the last second.

- **v1**: as Attack 2 — `v_real = 0.01`, fee **84 bps**.
- **v2**: $1M no-touch opened at `expiry − 1s`, EWMA `α ≈ dt/half_life = 1000/60_000 ≈ 0.017`. Pad contributes ~$30k to `pwe_no_touch_ewma`. Real position sees `v = 18k / max(pwe_T_baseline, ~$50k) ≈ 0.36`. Fee = `50 + 400 · 0.857 · 0.6 ≈ `**256 bps**. Attack mostly defeated; residual ~25 % under-charge becomes 0 % after a 60-s freeze period (the EWMA fully accumulates by then). v2 additionally enforces a **`trade_cooloff_ms = 30_000`** parameter on `Market<C>`: opens are rejected if `now > expiry_ms − trade_cooloff_ms`. With cooloff, the $1M pad cannot be opened at all; fee = **393 bps** as honest case.

### Scenario 11 — Attack 11: withhold loser positions to inflate denominator

Alice (no-touch winner) holds 50 % of touch losers and refuses to redeem them.

- **v1**: `touch_exp` stays inflated as long as losers don't redeem; Alice's `v` stays small; fee stays cheap.
- **v2**: snapshot reads `pwe_touch_ewma` at lock_settlement, before any redemption (winning or losing) starts. Whether Alice redeems the loser positions or not is irrelevant. Fee = honest snapshot fee. Attack defeated.

### Scenario 12 — Attack 12: multi-leg PTB spread, fee mismatch

Trader buys long touch K1 ($1k stake, $1.8k payout) + no-touch K2 ($500 stake, $900 payout). BTC settles at $51k. Both legs win.

- **v1**: each leg charges its own fee; total fees $43.20. Trader is taxed for using a spread.
- **v2 default**: same — each leg pays independently, total $43.20. **This is by design**: spreads in MVP are not netted. Documented in trader-facing copy ("each leg of a spread is fee'd independently").
- **v2 opt-in**: a new entrypoint `linked_redeem(market_a, position_a, market_b, position_b, ...)` — added if and only if `market_a.fee_snapshot` and `market_b.fee_snapshot` were both written within the same epoch and refer to the same underlying — computes a *blended* fee. The blended fee is `f_blended = f(m_blend, v_blend)` where `m_blend = max(m_a, m_b)` and `v_blend = (P_a + P_b) / max(PWE_T, PWE_NT)`. Available post-MVP. v2 spec defines the interface but the implementation is feature-flagged off by default.

---

## 7. Mitigated attack table

| # | Attack | v1 bypass | v2 status | v2 mechanism |
|---|---|---|---|---|
| 1 | Post-expiry `record()` inflates max_seen | 88 % | **Closed** | `path.frozen` + clock-based `record()` short-circuit; `lock_settlement` snapshots `final_max_seen` before any later state can mutate. |
| 2 | Sybil dust on opposite side deflates `v` | 80–95 % | **Closed** | EWMA + `MIN_EXPOSURE_PAYOUT` floor: dust positions don't move denominator; last-second pads decay-weighted to ~1 %. |
| 3 | Mid-redemption exposure decrement order | 25 % swing | **Closed** | Snapshot at lock; redeem reads frozen `pwe_*_global`. |
| 4 | Wick-graze deadband (record control) | 70 % | **Mitigated, residual to path_v2** | Snapshot freezes the deadband m at lock; structural deadband fix lives in `path_observation` v2 (post-cross window). |
| 5 | v=0 via last-redeem after exposure drained | 76 % | **Closed** | Snapshot taken before any redemption; `denom == 0` branch replaced with `max(MIN_DENOM, denom)`. |
| 6 | Cross-market correlated arbitrage | 76–78 % | **Closed** | Global registry per underlying; both A and B see same `pwe_*_global`. |
| 7 | isqrt round-down compounding | < 1 % | **Closed** | `isqrt_u64` documented round-down; final fee divisor uses ceiling division so net effect favors protocol. |
| 8 | WICK staking discount stacking | +40 % multiplier | **Closed** | Stacked-discount cap at 30 % of base fee; absolute floor 35 bps. |
| 9 | PTB atomic spread on random-walk markets | 89 % (arcade) | **Mitigated, residual to driver_v2** | Snapshot fixes per-cycle fee; structural fix is VRF/commit-reveal in random_walk_driver v2. |
| 10 | Last-second opposite-side open | 75 % (with hedge) | **Closed** | EWMA decay + `trade_cooloff_ms = 30s` reject window. |
| 11 | Withhold losers' redemptions to inflate denom | 5–10 % | **Closed** | Snapshot taken before any redemption. |
| 12 | Multi-leg PTB spread fee mismatch | n/a (trader tax) | **Defined** | Each leg pays independently in MVP; `linked_redeem` opt-in defined for post-MVP netting. |

---

## 8. Move pseudocode

All math in `u64` with `u128` intermediates. Errors numbered above 100 to avoid clash with `market`'s 1–99 range.

```move
module wick::fee;

use sui::object::{Self, UID, ID};
use sui::tx_context::TxContext;
use sui::clock::{Self, Clock};
use sui::option::{Self, Option};

use wick::market::{Self, Market};
use wick::path_observation::{Self, PathObservation};
use wick::registry::{Self, GlobalExposureRegistry};

// --- constants ---
const BPS_DENOM: u64 = 10_000;
const MIN_EXPOSURE_PAYOUT: u64 = 10_000_000;     // $10 in micro-USDC
const MIN_DENOM: u128 = 1;                        // never divide by zero
const STACKED_DISCOUNT_FRAC_NUM: u64 = 30;        // discount cap = 30 % of base
const STACKED_DISCOUNT_FRAC_DEN: u64 = 100;
const REALISED_FLOOR_FRAC_NUM: u64 = 70;          // realised >= 70 % of base
const REALISED_FLOOR_FRAC_DEN: u64 = 100;

// --- error codes ---
const E_NEGATIVE_EXCURSION: u64 = 100;
const E_BAD_FEE_PARAMS: u64 = 101;
const E_NO_SNAPSHOT: u64 = 102;
const E_DOUBLE_LOCK: u64 = 103;
const E_PATH_NOT_FROZEN: u64 = 104;
const E_REGISTRY_MISMATCH: u64 = 105;

// --- params ---
public struct FeeParams has copy, drop, store {
    base_bps: u64,
    cap_bps: u64,
    m0_bps: u64,
}

// --- snapshot ---
public struct FeeSnapshot has copy, drop, store {
    final_max_seen: u64,
    final_min_seen: u64,
    final_touched_at: Option<u64>,
    barrier: u64,
    direction: u8,
    touch_exposure_local: u64,
    no_touch_exposure_local: u64,
    pwe_touch_global: u128,
    pwe_no_touch_global: u128,
    winning_side: u8,
    settled_at_ms: u64,
    snapshot_version: u8,
}

// --- core: snapshot at lock ---

/// Called only by market::lock_settlement. Builds the immutable FeeSnapshot.
/// Asserts: path is already frozen, registry matches market's underlying.
public(friend) fun snapshot_at_lock<C, U>(
    market: &Market<C>,
    path: &PathObservation,
    registry: &GlobalExposureRegistry<U>,
    clock: &Clock,
): FeeSnapshot {
    assert!(path_observation::is_frozen(path), E_PATH_NOT_FROZEN);
    assert!(market::registry_id(market) == object::id(registry), E_REGISTRY_MISMATCH);

    let touched_at = path_observation::touched_at(path);
    let winning_side = if (option::is_some(&touched_at)) {
        market::side_touch()
    } else {
        market::side_no_touch()
    };

    FeeSnapshot {
        final_max_seen: path_observation::max_seen(path),
        final_min_seen: path_observation::min_seen(path),
        final_touched_at: touched_at,
        barrier: path_observation::barrier(path),
        direction: path_observation::direction(path),
        touch_exposure_local: market::touch_exposure(market),
        no_touch_exposure_local: market::no_touch_exposure(market),
        pwe_touch_global: registry::pwe_touch_ewma(registry),
        pwe_no_touch_global: registry::pwe_no_touch_ewma(registry),
        winning_side,
        settled_at_ms: clock::timestamp_ms(clock),
        snapshot_version: 1,
    }
}

// --- core: fee computation ---

/// Returns (m_bps, v_bps) given a snapshot and a winning position's payout.
public fun compute_inputs(snap: &FeeSnapshot, payout_if_win: u64): (u64, u64) {
    // --- decisiveness ---
    let excursion: u64 = if (snap.winning_side == market::side_touch()) {
        if (snap.direction == path_observation::touch_above()) {
            if (snap.final_max_seen >= snap.barrier) snap.final_max_seen - snap.barrier else 0
        } else {
            if (snap.barrier >= snap.final_min_seen) snap.barrier - snap.final_min_seen else 0
        }
    } else {
        if (snap.direction == path_observation::touch_above()) {
            if (snap.barrier >= snap.final_max_seen) snap.barrier - snap.final_max_seen else 0
        } else {
            if (snap.final_min_seen >= snap.barrier) snap.final_min_seen - snap.barrier else 0
        }
    };

    let m_bps: u64 = if (snap.barrier == 0) 0 else {
        let raw = ((excursion as u128) * (BPS_DENOM as u128)) / (snap.barrier as u128);
        if (raw > (BPS_DENOM as u128)) BPS_DENOM else (raw as u64)
    };

    // --- vulnerability ---
    let denom_raw = if (snap.pwe_touch_global > snap.pwe_no_touch_global)
        snap.pwe_touch_global else snap.pwe_no_touch_global;
    let denom = if (denom_raw < MIN_DENOM) MIN_DENOM else denom_raw;

    let v_bps: u64 = {
        let raw = ((payout_if_win as u128) * (BPS_DENOM as u128)) / denom;
        if (raw > (BPS_DENOM as u128)) BPS_DENOM else (raw as u64)
    };

    (m_bps, v_bps)
}

/// Returns f_bps in [base_bps, cap_bps]. Round-up at the divisor.
public fun compute_fee_bps(params: &FeeParams, m_bps: u64, v_bps: u64): u64 {
    let g_num = (m_bps as u128) * (BPS_DENOM as u128);
    let g_den = (m_bps as u128) + (params.m0_bps as u128);
    let g_bps: u64 = if (g_den == 0) 0 else (g_num / g_den) as u64;

    // sqrt(v_bps · BPS_DENOM), round-down by definition of isqrt_u64.
    let sqrt_v_bps: u64 = isqrt_u64((v_bps as u128) * (BPS_DENOM as u128));

    let span_bps = params.cap_bps - params.base_bps;

    // extra_bps = ceil(span · g · sqrt_v / (BPS_DENOM · BPS_DENOM))
    // Ceiling division so round-down on isqrt is offset on the divisor.
    let num: u128 = (span_bps as u128) * (g_bps as u128) * (sqrt_v_bps as u128);
    let den: u128 = (BPS_DENOM as u128) * (BPS_DENOM as u128);
    let extra_bps: u64 = ((num + den - 1) / den) as u64;

    let f = params.base_bps + extra_bps;
    if (f > params.cap_bps) params.cap_bps else f
}

/// Apply the stacked-discount cap, then the gross→net haircut.
public fun apply_fee(
    params: &FeeParams,
    gross_payout: u64,
    f_bps_raw: u64,
    discount_bps_total: u64,
): u64 {
    // Cap discount at 30 % of base.
    let discount_cap = (params.base_bps * STACKED_DISCOUNT_FRAC_NUM) / STACKED_DISCOUNT_FRAC_DEN;
    let discount_capped = if (discount_bps_total > discount_cap) discount_cap else discount_bps_total;

    // Floor at 70 % of base.
    let realised_floor = (params.base_bps * REALISED_FLOOR_FRAC_NUM) / REALISED_FLOOR_FRAC_DEN;
    let f_after_discount = if (f_bps_raw > discount_capped) f_bps_raw - discount_capped else 0;
    let f_bps = if (f_after_discount < realised_floor) realised_floor else f_after_discount;

    let keep_bps = BPS_DENOM - f_bps;
    (((gross_payout as u128) * (keep_bps as u128) / (BPS_DENOM as u128)) as u64)
}

/// Babylonian integer square root, round-DOWN. Documented behavior.
fun isqrt_u64(n: u128): u64 {
    if (n == 0) return 0;
    let mut x: u128 = n;
    let mut y: u128 = (x + 1) / 2;
    while (y < x) {
        x = y;
        y = (x + n / x) / 2;
    };
    x as u64
}
```

### Integration into `market::redeem_winner`

```move
public fun redeem_winner<C, U>(
    market: &mut Market<C>,
    registry: &mut GlobalExposureRegistry<U>,
    position: Position,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    assert!(option::is_some(&market.fee_snapshot), E_NO_SNAPSHOT);
    let snap = *option::borrow(&market.fee_snapshot);
    let payout_if_win = market::position_payout_if_win(&position);

    let (m_bps, v_bps) = fee::compute_inputs(&snap, payout_if_win);
    let f_bps = fee::compute_fee_bps(&market.fee_params, m_bps, v_bps);

    // discount lookup is a separate module call (staking, etc); 0 in MVP.
    let discount_bps = 0;
    let net = fee::apply_fee(&market.fee_params, payout_if_win, f_bps, discount_bps);

    // Decrement registry AFTER fee read; read used the snapshot, not registry.
    registry::record_close(registry, market.payout_multiplier_bps, snap.winning_side, payout_if_win, clock);
    // Decrement local exposure for telemetry.
    market::decrement_exposure(market, snap.winning_side, payout_if_win);

    let payout_coin = vault::withdraw(&mut market.vault, net, ctx);
    market::burn_position(position);
    payout_coin
}
```

---

## 9. New test scenarios (10)

Tests live in `move/tests/fee_v2_tests.move` and replace the deleted v1 tests. All assert against the snapshot-derived inputs.

1. **`test_snapshot_freezes_max_seen`** — open touch market, simulate path with `max_seen = $47.5k`, lock_settlement, then call `record()` with a $49.95k tick. Assert `snap.final_max_seen == $47.5k` (Attack 1).
2. **`test_path_record_noop_after_freeze`** — directly call `path_observation::record()` after `freeze`, assert `max_seen` and `min_seen` unchanged.
3. **`test_v_unchanged_by_redemption_order`** — 10 winners. Redeem in order [first, last, middle, ...]; assert all 10 receive identical `f_bps` values from emitted events (Attack 3).
4. **`test_dust_below_floor_does_not_move_denom`** — open 1,000 positions of $1 each. Assert `registry::pwe_touch_ewma()` unchanged from baseline (Attack 7).
5. **`test_ewma_decays_last_second_pad`** — open $1M no-touch at `expiry - 1s`. Lock at `expiry + 1s`. Assert `pwe_no_touch_ewma` increased by less than 5 % of the raw $1M weight (Attack 2/10).
6. **`test_cross_market_v_identical`** — two markets A and B on same underlying, same payout multiplier, different barriers. Position of $50k payout opened on each. Both lock simultaneously. Assert `compute_inputs(snap_A, $50k).v_bps == compute_inputs(snap_B, $50k).v_bps` (Attack 6).
7. **`test_last_redeemer_no_div_by_zero`** — single-winner market, redeem after exposure has been internally decremented. Assert `f_bps > 0` and matches honest expectation; assert no `arithmetic_error` abort (Attack 5).
8. **`test_stacked_discount_capped`** — feed `discount_bps = 1_000` into `apply_fee` with `b = 50, raw_f = 200`. Assert effective fee = `200 - 15 = 185` (capped, not 200 - 1000 underflow) (Attack 8).
9. **`test_fee_floor_after_discount`** — feed `discount_bps = 1_000` into `apply_fee` with `b = 50, raw_f = 50`. Assert effective fee = `35` (= 70 % of base), not 0 (Attack 8).
10. **`test_isqrt_rounding_favors_protocol`** — for `v_bps ∈ {2, 3, 5, 7, 11, 13}` with fixed `m`, assert `compute_fee_bps` returns a value at least as large as `b + ceil(span · g · sqrt_v_exact / 10^8)`. I.e., the protocol never under-charges relative to ideal-real-arithmetic (Attack 7).

A 11th opt-in test, `test_linked_redeem_blends_fee`, is included gated behind a feature flag for the post-MVP `linked_redeem` path (Attack 12).

---

## 10. Open issues

1. **Half-life calibration**. `half_life_ms = 60_000` is a guess. The right value depends on typical market lifetime (15-min markets want a faster decay; 24-hr markets a slower one). Recommend: parameterise on `Market<C>` at create time, default 1 minute.
2. **Registry hot-spotting**. Every `open_position` mutates a shared object. At 1k tx/s this is the bottleneck. Mitigations: shard the registry by `(underlying, time_bucket)` into 64 partitions and aggregate at snapshot time. Defer to v2.1.
3. **Probability formula for non-binary payout structures**. v2 uses `p_touch_bps = 10^8 / payout_multiplier_bps`. This is exact for fair-priced binary options but underweights the `LP edge` baked into `payout_multiplier_bps`. For markets quoted with a 5 % house edge, `p_touch` is overestimated by ~5 %, biasing PWE slightly toward touch-side weight. Acceptable for MVP; revisit when an AMM curve is implemented.
4. **`linked_redeem` netting math**. The blended formula `m_blend = max(m_a, m_b), v_blend = (P_a + P_b) / max(PWE_T, PWE_NT)` is one of three reasonable choices. Alternatives: stake-weighted blend, pessimistic (use min of two fees), or VaR-based. Picked `max(m)` for now because it's monotone and easy to audit, but `linked_redeem` is post-MVP and the choice can change.
5. **EWMA on the read side, not the write side**. Currently the EWMA accumulates on every write. An alternative is to store `pwe_*_raw` only and compute the EWMA at snapshot read time (single shot per market lock). That is gas-cheaper for opens but loses the sample-time information. Recommend: stay with write-side EWMA for v2; revisit if open gas becomes a problem.
6. **Random-walk driver predictability**. The structural fix (commit-reveal/VRF in `random_walk_driver`) belongs to that module's redesign, not this one. v2 documents the residual via Scenario 9.
7. **Wick-graze deadband**. The "post-cross window" mitigation (Attack 4) lives in `path_observation` v2. v2 fee module is structurally compatible — once `path_observation` v2 lands, the snapshot will reflect the post-window `max_seen` automatically.
8. **Trade cool-off interaction with very short markets**. `trade_cooloff_ms = 30_000` is fine for hourly markets; for a 60-second random-walk arcade market it eats half the lifetime. Recommend: cool-off as a fraction of market lifetime, e.g. `cooloff_ms = max(5_000, market_lifetime_ms / 10)`.

---

*End v2 spec. Version: 2026-05-12. Implementer entry point: task H8 in `TASKS.md`. Apply in order: (a) add `frozen` to `PathObservation` and freeze hook; (b) add `GlobalExposureRegistry<U>` and wire `open_position` / `redeem_*`; (c) add `FeeSnapshot` to `Market<C>` and rewire `lock_settlement`; (d) implement `fee::compute_inputs`, `compute_fee_bps`, `apply_fee` per §8; (e) add tests per §9; (f) run `./scripts/agent-preflight.sh`.*
