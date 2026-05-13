# Wick v2 — Canonical Interfaces (Reconciliation)

> **Purpose:** Pin canonical interfaces resolving the ~56 cross-doc inconsistencies the validation pass found.
> **Status:** Implementation-blocking. All Phase A code references this doc.
> **Supersedes:** ambiguous parts of v2 docs 01–11 only where named below.

---

## 0. Document priority

When implementing, resolve conflicts in this order:

1. **This doc** (00_reconciliation.md) — canonical
2. **doc 11** (ride streaming primitive) — if implementing ride
3. **doc XX** specific (e.g. doc 02 for impact fee math)
4. **threat-model.md** for security framing

---

## 1. Market.status — canonical 5-value enum

```move
public enum MarketStatus has copy, drop, store {
    Open,
    SettledTouch,
    SettledNoTouch,
    SettledAborted,
    StaleReleased,
}
```

Used by `wick::market`, `wick::path_observation`, `wick::wick_oracle`,
`wick::ride_position`. No other variants exist.

Transitions:
```
Open ──────────────► SettledTouch       (touch fired before expiry, redeemable)
Open ──────────────► SettledNoTouch     (expired without touch, redeemable)
Open ──────────────► SettledAborted     (path failed min_observations, refund 1:1)
Settled* ─────────► StaleReleased       (after retention window, settlement_lock returned)
```

Aborted refunds use `abort_refund_pool: Table<ID, Balance<C>>` sibling to
`settlement_locks` on `MartingalerVault`. Refunds are ranked behind queued
winners (queue-head priority preserved per `01_v2 INV-14`).

---

## 2. lock_and_settle — atomic settlement entry

The SOLE atomic settlement entrypoint on Market<C>. Executes phases in
order. No public function may invoke any of these phases independently.

```move
public fun lock_and_settle<C>(
    market: &mut Market<C>,
    path: &mut PathObservation,
    oracle: &mut WickOracle,
    vault: &mut MartingalerVault<C>,
    fee_router: &mut FeeRouter<C>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    // PHASE 0 — freeze inputs (the v1 doc 01 was missing this)
    path_observation::freeze(path, clock);                     // halts post-expiry record updates
    let fee_snapshot = fee::snapshot_at_lock(market, path);    // captures decisiveness, exposures
    let path_snapshot = path_observation::snapshot(path);      // captures touched_at, max/min/last_seen

    // PHASE 1 — three-way dispatch on path_snapshot
    let kind = if (path_snapshot.aborted) MarketStatus::SettledAborted
               else if (path_snapshot.touched) MarketStatus::SettledTouch
               else MarketStatus::SettledNoTouch;

    // PHASE 2 — reserve obligation per-market
    let max_payout_obligation = match (kind) {
        MarketStatus::SettledTouch => market.touch_exposure(),
        MarketStatus::SettledNoTouch => market.no_touch_exposure(),
        MarketStatus::SettledAborted => market.touch_exposure() + market.no_touch_exposure(),  // 1:1 refund both sides
        _ => abort EInvalidKind,
    };
    martingaler_vault::reserve_for_market<C>(vault, market.id(), max_payout_obligation);

    // PHASE 3 — write status, emit event
    market.set_status(kind);
    fee::store_snapshot(market, fee_snapshot);
    event::emit(MarketSettled { ... canonical schema per §10 });
}
```

`lock_settlement`, `settle_market_*`, and any other v1-named entry points
DO NOT EXIST in v2. Only `lock_and_settle`.

---

## 3. abort_refund_pool — the missing piece

`MartingalerVault<C>` gets one new field:

```move
abort_refund_pool: Table<ID, Balance<C>>,  // keyed by market_id
```

On `MarketStatus::SettledAborted`, both sides' stake is moved into this
pool (escrowed there until users claim 1:1). It does NOT consume from the
queue but IS subordinate to it — the per-market settlement_lock for an
aborted market routes through queue first, then refunds remainder to
abort_refund_pool.

```move
public fun claim_aborted_refund<C>(
    vault: &mut MartingalerVault<C>,
    position: Position<C>,
    ctx: &mut TxContext,
): Coin<C>;  // 1:1 of stake
```

---

## 4. GlobalExposureRegistry — canonical home

ONE shared object, ONE source of truth. Used by both OI cap denominator
(per `04_v2`) AND fee vulnerability denominator (per `02_v2`).

```move
module wick::global_exposure_registry;

public struct GlobalExposureRegistry has key {
    id: UID,
    /// Per-(underlying, side) probability-weighted exposure.
    /// Updated atomically on every position open/close/settle.
    pwe: Table<UnderlyingSideKey, ExposureCell>,
    /// Macro correlation buckets for cross-underlying caps.
    correlation_buckets: VecMap<u8, vector<String>>,
    /// EWMA half-life — uniform 1h for both V_eff and exposures.
    ewma_half_life_ms: u64,  // = 3_600_000
}

public struct UnderlyingSideKey has copy, drop, store {
    underlying: String,    // "BTC", "SUI", "SP500", "RWALK_25"
    side: u8,              // 0 = touch, 1 = no_touch
}

public struct ExposureCell has store {
    /// Σ p_i × payout_i, EWMA-smoothed.
    pwe_smoothed: u64,
    last_update_ms: u64,
}
```

