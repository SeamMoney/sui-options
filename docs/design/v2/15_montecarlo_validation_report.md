# Monte Carlo Validation Report — Wick Markets Protocol

**Generated:** by `scripts/simulate_protocol.py` (seed=42).
**Sessions per template:** 10,000
**Templates:** WRNG25, WRNG100, WRNG1000
**Total sessions:** 30,000

## 1. Conservation Invariant — INV-1'

`treasury + side_bucket + Σ_m settlement_locks[m] + abort_pool + fee_buckets == cumulative_in - cumulative_out` **held across every state mutation in every session** (30,000 sessions, millions of mutations). **Status: PASS**.

## 2. Vault P&L per Arcade Market Template

| Template | Sessions | Mean Vault P&L | Median | 5th pct | 95th pct | Worst loss | Best win |
|---|---|---|---|---|---|---|---|
| WRNG100 | 10,000 | $493.51 | $679.99 | $-195.46 | $1,044.44 | $-198.74 | $1,506.63 |
| WRNG1000 | 10,000 | $335.91 | $540.60 | $-196.17 | $1,019.31 | $-198.54 | $1,354.17 |
| WRNG25 | 10,000 | $489.19 | $673.55 | $-194.99 | $1,043.48 | $-198.43 | $1,415.85 |

## 3. Closed-form vs Realized Touch Rate

Validates `P_touch = 2·Φ(−|δ|/(σ·√T))` from §3 of `docs/design/v2/14_ride_economics.md`.

| Template | Closed-form P_touch | Realized touch rate | Δ |
|---|---|---|---|
| WRNG100 | 30.743% | 29.580% | -1.163% |
| WRNG1000 | 47.049% | 45.610% | -1.439% |
| WRNG25 | 31.534% | 29.680% | -1.854% |

## 4. Per-Trader-Profile Vault P&L

Positive = vault wins on that profile. Negative = profile is bleeding the vault.

| Profile | Vault P&L (sum) |
|---|---|
| spammer | $5,155,359.17 |
| barrier_hugger | $4,840,913.63 |
| cashout_when_ahead | $2,223,225.06 |
| naive_degen | $969,555.90 |

## 5. Settlement-Kind Distribution

| Kind | % of total |
|---|---|
| ride_expired_loss | 56.79% |
| ride_touch_win | 28.96% |
| market_expired | 9.27% |
| market_hit | 4.98% |

## 6. Fee Distribution

- **Count of winning redemptions with non-zero fee:** 236,116
- **Mean fee (per winning position):** $0.28
- **Median:** $0.00
- **95th percentile:** $1.36
- **99th percentile:** $2.41
- **Max:** $6.51

Fees stay bounded by the asymmetric impact fee formula (max ≈ 4.5% of profit per INV from `02_asymmetric_impact_fee_v2.md` §5.1).

## 7. Findings & Recommendations

- **WRNG100**: 5th-percentile vault P&L is $-195.46 (>50% of seed treasury). Tail risk warrants a smaller per-market `max_concurrent_escrow` cap (§7 of 14_ride_economics).
- **WRNG1000**: 5th-percentile vault P&L is $-196.17 (>50% of seed treasury). Tail risk warrants a smaller per-market `max_concurrent_escrow` cap (§7 of 14_ride_economics).
- **WRNG25**: 5th-percentile vault P&L is $-194.99 (>50% of seed treasury). Tail risk warrants a smaller per-market `max_concurrent_escrow` cap (§7 of 14_ride_economics).

### Critical structural finding: shared multiplier on both sides

For a market with shared `payout_multiplier_bps = M` (as today in `market::open`), vault edge per dollar against a random-side opener is **exactly `1 - M`**, *independent of P_touch*:

```
E[vault PnL / $] = 0.5·(1 − P_touch · M) + 0.5·(1 − (1−P_touch) · M)
                 = 1 − M · (P_touch + 1 − P_touch)
                 = 1 − M
```

