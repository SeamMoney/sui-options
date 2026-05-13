# Red Team — Wick Oracle & Path Observation Subsystem

Status: adversarial review
Scope: `wick::wick_oracle`, `wick::path_observation`, `wick::pull_oracle_driver`, `wick::random_walk_driver`, the planned PathObservation v2 (`docs/design/05_path_observation_v2.md`), and the keeper-trust assumptions baked into all of the above.

The headline finding: the entire pull-oracle path collapses to *one address* — the holder of `KeeperCap`. Most of the "buffered, rate-limited, min-observations" v2 design is defense-in-depth around a soft target. Below: 14 distinct attacks, ranked roughly by severity for an MVP that will hold real money.

---

## Attack 1 — Compromised KeeperCap silently rewrites the truth

**Severity:** Critical (loss of all open notional on every pull-driven market)

**Setup.** The attacker holds the `KeeperCap` (theft, key compromise, social-engineering the operator, hosted-bot-image RCE, leaked CI secret). The cap is `key, store` so it is bearer — possession is authority. There is **no multi-sig, no timelock, no rotation, no on-chain attestation verifier**. The on-chain check at `pull_oracle_driver.move:141` is `feed.keeper_cap_id == object::id(cap)` — that's it.

**Step-by-step.**
1. Attacker takes positions on every live `Market<C>` driven by Pyth Lazer feeds: NO_TOUCH on ATM/near-the-barrier markets where the real market is about to wick, TOUCH on markets where the real market is calm.
2. Attacker calls `push_price(feed, oracle, cap, fake_price, real_pyth_ts, attestation_blob_of_their_choice, clock, ctx)`. The `attestation` is a `vector<u8>` recorded in the `PricePushed` event but **never verified on-chain**. They paste real Lazer bytes for plausible deniability or random bytes; both succeed.
3. `apply_observation` writes `latest`, `record(po, oracle, clock)` ingests it, `touched_at` flips to `Some` (or stays `None`), settlement resolves on the keeper's lie.

**Economic impact.** Total open interest on every Lazer-driven market. Worst case (attacker also seeded large pre-positions on an arcade tournament): the entire `payout_pool` gets drained over one expiry window. There is no slashing, no clawback, no on-chain proof of misbehavior — just a `PricePushed` event whose `attestation` field doesn't match a real Lazer signature. Discovery is post-hoc and off-chain.

**Existing controls.** `MAX_FUTURE_SKEW_MS = 30_000` blocks far-future stamps. `last_pushed_ms` enforces strictly-monotonic timestamps. Neither helps: the keeper picks any `(price, ts)` with `ts > last_pushed_ms` and `ts <= now + 30s`.

**Mitigation.** Three orthogonal layers, none in the MVP code today:

1. Ship the planned `lazer_verifier_driver` that verifies Pyth Lazer's secp256k1 signature on-chain *before* writing `latest`. This makes "compromised keeper" topologically impossible.
2. Until then, require `attestation` to be a Lazer signed-update blob and at least *parse* it on-chain (decode `feed_id`, `price`, `ts`) so the keeper can't push (`price=$1`, `ts=now`, `attestation=b"yolo"`). Even unverified parsing makes silent lies require forging a structurally valid blob.
3. Keeper key in HSM + 2-of-3 multi-sig wrapper Move object that holds the `KeeperCap` and gates `push_price` calls behind threshold approval. Operationally heavier; cuts the single-cap blast radius.

---

## Attack 2 — Slow-keeper price selection (legal manipulation)

**Severity:** High (consistent edge, no detectable line crossed)

**Setup.** Keeper is honest but the operator decides *when* to push the next tick. Lazer publishes ~10 Hz off-chain; the keeper batches at ~5 s. That 5 s window contains 50 candidate prices.

