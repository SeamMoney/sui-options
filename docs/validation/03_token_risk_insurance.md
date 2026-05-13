# Cross-Reference Validation: WICK Token, Risk Config, OI Registry, Fee Router, Insurance Fund

**Status:** validation pass, 2026-05-12. Reads
`docs/design/v2/01_martingaler_accounting_v2.md` ("doc 01"),
`docs/design/v2/02_asymmetric_impact_fee_v2.md` ("doc 02"),
`docs/design/v2/03_wick_tokenomics_v2.md` ("doc 03"),
`docs/design/v2/04_solvency_v2.md` ("doc 04"),
`docs/design/v2/06_predict_btc_route_v2.md` ("doc 06"),
`docs/design/v2/08_gamification_v2.md` ("doc 08").

This pass surfaces the inconsistencies the v2 specs leak between the WICK
token, the risk-config / OI cap layer, the global exposure registry, the
fee router, the insurance fund, and the tournament vault. Fifteen
questions, fifteen verdicts. Severity is graded against the AGENTS.md
collateral invariant and the v2 attack-mitigation claims that load-bear
on cross-document agreement.

Severity legend:
- **CRITICAL** — load-bearing for solvency or for an explicit attack
  mitigation; ships as a bug if not reconciled.
- **HIGH** — names/signatures conflict between docs; one of the agents
  who wrote them produced compile-incompatible code.
- **MEDIUM** — unspecified detail that two integrating modules will
  resolve differently in absence of a top-down decision.
- **LOW** — orthogonal or already covered in open-issues sections.

---

## Q1 — `GlobalExposureRegistry` interface: do doc 04 and doc 02 spec the same object?

**Quotes.**

