# 04 v2 — Solvency Proof, Hardened: Probability-Weighted OI, Time-Averaged Vault, Correlation Buckets, Isolated Tournaments, Wind-Down

> Status: design analysis, v2. Supersedes
> `docs/design/04_solvency_proof.md` for caps, denominators, tournament
> isolation, and wind-down. The lifecycle, fee algebra, and steady-state
> drift derivations from v1 carry over and are restated here only where
> the new caps reshape them.
>
> This document is **self-contained**. v1 is included as historical
> commentary; v2 is what Move enforces.
>
> Anchors:
> - v1: `docs/design/04_solvency_proof.md`
> - PTB attack inventory: `docs/redteam/05_cross_market_ptb.md` (12 attacks)
> - Economic / governance attack inventory: `docs/redteam/10_economic_governance.md` (14 attacks)

---

## 0. What changed and why

v1 produced one headline mitigation: a global per-`(underlying, side)` OI
cap of `α_global = 25%`. Two subsequent red-team passes showed that cap is
necessary but not sufficient. Specifically:

| v1 assumption | Falsified by | v2 fix |
|---|---|---|
| All TOUCH legs on one underlying are fungible against the cap | `05` Attack 1 (barrier stacking, OTM camouflage) | **Probability-weighted OI**: cap counts `Σ p_i × payout_i`, not `Σ payout_i` |
| Per-underlying caps suffice | `05` Attack 2 (cross-underlying correlation under macro shock) | **Correlation-bucket cap** with explicit ρ matrix |
| `V` is the spot vault balance | `05` Attack 7 (vault inflation via flash-LP, donate, abandon-position) | **Time-averaged `V_eff`**: 1-hour EWMA used in cap denominators |
| Settlement order is incidental | `05` Attack 5 (settlement cascade sequencing) | **Deterministic settle ordering** by `market_id` within a block |
| Tournament markets share the main vault | `05` Attack 12, `10` Attack 13 (Queue-of-Doom from correlated tournament flow) | **Isolated tournament vaults** (`TournamentVault<C, T>`) |
| Queue eventually drains | `10` Attack 13 (queue calcifies under reputational cascade) | **Hard queue cap** + **orderly wind-down clause** |

Two new mechanisms — the **hard queue cap** and the **wind-down clause** —
exist as explicit backstops. The hard cap denies new opens at `Q/V > 0.5`
(painful UX, but bounded loss). The wind-down clause is the legal /
mechanical answer to "what happens if `Q` exceeds 30 days of EWMA
volume" — a controlled close, not a calcified queue.

Concretely: this is the spec the Move package targets. v1's parameter
recommendations remain inside the new envelope; v2 adds enforcement and
new caps without weakening any v1 invariant.

---

## 1. Notation (delta from v1)

| Symbol | Meaning |
|---|---|
| `V_t` | Spot vault balance at time `t` (per-collateral) |
| `V_eff` | **Time-averaged effective vault**: 1-hour EWMA of `V_t`, decay constant `τ = 3600s`. This is the **denominator of every cap**. |
| `S_{m,s}` | Per-market, per-side reserved balance for in-flight payouts (a.k.a. `sideBucket[m][s]`) |
| `Q` | `queueTotal`: sum of unpaid winning payouts in FIFO queue |
| `E` | Protocol equity: `E = V + Σ S − Q` |
| `OI_{m,s}` | Open interest (payout obligation) on market `m`, side `s` |
| `p_{m,s}` | Current model-implied probability of side `s` paying out for market `m`. For TOUCH: `p = touch_probability(distance_in_σ, time_remaining)`. For NO_TOUCH: `1 − p_touch`. Floored at `p_min = 0.05`. |
| `WOI_{u,s}` | **Probability-weighted OI** for `(underlying, side)`: `Σ_{m∈u} p_{m,s} · OI_{m,s}` |
| `BWOI_{b,s}` | **Bucket-weighted OI** for `(correlation bucket, side)`: `Σ_{u∈b} ρ_{u,b} · WOI_{u,s}`, where `ρ_{u,b}` is the underlying's loading on the bucket |
| `α` | Per-market per-side OI cap: `α = 0.10` |
| `α_global` | Per-(collateral, underlying, side) probability-weighted cap: `α_global = 0.25` |
| `α_corr` | Per-(collateral, correlation-bucket, side) cap: `α_corr = 0.40` |
| `α_addr` | Per-(address, underlying, side) sub-cap: `α_addr = 0.05` |
| `β` | Per-trade cap: `β = 0.005` (50 bps) |
| `Q_max_open` | Hard cap on `Q/V_eff` for accepting new opens: `0.50` |
| `Q_winddown` | Threshold triggering wind-down: `Q / V_eff > daily_volume_ewma × 30 / V_eff` (see §7) |
| `f(d, v)` | Asymmetric impact fee, unchanged from v1 |

The denominator change (`V` → `V_eff`) is the single most important
mechanical change in the document. Every cap inequality below uses
`V_eff`.

---

## 2. Updated formal model

### 2.1 Probability-weighted OI cap (replaces v1 §7.5)

Per `(collateral C, underlying u, side s)`, enforce at every `open_position`:

```
WOI_{u,s} + p_{m,s} · m · stake  ≤  α_global · V_eff
```

where `p_{m,s}` is the current touch (or no-touch) probability for the
market being opened, evaluated as of `clock.now() − Δ_freshness` (see
§2.3).

Why this defeats `05` Attack 1: a 5-leg ladder at $70k / $75k / $80k /
$120k / $200k / $500k strikes against a $65k spot has `p` ≈ `[0.42, 0.28,
0.18, 0.04, 0.005, 0.0001]`. The total nominal payout obligation can be
enormous, but its probability-weighted contribution is `~0.92 ·
single_leg`. The cap binds on *risk-adjusted exposure*, not on the cheap
optionality the attacker is stacking.

