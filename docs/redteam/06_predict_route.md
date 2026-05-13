# 06 — Red Team: Wick × DeepBook Predict BTC Route

> Adversarial review of the `wick::predict_route` integration specified in
> `docs/design/06_predict_btc_route.md`. The spec proposes a single shared
> `WickPredictHub<DUSDC>` that custodies all BTC-route flow and a single
> `PredictManager` whose **owner is the Wick admin EOA**. Users sign a PTB,
> the Wick relayer co-signs, the relayer's signature satisfies Predict's
> `assert!(ctx.sender() == manager.owner)` check, and DUSDC moves through
> Wick custody on its way into and out of Predict.
>
> The design author already concedes (§3.1) "this is a step backwards from
> 'user signs once'." This document argues it is much worse than that: the
> chosen Option A turns Wick into a **DUSDC custodian for all BTC users
> simultaneously**, with a single hot key that can sign Predict-side
> withdrawals against the *aggregate* hub balance. Most of the §7 risk
> section is one paragraph apiece for issues that warrant several pages.
>
> Author: black-hat redteam pass, 2026-05-12. Goal: kill or harden Option A
> before any line of `predict_route.move` is written, and force a defensible
> answer to "why are you holding everyone's DUSDC in one BalanceManager
> behind one EOA?"

Threat model: an attacker with the ability to submit arbitrary PTBs against
the Wick package and the Predict package; observe and front-run Sui
mempool / sequencer state; spin up alt addresses to act as multiple
"users"; and, in some scenarios, social-engineer or compromise the Wick
relayer key. They cannot forge `OracleSVI` signatures (Block Scholes signs
those off-chain) and they cannot upgrade Predict.

The spec's §7 lists six risks in three or four sentences each. I find at
least eleven distinct attacks below; only two are seriously discussed in
the spec, and even those are under-mitigated. The pattern across the list:
the spec treats Predict as a black box that "settles eventually" and Wick
as a thin wrapper over it. In reality the seam between the two systems —
ownership, settlement timing, oracle independence, and reconciliation
order — is wide enough to drive a truck through.

---

## 1. Custody Capture (Compromised Relayer Drains the Hub)

**Severity: Critical (loss of all hub DUSDC; full BTC route compromise)**

### Setup

Per §3.1: "Wick admin EOA owns the manager. That EOA is a multisig in
production; for MVP it is the deployer." The relayer key sits hot in
production — every BTC trade requires its co-signature for the
`manager.owner == ctx.sender()` gate inside `predict::mint`.

### Exploit (PTB)

The attacker compromises the relayer key (phishing the deployer's CLI
keystore, exfiltrating a CI secret, sandbox escape on the relayer host,
bribery — pick your favorite). With that key alone they construct:

```
PTB:
  let coin = predict_manager::withdraw<DUSDC>(
      &mut wickHub.manager,    // owner check passes — attacker IS owner
      <full_balance>,
      ctx,
  );
  transfer::public_transfer(coin, attacker);
```

