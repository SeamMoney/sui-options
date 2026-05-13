# Red Team — WICK Token, Mint Curve, and Staking Dividends

> Adversarial review of `docs/design/03_wick_tokenomics.md` (v0.1 draft).
> Read this **before** implementing `wick_token.move` or `wick_staking.move`.
> Every attack here either (a) bypasses the Layer 1–5 anti-loop story
> outright, (b) costs the protocol an order-of-magnitude more WICK supply
> than the curve graph suggests, or (c) extracts dividends with a
> negative-cost-basis trade. Several are **direct loss-of-funds** under
> the spec as written.

> Frame: the document advertises the anti-loop layers as the
> "load-bearing economic guard." This review takes that claim seriously
> and shows why it is wrong as currently specified. Most attacks below
> do not require any oracle compromise, validator collusion, or new
> Move 2024 trickery. They follow from the design's stated rules.

---

## Attack 1 — Empty-bag retroactive claim (the cliff that isn't a cliff)

**Severity:** Critical (direct staker-pool drain).

**Setup.** § 5.1 Layer 2 promises a 48-hour cliff implemented by
"`debt_per_wick` is initialized at the *future* `acc_usdc_per_wick`
projected forward 48h." § 9.2's pseudocode does the opposite:

```move
debt_per_wick_by_currency: bag::new(ctx),  // empty = snapshot at zero
```

Combined with `claim<C>` reading `debt = read_debt<C>(receipt)` from an
empty bag, the canonical accumulator math `(staked * (acc - 0)) / 1e18`
pays the new staker their *pro-rata share of every fee ever deposited
since pool genesis*, retroactively. The `assert!(now >=
eligible_at_ms)` only delays the claim by 48 hours; it does not zero
the math.

**Step-by-step.**

1. Genesis. `acc_usdc_per_wick` is incremented over weeks of fee flow
   to, say, `acc = 5,000 USDC * 1e18 / 100,000 WICK = 5e16` per WICK
   (i.e. ~$0.05 of dividend already accrued per WICK staked).
2. Attacker buys 100 WICK on a secondary market for $10 (TGE pricing
   has not happened, OTC trade with an existing loser is plausible).
3. Attacker stakes the 100 WICK. `eligible_at_ms = now + 48h`. The bag
   for `USDC` is empty, so `debt = 0`.
4. 48 hours later, attacker calls `claim<USDC>`. Pending =
   `100 * (5e16 − 0) / 1e18 = 5 USDC`. Attacker is paid $5 of *historical*
   dividends they did not finance.
5. Existing stakers' receipts still show `debt_per_wick = 5e16`. Their
   own `claim` returns 0 until further deposits land. The attacker has
   stolen pro-rata historical accumulator, not future flow.

**Economic impact.** With $300k/yr of staker dividends projected at $1M
fee revenue (§ 3.3), an attacker with $1k of secondary-market WICK at
the right time captures whatever fraction of cumulative-but-unclaimed
balance their stake represents. If 30% of the staker pool's `acc` is
unclaimed when they enter (very plausible — most testnet users will
not claim until a UI exists), a $1k WICK position can extract $300+ on
day-3, a 30% return *per round trip*, with the only delay being the
48h cliff.

**Existing controls.** None of Layers 1–5 catches this. Layer 4 only
caps lifetime claims to 30% of *lifetime losses*. A wash-trade or
secondary buy easily creates artificial losses.

**Mitigation.**
- **Snapshot `debt_per_wick = acc_usdc_per_wick`** at *stake time*, not
  at first claim. The pseudocode must read the live accumulator and
  populate the bag with the current value for every supported
  currency, not `bag::new`.
- The "projected forward 48h" framing in § 5.1 is operationally
  meaningless because future `acc` is unknown. Drop it; replace with
  "snapshot at stake, payout gated by 48h cliff."
- Add an invariant test: `acc_after_stake_event == acc_before_stake_event`
  must imply `claim() == 0` for the new staker.

---

## Attack 2 — `total_staked == 0` first-staker windfall

**Severity:** High.

**Setup.** § 9.2's `deposit_fees<C>`:

```move
if (pool.total_staked == 0) {
    absorb_balance(pool, fees);
    return
};
```

Fees deposited while `total_staked == 0` *do not bump the
accumulator*, but they *do* land in `balances`. The first ever staker
walks into a pool whose physical USDC balance is non-zero but whose
accumulator is zero. They receive nothing from those fees through the
normal claim path — the funds are stranded.

Attackers exploit the inverse: if `total_staked` ever returns to zero
(every staker unstakes), subsequent fee deposits are stranded; then
the next staker can stake 1 WICK, wait for any tiny deposit that does
move the accumulator (`delta_per_wick = amt * 1e18 / 1`), and claim a
massive per-WICK accumulator on their position.

