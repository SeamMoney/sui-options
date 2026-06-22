# Wick Markets — 60-second judge guide

**The submission is Wick Pro:** one-tap Black-Scholes options priced off a **live DeepBook mark**.
Everything below is live on testnet — no install, no wallet needed to play.

> **One command proves the whole story:** `npm run judge` (~20s, no wallet, no browser)
> chains every claim — live demo up · on-chain ride fairness (honest + tamper + rug) ·
> live P&L == settlement · `/pro` commit-reveal fairness (honest + a forged reveal caught) —
> and prints a single **PASS — 7/7**. Add `--with-e2e` for the live UI + all-routes browser
> pass, `--with-chain` for a real cold on-chain ride, or `--full` for everything.
>
> Narrower checks if you want them: `npm run smoke:demo` (curl-only, ~5s, live demo green) ·
> `npm run check:routes` (headless browser over every route + the unknown-route fallback) ·
> `npm run verify:offline` (the fairness + correctness proofs with **zero network**, for a
> judge behind a firewall or on a plane).

---

## ▶ The 60-second path — [wick-markets.vercel.app/pro](https://wick-markets.vercel.app/pro)

1. **Open `/pro` on a phone.** The header shows a live price + `● DEEPBOOK LIVE` and a `σ` — that's
   a real DeepBook mid — toggle **SUI**, **BTC** (XBTC/USDC ~$64k), or **DEEP** — with volatility
   computed from each pool's live trade tape. (Jump straight to
   **[Bitcoin options ↗](https://wick-markets.vercel.app/pro?asset=XBTC_USDC)** — `/pro?asset=XBTC_USDC`,
   a real on-chain CLOB mark ~$64k.) The chart is seeded with real DeepBook candle history.
2. **Tap ▲ UP or ▼ DOWN.** You've bought a 60-second at-the-money call/put. The premium and the
   `±%` to win come from a real Black-Scholes engine (`@sui-options/pro-options`) using that live mid
   and σ.
3. **Watch the one big P&L.** It updates off the real DeepBook mid every tick (value **and** %). The
   `CLOSE` button always shows the same number — what you watch is what you get.
4. **CLOSE, or let it auto-settle at 60s.** The settled result equals the last live P&L you saw —
   **settlement-consistent pricing** (the live mark and settlement use the same formula + inputs).
5. A **CandleVision pattern coach** reads the same live tape and calls setups (Marubozu, doji, …) as
   they form.

**Why it's credible:** real options math · real on-chain CLOB price (DeepBook v3 indexer mid) · honest
live σ · settlement-consistent P&L · mobile-first. Not "trust us" — the price is a real market.

---

## Also worth a look

