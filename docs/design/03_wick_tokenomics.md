# WICK Tokenomics — Design Spec

**Version:** 0.1 (draft)
**Status:** Design only. No Move code shipped under this spec yet.
**Author seat:** tokenomics design pass, 2026-05-12.
**Lineage:** structurally inspired by `PAPER` (papertrade.xyz). Re-derived for Wick's binary-options primitive at hackathon scale. The PAPER repo is **not** vendored or imported — only the *idea* of "loss-triggered fair-launch mint with strict-monotone ratchet" is reused. Same posture as the Darbitex boundary in `AGENTS.md`.

> **Frame, on every page:** WICK is a **fee receipt token**. It is minted to losing traders as compensation for the fees their loss generated for the protocol. It is not sold to depositors, never marketed as yield, never premined. There is no team allocation, no VC round, no airdrop, no vesting cliff, no treasury wallet that holds WICK at genesis. Total supply at TGE = **0**.

---

## 0. Mental model in one paragraph

A Wick trader closes a losing TOUCH/NO_TOUCH position (or expires out of the money). Their loss flows into the LP pool as profit. That LP gain is the **only** event that mints WICK. The trader who ate the loss receives the WICK directly into their address. Stakers of WICK earn USDC dividends from the protocol's fee carve. As cumulative LP gain grows, the per-dollar mint rate decays (high-water-mark ratchet — never resets). Result: early-loss traders are over-rewarded relative to late-loss traders, supply asymptotes to a finite cap, and the token is structurally a *loss-receipt* rather than a *deposit-yield instrument*.

---

## 1. Mint curve

### 1.1 Closed form

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
    # event straddles the threshold — split into two pieces
    flat_piece = flat * (T - H)
    decay_piece = flat * (H + dG - T) * (S / (S + (H + dG - T)/2))^2
    minted = flat_piece + decay_piece
```

The `(S / (S + H_excess))^2` term is the same shape as PAPER's; the `dG/2` correction integrates the decay across the event so a single $100k loss does not get a different mint than 100 separate $1k losses (within rounding).

### 1.2 Why these parameters at hackathon scale

PAPER's chosen scale is `T = $2M`, `S = $120M` — calibrated for a perps DEX that expects multi-million-dollar daily LP carry. Wick at hackathon scale will see **$1k to $1M total LP gain** across the demo and first weeks of public testnet. Picking PAPER's numbers verbatim would put Wick permanently in the flat region and never trigger the decay narrative — so we shrink both axes by ~100x.

| Param | Value | Justification |
|---|---|---|
| `flat` | 100 WICK / $1 | Identical to PAPER. Round number, easy to communicate, ensures the first $1 lost mints exactly 100 WICK. |
| `T` (flat threshold) | $20,000 | At hackathon LP scale of ~$1k seed liquidity per market and ~50 markets, $20k cumulative LP gain is plausibly hit in the first week of real testnet activity. Below `T` everyone gets the full 100x; above `T` early-adopter-premium kicks in. |
| `S` (decay scale) | $1,200,000 | Sets the asymptote. Chosen so that at `H = $1M` of cumulative gains, the marginal mint rate is `100 * (1.2M / (1.2M + 0.98M))^2 ≈ 30 WICK/$` — a 3.3x compression. At `H = $10M` the marginal is `100 * (1.2M / 11.18M)^2 ≈ 1.15 WICK/$` — a ~87x compression. This curve crosses below 1 WICK/$ around $11M of cumulative gain, which is approximately where Wick stops being a hackathon project. |
| Ratchet | strict-monotone on `H` | `H` only ever increases. Stakers withdrawing WICK, redemptions, treasury sweeps — none of these touch `H`. The single update path is `H += dG` from a recorded LP gain. |
| Min event size | $0.10 USDC equiv | Below this, mint = 0 (rounding floor). Stops dust-spam mint loops. |

### 1.3 What the curve does *not* do

- It does **not** mint on LP deposits. Adding liquidity does not mint WICK.
- It does **not** mint on AMM swap fees in isolation. Only realized losses (closed losing positions, settled-out-of-the-money positions) trigger mints.
- It does **not** mint on winning trades. A winner who pays the protocol fee gets nothing.
- It does **not** retroactively re-mint when the curve decays — past mints are final.

---

## 2. Total-supply projection

Closed-form integral (continuous approximation):

For `H_total >= T`:
```
total_supply ≈ flat * T  +  flat * S^2 * H_excess / (S * (S + H_excess))
            =  flat * T  +  flat * S * H_excess / (1 + H_excess/S)
