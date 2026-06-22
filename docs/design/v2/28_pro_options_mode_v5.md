# 28 — Pro Options Mode (v5)

> **Built note (2026-06-22):** this records the original v5 design exploration. Pro Options
> Mode shipped as **`/pro` (`WickProLive`)** — Black-Scholes options priced off a **live
> DeepBook mark**, not the "Robinhood-Legend" UI prototyped below. The vendored
> `frontend/robinhood-legend/` reference code was never wired in and has been **removed** from
> the repo; the Legend-UI references in this doc are historical, not current state.

**Status:** design / spec-first. No production code until Phase 1 is approved.
**Author seed:** product brief 2026-06-02. Supersedes the assumption that the tap-hold
ride gesture generalises to options.

> One line: *Round-based, provably-fair options trading on synthetic candlestick
> markets — Robinhood-Legend UI, Black-Scholes-priced contracts, house edge, built to
> train (and bet on) TA + options skill.*

---

## 1. Why this exists / the core reframe

The tap-hold **Ride** gesture ("long while I hold, sell when I let go") is a **spot**
primitive. Exposure = holding. It never mapped cleanly onto options/prediction markets
because an option is a *contract with a strike and an expiry*, not a position you
continuously hold. Forcing the gesture onto options is why degen mode felt wrong there.

**Decision:** Ride/degen stays the **spot** product. Pro Mode is a **separate product**
with real options mechanics: choose strike + expiry, pay premium, receive the payoff
curve if ITM at expiry, else it expires worthless — with an explicit **Sell to close**.

This is a deliberate expansion **past the locked MVP** (AGENTS.md puts vanilla options
out of MVP scope). It introduces a new market type and new Move modules.

---

## 2. Decisions locked (this round)

| Topic | Decision |
|---|---|
| **Contract style** | European **hold-to-expiry as the base** + a first-class **Sell to close** (mark-to-market buyback by the vault). No full American — "Sell at mark" is the strictly-better realistic version of early exercise. |
| **Pricing** | **Black-Scholes off-chain** for premiums, Greeks, payoff curve, live mark (the experience). **Bachelier on-chain** as a cheap guardrail/bound + fully-on-chain fallback. Settlement itself needs neither — it pays intrinsic vs the committed path. |
| **House edge** | **Spread/vig on the fair price + mild rug.** BS fair price + transparent spread, plus occasional rug candles biasing realized paths slightly against holders. Must be stated honestly in UI/README/threat model. |
| **Fairness** | Commit-reveal: keeper generates the full path at lobby start, publishes a hash commit, streams candles in real time, reveals the seed at settle so anyone can verify. Clients never get the seed early. |
| **Build order** | **Spec first (this doc) → off-chain single-player prototype → multiplayer → on-chain.** |

**Open (Section 9):** exact round/expiry timeline; practice-vs-money first; number of
concurrent markets at launch.

---

## 3. What we reuse vs scratch

**Reuse (≈80% of the surface already exists):**
- **Synthetic price engine** — `packages/candle-vision` `generateCandles`/`streamCandles`
  (regime GBM + noise). "Different markets" = parameterise vol/drift/jump/mean-reversion
  → Calm / Volatile / Trending / Choppy tables (reuse `RegimeBadge`).
- **Chart + animation** — lightweight-charts + GSAP camera + the gamified lock-on/HUD.
- **Legend options widgets** — `OptionsChainWidget`, `OrderEntryFlyout`, `SimulatedReturns`
  (the payoff curve), `OrderBook`, `InstrumentDetail`, `PositionsTable`, pixel charts.
- **Move house-bank + rounds** — `MartingalerVault` (house/LP), `Position`, `PathObservation`,
  `RiskConfig`, fee router, USD oracle, segment-market v4 rounds + rug edge (doc 26),
  commit-reveal (doc 17).
- **Pricing math** — Bachelier (`compute_pwe`) already on-chain.
- **Collateral / faucet / keeper** plumbing.

