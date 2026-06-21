# Wick Markets — 60-second judge guide

**The submission is Wick Pro:** one-tap Black-Scholes options priced off a **live DeepBook mark**.
Everything below is live on testnet — no install, no wallet needed to play.

> Quick health check: `npm run smoke:demo` (curl-only, ~5s) confirms the live demo is green.
> Deeper: `npm run check:routes` drives a real headless browser over **every** route below
> (`/pro` · `/coach` · `/ride` · `/verify`) and asserts each loads, renders, and throws no errors.
> Zero-trust, **zero-network**: `npm run verify:offline` proves the core fairness +
> correctness claims (commit-reveal binds, on-chain ride replay, P&L engine) with no
> network and no wallet — for a judge behind a firewall or on a plane.

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
  - **prove the house won fairly** — `npm run verify:halt` re-derives the keccak halt-roll of a real
    `MARKET HALT` ride and confirms it fired honestly (`roll < rug_chance_bps`) → the wiped ride settled
    `EXPIRED_LOSS` exactly as the chain says. The headline "that's how the house wins" — provably.
  - audit a specific market's recorded segments: `npx tsx scripts/verify-v4.ts --market <SegmentMarketV4 id>`
  - verify one closed ride's settlement: `npx tsx scripts/verify-v4.ts --market <id> --ride <id>`
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
  **production faucet** (the same 0.2 SUI + 10 TUSD a fresh player gets), opens a real touch-either ride,
  cranks segments, settles on-chain, then hands the closed ride to `verify-v4.ts` and asserts **PASS** —
  every step printed with a SuiScan link. Fund → play → settle → audit, cold, no wallet extension.

## Proof points

- **The mark is a real on-chain CLOB** — on `/pro` (and `/coach`) click the pair (e.g. **`SUI/USDC ↗`**)
  to open the actual DeepBook v3 pool object on Suiscan and see its live order book. Not a faked feed.
- **Live book + tape, in-app** — `/coach` renders that pool's actual resting bids/asks (with depth),
  24h volume, and streaming recent fills, right next to the option quote it prices. The CLOB Wick Pro
  marks against, visible and moving.
- **DeepBook v3 mark** the options price against: `npm run check:deepbook` (live mid + σ → BS premium).
- **Live P&L == settlement, provably** — `npm run verify:pro` pulls the real DeepBook mark + σ and asserts the number you *watch* equals the number you're *paid* at a sweep of exit prices × times, to `1e-9`. Honest P&L isn't a promise; it's a function call. (`npm run check:all` runs every no-browser gate in one shot.)
- **Commit-reveal fairness, provably** — `npm run verify:pro-fairness` publishes each `/pro` round's `commit` (real SHA-256 of `seed:params`) before the lobby, reveals the seed at settle, then **independently** recomputes the digest via `node:crypto` and confirms it binds — plus a tamper check that a wrong seed can't reproduce the commit. The price path was fixed before you bet; you don't have to trust us, you can re-hash it. Watch it **catch a cheating house**: `npm run verify:pro-fairness:tamper` forges a more-favourable reveal under the published commit and the independent verifier rejects all 4 (exit 1 = cheat detected). (The on-chain `/ride` fairness has its own pair: `npm run verify:fairness` · `:tamper`.)
- **Move package** (v4.26, testnet): [`0x1fdf78474…815924` on Suiscan](https://suiscan.xyz/testnet/object/0x1fdf784743d82c000e84154506e21daedc45bf241818fef6b28635e99e815924).
- **574/574 Move tests** (incl. 10k seeded-path conformance vectors, TS↔Move byte-identical, enforced in CI).

> Honest scope: `/pro` settles client-side against the live DeepBook mark (no wallet, instant) — the
> on-chain pieces are the DeepBook price it reads, the `/ride` rides, and the `sui::random` fairness
> that `/verify` proves. We don't claim on-chain option settlement (that's the v3 roadmap).
