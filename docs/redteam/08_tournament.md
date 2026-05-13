# 08 — Red Team: Tournament, Badge, and Leaderboard Mechanics

> Scope: every attack surface in `docs/design/08_gamification.md` plus the
> token/staker interactions in `docs/design/03_wick_tokenomics.md` and the
> indexer/event surface in `docs/design/09_events_indexer.md`.
>
> Posture: I am a black-hat researcher hired to break the gamification layer
> for profit. The security model in §7 of the gamification spec ("Anti-grief")
> is treated as advisory, not as a defense — every named control gets a
> dedicated probe.

**Headline finding:** the design has a serious **Sybil-asymmetry problem**.
Tournaments are designed for "fair launch" identity (no stake to enter, no
stake to *appear* on leaderboards), and the only real Sybil control is a
WICK-stake gate on **prize payout**. WICK is fair-launched by *losing* (§3 of
tokenomics). That means an attacker who is already losing money on Wick is
*organically accumulating the exact resource needed to bypass the only
Sybil control.* Several attacks below chain on this.

The 5% **comeback sub-pot** is also acutely exploitable — it pays the worst
PnL traders, capped at 5x entry, but the cap is *per address*, so a Sybil
operator banks 5x on every farm wallet that lost. With a 1 SUI entry fee,
a 100-wallet Sybil farm extracts up to 500 SUI of comeback pot per
tournament with near-zero skill required.

Twelve attacks documented below, ordered by severity within domain.

---

## A1 — Sybil tournament entry (Critical)

**Severity:** Critical. Drains the prize pool every tournament until patched.

**Setup.** One operator. 100 fresh Sui addresses (cost: dust gas, ~$1
total). Single hot wallet funds all 100 with `entry_fee + ~0.05 SUI gas` =
1.05 SUI each. Capital outlay: 105 SUI to enter. Optional: pre-write a
keeper script that signs `tournament::enter` from each of the 100 wallets in
a tight loop in the entry window.

**Step-by-step.**
1. T-30min: keeper iterates over the 100 keypairs, calls
   `tournament::enter` from each. Each gets a `TournamentEntry` object
   transferred back. Pot now has 100 × 1 SUI = 100 SUI from this attacker
   alone. If real-user entry count is N, total pot ≈ N + 100.
2. T-0: lock-in. Seed is set; markets spawn. Attacker now owns 100 entries
   pointing at the same 5 markets.
3. T+0 to T+5min: from each of the 100 wallets, place a tiny stake (e.g.
   1000 mist) on one of the five markets. With the **per-entry stake cap**
   (`entry_fee × 100` = 100 SUI), the attacker has *plenty* of room to
   stake meaningfully — but minimum-stake entry is enough to qualify for
   ranking *and* for the comeback sub-pot.
4. Strategy A — pure ranking attack: have all 100 wallets straddle (50
   TOUCH, 50 NO\_TOUCH) at the cheapest barrier. Roughly half always win
   the *intra-tournament* TOUCH/NO\_TOUCH leg, so 50 of the 100 wallets
   end the round with positive PnL. Of the top-10 paid ranks, the
   attacker plausibly captures 4–6 (depending on real entrant count).
5. Strategy B — comeback farm: have all 100 wallets place tiny losing
   bets and *intentionally* end in the bottom-3 PnL bucket per wallet.
   Comeback sub-pot pays top-3 *worst* traders, capped at 5x entry → 5
   SUI per wallet. With 100 sybil wallets in the bottom-3 bucket,
   attacker captures the 3 paid slots in 3 separate rounds → 15 SUI per
   sub-pot, or a single round if comeback pays multiple winners.
6. Strategy C — both. Half the wallets play strategy A, half play B.

**Economic impact.**
- Per tournament: at the spec's example pot (1,247 SUI, 1,247 entrants),
  capturing 3–5 paid ranks (5%–30% slots) extracts ~10%–40% of the pot
  ≈ **125–500 SUI/day** per Sybil operator.
- Plus comeback sub-pot share: 5% of 1,247 = ~62 SUI, of which up to 100%
  is capturable by sub-Sybil wallets that botherwise are money-losers.
- At today's SUI ~$3 prices, that's **~$400–$1,800/day per attacker**
  with one cron job. Annualised: $150k+.

**Existing controls (per spec §7, anti-grief table).**
- **Per-entry `max_stake_total` cap** (entry_fee × 100). *Useless against
  Sybil.* Attacker uses 100 entries, each with its own cap.
- **WICK staking gate for prize eligibility.** *Soft.* Operator only needs
  ≥100 WICK staked per farm wallet to *cash out*. WICK is mintable by
  losing trades (§3 of tokenomics), so a one-time round of intentional
  losses on a small budget seeds every farm wallet with stakeable WICK.
- **Optional `min_wick_staked` per-tournament gate.** Off by default.
  Even when on, see attack A12 below.
- **"Same address on both sides of a market within a 5-min window" wash
  filter.** Doesn't apply — different addresses (Sybil), so no flag.

