# 04 — Red Team: Asymmetric Impact Fee

> Adversarial review of `docs/design/02_asymmetric_impact_fee.md` and the
> currently-shipped enforcement points in `move/sources/path_observation.move`
> and `move/sources/market.move`. The fee mechanism's stated purpose is to give
> the LP a **structural** edge by haircutting wins in proportion to how badly
> they hurt the vault. We try to break that property.
>
> Fee under test:
> ```
> f(m, v) = b + (cap − b) · m/(m + m0) · √v
> b = 50 bps, cap = 450 bps, m0 = 50 bps
> m = excursion / barrier         (in bps)
> v = payout_if_win / max(touch_exp, no_touch_exp)
> ```
> Charged ONLY on winning closes. Loser pays nothing.
>
> The spec sketches several monotonicity proofs (§4 of doc 02) that, if
> faithfully implemented, would block several attacks below. The attacks below
> exploit gaps between the spec's *assumptions* and its *enforcement*: the
> proof assumes "exposure is fixed at settlement"; the implementation
> decrements exposure on every redeem. The proof assumes `m` is the actual
> path's excursion; the implementation reads `max_seen` from a permissionless
> path object that accepts post-expiry observations. Etc.

---

## Threat-model preamble

**What we treat as in-scope for the attacker:**

- Multiple Sui addresses (Sybil is free).
- Ability to call any permissionless entrypoint (`record`, `lock_settlement`,
  `redeem`).
- Ability to construct programmable transaction blocks (PTBs) with up to 1024
  commands and atomic shared-object access in a single tx.
- WICK staking participation if it materially advances the attack.
- Knowledge of the public mempool/object state at the time the tx is signed.
- No oracle-source compromise (that's a separate threat model). The attacker
  *can* time their actions around oracle pushes that any keeper makes.

**What we treat as out-of-scope:**

- Compromising the `WickOracle` source itself.
- Breaking Sui consensus / object model.
- Bribing the centralized keeper to push or withhold ticks.

**Severity scale (per the brief):**

- **Critical** — a fee-bypass that breaks LP economics (negative-EV LP, or
  trader-EV approaches the multiplier × payout).
- **High** — persistent EV extraction worth ≥ 50% of the designed haircut on
  affected paths.
- **Medium** — limited extraction (10–50% haircut bypass), or requires
  uncommon market configurations.
- **Low** — theoretical / requires strong assumptions about other actors.

Across the formula, the "designed haircut" on a typical retail trade
(per doc 02 §5) is ~95 bps. The cap is 450 bps. Any attack that consistently
keeps the realized fee at or near the 50 bps floor (`b`) on a trade that
*should* settle at 200–400 bps gets ≥ 70 % of the designed surplus and
qualifies as High.

---

## Attack 1 — Permissionless `record()` after expiry inflates `max_seen`/`min_seen` to suppress no-touch decisiveness

**Severity:** High. Touches the entire no-touch product line. Fee bypass is
not 100% but is large in expectation.

**Setup.** Per `path_observation.move:127`, `record(po, oracle, clock)` is
permissionless. After `expiry_ms` it does NOT abort — it merely *clamps the
recorded timestamp* to `expiry_ms`. The price observation, however, **still
updates `max_seen` and `min_seen`** regardless of whether the underlying
observation came from before or after the window:

```move
if (obs_price > po.max_seen) po.max_seen = obs_price;
if (obs_price < po.min_seen) po.min_seen = obs_price;
po.last_seen_ms = option::some(effective_ts);
```

For no-touch positions the fee uses `closest_approach`:

- `touch_above` market: `closest_approach = barrier − max_seen`.
- `touch_below` market: `closest_approach = min_seen − barrier`.

A no-touch winner *wants* `closest_approach` to be tiny (close to 0) so the
fee floors at `b = 50 bps`. They have a permissionless lever to do this AFTER
the window closed.

**Step-by-step (numbers).** BTC market, barrier = $50,000, `touch_above`,
expiry at T=1000 ms.

1. During the live window the path's true `max_seen` was $47,500 (5%
   away). The honest `m_no_touch = (50,000 − 47,500) / 50,000 = 500 bps`.
   Honest `g(m) = 500/(500+50) = 0.909`. Vulnerability `v = 0.10` (a typical
   $1k position against $10k of no-touch exposure). `√v = 31.62 / 100 = 0.3162`
   in bps-space (i.e. `√(1000) ≈ 3162` returned by `isqrt_u64(v_bps · 10000)`,
   so `sqrt_v_bps = 3162`).
2. Designed fee: `f = 50 + (450 − 50) × 0.909 × 0.3162 = 50 + 115 = 165 bps`.
   On a $1,800 gross payout the haircut is $29.70.
3. **Attack**: at T=1001 (one ms after expiry), the WickOracle still has its
   pre-expiry latest observation queued. Attacker calls `record(po, oracle,
   clock)` once. If the oracle's latest queued price was $49,950 (15 bps from
   the barrier — typical near-miss the attacker manufactured by waiting until
   a tick that almost crossed), `max_seen` becomes $49,950.
4. New `closest_approach = 50,000 − 49,950 = $50`. New `m = 50/50,000 = 10
   bps`. `g(10) = 10/(10+50) = 0.167`.
5. New fee: `f = 50 + 400 × 0.167 × 0.3162 = 50 + 21 = 71 bps`. Haircut
   collapses to $12.78.
6. Attacker (the no-touch winner) **saved $16.92 per $1,800 payout = 94 bps
   of payout**, i.e. roughly 57 % of the designed haircut.

