# Wick Markets — Gamification Layer (Design Spec)

**Status:** design proposal, post-MVP. Builds on the existing `market::Market<C>` /
`market::Position` primitive in `move/sources/market.move`. Nothing here changes
the collateral invariant or the touch / no-touch product surface — these are
*coordinators* sitting on top of the base options layer.

**Vibe target:** Robinhood × Korean MMO × papertrade arcade. Mobile-first.
Visceral, loud, Skinner-box. Real money risk; non-real "season" cosmetics.

**Hard line:** none of this turns Wick into a casino. All payoffs derive from
on-chain barrier touches against an oracle. Gamification adds *coordination,
identity, and feedback* on top of an already-fair primitive — it does not add
new randomness sources or new payouts not anchored to oracle observations.

---

## 0. Components at a glance

| # | Mechanic | New on-chain object | Drives |
|---|---|---|---|
| 1 | Tournament markets | `Tournament<C>` shared object + `TournamentEntry` | Daily focal point |
| 2 | Streaks + badges | `BadgeRegistry`, `Badge` (Display NFT) | Identity, retention |
| 3 | Leaderboards | `Season<C>` shared object, `TraderProfile` | Status, WICK rewards |
| 4 | PTB spreads | `SpreadTag` (off-chain index, on-chain group_id event) | Strategy depth |
| 5 | Path-watch room | Indexed view; tip via `WICK::transfer` | Multiplayer feel |
| 6 | Tick animation | Frontend reaction to `Tick` events | Dopamine loop |

---

## 1. Tournament markets

**The product:** once a day at 20:00 UTC, a 5-minute random-walk tournament
opens. Everyone trades the *same* synthetic asset, on the *same* set of
barriers, with the *same* expiry. At settlement, the entire entry pot is
distributed by a curve over participants ranked by realised PnL.

### Entry window and lock-in

- **T-30 min → T-0:** entry window. Anyone calls `tournament::enter` to deposit
  a fixed entry fee (e.g. 1 SUI) and receive a `TournamentEntry` object. Entry
  is closed at T-0.
- **T-0:** lock-in. The tournament's underlying `random_walk_driver` is
  initialised with a seed derived from `hash(prev_block_digest, T-0_clock_ms)`
  — public, unpredictable until lock-in, deterministic after.
- **T+0 → T+5min:** trade. Five paired Wick markets (TOUCH-ABOVE / TOUCH-BELOW
  at ±1%, ±2%, ±5%) are auto-spawned by the tournament module. Entrants trade
  *only* these five markets; their `TournamentEntry` ID is required as a
  capability when calling `market::open` so PnL is attributed.
- **T+5min:** settle. All five markets resolve via the standard path
  observation. Each entrant's realised PnL is summed across positions tied to
  their entry. The tournament module reads these sums and distributes the pot.

### Prize distribution — top-10 curve, not winner-take-all

Winner-take-all is bad UX (one person gets paid, 999 leave). Use a decaying
curve that pays the long tail enough to come back:

```
rank  1: 30% of pot
rank  2: 18%
rank  3: 12%
rank  4-10: 5% each (35% total)
rank 11+: 0% prize, but keep all in-tournament PnL
```