```
where `H_excess = H_total - T`.

| Cumulative LP gain (`H_total`) | Region | Total WICK supply | Marginal rate at this point | Avg rate so far |
|---|---|---|---|---|
| $1,000 | flat | 100,000 | 100 W/$ | 100 W/$ |
| $10,000 | flat | 1,000,000 | 100 W/$ | 100 W/$ |
| $20,000 | edge of flat | 2,000,000 | 100 W/$ | 100 W/$ |
| $100,000 | decay | ~9,300,000 | ~78 W/$ | 93 W/$ |
| $1,000,000 | decay | ~46,200,000 | ~30 W/$ | 46.2 W/$ |
| $10,000,000 | decay | ~109,200,000 | ~1.15 W/$ | 10.9 W/$ |
| $100,000,000 | decay | ~118,800,000 | ~0.014 W/$ | 1.19 W/$ |
| ∞ (asymptote) | — | `flat*T + flat*S = 2M + 120M = 122M WICK` | 0 | 0 |

**Asymptotic cap:** ~122M WICK total supply, ever.

**Front-loading:** the first $20k of LP gain mints **2M WICK** (1.6% of cap). The first $100k mints **9.3M WICK** (7.6% of cap). The first $1M mints **46M WICK** (38% of cap). By the time the protocol has generated $10M of cumulative LP gains, **89% of all WICK that will ever exist is already minted.** This is the early-trader premium, by design.

The hackathon demo will live entirely in the first row or two of this table — likely 100k–2M WICK minted total during testnet. That is a clean, demonstrable supply story.

---

## 3. Dividend mechanics

### 3.1 Revenue sources

Wick has two revenue lines:
1. **AMM swap fees** — `fee_bps` on every TOUCH/NO_TOUCH swap inside the CPMM. Defaults to 50 bps in `Market`. Paid in market collateral (`SUI` or `USDC`).
2. **Settlement skim** — a small fixed bps (proposed 25 bps of payout) deducted from `redeem_winner` payouts at settlement. Same currency as collateral.

Both are normalized to USDC for accounting (see §6 for how SUI-denominated revenue is converted).

### 3.2 Bucket split

Every dollar of fee revenue is split atomically at the moment of collection:

| Bucket | Share | Destination |
|---|---|---|
| `lp_share` | **60%** | Stays in the originating market's `collateral_vault`, contributing to LP gains (which trigger WICK mint via §1). LPs earn this directly via complete-set redemption / pool ownership. |
| `staker_share` | **30%** | Routed to the `WickStakingPool`. Distributed pro-rata to staked WICK as USDC dividends. |
| `insurance_share` | **10%** | Routed to a permissionless `InsuranceVault`. Used to cover oracle-failure scenarios (e.g., manual `mark_hit` reverted due to oracle outage). Excess above a `$50,000` cap is swept back to `staker_share` weekly. |

### 3.3 Why these percentages

- **60% to LPs** — LPs take real risk (path-dependent settlement can blow up a market's pool). They need the largest share. This is also the share that *re-feeds* the WICK mint curve, creating a flywheel: more LP gains → more WICK minted → more stakers → more dividends → more LPs attracted.
- **30% to stakers** — material enough to make staking a competitive yield. With $1M annualized fee revenue, 30% = $300k/yr to stakers; on a circulating supply of ~10M WICK that's ~3¢/WICK/yr in dividends — a real yield curve, not a vapor airdrop.
- **10% to insurance** — small enough not to starve LPs/stakers, large enough to bootstrap a meaningful oracle-failure backstop in <6 months. The $50k cap and weekly sweep prevent the insurance bucket from becoming a stagnant pool.

### 3.4 `claim()` is permissionless

Distribution uses the standard "rewards-per-share accumulator" pattern:

```move
// in WickStakingPool
acc_usdc_per_wick: u128,   // 18-dp fixed point
total_staked: u64,
// in StakeReceipt
staked_amount: u64,
debt_per_wick: u128,        // snapshot of acc at last claim
```

When fees are deposited:
```
acc_usdc_per_wick += (deposit * 1e18) / total_staked
```

When a staker calls `claim(receipt)`:
```
pending = (staked_amount * (acc_usdc_per_wick - debt_per_wick)) / 1e18
debt_per_wick = acc_usdc_per_wick
transfer(pending, receipt.owner)
```

**Permissionless properties:**
- Anyone can call `deposit_fees(coin)` — no auth check; the pool blindly accepts and updates `acc`.
- Anyone can call `claim()` on their own receipt — no admin path.
- Anyone can call `crank_insurance_sweep()` once the cap is exceeded — no admin path.
- There is no admin key on the staking pool. Pool object is `key`-only, addressed by ID, lookup-shared.

### 3.5 Cap-and-sweep on staker share (PAPER analog)

PAPER caps LP gain above $5M and sweeps the excess to stakers. Wick mirrors this at hackathon scale: **`LP_EXCESS_CAP = $250,000`** per market collateral_vault. Once an individual market's vault crosses this cap, additional gains are diverted to the staker pool until the vault drops back below cap. This prevents one runaway market from infinitely hoarding LP-share fees while stakers see nothing during the early phase.

---

## 4. Demand drivers beyond dividends

Two utilities beyond yield, designed so a trader who never reads the staking docs still has a reason to want WICK.

### 4.1 Driver A — Stake-tier fee discount on losses

**Mechanic:** stakers receive a discount on the **settlement skim** (the 25 bps from §3.1) on their *own* losing positions, scaling with their staked WICK balance. Effectively: the more WICK you stake, the cheaper your losses are.

| Stake tier | Stake floor | Settlement skim | Effective edge |
|---|---|---|---|
| None | 0 | 25 bps | baseline |
| Bronze | 1,000 WICK | 20 bps | 5 bps cheaper losses |
| Silver | 10,000 WICK | 15 bps | 10 bps cheaper |
| Gold | 100,000 WICK | 10 bps | 15 bps cheaper |
| Platinum | 1,000,000 WICK | 5 bps | 20 bps cheaper |

**Why this is the right shape:**
- WICK is minted *to losers*. Stakers are disproportionately losers historically. So stake-tier discounts on losses are aligned: the people who hold WICK are the people who use the discount.
- It is not a fee discount on winning trades — that would attract pure airdrop-farmers staking only to extract tighter spreads on profitable trades.
- The discount is paid out of the `staker_share` bucket (the dividend pool eats the cost). Net-net stakers are cross-subsidizing each other's losses, which is structurally what an *insurance pool* looks like. This is good optics.

### 4.2 Driver B — WICK-bonded market creation

**Mechanic:** anyone can `create_market(...)` for free. But to **list** that market in the official Wick frontend's curated tab (the high-traffic surface), the creator must bond a refundable WICK deposit:

| Listing tier | WICK bond | Frontend treatment |
|---|---|---|
| Open | 0 | Visible only via `?showAll=true` URL param. Not searchable. |
| Indexed | 5,000 WICK | Searchable, appears in "All markets" list, no featured promo. |
| Featured | 50,000 WICK | Appears in the front-page rail. Shows creator handle. |
| Sponsored | 500,000 WICK | Bot-eligible (the personality bots in `bots/` will trade it). Top-of-rail placement. |

**Refund rules:**
- Bond is refundable in full when the market reaches `HIT` or `EXPIRED` and final redemption has settled.
- Bond is **slashed 50%** to the insurance bucket if the market is reported and confirmed as a spam/duplicate (governance vote in v2; in v1, a hardcoded admin multisig that we burn after the curated list stabilizes).
- Bond is non-transferable while locked.

**Why this drives demand:**
- Creates a real, on-chain reason to *acquire and hold* WICK that has nothing to do with dividend yield — namely, market-makers and trading bots that want their own markets surfaced.
- Sinks supply directly: a healthy ecosystem with 200 active featured markets locks 200 × 50,000 = 10M WICK out of circulation (~9% of asymptotic cap).
- Creates a soft governance signal: which markets the community is willing to bond WICK for is a real market-maker preference signal, distinct from off-chain Discord polls.

### 4.3 Why two and not five

Picking five drivers dilutes each one. Two is enough to write down clean unit economics for and ship in v1. Tournament fees, badge-mints, voting rights, governance tokens — all post-MVP; can be layered onto the same staking object later.

---

## 5. Anti-loop protection

The naive attack: trader opens a $10k position, intentionally loses, mints WICK, stakes it, claims dividends *from their own loss*, restakes, and waits for the next attacker to repeat. Without protection this is a perpetual-motion machine for extracting the staker_share bucket.

Strict-monotone ratchet (PAPER's solution) handles part of this: each loss mints *less* WICK than the previous, so the loop has diminishing returns. But it does not eliminate the loop — it only slows it. We need explicit defenses.

### 5.1 Defense layers

**Layer 1 — Mint cooldown per address.** After a WICK mint event credits address `A`, that address cannot trigger another mint for **6 hours**. In Move: a `last_mint_at_ms: Table<address, u64>` lookup before mint. A would-be loop attacker is throttled to 4 cycles/day.

**Layer 2 — Stake unlock window.** Newly staked WICK has a **48-hour cliff** before it accrues dividends. `debt_per_wick` is initialized at the *future* `acc_usdc_per_wick` projected forward 48h, so the staker only earns on flow generated after the cliff. This prevents instant-stake-and-claim of dividends generated by the same loss event.

**Layer 3 — Unstake delay.** Unstaking initiates a **7-day** cooldown before WICK is withdrawable. During cooldown the WICK earns no dividends. Combined with Layer 2, the round-trip "stake → claim → unstake" minimum is 9 days.

**Layer 4 — Cumulative-loss-vs-dividend ceiling per address.** An address's lifetime claimed staking dividends are capped at **30% of that address's lifetime realized losses on Wick**. Once `claimed_dividends >= 0.30 * lifetime_losses`, future dividends accrue but cannot be claimed by that address (they roll back into the staker pool for everyone else). This is the load-bearing economic guard: it makes intentional self-harming impossible to net-positive.

  Implementation note: this requires tracking `lifetime_losses` per address inside the protocol — a `Table<address, u64>` updated at every `redeem_winner`-triggered LP gain. Adds ~1 storage slot per active address. Acceptable.

**Layer 5 — High-water-mark cannot decrement.** Already part of §1. Means even if all WICK is unstaked and burned, the mint curve is locked at the current decay level. No path to "reset" the curve and re-extract flat-region rewards.

### 5.2 Why these specific delays

- 6h mint cooldown — long enough to prevent same-block loops, short enough that a real losing trader getting wrecked twice in a day still mints normally. Tuned to the testnet round cadence (30s rounds → ~720 rounds/day, plenty of room).
- 48h dividend cliff — long enough that the staker can't directly claim from the loss event they just generated (the dividends from a single event distribute within seconds; by 48h they're spread across all stakers active in that window).
- 7d unstake — standard DeFi convention. Long enough to deter mercenary capital. Short enough not to scare off real holders.
- 30% lifetime cap — the hard ceiling that mathematically defeats the loop. Even with perfect execution, an attacker can extract at most 30% of what they paid in losses, which is a guaranteed net-negative trade.

### 5.3 What we explicitly do *not* do

- We do **not** require KYC or address binding.
- We do **not** ban Sybil patterns directly. Layer 4 (lifetime-loss ceiling) is per-address, but a Sybil attacker who splits one $10k loss across 100 fresh addresses still pays $10k and only mints WICK at the curve — Sybil splitting does not increase total mint, only spreads it across addresses.
- We do **not** introduce a "team can pause" lever on staking. The staking pool is unprivileged.

---

## 6. Multi-collateral handling

Wick supports two collateral pools at hackathon scope: `SUI` and `USDC`. The mint curve is denominated in USDC-equivalent for a single canonical reason: WICK supply must have a *single* answer at any moment, and using two parallel curves would create cross-collateral arbitrage on the curve itself.

### 6.1 Normalization

Every LP-gain event is converted to USDC at the moment of accounting:

```move
// inside Market<SUI>
let gain_sui: u64 = compute_lp_gain(...);
let sui_price_usd_e6: u64 = pyth_oracle::sui_usd_price_e6(price_info, clock);
let gain_usd_e6: u64 = (gain_sui as u128 * sui_price_usd_e6 as u128 / 1_000_000_000u128) as u64;
wick_token::record_gain_and_mint(&mut state, recipient, gain_usd_e6, clock);
```

For `Market<USDC>` the conversion is the identity.

### 6.2 Pyth as the conversion oracle

Conversion uses Pyth pull-oracle SUI/USD spot. Same Pyth price feed already used by the keeper for `mark_hit` evaluation. Single oracle dependency, single failure mode.

**Edge case — Pyth feed stale:** if `clock.timestamp_ms() - price.publish_time_ms() > 60_000`, the mint *fails closed* — the LP gain is recorded, but no WICK is minted, and a `MintDeferred` event fires. A later `crank_deferred_mints(...)` call (permissionless) can replay the mint once Pyth is fresh. This preserves the supply story (every $1 of LP gain eventually mints the right WICK) while gracefully handling oracle hiccups.

### 6.3 Why not independent pools

Considered: two separate WICK token contracts (`WICK-SUI` and `WICK-USDC`) with independent curves and dividend pools. Rejected because:

- Two tokens means two listing efforts, two staking UIs, two governance surfaces. Operational nightmare.
- Stakers want one yield-bearing receipt, not two.
- The *only* benefit of independent pools is decoupling curve state across collaterals, which is solved more cleanly by USDC normalization.

### 6.4 Dividend payout currency

Stakers receive dividends in **the original collateral currency of the fee event** (no conversion). A staker therefore accumulates a basket of `Coin<SUI>` and `Coin<USDC>` claims, both claimable independently via `claim_sui()` and `claim_usdc()`. This avoids spot-conversion slippage at the staking pool layer and avoids needing a swap-router dependency in the staking module.

---

## 7. Tax / regulatory framing

The single most important framing decision: **WICK is a fee receipt, not a deposit instrument.**

Wrong frame (security-flavored, do not use):
> "Deposit USDC into Wick markets to earn yield on WICK staking."

Correct frame (used in all UI, README, marketing):
> "When you lose a Wick trade, you receive WICK as a fee receipt — compensation for the protocol fees your loss generated. WICK can be staked to receive a share of future protocol fees."

### 7.1 Why this matters

The Howey test, distilled: investment of money → in a common enterprise → with expectation of profit → derived from the efforts of others. The deposit-yield framing checks *all four boxes*. The fee-receipt framing breaks the first box: **WICK is not purchased**, it is received as compensation for a fee the protocol charged. Stakers in v1 are *receiving back* a portion of fees they themselves paid via past losses (Layer 4 ceiling literally enforces this).

### 7.2 Practical anchors

- **No public WICK sale.** Period. Not at TGE, not later. WICK can only be acquired via (a) losing a trade, (b) buying on a secondary market that lists it later, (c) being paid in WICK by an existing holder.
- **No team allocation.** Founders and contributors who want WICK must lose money on Wick like everyone else. (Optics, but the optics matter.)
- **No "stake to earn" copy.** All staking copy frames as "claim your share of protocol fees" — past tense, not "earn future yield."
- **The cap on lifetime claims** (Layer 4 in §5) doubles as a regulatory anchor: an address's claim is bounded by the fees they personally generated. This makes the per-address stake-and-claim flow look much more like a *fee refund* than a *yield product*.

### 7.3 Disclaimers we will include

Standard "for entertainment / experimental software / not investment advice" boilerplate, plus:
- "WICK has no claim on protocol equity, governance, or treasury assets."
- "WICK is not redeemable for any underlying."
- "Dividend payments are denominated in the original fee collateral and are not guaranteed."

This is design intent, not legal advice. Before any token contract goes to mainnet, a real opinion letter is required. For testnet hackathon scope, the framing above is the operational guide.

---

## 8. Compare to PAPER

| Dimension | PAPER (papertrade.xyz) | WICK (Wick Markets) | Why different |
|---|---|---|---|
| Underlying primitive | Perpetual futures | Touch / no-touch binary options | Different product → different fee surface, different loss event semantics. |
| Mint trigger | Losing close OR liquidation | Losing close (manual exit) OR settlement (HIT for NO_TOUCH holders, EXPIRED for TOUCH holders) | Wick has no liquidations; settlement plays that role. |
| Flat threshold `T` | $2,000,000 | $20,000 | 100x scale-down for hackathon. Real launch would be $100k–$500k. |
| Decay scale `S` | $120,000,000 | $1,200,000 | Same 100x scale-down. Asymptotic cap is 122M WICK vs PAPER's 12.2B. |
| Asymptotic supply | ~12.2B PAPER | ~122M WICK | Smaller cap → easier to communicate, easier to trade. |
| Demand drivers beyond dividends | Implicit (governance, future product surface) | Explicit two: stake-tier loss discount + WICK-bonded market listing | Wick has a curated market surface (PAPER does not — there's only one perp pair per asset). |
| Anti-loop guards | Strict ratchet only | Strict ratchet + 6h mint cooldown + 48h dividend cliff + 7d unstake + 30% lifetime claim cap | Wick's settlement is faster (30s rounds eventually), so loop attempts can iterate much faster than on a perp DEX. We need belt-and-suspenders. |
| Multi-collateral | USDC only | SUI + USDC, USDC-normalized via Pyth | Sui ecosystem is dual-currency native. Forcing USDC-only would lose the whole gas-token-collateralized degen flow. |
| Dividend currency | USDC | Original fee currency (SUI or USDC, claimable independently) | Avoids router dependency in staking module. |
| Insurance bucket | Not in PAPER spec | 10% of fees, capped $50k, sweeps to stakers | Wick's oracle dependency creates a real failure mode (oracle outage during a barrier touch). The bucket pre-funds a backstop. |
| Curve numeraire | USDC linear | USDC-equivalent via Pyth conversion | Forced by multi-collateral. |

The shape of the curve, the ratchet, the no-team-no-VC genesis, the stake-for-dividends pattern — all PAPER. The numbers, the multi-collateral handling, the demand drivers, and the anti-loop layers — all Wick-specific. The two tokens are siblings, not clones.

---

## 9. Move pseudocode

All pseudocode below is **design-level** — function signatures and core math. Final implementation will need full error codes, event emissions, and sui-framework idioms. No file under `move/sources/` should land based on this section alone without a fresh implementation pass.

### 9.1 `wick_token.move` — the curve and mint

```move
module wick::wick_token {
    use sui::balance::{Self, Balance};
    use sui::clock::Clock;
    use sui::coin::{Self, Coin, TreasuryCap};
    use sui::table::{Self, Table};
    use sui::tx_context::TxContext;