**Step-by-step.**
1. Operator pre-trades NO_TOUCH on a market where real BTC is hovering near `barrier × (1 + buffer_bps/10_000)`.
2. Operator watches the off-chain Lazer stream. When a tick prints *below* the effective trigger, they push that one. When ticks print *above*, they delay.
3. Each push moves `last_pushed_ms` forward, so the omitted ticks become unrecordable forever (`obs_ts <= last_seen_ms` → no-op in `path_observation::record`).
4. Across many markets and many pushes the operator earns a structural edge.

**Economic impact.** Hard to size — depends on barrier-distance distribution and how aggressively they cherry-pick. At 10 bps buffer with naturally ~5 bps of intra-second wiggle, withholding adverse ticks shifts touch probability by 5–15% on borderline markets. On a $1M portfolio that's $50k–$150k of free EV per cycle.

**Existing controls.** `record_range` (Section 3 of v2) is the *intended* fix — it forces the keeper to attest both extremes between two ticks. But the design doc explicitly says "Until the Lazer range extension ships, `record_range` is unimplemented" and v1 currently has no `record_range` at all. There is **no on-chain check that the keeper isn't omitting prints**.

**Mitigation.** Implement `record_range` immediately and require it (not merely accept it) on every push gap > X ms. Validate `low_obs.price <= high_obs.price` and that both are signed by the upstream feed. Even without a Lazer range extension, attest the min/max from the keeper's own buffer with two `PriceObservation` blobs and verify `signature` off-chain via watchdog bounty.

---

## Attack 3 — Stale-Lazer push to game the freshness window

**Severity:** High

**Setup.** `lock_settlement_from_latest` requires `now - obs_ts <= settlement_freshness_ms` (default 60 s) **and** `obs_ts >= expiry_ms`. So the very first observation with `ts >= expiry_ms` becomes the settlement price.

**Step-by-step.**
1. Market expires at `T`. Real Lazer prints `(price=P_real, ts=T+1ms)` immediately.
2. Keeper has a 60 s budget. Keeper privately picks the most-favorable post-expiry tick from the next 60 s of off-chain data: e.g. a momentary spike at `T+30s` to `P_extreme` that lasts one Lazer tick before mean-reverting.
3. Keeper pushes only `(price=P_extreme, ts=T+30s)`. Settlement locks at `P_extreme`. `lock_settlement_from_latest` passes (`30s <= 60s`).
4. Touch markets that depend on `settlement_price` (today: none, but the design promises future closing-price-dependent products) and any external composers reading `settlement_price` get the cherry-picked value.

**Economic impact.** For pure touch/no-touch markets the in-window touch decision is independent of `settlement_price`, so this is bounded. For *anything else that reads `settlement_price`* (range markets, future expiry-priced derivatives, `wick_oracle::settlement_price` consumed by an indexer for fair-value), the impact is "keeper picks the close." That's the closing-print equivalent of a centralized exchange operator marking-to-themselves.

**Existing controls.** None. `settlement_freshness_ms = 60_000` is the entire defense and it's the attack surface.

**Mitigation.** Lock settlement to the *first* post-expiry observation, not the latest. Track `first_post_expiry_obs` in the oracle and have `lock_settlement_from_latest` consume that one; reject any push that tries to overwrite it once expiry has been crossed. Pair with a 5–10 s sub-grace to absorb network jitter.

---

## Attack 4 — Sticky `touched_at` from a single bad tick

**Severity:** High

**Setup.** Both v1 and v2 set `touched_at` after a *single* observation that crosses the (buffered) barrier and never revert. Lazer is honest 99.99% of the time — but a bad publish, a relay glitch, a fat-finger in keeper code, or one cherry-picked Lazer tick is enough to lock a market wrong.

**Step-by-step.**
1. Attacker (keeper or anyone with influence over a single tick) ensures *one* observation crosses the barrier — for v1, equality with barrier suffices; for v2, the buffered trigger.
2. `touched_at` becomes `Some(ts)`, `BarrierTouched` emits.
3. Even if the next 1,000 ticks all print below barrier and a moderator wants to revert, **there is no revert path**. `touched_at` is sticky by design, the path object is shared, no admin function exists.

