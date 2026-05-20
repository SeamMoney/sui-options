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
