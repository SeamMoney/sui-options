# Validation 02 — State Semantics Inconsistencies (v2 design corpus)

**Scope.** Cross-referential validation of the state machines in:
- `01_martingaler_accounting_v2.md` — `Market.status` (OPEN → SETTLED_TOUCH | SETTLED_NO_TOUCH | STALE_RELEASED)
- `02_asymmetric_impact_fee_v2.md` — `FeeSnapshot`, `MarketStatus` (CREATED | LIVE | LOCKED_HIT | LOCKED_EXPIRED), `path.frozen`
- `04_solvency_v2.md` — wind-down state, isolated tournament vaults, deterministic settle ordering
- `05_path_observation_v2_hardened.md` — PathObservation `settlement_state` (NotReady | Resolved | Aborted), `settlement_observation` first-post-expiry latch, frozen flag, N-consecutive ticks, `PathSnapshot`
- `06_predict_btc_route_v2.md` — `OracleVersionLock`, `SettlementBucket.finalized`, `early_unwind`, two-phase settlement

**Method.** I read each spec end-to-end, then traced the cross-module call graph for `lock_and_settle / lock_settlement / settle_market`, the `redeem` family, and the freeze/snapshot/abort lifecycle. Inconsistencies below are surfaced strictly from contradictions or under-specified seams between docs — not aesthetic redesigns.

**Severity scale.**
- **CRITICAL** — direct path to fund loss or unsettleable market on a happy-path testnet demo
- **HIGH** — invariant violation under realistic flow ordering
- **MEDIUM** — implementation-time ambiguity that two engineers will resolve differently
- **LOW** — naming/event/UX inconsistency, no economic impact

---

## Finding 1 — `Market.status` enum is defined three different ways across docs

**Question.** Doc 01 has `status: u8` ∈ {OPEN, SETTLED_TOUCH, SETTLED_NO_TOUCH, STALE_RELEASED}. Doc 02 has `status: MarketStatus` ∈ {CREATED, LIVE, LOCKED_HIT, LOCKED_EXPIRED}. Doc 05's redeem says it "is gated on `status != Active`" with status ∈ {HIT, EXPIRED, ABORTED}. What is the canonical Market state set?

**Current state (quotes).**
- 01 §1: `status: u8, // 0=OPEN, 1=SETTLED_TOUCH, 2=SETTLED_NO_TOUCH, 3=STALE_RELEASED [Δ vs v1] LOCKED state removed — lock + settle is atomic now.`
- 02 §1.1: `status: MarketStatus, // CREATED | LIVE | LOCKED_HIT | LOCKED_EXPIRED`
- 05 §7: `market::settle_market ... transitions Market.status to one of {HIT, EXPIRED, ABORTED} based on the snapshot. redeem is gated on status != Active.`

**Verdict.** Three conflicting state enums for the same field. Doc 01 has 4 values, doc 02 has 4 values (different set), doc 05 has 4 values (third set including ABORTED that the others lack). Most importantly: only doc 05 acknowledges an `ABORTED` Market status, but doc 01 routes `lock_and_settle` exclusively to SETTLED_TOUCH or SETTLED_NO_TOUCH. There is no path in doc 01 for a market to become aborted — yet doc 05's `Aborted` settlement state requires the Market to enter an aborted status to gate `refund_one_to_one`.

**Recommended resolution.** Pick one canonical 5-value enum and pin it in a foundation doc:
```
OPEN → {SETTLED_TOUCH, SETTLED_NO_TOUCH, SETTLED_ABORTED} → STALE_RELEASED
```
Add a 6th value `WIND_DOWN_FROZEN` if doc 04 wind-down freezes individual markets (see Finding 7). Update docs 01, 02, 05 to reference this single set. The `LIVE` ⇄ `OPEN` rename is harmless cosmetics; the missing `SETTLED_ABORTED` is structural.

**Severity.** CRITICAL. Without an ABORTED Market state, doc 05's refund flow has nowhere to live — the keeper observes `path.settlement_state == Aborted` but the Market has no status it can move to that gates `redeem` into the refund branch.

---

## Finding 2 — `lock_and_settle`'s precondition on PathObservation is unspecified

**Question.** Doc 01's atomic `lock_and_settle` calls `path::touched(path_obs, oracle, clock)` and uses the boolean to pick an outcome. What is the path's required state? Must `settlement_snapshot` already be locked? Or does `lock_and_settle` itself trigger the snapshot lock? What if `path.settlement_state == NotReady`? What if `path.settlement_state == Aborted`?

**Current state (quotes).**
- 01 §2.2: `let outcome_side = path::touched(path_obs, oracle, clock) ? SIDE_TOUCH : SIDE_NO_TOUCH;`
- 05 §7: `market::settle_market (cranked once per market post-expiry) calls path_observation::lock_settlement_snapshot(path, clock) exactly once and then transitions Market.status to one of {HIT, EXPIRED, ABORTED} based on the snapshot.`
- 02 §1.1: `lock_settlement aborts unless now >= expiry_ms AND market.status == LIVE AND market.fee_snapshot.is_none(). lock_settlement calls path_observation::freeze(path, ctx) before reading max_seen/min_seen.`

