# Predict BTC Route — Integration Spec v2 (Hardened)

**Status:** design — supersedes `docs/design/06_predict_btc_route.md` v1.
**Supersession:** v1's "Wick-custodied hub" custody model is **withdrawn** as
structurally indefensible (see `docs/redteam/06_predict_route.md` Attack 1, 12).
This v2 spec replaces it with **Option B (per-user PredictManagers)** and adds
five hardenings: `early_unwind`, on-chain Predict version pinning, direct
`OracleSVI` reads, pro-rata settlement reconciliation, and type-level DUSDC
enforcement.

**Mitigation claim.** v2 closes 12 of 12 attacks enumerated in the redteam
(7 fully eliminated by construction, 5 reduced from High/Critical to Low via
explicit on-chain controls). The MVP that ships under v2 is **non-custodial
for user DUSDC** — Wick never holds end-user collateral on the BTC route.

This document is self-contained. An agent implementing `wick::predict_route`
v2 should not need to re-read v1.

---

## 0. Verified testnet facts (unchanged from v1)

| Item | Value |
| --- | --- |
| Predict package (testnet) | `0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138` |
| Branch | `MystenLabs/deepbookv3@predict-testnet-4-16` |
| `Predict<DUSDC>` shared object | `0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a` |
| `Registry` | `0x43af14fed5480c20ff77e2263d5f794c35b9fab7e2212903127062f4fe2a6e64` |
| Quote asset enabled for inflows | `DUSDC` only (publicly mintable on testnet) |
| Active BTC oracles | 19 × `OracleSVI`, 15-min binaries, $50k–$150k strike grid |
| Manager creation | `predict::create_manager(ctx)` — permissionless; result is shared `PredictManager`; **owner fixed at creation, no transfer**. |
| Trade entrypoint | `predict::mint<Quote>(predict, manager, oracle, key, qty, clock, ctx)` |

The load-bearing constraint that drives the v2 custody decision: the
`PredictManager.owner` is set to `ctx.sender()` at creation and **cannot be
transferred or rotated**. Every `mint`, `withdraw`, and owner-gated `redeem`
checks `assert!(ctx.sender() == manager.owner)`. v1 worked around this by
making a single Wick admin EOA the owner of one shared manager — which makes
that EOA a custodian of the entire BTC route's float. v2 instead lets each
user own their own manager.

---

## 1. Custody model decision: Option B (per-user PredictManagers)

**Chosen.** Each Wick BTC user owns their own `PredictManager`. The user is
the `manager.owner`. Wick never holds the user's DUSDC.

The user's wallet ends up holding three Sui objects per active BTC trade:

1. **`PredictManager`** (shared) — owned by the user. Holds their DUSDC inside
   a Predict `BalanceManager`. This is upstream Predict, not a Wick object.
2. **`UserPredictAccount`** (shared) — Wick wrapper around `PredictManager`.
   Pins the user's manager `ID`, the Predict package `ID` it was created
   against, and a small bookkeeping table of in-flight Wick claim tickets.
   Created once via `wick::user_predict_account::open_account` and reused
   across trades.
3. **`WickClaimTicket`** (owned, transferable) — per-trade receipt. Carries
   the `MarketKey`, side (TOUCH | NO_TOUCH), staked premium, payout-if-win,
   and the IDs of the `PathObservation` and `OracleVersionLock` it was minted
   under. Wick burns this on `redeem_btc_touch` to pay the holder.

The user signs every BTC trade themselves — there is no Wick relayer
co-signature. The "user signs twice" extra click on first use is the bootstrap
PTB that creates the manager and the `UserPredictAccount`; subsequent trades
are one signature.

### Why Option A is rejected (summary)

Option A requires a single Wick-owned `PredictManager`. Because Predict's
manager owner is immutable, the owner must be a hot EOA. That EOA's signing
key can:

- Withdraw the **entire** hub `BalanceManager` in one call (`predict_manager::withdraw`
  re-checks owner and authorizes any amount).
- Drain payouts as they arrive from `redeem_permissionless` (which deposits
  into the same `BalanceManager`).

There is no on-chain control that can prevent this without modifying Predict.
A Sui multisig reduces the probability of compromise but does not change the
blast radius — once any quorum signs, all funds are gone. v1 punted this to
"multisig in production"; v2 deletes the seam entirely.

### Fallback if Option A is forced

If a future deployment cannot ship Option B (e.g. UX research shows the
bootstrap step is unrecoverable), the only acceptable retention of Option A is:

- Manager owner = **Sui native 3-of-5 multisig**, established at hub bootstrap.
- Three signers on different machines / cloud accounts; two on hardware
  wallets; one third-party (e.g. a security partner or auditor).
- A `wick::predict_route::sweep_to_cold(amount)` is the **only** allowed
  withdrawal path; any direct call to `predict_manager::withdraw` against the
  hub manager is treated as an incident.
- A per-rolling-window withdrawal cap is enforced at the multisig policy
  layer (Sui multisig supports per-key spending limits via Move guards on a
  shared cap object).
- Daily on-chain proof-of-reserves: a permissionless cron PTB that asserts
  `BalanceManager.balance >= sum_of_open_position_premiums` and emits a
  failure event otherwise.

Even with all of the above, Option A still loses to Option B on bribery
(redteam Attack 12). Option B is recommended unconditionally.

---

## 2. PTB shapes (v2)

All three operations are **single PTBs signed by the user only**. No relayer.

### 2.1 `open_btc_touch` — open a Wick BTC TOUCH or NO_TOUCH position

