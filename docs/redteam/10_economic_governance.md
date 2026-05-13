# Red Team — Economic & Governance Layer

Status: adversarial review.
Scope: cross-cutting concerns that don't live inside a single Move module — the
multi-day, multi-actor games the protocol invites once it's deployed at any
real scale. Anchors: every doc in `docs/design/` plus
`docs/redteam/03_oracle_path.md` (the keeper / oracle attack inventory) and the
papertrade research note in user memory.

The headline finding: Wick has *two* protocol-killers and neither is
exploitable in a single PTB. The first is the **mint-curve front-run**
(Attack 3) which creates a permanent supply-side wealth transfer measured in
8-figures-of-WICK before the protocol notices. The second is the
**queue-of-doom** (Attack 13) — a single correlated-flow tournament that
fills the FIFO queue beyond any plausible drain horizon, soft-bricking the
protocol's "winners always get paid" promise. Both succeed even with every
on-chain invariant intact. Both are coordination attacks, not code bugs.

Below: 14 distinct attacks, ranked by severity. The file ends with a Top-5
ranking across all red-team docs (this one + `03_oracle_path.md`).

---

## Attack 1 — LP Starvation Coalition (the Patient Cartel)

**Severity:** High (persistent value extraction; protocol stays solvent but
WICK supply dilutes against an empty treasury).

**Setup.** The Martingaler vault bootstraps from $0 by absorbing trader
losses. Every $1 of LP gain mints 100 WICK to the loser at the flat rate.
Stakers earn dividends from the 30% staker carve. The whole flywheel
**depends on traders losing more often than they win.** A coalition that
agrees to *only* take trades with positive EV — i.e. only when oracle latency
or barrier-distance creates an exploitable edge — never feeds the curve.

**Multi-step scenario.**

1. **Day 0–1 (recon).** Coalition of ~10 wallets monitors keeper push
   cadence and barrier distributions across all live markets. They build a
   heat map: which markets are mispriced *at the moment of the keeper push*.
2. **Day 2 onward (selective participation).** Each member opens positions
   only on `(market, side)` pairs where `decisiveness * barrier_distance` is
   small enough to clear the asymmetric-impact-fee floor (50 bps) net
   positive in expectation. They walk away from anything fair.
3. **Vault stays empty.** The Martingaler vault never accumulates surplus
   because the only inflows are from non-coalition retail. With 50% of
   trader stake from the coalition flipping to wins, expected vault drift
   collapses from `+0.755 × stake/trade` (per `04_solvency_proof.md` §3.3) to
   near zero, then negative as coalition share grows.
4. **Queue grows.** Every coalition win that would normally drain the
   treasury instead enqueues. `queue_total > 0` becomes the chronic state.
5. **Stakers leave.** Dividends dry up. WICK price drops. Coalition holds
   short via a CLOB order against retail bag-holders.

**Economic impact.** At 30% coalition share of volume, expected protocol
equity drift flips negative (back-of-envelope: with `m=1.8` and coalition
`p=0.65`, expected drift becomes `1 − 0.65 × 1.8 × 0.975 ≈ −0.14` per
stake unit). On $100k daily volume, that's **$14k/day of value leakage** to
the coalition, capped only by their ability to keep finding edge. Over a
month: ~$420k extracted. WICK token price tracks this drift through staker
exit; a 70% drawdown is plausible.

**Existing controls.** Asymmetric impact fee scales with `√v` (per
`02_asymmetric_impact_fee.md`) and decisiveness `m`. But the floor is 50 bps
— too low to discourage edge-only trading when the underlying mispricing is
≥ 100 bps. `f_max = 4.5%` only engages on enormous, decisive wins; coalition
members keep size small and split across wallets.

**Mitigation.**

- **Per-address rolling win-rate audit.** Indexer flags addresses with
  `>57%` win-rate (the §7.1 informed-flow critical threshold from
  `04_solvency_proof.md`) over a 30-day rolling window. Force a higher fee
  floor (e.g. 200 bps) for those addresses. This is governance via dynamic
  fees — visible to the user, justifiable as risk-pricing.
- **Sybil-resistant rate-limiting at the UI** isn't enough — the coalition
  can call into Move directly. The dynamic-fee mechanism *must* live
  on-chain in `fee_router`.
- Raise the base impact-fee floor to 100 bps. That's a 2x edge cost for
  coalition members, doubles the EV bar for participation.

**Cost-to-attacker.** Coordination cost only. ~10 sophisticated wallets,
weeks of recon, custom monitoring infrastructure. Capital cost: ~$50k of
working capital across wallets to seed the operation. ROI: positive within
30 days at the projected $14k/day extraction rate.

---

## Attack 2 — Whale Front-Run on the Mint Curve Threshold

**Severity:** Critical (one-shot, irreversible wealth transfer; defines
WICK supply distribution forever).

**Setup.** The mint curve has a $20k flat-region threshold and a 100 WICK/$
flat rate. Above $20k, the rate decays as `100 × (S / (S + H_excess))²` with
`S = $1.2M`. **The first $20k of cumulative LP gain mints 2M WICK
(1.6% of asymptotic supply) at the absolute peak rate.** A whale who can
front-run this threshold captures it.

**Multi-step scenario.**

1. **Day 0 (pre-launch).** Whale notices the mint curve published in
   `03_wick_tokenomics.md`. They stage one or more wallets with $20k+ of
   USDC.
