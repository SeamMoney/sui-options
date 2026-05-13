# Wick Markets — Degen Simple Mode (UX Spec v1)

> **Status:** v1 design, mobile-first, default mode for unsophisticated users.
> Pairs with: `docs/design/v2/08_gamification_v2.md` (dopamine loop §6 + path-watch room §5),
> `docs/design/v2/10_demo_script_v2.md` (Scene 2 = Arcade always-works moneyshot),
> `docs/design/v2/09_events_indexer_v2.md` (session-key cap §3, decoded-PTB §3.4, signed SSE §5.4).
>
> **Posture:** this is the *default*. Advanced mode (the trader workspace) is
> behind one toggle. If a first-time user touches Wick on a phone and is not
> placing a bet within 30 seconds of opening the app, this spec failed.
>
> **Not a casino claim:** payoffs still derive from on-chain barrier touches
> against an oracle. The hardening from `08_gamification_v2.md` (cluster filter,
> VRF seed, attestation-gated prizes) holds. We just don't show any of it on
> the default screen.

---

## 1. Design principles (the seven that bind every decision)

These are anchors. Any future PR that breaks one needs the principle named in
the description.

### 1.1 One screen, one verb

Every screen has exactly one primary action. Landing → *Tap a card*. Card →
*Tap WICK YES or WICK NO*. Live position → *Wait*. Settled → *Roll it*. If a
designer wants to add a second button at equal weight, they must remove one
first.

### 1.2 The dopamine loop is the visual

Per gamification spec §6: the *tick* is the heartbeat. Sparkline pulses every
5s on Arcade, every block on Predict-backed BTC. Path overlay shows where price
has *been*; barrier shows what to *beat*. The screen is alive even when the
user isn't tapping. Static = dead.

### 1.3 No popups inside a session

Session-key cap (`09_events_indexer_v2.md` §3) means **one signature on
connect, then nothing** until the cap expires (5 minutes default, 24h hard
cap). If we need to confirm-modal a trade, we have failed at session-key
configuration. The decoded-PTB modal is for the *initial* session-key sign,
not for every tap.

### 1.4 Money words, never math words

From `AGENTS.md`: *touch, no touch, wick, sweep, max loss, payout, time
left*. Banned: *strike, premium, IV, theta, delta, barrier option, payoff
function*. Even *barrier* is suspect — prefer *the line*. **The product is
"will it wick?"** not "will the price cross the barrier of the strike".

### 1.5 Loss is progress

Every loss mints WICK on the fair-launch curve (per demo script §3 Scene 4).
The losing animation does not say "you lost." It says **"you minted X WICK."**
Loss is reframed as advancement. (This is the substance, not just a frame —
the WICK is real, it's claimable, and it accrues protocol fees per
tokenomics.)

### 1.6 Hide the smart stuff

Tournaments, badges, leaderboards, comeback pots, multi-leg PTBs, real-asset
markets, oracle source pickers, advanced-chart timeframes — **all behind
"More."** Discovery is opt-in. If a user never taps "More" they should still
get a complete arcade experience.

### 1.7 The Arcade is always on

Per demo script §3 Scene 2: random-walk tick is in the contract, not on an
external oracle. So Arcade markets *cannot* go down with Pyth, Predict, or
RPC. **Degen mode defaults to Arcade.** Real-asset markets (BTC, SUI, SP500)
are accessible via a 2nd-tier card — they're a feature, not the main course.

---

## 2. Information architecture (the whole app, 5 screens)

```
┌──────────────────────────────────────────────────────────────┐
│  ROOT TABS (bottom nav, 3 tabs only)                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                     │
│  │  Play    │ │  Mine    │ │  More    │                     │
│  │  (home)  │ │  (positions) │ (drawer) │                  │
│  └──────────┘ └──────────┘ └──────────┘                     │
└──────────────────────────────────────────────────────────────┘
        │            │            │
        ▼            ▼            ▼
   ┌─────────┐  ┌──────────┐ ┌────────────────────────────┐
   │ S1 Play │  │ S2 Mine  │ │ S3 More (drawer)           │
   │  cards  │  │ position │ │ - Leaderboard              │
   │  feed   │  │ list     │ │ - Tournaments              │
   └─────────┘  └──────────┘ │ - WICK token / earn        │
        │                    │ - Badges                   │
        ▼                    │ - Real markets (BTC/SUI..) │
   ┌─────────────┐           │ - Switch to Advanced mode  │
   │ S4 Market   │           │ - Settings (sound, haptics)│
   │  detail +   │           │ - Help / What is Wick?     │
   │  trade pad  │           └────────────────────────────┘
   └─────────────┘
        │
        ▼ (after tap)
   ┌─────────────┐
   │ S5 Live     │
   │  position   │
   │  watch room │
   └─────────────┘
```

**That's the whole app for a degen.** Five screens, three bottom tabs, one
drawer. No navigation graph deeper than 2 taps from Play to a settled win.

Notes:

- **No sign-up flow.** Wallet-connect is the sign-up. Email is "More → Settings → Notifications" and is opt-in only.
- **No transactions screen.** Settled positions live in S2 (Mine) under a "Done" pill. Tap one to see the result animation again.
- **No portfolio breakdown.** Just a single SUI / USDC / WICK balance strip at the top of Mine.

---

## 3. Screen-by-screen wireframes

ASCII wireframes are normative for layout intent, not pixel-perfect. Sizes
are mobile portrait, ~375px wide, ~812px tall.

### S0 — Connect (first-launch only, no bottom tabs)