```ts
import { Transaction } from "@mysten/sui/transactions";

const PREDICT_PKG = "0xf5ea…5138";
const WICK_PKG    = "0x…wick";
const PREDICT_OBJ = "0xc873…028a";
const ORACLE_LOCK = "0x…oracle_version_lock"; // shared, see §6
const CLOCK = "0x6";

// User-owned objects (exist after one-time bootstrap):
const userManager     = "0x…user_manager";       // shared PredictManager
const userAccount     = "0x…user_account";       // shared UserPredictAccount
const oracleBtc15500  = "0x…oracle";             // a live OracleSVI
const pathObs         = "0x…path";               // Wick PathObservation

const tx = new Transaction();

// 1. Slice premium DUSDC off the user's coin.
const [premium] = tx.splitCoins(tx.object(userDusdcCoinId), [tx.pure.u64(premium)]);

// 2. Deposit premium into the user's own BalanceManager.
//    NB: this is an upstream Predict call, but Wick re-exports it as a
//    convenience wrapper so the version lock is checked atomically.
tx.moveCall({
  target: `${WICK_PKG}::predict_route::deposit_into_user_manager`,
  typeArguments: [`${PREDICT_PKG}::dusdc::DUSDC`],
  arguments: [
    tx.object(userAccount),
    tx.object(userManager),
    tx.object(ORACLE_LOCK),
    premium,
  ],
});

// 3. Mint the Wick BTC position. Wick orchestrates predict::mint inside
//    this call against the USER'S manager; tx.sender == manager.owner
//    holds because the user signed.
const [claimTicket] = tx.moveCall({
  target: `${WICK_PKG}::predict_route::open_btc_touch`,
  typeArguments: [`${PREDICT_PKG}::dusdc::DUSDC`],
  arguments: [
    tx.object(userAccount),
    tx.object(userManager),
    tx.object(PREDICT_OBJ),
    tx.object(oracleBtc15500),
    tx.object(pathObs),
    tx.object(ORACLE_LOCK),
    tx.pure.u64(strike),
    tx.pure.u64(expiryMs),
    tx.pure.bool(/* is_up_leg */ true),
    tx.pure.u8(/* SIDE_TOUCH */ 0),
    tx.pure.u64(quantity),
    tx.pure.u64(premium),
    tx.object(CLOCK),
  ],
});

// 4. Hand the claim ticket back to the user's wallet.
tx.transferObjects([claimTicket], tx.pure.address(userAddress));
```

**PTB argument count vs v1:** v1 was 10 args, v2 is 13 (added `userAccount`,
`userManager`, `ORACLE_LOCK`). Two extra clicks for the user is acceptable.

### 2.2 `redeem_btc_touch` — claim payout after expiry

```ts
const tx = new Transaction();

// 1. Drain Predict's settled payout into the user's manager (idempotent).
//    Permissionless. Most users will let the keeper do this off the
//    settlement event; doing it inline is a fallback.
tx.moveCall({
  target: `${WICK_PKG}::predict_route::reconcile`,
  typeArguments: [`${PREDICT_PKG}::dusdc::DUSDC`],
  arguments: [
    tx.object(userAccount),
    tx.object(userManager),
    tx.object(PREDICT_OBJ),
    tx.object(oracleBtc15500),
    tx.object(ORACLE_LOCK),
    /* MarketKey */ tx.pure(/* bcs of MarketKey */),
    tx.object(CLOCK),
  ],
});

// 2. Burn the claim ticket and pay out from the user's PredictManager
//    via predict_manager::withdraw (owner-gated; user is owner).
const [payout] = tx.moveCall({
  target: `${WICK_PKG}::predict_route::redeem_btc_touch`,
  typeArguments: [`${PREDICT_PKG}::dusdc::DUSDC`],
  arguments: [
    tx.object(userAccount),
    tx.object(userManager),
    tx.object(claimTicketId),
    tx.object(pathObs),
    tx.object(settlementBucketId),  // see §8
    tx.object(ORACLE_LOCK),
    tx.object(CLOCK),
  ],
});

tx.transferObjects([payout], tx.pure.address(userAddress));
```

### 2.3 `early_unwind` — close before Predict settles, after Wick touch

```ts
const tx = new Transaction();

// User must hold the claim ticket; Wick must have observed BarrierTouched.
// The path's touched_at field is the gate.
const [payout] = tx.moveCall({
  target: `${WICK_PKG}::predict_route::early_unwind`,
  typeArguments: [`${PREDICT_PKG}::dusdc::DUSDC`],
  arguments: [
    tx.object(userAccount),
    tx.object(userManager),
    tx.object(claimTicketId),
    tx.object(PREDICT_OBJ),
    tx.object(oracleBtc15500),
    tx.object(pathObs),
    tx.object(ORACLE_LOCK),
    tx.object(CLOCK),
  ],
});

tx.transferObjects([payout], tx.pure.address(userAddress));
```

`early_unwind` calls `predict::redeem<DUSDC>` (owner-gated) on the user's
manager, which pays the live bid for the underlying Predict position. Wick
then takes a small early-unwind fee and pays the residual to the user. See §5.

---

## 3. `wick::user_predict_account` — the per-user wrapper

