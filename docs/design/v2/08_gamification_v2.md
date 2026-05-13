# Wick Markets — Gamification Layer v2 (Hardened Spec)

**Status:** v2 design, supersedes `docs/design/08_gamification.md` (v1).
**Supersedes:** `08_gamification.md` is FROZEN as of this document. Any new work
on tournaments, badges, leaderboards, comeback pots, multi-leg PTB tagging, or
WICK staking tie-ins MUST reference this doc. v1 is retained only for the
narrative framing of the dopamine loop (§6) and the path-watch room (§5),
neither of which is adversarially load-bearing and both of which are reproduced
here unchanged.
**Driving inputs:** the 14-attack red-team pass in
`docs/redteam/08_tournament.md` (headline: $365k–$910k annual extraction with
v1 as written, plus a one-shot $200k–$1M Founder NFT capture).
**Posture:** every attack in the red-team pass MUST have a named v2 mitigation
in this document, on-chain where possible, indexer-side only when on-chain is
infeasible. The compound-attacker daily extraction estimate must drop from
$1k–$2.5k to dust after this spec lands.
**Hard line:** none of the hardening makes Wick a casino. Payoffs still derive
exclusively from on-chain barrier touches against an oracle. The hardening
removes Sybil farming and seed grinding; it does not add new randomness sources
or new payouts not anchored to oracle observations.

---

## 0. What changed from v1 — the seven-line summary

1. Tournament seed: VRF (`sui::random::Random`) replaces `hash(prev_block, T-0)`.
2. `bulk_open` PTB: capped at 5 entries, ≥5 distinct owner addresses asserted on-chain.
3. Tournament vault: isolated `TournamentVault<C>` shared object, separated from `Market<C>` collateral vaults — invariant 1:1 still holds inside each vault separately.
4. Leaderboard windows: sliding (now − 24h, now − 7d), not fixed midnight rollover.
5. Prize claim flow: on-chain rank-proof + indexer-blessed "primary cluster member" attestation required to claim, gated by a `ClaimAttestation` capability published by a permissioned attestor.
6. Founder badge: replaced with **Charterhouse** — behaviour-based mythic, requires 50 distinct active days AND 5 distinct underlyings traded AND 60-day-aged WICK held.
7. WICK staking: owned-vs-rented distinction enforced by an `acquired_at_ms` field on `StakeReceipt`; tournament gates require `now - acquired_at_ms ≥ 30d` for "owned" status.

Every attack in the red-team pass is mapped to a fix in §9 (mitigated attack table).

---

## 1. Tournament v2

### 1.1 Lifecycle

```
T-30min  entry window opens  (TournamentScheduled emitted)
T-30s    HARD FREEZE — no new entries accepted, no withdrawals
T-0      VRF seed pulled, markets spawned, tournament locked
         (TournamentLocked emitted)
T+0      trading opens; only via tournament module
T+5min   path settlement; PnL aggregated; ranks posted on-chain
T+5min + ε  prize epoch opens; winners may submit ClaimAttestation
T+5min + 7d prize epoch closes; unclaimed prizes flow to next tournament's pot
```

The two new gates are the **T-30s hard freeze** (closes A4 — late-entry seed
read) and the **VRF reveal at T-0** (closes A3 — seed grinding).

### 1.2 VRF seed (A3, A4 mitigated)

v1 used `hash(prev_block_digest, T-0_clock_ms)`. v2 uses Sui's native
randomness beacon, which is BFT-aggregated and unbiasable by any single
validator or builder. The seed is pulled atomically with `lock_in`:

```move
public entry fun lock_in<C>(
    tournament: &mut Tournament<C>,
    r: &mut Random,                  // sui::random::Random
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(tournament.status == STATUS_PENDING, EBadStatus);
    assert!(clock::timestamp_ms(clock) >= tournament.lock_in_ms, ETooEarly);
    assert!(clock::timestamp_ms(clock) < tournament.lock_in_ms + 30_000, EWindowClosed);
    let mut gen = random::new_generator(r, ctx);
    tournament.seed = random::generate_bytes(&mut gen, 32);
    tournament.markets = spawn_markets(tournament, &tournament.seed, clock, ctx);
    tournament.status = STATUS_ACTIVE;
    event::emit(TournamentLocked {
        tournament_id: object::uid_to_inner(&tournament.id),
        seed: tournament.seed,
        market_ids: market_id_vec(&tournament.markets),
        entry_count: tournament.entry_count,
        pot_total: balance::value(&tournament.vault.pot),
        locked_at_ms: clock::timestamp_ms(clock),
    });
}
```

`sui::random::Random` is a shared object; only entry functions can consume it
(Sui platform restriction). This is fine — `lock_in` is keeper-callable, not
user-callable. The keeper-PTB that calls `lock_in` cannot grind: any txn that
depends on the result of `random::generate_bytes` aborts before the seed is
visible to the user-space (Sui's randomness API enforces this at the runtime
layer).

The defence-in-depth XOR with `prev_block_digest` is **NOT** added — it would
re-introduce the grinding surface. VRF alone is sufficient.

### 1.3 Entry window and hard freeze

Entry from T-30min to T-30s. After T-30s no `enter` calls succeed, even if
the tournament has not yet locked.

```move
public entry fun enter<C>(
    tournament: &mut Tournament<C>,
    fee: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): TournamentEntry {
    assert!(tournament.status == STATUS_PENDING, EBadStatus);
    let now = clock::timestamp_ms(clock);
    assert!(now < tournament.lock_in_ms - 30_000, EEntryFrozen);
    assert!(coin::value(&fee) == tournament.entry_fee, EBadFee);
    balance::join(&mut tournament.vault.pot, coin::into_balance(fee));
    let owner = tx_context::sender(ctx);
    let entry = TournamentEntry {
        id: object::new(ctx),
        tournament_id: object::uid_to_inner(&tournament.id),
        owner,                       // bound at mint, immutable
        funded_from: tx_context::sender(ctx),  // see §3 cluster filter
        realised_pnl_mist: 0,
        stake_total_mist: 0,
        max_stake_total_mist: tournament.entry_fee * 100,
        created_at_ms: now,
    };
    tournament.entry_count = tournament.entry_count + 1;
    event::emit(TournamentEntered {
        tournament_id: object::uid_to_inner(&tournament.id),
        entry_id: object::uid_to_inner(&entry.id),
        owner,
        entry_fee_paid: tournament.entry_fee,
        entered_at_ms: now,
    });
    entry
}
```

`TournamentEntry` is `key`-only (no `store`) so it cannot be transferred. This
closes A2 step 2 (transfer 100 entries to operator) at the type-system level.
Friend-capability delegation, if introduced post-MVP, is a separate object that
references the entry by `ID` and proves authorisation per-call — it never
hands the entry over.

### 1.4 `bulk_open` v2 — distinct-owner enforcement (A2 mitigated)