**Economic impact.** All TOUCH holders win, all NO_TOUCH holders lose, on a price level the asset never legitimately reached.

**Existing controls.** `barrier_buffer_bps = 10` raises the bar by 0.10% — meaningful for noise, irrelevant for adversarial pushes. `min_observations = 6` does **nothing** here: a touch short-circuits the `min_observations` requirement (`can_settle` returns true on touch regardless of count, per Section 5 of v2). One tick + expiry = HIT.

**Mitigation.** Require **N consecutive in-window ticks above the trigger** for a touch to fire (e.g. 2 of 3 within 1 s). Or require `obs_price` to clear a *higher* trigger by some bps (a "confirm" buffer larger than the "trigger" buffer). The current sticky-on-first design optimizes for low-latency; that's the wrong trade for a primitive that decides money.

---

## Attack 5 — Random-walk seed grinding by the market creator

**Severity:** High (for arcade markets — but those are the ones with real PvP volume)

**Setup.** `random_walk_driver::create_market` builds the `RandomWalk` with `nonce = 0`. `tick`'s entropy is `sha2_256(nonce || clock_ms || fresh_object_address(ctx))`. `fresh_object_address` is derived from the **transaction digest** plus an internal counter — and the tx digest is determined by *the creator's transaction*. The creator can grind their own create-tx until they get a `RandomWalk.id` (and predictable downstream `fresh_object_address`es) that produce a favorable price path.

**Step-by-step.**
1. Adversary writes an off-chain simulator that, given a candidate tx digest, replays the deterministic PRNG forward N ticks.
2. Adversary builds candidate `create_market` transactions (varying gas budget, gas object, sender nonce, coins consumed, etc.) until the projected price path crosses the barrier they intend to bet *against*.
3. Adversary submits the chosen tx, opens NO_TOUCH (or TOUCH, depending on the grind), then ticks the market themselves at predictable times.

**Economic impact.** Full edge on the market they created. For an arcade tournament with $X notional, expected loss = $X.

**Existing controls.** None. The doc-string for `random_walk_driver.move` says "Mixes a 256-bit hash from (seed counter, clock_ms, fresh address)" as if entropy were assured; in reality `fresh_object_address` is **not** unpredictable to the tx submitter — they're choosing the seed.

**Mitigation.** Two options:
1. Mix in a *post-creation* commit-reveal: the creator commits a hash; a later party reveals the preimage; or the price path uses `clock.timestamp_ms()` plus a Sui randomness object (`sui::random::Random`) per tick.
2. Best: use `sui::random::Random` as the entropy source for every tick. Sui's randomness object is unbiasable by validators within the BFT assumption, and the creator has no influence over it.

Either way, the current `fresh_object_address` mix is grindable and must be replaced before any market with skin in the game uses the random-walk driver.

---

## Attack 6 — Same-tx tick reuse across PTBs (`fresh_object_address` predictability)

**Severity:** Medium (compounds with Attack 5)

**Setup.** Multiple `tick(rw, oracle, clock, ctx)` calls in one PTB share the same `ctx`. `tx_context::fresh_object_address(ctx)` is called once per `tick`, but it's deterministic given the tx — so a caller who composes a PTB with N ticks and a position open in between has full information about the PRNG output of every tick *before* signing.

**Step-by-step.**
1. Attacker (any user) writes a PTB: `tick`, `read_price`, conditionally `open(side=…)`, `tick`, conditionally `redeem` …
2. Off-chain dry-run reveals each tick's outcome under their proposed PTB. They iterate the PTB shape until profitable.
3. Submit. Win deterministically.

**Economic impact.** Free EV on every PTB. For arcade markets that allow open-and-close in a single transaction, this is a print-money bug. Even without same-tx redeem, the attacker can open at the optimal entry price and close in a follow-up tx.

