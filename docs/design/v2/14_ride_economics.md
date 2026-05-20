# Ride Economics — Pricing, Liquidity, and Vault Solvency

**Status:** Design contract for Phase A.5+ Ride mechanics and Phase F.4 frontend gesture work.
**Scope:** Touch / no-touch / Ride markets on both random-walk synthetic underlyings and oracle-pushed real assets. DNT corridor pricing follows by composition.
**Owner:** This document is the source of truth for any parameter pinned in `seed-arcade-markets.sh`, `ride_market_caps`, or `market::create_*`. If on-chain parameters diverge from this doc, this doc is wrong — update it.

---

## 1. The question this document answers

The on-chain `ride_position` module ships and the `bachelier_cashout_factor` math is correct. What has not been written down is **why the Martingaler vault has positive expected edge on Ride positions**, and **which parameter combinations are safe to deploy**.

Without this, every Ride market is a coin-flip on the vault's solvency. With this, every market we deploy has a mathematically defensible expected edge and a known worst-case loss percentile.

This document answers:

1. The mechanics — what determines vault edge on a Ride position
2. The pricing problem — how to set parameters so edge is positive
3. Per-market-type strategy — different approach for random-walk vs. oracle-pushed assets
4. Random-walk calibration — how to make the on-chain walk produce the vol it advertises
5. Tested parameter sets — what to actually deploy at the hackathon
6. Per-position caps and vault sizing

---

## 2. The mechanics

A `RidePosition` has four parameters fixed at position-open time and one observed parameter:

| Parameter | Source | Notes |
|---|---|---|
| `multiplier_bps` | Position open | Locked at open, paid on touch |
| `stake_rate` | Position open (from market or per-open quote) | Accrues to `stake_paid` while held |
| `cashout_spread_bps` | Market-level | Vault's cut on voluntary cashout |
| `barrier_distance` | Market | Distance from spot at market creation |
| `σ` (vol) | Observed / assumed | Realized vol of underlying over ride horizon |

Four settlement branches:

| Outcome | Payout to user | Vault P&L (per position) |
|---|---|---|
| `TOUCH_WIN` | `multiplier × stake_paid` + unused escrow | `−(multiplier − 1) × stake_paid` |
| `CASHOUT` | `bachelier_factor × stake_paid × (1 − spread)` ≤ `stake_paid` | `stake_paid − cashout_payout` (always ≥ 0) |
| `EXPIRED_LOSS` | 0 + bounty to keeper | `+stake_paid − bounty` |
| `ABORTED_REFUND` | escrow returned 1:1 | 0 |

**Vault expected P&L per second of stake**, integrating over outcomes:

```
E[ΔP/Δt] = stake_rate × (1 − P_touch × multiplier) + (vault cashout edge term)
```

Where `P_touch` is the probability of a barrier touch in the time remaining.

The cashout term is structurally non-negative (the user receives at most fair value minus spread). The dominant term is the first one. The vault edge constraint reduces to:

> **`P_touch × multiplier < 1` at every moment of every position the vault accepts.**

---

## 3. The touch probability formula

For a one-sided barrier at distance `δ` from current spot, in driftless arithmetic Brownian motion with vol `σ`, with `T` seconds remaining:

```
P_touch(t) = 2 × Φ(−|δ| / (σ × √T))
```

where `Φ` is the standard normal CDF and `δ` is the barrier distance in the same units as `σ × √T`.

This is the closed-form Reiner-Rubinstein approximation, accurate to first order for short-dated barriers. We already compute `Φ` in fixed-point Move via the 33-entry lookup table in `ride_pricing::phi_neg_interp`, so the on-chain implementation reuses existing primitives.

**Behavior of `P_touch`:**

| Condition | `P_touch` behavior | Implication for multiplier |
|---|---|---|
| `σ → 0` | `P_touch → 0` | Multiplier can be arbitrarily high; trivial vault edge |
| `δ → 0` | `P_touch → 1` | Max safe multiplier → 1 (≈ no profit possible) |
| `T → ∞` | `P_touch → 1` | Max safe multiplier → 1 |
| `σ × √T = δ` | `P_touch ≈ 0.62` | Max safe multiplier ≈ 1.6× |
| `δ = 2 × σ × √T` | `P_touch ≈ 0.05` | Max safe multiplier ≈ 20× (plenty of room) |

The market parameter that has to track these dynamics is `multiplier`. A static `multiplier` is only safe if `P_touch` cannot exceed `1 / multiplier` over the life of the position. This is achievable for arcade markets (we control the walk) and requires dynamic quoting for real assets (vol moves).

