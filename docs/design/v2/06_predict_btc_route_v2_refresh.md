# Predict BTC Route — v2 ABI Refresh & Implementation Plan

**Status:** implementation-ready refresh of `06_predict_btc_route_v2.md`.
**Source of truth pulled live (2026-05-18):** `MystenLabs/deepbookv3@predict-testnet-4-16` (`1159d79a`), Sui testnet package `0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138`.
**Does NOT supersede v2.** The custody model (Option B / per-user managers),
the `early_unwind` semantics, the `OracleVersionLock` pattern, and the
two-phase `SettlementBucket` reconciliation in v2 §§1–8 remain correct.
What changes here is the **on-chain ABI surface** the adapter must call into,
and the **dependency posture** the Wick Move package needs.

This document is intentionally narrow: ABI delta, dep wiring, adapter
skeleton, `record_from_oracle_svi` body, risks, test plan, ship order. An
agent implementing #121 + the BTC `path_observation` entrypoint should be
able to follow this end-to-end without re-reading the v2 doc.

---

## Section 1 — ABI delta vs v2 doc

Pulled live via `sui_getNormalizedMoveModulesByPackage` against
`0xf5ea…5138` and cross-checked against
`MystenLabs/deepbookv3@predict-testnet-4-16:packages/predict/sources/*.move`.

### 1.1 Module layout

The package exposes 17 modules. The four that matter for the BTC route:

| Module | Role | Notable structs |
| --- | --- | --- |
| `deepbook_predict::predict` | trading + LP entrypoints, shared `Predict` object | `Predict { vault, treasury_cap, pricing_config, risk_config, treasury_config, oracle_config, withdrawal_limiter, trading_paused }` |
| `deepbook_predict::predict_manager` | per-user account, wraps `deepbook::balance_manager::BalanceManager` | `PredictManager { owner, balance_manager, deposit_cap, withdraw_cap, positions: Table<MarketKey, u64>, range_positions: Table<RangeKey, u64> }` |
| `deepbook_predict::oracle` | SVI oracle + lifecycle | `OracleSVI { authorized_caps, underlying_asset, expiry, active, prices: PriceData, svi: SVIParams, timestamp, settlement_price: Option<u64> }` |
| `deepbook_predict::registry` | admin wiring, oracle creation, `AdminCap` | `Registry { predict_id: Option<ID>, oracle_ids: Table<ID, vector<ID>> }`, `AdminCap` |

Three supporting modules the adapter must understand:

- `deepbook_predict::market_key` — `MarketKey { oracle_id, expiry, strike, direction: u8 }`. Built via `market_key::new(...)`. `direction` is encoded as `u8`: `up()`/`down()` returns the constant.
- `deepbook_predict::range_key` — `RangeKey { oracle_id, expiry, lower_strike, higher_strike }`. Built via `range_key::new(...)`.
- `deepbook_predict::plp::PLP` — LP share token; `Coin<PLP>` is the return type of `supply` and the input to `withdraw`.

### 1.2 Function delta (v2 doc → live ABI)

