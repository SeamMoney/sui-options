# 07 — Red-Team: Wick × DeepBook v3 CLOB Integration

**Status:** adversarial review of `docs/design/07_deepbook_clob.md`
**Date:** 2026-05-12
**Reviewer hat:** black-hat / griefer / whale arb
**TL;DR:** The CLOB integration as specified is a **net loss-of-value generator** for Wick under realistic adversarial conditions. The keeper market-maker is the single largest exposure: an honest mispricing oracle facing a faster off-chain trader is a free-money pipe. Settled-coin trading, pre-expiry ramps, and Touch+NoTouch arb each independently produce non-trivial losses. DEEP token economics make pool creation a real DoS surface even at testnet scale. Several issues (settled-coin trades, double-listing, witness publish race) are **fundamental to the permissionless-pool model** and cannot be fully closed without a custodial layer or a "trade halt" oracle inside DeepBook (which Wick does not control). Recommend shipping CLOB as **opt-in advanced feature** with clear "expert mode" warnings, keeper inventory caps, and the OTC fallback as the **default trade path** for the demo.

Total distinct attacks: **14**. Severity legend: **Critical** = direct loss-of-funds at scale, **High** = consistent loss-of-value or reputational kill, **Medium** = griefing / partial loss, **Low** = nuisance.

---

## Attack 1 — Keeper Stale-Quote Sniping ("the killer")

**Severity:** Critical (this is where the real money goes)

**Setup**
The keeper publishes two-sided quotes at `fair_value ± 50 bps` (per §9.2). The `fair_value` is computed from `path_observation.touchProbability(market.id)` — itself derived from on-chain oracle ticks pushed at some cadence (Predict for BTC, custom feed for SUI/SP500). On-chain oracle latency is, optimistically, 200-500 ms. CEX prices update at <50 ms.

**Step-by-step**

1. Attacker subscribes to Binance/OKX/Coinbase BTC trade-stream and a Sui RPC websocket.
2. BTC ticks toward the touch barrier on CEX. Attacker's local `p_touch` model jumps from 0.30 → 0.45.
3. Wick keeper's on-chain `path_observation` has not yet ingested the move; it still publishes `bid=0.295, ask=0.305`.
4. Attacker submits `place_market_order(is_bid=true, qty=keeper_full_ask_size)` against the keeper's stale ask at 0.305, paying ~0.31 USDC per Touch coin worth ~0.45 USDC of expected payout. **40 bps to 1500 bps of mispricing captured per fill, depending on lag.**
5. After Wick's oracle catches up, keeper requotes at `bid=0.445, ask=0.455`. Attacker either dumps Touch back to keeper at the new bid (locking ~14 cents per coin) or holds to expiry if path actually crosses.

**Economic impact**
With 100 Touch tokens per side at 1 USDC payout, each round-trip snipe extracts $14 if the move is ~10% in p-space. Over a single demo session with 20 BTC ticks, an HFT can drain the entire keeper inventory. **At scale, the keeper P&L is negative-of-spread minus capture-of-edge — and the spec's 50 bps half-spread is far too tight for 200 ms+ oracle latency.**

**Existing controls (per §9.2)**
- "Throttle: re-quote at most every `min_requote_ms`" — actively *worsens* this attack by guaranteeing stale quotes for longer.
- "If the `path_observation` flips to HIT, immediately cancel everything" — only triggers on the discrete HIT event, not on probability drift.
- "Never quote `bid >= ask` (sanity)" — irrelevant.

**Mitigation**
- **Asymmetric spread tied to oracle freshness.** `half_spread = base + k * (now - last_oracle_tick_ms)`. Wide on stale, narrow only when fresh.
- **Aggressive cancel-on-staleness.** If `path_observation.last_update_ms` lags wall clock by > 1 second, cancel both sides outright. Better to be off-market than be picked off.
- **Per-tick size caps.** Quote sizes ≤ what you can afford to lose at one tick of mispricing. `max_size_per_quote = inventory_buffer / max_expected_jump`.
- **Dollar circuit breaker.** Hard daily loss cap; pause keeper at 2x expected daily P&L drawdown.
- **Realistic spread.** 50 bps half-spread (1% spread) is HFT-tight for an oracle product. **200-500 bps minimum.** Wider for thinly-traded markets.
- **Use the asymmetric-impact-fee design from `02_asymmetric_impact_fee.md` as inspiration:** tax orders that move price *toward* recent oracle drift. Hard to do as a CLOB taker via DeepBook hooks (DeepBook v3 has no per-trade hook), so this only works inside Wick's own AMM, not on the CLOB. **This is the structural reason CLOB is harder to defend than the in-protocol AMM.**