---

## 4. Per-market-type pricing strategy

### 4.1 Arcade markets (random-walk underlyings)

We control both the walk and the pricing, so the right approach is **conservative static parameters, validated by Monte Carlo before deployment**.

**Workflow:**

1. Pick `(barrier_distance, time_horizon, multiplier, stake_rate, cashout_spread)` for a candidate market template.
2. Run Monte Carlo simulation under the calibrated walk parameters (see §5).
3. Compute vault P&L distribution: mean edge, 5th / 50th / 95th percentile, max loss.
4. **Acceptance criteria:**
   - Mean edge ≥ +10% (vault expected to win 10¢ per dollar staked)
   - 5th percentile ≥ −30% (worst case in 1-in-20 scenarios is bearable)
   - Max single-position loss ≤ 5% of vault treasury

If a parameter set fails, retune (smaller multiplier, larger barrier distance, shorter horizon) and re-simulate.

**Pinned parameters for hackathon arcade markets:** see §6.

### 4.2 Real-asset markets (oracle-pushed: BTC / ETH / SUI / SP500)

We don't control the vol of real assets. Static multipliers are unsafe. Two pieces are required:

1. **`vol_oracle` module.** EWMA of realized log-returns from `wick_oracle` ticks. Half-life ~5 minutes for short-dated markets. Stored on a shared `VolOracle<U>` object per underlying. Updated on every `oracle_tick`. ~80 LOC of Move.

2. **Quote-at-open.** `open_ride` is extended to compute `multiplier` at position-open time:

   ```
   P_touch = touch_pricer::prob(spot, barrier, vol_oracle.current, time_to_expiry)
   multiplier = (1 − target_edge) / P_touch
   multiplier = clamp(multiplier, MIN_MULT, MAX_MULT)
   ```

   The clamped multiplier is locked into the `RidePosition` struct. The market's `RideMarketCaps.multiplier_bps` becomes a fallback for compatibility but is not the primary source.

`target_edge` is a market-level parameter (default 10%). `MIN_MULT` prevents below-1 quotes (sanity); `MAX_MULT` prevents OTM-degenerate quotes when vol crashes (treasury risk if vol immediately rebounds).

**Why this is safe:** the multiplier reflects current vol regime at the moment the position opens. The user takes whatever multiplier is quoted at that instant. Vault edge is guaranteed positive at quote time, modulo the vol oracle's lag.

**Vol-oracle lag risk:** if vol spikes between two oracle ticks and a user opens before the EWMA catches up, that single position is under-priced. Per-position max stake (§7) bounds the worst case.

### 4.3 DNT corridor markets (composition of two touch markets)

`P_touch_corridor = P_touch_upper + P_touch_lower − P_both_touch` (approximate; barriers are typically far apart so `P_both_touch ≈ 0` for short tenors).

DNT_INSIDE side wins if neither barrier touched: `P_inside_wins = 1 − P_touch_corridor`. Multiplier constraint: `multiplier × P_inside_wins < 1`. Same Monte Carlo or quote-at-open machinery applies; just compose the two `P_touch` calls.

---

## 5. Random-walk calibration

**The problem.** `random_walk_driver` takes a `vol_bps` parameter at market creation. The PRNG output's realized vol must equal `vol_bps`, otherwise pricing assumptions are wrong.

**The calibration test:**

1. Instantiate the random walk with `vol_bps = X`.
2. Run 10,000 simulated 60-second windows.
3. Compute realized standard deviation of log-returns within each window, annualized.
4. Compute the mean of those realized vols.
5. If `mean(realized_vol) / X` ∈ `[0.95, 1.05]`, the walk is calibrated. Otherwise, scale the per-tick increment so they match.

**Implementation note:** the PRNG increment per tick is derived from `vol_bps` by some formula in `random_walk_driver`. Likely it currently uses `increment = vol_bps × prng_normal() × √(tick_interval)`. If realized vol diverges from stated vol, the issue is either (a) the normal approximation in the PRNG output is biased, or (b) tick interval used in the formula doesn't match the actual block time.

Calibration script: `scripts/calibrate_random_walk.py` (to be written). Outputs a multiplicative correction factor that we then bake into the Move module so `vol_bps` becomes truth-in-advertising.

---

## 6. Tested parameter sets for hackathon arcade markets

**Recalibrated 2026-05-20** after the Monte Carlo simulator surfaced two safety failures (see `15_montecarlo_validation_report.md`):