```
┌─────────────────────────────────┐
│                                 │
│         W I C K                 │  ← 80pt Geist Sans, lime
│         markets                 │  ← 24pt Geist Mono, white
│                                 │
│                                 │
│   tap the wick.                 │  ← 28pt headline, white 80%
│   win the round.                │
│                                 │
│   ────── live arcade ──────     │  ← micro-cap label
│                                 │
│   ┌─────────────────────────┐   │
│   │ RWALK-25  ·  31s left   │   │  ← live-ticking demo card,
│   │   ▁▂▃▅▆▇█▇▆▅▃▂  ▼       │   │    no interaction yet
│   │ $24.18   barrier $25.00 │   │
│   └─────────────────────────┘   │
│                                 │
│   ┌─────────────────────────┐   │
│   │  CONNECT SLUSH WALLET   │   │  ← lime, full-width, 56pt
│   └─────────────────────────┘   │
│                                 │
│   No wallet? [Get Slush ↗]      │  ← grey link
│                                 │
└─────────────────────────────────┘
```

**Behavior:** the live-ticking card is *not interactive yet*. It's a teaser.
It's there to communicate *"this is a real live thing right now"* before the
user has even connected. The card uses public-read SSE from §5.3 of the
indexer spec (no JWT needed for guest) **OR** falls back to a 5-second
mock if SSE is gated — this fallback is acceptable because nothing about
this screen is authoritative.

**Connect tap:**
1. Slush wallet popup → sign personal-message nonce (issues JWT for SSE).
2. Decoded-PTB modal (per `09_events_indexer_v2.md` §6.3) for **session-key
   creation only** — not for trades. Single sign. Title: *"One signature.
   Then tap to play for 5 minutes."*
3. Faucet auto-call in background — if testnet balance is 0 SUI, request
   1 SUI from faucet silently. Show toast on success.
4. Land on S1.

**Total:** 1 popup, 1 sign, 0 forms.

### S1 — Play (the home feed)

```
┌─────────────────────────────────┐
│ 1.42 SUI   1,240 WICK     [⚙]   │  ← balance strip (32pt Mono); cog = More
├─────────────────────────────────┤
│                                 │
│   FEATURED  ·  29s left         │  ← bright lime label
│   ┌─────────────────────────┐   │
│   │ RWALK-25     [LIVE ●]   │   │
│   │                         │   │
│   │   ▂▃▆▇█▇▆▃ ╌╌╌╌╌╌ ─25.00│   │  ← path overlay + barrier dashed
│   │              ▲ $24.32   │   │
│   │                         │   │
│   │ payout 2.4×    pot 312Σ │   │
│   ├─────────────────────────┤   │
│   │ ┌──────────┐┌─────────┐ │   │
│   │ │ WICK YES ││ WICK NO │ │   │  ← 2x huge buttons, full row
│   │ │   2.4×   ││   1.7×  │ │   │
│   │ └──────────┘└─────────┘ │   │
│   └─────────────────────────┘   │
│                                 │
│   NEXT UP                       │  ← micro-cap
│   ┌─────────────────────────┐   │
│   │ RWALK-13   58s          │   │
│   │   ▆▇▅▃▂▃▅  ╌╌╌╌╌  ─12.50│   │
│   │ payout 1.9×             │   │
│   └─────────────────────────┘   │
│   ┌─────────────────────────┐   │
│   │ RWALK-99   2m 14s       │   │
│   │   ▂▃▂▁▂▃▅  ╌╌╌╌╌  ─99.00│   │
│   └─────────────────────────┘   │
│                                 │
├─────────────────────────────────┤
│  [▶ Play]  [● Mine]  [⋯ More]   │  ← bottom tabs (Play active)
└─────────────────────────────────┘
```

**Behavior:**
- Featured card auto-cycles to the *highest-payout, soonest-expiring*
  random-walk market. Cycling happens silently when the user is at the
  top of the feed; if they've scrolled, no auto-cycle.
- Pull-to-refresh triggers a hop to a new featured pick.
- Tap the **WICK YES** or **WICK NO** button → S5 (live position watch room)
  immediately. No intermediary "confirm" screen — the session key has
  already authorized this trade pattern.
- Tap a "Next up" card body (not the buttons) → S4 (market detail). This is
  the *only* path to S4; degens almost never need it because the bet is
  on S1 already.

**Stake input** lives *inside the trade button*. See §5.3.

### S2 — Mine (positions)

```
┌─────────────────────────────────┐
│ 1.07 SUI   1,240 WICK     [⚙]   │
├─────────────────────────────────┤
│                                 │
│   LIVE                          │
│   ┌─────────────────────────┐   │
│   │ RWALK-25  WICK YES      │   │
│   │ stake $5.00   payout $12│   │  ← USD-denominated for clarity
│   │ ▆▇█▇▆ ╌╌╌╌─25.00        │   │  ← live tickers per card
│   │ 18s left   touch in 0.4σ│   │
│   │ [   CASH OUT  $9.20  ]  │   │  ← only if AMM has ask side
│   └─────────────────────────┘   │
│                                 │
│   DONE                          │
│   ┌─────────────────────────┐   │
│   │ RWALK-13  WICK NO  WON  │   │  ← lime "WON" pill
│   │ +$8.60   ┃ pot 4×       │   │
│   │ [   ROLL IT   ]         │   │  ← reinvest in current featured
│   └─────────────────────────┘   │
│   ┌─────────────────────────┐   │
│   │ RWALK-99  WICK YES  ──  │   │  ← grey "minted" pill
│   │ stake $2.00 → 87 WICK   │   │
│   │ [   STAKE AGAIN   ]     │   │
│   └─────────────────────────┘   │
│                                 │
├─────────────────────────────────┤
│  [▶ Play]  [● Mine]  [⋯ More]   │  ← Mine active
└─────────────────────────────────┘
```