**Verdict.** Three docs name three different functions (`lock_and_settle`, `settle_market`, `lock_settlement`) and none agree on which one calls `lock_settlement_snapshot`. Doc 01 doesn't call snapshot at all; it reads live `path::touched` which is the exact bug doc 05 §7 was written to prevent. Doc 02 calls a `freeze` function that doc 05 doesn't define (doc 05 has `lock_settlement_snapshot`, not `freeze`). Doc 05 says `settle_market` calls `lock_settlement_snapshot` — but doc 01's atomic `lock_and_settle` doesn't.

Worse: `path::touched` (the helper doc 01 uses) returns a bool. If the path is `Aborted`, what does it return? Spec doesn't say. If it returns false, doc 01's `lock_and_settle` will route the market to SETTLED_NO_TOUCH and pay all no-touch holders — losing every TOUCH holder's stake on a market that should have refunded.

**Recommended resolution.** Make `lock_and_settle` (the only atomic settle entry point per doc 01 INV-15) the function that:
1. Calls `path_observation::lock_settlement_snapshot(path, clock)` first.
2. Reads `path::settlement_snapshot(path)` and dispatches three-way: HIT → SETTLED_TOUCH, EXPIRED-no-touch → SETTLED_NO_TOUCH, ABORTED → SETTLED_ABORTED + skip vault lock entirely (refund flow uses no settlement_lock — see Finding 12).

Drop the `path::touched` boolean helper entirely. Replace with `path::winning_side(path) -> Option<u8>` where `None` means aborted.

**Severity.** CRITICAL. Direct fund-loss path on aborted markets in MVP.

---

## Finding 3 — First post-expiry observation latch can deadlock `lock_and_settle`

**Question.** Doc 05 says `WickOracle.settlement_observation` is latched on the FIRST post-expiry observation atomically inside `apply_observation`. Doc 01's `lock_and_settle` reads the path/oracle state. What happens if `now >= market.expiry_ms` but no post-expiry observation has landed yet (keeper crashed, network partition, oracle paused)?

**Current state (quotes).**
- 05 §6: `lock_settlement_from_latest reads settlement_observation, not latest ... assert!(option::is_some(&oracle.settlement_observation), ENoObservation);`
- 05 §6: `The latching happens inside apply_observation the moment any driver writes an observation with timestamp_ms >= expiry_ms.`
- 01 §2.2: `assert!(now >= market.expiry_ms, ENotExpired); assert!(market.status == OPEN, ENotOpen);` — no precondition on oracle settlement_observation existence.

**Verdict.** `lock_and_settle` will revert with `ENoObservation` if no post-expiry tick has landed, but neither doc says (a) who is responsible for ensuring a post-expiry tick exists, (b) what happens during the gap between `expiry_ms` and the first post-expiry tick, or (c) how this interacts with PathObservation's grace_ms / Aborted transition. Specifically: the path can transition to `Aborted` after `expiry_ms + grace_ms` *without ever needing a post-expiry oracle observation* (Aborted condition is "observation_count < min_observations", purely path-side). But `lock_and_settle` calls `lock_settlement_from_latest` which requires `settlement_observation`. So an aborted market cannot be settled because the oracle latch never happened.

**Recommended resolution.** Split the precondition by branch:
- HIT/EXPIRED-no-touch: requires `settlement_observation.is_some()`.
- ABORTED: skips oracle lock entirely; refund flow doesn't need a settlement price.

Concretely, `lock_and_settle` should: (1) call `lock_settlement_snapshot` to determine path state; (2) only call `lock_settlement_from_latest` on the oracle if state ∈ {Resolved}; (3) on Aborted, skip oracle steps and emit a distinct event so the keeper knows to stop pushing oracle ticks.

Also: add a keeper-side liveness alert if `now > market.expiry_ms + 60s` and `oracle.settlement_observation.is_none()` and `path.settlement_state != Aborted` — this is an oracle outage that needs human escalation.

**Severity.** HIGH. Markets stuck in OPEN forever if oracle outage straddles expiry and the path also has < min_observations.

---

## Finding 4 — `frozen` flag interaction with `record_range` is unspecified

**Question.** Doc 02 says `frozen` halts updates post-lock-settlement. Doc 05 has post-expiry freeze that returns no-op early. `record_range` reads from the oracle ring buffer by index. What if the high_idx points to an observation whose `timestamp_ms > path.expiry_ms`? Reject? Clamp?

**Current state (quotes).**
- 05 §5.2: `assert!(h_ts <= po.expiry_ms, EInvalidRange);`
- 05 §5.2: `let now = clock.timestamp_ms(); if (now >= po.expiry_ms) return; // post-expiry freeze`
- 02 §2.2: `if (po.frozen) return; // NEW: hard short-circuit ... if (now >= po.expiry_ms) return; // NEW: refuse all updates after expiry`

