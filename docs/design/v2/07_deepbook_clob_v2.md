# 07 — Wick × DeepBook v3 CLOB integration (v2, hardened)

**Status:** v2 spec, supersedes `docs/design/07_deepbook_clob.md`.
**Date:** 2026-05-12.
**Predecessor:** `docs/design/07_deepbook_clob.md` (v1, naive 50bps half-spread, no inventory caps, no oracle-staleness gate).
**Red-team input:** `docs/redteam/07_deepbook_clob.md` (14 attacks; headline: "$50–500/market/day P&L drag with naive 50 bps spread; CLOB on path-dependent products is structurally hard").

**TL;DR.** v1 treated DeepBook listing as the default trade path for every market and the keeper as a generic AMM-style maker. The red-team review showed both assumptions are wrong. v2 ships CLOB as a **curated, opt-in tier** for flagship markets only, with a hardened keeper (200–500 bps half-spread, hard inventory caps, oracle-staleness pause, pre-expiry trading halt, daily loss circuit breaker), atomic single-PTB pool bootstrap (no front-run window), and an explicit Touch+NoTouch arbitrage clamp. Every other market ships **OTC-only** via a first-class P2P escrow path keyed off Wick events. Settled coins are quarantined behind a `MarketSettled` event the indexer uses to filter pools out of the UI. DEEP economics are budgeted: 1000 DEEP per flagship market, swap-sourced from the testnet `DEEP/SUI` pool, OTC fallback when DEEP runs out.

The contract with users does not change: ticket in, ticket out, payout at settlement. What changes is how a holder exits before expiry — and we're now honest that the CLOB tier is a privilege, not a guarantee.

---

## 1. Listing tier strategy

The defining v2 architectural choice: **not every Wick market gets a CLOB pool.** Listing is curated, with three tiers:

### Tier A — Flagship CLOB

- **Definition:** the 1–4 markets per demo session we want to trade live on a real DeepBook book.
- **Requirements:** `(Touch_M, DBUSDC)` and `(NoTouch_M, DBUSDC)` permissionless pools, 1000 DEEP burned at bootstrap, keeper market-making active, OTC layer also listening (belt-and-braces).
- **Curation rule:** flagship markets are flagged at creation by the `KeeperCap` holder via `bootstrap_pull_market_with_clob` (vs the OTC-only `bootstrap_pull_market`). Today that's a human decision; post-MVP it can be automated by underlying volume + barrier liquidity.
- **Visible UX:** an orderbook depth chart, taker fees, `Modify Order`, market vs limit toggle. Users see "CLOB" badge.

### Tier B — OTC-only