**Existing controls.** Rate-limit (`min_record_interval_ms = 250`) only applies to `path_observation::record`, not to `random_walk_driver::tick`. The driver itself has no per-call rate limit.

**Mitigation.** Add a `min_tick_interval_ms` to `RandomWalk` and assert against `clock.timestamp_ms()` so multiple `tick`s in one ms abort. Better: switch to `sui::random::Random`, which is one-shot per epoch slot and not foreseeable.

---

## Attack 7 — Race-to-record front-running of the touch tick

**Severity:** Medium

**Setup.** Even with v2's permissionless `record`, the *first* call after a Lazer push that crosses the barrier flips `touched_at`. Anyone watching the mempool / oracle state can:

1. See `apply_observation` land in oracle (driver pushed a barrier-crossing price).
2. Observe that `path_observation::record` hasn't been called yet.
3. Open a TOUCH position, then call `record` in the same PTB or the next block.

The buffer doesn't help — Lazer already crossed. The window is one block.

**Economic impact.** On a ~$10k notional 1.8x payout TOUCH market, opening $100 right before the touch fires nets ~$80 risk-free. Profitable for any bot.

**Existing controls.** Per v2 Section 7(b): "Mitigated by the buffer (the move has to clear `barrier × (1 + buffer_bps/10_000)`) and by AMM swap fees + slippage." But Wick-native markets (`wick::market`) are *not* AMM-priced — they are fixed-multiplier vault markets (`payout_multiplier_bps`). So slippage is zero. The `open` function has no `now < expiry_ms - X` lockout that would block "pre-touch sniping."

**Mitigation.** Either (a) close trading N seconds before expiry, (b) close trading once `latest_price` is within `min_distance_to_barrier` of the trigger, or (c) make `open` reject if the latest oracle observation already satisfies the touch predicate. Option (c) is the cheapest and closest to correct.

---

## Attack 8 — Min-observations grief to force `Aborted` refund

**Severity:** Medium

**Setup.** v2's `Aborted` state refunds 1:1 if `observation_count < min_observations` past `expiry_ms + grace_ms`. A user holding the *losing* side at expiry minus epsilon would prefer Abort to Loss.

**Step-by-step.**
1. Attacker is long NO_TOUCH on a market that has just touched (barrier crossed in-window, `touched_at = Some(ts)`).
2. Attacker DDoSes the keeper, blocks the keeper's outbound RPC, gets their cap holder rate-limited at the RPC provider, etc.
3. With v1 there's no abort, so DDoS doesn't help. With v2, if `touched_at` is set, the path resolves Touch (Section 5: "if option::is_some(&po.touched_at) return true"). So the attacker actually has to grief *before* the touch is recorded. They suppress all `record` calls for the entire window. No touch detected, no min_obs reached, market aborts → both sides refund.

**Economic impact.** Attacker recovers stake on a position they would have lost. Counterparty gets refunded too — so symmetric loss-of-edge, but the *protocol* loses the spread/fees. For a keeper-paid model, the keeper eats the gas + opportunity cost.

**Existing controls.** "Permissionless ticking — anyone can crank" (v2 Section 4). Mitigation works only if there are N independent recorders. In practice, on testnet there's 1 keeper — and the rate limit (250ms) applies to the *path*, so even friendly recorders can't burst-recover after a downtime gap.

**Mitigation.** Lower `min_observations` defaults for low-volume markets; or scale `min_observations` with elapsed time, not count, so a 24-hour outage that misses 6 ticks doesn't auto-abort. Run multiple geographically-distributed keepers behind one cap (or N caps with N feeds).

---

## Attack 9 — `record_range` price-injection by no-touch holder (v2 only)

**Severity:** Critical (if `record_range` is permissionless)

**Setup.** v2's `record_range(po, oracle, low_obs, high_obs, clock)` takes two `PriceObservation` values *as arguments*. `PriceObservation` is `copy, drop, store` — so anyone can mint one with `price_observation::new(price, ts, source_id)`. The function signature in v2 pseudocode does not show a cap or a verifier.