The per-market cap (`α`) and per-trade cap (`β`) remain unchanged from
v1. Probability weighting layers *on top of* per-market and per-trade
caps; it does not relax them.

### 2.2 Per-address sub-cap (defends `05` Attack 1's PTB monopolization)

Per `(address a, collateral C, underlying u, side s)`, enforce:

```
Σ_{m∈u} p_{m,s} · OI_{m,s,a}  ≤  α_addr · V_eff
```

where `OI_{m,s,a}` is address `a`'s share of `OI_{m,s}` (tracked as the
sum of `payout_if_win` of `Position` objects owned by `a`, indexed
on-chain).

With `α_addr = 5%` and `α_global = 25%`, no single address can monopolize
more than 1/5 of the global headroom on any (underlying, side). The PTB
"lock the cap to deny competitors" attack now requires Sybiling across
≥5 addresses, each of which is independently rate-limited.

### 2.3 Cross-underlying correlation buckets

Underlyings are partitioned into **correlation buckets** with explicit
loadings `ρ_{u,b} ∈ [0,1]`. The bucket cap aggregates probability-
weighted OI across the bucket:

```
BWOI_{b,s} = Σ_{u∈b} ρ_{u,b} · WOI_{u,s}
BWOI_{b,s}  ≤  α_corr · V_eff
```

Initial bucket structure (revisited in §10):

| Bucket | Members | `ρ_{u,b}` |
|---|---|---|
| `crypto_majors` | BTC, ETH | 1.0, 1.0 |
| `crypto_alts` | SUI, SOL, APT (when listed) | 0.7 each (loading on `crypto_majors`) |
| `equities` | SP500, NASDAQ | 1.0, 0.85 |
| `cross_macro` | All of `crypto_majors` ∪ `equities` | 0.4 each (during macro events; see §10 for the regime-detection trigger) |
| `synthetic` | RWALK-25, RWALK-100 | uncorrelated, ρ = 0 with everything |

The correlation matrix is intentionally *simple* and *conservative* —
not data-derived to four decimals. Two reasons:

1. **Adversarial robustness over forecast accuracy.** A static `ρ = 0.7`
   between SUI and BTC is wrong about half the time and right enough on
   tail days. Tail days are the only ones the cap exists to defend.
2. **Move-encodable.** A constant matrix lives in a `Bag<Bucket,
   BucketParams>` shared object updated by `AdminCap` with a 24h
   timelock and bounded changes (`ρ` can change by ≤ `0.1` per
   adjustment). The matrix is auditable from a block explorer.

**During regime detection** (e.g. realized 5-min σ on BTC > 4× its
30-day mean), the system promotes underlyings into `cross_macro`
temporarily for 24h. This is the on-chain equivalent of "macro shock —
treat all risk as one".

### 2.4 Time-averaged `V` (defeats `05` Attack 7)

`V_eff` is computed as a 1-hour EWMA:

```
V_eff_{t}  =  (1 − Δt/τ) · V_eff_{t−Δt}  +  (Δt/τ) · V_t
where τ = 3600 seconds, Δt is seconds since last update.
```

Updates are lazy: `V_eff` is recomputed at the top of every `open_*`
and `redeem_*` against the current clock. Stored as `EwmaVault` field
on `MartingalerVault<C>` with `(V_eff, last_update_ms)`.

Caps use `V_eff`, **not** `V`. Implications:

- A flash-LP injecting $1M and withdrawing in the next block does not
  move `V_eff` materially (one block ≈ 0.0007 of one hour, so injection
  raises `V_eff` by `~0.07%` of injection amount).
- Donations through a backdoor `donate` function are similarly defanged.
- Open-and-abandon position cycling does not work: stake retained in `V`
  as a side-bucket reservation does count, but only over the EWMA
  window — and the side bucket is held until settlement, so the cycling
  attacker cannot also hold it inside the same PTB.
- LP withdrawals also propagate slowly into `V_eff`. This *intentionally*
  makes withdrawal-race exits less able to shrink other positions' caps
  mid-stress — fairness goes both ways.

The trade-off: legitimate LP top-ups during a stress event take ~30
minutes to fully count toward cap headroom. We accept this. The stress-
recovery posture is to hold positions stable, not to grow them quickly.

### 2.5 Isolated tournament vaults

Tournament markets do **not** back to `MartingalerVault<C>`. Each
tournament `T` instantiates its own `TournamentVault<C, T>` shared
object, seeded entirely from:

1. The tournament `pot` (entry fees),
2. Optional sponsor seed,
3. **Nothing else.**

`TournamentVault<C, T>` enforces caps `α_t = 25%`, `β_t = 1%` — its own
isolated parameter set, scaled to the tournament size. If a tournament's
vault is exhausted, **the tournament's** queue grows; the main vault is
untouched. Tournament queue can wind down independently of, and without
infecting, the main protocol.

This kills both `05` Attack 12 (double-dip via main-vault-backed
tournament markets) and `10` Attack 13 (Queue-of-Doom seeded from
correlated tournament flow).

The Move type signature is the enforcement: `Market<C>` carries its
parent vault as a typed reference, and tournament markets are
constructed only via `tournament::spawn_market` which threads the
`TournamentVault<C, T>` instead of the main vault. There is no path in
the Move source where a tournament market draws from `MartingalerVault`.

### 2.6 Deterministic settlement ordering

Within a single Sui block, when multiple markets settle:

```
Order settlement processing by ascending `market_id` (the address of the
Market<C> shared object), regardless of transaction order in the block.
```