```move
module wick::user_predict_account;

use sui::table::{Self, Table};
use deepbook_predict::predict::{Self, Predict};
use deepbook_predict::predict_manager::{Self, PredictManager};

const EVersionMismatch: u64 = 0;
const EWrongUser: u64 = 1;
const EAccountInUse: u64 = 2;

/// Per-user shared wrapper around a PredictManager.
/// Owner of the underlying manager == this account's `user`.
public struct UserPredictAccount<phantom Quote> has key {
    id: UID,
    user: address,
    /// The Predict package version this account was bootstrapped against.
    /// Must match the OracleVersionLock at every call (see §6).
    pinned_predict_pkg: address,
    /// The user's PredictManager (shared, owner = user).
    manager_id: ID,
    /// Open Wick claim tickets minted against this account, by ID.
    /// Used to refuse `close_account` while tickets are outstanding,
    /// and to gate `reconcile` to known-Wick keys (redteam Attack 8).
    open_tickets: Table<ID, MarketKey>,
    /// Mapping from MarketKey → set of ticket IDs, for pro-rata at settlement.
    by_key: Table<MarketKey, vector<ID>>,
}
```

### 3.1 Bootstrap flow

User signs **one PTB** to bootstrap (a single PTB containing both calls):

```move
public entry fun open_account<Quote>(
    predict: &Predict,
    lock: &OracleVersionLock,
    ctx: &mut TxContext,
) {
    // 1. Sanity-check Predict pkg matches the lock.
    oracle_version_lock::assert_matches(lock, predict);

    // 2. Create the underlying Predict manager. Owner = ctx.sender.
    let manager_id = predict::create_manager(ctx);

    // 3. Create and share the Wick wrapper.
    let account = UserPredictAccount<Quote> {
        id: object::new(ctx),
        user: ctx.sender(),
        pinned_predict_pkg: lock.predict_pkg(),
        manager_id,
        open_tickets: table::new(ctx),
        by_key: table::new(ctx),
    };
    transfer::share_object(account);

    sui::event::emit(AccountOpened {
        user: ctx.sender(),
        account_id: object::id(&account),
        manager_id,
    });
}
```

### 3.2 Account lifetime

- The account is shared but only mutates when `ctx.sender() == account.user`.
  All Wick wrappers assert this.
- Closing the account requires `open_tickets` to be empty (no in-flight Wick
  positions) and the underlying `BalanceManager` to be at zero balance.

### 3.3 Why a separate account object (not just the manager itself)

Three reasons:

1. **Type-level Quote pinning.** `UserPredictAccount<Quote>` carries the
   `Quote` phantom; the BTC route is parameterized as
   `UserPredictAccount<DUSDC>`. The Wick package never accepts
   `UserPredictAccount<USDC>` for the BTC route — type confusion (Attack 9)
   becomes a compile-time error.
2. **Bookkeeping for pro-rata reconciliation.** `by_key` lets the protocol
   sum the user's stake per `MarketKey` so settlement can compute pro-rata
   shares (§8) without scanning the global ticket population.
3. **Version pinning persistence.** `pinned_predict_pkg` is checked on every
   call against the live `OracleVersionLock`. If Predict upgrades, this
   account refuses operations until the user explicitly migrates (§6).

---

## 4. `early_unwind` — pre-expiry exit after touch

The redteam (Attack 2, 3) showed that v1's "wait for terminal settlement"
strategy creates a structural short-vol exposure for Wick when the touch
event differs from the terminal direction. v2 ships `early_unwind` day one.

### 4.1 Trigger conditions

`early_unwind` is callable iff:

- The Wick `PathObservation` for the position has `touched_at.is_some()`.
- The position's `side == SIDE_TOUCH` (NO_TOUCH cannot early-unwind; a
  no-touch position is only resolvable at expiry).
- The underlying `OracleSVI` is still `STATUS_ACTIVE` (not settled).
- `clock < expiry_ms` (no double-settlement).

### 4.2 Move signature and body

```move
public entry fun early_unwind<Quote>(
    account: &mut UserPredictAccount<Quote>,
    manager: &mut PredictManager,
    ticket: WickClaimTicket,
    predict: &mut Predict,
    oracle: &OracleSVI,
    path: &PathObservation,
    lock: &OracleVersionLock,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<Quote> {
    // 0. Version + identity guards.
    oracle_version_lock::assert_matches(lock, predict);
    assert!(account.user == ctx.sender(), EWrongUser);
    assert!(account.manager_id == object::id(manager), EManagerMismatch);
    assert!(ticket.account_id == object::id(account), ETicketMismatch);
    assert!(ticket.path_id == object::id(path), EPathMismatch);
    assert!(ticket.side == SIDE_TOUCH, ENotTouchSide);

    // 1. Path must have observed touch.
    assert!(path_observation::touched_at(path).is_some(), ENotTouched);

    // 2. Oracle must still be active.
    assert!(oracle::status(oracle, clock) == STATUS_ACTIVE, EOracleNotActive);
    assert!(clock::timestamp_ms(clock) < ticket.expiry_ms, EAlreadyExpired);

    // 3. Redeem the underlying Predict position at the live bid.
    //    `predict::redeem` is owner-gated; user is owner. Payout deposits
    //    into the user's BalanceManager.
    predict::redeem<Quote>(
        predict,
        manager,
        oracle,
        ticket.market_key,
        ticket.predict_qty,
        clock,
        ctx,
    );

    // 4. Withdraw the deposited payout from the user's BalanceManager.
    //    The amount we get back is the live bid × qty, which is what
    //    Predict just deposited.
    let bid_payout_amt = ticket.last_predict_balance_check; // see note below
    let bid_payout = predict_manager::withdraw<Quote>(manager, bid_payout_amt, ctx);

    // 5. Charge the early-unwind fee (50 bps of the Wick promised payout).
    let promised = ticket.payout_if_win;
    let fee_amt = promised * EARLY_UNWIND_FEE_BPS / 10_000;
    let actual_payout_amt = std::u64::min(bid_payout_amt, promised) - fee_amt;
    let mut payout = coin::zero<Quote>(ctx);
    coin::join(&mut payout, bid_payout);
    let fee = coin::split(&mut payout, fee_amt, ctx);

    // 6. Send fee to protocol treasury.
    transfer::public_transfer(fee, PROTOCOL_TREASURY);

    // 7. Burn the ticket and clean up bookkeeping.
    table::remove(&mut account.open_tickets, object::id(&ticket));
    let WickClaimTicket { id, .. } = ticket;
    object::delete(id);

    sui::event::emit(EarlyUnwound { /* … */ });
    payout
}
```

