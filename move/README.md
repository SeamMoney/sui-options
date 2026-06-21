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

The package is `wick` (~25 modules under `sources/`). The **collateral
invariant** — `collateral_vault == total_touch_supply == total_no_touch_supply`
after every transition — is load-bearing and covered by
[`tests/invariants.move`](tests/invariants.move).

```bash
sui move test                 # invariant + DNT + probability + conformance suites
../scripts/agent-preflight.sh # gate: sui move test + frontend/keeper tsc --noEmit
```

Deploy is **testnet only**; the live `package_id` is in
[`../deployments/testnet.json`](../deployments/testnet.json) (read it from disk —
this file and AGENTS may lag a redeploy).