    /// Fixed-point: WICK has 9 decimals, USD numeraire has 6 decimals.
    const FLAT_RATE_NUM: u128 = 100;            // 100 WICK per $1
    const FLAT_RATE_DEN: u128 = 1;
    const FLAT_THRESHOLD_USD_E6: u128 = 20_000_000_000;        // $20,000 in 6dp
    const DECAY_SCALE_USD_E6: u128 = 1_200_000_000_000;        // $1,200,000 in 6dp
    const MIN_EVENT_USD_E6: u128 = 100_000;                    // $0.10 in 6dp
    const MINT_COOLDOWN_MS: u64 = 6 * 60 * 60 * 1000;          // 6h

    /// One-of, shared.
    public struct WickGlobalState has key {
        id: UID,
        treasury: TreasuryCap<WICK>,
        high_water_mark_usd_e6: u128,            // strict-monotone H
        total_supply_minted: u128,               // bookkeeping
        last_mint_at: Table<address, u64>,       // address -> ms timestamp
        lifetime_losses_usd_e6: Table<address, u128>,
        lifetime_claims_usd_e6: Table<address, u128>,
    }

    public struct WICK has drop {}

    /// Compute WICK mint for a given LP gain delta starting from the current H.
    /// Pure function — no state mutation. Caller updates H after.
    /// Returns (wick_minted_in_smallest_unit).
    fun compute_mint(
        h_before_usd_e6: u128,
        d_gain_usd_e6: u128,
    ): u128 {
        if (d_gain_usd_e6 < MIN_EVENT_USD_E6) {
            return 0
        };

        let h_after = h_before_usd_e6 + d_gain_usd_e6;

        // Case 1: entirely in the flat region.
        if (h_after <= FLAT_THRESHOLD_USD_E6) {
            return flat_mint(d_gain_usd_e6)
        };

        // Case 2: entirely in the decay region.
        if (h_before_usd_e6 >= FLAT_THRESHOLD_USD_E6) {
            // midpoint H_excess for trapezoidal integration
            let excess_mid = (h_before_usd_e6 + h_after) / 2 - FLAT_THRESHOLD_USD_E6;
            return decay_mint(d_gain_usd_e6, excess_mid)
        };

        // Case 3: straddles the threshold — split.
        let flat_dgain = FLAT_THRESHOLD_USD_E6 - h_before_usd_e6;
        let decay_dgain = h_after - FLAT_THRESHOLD_USD_E6;
        let excess_mid = decay_dgain / 2;
        flat_mint(flat_dgain) + decay_mint(decay_dgain, excess_mid)
    }