- **[/coach](https://wick-markets.vercel.app/coach)** — the live DeepBook **options desk**: the
  CandleVision pattern coach · a live Black-Scholes quote (CALL/PUT premium, Δ, break-even, and the
  **payoff hockey-stick**) · the real on-chain **order book** (resting bids/asks with depth bars, 24h
  volume, and streaming recent fills) · Suiscan pool links — all on the live mark, toggle SUI / BTC /
  DEEP. The whole DeepBook integration laid bare in one screen.
- **[/ride](https://wick-markets.vercel.app/ride)** — the original tap-hold touch/no-touch game.
  Real **on-chain** rides: one-tap faucet (free testnet SUI + TUSD, no wallet) → hold the chart →
  segments recorded on-chain from `sui::random`.
- **[/verify](https://wick-markets.vercel.app/verify)** — replay any closed ride live in your browser
  from its on-chain keys; toggle **"dishonest house"** to watch the verifier catch a tampered candle.
  Or audit the **live v4 chain** from a terminal, no wallet, no indexer:
  - instant offline demo (honest PASS, then a tampered-segment FAIL):
    `npm run verify:fairness` · `npm run verify:fairness:tamper`
  - **audit the live chain, zero args** (auto-picks a live market from `deployments/testnet.json`):
    `npm run verify:fairness:live`
  - **prove the house won fairly** — `npm run verify:halt` runs the **complete** audit of a real
    `MARKET HALT` ride: the candles reproduce from their on-chain keys, the halt was an honest keccak
    roll (`roll < rug_chance_bps`), the ride settled `EXPIRED_LOSS` exactly as the chain says, **and**
    the house forfeited *exactly* the held stake — not a satoshi more. The headline "that's how the
    house wins" — provable to the last unit.
  - audit a specific market's recorded segments: `npx tsx scripts/verify-v4.ts --market <SegmentMarketV4 id>`
  - verify one closed ride's settlement: `npx tsx scripts/verify-v4.ts --market <id> --ride <id>`
  - **pick your own ride to audit** — `npm run rides:recent` lists real recent closed rides off the
    chain — a touch win, a cashout, a **MARKET HALT** — each with a paste-ready verify command. Don't
    trust our cherry-picked example: audit a ride *you* chose. (Every surfaced ride verifies honest —
    including rides held *across* a round boundary, which the verifier judges against the close round, so
    they reproduce `verdict: match`; never a false "chain lied".) Each is listed with a paste-ready
    `audit-ride` command — the COMPLETE audit, below.
  - **the COMPLETE audit in one command** — `npm run audit:ride -- --market <id> --ride <id>` runs all
    three verifiers and only passes if all five hold: barriers not cherry-picked · honest candles ·
    honest `MARKET HALT` · correct verdict · exact payout → `✅ COMPLETE AUDIT PASS`.
  - **zero-friction — audit the newest real ride, read-only** — `npm run audit:latest` (no args, no
    wallet, no faucet) finds the most recent closed ride on-chain and runs that same COMPLETE audit on
    it. The read-only counterpart to `smoke:ride` — nothing to fund, a real ride proven end-to-end.
  - **prove you were paid the exact right amount** — `npm run verify:payout -- --market <id> --ride <id>`
    re-derives `stake_paid` from on-chain state and checks the payout identity for the settlement kind
    (`TOUCH_WIN = stake × multiplier`; a `MARKET HALT` forfeits *exactly* the held stake, not a satoshi
    more). The candles, the house edge, the verdict, **and the money** — all four are a function call.
  - **verify a real `MARKET HALT` (rug) — the house edge is provably fair too:**
    ```
    npx tsx scripts/verify-v4.ts \
      --market 0x54e915308c596981fa94e5ff1f6f4e602e8bd1aae8c4a610cb782573310b5282 \
      --ride   0x7b3df97e608bda202efd096bca652be8a846dc2a286abfd5d94a1ca3b9c4a5ea
    ```
    → `MARKET HALT: rug fired @ segment 458 — keccak roll=78 < rug_chance_bps=150 (HONEST)` → **PASS**
  - **audit EVERY round of the market** — `npm run check:rugs` sweeps all rounds, re-derives the
    keccak roll for each, and proves the house could neither fake a `MARKET HALT` nor suppress one
    (it halted at the FIRST qualifying segment every time; clean rounds had none) — `✓ HONEST` per
    round → **PASS**. The house edge isn't asserted; it's audited.

  It re-runs the byte-identical seeded walk from each segment's on-chain key + carried state and
  confirms the chain's published high/low/verdict — prune-proof (reads the segment Table directly, no
  event replay). For a rugged ride it also **re-derives the keccak halt-roll**
  (`keccak256(segment_key ‖ market_id ‖ round) mod 10_000 < rug_chance_bps`) and proves the freeze only
  fired on an honest roll. Tamper any key, extremum, or halt and it exits non-zero.
- **The whole loop in one command** — `npm run smoke:ride` mints a throwaway wallet, funds it from the
  **production faucet** (the same 1 SUI + 10 TUSD a fresh player gets), opens a real touch-either ride,
  cranks segments, settles on-chain, then hands the closed ride to the COMPLETE audit (`audit-ride.ts` —
  barriers · candles · halt · verdict · payout) and asserts **PASS** — every step printed with a SuiScan
  link. Fund → play → settle → audit, cold, no wallet extension.
- **Watch the house win, live** — `npm run smoke:halt` (operator wallet) opens a ride and cranks the
  chain until a real `MARKET HALT` (the v4.26 rug) fires inside the round, **wiping the ride** on-chain
  (`EXPIRED_LOSS`), then proves the freeze was an honest keccak roll via `verify-v4`. The headline "that's
  how the house wins" — not a slide, an on-chain event you just triggered and verified.

## Proof points

- **The mark is a real on-chain CLOB** — on `/pro` (and `/coach`) click the pair (e.g. **`SUI/USDC ↗`**)
  to open the actual DeepBook v3 pool object on Suiscan and see its live order book. Not a faked feed.
- **Live book + tape, in-app** — `/coach` renders that pool's actual resting bids/asks (with depth),
  24h volume, and streaming recent fills, right next to the option quote it prices. The CLOB Wick Pro
  marks against, visible and moving.
- **DeepBook v3 mark** the options price against: `npm run check:deepbook` (live mid + σ → BS premium).
- **Live P&L == settlement, provably** — `npm run verify:pro` pulls the real DeepBook mark + σ and asserts the number you *watch* equals the number you're *paid* at a sweep of exit prices × times, to `1e-9`. Honest P&L isn't a promise; it's a function call. (`npm run check:all` runs every no-browser gate in one shot.)
- **Commit-reveal fairness, provably** — `npm run verify:pro-fairness` publishes each `/pro` round's `commit` (real SHA-256 of `seed:params`) before the lobby, reveals the seed at settle, then **independently** recomputes the digest via `node:crypto` and confirms it binds — plus a tamper check that a wrong seed can't reproduce the commit. The price path was fixed before you bet; you don't have to trust us, you can re-hash it. Watch it **catch a cheating house**: `npm run verify:pro-fairness:tamper` forges a more-favourable reveal under the published commit and the independent verifier rejects all 4 (exit 1 = cheat detected). (The on-chain `/ride` fairness has its own pair: `npm run verify:fairness` · `:tamper`.)
- **Verify a round end-to-end yourself, trusting nothing** — `npm run play -- --seed 4242` runs one `/pro` round and prints its `commit`, revealed `seed`, and `paramsJson`. Confirm the path was committed before the reveal any of four ways, no frontend or deploy needed: open **`scripts/verify-pro.html`** in your browser (re-hashes client-side via Web Crypto — offline, nothing sent anywhere) · `POST`/`GET` **`/api/verify-pro`** · the SDK's **`verifyProRound(commit, seed, paramsJson)`** · or `npm run verify:pro-fairness`. Four independent surfaces, one SHA-256, same answer.
- **Sui-native economics, measured on-chain** — `npm run gas:report` pulls a real `record_segment_v4` tx and prints its cost: **≈ $0.004 per candle tick**, with **~69% of the storage refunded** by Sui's storage rebate, and one tick advances the chart for *every* open ride at once. The streaming chart is only affordable because of Sui's object+rebate model — not a generic-EVM design.
- **Audit the live protocol yourself, one command** — `npm run prove:live` proves the *deployed* protocol is fair **and** solvent on testnet right now, walking the whole chain of custody: `verify:randomness` (every `record_segment` crank consumes the `0x…08` system Random — the key isn't house-chosen or grindable) → `audit:deployment` (every market's candles reproduce from those on-chain keys) → `vault:solvency` (every `MartingalerVault` clears its full FIFO claim queue from on-hand reserves). Random keys → honest candles → a vault that can pay everyone — checkable without trusting us.
- **Move package** (v4.26, testnet): [`0x1fdf78474…815924` on Suiscan](https://suiscan.xyz/testnet/object/0x1fdf784743d82c000e84154506e21daedc45bf241818fef6b28635e99e815924).
- **590/590 Move tests** (incl. 10k seeded-path conformance vectors, TS↔Move byte-identical, enforced in CI).

> Honest scope: `/pro` settles client-side against the live DeepBook mark (no wallet, instant) — the
> on-chain pieces are the DeepBook price it reads, the `/ride` rides, and the `sui::random` fairness
> that `/verify` proves. We don't claim on-chain option settlement (that's the v3 roadmap).