**Verdict.** Three layered guards but they conflict in semantics. Doc 05's `record_range` aborts (`EInvalidRange`) if `high_obs.ts > expiry_ms` — which means a keeper that submits a range crossing expiry gets a transaction failure (gas burned, telemetry noise). Doc 02 says `record()` becomes a *silent no-op* when frozen. So `record` and `record_range` have inconsistent post-expiry behavior: silent no-op vs hard abort. Worse, doc 02's `frozen: bool` field is supposed to be `friend market` and flipped by `lock_settlement` — but doc 05's PathObservation struct doesn't include a `frozen` field at all, only `settlement_snapshot: Option<PathSnapshot>`. The `frozen` flag and the snapshot are two independent freeze mechanisms.

**Recommended resolution.** Pick one freeze primitive — the snapshot is structurally stronger because it captures values, not just a flag. Delete `frozen: bool` from doc 02. Make `settlement_snapshot.is_some()` the single source of "frozen". For `record_range` with a partially-post-expiry range: clamp `h_ts = min(h_ts, expiry_ms)` and look up the corresponding pre-expiry observation by reverse-walking the ring buffer (or simpler: reject with a clear `EHighObsPostExpiry` error and let the keeper resubmit with a tighter range).

**Severity.** MEDIUM. Honest keepers will hit this within the first hour of testnet. Symptom: random `record_range` failures around expiry boundaries.

---

## Finding 5 — "N consecutive ticks" semantics is ambiguous

**Question.** Doc 05 says `MIN_TOUCH_CONFIRMATIONS = 3` consecutive crossings required. What is "consecutive"? N consecutive `apply_observation` calls? N within a window? N consecutive *crossings* with possible non-crossings ignored? Does a single non-crossing tick reset the counter?

**Current state (quotes).**
- 05 §5.1: `if (is_touch_price(po, obs_price)) { po.consecutive_cross_count = po.consecutive_cross_count + 1; ... } else { po.consecutive_cross_count = 0; };`
- 05 §1: `Sticky-touch correctness. touched_at = Some(ts) only if at least MIN_TOUCH_CONFIRMATIONS = 3 consecutive in-window oracle observations crossed the buffered trigger. A single bad tick cannot lock the outcome.`
- 05 §5.2: `record_range collapses an entire interval. Treat it as confirming (touch_confirmations_required) — a Lazer-attested high above the trigger across an interval is stronger than a single tick. po.consecutive_cross_count = po.touch_confirmations_required;`

**Verdict.** Spec is internally consistent for `record` (single non-crossing tick resets to 0). But it under-specifies the interaction between `record` and `record_range`: a `record_range` call sets the counter to `touch_confirmations_required` directly, fires touch immediately. So a single `record_range` with an interval-high above trigger fires touch in one call — completely bypassing the "3 consecutive" defense for ring-based reconstruction. That is documented (the rationale is "interval-high is stronger than a single tick"), but it creates an attack surface: the keeper can choose to submit one `record_range` instead of 3 `record` calls and fire touch on the first crossing.

Also unspecified: what counts as "in-window"? An observation with `timestamp_ms < last_seen_ms` is dropped before the counter is touched (the stale-tick guard), so it neither increments nor resets. But what about an observation with `timestamp_ms == last_seen_ms`? The guard uses `<=` for `record` (drops) but doc 05 has no equivalent guard for `record_range` — duplicate timestamps slip through.

**Recommended resolution.** Document the "interval high counts as N confirmations" rule loudly in the threat model, since it's the one path that bypasses the multi-tick defense. Add a `record_range`-specific minimum interval width (e.g. `h_ts - l_ts >= MIN_RANGE_MS`) to prevent a degenerate "1-millisecond range" from being a single-tick equivalent. Add a duplicate-timestamp guard to `record_range`. Also clarify: the counter resets on any non-crossing `record` tick, but `record_range` does NOT reset — it only ratchets up. Asymmetric behavior is a footgun for keeper authors.

**Severity.** MEDIUM. Subtle but real attack surface; bypass requires keeper cooperation, so MVP-safe but production-fragile.

---

## Finding 6 — `PathSnapshot` and `FeeSnapshot` are two snapshots of overlapping data

**Question.** Doc 05 introduces `settlement_snapshot: Option<PathSnapshot>`. Doc 02 introduces `fee_snapshot: Option<FeeSnapshot>`. Both capture `max_seen`, `min_seen`, `touched_at`. Are they captured at the same moment? Same atomic transition? Different functions? Could they ever diverge?

**Current state (quotes).**
- 05 §4: `PathSnapshot { state, max_seen, min_seen, touched_at, observation_count, locked_at_ms }`
- 02 §1.1: `FeeSnapshot { final_max_seen, final_min_seen, final_touched_at, barrier, direction, ... touch_exposure_local, no_touch_exposure_local, pwe_touch_global, pwe_no_touch_global, winning_side, settled_at_ms, snapshot_version }`
- 02 §1.1: `lock_settlement calls path_observation::freeze(path, ctx) before reading max_seen/min_seen.`
- 05 §6: `lock_settlement_snapshot ... po.settlement_snapshot = option::some(PathSnapshot { ... })`

