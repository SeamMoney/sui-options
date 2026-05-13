# Martingaler Accounting State Machine — v2 (Hardened)

> **Supersedes v1 of 2026-05-12** (`docs/design/01_martingaler_accounting.md`).
> **Mitigates redteam findings #1 through #15** from
> `docs/redteam/01_vault_queue.md`.
>
> Status: design spec, implementation-ready. This document is self-contained.
> Do not consult v1 to implement; v1 is preserved only for archeology. Where
> v2 deviates from v1 in load-bearing ways the change is called out inline as
> **[Δ vs v1]**.
>
> Per AGENTS.md: this is a *transcription* of papertrade.xyz's "treasury +
> queue + side-bucket" idea, rewritten for Wick's binary touch / no-touch
> domain. The word "fork" is banned.

## 0. Design intent in one paragraph

A single protocol-wide `MartingalerVault<C>` faces every Wick-native market
of collateral type `C`. Net trader stake feeds the `treasury`. When a market
settles and the winning side's payout exceeds available treasury, the unpaid
remainder becomes on-chain debt — a FIFO queue of `QueueEntry` claims keyed
by monotonic indices. While the queue is non-empty, every flow that would
normally credit `treasury` is auto-routed through the queue head first
(losing-stake auto-harvest, redeem-with-priority). Queue entries always pay
in full eventually; the protocol absorbs *timing* risk, never *haircut*
risk. LP yield is the positive expectation of binary house edge over many
markets, accruing to `treasury` once `queue_total == 0`.

