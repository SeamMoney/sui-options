# Wick Move — safety property → test traceability

The Wick contracts hold user collateral, so the load-bearing properties are the
ones that protect funds. This file maps every fund-safety property the package
enforces — the [`AGENTS.md`](../AGENTS.md) "Safety properties the Move package
must enforce" list and "The collateral invariant" at its core, plus the broader
surface those imply: vault conservation + every money-out path (winner payout,
fee-bucket withdrawals, protocol-fee sweep, abort refunds, LP seed-recovery),
vault-solvency exposure caps, the full settlement-integrity chain (oracle feed →
barrier record → settlement → payout), both ride systems (v4 segment + v2
streaming), fee routing/theft-prevention, the staking anti-loop, house-edge, the
immutable-config rules, and determinism — each mapped to the named test(s) (or
compile-time guarantee) that prove it, so an auditor or judge can run a specific
test rather than take the claim on faith.

Run the whole suite: `sui move test` (from `move/`) — **685/685 passing**.
Run one property: `sui move test <test_name>` (substring match on the function).

## The collateral invariant — load-bearing

User collateral is escrowed in the `MartingalerVault`, so the load-bearing
property is **vault conservation**: every unit deposited is either still held by
the vault or was paid out — never minted, never lost. After every state
transition `cumulative_in − cumulative_out == held`, where
`held = treasury + side_bucket + Σ per-market locks`. Bugs here are direct loss
of funds.

> **On the `vault == touch_supply == no_touch_supply` phrasing in AGENTS.md:** that
> is inherited from the retired v1 *complete-set* model (mint a set → equal
> touch/no-touch supplies). v2 has no complete sets — a depositor stakes into ONE
> side via `deposit_open`, so `touch_stakes` and `no_touch_stakes` are independent
> accumulators (a touch-only market simply has `no_touch_stakes == 0`). The
> conservation the package actually enforces and tests is the vault identity above,
> not a cross-side supply equality.

| Property | Test | File |
|---|---|---|
| Vault conservation: `Σ in − Σ out == held` | `conservation_in_minus_out_equals_held` | `martingaler_vault_tests.move` |
| …and it holds **end-to-end through every settlement path** (deposit → fee routing → payout/forfeit), not just the vault primitive — each asserts `Σ buckets == Σ in − Σ out` after settling | rides: `rug_settles_ride_as_loss` · `abort_segment_ride_v4_past_deadline_refunds_one_to_one` · `close_upper_touch_wins_with_touched_side_upper` · `close_no_touch_within_round_yields_cashout` · `crank_expired_no_touch_yields_expired_loss` — options: `lock_and_settle_dnt_market_with_held_corridor_pays_inside_side` · `lock_and_settle_dnt_market_with_breached_corridor_pays_outside_side` · `two_sided_market_clears_correctly` | `segment_market_v4_tests` · `dnt_tests` · `market_tests` |
| Winner paid in full from the per-market lock | `pay_winner_full_from_lock` | `martingaler_vault_tests.move` |
| Partial pay queues the remainder (no overdraw) | `pay_winner_partial_then_queue_remainder` | `martingaler_vault_tests.move` |
| Empty lock ⇒ full payout queued (FIFO), never minted | `pay_winner_full_queue_when_lock_empty` | `martingaler_vault_tests.move` |
| The generic single-collateral `vault` primitive conserves every unit (deposit→withdraw round-trips exactly), rejects a zero move, and can't over-withdraw | `deposit_withdraw_round_trip_conserves_every_unit` · `deposit_balance_adds_to_held` · `deposit_zero_aborts` · `withdraw_zero_aborts` · `withdraw_more_than_held_aborts` | `vault_tests.move` |
| Exposure caps protect vault solvency — measured against the live vault-effective balance (which must be non-zero), a single position's payout can't exceed the per-position cap, a side's aggregate exposure can't exceed the per-side cap, an underlying's PWE can't exceed the global cap, and a correlation bucket's combined PWE can't exceed the bucket cap (so the vault can never be over-committed beyond what it can pay) | `per_position_cap_aborts_above` · `per_position_cap_zero_vault_aborts` · `per_side_cap_aborts_above` · `global_pwe_cap_aborts_above` · `correlation_bucket_cap_aborts_above_with_multi_underlying` | `risk_config_tests.move` |