Plus: **10% of the pot is burned to fund WICK staking rewards** (everyone
benefits, including non-participants). **5% is held back as a "comeback"
sub-pot** — distributed to the top-3 *worst* PnL traders, capped at 5x entry,
to soften max-loss psychology. (Anti-degeneracy: cap means you can't farm this.)

### Tie handling

PnL is integer mist. Exact ties for a paid rank split that rank's prize equally
and skip the next slot (standard sports tie-break). If somehow >10 entries tie
for #1, the prize is split across all of them and ranks 2–10 are paid 0.

### Zero participants

If `entry_count == 0` at lock-in, the tournament `cancel`s automatically: no
markets are spawned, no seed pot is moved. If `entry_count == 1`, the lone
entrant gets their entry fee back minus a 1% gas-cost recoupment that goes to
the protocol — prevents single-entry farming for guaranteed pot.

### Anti-collusion

Three layers, in order of strength:

1. **Per-entry stake cap.** Each `TournamentEntry` has a `max_stake_total` cap
   computed at lock-in (e.g. `entry_fee * 100`). You can't dump 1000x your
   entry fee to dominate the leaderboard.
2. **Equal-cost trades.** Tournament markets are protocol-funded `Market<C>`s
   with identical seed liquidity. Whales can't buy their way to a price
   advantage by being early — early traders get standard CPMM benefit, but
   `payout_multiplier_bps` is fixed across the tournament so the math is the
   same for everyone.
3. **Sybil resistance via WICK stake gating** (post-launch). Optional flag:
   tournaments can require `min_wick_staked` to enter, making farm accounts
   capital-expensive. Off by default; on for high-pot specials.

### PTB bulk-open for groups

Sui PTBs let one transaction open positions across all five tournament markets
*for many traders at once*. The tournament module exposes:

```move
public fun bulk_open<C>(
    tournament: &mut Tournament<C>,
    entries: vector<&mut TournamentEntry>,
    sides: vector<u8>,
    stakes: vector<Coin<C>>,
    market_ids: vector<ID>,
    clock: &Clock,
    ctx: &mut TxContext,
): vector<Position>
```

This is the foundation for the "**join with friends**" UX: a guild leader signs
one PTB that opens five spread positions across five markets for their five
guild members. Each `entries[i]` must be owned by the signer or by a `Friend`
capability that the entry-owner pre-issued.

### On-chain objects

```move
public struct Tournament<phantom C> has key {
    id: UID,
    season_id: ID,
    entry_fee: u64,
    entry_window_close_ms: u64,
    expiry_ms: u64,
    seed: vector<u8>,            // filled at lock-in
    entry_count: u64,
    pot: Balance<C>,
    market_ids: vector<ID>,      // empty until lock-in
    status: u8,                  // PENDING / ACTIVE / SETTLED / CANCELLED
}

public struct TournamentEntry has key, store {
    id: UID,
    tournament_id: ID,
    owner: address,
    realised_pnl_mist: i64,      // updated on every redeem
    stake_total_mist: u64,
    max_stake_total_mist: u64,
}
```

---

## 2. Streaks + badges

Badges are `Display`-enabled NFTs minted to the winner's address. They're
non-transferable (`store` only inside a `Trophy` wrapper that has no `store`)
to avoid a secondary market that turns identity into a commodity.

### The 10 launch badges

| # | Name | Trigger | Rarity tier |
|---|---|---|---|
| 1 | **First Wick** | First winning TOUCH redemption ever | Common — many issued |
| 2 | **Razor's Edge** | Won a TOUCH where touch-price was within 1 bp of the barrier | Rare |
| 3 | **Conviction** | Held a NO_TOUCH that survived ≥5 path observations within 0.5% of barrier | Rare |
| 4 | **Founder** | Issued to the first 1,000 unique trade signers | Mythic, hard cap |
| 5 | **Iron Stomach** | Held a position through a single random-walk tick of ≥100x stdev | Epic |
| 6 | **Comeback Kid** | Won a tournament after being in the bottom-25% PnL at the 60% time mark | Epic |
| 7 | **Spread Architect** | Opened a 4+ leg PTB spread that settled with positive net PnL | Rare |
| 8 | **The Witness** | Was the address that called `mark_hit` on a market they had no position in (good citizen) | Common |
| 9 | **Hot Hand** | 7-trade win streak (any side, any market) | Rare |
| 10 | **Diamond Wrist** | Held a position to expiry in 50 distinct markets without any early redemptions | Mythic |

### On-chain mint flow

```move
public struct Badge has key {
    id: UID,
    kind: u8,                    // 1..10
    minted_at_ms: u64,
    market_id: Option<ID>,       // for context-sensitive badges
    serial: u64,                 // 1, 2, 3... per kind
}

public struct BadgeRegistry has key {
    id: UID,
    issued_count: vector<u64>,   // per kind, for serial numbering and caps
    cap: vector<u64>,            // 0 = uncapped
}
```

Badges are minted by the contracts that observe the trigger condition. Example:
`market::redeem` checks if this is the caller's first winning TOUCH and emits a
`BadgeEarned` event; the tx caller passes a mutable reference to the registry
in the same PTB so the badge mints in the same atomic op.

For triggers that need cross-market state ("first ever", "7-trade streak"), the
contract reads from the caller's `TraderProfile` (see leaderboards). Streaks
are tracked there.

### Display

Badges use Sui `Display` with a per-kind image URL pulled from a content CDN.
The frontend renders a badge gallery from a single `getOwnedObjects` call
filtered by `Badge` type. Mythic badges have animated SVG; rare and below are
flat PNGs.

---

## 3. Leaderboards

### Time windows and metric

Three concurrent boards. All keyed by **net realised PnL in mist on the
season's collateral coin**, but with different windows and tie-breakers:

- **24h Sprint.** Resets every UTC midnight. Tie-break: trade count (lower
  wins — efficiency reward). Top 10 each get a small WICK bonus mint.
- **7d Marathon.** Rolling 7-day. Tie-break: max drawdown depth (shallower
  wins). Top 25 paid.
- **All-time / Season.** ~3-month seasons aligned with hackathon → mainnet →
  growth phases. Tie-break: total volume (higher wins). Top 100 paid; top 3
  get on-chain "Season N Champion" badges (extra rarity tier).

### Composite score? No.

Composite scores ("0.4 * winrate + 0.3 * volume + 0.3 * pnl") are gameable and
opaque. PnL in mist is honest — it's the same number the user sees on their
position cards. Tie-breakers handle the degenerate cases.

### Display tiers

```
Diamond  — top 1%   — animated card border, glowing username
Platinum — top 5%   — silver border
Gold     — top 10%  — gold border
Silver   — top 25%  — gray border
Bronze   — top 50%  — no decoration but listed
Unranked — bottom 50% — visible only on own profile
```

Tier is computed off-chain by the indexer from the `TraderProfile` snapshot.
On-chain we just store the raw PnL and trade counts.

### Anti-Sybil

Two-tier system:

- **No stake required to *appear*** on leaderboards. Open by default — fair
  launch.
- **WICK staking is required to *win prizes***. To be eligible for the WICK
  bonus mint, you must have staked ≥`min_stake_for_prize` (e.g. 100 WICK) for
  the entire window. Doesn't gate participation, gates payout.

This makes Sybil farming expensive (you need WICK on every farm wallet) without
hiding small fish from their own ranking.

### TraderProfile

```move
public struct TraderProfile has key {
    id: UID,
    owner: address,
    lifetime_pnl_mist: i128,
    lifetime_volume_mist: u128,
    trade_count: u64,
    win_count: u64,
    current_streak: u64,         // consecutive wins
    best_streak: u64,
    season_pnl_mist: i64,
    season_volume_mist: u64,
    badge_kinds_held: u128,      // bitset over kinds 1..128
    wick_staked: u64,
}
```

One profile per address, created lazily on first trade. Updated atomically
inside `market::open` and `market::redeem` via mut-ref pass-through.

---

## 4. Multi-leg PTB spreads

The Sui PTB primitive is the differentiator here — *no other chain can do this
in one signature for arbitrary heterogeneous markets.*

### Example: BTC ladder

User wants: "Bet 100 SUI split 50/30/20 across BTC TOUCH at $50k, $55k, $60k,
all expiring in 30 minutes."

PTB structure:

```text
TX inputs:
  - 100 SUI Coin
  - market_50k object ID
  - market_55k object ID
  - market_60k object ID
  - clock object
  - profile object (mut)

Commands:
  1. SplitCoins(input_sui, [50_000_000_000, 30_000_000_000, 20_000_000_000])
       → [coin_a, coin_b, coin_c]
  2. MoveCall market::open<SUI>(market_50k, SIDE_TOUCH, coin_a, clock, ctx)
       → position_a
  3. MoveCall market::open<SUI>(market_55k, SIDE_TOUCH, coin_b, clock, ctx)
       → position_b
  4. MoveCall market::open<SUI>(market_60k, SIDE_TOUCH, coin_c, clock, ctx)
       → position_c
  5. MoveCall spread::tag(spread_kind=LADDER, [position_a, position_b, position_c])
       → emits SpreadOpened event with group_id
  6. TransferObjects([position_a, position_b, position_c], sender)
```

One signature. Three positions. One `SpreadOpened` event tying them together
for UI grouping and badge eligibility ("Spread Architect" requires 4+ legs).

### On-chain `spread::tag`

We don't need new position types. A `spread::tag` function takes a vector of
`&Position` references, asserts they all belong to the signer, and emits:

```move
public struct SpreadOpened has copy, drop {
    group_id: ID,                // a fresh UID
    owner: address,
    kind: u8,                    // LADDER / STRADDLE / STRANGLE / CONDOR
    position_ids: vector<ID>,
    market_ids: vector<ID>,
    total_stake_mist: u64,
}
```

The indexer keys positions by `group_id` for "spread view" in the portfolio.
Closing one leg early breaks the spread visually but doesn't affect on-chain
state — the leg redeems independently. Optional `spread::redeem_all` is a
convenience PTB helper that takes the vector and redeems all legs.

### Spread kinds the UI exposes

- **Straddle** — TOUCH-ABOVE *and* TOUCH-BELOW at the same barrier offset.
- **Strangle** — TOUCH-ABOVE at +X% and TOUCH-BELOW at –X%.
- **Ladder** — TOUCH-ABOVE at +X%, +Y%, +Z% (all same direction).
- **Condor** — wider range, NO_TOUCH inside, TOUCH outside.
- **Custom** — UI lets the user pick any combo; tagged as `CUSTOM`.

---

## 5. Path-watch room

A multiplayer view of one market. All open positions are on-chain anyway, so
"showing them" requires no new on-chain state — just an indexer view + a chat
overlay.

### Data flow

```
On-chain                  Indexer                     Frontend
────────                  ───────                     ────────
PositionOpened   ────►    aggregate by market   ────► live position list
PathTickRecorded ────►    push to WS channel    ────► tick animation
PositionRedeemed ────►    aggregate by market   ────► P&L pop-ups
TipSent (event)  ────►    relay                 ────► "anon tipped X 5 WICK"
chat (off-chain) ────►    Ably/Cloudflare DO    ────► chat bubbles
```

Chat lives in Cloudflare Durable Objects (off-chain — chat isn't load-bearing
for the product). Each room is keyed by `market_id`. Auth is by signing a
nonce with the connected wallet — chat names are addresses (truncated) with
optional ENS-style resolution to a profile-set nickname.

### Tip jar

Anyone can tip any visible address by calling
`wick_token::tip(amount: Coin<WICK>, recipient: address, market_id: ID, memo: String)`.
The contract emits `TipSent { from, to, amount, market_id }` and the chat
overlay surfaces it: *"degen42 tipped 0xAlice 5 WICK — 'nice call'"*.

Tipping is just a `transfer` with an event wrapper. Zero new state.

---

## 6. Live tick animation as Skinner box

Designing the dopamine loop. All frontend reaction; on-chain emits the
triggers, frontend renders.

### Per-tick: the gentle hum

Each `PathTickRecorded` event triggers:

- **Sparkline pulse.** The current price line on the watched market's card
  flashes a single-pixel-tall white bar at the new price, then fades to the
  series colour over 200ms.
- **Distance-to-barrier ring.** Around the market thumbnail, a thin arc fills
  toward the closer barrier. As price approaches, the arc grows; on retreat,
  it shrinks. Smooth `cubic-bezier(0.4, 0, 0.2, 1)`, 350ms.
- **No sound.** Ticks happen every 5s on random-walk; sound here is annoying.

### Approach to barrier (within 0.5%): the tightening

- **Card border glow.** Goes from neutral 0% to 100% over the last 0.5% of
  approach. 60Hz pulsing increases tempo as price gets closer.
- **Audio rise.** A quiet cello-like sustain comes in at 0.5%, swells through
  0.2%, peaks at 0.05%. Stops on touch or retreat.
- **Haptic on mobile.** Single 10ms buzz at 0.1%; double buzz at 0.05%.

### Touch fires: the payoff hit

`MarkHit` event triggers the moneyshot:

- **Screen-flash.** 60ms full-screen tint in the winning side's colour
  (TOUCH = green, NO_TOUCH = red — but only on a market the user holds).
- **Card explode.** The market card scales 1.0 → 1.15 → 1.0 over 600ms with a
  bright burst at peak.
- **Sound.** A single cymbal-and-coin-drop chord, ~600ms. Mute toggle in
  settings, on by default.
- **Haptic.** Strong triple-buzz (mobile).
- **Confetti from the user's position cards** that won.

### Settlement: the slot-machine tally

`PositionRedeemed` for each of the user's positions, sequenced 200ms apart:

- Position card flips like a playing card.
- Number rolls from `stake` to `payout` over 800ms with an easing curve.
- **Won?** Card edges glow gold; +PnL number floats up and fades.
- **Lost?** Card desaturates to gray; –stake number floats down and fades.
- After all positions in the round have animated, **"ROLL IT" button** appears
  for 5 seconds — pre-fills the next round's UI with the same stake / sides.

### The dopamine loop in one sentence

> *Every tick teases, every approach tightens, every touch pays in screen,
> sound, and haptic — and "ROLL IT" is always one tap away before you've fully
> processed the win.*

This is the Skinner box. The constraint that keeps it ethical: the underlying
event (touch / no-touch) is a real, fair, oracle-observed outcome — we're
just dressing the feedback.

---

## 7. Anti-grief

| Attack | Defense |
|---|---|
| Whale dumps 10x the pot to dominate a tournament | Per-entry `max_stake_total` cap. |
| Spam-creating worthless markets to clutter UI | Market creation requires a non-trivial seed (`min_seed_collateral`); UI default-filters markets below a liquidity threshold; indexer surfaces a "verified market" flag for protocol-spawned tournament markets. |
| Wash-trading own positions to inflate volume / streaks | Streak counter only increments on positions held ≥ `min_hold_ms`. Volume-based tie-breakers are bounded by `lifetime_volume_mist` cap per day. Same-address counterparty wash trades are detectable in the indexer and discounted. |
| Sybil farms for tournament prize pool | WICK staking gate for prize eligibility. Optional WICK gate for entry on premium tournaments. |
| Fake leaderboard PnL by self-counterparty | Anti-wash above. Plus: leaderboards filter out trades where the same address has been on both sides of a market within a 5-min window. |
| Frontrunning `mark_hit` to extract MEV | `mark_hit` payout (the "Witness" badge + small SUI bounty) is fixed and small enough to not be MEV-attractive vs the cost of submitting late blocks. |
| Mass-mint badges by exploiting one trigger | Per-kind serial number + optional per-address cap (e.g. one "First Wick" per address forever). Mythic badges are hard-capped (Founder = 1000 lifetime). |
| Bots farming all leaderboards on testnet | Address must have ≥ N real (mainnet) trades before counting on mainnet leaderboards. Testnet has its own separate leaderboard, clearly labeled "TESTNET — no prizes." |

---

## 8. On-chain event schema

Required emissions per mechanic. Format: `EventName { fields } — semantic
description`.

### Tournament module

```move
TournamentScheduled { tournament_id, season_id, entry_window_open_ms, entry_window_close_ms, expiry_ms, entry_fee }
  // Fired when a tournament is created (could be auto-cron'd by the keeper).

TournamentEntered { tournament_id, entry_id, owner, entry_fee_paid }
  // One per entrant. Indexer counts entries.

TournamentLocked { tournament_id, seed, market_ids, entry_count, pot_total }
  // At T-0. Tournament is live. UI uses this to flip lobby → trading view.

TournamentSettled { tournament_id, ranks: vector<address>, payouts: vector<u64>, comeback_payouts: vector<address> }
  // One terminal event with the full result. Off-chain leaderboard renders from this.

TournamentCancelled { tournament_id, reason: u8 }
  // Zero-entrant or single-entrant case.
```

### Badges module

```move
BadgeEarned { kind, owner, badge_id, serial, market_id: Option<ID>, minted_at_ms }
  // Fires every mint. UI pops a "BADGE UNLOCKED" toast.

BadgeCapReached { kind, total_minted }
  // For mythic / capped badges. Display in the badge gallery.
```

### Leaderboard / profile module

```move
ProfileCreated { owner, profile_id, created_at_ms }
ProfileUpdated { owner, profile_id, season_pnl_mist_delta, season_volume_mist_delta, streak, badge_kinds_held }
  // Emitted on every market::open / market::redeem that touches the profile.

SeasonStarted { season_id, started_at_ms, ends_at_ms, prize_pool_wick }
SeasonEnded { season_id, top_addresses: vector<address>, top_payouts: vector<u64> }
```

### Spread tagging

```move
SpreadOpened { group_id, owner, kind, position_ids, market_ids, total_stake_mist }
SpreadRedeemed { group_id, owner, total_payout, total_pnl_mist, leg_count }
  // Optional, only if the convenience redeem-all helper is used.
```

### Path-watch / tipping

```move
TipSent { from, to, amount_wick, market_id, memo }
  // Off-chain chat overlay surfaces these.
```

(Existing market events `MarketCreated`, `PositionOpened`, `PositionRedeemed`,
plus the path module's `PathTickRecorded`, are reused as-is.)

---

## 9. Token utility tie-ins

WICK is the protocol's fee-claim token, fair-launched to losers (every losing
`PositionRedeemed` mints `WICK` proportional to the lost stake — losing isn't
*free*, but you walk away with future fee claim rights). Gamification layers
that rule with *staked* utility:

| Surface | Stake effect |
|---|---|
| **Leaderboard prize eligibility** | Must have ≥100 WICK staked for the entire window to receive prize mints. Below threshold = visible rank but no payout. |
| **Tournament entry discount** | Staking 1k WICK halves entry fees on standard tournaments. Doesn't apply to "free entry" specials. |
| **Badge minting** | "Founder" requires ≥10 WICK staked at mint time (proves real participation, not an airdrop farmer). |
| **Spread bonus** | 4+ leg spreads with ≥1k WICK staked get a 1% PnL bonus minted in WICK. Encourages deep strategy use. |
| **Path-watch tip multiplier** | Tipping while staking ≥100 WICK doubles the visibility of your tip in the chat overlay (cosmetic only). |
| **Comeback sub-pot eligibility** | Must hold any non-zero WICK stake at lock-in. |
| **Anti-Sybil floor** | Stake gates on premium tournaments (configurable per-tournament `min_wick_staked`). |

The staking mechanism itself is a separate spec — for this doc, treat it as a
`StakeReceipt { owner, amount, locked_until }` shared object that the
gamification modules read.

---

## 10. Frontend storyboard sketches

### Tournament lobby

```
┌─────────────────────────────────────────────────────────────────┐
│ DAILY TOURNAMENT — opens in 04:23                               │
├─────────────────────────────────────────────────────────────────┤
│  Synthetic asset:  RWALK-25                                     │
│  Entry fee:        1 SUI                                        │
│  Pot so far:       1,247 SUI    (1,247 entrants)                │
│  Top prize est:    374 SUI                                      │
├─────────────────────────────────────────────────────────────────┤
│  [   ENTER NOW — 1 SUI    ]   ◀ giant green button              │
│  [   Free entry with 5k WICK staked   ]                         │
├─────────────────────────────────────────────────────────────────┤
│  Recent entrants ticker: 0xAlice • 0xDegen42 • 0xFrog • ...     │
│  Past 10 winners (avatars + payouts)                            │
└─────────────────────────────────────────────────────────────────┘
```

### Position card

```
┌──────────────────────────────────────┐
│ BTC > $51,200    ●  TOUCH   1.8x     │ ← side colour bar on left edge
│                                      │
│  ╱╲  ╱╲      ╱─── barrier            │ ← sparkline with barrier overlay
│ ╱  ╲╱  ╲  ╱╲╱                        │
│ ╲╱      ╲╱                           │
│                                      │
│  Stake     50 SUI                    │
│  If touch  90 SUI   (+40)            │
│  If miss   0 SUI    (-50)            │
│                                      │
│  03:21 left   ●●●○○ 4 in this trade  │ ← green dots = ticks toward barrier
└──────────────────────────────────────┘
```

### Path-watch room

```
┌──────────────────────────────┬──────────────────┐
│  RWALK-25 — TOUCH > 1.025    │  Live entrants   │
│                              │  ────────────────│
│  ┌────────────────────────┐  │  🥇 0xAlice +127 │
│  │   ╱╲    barrier ─ ─ ─  │  │  🥈 0xDegen +44  │
│  │  ╱  ╲╱╲                │  │  🥉 0xFrog  +12  │
│  │ ╱     ╲╱╲╱╲╱╲╱        │  │  …               │
│  └────────────────────────┘  │  Tip 💰 / Profile│
│                              ├──────────────────┤
│  Open positions (live)       │  CHAT            │
│  ─────────────               │  ────            │
│  TOUCH  340 SUI  (62%)       │  alice: lfg      │
│  NTOUCH 207 SUI  (38%)       │  frog: barrier?? │
│                              │  degen tipped a  │
│  [ Tap-and-hold UP / DOWN ]  │  5 WICK 💎       │
└──────────────────────────────┴──────────────────┘
```

### Leaderboard

Tabbed (24h / 7d / Season). Top 10 rows are oversized with avatars, gradient
border by tier (Diamond → Bronze), inline win-rate sparkline, and a "FOLLOW"
button. Sticky "your row" pinned at bottom even if outside top 100. Sortable
columns: PnL, volume, win rate, badges.

### Badge gallery

Grid of square cards, 4 wide on desktop, 2 wide on mobile. Each card:
foil-stamp animated SVG for mythic, color outline for rarity tier, serial
number ("#42 of 1000"), date earned, link to the trigger trade. Locked badges
shown as silhouettes with the criterion text — gives users a checklist.

---

## Implementation order (suggested)

1. **TraderProfile + leaderboards** — unlocks streak tracking for badges.
2. **Badges** — easy wins, immediate identity surface.
3. **Spread tagging** — minimal Move (just an event emitter); huge UI payoff.
4. **Path-watch room** — front-end + indexer; no Move work beyond existing
   events.
5. **Tournaments** — biggest Move surface; build last when the foundation is
   stable.
6. **Tick animation polish** — ongoing; layered on as events stabilise.

Each step is independently shippable and testable behind a feature flag.