---

## Attack 2 — Pre-Settlement Information Ramp

**Severity:** Critical

**Setup**
1 minute before market expiry. Spot is $0.50 below the touch barrier. Volatility implies a non-trivial probability of crossing, but the keeper's model says ~10%. A whale who has just placed a $2M sell on CEX (or who has private order-flow info) knows the actual probability is closer to 70%.

**Step-by-step**

1. Attacker computes private `p_touch_actual = 0.70` from off-chain knowledge.
2. CLOB shows: keeper offering 100 Touch @ 0.10, 100 Touch @ 0.12, 50 Touch @ 0.15 from honest LPs.
3. Attacker market-buys the entire ask side, sweeping up to 0.30. Pays ~$25 for $250 of expected payout.
4. Attacker simultaneously executes their CEX sell. Spot drops, barrier crosses, oracle observes HIT.
5. Attacker `redeem_position` for `payout = $1.00 × 250 tokens = $250`. **Profit: $225 minus gas, in 60 seconds.**

**Economic impact**
The honest LPs and keeper just sold at $0.10-0.30 something worth $1.00. **They are the bagholders.** This is *informationally* unavoidable on any CLOB without a privileged trading halt — DeepBook does not natively support time-based circuit breakers, and Wick cannot inject one.

**Existing controls**
- None mentioned in §07 design.
- §10 "OTC fallback" implicitly avoids this because OTC orders are owner-cancellable and slower, but the spec doesn't recommend OTC in this scenario.

**Mitigation**
- **Pre-expiry trading halt at the keeper level.** `if (expiry_ms - now < CLOB_HALT_WINDOW_MS) { cancel_all_orders; do_not_requote; }`. Does not stop the attacker from buying from honest LPs, but stops the keeper from being the patsy. Suggested window: **5 minutes.**
- **UI warning in last 5 minutes.** Big red banner: "trading is now permissionless — keeper has withdrawn liquidity. Trade at your own informational risk."
- **Document this is a structural property of permissionless CLOBs on path-dependent products.** Serious binary-options venues use auction-style settlement windows specifically for this reason. We are not building one in MVP.
- **Make the OTC layer the default in the last 10 minutes** — OTC orders have explicit `expires_ms` (per §10.1), so even an honest LP can post a quote that auto-cancels before the danger zone.

---

## Attack 3 — Settled-Coin Trading (zombie tickets)

**Severity:** High

**Setup**
Market settles at T (e.g. EXPIRED → no_touch wins). The `Coin<Position<M, Touch>>` is now worthless — `redeem_position` on a Touch coin pays zero. **But the CLOB pool still exists. The coin type still exists. Orders placed pre-settlement still exist.** A buyer who looks at the order book sees "Touch @ 0.42, size 100" and clicks "buy."

**Step-by-step**

1. Market M expires at 12:00. Path observation shows no-touch wins. `lock_settlement` and `settle_market_no_touch` execute at 12:00:30.
2. The CLOB `Pool<Position<M, Touch>, DBUSDC>` has resting orders from before settlement: bids and asks at 0.30-0.50 placed by the keeper an hour earlier, never cancelled before the keeper crashed at 11:55.
3. New user, never having heard of this market, opens the Sui Wallet token list. Sees `Position<M, Touch>` pricing at 0.30 on a CLOB. Buys 100 for $30 USDC.
4. They redeem. They get $0. They lost $30.

**Economic impact**
Per-victim: full coin price (up to $1 × position units). Multi-victim: depends on resting order depth at settlement. **Reputation cost: probably terminal.** "I traded on the CLOB and the protocol let me buy worthless tokens" is the kind of thing that ends hackathon traction.

**Existing controls**
- The keeper's "If the `path_observation` flips to HIT, immediately cancel everything" handles HIT only — not EXPIRED, not LOCKED.
- Nothing in DeepBook v3 closes a pool on coin-type deprecation.