**Step-by-step.**

1. Mainnet day-1: nobody has lost yet, nobody has staked yet.
   `total_staked = 0`.
2. A bot pre-emits `deposit_fees(1 USDC)` (anyone can call it,
   permissionless per § 3.4). Lands in `balances`, accumulator
   unchanged.
3. Attacker mints 0.000000001 WICK (1 base unit) by losing $0.10 in a
   throwaway market (just above `MIN_EVENT_USD_E6`). Stakes it.
   `total_staked = 1`.
4. A second `deposit_fees(1 USDC)`. `delta_per_wick = 1_000_000 * 1e18
   / 1 = 1e24`. The accumulator is now astronomically large *per WICK*.
5. After 48h cliff, attacker claims `1 * (1e24 - 0) / 1e18 = 1_000_000`
   base units of USDC = $1.
6. Then a real loser mints 1,000 WICK and stakes. Their `debt = 1e24`,
   so they earn nothing on the next $1 deposit until accumulator moves
   above `1e24` again. Effectively the attacker has poisoned the
   accumulator math for everyone after them, and hoarded the next
   batch of deposits as `acc - debt` differential while their tiny
   stake sits.

**Economic impact.** The attacker captures 100% of the next deposit
flow until their differential is exhausted. With careful sizing (stake
1 base unit of WICK when total_staked is empty, then claim everything
that follows), they can rake the first weeks of dividend flow.
Conservative estimate: 5–10% of the first month's $25k fee flow, or
~$2k, on a $0.10 cost basis. ROI: 20,000x.

**Existing controls.** None. The cliff doesn't help (they wait it
out). The 30% lifetime cap doesn't bind (they paid $0.10 in losses,
their cap is $0.03 — but 1e6 base units of USDC = $1 is still
*claimable*; the cap forfeits the rest. Run the attack across 100
sybil addresses, each with $0.10 lifetime loss, and the cap never
binds.).

**Mitigation.**
- **Burn-on-zero:** when `total_staked == 0`, route incoming fees to
  insurance bucket, **not** to `balances`.
- **Minimum stake:** require `staked >= 1_000 WICK` (or equivalent) to
  open a `StakeReceipt`. Prevents 1-base-unit dust positions from
  dominating the accumulator.
- **Per-WICK accumulator overflow check:** assert delta_per_wick <
  some sane ceiling (e.g. 1e22). If a single deposit would move the
  accumulator by more than 10x the historical max, route to insurance.

---

## Attack 3 — Multi-receipt cliff laundering

**Severity:** High.

**Setup.** A staker can hold *N* `StakeReceipt` objects from staking
*N* times. § 9.2 places `eligible_at_ms` on the receipt, not on the
address. Nothing prevents an attacker from continuously staking 1
WICK every block to populate a rolling stash of receipts, then
selectively claiming whichever receipt's cliff has matured into a
juicy accumulator delta.

Worse: combined with **Attack 1** (empty-bag retroactive claim), each
new receipt re-arms the retroactive claim against any deposits between
now and 48h from now.

**Step-by-step.**

1. Attacker holds 10,000 WICK acquired on secondary market.
2. Every hour, attacker calls `stake(1 WICK)`. After 48 hours, they
   have 48 active receipts whose cliffs are continuously staggered.
3. Whenever a juicy `deposit_fees` lands, the attacker's *most-aged*
   receipt has snapshot `debt = 0` (Attack 1) or `debt = (acc just
   before deposit)` and immediately captures the delta on its 1-WICK
   stake.
4. Attacker rotates: claim the matured receipt, initiate-unstake,
   immediately stake a fresh 1 WICK to re-arm the queue.

**Economic impact.** Even after Attack 1 is patched, the staggered
queue lets an attacker bypass Layer 3 (7-day unstake delay) by always
having *a* receipt past the cliff. Effective unstake delay: 0
(rotating positions). Effective stake-to-claim window: 48h, exactly
the cliff. The 9-day round-trip claimed in § 5.1 is fiction.

**Existing controls.** None. Receipt-level state is the wrong scope.

**Mitigation.**
- **Per-address cliff:** maintain `last_significant_stake_increase_at`
  per address. Cliff applies to the *address*, not each receipt. Any
  stake increase resets the address-level cliff for *all* of that
  address's receipts.
- Stronger: collapse the design to **one StakeReceipt per address**
  (mergeable, cliff resets on increase using a TWAB — time-weighted
  average balance). Removes the receipt-stagger primitive entirely.

---

## Attack 4 — Sybil mint loop with per-address ceilings

**Severity:** Critical (token supply exploit).

