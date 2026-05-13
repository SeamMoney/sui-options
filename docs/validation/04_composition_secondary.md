# 04 — Composition & Secondary-Market Boundary Validation

**Scope.** This pass cross-references the v2 design docs at the *composition seams*: where Wick meets Predict (BTC route), DeepBook v3 CLOB (secondary), Pyth Lazer (primary oracle), and the gamification/indexer surface. Every issue below is an inconsistency *between* docs — internal contradictions inside a single doc are out of scope (covered by the per-doc red-teams).

**Sources read.** `06_predict_btc_route_v2.md`, `07_deepbook_clob_v2.md`, `05_path_observation_v2_hardened.md`, `08_gamification_v2.md`, `01_martingaler_accounting_v2.md` (skim), `09_events_indexer_v2.md` (skim).

**Severity legend.** Critical (ship-blocker), High (must fix before mainnet), Medium (must fix before flagship demo), Low (clarifying ambiguity), Info (open question, not yet a bug).

Findings: 14.

---

## Q1. CLOB pool creation atomicity vs witness OTW publish

**Quotes.**
- Doc 07 §2: *"v2 collapses everything after T0 into a single PTB. The witness publish itself remains its own transaction (Sui's CLI does not currently support `publish` inside a PTB containing other move-calls), but the witness module is intentionally not bound to the market until step (2)."*
- Doc 07 §2 closing the gap: *"Submission discipline. The keeper script publishes the witness and immediately submits the bootstrap PTB in the very next API call — typical end-to-end is <500 ms. Window of vulnerability is one block."*
- Doc 07 §10 test 1: *"flagship bootstrap with witness publish + market creation + 2 pool creations + `set_clob_pools` lands in two transactions."*

**Verdict.** The user's framing in Q1 is contradicted by doc 07. The doc is explicit that witness publish is **necessarily a separate transaction** because Sui PTBs cannot contain a `publish` opcode mixed with `moveCall`s. The `TreasuryCap`/OTW lives in T0; the bootstrap PTB consumes it in T1. So the "atomic with market bootstrap" claim is slightly misleading: only steps 1–6 are atomic, not the witness publish itself. The doc acknowledges this and addresses the resulting front-run window with name opacity + `EPoolAlreadyExists` revert.

The composition issue: **doc 07 says the bootstrap PTB calls `create_permissionless_pool<Position<M, Touch>, DBUSDC>`** as type arguments. For DeepBook to accept these as a *coin* type (which CLOB requires), the witness must have already published a `Position<M, Touch>: drop, store + has Coin metadata` — i.e. `coin::create_currency` must have been invoked, producing a `TreasuryCap<Position<M, Touch>>` in T0. Doc 07's pseudocode shows `touchCap, noTouchCap = await waitForCaps(witnessPkg)` which presupposes this. But doc 07 does not actually show the witness module's `init` body, so it's not obvious that the per-market `coin::create_currency` happened with the OTW. This is an under-specified seam.

**Resolution.** Add to doc 07 §2 an explicit witness-module skeleton showing `init(otw: M, ctx)` calling `coin::create_currency<Position<M, Touch>>(...)` and `coin::create_currency<Position<M, NoTouch>>(...)`, both `transfer::public_transfer(treasury_cap, sender)`. Then the bootstrap PTB consumes both caps. This makes the OTW-coin compatibility explicit. Also: name the *risk* clearly — if a future Sui release allows `publish` inside a PTB, fold the publish in and remove the front-run vector entirely. Track as a follow-up.

**Severity.** Medium (under-specified seam; not a bug, but the implementer needs the witness skeleton spelled out).

---

## Q2. OracleVersionLock fail-closed vs CLOB pools holding orders

**Quotes.**
- Doc 06 §5: *"Every Wick predict-route call passes `&OracleVersionLock` and asserts at the top of the body. If Mysten ships a Predict upgrade that changes the package address (or changes the shared object), all in-flight Wick operations fail-closed until Wick's admin runs `migrate`."*
- Doc 06 §5 (continued): *"Stuck funds are still withdrawable by the user directly via `predict_manager::withdraw` (the user is owner) — Wick wrappers freeze, but the user's underlying DUSDC is never captured."*
- Doc 07 §6 (settled-coin handling): *"the CLOB pool keeps trading and a clueless buyer pays $0.30 for a worthless coin"* — handled for *settled* markets via `MarketSettled`. **No equivalent handling for "Predict-version-locked" markets exists in doc 07.**

**Verdict.** This is a real inconsistency. If `OracleVersionLock` freezes Wick's BTC route, the BTC-route flagship CLOB pools (Touch + NoTouch coins of that market) are still tradable on DeepBook. New buyers can acquire `WickPosition<M, Touch>` coins that they will never be able to redeem until `migrate` lands. There is no on-chain signal to the indexer/UI to flag these pools as "frozen pending migration."