This is enforced by requiring `settle_market_*` to take a `SettleBatch`
shared object that accumulates pending settlements during the block and
processes them in order at the *end* of the block (via
`sui::framework::checkpoint`-style end-of-block hook — concretely
implemented as a deferred-PTB queue that the keeper drains with the
correct ordering, gated by an on-chain `BlockSettleCommit` invariant
check).

This kills `05` Attack 5's permutation freedom: an attacker can no
longer reorder lock/settle calls to make their winning position pay
from `S` while others enqueue.

---

## 3. State invariants

The full set; new in v2 marked with `(v2)`.

1. **Per-side OI cap** (v1):
   `OI_{m,s} ≤ α · V_eff` for every `(m, s)`.

2. **Per-trade cap** (v1):
   `m · stake ≤ β · V_eff`.

3. **Probability-weighted global OI cap** (v2):
   `WOI_{u,s} ≤ α_global · V_eff` for every `(u, s)`.

4. **Per-address sub-cap** (v2):
   `Σ_m p_{m,s} · OI_{m,s,a} ≤ α_addr · V_eff` for every `(a, u, s)`.

5. **Correlation-bucket cap** (v2):
   `BWOI_{b,s} ≤ α_corr · V_eff` for every `(b, s)`.

6. **Equity floor** (v1): `E_t = V + Σ S − Q ≥ E_0 − ε(t)` modulo
   bounded discretization error.

7. **Tournament isolation** (v2): `treasury(MartingalerVault<C>) ∩
   {payouts to tournament market positions} = ∅`. No code path debits
   `MartingalerVault<C>` for a position created against a
   `TournamentVault<C, T>`.

8. **Hard queue cap on opens** (v2):
   `Q / V_eff ≤ Q_max_open = 0.5` is required for any `open_position`
   to succeed. If exceeded, opens revert with `EQueueExceedsHardCap`.

9. **Wind-down monotonicity** (v2): once
   `Q > daily_volume_ewma × 30` is observed and the wind-down flag is
   set, the protocol enters `WIND_DOWN` mode irrevocably; opens are
   forbidden, only closes/redeems run.

10. **Deterministic settle ordering** (v2): for any block containing
    multiple `settle_market_*` calls, the order of state mutation is
    `sort_ascending(market_id)`, independent of tx order.

11. **`V_eff` is a true EWMA** (v2): `V_eff_{t+Δt} − V_eff_{t}` has
    sign `sign(V_t − V_eff_t)` and `|V_eff_{t+Δt} − V_eff_t| ≤ |V_t −
    V_eff_t| · (Δt / τ)`. (Equivalent: caps cannot be moved by more
    than `Δt/τ` of their target shift in one block.)

12. **`α_global` ≥ `α`** and **`α_corr` ≥ `α_global`** by construction
    (parameter monotonicity check at admin update time).

---

## 4. Worst-case scenarios revisited

All numbers below assume `V_eff = $1,000,000` USDC, `m = 1.8x`,
`base = 50 bps`, `k_d = 200 bps`, `k_v = 4000 bps`, `f_max = 50%`. New
caps: `α_global = 25%` (probability-weighted), `α_corr = 40%`,
`α_addr = 5%`.

### 4.1 The Whale (revisited)

A single whale opens the maximum size on side TOUCH of one market.

- Per-trade cap binds first: `stake* = β · V_eff / m ≈ $2,778`.
- Per-address sub-cap is much larger (`α_addr · V_eff = $50k` of
  weighted OI), so binds only after many whale opens accumulated.
- Per-market `α` cap: $100k payout — also non-binding for one whale.

Single whale max win drain (after fee): `≤ 0.21% · V_eff = $2,100`.
Identical to v1; the additional caps don't tighten this case.

### 4.2 The Crowd (revisited under probability weighting)

Crowd piles onto TOUCH of one market with a barrier where `p = 0.5`
(at-the-money). Probability-weighted contribution of the market to
`WOI_u_TOUCH` is `0.5 · OI_TOUCH`. The global cap binds when:

```
0.5 · OI_TOUCH  =  α_global · V_eff  =  $250k
→  OI_TOUCH  =  $500k  (= 50% of V_eff in nominal)
```

But the per-market cap `α = 10%` binds first: `OI_TOUCH ≤ $100k`.
Probability-weighted contribution `= 0.5 · $100k = $50k`. The global
cap allows up to `$250k` of weighted OI — so 5 such markets can fill in
parallel before the global cap binds. (All on the same underlying.)

Aggregate exposure across 5 ATM TOUCH markets:
- Total nominal payout obligation: `5 · $100k = $500k` (50% of vault).
- Net stake collected (TOUCH side): `5 · $100k / m = $278k`.
- Net stake collected (NO_TOUCH side, organic): assume parity ≈ $278k.
- Vault before settlement: `V + $556k = $1.556M`.
- One macro tick triggers all 5 (correlated → outside protection of
  per-market `α`).
- Vault after payout: `$1.556M − $500k · (1 − f) ≈ $1.556M − $475k =
  $1.081M`.

**Crowd outcome**: vault gains ~$81k (8% growth) on a fully one-sided
correlated macro hit across 5 ATM TOUCH markets. The same exposure
pattern that killed the v1 spec (Attack 2) now finishes solvent because
the cap denies the 6th market open.

What if the crowd opens 5 ATM TOUCH markets on BTC + 5 on ETH + 5 on
SUI + 5 on SP500? Correlation-bucket cap binds:

```
BWOI_{cross_macro, TOUCH}  =  Σ ρ · WOI
                           =  1.0 · $250k_{BTC}  + 1.0 · $250k_{ETH}
                            + 0.7 · $250k_{SUI} + 1.0 · $250k_{SP500}
                           =  $925k
```