Single setter, called by `market::open` / `market::redeem` / `ride::open` /
`ride::close`:

```move
public(package) fun update<U>(
    reg: &mut GlobalExposureRegistry,
    underlying: String,
    side: u8,
    delta_pwe: i128,        // signed
    clock: &Clock,
);

public fun read_pwe(
    reg: &GlobalExposureRegistry,
    underlying: String,
    side: u8,
    clock: &Clock,
): u64;
```

---

## 5. Probability formula — single canonical

Bachelier first-passage with `p_min = 0.05`. Used by:
- OI cap denominator (`04_v2 §3`)
- Fee vulnerability denominator (`02_v2 §3`)
- Ride cashout factor (`11 §7`)

```move
module wick::probability;

/// Returns P(touch by T | spot, barrier, σ_per_sqrt_sec, seconds_remaining) in 1e9 fixed-point.
/// Floored at 0.05 (5e7 in 1e9 fixed-point).
public fun touch_probability(
    spot: u64,
    barrier: u64,
    sigma_bps_per_sqrt_sec: u64,
    seconds_remaining: u64,
): u64;

/// 32-entry lookup of Φ(-z) for z in bps. Single source of truth.
public fun phi_negative_lookup(z_bps: u64): u64;
```

The `1/payout_multiplier` shortcut in v1 doc 02 is RETIRED.

---

## 6. EWMA half-life — harmonized

ALL EWMAs (V_eff for vault denominator, exposures for caps and fees) use
the same `ewma_half_life_ms = 3_600_000` (1 hour). The v1 60s exposure
half-life from doc 02 is RETIRED — it created the asymmetry that favored
attackers shifting exposure faster than vault state.

---

## 7. InsuranceVault — canonical singleton

ONE shared object. Co-located with MartingalerVault but separately
accounted. Used by both fee_router insurance bucket AND wind-down
emergency reserve AND wick_staking forfeit-to-insurance routing.

```move
module wick::insurance_vault;

public struct InsuranceVault has key {
    id: UID,
    balances: Bag,                      // Balance<C> keyed by TypeName
    /// Dynamic cap: max(50_000_000_usd, vault.V_eff × 5%)
    /// Above cap, sweep excess to wick_staking accumulator.
    cap_micro_usd: u64,
    /// On wind-down, this is the emergency reserve drawn FIRST.
    wind_down_reserve_locked: bool,
}
```

The `$50k flat cap` from v1 doc 03 is RETIRED. Cap is dynamic per `04_v2 §6`.

---

## 8. fee_router — 4-bucket spec

Replaces both v1 doc 01 3-bucket spec AND v1 doc 03 60/30/10 spec. ONE
canonical structure:

```move
module wick::fee_router;

public struct FeeRouter<phantom C> has key {
    id: UID,
    /// Distribution shares in bps, must sum to 10_000.
    /// Default: 5500 LP / 2500 stakers / 1000 insurance / 1000 protocol
    lp_bps: u64,
    staker_bps: u64,
    insurance_bps: u64,
    protocol_bps: u64,
    /// Per-bucket pending balances.
    lp_pending: Balance<C>,
    staker_pending: Balance<C>,
    insurance_pending: Balance<C>,
    protocol_pending: Balance<C>,
    /// Settings cap.
    setter_cap: ID,  // points at AdminCap, hard upper bound on changes
}

public fun accrue<C>(
    router: &mut FeeRouter<C>,
    market_id: ID,
    fee_balance: Balance<C>,
);

public fun crank<C>(
    router: &mut FeeRouter<C>,
    vault: &mut MartingalerVault<C>,           // routes lp_pending here
    insurance: &mut InsuranceVault,            // routes insurance_pending here
    staking: &mut WickStakingPool<C>,          // routes staker_pending here
    protocol: &mut ProtocolTreasury<C>,        // routes protocol_pending here
);
```

`crank` is permissionless. Anyone can drain pending buckets to their final
homes. Documented as the `fee_router::crank` function V1 found missing.

---

## 9. StakeReceipt — single canonical struct

Replaces v1 doc 03 AND v1 doc 08 incompatible variants:

```move
module wick::wick_staking;

public struct StakeReceipt has key, store {
    id: UID,
    owner: address,
    /// Amount of WICK staked.
    staked: u64,
    /// Multi-currency dividend debt accumulator at last update.
    /// Bag<TypeName, u128> for per-collateral accumulator.
    debt_per_wick_by_currency: Bag,
    /// Anchor timestamp for owned-vs-rented (gamification §3).
    acquired_at_ms: u64,
    /// 7d unstake delay anchor. None = not initiated.
    unstake_initiated_at_ms: Option<u64>,
    /// Tier multiplier for leaderboard (gamification §3).
    last_settlement_observed_ms: u64,
}
```