- **Definition:** every market that is not flagship. The default tier.
- **Requirements:** none beyond standard Wick bootstrap. Position type stays `key, store` (no Coin'ification needed; saves DEEP and the per-market witness publish step).
- **Visible UX:** a "Post offer" panel listing live `OtcOrder` objects. No order book, no maker fees. Slower, but every order is owner-cancellable and explicitly time-bounded.

### Tier C — Primary-only

- **Definition:** brand-new markets in their first ~60 seconds, before either keeper or OTC posts. Same product as Tier B but with no secondary liquidity yet.
- **UX:** "Open Touch / NoTouch" via primary mint only. Buy a complete set or one side; OTC unlocks once a maker posts.

The curation rule is conservative on purpose. The red-team showed that DEEP economics, witness-publish race, and inventory toxicity each independently make CLOB listing expensive and risky. Reserving it for the markets we *want* to demo with live order books makes every other market strictly safer.

---

## 2. Pool creation PTB — atomic with market bootstrap

v1 published the per-market witness module in transaction `T0`, ran `bootstrap_pull_market_with_clob` in `T1`, and called `create_permissionless_pool` twice in `T2`. The window between `T0` and `T2` is the front-run vector in **Attack 5** — anyone who sees the witness package on chain can race in and create the pool with adversarial tick/lot params.

v2 collapses everything after `T0` into a single PTB. The witness publish itself remains its own transaction (Sui's CLI does not currently support `publish` inside a PTB containing other move-calls), but the witness module is intentionally **not bound to the market** until step (2) — the witness `TreasuryCap`s sit unused in the publisher's wallet, indistinguishable from any other unused cap. The bootstrap PTB then atomically:

1. consumes both `TreasuryCap`s,
2. constructs the `Market<C>` and stores them inside it,
3. shares the `Market`,
4. calls `create_permissionless_pool<Position<M, Touch>, DBUSDC>`,
5. calls `create_permissionless_pool<Position<M, NoTouch>, DBUSDC>`,
6. writes both pool IDs onto the shared `Market<C>` via `set_clob_pools`.

All five state-mutating calls happen in one transaction. An attacker cannot interleave a `create_permissionless_pool` between steps 4 and 5 because PTB execution is atomic per-transaction — the only race is between the witness publish (step 0) and the bootstrap PTB (steps 1–6).

### Closing the publish→bootstrap gap

Three layered defenses:

1. **Submission discipline.** The keeper script publishes the witness and immediately submits the bootstrap PTB in the very next API call — typical end-to-end is <500 ms. Window of vulnerability is one block.
2. **Witness type opacity.** Witness packages are named `wm_<random_hex>` (not `wick_market_<UUID>`). Mempool scanners cannot identify a Wick witness publish without parsing every package's source.
3. **Atomic recovery.** If `create_permissionless_pool` does revert with `EPoolAlreadyExists` (front-run succeeded against opacity), the bootstrap PTB aborts cleanly. The unused `TreasuryCap`s remain in the publisher's wallet. The keeper can republish a fresh witness on a different `M` and retry. Cost: 500 DEEP wasted per attempt (the pool fee is non-refundable but the bootstrap itself reverts before consuming the second 500 DEEP, since both pools are in the same PTB).

### Pseudocode

```ts
// keeper/scripts/bootstrapFlagshipMarket.ts
async function bootstrapFlagship(args: FlagshipArgs) {
  // Step 0: publish witness. Separate tx; opaque name.
  const witnessPkg = await publishWitness({ name: `wm_${randomHex(8)}` });
  const { touchCap, noTouchCap } = await waitForCaps(witnessPkg);

  // Steps 1-6: single atomic PTB.
  const tx = new Transaction();
  const market = tx.moveCall({
    target: `${WICK_PKG}::wick::bootstrap_pull_market_with_clob`,
    typeArguments: [DBUSDC_TYPE, witnessPkg.M_type],
    arguments: [/* market params */, args.seedCollateral, tx.object(touchCap), tx.object(noTouchCap)],
  });
  const [deepFee1] = tx.splitCoins(tx.object(DEEP_COIN_ID), [tx.pure.u64(500_000_000n)]);
  const touchPoolId = tx.moveCall({
    target: `${DEEPBOOK_PKG}::pool::create_permissionless_pool`,
    typeArguments: [`${witnessPkg.id}::market_witness::Position<${witnessPkg.M_type}, ${WICK_PKG}::market::Touch>`, DBUSDC_TYPE],
    arguments: [tx.object(REGISTRY_ID), tx.pure.u64(TICK), tx.pure.u64(LOT), tx.pure.u64(MIN), deepFee1],
  });
  const [deepFee2] = tx.splitCoins(tx.object(DEEP_COIN_ID), [tx.pure.u64(500_000_000n)]);
  const noTouchPoolId = tx.moveCall({
    target: `${DEEPBOOK_PKG}::pool::create_permissionless_pool`,
    typeArguments: [`${witnessPkg.id}::market_witness::Position<${witnessPkg.M_type}, ${WICK_PKG}::market::NoTouch>`, DBUSDC_TYPE],
    arguments: [tx.object(REGISTRY_ID), tx.pure.u64(TICK), tx.pure.u64(LOT), tx.pure.u64(MIN), deepFee2],
  });
  tx.moveCall({
    target: `${WICK_PKG}::clob_listing::set_clob_pools`,
    arguments: [market, touchPoolId, noTouchPoolId, tx.object(KEEPER_CAP_ID)],
  });
  return await client.signAndExecuteTransaction({ signer: kp, transaction: tx });
}
```

Net effect: an attacker has at most one block (~500 ms) to identify a Wick witness inside a stream of opaquely-named packages and front-run it, and even on success only griefs one market — which then redeploys with a fresh witness.

---

## 3. Keeper spec v2

The v1 keeper is the single biggest attack surface (Attacks 1, 2, 4, 8, 9 — five of fourteen). v2 makes five non-negotiable changes.

### 3.1 Wider half-spreads (200–500 bps)

| Spread | When |
|---|---|
| **200 bps** | Fresh oracle (≤ 2 s old), inventory between 30%–70% of cap, > 5 min to expiry |
| **350 bps** | Oracle 2–5 s old, OR inventory 15%–30% / 70%–85% of cap |
| **500 bps** | Oracle 5–10 s old, OR inventory 0%–15% / 85%–100% of cap |
| **Cancel all** | Oracle > 10 s old, OR < 5 min to expiry, OR market not in `OPEN` status, OR daily loss circuit breaker tripped |

The **tradeoff:** 200–500 bps spreads cede price discovery — fair value is now bracketed by a wider band. A retail user clicking "buy at fair price" will pay 2–5% above the keeper's mid. We accept that. The alternative is the v1 50 bps spread that the red-team showed produces $50–500/market/day of negative carry to HFT snipers. Wider spreads are what allow the keeper to be sustainably-on rather than a charity for off-chain low-latency traders.

The frontend is honest about this. The "Sell on CLOB" panel shows the keeper's mid with a small footnote: *"Keeper spread reflects oracle latency on Sui. For tighter prices, post a limit order or use OTC."*

### 3.2 Inventory-aware quoting with hard caps

Each `(market, side)` has a keeper-managed inventory in a Sui `Vault<WickPosition<M, Side>>` — a Move struct holding a `Balance<Coin<Position<M, Side>>>`. Caps:

| Param | Default | Note |
|---|---|---|
| `MAX_INV_PER_SIDE` | 1000 position units | Hard ceiling. Refuse fills that would exceed. |
| `INITIAL_INV_PER_SIDE` | 200 position units | Seeded at bootstrap from primary mint. |
| `MIN_INV_PER_SIDE` | 50 position units | Below this, stop quoting the ask. |
| `SKEW_K` | 0.5 | Quote skew per inventory delta. |

Quoting math, per side:

```
inventory_ratio = current_inventory / MAX_INV_PER_SIDE   ; in [0, 1]
skew_bps = SKEW_K * (0.5 - inventory_ratio) * 10_000     ; positive when low inv

half_spread_bps = base_spread_bps(oracle_age_ms)         ; from 3.1 table
ask = fv * (1 + half_spread_bps/10_000 - skew_bps/10_000)
bid = fv * (1 - half_spread_bps/10_000 - skew_bps/10_000)
```

Example: at low inventory (`ratio = 0.10`), `skew_bps = +200 bps`. Both bid and ask shift *up* by 2% — the keeper actively bids less aggressively (less likely to accumulate more) and asks more aggressively (more likely to sell down). At high inventory (`ratio = 0.90`), skew flips negative.

**Hard refusal at the move-call boundary.** The keeper's quoter does not just rely on its own self-policed cap — the `Vault<WickPosition<M, Side>>` enforces it on-chain:

```move
public fun deposit_to_vault<M, Side>(
    vault: &mut Vault<Position<M, Side>>,
    coin: Coin<Position<M, Side>>,
    cap: &KeeperCap,
) {
    let new_balance = vault.balance.value() + coin.value();
    assert!(new_balance <= vault.max_inventory, EInventoryCapExceeded);
    balance::join(&mut vault.balance, coin::into_balance(coin));
}
```

So even if the keeper's off-chain quoter has a bug and tries to deposit more than `MAX_INV_PER_SIDE`, the move-call aborts. The cap is enforced in two places — the off-chain quoter and the on-chain vault — and the on-chain check is authoritative.

### 3.3 Oracle-staleness pause

The keeper subscribes to `WickOracle` events. On each new oracle observation it stores `last_oracle_observation_ms`. The quoting loop checks at the top of every iteration:

```ts
const oracleAgeMs = Date.now() - this.lastOracleObservationMs;

if (oracleAgeMs > ORACLE_STALENESS_HARD_MS) {       // 10_000 ms
  await this.cancelAllOrders();
  this.metrics.cancelReason = "oracle_stale";
  return;
}

if (oracleAgeMs > ORACLE_STALENESS_WIDEN_MS) {       // 5_000 ms
  this.currentSpreadBps = SPREAD_500_BPS;
} else if (oracleAgeMs > ORACLE_STALENESS_LIGHT_MS) { // 2_000 ms
  this.currentSpreadBps = SPREAD_350_BPS;
} else {
  this.currentSpreadBps = SPREAD_200_BPS;
}
```

Thresholds (`ORACLE_STALENESS_*_MS`) are conservative for Sui's on-chain oracle latency. A path-update that takes 3 seconds to land widens the spread; one that takes 11 seconds withdraws the keeper entirely. The system fails closed.

### 3.4 Pre-expiry trading halt

5 minutes before market expiry, the keeper unconditionally:

```ts
if (market.expiryMs - Date.now() < PRE_EXPIRY_HALT_MS) {  // 5 * 60 * 1000
  await this.cancelAllOrders();
  this.metrics.haltReason = "pre_expiry";
  return;
}
```

The CLOB pool can still trade peer-to-peer — the keeper has no authority to halt DeepBook itself — but Wick keeper liquidity is gone. The frontend shows a banner: *"Keeper has withdrawn liquidity (5 min to expiry). Resting orders may fill at unusual prices. Use OTC for time-bounded quotes."* This is the **Attack 2** mitigation: the keeper refuses to be the patsy on the last-minute information ramp.

### 3.5 Daily loss circuit breaker

The keeper journals every fill in a local SQLite log: `(timestamp, market_id, side, qty, price, mark_at_fill, pnl_at_fill)`. `pnl_at_fill = (mark_at_fill - price) * qty * is_bid_sign`. End-of-day P&L per market and per keeper-wallet is summed.

```ts
const cumulativeLossUsd = this.computeRollingLossUsd(LOOKBACK_24H);

if (cumulativeLossUsd > MAX_DAILY_LOSS_USD) {  // $250 testnet, $5000 prod target
  await this.cancelAllOrdersAcrossAllMarkets();
  this.haltedUntil = Date.now() + COOLDOWN_MS;  // 1 hour
  emitAlert("circuit_breaker_tripped", { cumulativeLossUsd });
  return;
}
```

When tripped, the keeper halts **all** market making (not just the offending market), waits one cooldown hour, and resumes only after a human ack. The breaker is generous on testnet ($250) so the demo doesn't trip on a single bad fill, and tight in mainnet planning ($5000). It exists so a single oracle-feed degradation cannot drain Wick's treasury before anyone notices.

---

## 4. Touch + NoTouch arbitrage prevention

The collateral invariant guarantees `touch_payout + no_touch_payout = payout` always. Therefore the keeper's quoted asks must satisfy:

```
keeper.touch_ask + keeper.no_touch_ask >= payout * (1 + 2 * half_spread_bps / 10_000)
```

and symmetrically for bids:

```
keeper.touch_bid + keeper.no_touch_bid <= payout * (1 - 2 * half_spread_bps / 10_000)
```

**Enforcement.** The keeper does not compute Touch and NoTouch quotes independently. It computes one and *derives* the other:

```ts
// Compute touch quotes from oracle.
const fvTouch = await this.fairValueTouch(market);
const halfSpread = this.currentSpreadBps / 10_000;
const touchAsk = fvTouch * (1 + halfSpread - touchSkew);
const touchBid = fvTouch * (1 - halfSpread - touchSkew);

// Derive no-touch quotes by complement, then add a second spread layer.
const fvNoTouch = market.payout - fvTouch;
const noTouchAsk = (market.payout - touchBid) + halfSpread * market.payout;
const noTouchBid = (market.payout - touchAsk) - halfSpread * market.payout;

// Sanity invariant — must hold after rounding/skew.
assert(touchAsk + noTouchAsk >= market.payout * (1 + 2 * halfSpread));
assert(touchBid + noTouchBid <= market.payout * (1 - 2 * halfSpread));
```

The asserts are tested by `keeper/tests/clob_arb.test.ts`. If they ever fail, the keeper aborts before placing the orders. The trivial complete-set arbitrage from **Attack 4** is closed by construction: an attacker who buys both asks pays at minimum `payout * (1 + 2 * halfSpread)`, redeems for `payout`, and is at least `2 * halfSpread * payout` underwater.

This means the keeper is *also* protected against accidentally quoting itself into a complete-set hole via skew. If aggressive skew on the touch side would push `touchAsk + noTouchAsk < payout`, the keeper widens both sides until the invariant holds, even at the cost of an even worse displayed spread.

---

## 5. OTC fallback — first-class P2P escrow

OTC is no longer a "if DeepBook slips" emergency. It is the **default trade path for Tier B and Tier C markets** and a fallback for Tier A when DEEP runs dry.

### 5.1 Object model

```move
public struct OtcOrder<phantom C> has key, store {
    id: UID,
    market_id: ID,
    maker: address,
    side: u8,                              // SIDE_TOUCH or SIDE_NO_TOUCH
    intent: u8,                            // INTENT_BID or INTENT_ASK
    price_per_unit: u64,                   // in C, raw
    size: u64,                             // in position units
    locked_collateral: Balance<C>,         // populated if intent == BID
    locked_position: Option<Position>,     // populated if intent == ASK
    expires_ms: u64,
    status: u8,                            // OPEN | FILLED | CANCELLED | EXPIRED
}
```

A `BID` intent locks `price_per_unit * size` of collateral; the maker is offering to *buy* position tokens. An `ASK` intent locks the position itself; the maker is offering to *sell*.

### 5.2 Intent → match → settle flow

**Intent (post).** Maker submits one of:

```move
public entry fun post_otc_bid<C>(
    market: &Market<C>,
    side: u8,
    price_per_unit: u64,
    size: u64,
    collateral: Coin<C>,
    expires_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
)

public entry fun post_otc_ask<C>(
    market: &Market<C>,
    side: u8,
    price_per_unit: u64,
    position: Position,
    expires_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
)
```

Each emits an `OtcOrderPosted` event indexed by `market_id`, `side`, `intent`, `price_per_unit`, `size`, `expires_ms`, `maker`. The frontend reads these via the indexer and assembles a per-market book.

**Match (fill).** Taker submits one of:

```move
public entry fun fill_otc_bid<C>(
    order: &mut OtcOrder<C>,
    market: &Market<C>,
    position: Position,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C>

public entry fun fill_otc_ask<C>(
    order: &mut OtcOrder<C>,
    market: &Market<C>,
    payment: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): Position
```

Fills can be partial (size < order.size) or full. Partial fills decrement `order.size` and `order.locked_collateral` / split `locked_position`. Each fill emits `OtcOrderFilled` with the fill price and remaining size.

**Settle (cancel or expire).** The maker can cancel an `OPEN` order at any time, recovering the locked collateral / position. Anyone can call `expire_otc_order` after `expires_ms` (incentivized by a tiny gas-rebate refund from the order's collateral). Every state transition emits a typed event.

### 5.3 Why OTC is structurally safer

- **Owner-cancellable.** Unlike a CLOB resting order locked into a `BalanceManager` whose owner crashed, an `OtcOrder` is owned by the maker. No "zombie order" risk.
- **Explicit `expires_ms`.** Every order self-destructs at a maker-chosen timestamp. The pre-expiry information ramp (Attack 2) is bounded — if you posted a 10-min order 30 min before expiry, it cancels itself before the danger zone.
- **No DEEP cost.** Zero protocol fee to list. Wick takes a small fee at fill (configurable; 30 bps default in v2).
- **No witness publish.** Position stays as `key, store`. No bootstrap-front-run vector. No witness pollution.
- **Match-by-event.** No on-chain order book — the indexer materializes the book from `OtcOrderPosted` / `OtcOrderFilled` / `OtcOrderCancelled` events. UI is responsible for sorting and displaying. Cheap on-chain footprint.

### 5.4 OTC market-making

The keeper can also post `OtcOrder`s when DEEP is exhausted or for Tier B markets. Same fair-value math, same inventory caps, same daily loss breaker. Half-spreads can be tighter (300 bps default) because `expires_ms` lets the keeper bound exposure in time without polling — every 60 seconds it posts a fresh order that auto-expires in 75 seconds. Perfect for low-volume markets where active polling is wasteful.

---

## 6. Settled-coin handling

The single ugliest user-facing failure mode in v1 is **Attack 3**: a settled market's CLOB pool keeps trading and a clueless buyer pays $0.30 for a worthless coin. v2 closes this with three layers.

### 6.1 On-chain `MarketSettled` event

Every settlement path (`settle_market_hit`, `settle_market_no_touch`, `settle_market_expired_void`) emits, in addition to its existing payout events, a single canonical event:

```move
public struct MarketSettled has copy, drop, store {
    market_id: ID,
    settled_at_ms: u64,
    outcome: u8,                          // HIT | NO_TOUCH | VOID
    touch_coin_type: TypeName,
    no_touch_coin_type: TypeName,
    touch_clob_pool_id: Option<ID>,
    no_touch_clob_pool_id: Option<ID>,
}
```

`touch_coin_type` and `no_touch_coin_type` are populated from the `PositionCaps<phantom C, phantom M>` stored on the market — the indexer can look up the exact `TypeName` used to type the coins.

### 6.2 Indexer flow

The indexer subscribes to `MarketSettled` and writes to a `settled_coin_types` table with `(coin_type_string, settled_at_ms, outcome)`. A second job iterates the table and:

- marks all DeepBook pool IDs whose `(base, quote)` includes a settled coin type as `expired_pool = true`,
- pre-computes a payout-per-coin for the winning side (1.0 × `payout_multiplier_bps / 10_000`) and zero for the losing side.

### 6.3 UI filter

The frontend has two queries:

- `getActiveMarkets()` — returns markets where `status = OPEN` and the indexer has not seen a `MarketSettled` event. CLOB pool links surface here.
- `getRedeemableCoins(address)` — returns the user's coin balances, joined against `settled_coin_types`, with a redeem-or-zero-value annotation.

Settled markets are removed from the trade list. The pool URL still resolves but renders a hard banner: *"This market settled at YYYY-MM-DD HH:MM UTC. Outcome: {HIT, NO_TOUCH, VOID}. Touch coins {are worthless / pay $1.00}. Do not trade — the order book is a zombie. Click to redeem."*

### 6.4 Keeper's part

Independently, on `MarketSettled` the keeper:

1. cancels all its own orders on both pools,
2. withdraws all `Coin<Position<M, Touch>>` and `Coin<Position<M, NoTouch>>` from its `BalanceManager` and `Vault`,
3. calls `redeem_position` on the winning side (and burns the losing side via `TreasuryCap.burn` if it still holds losers),
4. emits a `KeeperSettled` event for monitoring.

This does not protect organic LPs from being picked off by zombie order trades — DeepBook has no concept of "pool deprecation" — but it ensures Wick itself is never the bagholder, and the UI surface that 99% of users see correctly removes the market.

---

## 7. DEEP economics

### 7.1 Sourcing

500 DEEP per pool × 2 pools per flagship = 1000 DEEP per market. v2 reserves a war chest:

| Tier | DEEP per market | Markets / demo session | DEEP / session |
|---|---|---|---|
| A — Flagship CLOB | 1000 | 2 | 2000 |
| B — OTC-only | 0 | unlimited | 0 |

So one demo session needs **2000 DEEP**, sourced via:

1. **Primary path: swap on the testnet `DEEP/SUI` pool.** Sui faucet gives ~1 SUI per drip; DEEP/SUI testnet rate is volatile but historically ~0.1 SUI per DEEP. So 200 SUI = 2000 DEEP. The faucet rate-limits per address; the keeper rotates through 5 addresses pre-demo and consolidates DEEP into the bootstrap wallet.
2. **Secondary path: DeepBook devrel ask.** Documented contact in `docs/contacts.md`. They have whitelisted hackathon teams in the past.
3. **Tertiary path: skip CLOB entirely for that market.** Flagship demotes to Tier B and ships OTC-only. The demo narrative degrades from "live CLOB on a real Sui orderbook" to "live P2P escrow with active maker" — still credible, less impressive.

### 7.2 Runway

The bootstrap wallet's DEEP balance is monitored by the keeper. Below `DEEP_LOW_WATERMARK = 2000` (one full flagship session), the keeper:

- emits a `DeepLowWaterReached` event,
- refuses to bootstrap new flagship markets (returns `EInsufficientDeep`),
- continues to operate existing flagship pools normally,
- continues to bootstrap Tier B markets without restriction.

### 7.3 Fallback

If DEEP runs out mid-session, **Tier A markets continue trading on their existing pools** (no DEEP needed for ongoing trades — the 500 DEEP fee is a one-time pool creation cost). New markets that would have been flagship become Tier B (OTC-only) silently. The frontend hides the "CLOB" badge and shows "OTC only — DEEP exhausted, see ops." This is a graceful degradation path: the protocol does not stop, only the new-CLOB-listing capability does.

---

## 8. Mitigated attack table

| # | Attack | Severity | v2 mitigation |
|---|---|---|---|
| 1 | Keeper stale-quote sniping | Critical | 200–500 bps spread (3.1); oracle-staleness pause (3.3); cancel at >10s lag |
| 2 | Pre-settlement information ramp | Critical | Pre-expiry trading halt 5 min before expiry (3.4); UI banner; OTC default in last 10 min |
| 3 | Settled-coin zombie trading | High | `MarketSettled` event (6.1); indexer flags pools (6.2); UI filters (6.3); keeper cancels at lock (6.4) |
| 4 | Touch + NoTouch arb exceeding payout | High | Symmetric quote derivation (4); on-quote assert; complete-set inventory recycle when arb seen |
| 5 | Bootstrap front-run on pool creation | High | Atomic single-PTB pool creation (2); witness opacity; one-block window |
| 6 | Multi-pool double-listing | High | UI canonicality (only Wick-blessed pool IDs); aggregator coordination; documented |
| 7 | DEEP inventory exhaustion DoS | High | `KeeperCap`-gated bootstrap (3.5 in this doc, 7.1); pre-purchased war chest; OTC fallback for unfunded |
| 8 | One-sided inventory toxicity | High | Hard inventory caps (3.2); inventory-skew quoting; vault-enforced ceiling; daily loss breaker (3.5) |
| 9 | Front-running keeper re-quotes | Medium | `modify_order` atomic replace; multi-tier quotes; jittered requote timing; wider spread tolerates this |
| 10 | DBUSDC vs DUSDC token confusion | Medium | DBUSDC is the canonical CLOB quote; UI never calls them both "USDC"; embedded swap if needed |
| 11 | Coin merge / decisiveness state loss | Low–Medium | Per-(market, address) bonus state in `Table`, never per-Position-object; merging is safe |
| 12 | CLOB trade vs redeem race | Medium | Pre-expiry halt (3.4); oracle-staleness pause (3.3); UI shows "expires in: T" countdown |
| 13 | Off-chain fair-price spoofing | Medium | UI default 0.5% slippage; freshness indicator; default UI is limit-order-only |
| 14 | Witness-module polluter / OTW spam | Low | UI discovers markets via on-chain `MarketRegistry`; opaque witness names; never via package-name scan |

All 14 are addressed. Attacks 1, 2, 8 retain residual exposure (any oracle product on a permissionless venue does), but the residual is bounded by the daily loss circuit breaker.

---

## 9. Move pseudocode — `wick::clob_listing` v2 + `wick::otc_escrow`

### 9.1 `wick::clob_listing`

```move
module wick::clob_listing {
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::object::{Self, ID, UID};
    use sui::event;
    use wick::market::{Self, Market};
    use wick::keeper_cap::KeeperCap;

    const EInventoryCapExceeded: u64 = 100;
    const EInsufficientDeep: u64 = 101;
    const EPoolAlreadyAttached: u64 = 102;

    /// Inventory vault — keeper-owned per (market, side). On-chain inventory cap.
    public struct Vault<phantom T> has key, store {
        id: UID, balance: Balance<T>, max_inventory: u64, market_id: ID,
    }

    /// Stored on Market<C> after flagship bootstrap.
    public struct ClobListing has store {
        touch_pool_id: ID, no_touch_pool_id: ID,
        balance_manager_id: ID, listed_at_ms: u64,
    }

    public struct ClobListingAttached has copy, drop {
        market_id: ID, touch_pool_id: ID, no_touch_pool_id: ID,
    }

    public struct MarketSettled has copy, drop, store {
        market_id: ID, settled_at_ms: u64, outcome: u8,
        touch_coin_type: std::type_name::TypeName,
        no_touch_coin_type: std::type_name::TypeName,
        touch_clob_pool_id: std::option::Option<ID>,
        no_touch_clob_pool_id: std::option::Option<ID>,
    }

    /// Bind pool IDs to the market in the same PTB as create_permissionless_pool.
    public fun set_clob_pools<C, M>(
        market: &mut Market<C, M>, touch_pool_id: ID, no_touch_pool_id: ID,
        balance_manager_id: ID, _cap: &KeeperCap, ctx: &mut TxContext,
    ) {
        assert!(!market::has_clob_listing(market), EPoolAlreadyAttached);
        market::attach_clob_listing(market, ClobListing {
            touch_pool_id, no_touch_pool_id, balance_manager_id,
            listed_at_ms: market::now_ms(ctx),
        });
        event::emit(ClobListingAttached { market_id: object::id(market), touch_pool_id, no_touch_pool_id });
    }

    public fun new_vault<T>(market_id: ID, max_inventory: u64, ctx: &mut TxContext): Vault<T> {
        Vault { id: object::new(ctx), balance: balance::zero<T>(), max_inventory, market_id }
    }

    /// Authoritative inventory cap — aborts if deposit would exceed max.
    public fun deposit_to_vault<T>(vault: &mut Vault<T>, coin: Coin<T>, _cap: &KeeperCap) {
        assert!(vault.balance.value() + coin::value(&coin) <= vault.max_inventory, EInventoryCapExceeded);
        balance::join(&mut vault.balance, coin::into_balance(coin));
    }

    public fun withdraw_from_vault<T>(vault: &mut Vault<T>, amount: u64, _cap: &KeeperCap, ctx: &mut TxContext): Coin<T> {
        coin::from_balance(balance::split(&mut vault.balance, amount), ctx)
    }

    /// Called inside settle_market_*. Indexer reads this to flag pools as expired.
    public fun emit_market_settled<C, M>(market: &Market<C, M>, outcome: u8, ctx: &mut TxContext) {
        // ... lookup pool IDs from listing if present, then:
        event::emit(MarketSettled { /* market_id, settled_at_ms, outcome, type names, pool IDs */ });
    }
}
```

### 9.2 `wick::otc_escrow`

```move
module wick::otc_escrow {
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::object::{Self, ID, UID};
    use sui::clock::Clock;
    use sui::tx_context::TxContext;
    use sui::transfer;
    use sui::event;
    use std::option::{Self, Option};

    use wick::market::{Self, Market, Position};

    const STATUS_OPEN: u8 = 0;
    const STATUS_FILLED: u8 = 1;
    const STATUS_CANCELLED: u8 = 2;
    const STATUS_EXPIRED: u8 = 3;

    const INTENT_BID: u8 = 0;
    const INTENT_ASK: u8 = 1;

    const SIDE_TOUCH: u8 = 0;
    const SIDE_NO_TOUCH: u8 = 1;

    const EWrongIntent: u64 = 200;
    const ENotMaker: u64 = 201;
    const ENotExpired: u64 = 202;
    const EOrderClosed: u64 = 203;
    const EWrongMarket: u64 = 204;
    const ESizeExceeded: u64 = 205;
    const EInsufficientPayment: u64 = 206;
    const EInvalidExpiry: u64 = 207;

    public struct OtcOrder<phantom C> has key, store {
        id: UID,
        market_id: ID,
        maker: address,
        side: u8,
        intent: u8,
        price_per_unit: u64,
        size: u64,                            // remaining
        locked_collateral: Balance<C>,
        locked_position: Option<Position>,
        expires_ms: u64,
        status: u8,
    }

    public struct OtcOrderPosted has copy, drop, store {
        order_id: ID,
        market_id: ID,
        maker: address,
        side: u8,
        intent: u8,
        price_per_unit: u64,
        size: u64,
        expires_ms: u64,
    }

    public struct OtcOrderFilled has copy, drop, store {
        order_id: ID,
        market_id: ID,
        taker: address,
        fill_size: u64,
        fill_price: u64,
        remaining_size: u64,
    }

    public struct OtcOrderCancelled has copy, drop, store {
        order_id: ID,
        market_id: ID,
        reason: u8,                           // CANCELLED or EXPIRED
    }

    public entry fun post_otc_bid<C>(
        market: &Market<C, /*M*/>, side: u8, price_per_unit: u64, size: u64,
        collateral: Coin<C>, expires_ms: u64, clock: &Clock, ctx: &mut TxContext,
    ) {
        assert!(expires_ms > clock::timestamp_ms(clock), EInvalidExpiry);
        assert!(coin::value(&collateral) >= price_per_unit * size, EInsufficientPayment);
        let order = OtcOrder<C> {
            id: object::new(ctx), market_id: object::id(market), maker: tx_context::sender(ctx),
            side, intent: INTENT_BID, price_per_unit, size,
            locked_collateral: coin::into_balance(collateral),
            locked_position: option::none(),
            expires_ms, status: STATUS_OPEN,
        };
        event::emit(OtcOrderPosted { /* indexed by market_id, side, intent, price */ });
        transfer::share_object(order);
    }

    public entry fun post_otc_ask<C>(
        market: &Market<C, /*M*/>, side: u8, price_per_unit: u64,
        position: Position, expires_ms: u64, clock: &Clock, ctx: &mut TxContext,
    ) {
        assert!(expires_ms > clock::timestamp_ms(clock), EInvalidExpiry);
        assert!(market::position_market_id(&position) == object::id(market), EWrongMarket);
        assert!(market::position_side(&position) == side, EWrongIntent);
        let order = OtcOrder<C> {
            id: object::new(ctx), market_id: object::id(market), maker: tx_context::sender(ctx),
            side, intent: INTENT_ASK, price_per_unit,
            size: market::position_amount(&position),
            locked_collateral: balance::zero<C>(),
            locked_position: option::some(position),
            expires_ms, status: STATUS_OPEN,
        };
        event::emit(OtcOrderPosted { /* ... */ });
        transfer::share_object(order);
    }

    public entry fun fill_otc_bid<C>(
        order: &mut OtcOrder<C>, market: &Market<C, /*M*/>, position: Position,
        clock: &Clock, ctx: &mut TxContext,
    ): Coin<C> {
        // assert OPEN, INTENT_BID, market match, not expired, size <= remaining
        let fill_size = market::position_amount(&position);
        let payout = coin::from_balance(balance::split(&mut order.locked_collateral, order.price_per_unit * fill_size), ctx);
        market::transfer_position_to(position, order.maker);
        order.size = order.size - fill_size;
        if (order.size == 0) { order.status = STATUS_FILLED; };
        event::emit(OtcOrderFilled { /* ... */ });
        payout
    }

    public entry fun fill_otc_ask<C>(
        order: &mut OtcOrder<C>, market: &Market<C, /*M*/>, mut payment: Coin<C>,
        clock: &Clock, ctx: &mut TxContext,
    ): Position {
        // assert OPEN, INTENT_ASK, market match, not expired, payment >= price * size
        let position = option::extract(&mut order.locked_position);
        let cost = order.price_per_unit * market::position_amount(&position);
        coin::transfer(coin::split(&mut payment, cost, ctx), order.maker);
        coin::transfer(payment, tx_context::sender(ctx));   // refund overage
        order.size = 0; order.status = STATUS_FILLED;
        event::emit(OtcOrderFilled { /* ... */ });
        position
    }

    /// Maker cancels OPEN order. Refunds collateral (BID) or position (ASK).
    public entry fun cancel_otc_order<C>(order: OtcOrder<C>, ctx: &mut TxContext) { /* ... */ }

    /// Anyone may call after expires_ms. Refunds maker. Emits CANCELLED with reason=EXPIRED.
    public entry fun expire_otc_order<C>(order: OtcOrder<C>, clock: &Clock, ctx: &mut TxContext) { /* ... */ }
}
```

---

## 10. Test scenarios

The below 12 scenarios live in `move/tests/clob_listing_v2_tests.move`, `move/tests/otc_escrow_tests.move`, and `keeper/tests/clob_keeper.test.ts`. All must pass under `./scripts/agent-preflight.sh` before any v2 commit lands.

1. **Atomic bootstrap PTB** — flagship bootstrap with witness publish + market creation + 2 pool creations + `set_clob_pools` lands in two transactions; intermediate front-run by a test attacker calling `create_permissionless_pool` between the two reverts the bootstrap PTB cleanly with no DEEP loss on the second pool. *(Section 2)*
2. **Inventory cap enforcement** — keeper attempts to deposit 1100 position units into a `Vault` with `max_inventory = 1000`; aborts with `EInventoryCapExceeded`. *(Section 3.2)*
3. **Oracle staleness widens then halts** — simulate oracle gaps of 1 s, 3 s, 7 s, 12 s; assert keeper spreads at 200 / 350 / 500 / cancel-all respectively. *(Section 3.3)*
4. **Pre-expiry halt** — keeper running 6 minutes before expiry quotes normally; at 5-minute boundary, all orders cancel and no new orders place until settlement. *(Section 3.4)*
5. **Daily loss breaker** — feed keeper 50 simulated losing fills totaling $260 over 1 hour; breaker trips, all cross-market orders cancel, `circuit_breaker_tripped` event emitted, halted-until set to now + 1 hr. *(Section 3.5)*
6. **Touch+NoTouch arb invariant** — fuzz keeper quoter with random fair-value, payout, spread, skew; assert post-condition `touch_ask + no_touch_ask >= payout * (1 + 2*halfSpread)` for 10,000 random inputs. *(Section 4)*
7. **OTC bid post → fill → maker receives position** — Alice posts bid for 100 Touch at $0.40 with 40 USDC collateral; Bob fills with a 100-Touch position; Bob receives 40 USDC, Alice receives the position; `OtcOrderFilled` emitted. *(Section 5.2)*
8. **OTC ask post → partial fill** — Alice posts ask for 100 Touch at $0.50; Bob fills 60; Bob receives a 60-position split, Alice receives 30 USDC, order remaining size = 40. *(Section 5.2)*
9. **OTC expiry refund** — Alice posts ask, expires unfilled; anyone calls `expire_otc_order`, position returns to Alice, `OtcOrderCancelled` with reason `EXPIRED` emitted. *(Section 5.2)*
10. **`MarketSettled` event emission** — settle a market via HIT path; assert exactly one `MarketSettled` event with correct `outcome=HIT`, `touch_coin_type`, `no_touch_coin_type`, both pool IDs populated. *(Section 6.1)*
11. **Indexer flags settled coin types** — feed the indexer a `MarketSettled` event; assert `settled_coin_types` table contains both coin types and any pool whose base or quote matches is marked `expired_pool=true`. *(Section 6.2 — TS test)*
12. **DEEP exhaustion graceful degradation** — set keeper wallet's DEEP to 1500; bootstrap one flagship (consumes 1000, leaves 500); attempt second flagship bootstrap; reverts with `EInsufficientDeep`; same market re-bootstrapped as Tier B (OTC-only) succeeds; `DeepLowWaterReached` event emitted. *(Section 7.3)*

---

**End of v2 spec.** Cross-references: §1 listing tiers → §2 atomic bootstrap → §3 hardened keeper → §4 arb prevention → §5 OTC fallback → §6 settled-coin handling → §7 DEEP economics → §8 attack table → §9 Move pseudocode → §10 tests. Every red-team attack from `docs/redteam/07_deepbook_clob.md` is addressed in §8 with a back-pointer to the section that mitigates it.