`α_corr · V_eff = $400k`. The third market in the bucket cannot open;
the fourth cannot exist. Crowd exposure across the macro bucket is hard-
capped at `$400k` of weighted OI. Worst-case payout: still well below
vault size, equity stays positive.

### 4.3 The Serial Winner (revisited)

A single whale wins K markets in a row across uncorrelated underlyings.
v1 already showed this is bounded by:
- Per-trade cap re-evaluating against current `V` (geometric decay),
- `k_v · v` ramping the fee toward `f_max`,
- Other traders' losing flow refilling `V`.

v2 changes: per-trade cap re-evaluates against `V_eff`, which by
construction *lags* `V` downward. The winner's cap shrinks more slowly
than the vault drains, modestly *worsening* the per-event drain rate
during a serial-winner streak.

But: the per-address sub-cap `α_addr` now binds *across* their wins on a
single underlying. After roughly 18 max-size wins on one underlying
(`α_addr = 5%` worth of weighted OI), they cannot open *any* new TOUCH
position on that underlying until they redeem and free OI. Forces
diversification across underlyings, which the correlation bucket then
caps. Net effect: serial winner's blast radius is `(α_addr · V_eff) ·
(number of buckets) ≈ 5% · 4 = 20%` of `V_eff` cumulative across all
wins in the worst case, not unbounded.

---

## 5. Steady-state analysis

The v1 result — `E[ΔV/Δt] = λμ · (1 − 0.5 m (1 − E[f])) > 0` for
`m ≤ 2.0` and any `E[f] > 0` — is unchanged. The new caps tighten
exposure during stress; they do not change baseline drift.

Two new stress regimes need explicit drain analysis:

### 5.1 Drain at the hard queue cap

If `Q / V_eff` rises to `Q_max_open = 0.5` and new opens halt, drain
relies on existing winning-side redemptions and on losing-side stakes
that are already in `S` from open-but-unsettled markets.

Drain rate while halted:
- Existing in-flight markets continue to settle. Their losing-side
  stakes flow to `V` at rate `0.5 · λ_existing · μ`.
- Their winning-side payouts are routed FIFO to the queue head (per
  the v1 routing rule) at rate `0.5 · λ_existing · μ · m · (1 − f_max)`
  ≈ `0.5 · λ_existing · μ · 0.9` (with `f_max` saturating).

Total queue-drain rate while opens are halted:
```
drain_rate  ≈  0.5 · λ_existing · μ · m · (1 − f_max)
            =  0.45 · λ_existing · μ
```

Time to drain queue from `Q = 0.5 · V_eff` back to `Q ≤ 0.1 · V_eff`
(the threshold to re-enable opens):
```
T_unblock  =  (0.4 · V_eff) / (0.45 · λ_existing · μ)
```

With `V_eff = $1M` and pre-halt daily volume `λμ = $100k`, assume
`λ_existing` is roughly the in-flight-at-halt subset ≈ 20% of nominal
flow ≈ `$20k / day`. Then `T_unblock ≈ $400k / ($9k/day) ≈ 44 days`.
That's **bad** — a 44-day halt is effectively a bankruptcy under any
realistic UX standard.

**Conclusion**: the hard cap is a *backstop*, not a normal operating
mode. Reaching it implies one of:
1. A correlated multi-underlying stress event (which the new caps
   should already prevent).
2. A coordinated attack on `V_eff` (defended by EWMA).
3. A sustained insolvency drift (which would already have triggered
   wind-down per §7).

If `Q_max_open` ever binds in production, `WIND_DOWN` will follow
shortly thereafter. The hard cap exists to prevent the queue from
growing during the gap between insolvency-detected and wind-down-
activated.

### 5.2 Drain in normal stress (queue between 10% and 30% of V_eff)

This is the regime v1 §5 analyzed; the v2 numbers are unchanged.
`T_recover ≈ Q / (0.5 · λμ · m · (1 − E[f]))`. With `Q = $200k`,
`λμ = $100k`, `E[f] = 0.10`: `T_recover ≈ 4.4 days`.

The new caps mean we should reach this regime less often, not that we
recover faster.

---

## 6. Recovery time, with isolated tournament vaults

The v1 recovery analysis assumed any stress event drove vault
recovery via daily volume. v2 changes the picture in two important
ways:

### 6.1 Tournament-induced stress is contained

A tournament that blows its vault produces a bounded queue *inside*
the tournament's `TournamentVault`. The main vault's recovery
trajectory is unchanged. This is the structural fix to `10` Attack 13:
the Queue-of-Doom can still happen *inside* a tournament (we cannot
prevent random walks from wicking five barriers), but it cannot infect
the main solvency model.

When a tournament vault is exhausted with positive queue:
- Tournament's `TournamentVault` enters wind-down (§7).
- Tournament prize curve pays out in proportion to *realized* queue
  drain — no double-dip from main vault.
- Tournament terminates and its remaining state is closed.
- Main vault unaffected.

Recovery time for a tournament vault is its own concern; the
tournament's "lifetime" is bounded (days, not weeks), so there is no
"chronic queue" failure mode for tournaments.

### 6.2 Main-vault recovery formula (unchanged shape, redenominated)

```
T_recover  =  Q  /  (0.5 · λ_main · μ_main · m · (1 − E[f]))
```

where `λ_main · μ_main` is **non-tournament** daily volume. Since
tournament volume can no longer drain through the main vault, this is
a *cleaner* (and possibly lower) volume number than v1 used. We
explicitly recommend tracking `daily_volume_ewma` only over
non-tournament markets to use as the wind-down trigger denominator.

For typical post-launch conditions with `λμ_main = $100k` and `Q =
$50k` (5% of vault): `T_recover ≈ 1.4 days`. Unchanged from v1's
prediction; the relevant difference is that the v1 spec
underestimated `Q_initial` because tournament events could blow it
much higher.

---

## 7. Orderly wind-down spec

The wind-down is the protocol's honest answer to the impossible
question raised by `10` Attack 13: *what happens if the queue exceeds
plausible drain horizon?*

### 7.1 Triggers (any of)

```
Trigger A — Queue-vs-volume:  Q  >  daily_volume_ewma · 30
Trigger B — Equity floor:     E  <  −0.10 · V_eff_initial   (10% loss)
Trigger C — Hard cap stuck:   Q / V_eff > Q_max_open  for > 24 hours
Trigger D — Admin (timelocked): explicit admin call, 48h timelock,
                                 7-day public notice