`withdraw<DUSDC>` reasserts owner (per §1.2 step 9 "which itself reasserts
owner"). The relayer key is the owner. Done in one tx; no Wick code path
executes. The hub's `BalanceManager` empties — including DUSDC that
belongs to other users' open Wick positions.

Open Wick positions are now insolvent: the underlying Predict positions
are still open in the manager's `positions` table, but the
`BalanceManager.balance` is zero, so when expiry arrives and
`redeem_permissionless` returns funds to the manager, those funds *also*
land in the now-empty BalanceManager and the attacker can withdraw them
again. Permanent capture of the BTC route's float.

### Economic impact

Caps at the entire DUSDC balance held by the hub at the moment of
compromise, which is `Σ(open premiums) + seeded reserve` for every BTC
position currently open. With the spec's "10–100 concurrent BTC traders
at $10–$100 each" hackathon figure that's small; with any production
adoption it's the entire BTC float through Wick. There is no per-user
segregation inside the BalanceManager — Predict's `BalanceManager` is one
balance, not a registry of (user, balance) tuples.

### Existing controls assessment

§3.1 hand-waves: "That EOA is a multisig in production; for MVP it is the
deployer." §7 hand-waves: "the relayer key is a multisig in production,
hot-key budget is bounded by sweeping payouts to a cold treasury after
each settlement." Neither is a control today:

- The "multisig in production" promise is a deferred control. MVP code
  ships with single-key custody, which is exactly when judges and the
  first real users transact. Saying "we'll multisig later" is the
  hackathon equivalent of a security incident waiting for press.
- "Sweep payouts to a cold treasury after each settlement" only protects
  the *settled-payout* tail. The hot-key window is the live float of
  open positions, which can be the majority of the hub's balance during
  a busy 15-min cycle. Sweeping after settlement does nothing for the
  hour the float is exposed.
- There is no on-chain rate limit, no proof-of-reserves check, no
  governance gate on `withdraw` from the hub-owned BalanceManager.

### Mitigation

- **Easy:** Ship Option B (per-user managers, `WickClaimTicket`). It
  eliminates the Wick custody seam entirely. The "user signs twice"
  cost is a one-time bootstrap; demo this in the pitch and judges
  reward you for non-custodial design rather than penalize the extra
  click.
- **Easy (compromise):** If Option A must ship, make the hub a
  Sui multisig from day zero (Sui has native 1-of-N and M-of-N support;
  even 2-of-2 with the deployer + a watch-only co-signer eliminates the
  single-key compromise vector). Document the multisig address in
  `AGENTS.md` and verify on-chain at startup.
- **Medium:** Add a `wick::predict_route::sweep_to_cold(amount)` entry
  that is the *only* way to move DUSDC out of the hub manager, and gate
  it on a per-block / per-window withdrawal cap. Predict's
  `predict_manager::withdraw` is callable directly by the owner — so to
  bind the owner to Wick logic the hub's owner must itself be a Move
  object (a `HubAdminCap` capability), not a raw EOA. Predict explicitly
  forbids ownership transfer (§1.1: "owner is fixed at creation time
  and cannot be transferred"), so this requires either upstreaming a PR
  to Predict or living with the hot-key surface.
- **Hard:** Petition Mysten/Aslan to add a `transfer_owner` flow to
  Predict's `PredictManager` so Wick can hand ownership to a
  package-controlled address. Until that ships, you are renting a hot
  EOA.

This is the load-bearing finding. Every other attack below assumes Option
A has *not* been replaced.

---

## 2. Settlement-Order Arbitrage (Touch-Wick-Pay-Twice)

**Severity: High (loss of funds; protocol-side, not user-side)**

### Setup

A Wick BTC market has barrier `B`. The same BTC binary on Predict has
strike `K` adjacent on the grid. Because Wick mirrors `OracleSVI.spot`
into a `WickOracle`, both Wick's `PathObservation` and Predict's
`OracleSVI.is_settled` ultimately read the same upstream Block Scholes
spot — but at *different cadences*:

- Wick: pull-driven, ~1s keeper push into the mirror, `path_observation::record`
  consumes immediately.
- Predict: oracle settles only on the post-expiry `update_prices` tick,
  whose timing is whatever Block Scholes' keeper does next.

Within a single 15-min window an attacker opens both:

- A Wick TOUCH position (small) — wins if BTC wicks past `B` even briefly.
- A Predict short of the up-leg (or whatever leg pays out the same way) —
  wins on the *terminal* settlement price.

### Exploit (PTB sequence across the window)

1. **Minute 0**: Attacker mints both legs above. The Wick PTB calls
   `predict_route::open_touch` and the hub mints a Predict position on
   the *up-leg* (per §3.2: "is_up_leg: bool — see §3.2 for leg choice").
   Attacker also mints their own Predict position on the down-leg via a
   *separate, attacker-owned* `PredictManager`.
2. **Minute 7**: BTC briefly wicks above `B`. Wick keeper pushes the
   tick, `PathObservation` records, `BarrierTouched` fires. Attacker's
   Wick TOUCH is now sticky-touched.
3. **Minute 8**: BTC retraces below `B`. Wick's path stays touched
   (sticky `touched_at`); Predict's terminal-spot path is still TBD.
4. **Minute 15**: Expiry. Block Scholes' next price tick freezes
   `OracleSVI.settlement_price`. Suppose the post-expiry tick lands
   *below* `B`. Predict's up-leg loses; Predict's down-leg wins.
5. **Reconciliation**: anyone calls `wick::predict_route::reconcile`. The
   hub's up-leg Predict position pays *zero* DUSDC. The hub now owes
   the Wick TOUCH winner a payout it cannot fund from Predict.
6. The spec admits this in §7 as "Oracle never settles" but the same
   shortfall arises whenever Wick's path-touch outcome and Predict's
   terminal-spot outcome diverge — which is *the entire reason Wick
   exists* (touch ≠ terminal). Attacker's Wick TOUCH is paid from the
   hub's seeded reserve. Attacker's attacker-owned Predict short pays
   off independently.

### Economic impact

Per touch-then-retrace event the hub eats up to
`stake × payout_multiplier` DUSDC from its reserve, while the attacker
collects *both* the Wick payout and the contrarian Predict payout. The
"hub seeded reserve" cap is per-market (§7: "Limit: cap per-market hub
exposure to that reserve"), so a single window can drain the reserve.
Attacker opens new windows, repeats. Reserve is exhausted in O(reserve /
max_window_payout) windows.

### Existing controls assessment

§7 ("Oracle never settles") describes one half of this: hub funded by
seeded reserve. But the spec frames it as a *Block Scholes outage*,
implying it's a tail event. **The wick-then-retrace divergence is the
common case for the product.** Path-dependent options exist precisely
because terminal settlement diverges from path-touch. The whole product
implicitly pays out divergence; the spec just doesn't budget for that
divergence on the protocol side.

§6 ("Hot path") explicitly says "Wick will not early-exit Predict — it
always waits for `OracleSVI.is_settled()` and uses `redeem_permissionless`."
This locks in the divergence. The spec hand-waves: "the hub's payout
multiplier is set so the protocol's expected vig covers the spread between
Predict's settled payout (which depends on which leg Wick minted) and
Wick's promised multiplier." There is **no number** in the spec for what
that vig must be, no model of the touch-vs-terminal expected divergence,
and no on-chain enforcement that the multiplier is actually conservative
enough.

### Mitigation

- **Easy:** Ship the §6 stretch goal day one — `predict_route::early_unwind`
  that opens the bid-side equivalent in Predict the moment a Wick touch
  fires. This locks in Predict's *current* probability of touch-given-
  current-spot, which is much closer to the realized payout than the
  terminal price will be. Yes, it's harder to implement than waiting; do
  it anyway. The current "wait and pray" model is structurally short
  vol via Predict, which is a side bet the protocol didn't intend to make.
- **Easy:** Cap `payout_multiplier_bps` so that even the worst-case
  touch-then-retrace pays out from `min(predict_terminal_payout,
  promised_payout)` rather than the promised value, and surface this as
  a "max payout if Predict diverges" UI footnote.
- **Hard:** Build a model of touch-given-spot inside Predict's SVI vol
  surface and price the Wick premium dynamically off it. This is the
  honest fix and probably out of MVP.

---

## 3. Touch-Before-Predict-Expiry Drain (User Cashes Out, Hub Sits Locked)

**Severity: High (stuck funds + amplified custody exposure)**

### Setup

A direct corollary of attack #2's mechanics, but viewed from the
liquidity-management angle. Wick's TOUCH user redemption flow is gated
on `clock >= expiry_ms` (§6: "Wick `Market` invariant only allows redeem
after `clock >= expiry_ms`"). Predict's `redeem_permissionless` requires
`OracleSVI.is_settled()`, which doesn't fire until Block Scholes' first
post-expiry price update.

Between `expiry_ms` and the post-expiry Block Scholes tick (call it
`expiry_ms + Δ`), Wick **owes** the user but Predict has not paid. The
spec asserts `Δ` is small ("the post-expiry update_prices call"), but
`Δ` is unbounded in practice — it's "next time the keeper runs."

### Exploit

Attacker opens M Wick TOUCH positions across many concurrent windows.
At least one expires per minute. Attacker watches Block Scholes' keeper
cadence (publicly observable). When the keeper is sluggish, attacker
calls `wick::predict_route::redeem` on every expired position. Wick pays
out from the hub's `settled_payouts` table — but reconciliation hasn't
run yet, so the table reads from the seeded reserve fallback (§7: "the
hub then owes more than it has banked from Predict; covered by the
hub's seeded protocol DUSDC reserve").

Attacker drains the reserve. Subsequent legitimate users with winning
positions cannot redeem until reconciliation finally completes —
indefinite stuck-funds for honest users.

### Economic impact

Bounded by the seeded reserve plus the cumulative attacker stake. With
the §7 mitigation "cap per-market hub exposure to that reserve," each
market is capped — but the attacker can *open many markets in parallel*,
and the cap is per-market, not per-attacker. So the per-attacker cap is
`num_markets × per_market_cap`, which scales with adoption.

### Existing controls assessment

The spec mentions the freshness fallback in one sentence and never
distinguishes "Block Scholes died" from "Block Scholes is just slow."
There is no rate limit on `redeem`, no cooldown between Wick-side
redeem and Predict-side reconcile. The freshness fallback (`wick::wick_oracle`'s
`settlement_freshness_ms`, default presumably small) actually *enables*
this attack — it tells Wick to settle off the last live observation,
even though Predict will eventually settle off the post-expiry tick,
which can differ.

### Mitigation

- **Easy:** Block Wick `redeem` until `predict_route::reconcile` has
  successfully drained the corresponding Predict position. Concretely,
  gate `redeem` on `hub.settled_payouts[key] > 0` *and* track a
  `reconciled_at_ms` per key; refuse redeem until both are set. Yes, this
  delays user payouts when Block Scholes is slow — but the alternative
  is the attack above.
- **Medium:** Pre-fund the hub reserve out of protocol equity so the
  attacker drains protocol equity rather than other users' future
  payouts. Slows the attack; doesn't stop it.
- **Hard:** Ship `early_unwind` (see attack #2 mitigation), which closes
  the gap by replacing the hub's directional exposure with a hedged
  position the moment touch fires.

---

## 4. Single-Manager Cross-Contamination (Cap-Eats-Cap)

**Severity: High (denial of service across all BTC users)**

### Setup

The hub has exactly one `PredictManager` per quote (§3.1). All BTC
traffic flows through it. Predict's `assert_total_exposure(max_total_exposure_pct)`
(§1.2 step 11) is a *protocol-global* exposure cap — when reached,
`predict::mint` reverts with what the spec elsewhere calls "exposure-cap
exceeded."

But there is *also* a per-manager position book (`manager.positions`),
and `oracle.move`'s exposure is computed from both the protocol vault
and per-oracle/per-manager state. A single fat position from one Wick
user inflates the hub manager's per-key exposure for *that key*, and
contributes to the protocol total cap.

### Exploit

Attacker opens one whale-sized Wick position on a high-strike, low-prob
BTC market (low ask price → can buy lots of contracts cheap). The hub's
`mint` succeeds, putting a giant `(MarketKey, qty)` row in the manager.

Other Wick users now try to open positions on *different* BTC markets.
Their `mint` calls share the same `manager` — Predict's per-position
checks aren't the problem, but Predict's `assert_total_exposure` and
the per-oracle risk MTM (§1.2 step 7) are now elevated by the attacker's
fat row. Other users' opens revert with `EAskPriceOutOfBounds` (the post-
trade ask drifts above the configured ceiling because the manager is
overweight one direction) or hit the global exposure cap.

This is not theoretical — Predict's "post-trade ask must sit in
`[min_ask_price, max_ask_price]`" (§1.2 step 8) is exactly the kind of
quote-band check that one big position in one direction can blow out.

### Economic impact

DOS: legitimate Wick users cannot open BTC positions while attacker's
fat Predict position is live. Lasts until expiry of attacker's market
(15 min in MVP cadence) or until attacker voluntarily redeems — and
attacker has no incentive to redeem early.

The attacker's cost is the premium they paid (small, since they bought
low-prob OTM). For a few dollars they can grief the entire Wick BTC
route for 15 min. Repeat across windows for indefinite DOS.

### Existing controls assessment

Not addressed in the spec. The single-manager design is presented as a
custody simplification (§3.1 "one shared `WickPredictHub<DUSDC>` per
quote asset"); the cross-user contamination of Predict-side risk is not
even mentioned.

### Mitigation

- **Easy:** Per-Wick-user accounting cap. Limit each Wick address's
  contribution to `manager.positions[key]` such that no single user can
  push the manager into the quote-band ceiling. Enforce in
  `wick::predict_route::open_touch` before calling `predict::mint`.
- **Medium:** Multiple hub managers, sharded by market or by user-bucket,
  so one fat position's blast radius is one shard, not the whole route.
  Costs a bit of operational complexity (more EOAs to multisig, more
  managers to seed) but is a pure win for liveness.
- **Hard:** Option B (per-user managers) — the cross-contamination
  vanishes by construction. (Yet another reason to prefer Option B.)

---

## 5. Predict Pause As DOS On Wick Open Positions

**Severity: High (stuck funds for the duration of the pause)**

### Setup

§7 says `trading_paused = true` aborts all `mint` calls but not `redeem`.
The spec presents this as a benign condition: "Wick reads
`predict::trading_paused(&predict)` before quoting in the UI and grays
out BTC."

That covers *new* opens. But what about open Wick TOUCH positions whose
expiry hits during a pause?

### Exploit

The attacker doesn't need to *cause* the pause — Mysten/Aslan operates
Predict, and pauses can happen for any operational reason (oracle issue,
risk event, planned maintenance). When the pause is announced:

1. Wick has open BTC positions in the hub manager.
2. Hub-side Wick `redeem` works (just reads `hub.settled_payouts`).
3. But `predict_route::reconcile` calls `predict::redeem_permissionless`,
   which **does not check the pause flag** per §7 — *if* that's actually
   true.

I dispute the spec's claim. Reading `predict-testnet-4-16` carefully,
the pause flag is checked in `mint` (§1.2 step 2) but the spec author
asserts without showing the source that `redeem` doesn't check it. The
spec needs a citation here. If `redeem_internal` *also* checks the pause
flag (which is a defensible design choice — pause-everything is the
common semantic), then **all open Wick positions are stuck for the
duration of the pause**. Even if the spec is right that redeem is
unaffected: many Predict deployments add a pause-everything override in
emergency upgrades, and Wick has no on-chain proof that the bypass is
permanent.

Beyond redeem: `oracle::settlement_price` requires a post-expiry
`update_prices` call (§1.4). If the pause is administered by the same
admin path that gates `update_prices`, settlement also hangs. Now Wick's
`settlement_freshness_ms` fallback kicks in and Wick settles off the
last live observation — which means the hub owes payouts it has not
banked from Predict and falls back on the seeded reserve (attack #3
amplifier).

### Economic impact

For the duration of the pause: every open BTC position is stuck. If the
pause coincides with a price spike and Wick's freshness fallback fires,
Wick eats the difference between its promised payout and the (eventual)
Predict redeem.

### Existing controls assessment

§7 reads the pause risk in three sentences: "Wick reads
`predict::trading_paused(&predict)` before quoting in the UI and grays
out BTC." This addresses the new-open case only. Does **not** address:
- pause-during-window for in-flight positions
- pause-during-settlement freshness fallback amplification
- coordination with Predict's social channel (Wick has no Predict-pause
  alerting)

### Mitigation

- **Easy:** Document the actual redeem-during-pause behavior by reading
  `predict.move`. If redeem is paused too, ship a pause-aware redeem
  guard in `wick::predict_route::redeem`: refuse to pay out until either
  Predict unpauses *or* a configurable timeout elapses, after which the
  protocol absorbs (with explicit on-chain event so users see it).
- **Medium:** Subscribe to Predict's `PauseToggled` events in the keeper
  and freeze Wick's UI at the keeper layer with a banner. Keeper-side
  freshness fallback should require an admin override during a known
  Predict pause to avoid auto-paying from the reserve.
- **Hard:** Negotiate with Aslan/Mysten for a pause-with-grace-window
  semantic where in-flight positions can still settle. Out of MVP scope.

---

## 6. Two-Keeper Desync (Spot-Settlement Mismatch)

**Severity: High (loss of funds via predictable mispricing)**

### Setup

§5 enumerates two independent keepers:
- **Block Scholes** pushes `OracleSVI` spot ~1s and SVI params ~10–20s.
  Settles via post-expiry `update_prices`.
- **Wick keeper** polls `OracleSVI.spot` ~1s and pushes into the Wick
  mirror oracle via `pull_oracle_driver::push_price`, then calls
  `path_observation::record`.

These are different machines. The spec assumes they're "close enough"
but provides no hard bound on `(wick_mirror.spot_ts - predict_oracle.spot_ts)`.

### Exploit

A motivated attacker measures the desync window empirically. Suppose
Wick's keeper lags Predict by ~2s on average (or vice versa). The
attacker:

1. Watches Predict's spot. When a price spike to barrier `B` is about to
   be pushed, the attacker submits a `wick::path_observation::record`
   call against the *current* Wick mirror — which is *stale*, still
   showing pre-spike. `record` is a no-op (price hasn't crossed barrier
   in the mirror's view).
2. Two seconds later Wick's keeper pushes the spike into the mirror and
   re-records — now barrier is touched.
3. Conversely, an attacker can race to be the recorder of a tick that
   *just* missed the barrier on Wick's mirror but *did* touch on
   Predict's side, because the upstream noise is non-deterministic
   between the two keepers' polling instants. Ticks are samples of the
   underlying, not the underlying — sampling at different times yields
   different numbers.

When the divergence is in the attacker's favor, they get the Wick payout
based on Wick's mirror saying "touch" while Predict's side says "not
touched at terminal." Hub funds the difference from reserve.

### Economic impact

Same as attack #2 — per divergent window the hub eats one payout. Cost
per attack is the Wick premium; gain per successful attack is the Wick
gross payout minus the loss on the Predict side (zero, since the Predict
position is wholly hub-owned). Asymmetric expected value when the
attacker can predict the desync direction.

### Existing controls assessment

§5 hand-waves: "Wick keeper for the BTC route is responsible for…
observation forwarding." There is no requirement that the mirror's
`spot_ts` matches Predict's `spot_ts` to within X ms. There is no
on-chain check that says "if mirror is more than N seconds behind
Predict's last spot, refuse to record." The whole architecture is
"poll Predict, mirror it, hope the lag is small."

### Mitigation

- **Easy:** Read `OracleSVI.spot_ts` directly inside
  `pull_oracle_driver::push_price` and reject pushes whose `ts`
  differs from `OracleSVI.spot_ts` by more than `max_mirror_lag_ms`
  (e.g. 1500 ms). This forces the mirror to match Predict's actual
  observation timeline, not the keeper's wall clock.
- **Easy:** Drive `path_observation::record` directly off `OracleSVI`
  reads, not off the Wick mirror, for the BTC route. The spec justifies
  the mirror as "keeps WickOracle driver-agnostic" — but for the route
  whose product definition depends on Predict's view of touch, the
  mirror is a foot-gun. Bite the architectural cost.
- **Medium:** Add a settlement-time consistency check: at lock time,
  assert that the mirror's last `spot` matches Predict's `OracleSVI.spot`
  to within an explicit tolerance (`abs(mirror - predict) / predict <
  10 bps`). Fail loudly otherwise — abort the path so neither side
  wins, refund both sides per §5 of `05_path_observation_v2.md`.
- **Hard:** Run a single keeper for both Wick and Predict. Out of scope
  (Wick doesn't operate Predict's keeper).

---

## 7. `predict::mint` Half-State Visibility (Race-Window Front-Run)

**Severity: Medium (loss of funds, requires precise timing)**

### Setup

Inside `wick::predict_route::open_touch` per §8 pseudocode:

```move
predict_manager::deposit<Quote>(manager, premium, ctx);   // step 1
predict::mint<Quote>(predict, manager, oracle, key, qty, clock, ctx);  // step 2
```

Sui's PTB model is a single transaction — abort in step 2 reverts step 1
atomically. The spec relies on this atomicity (§7 "Because the call is
one PTB, an abort reverts the whole transaction"). True for the user's
own PTB.

But within the *same Sui checkpoint*, multiple PTBs can be sequenced by
the validator. After user A's PTB lands step 1 in the manager (deposit
visible in `BalanceManager.balance`), user B's PTB executes against the
post-step-1 state of the shared manager.

### Exploit

The hub manager is a shared object. Sui sequences shared-object access.
While user A's PTB is mid-flight (deposit done, mint not yet), the
manager carries A's premium — but A has not yet been credited a
position. If between checkpoints another transaction can read the
manager's balance and submit a `predict::mint` for *itself*, that
attacker's mint draws DUSDC from the BalanceManager that A just
deposited — and the BalanceManager has no per-user accounting.

Wait — the relayer's signature is required for any `mint` against the
hub manager (the owner check). So an arbitrary attacker can't run
`mint` with their own sender. But they *can* coerce another user to do
it on their behalf, indirectly:

1. Attacker opens their own Wick PTB calling `open_touch`.
2. The Wick relayer co-signs (relayer signs all Wick BTC opens).
3. Attacker's `open_touch` deposits attacker's premium *and* mints
   attacker's position.
4. If attacker's PTB is sequenced *after* user A's deposit but before
   user A's mint (which can happen if Sui checkpoints fragment a PTB
   across instructions — they don't normally, but verify), attacker's
   mint sees a manager with A's premium plus their own and can mint
   a larger qty than their own deposit funds.

The Move `Transaction` model says PTB instructions are atomic per
PTB but shared-object reads see post-checkpoint state — so this
specific race is unlikely *if* PTBs really are atomic over the manager
borrow. **The spec needs to verify this and write down "PTB atomicity is
the security property we depend on."** Without it, the hub design is
gambling on Sui sequencing semantics that can change between releases.

### Economic impact

If the race is exploitable: attacker's mint qty exceeds what their
premium funded; hub manager goes to zero balance with too many
positions; on settlement, payouts exceed receipts; hub eats the diff.

Impact bounded by attacker's ability to time the race (low — Sui mempool
visibility is limited) and by the size of in-flight deposits at any
moment.

### Existing controls assessment

Nothing in the spec defends this surface. §7 only addresses the
single-PTB abort case. The cross-PTB sequencing case is not analyzed.

### Mitigation

- **Easy:** Make `predict_route::open_touch` *not* deposit the premium
  separately. Use `predict::mint`'s ability to consume a `Coin<Quote>`
  payment directly… except `mint` reads from `BalanceManager`, not from
  a passed-in coin. So the mitigation is: deposit only the *exact* amount
  needed (`ask × qty`), not a buffer, and assert the BalanceManager's
  balance equals the deposit before calling mint. If sequencing has
  inserted state, the assertion catches it.
- **Easy:** Compute `cost = ask × qty` off-chain, deposit *exactly*
  `cost`, mint, and assert post-state balance == 0. Deviation aborts.
- **Medium:** Audit Sui's documented PTB atomicity guarantees (the
  Move VM does run a PTB as one transaction; shared-object reads inside
  a PTB are consistent). Document in the spec which property you depend
  on, with a citation.

---

## 8. `redeem_permissionless` Gas Griefing

**Severity: Medium (DOS / griefing; bounded protocol cost)**

### Setup

§4 ("Settlement reconciliation") says anyone can call
`predict::redeem_permissionless` to drain the hub manager after Predict
settles. §1.3 confirms it is permissionless. The spec's idempotency
guard:

```move
if (predict_manager::position(&hub.manager, key) > 0) {
    predict::redeem_permissionless<DUSDC>(predict, &mut hub.manager, oracle, key, qty, clock, ctx);
}
```

Wick wraps it. But the *Predict* function is also reachable directly,
without going through Wick's wrapper.

### Exploit

Attacker watches the chain for newly-settled `OracleSVI` events. The
moment one fires, attacker submits a flood of `predict::redeem_permissionless`
calls against the hub manager for every `(key, qty)` they can construct:

- Most calls revert (`EInsufficientPosition` after the first drains).
- Each revert costs the attacker gas — but Sui charges the *caller*, not
  the protocol.

So this is bounded: attacker burns their own gas. The griefing is on
the *call surface* — it adds noise to the event stream that Wick's
keeper subscribes to, makes the indexer harder to operate, and could
front-run Wick's keeper-orchestrated reconcile (which has its own
guard, so functionally a no-op but operationally noisy).

The variant with bite: attacker calls the *Wick wrapper* `reconcile`
with a malformed `MarketKey` that decodes to a `key` not held by any
hub user. Wick's guard checks `predict_manager::position > 0` so it
does nothing — but the call still costs gas to *the caller*, which is
fine. **However**, if Wick's `reconcile` is supposed to *also*
update hub-side `settled_payouts[key]`, and that update is not guarded
on the wrapper-side, the attacker can pollute the hub's `settled_payouts`
table with bogus keys. Each bogus key is a storage row Wick is now
paying rent on permanently.

### Economic impact

Per bogus key: ~1KB storage rent. Forever. Attacker can spam thousands
per Sui tx. Cost to attacker: gas. Cost to Wick: indefinite storage
rent that compounds every settlement window.

### Existing controls assessment

§4's guard checks only the position; it does not check that the key is
*known to Wick* (i.e. that there is at least one outstanding
`WickPredictPosition` referencing that key). The spec author may have
intended `reconcile` to be implicitly safe because of the position check,
but a malicious caller can construct any `MarketKey` they like; the only
gate is "did the manager hold a position for this key" — which Wick
controls — but the *side effects* of `reconcile` on Wick's tables are
unguarded.

### Mitigation

- **Easy:** Gate `reconcile` on `table::contains(&hub.open_qty, key)`.
  No Wick-tracked position → revert. Storage stays bounded by Wick's
  own tracking.
- **Easy:** Make the reconcile call permissioned (only Wick keeper).
  Loses the "anyone can crank" benefit but eliminates the surface.
- **Medium:** Charge a small refundable bond per `reconcile` call,
  refunded if the call resulted in non-zero settled payout.

---

## 9. DUSDC Token-Type Confusion (Phishing + UI Compromise)

**Severity: Medium (user-facing loss, not protocol)**

### Setup

Predict uses **DUSDC** — a testnet-mintable mock token (§1.2 step 4
"`DUSDC` is the only enabled inflow"). Real users see "USDC" in their
wallet, "DUSDC" in some dialogs, and may not know the difference. The
verification commands (§9) literally call `dusdc::mint_for_testing` — a
public mint function with no rate limit.

### Exploit

Two flavors:

1. **UI phishing.** A clone of Wick's frontend prompts the user to
   "approve USDC" but routes the type-arg to a *different* package's
   "USDC" token (or to mainnet USDC on a fork of the Wick UI). Sui
   wallet adapters display the type tag, but most users skim. User
   approves → attacker drains.

2. **Type-tag substitution in PTB construction.** If Wick's frontend
   constructs the PTB and passes the DUSDC type tag as a string from
   off-chain config, an attacker who compromises the frontend (e.g. via
   an npm dep supply-chain) can substitute a malicious coin type. The
   PTB still type-checks because the same generic `predict::mint<Quote>`
   accepts any `Quote` on the whitelist — and the whitelist is
   on-chain config that *can be updated by Predict admin*. If Predict
   ever whitelists a second quote type, type confusion becomes possible.

### Economic impact

User-side: total premium per duped user. Protocol-side: reputational and
support cost. Bounded by individual user balances; not systemic.

### Existing controls assessment

Not addressed in the spec. The verification commands just `mint_for_testing`
without warning the integrator that this is testnet-only and should not
ship to production UIs.

### Mitigation

- **Easy:** Hardcode the DUSDC type tag in the Wick Move package itself
  (`const DUSDC_TYPE: vector<u8>` or `phantom DUSDC` constraint on the
  hub) so the type is not user-chosen. The hub already has `<phantom Quote>`
  — instantiate it once at deployment for `<DUSDC>` and never accept
  user-supplied type tags.
- **Easy:** Frontend should display the full type tag in the
  trade-confirmation modal, with "this is testnet DUSDC, not real USDC"
  explicit copy.
- **Medium:** Add a `wick::predict_route::is_dusdc<T>(): bool` view that
  the Wick UI calls before presenting the trade — and refuse to render
  trades where the type doesn't match the canonical address.

---

## 10. Settlement Reconciliation Race (First-Come Drains The Reserve)

**Severity: Medium (loss to late redeemers; concentrates DOS to slowest users)**

### Setup

§4 step 4: "Each user calls `wick::predict_route::redeem(WickPredictPosition,
&mut hub, &PathObservation, ctx)`. Wick burns the position object and
pays the holder `payout_for_winning_side(stake, payout_multiplier_bps)`
from `hub.settled_payouts`."

The spec models payout as a per-position fixed amount drawn from a
shared `settled_payouts[key]` bucket. If multiple users win the same
key and the bucket is undersized, the first user to redeem gets full
payout; later users get zero.

When does the bucket get undersized? Whenever `predict::redeem_permissionless`
returned less than the sum of Wick's promised payouts on that key —
which is exactly the touch-vs-terminal divergence case (attacks #2, #3).

### Exploit

Attacker monitors path-touched markets. The moment Predict settles in a
direction that *doesn't* fund the full Wick payout, attacker is
first-in-line to call `redeem` (they wrote a bot for it). Attacker's
position pays in full from `settled_payouts + reserve`. Slow users get
nothing once the reserve is dry, even though they hold legitimate
winning positions.

This is FCFS by transaction ordering — no fairness guarantee. Sui has
no built-in pro-rata mechanism without explicit coding.

### Economic impact

The aggregate loss is bounded by the touch-vs-terminal shortfall (which
is also attack #2's impact). What changes here is **who eats the loss**:
not the attacker, but the slowest legitimate user. This is a fairness
failure even when the protocol is solvent in expectation.

### Existing controls assessment

The spec describes redemption as straightforward FIFO. There is no
pro-rata logic, no "wait for all redemptions before paying," no
sorting. Pro-rata distribution is a known good design for partial
shortfalls; the spec ignores it.

### Mitigation

- **Easy:** When `settled_payouts[key] < expected_total_payout(key)`,
  switch into pro-rata mode: each user gets `their_payout × (settled_payouts /
  expected_total)` and the difference is enqueued (per the Martingaler
  vault model in design doc 01) or absorbed by the reserve. Explicit on-chain
  flag: `mode: u8 = FULL | PRO_RATA | ABORTED`.
- **Easy:** Lock all redeems on a key until `reconcile` completes for
  that key, then atomically compute the pro-rata factor. Gas cost: one
  extra read per redeem.
- **Hard:** Implement a queue per Martingaler doc 01. Out of MVP scope
  but the right long-term answer.

---

## 11. Predict Upgrade Mid-Flight (`predict-testnet-4-16` Is Already Old)

**Severity: High (stuck funds; entire BTC route bricked)**

### Setup

§0 cites the branch: `predict-testnet-4-16`. The spec acknowledges in §7
"Predict upgrades" that Mysten can ship an ABI-incompatible upgrade and
Wick would need to re-upgrade within 24h. The `main` branch is a
different beast (per the spec's mention of `MarketOracle`/Pyth Lazer
being "post-MVP on `main`").

The implication the spec under-states: **the Predict deployment Wick
integrates with today is on a non-main branch, which means it is
explicitly understood to be a moving target.** When `main` ships, the
testnet deployment will likely be replaced with one running `main`'s
ABI. Wick's hub holds positions in the old deployment; the new
deployment is at a different shared object ID.

### Exploit

Not adversarial — environmental. But: an attacker who *knows* an upgrade
is imminent (Mysten announces it) opens many large Wick positions in
the days before the upgrade, expecting:

1. Predict settles per old ABI before the upgrade.
2. The upgrade replaces the package; Wick's `redeem`/`reconcile` paths
   still resolve to the old deployment's ABI, which may now revert
   because the on-chain object is the same shared `Predict` but with
   new package code; the position table format may differ; the call
   itself may abort with `EWrongVersion` or similar.

Result: in-flight Wick positions are stuck in the old deployment with no
way to drain. Wick must either:
- Hard-fork the hub to point at the new deployment (losing all open
  positions in the old).
- Wait for emergency Mysten intervention (no SLA).

If the attacker chose positions where Wick's seeded reserve covers the
payout, the attacker collects from Wick reserve while the underlying
Predict position is bricked. Reserve drained, hub now insolvent for the
remaining users.

### Economic impact

Catastrophic on a single upgrade cycle if Wick has not pre-staged a
migration playbook. Bounded by hub reserve + open premiums.

### Existing controls assessment

§7 promises "we commit to upgrading within 24h of any breaking Predict
change." This is an operational promise with no on-chain enforcement.
There is no:

- Pause-on-upgrade-detected mechanism.
- Pre-pinned package version that the Wick Move package validates against
  on every call.
- Migration manifest that defines how to drain old positions before
  cutting over.

### Mitigation

- **Easy:** Pin the Predict package ID inside the hub at bootstrap and
  refuse all calls (including `redeem`) if the on-chain `Predict` shared
  object's `version` field doesn't match. Forces an explicit Wick
  upgrade rather than silent drift. Costs a few cents of gas per call.
- **Easy:** Subscribe to Predict's `PackageUpgraded` event in the keeper
  and freeze the Wick UI for BTC the moment one fires. Trigger an
  emergency drain of all hub balance to cold storage so the upgrade
  doesn't lock funds.
- **Medium:** Pre-write a migration script (`scripts/predict-migrate.sh`)
  that reads all open positions, calls `redeem` on the old deployment
  (if still callable), forwards funds, and re-mints on the new. Test
  it on a `predict-testnet-4-16` → `main` simulated upgrade before any
  user funds touch the system.
- **Hard:** Negotiate an upgrade-coordination channel with Mysten/Aslan
  so Wick gets advance notice. Outside engineering control.

---

## 12. "Bribery of the Manager-Owner Admin" (Insider Threat)

**Severity: Critical (loss of funds; same blast radius as attack #1)**

### Setup

The attacker can't *technically* compromise the relayer key, but they
can offer the deployer cash to sign one transaction. This is attack #1's
twin — same target, different vector.

### Exploit

Attacker pays the deployer X. Deployer signs a one-time `withdraw` from
the hub manager to attacker's address. Funds gone. Deployer claims "key
compromised." Forensics impossible to distinguish from a hack.

### Economic impact

Same as attack #1 — full hub balance.

### Existing controls assessment

§3.1 says "for MVP it is the deployer." Single-deployer custody is the
weakest possible control structure for any product holding others'
funds.

### Mitigation

- **Easy:** Multisig from day zero. M-of-N where N includes at least
  one party not employed by Wick. Sui native multisigs do this fine.
- **Medium:** On-chain timelocked withdrawals: any drain over a threshold
  must announce 24h in advance via on-chain event, and any other
  signer can veto. Adds operational friction; eliminates the
  single-signer-bribery vector.
- **Hard:** Move ownership to a DAO-governed cap. Out of MVP.

---

## Summary Table

| # | Attack | Severity | Mitigation difficulty |
|---|---|---|---|
| 1 | Custody Capture (relayer key compromise) | Critical | Easy (Option B) / Easy (multisig) |
| 2 | Settlement-Order Arbitrage (touch-then-retrace) | High | Easy (early_unwind) / Hard (proper pricing) |
| 3 | Touch-Before-Predict-Expiry Drain | High | Easy (gate redeem on reconcile) |
| 4 | Single-Manager Cross-Contamination | High | Easy (per-user cap) / Medium (sharded managers) |
| 5 | Predict Pause As DOS | High | Easy (pause-aware redeem) |
| 6 | Two-Keeper Desync | High | Easy (lag check) / Easy (read OracleSVI direct) |
| 7 | `predict::mint` Half-State Race | Medium | Easy (exact-deposit assert) |
| 8 | `redeem_permissionless` Gas Griefing | Medium | Easy (key-known guard) |
| 9 | DUSDC Token-Type Confusion | Medium | Easy (hardcode type tag) |
| 10 | Settlement Reconciliation Race | Medium | Easy (pro-rata mode) |
| 11 | Predict Upgrade Mid-Flight | High | Easy (pin version) / Medium (migration script) |
| 12 | Manager-Owner Bribery | Critical | Easy (multisig) / Medium (timelock) |

---

## Top-Level Recommendations

1. **Ship Option B (per-user managers), not Option A.** Half of the
   findings above (1, 4, 12, parts of 2/3) collapse to "Wick custodies
   nothing." The user-experience cost is a one-time bootstrap; the
   security gain is the entire hot-key surface. The spec's own
   §3.2 admits Option B's interface is identical except for the type
   of two arguments. Take the design loss now; you save the incident
   report later.
2. **If Option A must ship, ship a multisig hub day zero.** No
   single-key MVP. Sui native multisig is free; the only cost is one
   extra signer. This kills attacks 1 and 12 and partially mitigates
   3, 5.
3. **Design the touch-vs-terminal pricing model honestly.** Attack 2
   is not a bug, it's the product. Either ship `early_unwind` (locks
   in Predict-side value at touch time) or write down explicitly how
   much reserve is required to cover the expected divergence per
   window, with a stress test against historical BTC vol.
4. **Pin the Predict package version on-chain and freeze on upgrade.**
   `predict-testnet-4-16` is moving. Don't get migrated under your feet.
5. **Replace Wick's mirror with direct `OracleSVI` reads for the BTC
   route.** The mirror's "driver-agnostic" benefit is real for SUI/SP500/
   random-walk, but for the route whose product semantics depend on
   Predict's view of touch, the mirror is an attacker surface. Keep
   the mirror for the other routes.

The spec is a credible *integration sketch*. It is not yet a *security
spec*. The gap between those two is the work this document forecasts.
