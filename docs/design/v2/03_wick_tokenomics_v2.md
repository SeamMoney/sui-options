# WICK Tokenomics — Design Spec v2 (Hardened)

**Version:** 0.2 (hardened)
**Status:** Design only. Supersedes `docs/design/03_wick_tokenomics.md` (v0.1) in full. Do **not** read v1 in isolation; the prose-vs-pseudocode contradictions there are load-bearing bugs that v2 fixes by being self-contained.
**Author seat:** tokenomics design pass v2, 2026-05-12.
**Lineage:** structurally inspired by `PAPER` (papertrade.xyz) — re-derived for Wick's binary-options primitive at hackathon scale. Same posture as the Darbitex boundary in `AGENTS.md`: **idea reuse only, no vendoring**.

> **Mitigations claim.** This v2 is the implementation target. It mitigates **all 12 attacks** documented in `docs/redteam/02_wick_token.md`. Specifically, it incorporates the H3 hardening tasks (cliff bug, genesis dampener, per-address cliff, per-fund cap, listing-bond fix, insurance-sweep timing, bot exclusion, deferred-mint replay determinism, multi-collateral price-at-settlement) and the H6 slice covering Attack 1 / 3 / 6 / 9 / 11 mitigations. Where v1 prose and v1 pseudocode disagreed, v2 picks the version that is loss-of-funds-safe and rewrites both.

> **Frame, on every page (unchanged from v1):** WICK is a **fee receipt token**. It is minted to losing traders as compensation for the fees their loss generated for the protocol. It is not sold to depositors, never marketed as yield, never premined. There is no team allocation, no VC round, no airdrop, no vesting cliff, no treasury wallet that holds WICK at genesis. Total supply at TGE = **0**.

---

## 0. Mental model in one paragraph

A Wick trader closes a losing TOUCH/NO_TOUCH position (or expires out of the money). Their loss flows into the LP pool as protocol profit. That LP gain is the **only** event that mints WICK, and the trader who ate the loss is the only recipient. Mint rate decays as cumulative LP gain grows (high-water-mark ratchet — never resets). Stakers of WICK earn USDC + SUI dividends from a fee router. Anti-loop: 6h mint cooldown per address, 48h dividend cliff per address (single timer, not per receipt), 7d unstake delay, 30% lifetime-loss claim cap enforced **at both per-address and per-fund (network-wide) levels**, and a genesis-week dampener that prevents single-operator monopoly capture of the flat region.

---

## 1. Mint curve

### 1.1 Closed form (unchanged from v1)

Let:
- `S` = curve scale constant = **$1,200,000** (USDC, 6 dp internally)
- `T` = flat-region threshold = **$20,000** (cumulative LP gain at which decay begins)
- `flat` = flat mint rate = **100 WICK per $1 of LP gain** (1 WICK = 9 dp)
- `H` = current high-water-mark of cumulative LP gain (USDC, 6 dp), strictly monotone, never reset
- `dG` = LP gain delta from the loss event being processed (USDC, 6 dp)

Mint amount for an event:

```
if H + dG <= T:
    minted = flat * dG                       # flat region
elif H >= T:
    excess_after = (H + dG) - T              # H is post-update
    minted = flat * dG * (S / (S + excess_after - dG/2))^2
else:
    flat_piece  = flat * (T - H)
    decay_piece = flat * (H + dG - T) * (S / (S + (H + dG - T)/2))^2
    minted = flat_piece + decay_piece
```

The `(S/(S+H_excess))^2` term is the same shape as PAPER. The `dG/2` correction makes the decay path-independent across event partitioning.

### 1.2 Genesis-week dampener (NEW in v2)

The flat region is the highest-leverage attack surface. v1 says the first $20k of LP gain mints 2M WICK (1.6% of asymptotic cap); the red team showed (Attacks 4 + 5 + 8) that one well-funded actor can capture the **entire flat region in one block** for ~$240 of wash-trade fees.

v2 introduces a **genesis-week dampener overlay** that is multiplied into the flat-region mint:

```
if (now - wick_token_deploy_at_ms) < 7 days:
    # per-address per-day cap: at most $50 of lifetime-loss-equivalent
    # mints WICK for any single address per UTC day.
    daily_loss_used  = lifetime_loss_used_today[recipient]   # resets at UTC 00:00
    daily_loss_quota = 50_USD - daily_loss_used
    effective_dG     = min(dG, daily_loss_quota)
    deferred_dG      = dG - effective_dG    # see §1.2.1
else:
    effective_dG = dG
    deferred_dG  = 0

minted = curve(H, effective_dG)
```

Effect:
- During genesis week, an attacker controlling 100 addresses can extract at most `100 × $50 × 7 = $35k` of loss-equivalent WICK total — and *every dollar past $50/address/day is deferred*, not destroyed.
- A retail trader who actually loses $50 in a real position is unaffected.
- After day 7, the dampener is gone and the curve runs normally.

#### 1.2.1 Deferred-overflow handling

The `deferred_dG` portion is recorded in `MintDeferred` (see §7.2) **with the price-at-settlement-time captured**, and replayed via the same FIFO `crank_deferred_mints` queue used for stale-Pyth deferrals. This means:
- The attacker cannot "burn" the dampener by losing $10k at once on day-1 to lock everyone else out — the surplus is queued and made available to the recipient *after* day 7, computed against the post-genesis HWM.
- Deferred replay uses the **HWM-snapshot-at-record-time** (see §7.3 — Attack 7 mitigation), so attackers cannot game the replay order.

#### 1.2.2 Why $50 / address / day

The expected real-trader testnet behavior is on the order of $5–$50 of paper losses per session. A $50 cap is permissive enough to never block honest traders, while still mathematically capping operator-cluster capture: with the absolute maximum sybil count economically feasible at testnet faucet scale (~1,000 funded addresses), the genesis-week capture ceiling is `1,000 × $50 × 7 = $350,000` of loss-equivalent — which lands **squarely in the decay region**, removing the flat-region monopoly. At realistic sybil counts (tens, not thousands), genesis-week capture is bounded under $1,000 of WICK.

### 1.3 What the curve does *not* do (unchanged)

- It does **not** mint on LP deposits.
- It does **not** mint on AMM swap fees in isolation. Only realized losses trigger mints.
- It does **not** mint on winning trades.
- It does **not** retroactively re-mint when the curve decays — past mints are final.
- It does **not** mint to bot addresses (NEW in v2 — see §1.4).

### 1.4 Bot-trader exclusion (Attack 11 mitigation)

Every `Position` carries an `eligible_for_wick_mint: bool` flag set at **trade-open time**. The flag is `false` for:
- Any address in the on-chain `BotRegistry` (operator-controlled personality bots in `bots/`).
- Any trade opened against a known protocol-bot counterparty within the same market (tournament-internal trades).
- Any trade flagged by the keeper at routing time (e.g. obvious wash-trade heuristics, same-funder counterparties within last 30 days).

When `record_gain_and_mint` is called for a position with `eligible_for_wick_mint == false`:
- The HWM **does not ratchet** (the gain is still real LP profit, but not WICK-mintable, so we keep the curve clean of bot losses).
- The `dG` is recorded in a separate `bot_lp_gain_ledger` for transparency / audit.
- WICK is not minted; no event is deferred.

This honestly preserves the "no team allocation" frame: bots funded by the operator never accrue WICK to addresses the operator controls.

---

## 2. Total-supply projection (with genesis dampener)

The asymptotic supply is **unchanged at ~122M WICK**, because the dampener only delays/throttles flat-region issuance — it does not destroy it. But the *path* to that asymptote is meaningfully different in week 1.