```

`daily_volume_ewma` is itself a 7-day EWMA computed lazily on every
open / settle and persisted on `MartingalerVault<C>`.

Trigger A is the load-bearing one: if the queue would take >30 days to
drain at current volume, recovery is implausible (per the §10 Attack
13 reputational-cascade reasoning — volume will *fall* during the
queue's life, not stay constant). Trigger A makes the protocol
acknowledge insolvency *before* trader trust collapses.

### 7.2 Activation (Move pseudocode)

```move
public(package) fun check_winddown_triggers<C>(
    vault: &mut MartingalerVault<C>,
    clock: &Clock,
) {
    let now = clock.timestamp_ms();
    update_ewma_vault(vault, now);
    update_ewma_volume(vault, now);

    if (vault.status == STATUS_WINDDOWN) return;

    let v_eff = vault.v_eff;
    let q = vault.queue_total;
    let dv_ewma = vault.daily_volume_ewma;
    let e = (vault.balance.value() + vault.side_bucket_total) - q;

    let trigger_a = q > dv_ewma * 30;
    let trigger_b = e < -((v_eff_initial(vault) / 10) as i128);
    let trigger_c = (q * 100 > v_eff * (Q_MAX_OPEN_BPS as u64))
                    && (now - vault.hardcap_first_breach_ms > 24 * 3600 * 1000);

    if (trigger_a || trigger_b || trigger_c) {
        vault.status = STATUS_WINDDOWN;
        vault.winddown_started_ms = now;
        vault.winddown_v_snapshot = vault.balance.value();
        vault.winddown_queue_snapshot = q;
        vault.winddown_side_bucket_snapshot = vault.side_bucket_total;
        event::emit(WindDownActivated { vault_id: object::id(vault),
                                         trigger: which_trigger(...),
                                         v_snapshot: vault.winddown_v_snapshot,
                                         queue_snapshot: vault.winddown_queue_snapshot,
                                         expected_payout_ratio_bps: ... });
    };
}
```

After activation:

```move
// All open paths revert
public fun open_position<C>(...) {
    assert!(vault.status != STATUS_WINDDOWN, EProtocolWindingDown);
    ...
}

// Settle still runs (so unsettled markets resolve)
public fun settle_market_touch<C>(...) {
    assert!(vault.status != STATUS_PAUSED, EPaused);
    // Wind-down does NOT block settle — markets must resolve to know payouts
    ...
}

// Redeem returns pro-rata payout from §7.3
public fun redeem_winner_winddown<C>(
    vault: &mut MartingalerVault<C>,
    position: Position,
    ...
): Coin<C> { ... }
```

### 7.3 Pro-rata payout math

At the moment of wind-down activation, the protocol computes the
**expected payout ratio**:

```
payable_assets  =  V_snapshot + Σ S_snapshot
total_obligations  =  Q_snapshot + Σ winning_side_payouts_at_settlement
expected_payout_ratio  =  min(1.0, payable_assets / total_obligations)
```

For positions whose markets have already settled and are in the queue:
they receive `min(payout, payout · expected_payout_ratio)` of their
nominal `payout_if_win`. For positions whose markets have not yet
settled at wind-down time: they receive
`p_{m,s} · payout_if_win · expected_payout_ratio` (probability-
weighted expected value of their position).

**Rationale.** Pro-rata is the only fair scheme: it treats already-
queued winners and not-yet-settled holders symmetrically, weighted by
realized vs. expected outcomes. It is also the only scheme that does
not require declaring some traders "luckier" than others post-hoc.

Concrete example. `V_snapshot = $400k`, `Σ S = $200k`, `Q = $300k`,
unsettled winning OI (probability-weighted) = `$400k`. `payable =
$600k`, `obligations = $700k`, `ratio = 0.857`.

A position with `payout_if_win = $1000` that is already queued
receives `$857`. A position with `payout_if_win = $1000` on an
unsettled TOUCH market with `p = 0.40` receives `0.40 · $1000 · 0.857
= $343` upon redeem (no further wait — settlement still resolves but
the payout is collected at redeem time).

The ratio is *frozen* at activation. Late-arriving losers' stakes that
flow into `V` *after* activation increase the ratio for *next* wind-
down; they do not retroactively adjust this one. This kills any
incentive to "wait for more recovery before claiming" — first to claim
gets the same as last.

### 7.4 Termination

Wind-down terminates when all positions have been redeemed and
`Q = 0`. The vault then enters `STATUS_TERMINATED`; LP shares can
withdraw remaining `V` pro-rata. The protocol on this collateral is
done; users must migrate to a fresh vault (which will be deployed as a
new `MartingalerVault<C>` shared object).

### 7.5 Disclosure obligation

The wind-down clause MUST be disclosed in the README, the trade UI's
pre-trade modal, and the LP onboarding UI. Without disclosure, this
is a fraud, not a product term.

---

## 8. Hard cap on queue size (Move enforcement)

Independent of wind-down, the hard cap on opens is:

```move
const Q_MAX_OPEN_BPS: u64 = 5000;  // 50%