2. **Day 1 (deployment + first market open).** As soon as the package is
   live and the first market accepts trades, whale opens 20 separate $1k
   losing positions through 20 wallets — all designed to expire
   out-of-the-money against thin protocol-seeded liquidity. They deliberately
   *trade against themselves* on opposite sides of paired markets so each
   $1k flow nets to ~$1k of LP gain (winners walk with their own stake +
   payout from the protocol; losers fund the gain).
3. **Within 24h of launch, before any retail discovers Wick**, the whale's
   wallets have absorbed the entire flat region and minted **2M WICK**.
4. **The 6h mint cooldown helps.** It means each wallet can only mint once
   per 6h. So 20 wallets ≈ 80 mints in 24h. The whale needs more wallets if
   they want to compress the timeline. Sybil cost is ~5¢/wallet on Sui;
   negligible.
5. **Whale stakes the WICK.** Subject to the 48h cliff and 7d unstake.
   While locked, whale earns 30% of all protocol fees forever.

**Economic impact.** 2M WICK ≈ 1.6% of asymptotic supply. At a hypothetical
mature WICK price of $0.10 (a $12M FDV at 122M cap), that's **$200k of
extracted value per attacker**. But the real damage is *concentration*: the
2M WICK staked permanently captures 30% of fees for whoever held it, in a
protocol where total expected supply earning dividends is ~10M WICK in the
first year. The whale earns **~16% of all dividends in perpetuity** for a
$20k cost, until the cap binds.

**Existing controls.**

- 6h mint cooldown per address — Sybil-defeated.
- 48h cliff before dividends accrue — irrelevant; whale holds for years.
- 7d unstake delay — irrelevant for the same reason.
- 30% lifetime claim ceiling — caps the *whale's own* dividend extraction
  at 30% of $20k = $6k. **But the whale's claims still count against
  staker_share!** When the whale's claim hits the ceiling and goes
  un-claimable, those forfeited dividends "stay in the pool" — meaning they
  go to *other* stakers, who at this stage are mostly the whale's other
  Sybil wallets. The 30% cap is bypassed by Sybil as long as the cap is
  per-address rather than per-funder.

**Mitigation.**

- **Genesis-week dampener.** For the first 7 days post-launch, the flat
  rate is reduced 10x (10 WICK/$ instead of 100). Resets the front-run EV.
- **Split-loss detection.** Indexer flags trades where the same funding
  source (KYT-style heuristics off-chain) is on both sides of paired
  markets within the same epoch. Mints those losses at the *decayed* rate
  even while H is below threshold. Hard to implement permissionlessly but
  possible via opt-in protocol multisig.
- **Replace the flat region entirely** with a smooth `(S / (S + H))²` from
  H=0. Removes the front-run EV cliff. The cost: less dramatic
  "first-100 traders" narrative, but the curve is still clearly
  early-trader-favoring.

**Cost-to-attacker.** ~$20k-25k of capital tied up for ~24h, plus gas
(~$5 on Sui). Net ROI per dollar: ~10x in extracted dividend NPV. **The
single most lopsided attack in this document.**

---

## Attack 3 — WICK Token Dividend-Pump Manipulation

**Severity:** High.

**Setup.** WICK earns USDC dividends from the 30% staker carve. The dividend
flow is observable on-chain (`FeeAccrued`, `FeeDistributed` events) but the
*timing* of when fees deposit into the staking pool is gameable: protocol
fees accumulate, then someone calls `deposit_fees(coin)` to credit the
`acc_per_wick` accumulator.

**Multi-step scenario.**

1. **Whale stakes 5M WICK** (assume mid-life supply: ~5% of total stake).
2. **Whale sees fee buckets accumulating**, e.g. 3 days of fees pending in
   the `protocol_fees` and `staker_fees` balances on the
   MartingalerVault. Off-chain dashboards expose this.
3. **Whale times the deposit.** Whoever has authority to call
   `deposit_fees` (protocol multisig, or a permissionless cron) drops the
   accumulated fees in one chunk at moment T.
4. **Whale buys WICK on CLOB at T-1**, marks up the order book to suggest
   "DIVIDEND INCOMING," tweets the deposit. Retail FOMOs.
5. **At T**, the deposit lands. Whale's already-staked position captures
   peak `acc_per_wick` jump because they were earliest staker.
6. **Whale dumps WICK on retail at T+1.** Captured dividend value via WICK
   price pump.

**Economic impact.** Hard to size without a price discovery model, but
analogous Olympus / OHM-style "rebase pump" patterns historically extract
20-50% of the dividend flow value in price action over an hour. On a $50k
weekly dividend deposit, that's **$10k–$25k per pump cycle**, repeatable
weekly.

**Existing controls.**

- 48h cliff means whale must have staked *before* seeing the fee buildup.
  This cuts the window: whale can only stake up to T-48h, then time the
  trumpet. Reduces the attack to a slower swing trade — still profitable.
- 7d unstake is *not* protective here because whale doesn't unstake; they
  pump WICK price and dump on the *unstaked, freely-traded* secondary WICK
  market.

**Mitigation.**

- **Continuous deposit.** Make `deposit_fees` happen automatically on every
  fee accrual — e.g. inline at `redeem_winner`. Removes the discretionary
  timing surface entirely. Modest gas cost, completely defeats the attack.
- If continuous deposit is infeasible: **mandatory random deposit
  scheduling.** A `crank_deposit` callable by anyone, whose execution time
  is gated by `sui::random` so attackers can't predict the next deposit
  block.

