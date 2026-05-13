# DeepVault — DeepBook Integration Study

Source: [github.com/Chimdalu-Ofoegbu/DeepVault](https://github.com/Chimdalu-Ofoegbu/DeepVault), commit at clone (head of `main`, 2026-05-13).
Vendored DeepBookV3 SHA: `1159d79af33c70e09e406310e1d8f067832ede9d` (branch `predict-testnet-4-16`).
Sui Overflow 2026 submission, ship target 2026-06-16.

This document studies what they do well, what we should mimic in `wick::predict_route` / `wick::clob_listing`, and what *not* to copy.

---

## 1. Product

DeepVault is a **structured-product vault**: USDsui in, dvUSDC share token out. Of every deposit it routes ~90% to DeepBook Predict's PLP for yield and ~10% to buy a deep-OTM (-15%) 14-day binary "DOWN" hedge on BTC, sized from a live SVI volatility surface. When BTC tanks, the hedges pay; otherwise PLP fees minus hedge cost is your yield. Their flagship demo is one PTB that does **Margin borrow + vault deposit + Predict hedge mint** atomically — the "Sui composability" 60-second hook.

> *Elevator pitch (verbatim from `README.md:18-22`):* "DeepVault sells 'PLP yield minus crash insurance' as a single deposit. You put USDsui in. The vault routes ~90% to DeepBook Predict's PLP for yield, and ~10% buys binary tail hedges priced from a live SVI volatility surface (Gatheral & Jacquier 2014). When BTC tanks more than ~15%, the hedges pay; otherwise you collect the PLP fees minus a small hedge cost."

It is not a market-making product and it is not a DEX. It is a single-button structured note that judges understand in 90 seconds.

---

## 2. DeepBook integration

### Objects referenced
From `contracts/sources/predict_adapter.move:15-19` and `vault.move:19-23`:

- `deepbook_predict::predict::Predict` — the top-level Predict shared object
- `deepbook_predict::predict_manager::PredictManager` — per-owner balance/position manager (one per LP, see §3)
- `deepbook_predict::oracle::OracleSVI` — Mysten's BTC SVI oracle shared object
- `deepbook_predict::market_key::MarketKey` — `(oracle_id, expiry, strike, direction)` tuple used as Table key
- For the two-protocol PTB, the Margin SDK's `MarginManager`, `MarginRegistry`, `MarginPool`, BTC/USDC oracles, and the spot DeepBook v3 `Pool` (`scripts/two-protocol-ptb-demo.ts:314-335`).

### Functions called
- `predict::create_manager(ctx)` — public entry that creates and **shares** a `PredictManager` whose `owner = ctx.sender()`. Called once per LP from the supply PTB.
- `predict::mint<Quote>(predict, manager, oracle, key, quantity, clock, ctx)` — opens a binary position.
- `predict::redeem<Quote>(predict, manager, oracle, key, quantity, clock, ctx)` — closes a binary position; payout lands back in `manager.balance`.
- `predict::get_trade_amounts(predict, oracle, key, qty, clock)` — used as a misquote check at qty=1 (`rebalance.move:264`).
- `predict_manager::deposit<Quote>(manager, coin, ctx)` — funds the manager's internal balance *before* mint, since `predict::mint` calls `manager.withdraw` internally.
- Read-only: `oracle::forward_price`, `oracle::svi`, `oracle::svi_a/b/rho/m/sigma`, `oracle::id`, `market_key::down`.
- Margin leg: `margin_manager::new_margin_manager`, `deposit`, `borrow_quote`, `withdraw`.

### Move.toml dependency declaration

`contracts/Move.toml:11-30`:

```toml
deepbook = { git = "https://github.com/MystenLabs/deepbookv3.git", subdir = "packages/deepbook", rev = "1159d79af33c70e09e406310e1d8f067832ede9d" }
deepbook_predict = { git = "https://github.com/MystenLabs/deepbookv3.git", subdir = "packages/predict", rev = "1159d79af33c70e09e406310e1d8f067832ede9d" }

[addresses]
deepvault = "0x0"
predict   = "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138"
```

Two key choices:

1. **SHA-pinned, not branch-tracking.** Comment on line 17: "SHA captured 2026-05-09 from `git ls-remote ... predict-testnet-4-16`. Bump only after a Monday Predict sweep triages the diff."
2. **DeepBookV3 also vendored as a `git subtree --squash` at `scripts/deepbookv3/`** (per `README.md:151`) so they can grep, run `cargo`, and point at exact source lines without round-tripping to GitHub. The Move.toml dep still pulls from the upstream Git URL — the local subtree is a read-only mirror for tooling.

### Integration surface: direct Move + PTB orchestration

Both. Move calls happen *inside* `vault::supply` and `rebalance::roll_expiring`; the supplier's PTB front-loads `predict::create_manager` and then drives the rest as a single signed PTB.

### Most representative integration code

The thin adapter (`contracts/sources/predict_adapter.move:24-47`):

```move
public(package) fun mint<Quote>(
    predict: &mut Predict,
    manager: &mut PredictManager,
    oracle: &OracleSVI,
    key: MarketKey,
    quantity: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    predict::mint<Quote>(predict, manager, oracle, key, quantity, clock, ctx);
}
```

The W3-locked deposit-then-mint sequence (`contracts/sources/rebalance.move:272-289`):

```move
// 7. W3 LOCK: fund the PredictManager from the hedge_alloc Coin BEFORE
//    predict_adapter::mint runs. predict::mint internally calls
//    `manager.withdraw<Quote>(cost, ctx).into_balance()` against this
//    just-deposited balance (predict.move:248-249).
predict_manager::deposit<Quote>(predict_manager, hedge_alloc, ctx);

predict_adapter::mint<Quote>(
    predict, predict_manager, oracle, key, quantity, clock, ctx,
);
```

The misquote-abstain check (`rebalance.move:264-270`):

```move
let (predict_ask_unit, _) = predict::get_trade_amounts(predict, oracle, key, 1, clock);
let max_premium_bps = strategy_constants::max_price_premium_bps();
assert!(
    (predict_ask_unit as u128) * 10_000u128
        <= (fair_value as u128) * ((10_000 + max_premium_bps) as u128),
    EPredictMisquote,
);
```

---

## 3. Custody model

**User-custodied PredictManager, per LP.** This is the load-bearing decision they spent Wave 0 of Phase 2 resolving (`.planning/phases/02-vault-move-package-testnet-deploy/WAVE0-DECISION.md`).

The constraint: `predict::mint` opens with `assert!(ctx.sender() == manager.owner(), ENotOwner)` at `predict.move:228`. `manager.owner` is set at `predict_manager.move:90` to `ctx.sender()` of the original `predict_manager::new` caller and is **not transferable**. So whoever creates the PredictManager is the only address Sui will let call `predict::mint` with it.

Three options were considered (and verified empirically by spike module + spike test in `contracts/sources/_spike/predict_manager_owner_spike.move` and its companion test):

| Option | Who creates PredictManager | Result |
|---|---|---|
| (a) Vault-as-owner (admin creates at deploy) | admin | **FAILS** — supplier's `ctx.sender() != admin` |
| (b) Supplier-owned | each LP creates their own | **PASSES** — chosen |
| (c) Two-call PTB with vault-recorded intent | supplier | passes, but violates D-06 (atomic supply→hedge from inside `vault::supply`) |

**Selected (b).** The vault stores `predict_manager_id: ID` only as a deploy-time reference for dashboards (`vault.move:118, 274`). The actual PredictManager passed into `vault::supply` is the **supplier's own**, threaded through the PTB. The TreasuryCap<SHARE> is custodied inside the Vault via the `PendingTreasury` bridge in `share.move:27-30, 58-62` (TreasuryCap never appears as a free local outside of the two-line consume_pending → create_vault handover; Pitfall 9 mitigation). AdminCap is `key`-only, non-transferable in v1 (`vault.move:87-88`); only four powers exist (pause, oracle staleness override, tune strategy, emergency unwind — `vault.move:594-739`); no `admin_withdraw_fees`, no `admin_transfer_cap`.

Their answer to "PredictManager owner can't be transferred" is: **don't try.** Each LP owns their own manager; the vault never holds one.

---

## 4. PTB shape

Two PTBs ship in the repo. The vanilla supply path (`scripts/e2e-vault-cycle.ts:180-207`):

```typescript
const supplyTx = new Transaction();
const [depositCoin] = supplyTx.splitCoins(supplyTx.object(depositCoinId), [
    supplyTx.pure.u64(SUPPLY_AMOUNT_MICRO),
]);
supplyTx.moveCall({
    target: `${deploy.package_id}::supply::supply`,
    typeArguments: [deploy.dusdc_type_tag],
    arguments: [
        supplyTx.sharedObjectRef({
            objectId: deploy.vault_id, mutable: true,
            initialSharedVersion: deploy.vault_initial_shared_version,
        }),
        supplyTx.object(deploy.predict_top_level_id),
        supplyTx.sharedObjectRef({
            objectId: deploy.predict_manager_id, mutable: true,
            initialSharedVersion: deploy.predict_manager_initial_shared_version,
        }),
        supplyTx.object(oracleSviId),
        depositCoin,
        supplyTx.object('0x6'), // Clock
    ],
});
```

The flagship two-protocol PTB (`scripts/two-protocol-ptb-demo.ts:286-457`) is a **5-call PTB** crossing the `margin` package, the `deepbook` Pool, the supplier's `MarginManager`, the supplier's `PredictManager`, and the `deepvault::supply` entry:

1. `margin_manager::deposit<BTC, DUSDC, BTC>` — collateral in
2. `margin_manager::borrow_quote<BTC, DUSDC>` — borrow DUSDC (auto-deposits internally; returns `()`)
3. `borrowedCoin = margin_manager::withdraw<BTC, DUSDC, DUSDC>` — **bridge**: extract a free `Coin<DUSDC>` so step 4 has something to consume
4. `vault::supply::supply<DUSDC>(..., borrowedCoin, ...)` — atomic deposit + Predict hedge mint (the internal `rebalance::buy_hedge_for_deposit` call is `public(package)`, so it isn't a separate moveCall)
5. (optional, currently skipped) `margin_manager::deposit<BTC, DUSDC, SHARE>` — reposit dvUSDC as collateral (Margin governance hasn't whitelisted SHARE)

Crucial design note in their header (`two-protocol-ptb-demo.ts:24-29`): "`borrow_quote` returns void (auto-deposits via `self.deposit_int<BaseAsset, QuoteAsset, QuoteAsset>(coin, ctx)`). The explicit withdraw step is the load-bearing bridge — without it the supply step has no `Coin<DUSDC>` to consume."

Capability discipline (`two-protocol-ptb-demo.ts:37, 213-217`): the TradeCap is created **inside** `MarginManager::new_margin_manager` and stored inside the wrapped BalanceManager; `setupBalanceManagerWithTradeCap` returns only the MarginManager object id. No TradeCap, no `&mut TradeCap`, no `Coin<TradeCap>` ever escapes.

---

## 5. Patterns we should steal

Five concrete patterns to lift, each with the file:line they live at:

1. **Single-file blast radius adapter for ABI churn.** `predict_adapter.move:13-47` is a pure passthrough — zero logic. The header at line 5 says: "If Mysten changes the predict signatures, this is the ONE file to update." Wick should do the same: `wick::predict_route` should be a thin adapter, never importing `deepbook_predict` types into `wick::market` or `wick::vault`. Today our `wick_oracle.move` reads observations through driver structs, which is the right shape — extend it to Predict mint/redeem too.

2. **SHA-pinned dep + vendored subtree.** `Move.toml:18,25` pins exact SHAs (not branch). README warns "Bump only after a Monday Predict sweep triages the diff." The DeepBookV3 source is also `git subtree --squash`-vendored at `scripts/deepbookv3/` so `grep -rn '<symbol>'` finds the actual line. We should do this for Predict and DeepBook v3 — pin exact SHAs in `move/Move.toml`, vendor them under `move/vendor/deepbookv3/` for read-only grep, and add a `scripts/predict-diff.sh` Monday cron.

3. **Ownership spike before any production code.** `WAVE0-DECISION.md` + `_spike/predict_manager_owner_spike{,_test}.move` is a 200-line, MIT-paranoid empirical answer to "can the vault own the PredictManager?" They built a verbatim copy of `predict.move:228`'s assertion locally (`assert_owner_matches_sender`) so they could `expected_failure(abort_code = ENotOwner)` on each ownership configuration without needing a real `Predict` shared object. Wick's `predict_route` design has the same problem (`H5` in our task list, "Predict route: per-user managers OR Sui multisig hub"). Steal the spike pattern — write a `wick::predict_owner_spike` that confirms the chosen design *before* writing the route module.

4. **Misquote-abstain at qty=1.** `rebalance.move:264-270` queries Predict's quote at qty=1, compares it to the SVI fair value, and aborts if Predict's ask exceeds the model price by more than `max_price_premium_bps`. Two wins: the unit comparison aligns scales (per-unit at FLOAT_SCALING), and the vault refuses to overpay even if a market-maker glitch widens spreads. Wick's `predict_route` should do the same against our Wick-internal fair value.

5. **PendingTreasury / capability quarantine bridge.** `share.move:27-62` wraps TreasuryCap<SHARE> in a `PendingTreasury` struct at `init()`, and the only way to extract the inner cap is `consume_pending`, which is `public(package)`. The deployer never holds a free `TreasuryCap<SHARE>` in their wallet; only `vault::create_vault` can unwrap it. `ptb_capability_test.move:75-93` documents the pattern as a structural test (the file's compilation IS the assertion) plus a Python grep gate. Wick's per-market position-Coin TreasuryCaps (Phase C.1, "Coin'ify positions") should use the same bridge — never let a TreasuryCap<MarketPosition> appear as a free local.

Honourable mention: their **W1/W2/W3 schema/field locks** (`vault.move:11-15`) — they freeze the struct schema before writing any business logic, so later plans can only *add function bodies that read/mutate fields already declared*. Worth borrowing for `wick::martingaler_vault` once that struct is stable.

---

## 6. Patterns we should NOT copy

1. **Single shared `OracleSVI` per BTC market.** Their `oracle::forward_price` and `oracle::svi` accessors are public, but the **OracleSVI shared object id** they use is whatever Mysten publishes via the Predict server registry (`scripts/e2e-vault-cycle.ts:97-100`: `process.env.ORACLE_SVI_ID`). They don't pin the *shared object id* in code — they read it from env at runtime. For Wick that's fragile because if Mysten redeploys Predict on testnet (which they have, this is `predict-testnet-4-16`), the OracleSVI id changes and your vault is now reading a stale or invalid oracle. We already have `wick::oracle_version_lock` that pins both Predict pkg id AND object id; **keep that, do not adopt the env-var pattern.**

2. **Test the "happy path" by mocking out Predict entirely.** `contracts/tests/integration_test.move:8-17` admits: "We cannot construct a live `Predict` / `OracleSVI` from these tests, so we cannot directly invoke `vault::supply`." Their workaround is `vault::inflate_liquid_for_testing` + `vault::mint_shares_for_testing` + direct `insert_or_consolidate_hedge` — they reconstruct what the post-supply state *should* look like and assert the registry invariants. The misquote-abort test (`integration_test.move:216-226`) is `abort 401` literally hardcoded. Production exercise of the Predict path runs only in `scripts/e2e-vault-cycle.ts` (FAST_FORWARD=0 mode, nightly CI). Wick should aim higher: build a deterministic mock Predict (or use sui-test-validator with a vendored Predict deploy) so per-push CI exercises the real `predict::mint`. We already have `wick::random_walk_driver` and `wick::pull_oracle_driver`; keep the hermetic-test discipline that gives us.

3. **Hedge registry with parallel `vector<MarketKey>` index next to `Table<MarketKey, HedgePosition>`.** `vault.move:112-114` and the iteration in `rebalance.move:99-112` keep the vector in sync with the table by hand because Sui Tables have no native iterator. They protect this with the `HEDGE_REGISTRY_CAP = 100` backstop (`rebalance.move:50`). Our `wick::martingaler_vault` is per-market (one vault per market), so we don't need a registry and we shouldn't copy the dual-index pattern. If we ever need to iterate, use `ObjectBag` or push the iteration to the indexer, not on-chain.

---

## 7. Their tests

**They mock the Predict surface for unit tests; they exercise it for real only in nightly testnet CI.**

The architectural reason is in `integration_test.move:8-17`: `predict::create<Quote>` and `oracle::create_oracle` are `public(package)` (predict.move:507, oracle.move:368) and unreachable from outside the vendored package, so a Move test in `deepvault` cannot construct a real `Predict` or `OracleSVI`. Their workaround across the suite:

- **Pure-vault unit tests** (`vault_test.move`, `supply_test.move`, `redeem_test.move`, `rebalance_test.move`, `ltv_test.move`, `share_test.move`, `phi_test.move`, `isqrt_test.move`, `svi_view_test.move`, `liquidation_test.move`, `admin_test.move`): use `vault::new_vault_for_testing` (bypasses `predict::create_manager`), `mint_shares_for_testing`, `inflate_liquid_for_testing`, `drain_liquid_for_testing` to set up post-supply state directly.
- **Integration tests** (`integration_test.move`): six tests covering atomic-supply state, misquote-abort code reachability (via literal `abort 401`), roll-expiring registry mutation (via direct Table manipulation through `vault::hedges_mut`), and the full redeem cycle. None call `predict::mint` directly.
- **Spike tests** (`_spike/predict_manager_owner_spike_test.move`): the *only* tests that actually call vendored Mysten code (`predict::create_manager`), because that's a public function. They use it to validate the ownership assertion empirically.
- **Property tests** (`property_test.move`): 50-case round-down-in-vault-favor invariant via `compute_shares_to_mint_for_test` (a `#[test_only]` pure-math entry).
- **Specs** (`contracts/specs/{nav_monotone,capability_containment,inflation_safe}.move`): three `move-prove`-style spec files (separate from the test suite).
- **Real Predict round-trip** lives only in `scripts/e2e-vault-cycle.ts` (nightly, FAST_FORWARD=0) and `scripts/two-protocol-ptb-demo.ts`. Per-push CI runs FAST_FORWARD=1 (Move-only). The cycle script also dumps an action trace to `backtest/traces/cycle-full.json` for Python parity replay (Move ↔ Python 1-wei NAV equivalence).
- **Capability containment** is enforced at three layers: Move type system + structural Move test (`ptb_capability_test.move`) + a Python `grep -rnE '^public fun ...: TradeCap|TreasuryCap<SHARE>'` gate in CI.

Test strategy spec: "What Move tests can prove" + "What lives in the nightly real-testnet driver" is split *explicitly* in every test file's header. This is good documentation but it leaves the per-push CI weak on Predict regressions — they catch them on the Monday sweep, not the next push.

---

## 8. What this teaches us specifically

Five concrete shifts for our codebase given what we already have (`wick::martingaler_vault`, `wick::oracle_version_lock`, planned `wick::predict_route` and `wick::clob_listing`):

1. **Custody decision for `wick::predict_route` is already made for us — per-user PredictManagers.** Hardening task H5 already concluded "per-user managers OR Sui multisig hub." DeepVault confirms: there is no third option. `predict.move:228`'s `ctx.sender() == manager.owner()` assert plus the immutable `owner` field on `PredictManager` rules out a vault-owned manager. Implication for our PTB shape: every BTC route trade must be a 2-call PTB on the user's first interaction (`predict::create_manager` then `wick::predict_route::open`) and a 1-call PTB after that, with the supplier's PredictManager id cached client-side. Our `UserPredictAccount` (already built per task H110) is exactly this — confirm it stores the per-user PredictManager id.

2. **Add the misquote-abstain check to `wick::predict_route`.** When opening a Predict-backed touch position, query `predict::get_trade_amounts(..., qty=1, ...)` and abort if the Predict ask exceeds Wick's internal fair value by more than a configurable `max_premium_bps`. Without this, a Predict price glitch silently overpays and dilutes the touch-side LP pool. See `rebalance.move:264-270` — copy the per-unit normalization carefully, or it'll be wrong by FLOAT_SCALING.

3. **Build a `wick::predict_route_owner_spike` *first*.** Before writing the route module, write the spike: prove empirically that `(supplier creates manager) → (supplier calls wick::predict_route::open which forwards to predict::mint)` succeeds, and that `(admin creates manager) → (supplier calls)` aborts. Use the verbatim-assertion-copy trick from `predict_manager_owner_spike.move:67-72`. This converts a 4-week production design risk into a 2-hour test.

4. **Pin Predict + DeepBook v3 SHAs in `move/Move.toml`, vendor the source under `move/vendor/`, add a `scripts/predict-diff.sh` weekly cron.** Right now our `wick::oracle_version_lock` pins the package_id + object_id at runtime, which is great for the live testnet binding — but our build-time dependency on Predict still risks the breaking-change problem (Pitfall 6 from their PITFALLS.md). DeepVault's discipline: SHA in Move.toml + vendored subtree + Monday diff sweep + CI job that fails when `Move.toml` SHA differs from the vendored subtree HEAD. Steal the whole package.

5. **For `wick::clob_listing`, the bridge pattern matters more than the listing call.** The lesson from `two-protocol-ptb-demo.ts:386-408` is that `borrow_quote` returns void (auto-deposits) and you need an explicit `withdraw` to extract a `Coin` for the next step. DeepBook v3 CLOB has the same shape: `pool::place_limit_order` consumes a `BalanceManager` you pre-deposited into. So `wick::clob_listing` won't be "list this WickPosition Coin on the orderbook" — it will be "the user pre-deposits their position Coin into a BalanceManager (or our SDK builds the deposit + place_order PTB chain), the BalanceManager owns the resting order, and on fill we credit them back." Plan the PTB shape before the Move module, exactly the way DeepVault planned the 5-call PTB before writing the Move signatures.

Bonus, applicable broadly: **AdminCap with exactly four named powers and zero `withdraw_fees` is a strong story for judges.** `vault.move:594-739` enumerates the four powers in a comment block. Our `wick::admin_cap` already does something similar per H9 — keep that discipline; resist scope-creep into "admin can also tweak X." Each new admin power is a new attack surface and a new judge question.

---

## Appendix: file map

| Where | What |
|---|---|
| `contracts/Move.toml` | SHA-pinned Predict + DeepBook deps |
| `contracts/sources/predict_adapter.move` | thin passthrough wrapper |
| `contracts/sources/vault.move` | shared Vault, AdminCap with 4 powers, hedge registry |
| `contracts/sources/supply.move` | atomic supply + hedge entry, virtual-shares math |
| `contracts/sources/rebalance.move` | `buy_hedge_for_deposit`, permissionless `roll_expiring`, misquote check |
| `contracts/sources/redeem.move` | two-step withdrawal queue, per-user RateLimiter |
| `contracts/sources/share.move` | SHARE coin + PendingTreasury bridge |
| `contracts/sources/svi_view.move` | read-only SVI evaluator (single-file blast radius for OracleSVI) |
| `contracts/sources/ltv.move` | NAV per share + worst-case haircut |
| `contracts/sources/_spike/predict_manager_owner_spike.move` | empirical owner-assertion spike |
| `contracts/tests/integration_test.move` | six integration tests, Predict mocked out |
| `contracts/tests/ptb_capability_test.move` | structural capability-containment proof |
| `scripts/e2e-vault-cycle.ts` | real-testnet vanilla supply + redeem PTB |
| `scripts/two-protocol-ptb-demo.ts` | flagship 5-call Margin + Predict + Vault PTB |
| `.planning/phases/02-vault-move-package-testnet-deploy/WAVE0-DECISION.md` | PredictManager ownership decision |
| `.planning/research/PITFALLS.md` | 20 numbered pitfalls; Pitfall 6 = Predict ABI churn |