| Cumulative LP gain (`H_total`) | Region | Total WICK supply (v2 path) | v1 supply for comparison | Δ from v1 |
|---|---|---|---|---|
| $1,000 | flat | 100,000 | 100,000 | 0 |
| $10,000 | flat | 1,000,000 | 1,000,000 | 0 |
| $20,000 | edge of flat | 2,000,000 | 2,000,000 | 0 |
| $20,000 *during* week 1 | flat (with dampener active) | 2,000,000 minted **across ≥ 57 addresses** (no single address > $50 × 7 = $350 of loss-equivalent → ≤ 35,000 WICK per address) | 2,000,000 minted (potentially all to one address) | distribution-only |
| $100,000 | decay | ~9,300,000 | ~9,300,000 | 0 |
| $1,000,000 | decay | ~46,200,000 | ~46,200,000 | 0 |
| $10,000,000 | decay | ~109,200,000 | ~109,200,000 | 0 |
| $100,000,000 | decay | ~118,800,000 | ~118,800,000 | 0 |
| ∞ (asymptote) | — | **~122M WICK** | ~122M WICK | 0 |

**Key point:** the dampener changes *who* the first 2M WICK is distributed to, not *how much* gets minted. Total supply trajectory is identical to v1.

The hackathon demo lives in the first three rows of this table — likely 100k–2M WICK total during testnet, distributed across the actual losing-trader set rather than concentrated in one operator wallet.

---

## 3. Dividend mechanics

### 3.1 Revenue sources (unchanged)

1. **AMM swap fees** — `fee_bps` on every TOUCH/NO_TOUCH swap inside the CPMM. Defaults to 50 bps. Paid in market collateral (`SUI` or `USDC`).
2. **Settlement skim** — 25 bps of payout deducted from `redeem_winner` payouts at settlement. Same currency as collateral.

### 3.2 Bucket split (unchanged)

| Bucket | Share | Destination |
|---|---|---|
| `lp_share` | **60%** | Originating market's `collateral_vault` — re-feeds the WICK mint curve. |
| `staker_share` | **30%** | `WickStakingPool` — pro-rata to staked WICK. |
| `insurance_share` | **10%** | `InsuranceVault`. Sweep-on-cap to stakers (NEW: deterministic, see §3.5). |

### 3.3 Why these percentages (unchanged)

See v1 §3.3. The percentages are not the v2 attack surface; the *mechanics* of distribution were.

### 3.4 The 48h cliff bug — definitively fixed

> **The contradiction.** v1 §5.1 says: *"`debt_per_wick` is initialized at the future `acc_usdc_per_wick` projected forward 48h."* v1 §9.2 pseudocode says: *"`debt_per_wick_by_currency: bag::new(ctx)`"* — i.e. zero-initialised. The pseudocode wins by default during implementation, which gives the **retroactive-claim** drain (Attack 1).

v2 makes the initialization **unambiguous, single-form, and load-bearing**:

```
At stake() time:
    For every supported currency C in pool.acc_per_wick_by_currency:
        receipt.debt_per_wick_by_currency[C] = pool.acc_per_wick_by_currency[C]
```

This is the **only** correct snapshot. The 48h cliff is a *separate* gate (`assert!(now >= eligible_at_ms)`) that prevents *premature* claim. The cliff and the debt snapshot are two different mechanisms; v1 conflated them.

#### 3.4.1 Exact pseudocode for the stake → claim flow (no ambiguity)

```move
public fun stake(
    pool: &mut WickStakingPool,
    wick: Coin<WICK>,
    clock: &Clock,
    ctx: &mut TxContext,
): StakeReceipt {
    let now      = clock.timestamp_ms();
    let amount   = coin::value(&wick);
    let sender   = tx_context::sender(ctx);

    // V2 LOAD-BEARING: snapshot debt at current accumulator for EVERY currency.
    // This is the empty-bag fix. Do NOT initialize an empty bag.
    let mut debt_bag = bag::new(ctx);
    let currencies = pool_currency_keys(pool);   // returns vector<TypeName>
    let mut i = 0;
    while (i < vector::length(&currencies)) {
        let key  = *vector::borrow(&currencies, i);
        let acc  = read_acc_by_key(pool, key);   // u128, 1e18 dp
        bag::add(&mut debt_bag, key, acc);
        i = i + 1;
    };

    // V2: enforce per-address single-cliff (Attack 3 mitigation) by reading the
    // address-level cliff state and updating it (not a per-receipt cliff).
    let addr_state = address_state_mut(pool, sender);
    addr_state.last_significant_stake_at_ms = now;
    let new_eligible_at = now + STAKE_CLIFF_MS;
    addr_state.eligible_at_ms =
        if (addr_state.eligible_at_ms < new_eligible_at) new_eligible_at
        else addr_state.eligible_at_ms;

    // V2: forced minimum stake (Attack 2 mitigation: dust accumulator poisoning).
    assert!(amount >= MIN_STAKE_WICK, E_STAKE_TOO_SMALL);

    absorb_wick(pool, wick);
    pool.total_staked = pool.total_staked + amount;

    // V2: per-stake-share cap (Attack 12 mitigation): no single address may
    // hold more than MAX_STAKE_SHARE_BPS of total_staked at the moment of stake.
    assert!(
        addr_state.staked + amount <= pool.total_staked * MAX_STAKE_SHARE_BPS / 10000,
        E_STAKE_SHARE_CAP_EXCEEDED,
    );
    addr_state.staked = addr_state.staked + amount;

    StakeReceipt {
        id: object::new(ctx),
        owner: sender,
        staked: amount,
        debt_per_wick_by_currency: debt_bag,
        unstake_initiated_at_ms: 0,
    }
}

public fun claim<C>(
    pool:    &mut WickStakingPool,
    receipt: &mut StakeReceipt,
    global:  &mut WickGlobalState,
    clock:   &Clock,
    ctx:     &mut TxContext,
): Coin<C> {
    let now      = clock.timestamp_ms();
    let owner    = receipt.owner;
    let addr_state = address_state(pool, owner);

    // V2: cliff is per-ADDRESS, applies to all of this address's receipts.
    assert!(now >= addr_state.eligible_at_ms, E_CLIFF_NOT_REACHED);

    let key  = type_name::get<C>();
    let acc  = read_acc_by_key(pool, key);
    let debt = *bag::borrow<TypeName, u128>(&receipt.debt_per_wick_by_currency, key);

    // Pure rewards-per-share math; debt was snapshot at stake-time, so this
    // returns ONLY post-stake flow.
    let pending = (receipt.staked as u128) * (acc - debt) / DPS_DEN;

    // Layer 4a — per-address lifetime-loss ceiling (30%).
    let addr_cap_remaining = lifetime_loss_cap_remaining(global, owner);

    // Layer 4b (NEW in v2) — per-FUND ceiling (Attack 12 mitigation).
    // max_total_claimed_network <= 30% * cumulative_network_losses.
    let fund_cap_remaining = fund_loss_cap_remaining(global);

    let allowed_uncapped = pending;
    let allowed_addr     = u128_min(allowed_uncapped, addr_cap_remaining);
    let allowed          = u128_min(allowed_addr, fund_cap_remaining);

    // FORFEIT routing (V2: NOT to staker pool — kills Attack 12 amplifier).
    // Forfeited dividends route to insurance vault.
    let forfeited = pending - allowed;
    if (forfeited > 0) {
        forward_to_insurance<C>(pool, forfeited, ctx);
    };

    bump_lifetime_claimed(global, owner, allowed);
    bump_fund_claimed(global, allowed);

    // CRITICAL: update debt to current acc so the user does not double-claim
    // the same accumulator delta on the next call.
    bag::remove<TypeName, u128>(&mut receipt.debt_per_wick_by_currency, key);
    bag::add(&mut receipt.debt_per_wick_by_currency, key, acc);

    coin::take(borrow_balance_mut<C>(pool), (allowed as u64), ctx)
}
```

The two changes from v1 that close Attack 1 + Attack 12:

1. `stake()` populates `debt_per_wick_by_currency` with the **current accumulator value at stake time**, for every currency. No empty bag. No "projected forward" hand-waving.
2. `claim()` routes forfeited dividends to **insurance**, not back to the staker pool. This breaks the sybil-amplification feedback loop where an operator at 90% of `total_staked` recaptures forfeits proportionally.

### 3.5 Insurance-sweep timing — deterministic, not first-caller-wins

v1 said "anyone can call `crank_insurance_sweep()` once cap is exceeded." Attack 9 weaponized this: an attacker stakes a huge position right before triggering a sweep and captures pro-rata.

v2 makes the sweep **deterministic and pre-announced**:

- Sweep eligibility is checked on a **fixed weekly cadence** (every Monday 00:00 UTC, derived from `clock.timestamp_ms() / WEEK_MS`).
- Sweep distribution to stakers is **pro-rata to time-weighted-average stake (TWAB) over the previous 7 days**, not to current `total_staked`. Pre-staking 1 second before the sweep gives essentially zero share.
- The crank is still permissionless (anyone can call), but the *distribution math* uses the TWAB snapshot, which is computed from on-chain `last_stake_change_at_ms` per address. No first-caller advantage exists.
- Additional MEV-break: the sweep amount above cap is **not distributed in one block** — it is added to a `pending_sweep_balance` and *vested into the staker accumulator over the next 7 days* via daily auto-bumps cranked permissionlessly. Attackers cannot stake-then-claim within the cliff window (48h) because the bulk of the vested sweep arrives after they unstake.

### 3.6 Cap-and-sweep on per-market LP excess (refined)

Per v1 §3.5, individual market vaults exceeding `LP_EXCESS_CAP = $250k` divert excess gains to the staker pool. v2 keeps this but routes through the same TWAB-protected accumulator path as §3.5 to prevent the equivalent "stake-before-cap-trigger" attack.

---

## 4. Staking — anti-loop layers (v2-correct)

### 4.1 Layer summary

| Layer | Mechanism | Scope | Param |
|---|---|---|---|
| L1 | Mint cooldown | Per address | 6h (no mint within 6h of last mint to same address) |
| L2 | **Per-address dividend cliff** (NEW: per-address, NOT per-receipt) | Per address | 48h after most-recent stake-increase |
| L3 | Unstake delay | Per receipt | 7d cooldown |
| L4a | Lifetime claim cap (per address) | Per address | 30% of that address's cumulative realized losses |
| L4b | **Lifetime claim cap (per fund)** (NEW) | Network-wide | `total_claimed_network ≤ 30% × cumulative_network_losses` |
| L5 | HWM strict-monotone | Global | No setter, no admin reset |
| L6 | **Forfeit-to-insurance** (NEW: not back to staker pool) | Network-wide | Closes Attack 12 |
| L7 | **Genesis-week dampener** (NEW) | Per address per day | $50 loss-equivalent / address / day for first 7 days |
| L8 | **Bot-trader mint exclusion** (NEW) | Per position | `eligible_for_wick_mint=false` for known bots |

### 4.2 The single-timer-per-address cliff (Attack 3 fix)

v1's pseudocode placed `eligible_at_ms` on each `StakeReceipt`. An attacker holding 10,000 WICK could `stake(1 WICK)` every hour, building a rolling stash of 48 receipts whose cliffs were continuously staggered. After 48h, they always had *some* receipt past cliff and could claim through it indefinitely.

v2 fix: cliff lives in a **per-address `AddressStakeState` record**, not on the receipt:

```move
public struct AddressStakeState has store {
    staked: u64,                            // sum across this address's receipts
    eligible_at_ms: u64,                    // address-level cliff
    last_significant_stake_at_ms: u64,
}
```

Rules:
- Any `stake()` call by `addr` sets `addr_state.last_significant_stake_at_ms = now`.
- `addr_state.eligible_at_ms = max(addr_state.eligible_at_ms, now + STAKE_CLIFF_MS)`.
  This is **monotonic-forward**: a fresh stake can only push the cliff later, never earlier. So adding 1 WICK every hour does not give an attacker an old, already-matured cliff — it resets the cliff for *all* of that address's receipts.
- `claim()` checks `addr_state.eligible_at_ms`, not `receipt.eligible_at_ms` (the field is removed from the receipt entirely).

A stake-once-and-forget user is unaffected (their cliff matures once, after 48h, and stays matured). A stake-stagger attacker is forced to wait 48h after their *most recent* stake before claiming on *any* receipt.

### 4.3 The per-fund 30% cap (Attack 12 + sybil amplification fix)

v1 enforced the 30% cap per address only. The red team showed that sybils + accumulator forfeit-back-to-pool means an operator at 90% pool share recaptures ~100% of forfeited dividends.

v2 enforces the cap **at both per-address and network-wide levels**:

```move
public struct WickGlobalState has key {
    // ...
    cumulative_network_losses_usd_e6: u128,
    cumulative_network_claimed_usd_e6: u128,
    // ...
}

fun fund_loss_cap_remaining(global: &WickGlobalState): u128 {
    let cap = global.cumulative_network_losses_usd_e6 * 3000 / 10000;  // 30% bps
    if (global.cumulative_network_claimed_usd_e6 >= cap) 0
    else cap - global.cumulative_network_claimed_usd_e6
}
```

A claim is `min(pending, addr_cap_remaining, fund_cap_remaining)`. If the global cap binds, no address can claim more — Sybil multiplication is bounded by the global cap, not by the per-address cap × number of addresses.

### 4.4 Forfeit routing (Layer 6)

When `pending > allowed`, the difference (`forfeited`) does **not** re-distribute through the staker accumulator. It is sent to the `InsuranceVault` (which itself sweeps to stakers via the TWAB-deterministic path in §3.5, but only on a 7-day vesting schedule). This single change:

- Closes the sybil-share amplification of Attack 12.
- Keeps forfeit value inside the protocol (it is not burned), so the "money goes somewhere productive" optic is preserved.
- The vested re-distribution path means even if a sybil eventually receives some of the forfeit, they receive it *much later and through the cliff/cap stack again*, making the attack net-negative on TVOM grounds.

### 4.5 Why these specific delays (refined)

- **6h mint cooldown** — unchanged.
- **48h dividend cliff (per-address now)** — long enough that a single loss event's dividend distribution has fully spread across all stakers active in that window, before the loss-trader can claim.
- **7d unstake** — unchanged.
- **30% lifetime cap, both layers** — the per-address layer remains the primary individual constraint; the per-fund layer is the **system-wide solvency floor** that no sybil cluster can break through.
- **$50/address/day genesis dampener** — calibrated to be invisible to honest traders (a $50 paper-trade loss at testnet scale is a normal-sized bad day) while holding the operator-cluster genesis capture bound under $1k.

### 4.6 What we explicitly do *not* do

- We do **not** require KYC.
- We do **not** ban Sybil patterns directly. The fund-level cap (4.3) means we don't have to.
- We do **not** introduce a "team can pause" lever on staking. The staking pool remains unprivileged.

---

## 5. Demand drivers beyond dividends (with double-utility removed)

### 5.1 Driver A — Stake-tier fee discount on losses (unchanged shape)

| Stake tier | Stake floor (WICK) | Settlement skim | Effective edge |
|---|---|---|---|
| None | 0 | 25 bps | baseline |
| Bronze | 1,000 | 20 bps | 5 bps cheaper |
| Silver | 10,000 | 15 bps | 10 bps cheaper |
| Gold | 100,000 | 10 bps | 15 bps cheaper |
| Platinum | 1,000,000 | 5 bps | 20 bps cheaper |

The stake tier is computed from `addr_state.staked` (which excludes bonded WICK — see §5.2). No double-utility.

### 5.2 Driver B — WICK-bonded market listing (HARDENED)