**Mitigations (in priority order).**
1. **Make Sybil expensive** — require ≥X WICK staked **at the wallet
   that is paying the entry fee**, with X > entry_fee × 50. WICK is
   minted to losers, so the attacker has to either lose materially first
   or pay secondary-market price for WICK. This converts Sybil from
   "free" to "capex per wallet".
2. **Per-funding-source nonce.** Track the funding tx for each wallet's
   first 1 SUI deposit. Apply a max-payout-per-source-tx cap of ~3× entry
   fee. Doesn't defeat sophisticated funding (split through 100 hops via
   a tumbler) but stops the trivial "fund 100 wallets from one address"
   pattern. Indexer-side, easy to detect.
3. **Address age requirement.** Entries from addresses whose first
   on-chain activity is <72h old don't accrue prize payouts. Pushes
   Sybil capex to "operate 100 dormant wallets for 3 days each" which is
   real cost.
4. **Optimal: combine all three.** Each individually is bypassable;
   combined, Sybil ROI flips negative.
5. **Treat the per-entry stake cap as a *per-entrant* cap.** Sum across
   `tournament_id × address`. (This requires `Tournament` to know about
   addresses, not just `TournamentEntry` IDs — a non-trivial refactor.)

---

## A2 — `bulk_open` PTB exploit by guild leader (Critical)

**Severity:** Critical. The "guild leader" model is the same person as
the Sybil operator; `bulk_open` is the canonical Sybil execution path.

**Setup.** Same as A1, but exercise the `bulk_open` PTB function described
in §1 of the gamification spec. The current signature:

```move
public fun bulk_open<C>(
    tournament: &mut Tournament<C>,
    entries: vector<&mut TournamentEntry>,
    sides: vector<u8>,
    stakes: vector<Coin<C>>,
    market_ids: vector<ID>,
    clock: &Clock,
    ctx: &mut TxContext,
): vector<Position>
```

The spec says "Each `entries[i]` must be owned by the signer or by a
`Friend` capability that the entry-owner pre-issued." The current code
sketch does not clearly enforce *ownership independence* — a single
signer who controls 100 wallets can:
- Pre-mint 100 `TournamentEntry` objects from 100 wallets.
- Transfer all 100 to a single "guild leader" address (or wrap each in a
  `Friend` capability the operator issues to themselves).
- Submit one PTB that opens 100 × 5 = 500 positions atomically.

**Step-by-step.**
1. Sybil-fund 100 wallets (A1 step 1).
2. From each wallet, call `tournament::enter` and immediately
   `transfer::public_transfer(entry, OPERATOR_ADDR)`. Now operator holds
   100 entries.
3. At T+0, operator submits one PTB calling `bulk_open` with all 100
   entries, all 5 markets, distributing stakes per a precomputed
   straddle plan from A1 step 4.
4. Atomically, all 500 positions open in one tx. Operator pays one set of
   gas fees instead of 500.
5. Optional escalation: the attacker doesn't even need 100 wallets at
   *trade* time — the entries are owned by the operator. The 100 wallets
   only matter at *enter* time (because `tournament::enter` takes 1 SUI
   from the signer, and the per-entrant fee is the only Sybil cost).

**Economic impact.**
- Same as A1 ($400–$1,800/day) but **gas cost cut by ~95%** because one
  PTB replaces 500 single-call txs.
- More importantly, makes the attack *executable in one tx at T+0*, so
  the attacker can react to the seed reveal (see A3) and only fire the
  PTB if the precomputed seed favors their book.

**Existing controls.**
- "Each `entries[i]` must be owned by the signer." This is the **only**
  defense; the spec does not require entries to be *independent*. The
  Friend-capability fallback is an explicit escape hatch.
- No address-distinct check on the entries vector.

**Mitigations.**
1. **Bind `TournamentEntry.owner` to entry creator at mint, mark the
   entry `key`-only (no `store`)**, so it cannot be transferred. Removes
   the "transfer 100 entries to operator" path entirely. Friend
   capabilities then become a true delegation rather than ownership
   transfer.
2. **Cap `bulk_open` length at 5.** This is enough for the legitimate
   "5-friend guild" use case. 100-entry `bulk_open` calls are
   prima-facie Sybil, never legitimate.
3. **Require `tx_context::sender(ctx) == entry.owner` for at least 80%
   of the entries vector.** Friend capabilities can cover the rest. This
   keeps the friend UX without making it the universal escape.
4. **Tournament module emits `BulkOpenSubmitted { signer, entry_count,
   distinct_owners }`.** Indexer flags any tx with `distinct_owners <
   entry_count / 2` for review and disqualifies prize eligibility.

---

## A3 — Seed-grinding via prev-block manipulation (High)

**Severity:** High. Deterministic outcome bias; repeatable by any
sophisticated actor with stake in the round.