**Mitigation**
- **Keeper must `cancel_all_orders` on its BalanceManager at `lock_settlement` time.** Add to keeper rebalance loop: `if market.status != OPEN { cancel_all; do_not_requote; }`.
- **Burn the `Pool` is impossible** — DeepBook doesn't expose pool deletion.
- **Frontend filter:** Wick UI must hide pools for settled markets in the trade list. Use the `Market.status` field as the gate.
- **Education:** every CLOB pool URL should redirect to a "this market settled — touch coins are worthless" warning page after settlement.
- **Long-term:** consider designing a wrapper Coin that is `burn`-only post-settlement (impossible without DeepBook coordination — DeepBook holds the balance inside its `Vault`, not the user). This is a **fundamental limitation of permissionless CLOBs over expiring tokens.**

---

## Attack 4 — Touch + NoTouch Arbitrage Exceeding Payout

**Severity:** High

**Setup**
By construction, `payout_touch + payout_no_touch = payout` exactly (per the collateral invariant). Therefore on a fair CLOB: `price(Touch) + price(NoTouch) ≤ payout - fees` always. If at any moment the *sum of best asks* on Touch and NoTouch is < payout, an arbitrageur can buy both, redeem either side after settlement for full payout, and lock risk-free profit.

**Step-by-step**

1. Touch CLOB ask: 0.45 USDC. NoTouch CLOB ask: 0.40 USDC. Payout: 1.00 USDC. **Sum = 0.85 < 1.00.**
2. Attacker in single PTB: `market_buy(touch_pool, 100, ask_price=0.45)`, `market_buy(no_touch_pool, 100, ask_price=0.40)`. Cost: $85 + DeepBook fees.
3. Attacker waits for settlement. Either Touch or NoTouch wins. Attacker `redeem_position` for $100.
4. **Risk-free profit: $15 per 100 tokens minus fees.**

**Economic impact**
Per occurrence: arbitrage closes the gap, but the loss falls on whoever was offering the underpriced asks — typically the keeper. If the keeper independently quotes both pools without an inventory cross-check, **it can quote a sum < payout from rounding, skew, or stale state.** Attackers will scan continuously.

**Existing controls**
- §9.1 "Already enforced by the collateral invariant: `touch + no_touch = 1.0 * payout`" — refers to *fair value*, not *quoted prices* on the CLOB. The bound is not enforced at quote time.

**Mitigation**
- **Cross-pool quote check in the keeper.** Before placing a new ask on either pool, assert `keeper.touch_ask + keeper.no_touch_ask >= payout * (1 + min_arb_spread_bps/10_000)`.
- **Symmetric quoting.** Keeper should always quote `ask_no_touch = payout - bid_touch + spread`. Derive one from the other; don't compute independently.
- **The reverse arb (sum of bids > payout)** is also possible — attacker sells synthetic "complete set." Same fix: `bid_touch + bid_no_touch <= payout * (1 - min_arb_spread_bps/10_000)`.
- **Embrace it:** if the keeper's own touch bid and no-touch bid sum to < payout, the keeper can mint a "complete set" via Wick's primary market for `payout` cost and sell both sides on CLOB — that's a profitable inventory recycler. But it requires the keeper to have collateral + a primary mint path open.

---

## Attack 5 — Bootstrap Front-Run on Pool Creation

**Severity:** High (one-time-per-market, but kills demo-day trust)

**Setup**
Wick's bootstrap script (per §8.1) does: (1) publish per-market witness package, (2) call `bootstrap_pull_market_with_clob`, (3) `create_permissionless_pool` for Touch and NoTouch, each costing 500 DEEP. Steps (1) and (2) are separate transactions; only step (3) consumes DEEP.

After step (1) is mined, the new `Position<M, Touch>` Coin type is **public knowledge**. The witness package address is in the explorer. Anyone can call `create_permissionless_pool<Position<M, Touch>, DBUSDC>` themselves with their own DEEP, before Wick gets to it.

**Step-by-step**

1. Attacker mempool-watches Sui testnet (or polls every block) for newly published packages with names matching `wick_market_*`.
2. Attacker spots Wick's witness package publish.
3. Attacker submits a `create_permissionless_pool` PTB for `Position<M, Touch> / DBUSDC` with adversarial parameters: `tick_size=10_000_000` (way too coarse, prices snap to $0.01) or `lot_size=1_000_000` (way too large minimum).
4. Wick's subsequent `create_permissionless_pool` reverts with `EPoolAlreadyExists` (DeepBook tracks `(base_type, quote_type)` keys in the registry).
5. Wick's bootstrap script must either (a) accept the adversarial pool and quote on it (bad UX for users), (b) crash and require manual recovery (bad demo), or (c) deploy a *second* witness module with a different `M` (wastes DEEP on the dead one).