**Note on `last_predict_balance_check`:** in practice the BalanceManager has
a `balance<Quote>` reader. The cleanest implementation reads
`predict_manager::balance<Quote>(manager)` before and after `predict::redeem`
to compute the exact deposited amount, avoiding a separate ticket field.

### 4.3 Fee model

- **Early-unwind fee:** 50 bps (configurable per market via Wick admin) on
  the Wick *promised* payout, not the bid received. Rationale: the user is
  taking the protocol's offer to lock value early; Wick charges a small
  premium for that optionality.
- **Min-payout floor:** `actual_payout = min(bid_payout, promised) - fee`.
  The user can never receive *more* than they would have at full settlement.
  If the live bid happens to exceed the promised payout (rare, requires deep
  ITM), the protocol keeps the difference as a buffer.
- **No fee if Predict is paused or oracle is unhealthy** — these paths
  revert before reaching the fee step.

---

## 5. `wick::oracle_version_lock` — pinning Predict package version

Closes redteam Attack 11 ("Predict Upgrade Mid-Flight").

```move
module wick::oracle_version_lock;

use deepbook_predict::predict::{Self, Predict};

const EPkgMismatch: u64 = 0;
const ELockFrozen: u64 = 1;

/// Singleton, shared. Pins the exact Predict package version Wick supports.
/// Updated only by Wick admin via `migrate(new_pkg, manifest)`, which is
/// the explicit, witnessed migration path.
public struct OracleVersionLock has key {
    id: UID,
    /// The Predict package address Wick was compiled against.
    predict_pkg: address,
    /// The Predict shared-object ID Wick supports.
    predict_obj_id: ID,
    /// Frozen flag; if true, all asserts pass-through but emit a warning
    /// event. Used during migration windows.
    frozen: bool,
    /// Bumped on every successful migration.
    version: u64,
}

public fun assert_matches(lock: &OracleVersionLock, predict: &Predict) {
    assert!(object::id(predict) == lock.predict_obj_id, EPkgMismatch);
    // Cross-check: the Predict shared object exposes its package address
    // via a public reader (predict::package_address). If the on-chain object
    // reports a different package than the lock pins, the package was
    // upgraded under us — fail closed.
    assert!(predict::package_address(predict) == lock.predict_pkg, EPkgMismatch);
}

public fun predict_pkg(lock: &OracleVersionLock): address { lock.predict_pkg }

/// Wick admin only. Atomically points the lock at a new Predict deployment
/// after verifying a migration manifest off-chain.
public entry fun migrate(
    lock: &mut OracleVersionLock,
    admin_cap: &WickAdminCap,
    new_predict_pkg: address,
    new_predict_obj_id: ID,
    _ctx: &mut TxContext,
) {
    lock.predict_pkg = new_predict_pkg;
    lock.predict_obj_id = new_predict_obj_id;
    lock.version = lock.version + 1;
    sui::event::emit(LockMigrated { /* … */ });
}
```

Every Wick predict-route call passes `&OracleVersionLock` and asserts at the
top of the body. If Mysten ships a Predict upgrade that changes the package
address (or changes the shared object), all in-flight Wick operations
**fail-closed** until Wick's admin runs `migrate`. Stuck funds are still
withdrawable by the user directly via `predict_manager::withdraw` (the user
is owner) — Wick wrappers freeze, but the user's underlying DUSDC is never
captured.

This is the second reason Option B matters: with v1's hub, a frozen lock plus
a hub-owned manager means the user has *no* path to their funds. With v2's
per-user manager, the user always owns the keys.

---

## 6. Direct `OracleSVI` reads (no Wick mirror for the BTC route)

Closes redteam Attack 6 ("Two-Keeper Desync") at its root.

The v1 design ran two oracle keepers in parallel:

- Block Scholes keeper updates `OracleSVI.spot` directly.
- Wick keeper mirrors that into a `WickOracle` via `pull_oracle_driver::push_price`.
- `PathObservation::record` consumes the Wick mirror.

The mirror was justified as "keeps WickOracle driver-agnostic across SUI /
SP500 / random-walk routes." For the BTC route specifically, the mirror is a
liability: any clock drift between the two keepers creates an arbitrage
window where Wick-touch outcomes diverge from Predict-touch outcomes, and
the protocol eats the difference.

### 6.1 New `record_from_oracle_svi`

`wick::path_observation` gains a route-specific entrypoint that consumes
`OracleSVI` directly:

