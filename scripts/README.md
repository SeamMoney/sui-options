# scripts/

Operator-facing bash + node scripts. All scripts read live IDs from
`deployments/testnet.json`; do not hardcode object ids.

## Pre-commit gate

- `agent-preflight.sh` — Move tests + workspace `tsc --noEmit`. Required green
  before any commit (see `AGENTS.md`).

## Deploy / bootstrap

- `deploy-testnet.sh` — upgrade (or first-publish) the Wick Move package on
  testnet, atomically patching `deployments/testnet.json`.
- `bootstrap-segment-market.sh` — create a fresh `SegmentMarket<SUI>` with
  doc 19 §4 B7-calibrated defaults.
- `bootstrap-ride-caps.sh` — bootstrap a `RideMarketCaps` for an existing
  arcade market.
- `seed-arcade-markets.sh` — vault + N random-walk touch markets (refresh
  the `/markets` rail with live expiries).
- `seed-demo-markets.sh` — minimal market set for the demo script.

## Smoke / verify

- `segment-smoke.sh` — end-to-end open / record / close on the most-recent
  segment market, then run `verify.ts`.
- `smoke.sh` — original touch-market smoke.
- `verify.ts` — replay any closed ride against a deterministic walk and
  assert extrema + verdict match (v2/v3 single-barrier path).
- `verify-v4.ts` — **cold-start provable-fairness verifier for the LIVE v4
  demo path** (`segment_market_v4`, touch-either, doc 25). Reads `SegmentRecord`
  rows directly from the market's `segments` Table and, for every segment,
  re-runs `expand_segment(prev.state_after, key)` off-chain to assert the chain's
  claimed min/max **and** the carried walk state match. Each passing segment
  chains to the previous one, so a contiguous run is a single tamper-evident
  proof. Robust to event pruning (reads the Table, not events). Defaults to the
  latest market's last complete round; `--round N`, `--from/--to`, `--all`,
  `--tamper` (self-test), `--rpc <url>`. `npm run verify:v4` / `verify:v4:tamper`.
- `verify_record_segment_shape.py` — schema check for `record_segment` events.
- `prune-proto-smoke.sh` — **empirically validates the storage-rebate
  economic claim** in `docs/design/v2/23_storage_rebate_pruning_v3.md` §3.3
  before v3.4 cutover. Move's test framework can't observe gas/rebate
  accounting (reviewer SEV-2 #B), so this on-chain smoke is the only way
  to prove the "~74M MIST/round positive EV for pruners" claim holds.
  Calls `wick::prune_proto::{create, fill(20), prune_range(0,20)}` on
  testnet, measures wallet balance deltas + per-tx `effects.gasUsed`, and
  asserts `BAL_T2 > BAL_T1` (net positive to the pruner). Refuses to run
  with a clear "upgrade first" message if `prune_proto` is not in the
  deployed package — the module currently lives on branch
  `claude/v3.4-prune-proto` and needs a Move upgrade to land on testnet.

## Demo / faucet

- `demo.sh` — drives the multi-market arcade demo end-to-end.
- `faucet.sh` — request testnet SUI for the active CLI wallet.
- `predict-spike.sh` — staged-load probe for the Predict route.

## Sentinel (tonight-demo bridge — retires with v3.6 sponsored cranking)

- `sentinel-runner.sh` — laptop-side loop that opens + closes a small
  sentinel ride against `segment_markets[-1]` continuously, so the
  `record_segment` wake gate (`active_ride_count > 0`) stays satisfied
  and the chart keeps producing candles between human plays.

  - Funded from `sui client active-address` (NOT the user's burner —
    switch wallets BEFORE running).
  - Skips opening whenever a human ride is already active.
  - Prints a burn-rate preamble and y/N prompt; `YES=1` skips the prompt.
  - On Ctrl+C: traps SIGINT, closes the in-flight ride, then exits.
  - Honors `MARKET=<id>` and `BARRIER=0|1` overrides.

  Replaced by the sponsored-cranking sentinel rider in
  `docs/design/v2/22_sponsored_cranking_v3.md` §3.7 once v3 lands.

## Simulators (off-chain)

- `simulate_protocol.py` — Monte Carlo solvency of the touch-market vault.
- `simulate_segment_protocol.py` — Monte Carlo solvency of the segment
  market with `MULTIPLIER_BPS × ROUND_DURATION_SEGMENTS` sweeps (see
  doc 15 §12).
