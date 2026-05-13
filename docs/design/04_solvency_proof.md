# 04 — Solvency Proof: Mega-Vault + FIFO Queue Architecture

> Status: design analysis. Targets the *Martingaler-style* future architecture
> (single mega-vault facing all markets) — not the per-market vault that is
> currently in `move/sources/vault.move`. This document is a precondition for
> migrating the Move package.

---

## 0. Notation

| Symbol | Meaning |
|---|---|
| `V` | Vault balance (free collateral, one mega-vault per collateral type `C`) |
| `S` | `sideBucket`: per-market, per-side reserved balance for in-flight payouts |
| `Q` | `queueTotal`: sum of unpaid winning payouts in FIFO `Queue<Payout>` |
| `E` | Protocol equity: `E = V + S − Q` |
| `OI_t, OI_n` | Open interest (payout obligation) on TOUCH / NO_TOUCH for one market |
| `α` | `max_side_exposure_pct` — per-side cap as fraction of `V` |
| `β` | `max_single_position_pct` — per-trade cap as fraction of `V` |
| `f(d, v)` | Asymmetric impact fee, fraction of nominal payout withheld from winners |
| `d` | Decisiveness ∈ [0,1]: how lopsided the market was (1 = all on losing side) |
| `v` | Vulnerability ∈ [0,1]: `Q / V` clamped to [0,1] — how queue-stressed protocol is |
| `p` | Trader win-rate per market (modeled as 0.5 at fair odds) |
| `m` | Payout multiplier (e.g. 1.8 means a $1 winning stake returns $1.80) |
| `V/day` | Trade volume in collateral units per day |

---

## 1. Formal Model

### 1.1 Trade

A trade is a tuple `(addr, market_id, side, stake)` arriving at time `t`. On
entry:

- `stake ≤ β · V` (per-trade cap, enforced by `assert!`)
- `OI_side + m · stake ≤ α · V` (per-side cap, enforced by `assert!`)
- The full `stake` flows into the mega-vault: `V ← V + stake`
- The market's `sideBucket[side]` reservation grows by `m · stake`
- A `Position { side, stake, payout_if_win = m · stake }` is minted to `addr`

### 1.2 Market lifecycle

```
create(barrier, expiry) → trade* → settle(touched: bool) → redeem*
```

- **create**: caller seeds `seed_collateral` into `V` (no `Coin<C>` minted, no
  per-market vault — the market only carries `sideBucket` accounting and a
  pointer to the mega-vault).
- **trade**: opens positions as in §1.1. Trade window closes at `expiry_ms`.
- **settle**: oracle observation determines `touched`. The losing side's
  `sideBucket` is released back to `V` (these stakes are now protocol revenue
  modulo refunds to LP). The winning side's `sideBucket` becomes the *payout
  obligation*.
- **redeem**: each winning position pulls `payout_if_win · (1 − f(d,v))` from
  `V`. If `V` cannot cover, the unpaid remainder enters the FIFO `Queue`.

### 1.3 Stochastic process

We model the trade arrival process as a compound Poisson process with rate
`λ` trades/day, stake distribution `X` (i.i.d., bounded above by `β · V`),
and per-trade win indicator `W ∈ {0,1}` with `Pr[W=1] = p`. Markets resolve at
the end of fixed-length epochs of duration `T` (e.g. 30s for the Wick Race
chassis; 5–60 min for traditional touch markets). Within an epoch the Bernoulli
outcomes across positions are *correlated* (one oracle, one resolution) — this
is the key non-trivial structural property and drives the worst case in §3.

### 1.4 Asymmetric impact fee

For a redeeming winner, define:

```
nominal_payout  = stake × m
actual_payout   = nominal_payout × (1 − f(d, v))
where  f(d, v) = base + k_d · d + k_v · v,  clipped to [0, f_max]
```

The fee is **only** charged on wins, never on stakes. This makes the LP's edge
unconditionally positive in expectation (see §4) and creates a self-stabilizing
loop: stress (high `v`) raises the fee, refilling the vault faster.

---

## 2. Invariants

### 2.1 Per-side OI cap

