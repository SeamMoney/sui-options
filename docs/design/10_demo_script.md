# Wick Markets — 3-Minute Hackathon Demo Script

> ⚠️ **SUPERSEDED — historical v1 script.** The current, maintained demo guide is
> [`docs/design/v2/10_demo_script_v2.md`](v2/10_demo_script_v2.md), and the
> 60-second judge path is the repo-root [`DEMO.md`](../../DEMO.md). This v1 script
> predates the segment-ride / Wick Pro pivot and references retired commands
> (e.g. `npm run bots:run`, the v1 trade model) and stale market ids — kept for
> history only. Don't run it cold.

> Sui DeepBook hackathon submission. Live demo with always-on backup. Total runtime: 3:00.

---

## 1. The Hook (0:00 – 0:15)

Three candidates, then the pick.

**Candidate A — the contrast line.**
> "Polymarket asks where BTC ends. Wick asks whether BTC *wicks* into a level — and we settle in 30 seconds, not 30 days."

**Candidate B — the composition flex.**
> "We turned DeepBook Predict into an options exchange. One PTB, one click, two protocols, atomically."

**Candidate C — the visceral one.**
> "Watch this candle." *(pause as the random-walk chart wicks through the upper barrier and confetti fires)* "That just paid me. That's Wick."

**Pick: C, with A as the second sentence.** Visual-first beats verbal-first with tired judges. Lead with the chart wicking on screen, fire confetti, *then* say the contrast line as the explainer. The judges have already leaned in.

**Spoken (15s):**
> "Watch this candle. *(touch fires, confetti)* That just paid me. I'm Max — this is Wick Markets, touch options on Sui. Polymarket asks where BTC ends. Wick asks whether BTC wicks into a level — and we settle in 30 seconds, not 30 days. Let me show you."

---

## 2. Three-Act Structure

### Act 1 — Problem + Product (0:00 – 0:45)

Hook (0:15) carries straight into a 30-second framing:

> "Prediction markets are slow. Perps get rugged by a single wick. We built the in-between: short-dated, defined-risk, path-dependent. If the price *touches* your level any time in the round, you win the full payout — even if it falls back. That's the product. Four lines of code separate Wick from a parimutuel: a CPMM, paired claims, an oracle observation, and a barrier-crossed flag. Everything else is composition."

On screen during Act 1: the **Markets rail** with four cards — `BTC-USD`, `SUI-USD`, `SP500`, `Arcade (Random Walk)`. Live tape ticking on the right (the four personality bots producing organic activity).

### Act 2 — Live Demo (0:45 – 2:15)

**90 seconds, four scenes.** This is the show. See § 3.

### Act 3 — Technical Wow (2:15 – 3:00)

**45 seconds, four punches.** PTB composition, fair-launch token from losses, Position coins listed on DeepBook v3 CLOB, oracle-pluggable settlement with the same Move call site.

Closer (last 10s) — see § 5.

---

## 3. Scene-by-Scene Live Demo

> **Always-works backup is built in.** The Arcade (random-walk) market ticks every 5 seconds in the contract itself — no external oracle, no RPC roulette. Lead with Arcade. Use BTC for the composition flex *after* you've already shown a working settlement. If BTC falls over, the demo is still complete.

### Scene 1 — Connect + Faucet (0:45 – 1:00, 15s)

**On screen:** Wick app, top-right. The **Connect Wallet** button glows (Slush is preinstalled in the demo browser profile).

**Presenter does:**
1. Click `Connect Slush` → wallet popup → Approve. Wallet pill shows the address.
2. Click the **Faucet 5 SUI** button in the top bar.

**Presenter says:**
> "Slush wallet, testnet. One click on the faucet — that's our hackathon collateral, real testnet SUI. Markets are denominated in SUI today; mainnet adds USDC."

**Why this scene:** demonstrates the user can be *anyone* with a Slush install. Two clicks to ready.

### Scene 2 — Arcade Touch (the always-works moneyshot) (1:00 – 1:30, 30s)

**On screen:** click the **Arcade** card. Full-screen chart loads — a candlestick path ticking every 5 seconds, two horizontal barrier lines (UP at +2%, DOWN at -2%), a 30-second countdown, and a TradePanel on the right with **TAP UP** / **TAP DOWN** buttons.