    fun flat_mint(d_gain_usd_e6: u128): u128 {
        // d_gain (6 dp) * 100 WICK/$ → result in WICK (9 dp)
        // (d_gain_usd_e6 / 1e6) * 100 * 1e9
        // = d_gain_usd_e6 * 100 * 1e3
        d_gain_usd_e6 * FLAT_RATE_NUM * 1000 / FLAT_RATE_DEN
    }

    fun decay_mint(d_gain_usd_e6: u128, excess_mid_usd_e6: u128): u128 {
        // multiplier = (S / (S + excess))^2
        // base_mint  = flat_mint(d_gain)
        // result     = base_mint * S^2 / (S + excess)^2
        let base = flat_mint(d_gain_usd_e6);
        let denom = DECAY_SCALE_USD_E6 + excess_mid_usd_e6;
        // Compute base * S^2 / denom^2 in u256-ish two-step to avoid overflow.
        // For real implementation, use u256 helpers from sui-framework / std::u256.
        let num = base * DECAY_SCALE_USD_E6 / denom;
        num * DECAY_SCALE_USD_E6 / denom
    }

    /// Permissioned: callable only by `wick::market` modules via a witness pattern.
    public(friend) fun record_gain_and_mint(
        state: &mut WickGlobalState,
        recipient: address,
        d_gain_usd_e6: u128,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let now = clock.timestamp_ms();

        // Layer 1 — mint cooldown
        if (table::contains(&state.last_mint_at, recipient)) {
            let last = *table::borrow(&state.last_mint_at, recipient);
            assert!(now >= last + MINT_COOLDOWN_MS, E_MINT_COOLDOWN);
        };

        let to_mint = compute_mint(state.high_water_mark_usd_e6, d_gain_usd_e6);

        // Strict ratchet — H only ever grows.
        state.high_water_mark_usd_e6 = state.high_water_mark_usd_e6 + d_gain_usd_e6;
        state.total_supply_minted = state.total_supply_minted + to_mint;

        // Track lifetime losses for Layer 4 ceiling.
        let prev_loss = if (table::contains(&state.lifetime_losses_usd_e6, recipient)) {
            *table::borrow(&state.lifetime_losses_usd_e6, recipient)
        } else { 0u128 };
        let new_loss = prev_loss + d_gain_usd_e6;
        upsert(&mut state.lifetime_losses_usd_e6, recipient, new_loss);
        upsert(&mut state.last_mint_at, recipient, now);

        if (to_mint == 0) return;

        let coin = coin::mint(&mut state.treasury, (to_mint as u64), ctx);
        transfer::public_transfer(coin, recipient);
    }
}
```

### 9.2 `wick_staking.move` — staking + dividend claim

```move
module wick::wick_staking {
    use sui::bag::{Self, Bag};
    use sui::balance::{Self, Balance};
    use sui::clock::Clock;
    use sui::coin::{Self, Coin};
    use sui::object::{Self, ID, UID};