Any `M > 1` is structurally negative for the vault when both sides can be opened. The §6 multipliers (1.8x, 2.0x, 2.5x) implicitly assume an opener can ONLY buy the low-probability touch side; the live `market::open` accepts either side at the same multiplier. Two paths forward:

1. **Move-level fix**: gate `market::open` to TOUCH side only on arcade markets   (the prediction-market UX intent). No_touch positions can only be created indirectly   by the vault as the counterparty. This preserves the §6 fun-money multipliers.
2. **Parameter fix**: drop shared multiplier to ≤ 1.1x (INV-17 floor). Vault edge   per random-side dollar = 1 − 1.1 = −0.10, but the impact fee on profit + cashout   spread + ride-stake-rate accrual recover this. Validated below in §9.

## 8. Gaps Beyond Move Unit Tests

The 253-test Move suite covers individual primitives. The simulator stress-tests the **composed system**: vault + impact fee + Bachelier cashout + 4-bucket router + FIFO queue. Gaps that would benefit from new Move tests (none caused conservation breaks here, but they would catch regressions early):

- A fuzz-style test that interleaves `open_position`, `pay_winner`, `crank_queue_head`,   `withdraw_for_ride_settlement`, and `accrue_via_router` in random order and asserts   `INV-1'` after every tx. Today's `foundation_tests` exercise the pieces but not the   full chaos schedule.
- A property test that for every triple `(stake, multiplier_bps, fee_bps)`,   `redeem_winner` distributes `fee_amt` such that `lp + staker + insurance + protocol ==   fee_amt` (no dust loss). The simulator confirmed this holds; a Move test would lock it.
- A path-observation freeze test: tick after `lock_and_settle` is called must be a no-op.   The simulator doesn't model the freeze (we sample the final path state at settle time),   so a dedicated Move test is the right place for this.

## 9. Recommended Safer Parameter Sets

After observing negative edge for the original WRNG25 template and 5th-percentile losses that consume the entire seed for all three templates, we re-ran with wider barriers (`barrier_pct` chosen so closed-form `z >= 1.5` → `P_touch ≤ 13%`):

| Template (safe) | vol_bps | barrier_pct | horizon | multiplier | Closed-form P_touch | Realized | Mean P&L | 5th pct |
|---|---|---|---|---|---|---|---|---|
| WRNG25-safe | 17 | 5% | 300s | 1.1x | 8.949% | 8.600% | $706.92 | $-72.98 |
| WRNG100-safe | 33 | 12% | 600s | 1.1x | 13.767% | 13.100% | $656.53 | $-83.17 |
| WRNG1000-safe | 67 | 30% | 900s | 1.1x | 13.556% | 14.500% | $645.62 | $-85.56 |

(Sample size: 1,000 sessions per template, separate seed from main run.)

These safer templates produce **positive mean vault P&L** while preserving the user-experience character of the original WRNG25 / WRNG100 / WRNG1000 markets. 5th-percentile tail loss is also materially smaller. **Recommend adopting these barrier widths in `seed-arcade-markets.sh`** — and updating the §6 table in `docs/design/v2/14_ride_economics.md` to match.

## 10. Reproducibility

```bash
python3 scripts/simulate_protocol.py --sessions 10000 --seed 42
```

---

# Segment market validation (doc 19)

**Generated:** by `scripts/simulate_segment_protocol.py` (seed = 42, rounds = 10 000).
**Scope:** the round-based shared-barrier arcade per `docs/design/v2/19_round_shared_grid_design.md`, using the integer fixed-point walk from `move/sources/seeded_path.move`. This section is the Phase B7 deliverable for doc 19.

## 11. Methodology

The simulator (`scripts/simulate_segment_protocol.py`) ports the `seeded_path::expand_segment` function to Python — every constant (`C_VR_JITTER`, `C_MOM_DECAY`, `C_FAT_PROB`, …) is lifted verbatim from the Move source, and Python `int` carries the u128 intermediates safely. Two draw modes are supported:

- **exact**: byte-identical blake2b keystream — used by the determinism self-test against the Move conformance vector.
- **fast** (default for sweeps): per-key numpy RNG. Distributional statistics for the walk (mean per-round return, per-segment vol, fat-tail incidence) match the exact path to within sampling noise. The simulator is validating *economics* (mean edge, percentiles, cap behaviour), so the fast path is appropriate. Conformance to the Move bytes is the job of `tests/seeded_path_conformance.move`, not this simulator.

Round mechanics implement doc 19 §4 directly: every round is a self-contained 75-segment slice; barriers are computed from `walk.price` at round start (±`BARRIER_OFFSET_BPS`). Opens are accepted only during the first `OPEN_WINDOW_SEGMENTS` of the round, and per-barrier cap enforcement happens at open time (reject if `aggregate_max_payout + new_max_payout > MAX_PAYOUT_PER_BARRIER`). At round end every still-open ride settles: `SETTLE_TOUCH_WIN` if the per-barrier segment-extreme scan triggers, `SETTLE_EXPIRED_LOSS` otherwise. (The simulator does **not** model voluntary cashout in this v1 sweep — every rider holds to round end, which is the worst case for the vault and the cleanest signal for the multiplier-tier calibration.)

Default parameters from doc 19 §4:

| Parameter | Value | Source |
|---|---|---|
| `ROUND_DURATION_SEGMENTS` | 75 (30 s) | doc 19 §4 |
| `OPEN_WINDOW_SEGMENTS` | 13 (≈ 5.2 s) | doc 19 §4 |
| `BARRIER_OFFSET_BPS` | 500 (±5 %) | doc 19 §4 |
| `MULTIPLIER_BPS` | 20 000 (2×) | doc 19 §4 |
| `MAX_PAYOUT_PER_BARRIER` | 10 % of seed treasury | doc 19 §4 (provisional) |
| `DEADBAND_BPS` | 20 | `RiskConfig` default |
| `DEFAULT_SEGMENT_MS` | 400 | doc 17 §10 |
| Walk constants | `seeded_path.move` | exact transcription |

The walk uses the `home_price = 1 000 USD = 1_000_000_000 µUSD` starting point with `vol_regime = 1.0`. Each scenario carries the walk state across rounds (so vol-regime clusters persist).

## 12. Results (v1 default parameters)

### 12.1 Scenario (a) — per-tier multiplier calibration

10 000 rounds × 8 uniform-opener riders per round = **80 000 rides**.

| Metric | Value |
|---|---|
| Realised P(touch) per ride | **85.79 %** |
| Mean vault edge per dollar staked | **−71.66 %** |
| Median edge per dollar | −100 % |
| Edge percentiles (5 / 95) | −100 % / +26.30 % |
| Mean vault P&L per round | −395 869 (collateral units) |
| Loss frequency (rounds where vault lost) | **86.49 %** |
| Fair-value check `1 − M × P_touch` | −71.57 % |

The realised edge tracks the closed-form `1 − M × P_touch` to within sampling noise — confirming the simulator's wager accounting is faithful and the headline number is **structural**, not a bug. **At the v1-default 2× multiplier, the vault bleeds 71 cents on every dollar staked.**

**Multiplier-tier sweep** (2 000 rounds per tier, same seeded_path walk):

| Multiplier | Realised P(touch) | Mean edge / $ | 5th-pct edge | `1 − M·P_touch` |
|---|---|---|---|---|
| 1.05× | 85.31 % | **+10.36 %** | −5 % | +10.42 % |
| 1.10× | 85.07 % | **+6.39 %** | −10 % | +6.42 % |
| 1.20× | 85.29 % | −2.41 % | −20 % | −2.34 % |
| 1.50× | 85.85 % | −28.84 % | −50 % | −28.78 % |
| 1.80× | 85.92 % | −54.72 % | −80 % | −54.65 % |
| 2.00× | 85.01 % | **−70.08 %** | −100 % | −70.03 % |
| 2.50× | 85.47 % | −113.80 % | −150 % | −113.67 % |
| 3.00× | 86.34 % | −159.11 % | −200 % | −159.03 % |
| 5.00× | 85.24 % | −326.40 % | −400 % | −326.22 % |

