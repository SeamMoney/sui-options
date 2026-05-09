# Wick Markets — Agent Task Queue

Decomposed from `docs/hackathon-plan.md` into agent-completable units. Each task names files touched, dependencies, and acceptance criteria so an agent can pick one up cold.

**Workflow for an autonomous run:**
1. Pick the highest-priority unblocked ☐ task
2. Mark it ◐
3. Implement against the acceptance criteria
4. Run `./scripts/agent-preflight.sh`
5. If green: commit, mark ☑. If red: surface the failure, leave ◐ for human triage

**Status legend:** ☐ todo · ◐ in-progress · ☑ done · ✗ blocked

---

## Day 1 — Core Move Model

### ☑ T1.1 — Initialize Sui Move package skeleton
- **Files:** `move/Move.toml`, `move/sources/wick.move`, `move/sources/oracle_adapter.move`, `move/tests/wick_tests.move`
- **Goal:** Buildable empty package with stub modules.
- **Acceptance:** `cd move && sui move build` succeeds. `sui move test` runs (zero tests OK).
- **Deps:** none

### ☑ T1.2 — Define core structs and enums
- **Files:** `move/sources/wick.move`
- **Goal:** Define `Market<phantom C>`, `Position`, `LpPosition`, `MarketStatus` (ACTIVE/HIT/EXPIRED), `Side` (TOUCH/NO_TOUCH), `Direction` (ABOVE/BELOW), error code constants.
- **Acceptance:** Types match `docs/architecture.md` § Market Model exactly. Builds clean.
- **Deps:** T1.1

### ☑ T1.3 — Mock oracle adapter
- **Files:** `move/sources/oracle_adapter.move`, `move/tests/oracle_adapter_tests.move`
- **Goal:** A `MockOracle` object with `set_price` (test-only) and `get_price` / `barrier_crossed` query functions. Boundary the production adapter will replace.
- **Acceptance:** Tests show `set_price` mutates state and `barrier_crossed(direction, barrier)` returns the expected boolean for ABOVE and BELOW cases.
- **Deps:** T1.2

### ☑ T1.4 — `create_market` entry function
- **Files:** `move/sources/wick.move`, `move/tests/wick_tests.move`
- **Goal:** Caller deposits seed collateral; mint equal TOUCH and NO_TOUCH supply into AMM reserves; return `LpPosition` to creator.
- **Acceptance:** Happy path: $100 seed → `touch_reserve == no_touch_reserve == lp_supply == 100`. Failure tests: zero barrier, past expiry, zero collateral all revert with named error codes.
- **Deps:** T1.2, T1.3

### ☑ T1.5 — Day-1 invariant test scaffold
- **Files:** `move/tests/invariants.move`
- **Goal:** `assert_collateral_invariant(&market)` helper used by every later test.
- **Acceptance:** Helper fails loud if `collateral_vault != total_touch_supply` or either != `total_no_touch_supply`. Called from T1.4's tests.
- **Deps:** T1.4

---

## Day 2 — Trading and Settlement

### ☑ T2.1 — `mint_complete_set` (internal)
- **Files:** `move/sources/wick.move`
- **Goal:** Internal helper: take `Balance<C>` of size N → increment both supplies by N → return two `Position`s.
- **Acceptance:** Used internally only. Invariant preserved across the call.
- **Deps:** T1.5

### ☑ T2.2 — `buy_touch` / `buy_no_touch`
- **Files:** `move/sources/wick.move`, `move/tests/wick_tests.move`
- **Goal:** User deposits collateral → mint complete set → keep wanted side → swap unwanted side into AMM reserve → return wanted-side `Position`.
- **Acceptance:** After `buy_touch(amount=10)`, user has `Position{side: TOUCH, amount = 10 + swap_out}`, market reserves updated, invariant holds.
- **Deps:** T2.1

### ☑ T2.3 — CPMM swap (TOUCH ↔ NO_TOUCH)
- **Files:** `move/sources/wick.move`, `move/tests/wick_tests.move`
- **Goal:** `swap_touch_for_no_touch` and reverse, integer `x*y=k` math, `fee_bps` skim into LP.
- **Acceptance:** Swap preserves `k` modulo fee. Output amount matches a hand-computed reference for a small case.
- **Deps:** T2.2

### ☑ T2.4 — `redeem_complete_set`
- **Files:** `move/sources/wick.move`, `move/tests/wick_tests.move`
- **Goal:** Pre-settlement: user with equal TOUCH and NO_TOUCH burns both, withdraws collateral 1:1.
- **Acceptance:** Test: 5 TOUCH + 5 NO_TOUCH → 5 collateral out, supplies decrement by 5, invariant holds.
- **Deps:** T2.2

### ☑ T2.5 — `mark_hit`
- **Files:** `move/sources/wick.move`, `move/tests/wick_tests.move`
- **Goal:** Permissionless. Read oracle, assert barrier crossed, assert `status == ACTIVE` and not past expiry, set `status = HIT`.
- **Acceptance:** ACTIVE + oracle crossed → HIT. Repeated calls revert (idempotent). Past-expiry market rejects `mark_hit`.
- **Deps:** T2.4

### ☑ T2.6 — `settle_expired`
- **Files:** `move/sources/wick.move`, `move/tests/wick_tests.move`
- **Goal:** Permissionless. Assert `clock.timestamp >= expiry_ms` and `status == ACTIVE`, set `status = EXPIRED`.
- **Acceptance:** Pre-expiry call reverts. Post-expiry call sets EXPIRED. HIT market rejects `settle_expired`.
- **Deps:** T2.5