**Economic impact**
- 500 DEEP burned per attempted-then-blocked pool creation. With 1000 DEEP per market design budget, **two consecutive attacks brick a market.**
- Reputation: "the Wick demo was trolled by a $5 attacker."
- Even if Wick recovers, the attacker's pool stays in DeepBook forever as a confused-user trap.

**Existing controls**
- §10 lists "Pool creation requires admin permission we don't have | none — `create_permissionless_pool` is `public fun`" — correctly identified as low-risk for *availability*, but missed the front-run vector.

**Mitigation**
- **Single-PTB bootstrap.** Combine witness publish + Wick bootstrap + both pool creations into one programmable transaction. A package publish in PTB is supported in Sui v1.x; verify the move-call publishing API. If Sui's CLI publish flow doesn't compose with the rest, do steps (1)+(2) atomically and accept the (2)→(3) gap as a smaller window — keep witness type opaque until step (3) executes by *not* indexing the witness module in any public registry between steps.
- **Predictable, short publish-to-pool window.** Have the bootstrap script publish witness + immediately submit the pool-creation PTB in the very next transaction. Window of vulnerability: one block (~500 ms).
- **Witness type obfuscation.** Use a non-discoverable name (`witness_<random_hex>`) so casual mempool scanners miss it. Security through obscurity, but at hackathon stakes it raises the attack cost.
- **DeepBook upstream PR (post-MVP):** propose a `create_permissionless_pool_with_caller_authority` that takes a witness from the base coin's `TreasuryCap`, restricting pool creation to the coin issuer.

---

## Attack 6 — Multi-Pool Double-Listing for Liquidity Fragmentation

**Severity:** High

**Setup**
Even if Wick wins the bootstrap race, **anyone** can create a second `Pool<Position<M, Touch>, X>` for any `X` they choose: DBUSDC with different tick/lot, SUI, DEEP, or a malicious shitcoin. DeepBook keys pools on `(base, quote)` tuples — different quote = different pool, no collision.

**Step-by-step**

1. Wick's pool exists at `(Position<M, Touch>, DBUSDC)` with sane params.
2. Attacker creates `(Position<M, Touch>, MaliciousCoin)` pool with tick 1_000_000_000 (basically free).
3. Attacker buys cheap on the malicious-pool, sells expensive on Wick's pool, and uses the price discrepancy to confuse keeper quoting (if keeper ever indexes "all pools for this token") and steal LP value.
4. Worse: a clueless user lists their Touch coin via a wallet aggregator (Cetus, FlowX) that auto-routes to *any* pool. Aggregator routes through the bad pool. User sells $100 of Touch for $0.001 of MaliciousCoin.

**Economic impact**
- Per fragmented pool: 100% loss for any user routed through it.
- Brand: "a Wick token cost me $100 in a wallet trade." Recovery: zero.

**Existing controls**
- None. Permissionless creation is a feature, not a bug, of DeepBook.

**Mitigation**
- **UI canonicality.** Wick UI links *only* to the Wick-blessed pool IDs (stored on the `Market<C>` per §8.1.4). Never trust pool discovery via type matching.
- **Aggregator coordination.** Submit Wick pool IDs to FlowX, Cetus, 7k aggregators with `verified=true` flags. Aggregators that don't whitelist will route badly; document this risk.
- **Wallet warning.** A standard wallet shows "you have a `Position<M, Touch>` coin"; the wallet has no idea what it's worth or where to sell it. Wick UI must be the canonical surface.
- **DeepBook upstream:** suggest a `creator_address` field on pools and a "primary pool" registry per coin pair, so aggregators can pick canonically.

---

## Attack 7 — DEEP Inventory Exhaustion DoS

**Severity:** High (for production), Medium (for hackathon — lower volume)

**Setup**
Wick must hold at least 500 DEEP per pool, 1000 DEEP per market. At even modest scale (50 markets), that's 50k DEEP. The DEEP testnet supply is gated; attacker can spam-trigger pool creation on Wick by:

1. Calling Wick's `bootstrap_pull_market_with_clob` directly (if open to public — currently appears to be `KeeperCap`-gated, but check); OR
2. Posting fake "I want a market on X-Y at barrier Z" requests that Wick auto-bootstraps; OR
3. (Indirect) Creating *non-Wick* permissionless pools to deplete the global testnet DEEP supply available to Wick from the OTC market.

**Step-by-step**