**Step-by-step.**
1. Attacker is long NO_TOUCH. Real BTC ticked above the barrier between two recorded points.
2. Attacker calls `record_range(po, oracle, low_obs = (price=barrier-1, ts=t1), high_obs = (price=barrier-1, ts=t2), clock)` with values they fabricated.
3. The function checks `l_ts < h_ts` and `l_ts > last_seen`, picks the relevant extreme based on direction, and (because `barrier-1 < trigger`) does **not** fire `touched_at`. It then advances `last_seen_ms = h_ts`, *closing the gap forever*.
4. The real touch is now unrecordable: subsequent `record` calls see stale ts.

**Economic impact.** Total: attacker decides whether each gap contains a touch.

**Existing controls.** None in the v2 pseudocode. Section 3 says observations "must carry timestamp_ms strictly between `last_seen_ms` and the current `latest`" and "be signed/attested by the same driver kind as the oracle" — but the only on-chain way to enforce attestation is to require the observation to live inside the `WickOracle`'s `latest` slot, which means re-running `apply_observation` first. The pseudocode passes `PriceObservation` *by value*, not by ID into the oracle.

**Mitigation.** Either (a) require `record_range` to consume two observations that have already been `apply_observation`'d (i.e. both are recorded in oracle history dynamic fields) — meaning the oracle, not user input, is the source of truth; or (b) require a signed Lazer range-update blob and verify the signature on-chain. (a) is feasible today by storing a small ring-buffer of recent observations on `WickOracle`. (b) is the real fix.

---

## Attack 10 — Rate-limit bypass via multi-wallet front-running

**Severity:** Low–Medium

**Setup.** `min_record_interval_ms = 250` is per-path, not per-caller. Two callers in the same 250 ms window: the second aborts `ERateLimited`. Combined with Attack 7, the attacker can pre-burn the rate budget so the keeper cannot ingest the *next* oracle tick.

**Step-by-step.**
1. Attacker monitors oracle. Real Lazer tick lands at `T=0ms`.
2. Attacker calls `record(po, oracle, clock)` at `T=10ms`. State updates, `last_record_call_ms = 10`.
3. Lazer pushes a barrier-crossing tick at `T=120ms`. Keeper races to call `record`. Keeper aborts because `120 - 10 = 110 < 250`. Keeper retries until `T=260ms`. By then attacker has had 250ms of mempool visibility to position.
4. Attacker opens TOUCH at `T=200ms`, then calls `record` at `T=261ms`. Touch fires.

**Economic impact.** Same as Attack 7 but with deterministic 250ms exclusion windows.

**Existing controls.** None — the rate limit is the attack vector here.

**Mitigation.** Make the rate limit per-caller (track `last_call_per_address` in a small dynamic field, or via address-keyed table). Alternatively, replace per-call rate limit with per-block dedup: if `obs_ts == last_seen_ms`, the call is a no-op (already true) — so no rate limit is needed at all. Remove the rate-limit field and the attack disappears.

---

## Attack 11 — Spurious cross-oracle write via driver-kind confusion

**Severity:** Low (with current code), High (if a future driver loosens the kind check)

**Setup.** `WickOracle.driver_kind` gates which driver may write via `apply_observation` (`assert!(oracle.driver_kind == expected_kind, EWrongDriver)`). Today this is honest: `random_walk_driver::tick` calls `apply_observation(..., driver_random_walk(), ...)`; `pull_oracle_driver::push_price` passes `driver_lazer()`. But `driver_config: vector<u8>` is opaque bytes, deserialized only by the matching driver. There is **no on-chain assertion that the `driver_config`'s embedded ID is consistent with what other modules think it is**.

