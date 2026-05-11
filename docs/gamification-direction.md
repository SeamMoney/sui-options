# Wick gamification direction — session notes

**Session date:** 2026-05-11
**Branch:** `claude/add-trading-bots-testnet-ougdg`
**Status going in:** hackathon MVP working end-to-end on testnet — Move package deployed, 40 tests passing, keeper auto-settling, frontend live, multi-actor `demo.sh` conserves to the mist.

This document is a self-contained handoff so a fresh Claude session (or human) can pick up where this one stopped. Read `AGENTS.md` first for the load-bearing constraints; this doc layers design context on top.

---

## TL;DR

We added 4 personality trading bots so the testnet UI looks alive, then spent the session figuring out what to build next. The product story is solid (path-dependent settlement is genuinely differentiated vs. Polymarket and Trepa) but the *UX* needs to be radically simpler and more tappable to land with normal users. Landing point: a 30-second tap-and-hold **"Wick Race"** game built on the existing TOUCH options primitive, with a scalar wick-bonus on top — keeps the CPMM, no parimutuel, on-brand with the product name.

---

## What was built this session

New workspace `bots/` — 4 personality-driven trading bots that produce organic-looking testnet activity. See `bots/README.md` for full usage.

- Personalities: `bull` (TOUCH always, creates ABOVE markets), `bear` (NO_TOUCH always, creates BELOW markets), `contrarian` (fades the larger reserve), `drunk` (random)
- Self-funded from the active CLI address in one `pay-sui` tx via `npm run bots:setup`
- `npm run bots:run` — long-running fleet, ~1 trade/sec aggregate (4 bots × 4s poll × ±2s jitter)
- Trade size auto-clipped to ≤25% of the smaller AMM reserve so a bot can't drain a small market
- Wired into root scripts: `bots:setup`, `bots:fund`, `bots:balances`, `bots:run`, `bots:tick`
- Preflight gains a `bots` typecheck step

Commit: see git log on this branch. All TS workspaces typecheck clean. Move untouched, no Move test changes.

---

## Design direction — what we explored

### 1. How is Wick different from prediction markets?

The clean three-way framing:

> **Polymarket asks where it ends. Trepa asks how close you got. Wick asks whether it touched.**

Path-dependent settlement is the moat. A BTC chart that wicks through a level and falls back is a *zero* on Polymarket and a *win* on Wick. That's the visual to lead with.

### 2. Trepa comparison (https://docs.trepa.io)

Trepa is a parimutuel forecasting contest — slider for a price guess, closest half wins the pot. Mechanically very different from Wick (no LPs, continuous prediction, contest not options).

**Verdict:** don't copy their mechanism (would require tearing out the AMM and the collateral invariant). *Do* steal UX patterns: slider for barrier selection, leaderboard / precision score per address, short fixed-duration rounds, very clean docs page.

### 3. Persona analysis

Wick's primitive serves multiple audiences with different framings:

| Persona | Hook | What grates | Lens for the UI |
|---|---|---|---|
| Polymarket users | "Polymarket for the next 5 minutes" — automatic settlement, no UMA disputes | Don't think in barriers; think in events | Yes/No cards with countdown |
| Perps users | "Defined-risk perps — can't get rugged by a wick" | No leverage knob, lower throughput | Position view showing max loss |
| Robinhood 0DTE | "Crypto's 0DTC (zero days to candle)" | No options chain layout, no greeks | Options-chain grid (rows = barriers, cols = expiries) |
| DeFi options pros | "First permissionless on-chain barrier option DEX" | CPMM pricing is crude vs proper vol model | Implied vol + greeks panel |
| PM researchers | Novel path-dependent oracle-observed resolution rule | MockOracle is a stub | Transparency log of every oracle observation |

**Verdict:** one product, persona-specific framings. Don't pick all five — pick the Polymarket × perps bridge as the launch lens (largest crypto-native audiences, same "fast crypto bet" mental model).

### 4. Gamification — make the user tap

The whole product becomes a slot machine when you compress the loop. Levers in priority order:

- **Short rounds (the chassis)** — 30s–60s markets that resolve fast. Every other gamification compounds on top of this.
- **Continuous launches** — new round every 15s, overlapping. Always something to tap.
- **Tap-and-hold to charge** stake — visual fill bar, escalating stake.
- **One-tap reinvest** — won? "ROLL IT" puts winnings on the next round.
- **Live odds drift** — TOUCH was 1.8x, now 1.6x. Tap *now*.
- **Streak multipliers** — break the streak, lose the bonus.
- **Live tape of others' bets** — bots already produce this for free.
- **Sensory** — haptic, sound, confetti, screen-shake.
- **Tinder-style market deck** — swipe right = TOUCH, left = NO_TOUCH, every gesture is a trade.

The single biggest unlock is **the short round loop**. Without it, decoration.

### 5. Random walk oracle vs. real BTC

User has a random-walk candlestick algorithm separately. We discussed:

**What it unlocks:** 5s rounds, always-on action, tunable difficulty, no real-world feed latency.

**What it breaks:** stops being an options DEX (no information aggregation, no signal); regulatory profile shifts toward "online gambling"; researcher angle dies.

**Verdict:** add `random_walk_oracle` as a *second market category* (synthetic asset alongside real BTC), not a replacement. Same `oracle_adapter` interface so `wick::wick` doesn't change. Frontend gets a "Synthetic" tab. A/B which audience shows up.

### 6. 30-second tap-and-hold rounds — does direction matter?

**Yes — two buttons (UP / DOWN), not one TOUCH button.** Single-button "did it touch" is too abstract; binary-options apps from 2014 already proved UP/DOWN is the tappable grammar.