**Setup.** § 5.3 explicitly states: *"a Sybil attacker who splits one
$10k loss across 100 fresh addresses still pays $10k and only mints
WICK at the curve — Sybil splitting does not increase total mint."*
This is **wrong** because of two interacting design choices:

1. The 6-hour mint cooldown is **per address** (Layer 1).
2. The 30% claim ceiling is **per address** (Layer 4).

A Sybil attacker uses fresh addresses to (a) bypass the cooldown for
parallel-block mints and (b) reset the 30% ceiling per address by
having each Sybil keep their lifetime loss / claim ratio at exactly
30%.

**Step-by-step.**

1. Attacker splits $10,000 into 100 fresh Sui addresses, each with
   $100 to lose.
2. In a single 30-second testnet round, each address opens a $100
   touch position with a barrier they expect to miss. All 100
   addresses lose simultaneously. Each triggers
   `record_gain_and_mint(addr_i, $100)`.
3. The HWM still ratchets to $10,000 — that part the spec gets right.
   But each Sybil address now holds the WICK for a $100 loss with
   `lifetime_loss = $100`, lifetime_claim_cap = $30.
4. Each Sybil stakes their WICK. After 48h cliff, each can claim *up
   to $30* of dividends. Across 100 sybils: **$3,000 of claims
   permitted** against $10,000 of net losses (the 30% cap binds at
   exactly $3,000). Same as a single-address attacker — the cap
   binds the same way.