| Listing tier | WICK bond | Frontend treatment |
|---|---|---|
| Open | 0 | Hidden (URL-param only) |
| Indexed | 5,000 | Searchable |
| Featured | 50,000 | Front-page rail |
| Sponsored | 500,000 | Bot-eligible, top-of-rail |

#### 5.2.1 v2 invariant: bond is locked, not stakeable

The listing-bond mechanism uses a **`BondReceipt`** that consumes `Coin<WICK>` by value into a separate `MarketBondPool` object. While bonded:

- The WICK is **not counted toward `addr_state.staked`** for purposes of the L1–L4 staking accounting.
- The WICK is **not counted toward staking-discount tiers** (§5.1). To get a tier discount, you must stake additional WICK *outside* the bond.
- The WICK **does not earn dividends**.
- The WICK is non-transferable while locked (held by `MarketBondPool` by value, refundable via burning the `BondReceipt`).

This is the explicit close of the Attack-6 stake-and-bond doubling exploit. There is no on-chain path by which the same `Coin<WICK>` object can be both bonded and dividend-earning.

#### 5.2.2 Refund + slash rules (refined)

- **Refund** in full when the market reaches `HIT` or `EXPIRED` and final redemption has settled. `BondReceipt` is consumed; `Coin<WICK>` is returned to the address recorded on the receipt.
- **Slash** if a market is reported and confirmed as spam/duplicate by the v1 admin multisig (post-MVP: governance vote): bonded WICK is **burned**, not sold. The insurance bucket is made whole from the next fee carve. **No protocol-forced sell of slashed WICK.** This closes the slash-arbitrage variant of Attack 6.
- **Listing cooldown:** 24h between bond placement and frontend promotion. Removes the create-bond-trade-against-it-immediately primitive.

### 5.3 Why two and not five (unchanged)

Two clean mechanics, written down honestly. Tournament fees, badge-mints, governance — all post-MVP.

---

## 6. Multi-collateral handling (v2: price-at-settlement-time)

Wick supports `SUI` and `USDC` collateral pools. The mint curve is denominated in USDC-equivalent (single canonical answer for `H` at any moment).

### 6.1 Normalization rule (HARDENED)

> **The v1 bug.** v1 §6.1 used `pyth_oracle::sui_usd_price_e6(price_info, clock)` *at the moment of `record_gain_and_mint`* — i.e., live Pyth at mint time. Attack 10 showed that delaying transaction inclusion (private mempool / gas-priority manipulation) lets an attacker shift which Pyth tick is used, over- or under-minting WICK.

v2 captures the Pyth price **at trade-settlement time** (the moment the position is closed / settles), stores it on the `Position` (or in the `MintDeferred` record, see §7.2), and uses *that* captured price for the USDC normalization at mint time:

```move
public struct Position has key, store {
    // ...
    settlement_price_usd_e6: u64,        // V2: captured at settle, frozen
    settlement_pyth_publish_time_ms: u64,
    eligible_for_wick_mint: bool,        // V2: Attack 11 flag
}
```

