# 16 — DeepBook v3 listing for Wick touch / no-touch tokens

**Status:** design contract for the **DeepBook integration prize** track at Sui Overflow.
**Date:** 2026-05-19.
**Scope:** turn Wick's per-market `Position` NFT into a fungible `TouchCoin<…>` so that pre-settlement secondary trading happens on DeepBook v3 against a USDC quote book.
**Predecessor:** `docs/design/v2/07_deepbook_clob_v2.md` (the keeper-side market-making spec — kept; this doc only changes what the keeper makes a market in).
**Related:** §3.4 of `/tmp/SuiOptions/options-protocol-spec.md` (ewitulsk's three coin-creation patterns), `docs/design/v2/14_ride_economics.md` (the pricing model that defines fair value of these tokens before settlement), `docs/design/v2/15_montecarlo_validation_report.md` (the safety audit whose `vault_side` gate carries over verbatim).
**Owner:** if any parameter pinned here drifts from `scripts/seed-flagship-deepbook-market.sh`, the script is wrong — this doc is source of truth.

**TL;DR.** Today a Wick `Position` is a non-fungible owned object (`key, store`) and the only way out before settlement is to wait. That works for arcade volume, not for a "real exchange" prize. v2 of `07_deepbook_clob_v2.md` already specified the keeper, the half-spread, the OTC fallback and the settled-coin event — but it punted on *what coin DeepBook actually trades*. This doc resolves that. We mint a fungible `TouchCoin<U, S, MarketTag>` on `open()` (and a symmetric `NoTouchCoin<…>` when the no-touch side opens), list both as the base asset of two permissionless DeepBook pools quoted in `Coin<USDC>`, and let the market clear at the current implied probability of touch. At `lock_and_settle`, the winning coin can be redeemed against the vault 1:1; the losing coin is a `TreasuryCap::burn`-able worthless asset. Hackathon MVP: **one flagship market** (BTC 24-hr touch ±2%) demoed end-to-end open → DeepBook sell → DeepBook buy-back → hold → redeem. No-touch CLOB and DNT CLOB are deferred. Estimated effort: **10 working days**, broken into 6 phases.

---

## 1. The product story

Today a Wick trader who clicks **TOUCH** on BTC-24h-±2% gets a `Position` NFT in their wallet. To get out before settlement, their only path is the OTC escrow lane from `docs/design/v2/07_deepbook_clob_v2.md` §5 — which works but is structurally illiquid. Every fill needs a counterparty hand-posting an `OtcOrder` whose price they typed in from a fair-value indicator the UI showed them. There is no continuous market.

With DeepBook touch coins, the same `open()` call mints `N` units of `TouchCoin<BTC, USDC, MKT_42>` straight into the trader's wallet. Those coins are interchangeable with every other `TouchCoin<…MKT_42>` in existence. They live on a real DeepBook book against `Coin<USDC>`. The trader sees an order book in the UI with a mid that *is* the market-implied probability of a touch. When `P(touch)` ticks up from 0.30 to 0.42 because BTC moved closer to the barrier, the displayed price moves from `$0.30` per token to `$0.42` per token, and the trader can hit the bid and walk away with a clean profit before resolution. After `lock_and_settle`, winning-side coins redeem 1:1 against the vault for `$1.00` of USDC; losing-side coins are zeroed and can be burned through the market's `TreasuryCap` to free DeepBook BalanceManager state. A DeepBook resting order placed pre-settlement that fills after lock is a known footgun handled in §7.

A concrete walkthrough: Alice opens at `t=0` with 100 USDC stake on TOUCH side of a market with 2× payout. She receives `Position` *plus* 200 TouchCoin (2× of stake). The keeper's mid for TouchCoin is `$0.45` (implied P(touch) ≈ 45% net of vault edge). At `t=4h` BTC is closer to the barrier; keeper mid is now `$0.62`. Alice sells 200 TouchCoin into the keeper's bid at `$0.61` per coin, walks with 122 USDC — a 22% profit, banked. At `t=18h` BTC has reversed away; keeper mid is `$0.28`. Alice buys 200 TouchCoin back at `$0.29`, paying 58 USDC. She holds. At `t=24h` market settles HIT (BTC touched ±2%). Alice redeems 200 TouchCoin for 200 USDC. Net P&L: `+122 - 58 + 200 = 264` on 100 USDC of original capital. She trades sentiment, not just the final outcome.

The product framing for users: *"Trade Polymarket-style binary tokens for events that haven't happened yet, on a real Sui order book, with a 1-second resolution clock."* Wick is the only protocol on Sui shipping that. The Foundation's DeepBook integration prize is built precisely to reward this kind of net-new use case.

---

## 2. The Move surface — coin-creation pattern

The design choice that decides the rest of the doc: **how do we mint a fungible per-market coin without publishing a Move package per market?** §3.4 of the ewitulsk options spec catalogs three patterns and lands on "operationally heavy, pre-publish per cohort." Wick has a cleaner answer because (a) DeepBook v3's `create_permissionless_pool<BaseAsset, QuoteAsset>` does not require `Coin<T>`-bounded type parameters — it just requires the two types are distinct — and (b) Sui's `coin::create_currency` can be called from any entry function as long as a one-time witness is supplied at call time.

The four candidates, scored:

| | α — OTW per market (published module per market) | β — `coin::create_currency` at runtime with synthetic witness | γ — Single generic `TouchCoin<U, S>` with on-chain `bucket_id` check at burn | δ — AMM virtual claims (no Coin at all) |
|---|---|---|---|---|
| Fungibility scoped to a single market | yes (by witness) | yes (by `phantom MarketTag`) | no — fungible across same `(U, S)`; must check bucket on every transfer | yes (object-by-object) |
| Operational weight | **heavy** — publish a Move package per market, 1-block race window | **light** — one entry call at bootstrap, no separate publish | **light** — no per-market publish | **light** but custom AMM, not DeepBook |
| Composes with DeepBook `create_permissionless_pool` | yes | yes | yes but loses per-market identity in the pool | no |
| Sui-idiomatic | yes | partial — `create_currency` from a non-`init` context needs a witness factory module | no — bucket check at every entry adds surface | no |
| DEEP cost per market | 1 (only the pool) | 1 (only the pool) | 1 (only the pool) | 0 |
| Compatible with `07_deepbook_clob_v2.md` keeper | yes | yes | yes, with caveats | no |

**Decision: β — runtime `coin::create_currency` driven by a one-shot witness module that we publish *once* per package upgrade and reuse for every market.**

The mechanism: a single `wick::touch_coin_factory` module publishes one `TOUCH_COIN_FACTORY` OTW at install time and stores its `Publisher` object. A new public function `mint_market_coins<U, S>(market_tag: vector<u8>, ctx: &mut TxContext): (TreasuryCap<TouchCoin<U, S>>, TreasuryCap<NoTouchCoin<U, S>>)` calls `coin::create_currency` twice with a *derived* witness — concretely, the factory holds a small `phantom MarketTag` type whose identity is the SHA-256 of `(package_id, market_id_seed, side)`. The two `TreasuryCap`s are returned and immediately stored on the freshly-created `Market<C>` via a new field `coin_caps: Option<CoinCaps<U, S>>`. **The point: zero per-market publish, one DEEP-cost pool creation per side.**

The reason α from §3.4 was the ewitulsk default — and why we don't follow it — is that ewitulsk's product allows the *trader* to choose strike/expiry, so the universe of possible coin types is unbounded and admin-pre-publishing per cohort was the lesser evil. In Wick the *protocol* fixes the market template (24-hr ±2% on BTC, 30-min ±1% on SUI, etc.) and the keeper creates markets on a schedule. We control the call site, so we can amortize the one OTW across all of them.

γ stays as a documented escape hatch in case β breaks against a real DeepBook deploy: `wick::generic_touch::TouchCoin<phantom U, phantom S>` plus a per-transfer assertion `assert!(coin.bucket_id == position.bucket_id)`. It's strictly worse — every transfer pays the assertion — but it ships in 1 day instead of 3 if β has a Move-side surprise.

δ (virtual claims with our own AMM) is rejected: it forfeits the DeepBook prize, which is the entire reason this document exists.

---

## 3. On-chain lifecycle (open → DeepBook trade → settle → redeem)

The five-stage lifecycle below is the contract between Move, keeper, and frontend. Every state transition emits a typed event for the indexer; every transition is idempotent.

### 3.0 State machine overview

```
                    bootstrap_flagship_deepbook_market
                                    │
                                    ▼
   ┌──────────────────────────  STATUS_ACTIVE  ──────────────────────────┐
   │       (Market live; TouchCoin & NoTouchCoin freely mintable          │
   │        via market::open; both DeepBook pools live)                   │
   │                                                                      │
   │   open()         ──▶  +TouchCoin to user, +touch_exposure            │
   │   open()         ──▶  +NoTouchCoin (gated by vault_side)             │
   │   DeepBook fill  ──▶  no Move state change (pure CLOB transfer)      │
   │   tick()         ──▶  path observation update; no coin change        │
   │                                                                      │
   └──────────────────────────────┬──────────────────────────────────────┘
                                  │ lock_and_settle (atomic)
                                  ▼
        ┌──── STATUS_HIT ────┬──── STATUS_EXPIRED ────┬──── STATUS_ABORTED ────┐
        │   touch_cap unfroz │   no_touch_cap unfroz  │   both caps frozen     │
        │   no_touch_cap frz │   touch_cap frozen     │   refund_coin only     │
        │                    │                        │                        │
        ▼                    ▼                        ▼                        │
   redeem_coin           redeem_coin              refund_coin                  │
   (TouchCoin)           (NoTouchCoin)            (either coin)                │
   pays $1/unit          pays $1/unit             pays implied_stake/unit      │
                                                                               │
   burn_loser_coin       burn_loser_coin          (no losers in ABORTED)       │
   (NoTouchCoin)         (TouchCoin)                                           │
   pays 0                pays 0                                                │
                                                                               │
   keeper cancels        keeper cancels           keeper cancels              ◀┘
   all DeepBook orders   all DeepBook orders      all DeepBook orders
   on MarketSettled      on MarketSettled         on MarketSettled
```

Each arrow is a single Move tx (or in the case of DeepBook fills, a single DeepBook tx). The `frozen_caps` field gates the asymmetric post-settlement mint rules. The keeper-side cancellation is a strict obligation but not a Move-enforceable one — see §7 for residual exposure.

### 3.1 Market bootstrap (`bootstrap_flagship_deepbook_market`)

A single PTB, following the atomic pattern from `07_deepbook_clob_v2.md` §2:

1. `market::create_v4<C>` with `vault_side = SIDE_NO_TOUCH` (so traders only open touch; the vault is the natural no-touch counterparty per the Monte Carlo finding).
2. `touch_coin_factory::mint_market_coins<U, S>(market_id_seed)` — returns two fresh `TreasuryCap`s.
3. `market::attach_coin_caps` — moves the caps into the shared `Market<C>` for later mint/burn.
4. `deepbook::pool::create_permissionless_pool<TouchCoin<U,S,MKT>, USDC>` — 500 DEEP fee, tick=1000, lot=1000, min=10_000 (see §5).
5. `deepbook::pool::create_permissionless_pool<NoTouchCoin<U,S,MKT>, USDC>` — same.
6. `market::attach_clob_pools` — records both pool IDs on the shared `Market<C>`.
7. `keeper_vault::seed_initial_inventory` — mint a small primary set of both coins into the keeper's BalanceManager so it can quote both books from t=0 (`MIN_BOOTSTRAP_INVENTORY = 200` units per side, paid for out of the keeper's USDC float at fair value).