**Verdict.** Two snapshots of the same path data, captured by two different functions (`lock_settlement` per doc 02, `lock_settlement_snapshot` per doc 05), neither of which is the function doc 01 names (`lock_and_settle`). FeeSnapshot duplicates path fields (max_seen, min_seen, touched_at) for "self-containment" so the path object can be GC'd — but PathSnapshot is the on-path freeze. If they are captured non-atomically they can diverge: a `record` call between PathSnapshot lock and FeeSnapshot lock could change live `max_seen`, and FeeSnapshot would read the stale path field unless it reads from the snapshot.

**Recommended resolution.** Define one canonical settle function (`lock_and_settle` per doc 01) that does, in this order, atomically:
1. `path_observation::lock_settlement_snapshot(path, clock)` → freezes PathSnapshot.
2. `oracle.lock_settlement_from_latest()` if state == Resolved, skip if Aborted.
3. Build `FeeSnapshot` by reading exclusively from `path.settlement_snapshot.borrow()` and `registry.pwe_*_ewma()`. FeeSnapshot's `final_max_seen` etc. are copies of PathSnapshot's, not independent reads.
4. Mutate `market.status` and `market.fee_snapshot`.

This collapses two snapshots to one read source of truth (PathSnapshot) with FeeSnapshot as a derived denormalized cache for fee-hot-path performance. Add an invariant test: `fee_snapshot.final_max_seen == path.settlement_snapshot.max_seen` always.

**Severity.** HIGH. Without atomicity, a tx-ordering attack between two settle calls is possible. With the proposed atomic single-function flow it becomes impossible by construction.

---

## Finding 7 — Wind-down state propagation is under-specified across modules

**Question.** Doc 04 says wind-down halts opens. Does it also halt: settlements? Tournament continuation? CLOB trading on settled coin pools? OTC escrow? `early_unwind` on the BTC route? `claim_queued_payout` on the queue? `redeem_dust_share`? `release_stale_lock`? Specify the global semantics explicitly.

**Current state (quotes).**
- 04 §7.2: `// All open paths revert ... // Settle still runs (so unsettled markets resolve) ... // Wind-down does NOT block settle — markets must resolve to know payouts ... // Redeem returns pro-rata payout from §7.3`
- 04 §3 inv9: `Wind-down monotonicity (v2): once Q > daily_volume_ewma × 30 is observed and the wind-down flag is set, the protocol enters WIND_DOWN mode irrevocably; opens are forbidden, only closes/redeems run.`

**Verdict.** Doc 04 names "open" and "redeem" but is silent on the dozen other entry points across docs 01, 05, 06, 07. Specifically:
- Doc 01's `claim_queued_payout` and `claim_dust_share` — should still run (they are pure pay-outs from already-funded queue entries)
- Doc 01's `release_stale_lock` — under wind-down, where does the released lock go? Treasury (which is being pro-rata distributed) or directly to wind-down pool?
- Doc 01's `lock_and_settle` — must still run per doc 04, but does it now produce SETTLED_TOUCH/NO_TOUCH or transition directly to a wind-down-specific state for pro-rata payout?
- Doc 05's `lock_settlement_snapshot` — must still run for unsettled markets
- Doc 06's `early_unwind` — pre-expiry exit on BTC; in wind-down should this be blocked (we want orderly close), allowed (user wants out), or reduced-fee (we want to incentivize closing)?
- Doc 06's `reconcile` and `redeem_btc_touch` — these run against a `SettlementBucket`, which has its own `pro_rata_factor_e9` independent of the main vault wind-down's pro-rata factor. Two pro-rata factors stacked is undefined.

Also: doc 04 says tournament vaults are isolated (§2.5) — fine. But if the *main* vault enters wind-down, do tournament markets continue trading? They share `WickOracle` and `PathObservation` infrastructure, both of which are presumably still functioning. Spec doesn't say.

**Recommended resolution.** Write a separate "Wind-down state propagation matrix" doc (or a §7.6 in doc 04) that lists every public entry point in the protocol and its wind-down behavior. Suggested defaults:
- Pure pay-out flows from already-resolved obligations: ALLOW (claim_queued_payout, claim_dust_share, redeem on settled markets).
- Settlement flows that resolve in-flight markets: ALLOW (lock_and_settle, lock_settlement_snapshot).
- Settlement-lock release: REROUTE to wind-down pool, not treasury.
- New opens: BLOCK (already in spec).
- Early-unwind: ALLOW with reduced fee (encourage exit).
- Tournament markets: continue under their isolated vault unless the *tournament* vault hit its own wind-down trigger.
- BTC route SettlementBuckets: independent of main vault wind-down. Their pro-rata factor is computed against Predict's payout, not Wick's main vault.

**Severity.** HIGH. Wind-down is an explicit safety mechanism; under-specifying its scope means it cannot ship safely.

---

## Finding 8 — `OracleVersionLock` revert behavior is end-to-end unspecified

**Question.** Doc 06 says `OracleVersionLock` pins `predict_pkg + obj_id` and "fails closed on upgrade." What is the user-facing behavior? Position stuck? Refund mechanism? Manual migration with new ticket? Does the keeper detect this and pause?