1. (Path 1) If Wick exposes a permissionless market-creation endpoint for hackathon demo: attacker spams 100 markets at $5 of DEEP each = $500 to brick Wick's wallet.
2. (Path 3) Attacker pre-buys all DEEP off the testnet `DEEP/SUI` pool and refuses to sell. Wick cannot acquire 500 DEEP for the next bootstrap.

**Economic impact**
- DoS on new market creation. Wick demo bricked at the worst moment.
- Real money: 1000 DEEP at testnet "fair" price is uncertain but non-zero in real DEEP-equivalent acquisition cost.

**Existing controls**
- §2 design notes "There is no public DEEP faucet" and proposes "Beg, borrow, or swap." This is the entire mitigation: human-gated procurement.

**Mitigation**
- **Gate `bootstrap_pull_market_with_clob` strictly behind `KeeperCap`.** Confirm in code; never expose to public address.
- **Pre-purchase a DEEP war chest.** Before demo day, buy 5x the budget of DEEP. Treat as opex.
- **Reuse pools across barriers (post-MVP).** Insight: a Touch coin for `BTC barrier=$70k` and a Touch coin for `BTC barrier=$71k` could share a pool *if* the position semantics were re-encoded. Currently they can't (different `M` types per market = different pool). A Wick refactor where positions are NFT-indexed by barrier within a single Coin type would cut DEEP consumption to 2 pools per *underlying*, not per *barrier*. Major redesign.
- **Single-side pools.** Skip listing NoTouch separately; force NoTouch trades through OTC. Halves the DEEP burn at the cost of UX symmetry.

---

## Attack 8 — One-Sided Inventory Accumulation Toxicity

**Severity:** High

**Setup**
A market is heavily-traded one-sided (e.g. everyone wants Touch on a market that just rallied close to barrier). Keeper's bid is hit constantly on the Touch side; ask sits untouched on the NoTouch side. After 30 minutes:

- Keeper's BalanceManager holds: 1000 Touch coins + tiny NoTouch + low USDC.
- The market then settles HIT (predictable — that's why everyone bought Touch). Touch coins pay $1 each. **Keeper just sold its Touch inventory at $0.40 average and now has to deliver against winning Touch coins it bought back at $0.95.**

Wait — actually if keeper *bought* Touch at low prices and Touch wins, keeper makes money. The *toxic* direction is: keeper *sold* Touch (was the ask side), accumulated USDC, market settles HIT, and keeper has the obligation but no Touch tokens.

Re-frame correctly:
- Keeper's ask is hit constantly → keeper sold Touch coins it minted from collateral → keeper is now *short* Touch synthetically and *long* USDC.
- Market settles HIT → buyers redeem their Touch coins for $1 each from Wick's collateral vault. Keeper's USDC was already paid to the buyers at sale time. **Keeper lost: (payout - average_sale_price) × volume.**

**Step-by-step**

1. Keeper deposits 1000 Touch coins + 500 USDC into BalanceManager. Quotes ask=0.40, bid=0.35.
2. Market sentiment shifts toward Touch (CEX rallies). Buyers sweep keeper's ask 1000 times at average 0.42.
3. Keeper inventory: 0 Touch, 500 + 420 = 920 USDC.
4. Keeper requotes ask=0.55 (no inventory; pulls bid). But before requote lands, more buyers hit any remaining asks.
5. Market settles HIT. Each Touch coin = $1.00. Wick's collateral vault pays $1000 to the new Touch holders. Keeper holds $920 USDC. Net keeper loss = $80 (plus the keeper's original 1000 Touch coin mint cost, which itself came from somewhere).
6. **If keeper minted those 1000 Touch from Wick's collateral vault, the loss falls on Wick's treasury, not the keeper personally.**

**Economic impact**
This is the biggest sustained-loss vector. Per heavily-trending market: $50-$500 per market depending on inventory size and trend strength. Across many markets per day: potentially the difference between Wick being LP-positive or LP-negative.

**Existing controls**
- §9.2 mentions `SKEW_BPS = inventorySkewBps(market)` to "shift quote based on inventory" — this is the right shape but not parameterized.
- "If the keeper is touched, withdraw / re-deposit to manage one-sided inventory" — "touched" is HIT only, not progressive accumulation.

