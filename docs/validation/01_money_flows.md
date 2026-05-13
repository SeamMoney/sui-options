# Money-Flow Integration Validation — v2 Cross-Doc Review #01

**Scope.** Cross-referential audit of every place value moves in the Wick v2
design corpus: `MartingalerVault` (doc 01), asymmetric impact fee snapshot
(doc 02), tokenomics fee router (doc 03), solvency caps + tournaments + wind-
down (doc 04), Predict-route DUSDC + per-user manager + `SettlementBucket`
(doc 06), DeepBook CLOB + OTC escrow (doc 07), and supporting touch-points in
the gamification doc (08).

**Method.** Read each doc end-to-end. Then trace every collateral movement
across module boundaries and check that the upstream and downstream module
agree on (a) which object holds the balance, (b) when the balance moves, (c)
which type the balance is, (d) which invariant is meant to gate the move.

**Verdict scale.**
- **Blocker** — Move will not compile or will compile a structurally-broken
  protocol; ship-stoppingly bad.
- **Should-fix** — protocol works but at least one of (security, fairness,
  invariant-clarity) suffers. Fix before mainnet, can defer for hackathon
  testnet if needed.
- **Acceptable** — under-specified but not contradictory; document the answer
  and move on.

15 integration questions are surfaced below. Each names which v2 doc should
*own* the resolution; that doc gets the small revision so the corpus
re-aligns.

---

## Q1 — Fee snapshot is captured BEFORE settlement deltas, not after

### Question

Doc 02 says "all fee inputs are captured atomically at `lock_settlement`
time." Doc 01 collapses lock + settle into a single atomic
`lock_and_settle`. Inside that one call there are 5 phases (drain queue,
build per-market lock, route losing stake, enqueue shortfall, finalise
status). Where in the phase ordering does the `FeeSnapshot` get built?

### Current state

Doc 02 §1.2 says the snapshot copies `pwe_touch_global` and
`pwe_no_touch_global` from the registry's EWMA. These EWMA values are
mutated by `record_close` calls inside `redeem_winner` (doc 02 §4.2). So
the snapshot must be taken *before* any redemption happens.

Doc 01 §2.2 has `lock_and_settle` doing five phases; nothing in those five
phases reads or mutates `GlobalExposureRegistry<U>`. The `treasury_snapshot_at_expiry`
field is captured in PHASE 2, but that's a separate (accounting) snapshot.