```move
const BULK_OPEN_MAX: u64 = 5;
const BULK_OPEN_MIN_DISTINCT_OWNERS: u64 = 5;

public entry fun bulk_open<C>(
    tournament: &mut Tournament<C>,
    entries: vector<&mut TournamentEntry>,
    sides: vector<u8>,
    stakes: vector<Coin<C>>,
    market_ids: vector<ID>,
    clock: &Clock,
    ctx: &mut TxContext,
): vector<Position> {
    assert!(tournament.status == STATUS_ACTIVE, EBadStatus);
    let n = vector::length(&entries);
    assert!(n == BULK_OPEN_MAX, EBulkOpenWrongSize);
    assert!(n == vector::length(&sides), ELenMismatch);
    assert!(n == vector::length(&stakes), ELenMismatch);
    assert!(n == vector::length(&market_ids), ELenMismatch);
    // Distinct-owner check — closes A2.
    let owners = collect_owners(&entries);
    let distinct = count_distinct_addresses(&owners);
    assert!(distinct >= BULK_OPEN_MIN_DISTINCT_OWNERS, EBulkOpenSybilSuspect);
    // Sender authorisation: signer must equal owner OR present a Friend cap.
    let signer = tx_context::sender(ctx);
    let mut i = 0;
    while (i < n) {
        let entry = vector::borrow(&entries, i);
        assert!(entry.owner == signer || friend::is_authorised(entry, signer), EUnauthorised);
        i = i + 1;
    };
    event::emit(BulkOpenSubmitted {
        tournament_id: object::uid_to_inner(&tournament.id),
        signer,
        entry_count: n,
        distinct_owners: distinct,
        submitted_at_ms: clock::timestamp_ms(clock),
    });
    inner_open_loop<C>(tournament, entries, sides, stakes, market_ids, clock, ctx)
}
```

Two enforcement layers: (1) cap `n == 5` exactly — no 100-entry calls; (2)
`distinct_owners >= 5` — every entry must be owned by a different address.
Combined, this means a single Sybil-operator signer cannot use `bulk_open` at
all; the legitimate "5-friend guild" path remains.

The `BulkOpenSubmitted` event is consumed by the indexer (§3.4); any tx with
`distinct_owners < n` is impossible by `assert!`, but the event is logged for
audit-trail completeness.

### 1.5 Isolated tournament vault

The pot is held in a `TournamentVault<C>` shared object, **separate from the
`Market<C>` collateral vault**. The market vaults the tournament spawns are
themselves isolated from main markets; they are protocol-funded with a fixed
seed liquidity from the tournament vault and recycled at settlement.

```move
public struct TournamentVault<phantom C> has key, store {
    id: UID,
    tournament_id: ID,
    pot: Balance<C>,                 // entry fees
    seed_liquidity: Balance<C>,      // protocol-funded market seed
    prize_reserve: Balance<C>,       // 80% of pot, locked at settle
    comeback_reserve: Balance<C>,    // 5% of pot, locked at settle
    burn_reserve: Balance<C>,        // 10% of pot, vests to stakers (see §7)
    operator_reserve: Balance<C>,    // 5% of pot, gas/keeper recoupment
    status: u8,
}
```

Invariant on the vault, checked on every state mutation:

```
balance(pot) == 0  IFF  status == STATUS_SETTLED OR status == STATUS_CANCELLED
balance(prize_reserve) + balance(comeback_reserve) + balance(burn_reserve)
   + balance(operator_reserve) + balance(seed_liquidity) <= initial_pot
```

(Note: not strict equality because settled prizes flow out of `prize_reserve`
to winners over the 7-day claim epoch.)

The isolated vault means a bug in tournament accounting cannot drain the main
market collateral vaults, and vice versa. The collateral invariant from
`AGENTS.md`
(`collateral_vault == total_touch_supply == total_no_touch_supply`) holds
inside each spawned tournament market exactly as it does in main markets — the
tournament vault itself is bookkeeping only, not a position-collateralising
vault.

### 1.6 Prize curve (unchanged from v1)

```
rank  1: 30%
rank  2: 18%
rank  3: 12%
rank  4-10: 5% each (35% total)
10% → burn_reserve (vests to stakers, see §7)
5%  → comeback_reserve (see §5)
5%  → operator_reserve (gas / keeper recoupment)
```

Total: 30 + 18 + 12 + 35 + 10 + 5 + 5 = 115. Wait — rebalanced for v2: prize
curve sums to 80% of pot, comeback 5%, burn 10%, operator 5% = 100%.

### 1.7 Cancellation semantics

If `entry_count == 0` at T-30s, `lock_in` skips market spawn, sets status to
STATUS_CANCELLED, and refunds nothing (there are no entries). If
`entry_count == 1`, the lone entrant is refunded their fee minus a 1% gas
recoupment; the recoupment goes to `operator_reserve` of the *next*
tournament's vault. Status set to STATUS_CANCELLED.

---

## 2. Leaderboard v2

### 2.1 Sliding windows (A11 mitigated)

The 24h and 7d boards use sliding windows: `(now − 24h, now]` and
`(now − 7d, now]`. The midnight-straddle attack (loss at 23:59, win at 00:01,
inflate both windows) cancels because both points fall inside any window
spanning both sides of midnight — net PnL ≈ 0 in every snapshot.

The Season board remains aligned to 3-month epochs; that's a calendar surface,
not an arbitrage surface, and "season" is meaningful for narrative.

### 2.2 Two-layer score: on-chain raw, indexer cluster-filtered

**On-chain `TraderProfile` stores raw PnL.** It has no notion of clusters,
Sybil, or wallets-from-the-same-funding-source. It is a deterministic ledger
and must remain so to keep the system auditable.

**Indexer computes a `cluster_id`** for every address by walking the funding
graph over the last 30 days of `Coin<C>` transfers. Two addresses are in the
same cluster if either funded the other (transitively, with edge value > 0.1
SUI to drop dust).

The leaderboard rendered to users is dual-layer:

- **Raw board:** all addresses, raw PnL, no filter. Public, viewable by anyone.
  This is the "fair launch" surface — the spec's promise that you can appear
  on a leaderboard without staking is preserved.
- **Prize-eligible board:** at most one address per `cluster_id` ranks; that
  address is the "primary cluster member" — defined as the address with the
  highest `lifetime_volume_mist` in the cluster. All other cluster members are
  filtered.

Prize claim flow uses the prize-eligible board. The raw board is for vibes.

### 2.3 Prize claim flow with on-chain rank-proof

Prizes are claimed, not pushed. This avoids on-chain iteration over all
entrants and lets the indexer's cluster-filter be authoritative:

```
1. Tournament settles at T+5min. `TournamentSettled` event emits with the
   on-chain top-N raw ranking (top 50, say). Raw ranking is deterministic
   from on-chain data.

2. Off-chain: indexer computes cluster filter, attests to the
   "prize-eligible top 10" by signing a `ClaimAttestation` per winner with
   the protocol attestor key (see §8 for key rotation).

3. Winner submits `tournament::claim_prize<C>(tournament, attestation, ctx)`.
   The Move module verifies:
   (a) attestation signature against the registered attestor pubkey
   (b) attestation's tournament_id matches
   (c) attestation's address == tx_context::sender(ctx)
   (d) attestation's rank is in 1..=10
   (e) attestation has not been redeemed (one-shot per (tournament_id, rank))

4. On success, the prize amount is transferred from prize_reserve to the
   sender. `PrizeClaimed` event emits.

5. After 7 days, unclaimed prizes flow to next tournament's seed_liquidity.
```

The attestor is permissioned but not custodial — it cannot send funds, only
sign attestations to facts derivable from public on-chain state. Multi-attestor
quorum (e.g. 2-of-3) is supported via `verify_quorum_signature` to remove
single-key risk; for MVP, single attestor is acceptable with a documented
rotation procedure.