**Current state (quotes).**
- 06 §5: `If Mysten ships a Predict upgrade that changes the package address (or changes the shared object), all in-flight Wick operations fail-closed until Wick's admin runs migrate. Stuck funds are still withdrawable by the user directly via predict_manager::withdraw (the user is owner) — Wick wrappers freeze, but the user's underlying DUSDC is never captured.`
- 06 §8 row 11: `OracleVersionLock (§5) freezes Wick on package mismatch. Per-user managers mean users can always recover funds via direct predict_manager::withdraw without Wick.`

**Verdict.** Doc 06 partially answers the question but leaves three gaps:
1. The user can withdraw their DUSDC via `predict_manager::withdraw`, but they still hold a `WickClaimTicket` that points at a `MarketKey` and has `payout_if_win` denominated in promised Wick payout, not Predict bid. After the user takes their DUSDC home, the ticket is orphaned. Does it stay on-chain forever? Burnable how?
2. After admin runs `migrate(new_pkg, new_obj_id)`, do existing tickets minted under the old version become valid for redemption against the new Predict instance? They reference the old `predict_pkg` indirectly through their `MarketKey` (which encodes `oracle_id`); the new Predict instance has different oracle objects.
3. Doc 06 says `oracle_version_lock::assert_matches` is called at the top of every wrapper. But `redeem_btc_touch` calls `assert_matches_id(lock, account)` — a different function the spec doesn't define. Probably a typo for `assert_matches`, but the user's `account` was bootstrapped against the *old* `pinned_predict_pkg`, so even after migration the user's account fails the assertion.

**Recommended resolution.** Add a `migrate_account(old_account, new_account, lock)` flow that lets users opt in to migrate their UserPredictAccount and any open tickets to a new Predict version. Tickets minted pre-migration must either (a) be force-resolved through the OLD Predict instance (kept around as a read-only legacy object) or (b) be refunded at premium-paid amount with a "protocol pause refund" event. Pick (b) for MVP — simpler, no dual-instance maintenance.

Also: define what happens to `SettlementBucket` objects keyed against the old Predict's oracle IDs. They become unreachable from new Wick wrappers. Either (a) extend `SettlementBucket` to optionally point at a snapshotted lock version, or (b) commit to never migrating mid-bucket (i.e., only allow migration when no buckets are pending finalization).