**Presenter does:**
1. Tap-and-hold **UP** for ~1 second. The button fills like a charge bar. Release → one PTB fires, position card appears in the right rail showing `0.50 SUI on TOUCH-ABOVE @ 1.74x`.
2. *Watch the candle.* Path animates upward, wicks through the barrier line. **Confetti fires. Screen pulses green. The position card flips to "WON 0.87 SUI"** with a `Redeem` button.
3. Click **Redeem**. Wallet popup, approve, the card fades. Balance ticks up.

**Presenter says:**
> "This is the Arcade market. The path is a Move-native random walk — it ticks deterministically inside the contract, no external oracle, no waiting on Pyth. I tap up, I'm long the upper barrier. *(release)* The candle wicks through. *(confetti)* Settled. Redeemed. Total time from click to cash: under ten seconds."

**Why this scene first:** if literally everything else dies — no testnet RPC, no Pyth, no DeepBook Predict — Arcade still works because the oracle is the contract itself. You have proven the product before you take any risk.

### Scene 3 — BTC Touch composing with DeepBook Predict (1:30 – 1:55, 25s)

**On screen:** click the **BTC-USD** card. Same chart UI but now the price is real, sourced from DeepBook Predict's testnet feed. A small **"Composes with DeepBook Predict"** badge sits next to the price.

**Presenter does:**
1. Use the slider to drop the barrier just above current price (~$67,400 on a $67,200 spot).
2. Click **TOUCH** → wallet popup. Notice the PTB preview: **two move calls in one transaction** — `wick::market::buy_touch` and `predict::oracle::observe`.
3. Approve. Position appears.

**Presenter says:**
> "This is the BTC market. One Programmable Transaction Block. One signature. Two protocols touched atomically: my buy goes into Wick, and *in the same transaction*, Wick reads a fresh observation from DeepBook Predict's live testnet deployment. We don't wrap Predict — we *compose* with it. The barrier resolves against the same price stream their own markets settle on. If the oracle stops, both protocols stop together; there's no oracle drift between us."

**Why this scene:** this is the line the DeepBook track judges are listening for. Note the language: *compose*, never *wrap*.

### Scene 4 — Position on DeepBook CLOB + WICK token mint (1:55 – 2:15, 20s)

**On screen:** click the position you just opened. A drawer slides out showing two new affordances: **List on DeepBook** and **Position metadata**.

**Presenter does:**
1. Click **List on DeepBook → 0.55 SUI ask**. PTB fires. The drawer flips and shows "Live ask on DeepBook v3 BTC-TOUCH-67400 book."
2. Switch tab to the **Arcade** market still running. Tap **DOWN** on a market that's already wicked up. Watch it expire against you in 5 seconds.
3. The losing position card shows: **"You minted 1,240 WICK at curve rate 0.0021 SUI/WICK."**

**Presenter says:**
> "Two more things. First — your touch position is a Sui object with `key, store`, so it's tradeable. One click and it's a live ask on the DeepBook v3 CLOB. The judges can see the order in their explorer. Second — losing isn't dead money. Every loss mints WICK, our LP claim token, on a fair-launch curve. No premine. No team allocation. The only way WICK gets minted is by losing on Wick. Losers are the LPs. The house pays you to gamble against it."

**Why this scene:** drops three of the four technical wows in 20 seconds, on screen, on chain.

---

## 4. The Technical Wow (2:15 – 3:00)

Four highlights, ~10 seconds each. Don't read them — point at them on screen.

### 4.1 Atomic multi-leg via Sui PTBs

**The flex:** one signature opens a Wick position *and* observes the DeepBook Predict oracle in the same transaction. There is no "what if Predict is down between my call and the oracle read" — Sui's PTB makes that question incoherent.

**Why it's hard:** on EVM you'd need either a router contract (custom code, audit surface) or a flashloan-style callback. Sui's transaction model lets the *user* be the composer, no on-chain glue.

**Why Sui:** PTBs + object capabilities. We pass the `Market` and the `OracleSource` as object handles into one transaction; the move VM atomicity does the rest.

### 4.2 Position objects, not wrapped Coin types

**The flex:** every position is a `Position { id, market_id, side, amount }` object with `key, store`. It's transferable, splittable, listable on DeepBook v3, and inspectable in any block explorer.

**Why it's hard:** the EVM-native instinct is to mint an ERC-20 per market. That fragments liquidity into one-trade-deep books and bloats the type graph. We avoided creating a `Coin<T>` per market — the Move type system rewards us for restraint.