**Step-by-step (hypothetical future driver).**
1. Suppose a new `wick::pyth_pull_driver` ships with `driver_kind = driver_lazer()` (because the design doc says "we reuse the Lazer kind for the keeper-pull form so a future on-chain Lazer verifier can swap in transparently"). Now `pull_oracle_driver` *and* `pyth_pull_driver` both pass `driver_lazer()` to `apply_observation`.
2. An attacker holds a `KeeperCap` for the *old* `PullFeed`. They call `push_price` against a `WickOracle` whose `driver_config` actually points to a `pyth_pull_driver`'s feed object. The cap-id check at `pull_oracle_driver.move:141` is `feed.keeper_cap_id == object::id(cap)` — but if the attacker passes the *old* `PullFeed` (which they have a cap for) along with a *different oracle*, the check `feed.oracle_id == object::id(oracle)` fails. Safe today.
3. **But:** if anyone wraps the cap or adds a "transfer cap rights" upgrade path without re-asserting the cap-feed-oracle triangle, the reuse of `driver_lazer()` across modules collapses isolation.

**Economic impact.** Today: zero. Tomorrow if anyone reuses the kind: total. This is a latent footgun in the *design*, not the current code.

**Existing controls.** `EConfigOracleMismatch` triple-checks (cap → feed → oracle) work *if* the driver remembers to enforce all three. Random-walk's `tick` checks both `driver_kind == driver_random_walk()` and `rw.oracle_id == object::id(oracle)`. Good. But a sloppy future driver only needs to drop one check.

**Mitigation.** Give every driver its own `driver_kind` value (no reuse), and consider a typed driver registry rather than a magic u8.

---

## Attack 12 — Multi-tick spam in one block (gas DoS + state bloat)

**Severity:** Low

**Setup.** `random_walk_driver::tick` is permissionless and has no per-block limit. Sui has soft per-tx gas budgets but a malicious user can stuff dozens of `tick` calls into a single PTB.

**Step-by-step.**
1. Attacker constructs a PTB with N=200 `tick(rw, oracle, clock, ctx)` calls.
2. Each tick mutates `current_price`, `nonce`, `last_tick_ms` and writes a `PriceObservation` to `oracle.latest` (overwriting the previous, since `latest` is `Option`-singleton). Plus emits 200 `Ticked` and 200 `ObservationRecorded` events.
3. Cost to attacker: gas for 200 ticks + 200 events. Cost to indexers: 200 events to chew. Cost to path: only the last tick's price is the new `latest`; 199 are observable in events but not in storage. So `record(po, oracle, clock)` only sees the final state.

**Economic impact.** Limited to event-channel bloat. But: combined with Attack 5 (seed grinding), the attacker burns 200 ticks of PRNG state in one tx to *reach a known favorable price* in one observable jump.

**Existing controls.** None.