**Cost-to-attacker.** Capital to stake (5M WICK ≈ $500k at $0.10), plus the
opportunity cost of the 7d unstake. Operational cost: nominal. ROI:
$10k–25k per cycle, weekly cadence — break-even on capital deployment in
~6 months, then pure profit.

---

## Attack 4 — Vampire Fork via Higher Mint Rates

**Severity:** Critical (full liquidity drain; protocol becomes a husk).

**Setup.** Wick has no Sui-specific moat at the Move source level once the
package is verified. Anyone can publish a near-identical package with a
*higher* `flat` mint rate or a *higher* `T` threshold. AGENTS.md bans the
*word* "fork" inside the codebase but does not (and cannot) prevent
external actors from doing exactly that.

**Multi-step scenario.**

1. **Day 0 (vampire).** Attacker publishes "WickPlus" with `flat = 200 WICK/$`
   (2x mint rate) and `T = $200k` (10x threshold). Identical product
   surface; their LP carve is also 60% so LPs/winners aren't worse off.
2. **Day 0 + 1h.** Attacker airdrops 50 SUI of testnet gas to every
   address that has interacted with Wick in the last 30 days, alongside a
   one-PTB "claim your bonus on WickPlus" link.
3. **Day 1–7.** A trader who would have lost $100 on Wick (and minted 10k
   WICK at flat rate) instead loses $100 on WickPlus (and mints 20k WICKP).
   Same loss, 2x token receipt. Rational trader migrates instantly.
4. **Day 7+.** Wick's volume collapses. Stakers see dividends fall. They
   unstake (7d delay) and migrate. Protocol dies of liquidity starvation.

**Economic impact.** Total Wick volume migrated. With nothing differentiating
Wick from a clean fork beyond brand and the curated UI, migration latency is
days, not months. Protocol revenue → zero. WICK token → zero.

**Existing controls.** None at the protocol layer. UI curation is the only
moat, and that moat collapses if the vampire builds a better-looking UI.

**Mitigation.**

