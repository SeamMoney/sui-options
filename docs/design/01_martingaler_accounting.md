# Martingaler Accounting State Machine — Wick Markets

> Status: design spec, not yet implemented. Targets a future replacement of the
> per-market `vault::Vault<C>` model in `move/sources/vault.move` with a single
> protocol-wide `MartingalerVault<C>` that backs every Wick-native touch /
> no-touch market simultaneously.
>
> Borrowed from papertrade.xyz's "treasury + queue + side bucket" model and
> adapted for binary path-dependent payouts. The word "fork" is banned per
> project convention; this is a *transcription* of the idea, rewritten for
> Wick's domain (per AGENTS.md: "transcribe the idea and rewrite cleanly").

## 0. Design intent in one paragraph

A single protocol-wide USDC `treasury` faces every Wick-native market. When a
market settles and the winning side's payout obligation exceeds available
treasury, the unpaid remainder is enqueued as on-chain debt — a FIFO `Queue` of
`Payout` claims. Trader stakes from open positions and losing-side stakes at
settlement first refill any non-empty `side_bucket` parking lot, which is then
drained into queue heads via permissionless `harvest(max_entries)` calls.
Net protocol equity = `treasury + side_bucket − queue_total` and is allowed to
be negative by design. Winners always get paid in full eventually; the
protocol absorbs timing risk, never haircut risk. LP/staker yield is the
positive expectation of binary house-edge over many markets, paid in the form
of a growing `treasury` once `queue_total == 0`.

---

## 1. State variables

All fields live on a single shared object:

```move
public struct MartingalerVault<phantom C> has key {
    id: UID,

    // ---- core balances (Sui Balance<C>, not Coin) ----
    treasury:     Balance<C>,   // free liquidity available to pay winners NOW
    side_bucket:  Balance<C>,   // parking lot: filled while queue non-empty,
                                // drained by harvest into queue heads
    queue_funds:  Balance<C>,   // funds already earmarked for queued claims
                                // (claim_queued_payout pulls from here)

    // ---- settlement-locked obligations ----
    settlement_lock: Balance<C>, // funds reserved between lock_settlement
                                 // and settle_market_*; prevents re-spending
                                 // committed liquidity mid-settlement

    // ---- queue (FIFO of unpaid winner obligations) ----
    queue_head:   u64,          // index of next entry to be funded
    queue_tail:   u64,          // index past the last enqueued entry
    queue_total:  u64,          // sum of all (entry.amount - entry.funded) for
                                // entries with index in [queue_head, queue_tail)
    // entries themselves stored in a Table<u64, QueueEntry> attached as
    // dynamic_field to `id`. See § 6.

    // ---- accrued fees (segregated; do not count toward solvency) ----
    protocol_fees: Balance<C>,  // claimable by protocol multisig
    staker_fees:   Balance<C>,  // streams to LP / WICK stakers post-MVP

    // ---- accounting telemetry (u128 to survive long histories) ----
    cumulative_stakes_in:    u128,  // monotonic; total stake ever deposited
    cumulative_payouts_out:  u128,  // monotonic; total ever paid to winners
                                    // (including via claim_queued_payout)
    cumulative_losses_absorbed: u128, // monotonic; total losing-side stake
                                      // ever absorbed by side_bucket+treasury
    cumulative_fees_taken:   u128,  // monotonic; protocol+staker
    enqueue_count: u64,             // monotonic counter, == queue_tail
    drain_count:   u64,             // monotonic; number of fully funded entries
                                    // (drain_count <= queue_head; they may be
                                    // marked-funded but not yet claimed)

    // ---- config ----
    protocol_fee_bps: u64,    // basis points of stake credited to protocol
    staker_fee_bps:   u64,    // basis points of stake credited to stakers
    max_harvest_per_call: u64,// gas safety: cap per harvest() call
    pause_open: bool,         // circuit breaker; settlement still works
}
```

### `QueueEntry` payload

```move
public struct QueueEntry has store, drop {
    market_id:   ID,            // which market produced this debt
    position_id: ID,            // exact winning Position object
    owner:       address,       // entitled recipient
    amount:      u64,           // total payout owed
    funded:      u64,           // funded so far (0 <= funded <= amount)
    created_ms:  u64,           // for analytics / SLA dashboards
    side:        u8,            // SIDE_TOUCH or SIDE_NO_TOUCH (informational)
}
```

An entry is *fully funded* when `funded == amount`. Once fully funded, the
owner can call `claim_queued_payout` to receive a `Coin<C>` and the entry is
deleted. Partial funding is allowed and visible on-chain so the UI can show
"82% funded, 18% pending."