**Why Sui:** object-centric storage + DeepBook v3 CLOB list-anything-with-key-store. Our positions get a working secondary market for free.

### 4.3 Pluggable oracle, identical Move call site

**The flex:** `Market::mark_hit` only depends on the trait `oracle_adapter::barrier_crossed`. Today: `MockOracle` for tests, `RandomWalk` for the Arcade, `PullOracleDriver` for Pyth Lazer (SUI/SP500), and `PredictOracleSource` for the BTC market reading DeepBook Predict.

**Why it's hard:** four oracle styles — push, pull, deterministic, composed — behind one Move signature. The keeper code that calls `mark_hit` does not know or care which oracle it's hitting.

**Why Sui:** Move's witness pattern + dynamic object fields let us hot-swap oracle backends without redeploying the market.

### 4.4 Martingaler LP that bootstraps from $0 + fair-launch WICK

**The flex:** the LP starts empty. The first trader's loss seeds the pool. WICK is minted *to the loser* at a curve rate that decays as cumulative losses grow. Losers become long-term LPs. There is no premine, no VC allocation, no token sale. The token is the receipt for "I funded the protocol by losing on it."

**Why it's hard:** most LP tokens require LPs. Most fair launches require a launch event. The Martingaler curve does both jobs at once.

**Why Sui:** fast finality + cheap object creation lets us mint a `WICK` claim per losing position with no gas guilt. On a slower chain this would feel like spam.

---

## 5. The Closer (2:30 – 3:00)

Three candidates.

**Candidate A — the punchline.**
> "Polymarket is bingo. Perps are blackjack. Wick is poker. We brought the game with the most skill — and made it settle in 30 seconds. Try it on testnet right now: `wick.markets`. Thanks."

**Candidate B — the composition restate.**
> "Wick is what happens when you stop treating DeepBook Predict like an exchange and start treating it like an oracle. One PTB, two protocols, real product. Built on Sui because no other chain lets the user be the composer. Thanks."

**Candidate C — the open invitation.**
> "Everything you saw is on testnet. Forty Move tests, full collateral conservation, four oracle backends, a real DeepBook composition, a real CLOB listing, and a real fair-launch token — all in this repo. Open the QR code, scan it with Slush, take the faucet. The Arcade is always running. Thanks."

**Pick: C.** A and B are clever but they let the judge stay seated. C makes them pull out their phone. We want them holding a Wick position when they walk to the next booth.

**Spoken (30s):**
> "Everything you just saw is live, on Sui testnet, in this repo. Forty Move tests. Full collateral conservation proven to the mist. Four oracle backends behind one call site. A real DeepBook Predict composition for BTC. A real CLOB listing for the Position object. And a real fair-launch token whose only mint path is losing on Wick. Scan this QR, open Slush, hit the faucet. The Arcade is always running. Trade it now — I'll be at the booth. Thanks."

QR code on the closing slide goes straight to the deployed app with the Arcade market open.

---

## 6. Backup Plans

| Failure mode | Pivot |
|---|---|
| **Testnet RPC slow / 5s+ tx finality.** | Open with the Arcade scene only — its ticks are inside the contract, not the RPC. Skip the BTC scene and narrate it from a pre-recorded 20s clip overlaid on the same UI. The clip lives at `/demo/btc-touch-fallback.mp4` and is bound to the `B` key in the demo controller. |
| **Aslan's DeepBook Predict deployment is paused.** | The frontend detects this on load and the BTC card shows a `predict-paused` pill instead of a price. Pivot Scene 3 to the **SUI-USD** card (Pyth Lazer-backed, no Predict dependency). Same composition story still holds — note that the PullOracleDriver is *also* a composition, just with Pyth not Predict. |
| **Pyth Lazer pushes are stale.** | The SUI-USD card greys out and shows "stale > 30s." Pivot to **SP500** (different Lazer feed, independent failure). If both Pyth feeds are stale, the demo runs entirely on the Arcade; the technical wow section gets 15 extra seconds and you talk through the BTC PTB by walking through the explorer view of a *previously executed* BTC position (URL pinned in the demo controller). |
| **Demo wallet runs out of gas.** | Two backup wallets are funded and listed in the demo controller. `Cmd+Shift+W` rotates wallets in the connected dApp without a page reload. The faucet button is also live in the UI — worst case, faucet *during* the demo and turn it into a "look how fast Sui testnet is" moment. |
| **Chart panel doesn't load (frontend bug).** | The TradePanel works without the chart. Pivot to a position-only narrative: show the position card update in real time as the bots trade against you. Replace "watch the candle wick" with "watch the AMM price move as my counterparties trade" — demonstrates liveness via the bot tape on the right rail. |
| **Slush wallet extension misbehaves.** | Backup wallet: Suiet, also preinstalled. Backup-backup: connect via WalletConnect QR from the phone in your pocket (the same phone that's showing the closer's QR). |
| **Internet drops entirely.** | Final fallback: the 3-minute screen recording lives at `/demo/wick-3min-final.mp4`. Pre-stage it in a browser tab. Do not hit play unless the wifi is verifiably down — judges can smell a recording. |