Doc 02 also requires `path_observation::freeze` to run *before* the
snapshot is read (§1.2 invariant 2: "lock_settlement calls
`path_observation::freeze(path, ctx)` *before* reading max_seen/min_seen").
Doc 01 has no `freeze` call anywhere in `lock_and_settle`.

### Verdict

**Real inconsistency.** Doc 01's `lock_and_settle` body needs to be
expanded to include a PHASE 0 (path freeze + snapshot construction) that
runs before PHASE 1 (queue drain). Today, doc 01 only mentions
`treasury_snapshot_at_expiry`; doc 02's `FeeSnapshot` is invisible to the
state machine doc.

### Recommended resolution

**Doc 01 should own this.** Insert a `PHASE 0 — freeze + snapshot` block at
the top of `lock_and_settle` that:

1. `path_observation::freeze(path, ctx)`
2. `let snap = fee::snapshot_at_lock(market, path, registry, clock)`
3. `option::fill(&mut market.fee_snapshot, snap)`

PHASE 0 happens *before* PHASE 1 (queue drain), because PHASE 1 mutates
`treasury` which the snapshot's `treasury_snapshot_at_expiry` field
depends on. Doc 02 says PWE is the load-bearing fee input; PWE EWMA does
not move during `lock_and_settle` itself, so the order between freeze and
queue-drain only matters for `treasury_snapshot_at_expiry` ordering.

Concretely: snapshot first, then drain. Otherwise PHASE 1 might move funds
out of `treasury` and the snapshot reads a smaller-than-expected value
(though atomically within the same tx, this is observable only to off-
chain analytics, not to redeem). Pin it in doc 01 to remove the ambiguity.

### Severity

**Blocker.** The implementer following doc 01 alone will not call
`fee::snapshot_at_lock` and the redeem path in doc 02 will abort with
`E_NO_SNAPSHOT` 100% of the time.

---

## Q2 — Per-market `settlement_lock` and `FeeSnapshot` synchronisation

### Question

Doc 01 puts `settlement_locks: Table<ID, Balance<C>>` on the vault. Doc 02
puts `fee_snapshot: Option<FeeSnapshot>` on the `Market<C>`. Both are
written by `lock_and_settle`. What guarantees they stay in sync (i.e. a
market with `Some(snap)` always has a corresponding entry in
`settlement_locks` and vice versa)?

### Current state

Doc 01 §2.2 says: at the end of `lock_and_settle`,
`table::contains(settlement_locks, market.id)` is a postcondition (INV-13
isolation depends on the entry existing).

Doc 02 §1.1 says: at the end of `lock_settlement`, `market.fee_snapshot.is_some()`.

The two states are written in the same atomic transaction, but they live
on different objects. There is no cross-object invariant linking them.

`release_stale_lock` (doc 01 §2.6) removes the entry from
`settlement_locks` after the stale window. It does *not* clear
`market.fee_snapshot`. So a market in `STALE_RELEASED` status can have
`Some(snap)` but no `settlement_lock`.

### Verdict

**Real inconsistency.** The `STALE_RELEASED` state breaks the implicit
synchronisation between the two storage locations. Doc 02's `redeem_winner`
asserts `market.fee_snapshot.is_some()` and proceeds to compute a fee —
but if the lock was already released to treasury, the redeem will then try
to pull from a balance that is no longer reserved.

### Recommended resolution

**Doc 01 should own this.** Two options:

(a) `release_stale_lock` clears `market.fee_snapshot = option::none()` AND
sets `market.status = STALE_RELEASED`. `redeem_winner` (doc 02) early-
returns `Coin::zero()` when `status == STALE_RELEASED`, before checking
`fee_snapshot`. This is what doc 01 §2.6 already says ("redeem_position
for that market always returns Coin::zero()") but only describes; the
order of checks in the redeem must put status before snapshot.

(b) Move `fee_snapshot` off `Market<C>` and onto a `Table<ID, FeeSnapshot>`
on the vault, alongside `settlement_locks`. This co-locates the two
pieces of per-market settlement state and lets `release_stale_lock`
remove both atomically.

Option (a) is cheaper and matches the existing one-shared-object
mutation pattern. Pick (a). Update doc 02's `redeem_winner` pseudocode to
assert `status != STALE_RELEASED` before reading `fee_snapshot`.

### Severity

**Should-fix.** A market that goes stale and then gets redeemed against
will compute a fee on a snapshot whose backing collateral is gone. The
`vault::withdraw(&mut market.vault, net, ctx)` call at the end of doc 02's
`redeem_winner` then aborts, but it aborts noisily — confusing for users
who don't realise they missed the window.

---

## Q3 — Auto-harvest does not bypass fee accrual; fees are taken at open only

### Question

Doc 01 says auto-harvest drains `side_bucket` into queue heads on every
flow that touches the vault. Doc 02 says fees deposit into `protocol_fees`
/ `staker_fees` / `harvest_bounty_pool` (doc 01 §1) at open time. When
auto-harvest moves losing stake from `side_bucket` into queue head, does
that movement bypass fee accrual?

### Current state

Doc 01 §2.1: `open_position` already takes
`fee_protocol + fee_staker + fee_bounty` from the gross stake before
routing `net_stake_balance` through `drain_into_queue_heads`. So the
losing-side stake that eventually lands in `side_bucket` is already net of
fees.

Doc 01 §2.2 PHASE 3: at lock+settle, `losing_stake` is "freed" via
`drain_into_queue_heads_with_balance`. This is a bookkeeping move — the
stake was already in `treasury` since open time, and the fee carve already
happened then.

Doc 02 §8: `apply_fee` at `redeem_winner` time computes a *second* fee on
the gross payout (`(gross_payout * (BPS_DENOM - f_bps)) / BPS_DENOM`).
That fee is NOT routed into `protocol_fees` / `staker_fees` in doc 02's
pseudocode — it just shrinks the payout. Where does the difference go?

Doc 03 §3.1 says the fee router has 60/30/10 split (LP / staker /
insurance) on "settlement skim" (25 bps of payout). That's a third fee
event distinct from open-time and from the asymmetric impact fee.

### Verdict

**Under-specified, real cross-doc gap.** Three fee events exist in the
corpus:

1. Open-time fees (doc 01 §2.1): protocol_fees + staker_fees + bounty.
   Routed inside `MartingalerVault`.
2. Asymmetric impact fee at redeem (doc 02 §8): shrinks payout. **Doc 02
   does not say where the difference goes.**
3. Settlement skim (doc 03 §3.1): 25 bps of payout, routed via fee_router
   with 60/30/10 split.

Items 2 and 3 may be the *same* fee (the impact fee is the variable
"settlement skim" mentioned in doc 03), or they may be additive. The
corpus does not say.

Auto-harvest itself does not bypass fee accrual — fees are taken at
*event boundaries* (open, redeem), not at internal balance-shuffles.

### Recommended resolution

**Doc 03 should own this.** Add a §3.1.1 "Fee event taxonomy":

| Fee event | Source | Where it lives | Routed to |
|---|---|---|---|
| Open fee | doc 01 §2.1 | `MartingalerVault.{protocol_fees, staker_fees, harvest_bounty_pool}` | held until governance/keeper drains |
| Asymmetric impact fee | doc 02 §8 | implicitly subtracted from `redeem_winner` payout | **NEW: route to `MartingalerVault.staker_fees`, then to fee_router on next `crank_fees`** |
| (former) settlement skim | doc 03 §3.1 | **REMOVED** — the impact fee replaces it | n/a |

Then add a `fee_router::crank<C>` function that drains
`vault.{protocol_fees, staker_fees}` into the 60/30/10 buckets at a
keeper-callable cadence. Auto-harvest (doc 01) does NOT touch
`protocol_fees` / `staker_fees`; those are segregated and only move on
explicit crank.

### Severity

**Blocker.** Without a clear answer, the implementer will either (a) drop
the impact fee revenue on the floor (doc 02 has nowhere for it to go) or
(b) double-charge the trader (impact fee + settlement skim = 2× the
intended haircut).

---

## Q4 — Queue-head priority composes with Predict pro-rata bucket via vault separation

### Question

Doc 01 §2.3 says: when `queue_total > 0`, fresh winners go to the queue
back. Doc 06 §7 says: Predict-route winners pay pro-rata from a
`SettlementBucket`. Are these the same queue? Does a Predict-route winner
respect the global FIFO?

### Current state

Doc 06 §1: "The MVP that ships under v2 is **non-custodial for user
DUSDC** — Wick never holds end-user collateral on the BTC route." So
Predict-route DUSDC sits in the user's own `PredictManager`, never in
`MartingalerVault<DUSDC>`.

Doc 06 §7.4: "Reserve top-up. The protocol seeds a `Reserve<DUSDC>`
shared object." That reserve is *separate* from the `MartingalerVault<C>`
treasury.

Doc 04 §2.5: "Tournament markets do **not** back to `MartingalerVault<C>`."
The same logic should apply to Predict-route — it has its own funding
source.

Doc 01 has no awareness of `SettlementBucket` or `Reserve<DUSDC>`.

### Verdict

**Under-specified but consistent.** The two "queues" do not share state
because they live in different vaults. The Predict-route shortfall
flows through `SettlementBucket.pro_rata_factor_e9` and is funded from
`Reserve<DUSDC>`, not from `MartingalerVault<DUSDC>.queue`.

The catch: Wick may eventually offer Wick-native DUSDC markets via
`MartingalerVault<DUSDC>`. Then there are *two* queues in DUSDC: the
Wick-native FIFO queue and the Predict-route pro-rata bucket. Both serve
DUSDC payouts; they don't share priority because they're funded by
different vaults.

### Recommended resolution

**Doc 06 should own a brief §7.5 disambiguation.** State explicitly:

> The Predict-route `SettlementBucket` is independent of any
> `MartingalerVault<DUSDC>.queue`. Predict-route shortfalls are absorbed
> by `Reserve<DUSDC>` (a Predict-route-specific shared object), then
> distributed pro-rata. Wick-native DUSDC market shortfalls are absorbed
> by `MartingalerVault<DUSDC>.queue` (FIFO). The two are non-fungible and
> never cross-collateralise.

Tag this as an architectural decision: pro-rata for Predict (because
divergence is a Predict-side fact, not a Wick-side timing fact); FIFO for
Wick-native (because Wick controls who-settled-first).

### Severity

**Should-fix.** Without explicit disambiguation, the keeper or indexer
might attempt to drain the Predict-route bucket through `drain_into_queue_heads`
and either compile-fail (different `Balance<C>` types? same type,
different vault?) or drain the wrong reserve.

---

## Q5 — Hard queue cap is per-vault, so it does NOT apply to the Predict route

### Question

Doc 04 §8 says new opens revert with `EQueueExceedsHardCap` when
`Q / V_eff > 0.5`. Doc 06 says Predict-route opens deposit DUSDC into the
user's own `PredictManager` — they don't touch `MartingalerVault<DUSDC>`
at all. Does the hard cap apply to Predict-route opens?

### Current state

Doc 04 §8's `open_position` pseudocode reads `vault.queue_total` and
`vault.v_eff`. Predict-route's `open_btc_touch` (doc 06 §9) does not
take a `MartingalerVault<DUSDC>` parameter at all — it operates on
`UserPredictAccount<DUSDC>`, `PredictManager`, `Predict`, `OracleSVI`.

So structurally, doc 04's hard cap CANNOT apply to Predict-route opens —
the function call doesn't have a vault to read.

But doc 04 §2.5 frames isolated tournament vaults as having "its own
isolated parameter set, scaled to the tournament size." There is no
analogous statement for Predict-route.

### Verdict

**Real gap.** Predict-route has no equivalent of the hard queue cap. If
Predict's PLP is exhausted and Wick's `Reserve<DUSDC>` is also dry, the
pro-rata factor will simply degrade — there is no "halt new opens"
backstop.

### Recommended resolution

**Doc 06 should own this.** Add a §7.6 "Reserve hard cap":

> Predict-route opens revert with `EReserveExceedsHardCap` when
> `pending_pro_rata_shortfall_estimate / Reserve<DUSDC>.value() > 0.5`.
> The estimate is the sum of `pwe_touch_global` worth of in-flight Wick
> tickets that Predict has *not yet* settled. Implementation: track a
> running `total_inflight_wick_promised_dusdc` on a shared
> `PredictRouteState` object, increment on every `open_btc_touch`,
> decrement on every `redeem_btc_touch`.

This makes the Predict route degrade-gracefully rather than silently
amplify pro-rata shortfalls.

### Severity

**Should-fix.** For hackathon: probably no Predict-route shortfall in
demo. For mainnet: a Reserve-exhausted state is a silent product failure
that traders only discover at redeem.

---

## Q6 — Tournament fees route to the **tournament's own** operator/burn reserves, not the main fee_router

### Question

Doc 04 §2.5 says tournaments use isolated vaults. Doc 08 confirms a
`TournamentVault<C>` per tournament. But doc 03 §3.1 says fees fund the
`fee_router` 60/30/10 split. Where do tournament fees go?

### Current state

Doc 08 §1.6: "Total: 30 + 18 + 12 + 35 + 10 + 5 + 5 = 115. Wait —
rebalanced for v2: prize curve sums to 80% of pot, comeback 5%, burn
10%, operator 5% = 100%." So a tournament's pot splits 80/5/10/5.
**There is no slice that routes to the main fee_router.**

Doc 08 §1.5: `TournamentVault.burn_reserve` (10% of pot) "vests to
stakers (see §7)." So WICK stakers do get tournament burn revenue —
just via a separate path, not via the main fee_router's `staker_fees`
balance.

Doc 03 §3.1 lists revenue sources as "AMM swap fees" and "settlement
skim". Tournaments do not have a CPMM swap (tournament markets are
spawned with seed liquidity and trade through the same `open_position`
primitive). So tournament-internal trades' open fees DO route through
`MartingalerVault.protocol_fees` etc. — but `MartingalerVault<C>` for
tournaments is the **TournamentVault's spawned market vault**, not the
main one.

### Verdict

**Real inconsistency.** Doc 04 §2.5 says tournament markets have isolated
parameter sets, which strongly implies isolated fee-router state too. But
neither doc 03 nor doc 08 spells this out. Two interpretations:

(a) Each tournament has its own mini fee router. Fees stay inside the
    tournament, get distributed via the existing 80/5/10/5 prize curve
    (the 10% burn IS the staker carve). Main fee_router untouched.

(b) Tournament-spawned markets DO route their open/impact fees through
    the main fee_router (not the tournament's own buckets). Pot stays
    isolated; per-trade fees do not.

Interpretation (a) is what "isolated tournament vault" implies. Doc 08's
prize curve (which already includes a 10% staker tithe) supports it.

### Recommended resolution

**Doc 08 should own this.** Add a §1.5.1 sentence:

> Per-trade fees (open fee, impact fee at redeem) on tournament-spawned
> markets accrue to the parent `TournamentVault.operator_reserve` (gas
> recoup) and `TournamentVault.burn_reserve` (staker tithe) buckets, not
> to the main `MartingalerVault<C>.{protocol_fees, staker_fees}`. This
> preserves tournament isolation and avoids double-counting tournament
> activity in the main fee router's APY metric.

### Severity

**Should-fix.** If we ship interpretation (b) by accident, tournament
fees inflate the main `staker_fees` balance, which inflates the
"baseline" dividend rate for non-tournament periods, which makes
post-tournament dividend cliffs look like a bug.

---

## Q7 — CLOB-held position coins must be redeemable by their bearer

### Question

Doc 07 says position coins trade on DeepBook CLOB. Doc 01 says positions
burn on `redeem_winner`. What happens when a CLOB seller's position is
held by a smart contract (e.g. a Wick-foreign aggregator) that can't call
`redeem`?

### Current state

Doc 07 §6 ("settled-coin handling"): the keeper "withdraws all
`Coin<Position<M, Touch>>` and `Coin<Position<M, NoTouch>>` from its
`BalanceManager` and `Vault`, calls `redeem_position` on the winning
side." So *the keeper redeems its own holdings*. Other holders are on
their own.

Doc 07 §6.3: the UI shows a hard banner directing the user to "Click to
redeem." This implies any human holder can call `redeem`, but a contract
holder cannot.

Doc 01 §2.3 `redeem_position` signature takes a `position: Position`
(the value, not a reference). It's a normal Sui object — anyone holding
it can redeem.

But doc 07 implies positions are `Coin<Position<M, Side>>` — they are
fungible, divisible Coin tokens (because they trade on DeepBook). This
is a structural mismatch with doc 01, which uses `Position` as a
non-Coin `key, store` struct (per `AGENTS.md` and `docs/architecture.md`).

### Verdict

**Real inconsistency at the type level.** Doc 01 expects `Position` as a
non-fungible struct; doc 07 expects `Coin<Position<M, Side>>` as a
fungible Coin token wrapped via OTW. These are not compatible — `Coin<T>`
holds a `Balance<T>`, while `Position { id, market_id, side, stake,
payout_if_win }` holds typed metadata that cannot be split.

If position becomes a `Coin`, then the `payout_if_win` field can no
longer live on the struct; it must be derived from the coin's amount
times a per-market payout multiplier. That changes the redeem math too.

### Recommended resolution

**Doc 01 should own this.** Pick one and propagate:

(a) **`Position` stays non-Coin.** Doc 07 §1 already says Tier B (OTC-
    only) keeps positions as `key, store` (no Coin'ification). Make Tier
    A also hold positions as non-Coin. The OTC path works; the CLOB path
    is replaced by an OTC-equivalent via DeepBook's spot-token escrow
    (which doesn't exist yet — would require Wick to mint a wrapper
    Coin per market just for the CLOB pool).

(b) **`Position` becomes `Coin<Position<M, Side>>`.** Doc 01 needs a
    significant refactor: `payout_if_win` derives from `coin::value() ·
    market.payout_multiplier_bps / 10_000`. The redeem function takes a
    `Coin<Position<M, Side>>` and burns it via the per-market
    `TreasuryCap`.

Doc 07 §1 implies the codebase intends to support BOTH (Tier A coinified,
Tier B non-coinified). That requires *two* `Market<C>` types, which is
gross. Better: pick (a) for MVP, defer (b) until post-MVP CLOB.

For the hackathon: pick (a). Doc 07 should re-frame Tier A as "OTC-only
with keeper market-making" rather than "real CLOB". The "coin'ify
positions" task in TASKS.md (#85) is then deferred.

If someone disagrees and wants real CLOB: a smart-contract holder of a
post-settlement Position coin who can't redeem is **stuck**. The position
sits in their contract forever. That's an acceptable failure mode (caveat
emptor for protocols that integrate Wick) but should be documented.

### Severity

**Blocker** for the type-level question (doc 01 and doc 07 disagree on
whether `Position` is a Coin). Once that's picked, the "stuck contract
holder" question becomes Acceptable.

---

## Q8 — OTC escrow holds collateral on the OtcOrder object itself, not in the vault

### Question

Doc 07 §5 specs OTC escrow via Wick events. Where does escrowed collateral
live?

### Current state

Doc 07 §5.1: `OtcOrder<phantom C>` has fields `locked_collateral:
Balance<C>` and `locked_position: Option<Position>`. So the bid's
collateral lives on the order object directly, and the ask's position
lives on the order object directly.

This means OTC escrow does NOT touch `MartingalerVault<C>` at all. Good
isolation. But: it also means the vault's INV-1 (solvency) sum does NOT
include OTC-escrowed collateral.

Is that correct? Yes — OTC collateral is the *maker's* funds, never the
protocol's. The vault's solvency invariant is about funds the protocol
has promised to pay out, not funds held in escrow for a P2P trade.

### Verdict

**Consistent.** OTC escrow lives on the `OtcOrder` shared object,
isolated from the vault. Cancellation refunds the maker; expiry refunds
the maker (anyone-can-trigger).

### Recommended resolution

**Doc 01 should own a one-line note.** In §3 (invariants), add:

> INV-1 does NOT include `OtcOrder<C>.locked_collateral` or
> `Balance<C>` held in any non-vault shared object (e.g.
> `Reserve<DUSDC>`, `TournamentVault<C>`). The invariant scope is
> `MartingalerVault<C>` and the per-market settlement_lock entries it
> owns.

This prevents an over-zealous test from summing all `Balance<C>` on
chain and asserting against INV-1.

### Severity

**Acceptable.** Just a documentation tightening.

---

## Q9 — InsuranceVault is one shared object with two purposes (sweep target + wind-down backstop)

### Question

Doc 03 says forfeited dividends route to InsuranceVault. Doc 04 says wind-
down uses the insurance fund. Are these the same object? Same Balance<C>?

### Current state

Doc 03 §3.2: `insurance_share = 10%` of fees → `InsuranceVault`. §3.5:
sweep-on-cap to stakers via TWAB-vested over 7 days.

Doc 04 §7.3: pro-rata payout math at wind-down uses
`payable_assets = V_snapshot + Σ S_snapshot` and does **not** mention
insurance fund inputs. Only the §7.5 disclosure says "the insurance
fund" exists.

Doc 04 §10 (table) lists "Insurance fund" as an out-of-scope
"orthogonal hardening" for v2. So the insurance fund is in scope for
doc 03 but out of scope for doc 04's wind-down math.

Doc 03 doesn't acknowledge the wind-down case at all — it treats
InsuranceVault as a one-way sweep buffer.

### Verdict

**Under-specified.** Two reasonable interpretations:

(a) InsuranceVault is *only* a sweep buffer for forfeited dividends
    (doc 03's view). Wind-down does not consult it. The wind-down
    "insurance fund" mentioned in doc 04 §7.5 is a separate thing
    (perhaps the protocol multisig treasury).

(b) InsuranceVault is a multi-purpose backstop. It absorbs forfeited
    dividends (doc 03) AND it gets drawn down at wind-down to bump
    `total_available` before pro-rata kicks in (doc 04 §7.3 amended).

Interpretation (b) is more defensible: a "wind-down insurance fund"
that doesn't insure against wind-down is silly. Forfeited dividends
should sit in InsuranceVault until either (i) the weekly TWAB sweep
distributes them or (ii) wind-down fires and pulls them in.

### Recommended resolution

**Doc 04 should own this.** Add a §7.3.1:

> At wind-down activation, `payable_assets` is augmented by
> `InsuranceVault.balance.value()`. The insurance balance moves into
> `payable_assets` BEFORE `pro_rata_factor` is computed. The insurance
> sweep cadence (doc 03 §3.5) is paused on wind-down; remaining
> insurance funds are committed to the wind-down payout.

Doc 03 should add a one-liner in §3.5 acknowledging this:
> Sweep cadence pauses while `MartingalerVault<C>.status == WIND_DOWN`.
> Remaining insurance balance is consumed by the wind-down payout per
> doc 04 §7.3.1.

One `InsuranceVault<C>` per collateral type, shared between dividend
sweep and wind-down backstop.

### Severity

**Should-fix.** A wind-down event that ignores the insurance fund leaves
real recoverable value on the floor; users get less than they should.

---

## Q10 — Predict-route losses do NOT mint WICK; only Wick-vault losses do

### Question

Doc 06 says Predict route uses Predict's PLP as counterparty. Doc 03 says
WICK mints on Wick-vault losses. Does losing a Predict-route trade mint
WICK?

### Current state

Doc 03 §1: "WICK is minted to losing traders as compensation for the fees
their loss generated for the protocol." And §1.3: "It does **not** mint
on … winning trades." Symmetrically, mint requires a *protocol* loss
event — i.e. a loss event that flowed into a Wick-controlled LP pool.

Doc 06 §0: "Wick never holds end-user collateral on the BTC route." The
Predict PLP is the counterparty; Wick takes only the early-unwind fee
(doc 06 §4.3) and the Predict-route reconciliation reserve top-ups
(doc 06 §7.4).

So a Predict-route trade that loses pays Predict's PLP. Wick took a 50
bps early-unwind fee at most. There is no `record_gain_and_mint` call
because there is no Wick LP gain.

### Verdict

**Consistent but ambiguous-by-omission.** Doc 03 frames itself
collateral-agnostically ("Wick LP gain") and doc 06 makes it clear that
no Wick LP gain occurs on the Predict route. The combined corpus says:
Predict-route losses do not mint WICK.

This is *probably* intentional — the BTC route is a wrapper, not an LP-
collateralised market — but it should be stated so traders understand
why their BTC loss didn't earn WICK.

### Recommended resolution

**Doc 03 should own this.** Add a §1.3.1 line:

> WICK does NOT mint on Predict-route trades (BTC, today; any future
> Predict-wrapped underlying). Predict-route losses pay Predict's PLP,
> not Wick's vault, so the "fee receipt" frame does not apply. WICK
> mints only when a loss flows into a `MartingalerVault<C>` —
> Wick-native SUI/USDC/SP500/random-walk markets.

Update the trader-facing copy accordingly: BTC trades show "no WICK
rebate" alongside the early-unwind fee disclosure.

### Severity

**Acceptable.** The behavior is correct; the documentation just needs to
be explicit so traders aren't surprised.

---

## Q11 — `harvest_bounty_pool` is not yet wired to a payer; it accumulates indefinitely

### Question

Doc 01 §2.1 takes a `fee_bounty` slice on every open and stores it in
`harvest_bounty_pool`. Doc 01 §9 (open issues #3) acknowledges "no public
function spends it in MVP." So this is a balance that grows without
bound. Where does it end up?

### Current state

Doc 01 §1: `harvest_bounty_pool: Balance<C>` is a vault field.
Doc 01 §2.1: every open adds `fee_bounty` to it.
Doc 01 INV-1: `harvest_bounty_pool` is included in the solvency sum on
the protocol-equity side.
Doc 01 §9: the function to spend it is post-MVP.

Doc 03 fee_router (60/30/10 to LP / staker / insurance) does not
mention `harvest_bounty_pool` as an input. So there's no path from
bounty pool → fee router.

### Verdict

**Real inconsistency.** The bounty pool is dust-ratchet — it grows by
`stake * harvest_bounty_bps / 10_000` on every open and never drains.
At 25 bps and $1M lifetime volume, that's $2.5k locked away with no
spender.

### Recommended resolution

**Doc 01 should own this.** Two options:

(a) **MVP: set `harvest_bounty_bps = 0`** by governance default. Field
    exists for post-MVP. Rationale: if no one spends from it, don't fund
    it.

(b) **MVP: route `harvest_bounty_pool` to `protocol_fees`** at every
    open if no keeper-bounty function exists. Cleanest: just make
    `harvest_bounty_bps = 0` and remove the third fee carve from
    `open_position`.

Pick (a). Update doc 01 §2.1 to default `harvest_bounty_bps` to 0;
remove the bounty pool from INV-1 (since balance is always 0); keep
the field for forward compat.

### Severity

**Should-fix.** Currently the bounty pool is a slow leak of trader fees
into a balance no one can claim. Not loss-of-funds (the protocol has it),
but it's bad optics and inflates the "fees taken" telemetry without
delivering a service.

---

## Q12 — `fee_router::crank` is missing — fees accrue in the vault but never reach stakers/insurance

### Question

Doc 03 §3.1 talks about the "fee router" with 60/30/10 splits. Doc 01
puts `protocol_fees` and `staker_fees` on `MartingalerVault<C>`. There
is no documented function that moves fees from vault → router → buckets.
How do staker dividends actually fund?

### Current state

Doc 01 §2.1: fees deposit into `MartingalerVault.{protocol_fees,
staker_fees, harvest_bounty_pool}`. These are `Balance<C>` fields.

Doc 03 §3.4.1 (`stake` and `claim`): the staker `claim` function reads
`pool.acc_per_wick_by_currency[C]` and pays from
`borrow_balance_mut<C>(pool)`. The accumulator and balance live on
`WickStakingPool`, not on `MartingalerVault<C>`.

There is no documented function that moves balance from
`MartingalerVault.staker_fees` → `WickStakingPool.balance<C>`.

### Verdict

**Real gap.** The accounting is bifurcated:
- Open-time fees land in the vault.
- Stakers pay out from the staking pool.
- No bridge.

### Recommended resolution

**Doc 03 should own this.** Add a `wick::fee_router` module spec with one
public function:

```move
public entry fun crank<C>(
    vault: &mut MartingalerVault<C>,
    staking_pool: &mut WickStakingPool,
    insurance: &mut InsuranceVault,
    treasury_addr: address,
    _bounty: Coin<C>,           // optional caller incentive from harvest_bounty_pool
    ctx: &mut TxContext,
)
```

Body:

1. Withdraw all of `vault.protocol_fees`, `vault.staker_fees`.
2. Combined sum × 60% → re-injected into `vault.treasury` (LP share).
3. Combined sum × 30% → `staking_pool.balance<C>` (staker share);
   bump `acc_per_wick_by_currency[C]` accordingly.
4. Combined sum × 10% → `InsuranceVault`.
5. Pay caller a small bounty from `vault.harvest_bounty_pool`.

Cadence: keeper-callable, e.g. once per epoch or whenever
`vault.protocol_fees + vault.staker_fees > some_threshold`.

This single missing module is the largest implementation gap surfaced by
this review.

### Severity

**Blocker.** Without it, fees accumulate in the vault and stakers earn
nothing — the entire dividend model is non-functional.

---

## Q13 — `GlobalExposureRegistry<U>` is not updated by `lock_and_settle`'s exposure transfers

### Question

Doc 02 says open and redeem update the registry. Doc 01's
`lock_and_settle` decrements `touch_exposure` and `no_touch_exposure`
internally as it pays out (well, actually doc 01 does NOT decrement
exposure at lock; that happens during redeem). But doc 04 caps OI based
on registry totals. When does the registry decrement on the *losing*
side?

### Current state

Doc 02 §4.2: `record_close` is called inside `redeem_winner` after the
fee snapshot is read. **Only winners' redemptions trigger
`record_close`.**

But losing positions also exist. They have `payout_if_win` that was
counted into the registry at open time. They never call `redeem_winner`
(or rather, doc 01 §2.3 has them call it and get `Coin::zero()` and
delete the position). Does that path also call `record_close`?

Doc 01 §2.3 losing-position branch: just deletes the position. No
registry call.

### Verdict

**Real inconsistency.** Losing positions never decrement the registry,
so the registry's `pwe_touch / pwe_no_touch` totals only ever go down
when a winner redeems. Long-term, the EWMA accumulates phantom
`payout_if_win` from losers who walked away. This inflates the
denominator of `v` over time, *under-charging* fees on future
positions.

### Recommended resolution

**Doc 02 should own this.** Update §4.2 `redeem_winner`:

> If `won == false`, also call `registry::record_close(registry,
> market.payout_multiplier_bps, position.side, position.payout_if_win,
> clock)`. Loser-side closes decrement the registry symmetrically.

OR: loser positions decrement the registry when the market settles
(doc 01 `lock_and_settle` PHASE 5 should call
`registry::record_close_all_losers(market, outcome_side)`). This is
cleaner because losers never need to call redeem; the registry can
clean up immediately.

Pick the latter. Add to doc 01 §2.2 PHASE 5:

> `registry::record_close_losers(registry, market, losing_side,
> losing_exposure, clock)` — decrements registry by the entire
> losing-side raw and PWE exposure in one call.

### Severity

**Should-fix.** Slow leak of denominator inflation; not catastrophic
in the first hours of a market but compounds over weeks.

---

## Q14 — `MarketSettled` event must fire from `lock_and_settle`, not from a separate path

### Question

Doc 07 §6.1 says `MarketSettled` fires from "`settle_market_hit`,
`settle_market_no_touch`, `settle_market_expired_void`." Doc 01 has
`lock_and_settle` (single function), no separate hit/no-touch entries.
Where does the event fire?

### Current state

Doc 07 §6.1 was written against v1's split state machine
(lock_settlement → settle_market_*). Doc 01 v2 collapsed those.

### Verdict

**Real inconsistency** in event-emission contract. The indexer (doc 09)
will be wired to listen for `MarketSettled` from a function that doesn't
exist in v2.

### Recommended resolution

**Doc 07 should own this.** Update §6.1:

> `MarketSettled` is emitted by `lock_and_settle` (doc 01 §2.2 PHASE 5)
> and by `settle_tournament_market` (doc 08). The `outcome` field is
> derived from `market.outcome_side`: `SIDE_TOUCH → HIT`,
> `SIDE_NO_TOUCH → NO_TOUCH`. There is no `EXPIRED_VOID` outcome in v2 —
> the lock-and-settle path always produces a touch/no-touch outcome
> (a market with no observation by expiry is treated as no-touch).

### Severity

**Should-fix.** Trivial doc fix; would be a Blocker if implementer wired
the event into a non-existent function.

---

## Q15 — Reserve top-up in Predict route is funded by what?

### Question

Doc 06 §7.4 introduces `Reserve<DUSDC>` to absorb Predict-route
shortfalls before pro-rata kicks in. Where does the reserve get funded?

### Current state

Doc 06 §7.4: "The protocol seeds a `Reserve<DUSDC>` shared object."
Doc 06 §4.3: early-unwind fee is 50 bps on the *promised* payout, sent
to `PROTOCOL_TREASURY`. That's a single address constant, not a
specifically-named reserve.

So early-unwind fees go to a treasury address; reserve is "seeded"
(once?) by some unspecified mechanism. There is no continuous funding
path.

### Verdict

**Real gap.** Reserve is a one-shot seed without replenishment. After
one bad reconciliation, the reserve is partly drained; after several,
it's empty and pro-rata kicks in for everyone.

### Recommended resolution

**Doc 06 should own this.** Add §7.4.1 funding mechanics:

> `Reserve<DUSDC>` is replenished by:
> 1. Initial seed: protocol treasury allocates X DUSDC at deployment.
> 2. Continuous: 100% of `early_unwind` fees collected on the BTC route
>    route to `Reserve<DUSDC>`, NOT to `PROTOCOL_TREASURY` as v1 said.
> 3. Optional: protocol treasury can top up via a permissioned
>    `Reserve::admin_top_up` function gated by `WickAdminCap`.
>
> Drawdown (doc 06 §7.4 already specifies) is capped at
> `max_per_window_cap` per reconciliation to prevent a single bad
> settlement from emptying the reserve.

Update doc 06 §4.3 fee destination accordingly: early-unwind fee →
`Reserve<DUSDC>`, not `PROTOCOL_TREASURY`.

### Severity

**Should-fix.** Without a funding loop, the reserve is decorative —
provides no real protection beyond the initial seed.

---

## Cross-cutting observations

### Where the docs are tightly aligned

- `Position` ownership / vault binding (doc 01 INV-18 + doc 02
  registry_id check + doc 06 ticket account_id check) all use the same
  pattern: pin an ID at create time, assert on every mutation.
- Tournament isolation (doc 04 §2.5 + doc 08 §1.5) is consistent: no
  Move path debits the main vault for tournament markets.
- Path observation freezing (doc 02 §2 + doc 05 referenced but not
  reviewed here) is a single, well-defined `frozen` flag with a
  load-bearing post-expiry guard.

### Where the docs need a coordinated revision pass

The biggest gap in the corpus is the **fee_router module**. It is named
in doc 03 and assumed to exist by every fee-emitting module, but no doc
specifies it. Q12 above is the recommended resolution; it implies a
small new module spec that doesn't exist in v2 yet (would be a "doc
03b" or new task #82 line item).

Second-biggest gap: the **`Position` representation** (Q7). Until that
is decided, doc 01 and doc 07 are talking about structurally different
objects with the same name.

Third: the **Predict-route ↔ Wick-vault conceptual boundary** (Q4, Q5,
Q15). Predict route is non-custodial and runs on its own funding
sources (Reserve<DUSDC>), but the docs blur the line. The cleanest fix
is a single section in doc 06 declaring: "Predict route is a wrapper,
not a Wick LP product. It does not interact with `MartingalerVault<C>`,
`WickStakingPool`, `InsuranceVault`, or the WICK mint curve. Its only
links to the rest of Wick are: (a) it shares `OracleVersionLock` and
`PathObservation` infrastructure; (b) early-unwind fees fund
`Reserve<DUSDC>` (a Predict-route-specific object); (c) traders are
advised in the UI that BTC trades do not earn WICK rebates."

### Severity summary

| Severity | Count | Items |
|---|---|---|
| Blocker | 4 | Q1 (fee snapshot timing), Q3 (impact fee destination), Q7 (Position type), Q12 (fee_router crank missing) |
| Should-fix | 9 | Q2, Q4, Q5, Q6, Q9, Q11, Q13, Q14, Q15 |
| Acceptable | 2 | Q8 (OTC vault scope), Q10 (Predict-route WICK mint) |

The four Blockers must be resolved before any Phase A or Phase B
implementation work begins. Should-fix items can be deferred until the
matching implementation phase but should be tracked as TODO-flagged
in the final spec.

### Doc ownership of the recommended revisions

| Doc | Revisions to incorporate |
|---|---|
| 01 (martingaler) | Q1 (PHASE 0 freeze+snapshot), Q2 (clear snapshot at stale release), Q7 (decide Position type), Q8 (INV-1 scope note), Q11 (default bounty_bps=0), Q13 (loser-side registry decrement) |
| 02 (impact fee) | Q13 (alternative: loser-side hook in redeem) |
| 03 (tokenomics) | Q3 (fee event taxonomy + remove settlement skim), Q10 (Predict-route mint exclusion), Q12 (fee_router::crank spec) |
| 04 (solvency) | Q9 (insurance ↔ wind-down link) |
| 06 (predict route) | Q4 (vault separation note), Q5 (reserve hard cap), Q15 (reserve funding loop) |
| 07 (clob) | Q7 (decide Position type), Q14 (event emitted by lock_and_settle) |
| 08 (gamification) | Q6 (tournament fee isolation) |

Most revisions are 1–3 paragraphs each. Doc 03 carries the heaviest
revision load because the fee_router was under-specified throughout.

---

*End validation. Next pass should re-read doc 01 §2.2 and doc 02 §1.2
together after the PHASE 0 insertion, then verify the complete
fee-event-to-staker payout path end-to-end.*