public fun open_position<C>(
    vault: &mut MartingalerVault<C>,
    market: &mut Market<C>,
    side: u8,
    stake_coin: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): Position {
    // ... existing checks: per-trade cap, per-market OI cap ...

    update_ewma_vault(vault, clock.timestamp_ms());

    // Hard queue cap
    let q = vault.queue_total;
    let v_eff = vault.v_eff;
    assert!(
        q * 10000 <= v_eff * (Q_MAX_OPEN_BPS as u64),
        EQueueExceedsHardCap
    );

    // Probability-weighted global OI cap
    let p = touch_probability(market, clock);
    let stake = stake_coin.value();
    let weighted_payout_add = (p * (stake as u128) * (m as u128)) / 1_000_000;
    let woi_after = vault.woi[underlying(market)][side] + weighted_payout_add;
    assert!(
        woi_after * 10000 <= (v_eff as u128) * (ALPHA_GLOBAL_BPS as u128),
        EWeightedGlobalCapExceeded
    );

    // Per-address sub-cap
    let addr_woi_after = vault.addr_woi[ctx.sender()][underlying(market)][side]
                         + weighted_payout_add;
    assert!(
        addr_woi_after * 10000 <= (v_eff as u128) * (ALPHA_ADDR_BPS as u128),
        EAddressSubCapExceeded
    );

    // Correlation-bucket cap
    let bwoi_after = compute_bwoi_after(vault, market, side, weighted_payout_add);
    assert!(
        bwoi_after * 10000 <= (v_eff as u128) * (ALPHA_CORR_BPS as u128),
        ECorrelationBucketCapExceeded
    );

    // ... mint position, update OI tables ...
}
```

Behavior at the cap:
- `EQueueExceedsHardCap` — trade reverts. UI surfaces "Protocol queue is
  full; new positions paused. Existing positions can be redeemed
  normally."
- The cap is checked again on every open, so as the queue drains opens
  resume automatically. No human intervention required.
- This **does not** halt redemptions, settles, or LP withdrawals.

### 8.1 Why 50% and not 20%

v1 §6 recommended `Q_max = 20% · V` as a halt threshold. v2 raises to
50% because:
1. The probability-weighted cap means we expect Q to grow under stress
   but tail-bounded.
2. 20% would halt opens more often than necessary; 50% is the "really
   broken" threshold.
3. The wind-down trigger A (queue > 30 days of volume) typically fires
   before `Q/V_eff = 0.5` in practice — wind-down is the *real* halt;
   the hard cap is a numerical safety net.

If Trigger A fires *first* (queue grows from low base to > 30 days at
moderate `Q/V_eff`, e.g. due to a sudden volume drop with stable Q),
wind-down activates and the 50% threshold is moot.

---

## 9. Mitigated attack table

Coverage of `docs/redteam/05_*` (cross-market PTB) and
`docs/redteam/10_*` (economic / governance):

| Attack (doc, #) | Title | v2 mitigation | Residual |
|---|---|---|---|
| 05, 1 | Synthetic Mega-Position via Barrier Stacking | §2.1 probability-weighted OI; §2.2 per-address sub-cap | OTM camouflage no longer free; 5-leg ladder requires probability-weighted headroom |
| 05, 2 | Cross-Underlying Correlation Defeats Per-Underlying Caps | §2.3 correlation buckets (`α_corr = 40%`); regime detection | Macro-shock blast radius capped at `α_corr · V_eff`; tail risk inside bucket remains |
| 05, 3 | PTB Ordering for Risk-Cap Headroom Stealing | §2.6 deterministic settle ordering; existing per-block fairness | Cap-burst surcharge from v1 §3 still recommended (orthogonal) |
| 05, 4 | Triangular Barrier Synthetic vs Risk Math | §2.1 probability weighting de-prices spread legs uniformly | Spread-aware fee surcharge from v1 still recommended for full neutralization |
| 05, 5 | Settlement Cascade Sequencing | §2.6 deterministic settle ordering by `market_id` | Eliminated within a block; cross-block ordering unaffected (intentional) |
| 05, 6 | Listing Seed Sybil Refund Farming | Out of scope for this doc; spec change in `08_gamification.md` | Unique-signer threshold required (orthogonal) |
| 05, 7 | Vault Inflation for Cap Headroom | §2.4 EWMA `V_eff` defangs flash-LP, donate, abandon-position cycling | Long-window inflation (>1h sustained capital) still moves `V_eff` — but this is no longer an "attack," it's legitimate LP |
| 05, 8 | Pre-Settlement Position Transfer to Sybil | Out of scope for solvency; spec change in `08_gamification.md` | Position transfer hold-time requirement orthogonal |
| 05, 9 | Multi-Leg Camouflage for Impact-Fee Avoidance | Partial: TWAP `d` recommended (orthogonal); probability weighting reduces incentive | Residual; needs §2.5-style fee TWAP from v1 §3 |
| 05, 10 | Oracle Tick Bundling Inside Trade PTB | Spec change in `path_observation` / `pull_oracle_driver`; `Δ_freshness` referenced in §2.1 | Min-freshness check orthogonal; this doc enforces only that `p` uses delayed oracle data |
| 05, 11 | Cross-Collateral Vault Asymmetry | §2.5 isolated tournament vaults sets the precedent; cross-collateral cap at `α_cross = 35%` recommended (per-vault config) | Each `MartingalerVault<C>` independent; cross-collateral cap is a v3 hardening |
| 05, 12 | Tournament + Main-Market Double-Dip | §2.5 isolated tournament vaults — completely eliminated | None; tournaments cannot draw from main vault by Move type signature |
| 10, 1 | LP Starvation Coalition | Out of scope; per-address dynamic fee from `10` mitigation orthogonal | Residual; v2 caps don't speak to win-rate-conditioned fees |
| 10, 2 | Whale Front-Run on Mint Curve | Out of scope; mint-curve change in `03_wick_tokenomics.md` | Orthogonal |
| 10, 3 | WICK Dividend-Pump Manipulation | Out of scope; continuous deposit fix orthogonal | Orthogonal |
| 10, 4 | Vampire Fork | Out of scope; brand / moat problem | Orthogonal |
| 10, 5 | Liquidity Flight at $20k Threshold | Out of scope; mint-curve smoothing fix in `03_*` | Orthogonal |
| 10, 6 | Cross-Protocol Arbitrage | Probability-weighted fee partially internalizes; arber profit reduced but not eliminated | Residual; accepted leak |
| 10, 7 | Tournament Prize-Sharing Cartel | Out of scope; cluster detection orthogonal | Orthogonal |
| 10, 8 | AdminCap Bribe to Lift Risk Caps | §2.3 admin updates of `ρ` are timelocked + bounded; same pattern recommended for `α`, `β` | Hard-coded bounds + multisig required (orthogonal); MUST land before mainnet |
| 10, 9 | Malicious Package Upgrade | Out of scope; UpgradeCap multisig + timelock orthogonal | MUST land before mainnet |
| 10, 10 | Insider Keeper Front-Run on CLOB | §2.6 deterministic settle ordering reduces window; `Δ_freshness` shrinks edge | Residual; orthogonal CLOB-side mitigation needed |
| 10, 11 | Insider Market-Creator with Selective Audience | Out of scope; market-creation gating orthogonal | Orthogonal |
| 10, 12 | Coordinated Stake/Dividend Squeeze | Out of scope; continuous deposit fix orthogonal | Orthogonal |
| 10, 13 | Queue-of-Doom Permanent Insolvency | §2.5 tournament isolation + §7 wind-down + §8 hard cap — fully addressed | Disclosure obligation §7.5 must be honored |
| 10, 14 | Sybil-Spawn Mint Farming | Out of scope; mint curve / cluster detection orthogonal | Orthogonal |

**Summary**: v2 directly addresses the 6 solvency-relevant attacks
(`05` 1, 2, 5, 7, 11, 12 + `10` 13). The remaining attacks are
governance, oracle, gamification, or token-economic concerns whose
fixes belong in their respective design docs but do not undermine the
solvency model.

---

## 10. Recommended parameters (v2 reference set)

| Parameter | Symbol | v1 | v2 | Notes |
|---|---|---|---|---|
| Per-market per-side cap | `α` | 10% | **10%** | Unchanged. |
| Per-trade cap | `β` | 0.5% | **0.5%** | Unchanged. |
| Probability-weighted global cap (per `(C, u, s)`) | `α_global` | 25% | **25%** | Same number, different denominator (now weighted). |
| Per-address sub-cap (per `(a, C, u, s)`) | `α_addr` | — | **5%** | New in v2. |
| Correlation-bucket cap (per `(C, b, s)`) | `α_corr` | — | **40%** | New in v2. |
| Hard queue cap on opens | `Q_max_open` | 20% (halt) | **50%** | New mode: revert opens, not protocol pause. |
| Wind-down trigger | `Q_winddown` | — | **`Q > daily_volume_ewma · 30`** | New in v2. |
| `V_eff` EWMA window | `τ` | spot | **3600 s (1h)** | New in v2. |
| Daily volume EWMA window | — | — | **7 days** | New in v2. |
| Base impact fee | `base` | 50 bps | **50 bps** | Unchanged. |
| Decisiveness coefficient | `k_d` | 200 bps | **200 bps** | Unchanged. |
| Vulnerability coefficient | `k_v` | 4000 bps | **4000 bps** | Unchanged. |
| Max impact fee | `f_max` | 50% | **50%** | Unchanged. |
| Payout multiplier | `m` | 1.8x | **1.8x** | Unchanged. |
| Probability floor for cap weighting | `p_min` | — | **5%** | Prevents OTM camouflage from going to zero weight. |
| Oracle freshness for `p` | `Δ_freshness` | — | **30s delayed** | Defends `05` Attack 10. |

### 10.1 Initial correlation matrix

| Underlying | `crypto_majors` | `crypto_alts` | `equities` | `cross_macro` | `synthetic` |
|---|---|---|---|---|---|
| BTC | 1.0 | 0.7 | 0.0 | 0.4 (in shock) / 0.0 | 0.0 |
| ETH | 1.0 | 0.7 | 0.0 | 0.4 (in shock) / 0.0 | 0.0 |
| SUI | 0.7 | 1.0 | 0.0 | 0.3 (in shock) / 0.0 | 0.0 |
| SP500 | 0.0 | 0.0 | 1.0 | 0.4 (in shock) / 0.0 | 0.0 |
| RWALK-25 | 0.0 | 0.0 | 0.0 | 0.0 | 1.0 |

`cross_macro` is *active* during regime-detection windows (BTC realized
5-min σ > 4× 30-day mean, sustained for 10 minutes). When inactive,
`α_corr` for the bucket is enforced against the active subset only.

### 10.2 Touch probability model

```
p_touch(distance_in_σ, time_remaining_s)
  =  max(p_min, 2 · Φ(−|distance_in_σ| / sqrt(time_remaining_s / σ_unit)))
