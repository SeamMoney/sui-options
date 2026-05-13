# 02 — Advanced Pro Mode UX

> Status: design spec, v1.
> Companion to: `01_degen_simple_mode.md` (forthcoming — the tap-to-bet entry point).
> Anchors: `docs/design/v2/02_asymmetric_impact_fee_v2.md`,
> `docs/design/v2/04_solvency_v2.md`,
> `docs/design/v2/06_predict_btc_route_v2.md`,
> `docs/design/v2/07_deepbook_clob_v2.md`,
> `docs/design/v2/08_gamification_v2.md`,
> `docs/design/v2/09_events_indexer_v2.md`,
> `docs/threat-model.md`.
> Memory: `feedback_v3_layout_is_the_target.md`,
> `project_wick_ui_direction.md`,
> `feedback_first_time_user_clarity.md`.

The Degen mode answers a first-timer: *"Will BTC touch $100k by 12:05?"
Tap green or red."* Pro mode answers a quant: *"Show me the chain across
all expiries and barriers, let me build a four-leg spread atomically,
prove the vault is solvent, and let me bind it to ⌘⏎."* This document
specifies how.

The core principle: **same package, same SDK, same indexer**. Pro mode
is a **density skin and a feature unlock**, not a separate app. Toggling
to Pro reveals data and tools; it never exposes a different protocol.

---

## 1. Design principles

1. **Density without noise.** Mono numerals, 11–13px type, 4–6px
   padding, `#262626` hairlines. But we don't add a panel just
   because we can — six panels of empty states was the failure mode
   of the v1 Legend clone (`feedback_v3_layout_is_the_target.md`).
   Panels render only when they have content.
2. **The chain is the chart's twin.** A Pro user thinks in two views
   simultaneously: price action (chart) and the option surface across
   barriers and expiries (chain). Hovering a chain row highlights its
   barrier on the chart; clicking loads the ticket. One-way bound
   from chain to chart.
3. **Atomic-first composition.** Every multi-leg construct is a
   single PTB. "Leg 1 succeeded, leg 2 failed" is not a permitted
   outcome. The ticket previews the simulated PTB before signing.
4. **Production-honest, surfaced.** Vault `V_eff`, queue `Q`, keeper
   multisig health, oracle age, threat model link — not buried in
   /docs. They live in a Verify panel one keystroke away (`v`). On
   degradation, the relevant pip goes amber/red and the chrome's
   status indicator follows.
5. **Keyboard is the primary input.** Every action has a hotkey.
   Mouse is for chart manipulation only. `?` shows the map.
6. **Mono numerals, bps not %.** All numbers in Geist Mono with
   decimal alignment. `50 bps`, not "0.5%". Money displayed in mist
   for accuracy and collateral display units for scannability —
   `u` toggles globally.
7. **Degen is one click away.** `g d` lands in Degen with the current
   market preselected; Degen's "Pro this market" link opens the chain
   pre-filtered. Modes share state, not just routing.

---

## 2. Layout architecture

### 2.1 The shell

Five-pane desktop workspace inside `App.tsx`. Content area is
`100vw × calc(100vh − 40px)` (40px chrome top, 24px status bar
bottom).

```
┌────────────────────────────────────────────────────────────────┐
│ Wick · BTC-15min · status● · pkg · ⓥ · net · Connect · Mode ▾  │ 40px chrome
├─────────┬──────────────────────────────┬───────────────────────┤
│ MARKETS │           CHART              │       TICKET          │
│  RAIL   │                              │                       │
│  220px  │     flex (≥ 480px)           │       360px           │
│         ├──────────────────────────────┼───────────────────────┤
│         │           CHAIN              │     POSITIONS /       │
│         │     flex (≈ 35% height)      │     ORDERBOOK (tabs)  │
└─────────┴──────────────────────────────┴───────────────────────┘
                STATUS BAR (V_eff · Q · OI · oracle age)         24px
```

- **Markets Rail** (left, 220px) — v3 `MarketRow` cards, grouped by
  underlying, with collapsible group headers, Tier badge (CLOB / OTC
  / PRIMARY), and keeper spread on hover.