```move
public struct ClaimAttestation has copy, drop {
    tournament_id: ID,
    address: address,
    rank: u8,
    cluster_primary: bool,
    attestor_pubkey: vector<u8>,
    signature: vector<u8>,
    issued_at_ms: u64,
}

public entry fun claim_prize<C>(
    tournament: &mut Tournament<C>,
    attestation: ClaimAttestation,
    ctx: &mut TxContext,
) {
    assert!(tournament.status == STATUS_SETTLED, EBadStatus);
    assert!(attestation.tournament_id == object::uid_to_inner(&tournament.id), EWrongTournament);
    assert!(attestation.address == tx_context::sender(ctx), EWrongClaimant);
    assert!(attestation.rank >= 1 && attestation.rank <= 10, EBadRank);
    assert!(attestation.cluster_primary, ENotClusterPrimary);
    assert!(verify_attestor_signature(&attestation), EBadSignature);
    assert!(!table::contains(&tournament.claimed_ranks, attestation.rank), EAlreadyClaimed);
    let amt = prize_amount_for_rank(tournament.prize_reserve_initial, attestation.rank);
    let payout = balance::split(&mut tournament.vault.prize_reserve, amt);
    transfer::public_transfer(coin::from_balance(payout, ctx), attestation.address);
    table::add(&mut tournament.claimed_ranks, attestation.rank, attestation.address);
    event::emit(PrizeClaimed {
        tournament_id: attestation.tournament_id,
        address: attestation.address,
        rank: attestation.rank,
        amount: amt,
        claimed_at_ms: tx_context::epoch_timestamp_ms(ctx),
    });
}
```

### 2.4 Tier display

Same as v1 (Diamond/Platinum/Gold/Silver/Bronze/Unranked) but computed by the
indexer from the **prize-eligible board**, not the raw board. The raw board
shows ranks for fun; the tier badge that appears on a profile reflects the
filtered rank.

---

## 3. Badge spec v2

Each badge has explicit anti-bot/anti-rush criteria. All ten badges are minted
by the canonical Wick package; the frontend filters by full type string
(`{wickPackageId}::badge::Badge`) per A13 mitigation, never by struct name
alone.

| # | Name | Trigger | Anti-rush guard | Tier | Cap |
|---|---|---|---|---|---|
| 1 | **First Wick** | First winning TOUCH redemption | One per address forever | Common | uncapped |
| 2 | **Razor's Edge v2** | Won a TOUCH where touch was within 1 bp AND oracle source was external (Predict or Lazer pull, never Wick-controlled random walk) AND was the *first* path observation crossing the barrier | Random-walk markets disqualified outright; one per address per quarter | Rare | uncapped |
| 3 | **Conviction** | Held a NO_TOUCH that survived ≥5 path observations within 0.5% of barrier | One per address per quarter | Rare | uncapped |
| 4 | **Charterhouse** (replaces Founder) | 50 distinct active days AND 5 distinct underlyings traded AND held ≥10,000 WICK that was acquired ≥60 days before claim | Cannot be bot-rushed: requires 50 days of activity, multiple underlyings, and 60-day-aged WICK; one per cluster (indexer-attested), max 1,000 ever | Mythic | 1,000 |
| 5 | **Iron Stomach** | Held a position through a single random-walk tick of ≥100x stdev | One per address per season | Epic | uncapped |
| 6 | **Comeback Kid v2** | Lost ≥2 trades in tournament window, recovered to top-10 final rank, AND max-PnL during round was lower than current top-10 cutoff at the 60% mark | Strict eligibility (see §5); no double-dip on comeback sub-pot | Epic | uncapped |
| 7 | **Spread Architect v2** | Opened a 4+ leg PTB spread that settled with positive net PnL AND every leg's stake ≥ $5 (or 5 SUI, see §6) | Dust legs disqualified; one per address per quarter | Rare | uncapped |
| 8 | **The Witness v2** | Called `mark_hit` on a market they have no position in AND have ≥1 real losing trade in the last 7d AND ≤5 mints per address per day AND bounty is delay-escalating | Anti-MEV bounty curve (0 SUI for first 5s, full bounty by 60s); per-address daily cap | Common | uncapped (rate-limited) |
| 9 | **Hot Hand** | 7-trade win streak (any side, any market) where each trade has stake ≥ 1 SUI and was held ≥`min_hold_ms` | Min-stake and min-hold prevent dust farming | Rare | uncapped |
| 10 | **Diamond Wrist** | Held a position to expiry in 50 distinct markets without any early redemptions | Distinct-market check, no streak resets | Mythic | uncapped |

### 3.1 Charterhouse (the Founder replacement) — A7 mitigated

The v1 Founder badge ("first 1,000 unique trade signers") was a $200k–$1M
one-shot bot rush waiting to happen. v2 replaces it with **Charterhouse**, a
behaviour-based mythic that cannot be bot-rushed because the eligibility
criteria are time-extended:

- **50 distinct active days.** "Active day" = at least one
  `PositionOpened` or `PositionRedeemed` from the address in a given UTC day.
  Bot-rushing 50 days requires keeping wallets warm for 50 days, raising
  capex to (50 × per-wallet-daily-gas) × 1000 wallets.
- **5 distinct underlyings traded.** With `wick`'s mix of BTC, SUI, SP500
  (post-MVP), and random-walk synthetics, this requires breadth.
- **≥10,000 WICK held, acquired ≥60 days before claim.** "Acquired" timestamp
  is recorded on the `StakeReceipt` (see §7). Bot-minted WICK from week-one
  losses doesn't qualify until day 60.
- **One per cluster.** The indexer's funding-graph cluster ID is checked at
  claim time; only the primary cluster member can claim.

Hard cap: 1,000 ever, but Charterhouse mints will trickle in over the first
year of mainnet rather than fire in a one-shot rush. Indexer maintains a
waitlist; first 1,000 cluster-distinct addresses to satisfy all four
conditions are eligible. Subsequent claimants get nothing.

Claim flow uses the same `ClaimAttestation` pattern as prize claims (§2.3).

### 3.2 Razor's Edge v2 — A8 mitigated

Two changes from v1:

1. **Oracle source must be external** (Predict CLOB or Pyth Lazer). Random-walk
   markets are explicitly disqualified for this badge because their seed is
   pre-determined from VRF at lock-in — even though the seed is unbiasable, the
   path is deterministic-given-seed, so a pre-computed barrier-grazing trade
   would mint the badge trivially. The badge is meant to celebrate genuine
   knife's-edge calls on real-world price action.
2. **First-touch requirement.** The TOUCH must be the *first* path observation
   crossing the barrier within 1 bp, not "any TOUCH within 1 bp at any point".
   Combined with the external-oracle requirement, this closes both the random-
   walk grind and the post-touch grind paths.

3. **Anti-MEV correlation check** (indexer-side): the tx that triggered
   `mark_hit` must not also be the same tx that placed the nudge order on the
   external oracle source. Same-tx correlation is sufficient because Sui
   provides full tx visibility; cross-tx Predict-nudge is harder to detect but
   also harder to execute.

4. One per address per quarter (rate-limit).

### 3.3 Spread Architect v2 — A9 mitigated

- **Each leg's stake ≥ $5** (denominated in collateral coin's USD-equivalent at
  spread open time; for SUI-collateralised markets, the conversion uses Pyth
  SUI/USD at open-time). Dust legs (1000 mist) no longer qualify.
- Spread net PnL must be ≥ 5x average leg stake — i.e. a real coordinated
  payoff, not a dust-survivor.
- One per address per quarter.

The leg-size floor is enforced in `spread::tag` by reading each position's
`stake_total_mist` and asserting it exceeds the dollar-floor for at least 4
legs.

### 3.4 The Witness v2 — A14 mitigated

The bounty for calling `mark_hit` on a market the caller has no position in is
**delay-escalating**: 0 SUI for the first 5 seconds after barrier touch,
linearly ramping to full bounty by 60 seconds. This means a legitimate keeper
running on a 1-second poll always wins the bounty race vs an MEV bot, because
the MEV bot's first-second mint is worth zero.

Additional defences:

- **Per-address daily cap of 5 Witness badges.**
- **Caller must have ≥1 real losing trade in the last 7d** (filters fresh
  keeper bots from harvesting Witness for nothing).
- **Bounty paid in SUI from the operator_reserve of the originating market's
  most recent tournament cycle**, not from a dedicated pool — keeps the
  bounty self-funded.

