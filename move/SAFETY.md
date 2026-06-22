# Wick Move — safety property → test traceability

The Wick contracts hold user collateral, so the load-bearing properties are the
ones that protect funds. This file maps each safety property (the list in
[`AGENTS.md`](../AGENTS.md) "Safety properties the Move package must enforce" +
"The collateral invariant") to the named test(s) that prove it, so an auditor or
judge can run a specific test rather than take the claim on faith.

Run the whole suite: `sui move test` (from `move/`) — **593/593 passing**.
Run one property: `sui move test <test_name>` (substring match on the function).

## The collateral invariant — load-bearing

`collateral_vault == total_touch_supply == total_no_touch_supply` after every
state transition. Bugs here are direct loss of funds.

| Property | Test | File |
|---|---|---|
| Vault conservation: `Σ in − Σ out == held` | `conservation_in_minus_out_equals_held` | `martingaler_vault_tests.move` |
| Winner paid in full from the per-market lock | `pay_winner_full_from_lock` | `martingaler_vault_tests.move` |
| Partial pay queues the remainder (no overdraw) | `pay_winner_partial_then_queue_remainder` | `martingaler_vault_tests.move` |
| Empty lock ⇒ full payout queued (FIFO), never minted | `pay_winner_full_queue_when_lock_empty` | `martingaler_vault_tests.move` |

## Settlement safety

| Property | Test | File |
|---|---|---|
| A market cannot settle both ways (HIT ⟂ EXPIRED) | `crank_expired_no_touch_yields_expired_loss` + `close_upper_touch_wins_with_touched_side_upper` | `segment_market_v4_tests.move` |
| DNT corridor settles one way only (HELD ⟂ BROKEN) | `lock_and_settle_dnt_held_idempotent_cannot_flip_to_broken` + `lock_and_settle_dnt_market_with_held_corridor_pays_inside_side` + `lock_and_settle_dnt_market_with_breached_corridor_pays_outside_side` | `dnt_tests.move` |
| Settlement is idempotent (repeat = no-op / revert) | `lock_and_settle_idempotent` · `release_idempotent_on_already_released` · `prune_settled_segments_v4_is_idempotent` | `market_tests` · `martingaler_vault_tests` · `segment_market_v4_tests` |
| Losing side cannot redeem (receives zero) | `loser_receives_zero` | `market_tests.move` |
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
| Aborted ride refunds escrow 1:1 past the deadline | `abort_segment_ride_v4_past_deadline_refunds_one_to_one` | `segment_market_v4_tests.move` |
| Per-round payout is capped | `either_max_payout_cap_enforced` | `segment_market_v4_tests.move` |
| Zero-value escrow / settlement is rejected | `deposit_ride_escrow_zero_value_aborts` · `withdraw_for_ride_settlement_zero_amount_aborts` | `martingaler_vault_tests.move` |

## House edge (v4.26 rug) safety

| Property | Test | File |
|---|---|---|
| The rug fires at most once per round | `rug_does_not_double_fire_per_round` | `segment_market_v4_tests.move` |
| A round roll clears the rug state | `round_roll_clears_rug` | `segment_market_v4_tests.move` |
| Rug takes precedence — a touch after a rug still loses | `close_after_rug_settles_as_loss_even_on_touch` | `segment_market_v4_tests.move` |
| Rug disabled when `rug_chance_bps == 0` | `rug_chance_zero_is_disabled` | `segment_market_v4_tests.move` |
| Rug fires at the calibrated rate (house-edge soundness) | `rug_fires_at_expected_rate` | `segment_market_v4_tests.move` |

## Adversarial / liveness

| Property | Test | File |
|---|---|---|
| Open after the round boundary aborts cleanly (no torn state) | `open_window_race_after_boundary_aborts_cleanly` | `segment_market_adversarial.move` |
| Concurrent-ride cap holds at the max | `concurrent_open_cap_holds_at_max_concurrent_rides` | `segment_market_adversarial.move` |
| Per-user ride cap bounds one account's exposure | `open_segment_ride_v4_enforces_per_user_cap` | `segment_market_v4_tests.move` |
| One barrier's cap exhaustion leaves the other open | `per_barrier_cap_exhaustion_keeps_other_barrier_open` | `segment_market_adversarial.move` |
| A ride spanning a round boundary is settled by a permissionless backup crank | `ride_spans_round_boundary_and_permissionless_backup_crank_settles` | `segment_market_adversarial.move` |

## Determinism (the auditability backbone)

The candle a player sees is reproducible bit-for-bit off the on-chain key. The
TypeScript port (`sdk/src/seededPath.ts`) is checked byte-identical against the
Move `expand_segment` at **10,000 vectors** via a rolling digest:
`npm run conformance:check` (regenerates `tests/seeded_path_conformance.move`
and fails on any diff). This is what makes `/verify` and `verify-v4.ts` able to
replay any ride and catch a dishonest house.