### Per-market companion state (lives on existing `Market<C>`, lightly modified)

The `Market<C>` keeps its existing `touch_exposure`, `no_touch_exposure`,
`payout_multiplier_bps`, `expiry_ms`, but loses its inline `vault: Vault<C>`
field. In its place: a `vault_id: ID` reference back to the shared
`MartingalerVault<C>`. All deposits and withdrawals route through the shared
vault.

A new per-market field tracks settlement state for idempotency:

```move
status: u8,   // 0=OPEN, 1=LOCKED, 2=SETTLED_TOUCH, 3=SETTLED_NO_TOUCH
locked_obligation: u64,  // amount transferred to vault.settlement_lock at
                         // lock_settlement; used by settle_market_* to know
                         // how much to release back into the system.
```

---

## 2. State transitions

Notation: `Δfield` means "field changes by this signed amount." Unspecified
fields are unchanged. `assert!` lines are preconditions. Postconditions list
invariants that must re-hold after the transition.

### 2.1 `open_touch(market, stake_coin, owner) -> Position`

Same shape for `open_no_touch` — only the side flag differs.

**Preconditions**

```
assert!(!vault.pause_open);
assert!(now < market.expiry_ms);
assert!(market.status == OPEN);
assert!(stake_coin.value() > 0);
let stake = stake_coin.value();
let payout = stake * market.payout_multiplier_bps / 10_000;
let net_stake = stake - fee_protocol - fee_staker;
```

**State delta**

```
treasury        += net_stake          // ALL net stake goes into treasury
                                      // (NOT side_bucket on open — see §7)
protocol_fees   += fee_protocol
staker_fees     += fee_staker
market.touch_exposure += payout       // worst-case obligation if this side wins

cumulative_stakes_in += stake
cumulative_fees_taken += (fee_protocol + fee_staker)
```

**Position object minted**

```
Position {
    market_id: id(market),
    side: SIDE_TOUCH,
    stake,
    payout_if_win: payout,
}
```

**Events**

```
PositionOpened { market_id, position_id, side, stake, payout, owner }
TreasuryGrew  { delta: net_stake, new_treasury_value: treasury.value() }
```

**Postconditions** — see § 3 invariants. Crucially the **per-market** solvency
check from the current `market.move` is *removed*; the new model accepts
that an individual market can be undercollateralized as long as the protocol
queue mechanism makes winners whole eventually.

### 2.2 `lock_settlement(market, oracle, clock)`

Called once by anyone after expiry. Computes the touch outcome from the path
observation, freezes the market, and reserves the maximum possible payout
obligation in `settlement_lock` so no one can drain `treasury` from under it
between `lock` and `settle`.

**Preconditions**

```
assert!(now >= market.expiry_ms);
assert!(market.status == OPEN);
let outcome_side = if (path::touched(...)) SIDE_TOUCH else SIDE_NO_TOUCH;
let winning_exposure = if (outcome_side == SIDE_TOUCH)
    market.touch_exposure else market.no_touch_exposure;
let losing_exposure  = if (outcome_side == SIDE_TOUCH)
    market.no_touch_exposure else market.touch_exposure;
let losing_stake_freed = losing_exposure * 10_000 / market.payout_multiplier_bps;
                                      // released stake from losers
let to_lock = min(winning_exposure, treasury.value());
```

**State delta**

```
treasury        -= to_lock
settlement_lock += to_lock
market.status    = LOCKED
market.locked_obligation = winning_exposure  // total owed; lock may be partial
market.outcome_side = outcome_side
```

**Events**

```
SettlementLocked {
    market_id, outcome_side, winning_exposure,
    locked_now: to_lock, shortfall_at_lock: winning_exposure - to_lock,
}
```

**Postconditions**

```
treasury_value_before == treasury_value_after + to_lock
settlement_lock_after >= to_lock
```

### 2.3 `settle_market_touch(market, vault)` and `settle_market_no_touch`

Called once after `lock_settlement`. Releases losers' stake and either pays
winners directly from `settlement_lock` or enqueues the shortfall.

For brevity below, "winning side" and "losing side" refer to the side
indicated by `market.outcome_side`. Winners are NOT paid here individually —
this transition only marks the market as settled and routes pooled funds.
Individual winners then call `redeem_position` (§ 2.4).

**Preconditions**

```
assert!(market.status == LOCKED);
let winning_exposure = market.locked_obligation;
let locked = settlement_lock.value();   // the amount we reserved
let losing_stake = losing_exposure * 10_000 / market.payout_multiplier_bps;
```