The only tiers with non-negative edge are **1.05× and 1.10×**. Anything above 1.15× is structurally a vault subsidy. Result: **the 2× multiplier from doc 19 §4 is not safe with the current `seeded_path` walk at ±5 % / 30 s barriers**.

### 12.2 Scenario (b) — open-window selection bot

A bot opens at the last segment of the open window (`segment_into_round = OPEN_WINDOW_SEGMENTS − 1`, i.e. ~5.2 s into the round) and picks the barrier currently closest to spot. A parallel **uniform baseline** opens at segment 0 and coin-flips the barrier. 10 000 rounds with both riders on the same walk.

| Metric | Bot | Uniform | Δ |
|---|---|---|---|
| Realised P(touch) | 96.74 % | 87.26 % | **+9.48 pp** |
| Mean edge per $ | +93.48 % | +74.52 % | — |
| **Selection advantage (bot − uniform)** | — | — | **+18.96 % per $ staked** |

Spot drift *during the 5.2 s open window* and *over the full 30 s round*:

| | Mean | p95 | p99 |
|---|---|---|---|
| Open-window drift (bps) | 471.5 | 1 184.1 | 1 602.6 |
| Round drift (bps) | 474.2 | 1 172.8 | 1 612.6 |

**This is the smoking gun.** Barriers are placed at **500 bps** from spot at round start. The walk's mean drift over the 5.2 s open window is **471.5 bps** — nearly the entire barrier offset. A bot watching the open window already sees, on average, which barrier is "near enough to touch" by the time it picks. Over 95 % of rounds the open-window drift exceeds 1 184 bps, more than 2× the barrier offset.

The conclusion is **NOT** "the open-window mechanism is broken." The mechanism is sound — a uniform opener and a late-opening bot are exposed to the same `(barrier, walk)` distribution; selection only matters when there is *information* in the open window. The conclusion is: **with the `seeded_path` walk's native vol, a 5.2 s open window is too long relative to a ±5 % barrier**. Either the barriers must be wider, the round must be longer (so a 5 s open window is a smaller fraction of total time), or the walk vol must be tuned down for the segment market.

### 12.3 Scenario (c) — per-barrier cap pile-on

Every rider opens at segment 0 with `stake_per_segment = MAX_STAKE_PER_SEGMENT`. The simulator drives both barriers to saturation each round — 134 rider intents per round, 67 of which fit under the cap on each side.

| Metric | Value |
|---|---|
| Cap (`MAX_PAYOUT_PER_BARRIER`) | 100 000 000 |
| Observed max per-barrier obligation across 2 000 rounds | 99 000 000 (99.00 % of cap) |
| Observed max **total** obligation per round | 198 000 000 (≈ 2 × cap) |
| Cap violations | **0** |
| Mean rejected opens per round | 2.0 |
| Max realised vault payout per round | 198 000 000 |
| Mean realised vault payout per round | 172 012 500 |

**The per-barrier cap behaves exactly as designed.** No round breached the cap, even under the most aggressive pile-on (max stake on every rider on both barriers). The worst-case vault liability per round is bounded by **2 × `MAX_PAYOUT_PER_BARRIER`** (one full pile per barrier), which at the provisional 10 %-of-seed cap leaves the vault still adequately collateralised against the seed treasury after one pessimistic round.

### 12.4 Joint (offset × multiplier) sweep — finding the sweet spot

§12.1's 1-D tier sweep varied `MULTIPLIER_BPS` alone at the fixed `BARRIER_OFFSET_BPS = 500` (±5 %). §13 below recommends *either* dropping multiplier to 1.10× *or* widening barriers to ±15 %, but does **not** measure the joint surface. This sub-section does — and the result is a single, defensible cell that satisfies all three game-design constraints simultaneously.