### ☑ T2.7 — `redeem_winner`
- **Files:** `move/sources/wick.move`, `move/tests/wick_tests.move`
- **Goal:** TOUCH redeems iff `status == HIT`; NO_TOUCH redeems iff `status == EXPIRED`. Pay 1 collateral per claim, decrement winning supply.
- **Acceptance:** HIT path full settlement, EXPIRED path full settlement, losing-side rejection, double-redemption rejection.
- **Deps:** T2.5, T2.6

### ☑ T2.8 — Property test for the invariant
- **Files:** `move/tests/invariants.move`
- **Goal:** Random sequence of `{create, buy_touch, buy_no_touch, swap, redeem_set, mark_hit, settle_expired, redeem_winner}`. Invariant holds after every step. Post-settlement: collateral drains exactly to outstanding winning supply.
- **Acceptance:** ≥100 random sequences pass.
- **Deps:** T2.7

---

## Day 3 — Frontend and Keeper

### ☐ T3.1 — Vite + React + TS scaffold
- **Files:** `frontend/*`
- **Goal:** Working `npm run dev` with placeholder routes.
- **Acceptance:** Dev server starts, routes resolve.
- **Deps:** none

### ☐ T3.2 — Sui wallet adapter
- **Files:** `frontend/src/wallet/*`
- **Goal:** Connect/disconnect wallet, show address, switch to testnet.
- **Acceptance:** Manual: connect Sui wallet on testnet, address renders.
- **Deps:** T3.1

### ☐ T3.3 — Markets page (browse)
- **Files:** `frontend/src/pages/Markets.tsx`, `frontend/src/lib/sui.ts`
- **Goal:** Query and list active `Market` objects: asset, barrier, expiry, current TOUCH price.
- **Acceptance:** Renders ≥1 testnet market correctly.
- **Deps:** T3.2, T2.7 (need a deployed package)

### ☐ T3.4 — Trade ticket
- **Files:** `frontend/src/pages/Trade.tsx`
- **Goal:** Buy TOUCH or NO_TOUCH for a chosen amount; show payout estimate.
- **Acceptance:** Submits real testnet tx; position appears on Portfolio.
- **Deps:** T3.3

### ☐ T3.5 — Create market form
- **Files:** `frontend/src/pages/Create.tsx`
- **Goal:** Asset, direction, barrier (defaulted from live price), expiry, seed collateral.
- **Acceptance:** Submits `create_market` tx; new market appears on Markets page.
- **Deps:** T3.3, T4.1 (live-price defaults)

### ☐ T3.6 — Portfolio + redeem
- **Files:** `frontend/src/pages/Portfolio.tsx`
- **Goal:** Show user's `Position`s and `LpPosition`s; redeem-winner button when settled; redeem-complete-set when applicable.
- **Acceptance:** Redeem flow works on testnet.
- **Deps:** T3.4

### ☐ T3.7 — Keeper: watch-predict job
- **Files:** `keeper/src/jobs/watch_predict.ts`, `keeper/package.json`, `keeper/tsconfig.json`
- **Goal:** Poll DeepBook Predict testnet (or chosen oracle) every N seconds, cache latest prices.
- **Acceptance:** Logs price updates; restartable; backoff on errors.
- **Deps:** none (parallelizable with frontend)

### ☐ T3.8 — Keeper: mark-hit job
- **Files:** `keeper/src/jobs/mark_hit.ts`
- **Goal:** Detect barrier crossings, submit `mark_hit` tx with retries.
- **Acceptance:** Manual: simulate cross, tx lands.
- **Deps:** T3.7, T2.5

### ☐ T3.9 — Keeper: settle-expired sweep
- **Files:** `keeper/src/jobs/settle_expired.ts`
- **Goal:** Sweep ACTIVE markets past expiry, call `settle_expired`.
- **Acceptance:** Manual: expire a market, sweep settles it.
- **Deps:** T3.7, T2.6

### ☐ T3.10 — `scripts/smoke.sh`
- **Files:** `scripts/smoke.sh`
- **Goal:** End-to-end on testnet: deploy → create market → buy both sides → mark_hit (or expire) → redeem winner. Exit 0 on success.
- **Acceptance:** Runs cleanly on testnet.
- **Deps:** T2.7, T3.8, T3.9

---

## Day 4 — DeepBook Predict and Polish

### ☐ T4.1 — DeepBook Predict adapter (read-only)
- **Files:** `frontend/src/lib/predict.ts`, optionally `move/sources/predict_adapter.move`
- **Goal:** Read active Predict testnet markets and BTC/SUI/APT live prices for display and Create-form defaults.
- **Acceptance:** Markets page shows context; Create form defaults barrier from live price.
- **Deps:** T3.3

### ☐ T4.2 — Demo recording prep
- **Files:** `docs/demo.md`
- **Goal:** Step-by-step demo script tied to the smoke test, with expected screen states.
- **Acceptance:** A non-author can follow it end-to-end.
- **Deps:** T3.10, T4.1

### ☐ T4.3 — README, pitch, threat model
- **Files:** root `README.md` polish, `docs/pitch.md`, `docs/threat_model.md`
- **Goal:** Pitch in one paragraph; oracle observation risk explicit; keeper failure mode explicit; MVP boundary explicit.
- **Acceptance:** Reviewer can understand product, risks, and scope from these alone.
- **Deps:** T4.2

### ☐ T4.4 — Final test sweep
- **Files:** none new
- **Goal:** `move test` clean, frontend `tsc --noEmit` clean, smoke test green on testnet, invariant property test ≥1000 sequences.
- **Acceptance:** All checks pass.
- **Deps:** all prior