```
OI_t  ≤ α · V    and    OI_n  ≤ α · V
```

Enforced at trade entry. With `α = 0.10`, no single market's TOUCH (or
NO_TOUCH) winning side can demand more than 10% of vault liquidity at
settlement.

### 2.2 Per-trade cap

```
m · stake  ≤  β · V
```

With `β = 0.005` (50 bps), a single whale trade can never demand more than
0.5% of vault liquidity in payout.

### 2.3 Payout transformation

```
actual_payout = m · stake · (1 − f(d, v))
```

with `f(d,v) ∈ [base, f_max]`, `base ≥ 0`, `f_max ≤ 0.50`.

### 2.4 Equity floor (the property to prove)

```
E_t  =  V_t + Σ_markets Σ_sides S_t  −  Q_t  ≥  E_0  −  ε
```

i.e. equity is a (super-)martingale modulo bounded loss `ε` per epoch.

---

## 3. Worst-Case Scenarios

### 3.1 The Whale

A single trader opens the maximum size on side `A` of one market and wins.

- Max stake: `stake* = (β · V) / m`. With `β = 0.005`, `m = 1.8`:
  `stake* ≈ 0.00278 · V`.
- Decisiveness `d ≈ 1` if no opposing flow exists; `f(d, v) ≈ base + k_d`.
  With `base = 50 bps`, `k_d = 200 bps`: `f ≈ 0.025`.
- Actual payout: `m · stake* · (1 − f) ≈ 1.8 · 0.00278 V · 0.975 ≈ 0.00488 V`.
- Vault drain: from `V` to `~0.995 V` (the stake itself sat in `V` so net drain
  is `0.00488 V − stake* = 0.00488 V − 0.00278 V = 0.0021 V`).
- **Queue impact**: zero. A single max-size win cannot exceed `β · V = 0.5%`,
  while we always hold ≥ that in `V`. Recovery time: instantaneous.

### 3.2 The Crowd

All traders pile onto side TOUCH of one market until the OI cap binds, then
TOUCH wins.

- Max winning OI on one market: `α · V`. With `α = 0.10`: payout obligation is
  `0.10 V`.
- Net stake collected from TOUCH side: `(α · V) / m = 0.0556 V`.
- Net stake collected from NO_TOUCH side: ≤ `α · V / m = 0.0556 V` (the
  losing-side bucket released back to `V`).
- Vault before settlement: `V + 0.0556 V + 0.0556 V = 1.111 V`.
- Decisiveness `d ≈ 1`, vulnerability `v ≈ 0`: `f ≈ base + k_d ≈ 0.025`.
- Vault after payout: `1.111 V − 0.10 V · 0.975 = 1.111 V − 0.0975 V = 1.014 V`.
- **Queue impact**: zero (vault is solvent throughout). Net protocol equity
  *grows* by ~1.4% because losing-side stakes were retained.

The OI cap saves us: even fully one-sided correlated flow on the cap-binding
market only consumes `α · (1 − base − k_d) = ~9.75%` of `V` net, while
contributing the losing side's ~5.6% of `V` back as fresh equity.

### 3.3 The Serial Winner

A single trader wins K markets in a row across different markets. We need to
check that the impact fee scales with cumulative wins, not just single-trade
decisiveness.

The fee components decompose:

- `k_d · d` — *per-trade* decisiveness, doesn't accumulate.
- `k_v · v` — *protocol-state* vulnerability, where `v = Q / V`. **This term
  accumulates across the trader's wins** because each win raises `Q` (or drains
  `V`), raising `v` for the *next* redemption — including theirs.

After K consecutive wins of size `s = β · V`:

- Per-trade vault drain: `m · s · (1 − f) − s ≈ s · (m − 1 − m · f)`.
- For `m=1.8`, `f=0.025`: per-trade drain ≈ `s · 0.755 ≈ 0.755 · β · V`.
- After 10 such wins, V dropped by ~7.5% and `v` rose roughly proportionally.

The serial-winner attack is bounded because:

1. The per-trade cap `β` re-evaluates against *current* `V`, so as `V` shrinks
   the maximum stake shrinks with it (geometric decay).