**Demo controller hotkeys** (a small overlay HUD only the presenter sees):
- `1`–`4`: jump to scene 1–4
- `B`: play the BTC fallback clip
- `R`: reset all positions and fund the wallet (idempotent script)
- `Cmd+Shift+W`: rotate to next backup wallet

---

## 7. Visual Storyboard — The Six Screens The Judge Sees

### Screen 1 — Markets dashboard (Act 1 framing)

Dark Robinhood-Legend-inspired layout. Black-zinc background `#0A0A0B`, lime accent `#C5FF3D`, Geist Mono for numbers. Left rail: four market cards stacked vertically, each with a sparkline and a bid/ask. Center: empty hero with a single sentence — *"Will it touch?"* — in 80px Geist Sans. Right rail: live tape, each row a recent trade by one of the four personality bots, color-coded by side. The tape scrolls upward continuously. Subtle animation: each card's sparkline is live and ticking.

### Screen 2 — Slush wallet connect overlay

The standard Slush popup, top-right. Behind it the Wick UI dims to 40% opacity. The faucet button glows lime when the wallet connects. One-screen, two-second beat — sets the stakes (real wallet, real testnet, real gas).

### Screen 3 — Arcade market in flight

Full-screen chart on the left two-thirds. A candlestick path painted live, ticking every 5 seconds. Two horizontal lines: **upper barrier** in lime, **lower barrier** in red. A 30-second countdown ring sits in the top-right corner of the chart, draining clockwise. Right third: the TradePanel — two giant buttons, **TAP UP** (lime) on top, **TAP DOWN** (red) on bottom, each fill-bar-charging when held. Below the buttons: the open positions list. When the touch fires, the chart background pulses lime for 200ms, confetti rains from the top of the chart only (not the whole screen — too much), and the position card flips with a card-rotation animation to show the WON state.

### Screen 4 — BTC market, PTB inspector visible

Same layout as Screen 3, but the chart is now a real BTC candlestick from DeepBook Predict's stream. A subtle **"DeepBook Predict"** chip sits next to the price ticker at the top. When the user clicks TOUCH, the wallet popup is *expanded* (not collapsed) so the judge can see the PTB preview text:

```
1. wick::market::buy_touch(market, oracle_source, 0.50 SUI)
2. predict::oracle::observe(market.oracle_source)
```

This is the moneyshot for the composition flex — point at it on the screen.

### Screen 5 — DeepBook CLOB listing drawer

A right-side drawer slides out over the existing chart (chart dims to 30%). Top half: position metadata (market, side, entry price, current mark, payoff if HIT, payoff if EXPIRED). Bottom half: a slim DeepBook v3 orderbook for `BTC-TOUCH-67400` with three asks and three bids visible. The user's new ask appears at the top of the asks side, highlighted lime, with a "YOUR ORDER" pill next to it. One small line below: *"Tradeable as a Sui object — `key, store`."*

### Screen 6 — Closer / QR

Dark slide. Top: the wordmark **WICK** in 200px Geist Sans, lime. Below: one line — *"Touch options on Sui. Always on. Settle in 30 seconds."* Center-right: a 400px QR code that resolves to the Arcade market. Bottom-left: testnet badge + package ID truncated. Bottom-right: GitHub URL. No more text. The judge scans, lands on a working market, plays a round on their phone before the next booth's pitch starts.

---

## 8. Questions Judges Will Ask

### Q1 — "Why not just use DeepBook Predict directly?"
> Predict is end-of-period prediction. Whether BTC closes above $67k at 5pm. Wick is path-dependent — *did it touch* $67k, any time, even if it fell back. They're different products. Predict is bingo; Wick is poker. We're not competing — we're an L2 on Predict's oracle. Their feed becomes our settlement primitive.