    const STAKE_CLIFF_MS: u64 = 48 * 60 * 60 * 1000;         // 48h
    const UNSTAKE_DELAY_MS: u64 = 7 * 24 * 60 * 60 * 1000;   // 7d
    const CLAIM_CEILING_BPS: u128 = 3000;                    // 30% of lifetime losses

    public struct WickStakingPool has key {
        id: UID,
        total_staked: u64,
        // per-currency accumulator: type-name string -> u128 acc_per_wick (1e18 dp)
        acc_per_wick_by_currency: Bag,
        balances: Bag,                        // type-name -> Balance<C>
    }

    public struct StakeReceipt has key, store {
        id: UID,
        owner: address,
        staked: u64,
        eligible_at_ms: u64,                  // staked + 48h
        debt_per_wick_by_currency: Bag,       // type-name -> u128 snapshot
        unstake_initiated_at_ms: u64,         // 0 if not unstaking
    }

    /// Anyone can deposit fees in any supported collateral.
    public fun deposit_fees<C>(
        pool: &mut WickStakingPool,
        fees: Coin<C>,
    ) {
        let amt = coin::value(&fees);
        if (pool.total_staked == 0) {
            // No stakers — drop into balances; first staker sees zero retro.
            absorb_balance(pool, fees);
            return
        };
        let delta_per_wick = (amt as u128) * 1_000_000_000_000_000_000u128 / (pool.total_staked as u128);
        bump_acc<C>(pool, delta_per_wick);
        absorb_balance(pool, fees);
    }

