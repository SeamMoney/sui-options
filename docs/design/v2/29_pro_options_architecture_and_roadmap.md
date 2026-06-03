# 29 — Pro Options Mode: Architecture & Phased Roadmap

Companion to **doc 28** (product spec). Doc 28 = *what & why*. This = *how it all fits
together* + the phased build plan with agent-sized tasks.

Status: planning. Engine spine (Phase 0) is built & tested; everything below wraps it.

---

## 1. Architecture at a glance — the layer stack

```
┌───────────────────────────────────────────────────────────────────┐
│ 6. ON-CHAIN (Move)      wick::option_market · MartingalerVault as   │
│                         counterparty · commit-reveal · USDC         │
├───────────────────────────────────────────────────────────────────┤
│ 5. UI (Legend)          Desk (lobby) · Live (manage) · Results      │
│                         built from existing Legend widgets + chart  │
├───────────────────────────────────────────────────────────────────┤
│ 4. PERSISTENCE/ACCOUNTS play-money ledger → USDC; positions; history│
├───────────────────────────────────────────────────────────────────┤
│ 3. TRANSPORT / SYNC     single-player: none · multiplayer: server   │
│                         streams candles+events, accepts orders      │
├───────────────────────────────────────────────────────────────────┤
│ 2. ROUND RUNTIME/HOST   real-time tick loop + event emitter around  │
│                         the engine. Client host OR server host.     │
├───────────────────────────────────────────────────────────────────┤
│ 1. CORE ENGINE  ✅ DONE  @sui-options/pro-options: path · BS pricing │
│                         · option lifecycle · round clock · RoundEngine│
└───────────────────────────────────────────────────────────────────┘
        (1) is pure & deterministic. Every layer above is I/O around it.
```

**The load-bearing idea:** the same deterministic `RoundEngine` runs in the browser
(single-player) and on the server (multiplayer). Only the *transport* changes. We never
fork the game logic.

---

## 2. Canonical data flow — one round, end to end

| Step | Single-player (Phase 1) | Multiplayer (Phase 3) | On-chain (Phase 4) |
|---|---|---|---|
| Generate path + commit | client RoundEngine | **server** RoundEngine | server; commit anchored on-chain |
| Lobby (Desk UI) | client shows chain/payoff/cone; opens locally | server broadcasts market+commit; clients open via server | premium debits USDC into vault |
| Live (candle stream) | client host ticks the reveal | **server** streams candles+events to all clients | — |
| Manage (Sell-to-close) | client engine marks + closes | order → server → fill broadcast | vault buyback at signed, Bachelier-bounded mark |
| Settle (expiry) | client settles vs path | server settles, broadcasts | `settle_option` pays intrinsic from committed path |
| Reveal + verify | n/a (client owns seed) | server reveals seed; clients verify stream==commit | reveal on-chain; anyone verifies |

**Fairness boundary:** in multiplayer the client must NOT hold the seed (would know the
future). Server streams candles; reveals seed only at settle. On-chain anchors the commit so
the reveal is trustless.

---

## 3. Component map — reuse vs build

| Layer | Reuse (already built) | Build new |
|---|---|---|
| 1 Engine | ✅ `@sui-options/pro-options` (done) | market presets; `RoundHost` tick loop |
| 2 Runtime | candle-vision GSAP ticker pattern | `RoundHost` + event emitter; `useRoundHost` React hook |
| 3 Transport | keeper (long-running Node) | server host service + WS/SSE; client thin-subscribe mode |
| 4 Accounts | Dynamic wallet (frontend); TUSD faucet | play-money ledger; round history store |
| 5 UI | candle-vision chart + gamified overlay; Legend widgets (`OptionsChainWidget`, `SimulatedReturns`=payoff, `OrderBook`, `InstrumentDetail`, `PositionsTable`); `/dashboard` 6-pane | Desk/Live/Results mode shells wired to the host |
| 6 On-chain | `MartingalerVault`, `RiskConfig`, fee router, USD oracle, Bachelier `compute_pwe`, commit-reveal (doc 17), keeper/sponsor | `wick::option_market` module; USDC collateral; settlement crank |
| Flavor | `OrderBook`/`PixelRecentOrders` widgets | synthetic order-flow generator (path-consistent) |

---

## 4. Cross-cutting concerns

- **Fairness:** commit-reveal everywhere; clients verify; on-chain anchors the commit.
- **House edge:** transparent spread (vig) + disclosed mild rug. Must be Monte-Carlo'd and
  stated honestly (AGENTS.md). Edge is tuned per market preset.
- **Determinism / time-scale:** one seed ⇒ reproducible path. `yearsPerSecond` accelerated
  clock is a first-class market parameter (a 60s round = a meaningful horizon); it *defines*
  a market's personality alongside `sigmaAnnual` and `rugChanceBps`.
- **Trust boundary (off-chain pricing):** the off-chain BS quoter signs premiums/marks;
  on-chain Bachelier bounds reject out-of-band quotes. Settlement needs no pricing — just the
  committed path.
