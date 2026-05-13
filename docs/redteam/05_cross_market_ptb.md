# 05 — Red Team: Cross-Market and PTB-Orchestration Attacks

> **Scope.** This is a black-hat audit of Wick's *cross-market* and
> *PTB-orchestration* surface — the place where multiple markets, multiple
> underlyings, the global OI cap from doc 04 §7.5, and Sui's atomic
> Programmable Transaction Block primitive collide. Per-market exploits
> (single market, single side) are covered elsewhere; here we assume each
> market in isolation is correctly implemented and look for the joint risks.
>
> All numbers below use the doc-04 reference parameters: `α = 10%`, `β = 0.5%`,
> `α_global = 25%`, `m = 1.8x`, `base = 50 bps`, `k_d = 200 bps`,
> `k_v = 4000 bps`, `f_max = 50%`. Vault sizes use `V = $1,000,000` USDC for
> readability — every drain figure scales linearly with `V`.
>
> Twelve attacks below; the headline one (#1, "Synthetic Mega-Position") is
> the most dangerous and is *not* defeated by the proposed `α_global`.

---

## Attack 1 — Synthetic Mega-Position: Defeating α_global via Barrier Stacking

**Severity:** Critical. Direct loss-of-funds path that survives the proposed
§7.5 mitigation.

**Setup.** Doc 04 §7.5 proposes a global OI cap per `(collateral, underlying,
side)` of `α_global = 25%`. Reading carefully: the cap aggregates exposure on
the *same side string* (TOUCH / NO_TOUCH) across all markets on one
underlying. It does **not** look at *barrier geometry*. Every TOUCH market on
BTC is treated as fungible from the cap's perspective regardless of whether
the barrier is at $50k or $500k.

This is the soft spot. Two TOUCH-ABOVE markets at very different barriers
have very different probabilities of paying out, but both consume
`payout · stake_count` against the same `(USDC, BTC, TOUCH)` bucket.
A trader can fill the global cap with *out-of-the-money* TOUCH legs that
have near-zero hit probability, leaving plenty of headroom on a
*deep-in-the-money* TOUCH leg the trader actually wants — but the cap is
already saturated by the cheap legs which the protocol still has to honor
if a flash crash hits.

**Step-by-step (the inverse — fill cap with realistic OTM legs first).**
Assume BTC at $65,000, vault `V = $1,000,000`. `α_global = $250,000` of
TOUCH OI. With `m = 1.8x`, max stake collected on TOUCH side is `$250k / 1.8
≈ $138,889`.

PTB `T0` (signer is one whale wallet):

```
inputs: [coin_usdc_300k, market_btc_touch_70k, market_btc_touch_75k,
         market_btc_touch_80k, market_btc_touch_120k, market_btc_touch_200k,
         market_btc_touch_500k, clock]
cmd 1 : SplitCoins(coin_usdc_300k, [27_777, 27_777, 27_777, 27_777, 27_777,
                                    27_777, /* +small headroom */])
cmd 2 : market::open<USDC>(market_btc_touch_70k, TOUCH, c1, clock, ctx)
cmd 3 : market::open<USDC>(market_btc_touch_75k, TOUCH, c2, clock, ctx)
... // five more identical opens
cmd 8 : TransferObjects([positions...], sender)
```

The whale now holds a $138,889 TOUCH portfolio with `$250k` in *combined*
payout obligation that the global cap permits. Of those six TOUCH legs, only
the $70k market is realistically reachable in the 30-min expiry; the rest
are camouflage that consume cap without consuming the whale's hit-probability
budget.

**The kicker.** The whale now opens a *seventh* TOUCH market — a brand-new
$66k barrier — but the global cap is full. They cannot. So they wait for the
keeper to settle one of the six (or self-settle a far-OTM leg by calling
`mark_hit` once `path_observation` records, which it will not for $500k…)
and then open. That sounds like the cap working.

But the *real* attack runs the other way. The whale opens a single
$66k-barrier TOUCH leg first, *then* fills the cap with five OTM legs.
The OTM legs become camouflage that prevents *other traders* from opening
TOUCH on the $66k market because they would push past the global cap. The
whale has effectively **monopolized the live touch product** on BTC for the
next 30 minutes, with capital that is mostly free option premium because
the OTM legs are near-worthless to settle. When BTC ticks $66k, the whale
collects `$50k · 1.8 = $90k` payout and the OTM legs expire worthless
(refunding the losing-side stake — but to *the whale*, since they took both
sides on those camouflage markets in real form).

**Economic impact.** In one PTB the attacker locks competitors out of an
underlying for an entire epoch and harvests the touch payoff with sized
exposure. The vault drain on a successful $66k touch is `$50k · 1.8 · (1 −
f) ≈ $87.7k`, well above the headline §3.1 "max whale drain" of `0.21% · V
= $2,100` because the per-trade `β` cap binds *per market*, not against the
whale's combined position.

**Existing controls.** None in the current codebase (markets and global cap
are both pending phases). The doc-04 §7.5 proposal as written does not stop
this.

**Mitigation.**
1. Make `α_global` *barrier-distance-weighted*: contributions to the cap
   scale by an oracle-implied probability of touch, e.g. `weight =
   max(0.05, exp(-d²/2σ²))` where `d` is barrier distance in σ. OTM
   camouflage stops being free.
2. Forbid one address from holding TOUCH at >2 distinct barriers on the same
   underlying inside a single epoch. Spreads still work via 2-leg strangles;
   the 6-leg ladder cap-monopoly does not.
3. Add a *per-address-per-underlying-per-side* sub-cap of `5% · V`. The
   whale can still open 5%, but cannot *also* eat the cap from other
   traders.

---

## Attack 2 — Cross-Underlying Correlation Defeats Per-Underlying Caps

**Severity:** High when ETH (or any second risk-on asset) is added; Critical
during macro shocks.

**Setup.** `α_global` is per-underlying. BTC and ETH (post-launch) are >0.85
correlated. SUI is ~0.7 correlated to BTC over short windows. SP500 has
intraday correlation to BTC during macro events (rate cuts, ETF flows).
A single macro tick — a Fed surprise, an ETF approval, a geopolitical
shock — moves all four markets in the same direction within minutes. The
protocol's per-underlying cap pretends these are independent draws; they
are not.

**Step-by-step.** Vault = $1M USDC. `α_global = 25%` per (USDC, X, TOUCH).
A coordinated trader (or organic correlated flow) fills:

```
PTB T0:
  - $138k stake on BTC TOUCH-ABOVE +1% → $250k payout obligation
  - $138k stake on ETH TOUCH-ABOVE +1% → $250k payout obligation
  - $138k stake on SUI TOUCH-ABOVE +1% → $250k payout obligation
  - $138k stake on SP500 TOUCH-ABOVE +1% → $250k payout obligation
```

Total stake: $552k, total payout obligation: $1M = `100% · V`. Each
underlying's cap is satisfied. A single macro tick triggers all four
TOUCH-ABOVE markets within seconds. After settlement, the vault owes $1M
in winning payouts but only collected $552k in stakes plus whatever NO_TOUCH
counterparty stakes existed (call it $200k from organic flow).

Net vault: starts at $1M, takes in $552k + $200k = $752k stakes, pays out
$1M · (1 − f_max) = $500k from settlement_lock, enqueues the remainder.
Equity post-event: `V_after + side_bucket − queue_total ≈ $250k + $200k −
$500k ≈ −$50k`. **Equity goes negative across the entire protocol from a
single correlated tick.**

**Economic impact.** Negative equity is allowed by Martingaler design, but
the *recovery time* assumes uncorrelated daily volume. After a macro shock
that drains four caps at once, daily volume itself often *halves* (risk-off
behaviour) — recovery is materially longer than the §5 estimate. UX
collapses to "every winner gets 50% haircut" (§7.4) for the duration.

**Existing controls.** None. Doc-04 §7.5 is per-underlying.

**Mitigation.**
1. Add a *correlation-bucket* cap. Group underlyings by realized 30-day
   correlation; cap aggregate exposure across the bucket at `α_corr = 40%`
   (more permissive than per-underlying because diversification is real,
   but still bounded).
2. Track an `equity_floor_breaker`: if equity drops below `−5% · V_before`
   in a single block, auto-pause `open_*` for 1 hour while keeper drains.
3. During macro shock windows (detected by oracle σ blowing past N stdev),
   raise `f` by a global multiplier of 1.5×.

---

## Attack 3 — PTB Ordering for Risk-Cap Headroom Stealing

**Severity:** Medium. Steals cap from honest concurrent traders.

**Setup.** Per-side OI cap is checked at `open_*` entry against current
`oi_side`. In a PTB, multiple opens execute *sequentially within one
transaction*. Sui shared-object consensus serializes the PTB against other
transactions but the PTB's *internal* command order is the signer's choice.

**Step-by-step.** Vault `V = $1M`. Market M1 has `oi_touch = $90k` (vs cap
`α · V = $100k`). Honest trader Bob is about to PTB-open `$10k` on M1
TOUCH (legitimately fits). Attacker Alice front-runs Bob's PTB with her own
PTB:

```
Alice PTB:
  cmd 1: market::open<USDC>(M1, TOUCH, $10k_coin)  // fills cap to $100k
  cmd 2: market::open<USDC>(M1, NO_TOUCH, $10k_coin) // refunds in 30s either way
```

If consensus orders Alice before Bob, Bob's open reverts (`oi_touch +
$10k > α · V`). Alice has paid only the impact fee on the wash trade
(she'll redeem one side, lose the other — net cost ≈ stake × house edge ≈
2.5% of $10k = $250) to bump Bob out of the market. If Bob is a market
maker quoting both sides, Alice has just denied competing liquidity at the
moment she wants to dump size.

**Economic impact.** Modest direct cost ($250) but compounds: an attacker
running this at every cap-binding moment hijacks pricing power on the most
liquid markets.

**Existing controls.** Sui consensus prevents simultaneous double-spend but
does not order by intent. Per-block fairness is best-effort.

**Mitigation.**
1. *Cap-burst dampening*: if `oi_side` exceeds `0.95 · α · V`, charge a
   surcharge of `5% · stake` on opens that push past `0.95`. Alice's wash
   becomes uneconomic.
2. Reserve the last 10% of each side cap for opens that *reduce* the
   side imbalance (the smaller side gets the headroom).
3. Make `open_*` revert with `EWouldExceedCap` instead of clipping — and
   surface the remaining headroom to the UI so honest traders can size
   precisely without racing.

---

## Attack 4 — Triangular Barrier Synthetic vs Risk Math

**Severity:** Medium. Free directional exposure mispriced as flat.

**Setup.** Consider three TOUCH-ABOVE markets on BTC at $50k, $55k, $60k.
A trader opens:

```
Long  TOUCH at $50k :  $30k stake, payout $54k
Short TOUCH at $55k :  $30k stake on NO_TOUCH side, payout $54k
Long  TOUCH at $60k :  $20k stake, payout $36k
```

If the protocol's risk math (impact fee `f`, cap accounting) treats the
three legs as independent — which it does — the trader has constructed a
synthetic narrow-strike payoff: positive if BTC closes between $55k and
$60k (NO_TOUCH at $55k pays + TOUCH at $60k stays alive but never hits +
TOUCH at $50k hits). The protocol sees three distinct positions; the
trader sees one combined exposure with a tightly bounded payoff
distribution.

Where the protocol mis-prices: the impact-fee `d` (decisiveness) component
is computed *per market*. If BTC hovers around $55k–$60k for the epoch,
the trader's NO_TOUCH at $55k will be a winner against a market that was
locally lopsided to TOUCH (because everyone else thought it would touch).
The trader collects the win at low `d`, paying the small `f`, while the
protocol's actual *combined* exposure to this trader is a focused
volatility-short — exactly the kind of structured trade that should pay
extra fee.

**Step-by-step.** Same structure; PTB:

```
PTB:
  cmd 1: SplitCoins($80k_usdc, [$30k, $30k, $20k])
  cmd 2: market::open<USDC>(M_50k, TOUCH,    c1, clock, ctx)
  cmd 3: market::open<USDC>(M_55k, NO_TOUCH, c2, clock, ctx)
  cmd 4: market::open<USDC>(M_60k, TOUCH,    c3, clock, ctx)
  cmd 5: spread::tag(STRANGLE_LIKE, [p1, p2, p3])
  cmd 6: TransferObjects([p1, p2, p3], sender)
```

`spread::tag` (per doc 08 §4) is purely cosmetic — it emits an event but
does not feed risk math. The trader's combined position has a much narrower
payoff distribution than three independent bets, but the protocol charges
fees as if independent.

**Economic impact.** A practiced strategist running 4-leg condors pulls
~3–5% structural edge per epoch on top of the fair-odds baseline. Across
hundreds of trades this erodes the protocol's positive drift from §4.

**Existing controls.** `spread::tag` exists for UX, not risk. No
risk-aware multi-leg netting.

**Mitigation.**
1. Detect adjacent-barrier opposite-side opens within the same PTB and
   apply a *spread surcharge* equal to the difference in barrier distance
   weighting: positions inside the implied "wedge" pay fee on the wedge
   width, not on each leg's notional.
2. If a single signer holds >3 legs across barriers on the same underlying
   in the same epoch, raise their per-position `k_d` by 100 bps.

---

## Attack 5 — Settlement Cascade Sequencing for Queue-Front Position

**Severity:** Medium-High. Manipulates payout order in the FIFO queue.

**Setup.** `lock_settlement` and `settle_market_*` are permissionless
(any caller, after expiry). Doc 01 §2.3 routes losing-side stake into
`treasury` *if `queue_total == 0` at the start of settle*, otherwise into
`side_bucket`. The decision is made per-call, in the order calls land in
the block.

When many markets expire in the same epoch (e.g. five 30-min markets all
opened at T-25min), an attacker can sequence settlement to control:

1. Which markets pay winners *directly from settlement_lock* (clean payout)
   versus *enqueue shortfalls* (queued debt).
2. Whether their *own* winning position is at the head of the queue or
   the tail (FIFO determines drain order).

**Step-by-step.** Vault `V = $400k`. Five markets expire at T+0, each with
$120k winning exposure on TOUCH. Attacker holds a winning position on M1
sized at $90k payout. PTB:

```
PTB (Attacker, executed at T+1):
  cmd 1: market::lock_settlement(M1, oracle, clock)  // lock $120k → SL=120, T=280
  cmd 2: market::settle_market_touch(M1, vault)      // QT was 0 → losers credit T
                                                      // attacker's $90k → enqueued? No,
                                                      // SL covers, so paid direct
  cmd 3: market::lock_settlement(M2, oracle, clock)  // lock $120k → SL=120, T=160
  cmd 4: market::settle_market_touch(M2, vault)      // M2 winners paid from SL
  cmd 5: market::lock_settlement(M3, oracle, clock)  // lock $120k → SL=120, T=40
  cmd 6: market::lock_settlement(M4, oracle, clock)  // lock min($120k, $40k) = $40k
                                                      // SHORTFALL on M4!
  cmd 7: market::settle_market_touch(M4, vault)      // M4 winners → enqueued for $80k
  cmd 8: market::lock_settlement(M5, oracle, clock)  // T=0, SL=$0 lockable
  cmd 9: market::settle_market_touch(M5, vault)      // M5 winners → fully enqueued
```

The attacker's M1 win is paid in full, immediately, and the *other
markets'* winners get queued. If the attacker *also* held positions on M4
or M5 (anonymously, via a Sybil), they could have reversed the order to
queue someone *else's* position behind theirs.

The deeper exploit: by interleaving locks and settles, the attacker
controls the `queue_total == 0` test in step 6's `settle` — they can make
losing-side stakes route to `treasury` (helping their next own market) or
to `side_bucket` (helping later queue heads — i.e. their own queued
positions). Either choice can be made favorable.

**Economic impact.** Doesn't drain the vault directly, but degrades the
protocol's payout fairness commitment. Honest traders who happened to be
on the wrong settle order get queued; the well-resourced PTB-runner
collects in full. Over time this drives professional flow to PTB-runners
and away from honest UX.

**Existing controls.** None. Settlement is permissionless and order-
sensitive.

**Mitigation.**
1. Within one block, batch all `lock_settlement` calls *before* any
   `settle_market_*` call. Implement as: `settle_market_*` reverts if any
   other market in the same block is still in `OPEN` status past expiry.
2. Require a 1-block delay between `lock_settlement` and
   `settle_market_*` so the order of locks (which the attacker can
   sequence) doesn't determine payout order.
3. Pay queue heads via *round-robin across markets* rather than strict FIFO
   when multiple shortfalls land in one block.

---

## Attack 6 — Listing Seed Sybil Refund Farming

**Severity:** Low-Medium. Free-money loop on creator refunds.

**Setup.** Per project spec (and doc 04 §1.1), market creation seeds
`seed_collateral` into `V`. Per doc-08 §7 and intent in `02_…fee.md`, the
listing seed is *refundable post-settlement if the market saw real trades*
— a creator-incentive to bootstrap markets while avoiding spam.

**Step-by-step.** Attacker controls 6 wallets. For each market they want
to spawn:

```
Wallet A: market::create_touch_above(barrier, expiry, seed=$100)
Wallet B: market::open(M, TOUCH, $5)   // dust, just to trip "real trade"
Wallet C: market::open(M, NO_TOUCH, $5)
Wallet D: market::open(M, TOUCH, $5)   // gives the appearance of crowd
Wallet E: market::open(M, NO_TOUCH, $5)
... settle ...
Wallet A: market::redeem_seed(M)       // gets $100 back
Wallets B–E: redeem their dust
```

If the "real trades" criterion is mere `trade_count > 0` (or a low
threshold like `> 3`), the attacker pays the impact fee on the dust trades
(near zero in absolute terms, ~$0.50 total) plus gas, in exchange for
keeping their seed. Net cost ≈ $1, but they have spawned a market that
clutters the UI, pollutes the `α_global` denominator (see #7), and gives
them a venue for self-trading badge farming.

If the refund criterion is volume-based (e.g. `trade_volume > 10×
seed`), the attacker just escalates dust trades — still cheap because
both sides of dust trades come back to the attacker minus a tiny fee.

**Economic impact.** Direct: ~$0 per market. Indirect: market spam
pollutes the active-market list, dilutes keeper attention, and (per #7
below) inflates the `α_global` cap if it's denominated against
`vault_value`.

**Existing controls.** None implemented; the design intent for refund
gating is described loosely.

**Mitigation.**
1. Refund criterion: *unique signer count* on real trades ≥ 10, with a
   decay window (signers who only traded the dust amount don't count).
2. Cap total markets one address can have refunded seeds on per epoch
   (e.g. 5/day).
3. Make the seed *non-refundable* but credited to staker_fees of stakers
   on the underlying — turns spam into a Sybil tax.

---

## Attack 7 — Vault Inflation for Cap Headroom

**Severity:** High. Briefly raises every cap proportionally.

**Setup.** All caps (`α`, `β`, `α_global`) are denominated as fractions of
`V` (or `treasury` in the Martingaler model). If an attacker can transiently
inflate `V` they can transiently inflate every cap and open a position
sized to the inflated cap, then deflate `V` back, leaving the protocol with
an oversized obligation relative to true `V`.

**Step-by-step.** Vault `V = $1M`, `α = 10%`, so per-market TOUCH cap is
$100k payout. Attacker wants to open $200k payout on M1 TOUCH (= 2× cap).

```
PTB (Attacker controls a 2nd address with $1M USDC):
  cmd 1: vault::donate(coin_usdc_1M)         // V grows to $2M (if a donate
                                              //  function exists)
  cmd 2: market::open(M1, TOUCH, $112k_usdc) // payout $200k, cap = $200k OK
  cmd 3: vault::withdraw(...)                // attempt to reverse the donate
```

Doc 01 §7.2 #9 explicitly warns "don't expose a public `donate`." Good. But
several legitimate paths inflate `V` similarly:

- **Open then immediately abandon a position.** Open `$X` on a near-flat
  market; both sides paid in. Then in the *same PTB*, run the open-cap-
  binding trade against the inflated `V`. Then in a follow-up tx, redeem
  the abandon position. The cap was inflated for the binding open.
- **Loan-funded opens.** Borrow USDC on Scallop or Suilend (instant flash
  borrow if available), open both sides on a no-volume market to inflate
  `V`, then in the next PTB attack the cap, then unwind. Sui doesn't have
  EVM-style flash loans but several lending protocols offer single-block
  open/close that approximates one.
- **LP deposit then withdraw.** If LP deposits count toward `V` for cap
  purposes (they should, they back payouts), an attacker can flash-LP at
  the start of their PTB.

**Economic impact.** A successful 2× cap breach turns the §3.2 "crowd"
analysis adversarial: instead of `0.10 V` net drain, attacker lifts `0.20
V`. With `V = $1M`, that's `$200k` payout obligation against a vault that
returns to $1M post-PTB. The fee mitigation (`f ≈ 0.025`) only saves
$5k. Net drain over a successful trade is `$200k · 0.975 − stake` ≈
$83k.

**Existing controls.** "No public `donate`" is one mitigation. Cap-on-`V`
denomination is the structural exposure.

**Mitigation.**
1. Compute caps against a *time-averaged* `V` (e.g. 1-hour EMA), not
   spot. Donations and flash-LP can't move a 1-hour EMA in one tx.
2. Subtract just-deposited LP capital from cap-eligible `V` for a
   cool-down window (e.g. 5 minutes after deposit, that capital doesn't
   count toward `α · V`).
3. In the open path, recompute the cap *both* with current `V` and with
   `V_at_block_start - withdrawals_in_block`; require both checks to pass.

---

## Attack 8 — Pre-Settlement Position Transfer to Sybil

**Severity:** Medium. Bypasses per-address claim caps and tournament caps.

**Setup.** Doc 01 §1.1 mints positions as `Position { … }` objects with
`key, store`. Per the CLOB design (doc 07), positions become Coins on a
secondary market — explicitly transferable. The badge / leaderboard / claim
system will inevitably grow per-address rate limits (e.g. anti-Sybil
"leaderboard PnL is filtered if same address wash-trades", §7 of doc 08;
tournament `max_stake_total` per entry). Between expiry and `redeem_*` the
position is transferable; an attacker can fan winning positions out to
fresh addresses to evade per-address controls.

**Step-by-step.** Tournament context. Entry has `max_stake_total = $100`
worth of trading; PnL credited to the entry. Attacker holds 4 winning
positions across the 5 tournament markets, total stake $80, total payout
$144 (so PnL = $64). Tournament prize curve: rank-1 = 30% of pot. Pot is
$10,000 (10,000 entries). Attacker is in rank 30 with $64 PnL.

Strategy: fan the 4 winning positions to 4 fresh addresses, each of which
has a *separate* tournament entry. Each fresh entry shows PnL of $16
(from one of the legs). Attacker now has 4 entries each near rank 200
instead of one entry at rank 30. Loss of value? It depends on the prize
curve shape — for the 30% / 18% / 12% / 5×7 = 35% curve, going from
rank-30 to four rank-200s is *worse*. So this doesn't work for tournaments
exactly as described.

But the same attack works against *leaderboards*: the 24h leaderboard's
top-10 each get a small WICK bonus mint. Splitting one rank-1 PnL into
ten rank-1-tied positions across 10 fresh addresses can capture **ten
rank-1 mints** if the tie-handling rule (§3 doc 08: "exact ties for a
paid rank split that rank's prize equally and skip the next slot") is
implemented for leaderboards the same way. The attacker prepares the 10
fresh wallets, transfers winning positions to them between expiry and
the leaderboard snapshot, and harvests the multi-mint.

For badge farming (badges are non-transferable, so the position transfer
needs to happen *before* the trigger fires): the trigger is in `redeem`,
so transfer pre-redeem; each fresh address earns "First Wick" on its own
redeem. 100 fresh wallets = 100 "First Wick" badges from one trade.

**Economic impact.** Multiplies leaderboard / badge rewards by N for an
N-wallet Sybil farm. Inflates the WICK distribution to one principal.
Distorts the "100,000 founder badges" hard cap.

**Existing controls.** Per doc 08 §7: "Address must have ≥ N real
(mainnet) trades before counting on mainnet leaderboards." That's a real
mitigation but easy to amortize — one trade per wallet per badge. Also
per §7: "wash-trading detection in indexer." Detecting *transfer-then-
redeem* requires graph-walking object provenance, which the indexer must
explicitly do.

**Mitigation.**
1. Position objects acquire a `last_owner_change_ms` field on transfer.
   Triggers like badges and PnL attribution require
   `now − last_owner_change_ms > min_hold_ms` (e.g. 6 hours).
2. Tournament PnL is credited to the *original opener* (recorded at open),
   not the redeemer. Transfers don't migrate tournament credit.
3. Leaderboard tie-handling: tied entries from addresses sharing
   provenance (the same upstream funding wallet within the past 7 days)
   collapse into one entry.

---

## Attack 9 — Multi-Leg Camouflage for Impact-Fee Avoidance

**Severity:** Medium. Pays house-edge on noise legs to dodge it on real legs.

**Setup.** Per doc 02 + doc 04 §1.4, the impact fee is `f(d, v) = base +
k_d · d + k_v · v`. `d` is per-market decisiveness (lopsidedness). A
trader who is the *only* TOUCH bettor on a market sees `d ≈ 1` and pays
the full `f ≈ 250 bps` on win.

A multi-leg PTB lets the trader *manufacture* low-decisiveness legs:
opening both TOUCH and NO_TOUCH on the same market in one PTB makes the
market look balanced (`d ≈ 0`), then opening their *real* directional
trade on a *different* market while the first market's `d` is still being
recorded.

**Step-by-step.** Trader's real intent: $10k TOUCH on M_BTC_70k. M_BTC_70k
currently has `d ≈ 1` because no other TOUCH bettors. PTB:

```
PTB:
  cmd 1: market::open(M_BTC_70k, TOUCH, $5k)    // opens balanced volume
  cmd 2: market::open(M_BTC_70k, NO_TOUCH, $5k) // makes the market 50/50
  cmd 3: market::open(M_BTC_70k, TOUCH, $10k)   // real trade — but d is now
                                                 //  computed from updated state
                                                 //  which shows it as 50/50
```

If `d` is computed from `oi_touch / (oi_touch + oi_no_touch)` after each
open, the trader's $10k real open sees `d ≈ 0.5` instead of `d ≈ 1`,
saving 100 bps of impact fee on win = $90 saved. Net cost of the
camouflage: the wash-trade pair pays house edge on $5k each ≈ $250. So
this only saves money on big trades (>$100k where 100 bps > camouflage
cost). At those sizes it works.

**Variant — reverse-side dilution.** Trader opens NO_TOUCH first to
artificially raise the *opposite* side's `d`, making their TOUCH look less
decisive. Same idea, opposite direction.

**Economic impact.** $90 per $10k saved at small scale; ~$9k per $1M
saved at whale scale (where $250 of camouflage is rounding error). Erodes
the impact fee's role as the load-bearing safety term in §4.

**Existing controls.** None. `d` is a single-snapshot read.

**Mitigation.**
1. Compute `d` over a *time window* (e.g. 5-minute TWAP of the
   imbalance), not spot. Wash-camouflage in one PTB doesn't move the TWAP.
2. Detect intra-PTB opposing opens by the same signer on the same market;
   ignore them when computing `d` for subsequent opens in the same PTB.
3. Apply `f` based on *the trader's own contribution to imbalance* —
   `d_attribution_to_signer` rather than market-wide `d`.

---

## Attack 10 — Oracle Tick Bundling Inside Trade PTB

**Severity:** Critical if `path_observation::record_tick` is permissionless
during epoch.

**Setup.** Per `path_observation.move`, ticks are recorded against the
oracle's reported price. If the oracle source is push-based (Lazer, Pyth
push) and `record_tick` is callable by anyone in the same PTB as a trade
open, the trader can:

1. Submit oracle update (e.g. `pull_oracle_driver::update(signed_price)`
   where the price is favourable to their trade) as cmd 1.
2. Open the trade as cmd 2, capturing the favourable price as the *entry*
   price for any path-dependent payoff.
3. (If the oracle update is partial — only a tick recorded, not a full
   path — also call `record_tick` to mark the path observation history as
   *touched* before settlement.)

**Step-by-step.** Trader holds $10k stake. Wants to open NO_TOUCH on M1
(barrier $50k touch-above, current oracle price $49,990). If the trader
can push a tick at $49,950 (legitimate update with a slightly stale
signed price), the perceived distance to barrier expands and other
traders see NO_TOUCH as more attractive, diluting `d` on their next
TOUCH-side fill.

PTB:

```
PTB:
  cmd 1: pull_oracle_driver::push_signed_update(signed_msg_from_lazer_at_$49950)
  cmd 2: market::open(M1, NO_TOUCH, $10k)  // opens at the pushed price
                                            // also reads current oracle for d
```

If the signed message has a freshness window (e.g. 5 seconds) and the
trader holds onto a stale message slightly before publishing, they can
choose which oracle update bracket they publish in. Worse — if the path
observation accepts pushed prices into its tick history, the trader can
control whether the path is "more touched" or "less touched" when settle
happens.

**Economic impact.** Doc 04 §7.1 already identifies the related "informed
trader p > 0.57" failure case. PTB-bundled oracle pushing makes informed-
trade execution mechanically *easier* and more atomic.

**Existing controls.** Pull-oracle drivers usually validate signed
messages with publisher pubkey + timestamp + nonce. Implementation must
not allow the trader to *choose which signed message to publish* if
multiple are valid in the same window.

**Mitigation.**
1. Enforce a minimum delay between `push_signed_update` and any
   subsequent `open_*` in the same PTB or same block, by requiring that
   any open uses oracle data with `clock.now() - oracle_observation_ms ≥
   min_freshness` (e.g. 2 seconds) — i.e. you cannot trade on the price
   you just published.
2. Charge the impact fee using oracle data from `clock.now() - 30s` (a
   delayed read), not the latest tick.
3. Make `record_tick` callable only by a permissioned keeper or with an
   anti-MEV bond. Trader-rooted ticks always discount the trader's later
   trades in the same epoch.

---

## Attack 11 — Cross-Collateral Vault Asymmetry

**Severity:** Medium-High. Drains the smaller-collateral vault first.

**Setup.** Per AGENTS.md "multi-collateral SUI+USDC is locked" and doc 01
§7.3: `MartingalerVault<USDC>` and `MartingalerVault<SUI>` are independent
shared objects with independent caps. The two vaults have *very different*
sizes (USDC will dominate) and presumably very different daily volume.
SUI vault may be 1/10 the size of USDC vault initially.

Cap fractions are constant across both. So the SUI vault's `α · V_SUI` is
1/10 the USDC vault's. The same trader can open the same nominal exposure
on both vaults, but in *SUI terms* it's 10× more cap-binding on the SUI
vault.

**Step-by-step.** Vault sizes: `V_USDC = $1M`, `V_SUI = $100k` worth of
SUI. Both list the same BTC TOUCH market (collateralized in the
respective coin). `α_global` is per-collateral-per-underlying, so:
USDC TOUCH cap = $250k payout, SUI TOUCH cap = $25k worth of SUI.

Attacker sees BTC about to touch $70k. Opens:

```
PTB on USDC vault:
  cmd 1: market::open<USDC>(M_70k_USDC, TOUCH, $138k_usdc) // fills cap
PTB on SUI vault (atomic — both PTBs in the same Sui block):
  cmd 1: market::open<SUI>(M_70k_SUI, TOUCH, $14k_in_SUI)  // fills SUI cap
```

When BTC touches $70k, *both* vaults pay out at cap. USDC vault drains by
~$200k (post-fee). SUI vault drains by ~$20k of SUI. The SUI vault is
20% drained vs USDC's 20% — same percentage, but SUI vault is closer to
absolute insolvency in tx-count terms (with smaller average stake on SUI,
fewer offsetting losing trades come in to refill).

The asymmetric exploit: on the smaller vault, *recovery time* is much
longer because daily volume is also smaller. SUI vault may take 24 hours
to recover from a stress event that USDC vault recovers from in 3 hours.
During that 24 hours, every SUI winner takes f_max haircut. UX collapses
on SUI. Traders flee to USDC. SUI vault dies.

**Economic impact.** Vault death spiral on the smaller collateral. The
attacker doesn't need to *drain* the SUI vault, just stress it enough that
LPs withdraw (per §7.6 of doc 04 the LP withdrawal race is real),
collapsing the smaller vault first.

**Existing controls.** None specifically for cross-collateral asymmetry.
Each vault enforces its own caps in isolation.

**Mitigation.**
1. Cross-list market caps: the SUI version of "BTC TOUCH > $70k" and the
   USDC version share an aggregate cap, denominated in some shared unit
   (e.g. USD via oracle) at `α_cross = 35%` of combined vault value.
2. Per-vault circuit breaker: if a vault's `equity / V` drops below some
   threshold (say `−10%`), pause new opens on *that vault only*, not
   USDC.
3. LP withdrawal subordination per §7.6 doc 04 must apply per-vault, not
   per-protocol.

---

## Attack 12 — Tournament + Main-Market Double-Dip via Settlement Timing

**Severity:** Medium-High. Direct value transfer from main vault to
tournament winners.

**Setup.** Per doc 08 §1: tournament prize is paid from staked entry
fees (`pot: Balance<C>` on the `Tournament<C>` object). Main market
winnings are paid from the main `MartingalerVault<C>`. Tournament markets
*are* `Market<C>`s spawned on the underlying — and since tournaments are
pot-funded with seed liquidity (§1 "Equal-cost trades. Tournament
markets are protocol-funded `Market<C>`s with identical seed liquidity"),
they share the main vault for backing.

Now the timing: tournament settlement (`tournament::settle`) reads
each entrant's `realised_pnl_mist` and pays from `pot`. PnL is updated on
each `redeem`. If an entrant *redeems* their winning tournament position
(crediting `realised_pnl_mist`), the position pays from the main vault
*and* the tournament pot pays them their rank prize for that PnL. That's
double payment because the tournament pot was funded from entry fees —
but the *winning* tournament positions are also paid by the main vault
(since tournament markets use the main vault as backing per the spec).

**Step-by-step.** Tournament: 1000 entrants × 1 SUI = 1000 SUI pot.
Tournament markets are seeded with main-vault liquidity (let's say 5000
SUI of seed across the 5 markets). Attacker enters and wins big on
tournament markets — say their positions have PnL = +200 SUI from
correctly-called barriers.

At settlement:

1. Attacker calls `redeem_position(M_tournament, position)` →
   receives 290 SUI (180% of 200 SUI win) **from the main vault** (because
   tournament markets back to main vault). Profile updates
   `realised_pnl = +290`. (Or +200 — depends on how PnL is tracked, but
   either way it's funded by the main vault.)
2. Tournament settles based on `realised_pnl_mist`. Attacker is rank-1
   with PnL +290. Tournament pays 30% of 1000 SUI pot = 300 SUI **from
   the tournament pot**.
3. Total to attacker: 290 (main vault) + 300 (tournament pot) = 590 SUI
   on a 1 SUI entry fee.

The rank-1 prize is paid for the *PnL*, but the PnL itself was already
paid from the main vault. The tournament pot is now leveraging the main
vault's payout to determine prize allocation — the attacker is being paid
*twice* for the same observed touch.

The same logic applies to the rank-2..rank-10 payouts. The pot is being
distributed based on PnL achieved through the main-vault-backed
tournament markets. The mechanism is *consistent* (everyone is paid
twice in the same way) but the *vault* is paying the entire prize curve's
PnL portion. Net result: the main vault subsidises 100% of the
tournament's "PnL" prize allocation while the entry pot is essentially
free upside for participants.

**Economic impact.** Per tournament, main vault pays ~`Σ winning_PnL` of
all entrants — which can easily exceed the pot itself if barriers are set
to be 50/50 fair (pot ≈ 1000 SUI, expected total winning PnL across
1000 entrants ≈ 0 net but ~5000 SUI in gross winning payouts being
double-counted as "rank prize basis").

**Existing controls.** None — the design assumes prize is paid from pot,
implicitly modelling tournament markets as standalone. The fact that
tournament markets share the main vault is in the spec but the double-
counting isn't called out.

**Mitigation.**
1. Tournament markets must use a *segregated* mini-vault funded only by
   the tournament pot (not the main `MartingalerVault`). If the tournament
   markets are not solvent on their own, that's the tournament's failure
   mode, not the main vault's.
2. Or: tournament prize curve operates on `realised_pnl − payout_from_main_vault`,
   so the rank prize is only the *delta* over base payout. (Computation:
   "you earned 290 from main vault, your entry fee was 1 SUI, your PnL
   metric is 289 SUI; rank curve applies to that.")
3. Or: tournaments use a separate synthetic-only random-walk underlying
   (per doc 08 §1 — "RWALK-25"), where the *entire* market backing is
   the entry pot. No main vault exposure at all. This is actually the
   cleanest fix and aligns with the spec's stated "synthetic asset"
   intent — the spec just needs to be tight that random-walk markets
   *don't* draw from `MartingalerVault<C>`.

---

## Closing notes

The most dangerous finding is **Attack 1** — the global OI cap, even with
the §7.5 mitigation, is defeated by barrier stacking because the cap is
not barrier-distance-weighted. Probability-weighted cap accounting is the
single highest-leverage protocol change that would close this and several
related attacks (#4, #9). **Attacks 2 and 7** (cross-underlying
correlation; vault inflation) are the most insidious because they
exploit the *denominator* of the cap rather than the numerator.
**Attacks 5 and 10** (settlement cascade; oracle-bundled PTB) are MEV-
adjacent and need on-chain ordering / freshness controls that are easier
to add early than retrofit. **Attacks 8 and 12** turn the gamification
layer into a value extraction surface that drains the main vault — both
need explicit isolation between the gamification economy and the core
solvency model.

Several mitigations cluster: a *time-averaged* `V` for cap denomination,
a *sub-cap* per-address-per-(underlying, side), and a *delayed* oracle
read for fee computation each defang multiple attacks at once.
