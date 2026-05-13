# 01 — Red Team: Vault, Queue, and Side-Bucket Accounting

> Adversarial review of the Martingaler vault state machine specified in
> `docs/design/01_martingaler_accounting.md` and the solvency analysis in
> `docs/design/04_solvency_proof.md`. The current MVP code at
> `move/sources/vault.move` is per-market and *does not yet implement* the
> mega-vault model — so the attacks below target the **specification**, not
> shipping code. Where I cite line numbers I'm citing the spec.
>
> Author: black-hat redteam pass, 2026-05-12. The goal of this document is to
> kill the design before code is written.

Threat model: a sophisticated attacker who can submit arbitrary PTBs, run
their own builder/validator stack (sequencing + censorship hints, not signing
collusion), and hold positions across many markets. Attacker can inject
oracle-touched markets indirectly via `path_observation::record` (which is
permissionless). Attacker cannot forge oracle prices; they can only choose
which already-published `PriceObservation` to consume.

---

## 1. Queue-Head Bumper (a.k.a. "Cut the Line")

**Severity: Critical (loss of funds + indefinite DOS on legitimate winners)**

### Setup

Queue is non-empty. Attacker controls (or is willing to fund) a fresh
position on a market that is about to settle. They expect to win that
position.

### Exploit

The spec routes `losing_stake` to `side_bucket` only when `queue_total > 0`
*at the time of `settle_market_*`*. But the spec also directly pays winners
from `settlement_lock` *first*, before draining `queue_funds`. The relevant
text:

> "Winners are NOT paid here individually — this transition only marks the
> market as settled and routes pooled funds. Individual winners then call
> `redeem_position`."

And `redeem_position` Case A pays the winner *in full from
`settlement_lock`*, regardless of how old the entries at the head of the
queue are. So:

1. Older market `M_old` settled with shortfall, leaving queue entries owed
   $190.
2. Attacker opens both sides of a new market `M_new` with whale-sized
   stakes (right under the per-trade `β` cap). Treasury fattens.
3. `M_new` expires. Outcome decides which side the attacker wins.
4. `lock_settlement(M_new)` reserves the full winning exposure into
   `settlement_lock`.
5. Attacker calls `redeem_position` on their winning M_new positions
   *before* `harvest()` ever runs — getting paid *in full* from
   `settlement_lock`, while the older queue entry continues to wait.

Steps 4–5 can be bundled into a single PTB by the attacker, fully
front-running any harvest call. Worse: if the attacker is the *only* writer
to `harvest()` (because nobody else is incentivized to pay gas — the spec
explicitly notes "no fee rebate beyond gas" in §7.2.1), the queue *never*
drains while the attacker keeps cycling new markets.

### Economic impact

Indefinite. A 1-USDC queued winner can wait years while the attacker
recycles `β · V` (= 0.5% of vault) per epoch through fresh markets. Across a
day at 30s epochs the attacker rotates ~$140k of fresh treasury through
themselves. They never break the per-trade cap; they never break the OI
cap; the protocol stays nominally solvent; but the FIFO ordering promised
by §3 INV-3 is violated *in spirit*: queue entries are FIFO inside the
queue, but the queue itself is starved relative to the fast lane through
`settlement_lock`.

### Does the spec catch it?

**No.** §7.1 Section "Rationale for routing `open_*` net stake to
`treasury`" actually *acknowledges this exact behavior*: "a stream of new
opens can transiently inflate `treasury` and let it pay winners ahead of
older queue entries. This *is the intended behavior*." The design treats
this as "we accept this." From an attacker's POV, the design hands you the
griefing tool and tells you the dev will not patch.

### Mitigation