**Behavior:**
- Live cards live-update via signed SSE (per `09_events_indexer_v2.md` §5.4).
- "Touch in 0.4σ" microcopy: see §5.4 microcopy table — this is the
  *one* place we use a math word, and only because "0.4 standard deviations
  from the line" is shorter and more honest than the alternatives. We
  test alternatives in §5.4.
- "Cash out" button only renders when the AMM has the opposite side
  liquid enough for ≥80% of position value. Otherwise the button is
  absent (not greyed) so the user doesn't tap a dead control.
- "Roll it" reinvests the same SUI stake into the current featured market.
  Single tap. No popup.
- "Stake again" reinvests the same SUI stake into the *same market kind*
  (RWALK-99) at the next available round.

### S3 — More (drawer; opens from cog or bottom tab)

```
┌─────────────────────────────────┐
│  ─                              │  ← swipe handle
│                                 │
│  ┌───────────────────────────┐  │
│  │ 0xMax · max@wick.markets  │  │  ← if email opted in
│  │ Tier: Bronze · 7 day      │  │  ← only if opted in to leaderboard
│  └───────────────────────────┘  │
│                                 │
│  PLAY MORE                      │
│  ▸ Real markets (BTC, SUI..)    │
│  ▸ Tournaments  · 4m to next    │
│  ▸ Leaderboard  · Bronze        │
│                                 │
│  EARN                           │
│  ▸ WICK token (1,240 yours)     │
│  ▸ Badges (3 of 10)             │
│                                 │
│  TUNE                           │
│  ▸ Sound        ON              │
│  ▸ Haptics      ON              │
│  ▸ Notifications  off           │
│  ▸ Responsible mode  off        │  ← per 09 §6.7
│                                 │
│  GROW UP                        │  ← honest, slightly cheeky
│  ▸ Switch to Advanced mode      │
│                                 │
│  ▸ What is Wick? (60s)          │
│  ▸ Help / contact               │
│                                 │
└─────────────────────────────────┘
```

**Behavior:**
- "Real markets" routes to a *Play-screen variant* with BTC/SUI/SP500 cards.
  Same UI shell as S1 — only the underlying differs. This keeps the mental
  model identical.
- "Switch to Advanced mode" is a single confirm: *"Switch to the trader
  workspace? You can switch back any time."* → reload to Advanced shell.
  We don't try to in-app port state.
- "What is Wick?" opens a 4-card swipeable explainer (§11).

### S4 — Market detail + trade pad (rarely visited from Degen)

```
┌─────────────────────────────────┐
│ ← Back                          │
│                                 │
│ RWALK-25                        │
│ Random walk · 5s tick · 1m round│
│                                 │
│ ┌─────────────────────────────┐ │
│ │ chart pane                  │ │
│ │ ▂▃▆▇█▇▆▃▂ ╌╌╌╌─25.00       │ │
│ │   path overlay + barrier    │ │  ← BIG chart, 240pt tall
│ │                             │ │
│ │ 24.32   ↑ 2.1% in 5s        │ │
│ └─────────────────────────────┘ │
│                                 │
│ payout: WICK YES 2.4×           │
│         WICK NO  1.7×           │
│ pot:    312 SUI                 │
│ time:   29s                     │
│                                 │
│ ┌────────┐┌────────┐            │
│ │ $1     ││ $5     │            │  ← preset chips
│ │        ││ ●      │            │  ← selected dot
│ └────────┘└────────┘            │
│ ┌────────┐┌────────┐            │
│ │ $20    ││ MAX    │            │
│ └────────┘└────────┘            │
│                                 │
│ ┌─────────────────────────┐    │
│ │   WICK YES   $5 → $12   │    │  ← stake → payout right in CTA
│ └─────────────────────────┘    │
│ ┌─────────────────────────┐    │
│ │   WICK NO    $5 → $8.50 │    │
│ └─────────────────────────┘    │
└─────────────────────────────────┘
```

**Why this exists:** the user *can* land here from a "Next up" card or
from a deep link. It's the same page Advanced mode users see at the same
URL, just rendered with the Degen layout. Path overlay is bigger; trade
pad is below the fold but easily reached.

### S5 — Live position watch room (the dopamine pane)

```
┌─────────────────────────────────┐
│ ← Back                  29s     │  ← countdown top-right
│                                 │
│ RWALK-25                        │
│ WICK YES   $5 → $12             │
│                                 │
│ ┌─────────────────────────────┐ │
│ │                             │ │
│ │    ╌╌╌╌╌╌╌─── $25.00 ╌╌╌╌╌  │ │  ← barrier line, dashed
│ │       ▆▇█▇▆▃▂              │ │
│ │            ▲                │ │  ← live path tip
│ │     $24.32                  │ │
│ │                             │ │
│ │   ─2.7% from line           │ │  ← distance microcopy
│ └─────────────────────────────┘ │
│                                 │
│   pulse · pulse · pulse         │  ← 5s ticks animate the box
│                                 │
│ ┌─────────────────────────┐    │
│ │   CASH OUT $4.10        │    │  ← only if liquid enough
│ └─────────────────────────┘    │
│                                 │
│ pot 312Σ · 89 traders · ▼       │  ← collapsable "social" line
└─────────────────────────────────┘
```