**Grid.** 5 × 5 cells: `BARRIER_OFFSET_BPS ∈ {500, 750, 1 000, 1 500, 2 000}` × `MULTIPLIER_BPS ∈ {11 000, 13 000, 15 000, 17 500, 20 000}`. **5 000 rounds × 8 uniform riders per round per cell = 40 000 rides per cell, 1 000 000 rides total.** Same `seeded_path` walk as §§12.1–12.3; same uniform-opener profile (random `segment_into_round` in `[0, OPEN_WINDOW)`, random barrier coin-flip).

**Vault edge per dollar staked** (mean across rides; positive = vault wins, negative = vault bleeds):

| ± offset \ multiplier | 1.10× | 1.30× | 1.50× | 1.75× | **2.00×** |
|---|---|---|---|---|---|
| **±5 % (500 bps)** | +5.94 % | −11.34 % | −29.19 % | −49.66 % | **−70.43 %** |
| ±7.5 % (750 bps) | +22.11 % | +8.16 % | −6.76 % | −24.51 % | −41.35 % |
| **±10 % (1 000 bps)** | +43.87 % | +34.10 % | +22.37 % | **+11.24 %** | −2.32 % |
| ±15 % (1 500 bps) | +81.04 % | +76.36 % | +73.46 % | +67.31 % | +65.67 % |
| ±20 % (2 000 bps) | +95.32 % | +94.57 % | +93.97 % | +93.26 % | +92.22 % |

**Realised P(touch)** (per ride):

| ± offset \ multiplier | 1.10× | 1.30× | 1.50× | 1.75× | 2.00× |
|---|---|---|---|---|---|
| ±5 % | 85.48 % | 85.60 % | 86.08 % | 85.47 % | 85.17 % |
| ±7.5 % | 70.77 % | 70.61 % | 71.13 % | 71.10 % | 70.62 % |
| **±10 %** | 50.99 % | 50.64 % | 51.74 % | **50.67 %** | 51.11 % |
| ±15 % | 17.22 % | 18.17 % | 17.69 % | 18.66 % | 17.15 % |
| ±20 % | 4.25 % | 4.18 % | 4.02 % | 3.84 % | 3.89 % |

Note `P(touch)` is essentially flat across the multiplier axis for each row, as expected — the multiplier doesn't change the walk's barrier-hit physics, only the vault's payout obligation. The ±5 % and ±7.5 % rows reproduce the §12.1 finding (high touch rate → only 1.10× ish multipliers survive). The ±15 % and ±20 % rows reproduce the §9 / §13 "widen the barriers" finding (touch rate collapses → vault edge is enormous *but* the game becomes a grind: 4 % touch rate at ±20 % means a rider waits ~25 rounds (≈ 12.5 minutes) for one win).

**Mean vault payout per round** (raw collateral units, round flow size):

| ± offset \ multiplier | 1.10× | 1.30× | 1.50× | 1.75× | 2.00× |
|---|---|---|---|---|---|
| ±5 % | 519 181 | 614 855 | 713 061 | 826 638 | 941 200 |
| ±7.5 % | 430 052 | 507 069 | 589 424 | 687 204 | 780 072 |
| **±10 %** | 309 973 | 363 973 | 428 540 | **489 917** | 565 133 |
| ±15 % | 104 687 | 130 514 | 146 582 | 180 234 | 189 411 |
| ±20 % | 25 810 | 29 945 | 33 258 | 37 271 | 42 923 |

**Mean stake paid per round** (raw collateral units) — essentially constant ≈ 552 000 across the grid (8 riders × ~75 segments × 1 000 stake/segment, modulo open-window-shortened riders). This isolates the edge effect: cell-to-cell payout differences are pure multiplier × P(touch), not stake-volume artefacts.

**Sweet-spot filter.** Three constraints, all must hold:

1. **vault edge ∈ [5 %, 15 %]** — defensible house edge (Polymarket-ish), but not extractive enough to drive users away.
2. **multiplier ≥ 1.5×** — meaningful payout feel ("Coin-flip" or "Lottery" flavour, not "Grind"). A 1.10× tier reads on the UI as "win 10 cents on the dollar" — closer to a fee than a wager.
3. **P(touch) ∈ [30 %, 65 %]** — the game has to feel alive. A 4 % hit rate ✗ (one win every 25 rounds); an 85 % hit rate ✗ (touch is automatic, the lottery is whether you cashed out in time).

**Exactly one cell satisfies all three:** **`BARRIER_OFFSET_BPS = 1 000` × `MULTIPLIER_BPS = 17 500`** — i.e., **±10 % barriers × 1.75× multiplier**:

- vault edge per dollar staked: **+11.24 %** (centre of the [5 %, 15 %] band)
- realised P(touch): **50.67 %** (centre of the [30 %, 65 %] band)
- mean vault payout per round: 489 917 collateral units (~88 % of mean stake paid, sustainable)
- fair-value check `1 − M·P_touch`: `1 − 1.75 × 0.5067 = +11.34 %` — matches realised edge to 0.10 pp, confirming the simulator's wager accounting.

**Why this cell, vs the §13 recommendation?**

§13 recommended either (1) `MULTIPLIER_BPS = 11 000` (1.10×) at the existing ±5 % barrier or (2) `BARRIER_OFFSET_BPS = 1 500` (±15 %) at the original 2×. The joint sweep shows:

- (1) `±5 % × 1.10×` produces +5.94 % edge — *just barely* in zone, but the 1.10× multiplier fails the ≥ 1.5× game-feel filter. A user betting $1 wins $0.10 net on a touch. That's the price of a snack, not a wager. The product becomes a grind.
- (2) `±15 % × 2.00×` produces +65.67 % edge — wildly **over-corrected**. The vault wins two-thirds of every dollar staked, P(touch) is 17 %, and the round is dead air ~83 % of the time. No one would play.
- **Joint sweet spot `±10 % × 1.75×`** sits in the middle of both knobs: barriers are wide enough that the walk's open-window drift (~470 bps from §12.2) is half the barrier offset (so selection edge collapses meaningfully), the multiplier preserves a "real win" feel, and P(touch) is a true coin-flip — every round feels live, half resolve on a touch, half resolve on expiry.

**Edge-of-zone neighbours** (informative for tuning under live data):

| Cell | edge | P(touch) | game feel | why excluded |
|---|---|---|---|---|
| ±10 % × 1.50× | +22.37 % | 51.74 % | OK | edge exceeds 15 % ceiling — too extractive |
| ±10 % × 2.00× | −2.32 % | 51.11 % | OK | edge negative — vault subsidises riders (~2 ¢/$) |
| ±7.5 % × 1.30× | +8.16 % | 70.61 % | weak | multiplier < 1.5× ("Coin-flip" floor) |
| ±15 % × 1.10× | +81.04 % | 17.22 % | grind | edge extractive, touch rate too low |

The asymmetry around `±10 % × 1.75×` is the punchline: moving one notch wider (±15 %) cuts P(touch) by **>3×** and moves edge well outside the band; moving one notch tighter (±5 %) does the opposite. The grid step from ±10 % to ±15 % straddles the (`seeded_path`) walk's natural ~6 % per-round stdev — once barriers cross that threshold the game changes character abruptly.

**Recommendation supersedes §13's two-knob compromise.** Ship doc 19 §4 with:

- **`BARRIER_OFFSET_BPS = 1_000`** (±10 % from spot at round start)
- **`MULTIPLIER_BPS = 17_500`** (1.75× payout on touch)
- `MAX_PAYOUT_PER_BARRIER` unchanged (10 % of seed treasury — §12.3 result intact)
- `ROUND_DURATION_SEGMENTS`, `OPEN_WINDOW_SEGMENTS` unchanged for v1 (revisit if §12.2's selection edge persists with the new barriers — the wider barriers should collapse it; re-measure under live tape).

This is a doc 19 §4 amendment: revise the v1 defaults from `BARRIER_OFFSET_BPS = 500` / `MULTIPLIER_BPS = 20_000` to `1_000` / `17_500`. The §13 fallbacks (1.10× at ±5 %, or 2× at ±15 %) remain available as conservative-edge or maximum-frequency variants if a market template wants to lean one way or the other.

## 13. Interpretation — does the data support shipping with doc 19 §4 parameters?

**Cap (c):** ship as-is. The cap is structurally sound; the 10 % provisional value is conservative.

**Multiplier (a) and open-window selection (b):** **the v1 default `MULTIPLIER_BPS = 20_000` (2×) cannot ship against the current `seeded_path` walk at ±5 % / 30 s barriers.** The walk's native realised P(touch) is ~86 %, and the closed-form vault edge `1 − M·P_touch` is decisive. The same walk drift that makes (a) unprofitable is what makes (b)'s bot strategy profitable: spot moves nearly the full barrier offset during the open window.

The simulator's tier sweep shows the **break-even multiplier is ≈ 1.17×** (`1 / 0.857`). For a **defensible ≥ 5 % house edge**, the multiplier must be ≤ **1.10×**. Three paths forward (compatible — any combination works):

1. **Drop `MULTIPLIER_BPS` to 11 000 (1.10×).** Trivial parameter change in `bootstrap_segment_market`. Yields +6.4 % vault edge per dollar staked. Cost: less leveraged payout, weaker "fun money" feel.
2. **Widen `BARRIER_OFFSET_BPS` to 1 500 (±15 %)** so the walk's per-round drift (~6 % stdev) is more than half a barrier away. This is the lever pulled in §9 above for the original arcade markets — it works, the same logic applies here.
3. **Reduce the walk's `C_VOL` constant** in `seeded_path.move` for the segment market. Most invasive: this is a shared library across the arcade and the segment market, so a separate vol parameter on `SegmentMarket` (or a separate "calmer" walk variant) would need to land first. **Out of scope for B7.**

The same recalibration *also* closes the (b) selection edge: if barriers are at 1 500 bps and the walk's open-window drift remains ~470 bps, the bot's information is a small fraction of the barrier offset — selection collapses toward the uniform baseline.

**Recommendation:** ship doc 19 as a design with `MULTIPLIER_BPS = 11_000` AND `BARRIER_OFFSET_BPS = 1_500` (or run the B7 sweep again at those parameters before locking). The 2× headline and ±5 % barriers in doc 19 §4 must be revised in a doc 19 §4 amendment before B-phase implementation builds against them.

The per-barrier cap pile-on result (c) is independent of these choices and locks in as-is.

## 14. Reproducibility (segment market)

```bash
# Full 10 000-round sweep — ~3 min on a 2024 laptop
python3 scripts/simulate_segment_protocol.py --rounds 10000 --seed 42

# JSON dump for downstream charts
python3 scripts/simulate_segment_protocol.py --rounds 10000 --seed 42 \
    --json-out /tmp/segsim.json

# Fast smoke (~30 s)
python3 scripts/simulate_segment_protocol.py --rounds 500 --seed 42

# Joint (offset × multiplier) sweep — §12.4 result (5 × 5 grid,
# 5 000 rounds/cell × 8 riders/round = 1 000 000 rides total, ~3 min)
python3 scripts/simulate_segment_protocol.py --rounds 500 \
    --joint-sweep-rounds 5000 --seed 42 --json-out /tmp/joint.json

# Skip the joint sweep entirely (only run the original (a)/(b)/(c))
python3 scripts/simulate_segment_protocol.py --rounds 10000 --seed 42 \
    --skip-joint-sweep
```

The simulator does an in-process determinism self-test against the Move walk constants on startup; any drift in the lifted constants will fail loudly before any rounds run.