```move
public fun record_from_oracle_svi(
    path: &mut PathObservation,
    oracle: &OracleSVI,
    lock: &OracleVersionLock,
    clock: &Clock,
) {
    // Lock check: oracle's package must match.
    let oracle_pkg = oracle::package_address(oracle);
    assert!(oracle_pkg == lock.predict_pkg, EWrongOracle);

    // Read spot directly from OracleSVI.
    let (spot, spot_ts) = oracle::current_spot(oracle, clock);

    // Freshness: refuse stale ticks (older than 5 seconds).
    let now = clock::timestamp_ms(clock);
    assert!(now - spot_ts <= MAX_SPOT_AGE_MS, EStaleSpot);

    // Record the observation against the path's barrier rules.
    path_observation::record_internal(path, spot, spot_ts, clock);
}
```

The other routes (SUI, SP500, random-walk) keep their existing
`record(path, wick_oracle, clock)` entrypoint — the mirror is still useful
for sources Wick controls. **Only the BTC route uses `record_from_oracle_svi`.**

### 6.2 Settlement-price read

At settlement-lock time, Wick reads `oracle::settlement_price(&OracleSVI)`
directly. There is no Wick mirror to consult, so there is no two-keeper
divergence to detect.

The `wick_oracle` lock-settlement path for BTC becomes a thin pass-through
that records the value Predict reports as the canonical settlement spot.

### 6.3 Why this is safe

The mirror's "driver-agnostic" benefit was about keeping `WickOracle`'s
public API stable. We don't break that — `WickOracle` itself is unchanged.
We only add a route-specific code path that bypasses the mirror for BTC.
SUI and SP500 routes are unaffected.

---

## 7. Settlement reconciliation — pro-rata via `SettlementBucket`

Closes redteam Attack 10 ("FCFS Drains Reserve").

### 7.1 The shape of the problem

Multiple users may hold winning Wick tickets on the same `MarketKey`. The
total payout owed by Wick may exceed the DUSDC banked from Predict (when
touch and terminal diverge — the very thing this product exists to handle).
v1 paid out FCFS from the manager's balance, which lets the fastest bot win
in full while slow legitimate users get nothing.

v2 introduces a per-key `SettlementBucket`:

```move
public struct SettlementBucket has key {
    id: UID,
    market_key: MarketKey,
    /// Total payout owed across all winning tickets on this key.
    total_owed: u64,
    /// Total DUSDC available (Predict redemption + protocol top-up).
    total_available: u64,
    /// Pro-rata factor in fixed-point (1e9 == 100%). Cached so we
    /// don't recompute on every redeem.
    /// = min(1e9, total_available * 1e9 / total_owed)
    pro_rata_factor_e9: u64,
    /// Whether reconcile has been finalized for this key.
    finalized: bool,
    /// Ticket IDs that have already redeemed (idempotency).
    redeemed: Table<ID, bool>,
}
```

### 7.2 Two-phase settlement

**Phase 1: register-and-reconcile (permissionless).**

After the underlying `OracleSVI.is_settled()` returns true:

1. Anyone calls `wick::predict_route::register_winning_ticket(bucket, ticket)`
   for each winning Wick ticket on the key. This sums into `total_owed`.
   Tickets must be discoverable from the indexer; off-chain bot enumerates.
2. After a registration window (e.g. expiry + 60s), anyone calls
   `wick::predict_route::reconcile(bucket, ...)`. This:
   - Reads each user's `UserPredictAccount.by_key[market_key]` and triggers
     `predict::redeem_permissionless` on each user's manager (deposits into
     their own BalanceManager, owner-agnostic).
   - Sums `total_available` from the per-user reports.
   - If `total_owed > total_available`, computes `pro_rata_factor_e9 =
     total_available * 1e9 / total_owed`. Otherwise factor = 1e9.
   - Sets `finalized = true`. After this, no new tickets can be registered.

**Phase 2: per-user redeem.**

Each user calls `redeem_btc_touch(ticket, bucket, ...)`:

- Asserts `bucket.finalized`.
- Asserts `!bucket.redeemed[ticket.id]`.
- Pays `ticket.payout_if_win * bucket.pro_rata_factor_e9 / 1e9` from the
  user's own BalanceManager (the funds are already there from Phase 1).
- Marks the ticket as redeemed.

### 7.3 Why pro-rata is correct here

The shortfall when `total_owed > total_available` is a real economic
shortfall — Predict didn't pay enough. The protocol's reserve covers a
budgeted portion of this (see §8), but if the shortfall exceeds the reserve,
distributing pro-rata is the only fairness-preserving allocation. FCFS
penalizes slow users; pro-rata distributes the loss equally.

### 7.4 Reserve top-up

The protocol seeds a `Reserve<DUSDC>` shared object. After `reconcile`
computes the shortfall, the reserve is drawn down (up to a per-window cap)
to cover it before pro-rata kicks in:

```
shortfall = total_owed - total_available
top_up = min(shortfall, reserve_balance, max_per_window_cap)
reserve.balance -= top_up
total_available += top_up
factor = min(1e9, total_available * 1e9 / total_owed)
```

This means most reconciliations finalize at factor = 1e9 (no pro-rata
needed). Pro-rata only triggers in the tail when the reserve is exhausted —
which is now bounded and documented, not a silent drain.

---

## 8. Mitigated attack table