1. **Symmetric-demand vault-edge bug** — when both `SIDE_TOUCH` and `SIDE_NO_TOUCH` can open at the same multiplier `M`, vault P&L per dollar reduces to `1 - M` regardless of `P_touch`. Closed by the `vault_side` gate added to `Market<C>` (`open` rejects positions on the side the vault reserved). Arcade markets default to `vault_side = SIDE_NO_TOUCH`, so traders can only open TOUCH and the vault is the natural counterparty.
2. **Parameter mismatch** — even with the gate, multipliers must satisfy `multiplier × P_touch < 1`. The original placeholder vols (50/150/400 bps) had `P_touch` ≥ 0.56 for all three templates, well above safe.

**Pinned safe parameter set (validated by 10k-session Monte Carlo with the gate active, mean P&L positive across all three, median > 0, conservation 0 violations):**

| Market | `vol_bps` | barrier | horizon | multiplier | spread | per-position edge | sim mean P&L | sim median |
|---|---|---|---|---|---|---|---|---|
| **WRNG25** ("slow & steady") | 23 | ±4% | 300s | 2.5× | 200 bps | **+21%** | +$489M µUSDC | +$674M µUSDC |
| **WRNG100** ("volatile altcoin") | 20 | ±5% | 600s | 2.0× | 250 bps | **+38%** | +$494M | +$680M |
| **WRNG1000** ("memecoin") | 12 | ±3% | 1200s | 1.8× | 300 bps | **+15%** | +$336M | +$541M |

Closed-form `z = barrier / (vol × √horizon)` is 1.00 / 1.02 / 0.72 respectively, giving `P_touch` ≈ 32 / 31 / 47% and `vault_edge = 1 - multiplier × P_touch` of +21 / +38 / +15%.

Stake rate is unchanged ($1 / $0.50 / $0.20 per second). Per-market RideMarketCaps are sized to keep `max_concurrent_escrow × multiplier` well below treasury per §7.

