# Wick Markets

> Touch / no-touch + double-no-touch options where the position lives only while you hold the screen. Tap the candle, watch PnL tick by tick, release to cash out — or hold for the touch jackpot. On Sui, because nowhere else can update position math every block at fractions of a cent.

Prediction markets ask where BTC ends. **Wick asks whether BTC wicks into a level — and lets you ride that question tick-by-tick.**

| | |
|---|---|
| Network | Sui **testnet** (do not use on mainnet) |
| Package | `0x9f0320d08c2025c57720b6f9b64fdc767441acb1ef778512abbf00c12e1ee8ba` |
| Published | 2026-05-20 (vault_side gate + calibrated parameters) |
| Source of truth | `deployments/testnet.json` — read it programmatically, README may lag a redeploy |
| Surface | Touch / No-Touch + Double-No-Touch + Ride streaming primitive |
| Tests | 256 / 256 Move tests passing |
| Solvency | Monte Carlo across 30k sessions → 0 conservation violations, positive vault edge on every market template (see [§6 of `docs/design/v2/14_ride_economics.md`](docs/design/v2/14_ride_economics.md)) |

## What's shipped

| Layer | What it does | How it's verified |
|---|---|---|
| **Move package** (`move/`) | Touch / no-touch markets, double-no-touch (DNT) corridor exotics, Ride streaming positions, Martingaler vault with loss-recycling FIFO queue, asymmetric impact fee, WICK fair-launch token + staking, global exposure caps, atomic `lock_and_settle`, permissionless cranking, aborted-seed recovery | 252 Move tests pass (`sui move test`); collateral invariant asserted after every state mutation |
| **Keeper bot** (`keeper/`) | Polls market events, drives `PathObservation` ticks, calls `lock_and_settle` when the buffered + deadbanded barrier has been crossed or expiry has passed. Permissionless on the Move side. | Runs end-to-end against testnet on the v1 ABI; update for the C.3 ABI is in progress in parallel |
| **Frontend** (`frontend/`) | Vite + React + Sui dApp Kit. Two-pane trading shell (markets rail + chart + trade panel) wired to live markets via events. | Type-checks clean; dev server up at `http://localhost:5173` |
| **Bots** (`bots/`) | Four personality-driven testnet traders (bull / bear / contrarian / drunk) producing organic activity so the UI doesn't look empty | `npm run bots:run` — ~1 trade/sec across the fleet |
| **SDK** (`sdk/`) and **API** (`api/`) | `@wick/sdk` is the canonical TypeScript surface (zero React deps, PTB builders, no signer attached). `@wick/api` is a read-only Fastify HTTP service for non-TS clients. | Both type-check clean; consumed by frontend, keeper, and bots |

## Architecture

```
                       +-----------------------------+
                       |    WickOracle (per asset)   |  random-walk driver | pull driver
                       +--------------+--------------+
                                      |
                                      v
   +-------------------+      +-----------------+      +----------------------+
   |  RiskConfig       |----->|  PathObservation|<-----| keeper records ticks |
   |  GlobalExposure   |      |  buffer + dead- |      | every block          |
   |  OracleVersionLock|      |  band anti-jitr |      +----------------------+
   +-------------------+      +--------+--------+
                                       |
                                       v
   +--------------------+     +-----------------+     +--------------------+
   | MartingalerVault<C>|<--->|   Market<C>     |---->|     Position       |  redeem
   |  treasury + queue  |     |  status, sigma, |     +--------------------+
   |  fee buckets       |     |  payout mult.   |---->|   RidePosition     |  close_ride
   +---------+----------+     +-----------------+     +--------------------+
             |
             | fee_router splits accrued fees
             v
   +---------+----------+     +-----------------+
   |   WickTokenState   |     | WickStakingPool |
   |  (fair-launch to   |---->|  stakers earn   |
   |   losing side)     |     |  staker bucket  |
   +--------------------+     +-----------------+
```

Per-collateral `MartingalerVault<C>` is the single LP for every market that uses collateral `C`. Markets reference the vault and a `PathObservation` by `ID`. `lock_and_settle` is atomic: it snapshots the path, sets the market status, accrues the fee, and releases the vault's settlement lock in one tx.

## Mechanism — three pillars

