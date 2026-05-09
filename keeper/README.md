# Wick Keeper

Permissionless settlement bot for [Wick Markets](../README.md). Polls the
Sui RPC for `MarketCreated` events, fetches each `Market<T>` and its
matching `MockOracle`, and submits `mark_hit` or `settle_expired` whenever
the on-chain conditions are met.

The keeper is permissionless on the Move side — anyone can run one. It
holds its own keypair purely to pay for gas; it never touches LP shares
or trader positions.

## Setup

```bash
cd keeper
npm install
npm run setup-key       # writes ./.keeper-key.json (gitignored)
```

The setup script prints the keeper's address and the CLI command to
fund it. 0.1 SUI on testnet is enough for many ticks.

## Running

```bash
# one-shot (CI / cron)
npm run tick

# long-running poller (5s default; override with WICK_KEEPER_POLL_MS)
npm run watch
```

## Config

All env vars optional:

| Var                       | Default                                       | Notes |
|---------------------------|-----------------------------------------------|-------|
| `WICK_KEEPER_RPC`         | derived from `deployments/testnet.json` network | override RPC URL |
| `WICK_KEEPER_POLL_MS`     | 5000                                           | watch-mode poll interval |
| `WICK_KEEPER_GAS_BUDGET`  | 100000000 (0.1 SUI)                            | per-tx gas budget |
| `WICK_KEEPER_KEY_PATH`    | `./.keeper-key.json`                           | path to the keeper key file |
| `WICK_KEEPER_MARKETS`     | (empty = all)                                  | comma-separated market IDs to act on |

## Event types

The keeper listens to:

- `<package_id>::wick::MarketCreated` — to discover markets
- It also reads `<package_id>::wick::Market<T>` shared objects and
  `<package_id>::oracle_adapter::MockOracle` shared objects directly.

Events are emitted under the **runtime** package id (the latest upgrade),
not the original publish id. The keeper reads `package_id` from
`deployments/testnet.json` and updates automatically when you re-deploy.

## What it does NOT do (yet)

- Index trade events (`PositionOpened`, `Swapped`, etc.) — that's the
  frontend / indexer job, not the keeper's.
- Multi-asset oracles. Right now the keeper finds `MockOracle` by scanning
  recent `oracle_adapter::create_and_share` calls; in production this is
  replaced by a Pyth/Switchboard adapter with a fixed feed registry.
- Retry / backoff on transient RPC errors. Each tick is a clean attempt;
  if a tx fails, the next tick re-plans.