**Severity.** MEDIUM for MVP (Predict isn't going to upgrade during the hackathon), but HIGH if we ship to mainnet without resolving.

---

## Finding 9 — TournamentVault state vs main vault state is independent — but cross-state interactions undefined

**Question.** Doc 04 says tournament markets isolated. If main vault enters wind-down, what happens to active tournaments? If a tournament vault enters its own wind-down, does the main vault know? Are tournament wind-downs reported to global telemetry?

**Current state (quotes).**
- 04 §2.5: `Tournament markets do not back to MartingalerVault<C>. Each tournament T instantiates its own TournamentVault<C, T> shared object, seeded entirely from: 1. The tournament pot (entry fees), 2. Optional sponsor seed, 3. Nothing else.`
- 04 §6.1: `Tournament-induced stress is contained ... When a tournament vault is exhausted with positive queue: Tournament's TournamentVault enters wind-down ... Main vault unaffected.`
- 04 §3 inv7: `Tournament isolation (v2): treasury(MartingalerVault<C>) ∩ {payouts to tournament market positions} = ∅.`

**Verdict.** Doc 04 explicitly says they're independent on the money side. Good. But there are three implicit couplings:
1. **Shared infrastructure**: TournamentVault markets use the same `PathObservation`, `WickOracle`, `OracleVersionLock`, and `GlobalExposureRegistry` (per doc 02 §4.4: "the random-walk arcade markets share a registry only with each other (not with BTC)" — but tournament markets on BTC presumably do share the BTC registry). So a tournament close affects `pwe_touch_global` for the BTC main vault's caps.
2. **Settlement ordering**: Doc 04 §2.6 mandates deterministic settle ordering by `market_id`. Tournament markets and main markets have disjoint market_id spaces (or do they? spec doesn't say). If they share the ID space, a single block can interleave tournament settles and main settles — both must be ordered together.
3. **Wind-down telemetry**: When a tournament vault winds down, the indexer should publish a global "Wick degraded" signal. Doc 04 doesn't define this event.

**Recommended resolution.** Add a §2.5.1 to doc 04: "TournamentVault markets share `PathObservation` and `WickOracle` infrastructure with main markets. They share the `GlobalExposureRegistry<U>` only if `tournament.uses_main_underlying == true`; arcade tournaments on RWALK have isolated registries. Tournament market_ids share the ID space with main markets and participate in the same per-block deterministic settle ordering. Tournament vault wind-down emits `TournamentVaultWoundDown` event, distinct from main vault `WindDownActivated`."

**Severity.** MEDIUM. Demo-runnable as long as we don't combine BTC tournaments with BTC main markets in the same block — but production needs explicit specification.

---

## Finding 10 — `touched_at` sticky vs N=3 confirmation creates an off-by-one

**Question.** Doc 05 says `touched_at` is sticky once `Some`. The 3-confirmation requirement — does the COUNT have to reach 3 before `touched_at` is `Some`? Or is `touched_at` set on the first crossing and "confirmed" if 3 land? What's the touch timestamp — first crossing or third?

**Current state (quotes).**
- 05 §5.1: `if (is_touch_price(po, obs_price)) { po.consecutive_cross_count = po.consecutive_cross_count + 1; if (po.consecutive_cross_count >= po.touch_confirmations_required && option::is_none(&po.touched_at)) { po.touched_at = option::some(obs_ts); ... }; }`
- 05 §1: `touched_at = Some(ts) only if at least MIN_TOUCH_CONFIRMATIONS = 3 consecutive in-window oracle observations crossed the buffered trigger.`

**Verdict.** Spec is clear: `touched_at` is set on the THIRD consecutive crossing, with `obs_ts` being the timestamp of that third tick. This is consistent — but the resulting `touched_at` value is the third-crossing timestamp, not the first-crossing timestamp. UI showing "touched at 14:32:01" will report the confirmation time, not the actual first-crossing time. Worse, fee/payoff models that depend on "how decisively did we cross" implicitly use `final_max_seen` (which is monotonic) instead of the touch timestamp, so this is mostly a UX issue.

But there's a subtle invariant: if the first crossing happens at `t1`, second at `t2`, third at `t3`, then `touched_at = t3`. Now the keeper observes `record_range` of `[t0, t3]` later (after expiry, in pre-freeze cleanup): `record_range` would set `touched_at = t3` (the high-side timestamp). Consistent. But if the keeper instead does `record_range([t0, t1])`, the high-side is `t1` and `record_range` would fire `touched_at = t1` — a different timestamp than the original `record`-based path would produce.

So `touched_at` is *not* unique to a (path, settlement) pair — it depends on the order/granularity of `record` vs `record_range` calls.

**Recommended resolution.** Document that `touched_at` is best-effort UX timestamp, not a load-bearing semantic value. Make settlement decisions depend exclusively on `touched_at.is_some()` (boolean) and `final_max_seen` / `final_min_seen` (frozen extremes). Never key payout amounts or fees off the timestamp value. Optional: add a separate `first_touch_observation_idx: Option<u64>` field that's set once and never updated, derived from the ring buffer.

**Severity.** LOW. UX inconsistency only as long as no downstream logic keys on the timestamp value.

---

## Finding 11 — Settled-coin trade on CLOB after `Market.status = SETTLED` is undefined

**Question.** Doc 07 (CLOB) says UI filters settled markets. But on-chain, can someone still place a limit order on the settled coin's pool? What does the keeper do with stale orders?

**Current state (quotes).**
I haven't read doc 07 in this validation pass; the question is referenced from the prompt. Doc 04 says "deterministic settle ordering" but doesn't address CLOB pool state at settlement. Doc 01 says `market.status` becomes SETTLED_* atomically, but the position Coin (per task #85 "Coin'ify positions") presumably continues to exist in users' wallets and could be tradeable on a DeepBook v3 pool that doesn't know the underlying market settled.

**Verdict.** Inferred without doc 07: the settled-coin pool is a DeepBook v3 object that has no on-chain awareness of `market.status`. Users with limit orders on the pool will still have those orders matched after settlement, trading post-settlement positions for DUSDC at potentially zombie prices. Without an on-chain freeze hook this is a fund-loss vector.

**Recommended resolution.** Specify in doc 07 (when written) that: (a) `lock_and_settle` calls a `clob_listing::cancel_pool_orders(market_id)` hook, OR (b) the settled position Coin has zero value post-settlement (only redeemable via Wick's `redeem_position`), so any post-settlement CLOB trade is implicitly a transfer of a worthless coin (caveat emptor) — but the UI must hard-block this.

For MVP demo: simplest fix is a `Market.status_witnessable_via_coin_metadata` pattern where the position Coin's display metadata updates on settlement and DeepBook UIs typically refuse to display zero-value coins. Document the limitation loudly in the trader-facing copy.

**Severity.** MEDIUM. Real loss vector but only triggers if a trader leaves a stale limit order on a settled market — uncommon for MVP demo, common for prod.

---

## Finding 12 — `Aborted` refund mechanics interact undefined with the queue

**Question.** Doc 05 says `market::redeem` honors Aborted with 1:1 refund. Does this refund go through `settlement_lock`? Bypass the queue? What if the vault is in queue-deficit state (queue_total > 0)?

**Current state (quotes).**
- 05 §7: `if (path_observation::snapshot_state(snap) == SETTLEMENT_ABORTED) { return refund_one_to_one(market, position, ctx) }`
- 05 §7: `refund_one_to_one returns the position holder's amount of C from the collateral vault, decrementing whichever supply (touch or no_touch) the position belonged to. The collateral invariant holds because both sides drain proportionally.`
- 01 §2.3 redeem_position branch (a): `if (queue_total > 0) { ... enqueue_one(vault, market.id, position, owed); ... }`

**Verdict.** Two redeem paths exist with conflicting routing:
- Doc 05's `refund_one_to_one` (for ABORTED markets): pays directly from "the collateral vault" (which one? per-market settlement_lock or main treasury?), bypassing the queue entirely.
- Doc 01's `redeem_position`: routes through the queue if `queue_total > 0`, regardless of why the holder is being paid.

If the vault is in queue-deficit state and an aborted market's holder calls `redeem`, doc 05 says they get 1:1 refund; doc 01 says they go to the back of the queue. These are incompatible.

Worse, `refund_one_to_one` bypasses the queue, which means a stream of aborted markets while queue_total > 0 effectively front-runs every queued winner. This violates INV-14 (queue-head priority).

The aborted market also never created a `settlement_lock` (per Finding 3's recommended resolution), so there's no per-market reservation to draw from. Refund must come from somewhere — probably treasury or a dedicated "refund pool" sourced from the market's never-locked-in stakes. But doc 01's atomic `lock_and_settle` already moved losing-stake to treasury and queue heads. For an aborted market, BOTH sides' stakes need to be refunded, so neither was "losing" — but the original `open_position` already booked all stakes into treasury and routed some through queue heads.

**Recommended resolution.** Treat ABORTED settlement as a separate flow:
1. `lock_and_settle` on aborted path skips PHASE 2 (no settlement_lock), skips PHASE 3 (no losing stake — both sides win), skips PHASE 4 (no enqueue), and instead reserves `total_stake = touch_exposure_stake + no_touch_exposure_stake` from treasury into a per-market `abort_refund_pool: Balance<C>` (sibling table to settlement_locks).
2. If treasury < total_stake (because earlier opens routed through queue heads), the difference is enqueued as an "abort refund obligation" at the queue tail, ranked after existing winners — refunds are best-effort, queued winners still come first.
3. `refund_one_to_one` in `market::redeem` reads from `abort_refund_pool[market_id]`, not the main treasury.

Add an INV-20: aborted markets do not create `settlement_locks` entries; they create `abort_refund_pool` entries. The two tables are disjoint per market.

**Severity.** CRITICAL. Without this, an aborted market on a queue-deficit vault either (a) silently fails to refund, (b) violates INV-14, or (c) double-spends treasury that was already promised to queued winners.

---

## Finding 13 — Touch fired after expiry but before lock_and_settle: does it count?

**Question.** Keeper laggy. Latest oracle obs is post-expiry, has crossed barrier, would be the 3rd confirmation. Does it count as a touch?

**Current state (quotes).**
- 05 §5.1 (record): `if (now >= po.expiry_ms) { return }` — `record` becomes a no-op past expiry.
- 05 §5.2 (record_range): `if (now >= po.expiry_ms) return; // post-expiry freeze`
- 05 §6: `apply_observation accepts post-expiry ticks (needed for settlement lock) but path-side mutation logic (§5) refuses to advance ... touched_at past expiry_ms.`

**Verdict.** Spec is clear: post-expiry observations cannot fire a touch. The third confirmation tick must arrive before `expiry_ms` for `touched_at` to be set. If the keeper is laggy and the third confirmation arrives at `expiry_ms + 100ms`, the path resolves to NO_TOUCH (assuming `min_observations` was met) or ABORTED (if not).

This is a sharp edge: a TOUCH market where the price visibly crossed the barrier in the chart but the third confirmation landed 100ms late will resolve as NO_TOUCH and pay no-touch holders. Trader-visible outcome contradicts trader-visible chart.

**Recommended resolution.** This is a design choice, not a bug — but it deserves explicit trader-facing copy and a documented invariant. Two options:
1. Accept the rule as-is. Document loudly: "Touch is the oracle-observed touch; off-chain chart wicks that land too close to expiry may not be confirmed." Add a UI "settlement may differ from chart wicks near expiry" warning.
2. Allow a "post-expiry confirmation grace" of `confirmation_grace_ms` (e.g. 5s). During this grace, post-expiry crossings can still confirm a touch whose first/second crossings happened pre-expiry. Adds keeper-coordination complexity but better matches trader expectations.

For MVP: pick (1), document.

**Severity.** LOW (semantic-policy choice, not a bug) — but absolutely must be documented or it's a UX disaster on first demo where a pump-and-retreat near expiry doesn't confirm.

---

## Finding 14 — `expiry_ms` consistency across PathObservation, Market, WickOracle is unenforced

**Question.** Doc 05's PathObservation has `expiry_ms`. Doc 01's Market has `expiry_ms`. Doc 05's WickOracle has `expiry_ms`. Are these synchronized? Can they drift? Who is the source of truth?

**Current state (quotes).**
- 05 §10: `let path = PathObservation { ... expiry_ms: wick_oracle::expiry_ms(oracle), ... }` — Path inherits from Oracle at construction.
- 01 §1: `Market<phantom C> has key { ... expiry_ms: u64, ... }` — Market has its own field, set at create_market.
- 01 §2.7 create_market: `assert!(expiry_ms > clock.timestamp_ms() + MIN_MARKET_DURATION_MS, EExpiryTooSoon);` — no cross-check against the path's expiry_ms or the oracle's expiry_ms.

**Verdict.** Three independent `expiry_ms` fields with no on-chain cross-check at market creation. If `market.expiry_ms = 1000` but `path.expiry_ms = 1500` (because the path was created against an oracle with a later expiry), then:
- `lock_and_settle` checks `now >= market.expiry_ms == 1000` → succeeds at t=1000.
- It calls `lock_settlement_snapshot(path)` which checks `compute_settlement_state(po, clock)` — at t=1000, `now < po.expiry_ms == 1500` → returns `NotReady` → asserts `state != SETTLEMENT_NOT_READY` → REVERT.
- Market is stuck OPEN until t=1500.

In the other direction (market expires after path), the market remains OPEN past the path's resolution and can accept new opens against a path that's already snapshotted.

**Recommended resolution.** Make `Market.expiry_ms` a derived field, not a constructor parameter. `create_market` takes a `path_id: ID` (not just an `oracle_id`) and reads `expiry_ms` from the path at construction:
```move
public fun create_market<C>(... path: &PathObservation, ...) {
    let market_expiry = path_observation::expiry_ms(path);
    let market = Market<C> { ..., expiry_ms: market_expiry, oracle_id: path_observation::oracle_id(path), path_id: object::id(path), ... };
}
```
Add INV-21: `market.expiry_ms == path.expiry_ms == oracle.expiry_ms` for every triple bound by `market.path_id` and `path.oracle_id`.

**Severity.** HIGH. Easy to ship a demo where these drift (especially with a separate keeper-driven oracle) and produce undecidable markets. Constructor enforcement removes the ambiguity.

---

## Finding 15 — `release_stale_lock` and Aborted markets interaction

**Bonus finding surfaced during validation.**

**Question.** Doc 01 has `release_stale_lock(market, vault, clock, ctx)` that asserts `market.status ∈ {SETTLED_TOUCH, SETTLED_NO_TOUCH}`. After `stale_lock_window_ms`, unredeemed lock returns to treasury and market becomes STALE_RELEASED. What happens to an aborted market's `abort_refund_pool` (from Finding 12) if holders never claim within the stale window?

**Current state (quotes).**
- 01 §2.6: `assert!(market.status == SETTLED_TOUCH || market.status == SETTLED_NO_TOUCH, ENotSettled);`

**Verdict.** Aborted markets are excluded from `release_stale_lock` because the assertion gates on SETTLED_TOUCH/SETTLED_NO_TOUCH only. An aborted market's `abort_refund_pool` would sit forever if any holder fails to redeem.

**Recommended resolution.** Extend `release_stale_lock`'s gate to include SETTLED_ABORTED, with the released `abort_refund_pool` returning to treasury (or to a dedicated insurance fund per H10). Add `STALE_RELEASED_ABORTED` market status if we want to distinguish in event logs.

**Severity.** MEDIUM. Won't bite during demo (24h window). Will bite production if any aborted market is forgotten.

---

## Summary table

| # | Title | Severity | Cross-doc |
|---|-------|----------|-----------|
| 1 | Market.status enum defined three different ways | CRITICAL | 01, 02, 05 |
| 2 | lock_and_settle precondition on PathObservation unspecified | CRITICAL | 01, 02, 05 |
| 3 | First post-expiry observation latch can deadlock lock_and_settle | HIGH | 01, 05 |
| 4 | frozen flag interaction with record_range under-specified | MEDIUM | 02, 05 |
| 5 | "N consecutive ticks" semantics ambiguous | MEDIUM | 05 |
| 6 | PathSnapshot vs FeeSnapshot — two snapshots, non-atomic | HIGH | 02, 05 |
| 7 | Wind-down state propagation under-specified | HIGH | 04, 01, 06 |
| 8 | OracleVersionLock revert behavior end-to-end unspecified | MEDIUM | 06 |
| 9 | TournamentVault vs main vault cross-state | MEDIUM | 04, 02 |
| 10 | touched_at sticky vs N=3 — off-by-one timestamp semantics | LOW | 05 |
| 11 | Settled-coin CLOB trade post-settlement | MEDIUM | 07 (inferred) |
| 12 | Aborted refund mechanics + queue interaction | CRITICAL | 01, 05 |
| 13 | Touch fired post-expiry: counts? | LOW (policy) | 05 |
| 14 | expiry_ms consistency across modules unenforced | HIGH | 01, 05 |
| 15 | release_stale_lock excludes Aborted markets | MEDIUM | 01, 05 |

**Three CRITICAL findings** (1, 2, 12) all converge on the same architectural gap: the design corpus does not have a single agreed-upon home for the ABORTED resolution path. Doc 05 introduces it; docs 01 and 02 don't acknowledge it; the refund mechanics, market status enum, and queue interaction all break at the seam. Recommended single-fix addresses all three: write a foundation doc that pins the canonical 5-value Market.status enum, defines `lock_and_settle` as the single atomic settle entry point that calls `lock_settlement_snapshot` first and dispatches three-way (Resolved-touch / Resolved-no-touch / Aborted), and defines `abort_refund_pool` as the per-market table sibling to `settlement_locks` that funds the refund flow.

End of validation 02.
