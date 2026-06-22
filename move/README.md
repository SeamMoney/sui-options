# Wick Markets — Move package

The Sui Move package for **Wick Markets**: short-dated, oracle-observed
**touch / no-touch** barrier options, **double-no-touch (DNT)** corridor
exotics, and the **ride** streaming-touch primitive — all collateralised by the
**MartingalerVault** loss-recycling LP vault.

- **Interface (entry funcs, events, payout, addresses):**
  [`../CONTRACT_INTERFACE.md`](../CONTRACT_INTERFACE.md) — the judge- and
  frontend-facing seam.
- **Architecture & invariants:** [`../AGENTS.md`](../AGENTS.md) (source of truth)
  and [`../docs/architecture.md`](../docs/architecture.md).
- **Entry facade:** [`sources/wick.move`](sources/wick.move).

The package is `wick` (26 modules under `sources/`). The **collateral
invariant** — the `MartingalerVault` conserves every unit
(`cumulative_in − cumulative_out == held`) after every transition (the older
`collateral_vault == total_touch_supply == total_no_touch_supply` phrasing is a
retired-v1 artifact — see [`SAFETY.md`](SAFETY.md)) — is load-bearing and
asserted across the vault/market test suites
([`tests/martingaler_vault_tests.move`](tests/martingaler_vault_tests.move),
[`tests/market_tests.move`](tests/market_tests.move),
[`tests/segment_market_v4_tests.move`](tests/segment_market_v4_tests.move)).

```bash
sui move test                 # invariant + DNT + probability + conformance suites
../scripts/agent-preflight.sh # gate: sui move test + frontend/keeper tsc --noEmit
```

Deploy is **testnet only**; the live `package_id` is in
[`../deployments/testnet.json`](../deployments/testnet.json) (read it from disk —
this file and AGENTS may lag a redeploy).