Doc 02 §4.1: "`public struct GlobalExposureRegistry<phantom U> has key {
id: UID, touch_total: u128, no_touch_total: u128, pwe_touch: u128,
pwe_no_touch: u128, pwe_touch_ewma: u128, pwe_no_touch_ewma: u128,
last_update_ms: u64, half_life_ms: u64, paused: bool, admin: address }`"

Doc 04 §2.1 (cap denominator): "`WOI_{u,s} + p_{m,s} · m · stake ≤
α_global · V_eff`" — uses `WOI_{u,s} = Σ_{m∈u} p_{m,s} · OI_{m,s}` per
§1's notation table.

Doc 04 §8 pseudocode references state on the vault, not on a registry:
"`let woi_after = vault.woi[underlying(market)][side] +
weighted_payout_add;`" — `vault.woi` is read off `MartingalerVault<C>`,
not off `GlobalExposureRegistry<U>`.

**Verdict: HIGH-severity inconsistency.** Two different agents
materialised the same logical quantity in two different objects. Doc 02
puts the probability-weighted exposure on a `GlobalExposureRegistry<U>`
shared object keyed by underlying. Doc 04 puts the same quantity on
`MartingalerVault<C>` keyed by `(underlying, side)` inside an in-vault
table. These cannot both be the storage of record. If implementers
follow doc 02 and doc 04 separately, the cap check in `open_position`
will read one number and the fee snapshot will read another — and they
will diverge whenever a cross-vault open updates one but not the other.

Field-level differences that matter even after picking one location:

| Field | Doc 02 | Doc 04 (implied) |
|---|---|---|
| Storage object | `GlobalExposureRegistry<U>` (one per underlying, one shared object) | `vault.woi: Bag<(underlying,side), u128>` (one per collateral vault) |
| Indexing key | implicit (one registry per `U`) | `(underlying, side)` |
| Sided split | `pwe_touch` / `pwe_no_touch` (two separate fields) | `[underlying][side]` map lookup |
| Probability source | `p_touch_bps = 10^8 / payout_multiplier_bps` (doc 02 §3.3) | `p_{m,s} = touch_probability(distance_in_σ, time_remaining)` 32-entry Bachelier table (doc 04 §10.2) |
| Smoothing | EWMA write-side, default `half_life_ms = 60_000` | Lookup table is instantaneous; doc 04 separately EWMAs `V_eff` with `τ = 3600s` |

**Resolution.** One canonical location and one canonical formula. The
cleanest cut is:

1. Adopt doc 02's `GlobalExposureRegistry<U>` as the single source of
   truth (it is a `key`-shared object scoped to underlying, which makes
   it natural to share across collateral vaults that face the same
   underlying — e.g. SUI-collateral and USDC-collateral BTC markets).
2. Replace doc 04 §8's `vault.woi[underlying(market)][side]` reads with
   `registry::pwe_touch_ewma(registry)` / `pwe_no_touch_ewma(registry)`
   reads.
3. Remove the `vault.woi` field from `MartingalerVault<C>`.

But the *probability formula* must also be reconciled — see Q2.

**Severity: HIGH.**

---

## Q2 — Probability-weighted exposure: same lookup table or two different formulae?

**Quotes.**

Doc 04 §10.2: "`p_touch(distance_in_σ, time_remaining_s) = max(p_min, 2
· Φ(−|distance_in_σ| / sqrt(time_remaining_s / σ_unit)))` … Implemented
as a 32-entry lookup table in Move … `p_min = 0.05` is the floor."

Doc 02 §3.3: "`p_touch_bps = 10_000 / payout_multiplier_bps · 10_000 =
10^8 / payout_multiplier_bps` so a market quoting `payout_multiplier_bps
= 18_000` (1.8×) gives `p_touch_bps ≈ 5_555` (≈ 55.55 %)."

**Verdict: CRITICAL-severity divergence.** Doc 04 derives the
probability from the *path-observation distance and time-remaining*
(Bachelier first-passage). Doc 02 derives the probability from the
*payout multiplier* (assumes the multiplier is fair, so the implied
probability equals the inverse multiplier). For a 1.8× ATM market with
1h remaining, doc 04 gives `p ≈ 0.5` (or higher, depending on σ); doc
02 gives `p = 0.5555`. For a 50× far-OTM market that doc 04 floors at
`p_min = 0.05`, doc 02 gives `p = 0.02` — a 2.5× difference, and
crucially *below* the floor doc 04 mandates.

This matters in two ways:

1. **Cap denominator vs fee denominator disagree.** If the cap check
   uses doc 04's Bachelier `p` and the fee snapshot uses doc 02's
   inverse-multiplier `p`, the same position contributes differently to
   the two systems. In particular, an OTM camouflage position (the
   thing the probability weighting is *supposed* to defeat per doc 04
   §2.1) would show up at `p ≈ 0.0001` in doc 02's formula (defeating
   `α_global` cap-binding by orders of magnitude relative to doc 04's
   floor of `0.05`).
2. **Doc 02's `p_min` gap.** Doc 02 has no probability floor in the
   pseudocode. A 100× OTM market contributes 1% of nominal exposure
   under doc 02 — small enough to camouflage. Doc 04's `p_min = 0.05`
   is exactly the defense against that.

**Resolution.** Adopt doc 04's Bachelier 32-entry lookup as the single
formula across both systems. Concretely:

- Add a `wick::pricing::touch_probability_bps(distance_σ_q,
  time_remaining_q): u64` Move function backed by the 32-entry table
  with linear interpolation.
- Both `wick::risk_config::check_global_cap` and
  `wick::registry::record_open` (called from `wick::market::open_position`)
  read the same function.
- Floor at `p_min_bps = 500` in both call sites.
- Doc 02 §3.3 needs an explicit erratum: replace the
  inverse-multiplier formula with a call to the shared function.

**Open issue:** the lookup needs `realized_vol_30d` from the oracle. Doc
04 §10.2 says "`σ_unit` is updated from oracle `realized_vol_30d` on
each `update` call." Doc 02 has no such oracle dependency. The shared
function must source σ from a single place (recommend storing on the
registry itself, refreshed by an admin or oracle pull).

**Severity: CRITICAL.**

---

## Q3 — EWMA half-life on `V_eff` vs on probability-weighted exposures

**Quotes.**

Doc 04 §1: "`V_eff` — Time-averaged effective vault: 1-hour EWMA of
`V_t`, decay constant `τ = 3600s`. This is the denominator of every
cap."

Doc 02 §3.3: "EWMA state … `half_life_ms: u64`" — initialised to
`60_000` (1 minute) per §3.4.

Doc 02 §10 open issue 1: "Half-life calibration. `half_life_ms = 60_000`
is a guess. The right value depends on typical market lifetime …
Recommend: parameterise on `Market<C>` at create time, default 1
minute."

**Verdict: MEDIUM-severity inconsistency, plus a CRITICAL second-order
risk if not reconciled.** Doc 04's `V_eff` uses τ = 3600s ≈ 1 hour. Doc
02's `pwe_*_ewma` uses half-life = 60s = 1 minute. These are two
*different* EWMA windows on two *different* quantities, which is fine
in principle, but the implications need to be checked:

- An attacker who LP-pumps `V` flash and immediately opens a max-size
  position: doc 04's `V_eff` barely moves (τ = 3600s defangs flash-LP),
  but doc 02's exposure EWMA reacts within the next 60s. So the
  attacker can briefly inflate `V` *and* see their exposure
  contribution under-weighted while the EWMA catches up. The cap
  inequality `WOI_{u,s} ≤ α_global · V_eff` becomes asymmetric: cap
  denominator slow, cap numerator fast.
- Inverse asymmetry: a real LP top-up during stress takes ~30 minutes
  to count toward `V_eff` (doc 04 §2.4) but a rebalancing trader's
  exposure shift counts against the cap within 60s of opening.

The half-lives can legitimately differ — they're measuring different
phenomena — but the *ratio* matters. The current spec has the exposure
EWMA 60× faster than the vault EWMA, which favors attackers who can
move exposure faster than vault state.

**Resolution.** Either:

1. Bring the two EWMAs into the same time scale (both 1h), OR
2. Document the asymmetry explicitly with a worst-case analysis showing
   that the 60s/3600s gap does not invalidate the §4.2 (The Crowd)
   bound.

Recommended: use a single `EwmaWindow` type with two named instances
(`EWMA_VAULT_TAU_MS = 3_600_000`, `EWMA_EXPOSURE_HALF_LIFE_MS = 60_000`)
and add a doc-04 §2.4 paragraph explaining the asymmetry rationale (or
align them).

Update frequencies must also be made explicit: doc 04 says `V_eff` is
"recomputed at the top of every `open_*` and `redeem_*`" — so updates
are lazy. Doc 02's exposure EWMA is updated "atomically with the open."
Both are event-driven, both are lazy in the same sense, so update
frequencies match. Good.

**Severity: MEDIUM (with a CRITICAL escalation if the asymmetry is
exploitable, which a quick mental model suggests it might be).**

---

## Q4 — Where does the `eligible_for_wick_mint` bot-exclusion flag actually live?

**Quotes.**

Doc 03 §1.4: "Every `Position` carries an `eligible_for_wick_mint:
bool` flag set at trade-open time."

Doc 03 §6.1 pseudocode: "`public struct Position has key, store { …,
eligible_for_wick_mint: bool, … }`"

Doc 03 §1.4 (continued): "The flag is `false` for: any address in the
on-chain `BotRegistry` (operator-controlled personality bots in
`bots/`)."

**Verdict: MEDIUM-severity inconsistency.** Doc 03 puts the flag on the
`Position` struct. But Position is intended to be Coin'ified per the
phase-C tasks (`#85. Phase C.1 — Coin'ify positions: one-time-witness
module per market`). A `Coin<PositionT>` cannot carry per-instance
metadata — coins are fungible.

There are three possible resolutions:

1. **Per-position metadata via `key, store` (not a `Coin`).** Keep
   Position as `key, store` with the flag in-place. This breaks the
   Coin'ification plan and the DeepBook listing flow.
2. **Per-address `BotRegistry` checked at mint time.** Move the check
   from open-time to mint-time. The `record_gain_and_mint` function
   already takes `recipient: address` and consults
   `state.bot_registry` (doc 03 §8.1). The flag passed in becomes
   irrelevant — the registry is checked freshly. This is what the doc
   03 §8.1 pseudocode actually does:
   ```
   if (!eligible_for_wick_mint || table::contains(&state.bot_registry, recipient)) {
       return
   };
   ```
   The `||` means *both* checks happen — the flag and the registry. The
   flag is therefore redundant if the registry is authoritative.
3. **Per-trade flag on the Position object (non-Coin'ified) plus
   per-address registry as defense-in-depth.** The flag captures
   trade-time context (e.g. "this trade was a tournament-internal
   match" — see Attack 5 mitigation in doc 03 §7) that the registry
   alone cannot capture; the registry catches operator-funded bot
   addresses regardless of trade context.

**Resolution.** The cleanest cut for Coin'ified positions is:

- Make the `BotRegistry` the per-address authoritative gate (option 2).
- Move the trade-context flags ("tournament-internal", "wash-trade
  heuristic-flagged") into a separate `MintEligibilityNote` shared
  table keyed by `(market_id, position_id)` — written by the
  trade-open path, consumed by `record_gain_and_mint`. Burned with the
  position.
- The `Coin<PositionT>` carries no metadata; the eligibility note is
  looked up by ID at mint time.

This preserves doc 03's intent (Attack 11 mitigation) while not
requiring per-instance fields on a fungible Coin.

**Severity: MEDIUM.** Open issue: explicit reconciliation needed
between phase-C Coin'ification design and doc 03 §1.4.

---

## Q5 — `MintDeferred` timing and replay drainage: who calls `crank_deferred_mints`?

**Quotes.**

Doc 03 §1.2.1: "The `deferred_dG` portion is recorded in `MintDeferred`
… and replayed via the same FIFO `crank_deferred_mints` queue used for
stale-Pyth deferrals."

Doc 03 §8.1: "`public fun crank_deferred_mints(state: &mut
WickGlobalState, max_to_process: u64, clock: &Clock, ctx: &mut
TxContext)`" — permissionless, bounded.

Doc 03 §10 open issue 6: "`MintDeferred` queue unbounded growth. If
Pyth degrades for hours and many trades close, the queue grows.
`crank_deferred_mints` is permissionless and bounded by
`max_to_process`; under degenerate conditions (no one cranks), the
queue stalls at the next genesis-overflow. Mitigation: add a
queue-length monitor in the keeper; auto-crank on growth."

**Verdict: MEDIUM-severity gap.** The queue is permissionless — anyone
can call it — but no on-chain economic incentive drives the call. Doc
03's open issue #6 explicitly acknowledges this. The downstream effects
of an undrained queue are:

1. Genesis-overflow deferrals can never replay until the keeper
   notices.
2. Stale-Pyth deferrals can never replay until the keeper notices.
3. Honest losers who hit either of these paths get *no WICK* until the
   crank runs.
4. Worst case: keeper outage for the genesis week means *all* honest
   losers above $50/day get nothing minted until day 8.

Two structural mitigations are missing:

- **Crank-bounty mechanic.** A small portion of each minted WICK on
  replay should be paid to the cranker. Doc 03 has no such bounty.
  (Doc 01 has a `harvest_bounty_pool` for the queue drain, but it's
  for the martingaler queue, not the WICK mint queue — they're
  different queues.)
- **Auto-crank on settle.** Every losing settlement could call
  `crank_deferred_mints(state, 1, ...)` as a piggyback. This bounds the
  queue to ≤ N entries on any sustained settlement flow. Doc 03's
  end-to-end flow in §8.5 does NOT show such a piggyback.

**Resolution.**

1. Pick: piggyback `crank_deferred_mints(state, 1, ...)` on the end of
   `record_gain_and_mint` so each settlement also drains one deferred
   entry. This makes the system self-cleaning under load.
2. Add a small WICK bounty to the cranker if (1) is rejected.
3. Document explicitly: "If keeper is offline AND no settlements occur,
   the deferred queue stalls. This is an availability concern, not a
   solvency concern — no mints are lost, only delayed."

**Severity: MEDIUM.**

---

## Q6 — Insurance fund identity: same object across docs 01, 03, 04?

**Quotes.**

Doc 03 §3.2: "`insurance_share` 10% — `InsuranceVault`. Sweep-on-cap to
stakers (NEW: deterministic, see §3.5)."

Doc 03 §3.4.1: "FORFEIT routing (V2: NOT to staker pool — kills Attack
12 amplifier). Forfeited dividends route to insurance vault."

Doc 03 §8.2: "`crank_insurance_sweep<C>(pool: &mut WickStakingPool,
insurance: &mut InsuranceVault, clock: &Clock, ctx: &mut TxContext)`" —
takes `&mut InsuranceVault`.

Doc 04 §7 (wind-down): does NOT mention an insurance fund. The
wind-down pays pro-rata from `payable_assets = V_snapshot + Σ
S_snapshot` — no insurance contribution to the payout. The phrase
"insurance fund" appears nowhere in doc 04.

Doc 01: does NOT define an insurance bucket. Doc 01 §1's
`MartingalerVault<C>` has `protocol_fees`, `staker_fees`, and
`harvest_bounty_pool` — no `insurance_fees`. The fee router's "insurance
~10%" bucket from doc 03 has no recipient defined in doc 01.

**Verdict: HIGH-severity inconsistency, leaning toward CRITICAL because
of the wind-down implication.** Three doc-01/03/04 mismatches:

1. **Doc 01 has no insurance bucket on `MartingalerVault<C>`.** Doc 03
   §3.2 says 10% of fees flow to `InsuranceVault`. But doc 01's
   `open_position` only credits `protocol_fees`, `staker_fees`, and
   `harvest_bounty_pool`. There is no path for the 10% to be carved.
2. **`InsuranceVault` is used by both forfeit-routing (doc 03) and
   sweep-on-cap (doc 03), but never named in doc 01 or 04.** No
   pseudocode signature for `InsuranceVault` itself appears in any
   doc; it's a referenced-but-undefined type.
3. **Wind-down (doc 04 §7.3) does not draw on the insurance fund.**
   Doc 04 explicitly excludes insurance from the payout calculation:
   `payable_assets = V_snapshot + Σ S_snapshot`. If insurance is
   supposed to backstop solvency, this is the moment it would —
   and it doesn't. (Maybe that's intentional: insurance backstops
   *staker* losses, not LP losses. But that needs to be said.)

**Resolution.** Three artifacts to write:

1. A canonical `wick::insurance_fund::InsuranceVault<C>` module
   defining the type. One shared object per collateral type. Held
   at-package level, shared across vaults (since doc 03 references
   `InsuranceVault` without a `<C>` parameter, but the underlying
   `Balance<C>` must be typed).
2. Doc 01 update: add an `insurance_fee_bps: u64` to
   `MartingalerVault<C>` config, route `(stake * insurance_fee_bps /
   10_000)` to a `forward_to_insurance_fund<C>` call inside
   `open_position` (parallel to `protocol_fees +=`).
3. Doc 04 update: §7.3 either explicitly draws from
   `InsuranceVault<C>` to top up `payable_assets`, or explicitly says
   "insurance is not consumed in wind-down because it's a
   staker-facing fund, not an LP backstop." Either is fine; the
   absence of the statement is the bug.

The fee-router bucket from doc 01 §1 is described in doc 03 §3.2 as
"60/30/10" but doc 01 doesn't break it that way — it just has
`protocol_fee_bps`, `staker_fee_bps`, `harvest_bounty_bps`. Three
buckets, but the names don't map cleanly to "LPs / stakers /
insurance". See Q11.

**Severity: HIGH.** This is the fee router that doc 01 §1 references
without defining and that doc 03 §3.2 defines without wiring.

---

## Q7 — Insurance dynamic cap: doc 03's $50k or doc 04's "dynamic"?

**Quotes.**

Doc 04 §2.3: nothing about a flat insurance cap; insurance is not
referenced at all in doc 04. The closest thing is the wind-down trigger
B (`E < −0.10 · V_eff_initial`).

Doc 03 §3.5: "Sweep eligibility is checked on a fixed weekly cadence."
Doesn't quote a $50k threshold per se. Doc 03 §8.2 references
`insurance_excess<C>(insurance)` as the function returning what to
sweep but does not define the cap formula.

**Verdict: MEDIUM-severity gap (the prompt asks about a $50k threshold
that I cannot find quoted in either doc — the canonical answer is
neither).** The actual specs are:

- Doc 03 §3.5 specifies a *cadence* (weekly) and a *destination* (TWAB
  pro-rata vested over 7 days), but does NOT specify the cap *value*
  itself. It says "excess over cap" but `insurance_excess<C>` is left
  to the implementer.
- Doc 04 has no insurance-cap concept.
- Neither doc says "$50k" anywhere related to the insurance fund. (The
  $50/address/day genesis-week dampener in doc 03 §1.2 is a different
  $50, not $50k.)

So both candidates from the prompt are unsupported by the documents.
The prompt may be conflating the genesis-week per-address per-day
$50 cap with an insurance-fund cap.

**Resolution.** Pick a canonical insurance-cap policy and write it
down. Recommended:

- **Dynamic cap = X% of `V_eff`** (e.g. 5% of `V_eff` per collateral).
  This makes insurance grow with protocol size and keeps the sweep
  threshold proportionate. Picks up doc 04's `V_eff` semantics for
  consistency.
- Sweep over-cap balance via the §3.5 TWAB-vested path.
- Document the cap value in a single config struct (not duplicated in
  doc 01, 03, and 04).

The single-source-of-truth for insurance cap should live in
`wick::insurance_fund::InsuranceVault<C>` (per Q6) as `cap_bps_of_v_eff:
u64`.

**Severity: MEDIUM.** Acknowledged as an underspec rather than a
contradiction.

---

## Q8 — Genesis-week dampener tracking: anchor and replay-drain timing

**Quotes.**

Doc 03 §1.2: "`if (now - wick_token_deploy_at_ms) < 7 days:` … per-address
per-day cap: at most $50 of lifetime-loss-equivalent mints WICK for any
single address per UTC day."

Doc 03 §8.1: "`pub struct WickGlobalState has key { … deploy_at_ms:
u64, … }`" — set at module init.

Doc 03 §8.1 (`crank_deferred_mints`): "For genesis-overflow, only
replay AFTER genesis window has ended. `if (head.kind == 1 && (now -
state.deploy_at_ms) < GENESIS_WINDOW_MS) { vector::push_back(...);
break }`"

**Verdict: LOW-severity, well-specified.** The anchor is `deploy_at_ms`
recorded at `WickGlobalState` creation (i.e., at package init). The
deferred-replay queue starts draining at `deploy_at_ms +
GENESIS_WINDOW_MS = deploy_at_ms + 7 days`. Both quoted precisely in
the §8.1 pseudocode.

The cleanly-specified parts:
- Anchor = package publish time (not first trade time).
- UTC day boundaries (`now / DAY_MS`), not per-address rolling 24h.
- Replay queue stalls during genesis week and resumes at day 7+1
  millisecond.

**Open issue.** `wick_token_deploy_at_ms` is set at module init time,
but the package publish event is a *Sui transaction*, not a clock read.
The `WickGlobalState` initialiser must be called in a transaction that
also reads the `Clock`, and the `clock.timestamp_ms()` value at that
moment is recorded. There is exactly one such transaction (per
deployment); no governance-controlled drift. Good.

**Resolution.** No resolution needed. Just confirm the §8.1 code is
load-bearing, and write a test that asserts `deploy_at_ms` is set
exactly once and never mutated. Add to `wick_token_tests.move`:
```
test_deploy_at_ms_immutable_after_init
```

**Severity: LOW.**

---

## Q9 — Per-fund 30% cap denominator: where does `cumulative_network_losses` live?

**Quotes.**

Doc 03 §4.3: "`pub struct WickGlobalState has key { …
cumulative_network_losses_usd_e6: u128,
cumulative_network_claimed_usd_e6: u128, … }`"

Doc 03 §4.3 (function): "`fun fund_loss_cap_remaining(global:
&WickGlobalState): u128 { let cap = global.cumulative_network_losses_usd_e6
* 3000 / 10000; … }`"

Doc 03 §8.2 (claim path): "`let fund_cap_remaining =
wick_token::fund_loss_cap_remaining(global);`"

**Verdict: LOW-severity, well-specified.** `cumulative_network_losses`
lives on the `WickGlobalState` shared object, on the WICK token module.
It is incremented in `record_gain_and_mint` (`state.cumulative_network_losses_usd_e6
= state.cumulative_network_losses_usd_e6 + effective_dg`) and in
`crank_deferred_mints` (same line for the deferred portion). It is
read by the staking pool's `claim` function via a module-cross
reference.

What's *not* specified:
- Does the `cumulative_network_losses` include losses from
  Predict-route trades? (See Q13.)
- Does it include losses from tournaments? (See Q14.)
- Does it include losses from bots? It explicitly does NOT, per doc 03
  §1.4 ("HWM does not ratchet for bot losses"). And the cumulative
  counter sits next to the HWM update, so they share the same
  early-return guard — bot losses are correctly excluded from this
  counter.

**Resolution.** Confirm via test that bot-flagged losses do not bump
`cumulative_network_losses_usd_e6`. Already implied by the §8.1 code
flow (the bot check returns before any state mutation), but worth a
direct assertion in `wick_token_tests.move`.

**Severity: LOW.** (HIGH escalation if the answer to Q13/Q14 is
unfavorable — cumulative_network_losses might be too narrow if
Predict-route or tournament losses are excluded.)

---

## Q10 — Stake cliff anchor: per-address single timer, but across underlyings or per-(address, underlying)?

**Quotes.**

Doc 03 §4.2: "v2 fix: cliff lives in a per-address `AddressStakeState`
record, not on the receipt: `pub struct AddressStakeState has store {
staked: u64, eligible_at_ms: u64, last_significant_stake_at_ms: u64 }`"

Doc 03 §8.2 (stake): "let prev = if (table::contains(&pool.address_state,
sender)) … `address_state: Table<address, AddressStakeState>`"

**Verdict: LOW-severity, well-specified at the staking-pool level — but
HIGH-severity unanswered question about cross-pool semantics.** The
`AddressStakeState` is keyed by `address`, not by `(address,
underlying)` or `(address, vault)`. A single timer per address.

The right question the prompt raises: WICK is a single token (no
per-underlying variants), so there is *one* `WickStakingPool` shared
object — not one per underlying. Confirmed by doc 03 §3.4.1's
`pool.acc_per_wick_by_currency` (a `Bag` keyed by currency *inside* a
single pool, not multiple pools). So one per address is correct.

But: there's an implication for *which currency* the dividends are
denominated in. If a user's dividends are coming from BTC trades (in
DUSDC) + SUI trades (in SUI) + USDC trades (in USDC), all three flow
through the *same* pool, accumulating into per-currency `acc_*`
trackers. The address has *one* cliff that gates *all* of them.

A user who opens their first stake to capture BTC-route dividends
delays their SUI dividends 48h too. This is the intended behavior —
it's the anti-loop fix.

**Resolution.** No resolution needed at the cliff level. But there's a
related under-specification: the address-state cliff also gates
*which* tournament participation? (Doc 08's owned-vs-rented test uses
`acquired_at_ms`, not `eligible_at_ms` — see Q15.) These are two
different timers on the same address. Make sure tests cover both: a
user could be cliff-eligible (48h since stake) but not "owned" (≤ 30
days since acquisition).

**Severity: LOW** (well-specified) **but FLAGS a related open issue
about timer-multiplicity per address that is worth a comment in doc
03**.

---

## Q11 — Fee router three-bucket split: 60/30/10 alignment vs doc 01

**Quotes.**

Doc 03 §3.2: "`lp_share` 60% — Originating market's `collateral_vault`
— re-feeds the WICK mint curve. `staker_share` 30% — `WickStakingPool`
— pro-rata to staked WICK. `insurance_share` 10% — `InsuranceVault`."

Doc 01 §1: "`protocol_fees: Balance<C>` … claimable by protocol multisig.
`staker_fees: Balance<C>` … streams to LP / WICK stakers post-MVP.
`harvest_bounty_pool: Balance<C>` … funds set aside to incentivize the
bounded auto-harvest work."

Doc 01 §2.1 fee computation: "`let fee_protocol = (stake *
vault.protocol_fee_bps) / 10_000; let fee_staker = (stake *
vault.staker_fee_bps) / 10_000; let fee_bounty = (stake *
vault.harvest_bounty_bps) / 10_000;`"

**Verdict: HIGH-severity inconsistency.** Doc 01 has three buckets
(`protocol_fees`, `staker_fees`, `harvest_bounty_pool`); doc 03 has
three buckets (LP, stakers, insurance). The names don't match and the
mappings aren't 1:1.

| Concept | Doc 03 name | Doc 01 closest equivalent |
|---|---|---|
| LP yield (60%) | `lp_share → collateral_vault` | net stake stays in `treasury` after fees |
| Staker dividends (30%) | `staker_share → WickStakingPool` | `staker_fees` |
| Insurance (10%) | `insurance_share → InsuranceVault` | (missing — closest is `protocol_fees` but that's a different concept) |
| Auto-harvest bounty | (not in doc 03) | `harvest_bounty_pool` |
| Protocol multisig | (not in doc 03) | `protocol_fees` |

So doc 01 has FIVE concepts (`treasury`, `staker_fees`,
`harvest_bounty_pool`, `protocol_fees`, plus the implicit "rest stays in
treasury") and doc 03 names THREE. Specifically:

- **Doc 03's "60% LP share" maps to doc 01's "net stake stays in
  treasury"** — doc 01 explicitly says LP yield is "net stake collected
  minus fees, routed to treasury via auto-harvest." So doc 01's 60% is
  not a separate bucket; it's the residual.
- **Doc 01's `protocol_fees` (multisig) is missing from doc 03's
  three-bucket model entirely.** Either doc 01 has a fourth bucket
  (governance) that doc 03 ignored, or `protocol_fees` should be 0 bps.
- **Doc 01's `harvest_bounty_pool` is missing from doc 03's split.**
  Same dilemma.
- **Doc 03's `insurance_share` (10%) has no home in doc 01.** Per Q6,
  this is the unimplemented bucket.

**Resolution.** Reconcile by writing a single `FeeSplitConfig`:

```move
pub struct FeeSplitConfig has store, copy, drop {
    lp_bps: u64,                  // = 0 (residual to treasury)
    staker_bps: u64,              // dividends to WickStakingPool
    insurance_bps: u64,           // doc 03's 10%
    protocol_bps: u64,            // multisig (can be 0)
    harvest_bounty_bps: u64,      // doc 01's bounty
}
// Constraint: lp_bps + staker_bps + insurance_bps + protocol_bps + harvest_bounty_bps == 10_000
// Recommended: lp = 6000, staker = 3000, insurance = 1000, protocol = 0, harvest = 0 (subsumed elsewhere)
```

And: harmonize doc 01 §2.1's three-line fee computation with doc 03's
three-bucket model. Either:

1. Drop `harvest_bounty_bps` from doc 01 (doc 01 §9.3 already lists
   bounty as an open issue — "no public function spends it in MVP").
   The bounty is a v2.1 concept; for v2 the bucket is dead weight.
2. Drop `protocol_fees` for v2 (set to 0), with governance carve
   defined post-MVP.

The result: doc 01's fee-split aligns with doc 03's LP/staker/insurance
split, with `lp_bps = 6000` realized as "treasury keeps the residual
after fee carve."

**Severity: HIGH.** The Move code cannot be written until a single
`FeeSplitConfig` is canonical.

---

## Q12 — Forfeit-to-insurance trigger conditions

**Quotes.**

Doc 03 §3.4.1: "FORFEIT routing (V2: NOT to staker pool — kills Attack
12 amplifier). Forfeited dividends route to insurance vault. … `let
forfeited = pending - allowed;`"

Doc 03 §4.4: "When `pending > allowed`, the difference (`forfeited`)
does not re-distribute through the staker accumulator. It is sent to
the `InsuranceVault`."

**Verdict: LOW-severity, well-specified — but the prompt asks "what
triggers a forfeit." The §3.4.1 pseudocode shows the precise trigger:**
forfeit happens when *either* `addr_cap_remaining` OR
`fund_cap_remaining` binds below `pending`. Specifically:

```
allowed = u128_min(u128_min(pending, addr_cap_remaining), fund_cap_remaining)
forfeited = pending - allowed
```

So the precondition for `forfeited > 0` is:

- `pending > addr_cap_remaining` (the per-address 30% cap binds), OR
- `pending > fund_cap_remaining` (the per-fund 30% cap binds).

The "stake cycled too fast" precondition from the prompt is *not* a
forfeit trigger. Stake cycling is gated by the cliff
(`E_CLIFF_NOT_REACHED`), which *reverts* the call rather than
forfeiting partial dividends. Stake cycling is a hard fail, not a
soft cap.

**Open issue.** What about `pending > addr_cap_remaining` due to the
*lifetime* losses cap (§4.3 "Per-address: 30% of that address's
cumulative realized losses")? This would forfeit. What about a user
who has never traded but somehow stakes (acquired WICK via transfer)?
Their `lifetime_losses_usd_e6 = 0`, so `addr_cap_remaining = 0`, so
ALL their dividends forfeit. That's working as intended (the cap
exists to prevent acquired-WICK farming) but should be noted in the
spec.

**Resolution.** Add to doc 03 §4.3 a sentence: "An address with
`lifetime_losses_usd_e6 == 0` has `addr_cap_remaining == 0` and all
their pending dividends forfeit. This is intentional: dividends are
loss-rebates, and a user who has not lost has nothing to rebate."
Also add a test:
```
test_addr_with_zero_losses_forfeits_all_pending_dividends
```

**Severity: LOW.**

---

## Q13 — Predict-route losses: do they mint WICK?

**Quotes.**

Doc 03 §1.4: "It does not mint on AMM swap fees in isolation. Only
realized losses trigger mints."

Doc 06 §3 (per-user managers): "Each Wick BTC user owns their own
`PredictManager`. The user is the manager.owner. Wick never holds the
user's DUSDC."

Doc 06 §7.4: "The protocol seeds a `Reserve<DUSDC>` shared object."

Doc 06 §6 + §7: nothing about `wick_token::record_gain_and_mint`.

Doc 03 §8.5 end-to-end flow: "`wick::market::settle_position` …
`wick_token::record_gain_and_mint(global, trader, d_gain_usd_e6, …)`"
— this is the *Wick-native* market path. There is no
`predict_route::settle_position` analog.

**Verdict: HIGH-severity unspecified.** Doc 06 entirely omits any
WICK-mint trigger. The Predict route's losing path is:

1. User opens BTC TOUCH via `predict_route::open_btc_touch` — this
   mints a Predict position in the user's own `PredictManager`, plus a
   `WickClaimTicket` for Wick payout asymmetry.
2. Market settles via the two-phase reconcile (§7.2).
3. If the user lost on the Wick side (TOUCH didn't trigger but Predict
   went to terminal-A, etc.), their `WickClaimTicket` redeems for less
   than `payout_if_win` — or the ticket simply isn't a winner.
4. Where does the *protocol's gain* (the user's loss) get recorded?

Per doc 06 §7.4, "the protocol seeds a `Reserve<DUSDC>` shared object"
that absorbs the *shortfall* when Wick can't pay out. But the
*surplus* (when Wick collected more in entry premium than it paid out
in winnings) — where does that go? Doc 06 doesn't say. The natural
homes are:

(a) Back to `Reserve<DUSDC>` (replenishing the buffer).
(b) Into the WICK mint curve as LP gain (parallel to doc 03 §1.1).
(c) Into the staker pool as direct dividends.
(d) Into the insurance fund.

And critically: does the *losing user* mint WICK?

**Resolution.** Decide one of:

1. **Predict-route losses do mint WICK.** Then doc 06 needs a
   `predict_route::record_loss(loser, d_gain_dusdc, ...)` call inside
   `redeem_btc_touch` (specifically when `pro_rata_factor < 1e9` or
   when the ticket has `payout_if_win == 0`). The DUSDC is converted to
   USDC at frozen reconcile-time price (per doc 03 §6.1 Pyth-frozen
   semantics).
2. **Predict-route losses do NOT mint WICK.** Then doc 03 §1.4 needs
   a sentence: "Only Wick-native market losses (settled via
   `wick::market::settle_position`) trigger mints. Predict-route
   losses route to Predict's PLP and do not mint WICK."
3. **Predict-route losses mint WICK only when Wick covers the
   shortfall from its `Reserve<DUSDC>`.** This is intermediate: the
   user's loss isn't a Wick LP gain unless Wick had to pay them to
   make them whole. The shortfall is the relevant quantity.

Recommended: option 3 captures the actual economic flow (Wick's PLP-
analog only profits when Predict diverges in Wick's favor; Wick's PLP-
analog only loses when Predict diverges in user's favor). The "Wick
LP gain" is the *delta* between what Predict paid and what Wick
collected as entry fees.

The "Wick-vault loss" the prompt asks about is exactly this delta —
recorded in a `wick::predict_route::WickRouteAccountingState` (new
type, per the missing-modules task #110) that tracks cumulative LP gain
on the Predict route.

**Severity: HIGH.** Underspecified; integration target without a
documented contract.

---

## Q14 — Tournament losses: do they mint WICK?

**Quotes.**

Doc 08 §1.5: "The pot is held in a `TournamentVault<C>` shared object,
separate from the `Market<C>` collateral vault." It does NOT mention
WICK minting.

Doc 04 §2.5: "Tournament markets do not back to `MartingalerVault<C>`.
Each tournament `T` instantiates its own `TournamentVault<C, T>` shared
object."

Doc 03 §1.4 (continued from Q13): "The flag is `false` for: any
address in the on-chain `BotRegistry` … any trade opened against a
known protocol-bot counterparty within the same market
(tournament-internal trades)."

**Verdict: MEDIUM-severity, partially specified.** Doc 03 §1.4
explicitly excludes "tournament-internal trades" from minting WICK
(via the `eligible_for_wick_mint` flag set to `false` at trade-open).
But this is a narrow exclusion: it covers trades *within* the
tournament where the counterparty is a protocol bot. It does NOT
cover trades where:

- The tournament market's losing side is a real human, AND
- The winning side is also a real human (not a bot).

In that case, by doc 03's logic, the loser SHOULD mint WICK. But the
tournament vault is *isolated* from the main vault. The "LP gain"
from a tournament-internal loser doesn't flow to the main
`MartingalerVault<C>`'s treasury — it flows to the `TournamentVault<C,
T>`. So there's no *protocol-wide* LP gain to trigger the mint.

**Resolution.** Decide one of:

1. **Tournament losses DO mint WICK** — using the tournament's own
   internal LP gain as `dG`. This is consistent with the spirit of
   "any losing trade mints WICK" but breaks the isolation principle
   (mint curve sees TournamentVault state too).
2. **Tournament losses DO NOT mint WICK** — `eligible_for_wick_mint
   = false` for all tournament market positions, regardless of
   counterparty. This is the cleanest cut and matches doc 04's
   isolation-via-typed-vault philosophy.
3. **Tournament losses mint WICK to a separate "tournament-wick
   curve"** — over-engineered for MVP.

Recommended: option 2. Set `eligible_for_wick_mint = false` for ALL
positions opened on tournament markets (not just bot-counterparty
trades). Update doc 03 §1.4 to read: "Any trade opened on a tournament
market" rather than "any trade opened against a known protocol-bot
counterparty within the same market (tournament-internal trades)."

This also resolves a dependency Q13/Q14 share with doc 03's
`cumulative_network_losses_usd_e6` definition: tournament losses
shouldn't count toward `cumulative_network_losses` either, because
they back to a different vault.

**Severity: MEDIUM.** Picks up integration-time confusion if not
resolved.

---

## Q15 — `acquired_at_ms` storage location: receipt or coin?

**Quotes.**

Doc 03 §8.2: "`pub struct StakeReceipt has key, store { id: UID, owner:
address, staked: u64, debt_per_wick_by_currency: Bag,
unstake_initiated_at_ms: u64 }`" — NO `acquired_at_ms` field.

Doc 08 §6.1: "`pub struct StakeReceipt has key, store { id: UID, owner:
address, amount: u64, locked_until: u64, acquired_at_ms: u64,
last_settlement_observed_ms: u64 }`" — HAS `acquired_at_ms` field.

Doc 08 §6.1 (continued): "`acquired_at_ms` is set to the receipt's mint
time on `stake()`. If WICK is transferred between wallets and re-staked,
`acquired_at_ms` resets — the new holder has freshly-acquired WICK
regardless of how long the previous holder had it."

**Verdict: HIGH-severity inconsistency.** Doc 03's `StakeReceipt` and
doc 08's `StakeReceipt` are NOT the same type. Two agents wrote the
same struct with different fields:

| Field | Doc 03 | Doc 08 |
|---|---|---|
| `id: UID` | yes | yes |
| `owner: address` | yes | yes |
| `staked: u64` / `amount: u64` | `staked` | `amount` |
| `debt_per_wick_by_currency: Bag` | yes | (missing) |
| `unstake_initiated_at_ms: u64` | yes | (missing — uses `locked_until` instead) |
| `locked_until: u64` | (missing) | yes |
| `acquired_at_ms: u64` | (missing) | yes |
| `last_settlement_observed_ms: u64` | (missing) | yes |

These are incompatible types. If implemented separately, the staking
module (doc 03) and the tournament module (doc 08) hold mutually
unreadable structs. Any function that takes a `StakeReceipt` from one
module cannot be called from the other.

The prompt's deeper question is correct: **you can't store metadata
on a `Coin<WICK>`.** WICK as a `Coin` is fungible by design (per doc
03 §0). The metadata (`acquired_at_ms`) MUST live on a wrapper. Doc
08's `StakeReceipt` is the right wrapper. Doc 03's `StakeReceipt` is
missing those fields.

The actual semantics — "if WICK is transferred between wallets and
re-staked, `acquired_at_ms` resets" — also need clarification. WICK is
transferred as a `Coin`; the receipt is created at `stake()`, not at
transfer. So `acquired_at_ms` is really "stake-time," not
"acquisition-time." A user who *holds* WICK for 60 days but never
stakes has `acquired_at_ms = stake-call-time`, not 60-days-ago. This
is semantically different from doc 08 §6.1's prose "when the WICK
first entered this wallet" — which implies tracking on the Coin
itself, which is impossible.

**Resolution.** Pick the doc-08 superset and replace doc-03's
`StakeReceipt`:

```move
pub struct StakeReceipt has key, store {
    id: UID,
    owner: address,
    staked: u64,                           // doc 03 name (preferred over `amount`)
    debt_per_wick_by_currency: Bag,        // from doc 03 — load-bearing
    unstake_initiated_at_ms: u64,          // doc 03 name (preferred over `locked_until`)
    acquired_at_ms: u64,                   // from doc 08 — set at stake()-time
    last_settlement_observed_ms: u64,      // from doc 08 — for tournament gates
}
```

And clarify the semantics of `acquired_at_ms`: it is **stake-time**,
not coin-acquisition-time. A user with `Coin<WICK>` held for 60 days
who has never staked has no `acquired_at_ms`; their first `stake()` call
sets it to `now`.

If true coin-acquisition-time tracking is required (for the "rented
vs owned" gate to be honest), that needs a different mechanism — e.g.,
require the user to hold the WICK in a `WickHoldingReceipt` wrapper
that tracks `first_received_at_ms`. That's more invasive and probably
overkill for MVP.

**Severity: HIGH.** Two agents wrote two `StakeReceipt` structs and
they don't compose.

---

## Summary

Across the 15 questions, the validation surfaces:

- **3 CRITICAL** issues (Q2 probability formula divergence; Q3 EWMA
  half-life asymmetry as a possible escalation; Q6 wind-down
  insurance interaction).
- **6 HIGH** issues (Q1 GlobalExposureRegistry interface; Q6 insurance
  fund identity; Q11 fee-router split; Q13 Predict-route mint trigger;
  Q15 `StakeReceipt` field mismatch; Q1's underlying object-of-record).
- **5 MEDIUM** issues (Q3 default; Q4 bot flag location; Q5 deferred
  crank; Q7 insurance cap; Q14 tournament mint).
- **3 LOW** issues (Q8 genesis anchor; Q9 cumulative tracker; Q10
  cliff scope; Q12 forfeit precondition).

The most critical to land before any of phases A.1–B.2 is implemented:
**Q2** (single probability formula across cap and fee), **Q6**
(canonical InsuranceVault module + fee-router insurance bucket wired
through doc 01), and **Q11** (canonical FeeSplitConfig replacing both
docs' partial splits). These three are upstream of every other
question and gate the Move code shape for `martingaler_vault`,
`risk_config`, `fee_router`, and `wick_token`.

The Coin'ification interaction (Q4 + Q15) is a phase-C planning issue
that should be settled before phase C.1 lands; otherwise the
Position-and-StakeReceipt storage models will collide with the
fungibility constraint.

The Predict-route loss path (Q13) and tournament loss path (Q14) are
gating decisions for the BTC route (phase D.1) and tournament module
(phase E.1) respectively. Neither blocks earlier phases but each will
re-open `wick_token::record_gain_and_mint`'s call-site contract.