**Mitigation**
- **Mandatory inventory-skew.** As keeper's Touch inventory drops, ask price rises sharply. Concrete: `ask = fv * (1 + base_spread) * (1 + skew_k * (1 - inventory_ratio))`. With `skew_k = 0.10`, an empty inventory pushes ask 10% above fair — making further snipes uneconomic.
- **Hard inventory floor.** Keeper refuses to sell below `min_inventory = 0.20 * initial_inventory`. Cancel ask outright, only quote bid.
- **Hedge synthetically.** When keeper's Touch inventory drops below threshold, automatically `open_touch` against Wick's primary market to refill. This converts the inventory loss into a primary-market position which itself pays out at HIT — but only if the keeper has collateral. Cost: ties up keeper capital.
- **Limit per-market exposure.** `max_inventory_per_market = $500`. After that, keeper exits CLOB for that market entirely until expiry.
- **Hackathon honesty:** the keeper *will* lose money in trending markets. Budget for it. Document as known-loss in the demo script: "we expect the keeper to lose ~$X per market on average — this is the cost of providing liquidity."

---

## Attack 9 — Front-Running Keeper Re-Quotes

**Severity:** Medium

**Setup**
Keeper rebalance loop runs every `min_requote_ms`. The cancel-then-place sequence is two PTBs (or one PTB with two move-calls). Mempool observers see the cancel and place coming.

**Step-by-step**

1. Attacker websocket-watches Sui mempool for transactions touching keeper's BalanceManager ID.
2. Sees keeper submit `cancel_order(old_ask_at_0.31)` followed by `place_limit_order(new_ask_at_0.35)`.
3. Attacker submits, with higher gas, `place_limit_order(my_ask_at_0.349, qty=tiny)` between the two.
4. The next market-buy hits attacker's $0.349 ask first (price-time priority). Attacker captures the spread without inventory risk over time.
5. Repeat for the bid side: attacker plants $0.341 bids in front of keeper's $0.34 bids. Captures the bid-side flow.

**Economic impact**
Per requote: keeper loses $0.01-0.001 per filled coin to the front-runner. Over thousands of fills: meaningful.

**Existing controls**
- "Throttle: re-quote at most every `min_requote_ms`" — does not help; throttles down requote frequency, not exploitability of each requote.

**Mitigation**
- **Atomic cancel-replace.** DeepBook v3 has `modify_order` (verify in source) that updates an existing order in one move-call — no cancel-place gap. Use it.
- **Multi-tier quotes.** Place multiple orders at different prices simultaneously; the front-runner can only undercut the best, leaving keeper to capture flow at deeper levels.
- **Random jitter.** Requote at random intervals around `min_requote_ms ± 30%`. Defeats deterministic front-runners.
- **Use sponsored transactions / private RPC.** If Wick keeper pays for sponsored txs through a relay, mempool exposure is reduced. Out of scope for hackathon.
- **Accept the loss.** If keeper's spread is wide enough (per Attack 1 mitigation: 200+ bps), front-runners undercutting still leave the keeper positive on inventory turnover. This is the mature CEX market-maker view.

---

## Attack 10 — DBUSDC vs DUSDC Token Confusion

**Severity:** Medium (financial loss for individual users, not protocol-wide)

**Setup**
Per §5: Wick uses **DUSDC** (`0xe95040...::DUSDC`) for the BTC Predict route and primary market collateral. DeepBook CLOB uses **DBUSDC** (`0xf7152c...::DBUSDC`). These are **different coin types** that visually display the same in most wallets ("USDC" symbol).

**Step-by-step**