Two clean implementations of the hold mechanic:

- **(A) Hold-as-duration → one stake on release.** Charge bar fills locally; release fires one tx, mints one Position. No Move changes. Slippage applied at release, not streamed.
- **(B) Streaming taps → many trades during the hold.** Every ~250ms fires a fresh `buy_*`. Real microstructure; expensive gas; needs session signer; produces a bag of Positions.

Ship A first. Layer B if "feel the slippage" turns out to matter.

### 7. CPMM vs. parimutuel for tap-spam (resolved)

I initially suggested parimutuel for the gambling round to avoid the CPMM being drained by spam. User pushed back — they want to stay in touch-options. Right call.

**Solutions that keep the CPMM:**
1. Seed rounds with **much bigger pools** (1–10 SUI per round vs current 200k mist). At round scale, individual taps barely move price.
2. **Batch taps client-side** — UI accumulates locally during the hold, fires one PTB on release.

Do both. No parimutuel.

### 8. Scalar payoffs (layered on TOUCH)

Touch options support scalar bonus payouts when you read more from the oracle than just "did it cross":

- **Time-decay scalar** — payoff bigger if touched earlier in the round.
- **Depth scalar (the "wick")** — payoff scales with how far past barrier price spiked. Literally what the product is named after.
- **Ladder scalar** — stacked barriers, payoff = sum over touched.
- **Lookback scalar** — payoff = max excursion past barrier during the round.

Move-level work: extend the oracle to track high/low over a round, add a `redeem_winner_scaled` that reads max-excursion at settlement and multiplies payout.

---

## The landing point: Wick Race

**30-second tap-and-hold rounds, UP/DOWN, binary base + scalar wick-bonus, all on the existing TOUCH options primitive.**

### Round mechanics

1. Round opens with two barriers, ±2% from spot. Locked at start.
2. **Tap-and-hold UP** → loads a TOUCH position on the upper barrier; charge bar fills with stake; release = one tx.
3. **Tap-and-hold DOWN** → same for the lower barrier.
4. Tapping both directions during the round = a long-vol straddle (auto-hedged degen mode).
5. Round ends when **either** barrier is touched (first-to-touch wins) **or** at 30s timeout.

### Payoff structure

- **Binary base** — if your side's barrier was touched first, you win the standard TOUCH payout (priced by the CPMM at the moment you bought).
- **Wick bonus (scalar)** — multiplier `1 + (depth_past_barrier / barrier_width)`, capped at e.g. 3x. Read from the oracle's max excursion during the round.
- **No-touch path** — if 30s expires with neither barrier touched, both sides settle EXPIRED via existing flow; no-touch holders win the standard NO_TOUCH payout.

### Implementation as paired markets (no Move changes for V1)

Each round = two paired markets sharing an expiry:
- Market A: `TOUCH-ABOVE-upper`
- Market B: `TOUCH-BELOW-lower`

Tap UP routes to market A; tap DOWN routes to market B. Keeper settles each independently. The frontend presents them as one screen.

Add the scalar wick-bonus in V2 (needs Move work — see open questions).

---

## Open questions for next session

1. **Move surface for scalar payoff** — `redeem_winner_scaled` reads oracle high/low at settlement. Requires the oracle to track per-round max excursion. Cleanest module split?
2. **Random walk oracle module** — user has the algo; needs a Sui Move shared object with `(price, vol_bps, last_tick_ms, seed)` and a `tick(&mut self, clock)` advance fn that anyone can call. Entropy from `hash(prev, clock_ms, recent_tx_digest)` is fine for hackathon. Same `barrier_crossed` / `get_price` interface so call sites don't change.
3. **Single-screen UI** — scrap the current Markets/Trade page split for a one-screen round view. Tinder-style market deck is the stretch goal.
4. **Session signer** — to make 1-tap trades real, no wallet popup per round. Options: Enoki/zkLogin (real path, 1–2 days) or local hot key funded once from the connected wallet (faster, testnet-only).
5. **Liquidity sizing** — current `seed-demo-markets.sh` seeds 200k mist. For tap-spam rounds we need 1–10 SUI per market. Update the seeder and probably teach the bots' `createMarket` to use bigger seeds for the synthetic-asset rounds.
6. **First-to-touch behaviour on paired markets** — when one of the two paired markets gets `mark_hit`, should the other auto-settle (refund/expired) immediately, or run its own clock to the 30s? Affects UX and Move surface.

---

## Suggested first action for the next session

Pick one of:

- **(a)** Write `wick::random_walk_oracle` (new Move module, mirrors `MockOracle` interface, anyone can `tick`). Highest dependency-unblocking.
- **(b)** Build the single-screen round UI on top of the existing CPMM with a hand-paired UP/DOWN market set. Highest demo-impact, no Move changes.
- **(c)** Add a `redeem_winner_scaled` and a `max_excursion` field on the oracle. Highest novelty / on-brand for the "wick" name.

Recommended order: (a) → (b) → (c). The oracle unblocks both the bots and the gambling rounds. The UI is the demo. The scalar payoff is the V2 polish.

---

## Pinned constraints (don't break these)

- **Collateral invariant** must hold after every state transition (see `AGENTS.md`).
- **Move package interface is stable** — any change to existing public function signatures = breaking upgrade. Additive only.
- **Don't import from Darbitex / Desnet / D** — reference patterns only.
- **Touch / No-Touch only** for MVP scope. Range / Breakout / Vol-Burst are post-MVP. Wick Race is implementable purely within Touch / No-Touch.
- **Run `./scripts/agent-preflight.sh`** before any commit. It now also typechecks the `bots/` workspace.