2. `k_v · v` ramps the fee upward as `Q` grows or `V` shrinks. By the time
   `v ≈ 0.5` (queue is half of vault), the fee has hit `f_max`.
3. Crucially, *other traders' losing trades* during this window keep
   refilling `V`, dampening the geometric decay. The serial winner only wins
   because they are sampling `p = 0.5` from a Bernoulli — so other traders are
   simultaneously losing.

---

## 4. Steady-State Analysis

Assume `p = 0.5` and trade volume `λ` (trades/day), each of mean stake
`E[X] = μ`. In one epoch:

- Expected stake inflow: `λ · μ`.
- Expected losing-side stake retained: `0.5 · λ · μ`.
- Expected winning-side payout (nominal): `0.5 · λ · μ · m`.
- Expected payout actually paid (after fee): `0.5 · λ · μ · m · (1 − E[f])`.
- Expected refunded stake on winning trades: already counted in `λ · μ` inflow.

Net expected change in `V` per unit time, *assuming `Q = 0` so all payouts
come from `V`*:

```
ΔV/Δt = λ · μ − 0.5 · λ · μ · m · (1 − E[f])
      = λ · μ · (1 − 0.5 · m · (1 − E[f]))
```

For solvency with positive drift we need:

```
0.5 · m · (1 − E[f])  <  1
1 − E[f]              <  2/m
E[f]                  >  1 − 2/m
```

Concrete inequality with `m = 1.8`:

```
E[f]  >  1 − 2/1.8  =  1 − 1.111  =  −0.111
```

i.e. **any non-negative fee gives positive vault drift at `m = 1.8`**, because
the multiplier itself is < 2 (so a fair-odds 0.5 win-rate is already
LP-favorable). The fee is gravy.

If `m = 2.0` (true breakeven binary):

```
E[f]  >  1 − 2/2.0  =  0
```

Need any positive fee. Our `base = 50 bps` more than suffices.

If `m = 2.5` (very generous, e.g. far-OTM touch options):

```
E[f]  >  1 − 2/2.5  =  0.20
```

Need expected fee of at least 20%. This is the regime where `f_max = 50 bps +
k_d · 1 + k_v · 0.5` should comfortably exceed 20% — which it does if
`k_d = 200 bps, k_v = 4000 bps` since `0.005 + 0.02 + 0.20 = 0.225 > 0.20`.

**Conclusion**: at `m ≤ 2.0` the protocol has positive drift purely from the
multiplier; the fee provides margin of safety. At `m > 2.0` the fee is
load-bearing and `k_v` is the dominant term.

---

## 5. Recovery Time

Suppose a stress event leaves `V = 0` and `Q = Q_0`. Trade volume `V/day`
resumes (collateral units, not vault) with mean stake `μ` and `λ` trades/day,
so `V/day = λ · μ`.

Each losing trade adds `μ` to `V`. With probability `1 − p = 0.5`, a trade
loses, so expected vault refill rate is `0.5 · λ · μ = 0.5 · V/day`.

But during recovery, the queue head pre-empts new winners — every new winning
payout is *also* routed to drain `Q` first (per the FIFO routing rule).
Effectively, every dollar that *would* have been paid to a current winner
goes instead to the queue head, while the current winner *joins the back of
the queue*. This means:

- Net queue drain rate from winning-trade routing: `0.5 · λ · μ · m · (1 − E[f])`.
- Plus: with `v` near 1, `f → f_max ≈ 0.50`, so winners only consume half their
  nominal payout, freeing the rest for queue drain.

Recovery time `T_recover`:

```
T_recover  =  Q_0  /  (0.5 · λ · μ · m · (1 − E[f]))
```

Concrete: assume daily volume `V/day = $100k`, `m = 1.8`, `E[f] = 0.10`
under stress, `Q_0 = $10k`:

```
T_recover  =  10_000  /  (0.5 · 100_000 · 1.8 · 0.9)
           =  10_000  /  81_000
           ≈  0.123 days  ≈  3 hours
```