**Setup.** The lock-in seed is `hash(prev_block_digest, T-0_clock_ms)`.
Sui's `prev_block_digest` is the previous checkpoint digest, which is
deterministic *given the set of transactions in that checkpoint*. An
attacker wanting to bias the seed has a few levers:

- **Tx ordering MEV via validator collusion or builder pay.** Sui
  validators can reorder/include/exclude transactions in their proposed
  checkpoints (within consensus rules). Paying a validator (via direct
  bribe or sponsored builder) to include or exclude a specific tx in
  the checkpoint covering T-0 changes `prev_block_digest`.
- **Tx-flooding.** Submit a large number of cheap txs immediately
  before T-0 to perturb the checkpoint contents. Each different mix
  yields a different digest.

**Step-by-step.**
1. Pre-position: at T-1min, attacker opens a heavy book on TOUCH-ABOVE
   +1% (i.e. they want the random walk to touch up).
2. T-30s: precompute a table — for every plausible `prev_block_digest`
   in the next ~5s of checkpoints, deterministically simulate the
   random_walk_driver's first 30 ticks. Bucket digests by "would my
   book win".
3. T-1s: have a confederate validator (or paid relay) include or exclude
   one of K candidate "bias-txs" the attacker pre-prepared. Each
   inclusion/exclusion shifts the digest into one of the buckets.
4. Result: attacker's book is positioned for a random walk that, with
   high probability, paths into their barrier in the first 30 seconds.
5. Compounding: combine with A1 — Sybil wallets all bet the same
   direction once attacker has biased the seed.

**Economic impact.**
- If the attacker can bias even *one bit* of the seed, they shift the
  expected value of a TOUCH bet from 50% to ~52% — a 4% edge on every
  position they hold. On a 1,247-SUI pot with attacker holding 30% of
  entries, that's an extra **~50 SUI per round** of expected
  extraction, on top of A1.
- If they can bias 4 bits (16 candidate digests), edge approaches
  60–70%. Pot fully extractable.

**Existing controls.** None explicit. The spec just says "public,
unpredictable until lock-in". *Unpredictable* is doing too much work —
it's only unpredictable to actors who *can't influence the prev block*.

**Mitigations.**
1. **Use a proper VRF** — Sui has `sui::random::Random`, which sources
   from a BFT randomness beacon. Use that as the seed primary, optionally
   XOR'd with `prev_block_digest` for belt-and-braces. The randomness
   beacon is unbiasable by any single validator.
2. **Commit-reveal across multiple blocks.** Lock seed at T-0 from
   `hash(checkpoint_at(T-0), checkpoint_at(T-0+10), checkpoint_at(T-0+20))`.
   Now an attacker has to bribe 3 different checkpoints' content. Costly
   but not impossible — VRF is still better.
3. **Delay seed reveal to T+30s** (after entries are locked). Combined
   with #1, makes seed-grinding moot.

---

## A4 — Late-entry seed read (Medium)

**Severity:** Medium. Smaller edge than A3, but trivially executable by
any user without colluding with a validator.

**Setup.** The spec locks entries at T-0, then derives seed at T-0. Even
without grinding, an attacker who runs `tournament::enter` at T-1ms can
*observe* the prev-block digest of the checkpoint immediately preceding
T-0 *during* their tx execution.

**Step-by-step.**
1. Run a node co-located with the fullnode for low-latency block reads.
2. At T-50ms, observe the candidate `prev_block_digest`.
3. Compute the simulated walk for the next 5 minutes given that digest +
   T-0 ms (the latter is fully predictable).
4. Decide which side of which barrier to bet on.
5. At T-1ms, submit `tournament::enter` AND the first `market::open`
   call together in one PTB. The entry beats the lock-in cutoff; the
   open is queued for T+0 and uses the now-known seed bias.

**Economic impact.** Similar to A3 but probabilistically smaller (no
ability to *change* the seed, only *react* to it). Still a 5–15% edge per
round vs unbiased entrants. **~$50–150/round.**

**Existing controls.** None — the spec implicitly assumes entries can't
read the seed before locking. The real-world race is decided by tx
inclusion latency.

**Mitigations.**
1. **Hard freeze entries at T-30s** (not T-0), so by the time the
   prev-block digest is observable for T-0, no one can still enter.
