# Wick Markets — Agent Context

Source of truth for any AI coding agent (Claude Code, Codex CLI, Cursor, Aider, …) working in this repo. Read this before touching any other file.

## What Wick is

Short-dated **touch / no-touch** binary options, **double-no-touch (DNT)** corridor exotics, and **continuous-streaming rides** on oracle-observed price barriers, on Sui.

One-liner: *Prediction markets ask where BTC ends. Wick asks whether BTC wicks into a level — and lets you ride that question tick-by-tick while you hold the screen.*

Working name: **Wick Markets**. Tagline: *Options for the next candle.*

## Tech stack — pinned, do not propose alternatives

- **`move/`** — Sui Move package
- **`frontend/`** — Vite + React + TypeScript + Sui wallet adapter
- **`keeper/`** — TypeScript keeper bot (cranks live ride segments: poll → `record_segment_v4`, via the SegmentCranker/SegmentSentinel; the legacy `mark_hit`/`settle_expired` path is retired with the v1 ABI)
- **`scripts/`** — bash deploy and smoke-test scripts

## MVP scope — Touch / No-Touch + DNT + Ride

In scope and shipped:

- Touch / No-Touch single-barrier markets
- Double-No-Touch (DNT) two-barrier corridor exotics (`STATUS_DNT_HELD=5`, `STATUS_DNT_BROKEN=6`)
- Ride streaming primitive — `open_ride` / `close_ride` / `crank_expired_ride` (lives only while the user holds the screen)
- Martingaler vault + asymmetric impact fee + WICK fair-launch token (Phase C.3)

**v3 was designed 2026-05-23, and its on-chain primitives later shipped folded into the v4.26 package** (not as a separate `v3` line — see the status note below). Design specs:
- [`docs/design/v2/22_sponsored_cranking_v3.md`](docs/design/v2/22_sponsored_cranking_v3.md) — gas sponsorship via `/api/sponsor` + `wick::sponsor` module
- [`docs/design/v2/23_storage_rebate_pruning_v3.md`](docs/design/v2/23_storage_rebate_pruning_v3.md) — `prune_settled_segments` for positive-EV storage reclamation
- [`docs/design/v2/24_walrus_archive_v3.md`](docs/design/v2/24_walrus_archive_v3.md) — permanent decentralized round archive via Walrus

The shipped surface is **v2** (touch/no-touch + DNT) **plus v4** (rides). The v3 design (docs 22/23/24) was largely folded into the v4.26 package rather than a separate `v3`: `wick::sponsor` (`move/sources/sponsor.move`), `prune_settled_segments` (storage-rebate reclaim), and the Walrus archive write (`record_walrus_archive`) are **live in the `wick` facade on testnet**, and the sponsor service exists at `api/sponsor.ts`. Still **NOT** done: the sponsor flow isn't wired end-to-end into user txs (the `SponsorPolicy` is initialized but unused — see *Current testnet state*), the standalone **archiver bot** was never built, and there is **no** separate `segment_market_v3` (v4's `segment_market_v4` subsumed that redesign). Do not build out that remaining v3 surface (end-to-end sponsor wiring, archiver bot) unless the user explicitly asks.

Do **not** write code for any of these unless the user explicitly says we're past MVP:

- Range / Breakout markets
- Lookback exotic (A5c — deferred, needs a new market type, invasive)
- D stablecoin collateral
- Aptos / Decibel adapter (lives in `/Users/maxmohammadi/aptos-prop-amm`, not here)
- Generic token factory
- Leveraged positions
- Multi-market shared collateral (the `MartingalerVault<C>` is single-collateral by design)
- Advanced option pricing models
- DeepBook Predict route (D.1) and DeepBook CLOB listing (D.2) — cut from hackathon scope
- Tournament / badges gamification (E.1 / E.2) — cut from hackathon scope

If a task seems to require any of the above, stop and ask.

## The collateral invariant — load-bearing

User collateral is escrowed in the `MartingalerVault`. After every state transition in `move/`, the vault conserves every unit — nothing minted, nothing lost:

```
cumulative_in − cumulative_out == held      (held = treasury + side_bucket + Σ per-market locks)
```