The single PTB collapses what would otherwise be a 7-tx flow with 6 attacker windows down to one tx with zero attacker windows after the witness factory publish (which is one-time per package version). DEEP cost: 1000 per flagship market (two pools × 500).

### 3.2 Position open (modified `market::open`)

`market::open` is extended with a single new line at the end. After the existing PWE gating + stake deposit + exposure update, the function calls:

```
TouchCoin::mint(&mut market.coin_caps.touch_cap, payout_if_win, ctx)
  → returns Coin<TouchCoin<U, S, MKT>> of `payout_if_win` units
  → transferred to tx_context::sender(ctx)
```

The `Position` NFT is no longer returned; the **coin is the position**. The trader's wallet holds `payout_if_win` units (e.g. 200 USDC of TouchCoin if they staked 100 USDC at 2× payout). On the vault side, accounting is unchanged: `touch_exposure += payout_if_win` exactly as before. The conservation invariant from `AGENTS.md` evolves into the form in §4.

### 3.3 Secondary trading on DeepBook

Trades happen entirely outside Wick's Move code. The keeper (per `07_deepbook_clob_v2.md` §3) maintains bid/ask on both pools using:

- `fv_touch = market.payout_per_unit * P(touch | spot, σ, t_remaining)` — Bachelier as in `14_ride_economics.md` §3
- `fv_no_touch = market.payout_per_unit - fv_touch`
- half-spread + skew per §3.1 of `07_deepbook_clob_v2.md`
- the arb-prevention assert from `07_deepbook_clob_v2.md` §4: `touch_ask + no_touch_ask >= payout_per_unit * (1 + 2 * half_spread)`