2. **Use VRF (A3 mitigation #1).** VRF reveal happens at T-0 atomically
   with the lock; no observable preimage.

---

## A5 — Wash trading PnL inflation across the tournament window (High)

**Severity:** High. Combines with Sybil to fully inflate any farm
wallet's PnL into the top-10 paid ranks.

**Setup.** Two addresses `A` and `B` controlled by one operator. Both
have `TournamentEntry` objects in the round. The tournament markets are
protocol-funded CPMMs with shared liquidity, which means buys and sells
move price within the round.

**Step-by-step.**
1. T+0: A opens a small NO\_TOUCH position on barrier X at low price.
2. T+30s: A's NO\_TOUCH is now valuable (say 2 SUI mid-price).
3. The CPMM has a path to *transfer* this position via the secondary
   market (DeepBook CLOB hook in `position_token::on_clob_match` per
   §2.4 of the events doc). A places a sell order at a deliberately
   high price (say 5 SUI). B places a buy order matching it. They
   match.
4. A's wallet records realised PnL of +5 SUI – stake. B's wallet now
   holds the position at 5 SUI cost basis.
5. At settlement, B redeems whatever the position pays out. If TOUCH
   never happens, B redeems 8 SUI on the NO\_TOUCH (full payout
   minus fee), so B's PnL is +3 SUI.
6. **Net realized PnL credited across A+B**: 5 + 3 – stake_A –
   stake_B – fees. Both *appear* near the top of the leaderboard.

**Economic impact.**
- Combined attack: A1 (Sybil) + A5 (wash) → operator deterministically
  positions 6+ farm wallets in the top-10 ranks. Captures most of the
  paid prize curve.
- Per round: **200–500 SUI extracted** from a 1,247-SUI pot.
- The wash filter ("same address on both sides within 5 min") doesn't
  fire because A and B are different addresses.

**Existing controls.**
- `lifetime_volume_mist` daily cap (anti-wash table). This caps
  *volume* counted toward leaderboard, not *PnL*. Doesn't help.
- Streak counter requires `min_hold_ms`. Tournament rounds are 5
  minutes, so this is plausibly satisfied or trivially evaded.
- DeepBook CLOB venue tag — useful for indexer-side detection, but
  no enforcement.

**Mitigations.**
1. **Wash-graph detection in the indexer.** Cluster addresses by
   funding-source graph (who funded whom in the last 7 days) and
   discount PnL between members of the same cluster. Borrow cluster IDs
   from a graph-walk over `Coin<SUI>` transfers.
2. **Disable secondary-market position transfer inside the tournament
   window.** The spec already requires `TournamentEntry` ID as a
   capability for `market::open` — extend that to require the entry ID
   for `position_token::transfer` *while the source market is part of an
   active tournament*. Closes the wash venue entirely for tournament
   markets.
3. **Cap PnL credit at 5x stake per position for tournament ranking
   purposes.** A wash trade that "pays out" 10x the stake on the
   loser's books gets ranked as if it paid 5x. Diminishes wash ROI.

---

## A6 — Comeback sub-pot double-dip (High)

**Severity:** High. Specific to the comeback sub-pot design; clean
extraction with no Sybil needed (though Sybil amplifies it).

**Setup.** The comeback sub-pot pays the **top-3 worst PnL** traders,
capped at 5x entry. The "Comeback Kid" badge requires being in the
**bottom-25% PnL at the 60% time mark, then winning the tournament**.

**Step-by-step.**
1. T+0 to T+3min (60% of 5 min): from a single wallet, place a clearly
   losing position (e.g. a 1 SUI TOUCH bet at +5% when current price is
   stable).
2. T+3min: indexer snapshots PnL ranks. Attacker is in bottom 25%.
   "Comeback Kid" eligibility is now *armed* per the spec.
3. T+3min to T+5min: place a heavy winning trade (say a barrier that's
   already touched on the random walk, paying near-instant). Now PnL is
   strongly positive.
4. **Outcome:** attacker is now in the top-10 paid ranks, *and* gets
   the "Comeback Kid" Epic badge, *and* can also qualify for the
   comeback sub-pot if they intentionally crash again at T+4:55 with
   a tiny stake.
5. The "win the tournament" part of Comeback Kid requires top-1 only,
   per the strictest reading. But "comeback sub-pot eligibility" is
   loose — bottom-3 PnL gets up to 5x entry, capped per address.

**Economic impact.**
- Comeback sub-pot at 5% of 1,247-SUI pot = 62 SUI total. With the cap
  at 5x entry (5 SUI per address), top-3 split that. Single-attacker
  capture: 5 SUI per round, **per address**.
- Combined with A1 Sybil farm (100 wallets): if comeback pays 3 distinct
  addresses, attacker captures 100% of comeback sub-pot every round
  by ensuring 3 of their wallets are guaranteed in the bottom-3 PnL
  bucket. **62 SUI / round = ~$185 / day at SUI ≈ $3.**
- Annualised: **~$67k from comeback alone**, before adding A1 main-pot
  capture.

**Existing controls.** "Cap means you can't farm this" — the 5x entry
cap. *Wrong analysis*: the cap is per address, so Sybil multiplies the
cap by `n`. Also no mention of badge logic enforcing "must have entered
in good faith".

**Mitigations.**
1. **Distribute comeback sub-pot pro-rata across all bottom-quartile
   entrants, not top-3 of bottom**. Removes the discrete winner-picking
   that Sybil exploits.
2. **Comeback eligibility requires** *unrealised* losses > some threshold
   for ≥50% of the round, *not just* PnL at the 60% mark. Filters out
   degenerate "place 1 small loss tx, place 1 big win tx" pattern.
3. **Disqualify wallets from comeback if their funding source funds any
   other participating wallet** (cluster filter from A5).
4. **Cap TOTAL comeback payout per cluster (not per address).** Same
   indexer-side cluster ID applies.

---

## A7 — "Founder" badge bot rush (High)

**Severity:** High. One-shot extraction of all 1,000 mythic Founder
NFTs at launch. Mythic NFTs are the *most valuable* on the secondary
market for status games like this (cf. Friend.tech keys, NFT mints).

**Setup.** Founder badge is "issued to the first 1,000 unique trade
signers" with a 10 WICK stake requirement. WICK isn't yet circulating
at launch; the ≥10 WICK floor presumably gets seeded by intentionally
losing the first 1,000 trades.

**Step-by-step.**
1. Pre-launch: attacker generates 1,000 fresh keypairs.
2. Pre-funds each with ≥0.5 SUI from a single hot wallet (capex: 500
   SUI = $1,500 at SUI ≈ $3).
3. At protocol launch (T+0 of mainnet listing), bot opens one trade
   from each of the 1,000 wallets in tight succession. With Sui's
   ~0.5s finality, the bot can land all 1,000 in ~10 minutes if it
   parallelises across many fullnode RPC endpoints.
4. Each trade is intentionally a loss (e.g. TOUCH on an already-
   expired-ish barrier with no path) to mint WICK to the wallet,
   satisfying the 10 WICK stake gate.
5. Attacker now controls all 1,000 Founder NFTs.

**Economic impact.**
- Capex: ~500 SUI ($1,500) for funding + ~0 SUI for losses (the loss
  is the *trigger* for the WICK mint, so it's a transfer to LPs, not a
  gas cost).
- Founder badge rarity = mythic, hard cap 1000. On Sui's NFT market
  at launch comparables (Suicune Bears, OG marks), mythic-floor =
  $200–$1,000+ per NFT. **Floor-extraction value: $200k–$1M.**
- This is a one-time extraction — the badge is hard-capped — but
  it's also an *organic-community-killing* event because no real
  trader can ever get a Founder badge.

**Existing controls.**
- "≥10 WICK staked at mint time". Defeated by losing-to-mint path.
- "Per-kind serial number + optional per-address cap (e.g. one First
  Wick per address forever)" — this exists in spec but is described as
  *optional* and *example*. Founder badge spec doesn't explicitly
  require per-address cap. **Implicit assumption: 1 Founder per
  address?** The spec is ambiguous.