    public fun stake(
        pool: &mut WickStakingPool,
        wick: Coin<WICK>,
        clock: &Clock,
        ctx: &mut TxContext,
    ): StakeReceipt {
        let amt = coin::value(&wick);
        // Burn the WICK into the pool's vault (treated as locked, not destroyed).
        absorb_wick(pool, wick);
        pool.total_staked = pool.total_staked + amt;
        StakeReceipt {
            id: object::new(ctx),
            owner: tx_context::sender(ctx),
            staked: amt,
            eligible_at_ms: clock.timestamp_ms() + STAKE_CLIFF_MS,
            debt_per_wick_by_currency: bag::new(ctx),  // empty = snapshot at zero, but cliff gates payout
            unstake_initiated_at_ms: 0,
        }
    }

    public fun claim<C>(
        pool: &mut WickStakingPool,
        receipt: &mut StakeReceipt,
        global: &mut WickGlobalState,    // for lifetime-loss ceiling check
        clock: &Clock,
        ctx: &mut TxContext,
    ): Coin<C> {
        let now = clock.timestamp_ms();
        assert!(now >= receipt.eligible_at_ms, E_CLIFF_NOT_REACHED);

        let acc = read_acc<C>(pool);
        let debt = read_debt<C>(receipt);
        let pending = (receipt.staked as u128) * (acc - debt) / 1_000_000_000_000_000_000u128;

        // Layer 4 — lifetime claim ceiling
        let cap = lifetime_loss_cap(global, receipt.owner);    // = 30% of lifetime_losses
        let already = lifetime_claimed(global, receipt.owner);
        let allowed = if (already + pending > cap) { cap - already } else { pending };

        // Forfeited portion (pending - allowed) stays in the pool, redistributing on next deposit.
        bump_lifetime_claimed(global, receipt.owner, allowed);
        write_debt<C>(receipt, acc);

        coin::take(borrow_balance_mut<C>(pool), (allowed as u64), ctx)
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
        let coin = release_wick(pool, receipt.staked, ctx);
        let StakeReceipt { id, .. } = receipt;
        object::delete(id);
        coin
    }
}
```

### 9.3 High-water-mark update — invariant and call site

The HWM update is a single line inside `record_gain_and_mint` (above):

```move
state.high_water_mark_usd_e6 = state.high_water_mark_usd_e6 + d_gain_usd_e6;
```

Invariants enforced by call-site placement:
1. There is **exactly one** call site for this update across the whole codebase (the `record_gain_and_mint` function). Found via grep at CI time.
2. `record_gain_and_mint` is `public(friend)` to `wick::market` only — no external module can update HWM.
3. The update is **after** `compute_mint(state.high_water_mark_usd_e6, ...)` reads the old HWM, so the curve uses the pre-event H, and the ratchet records the post-event H. No off-by-one.
4. There is **no setter, no admin reset, no governance hook** on `high_water_mark_usd_e6`. Strict-monotone is a code-level guarantee, not a runtime check.

### 9.4 Claim flow — keeper-friendly

A typical end-to-end flow for one losing trade:

```
Trader closes losing TOUCH position
  └─ wick::market::redeem_winner_or_burn_loser_position(market, position, clock, ctx)
        ├─ position destroyed, collateral stays in vault
        ├─ compute lp_gain_delta from (pre_settlement_pool, post_settlement_pool)
        ├─ normalize to USDC via pyth_oracle::usd_e6(collateral, clock)
        └─ wick_token::record_gain_and_mint(global, trader_addr, gain_usd_e6, clock, ctx)
              ├─ enforce 6h cooldown per address
              ├─ compute_mint(H_before, d_gain) → wick_amount
              ├─ H += d_gain  (strict ratchet)
              └─ mint Coin<WICK> to trader