Retail trades hit the keeper's bid/ask. Wick never sees these in Move — they're pure DeepBook fills. The indexer derives "implied probability" charts from `deepbook::pool::trade_event` streams.

### 3.4 Settlement (`lock_and_settle`)

Unchanged from current `market.move`. Snapshot path, compute status, reserve obligation. **In the same tx**, the keeper sees the new `MarketSettled` event from §6 of `07_deepbook_clob_v2.md` and within one block cancels its DeepBook orders. The frontend filters the market out of the trading list (also per `07_deepbook_clob_v2.md` §6.3).

### 3.5 Redeem (`market::redeem_coin`)

A new entry point replaces `redeem(Position)` for coin-backed markets:

```
redeem_coin<C, U, S, MKT>(
    market, vault, fee_router, wick_state, staking, oracle,
    coin: Coin<WinningSide<U, S, MKT>>, ctx
) -> Coin<C>
```

The function:

1. Reads `market.status` and decides which coin type is the winner.
2. Calls `coin::burn(&mut market.coin_caps.<winner>_cap, coin)` — supply decrements, cap stays on market.
3. Computes `payout = coin.value() * 1_000_000 / 1_000_000` (1 unit of TouchCoin redeems for 1 unit of underlying USDC; `payout_if_win` was the mint amount, so each unit is worth exactly $1).
4. Pulls from `mv::pay_winner` exactly as the current `redeem` does for `Position`.
5. Charges the impact fee on profit (`payout - implied_stake`); for a coin-holder, "stake" is recovered as `coin_amount / payout_multiplier_bps × 10000`. Honest behavior on a secondary-buyer is debatable — see §7 risk #3.
6. Loser branch: a separate `burn_loser_coin` entry function lets anyone burn worthless coins voluntarily (no payout, frees DeepBook BalanceManager state).

