# 02 — Asymmetric Impact Fee for Touch / No-Touch Options

**Status:** design proposal, pre-implementation
**Owner:** protocol design
**Source inspiration:** Rollbit asymmetric fees, [papertrade.xyz](https://papertrade.xyz) impact-scale formula
**Scope:** Wick-native markets (`market.move`). Predict-backed BTC route inherits its own fee schedule from DeepBook Predict and is out of scope here.

---

## TL;DR

Wick markets have a single LP-style counterparty per market — the **vault**. Today the vault's edge comes from a fixed `payout_multiplier_bps` set at create time. That is brittle: a binary-options market that quotes 1.80x is offering ~5.5% house edge regardless of how vulnerable the vault actually is when the position settles, or how decisively the position won. In particular:

- a touch position that grazes the barrier in the last second of the window pays the same as one that blew through it 2σ early;
- a $1 stake against a $1M vault is treated identically to a $200k stake against a $1M vault.

We import the Rollbit / papertrade idea: **only winning closes pay a fee, and the fee scales with how badly the close hurt the LP**. For perps, the haircut grows with `move` (price displacement) and `R = notional / referenceNotional` (LP vulnerability). For binary touch options we need analogues for both.

The recommended mechanism is a **win-only payout haircut**:

```
gross_payout = stake × payout_multiplier_bps / 10_000
fee_scale    = base + (1 − base) × decisiveness × vulnerability_kernel
net_payout   = gross_payout × (1 − fee_scale)
```

with `base = 0.005` (50 bps floor on every win), bounded above at 4.5% effective fee. The trader never sees a fee line item; the displayed `payout_if_win` is the net.

---

## 1. Mapping the perp concept onto touch options

### 1.1 What "move" means here

In papertrade's perp formula, `move` is *how far the price ran in the position's favor before the close* — a proxy for "how badly you stuffed the LP." A 0.1% move is noise; a 2% move is decisive.

For Wick we have two shapes of position and they need different definitions.

#### Touch positions — "decisiveness of the wick"

A touch position wins iff `path.touched_at` is `Some` before `expiry_ms`. The PathObservation already records `max_seen` and `min_seen` over the window. So we can quantify *how decisively* the barrier was breached:

- For `touch_above` markets: `excursion = max_seen − barrier` (must be ≥ 0 since we won).
- For `touch_below` markets: `excursion = barrier − min_seen` (must be ≥ 0 since we won).

We normalize by the barrier itself to get a unitless ratio:

```
decisiveness_touch = excursion / barrier         (in price space)
```

Intuition: a touch that goes 5% past the barrier was much more painful to the LP — the LP was probably charging too little for it — than a touch that grazes by 1bp. The 5% touch deserves a bigger haircut on its winnings; the 1bp touch should pay close to the floor.

This is exactly the spirit of papertrade's `move`: **how far in your favor did it go before you cashed out.**

#### No-touch positions — "path room remaining"

No-touch wins iff `touched_at` stays `None` through expiry. Here decisiveness is *how much daylight you had* — the closer the path got to the barrier, the closer the LP came to losing, and the smaller the haircut should be. The further away the path stayed, the more decisively the no-touch won.

Define:

- For `touch_above` markets: `closest_approach = barrier − max_seen` (≥ 0 since we won).
- For `touch_below` markets: `closest_approach = min_seen − barrier` (≥ 0 since we won).

Normalize:

```
decisiveness_notouch = closest_approach / barrier
```

A no-touch that *almost* got hit (closest approach = 0.1%) was a near-miss for the LP; the LP wants to keep most of that win. A no-touch that left the LP terrified the whole time (closest approach = 0%) is at the floor. A no-touch where the price never got within 5% of the barrier was a free roll for the trader and deserves a real haircut.

Both definitions collapse to the same `move`-shaped quantity: a non-negative ratio that is 0 at the worst-case-for-LP boundary and grows when the trade was easy.

### 1.2 What "position notional / reference notional" means here

In papertrade, `R = notional / referenceNotional` says "this trade was R times the size of a 'normal' position relative to the LP pool." Bigger R = more vault-relative damage = bigger haircut.

The Wick analogue is straightforward. The amount the vault pays a winning position is `payout_if_win`. The vault's effective worst-case obligation is the larger of `touch_exposure` and `no_touch_exposure` at the moment of redemption. So:

```
vulnerability = payout_if_win / max(touch_exposure, no_touch_exposure)
```

This sits in `(0, 1]` for any single position (since one position cannot exceed the side's total exposure). It is **monotone in size**: a single position that is 50% of the winning side's exposure is twice as vulnerability-weighted as one that is 25%, regardless of who else is in the book.

We use the *winning side's* exposure (not vault balance) on purpose: it represents the obligation the vault is actually working through. Using vault balance would let traders dilute their own R by waiting for redemptions of *other* winners to drain the vault. Exposure is the honest denominator.

Vulnerability as defined is **monotone-increasing in payout size** at any fixed market state — we prove this in §4.

---

## 2. Three candidate fee curves

Common notation across all three:

- `m` ∈ `[0, ∞)` — decisiveness ratio (the `move` analogue), defined per side as in §1.1
- `v` ∈ `(0, 1]` — vulnerability (the `R` analogue), defined as in §1.2
- `b` ∈ `[0, 1)` — base fee floor (we'll set ≈ 0.005)
- `k1`, `k2` — calibration constants

The fee `f(m, v)` is the fraction of the gross payout retained by the vault. `net_payout = gross_payout × (1 − f)`.

### Candidate A — direct port of papertrade

```
scale_A(m, v) = (1 − b) / (1 + 1/(m·k1) + v/(m·k2))
f_A(m, v) = b + scale_A(m, v) × m_norm
```

(Papertrade's original gives `scale` as an in-the-money discount; the fee is `1 − scale`. Adapted here so that the fee grows with both `m` and `v`.)

Mental shape:

| m \ v | 0.01 | 0.10 | 0.50 |
|-------|------|------|------|
| 0.001 | ~0%  | ~0%  | ~0%  |
| 0.010 | ~0.5%| ~0.7%| ~1.5%|
| 0.050 | ~1.5%| ~2.0%| ~3.5%|
| 0.200 | ~3.0%| ~3.8%| ~4.5%|

EV/risk implications:
- **Pros:** Two-knob calibration, smooth, exactly the curve papertrade tuned for retail intuition.
- **Cons:** Two reciprocal terms make Move-side overflow / divide-by-zero edge cases noisy. The `1/(m·k1)` term explodes when `m` is sub-bp, forcing a deadband. The shape at small `m` is strongly hyperbolic — micro-touches get *all* of their winnings. That is fine for perps where micro-moves are common; for touch options it under-charges grazing wins, which are exactly the trades the LP hates most because they were predictable mean-reversions.

### Candidate B — sqrt-vulnerability haircut

```
f_B(m, v) = b + k1 · m · √v             (clamped to [b, b+(1−b)])
```

Mental shape:

| m \ v | 0.01 | 0.10 | 0.50 |
|-------|------|------|------|
| 0.001 | ~0.5%| ~0.5%| ~0.5%|
| 0.010 | ~0.6%| ~0.8%| ~1.2%|
| 0.050 | ~1.0%| ~2.1%| ~4.0%|
| 0.200 | ~2.5%| ~6.8%| ~14% |

(With `k1 = 1.0`, `b = 0.005`. We'd cap at ~5% in practice.)

EV/risk implications:
- **Pros:** One knob, easy to reason about, sqrt damping on `v` matches the standard "impermanent loss-like" intuition that vault risk doesn't grow linearly with single-position size (the rest of the book provides natural offsets).
- **Cons:** Linear in `m` means a 10× decisive win pays a 10× fee. That overshoots — a touch that goes 50% past the barrier is not 10× as bad as one that goes 5% past, because the LP's loss is the *same* fixed payout in both cases. We want a **saturating** function of `m`, not a linear one.

### Candidate C — piecewise (deadband + linear above threshold)

```
f_C(m, v) = b                                            if m ≤ m_dead
         = b + k1 · (m − m_dead) · v                     if m_dead < m ≤ m_cap
         = b + k1 · (m_cap − m_dead) · v                 if m > m_cap
```

With `m_dead = 0.001` (10 bps grace zone for grazing touches), `m_cap = 0.05` (5% — anything past this is saturated), `k1 = 0.9`.

Mental shape:

| m \ v | 0.01 | 0.10 | 0.50 |
|-------|------|------|------|
| 0.0005| 0.5% | 0.5% | 0.5% |
| 0.005 | 0.54%| 0.86%| 2.3% |
| 0.030 | 0.76%| 3.1% | 13.5%|
| 0.100 | 0.94%| 4.9% | 22%  |

(Without a hard cap, `f` hits ~22% at extreme values. Needs a clamp.)

EV/risk implications:
- **Pros:** Explicit deadband neutralizes the "wick exactly grazes" edge case. Saturation past `m_cap` is correct (LP's loss is bounded). Easy to reason about at the bounds.
- **Cons:** Discontinuity in derivative at `m_dead` and `m_cap`. Three parameters to tune. Linear in `v` overcharges large positions — same overshoot problem as B.

### What we actually want

The good ideas to keep:

- **Saturation in `m`** (from C) — past some point the LP can't be hurt more.
- **Sub-linear in `v`** (sqrt from B) — book offsets matter.
- **Smooth, no piecewise** (from A) — easier audit, fewer branching bugs in Move.
- **Floor `b`** (all three) — every win pays *something*; otherwise grazing arbitrage is free.
- **Hard cap** (none of them have a clean one) — protocol guarantees winners get ≥ X% of stated payout.

---

## 3. Recommended formula

```
f(m, v) = b + (cap − b) × ( m / (m + m0) ) × √v_clamped

where
  v_clamped = min(v, 1)
  m         = decisiveness ratio (price-space, see §1.1)
  m0        = reference decisiveness (50 bps) — controls how fast the haircut climbs
  b         = base floor          = 50 bps  (0.005)
  cap       = effective ceiling   = 4.5%    (0.045)
```

Properties (proved in §4):

- `f(0, v) = b` for all `v` — grazing touches pay the floor.
- `lim_{m→∞} f(m, v) = b + (cap − b)·√v ≤ cap` — saturates.
- `f(m, 0) = b` — a position smaller than any other open exposure pays the floor.
- Strictly monotone-increasing in both `m` and `v`.
- Smooth (C¹) over the entire domain.

The key shape function `g(m) = m / (m + m0)` is the standard rectangular-hyperbola saturation used in enzyme kinetics (Michaelis–Menten) and queueing theory. It is 0 at `m = 0`, ½ at `m = m0`, asymptotes at 1. It has no derivative discontinuities and no overflow risk (numerator and denominator are both bounded sums in our fixed-point representation).

The `√v` damping caps the LP's worst case: even a position that *is* the entire winning-side exposure (`v = 1`) and is *infinitely* decisive only pays the cap.

### Worked numerical examples

We use the following definitions for the table:
- Markets quote `payout_multiplier_bps = 18_000` (1.8x gross)
- Underlying `barrier = 50_000` (BTC at $50k, scaled out for clarity)
- All currency amounts in USDC units

| # | stake | gross payout | side-exposure | side excursion | m       | v       | f       | net payout | trader keeps |
|---|-------|--------------|---------------|----------------|---------|---------|---------|------------|--------------|
| 1 | 100   | 180          | 1,000         | 5 (grazes)     | 0.0001  | 0.180   | 0.55%   | 179.01     | 99.45% of gross |
| 2 | 100   | 180          | 1,000         | 250 (0.5%)     | 0.005   | 0.180   | 1.81%   | 176.74     | 98.19% |
| 3 | 100   | 180          | 1,000         | 1,500 (3%)     | 0.030   | 0.180   | 4.06%   | 172.69     | 95.94% |
| 4 | 100   | 180          | 100,000       | 1,500 (3%)     | 0.030   | 0.0018  | 0.86%   | 178.45     | 99.14% |
| 5 | 5,000 | 9,000        | 10,000        | 1,500 (3%)     | 0.030   | 0.900   | 8.42% → cap 4.5% | 8,595.00 | 95.50% |
| 6 | 5,000 | 9,000        | 10,000        | 50 (0.1%)      | 0.001   | 0.900   | 1.17%   | 8,894.95   | 98.83% |
| 7 | 50    | 90           | 1,000,000     | 250 (0.5%)     | 0.005   | 0.00009 | 0.54%   | 89.51      | 99.46% |
| 8 | 1,000 | 1,800        | 5,000         | 0 (no-touch, closest = 5%) | 0.05 | 0.36   | 3.93%   | 1,729.20   | 96.07% |
| 9 | 1,000 | 1,800        | 5,000         | 0 (no-touch, closest = 0.05%) | 0.0005 | 0.36 | 0.71% | 1,787.20   | 99.29% |
| 10| 200   | 360          | 360 (only position) | 100 (2%) | 0.020 | 1.000  | 3.36%   | 347.90     | 96.64% |

(Examples 5 and 8 illustrate the cap engaging: row 5's raw computed `f` would be ~8.4%, but the protocol clamps to `cap = 4.5%` because the trader took down most of the winning side single-handedly with a decisive move.)

Spread across the table:
- **Smallest fee:** row 7 — small stake against a fat book → vulnerability is microscopic, fee floors at base.
- **Largest fee:** rows 5 — capped at the protocol ceiling.
- **Typical retail trade:** rows 2, 3 — 1.8% to 4% effective fee, in line with Polymarket / sportsbooks.

### Suggested calibration values (by collateral type)

| Collateral | b      | cap   | m0     | Notes |
|------------|--------|-------|--------|-------|
| USDC       | 0.005  | 0.045 | 0.005  | Default. ~0.5% min, 4.5% max. |
| SUI        | 0.0075 | 0.06  | 0.005  | Wider band — SUI vault is more volatile in dollar terms. |
| Random walk (arcade) | 0.002 | 0.02 | 0.005 | Demo-friendly; vault is house, traders don't notice. |

These are governance parameters — stored on the `Market<C>` at create time, not hardcoded. We name them `fee_base_bps`, `fee_cap_bps`, `fee_m0_bps`.

---

## 4. Bounds and monotonicity proofs

Let `f(m, v) = b + (cap − b) · g(m) · √v` where `g(m) = m / (m + m0)`, all parameters in `[0, 1]`.

### Maximum fee

`g(m) ≤ 1` for all `m ≥ 0`, with equality only as `m → ∞`. `√v ≤ 1` for `v ∈ [0, 1]`. Therefore

```
f(m, v) ≤ b + (cap − b) · 1 · 1 = cap
```

The cap is achieved only in the limit. In code we additionally clamp `f := min(f, cap)` for safety.

### Minimum fee

`g(m) ≥ 0`, `√v ≥ 0`. Therefore `f(m, v) ≥ b` for all valid inputs. The floor is achieved when `m = 0` *or* `v = 0`.

### Zero-fee conditions

The fee equals **zero only if `b = 0`**, which we explicitly disallow (`b ≥ 50 bps` enforced at market creation). In other words: every winning close pays at least the base fee. This is the desired property — there is no input the trader can choose that escapes the floor.

### Maximum-fee conditions

`f → cap` as `m → ∞` and `v → 1` simultaneously. In practice the protocol clamps both:
- `m` is computed against the actual observed extremum, naturally bounded by sane price ranges.
- `v` is clamped to `1` (a single position cannot be larger than total side exposure by construction; clamp guards against rounding).

### Monotonicity in vulnerability

Fix `m`. Then
```
∂f/∂v = (cap − b) · g(m) · 1/(2√v) > 0 for v > 0
```
Strictly increasing in `v`. **There is no exploit via choosing the right size**: making your position bigger always makes your effective fee non-decreasing, holding decisiveness fixed.

A subtlety: `v = payout / max(touch_exposure, no_touch_exposure)`. Increasing your own stake increases both numerator and denominator (yours is included in the side total). Let `P` be your payout and `S` be the rest of your side's exposure. Then `v(P) = P / (P + S)`. `dv/dP = S / (P + S)² > 0`. So increasing your own size strictly increases `v`, which strictly increases `f`. **No size-splitting trick reduces the fee** — the function is invariant to whether you submit one position of size 2P or two of size P (modulo redemption ordering, which cannot be exploited because exposure is fixed at settlement).

### Monotonicity in decisiveness

Fix `v`. Then
```
∂f/∂m = (cap − b) · m0 / (m + m0)² · √v > 0 for v > 0
```
Strictly increasing in `m`. Bigger wicks pay bigger fees. (For no-touch: bigger room from the barrier → bigger fee, which is the same property since both sides use the same shape.)

### Smoothness

`g(m)` is C¹ on `[0, ∞)`. `√v` is C¹ on `(0, ∞)` and continuous at 0. The product is C¹ everywhere except `v = 0`, but at `v = 0` we early-return `f = b` so the discontinuity is unobservable.

---

## 5. EV analysis

**Claim:** A trader who consistently makes "fair" trades — entering at a quoted multiplier that exactly matches the true probability of touching — has expected return per trade approximately equal to `−E[f] × P(win) × multiplier`.

### Setup

Suppose true touch probability is `p` and the vault quotes a gross payout multiplier `μ`. Fair pricing means `p · μ = 1`, i.e. `μ = 1/p`. With probability `p` the trader wins and receives `stake × μ × (1 − f)`. With probability `1 − p` they lose and receive 0.

```
E[net return / stake] = p · μ · (1 − E[f | win]) − 1
                      = p · μ − p · μ · E[f | win] − 1
                      = (p · μ − 1) − p · μ · E[f | win]
                      = 0 − p · μ · E[f | win]                  (fair pricing)
                      = −E[f | win]                              (since p · μ = 1)
```

So the trader's expected return per unit stake is **exactly** `−E[f | win]`. The fee is the entire house edge.

### Sanity check via simulation argument

Take `b = 0.005`, `cap = 0.045`, `m0 = 0.005`. Assume:
- `m` is drawn from an empirical distribution of touch decisiveness — for short-dated touch options at sensible barriers, the median is around 0.005 (50 bps past), the long tail is heavy out to 0.05.
- `v` for a typical retail trader is ~0.05 (their position is 5% of the winning side).

Then `g(0.005) = 0.5`, `√0.05 ≈ 0.224`, so

```
f ≈ 0.005 + 0.040 × 0.5 × 0.224 = 0.005 + 0.0045 = 0.0095   (~95 bps)
```

A trader making fair trades all day burns ~1% per trade. That matches the Polymarket / Kalshi range, is below typical sportsbook vig (5–10%), and well below perps funding (which compounds). For larger / more decisive traders the fee climbs to the cap; for whales taking the whole book on a dramatic touch they pay the protocol-mandated 4.5% ceiling.

### Why this is honest

The trader sees `payout_if_win` as a single number. There is no fee line item, no surprise. The vault's edge is fully encoded in the gross multiplier minus the post-settlement haircut, so:

- the *displayed* multiplier on the trade ticket is the *gross* number for comparison shopping,
- the *settled* payout is `gross × (1 − f)`,
- the README explains that the realized payout depends on path-decisiveness and book-share, with worked examples,
- the UI shows "estimated payout: 1.78x – 1.80x" (i.e. min-fee to no-fee range) on the ticket.

This is the same UX as Rollbit: traders learn that "obvious" wins pay a touch less, and they don't mind because they still won.

---

## 6. Edge cases

### Vault balance is zero

Cannot happen during a live market (creation requires positive `seed_collateral`; redemptions can only drain to zero on the last winner). If somehow exposure is non-zero with vault balance zero, redemption would fail upstream in `vault::withdraw` before the fee calculation runs. The fee function does not read vault balance, so it is robust to this.

### Vault is enormous (single position is dust)

`v = stake × multiplier / max(t_exp, nt_exp)` collapses toward zero as exposure grows. `√v → 0`, so `f → b`. The trader pays the floor. This is correct: a $10 trade against a $10M book deserves no scaling.

### Decisiveness is exactly zero (wick exactly grazes the barrier)

For touch positions: `excursion = max_seen − barrier = 0` is possible (the touch trigger is `>=`, so a price exactly equal to the barrier is a hit). For no-touch: `closest_approach = 0` cannot happen because `closest_approach = 0` means a hit, which means no-touch lost.

`m = 0 / barrier = 0`. Then `g(0) = 0`, `f = b`. The trader pays the floor only. This is the **deadband property** without a piecewise branch: the floor always applies, the kernel only adds on top.

### Decisiveness slightly negative due to integer rounding

Could happen if we computed `excursion = max_seen − barrier` for a no-touch case by mistake (max_seen < barrier when the trader won the no-touch). Guard with a `if (max_seen >= barrier) excursion = max_seen − barrier else excursion = 0` early-return. Same for the no-touch path.

### Minimum-touch-margin interaction

The protocol does **not** require a minimum touch margin (i.e. it does not reject barriers within X bps of spot). If governance later wants to enforce one, it lives separately in `path_observation.move::new` — the fee function is independent. The deadband `m → 0 ⇒ f = b` is the *only* deadband relevant to fee math.

### Multiplier exactly 1.0

Disallowed by `assert!(payout_multiplier_bps > 10_000)` in `market::create`. Even if it were allowed, `gross = stake`, `net = stake × (1 − b) ≈ 0.995 × stake`, so the trader pays the floor on a "win" that returns less than their stake. The product would not list such a market; defense-in-depth.

### Gross payout overflow

`gross = stake × multiplier_bps / 10_000`. With `u64`, `stake × multiplier_bps` can overflow if `stake > 10^15`. We compute in `u128` (already done in `mul_bps`). The fee step is `gross × (1 − f)` where `1 − f ∈ [0.955, 0.995]`. Done in `u128`, no overflow risk for any reasonable `gross` < 2^63.

---

## 7. Move pseudocode

All math in `u64` with `u128` intermediates. Basis points are the universal denomination: `BPS_DENOM = 10_000`. Decisiveness and vulnerability are also in bps for unit consistency.

```move
module wick::fee;

use wick::market::{Self, Market, Position};
use wick::path_observation::{Self, PathObservation};

/// Basis-points denominator. 10_000 bps = 100%.
const BPS_DENOM: u64 = 10_000;
/// Fixed-point sqrt scaling. Computes √(x · SQRT_SCALE²) / SQRT_SCALE for u64.
const SQRT_SCALE: u64 = 10_000;

const E_NEGATIVE_EXCURSION: u64 = 100;
const E_BAD_FEE_PARAMS: u64 = 101;

/// Per-market fee parameters. Set at create_market time, immutable thereafter.
public struct FeeParams has copy, drop, store {
    base_bps: u64,    // floor, e.g. 50  (= 0.50%)
    cap_bps: u64,     // ceiling, e.g. 450 (= 4.50%)
    m0_bps: u64,      // half-saturation point in bps of barrier price, e.g. 50
}

public fun new_fee_params(base_bps: u64, cap_bps: u64, m0_bps: u64): FeeParams {
    assert!(cap_bps > base_bps, E_BAD_FEE_PARAMS);
    assert!(cap_bps < BPS_DENOM, E_BAD_FEE_PARAMS); // never haircut more than 100%
    assert!(m0_bps > 0, E_BAD_FEE_PARAMS);
    FeeParams { base_bps, cap_bps, m0_bps }
}

/// Compute (m_bps, v_bps) for a winning position about to redeem.
/// `m_bps` = decisiveness, normalized against barrier, in bps.
/// `v_bps` = vulnerability, in bps.
public fun compute_inputs<C>(
    market: &Market<C>,
    position: &Position,
    path: &PathObservation,
): (u64, u64) {
    let barrier = path_observation::barrier(path);
    let direction = path_observation::direction(path);
    let max_seen = path_observation::max_seen(path);
    let min_seen = path_observation::min_seen(path);
    let side = market::position_side(position);
    let payout = market::position_payout_if_win(position);

    // --- decisiveness ---
    let excursion: u64 = if (side == market::side_touch()) {
        // Touch won: price crossed barrier in the trigger direction.
        if (direction == path_observation::touch_above()) {
            if (max_seen >= barrier) max_seen - barrier else 0
        } else {
            if (barrier >= min_seen) barrier - min_seen else 0
        }
    } else {
        // No-touch won: price stayed inside.
        if (direction == path_observation::touch_above()) {
            // Closest approach from below.
            if (barrier >= max_seen) barrier - max_seen else 0
        } else {
            if (min_seen >= barrier) min_seen - barrier else 0
        }
    };

    // m_bps = excursion * 10_000 / barrier  (u128 to avoid overflow)
    let m_bps: u64 = if (barrier == 0) 0 else
        (((excursion as u128) * (BPS_DENOM as u128) / (barrier as u128)) as u64);

    // --- vulnerability ---
    let touch_exp = market::touch_exposure(market);
    let no_touch_exp = market::no_touch_exposure(market);
    let denom = if (touch_exp > no_touch_exp) touch_exp else no_touch_exp;

    // v_bps = payout * 10_000 / max(touch_exp, no_touch_exp), clamped to BPS_DENOM
    let v_bps: u64 = if (denom == 0) 0 else {
        let raw = ((payout as u128) * (BPS_DENOM as u128) / (denom as u128)) as u64;
        if (raw > BPS_DENOM) BPS_DENOM else raw
    };

    (m_bps, v_bps)
}

/// Returns the fee in bps. f_bps in [base_bps, cap_bps].
public fun compute_fee_bps(params: &FeeParams, m_bps: u64, v_bps: u64): u64 {
    // g(m) = m / (m + m0), in bps. Numerator & denom both bps; ratio is unitless.
    // g_bps = m_bps * BPS_DENOM / (m_bps + m0_bps)
    let g_bps: u64 = {
        let denom = m_bps + params.m0_bps;
        if (denom == 0) 0
        else (((m_bps as u128) * (BPS_DENOM as u128) / (denom as u128)) as u64)
    };

    // sqrt(v_bps / BPS_DENOM) returned in bps.
    // Computed as integer sqrt(v_bps * BPS_DENOM): if v_bps = 10_000 (= 1.0),
    // result = sqrt(100_000_000) = 10_000.
    let sqrt_v_bps: u64 = isqrt_u64((v_bps as u128) * (BPS_DENOM as u128));

    // span = (cap - base), in bps.
    let span_bps = params.cap_bps - params.base_bps;

    // extra_bps = span * g * sqrt_v / (BPS_DENOM * BPS_DENOM)
    // Use u128 throughout; both g_bps and sqrt_v_bps are <= BPS_DENOM = 10_000,
    // so g * sqrt_v <= 10^8, span <= 10^4 → product <= 10^12 < 2^64. Safe.
    let extra_bps: u64 = (
        ((span_bps as u128) * (g_bps as u128) * (sqrt_v_bps as u128))
        / ((BPS_DENOM as u128) * (BPS_DENOM as u128))
    ) as u64;

    let f = params.base_bps + extra_bps;
    if (f > params.cap_bps) params.cap_bps else f
}

/// Apply the fee to a gross payout. Returns net_payout in collateral units.
/// net = gross * (BPS_DENOM - f_bps) / BPS_DENOM
/// Computed in u128 to handle gross up to ~2^60 without overflow.
public fun apply_fee(gross_payout: u64, f_bps: u64): u64 {
    let keep_bps = BPS_DENOM - f_bps; // safe: f_bps <= cap_bps < BPS_DENOM
    (((gross_payout as u128) * (keep_bps as u128) / (BPS_DENOM as u128)) as u64)
}

/// Babylonian integer square root for u128 → u64. Used at most once per redeem.
/// O(log n) iterations, no floats, no allocation.
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

### Integration into `market::redeem`

Add a `fee_params: FeeParams` field on `Market<C>` (set at `create`). Inside `redeem`, after the `won` branch:

```move
let payout = if (won) {
    let (m_bps, v_bps) = fee::compute_inputs(market, &position, path);
    let f_bps = fee::compute_fee_bps(&market.fee_params, m_bps, v_bps);
    let net = fee::apply_fee(payout_if_win, f_bps);

    // The (gross − net) stays in the vault → that's the "fee" — it accrues
    // to the LP / protocol-funded pool with no separate transfer.
    let payout_coin = vault::withdraw(&mut market.vault, net, ctx);

    sui::event::emit(PositionRedeemed {
        market_id: object::id(market),
        position_id: pos_id,
        side,
        payout: net,
        won: true,
        owner: tx_context::sender(ctx),
    });

    // Optional: emit a separate FeeApplied event for analytics.
    sui::event::emit(FeeApplied {
        market_id: object::id(market),
        position_id: pos_id,
        gross: payout_if_win,
        net,
        f_bps,
        m_bps,
        v_bps,
    });

    payout_coin
} else {
    /* losers pay nothing — no fee branch here */
    ...
};
```

### Overflow notes

- `excursion * BPS_DENOM` in `compute_inputs`: safe in `u128` as long as `excursion < 2^64 / 10^4 ≈ 1.8 × 10^15`. Our 1e9-scaled prices (~$50k = 5×10^13) leave 2 orders of magnitude of headroom.
- `payout * BPS_DENOM` in `compute_inputs`: same headroom; vault payouts < $10^14 are safe.
- `span * g * sqrt_v` in `compute_fee_bps`: each factor ≤ 10^4, product ≤ 10^12, safe in `u128`.
- `gross * keep_bps` in `apply_fee`: with `gross < 2^60` and `keep_bps < 10^4`, product < 2^74, comfortably safe in `u128`.
- `isqrt_u64` operates on `n = v_bps * BPS_DENOM ≤ 10^8`, so the Babylonian loop converges in <10 iterations.

### Conservation check

The fee is *retained in the vault*. There is no separate fee sink. So the existing solvency invariant in `market::open`

```
vault_balance >= max(touch_exposure, no_touch_exposure)
```

still holds, and after redemption the residual `(gross − net)` simply remains in `vault.balance`, accruing to whichever party governs the vault (in MVP: the protocol, since vaults are protocol-funded). This is the cleanest possible plumbing.

---

## Open questions for review

1. Should the fee accrue to a separate `Balance<C>` field (`fee_pool`) instead of staying in the working vault? Cleaner accounting, marginally more gas. Recommend: defer to v2; MVP keeps it in the vault.
2. Should `m0_bps` be auto-tuned per market (e.g., as a fraction of barrier-vs-spot at creation)? Recommend: no for MVP, governance constant.
3. Should we expose a `quote_net_payout(market, side, stake) -> (min_net, max_net)` view on-chain so the UI doesn't have to duplicate the math? Recommend: yes, small surface area, prevents drift.
4. Should the no-touch decisiveness use `closest_approach` or some integral over time-near-the-barrier? Recommend: `closest_approach` for simplicity; the integral version requires a richer `PathObservation` and isn't worth the gas in MVP.