**Behavior:** this is the *path-watch room* from gamification §5. The whole
screen is alive: barrier line, path drawing, distance ticker, payout
estimate. The barrier line **glows brighter** as price approaches it
(opacity 0.4 at >5σ, opacity 1.0 + soft lime halo at <0.5σ). When touch
fires, see §6.

This screen is **portrait-locked**. Landscape rotation re-renders the
trade panel for one-handed thumb reach.

---

## 4. Trade flow (exact tap sequence)

The hard target: **3 taps from cold-launch to live position.** Two taps if
session is warm.

### Cold launch (first ever bet)

| # | Action | Screen | What happens | Time budget |
|---|---|---|---|---|
| Open app | — | S0 Connect | Live RWALK card already pulsing | 0s |
| 1 | Tap *CONNECT SLUSH WALLET* | S0 → wallet | Slush opens; sign nonce + decoded-PTB session-key creation | 5s |
| Auto | App opens, faucet drops 1 SUI silently | S1 Play | Featured card front-and-center | 1s |
| 2 | Tap *WICK YES* on Featured | S1 → S5 | Session-key-signed PTB fires; transition to S5 | 0.4s |
| Auto | Position appears in S5 | S5 | Path-watch room live; countdown begins | — |

**Total signatures: 1.** Total taps: 2 (plus connect).

### Warm session (≥2nd bet within 5 minutes)

| # | Action | Screen | Time |
|---|---|---|---|
| 1 | Tap *Play* tab (or pull-to-refresh) | S1 | 0s |
| 2 | Tap *WICK YES* on Featured | S1 → S5 | 0.4s |

**Total taps: 2.** Stake defaults to last-used amount.

### Stake change

If the user wants to deviate from the default stake, the sequence is:

| # | Action |
|---|---|
| 1 | Tap the *stake chip* below buttons (pops a horizontal scroll of chips: $1, $5, $20, MAX) |
| 2 | Tap chip |
| 3 | Tap *WICK YES* / *NO* |

**Note:** chips live *inside* the card on S1 (collapsed by default; expand
on long-press of the trade button). On S4 chips are always visible. We
*never* show a numeric keypad on the Play screen — that's an Advanced-mode
affordance.

### Transition animations (frame-by-frame)

The S1→S5 transition is the most-watched 400ms in the app. Spec:

- **Frame 0–80ms:** Featured card scales 1.0→1.05, lifts on Z, soft lime
  glow appears around its border (haptic: light tap).
- **Frame 80–240ms:** Card morphs into the watch-room layout (shared
  element transition: chart frame stays put, buttons collapse upward,
  countdown moves to top-right).
- **Frame 240–400ms:** Barrier line draws in (left-to-right wipe), path
  pulse syncs to the heartbeat.