Aborted markets: `refund_coin` pays back the implied stake 1:1 (no profit-extraction, no fee), exactly as `redeem` does today for aborted positions.

---

## 4. Vault math + conservation invariant under fungible tokens

The load-bearing invariant from `AGENTS.md`:

```
collateral_vault == total_touch_supply == total_no_touch_supply
```

Under the current `Position` NFT model, `total_touch_supply` means `Σ Position.payout_if_win` for all touch-side positions. Under fungible TouchCoin, it means `coin::total_supply(market.coin_caps.touch_cap)` — a single read from the TreasuryCap. **This is strictly cleaner.** The supply totals stored on `Market<C>` (`touch_exposure`, `no_touch_exposure`) become a *cache* of what the TreasuryCap supply field already tracks authoritatively. The invariant test (`move/tests/invariants.move`) updates from "sum the position objects" to "read the cap supply"; the assertion gets shorter, the property is preserved.

Three concrete checks the invariant suite must enforce on every state transition:

1. **Mint conservation:** `touch_cap.total_supply == market.touch_exposure` and `no_touch_cap.total_supply == market.no_touch_exposure`. Holds after every `open` (one mint, one exposure bump). Holds after every `redeem_coin` (one burn, one exposure decrement). The keeper's primary-mint at bootstrap (§3.1 step 7) goes through the same `mint_to_keeper` entry that bumps `touch_exposure` to match — no out-of-band minting allowed.
2. **Vault solvency:** `mv::treasury_value(vault) + Σ_m mv::lock_value(vault, m) >= Σ_m max(market.touch_exposure, market.no_touch_exposure)` for every active market. This is the existing invariant, just restated against the new accounting source.
3. **Burn finality:** after `lock_and_settle`, the *loser* side's coins are zero-value but still mintable in principle. We patch `coin_caps.<loser>_cap` into a "frozen" state at `lock_and_settle` (a new `frozen_caps: VecSet<TypeName>` on the Market) so post-settlement opens are impossible. The keeper's `burn_loser_coin` is allowed against frozen caps; new mints are not.

There is one subtle change: under the NFT model, the protocol always knew "who owns each position" because each `Position` has a single owner address. Under coins, ownership is distributed across DeepBook orders, wallets, and the keeper's BalanceManager. **The protocol does not need to know this.** Payouts go to whoever shows up at `redeem_coin` with the coin in hand, exactly like a bearer instrument. This is the design point of using a Coin in the first place.

### 4.1 The invariant as a Move-test assertion

The current test in `move/tests/invariants.move` reads, in pseudocode:

```
let touch_total = sum_positions(market_id, SIDE_TOUCH).payout_if_win;
let no_touch_total = sum_positions(market_id, SIDE_NO_TOUCH).payout_if_win;
assert!(touch_total == market.touch_exposure);
assert!(no_touch_total == market.no_touch_exposure);
assert!(vault.treasury_value + Σ_locks ≥ max(touch_total, no_touch_total));
```

After this work it becomes:

```
let touch_total = coin::total_supply(&market.coin_caps.touch_cap);
let no_touch_total = coin::total_supply(&market.coin_caps.no_touch_cap);
assert!(touch_total == market.touch_exposure);
assert!(no_touch_total == market.no_touch_exposure);
assert!(vault.treasury_value + Σ_locks ≥ max(touch_total, no_touch_total));
```

Same three lines of assertion, but the first two reduce from O(N) summation across position objects to O(1) cap reads. The test suite gets faster and more reliable. The invariant lands one notch closer to "checked by the type system" — the `TreasuryCap`'s supply field is *itself* a Sui-runtime-maintained sum.

### 4.2 What breaks if the cap is forged

The only way `touch_total != market.touch_exposure` is if someone minted TouchCoin without going through `market::open`. Two paths to that:

1. **A second `MintCap` exists.** Defended by `mint_market_coins` returning exactly one `TreasuryCap` per side and the bootstrap PTB attaching both to the Market in the same atomic call. The factory cannot be re-called for the same MarketTag (witness identity check, see §2).
2. **The cap is stolen.** Defended by the cap living inside the shared `Market<C>` object behind a `friend` boundary — only `wick::market` functions can borrow it mutably. If the Market itself is corrupted, the protocol has bigger problems.

