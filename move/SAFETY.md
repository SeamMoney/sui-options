# Wick Move — safety property → test traceability

The Wick contracts hold user collateral, so the load-bearing properties are the
ones that protect funds. This file maps each safety property (the list in
[`AGENTS.md`](../AGENTS.md) "Safety properties the Move package must enforce" +
"The collateral invariant") to the named test(s) that prove it, so an auditor or
judge can run a specific test rather than take the claim on faith.

Run the whole suite: `sui move test` (from `move/`) — **610/610 passing**.
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

## Settlement safety

| Property | Test | File |
|---|---|---|
| A market cannot settle both ways (HIT ⟂ EXPIRED) | `crank_expired_no_touch_yields_expired_loss` + `close_upper_touch_wins_with_touched_side_upper` | `segment_market_v4_tests.move` |
| DNT corridor settles one way only (HELD ⟂ BROKEN) | `lock_and_settle_dnt_held_idempotent_cannot_flip_to_broken` + `lock_and_settle_dnt_market_with_held_corridor_pays_inside_side` + `lock_and_settle_dnt_market_with_breached_corridor_pays_outside_side` | `dnt_tests.move` |
| Settlement is idempotent (repeat = no-op / revert) | `lock_and_settle_idempotent` · `release_idempotent_on_already_released` · `prune_settled_segments_v4_is_idempotent` | `market_tests` · `martingaler_vault_tests` · `segment_market_v4_tests` |
| `lock_and_settle` is atomic — snapshot, status, fee accrual, and lock release commit together | **Guaranteed by Sui's transaction model**: a Move call commits in full or aborts in full, so there is no partial-commit state a unit test could observe. The settle path's combined effects are exercised end-to-end by the close/crank tests, and `lock_and_settle_idempotent` proves a repeat call cannot re-mutate | `segment_market_v4_tests.move` |
| Losing side cannot redeem (receives zero) | `loser_receives_zero` | `market_tests.move` |
| A touch/no-touch open is fully guarded (funded stake, before expiry, own vault + path, valid side) | `cannot_open_with_zero_stake` · `cannot_open_after_expiry` · `cannot_open_against_wrong_vault` · `cannot_open_against_wrong_path` · `cannot_open_with_invalid_side` | `market_tests.move` |
| Repeated `redeem` cannot double-pay | **Guaranteed by Move's linear types** — `redeem` consumes `position: Position` *by value* (`market.move`), so re-redeeming the same position is a compile-time use-after-move, never a runtime path; `cannot_redeem_when_active` guards the not-yet-settled case | `market.move` · `market_tests.move` |
| Fees route to the right buckets only on a winning redeem | `fee_routes_to_router_buckets_on_winner_redeem` | `market_tests.move` |
| Aborted market refunds 1:1, never 2:1, no fee | `aborted_path_routes_to_pool_no_fee` · `route_lock_to_abort_refund_pool` | `market_tests` · `martingaler_vault_tests` |
| Aborting twice is rejected (no double refund) | `route_lock_to_abort_twice_aborts` | `martingaler_vault_tests.move` |

## Ride (v4 streaming) safety

| Property | Test | File |
|---|---|---|
| A settled ride cannot be re-settled (no double-pay), on ALL three paths | `close_segment_ride_v4_twice_aborts_already_closed` · `crank_expired_segment_ride_v4_twice_aborts_already_closed` · `abort_segment_ride_v4_twice_aborts_already_closed` | `segment_market_v4_tests.move` |
| Touch wins ties at the close boundary | `both_barriers_touch_same_segment_upper_wins_tie_break` | `segment_market_v4_tests.move` |
| Either-touch resolves to the correct barrier | `close_upper_touch_wins…` · `close_lower_touch_wins…` · `nearer_barrier_picks_closer` | `segment_market_v4_tests.move` |
| Cash-out within the round pays the Bachelier curve | `close_no_touch_within_round_yields_cashout` | `segment_market_v4_tests.move` |
| Aborted ride refunds escrow 1:1 past the deadline — and an abort BEFORE the deadline is rejected (no early bail-out on a losing ride) | `abort_segment_ride_v4_past_deadline_refunds_one_to_one` · `abort_segment_ride_v4_before_deadline_rejected` | `segment_market_v4_tests.move` |
| `crank_expired` only settles a genuinely-expired, non-touched ride — it rejects a still-live ride (ENotExpired) and a touched/winning ride (ETouchedMustSelfClose), so no one can force a loss before its time or rob a winner of a self-close | `crank_expired_segment_ride_v4_before_expiry_rejected` · `crank_expired_rejects_touched_ride_must_self_close` | `segment_market_v4_tests.move` |
| No NEW ride can open on an aborted market | `open_segment_ride_v4_rejects_aborted_market` | `segment_market_v4_tests.move` |
| Per-round payout is capped | `either_max_payout_cap_enforced` | `segment_market_v4_tests.move` |
| Zero-value escrow / settlement is rejected | `deposit_ride_escrow_zero_value_aborts` · `withdraw_for_ride_settlement_zero_amount_aborts` | `martingaler_vault_tests.move` |
| Stake-per-segment must be within [min, max] | `open_segment_ride_v4_rejects_stake_below_min` · `open_segment_ride_v4_rejects_stake_above_max` | `segment_market_v4_tests.move` |
| Ride opens only against its own vault, with funded escrow (non-zero AND ≥ stake × round_duration) | `open_segment_ride_v4_rejects_wrong_vault` · `open_segment_ride_v4_rejects_zero_escrow` · `open_segment_ride_v4_rejects_insufficient_escrow` | `segment_market_v4_tests.move` |
| Concurrent-ride cap is enforced on open | `open_segment_ride_v4_rejects_when_concurrent_cap_reached` | `segment_market_v4_tests.move` |
| Ride settles only against the market it opened on | `close_segment_ride_v4_rejects_wrong_market` | `segment_market_v4_tests.move` |

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
| A ride held across a round boundary can always be settled by its OWNER — `crank_expired_segment_ride_v4` adds no admin/time gate beyond ownership, so the player reclaims their own escrow without the house, an indexer, or anyone's cooperation (censorship-resistant: the house cannot block your settlement). The ride is an OWNED object (the SDK `transferObjects([ride], sender)` at open), so the function takes `&mut` an owned ride — the owner self-settles; a third party CANNOT crank someone else's ride (the test's "permissionless" means no gate *beyond* ownership). Corollary: a truly-abandoned ride can be settled only by its owner returning — no third-party reaper exists — so abandoned rides are owner-recoverable but not externally cleanable. | `ride_spans_round_boundary_and_permissionless_backup_crank_settles` | `segment_market_adversarial.move` |

## Determinism (the auditability backbone)

The candle a player sees is reproducible bit-for-bit off the on-chain key. The
TypeScript port (`sdk/src/seededPath.ts`) is checked byte-identical against the
Move `expand_segment` at **10,000 vectors** via a rolling digest:
`npm run conformance:check` (regenerates `tests/seeded_path_conformance.move`
and fails on any diff). This is what makes `/verify` and `verify-v4.ts` able to
replay any ride and catch a dishonest house.