1. User opens Wick UI. UI says "deposit USDC to bet on BTC barrier."
2. User has DUSDC from earlier Wick activity. Deposits successfully.
3. User wins. Has Touch coins. Goes to "sell on CLOB."
4. CLOB takes DBUSDC, not DUSDC. UI prompts user to swap DUSDC→DBUSDC. User does so on a third-party DEX (since Wick doesn't bridge them).
5. Either: (a) user accidentally trades DUSDC for the wrong asset, losing it; (b) user goes to the wrong CLOB pool (some legacy `Position<M, Touch> / DUSDC` pool that someone else front-ran into existence) and trades there for nothing.

**Economic impact**
Per confused user: full coin balance, indeterminate amount. Cumulative: trust collapse.

**Existing controls**
- §5 documents the difference but not how to surface it to users.

**Mitigation**
- **Choose one stablecoin throughout.** Make the primary market accept DBUSDC too. Drop DUSDC from Wick entirely. Reduces UX friction to zero.
- **Or: swap router built into Wick UI.** When user clicks "sell on CLOB," a single PTB does `swap DUSDC→DBUSDC then place_limit_order on CLOB`. Hides the difference.
- **Renaming:** never call them both "USDC" in the UI. Display "Wick-USDC" vs "DeepBook-USDC" with a tooltip explaining.
- **Pool creation hygiene:** create the canonical Wick pool against DBUSDC explicitly; document everywhere that `Position / DUSDC` pools are *not* official.

---

## Attack 11 — Coin Merge / Decisiveness-Loss Exploit

**Severity:** Low to Medium (depends on per-position state)

**Setup**
`Position<M, Side>` is being refactored from `key, store` object with a `stake: u64` to `Coin<Position<M, Side>>`. Coins are *fungible within type* — `coin::join` merges them. **Anything tracked per-position is lost on merge.** If decisiveness/early-bird-bonus state is tracked per-position (per the gamification spec in `08_gamification.md`), merging strips it.

**Step-by-step**

1. User opens `Position<M, Touch>` early in market lifecycle, expecting an "early bird" decisiveness bonus (e.g. 1.05x payout).
2. User opens another Touch position later (no bonus).
3. Wick's UI prompts "consolidate?" or user manually merges via wallet. `coin::join`.
4. The two coins become one indistinguishable Coin balance. Decisiveness state attached to the early position is **gone** — it was on the original `Position` object, now destroyed.
5. User redeems: gets standard payout, no bonus. Loss = bonus delta × early stake.

**Economic impact**
Per affected position: ~5% of position value (the bonus). Across users who consolidate: nontrivial.

**Existing controls**
- The Coin'ification proposal in §3 doesn't address per-position state at all.

**Mitigation**
- **Don't track decisiveness per position; track per-(market, address) in a `Table` on the `Market<C>` object.** Bonus accrues based on first-deposit timestamp per address, not per coin.
- **Block merging via not exposing `merge` in Wick's PTBs.** Sui Coin is fungible by default, but Wick's UI need not encourage it.
- **Use NFT-style positions (key, store, not Coin) and accept that DeepBook listing is harder.** The Coin'ification is precisely the trade-off here. **Verify that the gamification design genuinely requires per-position state; if not, drop it and embrace fungibility.**

---

## Attack 12 — CLOB-Trade vs Redeem Race Condition

**Severity:** Medium

**Setup**
A buyer purchases Touch coins on CLOB at T=0. At T+1ms, market settles to HIT. At T+2ms, the seller (who no longer has the coins) cannot redeem — that's expected. But what about the buyer mid-flight? And what if the seller's PTB partially executed?

**Step-by-step**

1. Seller has 100 Touch coins, posts ask at $0.30.
2. Buyer submits market-buy PTB for 100 @ $0.30.
3. In the same Sui block, oracle path-update PTB lands, observation flips to HIT, `lock_settlement` PTB lands.
4. Sui sequences shared-object access. Possible orderings:
   - (a) buy → lock_settlement → settle → redeem: clean, buyer wins.
   - (b) lock_settlement → settle → buy: market is `LOCKED` or `SETTLED`. Does CLOB trading still work? **Yes** — DeepBook does not know about Wick's status. The trade goes through, buyer gets coins, redeems for $1.
   - (c) lock_settlement → buy → settle → redeem: same as (b).
5. **The risk is not solvency** (Wick still has collateral and pays out). **The risk is the seller is bagholding a coin they thought was worth $0.30 but is actually worth $1.** The seller sold "free money."

Reverse: market settles to NoTouch. Buyer bought Touch for $0.30. Buyer's coins worthless. Buyer thought there was time to react; there wasn't.

**Economic impact**
Per occurrence: full price spread (the difference between trade price and final outcome). Generally, the *informed* counterparty wins these races.

**Existing controls**
- None — the race is structural.

**Mitigation**
- **Keeper cancels at `lock_settlement`** (also helps Attack 3): keeper monitors expiry and cancels ~30 sec before, shifting the race window onto only-organic LPs.
- **CLOB trading halt at oracle-stale or post-expiry:** keeper detects `now > expiry_ms`, cancels everything. Doesn't stop existing organic LPs from getting picked off.
- **Document.** CLOB users explicitly accept that orders resting at expiry can be filled at inconvenient times. UI shows "expires in: 30s — orderbook resting orders may fill atypically."

---

## Attack 13 — Off-Chain Fair-Price Spoofing ("Quote-Stuff the UI")

**Severity:** Medium

**Setup**
Wick's UI displays a "Fair price: $0.34" computed off-chain from the same path-observation logic. A trader sees this and clicks "Buy at $0.34." The PTB executes at any price up to user-set slippage tolerance.

**Step-by-step**

1. Attacker observes Wick UI's fair-price computation (same as keeper's). Computes that BTC's next tick will move `p_touch` from 0.34 to 0.36.
2. Attacker submits a `place_limit_order(ask=0.348, size=large)` to CLOB **just** as a retail user clicks "buy at fair price."
3. Retail's PTB market-buys, hits attacker's ask at 0.348, then walks the book at 0.35, 0.36, etc.
4. Attacker captures the spread on the user's slippage tolerance.