These values are mirrored in:
- `scripts/seed-arcade-markets.sh` SPECS table (one row per market with vol + multiplier columns)
- `scripts/simulate_protocol.py` ARCADE_TEMPLATES dict (the simulator's source of truth)
- The live testnet seed under package `0x9f0320d08c…` (re-seeded post-recalibration)

If any one of these three drifts from the others, this doc is the source of truth; update the others to match.

**Why these specific multipliers** — 2.5× / 2.0× / 1.8× preserve the original product feel (different personalities pay differently) while keeping every template at vault edge ≥ +15%. Pushing multipliers higher would either require larger barrier distances (less engaging UX) or push vault edge below the 10% floor.

---

## 7. Per-position caps and vault sizing

The protocol-level safety guarantees come from `RideMarketCaps`:

- `max_concurrent_escrow` — total open escrow per market
- `per_user_max_escrow` — max concurrent escrow per user per market
- `max_stake_rate` — caps individual ride stake rates

**Sizing rule:** for a market with multiplier `M`:

```
max_concurrent_payout_obligation = max_concurrent_escrow × M
```

This must be ≤ `(vault_treasury × correlation_safety_factor)` for the market's correlation bucket. With a 0.2 SUI seed vault and the 3 arcade markets at 2× / 2.5× / 1.8× multipliers, the per-market cap on concurrent escrow should be small (~0.05 SUI) so even simultaneous max-stake touches across all three don't exceed treasury.

`GlobalExposureRegistry` already enforces correlation-bucketed limits at the aggregate level; per-market caps are an additional defense-in-depth.

**Bankruptcy backstop:** if vault treasury drops below `1.5 × Σ(open_payout_obligations)`, the protocol enters `vault_recovery_mode` (see Critical gap #2 in the strategy doc): no new positions open, fees route 100% to insurance + queue, existing positions can still close. Spec for this lives in a separate doc (TBD); it's not blocking for the Ride economics design.

---

## 8. Multi-asset Pro Mode pricing

The same `touch_pricer` works across all underlyings — random-walk or oracle-pushed — because it's just `P_touch(spot, barrier, vol, T)`. Pro Mode's options chain renders every cell by calling `touch_pricer::quote_cell(underlying, barrier, expiry)` which returns `(P_touch, suggested_multiplier)`. The chain UI displays the suggested multiplier and the implied probability.

For random-walk underlyings, the chain is *fully populated* with quoted prices because we know `σ` (it's the walk's parameter). For real-asset underlyings, the chain shows the dynamically-quoted multiplier at the current vol-oracle reading; cells refresh whenever the vol oracle updates.

---

## 9. The Monte Carlo simulator

`scripts/simulate_ride_market.py`. Inputs: walk parameters, market parameters, simulation count. Outputs: vault P&L histogram, summary stats (mean, std, 5/50/95 percentiles), per-outcome breakdown (touch / cashout / expired counts).

**Pseudocode:**

```python
def simulate(walk_params, market_params, n_paths=10_000):
    results = []
    for _ in range(n_paths):
        path = simulate_walk(walk_params, market_params.horizon)
        outcome = simulate_ride(path, market_params)
        results.append(outcome.vault_pnl)
    return results

def simulate_ride(path, market_params):
    stake_paid = 0
    open_time = 0
    # Naive user: holds for full horizon
    # (Future: model cashout behavior)
    for t, price in enumerate(path):
        stake_paid += market_params.stake_rate
        if abs(price - market_params.spot_at_open) >= market_params.barrier_distance:
            return TOUCH_WIN(stake_paid, market_params.multiplier)
    return EXPIRED_LOSS(stake_paid)
```

First iteration models naive (always-hold) users. Later iterations can model "cashout when ahead" / "cashout at threshold" user behavior to stress-test the spread parameter.

---

## 10. Open questions

1. **Should multiplier quote-at-open also apply to arcade markets?** Pro: uniform code path with real-asset markets, dynamic re-pricing as walk state evolves. Con: less predictable for arcade UX, complicates the "tap to ride" mental model. Current answer: no — arcade markets ship static parameters validated by Monte Carlo.

2. **DNT pricing with non-zero `P_both_touch`.** For longer-dated DNTs with tight corridors, the assumption `P_both_touch ≈ 0` breaks down. Need exact reflection-principle formula. Out of scope for hackathon (we don't ship long-dated DNT).

3. **Cashout user behavior modeling.** Currently the simulator assumes naive hold-to-expiry. A rational user cashes out near the barrier (high `bachelier_factor` ≈ 1, low spread cost) and lets it ride away from the barrier (low `bachelier_factor`, big upside). Modeling this gives a more honest vault edge estimate.

4. **Vol-of-vol on real assets.** Our EWMA vol oracle assumes vol is stable on the order of position duration. Sudden vol regime shifts (flash crashes, news prints) violate this. The MIN/MAX multiplier clamps are first-order protection; a separate "vol jump detected → halt new opens" mechanism may be needed for production.

5. **Random-walk seed source.** Current driver uses PRNG seeded from market init. For "provably fair" framing in the demo, switch to seeding from Sui block hashes so each tick is verifiable as fresh-entropy from chain state.

---

## 11. Deliverables tracked by this doc

| Item | Owner | Status |
|---|---|---|
| `vol_oracle.move` for real-asset markets | engineering | spec'd here |
| `touch_pricer.move` reusing existing `ride_pricing` primitives | engineering | spec'd here |
| Quote-at-open path in `open_ride` for real-asset markets | engineering | spec'd here |
| Random-walk calibration script + correction factor | engineering | spec'd here |
| `scripts/simulate_ride_market.py` Monte Carlo runner | engineering | spec'd here |
| Pinned arcade market parameters (Table in §6) | engineering | placeholder, awaits simulator run |
| `seed-arcade-markets.sh` updated with validated parameters | engineering | follows from above |
| `RideMarketCaps` configurations sized per §7 | engineering | follows from above |
| Bankruptcy backstop (`vault_recovery_mode`) | engineering | separate doc TBD |

---

## 12. Why this matters

Without this design, every Ride market we deploy is implicitly betting that the parameters chosen by whoever wrote `seed-arcade-markets.sh` happen to be safe. They probably are — `1.8×` payout on a `5%` barrier with `50 bps` vol is conservative — but "probably" doesn't survive the first bad streak.

With this design:

- Every arcade market has a Monte Carlo P&L distribution justifying its parameters
- Every real-asset market has a vault-edge guarantee at quote time
- The random walk's stated vol is also its realized vol (calibration enforced)
- Per-market and per-position caps are sized to vault treasury, not pulled from thin air
- The Pro Mode chain quotes prices via the same `touch_pricer` regardless of underlying

ewitulsk gets to punt this question to the MMs who quote his RFQ market — they handle pricing privately and the protocol just verifies signatures. Wick is the MM. We have to do the math ourselves, which is exactly what this document specifies how to do.