A property test (`move/tests/coin_invariant_props.move`) fuzzes random sequences of `open`, `redeem_coin`, `burn_loser_coin`, `lock_and_settle` and asserts the three-line invariant after every step.

---

## 5. DeepBook integration concretes

DeepBook v3's `pool::create_permissionless_pool` signature (from the contract source):

```move
public fun create_permissionless_pool<BaseAsset, QuoteAsset>(
    registry: &mut Registry,
    tick_size: u64,
    lot_size: u64,
    min_size: u64,
    creation_fee: Coin<DEEP>,
    ctx: &mut TxContext,
): ID
```

Constraints from the source: `BaseAsset != QuoteAsset` (asserted by `type_name::with_defining_ids`); `tick_size > 0` and a power of ten; `lot_size >= 1000` and a power of ten; `min_size > 0`, a multiple of `lot_size`, also a power of ten. Crucially, **no `Coin<T>` trait bound on `BaseAsset`/`QuoteAsset`** — DeepBook holds balances internally, it doesn't care that we created the type with `coin::create_currency` versus any other source. This is what makes pattern β work.

### 5.1 Choosing base / quote

- **Base:** `TouchCoin<U, S, MKT>` (per market, one pool) and `NoTouchCoin<U, S, MKT>` (per market, second pool).
- **Quote:** `Coin<USDC>` (the canonical Sui testnet USDC; mainnet maps to the bridged Circle USDC). Quoting in the *collateral* type keeps the math one-to-one — no FX, no embedded swap.

Why not quote in `Coin<SUI>`? Three reasons. (1) The vault collateral is USDC, so a SUI-quoted book introduces a basis between collateral and trading currency that the keeper has to hedge. (2) Retail UX is in dollars. (3) Tier-A DEEP pricing in `07_deepbook_clob_v2.md` already assumes USDC-quoted books. Quoting in SUI is a clean migration if the market ever wants it; we ship USDC.

### 5.2 Tick / lot / min sizes

The chosen pinned values for the flagship market, in **USDC base units** (6 decimals on Sui):

| Param | Value | Meaning |
|---|---|---|
| `tick_size` | 1_000 | 0.001 USDC = 1/10th of a cent per TouchCoin unit. Captures price moves between 0.000 and 1.000 USDC at 1000-step granularity (1000 distinct prices). |
| `lot_size` | 1_000 | 0.001 TouchCoin per lot. With `payout_if_win` typically 100–500 USDC, a position is 100k–500k lots. Plenty of room for partial fills. |
| `min_size` | 10_000 | 0.01 TouchCoin minimum order. Filters dust orders without locking out small retail. |

TouchCoin decimals: **6**, mirroring USDC. This means 1 TouchCoin unit (as displayed) is 1_000_000 raw, and 1 raw TouchCoin redeems for 1 raw USDC at settlement — a clean 1:1 with no decimal shift.

### 5.3 Worked example: a $0.40 → $0.55 mid move

Suppose the keeper's current TouchCoin fair value is `fv = 0.40 USDC/coin` (implied 40% P(touch)), payout multiplier is 2× (so `payout_per_unit = 1.00 USDC`), and half-spread is 200 bps. Then:

```
touch_bid = fv * (1 - 0.02) = 0.392 USDC/coin
touch_ask = fv * (1 + 0.02) = 0.408 USDC/coin

no_touch_bid = (1.00 - touch_ask) - 0.02 = 0.572 USDC/coin
no_touch_ask = (1.00 - touch_bid) + 0.02 = 0.628 USDC/coin

arb check: touch_ask + no_touch_ask = 0.408 + 0.628 = 1.036
           required: 1.00 * (1 + 2*0.02) = 1.040
           FAILS by 0.004 → widen until passes
```

The arb-prevention assert from `07_deepbook_clob_v2.md` §4 triggers; the keeper widens the half-spread until `touch_ask + no_touch_ask ≥ 1.04`. This is the right behavior — the keeper accepts a wider displayed spread over allowing a complete-set arb that drains its inventory.

When BTC moves halfway to the barrier, the Bachelier model bumps `P(touch)` from 0.40 to 0.55. The keeper's fair value reprices; new bid/ask is `0.539 / 0.561`. A trader who bought 200 TouchCoin at `0.408` earlier sells into `0.539` for `200 * (0.539 - 0.408) = 26.2 USDC` of profit. The keeper's `(touch_skew)` shifts negative (inventory built up), shading both quotes down by `SKEW_K * inventory_ratio` per `07_deepbook_clob_v2.md` §3.2. Everything from that doc continues to work; only the underlying tradeable changed.

### 5.4 Initial liquidity bootstrap

The "primary mint to keeper" in §3.1 step 7 is the seed. Sequence:

1. Keeper deposits 100 USDC of collateral via `market::open(side=TOUCH)` → receives 200 TouchCoin (assuming 2× payout multiplier).
2. Keeper deposits 100 USDC of collateral via `market::open(side=NO_TOUCH)` *but this is gated by `vault_side`*. Instead, the keeper uses a separate `seed_initial_no_touch_inventory` entry that mints from the cap directly and books the synthetic exposure against the vault. The vault essentially loans the keeper 200 NoTouchCoin worth of obligation, which the keeper undertakes to either sell or return at settlement.
3. Keeper places initial 10-level ladders on both pools at `fv ± 200 bps`.

Net DEEP cost per flagship market: 1000. Net keeper USDC float: ~$100 per side per market. With one flagship market for the MVP demo, this is trivially small.

---

## 6. Hackathon MVP scope cut

The full vision (touch + no-touch + DNT all on DeepBook for every flagship market) is ~25 days. The hackathon has 10. The cut:

**In scope for the prize demo:**

- **One flagship market** — BTC-24h-±2%-touch-only, USDC-collateralized. Pinned config goes in `scripts/seed-flagship-deepbook-market.sh`.
- **Both pools (Touch + NoTouch) created** — required for the no-arb invariant from `07_deepbook_clob_v2.md` §4 to even be checkable. The NoTouch pool may have thin keeper liquidity; that's fine, it's a demo of the *plumbing*, not a guarantee of tight spreads.
- **Keeper market-making active** — using the v2 spec's 200-bps half-spread, the inventory caps, the oracle-staleness pause, and the arb-prevention assert. The keeper updates from `07_deepbook_clob_v2.md` will be substantial — see §8 phase 4.
- **Full end-to-end demo flow** — open via `market::open`, sell on DeepBook to lock in a profit, buy back into the same side, hold to settlement, redeem. Recorded as part of `docs/design/v2/10_demo_script_v2.md`.

**Cut from MVP, deferred to post-Overflow:**

