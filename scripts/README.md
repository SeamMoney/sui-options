# scripts/

Operator-facing bash + node scripts. All scripts read live IDs from
`deployments/testnet.json`; do not hardcode object ids.

## Pre-commit gate

- `agent-preflight.sh` — Move tests + workspace `tsc --noEmit`. Required green
  before any commit (see `AGENTS.md`).

## Deploy / bootstrap

- `deploy-testnet.sh` — upgrade (or first-publish) the Wick Move package on
  testnet, atomically patching `deployments/testnet.json`.
- `bootstrap-segment-market-v4.sh` — create a fresh `SegmentMarketV4<SUI>`
  (touch-either, always-open per doc 25) — **the live arcade module.**
- `bootstrap-tusd-market-rugged.sh` — the v4.26 rugged TUSD market
  (`rug_chance_bps` MARKET HALT per doc 26).
- `bootstrap-segment-market.sh` *(legacy v3)* — fresh `SegmentMarket<SUI>`
  with doc 19 §4 B7-calibrated defaults.
- `bootstrap-ride-caps.sh` — bootstrap a `RideMarketCaps` for an existing
  arcade market.
- `seed-arcade-markets.sh` — vault + N random-walk touch markets (refresh
  the `/markets` rail with live expiries).
- `seed-demo-markets.sh` — minimal market set for the demo script.

## Smoke / verify

- `judge.mjs` (`npm run judge`) — **the one command a reviewer runs.** Chains
  the no-browser proofs (live demo up · provable fairness honest + tamper-caught
  · live P&L == settlement) with a judge-readable narrative and a single
  PASS/FAIL (~15s, no wallet, never flaky). `npm run judge -- --with-e2e` adds
  the live-UI Playwright flows; `-- --with-chain` adds the full cold on-chain
  ride loop; `-- --full` runs everything.
- `e2e-pro-smoke.mjs` (`npm run e2e:pro`) — drives the **submission** (Wick Pro,
  `/pro`) headless against the live site exactly as a judge would: loads the
  live DeepBook mark, opens a $5 UP option, asserts the live P&L ticks, closes
  back to the lobby, switches the asset to BTC, and fails on any console/page
  error. Screenshots each step to `~/work/uploads/a8-e2e`. Skips cleanly (exit 0)
  if Playwright isn't installed, so CI without browsers stays green.
- `e2e-verify-smoke.mjs` (`npm run e2e:verify`) — drives the `/verify`
  **Provable Fairness** page headless and asserts the headline differentiator
  works BOTH ways: the honest replay matches every chain-reported candle (all
  ✓, PASS verdict), and ticking "Simulate a dishonest house" makes the tampered
  segment get caught (✗, FAIL verdict). Screenshots both states.
- `e2e-coach-smoke.mjs` (`npm run e2e:coach`) — drives the `/coach` **DeepBook
  Desk** headless: live SUI/USDC mark, CandleVision pattern coach, the live
  Black-Scholes quote (CALL + PUT + σ + Δ + break-even), the payoff diagram, and
  the BTC asset re-mark — fails on any console error. Backs the "the mark is a
  real on-chain CLOB" claim. (`npm run e2e` runs the pro + verify + coach flows
  back to back.)
- `judge-ride-smoke.ts` (`npm run smoke:ride`) — **the one-command on-chain
  proof a judge runs cold.** Mints a throwaway burner, funds it from the live
  faucet, then `open_segment_ride_v4 → record_segment_v4 → close_segment_ride_v4`
  and audits the closed ride with `verify-v4.ts`. Ends "PASS — the chain was
  honest." No wallet, no setup.
- `verify-v4.ts` — the **current** provable-fairness CLI. Replays a closed
  **v4** ride (or a live market's recent segments) against the deterministic
  walk and asserts extrema + verdict match; rug-aware (re-derives the keccak
  MARKET HALT roll), prune-proof (reads the on-chain segment Table). Drives
  `npm run verify:fairness{,:tamper,:live}`.
- `autoplay-v4.26-rugged.mjs` — stress harness: runs N full v4 rides
  (`--rides N`) against the rugged TUSD market to generate on-chain activity
  + RugFeed events.
- `segment-smoke.sh` *(legacy v3)* — open/record/close on a v3 `SegmentMarket`;
  v3 `open_segment_ride` aborts on the live package — use `npm run smoke:ride`.
- `verify.ts` *(legacy v3)* — replays a v3 ride; superseded by `verify-v4.ts`.
- `smoke.sh` — original touch-market smoke.
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

## Sentinel — keep the on-chain chart alive between human plays

- `chart-keeper.sh` (`npm run chart:keep`) — **resilient supervisor** for a
  live demo: runs `sentinel-v4-fast.mjs` in `CRANKER_MODE=always` and restarts
  it ~5s later if the process dies (RPC outage / OOM / network drop), so the
  chart never freezes mid-judging. Ctrl+C stops it (the sentinel closes its
  in-flight ride first). ~30 SUI/hr. Tunables (`CRANK_INTERVAL_MS`,
  `HOLD_SEGMENTS`) pass through.
- `sentinel-v4-fast.mjs` — **the v4 cranker.** In-process `@mysten/sui`
  loop that pumps `record_segment_v4` (~150–200ms/crank) so a
  `SegmentMarketV4` chart keeps producing candles (and rugs keep firing into
  the RugFeed). Poll mode by default (cheap, ~0 SUI idle); `CRANKER_MODE=always`
  cranks unconditionally. `node scripts/sentinel-v4-fast.mjs`.
- `sentinel-runner.sh` *(legacy v3)* — laptop-side loop that opens + closes a
  small sentinel ride against `segment_markets[-1]` continuously, so the v3
  `record_segment` wake gate (`active_ride_count > 0`) stays satisfied and the
  chart keeps producing candles between human plays.

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