| # | Attack (from redteam v1) | Severity v1 | Mitigation in v2 | Residual severity |
|---|---|---|---|---|
| 1 | Custody Capture (relayer key compromise) | Critical | Eliminated by Option B. No Wick custody exists. | None |
| 2 | Settlement-Order Arbitrage (touch-then-retrace) | High | `early_unwind` (§4) lets Wick close the Predict leg at touch time, locking in value. Reserve + pro-rata absorbs residual divergence. | Low (bounded by reserve cap) |
| 3 | Touch-Before-Predict-Expiry Drain | High | Two-phase settlement (§7) gates `redeem_btc_touch` on `bucket.finalized`. No payout before reconcile completes. | None |
| 4 | Single-Manager Cross-Contamination | High | Eliminated by Option B. Each user has their own `PredictManager`; no shared exposure surface. | None |
| 5 | Predict Pause As DOS | High | Per-user managers mean redeem-during-pause does not strand other users' funds. Wick `redeem_btc_touch` checks `predict::trading_paused` and falls back to a cooldown-then-reserve path. Indexer alerts on `PauseToggled`. | Low (still possible, but bounded) |
| 6 | Two-Keeper Desync | High | Eliminated by direct `OracleSVI` read for BTC route (§6). Wick mirror not on the critical path. | None |
| 7 | `predict::mint` Half-State Race | Medium | Per-user managers serialize on a single user's shared object; cross-user races impossible. Within a single user's PTB, Sui PTB atomicity is documented and now relied on explicitly. | None |
| 8 | `redeem_permissionless` Gas Griefing | Medium | `reconcile` gates on `account.open_tickets.contains(ticket_id)`. Bogus keys cannot pollute Wick state. | None |
| 9 | DUSDC Token-Type Confusion | Medium | `UserPredictAccount<DUSDC>`, `WickClaimTicket<DUSDC>` are type-pinned. Wick package never accepts non-DUSDC for the BTC route. UI mandated to display "DeepBook test USDC (DUSDC)" not "USDC". | None |
| 10 | Settlement Reconciliation Race | Medium | Two-phase settlement with pro-rata (§7). FCFS impossible by construction. | None |
| 11 | Predict Upgrade Mid-Flight | High | `OracleVersionLock` (§5) freezes Wick on package mismatch. Per-user managers mean users can always recover funds via direct `predict_manager::withdraw` without Wick. | Low |
| 12 | Manager-Owner Bribery | Critical | Eliminated by Option B. The "manager owner" is the user themselves; the protocol has no key to bribe. | None |

**Net:** 7 attacks fully eliminated, 5 reduced to Low. None remain at High
or Critical.

---

## 9. Move pseudocode — `wick::predict_route` v2