**State delta**

```
// 1. Release locked funds back into a settlement-time pool
let total_available = locked + losing_stake;
                          // both sources can pay winners

// 2. If queue is non-empty, the *losing stake* portion is diverted to the
//    side_bucket per Martingaler rule. Locked funds (which originated from
//    treasury) flow back to treasury so they can pay this market's winners.
if (queue_total == 0) {
    treasury    += losing_stake          // straight protocol profit potential
    treasury    += 0  /* locked stays in settlement_lock until redeemed */
} else {
    side_bucket += losing_stake          // park while queue exists
}

// 3. Compute shortfall and enqueue
let shortfall = if (winning_exposure > locked) {
    winning_exposure - locked
} else { 0 };
if (shortfall > 0) {
    enqueue_shortfall_for_winners(market, shortfall)
    // creates one QueueEntry per winning Position, sized pro-rata.
    // queue_total += shortfall
    // queue_tail  += <num winning positions>
}

market.status = SETTLED_TOUCH or SETTLED_NO_TOUCH
cumulative_losses_absorbed += losing_stake
```

**Events**

```
MarketSettled {
    market_id, outcome_side, winning_exposure,
    paid_from_lock: locked, shortfall_enqueued: shortfall,
    losing_stake_absorbed: losing_stake,
    losing_stake_destination: (queue_total>0 ? "side_bucket" : "treasury"),
}
QueueEntryEnqueued { market_id, position_id, owner, amount } // per entry
```

**Postconditions**

```
market.status in {SETTLED_TOUCH, SETTLED_NO_TOUCH}
queue_total_after - queue_total_before == shortfall
```

Note: this transition can over-enqueue if winners never claim, but
`claim_queued_payout` is the only way to physically pay them, so funds remain
conserved. See § 5 edge case "winner abandons position."

### 2.4 `redeem_position(market, position, vault) -> Coin<C>`

Called by a winning position holder after settlement. Splits into two cases:

**Case A — fully funded by `settlement_lock`** (treasury was deep enough):

```
let pro_rata_payout = position.payout_if_win;  // exactly
settlement_lock     -= pro_rata_payout
cumulative_payouts_out += pro_rata_payout
// position deleted
// emit PositionRedeemed{won: true, paid_in_full: true}
return Coin<C> { pro_rata_payout }
```

**Case B — partially or fully queued**:

If the position has a corresponding `QueueEntry`, the redeemer instead
receives `Coin<C> { funded_so_far }` immediately and the entry's
`funded` is reset to zero (since paid out). Remaining `amount - funded` stays
queued. If the position was *split* (some paid from lock, some queued at
settlement), Case A handles the lock portion and the queue handles the rest.

For losing positions: returns `Coin::zero()`, no balance touched, position
deleted. Emits `PositionRedeemed{won: false}`.

### 2.5 `harvest(vault, max_entries)`

Permissionless. Drains `side_bucket` into queue heads in FIFO order, up to
`max_entries` entries (capped by `vault.max_harvest_per_call`).

**Preconditions**

```
assert!(side_bucket.value() > 0);
assert!(queue_total > 0);
let n = min(max_entries, vault.max_harvest_per_call);
```

**State delta** (loop, up to `n` iterations or until `side_bucket` empty)

```
loop:
    if (side_bucket.value() == 0) break;
    if (queue_head >= queue_tail) break;       // queue empty
    let entry = &mut queue[queue_head];
    let need  = entry.amount - entry.funded;
    let pay   = min(need, side_bucket.value());
    side_bucket -= pay
    queue_funds += pay
    entry.funded += pay
    queue_total  -= pay
    if (entry.funded == entry.amount) {
        queue_head += 1
        drain_count += 1
        emit QueueEntryFunded { entry, ... }
    }
```

**Events**

```
HarvestRan { entries_funded, total_drained, side_bucket_after, queue_total_after }
```

### 2.6 `claim_queued_payout(vault, queue_index, ctx) -> Coin<C>`

Called by a queue entry's owner (or anyone — coin returns to caller, so
wallets must call from the owner address). Pays out whatever is currently
funded for that entry.

**Preconditions**

```
let entry = &queue[queue_index];
assert!(entry.owner == ctx.sender());
assert!(entry.funded > 0);
```

**State delta**

```
let pay = entry.funded;
queue_funds -= pay
entry.funded = 0;
entry.amount -= pay;
if (entry.amount == 0) {
    delete queue[queue_index]   // freed; gas refund
}
cumulative_payouts_out += pay
```