**Economic impact**
Per retail trade: a few cents. Compounds with high retail flow.

**Existing controls**
- None mentioned.

**Mitigation**
- **Tight slippage default in UI.** Default slippage 0.5%, surfaced clearly. "Click to slip 1%" requires explicit user action.
- **Fair-price freshness indicator.** UI shows "fair-price as of T-3s." If stale, gray out the buy button.
- **Limit-order-only UI for non-experts.** Default UI mode posts limit orders at fair price ± user-chosen edge, never market orders. Power user mode unlocks market orders.

---

## Attack 14 — Witness-Module Polluter / OTW Spam

**Severity:** Low

**Setup**
The per-market witness publish flow (§8.1, Option A) creates a fresh Move package per market. A "Wick fork" — even a non-malicious teaching repo — could emit packages with name patterns matching `wick_market_*` and pollute the discoverable name space.

**Step-by-step**

1. Attacker publishes 10,000 packages to testnet, each named `wick_market_<random>`, each defining a `Position<M, Touch>` and `Position<M, NoTouch>` Coin type.
2. Wallet UIs that auto-discover Wick markets by package-name prefix now show 10,000 fake markets in the user's "your markets" list.
3. Per market: $1-2 of testnet gas to publish. 10k markets: ~$15k. Real money on mainnet, trivial on testnet.

**Economic impact**
- Hackathon: confused demo audience.
- Mainnet: significant UX pollution and impersonation risk.

**Existing controls**
- None — Move's package-name system is global and permissionless.

**Mitigation**
- **UI discovers markets by querying Wick's `MarketRegistry`, not by package-name scanning.** Maintain an on-chain registry of canonical market IDs blessed by the Wick `KeeperCap`.
- **Frontend shows only registered markets**, with a "show all on-chain" toggle for advanced users (with a "unverified" badge).
- **Don't publish witness packages with predictable names.** Use random hex; the deployment script captures the package ID and registers it on the Wick `MarketRegistry`. The name is incidental.

---

## Cross-Cutting Observations

### The keeper market-maker is the single biggest exposure

Of the 14 attacks, **5 of them** (1, 2, 4, 8, 9) directly extract value from the keeper's quoting. The combined daily P&L drag, with naive parameters from §9.2, is conservatively in the **$50-500 per market per day** range — this is the "real money loss" the prompt asked us to be harsh about.

The recommended posture:
1. **Wide spreads** (200-500 bps half-spread, not 50 bps).
2. **Inventory-aware quoting** with hard caps and skew.
3. **Stale-oracle pause.** Off > on under uncertainty.
4. **Pre-expiry trading halt** (keeper-side, 5 min before expiry).
5. **Daily loss circuit breaker.**

Even with all these, a sophisticated counterparty *will* extract some value. Budget for it as opex.

### Permissionless CLOB on path-dependent products is structurally hard

Attacks 3, 5, 6, 12 are all forms of "DeepBook doesn't understand Wick's market lifecycle." The CLOB layer is *purely* a fungible-token venue; it has no concept of expiry, settlement, or coin obsolescence. Mitigations are all *external*: keeper cancellations, UI filters, education.

The OTC fallback (§10) is **strictly safer for users** because every OTC order has an explicit `expires_ms` and a maker who can cancel. **Recommendation:** ship CLOB as advertised demo feature, but make OTC the default trade path in the UI for any non-expert user. The two can coexist.

### The DEEP economics are a soft cap on the integration

500 DEEP per pool × 2 pools per market is real cost. Combined with the bootstrap front-run risk (Attack 5) and the inventory toxicity (Attack 8), the total "cost per CLOB-listed market" is non-trivial. **Recommend listing only the 1-2 flagship demo markets on CLOB** and routing the rest through OTC. This matches the design doc's own §3 recommendation but should be stated more emphatically as a *security* posture, not just an *operational* one.