- **Chart** (top middle, flex) — candles with barrier lines and
  PathObservation envelope (§3.2). Timeframe segmented control above.
- **Chain** (bottom middle, ~35% height) — options surface across
  the selected underlying, every `(barrier, expiry)` as a row (§3.3).
- **Ticket** (top right, 360px) — multi-leg builder with PTB
  preview and Greeks/scenarios (§3.4 + §4).
- **Positions / Orderbook** (bottom right) — tabbed; Spreads tab
  appears once any `SpreadGroup` exists.
- **Status bar** (24px) — persistent `V_eff`, `Q`, per-underlying OI,
  oracle age, block height. One pip per subsystem.

### 2.2 Resize and layout presets

Drag handles between panes. Min sizes: rail 200px, chart 480×280,
ticket 320×360, positions 320×240, chain 480×180. Layout state is
persisted to `localStorage` per address.

Three named presets accessible via `g 1 / g 2 / g 3`:

- **`g 1` Default** — the layout above. Best for active monitoring.
- **`g 2` Chain-focused** — chain expanded to 60% height, chart
  collapsed to a sparkline strip. For surveying many barriers.
- **`g 3` Trade-focused** — chart 70%, chain hidden, ticket and
  positions stacked taller. For executing on a single market.

A fourth slot `g 4` is user-saveable — `⌘ S` saves current layout to
slot 4.

### 2.3 Tablet adaptation

Below 1180px viewport, the layout collapses to a two-pane split: rail
+ tabbed main (Chart | Chain | Ticket | Positions | Verify). Ticket
becomes a slide-over from the right when a chain row is clicked. This
is **not** the same as Degen mode — it's Pro mode adapted for less
real estate. Mobile (<768px) hard-redirects to Degen.

---

## 3. Panel-by-panel design

### 3.1 Markets Rail

Each row 56px: line 1 — `BTC ↑ $98,500 · CLOB`; line 2 — expiry
countdown + last touch prob; line 3 — full-width green/red prob bar
+ spot + distance. Hover reveals keeper bid/ask, OI, your size.
Right-click: pin / hide / open-in-Degen (`g d`) / copy market ID.

Sort: expiry (default), prob, OI, spread, your position. Filters:
underlying chips (BTC / SUI / SP500 / RWALK); tier chips
(CLOB / OTC); "only mine" toggle. `/` opens fuzzy filter over name,
ID prefix, and barrier value.

### 3.2 Chart pane

bklit candles (already shipped) with three Pro overlays:

1. **Barrier lines.** Every active barrier on this underlying renders
   as a horizontal line, side-coloured. Selected market's barrier is
   bold; others are 1px hairlines at 40% opacity. Shift-click in the
   chain selects multiple barriers (the **ladder view**).
2. **Path envelope.** A shaded band from
   `PathObservation.{max_seen, min_seen}` — what the protocol *knows*
   about excursion, vs what the chart *displays*. Discrepancies
   between candle highs and `max_seen` mean the oracle missed a tick
   or the keeper is lagging. Honest, not pretty.
3. **Touch zone.** Area between spot and barrier shaded by side bias.
   On HIT, the touch instant is marked with a wick annotation.

A vertical dashed line marks `expiry_ms` ("EXP 03:12"). `e`
recentres on expiry. Read-only chart in MVP; no drawing tools.

### 3.3 Chain (the strike chain)

Sortable, filterable table. One row per `(underlying, expiry,
barrier)` triple. Twelve columns: `Tier · Asset · Exp · Barrier ·
P_touch · Fair × · Offered × · Δspread (bps) · OI · Util · Path
(sparkline) · You`. Headers click-to-sort, shift-click reverse,
alt-click multi-sort. Per-column filter row below header; saved
filter sets via `⌘ F`.

Row interactions: click loads as single leg; shift-click adds as
additional leg; `a` adds via keyboard; cmd-click opens in Degen;
hover lights up the barrier on the chart.

Refreshes via SSE on `PriceObserved`, `MarketCreated`,
`MarketSettled`, `PositionOpened` for any visible market. Updates
flash a 1px amber border rather than re-rendering the row, preserving
selection.

### 3.4 Ticket — the multi-leg builder