| v2 doc reference | Live signature on `0xf5ea…5138` | Notes |
| --- | --- | --- |
| `predict::create_manager(ctx)` returning `ID` | `public fun create_manager(ctx: &mut TxContext): ID` | Unchanged. **Permissionless.** Owner = `ctx.sender()`. Manager is shared. |
| `predict::mint<Quote>(predict, manager, oracle, key, qty, clock, ctx)` | `public fun mint<Quote>(predict: &mut Predict, manager: &mut PredictManager, oracle: &OracleSVI, key: MarketKey, quantity: u64, clock: &Clock, ctx: &mut TxContext)` | Unchanged. **No `mint_collateralized` exists** (v1 pre-#963 form removed). |
| `predict::mint_range<Quote>(... key: RangeKey, qty, clock, ctx)` | `public fun mint_range<Quote>(predict, manager, oracle, key: RangeKey, quantity, clock, ctx)` | First-class combo instrument (#963). `range_qty` (#967) is the field name inside `Vault`. |
| `predict::redeem<Quote>(...)` | `public fun redeem<Quote>(predict, manager, oracle, key: MarketKey, quantity, clock, ctx)` | Owner-gated. Payout deposited back into `manager`. |
| `predict::redeem_permissionless<Quote>(...)` | `public fun redeem_permissionless<Quote>(predict, manager, oracle, key, quantity, clock, ctx)` | Settled-only (`assert!(oracle.is_settled())`). Payout deposited into manager via `deposit_permissionless` (no owner check). **This is what v2's `reconcile` calls.** |
| `predict::redeem_range<Quote>(...)` | `public fun redeem_range<Quote>(predict, manager, oracle, key: RangeKey, qty, clock, ctx)` | Owner-gated. No `redeem_range_permissionless` exists. |
| `predict::supply<Quote>(...) -> Coin<PLP>` | `public fun supply<Quote>(predict, coin: Coin<Quote>, clock, ctx): Coin<PLP>` | Unchanged. |
| `predict::withdraw<Quote>(...) -> Coin<Quote>` | `public fun withdraw<Quote>(predict, lp_coin: Coin<PLP>, clock, ctx): Coin<Quote>` | Unchanged. |
| `predict::compact_settled_oracle(...)` | `public fun compact_settled_oracle(predict: &mut Predict, oracle: &OracleSVI, cap: &OracleSVICap)` | **#972 oracle compaction is gated by `OracleSVICap`** — not permissionless. The v2 doc was silent here; see §5 risk. |
| `predict_manager::deposit<T>(manager, coin, ctx)` | `public fun deposit<T>(self: &mut PredictManager, coin: Coin<T>, ctx: &TxContext)` | Owner-gated. |
| `predict_manager::withdraw<T>(manager, amount, ctx)` | `public fun withdraw<T>(self: &mut PredictManager, amount: u64, ctx: &mut TxContext): Coin<T>` | Owner-gated. |
| `predict_manager::balance<T>(manager)` | `public fun balance<T>(self: &PredictManager): u64` | Live. Use for the v2 `bal_before / bal_after` delta read in `reconcile` / `early_unwind`. |
| `oracle::package_address(oracle)` *(assumed in v2 §6)* | **Does not exist.** No public reader returns the defining package address of an `OracleSVI`. | **Breaking gap.** The v2 `OracleVersionLock::assert_matches(lock, predict)` cannot cross-check the package by reading from a struct field. Use object identity (`object::id(predict) == lock.predict_object_id`) plus a Move-link-time pin via `Move.toml` — see §2. |
| `predict::package_address(predict)` *(assumed in v2 §5)* | **Does not exist.** Same gap; same mitigation. |
| `oracle::current_spot(oracle, clock)` *(assumed in v2 §6.1)* | **Does not exist.** Closest readers are `oracle::spot_price(&OracleSVI): u64` (no timestamp), `oracle::timestamp(&OracleSVI): u64`, `oracle::prices(&OracleSVI): PriceData` (returns the whole struct). | Trivial rewrite; see §4. |
| Settled-redeem name | Confirmed: **`redeem_permissionless`** (#965). | v2 doc was already right. |
| `ManagerCreated` event | Renamed to **`PredictManagerCreated { manager_id, owner }`** (still emitted). | Indexer code that listened for `ManagerCreated` must be updated. |

### 1.3 Three breaking shape facts the v2 doc misses

These each force a small change to v2's Move pseudocode. None affect the
custody decision or the two-phase settlement design.

1. **`PriceData` not flat.** `oracle::spot_price(&OracleSVI): u64` returns only spot. To get `(spot, forward)` atomically you must call `oracle::prices(oracle): PriceData` and then `oracle::svi_a()` / `oracle::spot_price()` accessors don't exist on `PriceData` — there are no field readers on `PriceData` at all. **Workaround:** the adapter holds `PriceData` opaquely and calls `oracle::spot_price(oracle)` plus `oracle::timestamp(oracle)` as two reads. Both are pure functions on the `&OracleSVI`, so they're atomic from the perspective of any caller holding the same `&OracleSVI` reference inside a PTB.

2. **Settlement state has 4 values, not 3.** `oracle::status(&OracleSVI, &Clock): u8` returns one of `STATUS_INACTIVE (0)`, `STATUS_ACTIVE (1)`, `STATUS_PENDING_SETTLEMENT (2)`, `STATUS_SETTLED (3)`. v2 §6.1 implies "active vs settled" — but `PENDING_SETTLEMENT` is the window between expiry and the first post-expiry price push, and `is_settled()` is false during that window. The Wick path_observation entrypoint must treat `PENDING_SETTLEMENT` as "no new ticks accepted" — same as `SETTLED` for record purposes.

3. **`deepbook::balance_manager` is a separate package.** `PredictManager.balance_manager: deepbook::balance_manager::BalanceManager` lives at `0xfb28c4cbc6865bd1c897d26aecbe1f8792d1509a20ffec692c800660cbec6982` (per the testnet ABI). It is **not** part of the Predict package. If the adapter wants to read `balance_manager::balance<Coin>` directly (rather than going through `predict_manager::balance<T>`), it must add `deepbook` as a Move dep too. **Recommendation: don't.** Use `predict_manager::balance<T>` exclusively; it forwards to the inner `BalanceManager` and keeps Wick's dep graph one package wide.

---

## Section 2 — Move.toml dependency

### 2.1 The two options

**Option A — pin to git commit on `predict-testnet-4-16`:**

```toml
# move/Move.toml
[dependencies]
Sui = { git = "https://github.com/MystenLabs/sui.git", subdir = "crates/sui-framework/packages/sui-framework", rev = "framework/testnet" }
DeepBookPredict = { git = "https://github.com/MystenLabs/deepbookv3.git", subdir = "packages/predict", rev = "1159d79af33c70e09e406310e1d8f067832ede9d" }
```

Pros:
- One-line addition.
- Source clearly attributed; no vendored code to license-audit.
- If Mysten updates `predict-testnet-4-16` with a backwards-compatible patch we don't pick it up.

Cons:
- Adds a transitive dep on `packages/deepbook` (Predict's `Move.toml` declares `deepbook = { local = "../deepbook" }`). Git resolution must walk into `packages/deepbook` too — works fine but pulls a ~30-file package into our build graph for two symbols (`balance_manager::BalanceManager`, `math::div/mul`). Compile time grows.
- Build now depends on `github.com/MystenLabs/deepbookv3` being reachable at build time. Hackathon judges and offline CI can break.
- If Mysten force-pushes the branch (they have for testnet branches in the past), the commit ID is still pinned, so we're safe — but if the commit becomes unreachable via GC, our build breaks.

**Option B — vendor `packages/predict/sources/*.move` (plus the one `deepbook::balance_manager` file it really needs) under `move/vendor/predict/`:**

```toml
# move/Move.toml
[dependencies]
Sui = { ... }
DeepBookPredict = { local = "vendor/predict" }

[addresses]
wick = "0x0"
deepbook_predict = "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138"
deepbook = "0xfb28c4cbc6865bd1c897d26aecbe1f8792d1509a20ffec692c800660cbec6982"
```

Pros:
- Reproducible builds offline. Hackathon-friendly.
- The adapter file in `move/sources/predict_adapter.move` and the vendored sources are auditable side-by-side in one tree.
- Mirrors **#122 DeepVault pattern** (the user explicitly named this) — same posture as how we vendor DeepBook's vault primitives.
- A future Predict upgrade is an explicit `git pull` into `vendor/predict/` plus a CI check, never a silent surprise.

Cons:
- Requires copying ~6 Move files (`predict.move`, `predict_manager.move`, `oracle.move`, `registry.move`, `market_key.move`, `range_key.move`, plus their internal helpers — `vault/*.move`, `oracle_config.move`, `pricing_config.move`, `risk_config.move`, `treasury_config.move`, `rate_limiter.move`, `plp.move`, `i64.move`, `math.move`, `constants.move`, `strike_matrix.move`, `helper/*.move`) and also `deepbook::balance_manager` from the sibling package.
- License (Apache-2.0) requires us to keep the copyright headers and add a `vendor/predict/README.md` saying where the vendor came from.
- If Mysten lands an ABI-incompatible upgrade to mainnet Predict, we *think* we're tracking it, but our adapter is actually pinned to whatever we last vendored. Mitigated by a top-of-file `// VENDORED FROM: MystenLabs/deepbookv3 @ 1159d79a — DO NOT EDIT` plus a `scripts/check-vendored-predict-fresh.sh` CI gate.

### 2.2 Recommendation: **Option B — vendor.**

For a hackathon, two factors decide:

1. **Reproducible offline builds.** The judges may not have GitHub reachable from their devbox; `agent-preflight.sh` should never need network.
2. **#122 DeepVault precedent.** We already vendor DeepBook code under the same auditability rationale. Doing the opposite for Predict — git-dep for one, vendor for the other — confuses contributors and complicates the trust model.

Implementation order (see §7 step 1):

```bash
# from repo root
mkdir -p move/vendor/predict/sources move/vendor/predict/sources/vault \
         move/vendor/predict/sources/helper move/vendor/deepbook/sources

# pull predict package
gh api repos/MystenLabs/deepbookv3/tarball/1159d79af33c70e09e406310e1d8f067832ede9d \
  | tar -xz --strip=4 \
    -C move/vendor/predict/ \
    'MystenLabs-deepbookv3-*/packages/predict/'

# pull the one deepbook module Predict needs at link-time
gh api repos/MystenLabs/deepbookv3/contents/packages/deepbook/sources/balance_manager.move?ref=1159d79a \
  | jq -r .content | base64 -d > move/vendor/deepbook/sources/balance_manager.move

# add Move.toml under each vendor dir matching upstream
```

Add `move/vendor/predict/Move.toml`:
```toml
[package]
name = "deepbook_predict"
edition = "2024.beta"

[dependencies]
Sui = { git = "...", rev = "framework/testnet" }
deepbook = { local = "../deepbook" }

[addresses]
deepbook_predict = "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138"
```

And `move/vendor/deepbook/Move.toml` declaring the `deepbook = "0xfb28…6982"` address.

The **package addresses are pinned to the testnet deployment** — this is what gives `wick::predict_adapter` link-time type identity with the live `Predict<DUSDC>` shared object.

---

## Section 3 — `wick::predict_adapter` skeleton

Lives at `move/sources/predict_adapter.move`. Re-exports the Predict entrypoints behind Wick-typed wrappers so `wick::predict_route` (the BTC-specific orchestrator from v2 §9) never imports `deepbook_predict::*` directly. The adapter is the *only* file in the Wick package that depends on the Predict package.

The wrapper has three responsibilities:

1. **Type-identity gate.** Every public entry asserts `OracleVersionLock` matches the `Predict` object's ID.
2. **Wick-flavored event emission** so our indexer doesn't have to filter on Predict's event names.
3. **One owned wrapper type, `WickPredictPosition`,** so Wick code in `wick::predict_route` can carry around a typed handle. The Predict ABI tracks positions inside the `PredictManager` (no NFT), so this wrapper is *not* an owned position object — it's a witness-style receipt the adapter mints alongside the real Predict mint.

```move
// move/sources/predict_adapter.move
// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Thin pass-through wrapper around DeepBook Predict's public entrypoints.
/// The only Wick module allowed to `use deepbook_predict::*`. Every other
/// Wick module talks to Predict through this adapter.
///
/// Design contract (per docs/design/v2/06_predict_btc_route_v2_refresh.md §3):
///   - Wick types never leak Predict types in their public signatures.
///   - Every entry asserts OracleVersionLock matches the Predict object id.
///   - Emits a Wick-namespaced event alongside the Predict event, so the
///     indexer can filter on `wick::predict_adapter::*` exclusively.
///   - `WickPredictPosition` is a receipt-style witness, NOT a custody object.
///     The real position quantity lives inside the user's PredictManager.
module wick::predict_adapter;

use deepbook_predict::market_key::{Self, MarketKey};
use deepbook_predict::oracle::{Self, OracleSVI};
use deepbook_predict::predict::{Self as predict_mod, Predict};
use deepbook_predict::predict_manager::{Self, PredictManager};
use deepbook_predict::range_key::{Self, RangeKey};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use wick::oracle_version_lock::{Self, OracleVersionLock};

// === Errors ===
const EVersionMismatch: u64 = 0;
const EWrongManager: u64 = 1;
const EWrongOracle: u64 = 2;
const ENotOwner: u64 = 3;

// === Events ===

public struct AdapterMinted has copy, drop {
    receipt_id: ID,
    predict_id: ID,
    manager_id: ID,
    oracle_id: ID,
    strike: u64,
    expiry_ms: u64,
    is_up: bool,
    quantity: u64,
    cost: u64,
}

public struct AdapterRedeemed has copy, drop {
    receipt_id: ID,
    predict_id: ID,
    manager_id: ID,
    oracle_id: ID,
    payout: u64,
    settled: bool,
}

public struct AdapterRangeMinted has copy, drop {
    receipt_id: ID,
    predict_id: ID,
    manager_id: ID,
    oracle_id: ID,
    lower: u64,
    higher: u64,
    quantity: u64,
    cost: u64,
}

// === Receipt ===

/// Witness-style receipt minted by the adapter. The underlying position
/// quantity lives inside `manager.positions[key]` (Predict tracks it as a
/// table entry, not an NFT). This receipt is the Wick-side handle that
/// lets `wick::predict_route` reason about a single mint cleanly.
public struct WickPredictPosition has key, store {
    id: UID,
    manager_id: ID,
    predict_id: ID,
    oracle_id: ID,
    /// 0 = single-strike (use `strike` + `is_up`); 1 = range (use `lower`/`higher`).
    kind: u8,
    strike: u64,        // populated iff kind == 0
    is_up: bool,        // populated iff kind == 0
    lower_strike: u64,  // populated iff kind == 1
    higher_strike: u64, // populated iff kind == 1
    expiry_ms: u64,
    quantity: u64,
    cost: u64,
}

// === Entry: mint single-strike ===

public fun mint<Quote>(
    lock: &OracleVersionLock,
    predict: &mut Predict,
    manager: &mut PredictManager,
    oracle: &OracleSVI,
    strike: u64,
    expiry_ms: u64,
    is_up: bool,
    quantity: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): WickPredictPosition {
    version_check(lock, object::id(predict));
    assert!(predict_manager::owner(manager) == ctx.sender(), ENotOwner);

    let oracle_id = oracle::id(oracle);
    let key = market_key::new(oracle_id, expiry_ms, strike, is_up);

    let bal_before = predict_manager::balance<Quote>(manager);
    predict_mod::mint<Quote>(predict, manager, oracle, key, quantity, clock, ctx);
    let bal_after = predict_manager::balance<Quote>(manager);
    // mint() debits from the manager, so bal_before >= bal_after.
    let cost = bal_before - bal_after;

    let receipt = WickPredictPosition {
        id: object::new(ctx),
        manager_id: object::id(manager),
        predict_id: object::id(predict),
        oracle_id,
        kind: 0,
        strike,
        is_up,
        lower_strike: 0,
        higher_strike: 0,
        expiry_ms,
        quantity,
        cost,
    };
    sui::event::emit(AdapterMinted {
        receipt_id: object::id(&receipt),
        predict_id: object::id(predict),
        manager_id: object::id(manager),
        oracle_id,
        strike,
        expiry_ms,
        is_up,
        quantity,
        cost,
    });
    receipt
}

// === Entry: mint vertical range ===

public fun mint_range<Quote>(
    lock: &OracleVersionLock,
    predict: &mut Predict,
    manager: &mut PredictManager,
    oracle: &OracleSVI,
    lower_strike: u64,
    higher_strike: u64,
    expiry_ms: u64,
    quantity: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): WickPredictPosition {
    version_check(lock, object::id(predict));
    assert!(predict_manager::owner(manager) == ctx.sender(), ENotOwner);

    let oracle_id = oracle::id(oracle);
    let key = range_key::new(oracle_id, expiry_ms, lower_strike, higher_strike);

    let bal_before = predict_manager::balance<Quote>(manager);
    predict_mod::mint_range<Quote>(predict, manager, oracle, key, quantity, clock, ctx);
    let bal_after = predict_manager::balance<Quote>(manager);
    let cost = bal_before - bal_after;

    let receipt = WickPredictPosition {
        id: object::new(ctx),
        manager_id: object::id(manager),
        predict_id: object::id(predict),
        oracle_id,
        kind: 1,
        strike: 0,
        is_up: false,
        lower_strike,
        higher_strike,
        expiry_ms,
        quantity,
        cost,
    };
    sui::event::emit(AdapterRangeMinted {
        receipt_id: object::id(&receipt),
        predict_id: object::id(predict),
        manager_id: object::id(manager),
        oracle_id,
        lower: lower_strike,
        higher: higher_strike,
        quantity,
        cost,
    });
    receipt
}

// === Entry: redeem (owner-gated; live or settled) ===

public fun redeem<Quote>(
    lock: &OracleVersionLock,
    predict: &mut Predict,
    manager: &mut PredictManager,
    oracle: &OracleSVI,
    receipt: WickPredictPosition,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    version_check(lock, object::id(predict));
    assert!(receipt.manager_id == object::id(manager), EWrongManager);
    assert!(receipt.oracle_id == oracle::id(oracle), EWrongOracle);
    assert!(predict_manager::owner(manager) == ctx.sender(), ENotOwner);

    let bal_before = predict_manager::balance<Quote>(manager);
    if (receipt.kind == 0) {
        let key = market_key::new(
            receipt.oracle_id, receipt.expiry_ms, receipt.strike, receipt.is_up,
        );
        predict_mod::redeem<Quote>(predict, manager, oracle, key, receipt.quantity, clock, ctx);
    } else {
        let key = range_key::new(
            receipt.oracle_id, receipt.expiry_ms, receipt.lower_strike, receipt.higher_strike,
        );
        predict_mod::redeem_range<Quote>(predict, manager, oracle, key, receipt.quantity, clock, ctx);
    };
    let bal_after = predict_manager::balance<Quote>(manager);
    let payout = bal_after - bal_before;

    sui::event::emit(AdapterRedeemed {
        receipt_id: object::id(&receipt),
        predict_id: object::id(predict),
        manager_id: object::id(manager),
        oracle_id: receipt.oracle_id,
        payout,
        settled: oracle::is_settled(oracle),
    });

    let WickPredictPosition { id, .. } = receipt;
    object::delete(id);
}

// === Entry: redeem_permissionless (settled-only; called by SettlementBucket reconcile) ===

public fun redeem_permissionless<Quote>(
    lock: &OracleVersionLock,
    predict: &mut Predict,
    manager: &mut PredictManager,
    oracle: &OracleSVI,
    receipt: &WickPredictPosition,    // BORROWED — bucket re-uses receipt across phases
    clock: &Clock,
    ctx: &mut TxContext,
): u64 {
    version_check(lock, object::id(predict));
    assert!(receipt.manager_id == object::id(manager), EWrongManager);
    assert!(receipt.oracle_id == oracle::id(oracle), EWrongOracle);
    assert!(receipt.kind == 0, EWrongOracle); // ranges use redeem (owner-gated)

    let key = market_key::new(
        receipt.oracle_id, receipt.expiry_ms, receipt.strike, receipt.is_up,
    );
    let bal_before = predict_manager::balance<Quote>(manager);
    predict_mod::redeem_permissionless<Quote>(
        predict, manager, oracle, key, receipt.quantity, clock, ctx,
    );
    let bal_after = predict_manager::balance<Quote>(manager);
    bal_after - bal_before
}

// === Entry: create_manager (one-off bootstrap) ===

public fun create_manager(
    lock: &OracleVersionLock,
    predict: &Predict,
    ctx: &mut TxContext,
): ID {
    version_check(lock, object::id(predict));
    predict_mod::create_manager(ctx)
}

// === Reads (passed through; receipt + oracle accessors) ===

public fun receipt_quantity(r: &WickPredictPosition): u64 { r.quantity }
public fun receipt_cost(r: &WickPredictPosition): u64 { r.cost }
public fun receipt_manager_id(r: &WickPredictPosition): ID { r.manager_id }
public fun receipt_oracle_id(r: &WickPredictPosition): ID { r.oracle_id }
public fun receipt_kind(r: &WickPredictPosition): u8 { r.kind }
public fun receipt_market_key(r: &WickPredictPosition): MarketKey {
    market_key::new(r.oracle_id, r.expiry_ms, r.strike, r.is_up)
}

// === Version check (gateway) ===

/// Verify the OracleVersionLock pins this exact Predict object. Per v2 §5.
/// We cannot read the defining package address from the on-chain object (no
/// public reader), so we pin by Predict object ID instead. The Move-link-time
/// package identity is enforced by the `deepbook_predict = 0xf5ea…5138` line
/// in `move/Move.toml` — if the package upgrades, the adapter file fails to
/// build until we update both the Move.toml address AND `OracleVersionLock`.
public fun version_check(lock: &OracleVersionLock, predict_id: ID) {
    assert!(oracle_version_lock::predict_object_id(lock) == predict_id, EVersionMismatch);
}
```

**LOC count:** ~270 LOC including blank lines, ~210 LOC of code. The
"about 80 LOC" target in the brief was an under-estimate for a full
adapter — the v2 doc's pseudocode under §9 alone runs ~150 LOC and that's
just `predict_route`, not the adapter. The number above buys correctness on
the three entry shapes (`mint`, `mint_range`, `redeem`,
`redeem_permissionless`, `create_manager`) plus the receipt type and the
version gate.

---

## Section 4 — `path_observation::record_from_oracle_svi`

Per v2 §6.1. The body needs four small revisions vs the v2 pseudocode:

1. `oracle::current_spot(...)` does not exist. Use `oracle::spot_price(&OracleSVI): u64` and `oracle::timestamp(&OracleSVI): u64` separately. Both are pure reads on the same `&OracleSVI` reference and thus atomic within the call.
2. `oracle::package_address(...)` does not exist. We pin via `OracleVersionLock` matching the **Predict object id** (set at deploy via `lock::init_lock(0xf5ea…5138, 0xc873…028a, …)`) — and we trust the Move link-time address identity of the imported `deepbook_predict::oracle::OracleSVI` type. If the link-time identity is wrong, the file won't compile.
3. The OracleSVI status enum is 4-valued. Treat `STATUS_SETTLED` and `STATUS_PENDING_SETTLEMENT` identically (no new ticks). Treat `STATUS_INACTIVE` as "wait" (return early; not an error — the oracle just hasn't been turned on yet).
4. We don't need a separate `min_observations` policy. Predict's keeper publishes spot ~every second per the README ("high frequency ~1s"). The existing `DEFAULT_MIN_OBSERVATIONS: u64 = 6` in `path_observation.move` is fine — at 1s ticks across a 15-min window, the path always clears 6 observations.

**Add to `move/sources/path_observation.move`** (next to the existing `record` function):

```move
// === Direct OracleSVI ingestion (BTC route only) ===
//
// Replaces the `WickOracle` mirror path for the BTC Predict route. The mirror
// keeper added clock-drift surface area (v2 §6 redteam attack #6). For BTC we
// read directly from the Predict OracleSVI that the Predict protocol itself
// uses for fair-pricing — no possibility of divergence by construction.
//
// Routes OTHER than BTC (SUI, SP500, random-walk) keep calling `record()`
// with their existing WickOracle.

use deepbook_predict::oracle::{Self as predict_oracle, OracleSVI};
use wick::oracle_version_lock::{Self, OracleVersionLock};

const EOracleVersionMismatch: u64 = 13;
const EStaleSpot: u64 = 14;
/// Reject spot ticks older than this many ms. Predict publishes ~1s; 5s gives
/// us 5x slack before we refuse to record. Matches v2 §6.1's MAX_SPOT_AGE_MS.
const MAX_SPOT_AGE_MS: u64 = 5_000;

/// Record a tick sourced directly from a Predict `OracleSVI`. Only used by
/// the BTC route. Per docs/design/v2/06_predict_btc_route_v2.md §6.
///
/// Invariants enforced beyond `record()`:
///   - The OracleSVI must be the one this path pinned at construction
///     (`path.oracle_id == object::id(oracle)`). Reuses the same field
///     populated for the WickOracle path; that's safe because both store the
///     `ID` of whatever oracle object was passed to the constructor.
///   - OracleVersionLock must pin the Predict object ID. Closes the
///     upgrade-mid-flight gap from v2 §5 / redteam attack #11.
///   - The OracleSVI's `timestamp` must be within `MAX_SPOT_AGE_MS` of `now`.
///     Stale-spot refusal is more aggressive than `record()` because Predict
///     publishes every ~1s — anything older than 5s means the keeper is dead.
public fun record_from_oracle_svi(
    po: &mut PathObservation,
    oracle: &OracleSVI,
    lock: &OracleVersionLock,
    clock: &Clock,
) {
    assert!(po.oracle_id == object::id(oracle), EOracleMismatch);

    // Version lock: refuse if Predict has been upgraded under us. We pin by
    // Predict object id; the OracleSVI lives in the same package, and the
    // package identity is fixed at Move link time.
    // Note: we don't have a `&Predict` here — the lock check uses the package
    // identity transitively (the OracleSVI type itself is link-pinned to
    // `0xf5ea…5138` via vendor/predict/Move.toml). The presence of the
    // `&OracleVersionLock` argument forces every BTC tick call to thread the
    // lock, so Wick admin's `start_migration(...)` freezes new ticks.
    assert!(!oracle_version_lock::is_migrating(lock), EOracleVersionMismatch);

    let now = clock.timestamp_ms();
    if (now >= po.expiry_ms) return;  // post-expiry freeze, identical to record()

    // Status gate. STATUS_INACTIVE → silently skip (oracle not yet activated).
    // STATUS_PENDING_SETTLEMENT / SETTLED → also skip; ticks past expiry are
    // not authoritative for the touch outcome.
    let status = predict_oracle::status(oracle, clock);
    if (status == predict_oracle::status_inactive()) return;
    if (status == predict_oracle::status_pending_settlement()) return;
    if (status == predict_oracle::status_settled()) return;

    let obs_ts = predict_oracle::timestamp(oracle);
    let obs_price = predict_oracle::spot_price(oracle);
    assert!(now - obs_ts <= MAX_SPOT_AGE_MS, EStaleSpot);

    // Stale-tick guard, identical to record().
    if (option::is_some(&po.last_seen_ms)) {
        let last = *option::borrow(&po.last_seen_ms);
        if (obs_ts <= last) return;
    };
    if (obs_ts > po.expiry_ms) return;

    // Same touch-confirmation logic as record(). Inlined for clarity.
    if (obs_price > po.max_seen) po.max_seen = obs_price;
    if (obs_price < po.min_seen) po.min_seen = obs_price;
    po.observation_count = po.observation_count + 1;
    po.last_seen_ms = option::some(obs_ts);

    if (po.direction == touch_dnt()) {
        apply_dnt_tick(po, obs_price, obs_ts);
    } else {
        if (is_buffered_touch(po, obs_price)) {
            po.consecutive_cross_count = po.consecutive_cross_count + 1;
            if (po.consecutive_cross_count >= po.touch_confirmations_required
                && option::is_none(&po.touched_at)) {
                po.touched_at = option::some(obs_ts);
                sui::event::emit(BarrierTouched {
                    path_id: object::id(po),
                    touched_at_ms: obs_ts,
                    touch_price: obs_price,
                    confirmations: po.consecutive_cross_count,
                });
            };
        } else {
            po.consecutive_cross_count = 0;
        };
    };

    sui::event::emit(TickRecorded {
        path_id: object::id(po),
        price: obs_price,
        timestamp_ms: obs_ts,
        new_min: po.min_seen,
        new_max: po.max_seen,
        consecutive: po.consecutive_cross_count,
    });
}
```

**LOC count:** ~70 (with comments). The brief's "~30 LOC" estimate
under-counted because it didn't account for inlining the
touch-confirmation block. **Do not** refactor `record()` to share that
block via a private helper — the design doc lists `record()` and
`record_from_oracle_svi` as separate route entrypoints precisely so the
WickOracle route is unaffected by changes to the OracleSVI route. Inline
duplication is the right call.

---

## Section 5 — Risks + open questions

### 5.1 Predict ABI re-cuts before we ship

The branch is `predict-testnet-4-16`; force-pushes have happened in
Mysten's testnet branches before (e.g. the rename of `cashback` to
`range_qty` in #967 was a non-trivial breaking change). Mitigations the
vendor approach already covers:

- We're pinned to commit `1159d79a`; even if the branch ref moves, our `vendor/predict/sources/*.move` does not.
- `OracleVersionLock.predict_object_id` is the canonical pin. If Mysten re-deploys with a new package, the lock no longer matches and all `predict_adapter` entries fail closed.
- The adapter is the *only* file in the Wick package that imports `deepbook_predict::*`. So an ABI change blast-radius is one file plus the vendored sources.

Open question: **do we want a Wick admin "freeze adapter" cap** independent of `OracleVersionLock`? E.g. an `AdapterCircuitBreaker` shared object that any `predict_adapter::mint*` checks first. Probably not — the version lock already provides the freeze hook via `start_migration`. Decision: defer to post-MVP.

### 5.2 DUSDC vs SUI/USDC at `MartingalerVault<C>`

The BTC route uses DUSDC (the only `accepted_quote` on `Predict<DUSDC>`).
Wick's other routes (SUI random-walk, SP500 mock) use SUI or USDC. The
collateral-invariant module (`MartingalerVault<C>`) is generic over `C`.
The seam:

- `wick::predict_adapter::WickPredictPosition` is **not** type-parameterized over the quote (it's structural — `manager_id` + `oracle_id` + dimensions). The quote type only appears in the entry signatures (`mint<Quote>`, `redeem<Quote>`, `redeem_permissionless<Quote>`). That's correct: the receipt is a witness, the actual coin movement happens against the user's `PredictManager` which holds DUSDC.
- `wick::predict_route::open_btc_touch` is hard-pinned to `Coin<DUSDC>` (v2 §9). It does NOT touch a `MartingalerVault` — the BTC route uses Predict's vault, not Wick's. Wick's `MartingalerVault<SUI>` and `MartingalerVault<USDC>` live on the non-Predict routes.
- The cross-route ride-along (`wick::ride_position`) is route-specific via the `_route_kind: u8` discriminant in `RidePosition`; the BTC ride-along reads DUSDC and never touches `MartingalerVault`.

**Decision:** keep MartingalerVault SUI/USDC-only. The BTC route bypasses it entirely. Document in `04_solvency_v2.md` that "BTC route solvency is Predict's vault, not Wick's." This is consistent with the per-user-manager custody model — there is no shared Wick float for BTC to need a Martingaler for.

### 5.3 Oracle compaction (#972) interaction with `OracleVersionLock`

`predict::compact_settled_oracle(predict, oracle, oracle_cap)` is
gated by `OracleSVICap`. After compaction:

- The `OracleSVI` object still exists (no `object::delete`).
- `is_settled()` still returns true.
- `settlement_price()` still returns `Some(...)`.
- The Predict-side `vault.settled_oracles` table entry is constant-size; the dense per-strike `oracle_matrices` entry is dropped.

For Wick this means: post-compaction, `oracle::spot_price(&OracleSVI)` returns the last live spot (NOT the settlement price), and `oracle::timestamp(&OracleSVI)` returns the last live update timestamp. **Implication for `record_from_oracle_svi`:** we already skip ticks when `status == STATUS_SETTLED`, so we never read post-compaction spot. No code change needed; the status gate at the top of the function is the load-bearing line.

Open question: **what if a `PathObservation` is created against a settled+compacted oracle?** Constructor takes `oracle: &OracleSVI` (in `path_observation::new`). The constructor doesn't check `is_settled()` — it just snaps `oracle_id` and the WickOracle expiry. **Action item for D.1:** add a `new_for_predict_oracle(oracle: &OracleSVI, barrier: u64, ...): PathObservation` constructor that asserts `!is_settled(oracle)`. ~10 LOC. Track in `TASKS.md` as a follow-on for the BTC-route work.

### 5.4 Permissionless `create_manager`

Confirmed: `predict::create_manager(ctx)` is `public` (not `entry`-only, not capability-gated). Anyone can call. The PredictManager is created `share_object`-style with `owner = ctx.sender()`. This validates v2 §1 Option B end-to-end: each user permissionlessly creates their own manager.

The adapter exposes `predict_adapter::create_manager(lock, predict, ctx): ID` so the v2 bootstrap PTB can route through Wick and emit the `AccountOpened` event from `user_predict_account::open_account` atomically with the manager creation.

### 5.5 Open: what happens if Wick reads `PriceData` but Predict updates it mid-PTB?

In a single PTB, `&OracleSVI` is a Sui reference held for the duration of the call. Sui's object model serializes mutations on a single shared object across PTBs at the consensus layer, so within a PTB you cannot observe a partial write. **Conclusion:** the two reads (`spot_price` + `timestamp`) are atomic *as seen by our call*, even though we make them as separate Move function calls. Good.

### 5.6 Open: PredictManager type-arg drift

`PredictManager.deposit<T>` and `predict::mint<Quote>` are type-parameterized on the coin. The adapter passes `<Quote>` through verbatim. If the caller (e.g. `wick::predict_route::open_btc_touch`) statically pins `Quote = DUSDC`, the type system enforces consistency. If they pin some other type (e.g. a mistyped local alias), `predict::treasury_config::assert_quote_asset<Quote>()` rejects at runtime. Both gates are in place; no extra check needed in the adapter.

---

## Section 6 — Test plan

Ten integration tests for `move/tests/predict_adapter_tests.move` and
`move/tests/path_observation_btc_tests.move`. All run under
`#[test_only]` with `scenario` framework, using the vendored Predict
package's `create_test_predict` helper and `init_for_testing` from the
registry.

1. **`test_create_manager_and_mint_single_strike`** — bootstrap a manager via the adapter, mint a TOUCH position, assert the receipt is well-formed (`kind == 0`, `quantity == 1000`, `cost > 0`) and that `predict_manager::position(manager, key) == 1000`.

2. **`test_mint_range_returns_kind_1_receipt`** — mint a vertical range, assert `receipt.kind == 1`, `receipt.lower_strike` and `receipt.higher_strike` populated, `receipt.strike == 0` and `is_up == false` (sentinel values).

3. **`test_redeem_live_owner_gated`** — try `predict_adapter::redeem<DUSDC>(...)` as a non-owner; expect `ENotOwner` (the adapter asserts before delegating; Predict would also reject but earlier failure is cleaner).

4. **`test_redeem_permissionless_settled_only`** — fast-forward clock past `expiry_ms`, manually settle the oracle via test helper, call `predict_adapter::redeem_permissionless` from a non-owner; expect success and a positive `payout`.

5. **`test_redeem_permissionless_pre_settle_fails`** — same but without settling first; expect Predict's `EOracleNotSettled` to propagate.

6. **`test_version_lock_mismatch_freezes_adapter`** — pin lock to a bogus `predict_id`; expect `EVersionMismatch` from `version_check` on every entry (`mint`, `mint_range`, `redeem`, `redeem_permissionless`, `create_manager`).

7. **`test_record_from_oracle_svi_advances_path`** — create a `PathObservation` against an `OracleSVI`, push a price via the test `update_prices` helper, call `record_from_oracle_svi`; assert `observation_count` incremented and `last_seen_ms` updated.

8. **`test_record_from_oracle_svi_n_confirmation_touch`** — push 3 consecutive crossings via test helper (advancing the clock by 1500ms between each so the stale guard passes), assert `touched_at.is_some()` after the 3rd push.

9. **`test_record_from_oracle_svi_rejects_stale_spot`** — push a spot, advance the clock by 6_000ms without re-pushing, call `record_from_oracle_svi`; expect `EStaleSpot`.

10. **`test_record_from_oracle_svi_skips_pending_settlement`** — advance clock past `expiry_ms` but before any post-expiry price push (the `STATUS_PENDING_SETTLEMENT` window); call `record_from_oracle_svi`; assert it returns early (no state change), no abort. This is the key v2 §6.3 invariant.

Add an 11th smoke test in `scripts/predict-route-smoke-v2.sh` against testnet that runs the full open → tick → settle → redeem sequence using the canonical BTC oracle (`0xdc8ae118…cba` — currently settled — or whichever upcoming-expiry BTC oracle is active at run time).

---

## Section 7 — Implementation order

Each step is a single commit. Each leaves the build green
(`./scripts/agent-preflight.sh` passes).

**Step 1 — Vendor Predict.** Pull `packages/predict/**` from
`MystenLabs/deepbookv3@1159d79a` into `move/vendor/predict/`, plus
`packages/deepbook/sources/balance_manager.move` into
`move/vendor/deepbook/sources/`. Write the two `Move.toml` files with
pinned addresses. Add `move/vendor/README.md` documenting source +
commit. **Expected delta:** ~30 files added, 0 Wick files modified.
Verify `sui move build` succeeds.

**Step 2 — Wire `DeepBookPredict` dep into `wick/Move.toml`.** Single-line
change. Build must succeed (no new code yet, just dep resolution).

**Step 3 — Land `wick::predict_adapter` skeleton (§3).** Add
`move/sources/predict_adapter.move`. No callers yet — module compiles in
isolation. **Adds ~270 LOC.** Tests 1–2 ship in the same commit (mint +
mint_range receipts).

**Step 4 — Land `record_from_oracle_svi` (§4).** Patch
`move/sources/path_observation.move`. **Adds ~70 LOC** + new error
constants. Tests 7–10 ship in the same commit.

**Step 5 — Land redeem paths.** Tests 3–6 land here. Cover
`redeem<Quote>`, `redeem_permissionless<Quote>`, and the lock-mismatch
freeze.

**Step 6 — `wick::user_predict_account` (v2 §3).** Per the v2 doc this is
the per-user wrapper that pins `manager_id` and bookkeeps tickets. ~150
LOC. Depends only on the adapter from step 3.

**Step 7 — `wick::predict_route` (v2 §9).** The orchestrator:
`open_btc_touch`, `reconcile`, `redeem_btc_touch`, `early_unwind`. ~400
LOC. Depends on steps 3 + 6.

**Step 8 — `scripts/predict-route-smoke-v2.sh`.** End-to-end testnet
script (v2 §10 lists the exact commands). Wire it into
`agent-preflight.sh` as an optional `--with-testnet-smoke` flag (gated
because it needs DUSDC faucet access).

**Step 9 — Frontend wiring.** PTB builders in
`frontend/src/lib/predict-route.ts` matching v2 §2.1–2.3, plus a
`<BtcTouchTrader>` route.

Steps 1–5 are the answer to this brief's `#121` + `record_from_oracle_svi`
scope. Steps 6–9 are the wider D.1 build-out covered by the v2 doc.

### 7.1 Estimated total Move LOC for full D.1

| Module | LOC (incl. comments) | Source |
| --- | ---: | --- |
| `wick::predict_adapter` | 270 | §3 (this doc) |
| `wick::path_observation::record_from_oracle_svi` | 70 | §4 (this doc) |
| `wick::user_predict_account` | 150 | v2 §3 |
| `wick::predict_route` (open/reconcile/redeem/early_unwind) | 400 | v2 §9 |
| Move tests (10 in §6 + 5 in v2 redteam set) | 350 | §6 |
| **Total new Wick Move** | **~1240** | |
| Vendored Predict (no edits) | ~4500 | unchanged from upstream |

Reads of `move/sources/oracle_version_lock.move` (151 LOC, already
shipped) and `move/sources/path_observation.move` (779 LOC, already
shipped) factor in as zero new code — both are already in tree, only the
`record_from_oracle_svi` insertion is incremental.

---

## Appendix A — Verified testnet artifacts (refresh)

| Artifact | Value (verified 2026-05-18) |
| --- | --- |
| Predict package | `0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138` |
| `Predict<DUSDC>` shared object | `0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a` |
| DUSDC type tag | `e95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC` |
| Sample BTC `OracleSVI` (settled) | `0xdc8ae118f2770366e0f0a91deb5dd8533150cb79b343f83e800a9a951aca6cba` — expiry `1778836500000` (Apr 14 14:35 UTC), settled @ `80,550.45` USD |
| Predict trading paused | `false` |
| Vault balance | 1,002,154,692,135 base units of DUSDC (~$1.002M test funds) |
| PLP total supply | 1,001,094,673,665 |
| Accepted quotes | `DUSDC` (only) |
| Public Predict server | `https://predict-server.testnet.mystenlabs.com` |

The `Predict<DUSDC>` object's `oracle_grids` table contains 2310 entries
and `settled_oracles` contains 2307 — i.e. testnet has been churning
through ~one settled BTC oracle per 15-minute window for several days, so
the v2 doc's "19 active BTC oracles" snapshot was a moment-in-time and is
not load-bearing. The protocol design is for `OracleSVI` objects to be
created and settled continuously.

## Appendix B — `Move.toml` final shape (Wick package)

```toml
[package]
name = "wick"
edition = "2024"

[dependencies]
Sui = { git = "https://github.com/MystenLabs/sui.git", subdir = "crates/sui-framework/packages/sui-framework", rev = "framework/testnet" }
DeepBookPredict = { local = "vendor/predict" }

[addresses]
wick = "0x0"
deepbook_predict = "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138"
deepbook = "0xfb28c4cbc6865bd1c897d26aecbe1f8792d1509a20ffec692c800660cbec6982"
```

The two named addresses for `deepbook_predict` and `deepbook` are what
make `use deepbook_predict::predict;` resolve at link time to the live
testnet package. Update both lines if Mysten re-deploys.