### Q2 — "What's the LP risk?"
> Worst case for an LP is the same as a CPMM market maker: adverse selection at the barrier. The Martingaler curve handles it by keeping LP exposure proportional to *cumulative losses* — when traders are winning, the pool shrinks faster than it can be picked off. Pre-mainnet we add a per-market position cap and a minimum barrier distance. Loss-of-funds risk is bounded by the collateral vault, which is asserted equal to outstanding supply after every state transition. Forty Move tests prove that to the mist.

### Q3 — "How do you avoid centralization in the keeper?"
> The keeper is permissionless. Anyone can call `mark_hit` and `settle_expired`. We run one bot for the demo so settlement is fast, but the Move package treats it like a public good. On mainnet we'd run a redundant fleet plus document the keeper as a runnable container. There is no privileged path through the contract.

### Q4 — "What is WICK actually worth?"
> It's a claim on the LP pool. The pool is fed by trader losses minus winner payouts. As cumulative net trader-loss grows, the pool grows, and WICK redeems for a slice of it. The mint curve decays over time so early losers get a bigger share — a fair-launch incentive to be the first generation of LPs. No premine, no team allocation, no sale. The only mint path is losing money on Wick. It's a memecoin with a balance sheet.

### Q5 — "How is this different from Polymarket?"
> Three things. *Time:* Polymarket trades for weeks; Wick rounds settle in 30 seconds to 5 minutes. *Path:* Polymarket pays only on terminal state; Wick pays on any touch during the round. *Oracle:* Polymarket settles by UMA disputes (slow, sometimes contested); Wick settles automatically by oracle observation. We're not their competitor. We're the short-dated, intraday version of what they do.

### Q6 — "What stops me from front-running the keeper?"
> Nothing — and that's intentional. `mark_hit` is permissionless. If you watch the oracle and call it before the keeper, you've done the protocol a favor. There's no MEV here because there's no preferred ordering — once `barrier_crossed` returns true, the market is HIT regardless of who calls or when. The oracle is the truth, the call is just a poke.

### Q7 — "Why Sui specifically? Couldn't you build this on Solana / EVM?"
> Three Sui-specific advantages. First, PTBs let us atomically compose with DeepBook Predict in one user signature — on EVM we'd need a router contract, on Solana we'd need a custom program. Second, object-centric storage means our `Position` is a real owned thing the wallet renders natively and DeepBook v3 lists for free; on EVM every position is an ERC-20 per market and your wallet shows nothing useful. Third, sub-second finality is what makes the 30-second Arcade round feel real instead of laggy.

### Q8 — "What's stopping a giant trader from killing the LP?"
> Three layers. The Martingaler curve scales LP exposure with cumulative net losses, so the pool can't be drained below what traders have already lost. Per-market position caps cap individual trade size at 25% of the smaller AMM reserve — same logic the bots use. And the collateral invariant is enforced after every state transition: the vault, the touch supply, and the no-touch supply are always equal. Worst case the LP earns less, never goes negative.

---

## 9. Materials Checklist

Pre-built and tested at least one hour before the pitch:

**On-chain state:**
- [ ] Move package on testnet, package ID `0x031f…e7d7`, verified in `deployments/testnet.json`
- [ ] Four seeded markets: `BTC-USD`, `SUI-USD`, `SP500`, `Arcade-RandomWalk`. Each has at least 5 SUI in collateral and at least one bot trade in history.
- [ ] Arcade market has a *fresh* round, not one mid-resolve. The demo controller resets it with `R`.
- [ ] BTC market has the barrier set just above current spot — within 0.3% — so a touch is genuinely possible during the demo window.

**Wallets:**
- [ ] Primary demo wallet: Slush, address pinned, 50 SUI funded.
- [ ] Backup wallet 1: Slush, different seed, 50 SUI funded.
- [ ] Backup wallet 2: Suiet, 50 SUI funded.
- [ ] Phone wallet (WalletConnect): 10 SUI funded, paired with the primary browser.

**Faucet:**
- [ ] Faucet button in the top bar verified working — calls our own faucet endpoint, not the public testnet faucet (which rate-limits aggressively at events).

**Live activity:**
- [ ] All four personality bots running (`npm run bots:run`) for at least 20 minutes before the demo so the tape is full and looks organic, not freshly seeded.
- [ ] Bot trade frequency confirmed at ~1 trade/sec aggregate.