## Settlement safety

| Property | Test | File |
|---|---|---|
| A market cannot settle both ways (HIT ⟂ EXPIRED) | `crank_expired_no_touch_yields_expired_loss` + `close_upper_touch_wins_with_touched_side_upper` | `segment_market_v4_tests.move` |
| The oracle settles one-shot against the FIRST fresh post-expiry observation (no early / stale / double settle, no cross-driver writes) | `post_expiry_observation_latches_and_settles` · `lock_before_expiry_aborts` · `lock_without_settlement_obs_aborts` · `stale_settlement_observation_aborts` · `double_settle_aborts` · `apply_after_settled_aborts` · `apply_with_wrong_driver_aborts` | `wick_oracle_tests.move` |
| Oracle-version pinning — a market settles only against the oracle version it was pinned to (no silent version swap; a migration flips the pin atomically and the old version is then rejected) | `assert_pinned_passes_on_match_and_getters_report_state` · `assert_pinned_rejects_wrong_package` · `assert_pinned_rejects_wrong_object` · `migration_flips_the_pin_atomically` · `pin_after_migration_rejects_the_old_version` · `complete_migration_without_start_aborts` | `oracle_version_lock_tests.move` |
| Pull-oracle feed integrity — a keeper can only push a monotonic, fresh (skew-bounded) price, with the right cap, into a PULL-kind oracle the feed is bound to (no spoofing the settlement price from a rogue feed/cap) | `push_price_accepts_monotonic_and_advances_last_pushed` · `push_price_rejects_non_monotonic_timestamp` · `push_price_rejects_far_future_timestamp` · `push_price_accepts_timestamp_at_skew_boundary` · `push_price_rejects_wrong_keeper_cap` · `push_price_rejects_non_pull_oracle` · `push_price_rejects_feed_bound_to_a_different_oracle` | `pull_oracle_driver_tests.move` |
| The barrier-cross record (`PathObservation`) resists oracle jitter and freezes its outcome — a single bad tick can't lock a touch (needs consecutive crossings past the buffered + deadbanded barrier; a run resets on an intervening reversal), the snapshot-lock is idempotent and frozen against post-lock writes, and it can't lock during the drain window (so a false touch from noise, or a re-write after lock, can't flip a payout) | `single_bad_tick_does_not_lock_outcome` · `three_consecutive_crossings_lock_touch` · `crossing_run_resets_on_intervening_below` · `buffer_bps_skips_at_exact_barrier` · `snapshot_double_lock_aborts` · `snapshot_freezes_outcome_against_post_lock_writes` · `snapshot_lock_during_drain_window_aborts` | `path_observation_v2_tests.move` |
| DNT corridor settles one way only (HELD ⟂ BROKEN) | `lock_and_settle_dnt_held_idempotent_cannot_flip_to_broken` + `lock_and_settle_dnt_market_with_held_corridor_pays_inside_side` + `lock_and_settle_dnt_market_with_breached_corridor_pays_outside_side` | `dnt_tests.move` |
| Settlement is idempotent (repeat = no-op / revert) | `lock_and_settle_idempotent` · `release_idempotent_on_already_released` · `prune_settled_segments_v4_is_idempotent` | `market_tests` · `martingaler_vault_tests` · `segment_market_v4_tests` |
| `lock_and_settle` is atomic — snapshot, status, fee accrual, and lock release commit together | **Guaranteed by Sui's transaction model**: a Move call commits in full or aborts in full, so there is no partial-commit state a unit test could observe. The settle path's combined effects are exercised end-to-end by the close/crank tests, and `lock_and_settle_idempotent` proves a repeat call cannot re-mutate | `segment_market_v4_tests.move` |
| Losing side cannot redeem (receives zero) | `loser_receives_zero` | `market_tests.move` |
| A touch/no-touch open is fully guarded (funded stake, before expiry, own vault + path, valid side) | `cannot_open_with_zero_stake` · `cannot_open_after_expiry` · `cannot_open_against_wrong_vault` · `cannot_open_against_wrong_path` · `cannot_open_with_invalid_side` | `market_tests.move` |
| Market creation is guarded — payout multiplier in range, path matches oracle, valid vault side, and NON-ZERO sigma (a zero would make every quote degenerate) | `gated_market_rejects_open_on_vault_side` · `create_v4_rejects_zero_sigma` (+ `EBadMultiplier`/`EWrongPath` paths) | `market_tests.move` |
| Repeated `redeem` cannot double-pay | **Guaranteed by Move's linear types** — `redeem` consumes `position: Position` *by value* (`market.move`), so re-redeeming the same position is a compile-time use-after-move, never a runtime path; `cannot_redeem_when_active` guards the not-yet-settled case | `market.move` · `market_tests.move` |
| Fees route to the right buckets only on a winning redeem | `fee_routes_to_router_buckets_on_winner_redeem` | `market_tests.move` |
| Fee-router integrity — the bucket split must sum to 100% (else init aborts), accrued fees land in the correct protocol/staker/insurance buckets with dust routed to LP, and the crank dispatch rejects an unknown bucket id (no fees lost or misdirected) | `init_with_invalid_sum_aborts` · `accrue_splits_into_correct_buckets` · `accrue_dust_routed_to_lp` · `accrue_zero_balance_noop` · `crank_bucket_handles_each_known_bucket_when_empty` · `crank_bucket_rejects_unknown_bucket_id` | `fee_router_tests.move` · `fee_router_crank_tests.move` |
| Vault fee-bucket money-out is isolated — a withdrawal from one bucket drains ONLY its own bucket (no cross-bucket drain), and a zero-accrue / empty withdraw yields nothing (no phantom money-out) | `accrue_routes_by_bucket_id_and_each_withdraw_drains_only_its_own` · `accrue_zero_is_a_noop_and_empty_withdraw_yields_zero` | `martingaler_vault_fees_tests.move` |
| Fee-router protocol-fee sweep is bounded — an admin withdrawal pays the requested amount capped at what's available (never over-draws), rejects a zero amount, and yields zero on an empty bucket | `withdraw_protocol_pays_requested_then_caps_at_available` · `withdraw_protocol_rejects_zero_amount` · `withdraw_protocol_on_empty_bucket_yields_zero` | `fee_router_withdraw_tests.move` |
| Fees can't be cranked externally to steal or misdirect them | **Code inspection / visibility** — `fee_router::crank_bucket` is `public(package)` (closed the fee-theft hole, #631), so only in-package settlement callers can move fees between buckets; there is no external entry an attacker could call to drain or redirect a fee bucket | `fee_router.move` |
| Aborted market refunds 1:1, never 2:1, no fee | `aborted_path_routes_to_pool_no_fee` · `route_lock_to_abort_refund_pool` | `market_tests` · `martingaler_vault_tests` |
| Aborting twice is rejected (no double refund) | `route_lock_to_abort_twice_aborts` | `martingaler_vault_tests.move` |
| Aborted-market LP seed-recovery is admin-gated and abort-only — only the holding admin cap can drain the abort-pool RESIDUE (the LP seed left after 1:1 bettor refunds) into the treasury, and only on an actually-aborted market | `recover_seed_drains_the_abort_pool_residue_into_treasury` · `recover_seed_rejects_a_non_aborted_market` · `recover_seed_rejects_a_foreign_admin_cap` | `martingaler_vault_seed_recovery_tests.move` |

## Ride (v4 streaming) safety

> **Complete adversarial coverage:** every abort guard in `segment_market_v4`'s
> open / record / crank / abort / prune paths has an explicit `#[expected_failure]`
> rejection test — codes 2, 3, 6, 7, 8, 9, 10, 12, 13, 14, 16, 18, 20, 25.
> (Codes 4 and 5 are reserved placeholders with no live guard.)

| Property | Test | File |
|---|---|---|
| A settled ride cannot be re-settled (no double-pay), on ALL three paths | `close_segment_ride_v4_twice_aborts_already_closed` · `crank_expired_segment_ride_v4_twice_aborts_already_closed` · `abort_segment_ride_v4_twice_aborts_already_closed` | `segment_market_v4_tests.move` |
| The v2 streaming-ride primitive (`ride_position`: open_ride / close_ride / crank) is settlement-safe too — open is guarded (after-expiry, on an aborted market, funded + sufficient escrow, own-path binding), a settled ride can't be double-closed and an aborted-market close refunds 1:1 (no double-pay), crank rejects a still-live (ENotExpired) or touched (must-self-close) ride, and a ride settles only against its OWN bound oracle (a foreign oracle aborts — no outcome manipulation); touch pays the multiplier, no-touch cashes out in-round, expiry refunds escrow only | `close_ride_twice_aborts` · `aborted_market_close_returns_one_to_one_refund_no_double_pay` · `close_ride_against_foreign_oracle_aborts` · `open_ride_zero_escrow_aborts` · `open_ride_insufficient_escrow_aborts` · `open_ride_wrong_path_aborts` · `open_ride_after_expiry_aborts` · `open_ride_on_aborted_market_aborts` · `crank_expired_ride_before_expiry_aborts` · `crank_when_touched_aborts` · `close_ride_with_touch_pays_multiplier` · `close_ride_without_touch_returns_cashout` · `close_ride_after_expiry_no_touch_returns_escrow_refund_only` | `ride_position_tests.move` |
| The candle stream can't be cranked on an empty market, and a crank can't under-pay an insolvent vault | `record_segment_v4_rejects_when_no_active_rides` (ENoActiveRides) · `crank_expired_rejects_when_treasury_insufficient` (EInsufficientTreasuryForCrank) | `segment_market_v4_tests.move` |
| Touch wins ties at the close boundary | `both_barriers_touch_same_segment_upper_wins_tie_break` | `segment_market_v4_tests.move` |
| Either-touch resolves to the correct barrier | `close_upper_touch_wins…` · `close_lower_touch_wins…` · `nearer_barrier_picks_closer` | `segment_market_v4_tests.move` |
| A ride's close touch-scan is bounded to its OWN round (no cross-round escape) — a ride held across its round boundary can't "touch" a later round's barrier to escape its dealt outcome (e.g. claim a jackpot instead of the EXPIRED_LOSS / rug it was given); the scan stops at the ride's round end, matching `crank_expired` (v4.26 fix #683) | `ride_cannot_touch_win_on_a_later_rounds_segment` | `segment_market_v4_tests.move` |
| Cash-out within the round pays the Bachelier curve | `close_no_touch_within_round_yields_cashout` | `segment_market_v4_tests.move` |
| Aborted ride refunds escrow 1:1 past the deadline — and an abort BEFORE the deadline is rejected (no early bail-out on a losing ride) | `abort_segment_ride_v4_past_deadline_refunds_one_to_one` · `abort_segment_ride_v4_before_deadline_rejected` | `segment_market_v4_tests.move` |
| `crank_expired` only settles a genuinely-expired, non-touched ride — it rejects a still-live ride (ENotExpired) and a touched/winning ride (ETouchedMustSelfClose), so no one can force a loss before its time or rob a winner of a self-close | `crank_expired_segment_ride_v4_before_expiry_rejected` · `crank_expired_rejects_touched_ride_must_self_close` | `segment_market_v4_tests.move` |
| A ride held ACROSS its round boundary cannot escape its round's outcome — `close`'s touch scan is bounded to the ride's OWN round (`scan_to = min(next_segment_index, ride_round_end_segment)`, matching `crank`), so a rugged ride can't "touch-win" on a LATER round's segment and collect a jackpot instead of its dealt EXPIRED_LOSS (cross-round rug-escape loss-of-funds fix, #683) | `ride_cannot_touch_win_on_a_later_rounds_segment` | `segment_market_v4_tests.move` |
| No NEW ride can open on an aborted market | `open_segment_ride_v4_rejects_aborted_market` | `segment_market_v4_tests.move` |
| Per-round payout is capped | `either_max_payout_cap_enforced` | `segment_market_v4_tests.move` |
| Aggregate correlated-market exposure (PWE) decays on the EWMA half-life so caps free up on schedule, register/read round-trips, and a decrease floors at 0 (no u128 underflow) | `ewma_halves_at_one_half_life` · `ewma_quarters_at_two_half_lives` · `ewma_linear_fraction_at_half_a_half_life` · `read_pwe_decays_over_time` · `decrease_floors_at_zero` | `global_exposure_registry_tests.move` |
| Zero-value escrow / settlement is rejected | `deposit_ride_escrow_zero_value_aborts` · `withdraw_for_ride_settlement_zero_amount_aborts` | `martingaler_vault_tests.move` |
| Stake-per-segment must be within [min, max] | `open_segment_ride_v4_rejects_stake_below_min` · `open_segment_ride_v4_rejects_stake_above_max` | `segment_market_v4_tests.move` |
| Ride opens only against its own vault, with funded escrow (non-zero AND ≥ stake × round_duration) | `open_segment_ride_v4_rejects_wrong_vault` · `open_segment_ride_v4_rejects_zero_escrow` · `open_segment_ride_v4_rejects_insufficient_escrow` | `segment_market_v4_tests.move` |
| Concurrent-ride cap is enforced on open | `open_segment_ride_v4_rejects_when_concurrent_cap_reached` | `segment_market_v4_tests.move` |
| The ride exposure/rate-cap primitive is sound (the /ride loss-of-funds backstop) — stake rate must be within [min, max], reserve/release conserves both the market-wide and per-user trackers, and reserving past the market OR per-user cap aborts | `rate_in_range_accepts_both_boundaries` · `rate_below_min_aborts` · `rate_above_max_aborts` · `reserve_then_release_conserves_both_trackers` · `reserve_over_market_cap_aborts` · `reserve_over_user_cap_aborts` | `ride_market_caps_tests.move` |
| Ride settles only against the market it opened on | `close_segment_ride_v4_rejects_wrong_market` | `segment_market_v4_tests.move` |
| Segment storage is reclaimed (pruned) only when SAFE — round past the settlement lag, every ride in it settled, archived to Walrus, and not already pruned. In particular a round with an UNSETTLED ride cannot be pruned, so the keys a player needs to settle and a judge needs to verify are never deleted out from under them | `prune_settled_segments_v4_aborts_when_too_soon` · `prune_settled_segments_v4_rejects_unsettled_rides` · `prune_settled_segments_v4_is_idempotent` · `prune_settled_segments_v4_succeeds_after_lag_and_archive` | `segment_market_v4_tests.move` |

## House edge (v4.26 rug) safety

| Property | Test | File |
|---|---|---|
| The rug fires at most once per round | `rug_does_not_double_fire_per_round` | `segment_market_v4_tests.move` |
| A round roll clears the rug state | `round_roll_clears_rug` | `segment_market_v4_tests.move` |
| Rug takes precedence — a touch after a rug still loses | `close_after_rug_settles_as_loss_even_on_touch` | `segment_market_v4_tests.move` |
| Rug disabled when `rug_chance_bps == 0` | `rug_chance_zero_is_disabled` | `segment_market_v4_tests.move` |
| Rug fires at the calibrated rate (house-edge soundness) | `rug_fires_at_expected_rate` | `segment_market_v4_tests.move` |

## Immutable rules — the house can't change the game after you bet

Provable fairness proves the *outputs* are honest; this proves the *rules* can't
move under you. Every economic parameter is set once at market bootstrap and has
**no production setter** — multiplier, barrier offset, deadband, cash-out spread,
sigma, max-payout-per-round, and the min/max stake bounds. The rug chance is the
same: the only function that writes `rug_chance_bps` after `enable_rug` is
`#[test_only] test_only_set_rug_chance_bps` — it is compiled out of the published
package, so on-chain the rug rate is frozen at enable time. So the house cannot
quietly raise the rug chance, lower the win multiplier, or widen the spread after
a player has opened a ride.

| Property | Proof | Where |
|---|---|---|
| Economic configs are immutable (no production setter for multiplier / offset / deadband / spread / sigma / max-payout / stake bounds) | **Code inspection** — `grep` the module for `market.<field> =` finds only the bootstrap constructor; there is no `set_*` / `update_*` entry function | `segment_market_v4.move` |
| Rug chance is frozen after `enable_rug` (no production setter) | **Code inspection** — the sole writer of `rug_chance_bps` post-enable is `#[test_only] test_only_set_rug_chance_bps`, absent from the published bytecode | `segment_market_v4.move` |
| `enable_rug` is one-shot — a second call cannot re-install the config and wipe a live `rugged_at_segment` (halt is immutable once armed) | `enable_rug_twice_rejected` | `segment_market_v4_tests.move` |
| A ride is paid against the market's CONFIGURED rate, not a quietly-lowered one | the ride snapshots `multiplier_bps`/barriers at open; the off-chain audit re-checks the snapshot against the live market — `ride.multiplier == market.multiplier` and `barriers == spot ± offset` | `scripts/verify-payout.ts` (#457) · `scripts/verify-barriers.ts` (#335) |

## Adversarial / liveness

| Property | Test | File |
|---|---|---|
| Open after the round boundary aborts cleanly (no torn state) | `open_window_race_after_boundary_aborts_cleanly` | `segment_market_adversarial.move` |
| Concurrent-ride cap holds at the max | `concurrent_open_cap_holds_at_max_concurrent_rides` | `segment_market_adversarial.move` |
| Per-user ride cap bounds one account's exposure | `open_segment_ride_v4_enforces_per_user_cap` | `segment_market_v4_tests.move` |
| One barrier's cap exhaustion leaves the other open | `per_barrier_cap_exhaustion_keeps_other_barrier_open` | `segment_market_adversarial.move` |
| WICK-staking anti-loop — a sybil cluster can't loop network losses into a net-positive drain of the staker reward pool: dividend claims are capped at 30% of an address's tracked lifetime loss, and any excess is auto-forfeited ON-CHAIN to the insurance recipient (not returned to the caller), with the cap persisting across repeated claims | `claim_capped_at_30pct_of_lifetime_loss_forfeit_auto_routed` · `zero_lifetime_loss_means_zero_cap_full_forfeit_auto_routed` · `cap_carries_across_multiple_claims_in_same_currency` | `wick_staking_tests.move` |
| A ride held across a round boundary can always be settled by its OWNER — `crank_expired_segment_ride_v4` adds no admin/time gate beyond ownership, so the player reclaims their own escrow without the house, an indexer, or anyone's cooperation (censorship-resistant: the house cannot block your settlement). The ride is an OWNED object (the SDK `transferObjects([ride], sender)` at open), so the function takes `&mut` an owned ride — the owner self-settles; a third party CANNOT crank someone else's ride (the test's "permissionless" means no gate *beyond* ownership). Corollary: a truly-abandoned ride can be settled only by its owner returning — no third-party reaper exists — so abandoned rides are owner-recoverable but not externally cleanable. | `ride_spans_round_boundary_and_permissionless_backup_crank_settles` | `segment_market_adversarial.move` |

## Determinism (the auditability backbone)

The candle a player sees is reproducible bit-for-bit off the on-chain key. The
TypeScript port (`sdk/src/seededPath.ts`) is checked byte-identical against the
Move `expand_segment` at **10,000 vectors** via a rolling digest:
`npm run conformance:check` (regenerates `tests/seeded_path_conformance.move`
and fails on any diff). This is what makes `/verify` and `verify-v4.ts` able to
replay any ride and catch a dishonest house.