- **Protocol-owned identity moat.** Brand, integrations, the BTC route
  composition with DeepBook Predict (which is *itself* unforkable without
  Predict's permission), tournaments with real prize sponsors, off-chain
  partnerships.
- **WICK token vesting / migration penalty.** Stakers who unstake to
  migrate to a fork lose accrued dividend rights. (Already partially in the
  spec via the 7d delay; could be widened.)
- **Pre-emptive forks.** Wick deploys "WickPlus" themselves as a v2 with
  better economics, capturing the vampire surface internally. Standard
  defense-via-self-cannibalization.

**Cost-to-attacker.** ~$500–$5,000 in Sui gas + audit + UI build. Trivial.

---

## Attack 5 — Liquidity Flight at $20k Threshold

**Severity:** Medium (predictable transient pain; system recovers).

**Setup.** At cumulative LP gain `H = $20k`, the marginal mint rate drops
from 100 WICK/$ to ~99.99 WICK/$ (smooth transition). But the *psychological*
cliff is real because every public dashboard will display "flat region:
$X / $20,000." Traders watching that gauge will treat it as a deadline.

**Multi-step scenario.**

1. **Day 0 (H = $19,500).** Public dashboards show "$500 of flat-region
   mint remaining." A swarm of small losers race to be the last in.
2. **Within minutes**, frontrunning bots open and close losing positions
   in 30s arcade markets to capture the last few hundred dollars of
   peak-rate WICK.
3. **Day 0 + 5min (H = $20k).** Threshold crossed. Traders who *missed*
   the threshold leave Wick entirely — not because the next $1 is much
   worse (it isn't, locally) but because the *narrative* has shifted from
   "early adopter premium" to "the rate is decaying."
4. **Volume drops 30-60% over the following week.** Vault stops growing.
   Queue, if any, doesn't drain.

**Economic impact.** Volume drop = revenue drop ∝ to the volume drop.
On a $100k/day baseline, a 50% drop for 30 days = $1.5M of foregone fees
across the protocol. Stakers see dividend flow halve. Recovery requires a
new narrative (tournaments, partnerships).

**Existing controls.** None — the cliff is in the spec.

**Mitigation.**

- **Smooth from H=0.** Per Attack 2's mitigation. Removes both the
  front-run *and* the threshold-flight problem.
- **Counter-narrative tooling.** Public-facing dashboards should suppress
  "flat region remaining" framing and lead with absolute-rate displays
  ("currently 87 WICK/$"). Marketing problem, but a real one.

**Cost-to-attacker.** $0 — this is emergent, not coordinated.

---

## Attack 6 — Cross-Protocol Arbitrage Drains the Vault

**Severity:** High.

**Setup.** Wick lists touch / no-touch markets on barriers that overlap with
existing Polymarket / Kalshi / sportsbook lines. When the same outcome can
be expressed both ways, sharper prices on the deeper venue let an arber
guarantee positive EV against Wick's vault.

**Multi-step scenario.**

1. **Polymarket** shows "BTC > $70k by Friday: 45¢" — implied probability
   45%.
2. **Wick** offers TOUCH-ABOVE $70k by Friday at multiplier 1.8x —
   implied probability ~55.6% (since $1 stake → $1.80 payout requires
   `1/1.80 = 55.6%` to break even).
3. **Arbitrageur sells $1k of Polymarket "Yes"** (collecting 45¢ × $1k =
   $450 if "No" wins, paying $550 if "Yes") and **buys $556 of Wick TOUCH**
   ($556 stake → $1000 payout if Touch). The two positions cover both
   outcomes for ~$0 net cost, locking in the spread.
4. **Wick's vault eats the loss.** Whichever side wins, Wick pays out from
   `treasury`; Polymarket's pool eats the other side. The arber walks with
   the spread (~$94 on a ~$1k notional, before fees).

**Economic impact.** Per arb cycle: $50–$200 net at typical spreads, on
~$1k notional. With $100k/day Wick volume, ~$5–20k/day of EV transfers
out. Annualized: **$1.8M–$7.3M** of value flowing to arbers.

**Existing controls.** Asymmetric impact fee scales with vulnerability and
decisiveness. For arber positions sized small relative to the vault, both
are low → fee floors at 50 bps. Doesn't dent arb spreads of 5-10%.

**Mitigation.**

- **Vault-aware quoting.** When the implied probability across markets
  diverges by > X bps, *raise* Wick's payout multiplier on the favored side
  (i.e. quote tighter to the cross-venue implied price). Requires an
  off-chain price aggregator + protocol multisig to update
  `payout_multiplier_bps`. Operationally heavy, breaks the "fixed
  multiplier" UX.
- **Higher base fee on size > $X.** Raises the floor for arb-sized
  positions.
- **Accept the leak as the price of being a price-taker.** Most binary
  markets eat this — Polymarket-Kalshi arbs run constantly. Wick's
  position: monetize via volume, accept the spread leak.

**Cost-to-attacker.** Operational only — running a cross-venue arb desk.
Capital recycles every market cycle.

---

## Attack 7 — Tournament Prize-Sharing Cartel

**Severity:** High (concentrated value extraction from gamification surface).

**Setup.** Tournaments pay 30/18/12/5×7 = top-10 distribution on the entry
pot. With many entrants, expected payout per random participant is < entry
fee minus rake. A coordinated cartel can guarantee top-3 placement by
splitting trades.

**Multi-step scenario.**

1. **Cartel of 10 wallets** all enter the daily 1-SUI tournament. Total
   entry: 10 SUI. Pot: 10 SUI + n_others × 1 SUI.
2. **At lock-in**, cartel coordinates off-chain (Discord, Signal):
   - Wallets 1, 2, 3 all open identical large TOUCH-ABOVE positions on
     market $A$.
   - Wallets 4–10 all open identical large NO_TOUCH positions on market $A$.
   - Sibling positions split risk across markets $B$, $C$, $D$, $E$ to
     guarantee at least one of the cartel wallets ends top-3 on aggregate
     PnL across the basket.
3. **Settle.** One side wins on each market. By spreading bets across
   five markets and ten wallets, the cartel *guarantees* that at least
   three of their wallets are in the top-10 PnL bracket (the math:
   guaranteed top-3 if the variance is tight enough; even worst-case, top
   spread of ~5 wallets in top-10).
4. **Cartel collects 30+18+12 = 60% of pot from #1-#3 alone.** With 100
   non-cartel entrants paying 1 SUI each, pot = 110 SUI. Cartel collects
   66 SUI on 10 SUI entry cost. Net: +56 SUI.
5. **Off-chain redistribution.** Cartel members redistribute proportionally
   to their pre-agreed shares.

**Economic impact.** Per tournament: ~$50–$500 of value transferred to
cartel from random participants. Daily tournaments × 365 days: **~$18k–
$182k/year transferred to a single cartel.** If multiple cartels form,
they cannibalize each other but the value still flows out of random retail.

**Existing controls.**

- Per-entry stake cap (`entry_fee × 100`). Doesn't block coordination.
- WICK staking gate for prize eligibility. Cartel just stakes WICK on each
  wallet — fixed cost per wallet but recoverable.
- 5-bp anti-wash filter (positions with same address on both sides within
  5min) in `08_gamification.md` §7. Doesn't catch *different addresses* on
  both sides.

**Mitigation.**

- **Cluster detection at the indexer.** Flag tournaments where the top-N
  wallets show on-chain funding-source clustering (e.g. all funded from the
  same prior address within the past 30 days). Forfeit prizes; redistribute
  to the unclustered top-10. Requires off-chain heuristics + moderator
  override.
- **Random tiebreaker for prizes.** Top-3 paid identically; positions 4-10
  drawn at random from the next 50 entrants. Reduces cartel certainty.
- **Smaller, more frequent tournaments** with smaller pots. Per-tournament
  EV from cartel formation drops below coordination cost.

**Cost-to-attacker.** ~10 wallets × ~1 SUI gas + WICK staking floor.
Coordination cost (Signal channel, planning). Trivial vs daily payout.

---

## Attack 8 — Governance Bribe of AdminCap

**Severity:** Critical (single corrupt action can wipe an entire market).

**Setup.** AGENTS.md states "Admin cap exists for risk parameter changes,
narrow scope." The narrow scope (per `04_solvency_proof.md`) includes
`max_side_exposure_pct` (α) and `max_single_position_pct` (β). A briber
finds a market they can win big on, then pays the admin to relax these
caps.

**Multi-step scenario.**

1. **Attacker identifies a high-conviction edge** — e.g. they've front-run
   a Pyth feed and know BTC will touch a barrier in the next epoch.
2. **Attacker stakes $50k on TOUCH** under the current `β = 0.5%` cap on
   a market where the vault has $10M, so cap allows ~$50k position.
3. **Attacker bribes the admin** to flip `β = 100%` for that single
   market (or for a brief window across all markets) for $100k.
4. **Attacker re-opens at maximum size**: their position now becomes a
   $10M payout claim against a $10M vault. They win.
5. **Vault → 0**, queue absorbs the rest. Other open positions enqueue and
   wait for a refill that may never come.

**Economic impact.** Up to **the entire vault balance per attacked market**.
On a $10M vault: $10M extracted, divided between attacker and admin per
the bribe agreement. Bribe of $100k captures $9.9M of net value transfer.

**Existing controls.**

- AdminCap is a `key, store` object — bearer authority. Loss/theft = same
  as bribe.
- "Narrow scope" is a documentation claim, not a Move-enforced bound. The
  admin can change *any* parameter exposed via setter functions.
- No timelock on admin actions.
- No multisig.

**Mitigation.**

- **Hard-coded bounds on admin setters.** `assert!(new_beta <= 0.01)` in
  the setter itself — admin can lower or raise *within a bounded range*,
  not arbitrarily. Any change beyond bounds requires a package upgrade.
- **Timelock all admin parameter changes** by ≥ 24h. Posts a public
  warning event; gives traders time to exit the affected markets.
- **Multisig the AdminCap.** 3-of-5 protocol multisig with at least one
  external signer (auditor, partner). Bribery cost increases at least
  proportionally to multisig size.
- **No per-market parameter overrides.** Risk params are global only; any
  change affects all markets symmetrically. Removes the "bribe to whitelist
  one market" surface entirely.

**Cost-to-attacker.** Bribe ($100k+) plus position cost ($50k pre-attack).
ROI: ~50x. The single highest-leverage action in the whole document.

---

## Attack 9 — Malicious Package Upgrade as Backdoor

**Severity:** Critical (if upgrade authority is compromised, full drain).

**Setup.** Sui packages have an upgrade authority (`UpgradeCap`) by default.
Whoever holds it can publish a new version of the same package. State
objects (`Market`, `Position`, vaults) persist across upgrades. The new
package can introduce migration logic that "fixes a bug" by silently
transferring vault balances.

**Multi-step scenario.**

1. **Attacker compromises the UpgradeCap holder** — same paths as
   AdminCap (key theft, social, supply chain).
2. **Attacker publishes a "v2.1 critical bug fix"** package. The migration
   function `fix_vault_accounting(market: &mut Market<C>)` is described as
   "rounding error correction" but actually transfers `treasury.value() *
   0.99` to the attacker's address.
3. **Attacker calls the migration** on every market. Drains within minutes.

**Economic impact.** Total TVL across all markets in vaults using the
upgraded package. Catastrophic.

**Existing controls.** `02_asymmetric_impact_fee.md` and other docs
mention multisig "in production" but the MVP ships with single-deployer
upgrade authority per AGENTS.md and the testnet artifact note.

**Mitigation.**

- **Burn the UpgradeCap post-MVP.** Make the package immutable. Cleanest
  defense; requires perfect first deploy. The Darbitex/D pattern already
  documented as "post-MVP" exactly describes this.
- **Timelock + multisig the UpgradeCap.** Same shape as AdminCap mitigation.
- **Public, mandatory upgrade-preview window.** Every upgrade hash must be
  published on-chain `≥ 7 days` before activation; any LP / staker can
  withdraw during the window. Aligns incentives — legitimate upgrades
  survive; backdoors get rejected.
- **Move-prover validation of state-touching migrations.** Any migration
  that touches `treasury.value` requires an attached proof that vault
  balance is non-decreasing. Not implementable for free, but the only
  cryptographic defense.

**Cost-to-attacker.** Whatever it costs to compromise the UpgradeCap. Could
be $0 (insider) to $1M+ (sophisticated supply-chain attack on the build
pipeline). ROI: ~100x against TVL.

---

## Attack 10 — Insider Keeper Front-Run on the CLOB Secondary Market

**Severity:** High.

**Setup.** Wick lists `Position<M, Side>` coins on DeepBook v3 CLOB for
secondary trading (`07_deepbook_clob.md`). The keeper sees touch events
*before* `BarrierTouched` lands on-chain (the keeper has the off-chain
Pyth Lazer feed at ~10 Hz; the on-chain emit is at the keeper's discretion
on a ~5 s cadence). This creates a window where the keeper knows the
outcome and the CLOB doesn't.

**Multi-step scenario.**

1. **Keeper sees Lazer print** that crosses the barrier at off-chain time
   `T`. The on-chain `BarrierTouched` won't fire until the keeper calls
   `path_observation::record` at, say, `T + 4s`.
2. **Keeper buys NO_TOUCH position coins** on DeepBook in the 4-second
   window between `T` and `T + 4s`. Sellers (uninformed retail) think
   NO_TOUCH still has a 50/50 chance; keeper knows it's worth zero.
3. **Keeper sells TOUCH position coins** in the same window — sellers
   think TOUCH is 50/50, keeper knows it's 100%.
4. **Keeper calls `record`** at `T + 4s`. Touch fires, NO_TOUCH coins worth
   zero, TOUCH coins worth payout. Keeper redeems the TOUCH coins they
   bought + has zero exposure on NO_TOUCH coins they sold (already
   delivered).

**Economic impact.** Per touch event: keeper extracts the bid-ask spread
+ the realized outcome from anyone who traded against them in the window.
On an active market with $10k of CLOB depth, ~$1–5k per touch. Active
markets see touches several times daily. **$10k–$50k/day** of free EV.

**Existing controls.** None. Per `03_oracle_path.md` Attack 7 ("race-to-
record front-running"), this is recognized at the path-recording layer
but not at the CLOB-trading layer.

**Mitigation.**

- **Mandatory keeper publish-then-trade lockout.** Keeper key cannot
  trade on Wick markets. Hard to enforce on-chain (keys aren't
  identifiable as keeper keys). Soft enforcement via attestation: keeper
  publishes a public statement of trading wallets; community / community
  multisig slashes keeper bond on violation.
- **Trustless keeper / auction-based ticking.** Anyone can `record` —
  partially in v2 already. The off-chain edge persists for whoever
  watches Lazer most efficiently, but the *keeper's* edge collapses to
  the public edge.
- **CLOB trading freeze before tick deadline.** When `path::record` hasn't
  been called for > X seconds and a price tick > X seconds old exists in
  Lazer, freeze CLOB trading on that market via a circuit breaker. Hard to
  implement (CLOB is DeepBook, not Wick), but possible via Wick-side
  CLOB-pause delegation.

**Cost-to-attacker.** Already paying gas to operate the keeper. Marginal
cost of the front-run trade: gas only. ROI: pure profit.

---

## Attack 11 — Insider Market-Creator with Selective Audience

**Severity:** Medium-High.

**Setup.** Permissionless market creation means anyone can create markets
with any barrier and any expiry. Sophisticated creators choose barriers
where they have informational edge (e.g. they know an off-chain catalyst is
coming) and quietly trade against early entrants who don't.

**Multi-step scenario.**

1. **Insider creates a market** "BTC TOUCH-ABOVE $X by Friday" where they
   have non-public information that BTC will *not* touch X.
2. **Insider trades NO_TOUCH** at maximum size right after creation,
   getting first-mover pricing.
3. **Insider promotes the market** through controlled channels (Discord,
   Telegram) under the framing "free money for TOUCH" — recruiting
   uninformed TOUCH counterparties.
4. **Friday passes.** No touch. Insider wins; promoted retail loses.

**Economic impact.** Per insider operation: limited by market size and
trader recruitment. Extractable wealth per cycle: $5k–$50k.

**Existing controls.**

- Listing tier in `03_wick_tokenomics.md` §4.2: featured markets require
  50k WICK bond. Increases insider capital cost but doesn't prevent the
  attack.
- UI curation. Insider markets remain unindexed unless promoted through
  bonded listing.

**Mitigation.**

- **Mandatory disclosure for listed markets.** Featured markets require
  the creator to disclose that they have an open position in the market.
  Voluntary; relies on community policing.
- **Auto-quote tightening on creator-side trades.** When the market
  creator opens a position in their own market, raise the impact-fee
  floor on their wallet by 200 bps. Mild disincentive; doesn't break
  legitimate market making.
- **Time-delayed market activation.** Markets created cannot accept trades
  for the first hour after creation. Removes first-mover edge for the
  creator.

**Cost-to-attacker.** ~$50k in WICK to bond a featured listing, recoverable.
Operational cost: low.

---

## Attack 12 — Coordinated Stake / Dividend Squeeze

**Severity:** Medium (the 7d unstake delay defangs most of this).

**Setup.** Stakers earn USDC dividends pro-rata. A coordinated group could
stake hard right before a known fee-deposit event, claim the dividend, then
unstake en masse. The 7d unstake delay defeats the naive version. But the
*claim* is decoupled from the unstake — claim is instant.

**Multi-step scenario.**

1. **Cartel observes accumulating fee buckets** (per Attack 3, the timing
   surface is observable).
2. **Cartel members all stake** simultaneously, expanding `total_staked`
   by, say, 10x.
3. **Wait 48h** (cliff). During this time, no new dividend deposit
   happens (cartel hopes).
4. **Deposit lands**: dividend per WICK drops 10x because the denominator
   exploded. But cartel's *share* of dividend captured = (their stake) /
   (total stake) — proportionally what they put in.
5. **Cartel claims**, then initiates unstake (7d delay), and during the
   delay, original stakers — diluted — leave.

**Economic impact.** This attack actually *doesn't extract value* in the
naive form because per-WICK dividends scale by total_staked, so doubling
stake captures only a fair share of any subsequent flow. The attack
*does* extract value if cartel can coordinate to time the dividend deposit
(see Attack 3). Standalone, severity is low.

The version that *does* extract value: cartel pre-stakes, then **uses
their voting power** (if WICK gains governance) to freeze new staking,
trapping the diluted base. Out of scope until governance ships.

**Existing controls.** 7d unstake delay makes coordinated exit visible
and slow. 48h cliff reduces alignment between stake-time and dividend-
time. 30% lifetime claim ceiling caps individual extraction.

**Mitigation.**

- **Continuous fee deposit** (Attack 3 mitigation) defeats the timing
  vector entirely.
- **Stake-weighted dividend rights with vesting** (à la Curve veCRV): only
  long-staked WICK earns full dividend share; freshly staked WICK earns
  fractional share until vested. Adds complexity but neutralizes flash-
  stake attacks.

**Cost-to-attacker.** Capital cost to stake; opportunity cost of the
unstake delay.

---

## Attack 13 — Queue-of-Doom: Permanent Insolvency via Tournament

**Severity:** Critical (protocol-killing, no clean recovery path).

**Setup.** The Martingaler vault tolerates negative equity by enqueuing
unpaid winner obligations. The queue is FIFO and drains via future losing-
side stake (`harvest`). The queue's drain rate is bounded by daily volume.
**A single tournament where everyone wins on the same side blows the queue
beyond any plausible drain horizon.**

**Multi-step scenario.**

1. **Tournament market spawns** with 5 paired barriers, vault seed $1k
   per market. Tournament entry fees create another $5k of seed.
2. **Random-walk path happens to wick all five upper barriers within the
   5-min window.** Every TOUCH-ABOVE entrant on every market wins. Every
   NO_TOUCH-ABOVE entrant loses, but they're vastly outnumbered (the
   wick attracted speculators).
3. **Total winning payout obligation across markets:** assume 500 entrants
   averaging $20 each on TOUCH-ABOVE, payout 1.8x = $18k payout per
   market. Five markets: **$90k payout obligation.**
4. **Vault has ~$50k** (seed + losing-side stakes from this round).
   Shortfall: **$40k enqueued.**
5. **Daily volume on Wick is $10k.** Drain rate per
   `04_solvency_proof.md` §5: queue equal to daily volume drains in ~30
   hours. Queue equal to **4 days of volume drains in ~5 days.**
6. **Reputational cascade.** During those 5 days, every Wick user sees
   "82% funded, 18% pending" on their UI. Word spreads. Daily volume
   *drops* to $2k. Recalculated drain time: **25 days.**
7. **WICK token** (which is the equity-claim token) collapses. Stakers
   see "$X owed but undrainable" and exit. New trader inflow to fund the
   queue dries up because the protocol *looks* insolvent (and in any
   meaningful sense *is*).
8. **Queue crystalizes.** No new losers are coming. Queue stays at $40k
   forever. Wick is a zombie.

**Economic impact.** $40k of crystallized debt the protocol cannot pay.
Reputational cost: total. Recovery requires either external recapitalization
or queue forgiveness (haircut to winners), which violates the "winners
always get paid" promise that is the load-bearing claim of the Martingaler
design.

**Existing controls.**

- Per-market OI cap (`α = 10%` of vault). Per `04_solvency_proof.md` §3.2,
  fully one-sided cap-binding flow on a single market still leaves equity
  positive. **But that analysis assumes a single market.** The tournament
  fans out across 5 markets, all correlated to the same random walk. Cap
  binds per market; aggregate OI = `5 × α × V = 0.5 × V` — half the vault
  immediately at risk.
- §7.5 of the same doc explicitly flags this: "correlated multi-market
  flow (the underrated risk)." Recommended mitigation: global OI cap per
  `(underlying, side)` of `α_global ≤ 25%`. **Not implemented.**
- Insurance bucket capped at $50k. Could partially cover the $40k
  shortfall — *if* the insurance bucket has accumulated. At hackathon
  scale it likely hasn't.

**Mitigation.**

- **Implement the §7.5 global OI cap** before tournaments ship. Hard
  invariant; protects the vault's ability to honor correlated wins.
- **Tournament-specific safeguard.** Tournament markets share their seed
  with each other (one shared vault for the tournament, not five). Caps
  total tournament-related obligation at `tournament_seed × m`.
- **Pre-funded tournament reserves.** Sponsors / protocol commit a USDC
  reserve before tournament lock-in equal to `max_payout_obligation`.
  Doesn't bootstrap from $0 but ensures solvency.
- **Queue size cap with circuit breaker.** When `queue_total > 20% of
  V`, halt new opens (per `04_solvency_proof.md` parameter table).
  Doesn't shrink the queue but prevents it from growing further while
  deadbeat winners wait.
- **Bankruptcy / haircut clause in product terms.** Painful UX but the
  only honest answer to the impossibility of cash-flow recovery. Cap at,
  e.g., "if queue is > 50% of V for > 30 days, all queue entries get a
  pro-rata haircut to bring queue ≤ 50% of V." The protocol survives;
  the winners share the loss. **This must be disclosed in the README at
  launch** or it's fraud.

**Cost-to-attacker.** This isn't really an *attack* — it's a normal
tournament with bad luck. Cost: zero. **That's why it's the worst finding.**

---

## Attack 14 — Sybil-Spawn Mint Farming

**Severity:** Medium (caps and cooldowns work, but combine badly with
tournaments).

**Setup.** Per `03_wick_tokenomics.md` §5.3, Sybil farming for WICK is
explicitly tolerated: the curve splits a fixed loss across N wallets but
mints proportionally fewer per wallet. A trader can't beat the curve via
Sybil. **But** Sybil is still useful for *avoiding the 6h mint cooldown*
and for *concentrating leaderboard / tournament EV*.

**Multi-step scenario.**

1. **Attacker spawns 10,000 wallets** at ~5¢ each Sui rent. ~$500 cost.
2. **Each wallet** opens one $10 losing trade per day, minting ~1,000
   WICK per wallet per day (flat region).
3. **Aggregate**: 10M WICK/day mintage to attacker, with a $100k/day
   loss to the protocol's vault. Net to attacker: WICK + 30% of those
   losses recycled as future dividends if WICK is staked.
4. **In tournament context**, 10k wallets means 10k tournament entries
   in any "open to all" tournament. Cartel guarantees top-10 (Attack 7
   amplified).
5. **In leaderboard context**, 10k wallets enable wash-trade volume
   inflation (despite anti-wash filters: cross-wallet wash via funding
   sources isn't fully detectable).

**Economic impact.** Low per-cycle, high cumulative. Per day: ~$100k of
protocol losses recycled into a single attacker's pocket as WICK + share
of dividends + tournament EV. Annualized: tens of millions if tolerated.

**Existing controls.**

- 6h mint cooldown per address — Sybil bypasses by spreading.
- 30% lifetime claim ceiling per address — Sybil bypasses.
- Anti-wash filter at 5-min same-address window — Sybil bypasses by using
  different addresses.

**Mitigation.**

- **Funding-source clustering** at the indexer (off-chain). Apply
  cooldowns/caps at the *cluster* level, not the address level.
  Implementation: see Chainalysis-style heuristics; trade-off is requires
  an opinionated off-chain authority.
- **Optional WICK stake floor for trade eligibility on premium markets.**
  Sybil cost = (stake floor) × (number of wallets). Linear barrier.
- **POH (proof-of-humanity) gate** for top-tier features. Optional, opt-
  in. Keeps the open-by-default ethos.

**Cost-to-attacker.** $500 in wallet rent + ongoing trade gas (~$50/day).
ROI: positive within 1 day at $100k/day extraction.

---

## Top 5 Most Dangerous Attacks Across All Vectors

Combining this document with `docs/redteam/03_oracle_path.md`, ranked by
worst-case protocol damage and difficulty of recovery:

### #1 — Compromised KeeperCap silently rewrites oracle truth
*(Attack 1 in `03_oracle_path.md`)*

A single bearer-cap object holds the keys to every Lazer-driven market's
truth. No multisig, no on-chain attestation verification, no rotation. Cost
to attacker: whatever it costs to phish one operator. Impact: total open
notional on every Lazer-driven market in one expiry window. **The single
worst attack in the entire red-team corpus** because (a) the blast radius
is "every market," (b) recovery requires recapitalization the protocol
hasn't pre-funded, and (c) the attack leaves no on-chain proof — the
`attestation` field is a black box.

**The reason this stays at #1:** a vault drain is recoverable if you can
prove fault and slash the actor. With KeeperCap, you can't prove fault
without reproducing the off-chain Lazer signature manually, which by then
the funds are gone.

### #2 — Queue-of-Doom permanent insolvency *(Attack 13 here)*

The Martingaler design promises winners always get paid, eventually. A
single tournament with correlated flow falsifies that promise without any
adversarial action. Once the queue exceeds plausible drain horizon,
reputation collapses, volume collapses, queue calcifies. **No recovery
without violating the core promise** (haircut winners) or external
recapitalization. Worse than #1 in one dimension: it requires no attacker
at all — it's an emergent property of the design under correlated load.
The §7.5 global OI cap mitigation exists in `04_solvency_proof.md` but is
not implemented and **must be a launch-blocker**.

### #3 — Whale Front-Run on the Mint Curve Threshold *(Attack 2 here)*

Permanent, irreversible wealth transfer of ~16% of all WICK dividends in
perpetuity to a single $20k attacker. Sets the WICK distribution forever
in the first 24 hours of protocol life. Can never be undone post-mint.
Stakeholders won't notice until they discover that a single address holds
2M+ WICK that nobody saw being earned through real losses. The
attacker's optics damage to the "fair launch" narrative is as bad as the
direct economic damage.

### #4 — AdminCap Bribe to Lift Risk Caps *(Attack 8 here)*

One corrupt action; one market drained. Up to vault-balance per attack.
Documented as "narrow scope" but the scope is not Move-enforced. The
single most leverage-dense attack: ~$100k bribe → ~$10M extraction at
typical mature scale. Mitigation requires hard-coded bounds in setters
plus multisig — mechanical, but not in MVP.

### #5 — LP Starvation Coalition *(Attack 1 here)*

The slow killer. No single moment of crisis; just a persistent ~$14k/day
of value leakage to a sophisticated cartel that only takes positive-EV
trades. Vault never grows. WICK token slowly bleeds out as stakers see no
dividend flow. Hard to detect (each individual trade looks normal); harder
to mitigate (dynamic per-address fees feel like censorship). The
protocol-level analog of "DEXes get sniped by MEV bots until they die."

---

## What this document recommends for launch

Do not deploy without:

1. The §7.5 **global OI cap** from `04_solvency_proof.md` (kills #2 above).
2. **Hard-coded bounds on every admin setter** + multisig the AdminCap
   (kills #4).
3. **On-chain Lazer signature verification** in the pull-oracle driver, or
   if not feasible by ship date, a 2-of-3 multisig wrapper around the
   KeeperCap (degrades #1 from critical to high).
4. **Genesis-week mint-rate dampener** OR replace the flat region with a
   smooth curve from `H = 0` (defangs #3).
5. A **bankruptcy / haircut clause** disclosed in the README (acknowledges
   #2's residual risk honestly and converts it from product fraud to
   product term).

Without 1, 2, and 5, Wick at any scale beyond hackathon demo is a question
of *when*, not *if*, the queue calcifies or the cap gets bribed open.
Accept these as launch blockers.

The remaining attacks (3, 5–7, 9–12, 14) are governance / monitoring
problems that can be addressed iteratively post-launch — they extract
value but don't kill the protocol outright.

---

*End red-team pass.*