**Mitigations.**
1. **Require Founder badge holders to have ≥30 days of trading
   history** (counted from first trade timestamp) before the badge
   actually mints. Defers all 1,000 slots until 30 days post-launch.
   Bots can still try, but they have to keep wallets active for 30
   days, raising capex and expected detection.
2. **Founder claims are funded-source-distinct.** Two wallets funded
   from the same source can't both claim. Indexer-enforceable.
3. **Stake gate ≥10,000 WICK** (not 10), and the WICK must be at
   least 60 days old. Pushes Founder eligibility into "real
   participant" territory.
4. **Drop the Founder badge entirely.** "First 1,000" is a Sybil
   magnet by definition. Replace with "first 1,000 to lose >$X across
   ≥10 distinct markets over ≥30 days" — same retention story without
   the bot-rush.

---

## A8 — "Razor's Edge" badge oracle gaming (Medium)

**Severity:** Medium. Requires oracle-side influence; lower probability
attack but high reward when feasible.

**Setup.** Razor's Edge requires winning a TOUCH where the touch-price
was within 1bp (0.01%) of the barrier. The attacker either operates a
random-walk market (where "oracle" is the deterministic walk seeded at
T-0) or operates a Predict-backed market they can MEV.

**Step-by-step (random-walk case).**
1. Attacker's `random_walk_driver` is seeded by the same lock-in seed
   that A3 grinds.
2. Pre-compute the simulated path. Find a TOUCH event where the path
   crosses the barrier by exactly `(barrier × 1e-4)` mist or less.
3. Open a TOUCH position on that barrier *just* before that path
   tick.
4. Wait for the path to barely cross the barrier. `mark_hit` fires.
5. Indexer sees the TOUCH redemption matched a path-tick where
   `|tick_price - barrier| < barrier * 0.0001`. Badge mints.

**Step-by-step (Predict-driver case).**
1. Attacker is a Predict CLOB taker. They observe order book.
2. They submit a small TOUCH position on a barrier just above current
   price.
3. They place a *just-large-enough* market order on Predict to nudge
   the marked price exactly to `barrier + 1bp`.
4. Predict updates, oracle observes, `mark_hit` fires. Badge mints.

**Economic impact.**
- Razor's Edge is **rare** tier (less mythic than Founder, less
  common than First Wick). Floor on rare badges = $50–$200.
- Per-attack iteration: ~1 SUI of stake + ~1–10 SUI of CLOB nudge
  capex (refundable if not all consumed). **ROI per badge: ~$50–$200
  net.**
- Repeatable per address — attacker can mint hundreds (one per
  address) and dump.