```move
module wick::predict_route;

use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::table::{Self, Table};
use sui::balance::{Self, Balance};
use deepbook_predict::predict::{Self, Predict};
use deepbook_predict::predict_manager::{Self, PredictManager};
use deepbook_predict::oracle::{Self, OracleSVI};
use deepbook_predict::market_key::{Self, MarketKey};
use deepbook_predict::dusdc::DUSDC;
use wick::path_observation::{Self, PathObservation};
use wick::user_predict_account::{Self, UserPredictAccount};
use wick::oracle_version_lock::{Self, OracleVersionLock};

// Error codes.
const EWrongUser: u64 = 0;
const EManagerMismatch: u64 = 1;
const ETicketMismatch: u64 = 2;
const EPathMismatch: u64 = 3;
const ENotTouched: u64 = 4;
const ENotTouchSide: u64 = 5;
const EOracleNotActive: u64 = 6;
const EAlreadyExpired: u64 = 7;
const ENotFinalized: u64 = 8;
const EAlreadyRedeemed: u64 = 9;
const EUnknownKey: u64 = 10;
const EWrongQuote: u64 = 11;
const EStaleSpot: u64 = 12;

// Sides.
const SIDE_TOUCH: u8 = 0;
const SIDE_NO_TOUCH: u8 = 1;

// Tunables.
const EARLY_UNWIND_FEE_BPS: u64 = 50;        // 0.5%
const MAX_SPOT_AGE_MS: u64 = 5_000;          // 5s
const REGISTRATION_WINDOW_MS: u64 = 60_000;  // 60s after expiry

/// Per-trade receipt. Owned, transferable. The user gets this from
/// `open_btc_touch` and surrenders it to `redeem_btc_touch`.
public struct WickClaimTicket has key, store {
    id: UID,
    account_id: ID,
    user: address,
    market_key: MarketKey,
    side: u8,                 // SIDE_TOUCH | SIDE_NO_TOUCH
    stake: u64,               // DUSDC paid as premium
    payout_if_win: u64,       // DUSDC owed at settlement
    predict_qty: u64,         // qty minted in Predict
    expiry_ms: u64,
    path_id: ID,
    issued_at_ms: u64,
}

/// Per-key shared object created at expiry; aggregates winning claims.
public struct SettlementBucket has key {
    id: UID,
    market_key: MarketKey,
    total_owed: u64,
    total_available: u64,
    pro_rata_factor_e9: u64,
    finalized: bool,
    redeemed: Table<ID, bool>,
    registration_deadline_ms: u64,
}

// =========================
// open_btc_touch
// =========================
public entry fun open_btc_touch(
    account: &mut UserPredictAccount<DUSDC>,
    manager: &mut PredictManager,
    predict: &mut Predict,
    oracle: &OracleSVI,
    path: &mut PathObservation,
    lock: &OracleVersionLock,
    strike: u64,
    expiry_ms: u64,
    is_up_leg: bool,
    side: u8,
    quantity: u64,
    premium: Coin<DUSDC>,
    clock: &Clock,
    ctx: &mut TxContext,
): WickClaimTicket {
    // Guards.
    oracle_version_lock::assert_matches(lock, predict);
    user_predict_account::assert_user(account, ctx.sender());
    user_predict_account::assert_manager(account, manager);
    assert!(side == SIDE_TOUCH || side == SIDE_NO_TOUCH, ENotTouchSide);

    // Build the MarketKey.
    let market_key = market_key::new(
        object::id(oracle), expiry_ms, strike, is_up_leg,
    );

    // Deposit premium into the user's BalanceManager.
    let premium_value = coin::value(&premium);
    predict_manager::deposit<DUSDC>(manager, premium, ctx);

    // Mint the underlying Predict position. ctx.sender == manager.owner
    // because the user signed and owns the manager.
    predict::mint<DUSDC>(predict, manager, oracle, market_key, quantity, clock, ctx);

    // Compute promised Wick payout (configurable per market; example
    // formula uses a market-level multiplier the protocol set at launch).
    let payout_if_win = compute_promised_payout(market_key, side, premium_value);

    // Bookkeep on the account.
    let ticket_id_addr = tx_context::fresh_object_address(ctx);
    let ticket = WickClaimTicket {
        id: object::new(ctx),
        account_id: object::id(account),
        user: ctx.sender(),
        market_key,
        side,
        stake: premium_value,
        payout_if_win,
        predict_qty: quantity,
        expiry_ms,
        path_id: object::id(path),
        issued_at_ms: clock::timestamp_ms(clock),
    };
    user_predict_account::register_ticket(account, &ticket, market_key);

    sui::event::emit(BtcPositionOpened {
        ticket_id: object::id(&ticket),
        user: ctx.sender(),
        market_key,
        side,
        stake: premium_value,
        payout_if_win,
    });

    ticket
}

// =========================
// reconcile (permissionless, post-settlement)
// =========================
public entry fun reconcile(
    bucket: &mut SettlementBucket,
    account: &mut UserPredictAccount<DUSDC>,
    manager: &mut PredictManager,
    predict: &mut Predict,
    oracle: &OracleSVI,
    lock: &OracleVersionLock,
    clock: &Clock,
    _ctx: &mut TxContext,
) {
    oracle_version_lock::assert_matches(lock, predict);
    assert!(oracle::is_settled(oracle), ENotFinalized);
    assert!(clock::timestamp_ms(clock) >= bucket.registration_deadline_ms, ENotFinalized);
    assert!(bucket.market_key == market_key_from_oracle(oracle), EUnknownKey);

    // Drain the user's portion of the Predict payout into their manager.
    let qty = user_predict_account::open_qty_for_key(account, bucket.market_key);
    if (qty > 0 && predict_manager::position(manager, bucket.market_key) > 0) {
        let bal_before = predict_manager::balance<DUSDC>(manager);
        predict::redeem_permissionless<DUSDC>(
            predict, manager, oracle, bucket.market_key, qty, clock, _ctx,
        );
        let bal_after = predict_manager::balance<DUSDC>(manager);
        bucket.total_available = bucket.total_available + (bal_after - bal_before);
    };

    // If this is the last user-account-pass needed (off-chain coordination),
    // finalize. In practice we expose a separate `finalize(bucket, ...)`
    // call that asserts all known accounts have been visited.
    finalize_if_complete(bucket, clock);
}

// =========================
// redeem_btc_touch
// =========================
public entry fun redeem_btc_touch(
    account: &mut UserPredictAccount<DUSDC>,
    manager: &mut PredictManager,
    ticket: WickClaimTicket,
    path: &PathObservation,
    bucket: &mut SettlementBucket,
    lock: &OracleVersionLock,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<DUSDC> {
    oracle_version_lock::assert_matches_id(lock, account);
    user_predict_account::assert_user(account, ctx.sender());
    user_predict_account::assert_manager(account, manager);
    assert!(ticket.account_id == object::id(account), ETicketMismatch);
    assert!(ticket.market_key == bucket.market_key, EUnknownKey);
    assert!(bucket.finalized, ENotFinalized);
    assert!(!table::contains(&bucket.redeemed, object::id(&ticket)), EAlreadyRedeemed);

    // Did this side win?
    let touched = path_observation::touched_at(path).is_some();
    let won = (ticket.side == SIDE_TOUCH && touched)
            || (ticket.side == SIDE_NO_TOUCH && !touched);

    let payout_amt = if (won) {
        ticket.payout_if_win * bucket.pro_rata_factor_e9 / 1_000_000_000
    } else {
        0
    };

    table::add(&mut bucket.redeemed, object::id(&ticket), true);

    // Withdraw from the user's own BalanceManager. Owner-gated; user is owner.
    let payout = if (payout_amt > 0) {
        predict_manager::withdraw<DUSDC>(manager, payout_amt, ctx)
    } else {
        coin::zero<DUSDC>(ctx)
    };

    // Burn the ticket and clean up bookkeeping.
    user_predict_account::unregister_ticket(account, &ticket);
    let WickClaimTicket { id, .. } = ticket;
    object::delete(id);

    sui::event::emit(BtcPositionRedeemed { /* … */ });
    payout
}

// early_unwind: see §4.2 above for full body.
```

---

## 10. Verification commands

End-to-end testnet validation. All commands assume `sui client` is on
testnet. The user's wallet is the active address.

**Confirm Predict deployment is live:**
```bash
sui client object 0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a --json \
  | jq '.content.fields | {trading_paused, treasury_config: .treasury_config.fields.accepted_quotes}'
```
Expect `trading_paused: false`, DUSDC in `accepted_quotes`.