**Events**

```
QueuedPayoutClaimed { queue_index, owner, paid: pay, remaining: entry.amount }
```

---

## 3. Invariants

The headline invariant — must hold at the end of every public function:

```
INV-1  (vault solvency, the load-bearing one)

    treasury + side_bucket + settlement_lock + queue_funds
    + protocol_fees + staker_fees
    ==
    sum_open_position_stakes
    + sum_locked_obligations          // settlement_lock per market
    + queue_total
    + queue_funds                     // funds earmarked but unclaimed
    + protocol_fees + staker_fees
    - cumulative_payouts_out_already_paid_directly
    + cumulative_stakes_in_already_consumed
```

In simpler operational form:

```
INV-1' (conservation)

    Δ(treasury + side_bucket + settlement_lock + queue_funds
      + protocol_fees + staker_fees)
    ==
    Σ(stake_coins_in) - Σ(coins_out_to_users)
```

Every public function must net to zero coin movement against the user ledger.

```
INV-2  (no negative balances)
    treasury.value() >= 0   (Move's Balance<C> enforces; just a sanity reminder)
    side_bucket.value() >= 0
    settlement_lock.value() >= 0
    queue_funds.value() >= 0

INV-3  (queue ordering, FIFO)
    queue_head <= queue_tail
    drain_count <= queue_head <= enqueue_count == queue_tail

INV-4  (queue-funds matches funded entries)
    queue_funds.value() == Σ entry.funded for entry in queue[head..tail]

INV-5  (queue total matches unpaid)
    queue_total == Σ (entry.amount - entry.funded) for entry in queue[head..tail]

INV-6  (idempotent settlement)
    market.status transitions are monotonic:
    OPEN → LOCKED → SETTLED_*  (never reverses, never branches)

INV-7  (mutual exclusion of outcome)
    market.status ∈ {SETTLED_TOUCH, SETTLED_NO_TOUCH} — never both,
    never neither after settle is called.

INV-8  (no over-payment per position)
    For any Position: total Coin<C> ever paid to its owner
    <= position.payout_if_win

INV-9  (losers get nothing)
    If position.side != market.outcome_side, redeem_position pays 0.

INV-10 (monotonic telemetry)
    cumulative_stakes_in, cumulative_payouts_out,
    cumulative_losses_absorbed, cumulative_fees_taken — all monotonically
    non-decreasing across every transaction.

INV-11 (harvest preserves equity)
    Δtreasury + Δside_bucket + Δqueue_funds + Δqueue_total == 0
    (harvest only moves money between buckets; nothing leaves)

INV-12 (open_* never enqueues)
    Only settle_market_* may grow queue_total. open_* and harvest never do.
```

Net protocol equity, by definition:

```
equity := treasury + side_bucket - queue_total
```

Equity may be **negative**. That is the entire point of Martingaler
bootstrapping: the protocol promises future cash flows out of expected losing
trades to back current winning ones. Stakers / LPs are claimants on this
equity once it turns positive and `queue_total == 0`.

---

## 4. Worked example: 10 trades from $0

Setup: payout multiplier = 1.80x (180_000 bps / 10 = 18_000 bps), all stakes
in USDC, fees set to zero for clarity, single market with both touch and
no-touch sides. Outcome is decided per-row in column "RESULT".

Numbers in USDC. T = treasury, SB = side_bucket, SL = settlement_lock,
QF = queue_funds, QT = queue_total, EQ = equity = T + SB - QT.

Two markets used: M1 (touch wins), M2 (no-touch wins).