Any function that mutates the vault or a market's stakes/exposure must preserve this. (The older `collateral_vault == total_touch_supply == total_no_touch_supply` phrasing is from the **retired v1 complete-set model**; in v2 a depositor stakes into ONE side via `deposit_open`, so `touch_stakes`/`no_touch_stakes` are independent accumulators — a touch-only market simply has `no_touch_stakes == 0` — and that cross-side equality is **not** the v2 invariant.) The conservation test (`conservation_in_minus_out_equals_held` in `move/tests/martingaler_vault_tests.move`) and the rest of the `sui move test` suite must pass before any commit. Bugs here are direct loss-of-funds. See [`move/SAFETY.md`](move/SAFETY.md) for the full map of every safety property to the named test that proves it.

## Safety properties the Move package must enforce

- A market cannot settle both ways (HIT and EXPIRED are mutually exclusive; DNT_HELD and DNT_BROKEN are mutually exclusive)
- Settlement is idempotent — repeat calls are no-ops or revert, never re-mutate
- Repeated `redeem` cannot double-pay (the `Position` UID is consumed on payout)
- Losing side cannot redeem
- `lock_and_settle` is atomic — snapshot, status, fee accrual, and lock release all commit in one tx
- Aborted markets refund 1:1 to depositors, never 2:1
- **Ride positions**: touch wins ties at the `close_ride` boundary; aborted refund is 1:1 never 2:1

## Object model — architectural decision, do not change without discussion

Use **dynamic Sui objects**, not a new `Coin<T>` per market.

Per-market objects:

- `Market<phantom C>` — `key`-only, references its `MartingalerVault` and `PathObservation` by `ID`, holds supply totals, status, payout multiplier, sigma, and fee snapshot
- `Position` — `key, store`, points at a market by `ID`, has `side`, `stake`, `payout_if_win`, `pwe_at_open`
- `RidePosition` — `key, store`, the streaming-touch primitive; tracks `multiplier_bps`, `stake_rate_micro_usd_per_sec`, `escrowed`, and a settlement enum (`SETTLEMENT_OPEN / TOUCH_WIN / CASHOUT / EXPIRED_LOSS / ABORTED_REFUND`)
- `PathObservation` — `key`, shared; the oracle-driven barrier-cross record, with `buffer_bps` + `deadband_bps` anti-jitter (papertrade-pattern, `DEFAULT_DEADBAND_BPS = 20`). Constructors: `new_v2/v3/v4` for single-barrier, `new_dnt/new_dnt_v2` for corridor exotics.
- `RideMarketCaps` — `key`, shared; per-market cap on concurrent ride exposure

Per-collateral / global objects:

- `MartingalerVault<C>` — `key`-only, the loss-recycling LP vault; holds treasury, side bucket, per-market settlement locks, per-market abort pools, FIFO claim queue, and fee buckets (protocol / staker / insurance)
- `FeeRouter` — routes accrued fees to the three buckets per the `RiskConfig`
- `RiskConfig` — global parameters: fee splits, deadband, payout caps, ride caps
- `GlobalExposureRegistry` — caps aggregate exposure across correlated markets
- `BotRegistry` — registry of bot-eligible accounts (rebates / payout multipliers)
- `OracleVersionLock` — pins the oracle version a market settles against
- `UsdPriceOracle` — small price-of-collateral oracle (mints `micro-USD` denominations for stake-rate accounting)
- `WickOracle` — the in-package oracle interface fed by `pull_oracle_driver` and `random_walk_driver`
- `WickTokenState` — fair-launch token state for **WICK**
- `WickStakingPool` — stakers receive a share of the staker fee bucket

