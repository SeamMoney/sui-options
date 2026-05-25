# 27 — Wick v4.26 Economic Model

**Status:** Live on testnet as of 2026-05-25 (package
`0x1fdf78474…`, rugged market `0x54e91530…`).
**Author:** Claude Opus 4.7 + Max Mohammadi.
**Companion sims:** `scripts/simulate_v4.27_strategies.py`,
`scripts/simulate_v4.27_vault_solvency.py`,
`scripts/simulate_v4_with_rug.py`.

---

## 1. Summary in one paragraph

Wick v4.26 is a **touch-either prediction market with a 1.5%-per-segment
rug mechanism**, calibrated for a **+3.93% house edge** on the player's
best strategy. The chart moves wildly (~5.5% std dev per 30-second
round on the on-chain seeded walk), barriers sit at ±10%, and players
hold to watch the wick. Most rounds (55%) end in a touch jackpot for
the player, but ~40% of rounds get rugged before the touch — a
"MARKET HALT" event that wipes any open position. Across six adversarial
player heuristics tested at 50k rounds each, **no strategy beats the
house** — every variant lands in a +3.93% to +11.71% house-edge band
with 95% confidence. The vault is over-capitalized: at the live 100M
TUSD seed and the per-round payout cap of 500 TUSD, the worst
plausible drawdown over 10k rounds is **<1% of seed**.

## 2. Live market parameters

| Param | Value | Why |
|---|---|---|
| `round_duration_segments` | 75 | ~30s at 400ms/segment — fast enough to hold a phone, long enough to feel decisive |
| `barrier_offset_bps` | 1000 | ±10% — wide enough to NOT touch every round at the walk's volatility |
| `multiplier_bps` | 17500 | 1.75× — feels generous to the player; calibrated against rug rate |
| `max_payout_per_round` | 500 TUSD | Caps single-round liability at 0.0005% of vault |
| `min_stake_per_segment` | 10000 | $0.01/segment (= $0.75 escrow per ride at min) |
| `max_stake_per_segment` | 150000 | $0.15/segment (= $11.25 escrow per ride at max) |
| `cashout_spread_bps` | 200 | 2% fee on remaining-segments refund — punishes panic cashouts |
| `sigma_bps_per_sqrt_sec` | 100 | 1% per √sec → ~5.48% std dev over a 30s round |
| `deadband_bps` | 20 | Anti-jitter margin on touch detection |
| **`rug_chance_bps`** | **150** | **1.5% per segment → ~40% of rounds get rugged** |

## 3. The house edge — derivation

For the player's best strategy (`hold_full` — open at segment 0, hold to
expiry or touch or rug), the per-round expected value is:

```
E[net_per_stake] = P(touch) × (multiplier - 1) + P(loss) × (-1)
```

Where `P(loss) = P(rug) + P(expire)` and these probabilities depend on
the walk + rug interaction.

At 50k rounds of seeded Monte Carlo:

| Outcome | Probability | Player payout per stake | Contribution to E[net] |
|---|---:|---:|---:|
| Touch win | 54.9% | +0.75 | +0.412 |
| Rug loss | 39.2% | -1.00 | -0.392 |
| Expire loss | 5.9% | -1.00 | -0.059 |
| **E[net]** | | | **-0.039** |

**House edge: +3.93% ± 0.76%** (95% CI bounds: +3.17% to +4.69%).

This matches the simpler MC predictor (`scripts/simulate_v4_with_rug.py`)
within statistical error. The mechanism works as designed.

## 4. Strategy robustness — no exploit found

Six player heuristics, all run on the IDENTICAL chart paths via per-(round,
segment) deterministic keys so the comparison is apples-to-apples. Results
from `scripts/simulate_v4.27_strategies.py`, 50k rounds each:

| Strategy | Touch% | Cashout% | Rug% | Expire% | House edge ± CI |
|---|---:|---:|---:|---:|---:|
| `hold_full` (best for player) | 54.9% | 0% | 39.2% | 5.9% | **+3.93% ± 0.76%** |
| `cashout_on_drawdown` | 54.9% | 0% | 39.2% | 5.9% | +3.93% ± 0.76% |
| `chase_touch` | 54.9% | 0% | 39.2% | 5.9% | +3.93% ± 0.76% |
| `cashout_on_profit` | 0.2% | 98.3% | 1.5% | 0% | +4.64% ± 0.11% |
| `early_exit_5` | 6.7% | 86.2% | 7.1% | 0% | +9.41% ± 0.29% |
| `mid_hold` | 43.7% | 24.4% | 31.9% | 0% | +11.71% ± 0.69% |

**Findings:**

1. **`hold_full` is the player's mathematical optimum.** Holding until
   touch / rug / expire captures the full +1.75× upside and avoids the
   2% cashout fee on remaining segments.
2. **Reactive strategies cost the player money** by paying the cashout
   fee on segments they didn't need to abandon. The 2% spread bleeds.
3. **`cashout_on_profit` looks worst on edge** but is the lowest-variance
   strategy — almost every round produces a small cashout-fee loss
   instead of a binary touch/no-touch swing. Risk-averse players might
   prefer it despite the slightly higher edge.
4. **No strategy in the tested family achieves negative house edge.** The
   design is robust against the obvious adversarial heuristics.

## 5. Vault solvency

The MartingalerVault<TUSD> sits at 100M TUSD on chain (publisher seed of
$100M nominal value). Each round produces a small +0.30 TUSD vault
contribution at $0.10 stake; vault grows monotonically in expectation.