If the PTB takes >400ms to land on chain (it shouldn't with session keys),
the watch room renders a *pending position* with a soft-pulsing
"awaiting…" sub-line; replaced by live data on confirm.

If the PTB fails (gas, RPC, session-key cap breach), see §7.

---

## 5. Microcopy (every label, button, headline)

We tested 5 candidates for each high-stakes label. The picked candidate is
**bold**.

### 5.1 The two big buttons

| # | Candidate | Verdict |
|---|---|---|
| A | "BUY TOUCH / BUY NO TOUCH" | math-word, hidden cognitive load. Reject. |
| B | "WILL WICK / WON'T WICK" | parses as future-tense statement, not action. Weaker as a button. |
| C | "WICK YES / WICK NO" | **WIN** — verb-tense, mirrors prediction-market YES/NO mental model, "wick" is the brand verb. |
| D | "TOUCH IT / SKIP IT" | "skip" reads as cancel. Reject. |
| E | "PUMP / DUMP" | wrong product (this is path-dependent, not direction). Reject. |

**Picked: WICK YES / WICK NO.** Used everywhere.

### 5.2 The one-line product explainer (S0 + What-is-Wick)

| # | Candidate | Verdict |
|---|---|---|
| A | "Tap the wick. Win the round." | **WIN** — short, evocative, no math. |
| B | "Trade short-dated touch options on Sui." | technical, MVP audience hates this. Reject. |
| C | "Will the price wick? Win 2x in 30s." | OK; loses to A on rhythm. |
| D | "Predict the wick, win the pot." | "predict" overloads with prediction markets. Reject. |
| E | "Tap fast. Wick faster." | too cute, no signal. Reject. |

**Picked: "Tap the wick. Win the round."**

### 5.3 Stake input

The stake chip set: **$1 · $5 · $20 · MAX**.

- USD-denominated everywhere on Degen mode (collateral is SUI or USDC, but
  we Pyth-convert SUI to USD for display per `08_gamification_v2.md` §5).
  The toggle to denominate in SUI lives in More → Settings → "Show SUI
  amounts" (off by default).
- *MAX* = `min(wallet_balance_minus_gas_buffer, max_stake_per_market_session_cap)`.
  The `max_stake_per_market` from the session-key cap (§3.2 of indexer spec)
  is the binding constraint for warm sessions.
- *Default selected chip:* last-used. First-time = $5.
- *Long-press* on a chip opens an inline scrubber (rare, advanced — not
  surfaced on first 3 sessions).

### 5.4 Live position labels (the "0.4σ" problem)

This is the only place we use a math-word, so we test more:

| # | Candidate | Verdict |
|---|---|---|
| A | "0.4σ from line" | accurate, math-word. Reject for default user. |
| B | "2.7% from line" | better, percent is universal. Provisional pick. |
| C | "Almost touching" | qualitative, loses meaning in volatile cells. |
| D | "Inches away" | warm, but breaks when far. |
| E | "$0.68 to wick" | dollar-denominated distance. Honest. **WIN.** |

**Picked: "$0.68 to wick"** for absolute distance. Use **"WICKED!"** as the
state when touch fires. Use **"NO WICK · 12s"** for no-touch positions
counting down.

The distance ticker updates every 5s (Arcade) or every block (real markets).
When distance < 1% of barrier, the label flashes lime once per update.

### 5.5 Settlement labels

| State | Microcopy | Animation |
|---|---|---|
| Touch-side wins | **"WICKED!"** big lime headline | confetti burst from the touch point + slot-machine payout count |
| No-touch-side wins | **"HELD."** big lime headline | barrier line pulses, payout count |
| Touch-side loses | **"NO WICK."** white headline | barrier line dims, "you minted X WICK" sub |
| No-touch-side loses | **"WICKED OUT."** white headline | path overlay highlights touch event, "you minted X WICK" sub |

**Never:** "you lost", "loss", "0", "rekt". Loss is reframed as WICK mint.

### 5.6 Empty / dead states

| Context | Microcopy |
|---|---|
| 0 SUI in wallet | "Need gas. [Tap for free testnet SUI ↗]" |
| No live markets (impossible on testnet but plan for it) | "All rounds are between innings. Next up in 12s…" + animated egg-timer |
| First time, no positions | "No positions yet. Tap a card to play." (no upsell, no badge bait) |
| Slush wallet not installed | "Slush wallet needed. [Get it ↗]" + "Or scan QR with desktop Slush" |
| Session key expired | "Time's up — one tap to keep playing." → renews session key with a single signature |

### 5.7 The countdown

- **>60s left:** `1m 12s` (mono numerals)
- **30–60s:** `45s` (tighter, no minute)
- **<30s:** `29s` in lime, pulses once per second
- **<5s:** `4s 3s 2s 1s` in deep lime, full screen-wide haptic on each tick
- **0s:** transition to settlement animation (§6.3)

### 5.8 The brand verbs (used everywhere)

- **wick** (verb): the price crossed the line, even momentarily.
- **hold** (verb): the no-touch side surviving to expiry.
- **roll it**: reinvest the same stake into the next round.
- **mint**: receive WICK token from a loss.
- **the line**: the barrier price.
- **the round**: the time-window of a single market.
- **the pot**: total collateral in the market.

These are the only words a Degen-mode user needs.

---

## 6. Visual language

### 6.1 Color (lifted from the existing app + design 08)

- **Background:** `#0A0A0B` (true near-black, OLED-safe)
- **Surface 1 (cards):** `#141416` (1 step lighter)
- **Surface 2 (elevated):** `#1E1E22`
- **Lime accent (primary CTA, win, glow):** `#C5FF3D` (Wick lime)
- **White text:** `#FFFFFF` (titles), `rgba(255,255,255,0.72)` (body),
  `rgba(255,255,255,0.4)` (micro)
- **Loss neutral:** `#8C8C92` (NOT red — loss is mint, not catastrophe)
- **Soft red:** `#FF6B6B` reserved for system errors only (gas out,
  session expired, network)

### 6.2 Type

- **Display:** Geist Sans, 64–80pt for big headlines (WICKED!, HELD.)
- **Title:** Geist Sans, 28–32pt
- **Body:** Geist Sans, 16pt
- **Numbers:** Geist Mono everywhere (price, stake, payout, countdown)
- **Micro labels:** Geist Sans uppercase, 11pt, letter-spacing 0.08em

### 6.3 Motion (per gamification §5–§6)

The app has 4 named animations. They are reused everywhere; nothing else
animates.

1. **Heartbeat pulse** (300ms ease-out, 5s loop): the chart frame
   subtle-glows lime once per oracle observation. Mirrors the on-chain
   tick. *This is the dopamine loop.*
2. **Path draw** (60fps, real-time): each new observation draws a 1px
   lime line segment from the previous price to the new one. Old segments
   age to white at 0.4 opacity over 30s.
3. **Barrier glow** (variable opacity by σ-distance): barrier line at
   0.4 opacity when far, 1.0 + 8px lime halo when within 0.5σ. The halo
   pulses 1Hz when within 0.1σ.
4. **Touch fire** (1.2s, one-shot on settlement): from the point of touch,
   12-particle confetti burst (lime + white), barrier line pulses to 1.5x
   thickness then back, big "WICKED!" headline scales 0→1 with overshoot.
   Slot-machine count-up of payout from 0 to final amount over 600ms.

### 6.4 Sound (with one global toggle in More → Tune)

- **Tap** (40ms, 800Hz click): every primary tap.
- **Heartbeat** (60ms, low thump): syncs to heartbeat pulse, *only* on
  S5 watch room. Not on S1 (would drive users insane).
- **Whoosh** (300ms, lime-shimmer): touch fire animation.
- **Coin clink** (200ms, slot-machine): payout count-up.
- **Loss thud** (180ms, soft low): WICK mint settlement.

Sound is OFF by default. The first time a user opens S5, a small
"🔊 sound makes this better — tap to enable" toast appears once, dismisses
on tap.

### 6.5 Haptics (iOS UIImpactFeedback, Android equivalent)

- **Light tap** on every button press
- **Medium tap** on countdown ticks <5s
- **Heavy tap + 2x medium** on touch fire (the "you won" pattern)
- **Single soft** on settlement loss

Haptics ON by default. Toggle in More → Tune.

---

## 7. Edge cases + error states

These are the moments where Degen-mode either earns trust or loses it. Spec
each one.

### 7.1 Wallet disconnects mid-session

**What:** Slush extension hangs, user backgrounds the app, etc.
**Detect:** SSE heartbeat to indexer continues, but RPC calls fail.
**UI:** Top of S1/S2 shows a yellow strip: *"Wallet napping. [Reconnect]"*
Existing positions remain visible (they're public on-chain) and continue
to live-update. Trade buttons grey out.
**Resolve:** Tap [Reconnect] → re-issue session key (new sign), no
re-faucet.

### 7.2 Out of gas

**Detect:** PTB simulation fails with `InsufficientGas` OR balance < 0.05 SUI.
**UI:** *Cannot* let the user tap WICK YES/NO into a fail. Buttons swap to
**"NEED GAS — TAP TO REFUEL"** (single button, lime). On tap: faucet
request (testnet) or a "Buy SUI" deep link (mainnet, post-MVP).
**No popup.** No modal. Just the button swap.

### 7.3 Session-key cap breached

**Detect:** PTB reverts with `E_STAKE_OVER_TOTAL`, `E_LOSS_OVER`, or
`E_COUNTERPARTY_OVER` (per `09_events_indexer_v2.md` §3.2).
**UI:** Toast at the top: *"5-min play window full — [Top up?]"* Tap →
new decoded-PTB sign for a fresh session-key cap with a doubled stake
budget. **One sign.** Returns to the previous screen with a confirmation
toast.

This is the *only* time after first-launch that Degen mode shows a wallet
popup — and it's because the user has been playing enough that the cap
needs renewal. We frame it as success, not interruption.

### 7.4 RPC slow / indexer lagging

**Detect:** Per `09_events_indexer_v2.md` §4.6, frontend banner if
`cursor_lag_ms > 5000`.
**UI:** Subtle yellow strip at top of any screen: *"chain catching up…"*
The path overlay uses on-chain SDK reads (not indexer SSE) where possible
— the Arcade chart in particular is sourced direct (per demo script §6).
Trade buttons remain enabled if SDK reads succeed; greyed if they don't.

### 7.5 Position is being settled

Between the round expiring and the chain firing `MarketSettled`, there's
a 1–3s window where the position is in limbo.
**UI:** S5 shows *"Settling… ▾▾▾"* with a soft pulse. Path overlay
freezes. Countdown clears. Settlement animation fires when event lands.

### 7.6 Lost connection entirely (offline)

**Detect:** `navigator.onLine === false` OR no SSE for 30s.
**UI:** Full-screen sub-banner: *"You're offline. Your positions are safe
on-chain — they'll settle without you."* Big blue calming text, no panic.
No error red.

### 7.7 Frontend crash / white screen

**Detect:** React error boundary.
**UI:** Single screen with the wordmark and *"Something rough — [Reload]"*.
Logs to indexer admin endpoint with anonymized session id.

### 7.8 Phishing-clone landing page

Per `09_events_indexer_v2.md` §6.1: canonical-host check on boot. Mismatch
→ full-screen interstitial: *"You're not on the official Wick site.*
[Go to wick.markets]". This is the **one** modal that overrides the no-popup
principle, because security trumps UX everywhere.

---

## 8. Viral / share mechanics

We pick three. Anything more is dilution.

### 8.1 Auto-generated share-position card

After every settlement (win or loss), a *Share* button appears in the
result animation. Tap → generates a 1080x1920 OG image with:

- The chart with path + barrier (the actual round)
- "WICKED!" or "HELD." headline in lime
- Payout: +$X.XX
- "Tap to play: wick.markets/r/[market_id_short]"
- WICK wordmark bottom-left

Image is generated client-side via Satori (Vercel's HTML→SVG, per skill
guidance) and dropped into the OS share sheet. Default share text:
*"just wicked $X on @WickMarkets in 30s. tap to play →"*.

This is the **single most important viral surface.** Most casino-y apps
fail at share because the image is generic. We win because each share is
*the actual round* — visually distinctive, meme-friendly, on-chain
verifiable.

### 8.2 The "watching" widget on S5

The watch room shows *"89 traders watching"* (subtle, bottom of card).
When a friend's wallet enters the same market, you see *"@frog joined"*
ticker for 2s. This is opt-in — appears only if both have linked an X
handle in More → Settings.

If a wallet on your friends list wins, you get a soft toast on Play:
*"@frog just wicked $42 — tap to bet the same line"* → S4 with that
market preselected. **One tap to copy a friend's trade.**

### 8.3 Tournament invite (More → Tournaments → Invite)

Per `08_gamification_v2.md` §1.3: tournaments are a discovery surface in
"More". We don't push them in Degen mode. But every tournament has an
*Invite* button generating a share link with referrer-tracking. If a
referred user enters the tournament, the referrer gets a small WICK kick
(post-MVP, sized to avoid Sybil per §1.4).

### 8.4 What we explicitly do NOT do

- **No leaderboard share.** It's vanity, not viral. Hidden in More.
- **No badge unlock share.** Badges are progressive disclosure; share-on-mint
  trains users to grind.
- **No streak push notifications.** Per `09_events_indexer_v2.md` §6.7
  Responsible mode — we don't manufacture FOMO around return cadence.

---

## 9. Mode handoff (when does Advanced reveal itself?)

Three triggers, each gentle, each opt-in.

1. **After 10 settled positions:** a one-time toast on Mine: *"You're
   getting good. Want the trader workspace? [Try it]"*. Dismisses to
   never-show-again on close. Tap → switches to Advanced mode.
2. **More → Grow Up:** the explicit menu item, always available.
3. **Custom stake amount:** if the user types a custom amount on S4
   (long-press scrubber moved >2x), prompt: *"You're playing precisely.
   Want the full trader UI?"* — once per user.

We do **not** auto-graduate users. Some degens want degen forever, and
that is a valid taste. The toggle is sticky across sessions and survives
re-login (stored as `wick_ui_mode = 'degen' | 'advanced'` in
`localStorage`; a single account-level pref later).

Reverse path: Advanced has a "Switch to Simple mode" link in its
own settings drawer. Symmetry.

---

## 10. Implementation notes (frontend file structure)

The repo already has Vite + React + TS in `frontend/`. The shell and
components are partially built; we add a `mode` system without breaking
Advanced.

### 10.1 New file structure (additions in **bold**)

```
frontend/src/
├── App.tsx                 # routes by mode
├── main.tsx
├── lib/
│   ├── session-key.ts      # session-key cap creation, nonce mgmt (per 09 §3)
│   ├── share-image.ts      # **NEW** — Satori-based share-card generator
│   ├── audio.ts            # **NEW** — howler-style sfx loader, single global toggle
│   ├── haptics.ts          # **NEW** — wraps Capacitor Haptics, no-op on web
│   └── ptb.ts              # decoded-PTB summary builder (per 09 §3.4)
├── hooks/
│   ├── useSessionKey.ts
│   ├── useMarketSse.ts     # signed SSE client (per 09 §5.4)
│   └── useUiMode.ts        # **NEW** — `'degen' | 'advanced'` from localStorage
├── components/
│   ├── ui/                 # shared (button, chip, toast, skeleton)
│   ├── shared/             # **NEW** — used by both modes
│   │   ├── PriceChart.tsx              # already exists; refactor
│   │   ├── PathOverlay.tsx             # **NEW** — reusable path renderer
│   │   ├── BarrierLine.tsx             # **NEW** — glow + halo logic
│   │   ├── Countdown.tsx               # **NEW** — formats per §5.7
│   │   └── ResultAnimation.tsx         # **NEW** — confetti, slot-machine
│   ├── market/             # Advanced-mode existing components
│   │   ├── MarketsRail.tsx
│   │   ├── ChartPlaceholder.tsx
│   │   ├── MarketHeader.tsx
│   │   ├── MarketRow.tsx
│   │   └── TradePanel.tsx
│   └── degen/              # **NEW** — Degen-only components
│       ├── DegenShell.tsx              # bottom-nav layout
│       ├── ConnectScreen.tsx           # S0
│       ├── PlayFeed.tsx                # S1
│       ├── FeaturedCard.tsx            # S1 main card
│       ├── NextUpCard.tsx              # S1 secondary
│       ├── MineList.tsx                # S2
│       ├── PositionCard.tsx            # S2 individual
│       ├── MoreDrawer.tsx              # S3
│       ├── MarketDetail.tsx            # S4 (degen layout)
│       ├── WatchRoom.tsx               # S5
│       ├── StakeChips.tsx              # the $1/$5/$20/MAX strip
│       ├── WickButton.tsx              # the YES/NO mega-button
│       └── ShareSheet.tsx              # share-position card UI
├── routes/                 # **NEW** — react-router or hand-rolled
│   ├── degen.tsx           # all 5 Degen screens
│   └── advanced.tsx        # the existing trader workspace
└── config/
    └── badges.ts           # static BADGE_TEMPLATES per 09 §6.4
```

### 10.2 What's shared with Advanced mode

- All `lib/` (session keys, PTBs, share, audio, haptics)
- All `hooks/` (SSE, session, mode)
- All `components/shared/` (PriceChart, PathOverlay, BarrierLine,
  Countdown, ResultAnimation) — these are the *visual primitives* used
  by both modes
- The decoded-PTB modal (lives in `lib/ptb.ts`)
- All wallet-adapter wiring

### 10.3 What's Degen-only

- Everything in `components/degen/`
- The bottom-nav layout shell (`DegenShell.tsx`)
- The full-bleed featured card pattern
- Audio + haptic *triggers* (the lib is shared; only Degen wires them
  by default — Advanced is silent unless opted in)

### 10.4 Mode routing

`App.tsx` reads `useUiMode()` once on mount and renders either
`<DegenShell>` or `<AdvancedShell>`. Switching modes triggers a full
reload — we don't try to hot-swap.

```tsx
function App() {
  const mode = useUiMode();
  return mode === 'degen' ? <DegenShell /> : <AdvancedShell />;
}
```

### 10.5 Performance budget (mobile-critical)

- **First-paint < 1.5s on 3G** — ship Degen-mode bundle separately;
  Advanced lazy-loads on switch. Code-split point: `routes/`.
- **60fps on path-draw + barrier-glow** on iPhone 11 baseline. PathOverlay
  uses Canvas2D (not SVG) for >100 segments.
- **Touch-to-trade < 400ms** — pre-build PTB on mount of S1; signature
  is local (session key); broadcast is fire-and-forget with optimistic
  UI on S5.

### 10.6 Notifications

Three channels, all opt-in via More → Tune → Notifications:

1. **In-app toast** — always on (covered above).
2. **Web Push (FCM via Vercel function)** — *"your position settled — tap
   to see"*. Fires on `MarketSettled` for the user's open positions. Off
   by default.
3. **SMS** — post-MVP. Not in scope for hackathon.

Push-notification rule (per `09_events_indexer_v2.md` §6.7 Responsible
mode): **never push for "play again" prompts.** Only settlement, only the
user's own positions.

### 10.7 PWA / native shell

- For hackathon: ship as PWA with manifest + service worker (offline
  shell + cached chart). Slush mobile wallet works via WalletConnect or
  via Slush's iOS app deep-link handler.
- Post-MVP: Capacitor wrap for iOS + Android with native haptics + push,
  same JS bundle.

---

## 11. Onboarding (the 4-card swipe explainer)

Triggered automatically once on first launch (after wallet connect),
skippable at any point. Also accessible from More → "What is Wick?".

| # | Visual | Headline | Body |
|---|---|---|---|
| 1 | Animated path drawing toward a barrier line | **"Will it wick?"** | "Every round, a price moves. Will it touch the line?" |
| 2 | Two big buttons mock-up | **"Tap WICK YES or WICK NO."** | "Touch the line: WICK YES wins. Doesn't touch: WICK NO wins." |
| 3 | Settlement animation in a card | **"Win in seconds, not days."** | "Rounds settle in 30s to 5min. Win up to 3x your stake." |
| 4 | WICK token coin animation | **"Even when you lose, you mint."** | "Every loss mints WICK — our token. Hold it, earn fees, climb tiers." |

Bottom of every card: **[Start playing →]** (lime, full-width).

If we cannot ship the 4-card flow on Day 1 of the hackathon, the fallback
is a single-line modal *"Tap a card. Win the round. Tap More for help."*
on first launch. The 4-card is a v1.1 polish.

---

## 12. Testing protocol (how do we know Degen mode is working?)

### 12.1 The pre-launch usability gate

Before Degen mode ships, run a 5-user test on testnet with people who
have **never used Wick before** and who self-identify as crypto-curious
(not crypto-native). Tasks:

1. "Open this URL on your phone and place a bet."
2. "Wait for it to settle. Tell me what happened."
3. "Place another bet."

**Pass criteria:**
- 5/5 complete task 1 within 90s of opening the URL, no help.
- 5/5 correctly describe their settlement outcome in plain English.
- 4/5 complete task 3 in <10s.

If we fail this, we don't ship Degen mode. We iterate microcopy + flow.

### 12.2 Production metrics (post-launch)

| Metric | Target (mobile, Degen mode) |
|---|---|
| Connect → first bet (cold) | p50 ≤ 60s, p90 ≤ 120s |
| Bet → second bet (warm) | p50 ≤ 30s |
| Bets per session | mean ≥ 3, median ≥ 2 |
| D1 retention | ≥ 35% (degen users) |
| D7 retention | ≥ 12% |
| Share-card share rate | ≥ 8% of settled wins |
| Mode-switch to Advanced | ≤ 5% in week 1 (we want degens to stay) |
| Session-key renewal completion | ≥ 90% (i.e. cap-breach toast → success) |
| Crash-free sessions | ≥ 99.5% |

The two North Star metrics: **bets per session** (engagement) and
**D7 retention** (stickiness). Everything else is secondary.

### 12.3 Failure signals to watch

- High **drop-off at session-key sign** in S0 → simplify the decoded-PTB
  copy.
- High **drop-off between bet and settlement watch** → users are leaving
  S5 before fire. Either watch room is boring (animation issue) or
  rounds are too long (market-config issue).
- High **mode-switch to Advanced in week 1** → Degen is too dumbed-down
  for our actual user. Add affordances back.
- Low **share-card share rate** → image is generic / unshareable. Iterate.
- High **session-key cap breach rate** → defaults are too tight. Bump.

### 12.4 A/B tests we should run after launch (NOT before)

- Featured card auto-cycle vs static (does cycling raise engagement or
  cause confusion?)
- Sound on by default vs off by default (does sound-on raise D1 or
  scare users away?)
- WICK YES/NO vs WILL WICK/WON'T WICK button copy (validate §5.1
  pick post-launch)
- 4-card onboarding vs single-line modal vs no onboarding

We resist the temptation to A/B test before launch. Pick, ship, measure,
iterate.

---

## 13. What we explicitly cut (so we ship)

For hackathon-day Degen mode, these are deferred to v1.1+:

- SMS notifications
- Capacitor native shell (PWA only at launch)
- Friend-watching widget (§8.2) — needs handle-linking infrastructure
- Tournament invite referrer tracking (§8.3)
- A/B tests (§12.4)
- Dark/light mode toggle (we are dark-only)
- Internationalization (English-only)
- Accessibility audit beyond contrast minimums (post-launch task)
- Custom stake numeric pad (chips only)
- Multi-leg PTB tagging from Degen mode (Advanced only)

**Hackathon day must-ship:**
- S0 Connect with live teaser card
- S1 Play with featured + 2 next-up cards
- S2 Mine with live + done states
- S5 Watch room with full animation suite
- Sound + haptics with global toggle
- Share-card via Satori
- Session-key sign on connect, no other popups
- Toggle to Advanced mode

The 5 screens, the 4 animations, the 1 signature, the share button.
That's the bar.

---

## 14. The summary one-liner for the team

> **Degen Simple Mode = "Tap the wick, win the round."** Five screens,
> bottom-nav, no popups after connect, sound + haptic on touch fire.
> Featured Arcade card is the dopamine source; loss is reframed as WICK
> mint; share-card is the viral primitive. Hide everything else behind
> "More." Hackathon-day demo flows from S0→S2 in 90 seconds with one
> signature.

---

*End of Degen Simple Mode v1. Pairs with Advanced Trader Workspace
(separate spec, TBD). Both modes share `components/shared/` primitives,
session-key infrastructure, and signed SSE — they diverge only at the
shell + composition layer. Mode toggle is one tap, sticky in
`localStorage`, never auto-graduates the user.*