The lever amplifies for cases where the path's honest `max_seen` was very low
(deeply unscary no-touch wins). A grand-touring no-touch where the price
never got within 10 % of the barrier *should* pay near the 4.5 % cap (per
example #8 in doc 02 §3), but a single post-expiry `record(...)` with a
$49,990 oracle tick brings the realized fee to ~70 bps — a **~88 % savings
on the cap-rate fee**.

**Worse**: the attacker doesn't even need to control the oracle. They just
need *one* late tick (anywhere in the residual oracle queue, possibly cached
from prior keeper pushes, possibly pushed adversarially by anyone). On Sui
shared-object semantics, calling `record` is permissionless and cheap. They
can call it repeatedly with progressively more-favorable cached
observations.

**Economic impact.** This attack alone routinely turns a 450 bps cap-rate
fee into a 50–80 bps floor-rate fee. On a $1M annual no-touch payout volume
quoted in the design table, that's **$37,000/yr of LP yield captured by
attackers** even before they touch the touch side.

**Existing controls.** None on the impact-fee path. There is `is_settled`
on the oracle (line 263 of `market.move`), but `lock_settlement` only
freezes the *outcome* (touched / not), not the `max_seen`/`min_seen` floor
that drives the fee.

**Mitigation.**
- Snapshot `max_seen` and `min_seen` into the `PathObservation` at the moment
  `lock_settlement_from_latest` runs, into immutable fields like
  `final_max_seen` and `final_min_seen`. The fee module reads these, not the
  live ones.
- Reject post-expiry `record` calls for the purposes of updating min/max
  (only allow them for the touched-at trigger, and only if `crossed && touched_at == None`).
- Equivalently: lock the path object at `lock_settlement` time and refuse
  further mutation.

---

## Attack 2 — Pre-trade book-padding (Sybil dust on opposite side) deflates `v`

**Severity:** Critical. Direct fee-bypass with negligible cost.

**Setup.** `v = payout_if_win / max(touch_exposure, no_touch_exposure)`.
The attacker controls *both* numerator and denominator: they open a tiny
"dust" position on the side they don't expect to win, inflating that side's
exposure. When their main winning position settles, the fee divides by the
inflated max.

**Step-by-step (numbers).** Barrier $50k, attacker is highly confident touch
will win, gross payout multiplier 1.8x.

1. Honest baseline: attacker opens $5,000 on TOUCH. `payout_if_win = $9,000`.
   Both sides have $5,000 exposure each → `max_exp = $9,000`. `v = 9000/9000 =
   1.0`. With decisive touch (m = 300 bps, g(300) = 0.857), `f = 50 +
   400 × 0.857 × √1 = 50 + 343 = 393 bps`. Fee on a $9k win = $353. Net = $8,647.
2. Attack: attacker first opens $1,000,000 on NO_TOUCH from a Sybil address.
   `no_touch_exposure = $1,800,000`. THEN the same attacker (different
   address) opens $5,000 on TOUCH. `touch_exposure = $9,000`. `max_exp =
   $1,800,000`.
3. `v = 9,000 / 1,800,000 = 0.005`. `v_bps = 50`. `sqrt_v_bps =
   isqrt(50 × 10_000) = isqrt(500_000) ≈ 707`. So `√v ≈ 0.0707`.
4. `f = 50 + 400 × 0.857 × 0.0707 = 50 + 24 = 74 bps`. Fee on $9k = $66.
   Net = $8,933. **Savings: $286, or 81 % of the designed haircut.**
5. Attacker's NO_TOUCH side loses $1,000,000 of stake — but wait, that's
   their *own* money on their own Sybil. They redeem it as `Coin::zero` and
   eat the loss... unless they can recover it.

**This is where the attack gets sharp.** The "$1M loss on the Sybil" sounds
disqualifying, but it isn't:

- **The Sybil is on the LOSING side, so it pays no fee** (only winners pay).
  But the loser's stake stays in the vault as protocol revenue. So the
  attacker pays $1M of stake. They saved $286. Net: catastrophic loss.
- **HOWEVER**: under the planned Martingaler architecture (doc 01), losing-
  side stake routes through the side_bucket → queue. More importantly, the
  attacker doesn't have to actually risk the $1M. They open the $1M
  no-touch and **simultaneously** open a hedging position elsewhere that
  pays $1M back if no-touch loses. Two paths:

   **Path A: hedge via the same market's TOUCH side.** Attacker opens $1M
   no-touch (Sybil 1) and $556k touch (Sybil 2). At 1.8x, the touch payout
   is $1M. If touch wins (which the attacker expects), Sybil 2's TOUCH
   redeems $1M, exactly cancelling Sybil 1's no-touch loss (modulo its own
   smaller fee, which is also discounted by this same trick). Net cash flow
   to the attacker: their original $5k touch position pays $9k − $66 fee,
   plus the hedge round-trip is roughly net-zero.

   The hedge fee is even more discounted because the $556k position itself
   inflates the TOUCH side now too. Let's compute. After all three opens:
   `touch_exposure = $9,000 + $1,000,000 = $1,009,000`,
   `no_touch_exposure = $1,800,000`. `max_exp = $1,800,000`.
   - Sybil 2 TOUCH: payout = $1,000,000. `v = 1M / 1.8M = 0.556`,
     `v_bps = 5556`, `sqrt_v_bps = isqrt(5556 · 10000) = isqrt(55,560,000) ≈
     7454`. With same `m = 300 bps`, `g = 0.857`. `f = 50 + 400 × 0.857 ×
     0.7454 = 50 + 256 = 306 bps`. Fee = $30,600 on the hedge.
   - Real position: payout = $9k. `v = 9000 / 1.8M = 0.005`, fee =
     $66 (as above).