Empirical results from `scripts/simulate_v4.27_vault_solvency.py`
(10,000 rounds per scenario):

| Concurrent rides | Realized edge | Max drawdown | Net growth / 10k rounds |
|---:|---:|---:|---:|
| 1 | +3.98% | -232 TUSD (0.000%) | +2,983 TUSD |
| 5 | +4.23% | -272 TUSD (0.000%) | +15,848 TUSD |
| 10 | +3.78% | -422 TUSD (0.000%) | +28,374 TUSD |
| 50 | +3.80% | -615 TUSD (0.001%) | +142,371 TUSD |

- **Per-round payout cap of 500 TUSD** bounds the worst single-round vault
  outflow at ~492 TUSD = 0.0005% of vault seed.
- **Worst observed drawdown across ALL scenarios: 615 TUSD out of 100M
  vault = 0.001% of seed.**
- **At 50 concurrent rides for 10k rounds** (= 500K ride-rounds = ~4,167
  hours of full-capacity continuous play), the vault GROWS by 142K TUSD
  on net. Monotonic uptrend in practice.
- Realized house edge across concurrency scenarios stays in the +3.78%
  to +4.23% band — matches the strategy-sweep prediction of +3.93% ± 0.76%.

**Conclusion:** the vault is effectively infinite for the testnet demo
+ early production. The 100M seed gives ~hundreds of thousands of
hours of full-capacity runway before any depletion concern.

## 6. LP yield projection

LPs depositing into the MartingalerVault earn pro-rata share of vault
P&L. At observed volumes:

| Daily ride volume | Daily vault P&L | Annualized | APY on 100M vault |
|---|---:|---:|---:|
| 100 (1 active user) | +29 TUSD | +10.5K TUSD | 0.01% |
| 10,000 (100 active users × 100/day) | +2,950 TUSD | +1.08M TUSD | 1.08% |
| 1,000,000 (active dApp scale) | +295K TUSD | +108M TUSD | 108% |

LP yield is **strictly volume-driven**. Wick has small per-ride margin
(~0.30 TUSD on $7.50 stake) compensated by short rounds (30s). At meaningful
production volume the vault is a yield-bearing asset for LPs; at hackathon
scale it's purely a backstop.

## 7. Comparison to other on-chain games

| Game | House edge | Mechanism |
|---|---:|---|
| Roulette (European, on-chain ports) | 2.7% | Single zero pocket |
| Crash games (Stake.com / Roobet style) | 1.0% - 4.0% | Random multiplier curve, cashout before crash |
| Polymarket (binary outcomes) | 0% (LMSR) + maker fee | Continuous double auction |
| **Wick v4.26** | **+3.93%** | **Touch barrier OR rug halt** |

Wick's edge is comparable to mainstream crypto crash games. The
mechanism — a rug-pull event vs a multiplier crash — is novel for the
"barrier touch" market category.

## 8. Edge cases + risks

| Risk | Mitigation |
|---|---|
| Cascade liquidation: many rides open during a single rug | Mitigated by lazy settlement — `record_segment_v4` flags the rug; rides settle on individual close calls. No per-rug gas-bomb. |
| Walk seed prediction attack | `record_segment_v4` consumes `sui::random` under the PTB-Random structural rule. Attackers can't grind seeds. The rug roll uses `keccak256(segment_key)` — derived from the random output, not predictable. |
| Vault bank-run | Bounded by per-round payout cap. Worst-case 1 round can pay 500 TUSD. Vault has 100M seed = 200K rounds of max-cap exposure before drain. |
| Concentrated whale exposure | `max_payout_per_round` and per-side aggregates cap protocol exposure regardless of single-ride stake size. |
| RugConfig dynamic field tampering | Only the operator (via `enable_rug`) can attach RugConfig. `ERugAlreadyEnabled` prevents accidental double-enable. |
| Rug fires too frequently → bad UX | 1.5% per segment is the MC-calibrated sweet spot. Higher rates trigger user frustration; lower rates erode house edge. Configurable per-market at bootstrap. |

## 9. What changes for production

This model assumes:
- Testnet TUSD (Wick-controlled). For real money, swap to USDC.
- Single-collateral markets. For multi-collateral, the vault per-collateral
  pattern (MartingalerVault<C>) generalizes.
- Single rug rate per market. Production might tune rug rate per-market
  based on observed touch rate and target house edge.
- LP yield: the WICK fair-launch token would distribute a share of vault
  P&L to LP token holders — separate spec (doc 03).
- Sponsored cranking (doc 22) so users don't pay gas — currently user's
  session wallet pays during their ride. Sponsored gas would shift gas
  cost to a protocol-funded pool.

## 10. Open questions for further modeling

- **Adversarial LP strategies**: can an LP profit by depositing before
  a known-rug round and withdrawing after? (No — LP shares track vault
  treasury, not per-round P&L.)
- **MEV / front-running**: can a sequencer front-run a rug to dump rides
  they pre-opened? Sui has no public mempool so this is bounded, but
  worth modeling against worst-case Sui RPC behavior.
- **Long-tail player behavior**: are there strategies based on chart
  pattern recognition (the pattern FSM in `move/sources/seeded_path.move`)
  that could exploit the deterministic walk? Worth running a sim with
  pattern-aware cashout rules.
- **Cross-market correlation**: multiple markets on the same underlying
  share the same walk seed across the cranker. Risk of correlated
  payouts. Not currently a concern (only one TUSD market) but worth
  modeling before launching a second.