The `amount` / `locked_until` fields from v1 doc 08 are RETIRED (renamed
`staked` and `unstake_initiated_at_ms`). The `acquired_at_ms` /
`last_settlement_observed_ms` fields from doc 08 are PRESERVED.

---

## 10. MarketSettled event — canonical schema

Single source of truth. Generated TS file `frontend/src/types/events.ts`
mirrors this struct exactly; CI fails on drift (Phase R+ task #117).

```move
public struct MarketSettled has copy, drop {
    market_id: ID,
    underlying: String,
    expiry_ms: u64,
    /// 0=touch, 1=no_touch, 2=aborted
    settlement_kind: u8,
    settlement_price: u64,
    settled_at_ms: u64,
    /// Lock priority root for downstream prize-claim verifiers.
    settlement_root: vector<u8>,  // 32-byte hash
    /// Total payout obligation reserved.
    obligation: u64,
    collateral_type: TypeName,
}
```

The doc 07 v1 schema and doc 09 v1 schema are RETIRED.

---

## 11. Position type for BTC route — non-Coin

`WickClaimTicket` (the BTC-route position object) is `has key` ONLY (no
`store`). This means:
- Cannot be transferred between wallets
- Cannot be listed on DeepBook v3 CLOB
- Can only be redeemed by original holder

For MVP. CLOB secondary trading is for Wick-NATIVE markets (random-walk +
SUI + SP500 native variants), not BTC. Per `06_v2` revised assumption.

---

## 12. WICK mint on Predict-route losses

The Wick reserve covers shortfalls on Predict-route losses (per `06_v2`
two-phase settlement). When Wick covers shortfall:

```move
// In predict_route::reconcile_settlement after Predict pays out winners:
let wick_shortfall_covered = max(0, total_wins_owed - predict_returned);
if (wick_shortfall_covered > 0) {
    // Mint WICK to the trader who ABSORBED the loss (i.e. the loser whose
    // Predict position settled to zero)
    wick_token::mint_to_loser(token_state, loser, wick_shortfall_covered_usd, clock);
}
```

WICK is NOT minted on a winning Predict-route trade where Predict's PLP
covered the payout in full. Wick reserve was untouched → no Wick-loss-event
→ no WICK mint.

---

## 13. Ride / discrete interaction

Per `11 §9`:

- Ride positions escrow in `vault.treasury`, NOT `vault.settlement_locks`.
- Ride payouts use the same auto-harvest flow as discrete payouts.
- Queue-head priority is preserved: a ride payout that exceeds available
  vault liquidity routes through the queue per existing FIFO semantics.
- Touch detection: `path::touched_during(path, start, end)` is read-only.
  Race rule: touch wins ties (touch tick lands before any user tx in same
  checkpoint).
- Ride and discrete positions on the SAME market: not supported in MVP.
  A market is either streaming-only or discrete-only at create time
  (`market.is_streaming` is fixed forever).

---

## 14. AdminCap hard caps — Move-enforced

ALL admin-tunable parameters have Move-enforced upper/lower bounds. The
admin entry functions assert before mutating:

| Parameter | Min | Max |
|---|---|---|
| `max_position_pct` | 0.1% | **5%** |
| `max_side_exposure_pct` | 5% | **30%** |
| `max_global_pwe_pct` (per underlying-side) | 5% | **25%** |
| `max_corr_bucket_pct` | 10% | **40%** |
| `base_fee_bps` | **25** | 200 |
| `cap_fee_bps` | base_fee_bps | **800** |
| `cashout_spread_bps` | 100 | **1000** |
| `payout_multiplier_bps` | 11_000 | **50_000** |
| `queue_circuit_breaker_pct` | 30% | **70%** |
| `wind_down_queue_volume_ratio` | 20 | **60** |

```move
public fun set_param(
    cap: &AdminCap,
    config: &mut RiskConfig,
    param_id: u8,
    value: u64,
) {
    assert!(value >= MIN_BOUNDS[param_id], EParamBelowMin);
    assert!(value <= MAX_BOUNDS[param_id], EParamAboveMax);
    config.set(param_id, value);
}
```

The "narrow scope" docstring claim from v1 is REPLACED by Move-enforcement.

---

## 15. Round timing

| Market type | Round duration | Tick rate |
|---|---|---|
| Random-walk Arcade (streaming) | 60 sec | 200 ms (5/sec) |
| Random-walk discrete | 5 min | 200 ms |
| BTC discrete | 30 min | per oracle (~2-5 sec) |
| BTC Predict-route | 30 min | per OracleSVI (~2-5 sec) |
| SUI discrete | 15 min | per Lazer (~1 sec) |
| SP500 discrete | 30 min | per Lazer (~1 sec) |

Streaming markets only exist for Random-walk. All other markets are discrete.

---

## 16. Implementation precedence

When writing Move code:

1. Read this doc first.
2. Read the relevant v2 doc (01-11) for detail and background.
3. If they conflict, this doc wins.
4. If something is unspecified here AND ambiguous in v2, raise as a
   blocking question — do not invent.

End of reconciliation.