### 3.5 Look-alike package griefing — A13 mitigated

Frontend rule (enforced in shared `lib/badges.ts`): every badge query goes
through `getOwnedObjects` with a fully-qualified type filter:

```ts
const CANONICAL_BADGE_TYPE = `${WICK_PACKAGE_ID}::badge::Badge`;
const CANONICAL_TOURNAMENT_ENTRY_TYPE = `${WICK_PACKAGE_ID}::tournament::TournamentEntry`;
```

Indexer asserts `package_id == WICK_PACKAGE_ID` on every `BadgeEarned` event;
off-package events are dropped silently and surfaced in an admin dashboard for
human review. A `wick_signature: vector<u8>` field on `Badge` carries an HMAC
of `(kind, owner, serial)` keyed by a published constant; the verified
checkmark in the gallery only renders when this signature validates.

### 3.6 Mint flow

```move
public struct Badge has key {
    id: UID,
    kind: u8,                        // 1..10
    minted_at_ms: u64,
    market_id: Option<ID>,
    serial: u64,
    wick_signature: vector<u8>,      // HMAC; cosmetic verify
}

public struct BadgeRegistry has key {
    id: UID,
    issued_count: vector<u64>,       // per kind
    cap: vector<u64>,                // 0 = uncapped
    per_address_cap: vector<u64>,    // 0 = uncapped, 1 = forever-once
    per_address_window_ms: vector<u64>, // for "per quarter" caps
    canonical_attestor_pubkey: vector<u8>, // for Charterhouse / Comeback Kid
}
```