| # | Action | Inputs | T | SB | SL | QF | QT | EQ | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 0 | (start) | — | 0 | 0 | 0 | 0 | 0 | 0 | bootstrapped from $0 |
| 1 | open M1 touch  | stake $100, payout $180 | 100 | 0 | 0 | 0 | 0 | 100 | M1.touch_exp = 180 |
| 2 | open M1 no-touch | stake $100, payout $180 | 200 | 0 | 0 | 0 | 0 | 200 | M1.no_touch_exp = 180 |
| 3 | open M1 touch  | stake $50,  payout $90  | 250 | 0 | 0 | 0 | 0 | 250 | M1.touch_exp = 270 |
| 4 | open M2 touch  | stake $100, payout $180 | 350 | 0 | 0 | 0 | 0 | 350 | M2.touch_exp = 180 |
| 5 | lock M1 (touch wins) | winning_exp=270, treasury=350 | 80 | 0 | 270 | 0 | 0 | 80 | min(270,350)=270 locked |
| 6 | settle M1 touch | losing stake = 100 (no-touch); QT=0 → losers credit T | 180 | 0 | 270 | 0 | 0 | 180 | shortfall = 0 (full pay possible) |
| 7 | redeem M1.t1 (winner) | pays $180 from SL | 180 | 0 | 90 | 0 | 0 | 180 | SL drains by 180 |
| 8 | redeem M1.t2 (winner) | pays $90 from SL | 180 | 0 | 0 | 0 | 0 | 180 | SL clean |
| 9 | open M2 no-touch | stake $200, payout $360 | 380 | 0 | 0 | 0 | 0 | 380 | M2.no_touch_exp = 360 |
| 10 | lock M2 (no-touch wins) | winning_exp=360, treasury=380 | 20 | 0 | 360 | 0 | 0 | 20 | full lock |
| 11 | settle M2 no-touch | losing stake = 100 (touch); QT=0 → T += 100 | 120 | 0 | 360 | 0 | 0 | 120 | full pay possible |
| 12 | redeem M2 winner | pays $360 from SL | 120 | 0 | 0 | 0 | 0 | 120 | profit accrued |

End state after a clean run: equity = $120, no queue, no queued debt. That's
the LP yield.

Now demonstrate **temporary negative equity** using a deeper scenario. Reset
state, replay with one big bad trade:

| # | Action | T | SB | SL | QF | QT | EQ |
|---|---|---|---|---|---|---|---|
| 0 | (start) | 0 | 0 | 0 | 0 | 0 | 0 |
| A | open M3 touch $50 (payout $90) | 50 | 0 | 0 | 0 | 0 | 50 |
| B | open M3 no-touch $300 (payout $540) | 350 | 0 | 0 | 0 | 0 | 350 |
| C | lock M3 (no-touch wins) winning_exp=540 | 0 | 0 | 350 | 0 | 0 | 0 | only 350 lockable |
| D | settle M3 no-touch | losing stake=50 (touch); QT was 0 at lock-time but shortfall=190 will enqueue → after enqueue QT>0, so... | 50 | 0 | 350 | 0 | 190 | -140 |

Wait — we need to compute carefully. Per § 2.3, the queue-emptiness test
that decides where losing stake goes happens at the *start* of settle.
At that moment QT == 0, so losing stake credits treasury. Then the shortfall
is enqueued, so AFTER settle QT > 0. Subsequent losing stakes from *new*
markets settled while QT > 0 will go to side_bucket. Continuing:

| # | Action | T | SB | SL | QF | QT | EQ | Notes |
|---|---|---|---|---|---|---|---|---|
| D | settle M3 (above) | 50 | 0 | 350 | 0 | 190 | -140 | enqueued $190; equity NEGATIVE |
| E | redeem M3 winner (1 position, owed $540) | 50 | 0 | 0 | 0 | 190 | -140 | pays $350 from SL; queue entry remains owed $190 |
| F | open M4 touch $200 (payout $360) | 250 | 0 | 0 | 0 | 190 | 60 | M4.touch_exp = 360 |
| G | open M4 no-touch $200 (payout $360) | 450 | 0 | 0 | 0 | 190 | 260 | M4.no_touch_exp = 360 |
| H | lock M4 (touch wins, 360 owed) | 90 | 0 | 360 | 0 | 190 | -100 | 360 locked from T |
| I | settle M4 touch (loser stake 200; QT>0 so SB) | 90 | 200 | 360 | 0 | 190 | 100 | losing stake parks in SB |
| J | harvest(1) | 90 | 10 | 360 | 190 | 0 | 100 | SB drains $190 into queue; queue entry now fully funded |
| K | claim_queued_payout (M3 winner) | 90 | 10 | 360 | 0 | 0 | 100 | $190 paid to owner; entry deleted |
| L | redeem M4 winner | 90 | 10 | 0 | 0 | 0 | 100 | $360 paid from SL; clean |

Equity went negative ($-140) at step D and recovered to $+100 by step L.
The owed M3 winner waited several blocks but got paid in full ($350 + $190).
LP/staker share of the $100 surplus accrues to `staker_fees` on future trades
(or to a periodic sweep).

---

## 5. Edge cases (exhaustive)

1. **Vault exactly zero on open.** `treasury == 0` is fine; `open_*` only adds
   to treasury, never subtracts. No assert needed beyond `pause_open`.

2. **Vault exactly zero on lock_settlement.** `to_lock = min(winning_exp, 0) = 0`.
   `settlement_lock += 0`. The whole winning obligation will be enqueued by
   `settle_market_*`. Winners receive `Coin::zero()` from `redeem_position`'s
   Case A and queue entries from Case B.