The struct summaries above are the current v2 source of truth (alongside the actual `move/sources/`). See `docs/design/v2/` for the per-feature design specs. (`docs/architecture.md` is **historical v1** — kept for context, not current; it's banner-flagged as such.)

## Lifecycle

The v1 `create → trade ↔ swap ↔ redeem_complete_set` flow is **gone**. Current flow:

```
bootstrap_vault → seed_vault                          // once per collateral
bootstrap_*_market (touch / no-touch / dnt)           // per market
  → open  (depositor stakes into Position)            // many times
  → tick  (keeper records oracle ticks into PathObservation)
  → lock_and_settle  (permissionless; atomic snapshot + status + lock release)
  → redeem  (winner burns Position, vault pays out)
```

For rides:

```
open_ride  →  (close_ride | crank_expired_ride)
```

**v3 lifecycle additions (the on-chain primitives shipped in v4.26; the end-to-end sponsor wiring + standalone archiver bot did not — see the v3 status note above; docs/design/v2/22+23+24):**

```
open_ride  →  /api/sponsor co-signs cranking → record_segment (sponsored)
            →  (close_ride | crank_expired_ride)
            →  record_walrus_archive (per round, by archiver bot)
            →  prune_settled_segments (positive-EV permissionless call)
```

Sponsored cranking moves gas to a protocol-funded sponsor wallet (doc 22). `prune_settled_segments` is permissionless, pays the caller via Sui's storage rebate, and keeps `segment_market_v4` storage bounded (doc 23). `record_walrus_archive` writes the round's segment keys to Walrus before pruning, so `/verify` works permanently without any indexer (doc 24). The on-chain primitives (the `sponsor` module, `prune_settled_segments`, `record_walrus_archive`) shipped in v4.26; what's not wired is the end-to-end sponsored-cranking flow into user txs + the standalone archiver bot.

Touch is **oracle-observed**. The product definition is "price as observed by the oracle crossed the buffered + deadbanded barrier" — not "any off-chain exchange tick." This must be honest in the README, the UI, and the threat model.

## Darbitex / Desnet / D — reference only, never imported

**Do not import or vendor** these repos into `sui-options`. They are reference patterns:

- **Desnet** — paired-claim collateral accounting (idea, not code)
- **Darbitex Sui AMM** — Sui object patterns, integer CPMM math (idea, not code)
- **D** — immutable Sui/Aptos deploy pattern (idea, not code, post-MVP)

If a familiar pattern from one of them comes to mind, transcribe the *idea* and rewrite cleanly for Wick. Add a brief comment explaining the choice. See `docs/darbitex-boundary.md`.

## Trader-facing copy

Avoid math language. Use market phrases: *touch, no touch, breakout, range, wick, sweep, max loss, payout, time left.*

## Verification gate — required before any commit

Run from the repo root:

```bash
./scripts/agent-preflight.sh
```

It checks branch, worktree, `sui move test`, frontend `tsc --noEmit`, keeper `tsc --noEmit`. **Do not commit if preflight fails.** Period.

Preflight gates **builds + Move tests**, not the TypeScript **unit** suites (verify-v4, verify-payout, the keeper/sdk/api/bots tests, …). While GitHub Actions CI is unavailable, those are only as green as someone's last manual run — so before merging a TS change also run:

```bash
npm run test:offline   # every deterministic unit suite, no network (cold-runnable)
npm test               # == test:offline (test:live is a no-op placeholder)
```

`test:offline` is the cold gate: it never touches the network (the chart/faucet/audit tests use fixtures, not the live demo), so a red result is a real code regression, not a flaky market. `test:live` is currently a no-op — live verification against the running testnet demo lives in the `check:*` / `e2e:*` / `prove:live` / `verify:fairness:live` targets, so run **`npm run prove:live`** (or `check:all`) when the demo is up to confirm the chart is alive, the faucet has runway, and the on-chain randomness → markets → audit → solvency chain still passes.

One more CI-down gap: changes to **sdk / pro-options / candle-vision** source need `npm run check:dist`. The frontend and `/pro` resolve those packages through each one's **committed `dist/`** (file: deps, not src), so editing their `src/` without rebuilding + committing `dist/` silently ships stale code to the live demo. CI runs `check:dist` (rebuild all four packages, diff against the committed dist) but it's down — so after any edit under those `src/` trees, run `npm run check:dist` and commit the rebuilt `dist/` before merging. (It's deterministic + offline; it's just slow, which is why it's not folded into `test:offline`.)

## Sibling workspaces — do not bleed into them

- `/Users/maxmohammadi/aptos-prop-amm` — separate Aptos research workspace (Decibel, D, Aptos AMM patterns)

## Hackathon notes

- Demo on Sui **testnet**, never mainnet
- Current testnet `package_id` lives in `deployments/testnet.json` (always read it from disk — README and AGENTS may lag a redeploy)
- Demo guide (current, judge-facing): `DEMO.md` — the no-wallet `/pro` + `/ride` 60-second walkthrough; keep it runnable end-to-end at all times. (`docs/design/v2/10_demo_script_v2.md` is the era-historical v2 *presentation* script — wallet/Arcade framing, predates the no-wallet pivot.)
- Per-feature v2 design specs: `docs/design/v2/` (00–11). The ride primitive lives in `11_ride_streaming_primitive.md`.
- Day-by-day milestones: `docs/hackathon-plan.md`
- Granular agent-sized tasks: `TASKS.md`
- Originally-deferred MVP shortcuts are now all addressed in code (2026-05-23): keeper TS wired to segment_market ABI via SegmentCranker (commit 27c6f1a + config fallback); FeeSnapshot's DNT impact-fee path verified end-to-end (`decisiveness_bps_for_side` dispatches on `is_dnt`, 15/15 DNT tests pass); DNT PWE replaces the placeholder `0` with the union-bound Bachelier model `compute_pwe_dnt` (commit 2d2050c — **live on testnet** since the v4.26 upgrade; `compute_pwe_dnt` is in `move/sources/risk_config.move`); frontend tap-hold ride gesture shipped in commit 79e85c1.
- v3 architecture spec landed 2026-05-23: [`docs/design/v2/22_sponsored_cranking_v3.md`](docs/design/v2/22_sponsored_cranking_v3.md) + [`23_storage_rebate_pruning_v3.md`](docs/design/v2/23_storage_rebate_pruning_v3.md) + [`24_walrus_archive_v3.md`](docs/design/v2/24_walrus_archive_v3.md). Its on-chain primitives then shipped **folded into the v4.26 package** (the `sponsor` module, `prune_settled_segments`, `record_walrus_archive`; `api/sponsor.ts` exists) — see the v3 status note up top. What's still unbuilt from that roadmap: end-to-end sponsor wiring into user txs + the standalone archiver bot (there is no separate `segment_market_v3` — v4 subsumed it). v2 (touch/no-touch + DNT) and v4 (rides) are in production.

### Current testnet state (2026-05-25, post-v4.26)

- **Move package**: `0x1fdf784743d82c000e84154506e21daedc45bf241818fef6b28635e99e815924` (v4.26, upgraded 2026-05-25 from `0x10c3…`) — source of truth `deployments/testnet.json`; every object verified live in `deployments/ADDRESSES.md`. The detailed object IDs below this line are a 2026-05-25 snapshot and may lag a redeploy — trust `testnet.json`/`ADDRESSES.md`.
- **TUSD test stablecoin**: `0x204d595c…::tusd::TUSD` (1B minted to publisher, 100M seeded into MartingalerVault<TUSD>). Faucet wallet holds the TreasuryCap so `/api/faucet-tusd` mints on demand.
- **Active markets** (authoritative list in `deployments/testnet.json:segment_markets_v4` + `ADDRESSES.md`):
  - **TUSD + rug — the live demo market**: `0x54e915…` — SegmentMarketV4 with the 1.5%/seg `MARKET HALT`. The rug shipped in v4.26 (no longer "pending"); `smoke:ride` funds + plays + audits this market cold.
  - TUSD non-rug: `0xe98ace0b…` — SegmentMarketV4, 75-seg round, no halt (kept as a no-rug fallback).
  - SUI legacy: `0xa72a36…` (kept for fallback, no rug).
- **Sponsor wallet**: `0x02e3f17c…` — **funded** for sponsored cranking (~200 SUI at the v4.26 snapshot; `python3 scripts/verify-deployment.py` reports the live balance), `SponsorPolicy` initialized at `0x00d868c659dd…`, but **not yet wired into user txs** (the end-to-end sponsored-cranking flow is unbuilt — see the v3 status note up top)
- **House edge model**: per-segment rug-pull at `rug_chance_bps = 150` (1.5%). The current calibration (doc 27 economic model, `scripts/simulate_v4.27_strategies.py` — a 6-strategy sweep at 50k rounds each) lands every tested strategy in a **+3.93% to +11.71%** house-edge band, the figure the README quotes. (Doc 26's earlier single-strategy estimate was +3.4% via `scripts/simulate_v4_house_edge.py` — superseded by the doc-27 sweep.) See `scripts/verify-v4.26-rug.mjs` for the on-chain validation harness.
- **v4 design spec doc 25** (touch-either always-open) shipped on testnet at commit `b1e9a2c`. **v4.26 (rug-pull house edge)** spec at `docs/design/v2/26_rug_pull_house_edge_v4.md` — **shipped on testnet** (package `0x1fdf…`, v4.26, upgraded 2026-05-25).