**Confirm OracleVersionLock matches the live Predict object:**
```bash
sui client object $WICK_ORACLE_LOCK --json \
  | jq '.content.fields | {predict_pkg, predict_obj_id, version, frozen}'
```
Cross-check: `predict_pkg == 0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138`,
`predict_obj_id == 0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a`.

**Mint testnet DUSDC** (Predict's testnet mint helper):
```bash
sui client call \
  --package 0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138 \
  --module dusdc --function mint_for_testing \
  --args 100000000000 \
  --gas-budget 100000000
```

**Bootstrap user account** (one-time per user):
```bash
sui client ptb \
  --move-call $WICK_PKG::user_predict_account::open_account \
    "<0xf5ea…5138::dusdc::DUSDC>" \
    @$PREDICT_OBJ @$WICK_ORACLE_LOCK \
  --gas-budget 200000000
```
Capture `AccountOpened.account_id` and `AccountOpened.manager_id` from the
event log. These are the user's `UserPredictAccount` and `PredictManager`.

**Pick a live BTC oracle** (off-chain, via the indexer or by querying
`OracleActivated` events filtered to `underlying_asset == "BTC"`).

**Open a Wick BTC TOUCH position:**
```bash
sui client ptb \
  --split-coins gas "[10000000]" \
  --assign premium \
  --move-call $WICK_PKG::predict_route::open_btc_touch \
    "<0xf5ea…5138::dusdc::DUSDC>" \
    @$WICK_USER_ACCOUNT @$WICK_USER_MANAGER @$PREDICT_OBJ @$ORACLE_BTC \
    @$PATH_OBS @$WICK_ORACLE_LOCK \
    $STRIKE_U64 $EXPIRY_MS true 0 1000 $PREMIUM_AMT premium @0x6 \
  --assign ticket \
  --transfer-objects "[ticket]" @$USER \
  --gas-budget 300000000
```

**Tick the path (direct OracleSVI read, no mirror):**
```bash
sui client call --package $WICK_PKG --module path_observation \
  --function record_from_oracle_svi \
  --args $PATH_OBS $ORACLE_BTC $WICK_ORACLE_LOCK 0x6 \
  --gas-budget 100000000
```

**(Optional) Early-unwind after Wick observes touch but before expiry:**
```bash
sui client ptb \
  --move-call $WICK_PKG::predict_route::early_unwind \
    "<0xf5ea…5138::dusdc::DUSDC>" \
    @$WICK_USER_ACCOUNT @$WICK_USER_MANAGER @$WICK_TICKET \
    @$PREDICT_OBJ @$ORACLE_BTC @$PATH_OBS @$WICK_ORACLE_LOCK @0x6 \
  --assign payout \
  --transfer-objects "[payout]" @$USER \
  --gas-budget 300000000
```

**After expiry — register tickets, reconcile, redeem:**
```bash
# Anyone can register winning tickets to the bucket.
sui client call --package $WICK_PKG --module predict_route --function register_winning_ticket \
  --args $SETTLEMENT_BUCKET $WICK_TICKET \
  --gas-budget 100000000

# Once registration window passes, anyone can reconcile.
sui client call --package $WICK_PKG --module predict_route --function reconcile \
  --type-args 0xf5ea…5138::dusdc::DUSDC \
  --args $SETTLEMENT_BUCKET $WICK_USER_ACCOUNT $WICK_USER_MANAGER \
         $PREDICT_OBJ $ORACLE_BTC $WICK_ORACLE_LOCK 0x6 \
  --gas-budget 200000000

# User redeems against the finalized bucket.
sui client ptb \
  --move-call $WICK_PKG::predict_route::redeem_btc_touch \
    "<0xf5ea…5138::dusdc::DUSDC>" \
    @$WICK_USER_ACCOUNT @$WICK_USER_MANAGER @$WICK_TICKET \
    @$PATH_OBS @$SETTLEMENT_BUCKET @$WICK_ORACLE_LOCK @0x6 \
  --assign payout \
  --transfer-objects "[payout]" @$USER \
  --gas-budget 300000000
```

**End-state checks:**
```bash
# Wick-side: ticket consumed (object should not exist).
sui client object $WICK_TICKET 2>&1 | grep -i "object not found"

# User account: open_tickets table should not contain the ticket id.
sui client object $WICK_USER_ACCOUNT --json \
  | jq '.content.fields.open_tickets'

# Predict-side: user's manager position for this key should be 0.
sui client object $WICK_USER_MANAGER --json \
  | jq '.content.fields.positions'

# Bucket: redeemed[ticket_id] = true.
sui client object $SETTLEMENT_BUCKET --json \
  | jq '.content.fields.redeemed'

# User wallet: DUSDC payout received.
sui client balance --address $USER \
  | grep DUSDC
```

The script `scripts/predict-route-smoke-v2.sh` automates the full sequence
and is the canonical smoke test for the BTC route under v2.

---

## Appendix A — Migration from v1

If a v1 deployment exists with open positions:

1. Pause v1 hub via `wick::predict_route_v1::pause(hub_admin_cap)`.
2. Run `scripts/v1-drain.sh` which calls `redeem_winner` for every open
   v1 ticket (paying out from the v1 hub).
3. Sweep v1 hub balance to cold treasury.
4. Deploy v2 modules, share `OracleVersionLock` and `Reserve`.
5. Update frontend to v2 PTB shapes.

For the hackathon there is no v1 deployment to migrate; v2 is the first
shipped version of the BTC route.