- DNT corridor coins (would need a `DntInsideCoin` / `DntOutsideCoin` per market, doubling the pools needed)
- Multi-flagship markets (we ship 1, not 4; eliminates the DEEP runway risk from `07_deepbook_clob_v2.md` §7.2)
- Tier-B OTC fallback through DeepBook — already covered by the existing OTC escrow in `07_deepbook_clob_v2.md` §5
- Per-market witness OPS automation (the factory pattern publishes once per package; per-market still requires the keeper to call `bootstrap_flagship_deepbook_market` manually for the demo)
- Frontend "implied probability" chart from DeepBook trade events (we ship the trade UI; the chart is week-4 polish if time permits)
- WICK token emissions on DeepBook trades (currently only emitted on Wick `open`; secondary trades on DeepBook don't mint WICK — this is intentional for MVP, the secondary market is "real money only")

The demo narrative: *"Wick is the only Sui protocol shipping Polymarket-style binary tokens on a real DeepBook order book. Watch a single trader open, exit at +40%, buy back in at the dip, hold through resolution, and redeem against the vault."* That story is sellable in 90 seconds.

---

## 7. Risks + open questions

**Risk #1 — Settled-coin trading on a zombie DeepBook pool.** Already analyzed in `07_deepbook_clob_v2.md` §6 (attack #3). DeepBook has no concept of "pool deprecation." The mitigations transfer over unchanged: `MarketSettled` event → indexer flags pool → UI filters out + hard banner. The residual exposure is a clueless trader who bypasses the Wick UI and trades the raw DeepBook pool. Acceptable for the demo; documented in the threat model.

**Risk #2 — DeepBook resting order fills after `lock_and_settle`.** Same root cause as #1, different symptom: an order placed at $0.40 pre-settlement may fill after the market is locked, transferring USDC for a worthless coin. The keeper cancels its own orders within one block of `MarketSettled`, but retail orders cannot be force-cancelled by Wick. Mitigation: the frontend default behavior is *immediate-or-cancel* on all DeepBook trades (no resting orders for retail in the MVP UI). Limit orders unlock as a pro-mode toggle with an explicit "expires at: …" picker that we silently cap at `market.expiry_ms - 60s`. This punts the problem from "protocol surface" to "UI safety."

**Risk #3 — Impact fee on a secondary-market buyer who never staked.** Today's `market::redeem` charges fee on `payout - stake`. A user who bought TouchCoin on DeepBook for $0.85 and redeems at $1.00 has implied "profit" of $0.15 per coin, but never paid a fee at open. The proposed §3.5 model imputes a stake of `coin_amount / payout_multiplier_bps × 10000` (i.e. the original-staker stake). For a 2× market, this charges fee on `1.00 - 0.50 = 0.50` of "profit" — punishing the secondary buyer disproportionately. **Open question:** should secondary buyers pay fee at all, or should fee be a one-time charge on the original opener? Recommendation: charge a flat 30-bps DeepBook-trade-fee at *each* secondary fill (via the keeper's spread, no Move change needed) and **zero impact fee at redeem for coin-purchased units**. Distinguishing "originally minted" vs "secondary-acquired" units requires per-unit history that fungibility deliberately discards. The clean answer is to drop the impact fee for the coin-backed flow entirely; the dirty answer is to keep the imputed-stake calculation and accept the asymmetry. **Decision needed before Phase 5.**

**Risk #4 — Per-market `MarketTag` collision under the factory pattern.** If `mint_market_coins` derives the witness identity from a market seed and two markets ever collide, their coin types become interchangeable — silently. Mitigation: derive `MarketTag` from the new `Market<C>`'s UID, which is globally unique by Sui object semantics. Witness factory pseudocode in §2 already does this; the implementation must not weaken it (no human-chosen tags).

**Risk #5 — DEEP runway.** Same as `07_deepbook_clob_v2.md` §7.1. With one flagship market for the MVP, 1000 DEEP is enough. If we extend to 4 flagship markets we need 4000 DEEP; the war chest sourcing plan from §7.1 carries over.

**Open question #1 — Should `TreasuryCap`s live on the shared Market object?** Storing them there means anyone who can mutably borrow the Market can mint. Today only `market::open` and `market::redeem_coin` do, both behind asserts. Alternative: store caps on a separate `MarketMintAuthority` object held in dynamic storage on the Market, only reachable via a friend module. Cleaner but more code. **Recommendation: ship caps-on-market for MVP, refactor if a real attack surfaces.**

**Open question #2 — What happens to coin-holders during `ABORTED`?** A market that aborts (oracle dies pre-settlement) currently refunds 1:1 to depositors. For coin-holders, the implied stake is `coin / payout_multiplier_bps × 10000`. A secondary buyer who paid $0.95 for a TouchCoin and gets refunded $0.50 (the original implied stake) lost $0.45 to a protocol failure. Either we refund *price-paid* (requires per-unit history we don't have) or *implied-stake* (current plan, screws secondary buyers) or *coin-face-value* (overpays — vault doesn't have the funds). Recommendation: refund implied-stake, document the asymmetry, and ensure ABORTED is genuinely rare via the `OracleVersionLock` mechanism.

---

## 8. Implementation roadmap — 6 phases

Total estimated effort: **10 working days**, single engineer, assuming `07_deepbook_clob_v2.md` keeper code lands in parallel.

### Phase 1 — Coin factory + Move plumbing (Day 1–2)

- New module `wick::touch_coin_factory` implementing pattern β: OTW + `mint_market_coins` returning two `TreasuryCap`s.
- New types `TouchCoin<phantom U, phantom S, phantom MKT>` and `NoTouchCoin<…>` with 6 decimals via `coin::create_currency`.
- Unit tests: mint, transfer, burn under a witness; assert two different MarketTags produce non-fungible coins.

**Exit criteria:** `sui move test` green for `move/tests/touch_coin_factory_tests.move` covering the conservation invariant under mint/burn.

### Phase 2 — Modified `market::open` and new `market::redeem_coin` (Day 3–4)

- Extend `Market<C>` with `coin_caps: Option<CoinCaps<U, S>>` and `clob_pools: Option<ClobListing>` (the latter from `07_deepbook_clob_v2.md` §9.1).
- Extend `market::open` to mint the appropriate side's coin to the caller, in addition to the existing `Position` return. **The `Position` NFT continues to be issued** for backward compatibility with OTC; coin-backed and NFT-backed positions coexist for now. Eventually deprecate NFTs for flagship markets.
- New entry `market::redeem_coin<C, U, S, MKT>` per §3.5.
- New entry `market::burn_loser_coin<C, U, S, MKT>` for post-settlement cleanup.
- Patch `lock_and_settle` to freeze the losing-side cap (new `frozen_caps` field).
- Update `invariants.move` to read supplies from `TreasuryCap` directly.

**Exit criteria:** existing `market_tests.move` green plus a new `coin_market_tests.move` covering mint-on-open, conservation under transfers, and 1:1 redeem.

### Phase 3 — Atomic bootstrap PTB (Day 5)

- New entry `bootstrap_flagship_deepbook_market` per §3.1.
- Witness factory publish in a separate one-shot tx; bootstrap PTB consumes the factory `Publisher` object.
- TypeScript keeper helper in `keeper/src/bootstrapFlagship.ts` modeled on `07_deepbook_clob_v2.md` §2's pseudocode.

**Exit criteria:** running `keeper/src/bootstrapFlagship.ts` against testnet successfully creates a Market, two TreasuryCaps, two DeepBook pools, and writes pool IDs onto the Market in one composite operation.

### Phase 4 — Keeper market-making activation (Day 6–7)

- Lift the keeper code from `07_deepbook_clob_v2.md` §3 with the substitution: it now quotes against `TouchCoin<…>` and `NoTouchCoin<…>` instead of `Position` objects.
- Implement the arb-prevention assert from `07_deepbook_clob_v2.md` §4 in the keeper's quoter.
- Wire the oracle-staleness pause (3.3 of that doc) against `wick_oracle::last_observation_ms`.
- Implement the `MarketSettled` listener that cancels all orders within one block.

**Exit criteria:** keeper runs against testnet, quotes update every 5 s, oracle-staleness simulation pauses correctly, all 12 keeper tests from `07_deepbook_clob_v2.md` §10 pass.

### Phase 5 — Frontend trading surface (Day 8–9)

- Replace the `TradePanel` mock fills with real DeepBook `place_limit_order` / `place_market_order` calls via the DeepBook SDK.
- Add an "exit position" button that does a single-PTB market-sell of the user's TouchCoin balance against the keeper's bid.
- Implied probability indicator: take `keeper_mid / payout_per_unit` and show as a percentage.
- Settled-market filter: subscribe to `MarketSettled` events, hide trading UI, show redeem button.
- Resting-order safety per Risk #2: default IOC, pro-mode limit orders capped at `expiry - 60s`.

**Exit criteria:** the end-to-end demo flow from `docs/design/v2/10_demo_script_v2.md` runs through the live frontend without manual CLI intervention.

### Phase 6 — Demo polish + recording (Day 10)

- Rerecord `10_demo_script_v2.md` to include the DeepBook flow.
- Pre-seed three throwaway wallets with USDC to act as visible counterparties on the demo book (so the order book has depth on camera).
- Add the "Open → Sell → Buy back → Hold → Redeem" walkthrough as the headline frame of the Overflow submission video.
- Final integration test: `./scripts/agent-preflight.sh` green; manual DeepBook flow green; settlement clears all DeepBook orders correctly.

**Exit criteria:** Overflow submission video shows the full lifecycle in under 90 seconds and `agent-preflight.sh` passes.

---

---

## 9. Test scenarios

The below 10 scenarios live in `move/tests/touch_coin_factory_tests.move`, `move/tests/coin_market_tests.move`, `move/tests/coin_invariant_props.move`, and `keeper/tests/deepbook_flagship.test.ts`. All must pass under `./scripts/agent-preflight.sh` before any change here lands.

1. **Factory single-use per MarketTag** — calling `mint_market_coins` twice with the same derived `MarketTag` aborts with `EWitnessAlreadyConsumed`. *(§2)*
2. **Mint conservation under open** — open 50 positions of varying sizes; assert `coin::total_supply(touch_cap) == market.touch_exposure` after each. *(§4.1)*
3. **Burn conservation under redeem** — settle HIT, redeem winners in random order; assert touch supply monotonically decreases and ends at 0 when all winners redeem. *(§4.1)*
4. **Frozen-cap rejection** — after `lock_and_settle` with HIT, attempt `market::open(side=NO_TOUCH)`; aborts with `ECapFrozen`. Attempt to burn an unredeemed NoTouchCoin via `burn_loser_coin`; succeeds. *(§3.5, §4)*
5. **Bootstrap PTB atomicity** — bootstrap a flagship market with a test attacker calling `create_permissionless_pool` interleaved between the two pool creations; the bootstrap PTB reverts cleanly with no DEEP consumed past the first 500. *(§3.1, mirrors `07_deepbook_clob_v2.md` test #1)*
6. **Coin redeems 1:1 against vault** — open 1000-unit TouchCoin position, settle HIT, redeem coin; assert returned `Coin<C>` value == 1000 µUSDC. *(§3.5)*
7. **Arb-prevention assert under coin quoting** — fuzz keeper with random `(fv, payout, half_spread, skew)`; assert `touch_ask + no_touch_ask >= payout * (1 + 2 * halfSpread)` for 10,000 random inputs. *(§5.3; mirrors `07_deepbook_clob_v2.md` test #6 against the new coin types)*
8. **Keeper cancels on MarketSettled** — feed keeper a synthetic `MarketSettled` event; assert all DeepBook orders for both pools cancel within one polling cycle (≤1 s). *(§3.4)*
9. **ABORTED refunds implied stake** — open 200-unit TouchCoin position (100 USDC stake at 2× payout), force market abort, redeem coin via `refund_coin`; assert returned value == 100 µUSDC (the implied stake), not 200 (the face value). *(§7 open question #2)*
10. **Property: bearer redeem** — open position as Alice, transfer coin to Bob, settle HIT, Bob calls `redeem_coin`; assert Bob receives full payout and no Position-NFT-style ownership check blocks the redeem. *(§4)*

---

**End of spec.** Cross-references: §2 picks the coin pattern → §3 lays out the lifecycle (with state diagram in §3.0) → §4 restates the invariant under fungibility → §5 nails down DeepBook concretes including a worked example → §6 cuts MVP scope to one flagship market → §7 lists known risks → §8 plans 10 days of work → §9 enumerates the test gate. Every previously-shipped concern from `07_deepbook_clob_v2.md` is preserved or explicitly inherited; this document only changes *what* DeepBook trades, not *how* the keeper makes a market or how settled coins are handled.