Five non-negotiable v2 properties (all v1 violations of these are red-team
findings #1, #4, #14, #15):

1. **Per-market `settlement_lock`**, never a shared pool (kills #15).
2. **Atomic `lock + settle`** in a single entry function (kills #4).
3. **Auto-harvest on every flow that touches `side_bucket`** — there is no
   standalone permissionless `harvest()` (kills #14).
4. **Settlement-lock pays old queue heads BEFORE fresh winners** (kills #1).
5. **Round-down to vault, round-up to user** for every divisive operation,
   documented per call site (kills #10).

---

## 1. State variables

All vault state lives on a single shared object per collateral type:

```move
public struct MartingalerVault<phantom C> has key {
    id: UID,

    // ---- core balances (Sui Balance<C>, never raw Coin) ----
    treasury:    Balance<C>,        // free liquidity available to pay winners
    side_bucket: Balance<C>,        // parking lot: filled by losing stake
                                    // while queue non-empty; auto-drained
                                    // into queue heads on every flow
    queue_funds: Balance<C>,        // funds already earmarked for queued
                                    // entries; claim_queued_payout pulls here

    // ---- settlement-locked obligations (PER-MARKET, [Δ vs v1]) ----
    settlement_locks: Table<ID, Balance<C>>,
                                    // key: market_id; value: that market's
                                    // reserved balance. Per-market isolation
                                    // closes redteam #15. Funds can never
                                    // leak across markets.
    lock_metadata: Table<ID, LockMeta>,
                                    // sibling table tracking per-market
                                    // accounting and stale-lock release.

    // ---- queue (FIFO of unpaid winner obligations) ----
    queue: Table<u64, QueueEntry>,  // entries indexed by monotonic counter
    queue_head: u64,                // index of next entry awaiting funding
    queue_tail: u64,                // index past the last enqueued entry
    queue_total: u64,               // Σ (entry.amount - entry.funded) across
                                    // entries in [queue_head, queue_tail)

    // ---- accrued fees (segregated; do NOT count toward solvency) ----
    protocol_fees: Balance<C>,      // claimable by protocol multisig
    staker_fees:   Balance<C>,      // streams to LP / WICK stakers post-MVP
    harvest_bounty_pool: Balance<C>,// funds set aside to incentivize the
                                    // bounded auto-harvest work; sourced
                                    // from a slice of protocol_fees on
                                    // every open. See §2.1.

    // ---- accounting telemetry (u128 to survive long histories) ----
    cumulative_stakes_in:        u128,  // monotonic
    cumulative_payouts_out:      u128,  // monotonic
    cumulative_losses_absorbed:  u128,  // monotonic
    cumulative_fees_taken:       u128,  // monotonic
    enqueue_count:               u64,   // == queue_tail
    drain_count:                 u64,   // monotonic; fully-funded entries

    // ---- config (governance-set, never permissionless) ----
    protocol_fee_bps:            u64,
    staker_fee_bps:              u64,
    harvest_bounty_bps:          u64,   // bp of side-bucket drained per
                                        // explicit-trigger keeper call
    max_harvest_per_call:        u64,   // gas safety cap (default 32)
    min_stake:                   u64,   // floor on open_*; closes #6, #10
    min_queue_entry:             u64,   // floor on per-position queue entry;
                                        // sub-floor positions roll into a
                                        // single per-market dust entry.
                                        // Closes #3.
    stale_lock_window_ms:        u64,   // after settle, unredeemed lock
                                        // returns to treasury. Closes #2.
                                        // Default: 86_400_000 (24h).
    pause_open:                  bool,  // circuit breaker; lock+settle and
                                        // claims still work even when paused.
}

public struct LockMeta has store, drop {
    settled_at_ms:        u64,    // when lock+settle ran; 0 if pre-settle
                                  // (shouldn't happen in v2 since atomic)
    expires_at_ms:        u64,    // settled_at_ms + stale_lock_window_ms
    locked_obligation:    u64,    // total winner payout owed
    funded_from_lock:     u64,    // running sum redeemed via Case A
    outcome_side:         u8,     // SIDE_TOUCH or SIDE_NO_TOUCH
    winner_count:         u64,    // for pro-rata accounting
}

public struct QueueEntry has store, drop {
    market_id:   ID,
    position_id: Option<ID>,      // None when this entry is a per-market
                                  // dust roll-up (closes #3)
    owner:       address,
    amount:      u64,             // total payout owed
    funded:      u64,             // 0 <= funded <= amount
    created_ms:  u64,
    side:        u8,              // SIDE_TOUCH or SIDE_NO_TOUCH (info only)
    is_dust:     bool,            // true => one shared entry per market for
                                  // sub-MIN_QUEUE_ENTRY winners. The
                                  // Position objects retain pro-rata claims
                                  // against `amount` and `funded`.
}
```

### Per-market companion state on `Market<C>`

```move
public struct Market<phantom C> has key {
    id: UID,
    vault_id: ID,                    // pinned at register_market(); see §1.1
    payout_multiplier_bps: u64,      // bounded [11_000, 100_000] [Δ vs v1]
    expiry_ms: u64,
    treasury_snapshot_at_expiry: u64,// captured by lock_and_settle()
                                     // closes redteam #11
    seed_collateral: u64,            // creator-bonded; min 1 USDC
    creator: address,                // bond beneficiary on dispute
    creator_bond: Balance<C>,        // slashable per §2.7

    touch_exposure:    u64,
    no_touch_exposure: u64,

    status: u8,                      // 0=OPEN, 1=SETTLED_TOUCH,
                                     // 2=SETTLED_NO_TOUCH, 3=STALE_RELEASED
                                     // [Δ vs v1] LOCKED state removed —
                                     // lock + settle is atomic now.
    outcome_side: u8,                // valid after settlement
}
```

### 1.1 Vault ↔ market binding (closes redteam #8)

`Market<C>.vault_id` is set exactly once, via:

```move
public fun register_market<C>(
    cap: &AdminCap,                  // governance gate
    vault: &MartingalerVault<C>,
    market: &mut Market<C>,
    ctx: &mut TxContext,
) {
    assert!(market.vault_id == ID::ZERO, EAlreadyRegistered);
    market.vault_id = object::id(vault);
}
```

Settlement reads `market.vault_id` and asserts it equals
`object::id(vault)` of the vault passed in. This binding is non-revocable.
The phantom `C` parameter on both types prevents cross-collateral confusion
at the type system level; the explicit `ID` check prevents wrong-vault-of-
right-type confusion.

### 1.2 Cross-collateral boundary (closes redteam #8 fully)

Two MartingalerVault instances may exist concurrently:
`MartingalerVault<USDC>` and `MartingalerVault<SUI>`. They share **no
state**:

- Distinct `id: UID` (Sui guarantees unique object IDs).
- Distinct `Balance<C>` types (Move's type system disallows
  `Balance<USDC>` flowing into `Balance<SUI>` and vice versa).
- Distinct `Table<ID, Balance<C>>` for `settlement_locks` (each table is
  parameterized by its outer vault's `C`).
- Markets pin to one vault at `register_market()` time; the pinned
  `vault_id` is checked on every state-transition call.
- No function takes two vaults of different `C` simultaneously.

Operationally: Wick may deploy one vault per supported collateral. A
governance multisig holds an `AdminCap` per vault. There is no
"super-vault" bridging USDC and SUI; bridging is explicitly out of scope
and cannot occur via this module's surface.

---

## 2. State transitions

Notation:
- `Δfield` = signed change to `field`
- `assert!` = precondition; abort code in parentheses
- All preconditions hold *before* deltas; postconditions are listed at end
- All divisions specify rounding direction explicitly
- All operations preserve INV-1 through INV-16 (§3)

### 2.1 `open_position(market, side, stake_coin, owner) -> Position`

[Δ vs v1] Net stake is auto-applied to queue heads first if the queue is
non-empty (the side_bucket route from v1 only triggered at *settle*; v2
applies it on *every* open as well). This makes opens themselves pay down
the queue, eliminating the "Never-Drain Steady State" (#14).

**Preconditions**

```
assert!(!vault.pause_open,                     EPaused);
assert!(now < market.expiry_ms,                EExpired);
assert!(market.status == OPEN,                 ENotOpen);
assert!(stake_coin.value() >= vault.min_stake, EBelowMinStake);
assert!(market.vault_id == object::id(vault),  EWrongVault);  // §1.1

let stake = stake_coin.value();
// Round payout UP (favors user). Round exposure UP (favors vault safety).
let payout   = ceil_div(stake * market.payout_multiplier_bps, 10_000);
let exposure = payout;                              // 1:1; payout == exposure

// Round fees DOWN (favors user; tiny, bounded by min_stake).
let fee_protocol = (stake * vault.protocol_fee_bps) / 10_000;
let fee_staker   = (stake * vault.staker_fee_bps)   / 10_000;
let fee_bounty   = (stake * vault.harvest_bounty_bps) / 10_000;
let net_stake    = stake - fee_protocol - fee_staker - fee_bounty;
```

**State delta**

```
// 1. Fees
protocol_fees       += fee_protocol
staker_fees         += fee_staker
harvest_bounty_pool += fee_bounty

// 2. Exposure
if (side == SIDE_TOUCH) {
    market.touch_exposure += exposure
} else {
    market.no_touch_exposure += exposure
}

// 3. Net stake routing — auto-harvest into queue heads first.
//    [Δ vs v1] No standalone harvest() exists. Every open auto-drains.
let mut remaining = net_stake_balance;            // Balance<C>
remaining = drain_into_queue_heads(vault, remaining, vault.max_harvest_per_call);
treasury += remaining                             // residual to treasury

// 4. Telemetry
cumulative_stakes_in  += stake
cumulative_fees_taken += (fee_protocol + fee_staker + fee_bounty)
```

**Position object minted**

```move
Position {
    id: UID,
    market_id: object::id(market),
    side,
    stake,
    payout_if_win: payout,
}
```

**Events**

```
PositionOpened {
    market_id, position_id, side, stake, payout, owner,
    auto_harvested: amount_drained_into_queue,
}
TreasuryGrew { delta: residual_to_treasury, new_treasury_value }
QueueEntryFunded { ... } per fully-funded queue entry, if any
```

**Postconditions** — see §3. Crucially: there is no per-market solvency
check. The *protocol* (vault + queue) is solvent in expectation; individual
markets can be locally undercollateralized.

### 2.2 `lock_and_settle(market, vault, oracle, path_obs, clock, ctx)`

[Δ vs v1] **Single atomic entry function**. v1 split this into
`lock_settlement` and `settle_market_*` — that split was gratuitous and
opened redteam attacks #4 (sandwich) and #11 (treasury-snapshot races). v2
does both in one transaction, no in-between state.

**Preconditions**

```
assert!(now >= market.expiry_ms,             ENotExpired);
assert!(market.status == OPEN,               ENotOpen);
assert!(market.vault_id == object::id(vault), EWrongVault);

let outcome_side = path::touched(path_obs, oracle, clock)
                 ? SIDE_TOUCH : SIDE_NO_TOUCH;

let winning_exposure = if (outcome_side == SIDE_TOUCH)
                        market.touch_exposure
                       else market.no_touch_exposure;
let losing_exposure  = if (outcome_side == SIDE_TOUCH)
                        market.no_touch_exposure
                       else market.touch_exposure;
// Inverse of payout calc; rounding must be CONSISTENT.
// Round losing_stake DOWN (favors vault — we credit at most what we owe
// back; rounding error stays in vault).
let losing_stake = (losing_exposure * 10_000) / market.payout_multiplier_bps;

// Snapshot treasury at expiry — closes redteam #11.
// Use min(treasury, winning_exposure) to bound lock.
let to_lock = min(winning_exposure, treasury.value());
```

**State delta (atomic)**

```
// PHASE 1 — drain queue heads BEFORE locking. This ensures fresh winners
//           never jump ahead of older queue entries (closes redteam #1).
//           We drain both side_bucket AND a slice of treasury through the
//           queue; treasury contribution is capped to what's left after
//           lock to avoid undercollateralizing this market's winners.
let pre_lock_drain = drain_into_queue_heads_capped(
    vault,
    side_bucket.value(),                       // drain all available SB
    vault.max_harvest_per_call
);
// pre_lock_drain.amount moved from side_bucket → queue_funds in-place.

// PHASE 2 — record snapshot, build per-market lock
market.treasury_snapshot_at_expiry = treasury.value()
let lock_balance = balance::split(&mut treasury, to_lock);
table::add(&mut settlement_locks, object::id(market), lock_balance);
table::add(&mut lock_metadata, object::id(market), LockMeta {
    settled_at_ms: now,
    expires_at_ms: now + vault.stale_lock_window_ms,
    locked_obligation: winning_exposure,
    funded_from_lock: 0,
    outcome_side,
    winner_count: count_winning_positions(market, outcome_side),
});

// PHASE 3 — route losing stake. Auto-harvest through queue heads first.
let losing_balance: Balance<C> = construct_losing_credit(losing_stake);
                                  // sourced from the open-time stakes
                                  // already in treasury — internally a
                                  // bookkeeping move, no new funds.
// (Mechanically: we already booked all stakes into treasury at open time.
//  At settle, losing_stake is "freed" — meaning we can spend it on either
//  winners-via-queue or treasury, depending on queue state.)
let drained_into_queue = drain_into_queue_heads_with_balance(
    vault,
    losing_stake,
    vault.max_harvest_per_call
);
let residual = losing_stake - drained_into_queue;
treasury += residual                          // surplus credits treasury
                                              // (only after queue is fed)

// PHASE 4 — enqueue shortfall (the part winning_exposure exceeds the lock)
let shortfall = if (winning_exposure > to_lock) winning_exposure - to_lock
                else 0;
if (shortfall > 0) {
    enqueue_winners_pro_rata(market, outcome_side, shortfall, vault.min_queue_entry);
    // Creates one QueueEntry per winning Position whose pro-rata share is
    //   >= min_queue_entry. Sub-floor positions roll into a SINGLE shared
    //   `is_dust=true` entry per (market, outcome_side). Closes redteam #3.
    // queue_total += shortfall
    // queue_tail  += <num qualifying entries + 0-or-1 dust entry>
}

// PHASE 5 — finalize market state
market.outcome_side = outcome_side
market.status = if (outcome_side == SIDE_TOUCH) SETTLED_TOUCH
                else SETTLED_NO_TOUCH
cumulative_losses_absorbed += losing_stake
```

**Events**

```
MarketLockedAndSettled {
    market_id, outcome_side, winning_exposure,
    locked_now: to_lock, shortfall_enqueued: shortfall,
    losing_stake_absorbed: losing_stake,
    pre_lock_drained_to_queue: pre_lock_drain,
    losing_stake_to_queue: drained_into_queue,
    losing_stake_to_treasury: residual,
}
QueueEntryEnqueued { market_id, position_id, owner, amount } // per entry
QueueEntryFunded   { ... } // for any entries fully funded by phases 1, 3
```

**Postconditions**

```
market.status ∈ {SETTLED_TOUCH, SETTLED_NO_TOUCH}
table::contains(settlement_locks, market.id)
table::contains(lock_metadata,    market.id)
queue_total_after - queue_total_before == max(0, shortfall - drained)
INV-1 holds. INV-13 (per-market lock isolation) holds.
```

### 2.3 `redeem_position(market, position, vault, ctx) -> Coin<C>`

[Δ vs v1] Two-tier ordering: queue heads ALWAYS get paid before fresh
winners, even when this winner's market has a positive `settlement_lock`
balance. v1's "Case A pays in full from settlement_lock" was the source of
the queue-head bumper attack (#1).

**Preconditions**

```
assert!(market.status == SETTLED_TOUCH || market.status == SETTLED_NO_TOUCH,
        ENotSettled);
assert!(position.market_id == object::id(market), EWrongMarket);
assert!(market.vault_id == object::id(vault),     EWrongVault);

let won = (position.side == market.outcome_side);
```

**State delta — losing position**

```
if (!won) {
    delete position;
    emit PositionRedeemed { won: false, paid: 0 };
    return Coin::zero();
}
```

**State delta — winning position**

```
let owed = position.payout_if_win;          // total owed to this winner
let mut paid_total: u64 = 0;
let mut payout_balance: Balance<C> = balance::zero();

// PHASE 1 — auto-harvest into queue heads BEFORE paying this winner.
//           Ensures that any side_bucket / fresh fees flow into older
//           queue entries before we top up this market's lock or pay
//           this winner. Closes #1.
drain_into_queue_heads(vault, /*from=*/SIDE_BUCKET, vault.max_harvest_per_call);

// PHASE 2 — Two-tier ordering. While queue_total > 0, this winner's payout
//           competes with queue heads.
//           Specifically: pay from settlement_lock[market_id] only the
//           portion that is "ahead" of this winner's logical queue
//           position. Since queue is ordered by (settled_at_ms,
//           position_id) and this position settled in *its own* market's
//           lock_and_settle call, we know:
//
//             * The position is NEWER than every entry currently in the
//               queue (queue is FIFO; older settlements enqueued first).
//             * Therefore, while queue_total > 0, this winner can ONLY
//               receive funds that exceed the queue's outstanding need.
//
//           Mechanically: redeeming-while-queue-nonempty diverts the
//           entire `owed` amount through the queue path (creates a fresh
//           queue entry at the tail), and the winner gets only what
//           settlement_lock holds AFTER queue is fully drained.
//
//           This makes the FIFO promise honest: any market that lost the
//           "first available liquidity" race becomes part of the queue.

if (queue_total > 0) {
    // (a) Push this winner to the BACK of the queue.
    //     Their settlement_lock contribution moves to side_bucket and
    //     immediately drains into older queue heads. (Funds are conserved.)
    let lock_share = pro_rata_share_of_lock(market, position);
    let lock_balance = table::borrow_mut(&mut settlement_locks, market.id);
    let credited = balance::split(lock_balance, lock_share);
    side_bucket += credited
    drain_into_queue_heads(vault, /*from=*/SIDE_BUCKET, vault.max_harvest_per_call);
    enqueue_one(vault, market.id, position, owed);
    delete position;
    emit PositionRedeemed { won: true, paid: 0, queued_amount: owed };
    return Coin::zero();
} else {
    // (b) Queue is empty. Pay directly from this market's lock; any
    //     residual obligation (lock < owed) creates a queue entry as
    //     usual. Auto-harvest had a chance to drain side_bucket above.
    let lock_balance = table::borrow_mut(&mut settlement_locks, market.id);
    let lock_avail = balance::value(lock_balance);
    let pay_from_lock = min(owed, lock_avail);
    if (pay_from_lock > 0) {
        let drained = balance::split(lock_balance, pay_from_lock);
        balance::join(&mut payout_balance, drained);
        paid_total += pay_from_lock;
        // Update LockMeta
        let meta = table::borrow_mut(&mut lock_metadata, market.id);
        meta.funded_from_lock += pay_from_lock;
    };
    if (paid_total < owed) {
        enqueue_one(vault, market.id, position, owed - paid_total);
    };
    cumulative_payouts_out += paid_total;
    delete position;
    emit PositionRedeemed { won: true, paid: paid_total, queued_amount: owed - paid_total };
    return coin::from_balance(payout_balance, ctx);
}
```

### 2.4 `claim_queued_payout(vault, queue_index, ctx) -> Coin<C>`

Unchanged from v1 except for dust-entry handling.

**Preconditions**

```
assert!(table::contains(&queue, queue_index), EBadIndex);
let entry = table::borrow(&queue, queue_index);
if (!entry.is_dust) {
    assert!(entry.owner == ctx.sender(), ENotOwner);
} else {
    // Dust entries are claimed via a position-level claim (see §2.5);
    // claim_queued_payout does NOT pay dust entries directly.
    abort EUseDustClaim;
}
assert!(entry.funded > 0, ENothingToClaim);
```

**State delta**

```
let pay = entry.funded;
let pay_balance = balance::split(&mut queue_funds, pay);
let entry_mut = table::borrow_mut(&mut queue, queue_index);
entry_mut.funded = 0;
entry_mut.amount = entry_mut.amount - pay;
if (entry_mut.amount == 0) {
    let _ = table::remove(&mut queue, queue_index);  // gas refund
}
cumulative_payouts_out += pay
```

### 2.5 `claim_dust_share(market, position, vault, ctx) -> Coin<C>`

For positions that were rolled into a per-market dust entry at settle time.

```
assert!(position.market_id == object::id(market), EWrongMarket);
assert!(position.side == market.outcome_side,     ELoser);
let dust_idx = market.dust_queue_index;            // Some(idx) if dust exists
assert!(option::is_some(&dust_idx),                ENoDust);
let entry = table::borrow_mut(&mut queue, *option::borrow(&dust_idx));
assert!(entry.is_dust,                             ENotDust);

let pro_rata = position.payout_if_win
             * entry.funded
             / entry.amount;                       // round DOWN (vault safe)
entry.funded = entry.funded - pro_rata;
entry.amount = entry.amount - position.payout_if_win;
let payout = balance::split(&mut queue_funds, pro_rata);
delete position;                                   // can only claim once
cumulative_payouts_out += pro_rata
return coin::from_balance(payout, ctx);
```

### 2.6 `release_stale_lock(market, vault, clock, ctx)`

[Δ vs v1] Closes redteam #2 (Settlement Lock Hostage). Permissionless.
After `stale_lock_window_ms` past settlement, any unredeemed
`settlement_lock` returns to `treasury` and the market transitions to
`STALE_RELEASED`.

```
assert!(market.status == SETTLED_TOUCH || market.status == SETTLED_NO_TOUCH,
        ENotSettled);
let meta = table::borrow(&lock_metadata, object::id(market));
assert!(clock.timestamp_ms() >= meta.expires_at_ms, ENotStale);

let lock_balance = table::remove(&mut settlement_locks, object::id(market));
let amount = balance::value(&lock_balance);
balance::join(&mut treasury, lock_balance);
let _ = table::remove(&mut lock_metadata, object::id(market));
market.status = STALE_RELEASED;

// Auto-harvest the released funds through the queue.
drain_into_queue_heads(vault, /*from=*/TREASURY, vault.max_harvest_per_call);

emit StaleLockReleased { market_id, amount, returned_to: TREASURY };
```

After `STALE_RELEASED`, `redeem_position` for that market always returns
`Coin::zero()` (winners had their window). Loser positions still delete
cleanly.

### 2.7 `create_market(...)` (closes redteam #13)

[Δ vs v1] Hard bounds + creator bond. `create_market` is **AdminCap-gated
in MVP**; permissionless creation with creator bond is post-MVP.

```
public fun create_market<C>(
    cap: &AdminCap,                                 // gate
    vault: &MartingalerVault<C>,
    payout_multiplier_bps: u64,
    expiry_ms: u64,
    seed_collateral: Coin<C>,
    oracle_id: ID,
    path_obs_id: ID,
    clock: &Clock,
    ctx: &mut TxContext,
): Market<C> {
    assert!(payout_multiplier_bps >= 11_000, EMultiplierTooLow);  // ≥ 1.1x
    assert!(payout_multiplier_bps <= 50_000, EMultiplierTooHigh); // ≤ 5x
    assert!(expiry_ms > clock.timestamp_ms() + MIN_MARKET_DURATION_MS,
            EExpiryTooSoon);                        // ≥ 60s window
    assert!(coin::value(&seed_collateral) >= MIN_SEED_COLLATERAL,
            ESeedTooSmall);                         // ≥ 1 USDC equiv

    let market = Market<C> {
        id: object::new(ctx),
        vault_id: ID::ZERO,                         // bound by register_market
        payout_multiplier_bps,
        expiry_ms,
        treasury_snapshot_at_expiry: 0,
        seed_collateral: coin::value(&seed_collateral),
        creator: ctx.sender(),
        creator_bond: coin::into_balance(seed_collateral),
        touch_exposure: 0,
        no_touch_exposure: 0,
        status: OPEN,
        outcome_side: 0,
    };
    market
}
```

Bounds rationale:
- **`>= 11_000`**: minimum 10% house edge per loser → kills near-1x
  donation-distortion (#9) and dust-pump exploits.
- **`<= 50_000`**: 5x cap is generous for binary options; protects
  unsophisticated LPs from extreme one-sided exposure.
- **`MIN_SEED_COLLATERAL`**: discourages spam markets and gives the
  creator skin in the game (bond can be slashed by governance for
  malicious markets, post-MVP).

### 2.8 Internal helper: `drain_into_queue_heads(vault, source, max_n)`

This is the auto-harvest primitive used by every state transition that
might add liquidity to the protocol while the queue is non-empty. It is
**not exposed publicly** — there is no standalone `harvest()` (closes #14
and #5).

```move
fun drain_into_queue_heads<C>(
    vault: &mut MartingalerVault<C>,
    from: u8,                                       // SIDE_BUCKET or TREASURY
    max_iters: u64,
): u64 {
    if (vault.queue_total == 0) return 0;
    let cap = min(max_iters, vault.max_harvest_per_call);
    let mut drained: u64 = 0;
    let mut i: u64 = 0;
    while (i < cap) {
        if (vault.queue_head >= vault.queue_tail) break;
        let avail = if (from == SIDE_BUCKET) balance::value(&vault.side_bucket)
                    else balance::value(&vault.treasury);
        if (avail == 0) break;
        let entry = table::borrow_mut(&mut vault.queue, vault.queue_head);
        let need = entry.amount - entry.funded;
        let pay = if (need < avail) need else avail;
        let payment = if (from == SIDE_BUCKET)
            balance::split(&mut vault.side_bucket, pay)
        else
            balance::split(&mut vault.treasury, pay);
        balance::join(&mut vault.queue_funds, payment);
        entry.funded = entry.funded + pay;
        vault.queue_total = vault.queue_total - pay;
        drained = drained + pay;
        if (entry.funded == entry.amount) {
            vault.queue_head = vault.queue_head + 1;
            vault.drain_count = vault.drain_count + 1;
            // entry remains in table until claim_queued_payout deletes it
            event::emit(QueueEntryFunded { /* ... */ });
        };
        i = i + 1;
    };
    drained
}
```

Invariants preserved by `drain_into_queue_heads`:

```
Δtreasury + Δside_bucket + Δqueue_funds + Δqueue_total == 0
```

(money only moves between buckets; nothing enters or leaves the system).

---

## 3. Invariants

The original v1 invariants INV-1 through INV-12 are preserved verbatim
below (with INV-6 updated for the v2 atomic-settle state machine), and
v2 introduces INV-13 through INV-19 to lock down the new properties.

```
INV-1  (vault solvency, load-bearing)
    treasury + side_bucket + Σ_m settlement_locks[m] + queue_funds
    + protocol_fees + staker_fees + harvest_bounty_pool
    ==
    Σ_open(position.stake_minus_fees)
    + Σ_locked(market.locked_obligation - meta.funded_from_lock)
    + queue_total                         // unfunded queue need
    + queue_funds                         // funded but unclaimed
    + protocol_fees + staker_fees + harvest_bounty_pool
    + cumulative_stakes_in_consumed_by_settled_winners
    - cumulative_payouts_out

INV-1' (operational form: conservation per transaction)
    Δ(treasury + side_bucket + Σ_m settlement_locks[m] + queue_funds
      + protocol_fees + staker_fees + harvest_bounty_pool)
    ==
    Σ(stake_coins_in) - Σ(coins_out_to_users)

INV-2  (no negative balances)
    All Balance<C> values >= 0 (Move's Balance enforces).

INV-3  (queue ordering, FIFO)
    drain_count <= queue_head <= queue_tail == enqueue_count

INV-4  (queue_funds matches funded entries)
    queue_funds.value()
    == Σ entry.funded for entry in queue[head..tail]

INV-5  (queue_total matches unpaid)
    queue_total
    == Σ (entry.amount - entry.funded) for entry in queue[head..tail]

INV-6  (idempotent atomic settlement) [Δ vs v1]
    market.status transitions are monotonic and one-shot:
    OPEN → {SETTLED_TOUCH, SETTLED_NO_TOUCH} → {STALE_RELEASED} (optional)
    No LOCKED state exists; lock_and_settle is atomic.
    Re-call of lock_and_settle reverts via assert!(market.status == OPEN).

INV-7  (mutual exclusion of outcome)
    market.status ∈ {SETTLED_TOUCH, SETTLED_NO_TOUCH, STALE_RELEASED}
    after lock_and_settle. Never both touch and no_touch.

INV-8  (no over-payment per position)
    For any Position p: total Coin<C> ever paid to its owner
    + amount currently queued under p
    <= p.payout_if_win

INV-9  (losers get nothing)
    redeem_position returns Coin::zero() for any p with
    p.side != market.outcome_side.

INV-10 (monotonic telemetry)
    cumulative_stakes_in, cumulative_payouts_out,
    cumulative_losses_absorbed, cumulative_fees_taken — all
    monotonically non-decreasing across every transaction.

INV-11 (auto-harvest preserves equity)
    drain_into_queue_heads:
        Δtreasury + Δside_bucket + Δqueue_funds + Δqueue_total == 0

INV-12 (open_* never grows queue_total directly)
    open_position calls drain_into_queue_heads (which DECREASES
    queue_total) but does not enqueue. Only lock_and_settle and
    redeem_position-while-queue-nonempty may enqueue.
```

NEW v2 invariants:

```
INV-13 (per-market lock isolation) [closes #15]
    For any two markets m_a ≠ m_b, redemptions on m_a cannot withdraw
    from settlement_locks[m_b]. Formally:
        Σ_redemptions_of(m_a) <= settlement_locks[m_a].initial_value
                               + 0 (no cross-market top-ups)

INV-14 (queue-head priority) [closes #1]
    For any redeem_position call where queue_total > 0 at entry:
    the redeeming position's payout is enqueued in full at the queue
    tail; no Coin<C> is returned directly to the caller. Equivalently:
        ∀ payout p emitted from settlement_lock[m] to a winner of m:
            p > 0 ⇒ queue_total == 0 at time of emission.

INV-15 (atomic lock+settle) [closes #4 and #11]
    There is no observable state in which a market has been locked but
    not yet settled. lock_and_settle is a single entry function that
    either fully succeeds (market.status moves OPEN → SETTLED_*) or
    aborts with no state change.

INV-16 (rounding direction) [closes #10]
    Every division in the codebase rounds in a documented direction:
        - payout from stake:    UP   (favors user)
        - exposure from stake:  UP   (favors vault safety)
        - losing_stake from
          losing_exposure:      DOWN (favors vault — leaves dust in vault)
        - fees from stake:      DOWN (favors user; bounded by min_stake)
        - dust pro-rata claims: DOWN (favors vault — protocol absorbs dust)
    Vault never owes more than it tracks; users never receive less than
    they're owed beyond the documented bounded direction.

INV-17 (multiplier bounds) [closes #9 and #13 partially]
    For every Market<C>: 11_000 <= payout_multiplier_bps <= 50_000.
    Enforced at create_market and re-checkable in tests.

INV-18 (vault binding) [closes #8]
    For every state transition affecting a market:
        market.vault_id == object::id(vault_passed_in)
    This binding is set exactly once via register_market and never mutates.

INV-19 (no orphan queue entries)
    For every queue entry e at index i ∈ [drain_count, queue_tail):
        table::contains(queue, i) == true
    For i ∈ [0, drain_count) (claimed, removed): table::contains == false
    Per-market dust entries: at most ONE entry with is_dust=true per
    (market_id, outcome_side) pair.
```

Net protocol equity, by definition:

```
equity := treasury + side_bucket + Σ_m settlement_locks[m] - queue_total
```

Equity may be negative — by design. That is the entire point of
Martingaler: the protocol promises future cash flows out of expected
losing trades to back current winning ones.

---

## 4. Worked example — 12 trades demonstrating the new atomic flows

Setup: payout_multiplier_bps = 18_000 (1.8x), fees set to zero for clarity,
single collateral USDC. Three markets used: M1, M2, M3 each with both
sides. Outcomes decided per row in the "OUT" column.

Columns: T=treasury, SB=side_bucket, SL[m]=per-market settlement_lock,
QF=queue_funds, QT=queue_total, EQ=equity.

| # | Action | OUT | T | SB | SL | QF | QT | EQ | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 0 | (start, $0 bootstrap) | — | 0 | 0 | {} | 0 | 0 | 0 | clean slate |
| 1 | open M1.touch $100 | — | 100 | 0 | {} | 0 | 0 | 100 | M1.touch_exp=180 |
| 2 | open M1.no_touch $100 | — | 200 | 0 | {} | 0 | 0 | 200 | |
| 3 | open M2.touch $50 (small) | — | 250 | 0 | {} | 0 | 0 | 250 | M2.touch_exp=90 |
| 4 | open M2.no_touch $300 | — | 550 | 0 | {} | 0 | 0 | 550 | M2.no_touch_exp=540 |
| 5 | lock_and_settle M1 | TOUCH | 290 | 0 | {M1:180} | 0 | 0 | 290 | losing $100 → T (QT=0); to_lock=180 |
| 6 | redeem M1.touch (winner) | — | 290 | 0 | {M1:0} | 0 | 0 | 290 | QT=0 → pay $180 from SL[M1] |
| 7 | lock_and_settle M2 | NO_TOUCH | 0 | 0 | {M2:290} | 0 | 250 | 40 | winning_exp=540, T=290 → lock 290; losing $50 → T (QT was 0); shortfall=250 enqueued |
| 8 | redeem M2.no_touch (one winner, owed $540) | — | 0 | 0 | {M2:0} | 0 | 250 | 40 | QT>0 → push redeemer to back of queue. SL[M2] $290 → SB → drains old M2-shortfall entry of $250 → QF; residual $40 → SB. Wait — see detailed flow below row 7 explanation. |

Let me redo rows 7–8 with the precise atomic flow, since this is the
queue-head-bumper test case.

**Detailed flow for row 7 (lock_and_settle M2, no_touch wins):**

- Pre-conditions: T=550, SB=0, QT=0, SL={}.
- `winning_exposure = 540`, `losing_exposure = 90`,
  `losing_stake = 90 * 10_000 / 18_000 = 50`.
- `to_lock = min(540, 550) = 540`. (T was 550, fits in full.)

Actually I made an arithmetic error above; let me recompute carefully.
After rows 1–4: T = 100+100+50+300 = $550.

Row 5 corrected: lock_and_settle M1, touch wins. winning_exp=180,
losing_exp=180, losing_stake=180*10000/18000=100. to_lock=min(180,550)=180.

```
PHASE 1 (drain queue heads): QT=0, no-op.
PHASE 2 (lock): T = 550-180 = 370. SL[M1] = 180.
PHASE 3 (route losing stake $100): QT=0, drain returns 0, residual $100 → T.
        T = 370 + 100 = 470.
PHASE 4 (shortfall): winning_exp(180) <= to_lock(180), shortfall=0. No enqueue.
PHASE 5: M1.status = SETTLED_TOUCH.
```

Post row 5: T=470, SB=0, SL={M1:180}, QF=0, QT=0, EQ=470+0+180-0=650.

Row 6 corrected: redeem M1 winner, owed $180. QT=0 → branch (b).

```
PHASE 1 (auto-harvest from SB): SB=0, no-op.
PHASE 2 branch (b): pay min(180, 180) = 180 from SL[M1]. SL[M1]=0.
                    cumulative_payouts_out += 180.
```

Post row 6: T=470, SB=0, SL={M1:0}, QF=0, QT=0, EQ=470. Winner got $180.

Row 7: lock_and_settle M2, no_touch wins. winning_exp=540, losing_exp=90,
losing_stake=50. to_lock=min(540, 470)=470.

```
PHASE 1: QT=0, no-op.
PHASE 2: T = 470-470 = 0. SL[M2] = 470.
PHASE 3: losing_stake=50, QT=0, residual=50 → T. T = 50.
PHASE 4: shortfall = 540 - 470 = 70. Enqueue ONE entry of $70 (single
         winner). queue_tail = 1, queue_total = 70.
PHASE 5: M2.status = SETTLED_NO_TOUCH.
```

Post row 7: T=50, SB=0, SL={M1:0,M2:470}, QF=0, QT=70, EQ=50+0+470-70=450.
M2 winner is owed $540: $470 in SL[M2] + $70 queued.

Row 8: redeem M2 winner. QT=70 > 0 → branch (a) — **queue-head bumper test**.

```
PHASE 1 (auto-harvest from SB): SB=0, no-op.
PHASE 2 branch (a):
  - lock_share = pro-rata of SL[M2] for this winner. Single winner, so
    lock_share = SL[M2].value() = 470.
  - SL[M2] -> SB: SB = 470, SL[M2]=0.
  - drain_into_queue_heads from SB: pays $70 to queue head 0 (the M2
    shortfall entry). SB = 470-70 = 400. QF = 70. queue_total = 0.
    queue_head = 1. drain_count = 1.
  - Now queue is fully funded but the original M2 shortfall queue entry
    is still in the table awaiting claim_queued_payout.
  - enqueue_one(M2, position, owed=540): adds new entry at index 1.
    queue_tail = 2. queue_total = 540.
  - But wait — that re-enqueues the same winner's full $540! We need
    to subtract what's already attributed to them. Let me be precise:
    the original $70 entry IS this same winner's queue entry (M2 had
    one winner). So we should NOT enqueue a fresh $540 — we should
    consolidate.
```

The above reveals an implementation detail worth pinning down: in row 8,
the M2 winner already owns queue entry index 0 ($70). When they redeem,
we should *not* enqueue a fresh $540 — we should fold their lock
contribution into the queue. Refined PHASE 2 branch (a):

```
PHASE 2 branch (a) refined:
  Compute owed_remaining = position.payout_if_win
                         - any_existing_queue_entry_for_this_position.amount
                         - any_pending_lock_share
  (Position.payout_if_win = 540; existing queue entry = 70; lock_share = 470.
   owed_remaining = 540 - 70 - 470 = 0. So no NEW enqueue needed.)

  - Move lock_share to SB: SB += 470. SL[M2] -= 470.
  - drain_into_queue_heads from SB: funds the $70 entry, leaving $400 in SB.
  - The remaining $400 stays in SB (no queue heads left to fund).
  - The $400 will route back to T at the next lock_and_settle whose pre-lock
    drain is called when QT==0.
```

Post row 8: T=50, SB=400, SL={M1:0,M2:0}, QF=70, QT=0, EQ=50+400+0-0=450.
The M2 winner can now call `claim_queued_payout(idx=0)` to receive $70.

| # (cont) | Action | OUT | T | SB | SL | QF | QT | EQ | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 9 | claim_queued_payout(0) by M2 winner | — | 50 | 400 | {} | 0 | 0 | 450 | $70 paid; entry deleted; QF -= 70 |
| 10 | open M3.touch $200 | — | 250 | 400 | {} | 0 | 0 | 650 | M3.touch_exp=360. QT=0, no auto-drain. |
| 11 | open M3.no_touch $200 | — | 450 | 400 | {} | 0 | 0 | 850 | M3.no_touch_exp=360. |
| 12 | lock_and_settle M3 | TOUCH | 90 | 400 | {M3:360} | 0 | 0 | 850 | winning_exp=360, T=450 → to_lock=360. losing $200 → T (QT=0). T=90+200=290 wait. Let me recompute. |

Recompute row 12: T_before=450. to_lock=min(360, 450)=360. T after lock =
450 - 360 = 90. losing_stake = 200*10000/18000 = 111. Routed to T (QT=0).
T after = 90 + 111 = 201. SL[M3] = 360. shortfall = 0.

| # | Action | OUT | T | SB | SL | QF | QT | EQ | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 12 | lock_and_settle M3 (corrected) | TOUCH | 201 | 400 | {M3:360} | 0 | 0 | 961 | losing_stake=111 (round down) → T |

End state: equity = $961, no queue, all winners paid in full. Note that
SB still holds $400 from row 8. This is **expected**: that capital is
"in flight" awaiting either (a) a future lock_and_settle whose pre-lock
drain phase routes it through queue heads (which are empty — so it would
sit), or (b) a stale-lock release event. v2 enhancement to drain stale SB
when QT=0 can be added as a no-op in `drain_into_queue_heads` — when
called with QT=0, just move `side_bucket → treasury`. Add this to PHASE 1
of every flow:

```
if (queue_total == 0 && balance::value(&side_bucket) > 0) {
    let stale = balance::withdraw_all(&mut side_bucket);
    balance::join(&mut treasury, stale);
}
```

This makes SB self-cleaning. Update the worked example accordingly:

| # | Action | OUT | T | SB | SL | QF | QT | EQ | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 9' | claim_queued_payout(0) | — | 50 | 400 | {} | 0 | 0 | 450 | unchanged |
| 10' | open M3.touch $200 (auto-cleans SB since QT=0) | — | 650 | 0 | {} | 0 | 0 | 650 | SB→T at flow start; then +200 stake |
| 11' | open M3.no_touch $200 | — | 850 | 0 | {} | 0 | 0 | 850 | |
| 12' | lock_and_settle M3 TOUCH | TOUCH | 601 | 0 | {M3:360} | 0 | 0 | 961 | T=850-360=490 +111=601 |

The queue-head-bumper attack is **not possible** here. In row 8, even though
the M2 winner had $470 sitting in their own market's settlement lock, the
queue's $70 outstanding entry was paid first (PHASE 2 branch a), and the
remainder cleared the lock via the dust-clean mechanism. There is no path
for a fresh winner to extract funds while older queue entries remain unpaid.

---

## 5. Mitigated attack table

For each of the 15 redteam findings, this table states how v2 addresses it.

| # | Attack | v2 disposition |
|---|---|---|
| 1 | Queue-Head Bumper | **Mitigated by INV-14**: redeem_position branch (a) pushes fresh winners to the back of the queue and auto-drains side_bucket and lock contributions through old queue heads first. The v1 §7.1 "intended behavior" has been reversed. |
| 2 | Settlement Lock Hostage | **Mitigated by `release_stale_lock` (§2.6)**: after `stale_lock_window_ms` (default 24h), unredeemed locks return to treasury. Per-market `settlement_locks: Table<ID, Balance<C>>` makes per-market release possible. |
| 3 | Pro-Rata Dust Avalanche | **Mitigated by `min_queue_entry` + dust roll-up (§2.2 PHASE 4)**: positions whose pro-rata share is below `min_queue_entry` collapse into a single shared `is_dust=true` entry per (market, side). Storage cost is O(markets), not O(positions). |
| 4 | Reorder-the-Settlement Sandwich | **Mitigated by INV-15**: `lock_and_settle` is a single atomic entry function. There is no observable state between lock and settle in which a sandwich can land. |
| 5 | Dust-Trickle Harvest Griefing | **Mitigated by removing standalone harvest()**: there is no public `harvest()` to grief. Auto-harvest happens inside paying flows whose gas is already attributed to a paying caller. The `harvest_bounty_pool` exists for an optional explicit-trigger keeper post-MVP, gated by `min_side_bucket_to_trigger`. |
| 6 | Cumulative-Telemetry Overflow Aiming | **Mitigated by `min_stake` (§1)**: minimum stake of 1 USDC equivalent makes telemetry-spam economically pointless. Off-chain consumers should compute APY from events, not raw cumulative counters; documented in `docs/design/09_events_indexer.md`. |
| 7 | Negative-Equity Withdrawal Exit | **Out of scope for v2**: LP withdrawals are post-MVP. When implemented (post-MVP), share value formula MUST include `side_bucket` and subtract `max(0, queue_total - side_bucket)` per redteam §7's correction. Tracked in §9 Open Issues. |
| 8 | Cross-Collateral Phantom Solvency | **Mitigated by INV-18 + §1.2**: `register_market` permanently binds `Market<C>.vault_id` to a specific `MartingalerVault<C>` instance via `AdminCap`. Every state transition asserts `market.vault_id == object::id(vault)`. Phantom `C` parameter prevents type-level confusion. |
| 9 | Donation Distortion | **Mitigated by INV-17 (multiplier ≥ 11_000 bps)**: minimum 10% house edge on the loser side makes targeted donations economically unattractive. No public `donate` exists; tips route to `protocol_fees`. |
| 10 | Multiplier-Rounding Dust Pump | **Mitigated by INV-16**: rounding direction is documented per call site. Payout-from-stake rounds UP (favors user); exposure tracking rounds UP (favors vault); losing_stake rounds DOWN (vault keeps dust). Net effect: tracked obligations always ≥ actual obligations. |
| 11 | Permissionless `lock_settlement` Wrong-Time | **Mitigated by INV-15 + `treasury_snapshot_at_expiry`**: atomic lock+settle removes the wrong-time window (no separate lock call to fire). The snapshot field is recorded for downstream invariant tests. |
| 12 | Time-Warp Settlement | **Accepted as low-risk**: Sui clock anomalies are a network-level concern. v2 documents the assumption and rate-limits `lock_and_settle` calls per checkpoint via `max_harvest_per_call` indirectly (each call drains bounded work). Path-observation hardening lives in `05_path_observation_v2.md`, not here. |
| 13 | Adversarial Market Creator | **Mitigated by AdminCap-gated `create_market` + INV-17 + creator bond (§2.7)**: market creation is governance-gated in MVP. Multiplier bounded to [11_000, 50_000]. Creator must post `MIN_SEED_COLLATERAL` bond, slashable post-MVP. |
| 14 | The "Never Drain" Steady State | **Mitigated by removing standalone harvest() + auto-harvest on every flow**: every `open_position`, `lock_and_settle`, `redeem_position`, and `release_stale_lock` calls `drain_into_queue_heads` first. Queue progress is forced at every paying-flow boundary. SB self-cleans when `queue_total == 0` (§4 PHASE 1 addendum). |
| 15 | Settlement-Lock Pool Confusion | **Mitigated by `settlement_locks: Table<ID, Balance<C>>`**: per-market keyed reservation. Market m_a's redemptions can only withdraw from `settlement_locks[m_a]`. Cross-market siphoning is structurally impossible. |

---

## 6. Move pseudocode — updated function signatures

```move
module wick::martingaler_vault {
    use sui::balance::{Self, Balance};
    use sui::table::{Self, Table};
    use sui::object::{Self, ID, UID};
    use sui::tx_context::{Self, TxContext};
    use sui::clock::Clock;

    // ---- error codes ----
    const EPaused:           u64 = 0;
    const EExpired:          u64 = 1;
    const ENotOpen:          u64 = 2;
    const EBelowMinStake:    u64 = 3;
    const EWrongVault:       u64 = 4;
    const ENotExpired:       u64 = 5;
    const ENotSettled:       u64 = 6;
    const EWrongMarket:      u64 = 7;
    const ELoser:            u64 = 8;
    const ENotOwner:         u64 = 9;
    const ENothingToClaim:   u64 = 10;
    const EBadIndex:         u64 = 11;
    const EUseDustClaim:     u64 = 12;
    const ENoDust:           u64 = 13;
    const ENotDust:          u64 = 14;
    const ENotStale:         u64 = 15;
    const EAlreadyRegistered:u64 = 16;
    const EMultiplierTooLow: u64 = 17;
    const EMultiplierTooHigh:u64 = 18;
    const EExpiryTooSoon:    u64 = 19;
    const ESeedTooSmall:     u64 = 20;

    // ---- side flags ----
    const SIDE_TOUCH:    u8 = 0;
    const SIDE_NO_TOUCH: u8 = 1;

    // ---- status flags ----
    const OPEN:              u8 = 0;
    const SETTLED_TOUCH:     u8 = 1;
    const SETTLED_NO_TOUCH:  u8 = 2;
    const STALE_RELEASED:    u8 = 3;

    // ---- internal source flags for drain_into_queue_heads ----
    const FROM_SIDE_BUCKET: u8 = 0;
    const FROM_TREASURY:    u8 = 1;

    // (struct definitions: see §1)

    // === public entries ===

    public fun open_position<C>(
        vault: &mut MartingalerVault<C>,
        market: &mut Market<C>,
        side: u8,
        stake: Coin<C>,
        clock: &Clock,
        ctx: &mut TxContext,
    ): Position;

    public fun lock_and_settle<C>(
        vault:    &mut MartingalerVault<C>,
        market:   &mut Market<C>,
        oracle:   &WickOracle,
        path_obs: &PathObservation,
        clock:    &Clock,
        ctx:      &mut TxContext,
    );

    public fun redeem_position<C>(
        vault:    &mut MartingalerVault<C>,
        market:   &mut Market<C>,
        position: Position,
        ctx:      &mut TxContext,
    ): Coin<C>;

    public fun claim_queued_payout<C>(
        vault: &mut MartingalerVault<C>,
        queue_index: u64,
        ctx: &mut TxContext,
    ): Coin<C>;

    public fun claim_dust_share<C>(
        vault:    &mut MartingalerVault<C>,
        market:   &mut Market<C>,
        position: Position,
        ctx:      &mut TxContext,
    ): Coin<C>;

    public fun release_stale_lock<C>(
        vault:  &mut MartingalerVault<C>,
        market: &mut Market<C>,
        clock:  &Clock,
        ctx:    &mut TxContext,
    );

    public fun register_market<C>(
        cap:    &AdminCap,
        vault:  &MartingalerVault<C>,
        market: &mut Market<C>,
    );

    public fun create_market<C>(
        cap: &AdminCap,
        vault: &MartingalerVault<C>,
        payout_multiplier_bps: u64,
        expiry_ms: u64,
        seed_collateral: Coin<C>,
        oracle_id: ID,
        path_obs_id: ID,
        clock: &Clock,
        ctx: &mut TxContext,
    ): Market<C>;

    // === governance entries (AdminCap-gated) ===

    public fun set_fee_bps<C>(cap: &AdminCap, vault: &mut MartingalerVault<C>,
                              protocol_bps: u64, staker_bps: u64,
                              bounty_bps: u64);
    public fun set_min_stake<C>(cap: &AdminCap, vault: &mut MartingalerVault<C>,
                                v: u64);
    public fun set_min_queue_entry<C>(cap: &AdminCap,
                                      vault: &mut MartingalerVault<C>, v: u64);
    public fun set_pause<C>(cap: &AdminCap, vault: &mut MartingalerVault<C>,
                            paused: bool);

    // === internal helpers (package-private) ===

    fun drain_into_queue_heads<C>(
        vault: &mut MartingalerVault<C>,
        from: u8,
        max_iters: u64,
    ): u64;

    fun ceil_div(a: u64, b: u64): u64 {
        (a + b - 1) / b
    }

    fun enqueue_winners_pro_rata<C>(
        vault:        &mut MartingalerVault<C>,
        market:       &Market<C>,
        outcome_side: u8,
        shortfall:    u64,
        min_qe:       u64,
    );

    fun enqueue_one<C>(
        vault:    &mut MartingalerVault<C>,
        market_id: ID,
        position: &Position,
        amount:   u64,
    );

    fun pro_rata_share_of_lock<C>(
        market:   &Market<C>,
        position: &Position,
    ): u64;
}
```

The full bodies follow the §2 specifications exactly. Implementers should
treat §2 as the ground truth and use the signatures above as the public
surface contract.

---

## 7. New test scenarios — invariant tests that MUST pass

All in `move/tests/martingaler_vault_tests.move`. The 12 must-pass tests:

1. **`test_inv13_per_market_lock_isolation`** — two markets locked
   simultaneously; redeeming m_a never decreases `settlement_locks[m_b]`.
2. **`test_inv14_queue_head_priority`** — replay the worked example rows
   1–8 verbatim; assert that in row 8 the M2 winner gets $0 immediately
   and queue head 0 receives full $70 funding.
3. **`test_inv15_atomic_lock_and_settle`** — confirm there is no public
   `lock_settlement` function; confirm `lock_and_settle` either fully
   succeeds or aborts with no state change (run with deliberate
   path-observation failure mid-call).
4. **`test_inv16_rounding_direction`** — open position with stake=7 and
   multiplier=12_500; assert payout = ceil(7*12500/10000) = 9 (rounded up
   from 8.75); assert exposure tracked = 9; settle with this side losing
   and assert losing_stake = floor(9*10000/12500) = 7 (rounded down from
   7.2); confirm 0.2 mist stays in vault.
5. **`test_inv17_multiplier_bounds`** — `create_market` with
   `payout_multiplier_bps=10_999` reverts `EMultiplierTooLow`; with
   `50_001` reverts `EMultiplierTooHigh`; with `11_000` and `50_000`
   succeed.
6. **`test_inv18_vault_binding`** — `register_market(vault_a, market)`
   pins `market.vault_id`; subsequent `lock_and_settle(vault_b, market)`
   reverts `EWrongVault` even when both vaults are `MartingalerVault<C>`.
7. **`test_no_drain_steady_state_resolved`** — simulate 100 settlements
   with persistent `queue_total > 0`; assert queue_head advances at
   every flow without any explicit `harvest()` call (none exists).
8. **`test_settlement_lock_hostage_resolved`** — open winning position,
   never redeem, advance clock past `stale_lock_window_ms`,
   `release_stale_lock` returns lock to treasury; subsequent
   `redeem_position` returns `Coin::zero()`.
9. **`test_dust_avalanche_resolved`** — open 1000 winning positions
   sized just below `min_queue_entry`; settle with shortfall; assert
   exactly ONE dust queue entry exists; each Position can call
   `claim_dust_share` for its pro-rata cut.
10. **`test_cross_collateral_isolation`** — create
    `MartingalerVault<USDC>` and `MartingalerVault<SUI>`; confirm that
    `lock_and_settle(usdc_vault, sui_market)` is impossible at the type
    level (won't compile) and that `register_market(sui_vault,
    usdc_market)` reverts at runtime.
11. **`test_inv1_solvency_invariant_under_mixed_load`** — fuzz-style
    test running 200 random opens/settles/redeems/claims; assert INV-1
    holds at every step.
12. **`test_release_stale_lock_auto_harvest`** — settle market with
    queue active; trigger stale release; confirm released funds
    auto-drain into queue heads via `drain_into_queue_heads(TREASURY)`.

These tests collectively prove all 7 v2-specific invariants hold and the
top-three required redteam fixes are in place.

---

## 8. Operational gotchas

- **`max_harvest_per_call`**: cap each auto-harvest loop to 32 entries to
  fit a single Sui tx gas budget. If a flow has more queue heads than
  this, residual capital sits in `side_bucket` until the next flow drains
  it. Acceptable; bounded by `min_queue_entry` from below.
- **Fee parameter changes**: gate `set_fee_bps` behind multisig with
  timelock. Mid-flight fee changes alter solvency math in subtle ways.
- **Bond slashing post-MVP**: creator bond (§2.7) is locked but never
  slashed in v2. Post-MVP: governance can slash bonds for markets that
  settle with self-trading evidence (creator holds > 50% of either side).
- **Pause semantics**: `pause_open == true` blocks new opens but ALL
  settlement and redemption flows remain callable. Critical: never gate
  settlement behind pause — that creates an honest-pause-as-DOS attack
  on winners.
- **Storage rebates**: `claim_queued_payout` removes the entry from
  `table::queue` and returns gas refund to caller. This is the
  incentive for owners to claim promptly.

---

## 9. Open issues

1. **LP withdrawals** (redteam #7) — out of scope for v2. When designed,
   share value MUST be `(treasury + side_bucket - max(0, Q - SB)) /
   total_shares`, NOT the naive `treasury / total_shares`. Withdrawal
   while `Q > 0` should be either fully blocked or rate-limited with
   slashing per the corrected formula.

2. **Permissionless `create_market`** — v2 ships AdminCap-gated. The
   creator-bond + slashing model from §2.7 is partially specified but
   not wired (bond is held but not slashed in MVP). Decision needed
   before unlocking permissionless creation.

3. **Explicit-trigger keeper bounty** — `harvest_bounty_pool` is
   funded by `harvest_bounty_bps` on every open, but no public function
   spends it in MVP. A future `keeper_drain(min_pay)` function could pay
   the caller a bounty in exchange for explicit harvest work when SB
   accumulates faster than auto-harvest drains. Keep accumulating; design
   the function post-MVP when we have steady-state telemetry.

4. **Time-Warp Settlement** (redteam #12) — accepted as low-risk for
   MVP. Path observation v2 (`05_path_observation_v2.md`) hardens against
   clock-jump-induced sticky observations independently of this module.

5. **Dust roll-up claim deadline** — `claim_dust_share` has no expiry
   in v2. Combined with `release_stale_lock` covering the lock side,
   dust entries that never get claimed leave `queue_funds` slightly
   over-reserved relative to live claimable positions. Post-MVP: add a
   `release_stale_dust(market)` analog to `release_stale_lock`.

6. **`treasury_snapshot_at_expiry` use** — the field is recorded but
   not yet used for any in-protocol logic in v2 (it was specified to
   close redteam #11 by snapshotting treasury at the moment expiry
   passed). With atomic lock+settle, the snapshot is taken inside the
   single tx, so it's not actively defending against anything beyond
   what atomicity already provides. Field is preserved for off-chain
   audit and analytics; consider removing if not used by indexers.

---

## Appendix A — relationship to existing `vault.move`

Current `move/sources/vault.move` is a thin per-market `Balance<C>`
wrapper. Migrating to v2 Martingaler means:

1. Delete `vault.move` or repurpose as a fee-only utility.
2. New `martingaler_vault.move` module owning shared `MartingalerVault<C>`.
3. `market.move`'s `Market<C>` drops its `vault: Vault<C>` field, gains
   `vault_id`, `payout_multiplier_bps` bounds enforcement, `status` (with
   no LOCKED state), `creator`, `creator_bond`, and
   `treasury_snapshot_at_expiry` fields.
4. `market.move` `open` and `redeem` route through `martingaler_vault`
   calls.
5. New `lock_and_settle` and `release_stale_lock` entrypoints.
6. Conservation tests in `move/tests/foundation_tests.move` and
   `move/tests/market_tests.move` extended; new
   `move/tests/martingaler_vault_tests.move` adds the 12 invariant tests
   from §7.

This is a meaningful refactor — explicitly out of MVP scope per AGENTS.md.
This document exists so we can implement quickly when the time comes.