where  Φ  is standard normal CDF
        σ_unit  is the underlying's daily realized vol scaled to seconds
        distance_in_σ  is (barrier − spot) / σ_per_unit_time(time_remaining)
```

This is the standard Bachelier first-passage approximation. Implemented
as a 32-entry lookup table in Move (no on-chain `Φ` computation), with
linear interpolation. `σ_unit` is updated from oracle `realized_vol_30d`
on each `update` call. `p_min = 0.05` is the floor.

For the implementation: a precomputed table of `(distance_σ, p_touch)`
keyed on quantized `distance_σ` and `time_remaining` is sufficient.
Probability accuracy of ±5% is fine — caps are conservative anyway.

---

## 11. Move-testable invariants (8)

Each is implementable as a property test in `move/tests/invariants.move`
plus an `assert!()` in the corresponding state transition. Names match
those in §3.

1. **`probability_weighted_global_cap_holds`** — After every
   `open_position`, `WOI_{u,s} = Σ_m p_{m,s} · OI_{m,s}` with `p_{m,s}`
   recomputed at test time satisfies `WOI_{u,s} ≤ α_global · V_eff`.
   Property: 1000 random opens across barriers in [0.5σ, 5σ] from
   spot, all underlyings; assert global cap.

2. **`per_address_subcap_holds`** — After every `open_position`, for
   the signer `a`, `Σ_m p · OI_{m,s,a} ≤ α_addr · V_eff`. Property:
   simulate adversarial signer opening across all available markets
   on one underlying; assert subcap binds.

3. **`correlation_bucket_cap_holds`** — After every `open_position`,
   for every bucket `b` and side `s`, `BWOI_{b,s} ≤ α_corr · V_eff`.
   Property: open across BTC, ETH, SUI, SP500 simultaneously; assert
   bucket cap binds before per-underlying caps fully exhaust.

4. **`v_eff_is_lagged_ewma`** — After any state transition that
   changes `V`, `|V_eff_after − V_eff_before| ≤ |V_after − V_eff_before|
   · (Δt / τ)`. Property: simulate 100-block sequence of LP donate/
   withdraw; assert no single block moves `V_eff` by > 0.07% of the
   donation amount.

5. **`tournament_vault_isolation`** — For every `Position` with
   `position.market.parent_vault_type == TournamentVault`, no transition
   debits or credits `MartingalerVault<C>` while paying that position.
   Property: spawn tournament, fully exhaust tournament vault, settle
   tournament markets; assert main vault delta = 0 across the entire
   tournament.

6. **`hard_queue_cap_blocks_opens`** — When `Q · 10000 > V_eff ·
   Q_MAX_OPEN_BPS`, `open_position` reverts with `EQueueExceedsHardCap`.
   Property: artificially set `Q = 0.51 · V_eff` via test scenario;
   attempt `open_position`; assert revert. Drain `Q` to `0.49 · V_eff`;
   open succeeds.

7. **`winddown_is_monotonic_and_freezes_opens`** — After
   `check_winddown_triggers` sets `status = WIND_DOWN`, no subsequent
   `open_position` succeeds, and `status` cannot transition back to
   `OPEN` (no Move path exists). Property: trigger wind-down via
   trigger A, then attempt opens / repeated trigger calls; assert all
   opens revert and status remains `WIND_DOWN`.

8. **`deterministic_settle_ordering`** — Within a single block, when
   multiple `settle_market_*` calls arrive, the resulting state of
   `S`, `Q`, and `treasury` is identical regardless of tx ordering,
   when input markets are sorted by `market_id`. Property: build two
   identical scenarios, settle markets in opposite orders, assert
   resulting state equality.

---

## 12. Out-of-scope (orthogonal hardenings)

This doc deliberately does not address (recommend separate docs):

- AdminCap bounds + multisig + timelock (`10` Attack 8) — must land
  before mainnet but lives in the admin module spec.
- UpgradeCap policy (`10` Attack 9) — lives in deployment / immutability
  policy doc.
- Mint-curve hardening (`10` Attacks 2, 5, 14) — `03_wick_tokenomics.md`.
- Position transfer hold-time (`05` Attack 8) — `08_gamification.md`.
- Oracle freshness window (`05` Attack 10) — `path_observation` /
  `pull_oracle_driver` specs.
- Cross-collateral cap (`05` Attack 11) — v3 candidate.

These are real and load-bearing. They are scoped elsewhere.

---

## 13. Summary

v2 of the solvency model adds five mechanisms beyond v1:

1. **Probability-weighted OI cap** with per-address sub-cap defeats
   barrier-stacking and PTB cap monopolization.
2. **Correlation-bucket cap** with explicit `ρ` matrix defeats macro-
   shock cross-underlying drain.
3. **Time-averaged `V_eff`** in cap denominators defeats vault-
   inflation attacks (flash-LP, donate, abandon).
4. **Isolated tournament vaults** prevent tournament-induced queue-
   of-doom from infecting main solvency.
5. **Hard queue cap on opens + orderly wind-down clause** provide a
   bounded-loss tail outcome instead of a calcified zombie protocol.

Eight Move-testable invariants encode the new state requirements. The
parameter set carries forward v1's recommendations (`α = 10%`, `β =
0.5%`, fee algebra unchanged) and adds three new caps (`α_addr = 5%`,
`α_corr = 40%`, `Q_max_open = 50%`) plus EWMA windows (`τ = 1h` for
vault, `7d` for volume).

The protocol remains solvent in expectation under the v1 steady-state
analysis; it now also remains solvent (or at worst, terminates
predictably) under all twelve cross-market PTB attacks and the
critical Queue-of-Doom emergent failure mode from the economic /
governance red team.