6. Total fees paid by attacker: $30,600 + $66 = $30,666. Total fees if
   attacker had not done the dance: $353 (real) + $0 (no hedge needed). So
   the hedge made things WORSE in this calibration.

So the simple "pad opposite side then hedge" doesn't work *if you have to
hedge with a 1.8x payout multiplier*. The attacker has to find a cheaper
hedge.

   **Path B: hedge on a DIFFERENT market with the same underlying.** This is
   where it gets dangerous. Attacker opens $1M no-touch on Market A
   (barrier $50,001, very unlikely to be touched given current price = $48k).
   Attacker opens real $5k touch on Market B (barrier $48,500, likely to be
   touched). If the touch happens at $48,500 it does NOT cross $50,001, so
   *both* the Sybil's no-touch on A AND the real touch on B can win
   simultaneously. The padding cost is the *fee* on the Sybil's no-touch win
   on market A, which we control via attack 1 above. With attack 1 chained,
   the Sybil's $1.8M no-touch payout pays only the floor (50 bps) =
   $9,000 fee.
7. So the cost of the dust-padding is now $9,000 (fee on Sybil's win), and
   the savings on the real position are still ≥ $286 per $5k stake. To break
   even, the attacker needs the real win to be ~$286k of stake. In other
   words, **Attack 2 is profitable when the attacker's true winning
   position is >~ $300k**.

**Economic impact.** Whales (positions > $300k of payout) can erase nearly
the entire impact-fee. On any market with a deep enough vault to support
such trades, this is a direct LP-economics break.

**Existing controls.** None. There is no minimum `m_or_v` requirement, no
"book-share at trade-open time" snapshot, no Sybil rate-limit.

**Mitigation.**
- **Snapshot `v` at position-open time, not at redemption.** Define `v_open
  = payout_if_win / max(touch_exp, no_touch_exp)` AT THE INSTANT THE
  POSITION IS MINTED. Use `max(v_open, v_settle)` (or a time-weighted
  average) as the fee input. This neuters Sybil padding, because pads
  added *after* the real position was opened don't reduce that position's
  `v_open`.
- Equivalently: enforce that `v` is a non-decreasing function of all later
  opens on the same side, but a non-increasing function of opens on the
  opposite side, ONLY for opposite-side opens that came before yours. Track
  per-position book-state at mint time.

---

## Attack 3 — Mid-redemption sequencing inflates `v` for whales (or deflates it for late winners)

**Severity:** High. Costs nothing to execute; depends purely on tx ordering.

**Setup.** The implementation in `market.move:218–231` decrements
`touch_exposure` (or `no_touch_exposure`) **on every redeem, regardless of
win/loss**. The fee compute reads `touch_exposure` and `no_touch_exposure`
*at the moment of redemption*. So `v` for any individual winner depends on
how many other winners (and losers) have already been processed in this
settlement cycle.

This contradicts doc 02 §4's monotonicity proof, which states: "exposure is
fixed at settlement, which cannot be exploited."

**Step-by-step (numbers).** A 1.8x market settles TOUCH-wins. Total touch
payouts owed: 10 winners of $1k payout each = $10k total. `touch_exp = 10k`,
`no_touch_exp = 5k`. The decisive `m = 300 bps` (so `g = 0.857`).

- **First redeemer**: `v = 1000 / max(10k, 5k) = 0.10`, `√v = 0.3162`.
  `f = 50 + 400 × 0.857 × 0.3162 = 50 + 108 = 158 bps`. Pays $15.80 fee.
  Then `touch_exp` drops to $9k.
- **Second redeemer**: `v = 1000 / max(9k, 5k) = 0.111`, `√v = 0.3333`.
  `f = 50 + 400 × 0.857 × 0.3333 = 50 + 114 = 164 bps`. Pays $16.40.
- ...
- **Tenth (last) redeemer**: `touch_exp` already drained to $1k.
  `v = 1000 / max(1k, 5k) = 0.20`. `√v = 0.4472`. `f = 50 + 400 × 0.857 ×
  0.4472 = 50 + 153 = 203 bps`. Pays $20.30.

The first redeemer paid 158 bps; the last 203 bps. **Being first saves 28 %
of the fee.** A whale who structures a PTB to redeem before all the small
fish takes the cheaper end of the curve.

**Worse — the asymmetric variant.** If the first nine redeemers are the
whale's Sybil $0.01 dust positions (they redeem first, decrementing
`touch_exp` toward zero), then the 10th redeem (the whale's real $1k payout)
sees `touch_exp = $1k`, `no_touch_exp = $5k`, `v = 1000 / 5000 = 0.20`.
That's *worse* for the whale, so this direction doesn't help touch-side
whales.

But it *does* help the LOSING side: dust positions on the *winning* side
can be opened pre-settlement (cheaply) by a hostile actor to inflate
touch_exp, so when the real whale wins they get a tiny `v`. Cf. Attack 2.

**Economic impact.** Modest per redemption (~10 bps swing) but accumulates
across the order book and gives an unambiguous advantage to whoever can
craft the redemption order. Sui's shared-object queueing makes this exact
ordering MEV-extractable.

**Existing controls.** None. The exposure decrement is inline in `redeem`.

**Mitigation.**
- Snapshot `touch_exposure_at_settle` and `no_touch_exposure_at_settle` once
  at `lock_settlement` time. Have the fee read those snapshots, not the
  live decrementing fields.
- Equivalently: compute fee against the *winning side's* exposure *as of
  settlement*, not as of redemption. Doc 02 already states this as the
  intent ("exposure is fixed at settlement"); the implementation diverges.

---

## Attack 4 — Wick-graze decisiveness deadband: route a win through `record_range` so the touch trigger fires but `max_seen − barrier` rounds to 0

**Severity:** Medium-High. Reliable on the touch side.

**Setup.** Doc 02 §6 acknowledges the "exactly-grazes" deadband property
and accepts it: a touch that fires at `max_seen == barrier` pays only the
floor `b = 50 bps`. The proof works ONLY because the fee math has a
deadband at `m = 0`. But what's the cost to manufacture a graze?

Per `path_observation.move:133`, the touch trigger is `obs_price >= barrier`.
A single oracle tick that lands at `obs_price = barrier + 1` (one integer
unit above) is sufficient to:

- set `touched_at = Some` (so touch wins),
- set `max_seen = barrier + 1`.

Then `excursion = 1`. With prices scaled to 1e9 (per doc 02 §7 overflow
notes: "$50k = 5×10^13"), `m_bps = (1 × 10000) / (5 × 10^13) = 0` after u128
truncation. So `g(0) = 0`, and the fee floors at 50 bps.

**Step-by-step.** Live trader playing a touch-above on barrier
`5_000_000_000_000` ($50,000 with 1e8 scaling). They want their win to be
"barely-decisive."

1. They control nothing. They wait for any oracle tick that lands at
   `5_000_000_000_001` or anywhere `< 5_000_005_000_000` (1 bp = 5×10^9
   units). Per `path_observation.move`, ANY recorded observation in that
   range will fire the touch (because `>= barrier`) without bumping
   `max_seen − barrier` past the truncation threshold.
2. The trader ensures (by being the keeper, or by sending the only-required
   `record` call) that no *later* observation pushes `max_seen` higher.
   Subsequent ticks at the same price are no-ops on `max_seen`; ticks
   *higher* would bump it, so the trader simply doesn't call `record` after
   that, and competing keepers may not call either before expiry.
3. At expiry, `max_seen − barrier = 1` (or any small integer). `m_bps`
   rounds to 0. Trader pays 50 bps fee on the touch win.
4. Designed fee for a typical near-the-money touch (the kind that a
   first-tick-grazer almost always is): roughly 165 bps from §3 example #2.
   Trader's saving: **115 bps of the gross payout**.

**Notice the keeper assumption.** The PathObservation's monotonic `max_seen`
makes this hard to fix by "just re-record the highest tick later" — every
later observation can only push max_seen *up*. So the attack is "be the
first to record the lowest cross-over tick, then prevent later ticks from
reaching the path module before expiry by simply not calling `record`."

In MVP the keeper is centralized and pushes every tick, so this is muted.
Post-MVP (doc 02 says "permissionless `record` is the design"), the
attacker can simply **outbid** the keeper for tx priority on the cross-over
tick, then sit on later ticks until expiry. Every subsequent post-expiry
`record` (Attack 1) can only push `max_seen` higher (worse for the touch
attacker), but the touch attacker can simply not submit any more `record`
calls and hope no one else does either.

**Economic impact.** On any touch win where the true `m` would have been
1–10 bps, this attack collapses fee to 50 bps. That's ~70 % of the
designed haircut. Across an order book of trader-driven graze touches
(common when multiple short-dated barriers exist), this is **a
recurring, predictable extraction**.

**Existing controls.** Doc 02 §3 explicitly accepts this as "deadband
property without piecewise branch." It is treated as a feature, not a bug.
But the proof did not assume the trader could *pick* which tick crosses.

**Mitigation.**
- Replace the simple `obs_price >= barrier` trigger with a *post-cross
  observation window*: require K observations or T milliseconds past the
  initial cross before the touch trigger sticks. During this window,
  `max_seen` continues to update naturally and a true wick (one that
  blows past the barrier) gets recorded.
- Or: use the `min(over_recorded_ticks_after_cross, max_seen)` for fee
  calculation, so that the trader cannot "cap" `max_seen` by withholding
  later ticks.
- Or: change the trigger condition to require `obs_price >= barrier · (1 +
  ε)` for some tiny ε (e.g. 1 bp) — at the cost of *all* sub-1-bp wicks
  becoming no-touches.

---

## Attack 5 — Vulnerability=0 edge: solo position with zero opposite-side exposure

**Severity:** Low (rare in production), Medium (common in cold-start markets).

**Setup.** Doc 02 §6 ("Vault is enormous (single position is dust)")
correctly handles `v → 0` from large denominators. But the OPPOSITE
edge — `denom = 0` because the attacker is the only position on either
side — is also possible early in a market's life. The implementation handles
this:

```move
let v_bps: u64 = if (denom == 0) 0 else { ... };
```

`v_bps = 0` means `√v = 0`, which means `f = b` regardless of `m`.

**Step-by-step.** Brand new market opens. Alice is the very first opener.
She opens $10k on TOUCH; barrier $50k, current price $49.5k (1 % away).

1. At her open, `touch_exposure = $18k`, `no_touch_exposure = 0`.
2. Suppose Alice is also the only opener — no one else trades. The price
   wicks past $50k, touch wins.
3. At redemption: `denom = max(18k, 0) = 18k`. `v = 18k / 18k = 1.0`.

So `denom = 0` doesn't trigger here; Alice still pays. Good. But the
spec says `denom = 0` (zero exposure on either side) should be impossible
at redemption time because the winner's own exposure is already counted. So
the `denom == 0 → v_bps = 0` branch is **dead code**... unless the winning
exposure was already drained by a previous redeem in the same settlement
cycle.

Combined with Attack 3 (decrement on redeem), one constructs:

1. Two winning positions on TOUCH side: Alice $1k payout, Bob $1k payout.
   `touch_exposure = $2k`, `no_touch_exposure = $0`.
2. Alice redeems first. Exposure drops to $1k. `v = 1000/max(1000, 0) =
   1.0`. Pays full fee.
3. Bob redeems second. `payout_if_win = $1k`, exposure decrement happens
   *first* (line 219 in market.move), so by the time the fee module reads,
   `touch_exp = 0`, `no_touch_exp = 0`.

Wait — looking at the code order again:

```move
if (side == SIDE_TOUCH) {
    if (market.touch_exposure >= payout_if_win) {
        market.touch_exposure = market.touch_exposure - payout_if_win;
    } else { market.touch_exposure = 0; };
}
// ...
let payout = if (won) {
    let payout_coin = vault::withdraw(&mut market.vault, payout_if_win, ctx);
```

The code today doesn't actually call the fee module — the impact fee isn't
implemented yet (per task list, Phase A.3 is pending). When it is, the
spec-compliant ordering will matter. If `compute_inputs` runs *after* the
exposure decrement, then for Bob's redeem `denom = 0 → v_bps = 0 → f = b`.
Bob pays 50 bps regardless of `m`. Alice paid 100% fee.

**Step-by-step (manipulated).** Alice colludes with Bob to be last.

1. As above, Bob is the LAST winner to redeem. He decrements exposure to
   zero before the fee read. `v_bps = 0`. Fee = 50 bps.
2. To maximize savings, Bob picks the largest position on the side. By
   construction the largest position has the highest `v`, so the highest
   designed fee. Bob's haircut bypass = full `(cap − b) × g(m) × √v_real`.
3. With `m = 300 bps, v_real = 1.0` (a single-position market), Bob's
   designed fee was `50 + 400 × 0.857 × 1.0 = 393 bps`. Realized: 50 bps.
   **Savings: 343 bps = 76 % of payout.**

**Economic impact.** On a single-winner or last-winner-takes-all market,
the last-to-redeem bypasses ~76 % of the fee. This compounds with Attack 3.

**Existing controls.** None — fee not implemented yet, but the spec
pseudocode (`compute_inputs` reads exposure post-decrement implicit in
`redeem`'s flow) is vulnerable.

**Mitigation.**
- Compute `(m_bps, v_bps)` BEFORE decrementing exposure.
- Or: snapshot exposure at `lock_settlement` and read from the snapshot.

---

## Attack 6 — Cross-market fee arbitrage via correlated underlying

**Severity:** High. Persistent and scales with the number of correlated
markets on a single underlying.

**Setup.** The fee parameters `(m, v)` are *per-market*. There is no
cross-market normalization. Consider two simultaneous markets on BTC:

- Market A: barrier $50,000, touch-above, vault has $1M of TOUCH exposure.
- Market B: barrier $49,000, touch-above, vault has $20k of TOUCH exposure.

If BTC pumps from $48k to $51k, BOTH markets settle TOUCH-wins. The
attacker who opened a $10k position on market B sees:

- Market A: `m_A = (51000 − 50000) / 50000 = 200 bps`, `g(200) = 200/250 =
  0.80`. `v_A = 18000 / 1000000 = 0.018`. `f_A = 50 + 400 × 0.80 × 0.134 =
  50 + 43 = 93 bps`.
- Market B: `m_B = (51000 − 49000) / 49000 = 408 bps`, `g(408) = 408/458 =
  0.891`. `v_B = 18000 / 20000 = 0.90`. `f_B = 50 + 400 × 0.891 × 0.949 =
  50 + 338 = 388 bps`.

Same underlying outcome, same trader stake, same gross payout — but B's fee
is **4.2× higher** than A's. The attacker simply opens on the deeper book
(A) for the same expected outcome.

**This is by design** in some sense (deeper books absorb more of the LP's
risk). But the attacker can game it asymmetrically:

**Step-by-step.** Attacker wants to express a "BTC will hit $50k" view.
They have $50k of stake.

1. **Naive trader**: opens $50k on the most relevant market (say barrier
   $50k itself). Pays 388 bps on $90k payout = $3,492.
2. **Cross-market attacker**: opens $50k on a *deeper, slightly-different*
   barrier (say barrier $49,500 also touch-above on a market with $5M of
   touch exposure). When BTC hits $50k, both barriers trigger, but the
   attacker's position settles in the deep book at `v ≈ 0.018` →
   `f ≈ 93 bps` → fee $837. **Saves $2,655 = 76 % of designed haircut.**

The attacker even has incentive to *create* a deep market for their preferred
direction — opening Sybil positions on the same side (TOUCH) to inflate the
denominator works for them since they too will win, but each Sybil pays its
own (small) fee. With `n` Sybil positions of $X each and a real $50k
position: every Sybil pays `f(m, X / total_exp) ≈ f(m, 1/n)` so Sybils are
nearly free, and the real $50k pays `f(m, 50k / total_exp) ≈ f(m, 50/(50 +
nX))`. Let nX = 5M, real = 50k → real `v = 0.0099`. Real fee:
`50 + 400 × 0.891 × 0.099 = 85 bps`. Each Sybil ($X = 1) pays:
`v_i = 1.8 / 5_000_000 ≈ 0`, fee floors at 50 bps × 1.8 = $0.009 per Sybil.

So padding the SAME side with Sybils is nearly free and converts a
designed-388-bps fee into 85 bps — **78 % savings**.

**Economic impact.** This is the most damaging attack listed. It scales
with vault size, requires no special information, and is undetectable
(it just looks like a healthy market with lots of participants).

**Existing controls.** None. The doc 04 §7.5 *global OI cap* would catch
this if implemented; it isn't in the impact-fee module.

**Mitigation.**
- Use a **global** vulnerability denominator: aggregate `touch_exposure`
  across all markets sharing the same underlying and side. The attacker
  cannot pad globally without paying the fee on the pads.
- Apply the `α_global` cap from doc 04 §7.5 at the fee-input level too:
  `v = payout / (max_global_exposure_for_underlying)`.
- Charge *per-position-open* a flat `0.5 bp · stake` "book-pollution
  fee" that compounds for opens on already-heavily-imbalanced sides;
  makes Sybil-padding net-negative.

---

## Attack 7 — `isqrt_u64` round-down compounding for boundary `v` values

**Severity:** Low (small per-trade), Medium when systematic.

**Setup.** The Babylonian `isqrt_u64` in doc 02 §7 returns the floor of the
square root. For `v_bps = 1`, `isqrt(1 × 10000) = isqrt(10000) = 100` exactly.
For `v_bps = 2`, `isqrt(20000) = 141` (true value 141.42); a 0.42 / 141 =
0.30 % under-count of √v. That under-count flows directly to the fee.

For very small `v_bps` values (which are common — sub-1% book share is
typical), the relative round-down can be material.

**Step-by-step (numbers).**

| v_bps | true √(v_bps · 10000) | isqrt result | round-down (bps of result) |
|-------|------------------------|--------------|------------------------------|
| 1     | 100.000                | 100          | 0 bp                         |
| 2     | 141.421                | 141          | 30 bp                        |
| 3     | 173.205                | 173          | 12 bp                        |
| 5     | 223.607                | 223          | 27 bp                        |
| 10    | 316.228                | 316          | 7 bp                         |
| 50    | 707.107                | 707          | 1 bp                         |

For low `v_bps`, the rounding shaves up to 30 bp off `sqrt_v_bps`, which
shaves `(cap − b) × g(m) × 30/10000 = 400 × g × 0.003 = 1.2 × g bps` off the
fee. Tiny per trade.

**The attack** is to *deliberately structure* positions so `v_bps` lands on
an unfavorable round-down point. With `v = payout / max_exp`, the attacker
can dust their own side by tiny amounts to push `v_bps` down to exactly 2
(largest relative round-down). At scale this is < 1 bps/trade, **but** if
the attacker is a market maker doing 10,000 trades/day at $1k each, they
extract `10_000 × 1000 × 0.0001 = $1,000/day` of LP yield from rounding
alone.

**Economic impact.** Bounded. Maybe $300k/yr at the highest end of plausible
volume. Real but small.

**Existing controls.** None. Babylonian `isqrt` is the spec.

**Mitigation.**
- Round the fee UP, not down. Replace the integer division in `extra_bps`
  with a ceiling: `(num + denom - 1) / denom`. Now round-down on `√v` is
  partially offset by round-up on the fee.
- Or use a fixed-point `isqrt` with one extra digit of precision (scale
  inputs by 100 before sqrt, divide outputs by 10).

---

## Attack 8 — WICK-staking discount stacking with low-fee scenarios

**Severity:** Medium. Designed feature, but compounds badly with other
attacks.

**Setup.** Per the brief, WICK stakers get 5–20 bps off the impact fee
(referencing the tokenomics doc 03 §4.1 stake-tier discount; note doc 03
applies the discount to the *settlement skim on losses*, but the brief
generalizes it to impact fees on wins). Whichever way it's wired, the
effect is the same: a cumulative discount that stacks.

**Step-by-step.** Platinum staker (1M WICK, 20 bps discount). They run any
of attacks 1, 2, 4, or 6 to drive their realized fee down to 50 bps floor.
With the discount, they pay **50 − 20 = 30 bps**. On a $10k payout:
$30 fee instead of the designed $400 (if cap-rate). **92.5 % bypass.**

The discount is nominally paid out of the staker_share bucket, but
Attack 6 + WICK staking together let a single attacker control the entire
fee path:

1. They stake 1M WICK (≈ $30k at hackathon prices, possibly free if they
   farmed during fair-launch).
2. They build up a large book on a single underlying via Sybils (Attack 6).
3. Each individual position's fee floors near `b = 50 bps`. With discount,
   it becomes `b − 20 = 30 bps`.
4. Designed haircut bypass: ≥ 90 %.

**Economic impact.** Adds a **40 % multiplier** on top of any other
attack's bypass. Combined with Attack 6 (78 % bypass), realized fee is
$30 instead of designed $388 — **a 93 % bypass on cap-rate fees**.

**Existing controls.** Doc 03 §4.1 limits the discount to 20 bps max and
ties it to staked-WICK amount. But it does not require the staker to be the
loser; if discount applies to the impact fee on wins, the entire mechanism
is mis-aligned (it rewards winners, which are by construction net-takers
from the LP).

**Mitigation.**
- Re-confirm doc 03's stated mechanic: the staking discount applies to
  *loss skims*, not to *win haircuts*. If the impact fee is a "win
  haircut" not a "loss skim," explicitly document that the 5–20 bps
  discount does NOT apply to it.
- If governance does want a win-haircut discount, cap it at `min(b/2,
  staked_tier_bps)` so the floor never drops below `b/2 = 25 bps`.
- Alternative: convert the discount into a *rebate paid post-settlement
  in WICK*, not a fee reduction. Keeps the LP-edge math clean while
  still being a staker perk.

---

## Attack 9 — PTB atomic spread: open, win, close, reopen to extract the deadband on every cycle

**Severity:** Medium. Requires high-frequency oracle pushes; works best on
the random-walk arcade markets.

**Setup.** On the random-walk driver markets (which have predictable
on-chain PRNG-driven price), an attacker can pre-compute when the price
will cross a barrier. They can then use a single PTB to:

1. Open touch position on Market K1 just before the deterministic crossing.
2. Wait for the crossing (next block).
3. Redeem the win at the deadband-graze rate (Attack 4).
4. Open a new position on Market K2 (different barrier) for the next
   predicted crossing.

Each cycle pays only `b = 50 bps` instead of designed ~165 bps.

**Step-by-step.** Random-walk PRNG has a known seed (per
`random_walk_driver.move`'s on-chain implementation). Attacker simulates
the next 1000 ticks and identifies 5 future crossings of barrier $X.

1. For each crossing, open a fresh touch position 1 block before.
2. After the crossing, immediately redeem (within the same epoch if
   possible). Each redemption pays floor: 50 bps.
3. Designed fee for these "obvious" trades: cap-rate (450 bps) since the
   trader is omniscient and the trade is highly decisive. Realized: 50 bps.
4. Bypass: 89 %.

**Economic impact.** Limited to arcade markets where PRNG is predictable.
On the BTC route or pull-oracle markets the attacker has no edge on the
underlying, so the deadband-graze attack is not pre-plannable (it depends
on real-world wicks happening at the right magnitude).

**Existing controls.** Doc 02 §3 calibration table lists the random-walk
markets with `cap = 0.02` and `m0 = 0.005` — a tighter band, which
slightly mitigates. But the deadband itself is unchanged.

**Mitigation.**
- Random-walk driver should not use a PRNG with on-chain-predictable seed.
  Use `Clock` + commit-reveal or VRF for the next tick.
- Apply Attack 4's mitigation (post-cross observation window) here too.

---

## Attack 10 — Trigger settlement when `v` is artificially low: front-run a large opposite-side open

**Severity:** Medium. Race-condition-style; depends on mempool visibility.

**Setup.** `lock_settlement` is permissionless and happens once after
expiry. Between expiry and lock, traders can still SEE pending opens but
cannot themselves open (`assert!(now < market.expiry_ms)` in
`open_position`). However, the *order* of `lock_settlement` vs. last-second
opens that landed in the same epoch is contested.

More importantly: the attacker, having just won a position, can:

1. Spam open a large *opposite-side* position right before the close of
   the trading window (technically still legal: `now < expiry_ms` permits
   opens up to the millisecond). This inflates the opposite-side
   `_exposure` denominator.
2. Wait for expiry; their winning position settles with low `v`.

This is a strict subset of Attack 2 in mechanism but uses *time-of-trade*
as the lever rather than Sybil identity.

**Step-by-step (numbers).** Bob has been long $10k touch all week.
`touch_exp = $18k`, `no_touch_exp = $5k`. With ~1 second left in the trade
window, BTC has clearly broken the barrier — touch will win.

1. Bob opens $1M on no-touch in the last second. He KNOWS no-touch will
   lose. `no_touch_exp = $1.8M + $5k = ~$1.8M`.
2. Trade window closes. Path settles touch-wins.
3. Bob redeems his $10k touch position. `v = 18k / 1.8M = 0.01`. `√v = 0.1`.
   Designed fee assuming `m = 300 bps, g = 0.857`:
   `f = 50 + 400 × 0.857 × 0.1 = 50 + 34 = 84 bps`. Pays $15 on $1.8k payout.
4. He also redeems his $1M no-touch as `Coin::zero` (loses $1M of stake).
5. Net: pays $15 on the win + loses $1M on the deliberate-loss padding. He
   needs the saved fee to be > $1M for this to pay off. With designed fee
   being roughly `f_real = 165 bps × $18k payout = $297`, savings are ~$282.
   Net loss: ~$1M.

So Attack 10 in isolation is uneconomic — same as Attack 2 in isolation.
But combined with cross-market hedging (Attack 6), the no-touch loss can
be partially recovered. The pure version is "Critical for tx ordering, but
the hedge requirement makes it ≤ Medium."

**Existing controls.** `assert!(now < market.expiry_ms)` is the only
gate. Doc 02 doesn't discuss last-second opens at all.

**Mitigation.**
- **Trade-window cool-off:** disallow opens in the final N seconds of the
  window (e.g. final 10 % of the option's lifetime). Last-tick opens are
  also typically informed flow (worse for the LP) so the cool-off has dual
  benefit.
- Or: use the time-weighted `_exposure` over the option's lifetime as the
  denominator instead of the snapshot at settlement. A position that opened
  in the last second contributes only 1/N of its size to the average,
  diluting the manipulation lever.

---

## Attack 11 — Reopen-after-redeem to "cash in" exposure-decremented book repeatedly

**Severity:** Low (one-shot per market) but compounds with Attack 5.

**Setup.** Same exposure-decrement-on-redeem footgun. After all but one
winner have redeemed, the last winner sees `v = 1` (since they ARE the
remaining winning exposure). But what if they could "create" more winners
mid-redemption to dilute themselves? They can't open new positions
post-expiry — but they CAN delay their own redemption while encouraging
or buying out other winners' positions.

Think of it as: **acquire other winners' Position objects (which are
transferable) and redeem them in a strategic order.**

**Step-by-step.**

1. Alice has won $10k payout. There are 9 other winners with $1k each.
2. Alice buys out the 9 other winners for $1k − ε each (saving them the
   redemption fee). Now Alice owns all 10 positions.
3. Alice constructs a single PTB: redeem the 9 small positions FIRST
   (each at progressively-lower `v_bps` because exposure is decrementing,
   ending at `v = 1k/$10k` for the last small one — actually wait, the
   small ones inflate `v` for themselves more than they reduce it, so
   this analysis is subtle).
4. After all 9 small redemptions, `touch_exp = $10k`. Alice's $10k position
   redeems with `v = 10k/10k = 1.0`. Pays cap-rate fee — WORSE than if
   she'd not bought the others.

So the buyout *raises* her own fee. The opposite is true: Alice would
rather other winners NOT redeem (and stay queued) so that, when she
redeems, exposure includes their share, lowering her relative `v`. But she
can't prevent them, only herself delay.

**Cleaner version:** Alice is a no-touch winner. She buys out the LOSING
touch positions for ε (since they're worthless). Wait — losers' Position
objects are also transferable. Alice can COLLECT all the losing position
objects but she can't "redeem" them productively (`won = false` returns
zero). However, she could STOP them being redeemed (which reduces
touch_exp). Simply not calling `redeem` on them keeps `touch_exp` inflated.

But touch_exp is a vault counter that starts at the sum of opens and
decrements on EVERY redeem (win or loss). So losers' positions sitting
unredeemed keeps `touch_exp` high → keeps Alice's `v` low → keeps her fee
low. **Alice should withhold redemption of losing-side Position objects
she controls, to keep the opposite-side exposure inflated.**

**Step-by-step (cleaner).**

1. Alice (no-touch winner, $10k payout). `touch_exp = $1M`, `no_touch_exp =
   $20k`. `v = 10k / 1M = 0.01`. Cheap fee already.
2. Alice (or her Sybils) holds 50% of the touch positions (which are
   losers). She refuses to redeem them. Other winners on no-touch redeem
   first; their `v` is computed against `max(touch_exp, no_touch_exp) =
   $1M` for now, but as no-touch winners drain, `no_touch_exp` decrements.
3. As long as no losing-side touch position has been redeemed,
   `touch_exp = $1M` permanently. Every no-touch winner enjoys low `v`.

Modest extension of Attack 3, but importantly: it can be coordinated by ONE
attacker collecting losing positions. The attacker doesn't lose anything
(loser positions are worthless).

**Economic impact.** Modest — maybe 5–10 bps swing per redemption. Compounds
across many no-touch winners' redemptions, capturing a fraction of the
designed haircut.

**Mitigation.**
- Snapshot exposures at lock_settlement (mitigation already proposed for
  Attack 3).

---

## Attack 12 — Multi-leg PTB spread (long touch K1, short touch K2): one leg wins, one loses; net fee mismatch

**Severity:** Low. Mostly a UX trap rather than an attack — but worth
noting.

**Setup.** A trader builds a vertical spread: long touch barrier $50k,
short touch barrier $52k (which on Wick means buying NO_TOUCH on the K2
market — there's no native "short"). One leg wins, one loses. The fee on
the winning leg is computed in isolation, ignoring the offsetting losing
leg's premium paid.

**Step-by-step.** Trader pays $1k for long touch K1 (payout $1.8k),
$500 for no-touch K2 (payout $900). BTC settles at $51k. Long touch K1
wins ($1.8k payout), no-touch K2 wins ($900 payout). Total stake: $1.5k.
Total gross: $2.7k.

- Each leg pays its own fee. Suppose `f_K1 = 200 bps, f_K2 = 80 bps`.
  Net haircut: $36 + $7.20 = $43.20.
- An equivalent single binary structure (if it existed) would charge a
  blended fee. The spread structure pays *more* fee than it should because
  the offsetting losing leg never reduced the winning leg's `v`.

This isn't an exploit — it's a tax on multi-leg trades. Sophisticated
traders will route around by trading single-leg only, simplifying the
attacker's problem (just don't use spreads).

**Economic impact.** Indirect. Drives sophisticated flow toward
single-leg trades, which is fine for the LP but bad for product depth.

**Mitigation.**
- Permit a "linked" PTB call that nets the fees on a defined spread. Only
  charge fee on the *net* P&L. (Out of MVP scope.)

---

## Summary table

| # | Attack | Severity | Bypass% (cap-rate) | Mitigation effort |
|---|---|---|---|---|
| 1 | Post-expiry `record` inflates max_seen | High | 88 % | Easy: snapshot at lock |
| 2 | Sybil book-padding deflates `v` | Critical (with hedge) | 80–95 % | Medium: snapshot v_open |
| 3 | Mid-redemption exposure decrement order | High | 25 % | Easy: snapshot at lock |
| 4 | Wick-graze deadband (record control) | Medium-High | 70 % | Medium: post-cross window |
| 5 | v=0 via last-redeem after exposure drained | Low/Medium | 76 % | Easy: compute fee pre-decrement |
| 6 | Cross-market correlated arbitrage | High | 76–78 % | Hard: global denom |
| 7 | isqrt round-down compounding | Low | < 1 % | Trivial: round fee up |
| 8 | WICK staking discount stacking | Medium | +40 % multiplier | Easy: doc 03 wording fix |
| 9 | PTB atomic spread on random-walk markets | Medium | 89 % (arcade) | Medium: VRF/commit-reveal |
| 10 | Last-second opposite-side open | Medium | 75 % (with hedge) | Easy: trade cool-off |
| 11 | Withhold losers' redemptions to inflate denom | Low | 5–10 % | Easy: snapshot at lock |
| 12 | Multi-leg spread fee mismatch | Low | (cost trader, not LP) | Hard: linked-PTB netting |

The two cheapest fixes — **(a) snapshot exposure and max/min at
`lock_settlement`** and **(b) compute fee inputs *before* decrementing
exposure on redeem** — close attacks 1, 3, 5, and 11 simultaneously. Both
fixes are <50 lines of Move code each.

The two structural risks — **(c) Sybil book-padding (Attack 2)** and
**(d) cross-market correlated arbitrage (Attack 6)** — require the global
OI tracker that doc 04 §7.5 already flags. Implementing it as part of the
fee module's denominator (rather than just as a position-open guard) closes
both for the price of one shared-object update per open.

---

*End red-team report. Version: 2026-05-12.*