**Hard, but mandatory:** Two-tier ordering. Whenever `queue_total > 0`,
`redeem_position` Case A must FIRST route `min(payout, queue_total)`
through the queue (pay the head entry, push the redeemer's balance into
the queue if the head can't cover them yet). Only the residual goes
straight to the winner. This makes new winners genuinely compete with
queued ones and aligns the FIFO promise.

Easy half-measure: make `harvest()` mandatory inside every
`redeem_position` call (auto-harvest with `max_n=1` before any payout).
Doesn't fix the front-running but at least guarantees forward progress.

---

## 2. Settlement Lock Hostage ("Brick-the-Market")

**Severity: High (DOS on a single market's redemptions)**

### Setup

Any market with a winner who refuses to call `redeem_position`. Attacker
*is* the winner (they hold the winning Position object and simply never
sign a redeem tx).

### Exploit

Per §2.3 the entire `winning_exposure` is moved from `treasury` into
`settlement_lock` during `lock_settlement`. Per §5 edge case 9 ("Winner
abandons position — never calls redeem"), the funds **stay in
`settlement_lock` forever** (or until a post-MVP `recover_stale` is added,
which doesn't exist).

An attacker who holds 100% of the winning side of a market locks
`winning_exposure` indefinitely into a balance that cannot pay any other
market's winners. This is *not* the queue — the queue gets refilled by
losing-stake harvests; `settlement_lock` doesn't.

Concrete: attacker opens 100% of a market's winning side at `α · V = 10%
of vault`. Winning side goes into `settlement_lock`. Attacker never
redeems. **10% of vault is permanently disabled for liquidity purposes.**
Attacker repeats across 9 markets. **90% of vault is dead.**

### Economic impact

`α · V · N` where N is the number of markets the attacker is willing to
co-fund. With α=10% and N=9, the protocol has ~10% of `V` available to
back live markets. Per-side OI caps now bind much harder, throttling
legitimate trade flow.

Cost to attacker: just the stakes themselves, which are sitting in
`settlement_lock` against their own winning positions — they can recover
them anytime by calling redeem. The "stake" isn't burnt; it's just being
refused. Infinite DOS at zero economic cost (bar gas + opportunity cost
of the locked stake).

### Does the spec catch it?

**No.** §5 #9 explicitly punts to "post-MVP `recover_stale`." The spec
acknowledges the attack vector and ships without a fix.

### Mitigation

**Easy:** Implement the `recover_stale(market)` timeout in MVP, not
post-MVP. If a market is `SETTLED_*` and has been so for > N hours
(N=24 is plenty for end users), anyone can call `release_stale`, which
moves unclaimed `settlement_lock` back to `treasury` *and* cancels the
linked Positions (they become permanent zero-redeem objects). Winners
who waited get nothing — fair enough; they had a day.

**Harder:** make `settlement_lock` a `Table<market_id, Balance<C>>`
keyed per market, so it doesn't pollute a global pool. Already required
to even reason about per-market staleness. Spec currently shows a single
shared `settlement_lock: Balance<C>` (§1) which makes per-market
release impossible.

---

## 3. Pro-Rata Dust Avalanche

**Severity: High (storage exhaustion, irreversible state bloat)**

### Setup

Many small winning positions in a single market that settles with a
shortfall. Per §2.3: "creates one `QueueEntry` per winning Position,
sized pro-rata."

### Exploit

Attacker opens N positions of `MIN_STAKE` each on the side they expect to
win. The `MIN_STAKE` floor isn't even in the spec yet (§7.2.3 mentions it
only as a *suggested* mitigation against telemetry spam). Without
`MIN_STAKE` an attacker can open positions of `1 mist` (10⁻⁹ SUI) each.

When the market settles with shortfall, *each* position becomes a
`QueueEntry` consuming a `Table<u64, QueueEntry>` slot. On Sui, each
dynamic field slot has a non-trivial storage rent (~50 bytes object
overhead + struct payload). At 1M entries the table is ~80MB and 1M Sui
storage rebates are owed when claimed — but the protocol pays the rent
*until* claim, and the attacker never claims.

### Economic impact

Storage cost to protocol: O(N) where N is attacker-controlled. With Sui's
~$0.0007/object storage cost (mainnet pricing analog) and a 1M-entry
attack, ~$700 of storage is held hostage, but more importantly the table
becomes unwieldy. Reading the head is still O(1), but management tools
that try to enumerate the queue (UIs, indexers) break. `harvest(max_n)`
is bounded by `max_harvest_per_call=32` per spec, so draining 1M entries
takes 31,250 harvest txs.

### Does the spec catch it?

**Partially.** §7.2.4 mentions "bucket all winning positions below a
`MIN_QUEUE_ENTRY` threshold into a single shared entry payable pro-rata
(post-MVP optimization)." Same pattern as Attack 2: spec acknowledges the
hole, defers the fix.

§5 edge case 14 says split must be "deterministic and tested" but says
nothing about a per-position floor.

### Mitigation

**Easy:** Enforce `MIN_STAKE` (e.g. 1 USDC = 1_000_000 mist for 6-dec
USDC) at `open_*` time. Combined with a `MIN_QUEUE_ENTRY` (e.g. enforce
no `QueueEntry` smaller than $5) at settle time — positions below the
floor get rolled into a single per-market dust entry whose owner is a
well-known burn address or the protocol fee bucket.

**Harder but proper:** Don't create one `QueueEntry` per position.
Create *one* `QueueEntry` per (market, winning side) carrying the total
shortfall, and have `redeem_position` pull pro-rata from the funded
amount. This makes settlement O(1) regardless of position count. Storage
is O(markets), not O(positions).

---

## 4. Reorder-the-Settlement Sandwich

**Severity: Critical (extracts entire `settlement_lock` from rightful winners)**

### Setup

A market expires with `winning_exposure > treasury` so a shortfall is
inevitable. The attacker is a builder (or has a relationship with one)
that can reorder transactions within a Sui checkpoint.

### Exploit

The spec leaves three lifecycle calls separately gated:

1. `lock_settlement(market)` — moves up to `treasury` worth of funds into
   `settlement_lock`.
2. `settle_market_*(market)` — distributes losing stake, enqueues
   shortfall.
3. `redeem_position(...)` — paid from `settlement_lock`.

Between (1) and (2) **there is no atomicity guarantee** in the spec.
Attacker:

- Front-runs `lock_settlement` with multiple `open_*` calls on a *separate*
  market that they are about to win. Treasury inflates by `Δ`.
- `lock_settlement` runs and grabs `min(winning_exposure, treasury)` —
  including the just-deposited Δ.
- Then `settle_market_*` runs.
- The attacker then races to call `redeem_position` on the second market,
  which… wait. The second market hasn't been settled yet so they can't
  redeem.

Re-attempt the attack the other way. The real exploit lives in the
between-blocks gap when `lock_settlement` was called but `settle` hasn't
yet:

- Other markets settle in the same window, draining `treasury`.
- That doesn't matter to the locked market because the funds are already
  in `settlement_lock`.
- BUT: `harvest(max_n)` is permissionless and happens to drain
  `side_bucket` into `queue_funds` for the OLD queue heads. While the
  freshly-locked market sits in LOCKED state, harvest is starving the
  queue using the side-bucket flow generated by the *new* settlements'
  losing stakes.

This isn't theft, but it does mean a market that locked early and
settles late has no claim on the side-bucket flow generated by markets
that settle in between. Pure FIFO of `settlement_lock` per market means
markets that *should* have been bundled together are accidentally
serialized.

The real critical attack: the spec doesn't require `lock_settlement` and
`settle_market_*` to be atomic. A malicious oracle keeper can `lock` for
a market where they hold winning positions, then *delay* the
`settle_market_*` call until they've also caused (via permissionless
oracle nudges) other markets' losing-stake flows to refill the side
bucket — even though those other markets' losing stakes were owed to
*older* queue heads. The attacker is using the lock as a parking
mechanism that doesn't appear in `queue_total`.

### Economic impact

Up to `winning_exposure` per market the attacker locks, multiplied by the
number of markets they hold winning positions on. Combines with Attack 2
(Settlement Lock Hostage) for compound effect.

### Does the spec catch it?

**No.** §2.2 doesn't require `settle_market_*` to follow `lock_settlement`
within the same tx, block, or even checkpoint. The spec says
"`lock_settlement` is called once by anyone after expiry" and treats
`settle_market_*` as a separate call.

### Mitigation

**Easy:** Combine `lock_settlement` and `settle_market_*` into a single
public entry that runs both back-to-back atomically. There is no reason
to split them — separating them only opens this race. The split exists
in the spec only because §2.2 mentions "between `lock` and `settle`" as
if it were intentional. It's not load-bearing.

**Harder:** if the split must remain (e.g. for keeper architecture
reasons), require `settle_market_*` to be called within the same epoch
as `lock_settlement`, with a dead-man's-switch: if `settle` is not called
within `T` blocks, anyone can call `unlock_and_revert` to push the funds
back to treasury and re-set the market to OPEN (then lock again with
fresh `treasury` value). Prevents the indefinite-lock variant.

---

## 5. Dust-Trickle Harvest Griefing

**Severity: Medium (gas grief + honest harvest amplification attack)**

### Setup

Queue has ≥ 1 entry. Attacker has standing to call `harvest(max_n=1)`
permissionlessly and pay only their own gas.

### Exploit

`harvest(max_n)` per §2.5 has the loop:

```
let pay = min(need, side_bucket.value());
side_bucket -= pay
queue_funds += pay
entry.funded += pay
```

There's no minimum `pay` floor. If the attacker watches the side bucket
for the moment when it has exactly `1 mist`, they call `harvest(max_n=1)`
which moves 1 mist from `side_bucket` to `queue_funds` and consumes
~$0.001 of gas. The queue head's `funded` grows by 1 mist. The entry
remains unfilled.

Why is this attractive to an attacker? Because it interferes with
*honest* harvest calls trying to bundle multiple events. In particular,
if a keeper is running a periodic `harvest(max_n=32)`, the attacker can
preempt them and "cheaply progress" the harvest such that the keeper's
call now does almost nothing — but the keeper still paid full gas to
acquire the lock on the shared `MartingalerVault` object. With Sui's
shared-object scheduling, repeated harvest(1) calls block the harvest(32)
calls.

The deeper version: if `MIN_STAKE` and `MIN_QUEUE_ENTRY` aren't
enforced, the attacker can *also* create dust queue entries per Attack 3,
ensuring every harvest() iteration only progresses 1 mist before
incrementing `queue_head` by 1. A `harvest(max_n=32)` becomes a 32-entry
walk that drains 32 mist total.

### Economic impact

Indirect — keeper costs balloon, queue drain rate falls. With a $0.0005
per-tx Sui cost and 32 entries per call, draining a 1000-entry attacker-
constructed dust queue requires 32 honest tx ($0.016) and produces no
real queue progress. Attacker spent ~$0.001 per dust deposit.

### Does the spec catch it?

**No.** `max_harvest_per_call` is gas-bound; there's no minimum-progress
requirement.

### Mitigation

**Easy:** add `min_pay_per_iteration` config. If `pay < min_pay`, skip
forward without incrementing the iteration counter (or refund the gas to
the caller from `protocol_fees`).

**Better:** combine with `MIN_QUEUE_ENTRY` from Attack 3 and a
`min_side_bucket_to_harvest` floor (e.g. don't even allow `harvest()`
to be called unless `side_bucket >= 1 USDC`). Forces meaningful work
per call.

---

## 6. Cumulative-Telemetry Overflow Aiming

**Severity: Low → Medium (depends on how telemetry is read by other modules)**

### Setup

Long-running protocol. Attacker spams tiny `open_position` calls.

### Exploit

§1 declares:

```move
cumulative_stakes_in:    u128,  // monotonic
cumulative_payouts_out:  u128,
cumulative_losses_absorbed: u128,
cumulative_fees_taken:   u128,
```

`u128` is fine for actual value rollover (~3.4×10³⁸). The attack isn't
overflow per se — it's that the *event indexer* downstream often uses
JS/TS `bigint` or even `number`. Off-chain dashboards subtract these
values to compute LP yield. A trader could spam positions to inflate
`cumulative_stakes_in` without affecting `cumulative_payouts_out`,
making the LP yield calculation appear inflated.

This isn't an on-chain attack but it's a UI-trust attack. Combined with
public off-chain rebalancing tools (e.g. an LP that buys/sells WICK
tokens based on the displayed LP yield), it can be a market-manipulation
primitive.

### Economic impact

Soft — depends on what off-chain consumers do with telemetry. Could
inflate displayed APY by 2–3x if naively computed, leading to mispriced
LP token.

### Does the spec catch it?

**Partially.** §7.2.3 mentions adding `MIN_STAKE` to prevent telemetry
spam, but treats it as cosmetic. The fact that off-chain price discovery
might use these values isn't considered.

### Mitigation

**Easy:** enforce `MIN_STAKE` ≥ $1 equivalent at `open_*`. Makes
telemetry spam economically pointless.

**Documentation-only fix:** add a "consumers should compute APY from
events not cumulative counters" warning in §9 of the events doc.

---

## 7. The Negative-Equity Withdrawal Exit

**Severity: Critical (LP first-mover advantage extracts all LP capital)**

### Setup

Future world where LP withdrawals exist (post-MVP). The spec doesn't
specify withdrawals, but §7.6 of the solvency proof acknowledges them as
a future feature: "LP withdrawals are rate-limited and subordinated to
queue-head payouts; LP shares are 'slashed' proportionally to `Q / V` at
withdrawal time."

### Exploit

Equity = `treasury + side_bucket - queue_total`. When `Q > 0`, equity
can be negative. When LP withdrawals are added, the natural
implementation is "LP withdraws their pro-rata share of `treasury`."

If the slashing is missing or buggy:

1. Market settles with shortfall. `Q` increases by $10k. Equity drops by
   $10k.
2. LP A immediately withdraws 50% of `treasury` (their pro-rata share).
3. Now `treasury` is half what it was, but `Q` is still $10k. The
   remaining LP B's share of equity dropped from 50% to a much smaller
   fraction (or negative).
4. LP B is locked in until `Q` drains via future losing trades.
5. LP A externalizes the loss to LP B — a classic bank-run pattern.

The spec's mitigation in §7.6 ("LP shares slashed proportionally to
`Q / V`") is the right idea but the math has to be exactly right or
arbitrage opens. Naive `share_value = treasury / total_shares` is wrong;
correct is `share_value = (treasury - max(0, Q - side_bucket)) /
total_shares`.

### Economic impact

Up to `Q` USDC, transferred from late-withdrawing LPs to early-
withdrawing LPs. With a 4-hour stress event and `Q ~ 20% of V`, the
first 50% of LPs walk away with their full notional, the remaining 50%
take a 40% haircut.

### Does the spec catch it?

**Acknowledged in §7.6 but not designed.** Post-MVP only. But the
spec's wording "LP shares are 'slashed' proportionally to `Q / V`" is
*itself* slightly wrong (should also subtract `side_bucket`'s
parked-but-not-yet-routed funds; otherwise you double-count side
bucket flow as LP equity).

### Mitigation

**Hard:** Define LP share value precisely, including the
`side_bucket` parking lot, and require any withdrawal to include a
`Q / equity` slashing factor. Test against the worked example in §4 of
the spec.

**Easy:** Disable LP withdrawals entirely while `Q > 0`. UX cost is
high (LP funds can be locked for hours during stress) but eliminates
the bank-run vector.

---

## 8. Cross-Collateral Phantom Solvency

**Severity: High (allows undercollateralized markets to pretend solvent)**

### Setup

Two `MartingalerVault` instances exist: `MartingalerVault<USDC>` and
`MartingalerVault<SUI>`. Per §7.3 "Cross-collateral … the design
naturally supports two parallel vaults."

### Exploit

`Market<C>` is generic over collateral. The per-market settlement
references *its own* vault by `vault_id: ID`. But the spec doesn't show
any check that `Market<C>.vault_id` *actually points to* a vault of type
`MartingalerVault<C>`.

If `vault_id` is just a `sui::object::ID` and the settlement function
takes `vault: &mut MartingalerVault<C>` as a param, what stops a market
from passing in `vault_id_a` at construction but presenting
`MartingalerVault<C>` instance B at settlement? Nothing in the spec.
The `&mut` borrow only proves the caller owns *some* vault of type C.

Concrete exploit: attacker creates `Market<USDC>` claiming
`vault_id = id(SUI_vault_misregistered_as_USDC)`. They then settle with
the actual production USDC vault, draining USDC even though their
market should have been settled against a separate (empty) vault.

This is mostly a code-level concern but the spec doesn't disambiguate.
Move's type system protects against most of the cross-collateral
confusion, but `vault_id: ID` is just a dumb reference — the vault
being passed is what matters at settlement.

### Economic impact

If exploited, an attacker can create markets that draw payouts from
ANY vault of the right collateral type, including ones never sanctioned
by governance. With multiple SUI-collateralized vaults (e.g. one for
arcade, one for retail), the attacker picks the deepest one to drain.

### Does the spec catch it?

**No.** §7.3 mentions the dual-vault deployment but doesn't specify the
binding mechanism between markets and vaults.

### Mitigation

**Easy:** require an `AdminCap`-gated `register_market(vault, market)`
that establishes the `vault_id ↔ market_id` binding atomically and
non-revocably. Settlement reads the bound vault_id and asserts equality.

**Harder but cleaner:** make `Market<C>` *contain* a phantom witness
type that pins it to a specific named vault (e.g. `Market<C, V_TAG>`
where `V_TAG: drop` is a one-shot witness minted by the vault at
registration).

---

## 9. Donation Distortion ("Tip the LP")

**Severity: Low (cosmetic but breaks invariant accounting)**

### Setup

Anyone with collateral and a desire to disrupt accounting telemetry.

### Exploit

§7.2.9 says "Don't expose a public `donate`." But Move doesn't actually
prevent this — anyone can construct a `Coin<C>` and call any function
that takes one. If `treasury` exposes any deposit primitive (even
package-private from `open_position`), the attacker can route a coin
through that path with `stake_amount = donation` and `payout =
near-zero` by gaming the multiplier inputs.

More concretely: the spec's `open_position` shows:

```
let stake = stake_coin.value();
let payout = stake * market.payout_multiplier_bps / 10_000;
```

`payout_multiplier_bps` lives on `Market<C>`. Attacker creates a market
with `payout_multiplier_bps = 10_001` (1.0001x — the assert is just
`> 10_000`). Their open is a tiny exposure but a meaningful treasury
deposit. Equivalently a gift.

Now the protocol's `cumulative_stakes_in` reflects the donation (good),
the treasury reflects it (good), but the *invariant* §3 INV-1
references `sum_open_position_stakes` which now includes a rogue
position whose payout rounds to ~stake. When that position settles,
either:

(a) the attacker wins, drains their own donation back at 1.0001x —
    losing 0.01% to fees but otherwise neutral; or
(b) the attacker loses, the donation is "absorbed" — but the side they
    bet on had 0 OI before, so the *other* side's winners get an
    unexpected windfall.

Combined with sandwich attacks on a thinly-traded market where the
attacker controls both sides, this lets them launder a donation into a
specific winner's pocket.

### Economic impact

Small per-transaction (basis points), but if `payout_multiplier_bps`
isn't bounded below at, say, 11_000 bps (1.1x) the attack is essentially
free targeted-redirection of capital.

### Does the spec catch it?

**Partial.** Current code at `move/sources/market.move:107-108`:

```move
assert!(payout_multiplier_bps > 10_000, EBadMultiplier); // must pay > 1x
assert!(payout_multiplier_bps < 100_000, EBadMultiplier); // sanity cap 10x
```

The `> 10_000` floor is too lax; 10_001 is allowed. The spec §1 doesn't
even mention this floor.

### Mitigation

**Easy:** raise the floor to `payout_multiplier_bps >= 11_000`
(minimum 10% edge for the loser-payout-funded LP) at market creation.
Add a separate `donate_to_protocol_fees(coin)` if you actually want to
accept donations — routes them away from `treasury` into
`protocol_fees`, preserving §3 INV-1 cleanly.

---

## 10. The Multiplier-Rounding Dust Pump

**Severity: Medium (slow leak; per-transaction tiny but adds up)**

### Setup

`payout = stake * payout_multiplier_bps / 10_000`. Integer division,
no banker's rounding.

### Exploit

For `payout_multiplier_bps = 18_000` (1.8x), a stake of 5 mist computes:

```
payout = 5 * 18_000 / 10_000 = 90_000 / 10_000 = 9 mist
```

For a stake of 9 mist:

```
payout = 9 * 18_000 / 10_000 = 162_000 / 10_000 = 16 mist (rounded down from 16.2)
```

Now consider the attacker who opens many `stake = 1 mist` positions:

```
payout = 1 * 18_000 / 10_000 = 18_000 / 10_000 = 1 mist (rounded down from 1.8)
```

The attacker's payout is 1 mist instead of 1.8 mist. They pay 1 mist
stake, receive 1 mist payout if they win. But the *exposure* recorded
in `market.touch_exposure` is 1 mist — not 1.8. So the solvency check:

```
worst_case = max(touch_exposure, no_touch_exposure)
assert!(vault.balance >= worst_case)
```

…is fooled by 0.8 mist per attacker position. Multiply by N positions —
the protocol thinks it's solvent but is actually under by 0.8N mist.

This isn't an attack against the *attacker's* benefit (they actually
*lose* the rounding). But it's an attack against the protocol's
*accounting*: settlement compares actual vault balance against tracked
exposure, and the `actual_balance > tracked_exposure` gap accumulates.
After many such trades, the gap is large enough that one big legitimate
winner's payout is short by however much rounding was lost — but the
protocol thinks it's solvent.

The reverse exploit is more interesting: if the attacker can shape the
payout multiplier to favor *up*-rounding (e.g. via a market with
`payout_multiplier_bps = 12_500` and `stake = 7`), `7 * 12_500 / 10_000
= 8.75 → 8 mist`. Attacker paid 7 mist, gets 8 if they win. Protocol
exposure says 8. But cumulatively:

- N opens × 1 mist rounding gain to attacker on each bet
- Attacker breaks even on 50/50 odds because the 1 mist rounding gain
  matches their 1 mist house-edge cost (roughly)
- But the *wrong* vault accounting cascades into incorrect solvency
  checks

### Economic impact

Direct theft is ~1 mist per trade. At 1M trades, ~$0.001 of leak. Tiny
in dollar terms but it breaks the invariant `vault.balance ==
sum(open_position.payout_if_win)` that the codebase claims as
"load-bearing" in `vault.move:11`. Once the invariant is gone, all the
solvency assumptions in `04_solvency_proof.md` are technically void.

### Does the spec catch it?

**No.** §1 shows the formula but doesn't address rounding direction.
The current code at `market.move:287-289` rounds *down* via
`u128 / 10_000`. There's no comment about which direction is safe.

### Mitigation

**Easy:** Round payouts *up* (ceiling division), exposures *up*. This
makes the protocol's tracked obligations strictly ≥ what's actually
owed. Solvency check then has 0–1 mist of safety margin per position.

**Belt-and-suspenders:** enforce `MIN_STAKE` such that rounding
becomes a < 0.01% error per trade (e.g. `MIN_STAKE = 10_000 mist` for
any market with `payout_multiplier_bps <= 100_000`).

---

## 11. Permissionless `lock_settlement` Wrong-Time Attack

**Severity: Medium (force-locks treasury at attacker-chosen moment)**

### Setup

A market is past expiry. `lock_settlement` is permissionless per §2.2.
Treasury fluctuates with new opens.

### Exploit

The attacker watches treasury value. They wait until *just after* a
large losing-side stake hits treasury (e.g. a $5k open by another
trader), then immediately fires `lock_settlement` for an expired market
they hold winning positions on. The amount locked is `min(winning_exp,
treasury.value())`, which now includes the freshly-deposited $5k.

Concretely:

1. Market M is expired with `winning_exp = $10k`, treasury sits at
   $7k. Without the attack, `lock_settlement` reserves $7k.
2. Trader X (unrelated) opens a $5k position on a different market.
   Treasury jumps to $12k.
3. Attacker fires `lock_settlement` on M *before* the next harvest or
   settlement consumes treasury. `lock_settlement` reserves $10k.
4. Attacker redeems and gets $10k from `settlement_lock` — Trader X's
   $5k went straight into the attacker's pocket via the lock.

Trader X isn't directly harmed (their stake is their stake, they're now
in their own market), but the *protocol's* equity suffered. Without the
attack the queue would have absorbed $3k of attacker's payout
(legitimately, given the protocol's vault state). With the attack the
queue absorbs $0. The other markets' winners are now more likely to be
queued instead.

### Economic impact

Up to `winning_exp - treasury_at_natural_settle_time`. In a stressed
protocol, this is the entire "shortfall" that should have been queued.
Attacker bumps themselves out of the queue and into the lock.

### Does the spec catch it?

**No.** `lock_settlement` is explicitly permissionless. The §7.2.2
"Front-run lock_settlement to inflate exposure" discussion only
considers attackers inflating their *own* exposure, not exploiting other
traders' deposits to lock at inflated treasury values.

### Mitigation

**Easy:** require `lock_settlement` to compute `to_lock` based on
`treasury_at_market_expiry`, snapshotted at expiry time and stored on
the market. New opens after expiry don't affect the snapshot. Doesn't
prevent timing games but bounds them to the expiry-instant treasury.

**Harder:** require `lock_settlement` and `settle_market_*` to be
bundled with a `treasury_minimum: u64` parameter that aborts if treasury
exceeds the snapshot by more than `Δ_max`. Forces the attacker to choose
between fast settlement and waiting for a juicy moment.

---

## 12. Time-Warp Settlement (Clock Discontinuity)

**Severity: Low (theoretical; only triggers under Sui clock anomaly)**

### Setup

Sui's `clock::Clock` advances forward but is operator-controlled at
the framework level. Hypothetical: validator collusion advances
`clock.timestamp_ms()` by a large jump (or, more realistically, a
genuine bug or re-config event resets clock).

### Exploit

`open_position` checks `now < market.expiry_ms`. `redeem_position`
checks `now >= market.expiry_ms`. If `now` jumps forward by 1 day:

- All markets with `expiry_ms` in that window become simultaneously
  redeemable. `lock_settlement` and `settle_market_*` race across all
  of them, processing in unpredictable order.
- `path_observation.touch_outcome(po, clock)` requires `clock.ts >=
  expiry`. Jumped clock → assertion always passes. Whatever ticks were
  recorded *before* the jump are the only data; the path observation's
  internal `last_seen_ms` is now days-old from the jumped clock's POV.

Combined with attacker control over `path_observation::record` (which
is permissionless), the attacker who anticipated the time warp can
front-run the discontinuity by recording oracle ticks favorable to
their position right before the clock catches up. The path's
`touched_at` becomes sticky.

### Economic impact

Negligible in practice (Sui clock doesn't jump in production), but if
it ever did, every queued payout in the system would be racing against
every other for `treasury` flow.

### Does the spec catch it?

**No.** Spec assumes monotonic clock. Path observation §5.7 punts the
"zero ticks" question to the path module, which itself doesn't handle
clock discontinuity.

### Mitigation

**Hard:** add an explicit `freeze_at_expiry()` that snapshots the
oracle's last-observed price into the market state at market creation,
and require settlement to read from the snapshot. Doesn't help with
the path question but ensures terminal-price markets are clock-jump
resistant.

**Easy:** document that settlement of N markets at once is fine (the
spec already allows it) and rate-limit `lock_settlement` calls per
checkpoint to prevent gas exhaustion attacks combined with clock jumps.

---

## 13. Adversarial Market Creator (the "Both-Sides Pump")

**Severity: High (targeted siphon of LP capital via crafted market)**

### Setup

Anyone can call `market::create()` per current code (the function is
public). Creator picks `payout_multiplier_bps` freely within
`(10_000, 100_000)`. Creator picks the linked `WickOracle` and
`PathObservation`.

### Exploit

Attacker creates a market with `payout_multiplier_bps = 19_999` and
seeds `seed_collateral = 1 mist`. They link to a `PathObservation`
with a barrier they *know* will be touched (say, BTC price observed at
$60k with a barrier at $50k — already touched at creation if the
oracle's latest is above $50k for `direction=touch_above`, but
`path_observation::is_touched` may not fire until the next `record()`).

1. Attacker opens both sides of the market with $1k each. After fees,
   $1k goes into treasury per side. Touch exposure = $1.9999k, no_touch
   exposure = $1.9999k.
2. Attacker calls `path_observation::record` (permissionless), which
   may immediately set `touched_at` based on the oracle's latest
   already-published observation.
3. After expiry, attacker calls `redeem` on the touch position — wins
   $1.9999k. The no_touch position is a loser.
4. Net: attacker put in $2k, got back $1.9999k + the residual of their
   loser side's stake which was absorbed by the vault.
5. The *vault* lost: $1.9999k (touch payout) - $1k (no_touch stake
   absorbed) - $1k (touch stake going in) - $1 (seed) = $-0.0001k.

OK so a near-fair multiplier and 50/50 known outcome roughly breaks
even on a per-trade basis. The attack value: **timing**. Attacker can
choose *when* to settle (by timing the `record()` call). They can
extract the queue head's funded position and spike it through their
own market.

The deeper attack: with `payout_multiplier_bps = 19_999`, the
attacker's edge as the loser side is 0.005% — but they control the
oracle observation timing. If the queue is already active and the
attacker's losing-side stake gets routed to side_bucket (because
`queue_total > 0` at settle time), then via `harvest()` the attacker's
loss flows to the queue head. **The attacker is voluntarily taking the
queue's place to be paid first** — a queue-jump.

In particular: they open the *winning* side at a moment when treasury
can pay them in full from `settlement_lock`. Then they open the
*losing* side at a moment when they want to inject side_bucket. They
control both sides' timing.

### Economic impact

Per attack: low (basis points). But the attacker can iterate
indefinitely with no per-attack risk. Aggregated across many crafted
markets, this is a slow drain of LP capital toward the attacker via
queue priority manipulation.

### Does the spec catch it?

**No.** Market creation is permissionless and `payout_multiplier_bps`
isn't bounded near 1x. The spec assumes adversarial *traders* but not
adversarial *market creators*. The README and AGENTS.md do say "for
arcade markets this is protocol-funded" but the code path is open to
anyone.

### Mitigation

**Easy:** gate `market::create()` behind `AdminCap`. Trade access for
safety. Document trade-offs.

**Harder but better for permissionless ethos:** require market creators
to post a `creator_bond` proportional to `seed_collateral`. Bond is
slashed if the market settles with shortfall before any non-creator
position opens. Makes single-creator bait markets economically
unattractive.

**Hardest:** add a "minimum third-party participation" rule — markets
where the creator holds > 50% of either side at expiry are settled
with all profits routed to `protocol_fees` instead of paying out.
Discourages self-trading attacks.

---

## 14. The "Never Drain" Steady State

**Severity: Critical (existential — if it happens, the protocol is dead)**

### Setup

Steady-state world. Trader win-rate is the assumed `p = 0.5`. The
`harvest()` function is fully permissionless and never automatically
called.

### Exploit

The protocol's solvency proof §4 assumes that, in expectation, losing
stakes flow into the side bucket while the queue is active and drain
the queue. But this requires:

(a) `harvest()` is actually called. Permissionless ≠ guaranteed.
(b) The queue eventually drains.

Imagine the following dynamic equilibrium: every winning trade pays in
full from `settlement_lock` (because new opens keep treasury fat).
Every settle-with-shortfall enqueues a tiny ($X) entry. side_bucket
fills slowly but harvest is never called because:

- Queue entries are dust-sized (per Attack 3's lack of MIN_QUEUE_ENTRY).
- Honest harvesters get gas-griefed (per Attack 5).
- No incentive exists to call harvest (no tip, no fee rebate).

Side_bucket grows unboundedly. Queue doesn't drain. Per the spec's
own §5 edge case 12: "harvest called with `queue_total == 0` but
`side_bucket > 0`. This state is unreachable: `settle_market_*` only
routes losing stake to side_bucket *if* `queue_total > 0`."

So once the queue becomes non-empty, every subsequent losing stake
goes to side_bucket. If the queue never fully drains, side_bucket
never reverts to "empty mode." Capital that should have flowed back
to treasury (where it would have refilled the LP equity buffer)
instead sits permanently in side_bucket with no live winners to pay.

The protocol's `equity = treasury + side_bucket - queue_total`
remains positive but the *useful* equity (treasury) declines monotonically.
Eventually treasury hits zero, every settlement enqueues entirely,
and the protocol becomes a queue-only state.

### Economic impact

Total. Treasury → 0, all market settlements go to queue, side_bucket
holds collateral that no live winner can claim quickly.

### Does the spec catch it?

**Partial.** §3 INV-11 ("harvest preserves equity") confirms harvest
is correct when called. §4.4 of the solvency proof models harvest as
called automatically — but the spec explicitly says it's permissionless.

### Mitigation

**Easy:** auto-harvest at the start of every `settle_market_*` and
`redeem_position` call. Force progress at the moments when capital is
moving anyway, making the harvest gas part of the settlement flow.

**Better:** small bounty paid to the harvest caller from
`protocol_fees` (e.g. 1 bp of `side_bucket` drained, capped at a
minimum). Makes harvest a real keeper economic activity.

**Best:** combine both. Auto-harvest on every flow + bounty on
explicit harvest calls.

---

## 15. Settlement-Lock Pool Confusion (per-market vs. shared)

**Severity: High (allows market A's winners to drain market B's lock)**

### Setup

Per the §1 spec, `settlement_lock: Balance<C>` is a single shared
balance on the vault. Multiple markets in `LOCKED` state contribute to
this single pool.

### Exploit

Two markets, M_A and M_B, both in LOCKED state.

- M_A locked $5k for its winners.
- M_B locked $3k for its winners.
- Total `settlement_lock = $8k`.

M_A's winners call `redeem_position`. The spec §2.4 case A says:

```
let pro_rata_payout = position.payout_if_win;
settlement_lock -= pro_rata_payout
```

There's no per-market accounting. M_A's first winner with payout $7k
*drains $7k from settlement_lock*, even though M_A only locked $5k.
M_B's winners get $1k of leftover instead of $3k. The shortfall now
goes to M_B's queue entries.

### Economic impact

Funds are misrouted between markets. M_A's overdrawing is technically a
solvency violation (pays more than was reserved). M_B's underdrawing
forces extra queue entries that wouldn't have existed.

In the worst case, an attacker who holds winning positions on M_A and
losing positions on M_B can deliberately drain M_B's lock into M_A's
payouts.

### Does the spec catch it?

**No.** §1 explicitly shows a single `settlement_lock: Balance<C>` and
§2.4 doesn't gate the withdrawal by `market.locked_obligation`. The
worked example in §4 only ever has one market locked at a time, hiding
the bug.

### Mitigation

**Easy:** make `settlement_lock` a `Table<ID, Balance<C>>` keyed by
market ID. Per-market reservation. `redeem_position` withdraws from
`settlement_lock[market_id]` not the shared pool.

**Alternative:** keep the shared pool but enforce
`market.locked_obligation` is a per-market budget — track
`market.locked_remaining: u64` and decrement on each redeem. When it
hits zero, all subsequent winners go to queue. (More state but smaller
storage refactor.)

---

## Severity Ranking (worst first)

| Rank | Attack | Severity | Caught by spec? |
|---|---|---|---|
| 1 | #1 Queue-Head Bumper | Critical | **No** (acknowledged & accepted) |
| 2 | #4 Reorder-the-Settlement Sandwich | Critical | No |
| 3 | #7 Negative-Equity Withdrawal Exit | Critical | Acknowledged (§7.6, post-MVP) |
| 4 | #14 The "Never Drain" Steady State | Critical | Partial |
| 5 | #15 Settlement-Lock Pool Confusion | High | **No** |
| 6 | #2 Settlement Lock Hostage | High | Acknowledged (§5.9, post-MVP) |
| 7 | #3 Pro-Rata Dust Avalanche | High | Acknowledged (§7.2.4, post-MVP) |
| 8 | #8 Cross-Collateral Phantom Solvency | High | No |
| 9 | #13 Adversarial Market Creator | High | No |
| 10 | #5 Dust-Trickle Harvest Griefing | Medium | No |
| 11 | #11 Permissionless `lock_settlement` | Medium | Partial (§7.2.2) |
| 12 | #10 Multiplier-Rounding Dust Pump | Medium | No |
| 13 | #6 Cumulative-Telemetry Overflow | Low/Medium | Partial (§7.2.3) |
| 14 | #9 Donation Distortion | Low | Partial |
| 15 | #12 Time-Warp Settlement | Low | No |

### Attacks the design genuinely DOES NOT mitigate (red-flag list)

These are the ones the spec doesn't even acknowledge and would actually
ship if implemented as specified today:

- **#1 Queue-Head Bumper** — spec calls it "intended behavior."
- **#4 Reorder-the-Settlement Sandwich** — lock/settle split is gratuitous.
- **#15 Settlement-Lock Pool Confusion** — single shared lock pool is wrong.
- **#8 Cross-Collateral Phantom Solvency** — no binding mechanism.
- **#13 Adversarial Market Creator** — `create()` is public + bounds too loose.
- **#10 Multiplier Rounding** — direction unspecified.

The rest are flagged or punted-to-post-MVP. The first six on the list above
need to be designed before any code is written.

---

## Top Three Required Fixes Before Any Code

1. **Atomic `lock + settle`** — collapse §2.2 and §2.3 into a single
   public entry. The split serves no purpose and opens Attack 4 + Attack 11.
2. **Per-market `settlement_lock`** — `Table<ID, Balance<C>>`, not a
   single shared `Balance<C>`. Closes Attack 15 + makes Attack 2 fixable.
3. **Auto-harvest on every flow** — every `redeem_position` and
   `settle_market_*` calls `harvest(small_n)` first. Closes Attack 14 and
   reduces Attack 1's window.

Once those are in place, the remaining attacks become parameter-tuning
exercises (MIN_STAKE, MIN_QUEUE_ENTRY, ceiling-rounding) rather than
architectural rewrites.