**Mitigation.** Add a per-call min_interval to `tick` (mirror the path's rate limit). Reject `now == rw.last_tick_ms` so each tick must have its own millisecond.

---

## Attack 13 — Oracle settlement-lock race for closing-price markets

**Severity:** Low for current touch-only MVP; High when `settlement_price` becomes load-bearing

**Setup.** `lock_settlement_from_latest` is permissionless and uses whatever `latest` happens to be. Two callers race: one wants the spike, one wants the post-spike.

**Step-by-step.**
1. At `T = expiry_ms + 100ms`, real Lazer prints `(P_high, T)`.
2. Honest cranker calls `lock_settlement_from_latest`. Locked at `P_high`.
3. **But** — if Lazer had two consecutive post-expiry ticks (`P_high` then `P_low`), and the keeper has only pushed `P_high` so far, an attacker who *wants* `P_high` will race to call `lock_settlement_from_latest` *before* the keeper pushes `P_low`. Whoever wins the priority gas auction picks the close.

**Economic impact.** For touch-only MVP: zero (touch decision is not closing-price-dependent). For any future product that reads `settlement_price`, the close is whoever cranks first.

**Existing controls.** None.

**Mitigation.** Wait at least `settlement_freshness_ms` after `expiry_ms` before allowing the lock, then average the post-expiry prints. Or use a TWAP of the first 30 s of post-expiry observations.

---

## Attack 14 — `EAlreadyExpired` confusion + `touch_outcome` boolean ambiguity

**Severity:** Low (correctness), but worth fixing pre-mainnet

**Setup.** v1 `path_observation::touch_outcome` aborts with `EAlreadyExpired` (constant value 2) if `clock.timestamp_ms() < expiry_ms`. The constant name is *backwards*: it aborts when *not yet* expired. This is a footgun for integrators reading the error. More substantively: `touch_outcome` returns `bool`, no concept of "ABORTED." `wick::market::redeem` consumes `touch_outcome(path, clock)` and decides win/loss — there's no path for "neither side wins, refund." If v2's `Aborted` state ships without `redeem` learning about it, an aborted path resolves as `touch_outcome → false → NO_TOUCH wins`. That's wrong: NO_TOUCH didn't earn it.

**Step-by-step.**
1. Market is in `Aborted` state per v2 (insufficient observations past grace).
2. NO_TOUCH holder calls `redeem`.
3. `path_observation::touch_outcome` returns `false` (no `touched_at`).
4. `won = (side == NO_TOUCH && !touched) = true`. NO_TOUCH "wins" the market that was supposed to refund both sides.

**Economic impact.** TOUCH holders lose their stake on an aborted path; NO_TOUCH holders win double (their stake back as if they'd been right). Inverted from refund semantics.

**Existing controls.** None — `market.move` doesn't reference `Aborted` state at all today.

**Mitigation.** Before shipping v2, refactor `redeem` to switch on `path_observation::settlement_state` (NotReady → abort, Resolved → win/loss, Aborted → refund-both-sides via a separate `refund_aborted` codepath). Update `EAlreadyExpired` constant name (`ENotYetExpired`) for clarity.

---

## Cross-cutting observations

**Keeper trust is the whole show.** Six of the fourteen attacks (1, 2, 3, 5, 6, 11) reduce in some form to "the entity producing observations chooses the observation." Buffer, min-observations, rate-limit, sticky touch, and grace are all *defense in depth* around the assumption that `KeeperCap` holders behave. If they don't, none of these defenses matter. The README, threat model, and UI must be honest about this — *especially* before any market with non-trivial notional.

**Random-walk seeds are not random.** Anything `fresh_object_address`-derived is grindable by the tx submitter. `sui::random::Random` exists. Use it.

**v2's Aborted state is half-shipped.** The path knows about Aborted; the market doesn't. Either both ship or neither. A market that resolves "no touch wins" because the keeper went down and observations were never recorded is *worse* than v1's "no touch wins by default" — at least v1 is upfront about the bias.

**`record_range` as designed is exploitable.** Taking `PriceObservation` by value means the caller invents the price. The fix is to require the observations to flow through `apply_observation` first, or to verify a Lazer signature on-chain.

**The MEV / rate-limit story doesn't add up.** The rate limit creates a 250 ms window during which the *real* keeper's call can be blocked by adversarial pre-call. Either remove the rate limit (the dedup check is sufficient) or make it per-caller.

**Permissionless ticking is presented as a defense and is not one.** "Anyone can crank" only matters if "anyone" actually does. On testnet today: one keeper. On mainnet day-one: probably one keeper. Until there's an incentive for third parties to crank (a reward, even tiny) or until the design assumes a real distributed cranker network, Section 4's MEV analysis ("permissionless ticking + grace") is theatre.

**Bottom line for hackathon ship.** The MVP can ship with the buffer, min-observations, and grace defenses *if* the README is brutally honest about the keeper-cap trust assumption *and* if random-walk markets either don't carry real money or switch to `sui::random::Random`. Anything more ambitious than testnet demo money is gated on the on-chain Lazer signature verifier.