The mechanism design borrows the *ideas* from [papertrade.xyz](https://papertrade.xyz) — Martingaler LP-from-losses, fair-launch fee-claim token, asymmetric impact fee — and reimplements them cleanly for the Sui object model and the touch / no-touch + DNT + ride product surface. No code is vendored.

1. **Martingaler vault** — a single LP pool per collateral that recycles loser stakes into the treasury and pays winners from it. A FIFO claim queue smooths cash flow when payouts temporarily exceed the treasury.
2. **WICK fair-launch token** — losers receive WICK proportional to their loss; WICK stakers earn a share of fees going forward. No presale, no team allocation.
3. **Asymmetric impact fee** — fees scale with how "decisive" a position is relative to the current barrier distance. Hugging the barrier costs more than betting against it. For DNT, separate `dnt_inside_decisiveness_bps` / `dnt_outside_decisiveness_bps` shapes are implemented (wiring into `compute_fee_amount` is deferred — see below).

## The Ride primitive

Rides are streaming-touch options that exist only while the user holds the screen. The user calls `open_ride` to escrow a stake, the position accrues `stake_rate_micro_usd_per_sec` against time, and the user calls `close_ride` (cashout) or lets the keeper `crank_expired_ride` (loss on the time cap). If the barrier is touched while the ride is open, the user wins the touch jackpot at `multiplier_bps`. Touch wins ties at the `close_ride` boundary; aborted markets refund 1:1.

Per `docs/design/v2/11_ride_streaming_primitive.md`.

## Run it locally

Prerequisites: `sui` CLI configured for testnet, a funded address, Node 22+.

```bash
# install all workspaces
npm install

# publish (or upgrade) the Move package
./scripts/deploy-testnet.sh

# bootstrap the SUI MartingalerVault + seed a fleet of arcade (random-walk) markets
./scripts/seed-arcade-markets.sh

# end-to-end on-chain smoke test (HIT path)
./scripts/smoke.sh

# multi-actor demo with real testnet wallets and conservation P&L
./scripts/demo.sh --hit
./scripts/demo.sh --expired

# permissionless keeper (drives ticks + settlement)
npm -w wick-keeper run setup-key      # fund the printed address with 0.1 SUI
npm run keeper:watch                  # poll forever; or `npm run keeper:tick`

# read-only HTTP API
npm run dev:api                       # http://localhost:8787

# frontend
npm run dev:frontend                  # http://localhost:5173

# optional: organic activity from personality bots
npm run bots:setup                    # generate + auto-fund 4 bot keys
npm run bots:run                      # bull / bear / contrarian / drunk
```

## Collateral invariant — load-bearing

After every state transition in `move/`, the vault, side bucket, queue, fee buckets, and per-market locks must reconcile. The invariant suite (`move/tests/foundation_v2_tests.move`, `martingaler_vault_tests.move`, `drain_window_tests.move`, and the per-feature `*_tests.move`) asserts this after every step. Bugs here are direct loss-of-funds.

## What is stubbed and would need to change before mainnet

- **`WickOracle`** is fed by `pull_oracle_driver` and `random_walk_driver`. For mainnet, swap in a Pyth or Switchboard pull adapter. The market call sites do not change — they consume `WickOracle` via `PathObservation::record`.
- **The upgrade capability is held by the publisher key alone** (`0xfad7…9455`). On mainnet this should be transferred to a multisig or burned. The package is on `compatible` upgrade policy.
- **Keeper** is permissionless — anyone can run their own — but for production you'd run a redundant fleet rather than a single bot.

## What's deferred (honest list)

These are explicitly **not** in the hackathon demo. They're either pushed to roadmap or wait on a dependency:

- **D.1 Predict route** (BTC via DeepBook Predict) — Predict's mainnet path isn't shipped; pushed to roadmap
- **D.2 DeepBook CLOB listing** — cut
- **E.1 tournament / E.2 badges** — cut
- **Full Pro-Mode rewrite** — the current 2-pane shell *is* Pro Mode; only need a toggle to a Degen view
- **Lookback exotic (A5c)** — needs a new market type, invasive; deferred
- **DNT impact fee wiring** — the decisiveness shapes are implemented in `impact_fee.move`, but `compute_fee_amount` does not yet route through them (the `FeeSnapshot` struct needs extension). DNT winners pay the base fee for MVP.
- **PWE for DNT** — currently 0; per-position caps still bind
- **Keeper TS update for the new ABI** — in progress in parallel
- **Frontend tap-hold ride gesture** — next phase

## Repository layout

```
move/            Sui Move package (252 tests pass)
sdk/             @wick/sdk — TS SDK (WickClient + PTB builders)
api/             @wick/api — Fastify HTTP service (read-only)
keeper/          wick-keeper — permissionless TS settlement bot
bots/            wick-bots — personality-driven testnet trading bots
frontend/        Vite + React trading UI
scripts/         Bash deploy + smoke + multi-actor demo + market seeders
deployments/     Live testnet manifest + archive of upgrades
docs/design/v2/  Per-feature design specs (00 reconciliation → 11 ride primitive)
```

This repo is an **npm workspace**. A single `npm install` from the root installs every TS package with `@mysten/sui` hoisted to the root `node_modules`.

## Sibling workspaces — do not bleed into them

- `/Users/maxmohammadi/aptos-prop-amm` — separate Aptos research workspace. Do not import from there.

See `AGENTS.md` for full agent context including the object model, lifecycle, Darbitex / Desnet / D no-import rule, and the MVP scope.
