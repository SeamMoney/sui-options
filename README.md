# Wick Markets

> **Touch / no-touch / double-no-touch options on Sui where the position lives only while you hold the screen.** Tap the candle. Watch PnL tick every 400 ms. Release to cash out — or hold for the touch jackpot. The chart is **deterministic from on-chain randomness**, and anyone can replay any ride to verify the house never cheated.

> **Now with `MARKET HALT` events (v4.26)** — ~1.5% per second the market freezes and wipes any open ride. Calibrated to a +3.93% house edge so the protocol survives. The roll is deterministic from `keccak256(segment_key)` — anyone can replay and verify the halt was honest. That's how the house wins.

[![CI](https://github.com/SeamMoney/sui-options/actions/workflows/ci.yml/badge.svg)](https://github.com/SeamMoney/sui-options/actions/workflows/ci.yml) [![status — live testnet](https://img.shields.io/badge/status-live%20testnet-10b981)]() [![Move tests 607/607](https://img.shields.io/badge/move%20tests-607%2F607-10b981)]() [![Sui — testnet](https://img.shields.io/badge/sui-testnet-3b82f6)]() [![hackathon — Sui Overflow 2026](https://img.shields.io/badge/hackathon-Sui%20Overflow%202026-f59e0b)]()

<p align="center">
  <img src="docs/assets/wick-chat.svg" width="600" alt="A chat between a curious dev and a Wick veteran" />
</p>

```
Prediction markets ask where BTC ENDS.
Wick asks whether BTC WICKS into a level —
       and lets you ride that question tick by tick.
```

→ **▶ Wick Pro — the options game** (start here): [wick-markets.vercel.app/pro](https://wick-markets.vercel.app/pro) — one-tap Black-Scholes calls & puts priced off a **live DeepBook mark** — toggle **SUI**, **BTC** (XBTC/USDC ~$64k), or **DEEP**: a real on-chain CLOB mid with σ from the live trade tape. Tap **UP** or **DOWN**, watch **one big live P&L** tick off the real mid, close (or let it auto-settle in 60s) — the result equals the live number you watched (settlement-consistent). A CandleVision pattern-coach reads the same live tape. No wallet, mobile-first. The full live DeepBook desk — order book, depth, 24h volume, recent fills, and the option payoff diagram — is at **[/coach](https://wick-markets.vercel.app/coach)**.
→ **Live frontend (tap-hold Ride game)**: [wick-markets.vercel.app/ride](https://wick-markets.vercel.app/ride)
→ **Verify the live chain from a terminal** (no wallet, no indexer): `npm run verify:fairness` (instant offline PASS) · `npm run verify:fairness:tamper` (watch it catch a tampered segment) · `npm run verify:halt` (prove a real **MARKET HALT** was an honest keccak roll) · `npm run verify:payout -- --market <id> --ride <id>` (prove the chain paid the **exact** amount — TOUCH_WIN = stake×multiplier, a halt forfeits exactly the held stake, CASHOUT to the satoshi via a bit-identical Bachelier port) · audit the real v4 chain with `npx tsx scripts/verify-v4.ts --market <SegmentMarketV4 id> [--ride <id>]`
→ **One command, the COMPLETE audit of a real ride**: `npm run audit:ride -- --market <id> --ride <id>` runs both verifiers and passes only if all four hold — honest candles · honest house edge · correct verdict · exact payout → `✅ COMPLETE AUDIT PASS`.
→ **Run the whole on-chain loop cold** (one command, no wallet): `npm run smoke:ride` — mints a burner, funds it from the production faucet, opens → cranks → settles a real touch-either ride, then audits it with `verify-v4` (**PASS**). Every step prints a SuiScan link. (`npm run smoke:halt` drives a live **MARKET HALT** and proves the wipe was an honest roll.)
→ **Verify in your browser** (no wallet, no CLI): [wick-markets.vercel.app/verify](https://wick-markets.vercel.app/verify) — replays a sample ride from its on-chain keys (toggle "dishonest house" to watch the verifier catch a tampered candle), **and one click verifies the LIVE chain** — it reads the busiest market's most recent candles straight off the on-chain segment table and confirms each reproduces from its key (prune-proof, no indexer), **and re-derives the house edge** — proving this round's `MARKET HALT` is an honest keccak roll, the README headline made clickable
→ **Explorer**: [package `0x1fdf78474…815924` v4.26 on Suiscan](https://suiscan.xyz/testnet/object/0x1fdf784743d82c000e84154506e21daedc45bf241818fef6b28635e99e815924)

---

## What it is

A provably-fair touch-binary arcade. Three things are simultaneously true:

1. **Real options math.** Touch / no-touch and double-no-touch (DNT) corridors with a Bachelier-derived cashout curve, asymmetric impact fee on profit, a Martingaler loss-recycling LP vault, and per-position + per-side + global probability-weighted-exposure caps.
2. **Real Sui randomness.** Every candle is derived from a `sui::random::Random` 32-byte draw committed inside `record_segment`. The draw is gated by Sui's **PTB-Random structural rule** (the verifier rejects any PTB that places attacker code after a `Random`-consuming MoveCall), so the standard "test-and-abort grinder" doesn't work. See [`docs/design/v2/17a_sui_randomness_spike.md`](docs/design/v2/17a_sui_randomness_spike.md).
3. **Real auditability.** The same `seeded_path::expand_segment` that the chain runs to produce a candle has a **byte-identical TypeScript port** (`sdk/src/seededPath.ts`). 10k random vectors are checked via a rolling blake2b digest in CI on every commit. The `/verify` CLI lets any user replay any closed ride's on-chain `segment_keys` and confirm the settlement. And the contracts that hold the funds carry **607 Move tests** where every fund-safety property maps to a named test you can run individually — see [`move/SAFETY.md`](move/SAFETY.md).

And it isn't only the candles. **Every output traces back to the chain's `sui::random` keys, end to end** — and `npm run audit:ride -- --market <id> --ride <id>` proves the whole chain for any real ride in one command:

```
keys ⟸ sui::random   (verify:randomness — un-grindable, gated by Sui's PTB-Random rule)
  ├─ round barriers  ⟸ the walk price at round-roll (verify-barriers — not cherry-picked)
  ├─ candles         ⟸ expand_segment(key)          (verify-v4 — bit-identical replay)
  ├─ MARKET HALT     ⟸ keccak256(key‖market‖round)  (check:rugs — honest roll, none suppressed)
  ├─ verdict         ⟸ the candles + barriers       (verify-v4 — touch/cashout/expiry)
  └─ payout          ⟸ the verdict                  (verify-payout — exact, to the unit)
```

The house chooses nothing: not the keys, not the barriers, not the candles, not the verdict, not the money. **And it can't change the rules after you bet** — the multiplier, rug chance, barrier offset, deadband, and spread are set once at market bootstrap with *no on-chain setter* (the only rug-chance mutator is `#[test_only]`, compiled out of the published package; traceability in [`move/SAFETY.md`](move/SAFETY.md)). Immutable rules, verifiable outputs. If a candle in your loss looks wrong, replay it. The whole ride is reproducible bit-for-bit.

---

## The 60-second story

You open a touch market — "will BTC wick above $1.05k in the next 30 seconds?"
You **press and hold** the chart. Each 400 ms you hold, the keeper records a new segment on-chain: a 32-byte random key plus the OHLC the chain derived from it. The chart paints the candle from the on-chain key. You see the same candle the chain saw.

You're paying a tiny stake-per-segment in escrow as you hold. The barrier sits at +10 %. You're praying for a wick.

- **Price touches the barrier** during your hold → you win `multiplier × escrow`. The Martingaler vault pays.
- **You release before the touch** → Bachelier cashout: `payout = escrow × (1 + cashout_factor × P(touch in remaining time))`.
- **Round ends without a touch** → escrow goes to the vault. The vault recycles losses into LP, so next round's payout multiplier ticks up a fraction.

The round structure is shared: everyone sees the **same** barrier grid, the same chart. The barrier price for round N is locked at round N's start — anti-cherry-pick.

---

## What's live on testnet (2026-05-25)

| Thing | ID |
|---|---|
| Package (v4.26, current) | [`0x1fdf784743d82c000e84154506e21daedc45bf241818fef6b28635e99e815924`](https://suiscan.xyz/testnet/object/0x1fdf784743d82c000e84154506e21daedc45bf241818fef6b28635e99e815924) |
| MartingalerVault\<SUI\> | [`0x73d3a17ab1e1cdc173b8cde1ae7d9789a29d1a177ebfd415196a04a6a10e5b9f`](https://suiscan.xyz/testnet/object/0x73d3a17ab1e1cdc173b8cde1ae7d9789a29d1a177ebfd415196a04a6a10e5b9f) |
| MartingalerVault\<TUSD\> | [`0xd9ff33f4f6e4014bcac74e89261ec47ce2ed34be4c6ea1ce10592fe7e081aa4d`](https://suiscan.xyz/testnet/object/0xd9ff33f4f6e4014bcac74e89261ec47ce2ed34be4c6ea1ce10592fe7e081aa4d) |
| TUSD test stablecoin (package) | [`0x204d595c642a06ccc667a32789a6a5a01d0b7ff3340fb53f7f69649c90d00a31`](https://suiscan.xyz/testnet/object/0x204d595c642a06ccc667a32789a6a5a01d0b7ff3340fb53f7f69649c90d00a31) |
| SegmentMarket V4 — SUI (75-seg round) | [`0xec32d173efe554247bc0b2b676f52a2f98918f6e0e6065d756757590ba526943`](https://suiscan.xyz/testnet/object/0xec32d173efe554247bc0b2b676f52a2f98918f6e0e6065d756757590ba526943) |
| SegmentMarket V4 — TUSD (75-seg round) | [`0xe98ace0ba07f165626c66b8d0ef9ec4858fe5d0b7fda8561d41a9e71476fa113`](https://suiscan.xyz/testnet/object/0xe98ace0ba07f165626c66b8d0ef9ec4858fe5d0b7fda8561d41a9e71476fa113) |
| SegmentMarket V4 — TUSD + rug (1.5 %/seg halt) | [`0x54e915308c596981fa94e5ff1f6f4e602e8bd1aae8c4a610cb782573310b5282`](https://suiscan.xyz/testnet/object/0x54e915308c596981fa94e5ff1f6f4e602e8bd1aae8c4a610cb782573310b5282) |
| Upgrade cap | [`0xa5bd66c01634671d92ce1ce6084074feaadc74e844f28e2f09af9ed8175cb590`](https://suiscan.xyz/testnet/object/0xa5bd66c01634671d92ce1ce6084074feaadc74e844f28e2f09af9ed8175cb590) |
| Faucet endpoint | `POST https://wick-markets.vercel.app/api/faucet` (SUI gas) · `/api/faucet-tusd` (TUSD stake) |
| **Every package + object, with SuiScan links** (69/69 verified live) | [`deployments/ADDRESSES.md`](deployments/ADDRESSES.md) |
| Source of truth (read this if README lags) | [`deployments/testnet.json`](deployments/testnet.json) |

**The whole loop runs on-chain in one command — no wallet, no setup:**

```bash
npm run smoke:ride   # mints a throwaway burner, funds it from the live faucet,
                     # then open → crank → close → audit, all on testnet
```

It opens a real `open_segment_ride_v4`, cranks `record_segment_v4`, settles with
`close_segment_ride_v4`, then audits the closed ride with `scripts/verify-v4.ts` —
replaying every segment from the chain's own keys and confirming the on-chain
settlement. A cold run ends with **`PASS — the chain was honest.`** To audit a ride
that already closed: `npm run verify:fairness:live` (auto-picks a live ride) or
`npx tsx scripts/verify-v4.ts --market <id> --ride <id>`.

---

## Try it yourself in 90 seconds

```bash
# 1. clone
git clone https://github.com/SeamMoney/sui-options && cd sui-options

# 2. install everything (sdk + frontend + keeper + bots + api)
npm install

# 2a. THE one command — prove the whole story in ~20s (no wallet, no browser):
npm run judge       # live demo up · ride fairness (honest+tamper+rug) · live P&L
                    # == settlement · /pro commit-reveal (honest + forged reveal
                    # caught) → PASS 7/7. Add --with-e2e / --with-chain / --full.

# 2b. reproduce the full CI gate locally in one command
#     (build packages + sdk, typecheck every workspace, run the keeper /
#      candle-vision / pro-options suites, build the frontend)
npm run ci          # the same checks .github/workflows/ci.yml runs
npm test            # just the TS unit suites
npm run test:move   # just `sui move test` (needs the Sui CLI)

# 3. run the deterministic-walk conformance harness on your machine
#    (10k vectors, Move↔TS rolling digest must match exactly)
cd move && sui move test seeded_path_conformance && cd ..

# 4. prove provable fairness — instant, offline, no wallet:
npm run verify:pro-fairness        # /pro round path is SHA-256-committed before the lobby;
                                   # recompute the digest independently (node:crypto) → binds
npm run verify:pro-fairness:tamper # forge a favourable reveal under that commit → rejected, exit 1
npm run verify:fairness          # honest synthetic v4 market+ride → PASS, exit 0
npm run verify:fairness:tamper   # one tampered segment extremum → FAIL, exit 1
npm run verify:fairness:live     # audit a LIVE market (auto-picked from deployments), zero args
npm run audit:deployment         # audit EVERY live v4 market's candles in one command → PASS
npm run verify:randomness        # prove the segment keys are drawn from sui::random (cranks consume 0x…08) → PASS
npm run verify:halt              # prove a real MARKET HALT (rug) ride was an HONEST roll → PASS
npm run gas:report               # real on-chain gas: a candle tick ≈ $0.004, settle ≈ $0.002 (Sui storage-rebated)
npm run vault:solvency           # prove the live MartingalerVault covers every outstanding claim → SOLVENT
npm run prove:live               # ONE command: the live protocol is provably fair AND solvent → PASS
#
#    …or audit a specific LIVE v4 market (reads the segment Table directly — prune-proof):
npx tsx scripts/verify-v4.ts --market <SegmentMarketV4 id>            # audit recent segments
npx tsx scripts/verify-v4.ts --market <id> --ride <SegmentRidePositionV4 id>  # verify one closed ride
#
#    …or verify a real MARKET HALT (rug) ride — re-derives the keccak halt-roll:
npx tsx scripts/verify-v4.ts \
  --market 0x54e915308c596981fa94e5ff1f6f4e602e8bd1aae8c4a610cb782573310b5282 \
  --ride   0x7b3df97e608bda202efd096bca652be8a846dc2a286abfd5d94a1ca3b9c4a5ea
#  → MARKET HALT: rug fired @ segment 458 — keccak roll=78 < rug_chance_bps=150 (HONEST)
#  → off-chain EXPIRED_LOSS == on-chain EXPIRED_LOSS → PASS — the chain was honest.

# 5. drive the LIVE UI the way a judge does (headless Chromium, screenshots saved):
npm run e2e            # /pro: live mark → open a $5 option → live P&L ticks → close → BTC re-mark
                       # /verify: honest replay all-match PASS, then "dishonest house" tamper → caught
                       #   (needs Playwright: npm i -D playwright && npx playwright install chromium;
                       #    skips cleanly if absent)

# 6. open the live frontend
open https://wick-markets.vercel.app/ride
```

`verify.ts` walks every segment from k=0 forward through the same `expand_segment` the Move chain ran, recomputes high/low per segment, runs the touch predicate with the on-chain barrier and deadband, and compares its verdict to the chain's `RideClosed.settlement_kind`. If they ever diverge, exit code 1, loud red error, with the per-segment diff. That tool is the public claim — fairness is a function call, not a promise.

---

## Architecture

```
                       +--------------------------------------------+
                       |  sui::random::Random  (system object 0x8)  |
                       +-----------------------+--------------------+
                                               |
                                               | one 32-byte draw per segment
                                               v
   +-------------------+         +-------------+---------------+      +--------------------+
   |   RiskConfig      |         |  SegmentMarket<C>           |<---->|    keeper /        |
   |   GlobalExposure  |<------- |  - segments: Table<k, key>  |      |  client-side crank |
   |   BotRegistry     |         |  - walk (FSM state)         |      |  every 400 ms      |
   |   OracleVerLock   |         |  - per-round shared barrier |      +--------------------+
   |   FeeRouter       |         |  - per-barrier exposure cap |
   +-------------------+         +-------------+---------------+
                                               |
                                               |  open / close / crank / abort
                                               v
   +--------------------+        +-------------+---------------+
   | MartingalerVault<C>|<------>|   SegmentRidePosition       |
   |  treasury + queue  |        |  - barrier_index, barrier   |
   |  per-market locks  |        |  - escrow, multiplier_bps   |
   |  fee buckets       |        |  - settlement_kind          |
   +---------+----------+        +-----------------------------+
             |
             | fee_router splits accrued fees per-bucket
             v
   +---------+----------+   +-----------------+   +-----------------+
   |  protocol_bucket   |   |  staker_bucket  |   |insurance_bucket |
   +--------------------+   +-----------------+   +-----------------+
                                  ^
                                  |
                            WickStakingPool (WICK token)
```

Per-collateral / global singletons live next to the package; per-market objects are `key`-only shared objects; positions are `key, store` and burn on payout.

---

## The mechanism — three pillars

### 1. Bachelier cashout + asymmetric impact fee

A no-touch-yet position can release early. The cashout factor is a closed-form `2 × Φ(-distance / (σ × √Δt))` lookup. Bigger barrier room remaining → higher cashout; tiny remaining time → cashout collapses to zero. The fee on the profit portion of any winning payout is **asymmetric**: the more *decisive* the win (barrier overshoot or path room remaining) and the more *vulnerable* it would have been to a counterparty grind (size vs side-aggregate exposure at lock), the higher the fee. See [`docs/design/v2/02_asymmetric_impact_fee_v2.md`](docs/design/v2/02_asymmetric_impact_fee_v2.md).

### 2. Martingaler vault — losses recycle into LP

Stakes that lose go to the vault treasury, not the protocol's pocket. The vault tracks per-market settlement locks atomically and pays winners from treasury — when treasury can't cover, the shortfall queues FIFO and accrues against future deposits (no socialized loss across markets, no priority for big payouts). See [`docs/design/v2/01_martingaler_accounting_v2.md`](docs/design/v2/01_martingaler_accounting_v2.md).

### 3. Provably-fair candles — the load-bearing claim

The walk is integer fixed-point, deterministic, and reseeded only by per-segment `random::generate_bytes(32)`. A pattern FSM arms one of 6 hero shapers (doji / hammer / shooting star / bullish-engulfing / bearish-engulfing / three white soldiers) and the candle materializes inside `expand_segment` with constant-gas branch structure. A 54-predicate catalog detects post-hoc patterns too. The TypeScript port is byte-identical at 10k vectors via a rolling blake2b digest — checked in CI on every PR. See [`docs/design/v2/17_provably_fair_arcade.md`](docs/design/v2/17_provably_fair_arcade.md) and [`docs/design/v2/17a_sui_randomness_spike.md`](docs/design/v2/17a_sui_randomness_spike.md).

### 4. Per-second rug-pull house edge (v4.26)

Every 400 ms segment carries a **1.5% chance the market HALTS** — wiping any open ride. The roll is `keccak256(segment_key) mod 10000 < 150`, derived from the same on-chain random draw that paints the candle, so a player can replay any closed round and prove the halt fired (or didn't) honestly. Across a 75-segment round that compounds to **~40% of rounds ending in a halt before the touch**. It's brutal and it's the point.

Why it exists: without it, the touch-either market is too generous to the player. The ±10% / 1.75× barrier configuration touches ~55% of the time on the seeded walk — without a counter-mechanism that's a negative-edge market and the vault drains. The rug calibrates the protocol to a **+3.93% house edge** so it survives, lining up with mainstream crypto crash games (Stake/Roobet land in the +1.0% to +4.0% band).

Why it's provably-fair: the rug roll is **deterministic from `(segment_key, market_id, round_index)`** — `roll = keccak256(segment_key ‖ market_id ‖ round)[0..8] mod 10_000`, fires iff `roll < rug_chance_bps`. The segment_key comes from `sui::random::generate_bytes(32)` gated by Sui's PTB-Random structural rule (attackers can't grind it), and `npx tsx scripts/verify-v4.ts --market <id> --ride <id>` **re-derives the keccak roll for every segment in the ride's round** straight from the on-chain keys. It reports the firing segment and its roll, cross-checks against the chain's `rugged_at_segment`, and confirms the rugged ride settled `EXPIRED_LOSS`. If a `kind=3 / rugged` settlement ever fired without a passing roll — or a passing roll were ignored — the verdict diverges and the verifier exits non-zero. Same standard as the candle math itself; the TS↔Move roll is pinned by golden vectors in `npm run test:verify-v4`.

Stronger still — audit the **entire halt history** of the market in one command:

```text
$ npm run check:rugs
rounds w/ segments: 0..6 · on-chain halts: 7
round   0 · ✓ HONEST · halt @    35 · roll     1 < 150
round   5 · ✓ HONEST · halt @   447 · roll   124 < 150
round   6 · ✓ HONEST · halt @   458 · roll    78 < 150
PASS — every round audited is cryptographically honest (7 halt(s) verified)
```

`scripts/audit-rugs.ts` sweeps **every round** of the market, re-derives each segment's keccak roll from its on-chain key, and proves the house could neither **fake** a halt (every halt rolled `< rug_chance_bps`) **nor suppress** one. The suppression half is airtight because it checks *all* rounds, not just the ones the chain admits it halted: for every round it finds the FIRST segment whose roll fires and confirms the chain halted at exactly that segment — so a halt that lands late, or a round that should have halted but emitted no `RugFiredV4` at all (a winning ride illegitimately kept alive), is caught. The house edge isn't asserted; it's audited.

Why the player can't avoid it: six adversarial heuristics tested at 50k rounds each (`scripts/simulate_v4.27_strategies.py`) — `hold_full`, `cashout_on_drawdown`, `chase_touch`, `cashout_on_profit`, `early_exit_5`, `mid_hold`. Every one lands in the **+3.93% to +11.71% house-edge band** with 95% confidence. No strategy in the tested family achieves negative house edge. Reactive cashouts make things WORSE because the 2% cashout spread bleeds segments the player didn't need to abandon.

Vault solvency under the rug: at the live 100M TUSD seed with a 500 TUSD per-round payout cap, the worst observed drawdown across 10k-round Monte Carlo simulations (1, 5, 10, and 50 concurrent rides) is **615 TUSD = 0.001% of seed**. The vault grows monotonically in expectation. Full derivation + strategy sweep + LP yield projection in [`docs/design/v2/26_rug_pull_house_edge_v4.md`](docs/design/v2/26_rug_pull_house_edge_v4.md) and [`docs/design/v2/27_economic_model_v4.md`](docs/design/v2/27_economic_model_v4.md).

---

## What's verified

| Layer | Verification |
|---|---|
| `move/sources/*.move` (26 modules) | **607 / 607** Move tests pass on every commit (`sui move test`) — incl. invariant, adversarial, e2e replay, full DNT lifecycle, deadband, FSM determinism, and the v4.26 rug-roll suite. **Every fund-safety property maps to a named test** in [`move/SAFETY.md`](move/SAFETY.md) (run one with `sui move test <name>`): no double-pay on any settlement path, settle-only-against-own-market, every open-path abort guard (stake range · funded escrow · market + per-user caps · aborted-market), DNT mutual-exclusion, oracle-version pinning, pull-oracle feed integrity |
| `seeded_path::expand_segment` vs `sdk/src/seededPath.ts` | 10k random vectors, rolling blake2b digest, **byte-identical** |
| Touch / DNT settlement on Sui testnet | Smoke ride 2026-05-23 — opened, recorded 3 segments, closed with CASHOUT, `verify.ts` PASS (extrema match + verdict match) |
| Asymmetric impact fee for DNT | 15 / 15 DNT tests pass including `lock_and_settle_dnt_market_with_*` |
| DNT PWE (probability-weighted exposure) | Union-bound Bachelier `compute_pwe_dnt`; 3 dedicated tests + zero regressions |
| Bootstrap script self-consistency | Refuses to bootstrap a market where the min/max ride payout exceeds the per-barrier cap |
| Vault solvency | Monte Carlo across 30k sessions → 0 conservation violations; positive vault edge on every market template ([`docs/design/v2/14_ride_economics.md`](docs/design/v2/14_ride_economics.md)) |
| B7 economic calibration | Joint sweep over (barrier × multiplier) grid → ±10 % × 1.75× sweet spot, +11.24 % vault edge / 50.67 % touch rate ([`docs/design/v2/15_montecarlo_validation_report.md`](docs/design/v2/15_montecarlo_validation_report.md)) |
| Keeper end-to-end | Boots against the v2 package on testnet, cranks `record_segment` against active rides at 400 ms cadence ([`keeper/src/segmentCranker.ts`](keeper/src/segmentCranker.ts)) |
| Frontend | Renders candles from on-chain `segment_keys`, live PnL from real deterministic candles, gesture → segment-boundary PTB commit, client-side crank fallback, pattern-glow overlay, per-barrier orderbook stake bars |
| `/api/faucet` | Vercel function — verified HTTP 200 on testnet (digest `3gh9wH8sr…`); rate-limited per-recipient with 90 s cooldown |

The collateral invariant (`vault treasury accounting balances after every state transition`) is asserted in test for every mutating function and enforced in Move by the vault's typed Balance-merge discipline.

---

## What's honestly deferred

Production deploy would address these; the hackathon submission states them openly rather than papering over.

- **DNT PWE on-chain.** Code is in (`compute_pwe_dnt` at commit `2d2050c`) but takes effect only after the next Move upgrade. Existing testnet markets still track DNT at PWE = 0 (per-position caps still bind).
- **Empirical gas-spread, PTB-rejection live test, abort-leak test.** Doc 17a §A0's three §6.3 tests require a deployed-package + `devInspect` harness, out of scope for the hackathon window. The primary defense (R1 — Sui's compile-time PTB-Random rule) is enforced by the Sui bytecode verifier independently.
- **`verify.ts` walk-state seed.** Hardcoded `vol_regime_init = 1_000_000n` matching the bootstrap default; a market deployed with a non-default value would mismatch from k=0. Runtime warning emitted; the proper fix is to extend `SegmentMarketCreated` to also emit `vol_regime_init` or to expose `state_after` from the segments Table.
- **B7-default market on testnet (`0x0c2bdb…71f9`)** uses the old stake bounds where `MIN_STAKE × ROUND_DURATION > cap`. Smoke market (`0x2f74…1e45`) and any future bootstrap use the new self-consistent defaults; the broken one stays for archive purposes.
- **E1 verify SEV-2s** (closure-time race window, `firstEvent` full-pagination cost, ID case-sensitivity), **E2 spine-test breadth** (only one happy-path scenario), **D5/D6 SEV-2 polish** (phase-semantics on 1-candle patterns, round-transition false pulse, tab-visibility guard). Reviewer-noted; non-blocking.
- **v3 architecture (sponsored cranking + storage rebate pruning + Walrus archive)** — design locked in [`docs/design/v2/22_sponsored_cranking_v3.md`](docs/design/v2/22_sponsored_cranking_v3.md), [`23_storage_rebate_pruning_v3.md`](docs/design/v2/23_storage_rebate_pruning_v3.md), and [`24_walrus_archive_v3.md`](docs/design/v2/24_walrus_archive_v3.md) (landed 2026-05-23). Implementation planned but not on testnet yet. Today's deploy is v2; users still pay their own cranking gas, segments still accrue on-chain forever, and `/verify` reads segments from the on-chain Table (not a Walrus blob).

This is the part of the threat-model where a serious reviewer earns their keep. See [`docs/threat-model.md`](docs/threat-model.md) for the full inventory.

---

## Run it locally

```bash
git clone https://github.com/SeamMoney/sui-options && cd sui-options
npm install                                # all workspaces in one go

# Move
cd move && sui move test && cd ..          # 607/607

# upgrade Move package on testnet (preserves all existing singletons)
./scripts/deploy-testnet.sh                # OR sui client upgrade --upgrade-capability <cap>

# bootstrap a SegmentMarketV4 (touch-either, always-open — the LIVE arcade module)
./scripts/bootstrap-segment-market-v4.sh   # B7-calibrated defaults

# end-to-end smoke — funds a throwaway burner, then open → crank → close → audit,
# all on-chain, no wallet/setup (this is the one judges run):
npm run smoke:ride

# keep a v4 market's on-chain chart cranking (record_segment_v4) from a wallet:
node scripts/sentinel-v4-fast.mjs          # poll mode — cranks only while rides are open

# read-only API
npm run -w api dev                         # http://localhost:8787

# frontend
npm run -w frontend dev                    # http://localhost:5173

# keep the live v4 chart moving for a demo (open → crank → close, supervised)
npm run chart:keep                         # ~30 SUI/hr; Ctrl+C closes the ride
```

> The `bots/` package drove the **retired v1** touch/no-touch *trade* model
> (`wick::create_market` / `buy`), which no longer exists on-chain — so
> `npm run bots:run` is legacy and won't settle against the current package.
> Use `npm run chart:keep` (above) to animate the live v4 chart instead.

`scripts/agent-preflight.sh` is the canonical pre-commit gate: Move test + frontend / keeper / bots tsc. Required green before any commit.

---

## Repository layout

```
move/sources/      26 Move modules — market, segment_market, vault, fee_router, …
move/tests/        607 Move tests including conformance, invariants, adversarial, e2e replay, v4.26 rug-roll suite
sdk/src/           @wick/sdk — PTB builders, typed event parsers, deterministic walk TS port
frontend/src/      Vite + React + Sui dApp Kit; live testnet markets
keeper/src/        Cranker + segment-market poller; permissionless on Move side
bots/              Personality-driven testnet traders
api/               Read-only Fastify HTTP service + Vercel /api/faucet endpoint
scripts/           Deploy, bootstrap, smoke, verify, deterministic-walk helpers
docs/design/v2/    Per-feature design specs 00–21 (locked architecture)
deployments/       testnet.json — read this for live IDs, never hardcode
```

---

## Acknowledgments

- **Sui** for the random object + the PTB-Random structural rule that makes the gas-grinding test-and-abort attack a non-issue.
- **papertrade.xyz** for the Martingaler / loss-recycling / fair-launch token shape — adapted, not vendored. Wick re-derives every formula. See [`docs/design/v2/01_martingaler_accounting_v2.md`](docs/design/v2/01_martingaler_accounting_v2.md).
- **Tappr** for the tap-and-hold ride UI inspiration. Wick keeps the Move settlement; the UI is a layer. See [`docs/design/v2/11_ride_streaming_primitive.md`](docs/design/v2/11_ride_streaming_primitive.md).
- **GPT-5 Codex** and **Claude Opus 4.7** as parallel co-implementors with cross-reviewing. The reviewer-agent pattern (one model implements, the other reviews) caught real shipping bugs in this sprint — including a non-functional gas-spread script that would have shipped with a misleading discharge claim.
- **[Thesirix/github-readme-animated-chat-bubbles](https://github.com/Thesirix/github-readme-animated-chat-bubbles)** for the animated chat-bubble SVG generator powering this README's hero.
- **Walrus** (Sui's decentralized blob storage) for the v3 archive design target: per-round segment keys written once at round-end as a Walrus blob, indexed on-chain in `ArchiveIndex`, fetched permanently and permissionlessly by `/verify` regardless of indexer status. v3 spec only — see [`docs/design/v2/24_walrus_archive_v3.md`](docs/design/v2/24_walrus_archive_v3.md).

---

## License

Apache-2.0 — see [`LICENSE`](LICENSE). Demo on Sui **testnet only**, never mainnet.

---

*If a candle in your loss looks wrong, replay it. The math is reproducible bit-for-bit. That's the whole pitch.*