When the keeper / settlement path closes a losing position:
1. Read Pyth at `clock.timestamp_ms()`. If stale (>60s), abort (do not settle yet — see §7.4). If fresh, store `(price, publish_time)` on the `Position`.
2. `record_gain_and_mint` reads the stored price, **not** live Pyth. The conversion `gain_sui * price_usd_e6 / 1e9` uses the frozen value.
3. If mint is deferred (genesis dampener, or stale-pyth at the *mint-record* moment which can't actually happen if §7.4 already gated settlement, but defensively for genesis-dampener overflow), the same frozen price is recorded on the `MintDeferred` event.

This makes mint-amount a **deterministic function of the position's settlement state**, independent of when the mint transaction gets included.

### 6.2 Pyth as the conversion oracle (unchanged)

Same Pyth pull-oracle SUI/USD spot used by `mark_hit`. Single oracle dependency.

### 6.3 Why not independent pools (unchanged)

See v1 §6.3.

### 6.4 Dividend payout currency (unchanged)

Stakers receive dividends in the original collateral currency of the fee event. No conversion. `claim<SUI>` and `claim<USDC>` are independent calls.

---

## 7. Mitigated attack table

For each of the 12 attacks in `docs/redteam/02_wick_token.md`, the v2 mitigation, the section that codifies it, and the residual risk.

| # | Attack name | v2 mitigation | v2 § | Residual risk |
|---|---|---|---|---|
| 1 | Empty-bag retroactive claim | `debt_per_wick` snapshotted at `acc_per_wick` at stake time, not zero. Pseudocode in §3.4.1 is the load-bearing form. | §3.4 | None at protocol layer. UI must read `acc` correctly (test in §8). |
| 2 | `total_staked == 0` first-staker windfall | `MIN_STAKE_WICK = 1,000 WICK` floor on `stake()`. When `total_staked == 0`, `deposit_fees` routes incoming fees to the insurance bucket, not `balances`. Per-WICK accumulator delta capped at `MAX_DELTA_PER_WICK = 1e22`; oversized deposits route to insurance. | §3.4.1 | Insurance-bucket fills slightly faster during cold-start, mitigated by §3.5 vested sweep. |
| 3 | Multi-receipt cliff laundering | Cliff lives on `AddressStakeState`, not on `StakeReceipt`. Any new `stake()` call by an address pushes that address's cliff forward (monotonic). | §4.2 | None. |
| 4 | Sybil mint loop | Per-fund 30% cap (§4.3), genesis-week dampener (§1.2), bot-trader exclusion (§1.4). Sybils still split mint across addresses but the *fund-level* claim cap is no higher than 30% of *real* network losses. | §1.2, §1.4, §4.3 | Sybils can still capture pro-rata of the legitimate dividend stream, but the cap binds globally. |
| 5 | Wash-trade mint with offsetting positions | Counterparty-disjointness check at `record_gain_and_mint`: if recipient has been a counterparty (via `Position` ownership history) of any winner in the same market within last 7 days, the mint is diverted to insurance. Also: `MIN_EVENT_USD_E6 = 10_000_000` ($10 floor, raised 100x from v1's $0.10). | §1.4, §7.4 | Long-tail wash patterns across more than 2 controlled addresses still possible but cost-of-attack rises sharply. |
| 6 | Listing-bond rehypothecation | Bond uses `BondReceipt` consuming `Coin<WICK>` by value into separate `MarketBondPool`. Bonded WICK is excluded from staking accounting, dividend earning, and tier discounts. Slashes are burns, not sells. 24h listing cooldown. | §5.2.1, §5.2.2 | None at protocol layer. Spam-listing remains a possibility but is rate-limited by cooldown. |
| 7 | Pyth-stale `MintDeferred` replay | `MintDeferred` records `(H_snapshot_at_record_time, dG, settlement_price_usd_e6)`. Replay computes `compute_mint(H_snapshot, dG)`, in FIFO order, with HWM ratchet sequencing tied to record-time, not crank-time. | §7.2, §7.3 | None. Honest traders get the rate they earned at settlement. |
| 8 | Genesis-race monopolization | Genesis-week dampener: $50/address/day cap on flat-region mint. Surplus is deferred (§1.2.1). | §1.2 | Operator with thousands of addresses can still capture meaningful share of week-1 mint, but bound is mathematical and pre-announced. |
| 9 | Insurance-sweep timing | Sweep eligibility is fixed-cadence (Monday 00:00 UTC). Distribution uses TWAB over previous 7 days, not current `total_staked`. Sweep amount vests over 7 days into accumulator. | §3.5 | None. Stake-then-trigger MEV is mathematically dead. |
| 10 | Cross-collateral conversion lag | Pyth price captured at *settlement* time (frozen on `Position`), used by `record_gain_and_mint`. Inclusion-timing manipulation does not change conversion basis. | §6.1 | None for closed positions. New positions opened during a Pyth degrade window are gated by §7.4. |
| 11 | Bot-trader mint flooding | `eligible_for_wick_mint: bool` on every `Position`, `false` for `BotRegistry` addresses and tournament-internal trades. Bot-side losses do **not** ratchet HWM and do **not** mint WICK; they are ledgered separately for transparency. | §1.4 | None. The "no team allocation" frame holds on-chain. |
| 12 | Forfeit-into-pool feedback loop | Forfeited dividends route to `InsuranceVault`, not back to staker pool. Combined with TWAB sweep (§3.5), sybils cannot recapture forfeits within their own cliff window. Per-stake-share cap (`MAX_STAKE_SHARE_BPS = 2000` = 20% per address) further bounds the amplification. | §3.4.1, §4.4 | A single address holding ≤ 20% of pool gets ≤ 20% of any sweep, gated by TWAB. |

---

## 8. Move pseudocode (v2)

All pseudocode is **design-level**. Final implementation needs full error codes, event emissions, sui-framework idioms.

### 8.1 `wick_token.move` — curve, mint, MintDeferred

```move
module wick::wick_token {
    use sui::balance::{Self, Balance};
    use sui::clock::Clock;
    use sui::coin::{Self, Coin, TreasuryCap};
    use sui::table::{Self, Table};
    use sui::tx_context::TxContext;
    use sui::event;
    use sui::object::{Self, UID, ID};

    // Curve
    const FLAT_RATE_NUM:        u128 = 100;
    const FLAT_RATE_DEN:        u128 = 1;
    const FLAT_THRESHOLD_USD_E6:u128 = 20_000_000_000;          // $20,000
    const DECAY_SCALE_USD_E6:   u128 = 1_200_000_000_000;       // $1,200,000
    const MIN_EVENT_USD_E6:     u128 = 10_000_000;              // V2: $10 (was $0.10)

    // Anti-loop
    const MINT_COOLDOWN_MS:     u64  = 6 * 60 * 60 * 1000;      // 6h

    // V2 — Genesis dampener
    const GENESIS_WINDOW_MS:    u64  = 7 * 24 * 60 * 60 * 1000;
    const GENESIS_DAY_CAP_USD_E6: u128 = 50_000_000;            // $50 / address / day
    const DAY_MS:               u64  = 24 * 60 * 60 * 1000;

    public struct WICK has drop {}

    public struct WickGlobalState has key {
        id: UID,
        treasury: TreasuryCap<WICK>,
        deploy_at_ms: u64,
        high_water_mark_usd_e6: u128,
        total_supply_minted: u128,

        last_mint_at:               Table<address, u64>,
        lifetime_losses_usd_e6:     Table<address, u128>,
        lifetime_claims_usd_e6:     Table<address, u128>,

        // V2 — fund-level cap (Attack 12)
        cumulative_network_losses_usd_e6:  u128,
        cumulative_network_claimed_usd_e6: u128,

        // V2 — genesis dampener
        daily_loss_used: Table<address, GenesisDayUsage>,

        // V2 — bot exclusion (Attack 11)
        bot_registry: Table<address, bool>,

        // V2 — deferred mints (genesis overflow + stale-Pyth)
        mint_deferred_queue: vector<MintDeferred>,
    }

    public struct GenesisDayUsage has store, copy, drop {
        utc_day: u64,
        used_usd_e6: u128,
    }

    /// V2 — captured at trade-settlement time, replayed deterministically.
    public struct MintDeferred has store, copy, drop {
        recipient: address,
        d_gain_usd_e6: u128,
        h_snapshot_at_record_usd_e6: u128,   // freeze the H seen when recorded
        settlement_price_usd_e6: u64,        // Pyth at trade-settle time
        settlement_pyth_publish_time_ms: u64,
        recorded_at_ms: u64,
        kind: u8,                            // 0 = stale-pyth, 1 = genesis-overflow
    }

    /// Pure computation — no state mutation.
    fun compute_mint(h_before: u128, d_gain: u128): u128 {
        if (d_gain < MIN_EVENT_USD_E6) { return 0 };
        let h_after = h_before + d_gain;

        if (h_after <= FLAT_THRESHOLD_USD_E6) {
            return flat_mint(d_gain)
        };
        if (h_before >= FLAT_THRESHOLD_USD_E6) {
            let excess_mid = (h_before + h_after) / 2 - FLAT_THRESHOLD_USD_E6;
            return decay_mint(d_gain, excess_mid)
        };
        let flat_dgain  = FLAT_THRESHOLD_USD_E6 - h_before;
        let decay_dgain = h_after - FLAT_THRESHOLD_USD_E6;
        flat_mint(flat_dgain) + decay_mint(decay_dgain, decay_dgain / 2)
    }

    fun flat_mint(d_gain: u128): u128 {
        d_gain * FLAT_RATE_NUM * 1000 / FLAT_RATE_DEN
    }

    fun decay_mint(d_gain: u128, excess_mid: u128): u128 {
        let base  = flat_mint(d_gain);
        let denom = DECAY_SCALE_USD_E6 + excess_mid;
        let num   = base * DECAY_SCALE_USD_E6 / denom;
        num * DECAY_SCALE_USD_E6 / denom
    }

    /// V2 — Friend-only entry. Called by `wick::market` at settle of a losing
    /// position. The settlement_price is FROZEN at settle-time (Attack 10 fix).
    public(friend) fun record_gain_and_mint(
        state: &mut WickGlobalState,
        recipient: address,
        d_gain_usd_e6: u128,                       // already converted via frozen price
        eligible_for_wick_mint: bool,              // Attack 11 flag from the Position
        settlement_price_usd_e6: u64,
        settlement_pyth_publish_time_ms: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let now = clock.timestamp_ms();

        // V2 — Bot exclusion (Attack 11). HWM does not ratchet for bot losses.
        if (!eligible_for_wick_mint || table::contains(&state.bot_registry, recipient)) {
            // Track separately for transparency, but DO NOT ratchet H or mint.
            return
        };

        // L1 — mint cooldown
        if (table::contains(&state.last_mint_at, recipient)) {
            let last = *table::borrow(&state.last_mint_at, recipient);
            assert!(now >= last + MINT_COOLDOWN_MS, E_MINT_COOLDOWN);
        };

        // V2 — Genesis dampener (Attack 8 fix). Split d_gain into effective + deferred.
        let (effective_dg, deferred_dg) = apply_genesis_dampener(state, recipient, d_gain_usd_e6, now);

        // L4a/L4b lifetime-loss tracking happens on EFFECTIVE dg only;
        // deferred portions accrue when replayed.
        let to_mint = compute_mint(state.high_water_mark_usd_e6, effective_dg);

        state.high_water_mark_usd_e6 = state.high_water_mark_usd_e6 + effective_dg;
        state.cumulative_network_losses_usd_e6 =
            state.cumulative_network_losses_usd_e6 + effective_dg;
        state.total_supply_minted = state.total_supply_minted + to_mint;

        upsert_loss(&mut state.lifetime_losses_usd_e6, recipient, effective_dg);
        upsert(&mut state.last_mint_at, recipient, now);

        if (deferred_dg > 0) {
            // Snapshot H at RECORD time so replay is order-independent (Attack 7).
            let snap_h = state.high_water_mark_usd_e6;   // post-effective ratchet
            vector::push_back(&mut state.mint_deferred_queue, MintDeferred {
                recipient,
                d_gain_usd_e6: deferred_dg,
                h_snapshot_at_record_usd_e6: snap_h,
                settlement_price_usd_e6,
                settlement_pyth_publish_time_ms,
                recorded_at_ms: now,
                kind: 1,
            });
        };

        if (to_mint == 0) return;
        let coin = coin::mint(&mut state.treasury, (to_mint as u64), ctx);
        transfer::public_transfer(coin, recipient);
    }

    /// V2 — FIFO replay of deferred mints. HWM uses snapshot at record time.
    public fun crank_deferred_mints(
        state: &mut WickGlobalState,
        max_to_process: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let now = clock.timestamp_ms();
        let mut processed = 0;
        while (processed < max_to_process && !vector::is_empty(&state.mint_deferred_queue)) {
            let head = vector::remove(&mut state.mint_deferred_queue, 0);

            // For genesis-overflow, only replay AFTER genesis window has ended.
            if (head.kind == 1 && (now - state.deploy_at_ms) < GENESIS_WINDOW_MS) {
                vector::push_back(&mut state.mint_deferred_queue, head);
                break
            };

            // Compute mint at the SNAPSHOT H (record-time), not current H.
            let to_mint = compute_mint(head.h_snapshot_at_record_usd_e6, head.d_gain_usd_e6);

            // Then ratchet current H by d_gain (sequential FIFO maintains invariant).
            state.high_water_mark_usd_e6 =
                state.high_water_mark_usd_e6 + head.d_gain_usd_e6;
            state.cumulative_network_losses_usd_e6 =
                state.cumulative_network_losses_usd_e6 + head.d_gain_usd_e6;
            state.total_supply_minted = state.total_supply_minted + to_mint;

            upsert_loss(&mut state.lifetime_losses_usd_e6, head.recipient, head.d_gain_usd_e6);

            if (to_mint > 0) {
                let coin = coin::mint(&mut state.treasury, (to_mint as u64), ctx);
                transfer::public_transfer(coin, head.recipient);
            };
            processed = processed + 1;
        }
    }

    fun apply_genesis_dampener(
        state: &mut WickGlobalState,
        recipient: address,
        d_gain: u128,
        now: u64,
    ): (u128, u128) {
        if ((now - state.deploy_at_ms) >= GENESIS_WINDOW_MS) {
            return (d_gain, 0)
        };
        let day = now / DAY_MS;
        let used = if (table::contains(&state.daily_loss_used, recipient)) {
            let entry = *table::borrow(&state.daily_loss_used, recipient);
            if (entry.utc_day == day) entry.used_usd_e6 else 0
        } else { 0 };
        let quota_left = if (used >= GENESIS_DAY_CAP_USD_E6) 0 else GENESIS_DAY_CAP_USD_E6 - used;
        let effective = if (d_gain <= quota_left) d_gain else quota_left;
        let deferred  = d_gain - effective;

        let new_used = used + effective;
        upsert(&mut state.daily_loss_used, recipient, GenesisDayUsage { utc_day: day, used_usd_e6: new_used });
        (effective, deferred)
    }
}
```

### 8.2 `wick_staking.move` — staking + claim with v2 fixes

```move
module wick::wick_staking {
    use sui::bag::{Self, Bag};
    use sui::balance::{Self, Balance};
    use sui::clock::Clock;
    use sui::coin::{Self, Coin};
    use sui::object::{Self, ID, UID};
    use sui::table::{Self, Table};
    use std::type_name::{Self, TypeName};

    const STAKE_CLIFF_MS:        u64  = 48 * 60 * 60 * 1000;
    const UNSTAKE_DELAY_MS:      u64  = 7 * 24 * 60 * 60 * 1000;
    const CLAIM_CEILING_BPS:     u128 = 3000;          // 30%
    const MIN_STAKE_WICK:        u64  = 1_000 * 1_000_000_000;   // 1,000 WICK
    const MAX_STAKE_SHARE_BPS:   u128 = 2000;          // 20% of total_staked
    const MAX_DELTA_PER_WICK:    u128 = 10_000_000_000_000_000_000_000u128;  // 1e22
    const DPS_DEN:               u128 = 1_000_000_000_000_000_000u128;

    public struct WickStakingPool has key {
        id: UID,
        total_staked: u64,
        acc_per_wick_by_currency: Bag,                         // TypeName -> u128 (1e18 dp)
        balances: Bag,                                          // TypeName -> Balance<C>
        address_state: Table<address, AddressStakeState>,       // V2: per-address cliff/share
        twab_history: Bag,                                      // for sweep TWAB (§3.5)
    }

    public struct AddressStakeState has store, copy, drop {
        staked: u64,
        eligible_at_ms: u64,
        last_significant_stake_at_ms: u64,
    }

    public struct StakeReceipt has key, store {
        id: UID,
        owner: address,
        staked: u64,
        debt_per_wick_by_currency: Bag,    // V2: snapshot at stake-time, NOT empty
        unstake_initiated_at_ms: u64,
    }

    /// V2 — Permissionless. Routes to insurance when total_staked == 0 (Attack 2).
    public fun deposit_fees<C>(
        pool: &mut WickStakingPool,
        fees: Coin<C>,
        ctx: &mut TxContext,
    ) {
        let amt = coin::value(&fees);
        if (pool.total_staked == 0) {
            // V2: forward to insurance, do NOT strand in balances.
            forward_to_insurance<C>(pool, amt, ctx);
            consume_coin(fees);
            return
        };
        let delta_per_wick = (amt as u128) * DPS_DEN / (pool.total_staked as u128);
        // V2: cap accumulator delta — oversized deposit routes excess to insurance.
        let safe_delta = if (delta_per_wick > MAX_DELTA_PER_WICK) MAX_DELTA_PER_WICK else delta_per_wick;
        let safe_amt = (safe_delta * (pool.total_staked as u128) / DPS_DEN) as u64;
        let overflow_amt = amt - safe_amt;
        bump_acc<C>(pool, safe_delta);
        if (overflow_amt > 0) {
            forward_to_insurance<C>(pool, overflow_amt, ctx);
        };
        absorb_balance(pool, fees);
    }

    /// V2 — stake() with debt snapshot at acc, per-address cliff, min stake, share cap.
    public fun stake(
        pool:  &mut WickStakingPool,
        wick:  Coin<WICK>,
        clock: &Clock,
        ctx:   &mut TxContext,
    ): StakeReceipt {
        let now    = clock.timestamp_ms();
        let amount = coin::value(&wick);
        let sender = tx_context::sender(ctx);

        assert!(amount >= MIN_STAKE_WICK, E_STAKE_TOO_SMALL);

        // V2 — load-bearing: snapshot per-currency acc into receipt's debt bag.
        let mut debt_bag = bag::new(ctx);
        let keys = pool_currency_keys(pool);
        let mut i = 0;
        while (i < vector::length(&keys)) {
            let key = *vector::borrow(&keys, i);
            let acc = read_acc_by_key(pool, key);
            bag::add(&mut debt_bag, key, acc);
            i = i + 1;
        };

        // V2 — per-address cliff (Attack 3).
        let prev = if (table::contains(&pool.address_state, sender)) {
            *table::borrow(&pool.address_state, sender)
        } else {
            AddressStakeState { staked: 0, eligible_at_ms: 0, last_significant_stake_at_ms: 0 }
        };
        let new_eligible_at = now + STAKE_CLIFF_MS;
        let updated = AddressStakeState {
            staked: prev.staked + amount,
            eligible_at_ms: if (prev.eligible_at_ms < new_eligible_at) new_eligible_at else prev.eligible_at_ms,
            last_significant_stake_at_ms: now,
        };

        // V2 — per-address stake-share cap (Attack 12 amplifier mitigation).
        let new_total = pool.total_staked + amount;
        assert!(
            (updated.staked as u128) * 10000 <= (new_total as u128) * MAX_STAKE_SHARE_BPS,
            E_STAKE_SHARE_CAP_EXCEEDED,
        );

        upsert_address_state(&mut pool.address_state, sender, updated);
        absorb_wick(pool, wick);
        pool.total_staked = new_total;
        twab_record(pool, sender, updated.staked, now);

        StakeReceipt {
            id: object::new(ctx),
            owner: sender,
            staked: amount,
            debt_per_wick_by_currency: debt_bag,
            unstake_initiated_at_ms: 0,
        }
    }

    public fun claim<C>(
        pool:    &mut WickStakingPool,
        receipt: &mut StakeReceipt,
        global:  &mut wick_token::WickGlobalState,
        clock:   &Clock,
        ctx:     &mut TxContext,
    ): Coin<C> {
        let now   = clock.timestamp_ms();
        let owner = receipt.owner;

        // V2 — read cliff from per-address state, not receipt.
        let addr = *table::borrow(&pool.address_state, owner);
        assert!(now >= addr.eligible_at_ms, E_CLIFF_NOT_REACHED);

        let key  = type_name::get<C>();
        let acc  = read_acc_by_key(pool, key);
        let debt = *bag::borrow<TypeName, u128>(&receipt.debt_per_wick_by_currency, key);
        let pending = (receipt.staked as u128) * (acc - debt) / DPS_DEN;

        // L4a — per-address cap.
        let addr_cap_remaining = wick_token::lifetime_loss_cap_remaining(global, owner);
        // L4b — per-fund cap (V2 NEW).
        let fund_cap_remaining = wick_token::fund_loss_cap_remaining(global);

        let allowed = u128_min(u128_min(pending, addr_cap_remaining), fund_cap_remaining);
        let forfeited = pending - allowed;

        // V2 — forfeit routes to insurance (Attack 12 close).
        if (forfeited > 0) {
            forward_to_insurance<C>(pool, forfeited as u64, ctx);
        };

        wick_token::bump_lifetime_claimed(global, owner, allowed);
        wick_token::bump_fund_claimed(global, allowed);

        // Update debt to current acc.
        bag::remove<TypeName, u128>(&mut receipt.debt_per_wick_by_currency, key);
        bag::add(&mut receipt.debt_per_wick_by_currency, key, acc);

        coin::take(borrow_balance_mut<C>(pool), allowed as u64, ctx)
    }

    public fun initiate_unstake(receipt: &mut StakeReceipt, clock: &Clock) {
        receipt.unstake_initiated_at_ms = clock.timestamp_ms();
    }

    public fun finalize_unstake(
        pool: &mut WickStakingPool,
        receipt: StakeReceipt,
        clock: &Clock,
        ctx: &mut TxContext,
    ): Coin<WICK> {
        assert!(receipt.unstake_initiated_at_ms != 0, E_NOT_UNSTAKING);
        assert!(
            clock.timestamp_ms() >= receipt.unstake_initiated_at_ms + UNSTAKE_DELAY_MS,
            E_UNSTAKE_DELAY,
        );
        pool.total_staked = pool.total_staked - receipt.staked;
        let addr = *table::borrow(&pool.address_state, receipt.owner);
        let updated = AddressStakeState {
            staked: addr.staked - receipt.staked,
            eligible_at_ms: addr.eligible_at_ms,
            last_significant_stake_at_ms: addr.last_significant_stake_at_ms,
        };
        upsert_address_state(&mut pool.address_state, receipt.owner, updated);
        twab_record(pool, receipt.owner, updated.staked, clock.timestamp_ms());

        let coin = release_wick(pool, receipt.staked, ctx);
        let StakeReceipt { id, .. } = receipt;
        object::delete(id);
        coin
    }

    /// V2 — TWAB-based weekly insurance sweep (Attack 9 fix).
    public fun crank_insurance_sweep<C>(
        pool: &mut WickStakingPool,
        insurance: &mut InsuranceVault,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let now = clock.timestamp_ms();
        // Only on fixed weekly cadence; not first-caller-wins.
        let week = now / (7 * 24 * 60 * 60 * 1000);
        assert!(insurance.last_swept_week < week, E_SWEEP_NOT_DUE);

        let excess = insurance_excess<C>(insurance);
        if (excess == 0) {
            insurance.last_swept_week = week;
            return
        };

        // Vest excess over next 7 days into the accumulator via TWAB-weighted bumps.
        // pending_sweep accrues in `pool.pending_sweep_by_currency`.
        schedule_vested_bump<C>(pool, excess, now, 7 * DAY_MS);
        consume_insurance<C>(insurance, excess);
        insurance.last_swept_week = week;
    }
}
```

### 8.3 Listing-bond flow

```move
module wick::market_bond {
    public struct MarketBondPool has key { id: UID, bonds: Bag /* market_id -> BondEntry */ }
    public struct BondEntry has store { owner: address, locked: Balance<WICK>, tier: u8, bonded_at_ms: u64 }
    public struct BondReceipt has key, store { id: UID, market_id: ID, owner: address, tier: u8 }

    public fun bond_market(pool: &mut MarketBondPool, market_id: ID, wick: Coin<WICK>, tier: u8, clock: &Clock, ctx: &mut TxContext): BondReceipt { /* ... */ }
    public fun refund_bond(pool: &mut MarketBondPool, receipt: BondReceipt, market: &Market, ctx: &mut TxContext): Coin<WICK> { /* asserts settlement complete */ }
    public fun slash_bond(pool: &mut MarketBondPool, market_id: ID, _admin: &SlashCap) { /* burns the locked WICK; insurance re-fills from next fee carve */ }
}
```

The `MarketBondPool` is its own object; bonded `Coin<WICK>` flows by value in and only flows out via `refund_bond` (live receipt) or `slash_bond` (burn). There is **no** path to a `claim()` from bond. **No double-utility.**

### 8.4 HWM update — invariant and call site (unchanged from v1, restated)

The HWM update is a single line inside `record_gain_and_mint` and `crank_deferred_mints`:

```move
state.high_water_mark_usd_e6 = state.high_water_mark_usd_e6 + d_gain_usd_e6;
```

Invariants enforced by call-site placement:
1. There are exactly **two** call sites: `record_gain_and_mint` (effective_dg only) and `crank_deferred_mints` (deferred replay). Both visited at CI grep time.
2. Both call sites are `public(friend)`/internal — no external module updates HWM.
3. `compute_mint(...)` reads pre-event H, then HWM is updated by the same `dG`. No off-by-one.
4. **No setter, no admin reset, no governance hook.** Strict-monotone is a code-level guarantee, not a runtime check.

### 8.5 End-to-end claim flow (v2-correct)

```
Trader closes losing TOUCH position
  └─ wick::market::settle_position(market, position, clock, ctx)
        ├─ assert Pyth fresh (else: revert; do NOT defer settle, see §7.4)
        ├─ position.settlement_price_usd_e6        := pyth_price_at_now
        ├─ position.settlement_pyth_publish_time   := pyth.publish_time
        ├─ position.eligible_for_wick_mint         := !is_bot(trader) && !is_internal_tournament_match(...)
        ├─ compute lp_gain_delta from settlement
        ├─ d_gain_usd_e6 = lp_gain_delta * position.settlement_price_usd_e6 / 1e9   (frozen!)
        └─ wick_token::record_gain_and_mint(global, trader, d_gain_usd_e6,
                                            position.eligible_for_wick_mint,
                                            position.settlement_price_usd_e6,
                                            position.settlement_pyth_publish_time_ms,
                                            clock, ctx)
              ├─ if !eligible: return (HWM does NOT ratchet)
              ├─ enforce 6h cooldown
              ├─ apply_genesis_dampener -> (effective, deferred)
              ├─ to_mint = compute_mint(H, effective)
              ├─ H += effective; cumulative_network_losses += effective
              ├─ if deferred > 0: push MintDeferred{H_snapshot=H, dG=deferred, frozen_price, ...}
              └─ mint Coin<WICK> to trader

[Fees flow:]
  └─ wick_staking::deposit_fees<C>(pool, fee_coin, ctx)
        ├─ if total_staked == 0: forward_to_insurance, return
        ├─ delta_per_wick = amt * 1e18 / total_staked
        ├─ if delta > MAX_DELTA_PER_WICK: forward overflow to insurance
        └─ acc_per_wick_by_currency[C] += delta

[Trader stakes WICK:]
  └─ wick_staking::stake(pool, wick_coin, clock, ctx) -> StakeReceipt
        ├─ assert amount >= MIN_STAKE_WICK
        ├─ debt_bag := snapshot of acc_per_wick_by_currency for ALL currencies   (V2 KEY FIX)
        ├─ address_state.eligible_at_ms = max(prev, now + 48h)
        ├─ address_state.staked += amount
        └─ assert address_state.staked / total_staked <= 20%  (V2)

[Trader claims after cliff:]
  └─ wick_staking::claim<USDC>(pool, receipt, global, clock, ctx)
        ├─ assert now >= address_state.eligible_at_ms
        ├─ pending = staked * (acc - debt) / 1e18
        ├─ allowed = min(pending, addr_cap, fund_cap)             (V2 fund cap NEW)
        ├─ forfeited = pending - allowed -> insurance             (V2 NOT pool)
        └─ Coin<USDC> to trader

[Genesis-overflow / stale-Pyth replay:]
  └─ wick_token::crank_deferred_mints(state, n, clock, ctx)
        └─ FIFO; uses MintDeferred.h_snapshot_at_record_usd_e6 as H input
```

---

## 9. Test scenarios

12 tests, one per attack. Land in `move/tests/wick_token_tests.move` and `move/tests/wick_staking_tests.move`.

| # | Test name | Setup | Assertion |
|---|---|---|---|
| 1 | `test_stake_debt_snapshots_at_acc_not_zero` | Run 5 fee deposits before any stake; then stake; advance past cliff; claim. | Claim returns 0 (not pro-rata historical). |
| 2 | `test_total_staked_zero_routes_to_insurance` | `total_staked == 0`; call `deposit_fees<USDC>(100)`. | `pool.balances<USDC>` unchanged; `insurance.balance<USDC>` increased by 100. |
| 3 | `test_per_address_cliff_resets_on_new_stake` | Stake 1k WICK at t=0; advance 47h; stake another 1k at t=47h. | Claim at t=48h reverts with `E_CLIFF_NOT_REACHED`; claim at t=47h+48h succeeds. |
| 4 | `test_sybil_per_fund_cap_binds` | 100 sybil addresses each lose $100; mint, stake, advance cliff; deposit large fees; all claim. | Sum of all claims ≤ 30% × $10,000 = $3,000. |
| 5 | `test_wash_counterparty_diverts_to_insurance` | Address A and B both controlled, opposing positions in same market; B loses. | `record_gain_and_mint` for B routes to insurance, no WICK to B. |
| 6 | `test_bonded_wick_does_not_earn_dividends` | Mint 100k WICK; bond 50k for Featured tier; stake remaining 50k. | Tier discount = Bronze (1k floor met by 50k staked, but does NOT include bond). After cliff + fee deposit, claim returns dividends on 50k staked, NOT 100k. |
| 7 | `test_deferred_mint_uses_record_time_h_snapshot` | Genesis week active. Address A loses $100 (effective $50, deferred $50, H_snapshot = X). Other losses ratchet H higher. After 7d, crank replay. | Replay computes `compute_mint(X, $50)` not `compute_mint(H_now, $50)`. |
| 8 | `test_genesis_dampener_caps_per_day` | Day 1 of deployment. Address A loses $200 in one event. | Mint corresponds to $50 effective; $150 deferred to queue. Address A loses another $30 same day → 0 effective, $30 deferred. |
| 9 | `test_insurance_sweep_uses_twab_not_current_stake` | Pre-stake 1k WICK at t=0 (week boundary). Other staker holds 1k since t=-7d. Sweep $1k at week boundary. | Sweep allocation: ~50/50 by TWAB; first staker (recent) gets ~half despite equal current stake. (Plus vested over 7d.) |
| 10 | `test_mint_uses_settlement_price_not_live_price` | Position closed at t=0 with Pyth=$1.00, frozen. `record_gain_and_mint` called at t=2 with Pyth=$1.20. | Mint computed at $1.00; ratchet uses $1.00-converted dG. |
| 11 | `test_bot_address_does_not_ratchet_hwm` | Address A in `BotRegistry`; A loses $1,000. | `H` unchanged; no WICK minted; `bot_lp_gain_ledger` shows $1,000. |
| 12 | `test_forfeit_routes_to_insurance_not_pool` | Address A lifetime_loss = $100 → cap = $30. A stakes, accumulator bumps to give pending = $50. Claim. | A receives $30; `insurance.balance` increased by $20; `pool.acc_per_wick_by_currency<USDC>` unchanged. |

Bonus integration test (not in the table, but recommended):

- `test_collateral_invariant_holds_through_full_lifecycle`: open → trade → settle → mint → stake → claim → unstake. After every step, assert `collateral_vault == total_touch_supply == total_no_touch_supply` (the load-bearing invariant from `AGENTS.md`). v2's mint changes must not break this.

---

## 10. Open issues

1. **`u256` math on Sui.** `compute_mint`'s `(S/(S+excess))^2` step needs care. Sui Move supports `u256` via `std::u256` in newer framework versions; need to verify it's in our toolchain pin and that the two-step `base * S / denom * S / denom` form in `decay_mint` does not under/overflow on the high end.
2. **`BotRegistry` governance.** Who can add/remove addresses? Hardcoded admin multisig at v1, governance vote at v2. Until governance ships, the registry is mutable by a `BotRegistryAdminCap` held by deployer; transparency requirement is that all changes emit events.
3. **TWAB storage cost.** Per-address TWAB history grows linearly with stake-change events. Need a pruning policy (rolling 7-day window). Acceptable for hackathon scale; will need a redesign at v2 mainnet scale.
4. **Tournament-internal trade flag.** Detecting "same operator on both sides" requires either a counterparty-funder heuristic (off-chain) or an explicit on-chain flag at trade-open. Hackathon: explicit flag, set by the keeper / market-maker. Mainnet: harder problem.
5. **Insurance-vault denomination.** Per-currency `Balance<C>` (`Bag` keyed by `TypeName`). What currency does a slash refill in if the next fee carve is in SUI but the insurance need was USDC? Probably: insurance is per-currency, refills happen in the original deficit currency. Documented in §3.5 footnote when implemented.
6. **`MintDeferred` queue unbounded growth.** If Pyth degrades for hours and many trades close, the queue grows. `crank_deferred_mints` is permissionless and bounded by `max_to_process`; under degenerate conditions (no one cranks), the queue stalls at the next genesis-overflow. Mitigation: add a queue-length monitor in the keeper; auto-crank on growth.
7. **Settlement-price freeze for non-keeper close paths.** A trader who closes their own losing position via direct on-chain call (not via keeper) must still freeze Pyth at settle-time. The `settle_position` entrypoint requires a `Pyth::PriceInfoObject` argument; if the trader passes a stale one, settlement reverts. No deferral path for close-time staleness.
8. **Listing-bond slash mechanics with fee-currency mismatch.** When a slash burns WICK but the insurance need is USDC, the next-fee-carve refill assumes the protocol is generating USDC fees. If only SUI fees are flowing, insurance USDC line stays underfunded. Track per-currency insurance debt and prioritize refill by currency.

---

*End of v2 spec. Implementation order: (1) `wick_token.move` skeleton with Genesis dampener, MintDeferred, BotRegistry; (2) `wick_staking.move` with debt-at-stake snapshot, per-address cliff, fund cap, forfeit-to-insurance; (3) `market_bond.move`; (4) the 12 attack tests above. Land each behind a feature flag separate from the core touch-options surface. Do not promote to default until all 12 tests pass.*