A queue equal to 10% of daily volume drains in roughly 3 hours under steady
flow. A queue equal to one full day's volume drains in ~30 hours.

Compare with the simpler formula given in the prompt
(`Q / (V · loss_rate · 0.5)`), which omits the multiplier and the
queue-routing effect: it gives `10_000 / (100_000 · 0.5 · 0.5) = 0.4 days =
9.6 hours`. Ours is faster because every routed-to-queue payment also carries
the multiplier.

---

## 6. Parameter Recommendations

| Parameter | Symbol | Recommended | Rationale |
|---|---|---|---|
| `max_side_exposure_pct` | α | **10%** (1000 bps) | §3.2 shows fully one-sided crowd flow at 10% leaves protocol equity *up* ~1.4% per resolved market. Raising α to 20% still works but burns more of the safety margin. |
| `max_single_position_pct` | β | **0.5%** (50 bps) | §3.1 shows a max whale win drains ≤ 0.21% of `V`. Keeps any single trader's blast radius below the daily noise floor. |
| `base_impact_bps` | base | **50 bps** | Always-on minimum. Covers gas + price-update freshness costs even when `d=0, v=0`. |
| `k_d` (decisiveness) | k_d | **200 bps** | Penalizes pile-on bets. At `d=1`, fee jumps to 250 bps — non-trivial but not punishing for retail. |
| `k_v` (vulnerability) | k_v | **4000 bps** | Dominant safety term. At `v=0.5` (queue = half of vault), fee hits 2050 bps; at `v=1` it hits `f_max`. |
| `f_max` | f_max | **5000 bps (50%)** | Hard cap. A winner always gets at least half their nominal payout — important UX promise. |
| Payout multiplier | m | **1.8x cap** for native markets | §4 shows `m < 2` makes the LP edge structural. Wider markets (`m=2.5`+) only allowed for paired straddle pairs where one always wins. |
| Queue size cap | Q_max | **20% of `V`** | If hit, *halt new trade entry* until queue drains under 10%. Prevents collapse spiral. |
| OI imbalance cap | — | **3:1** | If one side's OI is 3x the other, *raise* `f` for the smaller side (it will likely win, and the structural one-sidedness signals informed flow). |

These numbers are conservative starting points. The right empirical move is to
run agent-based simulations (the existing `bots/` workspace is the obvious
substrate) sweeping over (α, β, k_v) and measuring the empirical equity-drift
distribution.

---

## 7. Failure Modes

The proof breaks under any of:

### 7.1 Extreme one-sided flow with informed traders

Our model assumes `p = 0.5`. If a coordinated group consistently bets the
correct side (`p > 0.5`) — e.g. front-running oracle updates — then
`E[ΔV/Δt] = λ · μ · (1 − p · m · (1 − E[f]))`, which can flip negative for
`p > 1 / (m · (1 − E[f]))`. With `m=1.8`, `E[f]=0.025`: critical `p ≈ 0.57`.
Any trader cohort with sustained > 57% win-rate breaks LP profitability.

**Mitigation**: oracle latency monitoring; longer minimum trade-to-settlement
window; raise `f` for trades placed in the last 5% of an epoch's life.

### 7.2 Oracle manipulation

If the oracle can be made to report a barrier-touch when none occurred, all
TOUCH winners can be paid undeservedly. The OI cap limits damage to `α · V`
per market per attack, but a multi-market coordinated attack could chain
multiple `α`'s. **Mitigation**: per-epoch global payout cap (e.g. no more than
`30% · V` paid out per epoch across all markets); oracle multi-source
confirmation; circuit breaker on price moves > N std-dev.

### 7.3 Keeper failure leaving paths un-recorded

If the keeper fails to push `mark_hit` calls, settlements stall. Markets pile
up unsettled, and the `sideBucket` reservations stay frozen — usable `V` for
new trades shrinks even though nominal `V` is unchanged. **Mitigation**:
permissionless `mark_hit` (anyone can call, with a 1 bp keeper bounty paid
from `V`); auto-pause new trades if any market is > 1 hour past expiry
unsettled.

### 7.4 Fee saturation under sustained stress