The ticket is the most opinionated panel. It is **always a builder**,
even for a single-leg trade. A single TOUCH purchase is just a
1-leg spread. This unifies the code path and removes the "is this a
spread?" branching.

Top to bottom: per-leg list with `+ Add leg`; auto-detected Strategy
strip (net debit/credit, max profit, max loss, breakevens); Scenarios
panel (3–7 horizontal bars per the underlying's plausible range);
Greeks (collapsed `advanced ▾`); PTB Preview (`4 calls · 2 splits ·
est gas 0.0042 SUI`); `[▶ Simulate]  [⌘⏎ Sign & submit]`.

#### Per-leg controls

Each leg row: market selector (auto-filled from chain click), side
picker (TOUCH / NO-TOUCH × LONG / SHORT), stake input, and a
collapsible details strip with implied multiplier, exact payout, fee
in bps, and slippage tolerance. Stake field is mono, accepts `100u`
/ `100s` / `100m` shorthand for USDC / SUI / mist; default unit
follows the market's collateral coin. Right-edge `×` or `Backspace`
removes the leg.

#### Strategy detection (client-side)

Auto-labels from leg shape: 1L long touch → **TOUCH long**;
2L same-direction different barriers same expiry → **Bull / Bear
spread**; 2L opposite sides same barrier → **Synthetic long /
Conversion**; 4L two barriers + two expiries → **Calendar spread**;
≥3L same direction → **Ladder**. Drives the Strategy summary (net
debit/credit, max profit/loss, breakevens). On submit, the PTB
includes `spread::tag` (per `08_gamification_v2.md` §5) for badge
eligibility.

#### Scenarios

3–7 horizontal bars at hypothetical peak excursions. Touch options
have closed-form payoff given path peak — no Monte Carlo needed.

#### Greeks (advanced ▾)

Collapsed by default; expanded shows leg-summed `delta` / `vega` /
`theta` from the indexer's `touch_probability` partials.
Informational — never affects the trade payload.

#### PTB preview + submit

`▶ Simulate` runs `client.devInspectTransactionBlock` and renders
per-call object reads / balance deltas / emitted events; errors
highlight the first failing call. `⌘⏎` signs and submits. We **never**
auto-submit; user makes the final keystroke. After submit, the
ticket flips to a submitted state with tx digest + live event tail
from the SSE stream, clearing after 10s or on next leg.

Saved templates accessible via `Templates ▾` selector and `⌘ T`.

### 3.5 Positions

Tabbed: **Positions / Spreads / History**.

**Positions** — sortable table, one row per `Position`. Columns:
Market, Side, Stake, Entry mark, Current mark, Unrealised PnL,
Time-to-expiry, Status (LIVE / TOUCHED / EXPIRED), Actions.

Actions are contextual:
- **Close (early unwind)** — for TOUCHED, calls `redeem_winner`. For
  LIVE, disabled (you can't unwind a live binary — sell or post OTC
  instead).
- **CLOB sell** — for LIVE on CLOB-tier markets, inline sell ticket
  defaulting to the keeper's current bid as a limit.
- **Post OTC** — slide-out builder: price, size (default full),
  expiry (default 60 min), optional counterparty `to` address.
- **Tag as spread** — with ≥2 selected, runs `spread::tag` to bundle
  them into a `SpreadGroup` for badge eligibility and grouped display.

**Spreads** — rows are `SpreadGroup` objects, expandable to show
constituent positions. Group actions: close-all-via-CLOB,
close-all-via-OTC, untag.

**History** — every realised PnL event, sortable, CSV-export (`⌘ E`).
Includes badge mints, LP shares, OTC fills.

### 3.6 Orderbook (when CLOB market selected)

Auto-activates as a tab on the Positions panel for CLOB-tier markets.
Asymmetric DeepBook v3 depth histogram for the focused
`(market, side)`, plus 10 bid / 10 ask levels in a two-column table
with your resting orders highlighted amber. Click a level → pre-fill
ticket as a limit at that price. Below: Active orders with cancel
buttons; `⇧⌘C` cancels all. Polls 500ms when visible, 5s in
background. Top-of-book updates slide 1px rather than re-render so
selection isn't dropped.

### 3.7 Verify panel — the production-honest surface

A tab on the Positions panel, opened via `v`. Five collapsible
sections, each with a status pip and an "open on explorer" link:

- **Vault.** `V_eff` (1h EWMA), `V` (spot), drift over 1h,
  `Σ side_bucket`, `Q`, `Q / V_eff`%, per-underlying utilisation
  vs the `α_global` 25% cap (per `04_solvency_v2.md` §2.1).
- **Keeper.** Multisig status (2-of-3 signer health), seconds since
  last successful tick, daily-loss circuit-breaker state, CLOB
  inventory per `(market, side)` vs `MAX_INV_PER_SIDE`
  (per `07_deepbook_clob_v2.md` §3.2).
- **Oracle.** Per-underlying source (Pyth Lazer / Predict /
  Wick PRNG), age in seconds, Lazer signature verifier on/off,
  pinned `OracleVersionLock` ID.
- **Tournament** (if active). ID, status, raw vs prize-eligible
  pot, your raw rank, cluster status (PRIMARY / SECONDARY).
- **Threat model.** Link to `/docs/threat-model.md`, count of
  active warnings, last red-team pass date, subscribe-to-status
  control.

Each section's header has a status pip:
- ● green: nominal
- ● amber: degraded but operating (e.g. oracle age 3–10s, OI > 80%
  of cap, queue > 0 but < 25% V_eff)
- ● red: failed (e.g. oracle > 10s, queue > 50% V_eff, multisig
  member offline, daily-loss breaker tripped)

If any pip goes red, the chrome's `status●` indicator and the
status bar both go red, and a non-dismissable banner appears at the
top of the chart pane: *"BTC oracle stale 14s — keeper has cancelled
all CLOB orders. Open trades are unaffected. See /docs/threat-model
§ Oracle staleness."*

This is the contract: **we never hide degradation from a Pro user.**
A red status pip with a clear recovery path is more credible than a
green status pip that's lying. Production-honest, surfaced.

### 3.8 Dashboard (auxiliary view)

Reachable via `g h` (go-home). Replaces the workspace with a single
full-width view of: P&L curve over time (realised + unrealised, with
the toggle between collateral and USD-equivalent), WICK earned per
day, your badges, your leaderboard rank (raw and prize-eligible),
lifetime touches won, your tournament history.

Pro users will glance at this once a day. It's not the default view
— `g 1` returns to the workspace.

### 3.9 Tournament + leaderboard panels

A small Tournament strip in the chrome, visible when a tournament is
ACTIVE — single line: `t-2026-05-12-19 · ACTIVE · pot 1,247 SUI ·
your rank #14`. Click expands a slide-over with the full tournament
context (entries, prize-eligible cutoff, time-to-settle, your
positions in tournament markets).

Leaderboard accessible via `g l`. Renders both the raw and prize-
eligible boards side-by-side, with cluster-filter explanations
inline (per `08_gamification_v2.md` §2.2). Pro users want to see the
truth even when it's not flattering.

The point of "de-emphasised": tournaments are visible but not the
home view. A Pro user is looking at markets and positions, not at
their leaderboard rank.

---

## 4. Multi-leg builder — full spec

### 4.1 The mental model

Every action is a leg. A leg is one of:

| Leg type | What it does | Underlying call |
|---|---|---|
| `LongTouch(market, stake)` | Buy TOUCH-side coins | `wick::open_position(SIDE_TOUCH, stake)` |
| `LongNoTouch(market, stake)` | Buy NO-TOUCH-side coins | `wick::open_position(SIDE_NO_TOUCH, stake)` |
| `ShortTouch(market, qty, price)` | Post CLOB or OTC ask of TOUCH coins from inventory | `clob::place_limit_order` or `otc_escrow::post_otc_ask` |
| `ShortNoTouch(market, qty, price)` | Same, NO-TOUCH side | (same) |
| `Close(position_id)` | Sell to keeper, post OTC, or redeem if settled | router decides |
| `RedeemSpread(group_id)` | Atomic redeem of a tagged spread | `wick::redeem_complete_set` if applicable |

The ticket's leg list is an ordered vector. Order matters because the
PTB encodes them sequentially — earlier legs' results flow into later
legs (e.g. mint a position in leg 1, post it as an OTC ask in leg 2).

### 4.2 PTB construction

The compiler in `frontend/src/modes/pro/ticket/ptb.ts` walks legs in
order and emits a single `Transaction`. The contract:

1. **Coalesce splits per coin type.** One `tx.splitCoins` per
   collateral, sized to the sum of all leg stakes in that coin.
2. **Long legs before short legs.** Long legs (`open_position`) bind
   their `Position` result to a slot index; short legs reference that
   slot (so a "buy then OTC-list" spread is one PTB).
3. **`spread::tag` last.** If `legs.length ≥ 2` and `tagAsSpread` is
   on, append `spread::tag` over the vector of position refs.
4. **Single sender.** Wick never co-signs. The PTB is sender-only;
   session keys (§10.3) are an alternative sender, not a relayer.
5. **Refund overage.** Any collateral split-residual is transferred
   back to the sender as the final call.

`Leg` has a discriminated union for `LongTouch`, `LongNoTouch`,
`ShortTouch`, `ShortNoTouch`, `Close`, `RedeemSpread`. Short legs
choose `venue: "CLOB" | "OTC"`. Close legs route between
`redeem_winner`, CLOB sell, and OTC post based on market status and
liquidity tier.

### 4.3 The Greeks math

Probabilities come from the indexer's `touch_probability` endpoint,
which uses the same model the keeper uses for fair-value quoting
(per `07_deepbook_clob_v2.md` §3). Greeks are computed per-leg as
finite differences:

- **Delta** ≈ `(P(spot+ε) − P(spot−ε)) / (2ε)`, with ε = 0.1% of spot.
- **Vega** ≈ `(P(σ+δ) − P(σ−δ)) / (2δ)`, with δ = 1% of σ.
- **Theta** ≈ `(P(t−Δt) − P(t)) / Δt`, with Δt = 1 hour.

The `touch_probability` model lives in `@wick/sdk` so the frontend
and keeper agree. Indexer caches per-market Greeks every 30s and
exposes them at `/markets/:id/greeks` (per `09_events_indexer_v2.md`
§5).

### 4.4 Atomic preview before sign

Before signing, the ticket calls `client.devInspectTransactionBlock`
with the constructed PTB. The result includes:

- **Effects.** Created / mutated / deleted objects.
- **Balance changes.** Per-coin, per-address.
- **Events.** Including `PositionOpened`, `OtcOrderPosted`, `SpreadOpened`.
- **Gas estimate.** Renders in the PTB Preview strip.
- **Errors.** First failing call's source-line annotated.

If any leg fails simulation, the ticket flags it with a red border
and prevents submit. The user can click the failing leg to jump to
its row, which highlights the error reason.

This is the answer to "what does atomic mean?": before you sign, you
see exactly what would happen. After you sign, that exact thing
happens, or nothing does.

---

## 5. Verification surfaces — exposing production-honest claims

The Verify panel (§3.7) is the centrepiece, but verification surfaces
are sprinkled through the rest of the UI too:

- **Tier chips** on every market row (CLOB green / OTC cyan / PRIMARY
  grey). Click → 3-sentence explainer + link to the design doc.
- **Chrome status pip** reflects the worst of {vault, queue, oracle,
  keeper}. Click → Verify panel scrolled to the worst section.
- **Per-leg "Powered by"** in the ticket names each leg's oracle
  source (Pyth Lazer / Predict / Wick PRNG). Click → modal with
  publisher pubkey, last-N signed observation digests, and the
  `OracleVersionLock` ID.
- **Keeper degradation banner** (non-dismissable, amber) above the
  chart whenever the keeper transitions to cancelled, oracle-stale,
  or circuit-breaker-tripped, citing the relevant threat-model
  section.
- **On-chain solvency proof** button on the Vault section — opens
  the latest `SolvencyAttestation` event with `V_eff`,
  `Σ side_bucket`, `Q`, computed equity `E`, and the `tx_digest`.
- **`ⓥ` icon** persistent in the chrome's right edge → opens
  `/docs/threat-model.md` in a modal. Always visible, never in the
  footer.

The contract: production-honest beats production-confident. A red
pip with a clear recovery path is more credible than a green pip
that's lying.

---

## 6. Microcopy and density

Pro mode strips Degen's plain-language wrapping. Conventions:

- Use **TOUCH / NO-TOUCH**, not "Will hit / Won't hit". Pro users
  trade by the protocol's primitives.
- Use **bps**, not "%". `50 bps`, not "0.5%".
- Use **multipliers**, not "odds". `2.4×`, not "2.4-to-1".
- Use **mist** and **collateral display units** in parallel: a fee
  is `50 bps (≈ 0.50 USDC)`. The leading number is the protocol's
  unit; the parenthetical is the user-friendly conversion.
- Use **expiry as countdown**, not as wall-clock. `03:12` (mm:ss for
  ≤1h, h:mm for ≤24h, "2d 4h" beyond). Hover for absolute
  timestamp.
- Use **abbreviated underlying**: BTC, SUI, SP500, RWALK-25. No
  full names in the chain or rail.
- Use **`L` prefix for "long" and `S` for "short"** in the spread
  detector's strategy label: "L98.5k / S102k touch" for a bull
  spread.
- Numbers use **mono numerals** universally, with **decimal
  alignment** in tables.
- Errors use **the on-chain abort code** in addition to the human
  message: `EInsufficientCollateral (22): not enough USDC in your
  wallet to cover this leg's stake`. Pro users grep for those.

Density target: the chain panel shows ≥18 rows above the fold at
1080px height. The ticket shows ≥4 legs without scroll. The Verify
panel fits the entire vault + keeper + oracle status in one
viewport.

---

## 7. Visual language

Aesthetic: **Robinhood Legend × IBKR TWS × VS Code dark+**.

Tokens (extending the v3 set): app bg `#0a0a0a`, pane bg `#0f0f0f`,
card bg `#161616`, hairlines `#262626` (1px, never 2px), selected
row `#1f1f1f` + 1px left accent in the row's side colour, TOUCH
`#22c55e`, NO-TOUCH `#ef4444`, amber `#f59e0b`, muted text `#737373`,
primary text `#ededed`. Type: Geist Mono 500 for numerals,
line-height 1.2; Geist Sans 400 at 11px for column headers, 12px
for body.

**Anti-casino discipline.** No glow. No gradients (other than the
path envelope shade). No animated tickers — values jump on update
with a 100ms accent flash, then settle. No emoji. No win confetti
(Degen can; Pro doesn't). No streaks, no daily-rewards popups; the
badge gallery is opt-in via `g b`. Colour conveys data, not
decoration. The reference set is Linear, GitHub Primer dark,
TradingView, Legend — deliberately the opposite of Polymarket /
Stake / Rollbit visual maximalism.

---

## 8. Keyboard shortcuts

Full map renders on `?`. Conflicts caught at registration time by
`KeymapRegistry`; bindings tested via Playwright.

**Global**: `g 1/2/3/4` layout preset · `g h` dashboard · `g l`
leaderboard · `g b` badges · `g t` tournament · `g s` settings ·
`g d` → Degen · `g p` → Pro · `?` map · `⎋` close.

**Rail**: `j/k` next/prev · `↩` load · `/` filter · `f b/s/e/r`
filter to BTC/SUI/SP500/RWALK · `f c/o/p` tier filter · `f m`
"only mine".

**Chain**: `J/K` next/prev · `↩` load as new single leg · `a` add as
additional leg · `s/S` cycle/reverse sort · `⌘ F` filter sets.

**Ticket**: `t l/n/s/c` add long-touch / long-no-touch / short-OTC /
close · `1–9` focus leg N · `Backspace` delete focused leg · `r`
reset · `Space` simulate · `⌘⏎` sign & submit · `⌘ T` templates ·
`⌘ S` save current shape as template.

**Positions / Orderbook**: `p/o` switch tabs · `e` close action menu
· `c` cancel order · `⇧⌘C` cancel all on market · `⌘ E` CSV export.

**Verify**: `v` open panel · `V` open threat model modal.

**Chart**: `1/5/q/h/d` timeframe · `e` recentre on expiry · `0`
reset zoom.

**Unit toggle**: `u` flip between mist and collateral display units.

---

## 9. Mode toggle UX

Mode is persisted in `localStorage.wick.mode`, default `degen` for
new users (per `feedback_first_time_user_clarity.md`). Toggle lives
top-right in the chrome as `Mode ▾`, also `g d` / `g p`.

**State preservation.** Selected market preserved across toggle —
Pro on `BTC ↑ $98.5k · 12:05` → `g d` lands in Degen on that exact
card; Degen → `g p` opens Pro with the chain pre-filtered.

In-flight ticket state is **not** preserved — Degen can't represent
a 4-leg spread. Toggling mid-edit prompts: *"You have 3 legs in your
ticket. Discard and switch to Degen, or stay in Pro?"*

**Routing.** Pro at `/pro/...`, Degen at `/`. URLs shareable:
`/pro/btc/98500-1205` and `/btc/98500-1205` are the same market in
the two modes.

**First-time disclosure.** A one-time modal on first toggle to Pro:
*"Pro mode unlocks the options chain, multi-leg spreads, on-chain
verification, and keyboard shortcuts. It assumes you know what a
touch option is. Flip back any time with `g d`."* `[Show me] [Take
the tour]` — tour is a 4-step Shepherd.js overlay on Markets Rail,
Chain, Ticket, Verify.

**Important separation.** Degen is **not** Pro with panels hidden.
It is a different React tree (`modes/degen/*`) with its own components
(`MarketCard`, `BetButton`, `PayoffSlider`). Shared layer: SDK,
hooks, lib. This lets Degen ship a sub-200kb bundle (no chart
library, no orderbook, no PTB compiler) while Pro layers on heavy
deps without bloating Degen.

---

## 10. Power features

- **Saved order templates** — `localStorage`-stored, parameterised by
  underlying / barrier offset / expiry offset. Apply to a market →
  resolves against current spot and time. Exportable as JSON for
  sharing.
- **CSV history export** — `⌘ E` from History tab: timestamp,
  tx digest, event type, market, side, size, price, fee, realised
  PnL, badge earned. CSV-only in MVP.
- **Personal API key** (read-only) — mint from Settings, scoped to
  your address, authenticates against indexer `/api/v1/...`. For
  trading the analogue is the **session key** (per
  `09_events_indexer_v2.md` §2.2): on-chain capability with caps on
  stake / loss / expiry / per-counterparty volume. Sign once, trade
  for 24h. Not an integration surface for bots — bots that misbehave
  hit a cap and the cap kills the key on-chain.
- **Custom alerts** — conditions on BTC touching `$X`, position
  status changes, `Q/V_eff > 25%`, oracle age > 5s, tournament rank
  change, new CLOB market. Delivery: in-app toast, browser push,
  email, webhook. SSE-driven (per `09§6`).
- **Risk-cap inspector** — collapsed `Risk ▾` strip in the ticket
  showing per-leg post-trade `WOI / V_eff` and remaining headroom
  vs `α_global = 25%` (per `04_solvency_v2.md` §2.1). Leg flagged
  red pre-emptively if it would breach. Client-side from
  `/risk/woi-snapshot`; final on-chain check at submit.

---

## 11. Implementation notes

### 11.1 What's shared with Degen

**Everything below the component layer:**

- `@wick/sdk` — PTB builders, type tags, event parsing.
- `frontend/src/lib/` — fetch wrappers, formatters, SSE client,
  market-state derivations.
- `frontend/src/hooks/` — `useMarkets`, `usePositions`,
  `useOrderbook`, `useVault`, `useOracleAge`.
- `frontend/src/config/` — `WICK_PACKAGE_ID`, network constants,
  collateral coin types.
- The wallet adapter, the indexer URL, the SSE topic registry.

**Mode-specific:**

- `frontend/src/modes/degen/` — Degen's React tree
  (`MarketsCarousel`, `BigBetCard`, `PayoffSlider`, `WinLoseBars`).
- `frontend/src/modes/pro/` — Pro's React tree (everything in §3).
- `frontend/src/modes/shared/` — `<Chrome />`, `<ModeToggle />`,
  `<ConnectButton />`, `<NetworkBadge />`.

### 11.2 Frontend file structure (pro/)

```
frontend/src/modes/pro/
├── ProApp.tsx              // routes + layout shell
├── layout/                 // Workspace, StatusBar, presets
├── markets/                // MarketsRail, MarketRowPro, filters
├── chart/                  // ChartPane + Barrier/PathEnvelope/TouchZone overlays
├── chain/                  // Chain, ChainRow, columns, strategyDetect
├── ticket/                 // Ticket, LegEditor, Scenarios, Greeks, PtbPreview, ptb.ts, templates
├── positions/              // PositionsPanel, SpreadsTab, HistoryTab, exportCsv
├── orderbook/              // OrderbookPanel, DepthChart, LevelsTable
├── verify/                 // VerifyPanel + Vault/Keeper/Oracle sections
├── tournament/             // TournamentStrip
├── dashboard/              // Dashboard
└── hotkeys/                // KeymapRegistry, useHotkey, HotkeyMap
```

### 11.3 Build constraints

- Pro bundle ≤ 600kb gzipped. Code-split bklit, the PTB compiler,
  and the DepthChart as dynamic imports loaded on first interaction.
- Lazy-load dashboard / leaderboard / badge gallery / tournament
  behind `g h / g l / g b / g t`.
- SSE topics: `markets`, `positions:${addr}`, `vault`,
  `oracle:${underlying}`, `keeper-status`, `orderbook:${marketId}`.
  Subscribed at workspace mount, unsubscribed on unmount.
- Persistence: layout / mode / hotkey overrides / templates / alerts
  / filter sets in `localStorage.wick.*`. Personal API keys and
  session-key seeds in `IndexedDB`, encrypted via a user-set
  passphrase or `webauthn` PRF when available.

### 11.4 Test surface

Storybook for every panel with mocked SDK data. Playwright e2e for
hotkeys. Property-based tests for `strategyDetect` and the PTB
compiler. Visual regression for the chart at 1080/1440/2160p.

### 11.5 Out of scope for v1

Chart drawing tools, indicator scripting, social copy-trading,
multi-account view, programmable conditional orders, native mobile.
Revisit after real Pro behaviour is observed.

---

## 12. Open questions

1. **Sticky Pro for repeat users.** Keep Pro on next visit, or
   bounce returning >30-day users back to Degen? Lean sticky.
2. **Chain pagination at scale.** ~200 rows is fine; 600+ at full
   listing needs virtualisation (`react-virtuoso`) + default filters.
3. **Mixed-oracle spreads.** A BTC (Predict) + RWALK (Wick PRNG)
   spread may mis-label in `strategyDetect`. Acceptable to fall
   through to "Custom"?
4. **Session-key counterparty cap UX.** Surface the per-counterparty
   cap as a budget gauge in the ticket, or only as a post-hoc error?
   Lean toward gauge.
5. **Greeks plain-English mode.** Offer "Sensitivity to spot/vol/
   time" as an alias under `g s`? Or trust that the `advanced ▾`
   disclosure self-selects?
6. **Tablet multi-leg.** Cap legs at 2 on tablet, or let the ticket
   scroll? Lean toward scroll.
7. **Sim cost for large spreads.** `devInspect` on 6+ legs takes
   2–3s. Debounce on edit, or only on explicit `▶ Simulate`? Lean
   toward explicit.
8. **Verify panel: inline vs route.** Inline is faster; `/pro/verify`
   is shareable. Lean toward inline + "open in tab".
9. **Non-QWERTY keymap.** Vim-style `j/k` breaks on Dvorak/AZERTY.
   Ship a remap UI, defaults stay QWERTY.
10. **Mode in URL.** `/pro/btc/...` (path) vs `/btc/...?mode=pro`
    (param). Lean toward path.

---

*End of Pro Mode UX spec. Implementation begins after the v2 hardening
modules in `Phase H` ship — specifically `OracleVersionLock`,
`GlobalExposureRegistry`, and `UserPredictAccount` are required
dependencies for the Verify panel and the BTC route ticket.*