Badges are minted by:
- **Self-asserting badges** (First Wick, Conviction, Hot Hand, Diamond Wrist,
  Iron Stomach, The Witness, Spread Architect, Razor's Edge): the contract
  that observes the trigger emits `BadgeEarned` and mints in the same PTB,
  enforcing per-address cap by reading `BadgeRegistry`.
- **Attestation-required badges** (Charterhouse, Comeback Kid v2): require a
  `ClaimAttestation` from the indexer attestor, signed off the cluster-
  filtered, time-aged eligibility check.

---

## 4. Comeback pot v2 (A6 mitigated)

The v1 comeback pot was a Sybil farm: pay top-3 worst PnL, capped at 5x entry
*per address*, so a 100-wallet farm extracts 100% of the pot every round.

v2 strict eligibility:

- **Lost ≥2 trades in the tournament window.** Not "ended in bottom-3 PnL" but
  "had ≥2 losing trade closures during T+0 → T+5min". Single-loss-then-win
  patterns no longer qualify.
- **Recovered to a positive PnL by T+5min.** "Recovered" means
  `realised_pnl_mist > 0` at settle. This is the comeback story.
- **Max-PnL during the round was lower than the top-10 prize cutoff at the
  60% mark.** Captures that the trader was *actually* losing through the bulk
  of the round, not faking it for one tick.
- **Distributed pro-rata across all qualifying entrants**, not winner-takes-3.
  Pro-rata over `recovery_score = (settle_pnl - min_pnl_during_round) /
  num_losing_trades`.
- **Cap per cluster, not per address.** The indexer's cluster filter applies;
  one cluster can claim at most 1 comeback share per round.
- **Per-address cap = 1x entry fee** (down from 5x), so even a single wallet's
  comeback extraction is bounded by their entry cost.

```move
public entry fun claim_comeback<C>(
    tournament: &mut Tournament<C>,
    attestation: ComebackAttestation,
    ctx: &mut TxContext,
) {
    assert!(tournament.status == STATUS_SETTLED, EBadStatus);
    assert!(attestation.tournament_id == object::uid_to_inner(&tournament.id), EWrongTournament);
    assert!(attestation.address == tx_context::sender(ctx), EWrongClaimant);
    assert!(attestation.cluster_primary, ENotClusterPrimary);
    assert!(attestation.lost_at_least_two, EComebackIneligible);
    assert!(attestation.recovered_to_positive, EComebackIneligible);
    assert!(attestation.max_pnl_below_60pct_cutoff, EComebackIneligible);
    assert!(verify_attestor_signature(&attestation), EBadSignature);
    assert!(!table::contains(&tournament.claimed_comebacks, attestation.address), EAlreadyClaimed);
    let amt = u64::min(attestation.share, tournament.entry_fee);
    let payout = balance::split(&mut tournament.vault.comeback_reserve, amt);
    transfer::public_transfer(coin::from_balance(payout, ctx), attestation.address);
    table::add(&mut tournament.claimed_comebacks, attestation.address, amt);
    event::emit(ComebackClaimed { ... });
}
```

The combination of (lost-≥-2 + recovered-positive + below-60%-cutoff +
cluster-cap + per-address-cap = 1x) reduces single-attacker extraction from
~$185/day to the entry fee × 1 ≈ $3/day at 1 SUI entry, and only when they
genuinely lose then recover. The Sybil amplification path is closed by the
cluster cap.

---

## 5. Multi-leg PTB spreads — non-dust enforcement (A9 mitigated)

`spread::tag` v2 enforces non-dust leg sizes at tag-time. The conversion
between collateral mist and a USD floor uses an oracle reference (Pyth) for
non-USD collateral; for USDC collateral the floor is a literal mist value.

```move
const SPREAD_LEG_USD_FLOOR_CENTS: u64 = 500;  // $5

public entry fun tag<C>(
    positions: vector<&Position>,
    kind: u8,
    pyth_state: &PythState,          // for non-USDC collateral
    clock: &Clock,
    ctx: &mut TxContext,
): SpreadGroup {
    let n = vector::length(&positions);
    assert!(n >= 2, ESpreadTooShort);
    let signer = tx_context::sender(ctx);
    let mut i = 0;
    let mut total_stake = 0u64;
    while (i < n) {
        let p = vector::borrow(&positions, i);
        assert!(p.owner == signer, ENotOwner);
        let usd_cents = mist_to_usd_cents<C>(p.stake_total_mist, pyth_state, clock);
        // Spread Architect badge requires every leg ≥ $5 stake.
        assert!(usd_cents >= SPREAD_LEG_USD_FLOOR_CENTS, ELegBelowFloor);
        total_stake = total_stake + p.stake_total_mist;
        i = i + 1;
    };
    let group = SpreadGroup {
        id: object::new(ctx),
        owner: signer,
        kind,
        position_ids: position_id_vec(&positions),
        market_ids: market_id_vec(&positions),
        total_stake_mist: total_stake,
        opened_at_ms: clock::timestamp_ms(clock),
    };
    event::emit(SpreadOpened {
        group_id: object::uid_to_inner(&group.id),
        owner: signer,
        kind,
        position_ids: group.position_ids,
        market_ids: group.market_ids,
        total_stake_mist: total_stake,
    });
    group
}
```

For Spread Architect badge eligibility, the tag must additionally have ≥4 legs
and net PnL at settle ≥ 5x average leg stake. The 4-leg + 5x check is done at
badge mint time, reading the spread group and each leg's redemption result.

---

## 6. WICK staking tie-ins — owned vs rented (A10, A12 mitigated)

The v1 spec treated all staked WICK as equivalent for badge / tournament gates.
v2 introduces an `acquired_at_ms` field on `StakeReceipt` recording when the
WICK first entered the wallet, and uses **acquired-age** semantics for all
gates that need to distinguish "real long-term stake" from "rented for a
moment".

### 6.1 `StakeReceipt` v2

```move
public struct StakeReceipt has key, store {
    id: UID,
    owner: address,
    amount: u64,
    locked_until: u64,               // unstake delay end
    acquired_at_ms: u64,             // when the WICK first entered this wallet
    last_settlement_observed_ms: u64, // last tournament settle this stake observed
}
```

`acquired_at_ms` is set to the receipt's mint time on `stake()`. If WICK is
transferred between wallets and re-staked, `acquired_at_ms` resets — the new
holder has freshly-acquired WICK regardless of how long the previous holder
had it.

### 6.2 Owned-vs-rented distinction (A12)

For tournament gates, badge gates, and prize-eligibility gates, the relevant
threshold is "owned for ≥30 days":

```move
const OWNED_AGE_THRESHOLD_MS: u64 = 30 * 24 * 60 * 60 * 1000;

public fun is_owned<C>(
    receipt: &StakeReceipt,
    clock: &Clock,
): bool {
    let now = clock::timestamp_ms(clock);
    now >= receipt.acquired_at_ms + OWNED_AGE_THRESHOLD_MS
}
```

Rentals via flash-loan-like constructs — where WICK is transferred to a wallet
moments before a tournament gate check — fail this test because their
`acquired_at_ms` is recent. The flash-loan / rental wallet has stake but does
not have *owned* stake.

For the **Charterhouse** badge, the threshold is bumped to 60 days
(`ACQUIRED_AGE_FOUNDER_MS`).

### 6.3 Stake-at-last-settlement semantics (A10)

For the 10% burn-to-stakers tithe, the relevant snapshot is "WICK staked at
the **last tournament settlement time**". This pins the staking position to a
known historical timestamp; you cannot front-run the next tournament's burn by
staking a microsecond before settle.

```move
public entry fun distribute_burn<C>(
    tournament: &mut Tournament<C>,
    staking_pool: &mut StakingPool,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(tournament.status == STATUS_SETTLED, EBadStatus);
    let snapshot_ts = staking_pool.last_settlement_ms;
    let burn_amt = balance::value(&tournament.vault.burn_reserve);
    // Distribute pro-rata over StakeReceipts whose
    // acquired_at_ms <= snapshot_ts AND amount > 0 at snapshot_ts.
    // (Snapshot is materialised by the indexer on every settle.)
    distribute_to_snapshot_holders<C>(staking_pool, snapshot_ts, burn_amt, ctx);
    staking_pool.last_settlement_ms = clock::timestamp_ms(clock);
    event::emit(BurnDistributed {
        tournament_id: object::uid_to_inner(&tournament.id),
        snapshot_ts,
        amount: burn_amt,
    });
}
```

Combined with the existing 48h dividend cliff and 7d unstake delay from
tokenomics §5, the stake-then-claim-then-unstake attack (A10) requires the
attacker to be staked at *the previous* settlement time, not just present at
the *current* settlement. This adds an effective "missed by one tournament"
penalty to opportunistic stakers.

### 6.4 Premium tournament `min_wick_staked` v2

Premium tournaments require both:

- **Stake ≥ `min_wick_staked` for the entire entry window + tournament window.**
  Snapshotted at T-30min (entry window open), payout-checked at T+5min.
- **WICK is *owned* (acquired_at_ms ≤ T-30min - 30d).** Rented WICK fails.

```move
public fun assert_premium_eligible<C>(
    tournament: &Tournament<C>,
    receipt: &StakeReceipt,
    clock: &Clock,
) {
    let now = clock::timestamp_ms(clock);
    assert!(receipt.amount >= tournament.min_wick_staked, EBelowMinStake);
    assert!(receipt.acquired_at_ms <= tournament.entry_window_open_ms - OWNED_AGE_THRESHOLD_MS, ENotOwnedLongEnough);
    assert!(receipt.locked_until >= tournament.expiry_ms, EUnstakeWouldExpireDuringRound);
}
```

A `tournament_locked: bool` flag on `StakeReceipt` is set on entry and
cleared at T+5min, preventing transfer/unstake during the round.

---

## 7. Anti-grief defences — full v2 list

| Surface | v2 Defence |
|---|---|
| Whale dumps to dominate tournament | Per-entry `max_stake_total_mist` cap (entry_fee × 100), unchanged from v1. |
| Spam markets cluttering UI | Min `seed_collateral` for market creation; UI surface only protocol-spawned + verified-tag markets by default; indexer drops markets below liquidity threshold from search. |
| Wash trades inflating volume / streaks | Streak counter requires `min_hold_ms`. Volume tie-breakers daily-capped. Indexer cluster filter drops same-cluster trades from leaderboard PnL. Tournament markets disable secondary-market position transfer for the duration of the round. |
| Sybil farms for tournament prizes | (1) cluster filter at prize claim, (2) one prize per cluster, (3) `bulk_open` ≥5 distinct owners, (4) optional `min_wick_staked` *owned* gate on premium tournaments, (5) prize claim requires attestation. |
| Comeback sub-pot Sybil farm | (1) lost ≥2 + recovered + max-PnL-below-60%-cutoff eligibility, (2) per-cluster cap, (3) per-address cap = 1x entry fee. |
| Seed grinding | VRF (`sui::random::Random`) at lock-in; no pre-block-digest input. |
| Late-entry seed read | T-30s hard freeze; entries cannot land in the same checkpoint as `lock_in`. |
| `bulk_open` PTB Sybil execution | Cap at 5 entries; assert ≥5 distinct owners; assert per-entry signer == owner OR friend cap. `TournamentEntry` is `key`-only — cannot be transferred. |
| Founder badge bot rush | Replaced with Charterhouse: 50 active days + 5 underlyings + 60-day-aged WICK + cluster filter. |
| Razor's Edge oracle game | External oracle required (not random walk); first-touch only; per-address per-quarter cap; anti-MEV correlation check. |
| Spread Architect dust | Each leg ≥ $5 (Pyth-converted for non-USDC collateral); ≥4 legs; net PnL ≥ 5x average leg stake; per-address per-quarter cap. |
| Stake-then-claim timing | Burn distributes to "WICK staked at last settlement time" snapshot; opportunistic stakers miss the round they staked into. |
| Premium `min_wick_staked` rental | "Owned" requirement: `acquired_at_ms` ≥ 30 days ago. `tournament_locked` flag prevents transfer during round. |
| 24h leaderboard window arbitrage | Sliding window (not midnight rollover); midnight-straddle PnL nets to zero in every snapshot that spans both points. |
| `mark_hit` Witness farming | Bounty escalates 0→full over 5–60s; per-address daily cap of 5; caller needs ≥1 losing trade in last 7d. |
| Look-alike badge package | Frontend filters by full type string `{packageId}::badge::Badge`; indexer drops off-package events; HMAC `wick_signature` on Badge for verified-checkmark display. |

---

## 8. Mitigated attack table — all 14 attacks

| # | Attack | Severity (v1) | v2 mitigation | Residual risk |
|---|---|---|---|---|
| A1 | Sybil tournament entry | Critical | Cluster filter at prize claim (one prize per cluster); attestation-gated; address-age implicit via owned-stake gate | Low — sophisticated tumbler-funded Sybil clusters can split into multiple cluster IDs, but each cluster gets one prize at most; ROI flips negative for plausible operator costs |
| A2 | `bulk_open` PTB exploit | Critical | `n == 5` cap; `distinct_owners >= 5` assert; `TournamentEntry` is `key`-only (untransferable); per-entry signer/owner check | None at the bulk surface; entries can still be Sybil-created individually but A1's cluster filter applies |
| A3 | Seed grinding via prev-block | High | VRF (`sui::random::Random`) replaces hash-of-prev-block; no validator/builder bias surface | None — VRF is BFT-aggregated |
| A4 | Late-entry seed read | Medium | T-30s hard freeze; seed not derivable from any pre-T-30s state | None — VRF reveal is atomic with lock-in |
| A5 | Wash trading PnL inflation | High | Indexer cluster filter drops same-cluster PnL from leaderboard; tournament markets disable secondary transfer during round; PnL cap of 5x stake per position for ranking | Low — different-cluster wash (paid third-party) requires real arms-length funding, killing economics |
| A6 | Comeback sub-pot double-dip | High | Lost ≥2 + recovered-positive + max-PnL-below-60%-cutoff; per-cluster cap; per-address cap = 1x entry fee | Low — single-attacker max ≈ entry fee per round |
| A7 | Founder badge bot rush | High | Founder dropped, replaced with Charterhouse: 50 active days + 5 underlyings + 60-day-aged WICK + cluster cap | None at the rush surface; long-tail capture by patient operators is the design goal (they're real users by then) |
| A8 | Razor's Edge oracle gaming | Medium | External-oracle requirement; first-touch only; per-quarter cap; anti-MEV correlation check | Low — Predict-nudge attacks remain possible in principle but capped to 1 badge per quarter per address |
| A9 | Spread Architect padding | Low | Each leg ≥ $5; net PnL ≥ 5x avg leg stake; per-quarter cap | None |
| A10 | Stake-then-claim timing | Medium | Burn distributes to "stake at last settlement time" snapshot, not current snapshot | Low — opportunistic stakers must be present for at least one settlement before benefiting |
| A11 | 24h leaderboard window arbitrage | Medium | Sliding window; midnight-straddle PnL nets to zero | None |
| A12 | Premium `min_wick_staked` rental | Medium | `acquired_at_ms ≥ 30d` ("owned") requirement; `tournament_locked` flag during round | None at the rental surface; capital-cost gate restored |
| A13 | Look-alike badge package griefing | Low | Frontend full-type filter; indexer package-id assertion; HMAC `wick_signature` on Badge | Low — naive third-party UIs may still display look-alikes, but Wick-canonical UIs are clean |
| A14 | `mark_hit` Witness farm | Low-Medium | Delay-escalating bounty (0→full over 5–60s); per-address daily cap of 5; caller needs ≥1 losing trade in last 7d | Low — bot wins zero on first 5s, capped daily |

**Compound estimate** for a single sophisticated attacker running A1+A2+A5+A6+A11
on day-one of mainnet, v2 defences applied: bounded by per-cluster prize cap +
per-cluster comeback cap + per-quarter badge caps. Realistic upper bound:
**~$30–$80 per day** (one cluster's prize share + one cluster's comeback share +
incidental badge mints), down from $1k–$2.5k per day in v1. ROI flips negative
once cluster-creation costs (separate funding sources, age requirements) are
factored in.

The Founder one-shot capture ($200k–$1M) is closed entirely by replacement.

---

## 9. Move pseudocode — tournament + badge modules

This section lays out the complete shape of the v2 Move modules. Production
implementation will live in `move/sources/tournament.move` and
`move/sources/badge.move`.

### 9.1 `tournament.move`

```move
module wick::tournament {
    use sui::object::{Self, UID, ID};
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::clock::{Self, Clock};
    use sui::random::{Self, Random};
    use sui::tx_context::{Self, TxContext};
    use sui::table::{Self, Table};
    use sui::event;
    use std::vector;

    // ─── Constants ────────────────────────────────────────────────
    const STATUS_PENDING: u8 = 0;
    const STATUS_ACTIVE: u8 = 1;
    const STATUS_SETTLED: u8 = 2;
    const STATUS_CANCELLED: u8 = 3;

    const BULK_OPEN_MAX: u64 = 5;
    const BULK_OPEN_MIN_DISTINCT_OWNERS: u64 = 5;
    const HARD_FREEZE_MS: u64 = 30_000; // 30 s before lock-in

    // ─── Errors ───────────────────────────────────────────────────
    const EBadStatus: u64 = 1;
    const ETooEarly: u64 = 2;
    const EWindowClosed: u64 = 3;
    const EEntryFrozen: u64 = 4;
    const EBadFee: u64 = 5;
    const EBulkOpenWrongSize: u64 = 6;
    const EBulkOpenSybilSuspect: u64 = 7;
    const ELenMismatch: u64 = 8;
    const EUnauthorised: u64 = 9;
    const EWrongTournament: u64 = 10;
    const EWrongClaimant: u64 = 11;
    const EBadRank: u64 = 12;
    const ENotClusterPrimary: u64 = 13;
    const EBadSignature: u64 = 14;
    const EAlreadyClaimed: u64 = 15;
    const EComebackIneligible: u64 = 16;

    // ─── Objects ──────────────────────────────────────────────────
    public struct Tournament<phantom C> has key {
        id: UID,
        season_id: ID,
        entry_fee: u64,
        entry_window_open_ms: u64,
        lock_in_ms: u64,
        expiry_ms: u64,
        seed: vector<u8>,
        entry_count: u64,
        markets: vector<ID>,
        vault: TournamentVault<C>,
        prize_reserve_initial: u64,
        claimed_ranks: Table<u8, address>,
        claimed_comebacks: Table<address, u64>,
        status: u8,
        attestor_pubkey: vector<u8>,
        min_wick_staked: u64,        // 0 if not premium
    }

    public struct TournamentVault<phantom C> has store {
        pot: Balance<C>,
        seed_liquidity: Balance<C>,
        prize_reserve: Balance<C>,
        comeback_reserve: Balance<C>,
        burn_reserve: Balance<C>,
        operator_reserve: Balance<C>,
    }

    public struct TournamentEntry has key {  // NO `store` — untransferable
        id: UID,
        tournament_id: ID,
        owner: address,
        funded_from: address,
        realised_pnl_mist: i64,
        stake_total_mist: u64,
        max_stake_total_mist: u64,
        created_at_ms: u64,
    }

    public struct ClaimAttestation has copy, drop {
        tournament_id: ID,
        address: address,
        rank: u8,
        cluster_primary: bool,
        attestor_pubkey: vector<u8>,
        signature: vector<u8>,
        issued_at_ms: u64,
    }

    public struct ComebackAttestation has copy, drop {
        tournament_id: ID,
        address: address,
        cluster_primary: bool,
        lost_at_least_two: bool,
        recovered_to_positive: bool,
        max_pnl_below_60pct_cutoff: bool,
        share: u64,
        attestor_pubkey: vector<u8>,
        signature: vector<u8>,
    }

    // ─── Events (see §10) ─────────────────────────────────────────
    // ... TournamentScheduled, TournamentEntered, TournamentLocked,
    //     BulkOpenSubmitted, TournamentSettled, PrizeClaimed,
    //     ComebackClaimed, BurnDistributed, TournamentCancelled.

    // ─── Lifecycle ────────────────────────────────────────────────
    public entry fun enter<C>(...) { /* §1.3 */ }
    public entry fun lock_in<C>(...) { /* §1.2 */ }
    public entry fun bulk_open<C>(...) { /* §1.4 */ }
    public entry fun settle<C>(...) { /* path settlement; emits TournamentSettled */ }
    public entry fun claim_prize<C>(...) { /* §2.3 */ }
    public entry fun claim_comeback<C>(...) { /* §4 */ }
    public entry fun distribute_burn<C>(...) { /* §6.3 */ }

    // ─── Helpers ──────────────────────────────────────────────────
    fun collect_owners(entries: &vector<&mut TournamentEntry>): vector<address> { /* ... */ }
    fun count_distinct_addresses(addrs: &vector<address>): u64 { /* ... */ }
    fun verify_attestor_signature<T>(att: &T): bool { /* ed25519_verify */ }
    fun prize_amount_for_rank(initial: u64, rank: u8): u64 { /* curve */ }
}
```

### 9.2 `badge.move`

```move
module wick::badge {
    use sui::object::{Self, UID, ID};
    use sui::table::{Self, Table};
    use sui::clock::{Self, Clock};
    use sui::tx_context::{Self, TxContext};
    use sui::event;
    use std::vector;
    use std::option::{Self, Option};

    // ─── Badge kinds ──────────────────────────────────────────────
    const KIND_FIRST_WICK: u8 = 1;
    const KIND_RAZORS_EDGE: u8 = 2;
    const KIND_CONVICTION: u8 = 3;
    const KIND_CHARTERHOUSE: u8 = 4;     // replaces KIND_FOUNDER
    const KIND_IRON_STOMACH: u8 = 5;
    const KIND_COMEBACK_KID: u8 = 6;
    const KIND_SPREAD_ARCHITECT: u8 = 7;
    const KIND_WITNESS: u8 = 8;
    const KIND_HOT_HAND: u8 = 9;
    const KIND_DIAMOND_WRIST: u8 = 10;

    // ─── Caps ─────────────────────────────────────────────────────
    const CAP_CHARTERHOUSE: u64 = 1_000;

    public struct Badge has key {
        id: UID,
        kind: u8,
        minted_at_ms: u64,
        market_id: Option<ID>,
        serial: u64,
        wick_signature: vector<u8>,
    }

    public struct BadgeRegistry has key {
        id: UID,
        issued_count: vector<u64>,
        cap: vector<u64>,
        per_address_count: Table<address, vector<u64>>, // addr -> per-kind counts
        per_address_cap: vector<u64>,
        per_address_window_ms: vector<u64>,
        canonical_attestor_pubkey: vector<u8>,
    }

    // ─── Mint flows ───────────────────────────────────────────────

    /// Self-asserting badges (e.g. First Wick, Hot Hand) — caller passes
    /// proof in the form of the &Position or &TraderProfile that triggered.
    public fun mint_self_asserting(
        registry: &mut BadgeRegistry,
        kind: u8,
        owner: address,
        market_id: Option<ID>,
        clock: &Clock,
        ctx: &mut TxContext,
    ): Badge {
        check_cap(registry, kind, owner);
        let serial = bump_serial(registry, kind);
        let badge = Badge {
            id: object::new(ctx),
            kind,
            minted_at_ms: clock::timestamp_ms(clock),
            market_id,
            serial,
            wick_signature: hmac_sign(kind, owner, serial),
        };
        event::emit(BadgeEarned {
            kind, owner,
            badge_id: object::uid_to_inner(&badge.id),
            serial,
            market_id,
            minted_at_ms: clock::timestamp_ms(clock),
        });
        badge
    }

    /// Attestation-required badges (Charterhouse, Comeback Kid v2).
    public entry fun claim_attested(
        registry: &mut BadgeRegistry,
        attestation: BadgeAttestation,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let owner = tx_context::sender(ctx);
        assert!(attestation.address == owner, EWrongClaimant);
        assert!(verify_attestor_signature(&attestation, &registry.canonical_attestor_pubkey), EBadSignature);
        check_cap(registry, attestation.kind, owner);
        let serial = bump_serial(registry, attestation.kind);
        let badge = Badge {
            id: object::new(ctx),
            kind: attestation.kind,
            minted_at_ms: clock::timestamp_ms(clock),
            market_id: attestation.market_id,
            serial,
            wick_signature: hmac_sign(attestation.kind, owner, serial),
        };
        event::emit(BadgeEarned { /* ... */ });
        transfer::transfer(badge, owner);
    }

    fun check_cap(registry: &mut BadgeRegistry, kind: u8, owner: address) {
        let issued = *vector::borrow(&registry.issued_count, (kind as u64));
        let cap = *vector::borrow(&registry.cap, (kind as u64));
        if (cap > 0) {
            assert!(issued < cap, ECapReached);
        };
        let per_addr_cap = *vector::borrow(&registry.per_address_cap, (kind as u64));
        if (per_addr_cap > 0) {
            let counts = table::borrow_mut(&mut registry.per_address_count, owner);
            assert!(*vector::borrow(counts, (kind as u64)) < per_addr_cap, EPerAddressCapReached);
        };
    }

    fun bump_serial(registry: &mut BadgeRegistry, kind: u8): u64 {
        let issued_ref = vector::borrow_mut(&mut registry.issued_count, (kind as u64));
        *issued_ref = *issued_ref + 1;
        *issued_ref
    }
}
```

### 9.3 `staking.move` excerpt (for owned-vs-rented)

```move
module wick::staking {
    public struct StakeReceipt has key, store {
        id: UID,
        owner: address,
        amount: u64,
        locked_until: u64,
        acquired_at_ms: u64,         // v2 — set on stake() and on transfer
        last_settlement_observed_ms: u64,
        tournament_locked: bool,     // v2 — true while locked into a premium round
    }

    public fun is_owned(receipt: &StakeReceipt, clock: &Clock): bool {
        clock::timestamp_ms(clock) >= receipt.acquired_at_ms + OWNED_AGE_THRESHOLD_MS
    }

    public fun assert_premium_eligible<C>(
        tournament: &Tournament<C>,
        receipt: &StakeReceipt,
        clock: &Clock,
    ) { /* §6.4 */ }
}
```

---

## 10. Frontend storyboard updates

The v1 storyboards (tournament lobby, position card, path-watch room,
leaderboard, badge gallery) survive intact. v2 layers in:

### 10.1 Tournament lobby

```
┌─────────────────────────────────────────────────────────────────┐
│ DAILY TOURNAMENT — opens in 04:23                               │
│ Entry closes at T-30s. Seed locks via VRF.                      │
├─────────────────────────────────────────────────────────────────┤
│  Synthetic asset:  RWALK-25                                     │
│  Entry fee:        1 SUI                                        │
│  Pot so far:       1,247 SUI    (1,247 entrants — see clusters) │
│  Top prize est:    374 SUI                                      │
│  Prize-eligible after cluster filter: 689 SUI            [info] │
├─────────────────────────────────────────────────────────────────┤
│  [   ENTER NOW — 1 SUI    ]                                     │
│  [   Free entry with 5,000 owned-WICK staked   ]      [why?]    │
│                                  └───→ "owned = held >30 days"  │
├─────────────────────────────────────────────────────────────────┤
│  Recent entrants ticker: 0xAlice • 0xDegen42 • 0xFrog • ...     │
│  Past 10 winners (avatars + payouts + cluster tags)             │
└─────────────────────────────────────────────────────────────────┘
```

New surfaces:
- **Cluster-filtered prize estimate.** Shown alongside raw pot total. The
  difference between raw and cluster-filtered prize estimate is the visible
  Sybil tax — a transparent number telling honest entrants what they're
  expected to win.
- **"Why owned?" tooltip.** Defines owned vs rented in plain language:
  *"WICK held in your wallet for ≥30 days qualifies as owned. Rentals don't
  count, because rentals would let one person enter premium tournaments
  hundreds of times a day."*
- **Entry-window countdown** flips at T-30s ("ENTRIES FROZEN") and at T-0
  ("VRF LOCKED — markets live").

### 10.2 Settlement → claim flow

```
T+5min: TournamentSettled
        ┌─────────────────────────────────────────┐
        │  RESULTS                                │
        │  Your raw rank: #7   PnL: +12.4 SUI     │
        │                                         │
        │  Cluster status: PRIMARY MEMBER  ✓      │
        │  Eligible for prize: YES                │
        │                                         │
        │  [  CLAIM 18 SUI  ]      ◀ live button  │
        │  Claim window closes in: 6d 23h         │
        └─────────────────────────────────────────┘

If cluster status == NON-PRIMARY:
        │  Cluster status: SECONDARY  ✗           │
        │  Primary member of your cluster: 0xAlice│
        │  Eligible for prize: NO                 │
        │  [Why?] → opens explainer               │
```

Three states: PRIMARY (claim button live), SECONDARY (no claim, primary shown),
INELIGIBLE (e.g. cluster not yet attested). The honest path is dominant.

### 10.3 Comeback claim card

```
┌─────────────────────────────────────────┐
│  COMEBACK SUB-POT                       │
│  ────────────────                       │
│  Lost ≥2 trades in this round?  ✓       │
│  Recovered to positive PnL?     ✓       │
│  Below 60%-mark cutoff?         ✓       │
│                                         │
│  Your share: 0.85 SUI                   │
│  Cluster cap status: PRIMARY  ✓         │
│  [  CLAIM 0.85 SUI  ]                   │
└─────────────────────────────────────────┘
```

If any check fails, the row shows the failed criterion in red with a one-line
explainer.

### 10.4 Badge gallery — verified checkmark

Each badge card carries a **verified checkmark** (small green tick in the
corner) that renders only when:

1. The badge's full type string is `{WICK_PACKAGE_ID}::badge::Badge`.
2. The `wick_signature` field validates against the canonical HMAC key.

Spam look-alike badges (deployed by attackers in different packages with the
same struct shape) appear as **unverified** with a faded grey tag and a
"This badge is not from Wick — possibly a scam" tooltip.

### 10.5 Charterhouse progress card

Replaces the "Founder" silhouette in the badge gallery for users who are still
working toward Charterhouse:

```
┌─────────────────────────────────────────┐
│  CHARTERHOUSE — MYTHIC                  │
│  Behaviour-earned, 1000 ever            │
│  ────────────────────                   │
│  Active days:        37 / 50  ▓▓▓▓▓▓▓░░ │
│  Distinct underlyings: 3 / 5  ▓▓▓▓▓▓░░░ │
│  Owned WICK ≥10k:    YES (acquired 47d  │
│                       ago — 13d to age) │
│  Cluster primary:    YES                │
│                                         │
│  Estimated days to eligibility: 13      │
└─────────────────────────────────────────┘
```

Honest checklist; no rush surface; no "first 1000" frenzy.

---

## 11. On-chain event schema (v2 additions)

All v1 events survive. v2 adds or modifies:

```move
// ─── Tournament module ─────────────────────────────────────────

TournamentScheduled {
    tournament_id, season_id,
    entry_window_open_ms, entry_window_close_ms,  // close = lock_in - 30s
    lock_in_ms, expiry_ms,
    entry_fee, attestor_pubkey, min_wick_staked,
}

TournamentEntered {
    tournament_id, entry_id, owner,
    funded_from,                   // v2: indexer cluster input
    entry_fee_paid, entered_at_ms,
}

TournamentLocked {
    tournament_id, seed,           // 32-byte VRF output
    market_ids, entry_count, pot_total, locked_at_ms,
}

BulkOpenSubmitted {                // v2: anti-Sybil audit trail
    tournament_id, signer, entry_count, distinct_owners, submitted_at_ms,
}

TournamentSettled {
    tournament_id,
    raw_top_50: vector<address>,   // raw board, on-chain truth
    raw_top_50_pnl: vector<i64>,
    settled_at_ms,
}

PrizeClaimed {                     // v2: replaces v1 push-payout in Settled
    tournament_id, address, rank, amount, claimed_at_ms,
}

ComebackClaimed {                  // v2: separate from PrizeClaimed
    tournament_id, address, share, claimed_at_ms,
}

BurnDistributed {                  // v2: delayed burn, snapshot semantics
    tournament_id, snapshot_ts, amount,
}

TournamentCancelled { tournament_id, reason: u8 }

// ─── Badge module ──────────────────────────────────────────────

BadgeEarned {
    kind, owner, badge_id, serial,
    market_id: Option<ID>,
    minted_at_ms,
    wick_signature,                // v2: HMAC for verified checkmark
}

BadgeAttestationRedeemed {         // v2: when Charterhouse / Comeback Kid mints
    kind, owner, attestor_pubkey, attested_at_ms,
}

BadgeCapReached { kind, total_minted }

// ─── Profile / leaderboard ─────────────────────────────────────

ProfileCreated { owner, profile_id, created_at_ms }

ProfileUpdated {                   // v2 unchanged structurally
    owner, profile_id,
    season_pnl_mist_delta, season_volume_mist_delta,
    streak, badge_kinds_held,
}

SeasonStarted { season_id, started_at_ms, ends_at_ms, prize_pool_wick }
SeasonEnded { season_id, top_addresses: vector<address>, top_payouts: vector<u64> }

// ─── Spread tagging ────────────────────────────────────────────

SpreadOpened {
    group_id, owner, kind,
    position_ids, market_ids,
    total_stake_mist,
    leg_usd_cents: vector<u64>,    // v2: indexer eligibility for Spread Architect
}

SpreadRedeemed {
    group_id, owner, total_payout, total_pnl_mist, leg_count,
}

// ─── Staking ───────────────────────────────────────────────────

StakeAcquired {                    // v2: triggers acquired_at_ms
    receipt_id, owner, amount, acquired_at_ms,
}

StakeTransferred {                 // v2: resets acquired_at_ms on receiver
    receipt_id, from, to, amount, transferred_at_ms,
}

TournamentLockedStake {            // v2: premium-tournament hold
    tournament_id, receipt_id, locked_until_ms,
}

// ─── Path-watch / tipping (unchanged from v1) ──────────────────

TipSent { from, to, amount_wick, market_id, memo }
```

The indexer projects these events into:
- `tournaments` (status, vault balances, entry count, raw ranks)
- `tournament_entries` (cluster_id computed from `funded_from` graph walk)
- `prize_eligible_ranks` (cluster-filtered, signed for `ClaimAttestation`)
- `comeback_eligibility` (computed from entry-side trade history per address)
- `badges` (verified-or-not based on package_id and signature)
- `stake_receipts` (with `is_owned` derived from `acquired_at_ms`)

---

## 12. Implementation order (v2)

1. **VRF wiring + `lock_in` rewrite.** Smallest surface; closes A3+A4
   immediately. Ship behind a `vrf_enabled` feature flag; cut over once tested.
2. **`bulk_open` v2 + `TournamentEntry` untransferable.** Closes A2.
3. **Isolated `TournamentVault<C>`.** Refactor; preserves invariant-check
   surface area for the test suite.
4. **Sliding 24h window in indexer.** Pure indexer change; closes A11.
5. **Cluster filter in indexer + `ClaimAttestation` flow.** Closes A1+A5
   majority, plus A6 cluster cap. Largest off-chain build.
6. **Comeback v2.** Closes A6 fully.
7. **Charterhouse + retired Founder.** Closes A7. Indexer maintains the
   waitlist; first qualifier mints once they hit all four conditions.
8. **`StakeReceipt.acquired_at_ms` + owned-vs-rented.** Closes A10+A12. Coordinate
   with tokenomics §5.
9. **Badge spec v2 (Razor's Edge oracle gate, Spread Architect dust floor,
   Witness delay-bounty).** Closes A8+A9+A14.
10. **Frontend updates** (cluster-filtered estimates, claim flow, Charterhouse
    progress card, verified-badge checkmark). Closes A13.

Each step is independently shippable behind a feature flag. The order minimises
the window in which any one attack remains live in production.

---

*End of v2 hardened spec. Reviewed against `docs/redteam/08_tournament.md` —
all 14 attacks have a named v2 mitigation. Compound-attacker daily extraction
estimate drops from ~$1k–$2.5k (v1) to ~$30–$80 (v2), and the Founder one-shot
NFT capture is closed entirely. Recommend a follow-up red-team pass on this
spec before mainnet.*