**Existing controls.** None badge-specific. The "Witness" badge has
a frontrunning concern (mark_hit) but Razor's Edge has no anti-grind.

**Mitigations.**
1. **Per-address cap of 1 on Razor's Edge.** Already implied by spec
   ("one First Wick per address forever") but should be made explicit.
2. **Razor's Edge requires the TOUCH to be the *first* path
   observation crossing the barrier**, not "any TOUCH within 1bp".
   That makes deterministic-seed grinding harder (you need the path
   to first-touch within 1bp, not just touch-then-cross at any
   point).
3. **Anti-MEV check on Predict markets**: badge does not mint if the
   tx that triggered `mark_hit` was *also* the tx that placed the
   nudge order on Predict. Indexer-side correlation check.

---

## A9 — "Spread Architect" 4-leg PTB padding (Low)

**Severity:** Low (griefing). Cheap to perform, cheap to defend
against, low extraction value, but worth noting because the badge is
rare-tier.

**Setup.** Spread Architect requires a 4+ leg PTB spread with positive
net PnL. A trader who legitimately straddles 4 markets earns it. An
attacker can pad with 4 dust positions in one PTB.

**Step-by-step.**
1. Open 4 dust positions (1000 mist each) across 4 different markets,
   one PTB.
2. Tag with `spread::tag(spread_kind=CUSTOM, [...4 positions])`.
3. Wait for one or more to be net-positive (random chance ≥ 50%).
4. Badge mints.

**Economic impact.**
- Negligible per-attack value: rare-tier badge floor ~$50.
- Repeatable per address; trivial to spam.

**Existing controls.** None spec'd. The `spread::tag` function
asserts position ownership but not minimum position size or
strategic intent.

**Mitigations.**
1. **Minimum stake per leg** (e.g. ≥0.1 SUI or ≥1% of vault depth).
2. **Spread Architect requires spread net PnL ≥ 5x average leg
   stake** — i.e. a real coordinated payoff, not a dust-survivor.
3. **Per-address cap of 1.**

---

## A10 — Stake-then-claim-then-unstake dividend timing (Medium)

**Severity:** Medium. Crosses the boundary into tokenomics (§5 of
that doc) but materially affects tournament economics because the
"10% pot burn to stakers" is an unscheduled inflow.

**Setup.** The spec says 10% of the tournament pot is burned to fund
WICK staking rewards. WICK staking has a 48h dividend cliff and 7d
unstake delay (per tokenomics §5.1). But the cliff is *forward-
projected* from `acc_per_wick_at_stake_time + 48h`, which means a
staker who *has been staked* for >48h before tournament settle gets
the dividend immediately.

**Step-by-step.**
1. T-49h before tournament settle: attacker stakes a meaningful chunk
   of WICK (say 100,000 WICK if they have it). Now 48h cliff is
   already cleared by the time of the tournament.
2. Tournament settles. 10% of pot routes to staking pool. `acc_per_wick`
   bumps. Attacker's `pending` includes their pro-rata of this bump.
3. Attacker calls `claim()` immediately — passes cliff check, gets
   their share (denominated in tournament collateral, e.g. SUI).
4. Attacker calls `initiate_unstake()`, waits 7d, gets WICK back.

**Economic impact.**
- Per-tournament: 10% of 1,247 SUI = 125 SUI to stakers. With 1M
  total WICK staked and attacker holding 100k = 10% share, attacker
  extracts 12.5 SUI per round. **~$37/round, ~$13k/year.**
- This is *legitimate* by the spec — no exploit per se. But it's
  a structural incentive that any holder of meaningful WICK will use,
  meaning the "burn to stakers" mechanic is captured by whales who
  did not necessarily participate in the tournament. UX problem.
- The 30% lifetime claim ceiling (Layer 4) does cap this at 30% of
  lifetime losses. So the attacker has to be a real loser or buy
  WICK on secondary.