If the queue persists at `Q_max = 20% · V` for many hours, every winner is
taking a 50% haircut — terrible UX. The protocol stays solvent but loses
trader trust. **Mitigation**: emergency LP recapitalization route;
`pause_new_trades` governance flip when `Q > 15% · V` for > 4 hours.

### 7.5 Correlated multi-market flow (the underrated risk)

The OI cap is *per market*. A trader could open `α · V` on TOUCH of 50
correlated markets, all paying off if one underlying moves. The aggregate
payout obligation is `50 · α · V = 5 · V`, far exceeding solvency. **Mitigation**:
*global* OI cap per (collateral, underlying, side) of `α_global ≤ 25%`,
independent of how many markets exist on that underlying. This is critical
and not in the original problem statement — flagging it.

### 7.6 Withdrawal race during stress

Mega-vault means LPs share a balance. If a stress event triggers, LPs may
race to withdraw, draining `V` while `Q > 0`. **Mitigation**: LP withdrawals
are rate-limited and subordinated to queue-head payouts; LP shares are
"slashed" proportionally to `Q / V` at withdrawal time so first-out doesn't
externalize loss to last-out.

---

## 8. Move-Testable Invariants

Format: "After every X, Y must hold." Each is implementable as a Move
`assert!()` plus a property test in `move/tests/`.

1. **After every `open_position`**, `oi_side[market][side] ≤ α · V` and
   `m · stake ≤ β · V` and `V ≥ stake_just_added` (no underflow). Test:
   randomized open sequence; assert per-side cap never exceeded.

2. **After every `settle`**, `losing_side_bucket` is fully released back into
   `V` and `winning_side_bucket` equals `Σ payout_if_win` of winning open
   positions. Test: scenario test creating mixed positions, settling, and
   re-summing.

3. **After every `redeem_winner`**, exactly one of two outcomes holds:
   either `V` decreased by `actual_payout` and `Q` is unchanged, *or* `V` went
   to 0 and `Q` increased by `(actual_payout − V_before)`. Never both, never
   neither. Test: parameterized test driving `V` to 0 mid-redeem.

4. **After every state transition** (any public function), the global equity
   identity `E = V + Σ S − Q` is non-decreasing modulo the sum of
   `actual_payout · (1 − f)` flows and stake inflows. Property test: simulate
   1000-trade random sequences and assert `E_final ≥ E_initial − ε(N)` where
   `ε(N) = N · max_rounding_error` is the bounded discretization error.

5. **After every `redeem_winner` against a non-empty queue**, the
   queue-head `Payout` must be strictly older (lower epoch index) than any
   payout enqueued in this same call. Test: enqueue 3 payouts, drain partially,
   assert FIFO ordering by `epoch_id` field.

Bonus (catches §7.5):

6. **After every `open_position`**, `Σ_markets oi_side[market][side]` for a
   given `(underlying, side)` pair is `≤ α_global · V`. Requires a
   shared-object `GlobalOiTracker<C, Underlying>` updated on every open.

---

## 9. Summary

Under the recommended parameters (`α=10%`, `β=0.5%`, `base=50 bps`,
`k_d=200 bps`, `k_v=4000 bps`, `f_max=50%`, `m≤1.8x`), and assuming traders
win at fair odds (`p ≤ 0.5`), the mega-vault + FIFO-queue architecture
satisfies:

- Single whale wins drain ≤ 0.21% of `V`.
- Crowded one-sided wins *grow* protocol equity by ~1.4% per market.
- Expected per-trade vault drift is positive (`E[ΔV] > 0`) without relying on
  the impact fee at `m=1.8`; the fee provides a margin-of-safety buffer.
- A queue equal to 10% of daily volume drains in ~3 hours; equal to a full
  day's volume in ~30 hours.

The proof breaks if traders sustain `p > 57%` (informed flow / oracle
front-run), if oracle manipulation lets undeserved wins through, or if
correlated multi-market flow defeats the per-market OI cap. The §7.5 *global*
OI cap (per `(underlying, side)`) is the most important invariant not in the
original problem statement and should be added before mainnet.