So far the spec's defense holds. **But:** the *real* exploit is
combining sybils with the **bot-trader treatment** (§ 10 q4: "Lean
toward letting bots mint"). Tournament bots (`bots/`) are
adversarially-controllable from the same operator. An attacker who
controls 4 bots (the 4 personality bots already in `bots/`) gets
$10,000 / 4 = $2,500 lifetime-loss budget per bot, $750 of claims per
bot, **$3,000 total** — same. But add 100 sybils that *trade against*
the bots:

5. Bot wins systematically against sybils (attacker controls both
   sides). Each bot gains $25 per sybil trade; each sybil loses $25
   and mints WICK.
6. Attacker now has WICK in 100 sybil addresses *and* the bots have
   profits routed to LP, which mint WICK for *the bots* (because §10
   says bot wins ratchet HWM via routed LP gains too — wait, no, only
   *losses* mint WICK. Re-check.).

Re-reading § 1.3: only *losing* trades mint WICK. So the bot side
mints nothing; only the sybil losses mint. **But** the LP gains from
bot profits ratchet `H` if accounted as LP gain (which they are —
trader losses become LP profits, which is the *trigger*). So the
attacker can route their own capital from "bot side" to "sybil side,"
have the sybil side lose, and harvest WICK *for the sybil side* at
flat-region rates while keeping the capital through the bot side.

**Net flow:** $10,000 of capital cycles bot→sybil→protocol-LP→bot
(via withdrawal). Each cycle mints WICK to sybil addresses at
~100 W/$ (flat region) and ratchets HWM by the loss amount, but the
attacker's *capital* is preserved on the bot side, modulo AMM swap
fees (50 bps) and settlement skim (25 bps).

**Economic impact.** With 50bps + 25bps = 0.75% round-trip cost, the
attacker captures the entire flat-region 2M WICK supply for ~$150 in
fees (0.75% of $20,000). 1.6% of asymptotic cap — **2 million WICK on
a $150 budget**.

**Existing controls.** § 5.3 explicitly waves this off ("Sybil
splitting does not increase total mint"). It is correct that *total
mint* is unchanged — but *the attacker's share of total mint* goes
from a per-address-capped sliver to **100% of the flat region**,
because the attacker is the only one losing during the genesis
window.

**Mitigation.**
- **Bot-trader exclusion from mint:** bot losses route WICK mint to
  the insurance bucket, not the bot address. Open question § 10.4 must
  resolve to *exclude* bots, not include them.
- **Genesis ramp:** flat region applies only after `H >= $1,000` *and*
  at least 7 days have elapsed since `wick_token` deployment. Slows
  the genesis-race extraction.
- **Per-tx fee floor on mint:** require minimum $1 of *paid* AMM fees
  per mint event (not just the loss size). Wash-trading $25 between
  controlled addresses pays $0.18 in fees and mints 2,500 WICK at
  flat — the ratio of paid-fee to minted-WICK is the actual subsidy
  the attacker is capturing. Floor it.

---

## Attack 5 — Wash-trade mint with offsetting positions

**Severity:** Critical.

**Setup.** Two attacker addresses, A and B, both controlled. They open
opposing $1,000 positions on the same touch market. One of them must
lose. The loser mints WICK. The winner is paid out of the LP, but the
winner also pays the 25bps settlement skim.

If the AMM is barely capitalized (testnet realities) and the attacker
controls a meaningful fraction of pool depth, the round-trip is even
cheaper because the attacker is also their own counterparty for AMM
swap fees (which fund the LP that mints to the loser).

**Step-by-step.**

1. Attacker creates a market themselves (free, per § 4.2). Seeds
   $1,000 of LP from address C.
2. Address A buys $500 of TOUCH at midpoint. Address B buys $500 of
   NO_TOUCH. Net AMM fees paid by both: 50bps × $1,000 = $5.
3. Market expires. One side wins, one loses. Loser pays 25bps
   settlement skim on their loss (≈ $1.25 if you read the skim as on
   the lost amount; less if it's on payout).
4. Loser address triggers `record_gain_and_mint(loser, $500)`. Mints
   100 × $500 = **50,000 WICK** at flat rate.
5. Winner address withdraws $500 - skim. Address C (the LP) absorbs
   no net P&L because A vs B was zero-sum at the AMM mid; the LP only
   captured the swap fees.
6. Net cost to attacker: ~$6 (swap fees + skim). Net WICK: 50,000.
   Cost per WICK: **$0.00012**.

Repeat across the entire flat region: $20,000 of (washed) loss
generates 2M WICK for ~$240 of fees. Same-order outcome as Attack 4
without needing bots.

**Economic impact.** 1.6% of asymptotic supply for $240. Stake the
2M WICK, dominate the staking pool (likely > 95% of `total_staked`
during week 1), claim 95% of all dividends until the 30% lifetime-loss
ceiling binds. Lifetime loss is $20k → claim cap is $6k. At expected
$300k/yr divs, the ceiling is hit in **~7 days** — but the attacker
just spawns 100 fresh addresses, mints 50k WICK each at $20k loss
each (Attack 4), and refills.

**Existing controls.** Layer 4 (30% cap) bites *eventually* but not
before extraction. Layer 1 (6h cooldown) bites only per-address —
washes use multiple addresses.

**Mitigation.**
- **Counterparty disjointness check:** in `record_gain_and_mint`, if
  the recipient address has been a counterparty (via Position
  ownership history) of any *winner* in the same market within the
  same epoch, divert the mint to insurance. Requires per-market
  Position-ownership tracking; not free, but cheap.
- **Min loss of $10 USDC equivalent** for a mint event (raise the
  `MIN_EVENT_USD_E6` floor 100x). Doesn't prevent the attack but
  raises the cost.
- **Mint half-rate during first 90 days** — flat = 50 WICK/$ during
  testnet/early mainnet. The genesis race is the highest-leverage
  attack window; rate-limit it.

---

## Attack 6 — Listing-bond rehypothecation / stake-double-spend

**Severity:** High.

**Setup.** § 4.2 says listing tiers require WICK bonds (5k / 50k /
500k WICK), refundable on market settlement, non-transferable while
locked. The pseudocode for the bond does not exist in the doc.
Several issues fall out of just what's written:

1. **Can the same WICK be staked AND bonded?** The doc does not
   resolve this. If `WickStakingPool.stake()` and
   `MarketBondPool.bond()` both consume `Coin<WICK>`, then yes —
   they're separate pools.
2. **Is the bond `Coin<WICK>` taken by value or by reference?** If a
   creator can call `bond_market(coin_ref)` with a wrapped reference
   (Sui Move *does* allow stored Coin in objects), the same coin can
   sit in both a `StakeReceipt`'s vault and a bond.

**Step-by-step (variant: stake + bond same WICK).**

1. Attacker mints 50,000 WICK via Attack 4/5.
2. `bond_market(50,000 WICK)` → market promoted to Featured tier.
3. The same WICK was *also* staked in the staking pool (different call
   site, no shared lock). Attacker is earning dividends *while* the
   bond is locked.
4. Attacker creates 200 such featured markets (duplicates / spam),
   each bonded with the same 50k WICK if a re-pledge bug exists, or
   with mint-fresh WICK if not. Fronts the entire featured rail with
   their own markets, which trade against each other (Attack 5 again),
   which mint more WICK.

**Step-by-step (variant: bond slash arbitrage).**

1. Bonds are slashed 50% to insurance if a market is reported as
   "spam/duplicate" via the v1 admin multisig.
2. Insurance has a $50k cap; excess sweeps to staker pool.
3. Attacker bonds a duplicate market with 500k WICK Sponsored bond.
   Self-reports it as spam (or has the multisig do so under social
   pressure).
4. 250k WICK of slash → insurance bucket. If insurance is already at
   cap, $250k WICK denominated… wait, insurance bucket is in *USDC*,
   and the bond is in *WICK*. The doc does not specify what
   "slashed to insurance" means in unit terms. If the slashed WICK is
   sold at-market for USDC by the protocol, that's a forced sell
   pressure attackers can front-run.
5. Attacker shorts WICK on a secondary AMM, induces a slash,
   protocol forced-sells, attacker covers. Per slash event: 250k
   WICK at $0.10 = $25k forced flow on a thin AMM = double-digit
   percent move.

**Economic impact.** Stake-and-bond doubling: attacker captures the
dividend stream of (effectively) twice the WICK they hold, until the
30% lifetime-loss cap binds — and the cap binds against losses, not
against bond size, so it does not gate this. Forced-sell front-run:
direct extraction proportional to slash size, an arbitrarily large
target on Sponsored tier.

**Existing controls.** None. § 4.2 hand-waves the bond mechanics.

**Mitigation.**
- **Bond uses a `BondReceipt` analogous to `StakeReceipt`**, and
  consumes `Coin<WICK>` by value. The bond pool *holds* the WICK,
  burns its dividend eligibility (do not stake bonded WICK), and
  refunds on settlement.
- **Slash-to-burn, not slash-to-sell.** Slashed WICK is burned;
  insurance bucket gets *new* USDC from a future fee carve to make
  itself whole. No protocol-forced sell.
- **Listing cooldown:** 24h between bond placement and frontend
  promotion. Removes the "create-bond-trade-against-it-immediately"
  primitive.

---

## Attack 7 — Pyth-stale `MintDeferred` replay timing

**Severity:** High.

**Setup.** § 6.2 specifies that if Pyth is stale (>60s), the LP gain
is recorded but no WICK is minted; a `crank_deferred_mints` call
later replays the mint *once Pyth is fresh.* The replay reads
`H_at_replay` and `dG`, computes `compute_mint(H_at_replay, dG)`.

But by the time replay happens, **HWM has moved** (because other
losses ratcheted it). The deferred mint is now computed at a *higher
H*, so it gets *less* WICK than it would have at the time of the
loss. This is unfair to honest losers. Worse, the *attacker* can game
the replay timing.

**Step-by-step (attacker's POV).**

1. Attacker observes Pyth is degrading (publish_time gaps growing).
2. Attacker opens a large losing position right before Pyth exceeds
   60s staleness. Loss is recorded, mint is deferred.
3. Attacker waits. Other losses pile up — but they're also deferred
   (Pyth is stale). HWM has *not* yet moved (because the spec says
   "no WICK is minted" but does not specify whether HWM ratchets
   immediately or at replay).
4. **Ambiguity bites.** If HWM ratchets at *record-time* (loss event),
   then the first replay still gets the *post-record* HWM, which is
   high. If HWM ratchets at *replay-time*, then attacker can replay
   *their own* deferred mint first (permissionless crank) before
   anyone else's, capturing the lowest H.

**Front-running variant.**

5. Attacker is the first one to call `crank_deferred_mints` after
   Pyth recovers. They replay their own mint first; subsequent
   replays for other deferred events get higher H.

**Economic impact.** Order of magnitude effects when H is right at
$20k threshold. A $5k deferred loss replayed first at H=$15k mints
500k WICK (flat); replayed last at H=$25k mints ~470k WICK (decay
just begun). Difference is small in the flat region, but during the
decay region (H near $1M), the difference between first and last
replay across $50k of deferred losses can be **2-3x**.

**Existing controls.** None. § 6.2 does not specify HWM ratchet
timing.

**Mitigation.**
- **Snapshot H_at_record_time on the deferred event.** Replay
  computes `compute_mint(H_snapshot, dG)`, then ratchets HWM by dG.
  Replays land in the order the events were recorded, not the order
  cranks fire.
- **Sequential replay enforcement:** `crank_deferred_mints` processes
  the deferred queue in FIFO order; cannot skip.
- **Or simpler: do not defer.** If Pyth is stale, *fail the close
  txn* and let the trader retry when Pyth recovers. No mint
  deferral, no replay attack.

---

## Attack 8 — Genesis-race monopolization (single-address flat-region capture)

**Severity:** Critical (concentration risk + token-supply exploit).

**Setup.** § 2 makes explicit: the first $20k of LP gain mints 2M
WICK, the first $100k mints 9.3M, the first $1M mints 46M. The first
trader to start losing has near-monopoly access to flat-region rates.

**Step-by-step.**

1. Founder / insider / well-funded trader watches for `wick_token`
   deploy block.
2. Within the same block, opens 100 simultaneous touch markets they
   created themselves (Open tier, free), and immediately loses on all
   of them across multiple addresses (to bypass the 6h cooldown — see
   Attack 4).
3. With 100 addresses each losing $200, the attacker accumulates
   $20,000 of losses across the flat region in **one block**.
4. Mints 2M WICK across 100 addresses. Each address holds 20k WICK.
   Each address's lifetime-loss cap is 30% of $200 = $60.
5. Stake all 100 addresses. After 48h cliff, each address can claim
   up to $60 of dividends — total $6k claim cap across the sybil
   farm.
6. Meanwhile, attacker controls 2M WICK = 100% of flat-region supply.
   Until the next mint event (which is now in decay region and yields
   ~78 W/$ instead of 100), the attacker is the entire staker base.

**Economic impact.** 1.6% of asymptotic cap captured by one operator
in one block, for a cost of ~$300 in fees if Attack 5 (wash) is also
used, or a true cost of $20,000 if not. If the dividend pool generates
$300k/yr and the attacker holds 100% of stake for the first month,
they capture $25k/month *from their own losses fed back through the
fee carve* — but the cap forfeits most of this back to other
stakers. Net: attacker keeps $6k of dividends + 2M WICK ($200k @
$0.10) - $20k cost = **+$186k**.

If Attack 5 (wash) brings the cost to $300, net is **+$205k**.

**Existing controls.** 6h cooldown is *per-address*, so sybils bypass
it. 30% lifetime cap binds on the dividend side, but **does not bind
on the WICK quantity itself.** The 2M WICK is theirs to sell on
secondary markets, freely.

**Mitigation.**
- **First-N-blocks throttle:** for the first 1,000 blocks (or 24h)
  after `wick_token` deploy, mint rate is capped to 1 WICK / $1 (1%
  of nominal). Prevents the genesis-race race-condition entirely.
- **Per-recipient daily mint cap:** any address can mint at most
  100,000 WICK per 24h regardless of cooldown / loss size. Caps the
  sybil multiplier.
- **Sponsored-bond gating on mint:** addresses that do not hold a
  Sponsored-tier bond (or were not party to a non-attacker market)
  for >7 days mint at half rate. Discourages day-1 attackers.

---

## Attack 9 — Insurance-sweep timing game

**Severity:** Medium.

**Setup.** § 3.5 says insurance excess above $50k sweeps to stakers
weekly via permissionless `crank_insurance_sweep()`. § 3.4 also says
sweep is permissionless. An attacker can:

1. Wait until insurance bucket is at $49k.
2. Time a large fee deposit (or wait for one) that pushes it to $80k.
3. Stake a huge amount of WICK *immediately* (as a one-block
   front-run before the sweep).
4. Call `crank_insurance_sweep()` themselves, transferring $30k to
   the staker pool at a moment when the attacker is the maximum
   stake-holder.
5. Wait 48h cliff, claim, unstake.

**Step-by-step with numbers.**

1. Insurance at $49k. Attacker has 5M WICK pre-acquired (Attack 8).
2. Attacker pre-stakes the 5M WICK (this is fine; no event has
   triggered the cliff yet for the sweep deposit specifically).
3. Other natural stakers exist; let total_staked = 10M WICK
   post-attacker-stake.
4. A real fee deposit lands and pushes insurance to $80k. Excess =
   $30k.
5. Attacker frontruns `crank_insurance_sweep()` in the same block.
   $30k flows into staker pool. Accumulator bumps by `30,000 USDC *
   1e18 / 10M WICK = 3e15` per WICK.
6. After 48h cliff, attacker's pending = `5M * (3e15 - debt) / 1e18 =
   $15k` — half the swept funds, proportional to their 50% stake
   share.
7. 30% lifetime-loss cap binds at $15k only if attacker's lifetime
   loss is ≥ $50k. Attacker's WICK was acquired via $20k of losses
   (Attack 5/8), so cap = $6k. Attacker captures **$6k** of the
   $15k pending; the remaining $9k forfeits back to the pool (which
   includes attacker's own continuing positions).

**Economic impact.** Per sweep event, attacker captures min(stake
share × sweep, lifetime-loss cap remainder) = ~$6k under realistic
parameters. Sweeps happen weekly (per spec) → annualized ~$300k from
this attack alone.

**Existing controls.** Layer 2 cliff partially helps (must be staked
≥ 48h before claim), but a savvy attacker pre-stakes well in advance
of triggering the sweep. Layer 4 caps the per-address claim, but as
shown, it merely throttles, doesn't prevent.

**Mitigation.**
- **Sweep batching:** insurance sweeps occur at fixed intervals
  (every Monday 00:00 UTC) rather than on permissionless crank.
  Removes the "stake-then-trigger-sweep" primitive.
- **Anti-MEV: distribute swept funds via a 7-day vesting accumulator
  bump** rather than a single block. Attacker's stake-then-unstake
  loop is gated by the unstake delay × vesting period.
- **Snapshot-in-arrears:** sweep distribution is pro-rata to the
  *time-weighted average* stake over the previous 7 days, not the
  current `total_staked`. Pre-staking 1 second before the sweep
  yields essentially zero share.

---

## Attack 10 — HWM is per-token-state, not per-collateral — cross-collateral lag

**Severity:** Medium-High.

**Setup.** § 6 says "WICK supply must have a *single* answer at any
moment" and uses one HWM (USDC-denominated) across both `Market<SUI>`
and `Market<USDC>`. The Pyth conversion happens at *record time*. If
SUI/USD price deviates between the time a SUI loss is realized and
the time it's recorded (transaction inclusion delay), the conversion
is wrong and either over- or under-mints WICK.

**Step-by-step.**

1. Pyth SUI/USD = $1.00. Attacker opens $5,000 SUI position (5,000
   SUI). Trades against themselves to lose.
2. Attacker submits the close transaction at moment T0, but with a
   gas-pricing strategy that delays inclusion by ~30 seconds (or
   uses a private mempool / bot priority).
3. SUI/USD pumps to $1.20 between T0 and inclusion at T1. Pyth at T1
   reports $1.20.
4. `record_gain_and_mint` converts the 5,000-SUI loss at $1.20 =
   $6,000 USD. Mints WICK on $6,000 of HWM consumption — 600,000
   WICK at flat — when the actual realized loss (in dollar terms at
   T0) was $5,000. Attacker over-mints by 100,000 WICK = $10k of
   token at $0.10.

**Reverse direction:** SUI dumps from $1.20 → $1.00 between order
and inclusion. Honest trader under-mints. Attacker exploits by always
opening losing positions when SUI is *dumping* and timing inclusion
during a *pump*. The asymmetric attention pays.

**Economic impact.** With ~5% SUI daily volatility and even 1%
intra-block deviation potential, attacker captures ~1% extra WICK
per round trip. Over a $20k flat region, that's 20,000 extra WICK =
~$2k. Not huge, but it stacks with other attacks.

**Existing controls.** § 6.2's stale-feed check gates at >60s. Sub-60s
deviation is unbounded.

**Mitigation.**
- **TWAP-converted USD:** use Pyth EMA price (Pyth provides this)
  rather than spot for the conversion. Smooths sub-minute
  manipulation.
- **Convert at order-open, not order-close:** Position objects carry
  their *open-time USD-equivalent*, which is then carried through to
  the loss event. Attacker cannot game inclusion timing of close to
  shift the conversion basis.

---

## Attack 11 — Bot-trader mint flooding (open-question § 10.4 weaponized)

**Severity:** High (depending on resolution of § 10.4).

**Setup.** § 10.4 explicitly tilts toward "letting bots mint." The
4 personality bots in `bots/` (per `c0fee31` in git log) are designed
to lose realistically. If their losses mint WICK to bot addresses,
the operator (the protocol team) holds non-trivial WICK.

**Step-by-step.**

1. Bots are funded with $10k each from operator (per bot config).
2. Bots play across testnet / early mainnet, losing per design (some
   personalities are deliberately bad).
3. Each bot's losses mint WICK to bot address. Cumulative bot losses
   over the first month: ~$8k per bot × 4 = $32k → ~3.2M WICK at
   flat/early-decay rates.
4. Operator controls 3.2M WICK (~2.6% of asymptotic cap), claimed to
   be "fair launch with no team allocation" (§ 0).

**Worse:** Sybil bot operator (Attack 4 reused). External attacker
spins up 100 trading bots, all with realistic-looking
loss-distributions, captures flat-region rates the same way the
team does.

**Economic impact.** Direct violation of the "no team allocation"
brand promise. Tokenomic concentration risk = governance / market-cap
manipulation risk later.

**Existing controls.** None. § 10.4 explicitly leaves bots in.

**Mitigation.**
- **Resolve § 10.4 against the bots:** bot losses route mint to the
  insurance bucket (treating bots as "house").
- **Operator-bot label:** team-controlled bots have an on-chain
  registry; their mints are diverted, no exception.
- **Hard cap on per-address minted-WICK during first 90 days** at
  100k WICK regardless of source.

---

## Attack 12 — Forfeit-into-pool feedback loop (Layer 4 self-defeat)

**Severity:** Medium (subtle).

**Setup.** § 5.1 Layer 4 says "future dividends accrue but cannot be
claimed by that address (they roll back into the staker pool for
everyone else)." This *re-distributes* forfeited dividends. But "for
everyone else" includes the attacker's *other* addresses (if they're
sybils — Attacks 4, 8) and the staker pool's accumulator structure
re-credits everyone proportionally to current `total_staked`.

If the attacker holds 50% of `total_staked` across sybil addresses,
50% of the forfeited dividends from any *one* address flow back to
the attacker's other addresses. The 30% cap doesn't bind a sybil
operator at the 30% level — it binds at the **30% × (1 − sybil-share
of pool)** level. With 50% sybil share, the effective cap is **45%**.
With 90% share (very plausible during testnet), the effective cap is
**100% of forfeited flow recycles back to the operator, asymptotically**.

**Step-by-step.**

1. Operator holds 90% of staked WICK across 100 sybils.
2. Operator's lifetime losses (sum across sybils) = $20k.
3. Pool generates $10k of dividends to operator's stake share = $9k
   pending. Cap allows operator to claim $6k (30% of $20k). $3k
   forfeits.
4. $3k re-distributes via accumulator bump. Operator captures 90% =
   $2.7k. Lifetime claims now = $6k + $2.7k = $8.7k > cap. Sybil-
   address-by-sybil-address, those that haven't hit individual caps
   absorb the $2.7k.
5. Iterate: each iteration captures 90% of the forfeit, asymptote
   approaches **100% of generated dividends** captured by operator
   despite the per-address 30% cap.

**Economic impact.** Layer 4 stops being load-bearing if operator
holds majority stake. At 90% share, effective claim ratio = 100% of
share; the 30% cap is illusory. Realistic during testnet / first
month of mainnet.

**Existing controls.** None — the forfeit-into-pool is doc-spec and
the inevitable consequence of accumulator-style distribution.

**Mitigation.**
- **Forfeit-to-burn or forfeit-to-insurance**, not forfeit-to-pool.
  The doc literally says "they roll back into the staker pool" — the
  fix is to route them out of the staker pool entirely (insurance
  bucket).
- **Stake share cap:** any single address can stake at most 5% of
  `total_staked`. Forces sybil overhead in proportion to share.
  (Per-address only, easy to bypass with many sybils — but raises
  cost.)
- **Compound cap:** track operator-cluster lifetime claims via a
  TWAB/sybil-cluster heuristic (e.g. addresses funded by the same
  parent within last 30d). Heavyweight but possible.

---

## Cross-cutting observations

**The "9-day round trip" claim in § 5.1 is not true** under the spec
as written. With multi-receipt cliff laundering (Attack 3), the
round-trip is **48h + claim window**. The 7-day unstake delay
applies to the WICK *quantity* you want to remove from the pool, not
to your ability to claim dividends — those are independent.

**Layer 4 (30% cap) is the only mathematical guard, and it is per-
address.** Every other layer is a delay, not a cap. Sybils nullify
all per-address controls (Attacks 4, 8, 11, 12), so the system
reduces to "30% per address × number of addresses you control" —
i.e. unbounded.

**The doc's most overconfident claim** is § 5.3: *"Sybil splitting
does not increase total mint, only spreads it across addresses."*
This is mechanically true for *total mint* but completely wrong for
*attacker share of mint and dividends*. Attacker share scales with
the number of sybils; total mint is fixed. The fixed pie is being
eaten by one mouth.

**Specification ambiguities that bite at implementation time:**

- HWM ratchet timing on deferred mints (Attack 7).
- Whether `debt_per_wick` snapshots at stake or at first claim
  (Attack 1).
- Whether bonded WICK can also be staked (Attack 6).
- What "slashed to insurance" means when the bond is in WICK and
  insurance accounts in USDC (Attack 6).
- Whether `cumulative_losses` excludes washed losses (Attack 5).
- Whether the staker pool's `total_staked == 0` path strands fees
  (Attack 2).

Each of these needs to be resolved *in writing* before any Move
code lands.

---

## Recommended priority order for fixes

1. **Attack 1 (Critical)** — fix `debt_per_wick` snapshot-at-stake.
   This is a one-line code fix and a contradiction with the spec
   prose. Cannot ship without it.
2. **Attack 4 + 5 + 8 (Critical)** — sybil/wash/genesis-race. Address
   together via per-address daily mint cap + bot-mint exclusion +
   genesis throttle.
3. **Attack 12 (Medium)** — forfeit-to-burn instead of forfeit-to-
   pool. One-line fix, removes the sybil amplifier.
4. **Attack 6 (High)** — bond mechanics need a separate spec
   document. Don't ship listing tiers until that exists.
5. **Attack 9 (Medium)** — sweep batching + TWAB.
6. **Attack 7 (High)** — defer HWM snapshot to record time, FIFO
   replay.
7. **Attack 2 (High)** — burn-on-zero, minimum stake.
8. **Attack 3 (High)** — per-address cliff, single receipt per
   address.
9. **Attack 10 (Medium-High)** — convert at open, not close; or use
   Pyth EMA.
10. **Attack 11 (High)** — resolve § 10.4 against bots; on-chain bot
    registry.

Until at least items 1, 2, 12, 6 are in writing and tested, the
WICK token spec is **not safe to ship to mainnet** — and is risky
even on testnet because secondary markets and wrapped versions can
form on testnet WICK with real USD value if the token narrative
catches.