**Pre-recorded fallbacks:**
- [ ] Full 3-min demo recording at `/demo/wick-3min-final.mp4` — final fallback.
- [ ] BTC scene fallback at `/demo/btc-touch-fallback.mp4` — 20s clip of Scene 3 with the PTB inspector visible.
- [ ] SUI-USD scene fallback at `/demo/sui-touch-fallback.mp4` — same length, used if Predict is down.
- [ ] Six storyboard screens as 4K stills in `/demo/screens/`, named `01-markets.png` through `06-closer.png`. If the frontend dies entirely, narrate over the stills.

**Demo controller:**
- [ ] HUD overlay app running, bound to hotkeys `1`–`4`, `B`, `R`, `Cmd+Shift+W`.
- [ ] Demo browser profile clean — no other extensions, no other tabs, no autocomplete spillover, no notifications.

**Network:**
- [ ] Two networks: venue wifi (primary) + phone hotspot (failover). Test both. The demo machine joins both and prefers wifi.
- [ ] DNS for `wick.markets` resolves and the cert is valid.

**Presenter:**
- [ ] Practiced the script three times end-to-end, hitting the timing marks within ±2s per scene.
- [ ] Practiced once with the BTC fallback to make sure the verbal pivot feels natural.
- [ ] Water on the podium. Not a coffee — caffeine shake on a 3-minute pitch is real.

---

## 10. Pitch Language Polish

A small dictionary. The language matters. Use these. Avoid the others.

### Don't say "binary option." Say "touch option."
*Binary* sounds like 2014 Cyprus-broker scams. *Touch option* is what the same product is called on legitimate venues. We are not selling binaries. We are selling intraday touches.

### Don't say "Wick wraps DeepBook Predict." Say "Wick composes with DeepBook Predict."
*Wraps* implies a fork or a derivative — and it's wrong on Sui. PTBs let us compose at the user-transaction layer, not the contract-inheritance layer. Use *composes with*. If pressed: *"In the same atomic transaction, my contract reads from theirs."*

### Don't say "the WICK token." Say "the LP claim from your losses."
*Token* invites every "is it a security" reflex in the room. *LP claim* keeps the conversation in DeFi-primitives space. If a judge asks you point-blank what WICK is, say: *"It's a fair-launch LP receipt. The mint path is losing money on the protocol. There is no other mint path."*

### Don't say "Martingaler is undercollateralized at startup." Say "the LP bootstraps from cumulative trader losses."
*Undercollateralized* is a five-alarm word. The reality is: every individual *market* is fully collateralized in its own vault, and the LP pool grows from net trader losses. Don't ever volunteer the word "insolvent." If a judge asks about LP solvency, the answer is in Q2 above — collateral invariant, position caps, Martingaler curve.

### Don't say "AMM." Say "the in-market price."
"AMM" makes it sound like Uniswap. The CPMM here is an implementation detail of a market — the user-facing concept is *the touch is currently priced at 1.74x*. Lead with the price, not the curve.

### Don't say "settlement." Say "payout."
*Settlement* is a back-office word. *Payout* is what the user wants. "Your TOUCH paid out 0.87 SUI." Not "your position settled at 0.87 SUI."

### Don't say "oracle." Say "the price feed."
For non-crypto-native judges. Crypto-native judges hear "oracle" fine. Read the room — if the judge name on their badge has *VC* or *Product* or *Design*, use "price feed."

### Don't say "Pyth Lazer push." Say "live price every 200 milliseconds."
The mechanism is uninteresting. The latency is the headline.

### Don't say "fair launch." Say "no premine, no team allocation, no sale."
"Fair launch" is a buzzword. The three nos are a structure. Structure beats buzzwords with serious judges.

### Don't say "we built this in two weeks." Say "the protocol is production-shaped, the oracle is hackathon-stubbed."
Honest, structured, and tells the judge what they'd need to evaluate before mainnet without waving hands. The README already says this; the spoken pitch should match.

### When the demo glitches, say "testnet." Don't say "sorry."
*"Testnet."* is a complete sentence. Pause, smile, retry. Apologizing makes a 200ms hiccup feel like a 5-second hiccup. The judges will forgive testnet flakiness exactly once. Don't burn the chip on an apology.

---

*End of demo script. Total spoken time at conversational pace: 2:55. Buffer: 5 seconds. Use the buffer on Scene 2 (the moneyshot) — never on Act 1.*