**Existing controls.**
- 48h dividend cliff (gates first-time stakers).
- 7d unstake delay (delays exit but doesn't prevent claim).
- 30% lifetime-loss claim ceiling (caps total dividend extraction).

**Mitigations.**
1. **Tournament burn vests over 30 days into the staking pool** rather
   than dropping in atomically at settle. Smooths the spike, prevents
   tournament-timed stake-and-claim from being meaningfully different
   from background staking.
2. **Tournament burn split**: 5% to existing stakers (cliff-protected),
   5% to *tournament participants* (reward those who actually showed up).
   Aligns the incentive.
3. **Snapshot stake at T-7d** for tournament-burn distribution. Anyone
   who staked in the last 7 days doesn't share in this round's burn.
   Forces real long-term staking.

---

## A11 — Cross-window 24h leaderboard arbitrage (Medium)

**Severity:** Medium. Repeatable, but capped by the 24h window and
the "top 10 each get a small WICK bonus mint" reward sizing.

**Setup.** The 24h leaderboard resets every UTC midnight. A trader who
banks all their winning trades in one UTC day can inflate a single
day's leaderboard rank, then bank losses in a different day to *also*
qualify for tail-end "comeback / improvement" surfaces.

**Step-by-step.**
1. Day 1 (UTC): take a heavy losing trade at 23:59 UTC. PnL hit lands
   in Day 1's window only.
2. Day 2 (UTC): take a corresponding winning trade at 00:01 UTC.
   PnL gain lands in Day 2's window only.
3. Result: Day 1 leaderboard shows attacker as a big loser (qualifies
   for "Comeback Kid"-adjacent surfaces, or for rebate programs that
   reward losers). Day 2 leaderboard shows attacker as a big winner
   (qualifies for top-10 WICK bonus mint).
4. Net realized PnL across both days ≈ 0. Attacker collects badges and
   bonus from both surfaces.

**Economic impact.**
- 24h top-10 WICK mint, sized at "small" — let's say 100 WICK per
  rank per day. WICK on secondary at ~$0.01–$0.10 per WICK = $1–$10
  per day per rank captured. **Per-attacker per-day: ~$10.**
- Annualised: ~$3.6k per attacker for the leaderboard mint alone.
- Compounds with A6 (comeback) if the loss-day qualifies.

**Existing controls.** Tie-break by trade count (lower wins) — doesn't
help; this is an absolute-PnL inflation, not a tie. Wash filter is
intra-market intra-5min; doesn't catch cross-window timing.

**Mitigations.**
1. **Use a *rolling* 24h window** (now − 24h to now), not a fixed
   midnight reset. Attacker's loss and gain land in *every* window
   that spans both, so they cancel.
2. **Score tiebreak by *consistency*** — penalise traders whose
   intra-day PnL variance exceeds N standard deviations. The
   midnight-straddling pattern shows up immediately.
3. **24h bonus mint requires positive PnL across the prior 7d as
   well** — single-day inflation doesn't capture multi-day signal.

---

## A12 — Premium-tournament `min_wick_staked` bypass via stake-before / unstake-after (Medium)

**Severity:** Medium. Specific to "premium" tournaments where the
optional `min_wick_staked` flag is on.

**Setup.** Premium tournaments require ≥`min_wick_staked` (e.g.
1,000 WICK) to enter. The check happens *at entry time*. If the
WICK can be unstaked or transferred *during* the round, attacker
games this.

**Step-by-step.**
1. Attacker has 1,000 WICK staked. They enter the premium
   tournament from wallet `W1`. Check passes.
2. Attacker calls `initiate_unstake()` from `W1` immediately after.
   Per tokenomics, this starts a 7-day countdown but *the WICK is
   still in the staking pool* for that 7 days.
3. Wait — the WICK is *not* immediately movable. Attack as
   described requires either (a) unstake delay bypass, or (b)
   ability to transfer WICK *before* unstake completes.
4. Real attack: rent the WICK. Attacker pays a holder for a 5-min
   loan via an escrow / flash-loan-like construct. WICK transferred
   to W1, W1 enters tournament, W1 transfers WICK back. Cost: ~1
   SUI per loan.

**Economic impact.**
- Per round: rents 1,000 WICK for a few minutes. At a hypothetical
  rental rate of 0.1 SUI per 1,000 WICK per round, rental cost is
  trivially ≪ tournament prize capture from A1 (~125–500 SUI).
- Net: same as A1 plus a small rental tax.

**Existing controls.** "Must have staked ≥`min_stake_for_prize` for
the entire window" — this is the *prize* gate, not the *entry*
gate. The entry gate is just "stake ≥ X at entry time". The "entire
window" requirement is for prize payout. *Need to check the actual
implementation:* if "entire window" is enforced at payout time, this
attack only works for premium-entry, not premium-prize.

**Mitigations.**
1. **Both entry and prize gates should require WICK staked for the
   *entire entry window + tournament window***. So 30 minutes + 5
   minutes = 35 minutes minimum stake duration, snapshotted at
   T-30min, payout-checked at T+5min.
2. **WICK staked for premium-tournament eligibility is flagged
   `tournament_locked` and cannot be unstaked or transferred until
   T+5min**. Forces real lockup.

---

## A13 — Look-alike badge package griefing (Low)

**Severity:** Low (UX/UI griefing, no fund loss).

**Setup.** Badges are Display-NFTs minted by `wick::badge` from the
canonical package. Sui's Display registry resolves badge metadata by
struct type — but the frontend's `getOwnedObjects` filter is
type-prefixed by package_id. An attacker can deploy a *different*
package with a `Badge` struct of the same shape and mint look-alike
NFTs.

**Step-by-step.**
1. Attacker publishes `attacker_pkg` with `module badge { struct Badge { ... } }`
   matching the field shape of `wick::badge::Badge`.
2. Attacker mints 1M look-alike Founder badges to spam wallets.
3. Spam wallets show up in any wallet UI's "NFTs owned" section
   with the same image (Display URL is attacker-controlled but can
   point to the real Wick CDN).
4. Users get confused; some Wick frontends that filter only by
   *struct name* (not full type incl. package) display these.

**Economic impact.**
- No direct fund loss.
- Harms protocol perception and creates support-cost burden.
- If frontend implementers are sloppy, can fool users into believing
  spam wallets are "Founder" holders.

**Existing controls.** Sui Display is package-id-keyed, so a
correctly-implemented frontend filters by full type. Spec doesn't
explicitly require this.

**Mitigations.**
1. **Frontend `getOwnedObjects` filter MUST include full type
   string** (`{packageId}::badge::Badge`) — never match on `Badge`
   alone.
2. **Indexer asserts package_id of every `BadgeAwarded` event**
   matches the canonical published Wick package_id. Off-package
   events are dropped.
3. **Add a `wick_signature: vector<u8>` field** to the `Badge` struct
   that's a deterministic HMAC of `(kind, owner, serial)` keyed by a
   well-known constant. Real frontend shows a "verified" checkmark
   only on badges with valid signature. (Cosmetic, but useful.)

---

## A14 — `mark_hit` frontrunning for Witness badge farm (Low-Medium)

**Severity:** Low-Medium. Combined with bot orchestration this is a
small but persistent extraction.

**Setup.** "The Witness" badge is awarded to the address that calls
`mark_hit` on a market they have no position in (good citizen) +
small SUI bounty.

**Step-by-step.**
1. Attacker runs a keeper that monitors all open markets' path
   observations.
2. As soon as a barrier is crossed on any market the attacker has no
   position in, attacker fires `mark_hit` from a fresh address (no
   prior position).
3. Witness badge mints + bounty paid.
4. Repeat across markets. With Sui's ~0.5s finality the attacker
   typically wins the race vs the legitimate keeper.

**Economic impact.**
- Witness is *common* tier, but the bounty is "small SUI". Spec says
  "fixed and small enough not to be MEV-attractive". TBD what "small"
  is — let's say 0.1 SUI. **Per-mark_hit: ~$0.30.** Across ~100
  markets per day: **$30/day.**
- Real cost: attacker DoSes the legitimate keeper, which the protocol
  was relying on to drive timely settlement. Markets settle later
  than expected, harming trader UX.

**Existing controls.** "Bounty fixed and small". Doesn't address
keeper-DoS angle.

**Mitigations.**
1. **Bounty escalates linearly with delay since barrier touch**
   (0 SUI for first 5s, full bounty by 60s). Keeps the protocol
   keeper's bounty ≤ attacker's by design.
2. **Per-address cap of 5 Witness badges per day**. Mythic-tier
   farming across many wallets remains possible but bounded.
3. **Witness eligibility requires the calling address to have ≥1
   real losing trade in the last 7d**. Filters fresh keeper bots.

---

## Summary table

| # | Attack | Severity | $/day estimate (single attacker) |
|---|---|---|---|
| A1 | Sybil tournament entry | Critical | $400–$1,800 |
| A2 | `bulk_open` PTB exploit | Critical | (compounds A1) |
| A3 | Seed grinding via prev-block | High | $50–$500 |
| A4 | Late-entry seed read | Medium | $50–$150 |
| A5 | Wash trading PnL inflation | High | $200–$500 |
| A6 | Comeback sub-pot double-dip | High | $185 (capped) |
| A7 | Founder badge bot rush | High | $200k–$1M one-shot |
| A8 | Razor's Edge oracle gaming | Medium | $50–$200/badge |
| A9 | Spread Architect padding | Low | ~$50/badge |
| A10 | Stake-then-claim timing | Medium | $37/round |
| A11 | Cross-window 24h arbitrage | Medium | $10/day |
| A12 | Premium `min_wick_staked` bypass | Medium | (compounds A1) |
| A13 | Look-alike badge griefing | Low | UX harm only |
| A14 | `mark_hit` bounty / Witness farm | Low-Medium | $30/day |

**Compound estimate** for a single sophisticated attacker running A1+A2+A5+A6+A11
on day-one of mainnet, no defenses applied: **~$1,000–$2,500 per day,
~$365k–$910k annually**. Plus a one-shot $200k–$1M Founder NFT capture.

**Top three mitigations to ship first**, in priority order:
1. Replace the `hash(prev_block, T-0)` seed with `sui::random::Random` VRF +
   commit-reveal. Closes A3 and A4.
2. Cluster-aware Sybil filter in the indexer using funding-source graph,
   gating both prize payouts (A1) and comeback sub-pot (A6). Make the
   `bulk_open` PTB cap entries at 5 distinct owners (A2).
3. Founder badge: 30-day delay + 60-day-old WICK requirement, OR drop
   the badge entirely and replace with a behaviour-based mythic.

Without those three, the gamification layer is a sieve.

---

*End of red-team pass for the gamification surface. Recommend an immediate
follow-up pass on tokenomics §5 (the anti-loop layers) and indexer §3
(the projector idempotency assumptions, especially for `BadgeAwarded`).*