The asymmetry: `MarketSettled` is emitted at settlement, but lock-induced freeze has no analogous event. The indexer cannot proactively pull pools from the UI. Worse, the BTC-route doesn't even use `WickPosition` *coins* — it uses `WickClaimTicket` (see Q4) — so the BTC route doesn't list on CLOB at all per doc 06's design. But other routes (SUI / random-walk) do have CLOB listings, and *they* could also be affected if the lock pattern is generalized to other oracle adapters.

**Resolution.** Add to doc 05 (or create a new `wick::version_lock` module) an `OracleLockFrozen { lock_id, oracle_kind, frozen_at_ms }` event emitted on freeze, mirroring `MarketSettled`'s indexer→UI flow. Add to doc 07 §6 an explicit "frozen-pool" UI state distinct from settled. Confirm in doc 06 that the lock applies to BTC route only and that other routes are out of scope, OR generalize the lock pattern to all adapters (probably the right call — Pyth Lazer publisher rotations could create the same situation for SUI markets).

**Severity.** High (silent zombie-trade vector on operator-induced freeze; same class as Attack 3 in doc 07's red-team but not addressed).

---

## Q3. PathObservation's role in BTC route — record or skip?

**Quotes.**
- Doc 06 §6: *"`wick::path_observation` gains a route-specific entrypoint that consumes `OracleSVI` directly: `record_from_oracle_svi(path, oracle, lock, clock)`. … The other routes (SUI, SP500, random-walk) keep their existing `record(path, wick_oracle, clock)` entrypoint — the mirror is still useful for sources Wick controls. Only the BTC route uses `record_from_oracle_svi`."*
- Doc 05 §5.1: `record(po, oracle: &WickOracle, clock)` is the only entry signature shown. No `record_from_oracle_svi` exists in doc 05's source listing.
- Doc 06 §6.2: *"At settlement-lock time, Wick reads `oracle::settlement_price(&OracleSVI)` directly. There is no Wick mirror to consult, so there is no two-keeper divergence to detect."*

**Verdict.** Direct contradiction. Doc 06 specifies a function (`record_from_oracle_svi`) that does not appear in doc 05's hardened spec. Doc 05's `WickOracle` struct has `driver_kind` values 0 (lazer_verified), 1 (lazer_pull_multisig), 2 (predict), 3 (random_walk) — the `predict = 2` slot exists but doc 05's `apply_observation` dispatch shows no driver-specific code path for it.

The deeper architectural question: does the BTC route even *need* a `PathObservation` of its own? The Wick contract is "did the price wick into the level." Predict's `OracleSVI` provides only terminal-price binaries, not path observations. So Wick *must* maintain its own `PathObservation` to know when an intra-window touch happened. Doc 06 confirms this — `record_from_oracle_svi` exists precisely to feed BTC ticks into the path. But then `record_from_oracle_svi` must record into `WickOracle.recent_observations` (the ring buffer doc 05 §2 mandates) so that `record_range` works for replay/range proofs.

**Resolution.** Two changes required:
1. Doc 05 §5 must add `record_from_oracle_svi` to its public function list, OR Doc 06 §6 must rewrite the BTC tick path to go through `apply_observation` with a Predict-specific driver wrapper that calls `oracle::current_spot(oracle_svi, clock)` internally. The latter is cleaner — it keeps `path_observation::record` driver-agnostic and makes `predict_oracle_driver::tick(oracle_svi, wick_oracle, lock, clock)` the BTC equivalent of `pull_oracle_driver::push_price`.
2. Whichever route is chosen, the `WickOracle` for a BTC-route market must be created with `driver_kind = driver_predict()` (= 2) at construction. Doc 06 doesn't show this construction call.

**Severity.** High (contract surface is contradictory between docs; implementer doesn't know which signature to write).

---

## Q4. Per-user PredictManager world vs per-market Coin world — is WickClaimTicket CLOB-listable?

**Quotes.**
- Doc 06 §1: *"The user's wallet ends up holding three Sui objects per active BTC trade: PredictManager (shared), UserPredictAccount (shared), WickClaimTicket (owned, transferable)."*
- Doc 06 §9 struct: `public struct WickClaimTicket has key, store { … }` — *has store*, *transferable*.
- Doc 06 §4.2 `early_unwind` body: `assert!(account.user == ctx.sender(), EWrongUser);` and `assert!(account.manager_id == object::id(manager), EManagerMismatch);`
- Doc 07 §1 Tier B description: *"Position type stays `key, store` (no Coin'ification needed; saves DEEP and the per-market witness publish step)."*
- Doc 07 §5 `OtcOrder` carries `locked_position: Option<Position>`. The `Position` is the generic Wick position type, not a Coin.

**Verdict.** Multi-pronged inconsistency:

1. **`WickClaimTicket` is `has store`** (transferable). It is *not* a `Coin`. So even though it could be freely transferred between wallets, it cannot be listed on DeepBook CLOB (CLOB requires Coin types as base/quote). The BTC route is therefore necessarily a Tier B (OTC-only) market by doc 07's classification, OR a special tier doc 07 doesn't enumerate.

2. **OTC fill mechanics are broken for `WickClaimTicket`.** Doc 07's `fill_otc_ask` returns a `Position` and calls `market::transfer_position_to(position, order.maker)`. But for the BTC route, the buyer would need a `WickClaimTicket` whose `account_id` matches *their own* `UserPredictAccount` — the original ticket has `account_id` = seller's account. Transferring the bare ticket to the buyer means the buyer cannot redeem it: `redeem_btc_touch` asserts `ticket.account_id == object::id(account)` and the buyer's account has a different `account_id`.

3. **`early_unwind` ownership check.** `assert!(account.user == ctx.sender())` plus `assert!(ticket.account_id == object::id(account))` means only the original ticket holder, using their original account, can call `early_unwind`. A buyer-via-OTC who acquired the bare ticket cannot trigger early unwind.

So the BTC route's WickClaimTicket is **transferable in the type-system sense but un-redeemable by anyone other than the original account owner**. This is a footgun: a naive secondary trader could buy the ticket and find it dead-on-arrival.

**Resolution.** Three options, in order of preference:
(a) Make `WickClaimTicket` `has key` only (drop `store`). Tickets are non-transferable; secondary market for BTC route is unsupported in MVP. Document this in doc 06 and add a "BTC route secondary: NO" line to doc 07's tier matrix.
(b) Add a `transfer_ticket(ticket, new_account, ctx)` entry that re-binds `account_id` and the underlying Predict position to the new account. Requires Predict to support position migration between managers, which it doesn't. Out of scope.
(c) Build a wrapper `WickBtcCoin<M>` that is a `Coin` minted 1:1 with claim tickets, where the underlying ticket is held in escrow. Redemption goes through the escrow. Heavy lift; defer to post-MVP.

Recommend (a) for MVP. Add explicit doc text.

**Severity.** High (silent fund-loss for naive secondary buyers if `has store` ships as written).

---

## Q5. early_unwind eligibility after OTC transfer

**Quotes.**
- Doc 06 §4.1 trigger conditions: *"The Wick `PathObservation` for the position has `touched_at.is_some()`. The position's `side == SIDE_TOUCH`. … `clock < expiry_ms` (no double-settlement)."*
- Doc 06 §4.2: ownership-pinning asserts (`account.user == ctx.sender()`, `account.manager_id == object::id(manager)`, `ticket.account_id == object::id(account)`).

**Verdict.** Per Q4, OTC-transfer of a `WickClaimTicket` strands the ticket because `early_unwind`'s asserts pin the call to the original account. Even if the ticket physically reaches a new wallet, the new holder cannot:
- Call `early_unwind` (account mismatch).
- Call `redeem_btc_touch` (account mismatch).
- Hand it back to the seller for unwind (seller no longer owns it).

The position is bricked. This compounds Q4 — Q4 is the architectural seam; Q5 is the specific footgun for the most-actively-traded BTC route operation.

**Resolution.** Same as Q4 (a). If `WickClaimTicket` is non-transferable, this issue evaporates. If transferability is kept post-MVP, `early_unwind` and `redeem_btc_touch` need a delegation surface — e.g. an `Endorsement` resource the original account can mint to a buyer, transferable with the ticket.

**Severity.** High (same root as Q4; called out separately because it bites the most-liquid op).

---

## Q6. Tournament markets on CLOB — listed or not?

**Quotes.**
- Doc 08 §1.3: *"`TournamentEntry` is `key`-only (no `store`) so it cannot be transferred."*
- Doc 08 §7 anti-grief: *"Wash trades inflating volume / streaks: … Tournament markets disable secondary-market position transfer for the duration of the round."*
- Doc 07 §1 tier classification has Tier A (flagship CLOB), Tier B (OTC-only), Tier C (primary-only). No mention of tournament markets in any tier.
- Doc 08 §1.5: *"the market vaults the tournament spawns are themselves isolated from main markets; they are protocol-funded with a fixed seed liquidity from the tournament vault and recycled at settlement."*

**Verdict.** Doc 08 explicitly disables secondary transfer for tournament-spawned markets. Doc 07 does not list a "Tier D — tournament" tier and does not explain how the OTC `post_otc_ask` / `fill_otc_ask` logic should refuse to act on tournament-market positions. The two docs disagree by omission.

The right behaviour: tournament markets must reject CLOB listing AND OTC posting. The check belongs on the position type or the market type — `Market<C, M>` should carry a `tournament: bool` flag (or `kind: u8`) and `clob_listing::set_clob_pools`, `otc_escrow::post_otc_bid`, `otc_escrow::post_otc_ask` must all assert `!market.tournament`.

A separate concern: `TournamentEntry` itself is `key`-only and untransferable, but the *positions* opened *via* `bulk_open` are doc-06 `Position` objects bound to the tournament market. Doc 08 says they cannot transfer for the round. The mechanism is unspecified — is it a flag on the market read by `position::transfer`, a flag on the `Position`, or a check at the OTC entry?

**Resolution.**
1. Add `tournament: bool` (or better, `kind: u8` with `KIND_TOURNAMENT`) to `Market<C, M>` in doc 01.
2. Add to doc 07 §1 a "Tier D — Tournament markets" row: not CLOB-listable, not OTC-listable, primary-mint within tournament module only.
3. Add to doc 07 §5 (OTC) and §9 (clob_listing) the assert: `assert!(market::kind(market) != KIND_TOURNAMENT, ETournamentNoSecondary)`.
4. Add to doc 08 §1.5 explicit pointer to the doc-07 tier extension.

**Severity.** Medium (secondary leak vector if implementer follows doc 07 only and misses doc 08's anti-grief constraint).

---

## Q7. Lazer verifier vs random-walk driver mismatch in tournament markets

**Quotes.**
- Doc 08 §1.2 lock_in: *"`tournament.markets = spawn_markets(tournament, &tournament.seed, clock, ctx);`"*
- Doc 08 §1.6 / 10.1 tournament lobby: *"Synthetic asset: RWALK-25"* — confirms tournament markets are random-walk.
- Doc 05 §2: `driver_random_walk() = 3`. `apply_observation` rejects driver-kind mismatches.
- Doc 05 §3 lazer_verifier_driver: emits `apply_observation(oracle, wick_oracle::driver_lazer_verified(), obs)`.
- Doc 08 §3 Razor's Edge v2: *"Random-walk markets disqualified outright"* — confirms gamification distinguishes the two.

**Verdict.** No direct contradiction in the docs, but the construction surface for tournament markets is under-specified. `spawn_markets(tournament, seed, clock, ctx)` must:
1. Construct one `WickOracle` per market with `driver_kind = driver_random_walk()`.
2. Construct one `RandomWalk` driver state object per oracle, seeded from `tournament.seed`.
3. Construct `PathObservation` bound to each oracle.
4. Construct `Market<C, M>` with `kind = KIND_TOURNAMENT` (per Q6).

If the implementer picks the wrong `driver_kind` (e.g. `driver_lazer_verified()`), the random-walk `tick` calls will revert with `EWrongDriver` per doc 05 §2's `apply_observation` dispatch. That's a fail-loud failure mode, which is good.

The subtler concern: tournament markets must NOT use the per-trade `record` rate limit gate (doc 05 §5.1) for any path that doesn't need it. Doc 05 already restricts the rate limit to `driver_random_walk()` only — which is exactly what tournament markets use. So the rate limit *will* apply. With many parallel tournament markets all running random walks, keeper CPU/gas budget needs to be sized for "random-walk tick rate × tournament-market-count." Doc 08 doesn't size this.

**Resolution.**
1. Add to doc 08 §1.2 explicit `spawn_markets` body showing the four-step construction and the `driver_kind` selection.
2. Add to doc 08 §1.5 a sizing note: "tournament round of N markets requires N parallel `random_walk_driver::tick` cranks at the configured cadence (default 250ms); keeper budget per tournament round = N × (round_duration / 250ms) × tick_gas_cost."
3. Add a test (cross-module) confirming that `tournament::spawn_markets` produces oracles with `driver_kind == driver_random_walk()`.

**Severity.** Low (no direct bug; implementation hint missing).

---

## Q8. Charterhouse "5 distinct underlyings" counting

**Quotes.**
- Doc 08 §3 table: *"50 distinct active days AND 5 distinct underlyings traded AND held ≥10,000 WICK that was acquired ≥60 days before claim."*
- Doc 08 §3.1 Charterhouse: *"5 distinct underlyings traded. With wick's mix of BTC, SUI, SP500 (post-MVP), and random-walk synthetics, this requires breadth."*

**Verdict.** The doc enumerates "BTC, SUI, SP500 (post-MVP), and random-walk synthetics" as the available underlying space. With SP500 explicitly post-MVP, MVP underlyings are: BTC, SUI, and random-walk. That's only 3 underlyings unless random-walk synthetics count as multiple distinct underlyings.

The implicit answer is yes — each random-walk market has a distinct synthetic underlying (RWALK-25 vs RWALK-50 vs RWALK-100, etc.) generated from a distinct seed. So a user trading BTC + SUI + 3 different random-walk synthetic markets satisfies the criterion. But the doc doesn't make this explicit.

The user's framing in Q8 — "if user only ever trades BTC and Random-walk, is that 2 underlyings?" — exposes the ambiguity. If the indexer counts "BTC route" as a single underlying and "random-walk" as a single underlying regardless of how many synthetic seeds, then no MVP user can ever earn Charterhouse: max 2 underlyings (BTC + random-walk) until SP500 ships.

**Resolution.** Doc 08 §3 must define "distinct underlying" precisely. Recommended definition: *the `underlying: String` field of the `WickOracle` for the market traded.* For BTC, this is `"BTC"`. For SUI, `"SUI"`. For random-walk, this should be the *seed-specific* identifier, e.g. `"RWALK-25-seed-0xabc"`. Then trading 5 different random-walk seeds counts as 5 underlyings, and a power user can earn Charterhouse on MVP.

Alternatively, redefine the criterion to "5 distinct *markets* with distinct expiry windows" or relax to "3 distinct underlyings" for MVP and bump to 5 once SP500 lands.

**Severity.** Medium (Charterhouse is unreachable as currently spec'd; mythic badge with zero possible recipients is bad UX).

---

## Q9. Witness-bounty source — protocol fees, insurance, or new pool?

**Quotes.**
- Doc 08 §3.4 The Witness v2: *"Bounty paid in SUI from the operator_reserve of the originating market's most recent tournament cycle, not from a dedicated pool — keeps the bounty self-funded."*
- Doc 08 §1.5 vault breakdown: `operator_reserve: Balance<C>` is one of the four reserve buckets, sized at 5% of pot.
- Doc 08 §3 row 8: *"bounty is delay-escalating … Anti-MEV bounty curve (0 SUI for first 5s, full bounty by 60s); per-address daily cap"*

**Verdict.** Doc 08 specifies the source — `operator_reserve` of the originating market's most recent tournament cycle. This is consistent within doc 08 but breaks for *non-tournament* markets. Main markets (Tier A flagship CLOB, Tier B OTC-only) are not spawned by tournaments and have no `operator_reserve`. Where does the Witness bounty come from for those markets?

Three possible answers:
(a) Witness badge is only mintable for tournament-market `mark_hit` calls. Main-market keepers earn no badge.
(b) A second bounty pool exists for main-market `mark_hit`, sourced from main-market protocol fees (doc 01's `protocol_fees` balance).
(c) Each market carries its own per-market bounty pool seeded at creation.

The doc doesn't say. The frontend storyboards show "Witness" in the badge gallery without a tier filter, implying Witness should mint for any market.

**Resolution.** Doc 08 §3.4 must add: "For non-tournament markets, the bounty draws from `protocol_fees` of the parent `MartingalerVault<C>`, capped at `MAX_WITNESS_BOUNTY_PER_MS = 1 SUI/min` to bound drain. The cap escalates linearly to full bounty over 5–60s as for tournament markets." Or pick (a) and document the restriction.

**Severity.** Medium (under-specified pool source; incentive mechanism doesn't ship for ~95% of markets without a fix).

---

## Q10. Indexer event field types vs Move emit

**Quotes.**
- Doc 09 §2.3: *"`settlement_root: vector<u8>`,"*
- Doc 07 §6.1 `MarketSettled`:
  ```
  market_id: ID,
  settled_at_ms: u64,
  outcome: u8,
  touch_coin_type: TypeName,
  no_touch_coin_type: TypeName,
  touch_clob_pool_id: Option<ID>,
  no_touch_clob_pool_id: Option<ID>,
  ```
- Doc 09 §2.3 `MarketSettled` (DIFFERENT shape):
  ```
  market_id: ID,
  oracle_id: ID,
  settlement_price: u64,
  touched: bool,
  settled_at_ms: u64,
  final_vault_balance: u64,
  settlement_state: u8,
  settlement_root: vector<u8>,
  settlement_proof_height: u64,
  ```

**Verdict.** Direct contradiction. Doc 07 §6.1 and doc 09 §2.3 both define a `MarketSettled` event with different field sets. They are not subset/superset — doc 07 has `outcome`, `touch_coin_type`, `no_touch_coin_type`, pool IDs (not in doc 09); doc 09 has `oracle_id`, `settlement_price`, `touched`, `final_vault_balance`, `settlement_state`, `settlement_root`, `settlement_proof_height` (not in doc 07).

Worse, the *semantics* differ: doc 07's `outcome: u8` is `HIT | NO_TOUCH | VOID`; doc 09's `touched: bool` collapses HIT/NO_TOUCH into a binary and has separate `settlement_state: u8` for `0=normal, 1=cancelled, 2=oracle_failure_refund`. The ABORTED path from doc 05 maps to doc 09's `settlement_state = 1 or 2` but not to doc 07's `outcome = VOID` (or does it?).

This is the indexer-emit silent-break that the user's Q10 anticipated. If Move emits doc 07's shape but indexer parses doc 09's shape, the indexer drops events; if the Move emits doc 09's shape, the doc 07 settled-coin-handling flow can't compute pool IDs.

**Resolution.** Reconcile to a single canonical `MarketSettled` schema. Recommended union:
```
public struct MarketSettled has copy, drop, store {
    market_id: ID,
    oracle_id: ID,
    settlement_state: u8,             // 0=normal, 1=cancelled, 2=oracle_failure_refund/ABORTED
    outcome: u8,                       // HIT | NO_TOUCH | VOID (only meaningful when state == 0)
    settlement_price: u64,
    touched: bool,
    settled_at_ms: u64,
    final_vault_balance: u64,
    touch_coin_type: TypeName,
    no_touch_coin_type: TypeName,
    touch_clob_pool_id: Option<ID>,
    no_touch_clob_pool_id: Option<ID>,
    settlement_root: vector<u8>,
    settlement_proof_height: u64,
}
```
Update both docs to point at the canonical schema. Add a CI rule: indexer projector schema must be generated from a single TS file derived from the Move struct's BCS definition; drift fails the build.

**Severity.** High (silent indexer breakage on first settlement; the "indexer expects X but Move emits Y" bug is the exact failure mode Q10 calls out).

---

## Q11. Sliding 24h window — main vs tournament vault PnL

**Quotes.**
- Doc 08 §2.1: *"The 24h and 7d boards use sliding windows: `(now − 24h, now]` and `(now − 7d, now]`. The midnight-straddle attack … cancels because both points fall inside any window spanning both sides of midnight — net PnL ≈ 0 in every snapshot."*
- Doc 08 §2.2: *"On-chain `TraderProfile` stores raw PnL. … Indexer computes a `cluster_id` for every address … The leaderboard rendered to users is dual-layer: Raw board / Prize-eligible board."*
- Doc 08 §1.5: *"Isolated tournament vault: The pot is held in a `TournamentVault<C>` shared object, separate from the `Market<C>` collateral vaults"*
- Doc 09 §8 (referenced indirectly): tournament-specific 1s leaderboard recompute.

**Verdict.** The docs don't say whether tournament-vault PnL counts on the main 24h/7d leaderboards. Tournament markets are isolated vaults (doc 08 §1.5), but `TraderProfile.season_pnl_mist_delta` is updated on every `PositionRedeemed` regardless of which vault. If tournament wins count on the main board, a user can dominate the 24h main board by entering the tournament with high stakes and winning.

If tournament PnL is *excluded* from the main board, then the indexer projector must filter `PositionRedeemed` events by the parent market's `kind` (tournament vs main). This filter belongs in doc 09's projector spec but doc 09 doesn't mention it.

**Resolution.** Decide and document explicitly:
- Recommended: tournament PnL counts on the main raw board (transparency), but the *prize-eligible* board for main-vault rankings filters out tournament-bound `PositionRedeemed` events. Tournament prizes are claimed via the doc-08 attestation flow, not the main leaderboard.
- Add to doc 09 §4 (projector spec) the filter rule: main-board `pnl_window` aggregates only `PositionRedeemed` where `markets.kind != KIND_TOURNAMENT`.
- Add to doc 08 §2 a "leaderboard tributary mapping" subsection.

**Severity.** Medium (silent leaderboard distortion if tournament PnL leaks into main rankings; affects all "Hot Hand" / "Diamond Wrist" badge trigger logic too).

---

## Q12. Cluster filter Merkle root — which key signs it?

**Quotes.**
- Doc 08 §2.3: *"the indexer's cluster-filter be authoritative … 2. Off-chain: indexer computes cluster filter, attests to the 'prize-eligible top 10' by signing a `ClaimAttestation` per winner with the protocol attestor key (see §8 for key rotation)."*
- Doc 08 §2.3: *"The attestor is permissioned but not custodial — it cannot send funds, only sign attestations to facts derivable from public on-chain state. Multi-attestor quorum (e.g. 2-of-3) is supported via `verify_quorum_signature` to remove single-key risk; for MVP, single attestor is acceptable with a documented rotation procedure."*
- Doc 09 §9.2: *"Lock. When the tournament window closes, `tournament::lock(t)` computes a Merkle root over the sorted `(rank: u32, address, pnl: u64)` triples and emits `TournamentLocked { tournament_id, locked_at_ms, final_entry_count, pnl_root }`. The full sorted list is computed off-chain by the indexer (deterministic), published to the API, and pinned to Vercel Blob with the Merkle root anchored on-chain."*

**Verdict.** Two attestation models in the docs:

- **Doc 08 model.** Indexer signs `ClaimAttestation` per winner with attestor key. On-chain `claim_prize` verifies the signature. Prize data lives in attestation, not on-chain Merkle root.
- **Doc 09 model.** On-chain `tournament::lock` posts a Merkle root over `(rank, address, pnl)` triples. On-chain `claim_prize` verifies a Merkle proof, not a signature. No attestor key needed.

These are different schemes. Doc 09's is materially better — no centralization point, no key rotation problem. Doc 08's allows the attestor to lie about cluster membership to favor allies.

The docs disagree on which actually ships. Worse, doc 08 uses `ClaimAttestation` for *both* prize claims (§2.3) AND for Charterhouse badge (§3.1) AND for Comeback Kid (§4). Doc 09 only specifies the Merkle-root model for prizes. Charterhouse and Comeback Kid have no Merkle-root analogue — they fundamentally require an attestor because they aggregate over off-chain cluster data and time-sliding eligibility windows.

**Resolution.** Two-track design:
- **Prize claims.** Use doc 09's Merkle-root model. Pure on-chain rank-proof. Indexer publishes the sorted list; it cannot lie because the on-chain root is deterministic from public on-chain trades. Drop doc 08's attestor-signed prize flow. Update doc 08 §2.3 to point at doc 09 §9.
- **Badge claims (Charterhouse, Comeback Kid).** Keep the attestor-signed model from doc 08, because cluster aggregation cannot be Merkle-rooted on-chain. Document that this *is* a centralization point and propose 2-of-3 multisig from day one (not "MVP single attestor"), with the attestors being known third parties (e.g. one Wick org key, one community member, one external auditor). Document key rotation procedure.

**Severity.** High (two contradictory claim flows in two specs; silently picking one will break the other).

---

## Q13. Pre-expiry trading halt vs CLOB user-placed orders

**Quotes.**
- Doc 07 §3.4: *"5 minutes before market expiry, the keeper unconditionally cancels all orders. The CLOB pool can still trade peer-to-peer — the keeper has no authority to halt DeepBook itself — but Wick keeper liquidity is gone. The frontend shows a banner: 'Keeper has withdrawn liquidity (5 min to expiry). Resting orders may fill at unusual prices.'"*
- Doc 07 §4: keeper-side complete-set-arb prevention only constrains the keeper's quotes.

**Verdict.** Doc 07 explicitly acknowledges the limit: keeper can cancel its own orders but cannot halt the underlying DeepBook pool. So during the T-5min trading halt, users can still place crossing limit orders at any price. The complete-set-arb invariant (`touch_ask + notouch_ask >= payout × (1 + 2×spread)`) is *only* enforced on keeper-quoted prices; user-to-user matching can violate it freely.

This is internally consistent for doc 07 — the design admits the residual exposure. The cross-doc concern is whether *Wick-itself* loses money to user-vs-user crossing trades during the halt window. Answer: no, because Wick's keeper has no resting orders during the halt; user-vs-user matches don't touch Wick's inventory or vault. The only cost is reputational: a clueless user buys a TOUCH from another clueless user 30 seconds before the touch fires, paying 95¢ for a $1 payout that ends up worth $1.

This composes correctly with doc 08 (no tournament vault exposure since tournament markets aren't on CLOB per Q6) and doc 09 (the "settled-coin zombie trade" UI banner gives users a chance to see the warning).

**Resolution.** No code change. Add to doc 07 §3.4 a clarification: "User-to-user matching during the halt window is allowed by DeepBook and cannot be prevented. Wick itself has no exposure (no resting keeper orders + no inventory in the path of a user-vs-user fill). The UI banner is the user's only protection." Confirm in `clob_listing` tests that pre-expiry-halt does NOT add any restriction on user orders.

**Severity.** Low (design is honest; under-specification of the user-protection scope is a doc gap).

---

## Q14. OTC escrow ownership and V_eff accounting

**Quotes.**
- Doc 07 §5.1 OtcOrder: holds `locked_collateral: Balance<C>` (for BIDs) and `locked_position: Option<Position>` (for ASKs).
- Doc 07 §5: `wick::otc_escrow` is the module name. Standalone — no integration mention with `MartingalerVault`.
- Doc 01 §1: `MartingalerVault<C>` has `treasury: Balance<C>` plus per-market `settlement_locks: Table<ID, Balance<C>>`. No mention of OTC-locked balances.
- Doc 02 (referenced) computes asymmetric impact fee from `V_eff` which is the effective vault liquidity available to settle.

**Verdict.** Doc 07's `OtcOrder` holds collateral *outside* the `MartingalerVault`. A maker posting a BID locks `price_per_unit × size` in the OtcOrder shared object — this collateral is no longer in the user's wallet but also not in the vault. From the vault's accounting perspective, this collateral doesn't exist.

Three implications:
1. **`V_eff` impact fee.** If `V_eff` is computed as `treasury + side_bucket - sum(settlement_locks)`, OTC-locked collateral doesn't affect it. That's correct: OTC locked collateral is for a *secondary* trade, not a *primary* mint, so it doesn't change Wick's primary obligation surface.
2. **Position transfer accounting.** If Alice's BID gets filled by Bob's `Position` ASK, Bob receives Alice's collateral but Alice's collateral *was already deposited at primary mint time* into the vault when Bob originally opened the position. So total Wick obligations don't change — only ownership of the existing position. The `total_touch_supply` vs `total_no_touch_supply` invariant from `AGENTS.md` is unchanged. Good.
3. **Edge case: maker cancellation refund.** If Alice cancels her BID, the locked collateral returns to Alice. If Alice's wallet has been compromised between post and cancel, the attacker gets the refund. This is standard escrow behaviour and not a Wick-specific issue.

The composition is actually clean — OTC stands alone correctly. The doc seam is *clarifying* that OTC-escrowed collateral does NOT count toward `V_eff` and does NOT trigger martingaler queue entries. Doc 07 should say this explicitly; today it just doesn't mention it, leaving the reader to infer.

A second concern: **fee routing.** Doc 07 §5.3 says "Wick takes a small fee at fill (configurable; 30 bps default in v2)." The fee destination isn't specified. Should it route to:
- `MartingalerVault.protocol_fees` (treasury for buyback).
- `MartingalerVault.staker_fees` (LP yield).
- A new `OtcVault.fees` (parallel pool).

Doc 07 implies "small fee" but the routing is unspecified.

**Resolution.**
1. Add to doc 07 §5.3 explicit text: "OTC-escrowed collateral lives in the OtcOrder shared object, **not** in `MartingalerVault`. It does **not** count toward `V_eff` for impact-fee computation and does **not** trigger queue entries. Position transfers via OTC do not affect `total_touch_supply` or `total_no_touch_supply` because the position object itself, not its underlying collateral, changes hands."
2. Add to doc 07 §5.4 explicit fee routing: "OTC fee at fill (30 bps) routes to `MartingalerVault.protocol_fees` of the matching collateral type, accounted via a `vault::accept_otc_fee(vault, fee_coin)` entry. This keeps fee streams unified across primary and secondary."
3. Add an integration test: post BID, fill, assert vault balances unchanged (other than fee credit), assert position transfer succeeded.

**Severity.** Medium (clean architecture but under-specified seam; fee routing is a real ambiguity).

---

## Summary table

| # | Title | Severity |
|---|---|---|
| Q1 | CLOB pool atomicity vs witness OTW publish | Medium |
| Q2 | OracleVersionLock freeze leaves CLOB pools as zombies | High |
| Q3 | PathObservation BTC route — record_from_oracle_svi missing from doc 05 | High |
| Q4 | WickClaimTicket transferable but un-redeemable by transferee | High |
| Q5 | early_unwind unreachable post-OTC-transfer | High |
| Q6 | Tournament markets — no CLOB/OTC tier rule | Medium |
| Q7 | Lazer verifier vs random-walk driver in tournament construction | Low |
| Q8 | Charterhouse "5 underlyings" unreachable on MVP | Medium |
| Q9 | Witness bounty source for non-tournament markets | Medium |
| Q10 | MarketSettled schema differs between doc 07 and doc 09 | High |
| Q11 | Tournament PnL leakage into main leaderboard | Medium |
| Q12 | Two contradictory prize-claim attestation models | High |
| Q13 | Pre-expiry halt cannot stop user-to-user crosses | Low |
| Q14 | OTC escrow accounting vs V_eff and fee routing | Medium |

**Counts.** High: 6 (Q2, Q3, Q4, Q5, Q10, Q12). Medium: 5 (Q1, Q6, Q8, Q9, Q11, Q14). Low: 2 (Q7, Q13). Wait — Medium is 6 (Q1, Q6, Q8, Q9, Q11, Q14). Re-counting: 14 total = 6 High + 6 Medium + 2 Low. Confirmed.

**Hot zone.** The BTC-route × CLOB seam has the most issues (Q2, Q3, Q4, Q5 — all High), all rooted in the same architectural mismatch: Predict's per-user-manager model produces non-Coin claim tickets that cannot participate in the Coin-typed CLOB / OTC machinery doc 07 assumes. The clean fix is to declare BTC-route positions explicitly non-secondary for MVP (Q4 resolution (a)) and revisit post-MVP with a wrapper-coin design.

The second hot zone is the indexer schema seam (Q10, Q12) where doc 07/08/09 each independently define event shapes and prize-claim flows that contradict each other. Required: a single canonical events schema file (probably TS-generated from Move BCS) referenced by all design docs.

---

*End of v2 composition validation.*