3. **Winning exposure exactly equals `treasury`.** All winners paid in full
   from lock; no enqueue; happy path. Check the `==` boundary in tests.

4. **Two simultaneous opens against the same side.** Sui sequences
   transactions on the shared `MartingalerVault` object, so concurrency is a
   non-issue at the type level — Sui consensus serializes. But two opens
   *against the same Market* in the same block both legitimately add to that
   side's exposure; tests should cover this.

5. **Settlement when one side has zero opens.** `losing_stake = 0`. No
   crediting/parking happens. `winning_exposure` may still be > 0 if the
   other side has opens; standard path applies.

6. **Settlement when *both* sides have zero opens.** No-op market: lock
   reserves $0, settle releases $0, no queue entries. Status still moves
   OPEN → LOCKED → SETTLED_*. Tests must cover.

7. **Path observation has zero ticks recorded.** The path module's
   `touch_outcome` policy decides this — typical policy is "no observation =
   no-touch outcome" since touch must be *observed*. Vault is agnostic;
   whatever the path returns, settle handles. Document the policy in path
   module, not here.

8. **Queue exactly drains to zero in `harvest`.** Final iteration sets
   `entry.funded == entry.amount`, increments `queue_head`, and now
   `queue_head == queue_tail`. `queue_total == 0`. Subsequent harvest call
   returns early via `if (queue_total == 0) abort EQueueEmpty;` (or no-op,
   designer's choice). Future `settle_market_*` calls revert to "losing stake
   credits treasury" branch.

9. **Winner abandons position (never calls redeem or claim).** Funds remain
   parked in `settlement_lock` (Case A) or `queue_funds` (Case B) forever.
   This is fine for solvency (those funds are still earmarked) but represents
   permanent gas-locked liquidity. Post-MVP: add a `recover_stale(market)`
   timeout — say, 365 days post-settlement — that returns unredeemed
   `settlement_lock` to `treasury`. Out of MVP scope.

10. **Position object lost / sent to 0x0.** Same as abandoned; funds parked
    forever. Same recovery story.

11. **`harvest` called with `side_bucket == 0`.** Revert with `ENothingToHarvest`.

12. **`harvest` called with `queue_total == 0` but `side_bucket > 0`.** This
    would mean side_bucket has stale funds. Per the model, this state is
    unreachable: `settle_market_*` only routes losing stake to `side_bucket`
    *if `queue_total > 0`* at that moment. If we ever reach this state, it's
    an invariant violation; assert and abort.

13. **Pause during active settlement.** `pause_open` only blocks new opens.
    Lock, settle, harvest, redeem, claim all remain callable so the system
    can wind down cleanly. Critical: never gate settlement behind a pause —
    that creates honest-pause-as-DOS-on-winners.

14. **Multiple winning positions on one market with partial enqueue.**
    `settle_market_*` must split the shortfall pro-rata across winning
    positions (by `payout_if_win`), creating one `QueueEntry` per position
    sized by its share. This must be deterministic and tested.

15. **Losing-side stake larger than winning-side payout.** `losing_stake >
    winning_exposure`. Surplus credits treasury (or side_bucket if QT>0).
    This is the common case — house edge incarnate.

16. **Re-entry / re-call of `lock_settlement` or `settle_market_*`.** Guarded
    by `market.status` check (INV-6). Second call reverts.

17. **`open_*` called between `lock_settlement` and `settle_market_*`.**
    Blocked by `assert!(market.status == OPEN)` in `open_*`. Tests cover.

18. **Queue index overflow.** `queue_head, queue_tail: u64`. At one
    enqueue/sec, overflow takes ~584B years. Non-issue.

19. **Single market with extreme imbalance (99% touch, 1% no-touch).**
    Handled by single shared treasury — the protocol pools risk across
    markets. Local imbalance is the whole reason Martingaler exists.

20. **Fee bps misconfigured to 10_000 (100% fee).** `net_stake = 0`,
    `treasury` doesn't grow, but `payout` is computed from gross `stake`.
    This bricks the protocol. Add `assert!(protocol_fee_bps + staker_fee_bps
    <= MAX_FEE_BPS)` (e.g. 1_000 = 10%) at setter.

---

## 6. Move pseudocode for the queue

### Decision: use Sui `Table<u64, QueueEntry>` keyed by monotonic index, NOT a `vector<QueueEntry>`, NOT a `LinkedTable`.

**Rejected: `vector<QueueEntry>`.**
- Naive vector with O(1) head pop requires either:
  - shifting all elements (O(n) gas, unbounded)
  - a head-index pointer (we'd reinvent `Table`, but lose gas refunds since the vector never frees its tail)
- Worst case grows unboundedly across the protocol's lifetime. Fatal on Sui's gas model where each tx has a budget cap.

**Rejected: ring buffer (fixed-size `vector` with wrap-around).**
- Requires a static cap on outstanding queue entries. Cap-too-low blocks
  settlement; cap-too-high wastes storage rent forever.
- Doesn't compose with Sui's storage rebate model — slots are never freed.

**Rejected: `LinkedTable<u64, QueueEntry>` (sui::linked_table).**
- Tempting because it preserves insertion order natively. But:
  - extra storage per node (prev/next pointers) → 2x storage cost per entry
  - traversal in `harvest` requires walking the linked list, which is fine
    for ordered access but *requires* you to start from the head — so iteration
    cost is bounded but storage cost is the killer.

**Chosen: `Table<u64, QueueEntry>` plus explicit `queue_head` / `queue_tail`
counters on the vault.**
- Insert: `table::add(queue, queue_tail, entry); queue_tail += 1;` — O(1).
- Read head: `table::borrow_mut(queue, queue_head)` — O(1).
- Pop head: `table::remove(queue, queue_head); queue_head += 1;` — O(1) plus
  full storage rebate on the removed slot.
- FIFO ordering preserved by monotonic indices; never reuse them.
- Bonus: `Table` is part of `sui::table`, well-audited, gas-efficient.

```move
use sui::table::{Self, Table};

public struct MartingalerVault<phantom C> has key {
    id: UID,
    treasury: Balance<C>,
    side_bucket: Balance<C>,
    queue_funds: Balance<C>,
    settlement_lock: Balance<C>,
    queue: Table<u64, QueueEntry>,   // <-- the queue
    queue_head: u64,
    queue_tail: u64,
    queue_total: u64,
    // ... fees, telemetry, config as in § 1
}

fun enqueue<C>(v: &mut MartingalerVault<C>, e: QueueEntry) {
    let idx = v.queue_tail;
    table::add(&mut v.queue, idx, e);
    v.queue_tail = idx + 1;
    v.queue_total = v.queue_total + (e.amount - e.funded);
    v.enqueue_count = v.enqueue_count + 1;
}

fun harvest_one<C>(v: &mut MartingalerVault<C>): bool {
    if (v.queue_head >= v.queue_tail) return false;
    if (balance::value(&v.side_bucket) == 0) return false;
    let head_idx = v.queue_head;
    let entry = table::borrow_mut(&mut v.queue, head_idx);
    let need = entry.amount - entry.funded;
    let avail = balance::value(&v.side_bucket);
    let pay = if (need < avail) need else avail;
    let drain = balance::split(&mut v.side_bucket, pay);
    balance::join(&mut v.queue_funds, drain);
    entry.funded = entry.funded + pay;
    v.queue_total = v.queue_total - pay;
    if (entry.funded == entry.amount) {
        v.queue_head = head_idx + 1;
        v.drain_count = v.drain_count + 1;
        // entry stays in the table until claim_queued_payout deletes it
    };
    true
}

public fun harvest<C>(v: &mut MartingalerVault<C>, max_n: u64) {
    let cap = if (max_n < v.max_harvest_per_call) max_n else v.max_harvest_per_call;
    let mut i = 0;
    while (i < cap) {
        if (!harvest_one(v)) break;
        i = i + 1;
    };
}
```

`claim_queued_payout` calls `table::remove` on the entry index when fully
paid, returning storage rebate to the caller — making claims slightly net-
positive in gas, a nice incentive alignment.

---

## 7. Risks and gotchas

### 7.1 Rationale for routing `open_*` net stake to `treasury`, not `side_bucket`

Papertrade routes losing closes to `side_bucket` while queue is non-empty.
Wick's binary semantics mean *we don't know on open whether a stake will be a
loser* — the path observation hasn't happened yet. We route open stakes to
`treasury` on the assumption that ~50% will become losers (binary, near-fair
markets). This is statistically equivalent to Papertrade's flow over many
trades, with one edge case:

**Risk:** if `treasury` is paying winners on settle while `side_bucket` is
parked for queue heads, a stream of new opens can transiently inflate
`treasury` and let it pay winners ahead of older queue entries. This *is the
intended behavior* (treasury is FIFO-agnostic; it pays the next settling
market in full if it can). Queue entries only exist for shortfalls. If
shortfalls happen, harvest catches up. We accept this.

### 7.2 Malicious-trader exploit surface

1. **MEV / sandwich on `harvest`.** A trader could observe a pending
   `harvest` that will fund their queue entry, front-run with a no-op, and…
   no benefit. Harvest is permissionless and non-payable to the caller (no
   fee rebate beyond gas). No exploit.

2. **Front-run `lock_settlement` to inflate exposure.** The order is:
   expiry passes → `lock_settlement` callable → `open_*` blocked
   (`now >= expiry`). So you cannot open after expiry. Pre-expiry, opening
   *adds* to your own potential winning side — that's just trading. No
   exploit beyond standard market behavior.

3. **Spam tiny opens to inflate `cumulative_*` telemetry.** Telemetry doesn't
   gate any logic. Cosmetic only. Mitigation: minimum stake threshold, e.g.
   `assert!(stake >= MIN_STAKE)`.

4. **Spam tiny queue entries to bloat the table.** Possible if many winning
   positions exist. Mitigation: at settle time, bucket all winning positions
   below a `MIN_QUEUE_ENTRY` threshold into a single shared entry payable
   pro-rata (post-MVP optimization).

5. **`claim_queued_payout` from wrong owner.** Blocked by
   `assert!(entry.owner == ctx.sender())`. Coin is returned to caller, but
   the assert is the gate.

6. **Re-entrancy.** Move + Sui's resource model prevents classical re-entry.
   The only "callback" surface is `Coin<C>` returned to the user, which can't
   re-enter the vault as a coin. Safe.

7. **Oracle manipulation.** Out of scope for vault layer; lives in
   `wick::wick_oracle` and `wick::path_observation`. Vault trusts the path's
   `touched()` answer.

8. **Drain-the-treasury via `redeem` race.** If two winners simultaneously
   try to redeem and `settlement_lock` only covers one, both `Balance::split`
   calls would fail on the second. Sui sequences shared-object access, so
   one wins, one fails. The losing-tx winner gets their queue entry credited
   instead. Tests should cover.

9. **Donation attack on `treasury`.** Anyone can `Balance::join` into
   `treasury` if a public `donate` exists. Don't expose one. If we want a
   "tip the protocol" function, route it to `protocol_fees` not `treasury`,
   so it doesn't distort accounting telemetry.

10. **Negative-equity panic.** Off-chain dashboards must surface
    `equity = treasury + side_bucket - queue_total` and *not* alarm on
    negative values, since negative is by design. Alarm on `queue_age >
    SLA` instead.

### 7.3 Operational gotchas

- **Fee parameters are protocol-critical.** Changing `protocol_fee_bps` /
  `staker_fee_bps` mid-flight changes solvency math. Gate behind multisig
  with timelock; never permissionless setters.
- **`max_harvest_per_call`** must be set so that one harvest call always fits
  in a Sui tx gas budget. Conservative default: 32 entries.
- **Queue table never deletes its own slots between full-fund and claim** —
  `harvest` advances `queue_head` but leaves the entry in the `Table` until
  the owner claims. This means storage rent on funded-but-unclaimed entries
  is paid by the protocol. Accept for MVP; sweep with `recover_stale` later.
- **Cross-collateral.** This spec assumes single collateral type per vault
  (e.g. one vault for USDC, one for SUI). Per AGENTS.md "multi-collateral
  SUI+USDC" is locked, so the design naturally supports two parallel vaults
  of `MartingalerVault<USDC>` and `MartingalerVault<SUI>`. Markets pick one.

---

## Appendix A — relationship to existing `vault.move`

Current `move/sources/vault.move` is a thin per-market `Balance<C>` wrapper.
Migrating to Martingaler means:

1. Delete `vault.move` or repurpose as a fee-only utility.
2. New `martingaler_vault.move` module owning the shared `MartingalerVault<C>`.
3. `market.move`'s `Market<C>` drops its `vault: Vault<C>` field, gains
   `vault_id: ID`, `status`, `locked_obligation`, `outcome_side` fields.
4. `market.move` `open` and `redeem` route through `martingaler_vault` calls.
5. New `lock_settlement` and `settle_market_*` entrypoints replace the
   current `redeem` flow's implicit settlement.
6. Conservation tests in `move/tests/foundation_tests.move` and
   `move/tests/market_tests.move` extended to cover INV-1 through INV-12.

This is a meaningful refactor — explicitly out of MVP scope (per AGENTS.md
"do not write code for any of these unless we're past MVP"). This document
exists so we can implement quickly when the time comes.