[Separately, fee bucket carve has already occurred at swap/settle time:]
  └─ wick_staking::deposit_fees<C>(pool, fee_coin)
        └─ acc_per_wick_by_currency[C] += fee / total_staked

[Trader stakes WICK:]
  └─ wick_staking::stake(pool, wick_coin, clock, ctx) → StakeReceipt
        └─ eligible_at = now + 48h

[Trader claims after cliff:]
  └─ wick_staking::claim<USDC>(pool, &mut receipt, global, clock, ctx)
        ├─ enforce eligible_at <= now
        ├─ compute pending = staked * (acc - debt) / 1e18
        ├─ enforce 30% lifetime-loss ceiling
        └─ Coin<USDC> to trader
```

This flow is fully **permissionless** — every step can be cranked by anyone (the keeper bot, a third party, the trader themselves). No admin path exists.

---

## 10. Open questions for next pass

1. **Pyth feed availability on Sui testnet** — confirmed `SUI/USD` exists; need to verify update cadence and the exact `PriceInfoObject` ID we'll pin into the Move module. If unavailable, fall back to a TWAP from `wick::wick_oracle` for testnet only.
2. **`u256` math on Sui** — the `(S / (S + excess))^2` step needs care. Sui Move supports `u256` via `std::u256` in newer framework versions; need to verify it's in our toolchain pin.
3. **Single shared `WickGlobalState` vs sharded** — at hackathon scale, one shared object is fine. At v2 scale, contention on the `last_mint_at` table could become a problem; may need to shard by recipient address suffix.
4. **Bot-trader treatment** — the personality bots in `bots/` will be "losing traders" too and will mint WICK. Do we want bot WICK to be diverted to the insurance bucket, or do we want bot losses to count as real LP gains and mint to bot addresses? Lean toward **letting bots mint** — they paid the loss, and slashing them out would create a special case in the codebase.
5. **TGE timing** — the spec assumes WICK token contract is published before the first real loss. If we ship `wick_token` post-launch, do we retroactively mint based on historical LP gains? Lean toward **no** — start the curve from `H = 0` at deployment of `wick_token`. Past traders are out of luck. Cleaner story.

---

*End of spec. Next steps: review with team, then commit `wick::wick_token` and `wick::wick_staking` skeletons (no logic, just types + signatures + the friend boundaries). Implementation lands behind a feature flag separate from the core touch-options surface.*