- **Practice vs money:** identical engine; only settlement differs (play-money ledger vs
  USDC/Move). Practice mode doubles as the skill-trainer and onboarding.
- **Accounts/auth:** Dynamic wallet (already integrated) for identity; play-money balance
  off-chain first, USDC later.

---

## 5. Phases & tasks (agent-sized)

### Phase 0 — Spec & engine — ✅ DONE
Spec 28; `@sui-options/pro-options` (path, BS pricing, option lifecycle, round clock,
`RoundEngine`); 17 tests; runnable `npm run play`.

### Phase 1 — Single-player playable prototype (practice money, client-only)
*Goal: a fun, end-to-end round in the browser. No server, no money. Proves the loop.*
- **1.1** Market presets (Calm / Volatile / Trending / Choppy) as configs in pro-options.
- **1.2** `RoundHost`: real-time tick loop + typed event emitter around `RoundEngine`
  (phase-change, candle, settle, etc.). *Accept:* drives a full round on a wall clock.
- **1.3** `useRoundHost` React hook: exposes phase, spot, candles, positions, quote/open/sell.
- **1.4** Decide UI host app (see §6 Decision A), then **Desk** shell: chain + payoff curve
  (`SimulatedReturns`) + strike/expiry + Buy, wired to the hook.
- **1.5** **Live** shell: candle-vision chart + strike line + position card + mark/P&L + Sell.
- **1.6** **Results** shell: outcome + reveal/verify + per-position P&L.
- **1.7** Play-money wallet (local balance + deposit stub).
- **1.8** Round-cycle loop (auto-advance lobby→live→settle→next).
- **1.9** Lobby probability cone (ghost paths) over the unrevealed region.
*Exit:* a person can play repeated rounds and it's fun.

### Phase 2 — House-edge calibration (non-UI, parallel to Phase 1)
- **2.1** Monte-Carlo harness: N rounds per preset → realized house edge (spread+rug).
- **2.2** Tune spread/rug per preset to a target edge; record numbers.
- **2.3** Skill/Greeks metrics scaffolding (win-rate by setup, etc.).

### Phase 3 — Multiplayer canonical round (server authoritative)
- **3.1** Server host service (extend keeper / new Node service): runs `RoundEngine`, holds
  seed, publishes commit.
- **3.2** Transport: WS/SSE candle+event stream; order intake; fill/position broadcast.
- **3.3** Client thin mode: same `useRoundHost`, subscribes to server instead of local host.
- **3.4** Shared lobby: player count + shared positions feed.
- **3.5** Reveal+verify on client from server-published seed.
- **3.6** Reconnect / mid-round catch-up.

### Phase 4 — On-chain settlement & USDC collateral (Move)
- **4.1** `wick::option_market`: `OptionPosition`, open/sell/settle; vault as counterparty;
  escrow invariant (`escrow == Σ max_payout(open)`).
- **4.2** Commit-reveal on-chain (anchor at lobby, reveal at settle).
- **4.3** On-chain Bachelier bound for signed premium/mark quotes.
- **4.4** Settlement crank (keeper/sponsor).
- **4.5** USDC collateral (deposit/withdraw/escrow).
- **4.6** Move tests: invariant, idempotent settle, no double-pay, losing side can't redeem.
- **4.7** Testnet deploy + smoke.

### Phase 5 — Orderbook microstructure (flavor)
- **5.1** Synthetic order-flow generator consistent with the committed path.
- **5.2** Wire `OrderBook`/DOM/recent-trades widgets to it.

### Phase 6 — Polish / scale
- **6.1** Market/table browser (lobby of tables).
- **6.2** Leaderboards; practice↔money toggle.
- **6.3** Greeks panel; strike/breakeven projected onto the chart.
- **6.4** Threat model + fairness + honest house-edge disclosure docs.

---

## 6. Open architecture decisions (need product calls)

- **A. UI host app** — build Pro Mode in the **Legend Next app**, the **Vite `frontend/`
  app**, or **consolidate** onto one? The two-app split is the recurring pain. (Chart lives in
  Vite; Legend widgets live in Next.)
- **B. Multiplayer infra** — extend the **keeper** (long-running Node, natural for a stateful
  authoritative host) vs Vercel edge + a realtime/WS provider. Vercel functions are stateless,
  so a stateful host needs the keeper or a dedicated service.
- **C. Money model** — pure on-chain settlement vs **hybrid** (off-chain UX/matching + on-chain
  settle against the committed path). Spec leans hybrid.
- **D. Scope discipline** — confirm this is a new product line past the locked MVP (it is), and
  that Ride/degen + touch/no-touch stay as separate shipped products.

## 7. Sequencing / parallel tracks

- **Critical path:** 1.1 → 1.2 → 1.3 → 1.4/1.5/1.6 → playable. Then 3 (multiplayer) → 4 (chain).
- **Parallelizable now:** Phase 2 (edge Monte-Carlo) needs only the engine — can run alongside
  Phase 1. Market presets (1.1) unblock both.
- **Gate to money:** do NOT start Phase 4 until Phase 1 is *fun* (per the fragility concern).
```
