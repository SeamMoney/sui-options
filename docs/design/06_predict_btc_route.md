# Predict BTC Route — Integration Spec

Status: design (pending implementation as `wick::predict_route` driver, task #73).
Branch researched: [`MystenLabs/deepbookv3@predict-testnet-4-16`](https://github.com/MystenLabs/deepbookv3/tree/predict-testnet-4-16) — the deployment that backs the live Predict<DUSDC> shared object on Sui testnet.

This document specifies how Wick's BTC market composes with Aslan Tashtanov's live DeepBook Predict deployment to deliver **path-dependent (touch / no-touch) BTC options on top of Predict's terminal binaries**. It is written so that the Wick agent that implements it can do so without re-reading the Predict source.

## 0. Verified testnet facts (from prior research)

| Item | Value |
| --- | --- |
| Predict pkg (testnet) | `0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138` |
| `Predict<DUSDC>` shared object | `0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a` |
| `Registry` | `0x43af14fed5480c20ff77e2263d5f794c35b9fab7e2212903127062f4fe2a6e64` |
| Quote asset enabled for inflows | `DUSDC` only (publicly mintable) |
| Active BTC oracles | 19 × `OracleSVI`, 15-min binaries, $50k–$150k strike grid |
| Manager creation | `predict::create_manager(ctx)` — permissionless; result is a shared `PredictManager` |
| Trade entrypoint | `predict::mint<Quote>(predict, manager, oracle, key, qty, clock, ctx)` |

The branch uses `OracleSVI` (SVI volatility surface), not `MarketOracle` / Pyth Lazer — the latter is post-MVP on `main`.

---

## 1. Predict on-chain ABI we depend on

All function and struct paths below are verbatim from `predict-testnet-4-16` source. The corresponding files in the clone for an implementer are:

- `packages/predict/sources/predict.move`
- `packages/predict/sources/predict_manager.move`
- `packages/predict/sources/oracle.move`
- `packages/predict/sources/market_key/market_key.move`

### 1.1 `predict::create_manager`

```move
public fun create_manager(ctx: &mut TxContext): ID
```

Permissionless. Internally calls `predict_manager::new(ctx)`, which:

- Creates a fresh `BalanceManager`, `DepositCap`, `WithdrawCap` (all owned by the manager).
- Records `owner = ctx.sender()`.
- `transfer::share_object(manager)`.
- Emits `PredictManagerCreated { manager_id, owner }`.

The function returns the `ID` of the now-shared manager, but it is shared as `key`-only with no `store`, so once shared it must always be referenced by ID and read with a shared-input lookup. **The owner is fixed at creation time and cannot be transferred.** This is the load-bearing constraint that drives Wick's custody decision (§3).

### 1.2 `predict::mint<Quote>`

```move
public fun mint<Quote>(
    predict: &mut Predict,
    manager: &mut PredictManager,
    oracle: &OracleSVI,
    key: MarketKey,
    quantity: u64,
    clock: &Clock,
    ctx: &mut TxContext,
)
```

Behaviour, in order:

1. `assert!(ctx.sender() == manager.owner(), ENotOwner)` — **`tx.sender` must be the manager owner**. Not the manager's balance.
2. `assert!(!predict.trading_paused, ETradingPaused)`.
3. `assert!(quantity > 0, EZeroQuantity)`.
4. `treasury_config.assert_quote_asset<Quote>()` — `Quote` must be on the enabled-inflows whitelist (today: `DUSDC`).
5. `oracle_config.assert_key_matches(oracle, &key)` — `key.oracle_id == object::id(oracle)`, `key.expiry == oracle.expiry`, strike on the configured grid.
6. `oracle_config::assert_live_oracle(oracle, clock)` — oracle is `STATUS_ACTIVE` (not inactive, not pending settlement, not settled).
7. Inserts the new exposure into the vault, refreshes oracle risk MTM.
8. Re-quotes the post-trade ask, asserts it sits in `[min_ask_price, max_ask_price]`.
9. `cost = ask * quantity`. Withdraws `Coin<Quote>` of size `cost` **from the manager's `BalanceManager`** via `manager.withdraw<Quote>` (which itself reasserts owner). The DUSDC must already sit inside the BalanceManager.
10. Settles the coin into the protocol vault.
11. `assert_total_exposure(max_total_exposure_pct)` — protocol global exposure cap.
12. `manager.increase_position(key, quantity)`.
13. Emits `PositionMinted`.

Position is recorded as a `(MarketKey -> qty)` row inside `manager.positions`. There is no `Position` token / coin / object — the position is purely a row in the manager's `Table`.

### 1.3 `predict::redeem<Quote>` and friends

```move
public fun redeem<Quote>(
    predict: &mut Predict,
    manager: &mut PredictManager,
    oracle: &OracleSVI,
    key: MarketKey,
    quantity: u64,
    clock: &Clock,
    ctx: &mut TxContext,
)

public fun redeem_permissionless<Quote>(
    predict: &mut Predict,
    manager: &mut PredictManager,
    oracle: &OracleSVI,
    key: MarketKey,
    quantity: u64,
    clock: &Clock,
    ctx: &mut TxContext,
)
```

Both call the same `redeem_internal`. The difference:

- `redeem` requires `tx.sender == manager.owner` and deposits the payout via `manager.deposit` (also owner-gated).
- `redeem_permissionless` requires `oracle.is_settled()` and deposits via `manager.deposit_permissionless` (no owner check).

`redeem_internal`:

- Asserts `quoteable_oracle` (live or settled — not just active).
- `manager.decrease_position(key, quantity)` — aborts on insufficient position.
- If oracle is settled and vault has compacted that oracle's exposure, payout = settled fair price × qty. Otherwise payout is the live bid × qty.
- `vault.dispense_payout<Quote>(payout)` — note the **payout `Quote` need not be the same as the `Quote` used to mint**; outflows can use any quote with concrete vault balance, even if disabled for new inflows. This is important for forward-compat.

There is **no separate `redeem_settled` function** in `predict-testnet-4-16` — the settled path is the second arm of the `if` inside `redeem_internal`. Anyone can run the settled redemption permissionlessly via `redeem_permissionless`.

### 1.4 `oracle::is_settled` and settlement state

`oracle.move` defines four states:

- `STATUS_INACTIVE = 0`
- `STATUS_ACTIVE = 1`
- `STATUS_PENDING_SETTLEMENT = 2` — past expiry, no settlement price yet.
- `STATUS_SETTLED = 3`

```move
public fun is_settled(oracle: &OracleSVI): bool {
    oracle.settlement_price.is_some()
}

public fun settlement_price(oracle: &OracleSVI): Option<u64>

public fun status(oracle: &OracleSVI, clock: &Clock): u8
```

Settlement is frozen by **the next `update_prices` call after expiry** (in `oracle::update_prices`): if `status == PENDING_SETTLEMENT` when a price update arrives, that update's `spot` becomes the permanent `settlement_price` and the oracle is deactivated. Settlement is therefore driven by Block Scholes' keeper holding the `OracleSVICap`, not by any Wick action.

### 1.5 `predict_manager::deposit_permissionless`

```move
public(package) fun deposit_permissionless<T>(
    self: &mut PredictManager,
    coin: Coin<T>,
    ctx: &TxContext,
)
```

`public(package)` — only callable from within the `deepbook_predict` package. Wick **cannot call this directly**. It is invoked by `predict::redeem_permissionless` to deposit settled payouts back into a manager whose owner is offline. There is no version of `deposit` that bypasses the owner check at the public boundary.

Practical consequence: any DUSDC that moves into a `PredictManager.balance` must either (a) be deposited by the owner via `manager.deposit`, or (b) arrive as a redeem payout. The owner gate is unconditional for arbitrary deposits.

---

## 2. PTB shape — "Wick BTC touch open"

From the user's perspective, opening a BTC touch position via Wick is one signed PTB. The PTB:

1. Splits the user's DUSDC `Coin` to fund the premium.
2. Calls Wick's `predict_route::open_touch` entrypoint.
3. Inside that Move call, Wick mints into Predict via `predict::mint`.
4. Wick mints a `WickPredictPosition<TOUCH>` to the user as a tradeable receipt.

**TypeScript pseudocode** (assumes Wick-custodied model — see §3):

```ts
import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";

const PREDICT_PKG = "0xf5ea…5138";
const WICK_PKG    = "0x…wick";
const PREDICT_OBJ = "0xc873…028a";
const WICK_PREDICT_HUB = "0x…hub";       // Wick-owned shared PredictManager + custody
const ORACLE_BTC_15M_15500 = "0x…oracle"; // a live BTC OracleSVI
const PATH_OBS = "0x…path";              // Wick PathObservation tracking the barrier
const CLOCK = "0x6";

const tx = new Transaction();

// 1. Slice premium DUSDC off the user's coin.
const [premium] = tx.splitCoins(tx.object(userDusdcCoinId), [tx.pure.u64(premiumDusdc)]);

// 2. Open the Wick touch position. Wick orchestrates the Predict mint
//    inside a PTB sandwich around its own state changes.
const wickPosition = tx.moveCall({
    target: `${WICK_PKG}::predict_route::open_touch`,
    arguments: [
        tx.object(WICK_PREDICT_HUB),     // &mut WickPredictHub<DUSDC>
        tx.object(PREDICT_OBJ),          // &mut Predict
        tx.object(ORACLE_BTC_15M_15500), // &OracleSVI
        tx.object(PATH_OBS),             // &mut PathObservation (barrier-touch tracking)
        tx.pure.u64(strike),             // u64 (1e9-scaled USD)
        tx.pure.u64(expiryMs),
        tx.pure.bool(/* is_up_leg */ true), // see §3.2 for leg choice
        tx.pure.u64(quantity),
        premium,                         // Coin<DUSDC>
        tx.object(CLOCK),
    ],
});

// 3. Hand the receipt back to the user's wallet.
tx.transferObjects([wickPosition], tx.pure.address(userAddress));
```

Inside `predict_route::open_touch` Wick:

1. Deposits `premium` into the hub's BalanceManager (owner is the hub itself — see §3).
2. Builds `MarketKey::new(oracle_id, expiry, strike, is_up)`.
3. Calls `predict::mint<DUSDC>(predict, &mut hub.manager, oracle, key, quantity, clock, ctx)`.
4. Records the resulting `(MarketKey, qty, user, side=TOUCH)` claim in hub state.
5. Constructs a `WickPredictPosition` with `key, qty, side, hub_id` and returns it.

Because the manager owner check fires on `tx.sender`, the **PTB sender must equal the hub's owner address**. We achieve that by making the hub itself the `manager.owner` — see §3.

---

## 3. Custody model

Two designs are on the table. Wick should ship **option A (Wick-custodied via a shared "hub" object)**.

### 3.1 Option A — Wick-custodied (chosen)

Wick deploys exactly one shared `WickPredictHub<DUSDC>` per quote asset. The hub is initialized once in a bootstrap transaction:

```move
public struct WickPredictHub<phantom Quote> has key {
    id: UID,
    /// The Predict manager Wick owns.
    manager_id: ID,
    /// Wick's outstanding claims against the manager. Multiple users can
    /// hold the same MarketKey; Wick tracks aggregates here and per-user
    /// receipts via WickPredictPosition objects.
    open_qty: Table<MarketKey, u64>,
    /// Settled payouts (DUSDC) waiting to be claimed by holders of
    /// settled WickPredictPosition objects.
    settled_payouts: Table<MarketKey, u64>,
}
```

The hub's address must equal `manager.owner`. Two ways to do that:

1. Make the hub's `id.to_address()` the manager owner. Not possible — `manager.owner = ctx.sender()` at creation, and the hub has no signing key.
2. Have a dedicated **Wick admin EOA** create the manager, then transfer admin to a `HubAdminCap` that the Wick package holds. Predict has no concept of transferring manager ownership, so this also fails.

Therefore the hub design is:

- **Wick admin EOA owns the manager.** That EOA is a multisig in production; for MVP it is the deployer.
- All Wick traders sign PTBs that **pass through Wick** (`predict_route::open_touch`), and the Wick relayer co-signs as the manager owner. So every Wick BTC trade is a co-signed transaction (user + Wick relayer).

This is a step backwards from "user signs once" and merits an upgrade — see §3.2.

### 3.2 Option B — User-custodied with claim ticket

Each user creates their own `PredictManager` once (one-time bootstrap), funds it with DUSDC, and signs every Wick BTC trade. Wick holds a non-custodial **`WickClaimTicket`** that grants Wick the right to:

1. Read the position state.
2. Trigger `redeem_permissionless` after the underlying `OracleSVI` settles.
3. Reconcile the payout against the user's recorded touch / no-touch outcome.

```move
public struct WickClaimTicket has key, store {
    id: UID,
    user: address,
    user_manager: ID,
    key: MarketKey,
    qty: u64,
    side: u8,           // SIDE_TOUCH | SIDE_NO_TOUCH
    path_id: ID,
    issued_at_ms: u64,
}
```

Pros: one signer, fully non-custodial, no Wick relayer. Cons: each user pays manager-creation gas once and must keep their DUSDC inside their own `BalanceManager`.

**Choice: ship Option A for the hackathon (one-shot demo, Wick relayer is acceptable), evolve to Option B post-hackathon.** Option A's Wick-relayer co-signature can be reframed in the demo as "Wick batches Predict calls so the user signs once" — true, the user signs once, the relayer just adds its signature for the manager-owner gate.

If the hackathon judges flag custody as a smell, the fallback is Option B — the `predict_route::open_touch` signature is identical except it takes `&mut PredictManager` (the user's) and an `&mut WickClaimRegistry` instead of `&mut WickPredictHub`.

---

## 4. Settlement reconciliation

When the underlying `OracleSVI` settles (Block Scholes' keeper pushes the post-expiry price tick), Wick has to:

1. **Lock Wick's PathObservation snapshot.** Wick keeper reads `OracleSVI.spot_price` post-expiry, applies the same value as the path-observation tick that drives the barrier outcome via `wick::pull_oracle_driver::push_price` into the linked `WickOracle`. Then `wick::wick_oracle::lock_settlement_from_latest`.

2. **Drain the Predict manager's payout.** Anyone may call `predict::redeem_permissionless<DUSDC>(predict, &mut hub.manager, oracle, key, qty, clock, ctx)`. The DUSDC payout lands in the hub's `BalanceManager` via `deposit_permissionless`. Wick records `hub.settled_payouts[key] += payout`.

3. **Compute Wick winners.** The Wick `PathObservation` says whether the barrier was touched. The hub now knows:
   - Total DUSDC paid out from Predict for that key.
   - Wick's recorded `(touch_qty, no_touch_qty)` mix for that key.
   - Whether `is_touched == true` or not.

4. **Distribute to Wick position holders.** Each user calls `wick::predict_route::redeem(WickPredictPosition, &mut hub, &PathObservation, ctx)`. Wick burns the position object and pays the holder `payout_for_winning_side(stake, payout_multiplier_bps)` from `hub.settled_payouts`, decrementing that bucket.

Permissionless? Yes for steps 1, 2. Step 4 is per-user (the holder claims). Step 3 has no on-chain state — it is implicit in 4.

**Idempotency.** `redeem_permissionless` aborts on `EInsufficientPosition` after the first call drains the manager's row to zero. Wick's `predict_route::reconcile` wraps it in a guard:

```move
if (predict_manager::position(&hub.manager, key) > 0) {
    predict::redeem_permissionless<DUSDC>(predict, &mut hub.manager, oracle, key, qty, clock, ctx);
}
```

---

## 5. Keeper coordination

DeepBook Predict has its own keepers:

- **Block Scholes price keeper** — pushes `spot/forward` ~1s and `SVI` params ~10–20s. Wick does not intervene.
- **Predict settlement** is implicit in the post-expiry `update_prices` call — same keeper.

Wick's keeper for the BTC route is responsible for:

1. **Observation forwarding.** Poll the live `OracleSVI.prices.spot` every ~1s and push the same value into the Wick mirror oracle (`wick::pull_oracle_driver::push_price`). Wick uses its mirror — not the raw `OracleSVI` — to drive `PathObservation::record`. Why a mirror: keeps `WickOracle` driver-agnostic, so the Predict route stays symmetric with the SUI / SP500 / random-walk routes.
2. **Path crank.** After every push, call `path_observation::record(po, oracle, clock)` on every active path tied to the underlying. If Wick's barrier is touched, `BarrierTouched` fires and `touched_at` becomes sticky.
3. **Settlement reconciliation.** Once the underlying `OracleSVI.is_settled()` returns true (Wick keeper detects via event subscription on `OracleSettled`), the keeper:
   - Crosses the mirror over to the same settlement price (one final `push_price` with the post-expiry timestamp).
   - Calls `wick::wick_oracle::lock_settlement_from_latest`.
   - Calls `predict::redeem_permissionless<DUSDC>` on the hub for every `(key, qty)` with positive open qty — once per (oracle, key) pair, idempotent thereafter.

Failure modes (see §7) require the keeper to retry — there is no on-chain queue.

---

## 6. Hot path — Wick barrier touch fires before Predict settles

This is the case Wick exists to handle: BTC wicks past the strike at minute 7 of a 15-min window, and Wick wants to mark the touch immediately, **even though Predict's underlying `OracleSVI` will not produce a settlement price until after expiry at minute 15**.

What Wick does:

- Wick records the touch in `PathObservation` the moment any Predict price tick crosses the barrier. The `BarrierTouched` event fires immediately.
- **Wick does not early-redeem the underlying Predict position.** Predict's `redeem` (the owner-gated path) is callable while the oracle is live, but the bid quote at that moment will reflect the *current* probability, not the touch outcome — and bids fluctuate, so an early exit risks under-recovery if BTC retraces back past the strike before expiry.
- Wick's payout to the user is still owed at expiry (the Wick `Market` invariant only allows redeem after `clock >= expiry_ms`). The user collects from Wick's hub, where Wick has either (a) the early-bid recovery if Wick chose to early-exit, or (b) the post-settlement payout from `redeem_permissionless`.

For the hackathon Wick will **not** early-exit Predict — it always waits for `OracleSVI.is_settled()` and uses `redeem_permissionless`. That makes the math fully predictable: a Wick TOUCH winner is paid `stake * payout_multiplier_bps / 10_000` DUSDC funded by the hub's settled payout balance. The hub's payout multiplier is set so the protocol's expected vig covers the spread between Predict's settled payout (which depends on which leg Wick minted) and Wick's promised multiplier.

(Stretch: a future `predict_route::early_unwind` could open the bid-side equivalent in Predict the moment a Wick touch fires, locking in the value. Not in MVP.)

---

## 7. Risks

**Predict pauses.** `predict.trading_paused = true` aborts every `mint` with `ETradingPaused`. Wick's `open_touch` will revert. Existing positions are unaffected — `redeem` and `redeem_permissionless` do not check the pause flag. **Mitigation:** Wick reads `predict::trading_paused(&predict)` before quoting in the UI and grays out BTC.

**Predict upgrades.** `Predict` is a shared `key`-only object; Mysten can upgrade the package with a new ABI. Wick's hub holds an `ID` reference to the manager and the `Predict` shared object; the Move ABI is statically resolved at compile time, so an ABI-incompatible upgrade would require a Wick package upgrade. **Mitigation:** Wick's hub stores the `Predict` ID in a config row, not hard-coded; Wick uses Mysten's MVR (move version registry) reference for the package. We commit to upgrading within 24h of any breaking Predict change.

**`predict::mint` reverts mid-flow.** Possible aborts: `ETradingPaused`, `EZeroQuantity`, treasury-asset-disabled, oracle-not-active, `EAskPriceOutOfBounds`, exposure-cap exceeded. **Mitigation:** Wick's `open_touch` does a dry-run via `get_trade_amounts` before submitting, and surfaces the human-readable reason. Because the call is one PTB, an abort reverts the whole transaction including the user's premium-coin split — no half-state.

**Manager-owner key compromise.** Catastrophic in Option A: the attacker can `withdraw` all DUSDC from the hub's BalanceManager. **Mitigation:** the relayer key is a multisig in production, hot-key budget is bounded by sweeping payouts to a cold treasury after each settlement.

**Oracle never settles.** If Block Scholes' keeper goes down, `OracleSVI` stays in `STATUS_PENDING_SETTLEMENT` forever and `redeem_permissionless` aborts on `EOracleNotSettled`. Wick's mirror `WickOracle` has its own freshness check (`settlement_freshness_ms`) — past that, Wick can settle off Wick's last live observation. The hub then owes more than it has banked from Predict; covered by the hub's seeded protocol DUSDC reserve. Limit: cap per-market hub exposure to that reserve.

**Quote disabled.** If admin disables DUSDC for inflows, `predict::mint<DUSDC>` aborts. Outflows still work. Wick falls back to "BTC route closed for new business" while letting open positions drain.

---

## 8. Move pseudocode — `wick::predict_route`

```move
module wick::predict_route;

use std::string::String;
use sui::clock::Clock;
use sui::coin::Coin;
use sui::table::{Self, Table};
use deepbook_predict::predict::{Self, Predict};
use deepbook_predict::predict_manager::{Self, PredictManager};
use deepbook_predict::oracle::OracleSVI;
use deepbook_predict::market_key::{Self, MarketKey};
use wick::path_observation::{Self, PathObservation};
use wick::wick_oracle::{Self, WickOracle};

const ENotConfigured: u64 = 0;
const EWrongOracle: u64 = 1;
const EWrongPath: u64 = 2;
const EAlreadyClaimed: u64 = 3;
const ENotExpired: u64 = 4;
const EHubMismatch: u64 = 5;

const SIDE_TOUCH: u8 = 0;
const SIDE_NO_TOUCH: u8 = 1;

/// One per (Quote, Predict deployment). Wick admin owns the underlying
/// PredictManager; this hub aggregates user-side bookkeeping.
public struct WickPredictHub<phantom Quote> has key {
    id: UID,
    predict_id: ID,                    // sanity-check binding to Predict shared
    manager_id: ID,                    // and the Predict manager
    open_qty: Table<MarketKey, u64>,
    settled_payouts: Table<MarketKey, u64>,
    /// Aggregated Wick stakes per (key, side) for proportional distribution.
    touch_stake: Table<MarketKey, u64>,
    no_touch_stake: Table<MarketKey, u64>,
    /// Protocol-seeded reserve to backstop oracle-failure cases.
    reserve: sui::balance::Balance<Quote>,
}

/// Per-user receipt. Carries enough data to redeem without re-reading
/// hub Tables — minimizes shared-object contention.
public struct WickPredictPosition<phantom Quote> has key, store {
    id: UID,
    hub_id: ID,
    key: MarketKey,
    side: u8,
    stake: u64,
    payout_if_win: u64,
    path_id: ID,
}

public fun bootstrap<Quote>(
    predict: &Predict,
    manager: &PredictManager,
    seed_reserve: Coin<Quote>,
    ctx: &mut TxContext,
): WickPredictHub<Quote> { /* ... */ }

public fun open_touch<Quote>(
    hub: &mut WickPredictHub<Quote>,
    predict: &mut Predict,
    manager: &mut PredictManager,           // Option A: hub-owned manager
    oracle: &OracleSVI,
    path: &PathObservation,
    strike: u64,
    expiry_ms: u64,
    is_up_leg: bool,                        // which Predict leg backstops the hub
    quantity: u64,
    premium: Coin<Quote>,
    clock: &Clock,
    ctx: &mut TxContext,
): WickPredictPosition<Quote> {
    assert_hub_binding(hub, predict, manager);
    let key = market_key::new(object::id(oracle), expiry_ms, strike, is_up_leg);

    // 1. Deposit premium into the hub-owned PredictManager.
    predict_manager::deposit<Quote>(manager, premium, ctx);

    // 2. Mint the underlying Predict position.
    predict::mint<Quote>(predict, manager, oracle, key, quantity, clock, ctx);

    // 3. Bookkeep the user's claim.
    if (!table::contains(&hub.open_qty, key)) table::add(&mut hub.open_qty, key, 0);
    *table::borrow_mut(&mut hub.open_qty, key) =
        *table::borrow(&hub.open_qty, key) + quantity;
    bump_stake(&mut hub.touch_stake, key, /* stake */ premium_value);

    let position = WickPredictPosition<Quote> {
        id: object::new(ctx),
        hub_id: object::id(hub),
        key, side: SIDE_TOUCH,
        stake: premium_value,
        payout_if_win: mul_bps(premium_value, payout_multiplier_bps),
        path_id: object::id(path),
    };
    sui::event::emit(/* PositionOpenedViaPredict */);
    position
}

public fun open_no_touch<Quote>(/* mirrors open_touch with side = NO_TOUCH */)

/// Permissionless. Drains Predict's settled payout for `key` into the hub.
public fun reconcile<Quote>(
    hub: &mut WickPredictHub<Quote>,
    predict: &mut Predict,
    manager: &mut PredictManager,
    oracle: &OracleSVI,
    key: MarketKey,
    clock: &Clock,
    ctx: &mut TxContext,
)

/// User claims their share.
public fun redeem<Quote>(
    hub: &mut WickPredictHub<Quote>,
    position: WickPredictPosition<Quote>,
    path: &PathObservation,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<Quote>

fun assert_hub_binding<Quote>(
    hub: &WickPredictHub<Quote>,
    predict: &Predict,
    manager: &PredictManager,
) {
    assert!(hub.predict_id == object::id(predict), EHubMismatch);
    assert!(hub.manager_id == object::id(manager), EHubMismatch);
}
```

---

## 9. Verification commands

End-to-end testnet validation, from the repo root, assuming `sui client` is on testnet and the Wick admin wallet is the active address.

**Confirm Predict deployment is live:**
```bash
sui client object 0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a --json \
  | jq '.content.fields | {trading_paused, treasury_config: .treasury_config.fields.accepted_quotes}'
```
Expect `trading_paused: false`, DUSDC in the accepted_quotes set.

**Mint a fresh Wick-owned manager:**
```bash
sui client call \
  --package 0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138 \
  --module predict --function create_manager \
  --gas-budget 100000000
```
Capture the resulting `PredictManagerCreated` event's `manager_id`.

**Mint testnet DUSDC** (Predict provides a public mint helper for testnet):
```bash
sui client call \
  --package 0xf5ea…5138 --module dusdc --function mint_for_testing \
  --args 1000000000 \
  --gas-budget 100000000
```

**Bootstrap Wick hub** (after Wick package upgrade with `predict_route` module):
```bash
sui client call \
  --package $WICK_PKG --module predict_route --function bootstrap \
  --type-args 0xf5ea…5138::dusdc::DUSDC \
  --args $PREDICT_OBJ $WICK_MANAGER $WICK_DUSDC_RESERVE_COIN \
  --gas-budget 100000000
```

**Pick a live BTC oracle.** From prior research, query the `OracleActivated` events emitted by package `0xf5ea…5138` filtered to `underlying_asset == "BTC"` and unsettled. Capture the oracle ID, expiry, and choose a strike on the grid.

**Open a Wick BTC TOUCH position:**
```bash
sui client ptb \
  --split-coins gas "[10000000]" \
  --assign premium \
  --move-call $WICK_PKG::predict_route::open_touch \
    "<0xf5ea…5138::dusdc::DUSDC>" \
    @$WICK_HUB @$PREDICT_OBJ @$WICK_MANAGER @$ORACLE_BTC \
    @$PATH_OBS $STRIKE_U64 $EXPIRY_MS true 1000 premium @0x6 \
  --assign position \
  --transfer-objects "[position]" @$USER \
  --gas-budget 200000000
```

**Tick the path:**
```bash
sui client call --package $WICK_PKG --module pull_oracle_driver --function push_price \
  --args $WICK_FEED $WICK_ORACLE $KEEPER_CAP <btc_price> <ts_ms> <attestation_bytes> 0x6
sui client call --package $WICK_PKG --module path_observation --function record \
  --args $PATH_OBS $WICK_ORACLE 0x6
```

**After expiry — drain Predict and lock Wick settlement:**
```bash
sui client call --package $WICK_PKG --module wick_oracle --function lock_settlement_from_latest \
  --args $WICK_ORACLE 0x6

sui client call --package $WICK_PKG --module predict_route --function reconcile \
  --type-args 0xf5ea…5138::dusdc::DUSDC \
  --args $WICK_HUB $PREDICT_OBJ $WICK_MANAGER $ORACLE_BTC <market_key_bcs> 0x6
```

**User redeems:**
```bash
sui client call --package $WICK_PKG --module predict_route --function redeem \
  --type-args 0xf5ea…5138::dusdc::DUSDC \
  --args $WICK_HUB $POSITION $PATH_OBS 0x6
```

The end-state check: hub's `open_qty[key]` is 0, `settled_payouts[key]` is 0, and the user's wallet shows the DUSDC payout coin. Predict-side, `predict_manager::position(&manager, key)` returns 0.

This sequence is the script `scripts/predict-route-smoke.sh` should automate — it is the BTC-route equivalent of `scripts/smoke.sh` for the Wick-native arcade markets.