**Scratch / shelve:**
- `frontend/robinhood-legend/LegendApp.tsx` DOM **replay** (static scrape, no live canvas) —
  vendored as a visual reference, then **REMOVED** (it was never wired in). The shipped `/pro`
  (`WickProLive`) was built with a *live* DeepBook canvas instead — exactly the "real UI" this
  section called for, so the static replay was no longer needed.
- The tap-hold-for-options assumption.
- Binary touch/no-touch as the hero (keep as a side product).

---

## 4. Architecture

### 4.1 Canonical timeline & fairness (the load-bearing piece)
You can pre-generate the whole path at lobby start, but **clients must never get the seed**
or they know the future. So:

1. **Lobby start:** keeper generates full path `P` (params + seed), publishes
   `commit = H(seed ‖ params ‖ round_id)`.
2. **Lobby:** clients see the chart's opening history + a **probability cone / ghost paths**
   (the *distribution*, not the outcome). Users deposit USDC, browse the chain, buy.
3. **Round:** keeper **streams candles in real time** to all clients (everyone sees the
   same thing). Clients are thin renderers.
4. **Settle:** keeper reveals `seed`; anyone recomputes `P` and checks it matches `commit`
   and the streamed candles. Options settle against `P` at their expiry timestamps.

### 4.2 Pricing (BS off-chain, Bachelier on-chain)
- **Entry premium & Greeks & payoff curve & live mark:** off-chain TS Black-Scholes on the
  synthetic asset (σ from the market's regime params, r ≈ 0, τ in seconds). Full precision.
- **Settlement:** cash-settled → pay `max(0, ±(S_expiry − K))` (call/put) from the committed
  path. **No pricing on-chain at settle.**
- **Sell to close:** vault quotes a **mark** = off-chain BS mark (current streamed `S`,
  remaining τ) − spread. On-chain buyback honors a signed quote **bounded by on-chain
  Bachelier** so the quoter can't cheat.
- **Fully-on-chain markets (later):** Bachelier premium directly, no off-chain quoter.

### 4.3 House edge accounting (honest)
- **Spread/vig:** every premium and every mark carries a transparent spread → primary edge.
- **Mild rug:** low-probability rug candles (reuse doc-26 `rug_chance_bps`) bias realized
  paths against holders → secondary edge. Must be disclosed; Monte-Carlo the combined edge
  (extend `scripts/simulate_v4_house_edge.py`) so the number is known and stated.
- **Counterparty:** `MartingalerVault` is the house/LP and the other side of every contract;
  caps on aggregate per-round option exposure via `RiskConfig` / a per-round option cap.

### 4.4 Settlement & collateral (Move, Phase 3)
New `wick::option_market` module:
- `OptionPosition` — `key,store`: market id, side (call/put), strike, expiry_ts, premium_paid,
  contracts, collateral, status (OPEN / SOLD / EXERCISED_SETTLED / EXPIRED_WORTHLESS).
- Buyer pays premium into the vault; vault escrows max payout. Cash-settled.
- `settle_option` (permissionless, at/after expiry): reads committed path at `expiry_ts`,
  pays intrinsic, releases escrow. Idempotent.
- `sell_to_close` (before expiry): vault buys back at a signed, Bachelier-bounded mark.
- Preserve the collateral invariant analog: `vault_escrow == Σ max_payout(open positions)`.

### 4.5 Synthetic orderbook (Phase 4, flavor — NOT source of truth)
Do **not** derive candles from random flow (can't commit to a chaotic outcome). Instead:
**commit the path, then synthesize order flow / DOM / recent-trades consistent with it** for
realism. Drives `OrderBook` / DOM / recent-orders widgets.

### 4.6 UI (Legend, pro)
- Pull strike + breakeven lines onto the chart, extended into the ghost/future area —
  chart-reading and the contract become one act.
- `SimulatedReturns` as the payoff curve; Greeks panel (Δ/Θ/Γ/vega) for the skill angle.
- Lobby: countdown, deposit, chain, probability cone. Round: fast candles, live mark, P&L,
  Sell button. Multiplayer: player count + shared positions feed.

---

## 5. Round structure — Desk / Live split (LOCKED)

The key insight: **opening** an option and **managing** one have opposite cognitive loads,
so they live in different modes. This dissolves the "lobby-only = Crash" vs "mid-game chain
is too much under time pressure" tension.

- **Lobby = the Options Desk (deliberate).** Full option chain, payoff curves, Greeks,
  strike/expiry selection, probability cone. No time pressure — this is where users *think*
  and build positions. The Legend options widgets live here.
- **Live round = position management (fast).** Users do **not** see a live chain. They see
  **their own position(s)**: strike line on the chart, live mark, P&L, and one big **Sell to
  close** button. Glanceable while candles fly. This is the cash-out agency (the spiritual
  successor to degen's tap-hold), in honest options language.
- **One shared synchronized chart per round** — everyone watches the same reveal resolve
  together (Crash-style drama + clean fairness), but with real mid-game agency (Sell).

Not Crash (your hand is on the wheel the whole time), not an overloaded live chain, not a
faceless continuous market. "Crash you can actually trade inside of."

**Cadence (to confirm in tuning, not architecture):** Lobby ~60s (opening bell) → Live reveal
(shared chart plays out) → Settle/results → next lobby. Options expire at T+10..60s into the
live reveal. Whether the reveal is ~60–90s or longer is a tuning knob, not a structural one.

**Later (optional):** one-tap pre-baked quick-buys mid-round (e.g. "ATM call, T+30s") for more
live action — never the full chain mid-round.

---

## 6. Skill-training & framing
- **Practice (no-money) mode** sharing the exact engine — serves the "train TA/options skill"
  goal and softens the gambling framing for onboarding.
- Optional skill metrics: win rate by setup, Greeks intuition, post-round "what the chart did".

---

## 7. Phasing
- **Phase 0** — this doc.
- **Phase 1** — off-chain single-player prototype (no money): lobby→round clock, seeded gen +
  commit-reveal, BS pricing + payoff curve, Legend UI, buy→settle→P&L, Sell-to-close. Reuses
  ~80% of existing code, zero Move. Proves the loop in days.
- **Phase 2** — multiplayer canonical round: keeper/edge service streams the committed path to
  all clients; shared lobby + player feed.
- **Phase 3** — on-chain `option_market` + USDC collateral; vault as counterparty; commit-reveal
  + rug edge on-chain; Bachelier bounds.
- **Phase 4** — synthetic orderbook microstructure driving DOM/trades widgets.
- **Phase 5** — polish: market regimes, Greeks, leaderboards/skill metrics, practice mode.

---

## 8. Risks / considerations
- **On-chain BS is infeasible/expensive** → resolved: BS off-chain, settlement is intrinsic-only,
  Bachelier bounds on-chain.
- **Edge legibility** (AGENTS.md honesty rule) → spread is transparent; rug disclosed + MC'd.
- **Quoter trust** for off-chain premium/mark → signed quotes bounded by on-chain Bachelier.
- **Multiplayer determinism** → single keeper-streamed canonical timeline; clients never derive.
- **Regulatory framing** → skill-game / simulator positioning; practice mode.

---

## 9. Open questions for product
1. **Timeline:** RESOLVED — Desk/Live split (§5). Open positions in the lobby, manage
   (Sell-to-close) live, one shared chart per round. Exact reveal duration is a tuning knob.
2. **Money vs practice first:** RESOLVED — practice/play-money in Phase 1 to iterate on fun;
   on-chain money design written in parallel (§4.4 / Phase 3), built only once it's fun.
3. **How many markets at launch** (1 regime vs a small grid of Calm/Volatile/Trending/Choppy)?
4. **Spread size** + whether rug is on from day one or added after the spread-only edge is
   measured.
