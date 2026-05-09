# @wick/api

Read-only HTTP API for [Wick Markets](../README.md). Wraps `@wick/sdk`'s
`WickClient` in Fastify endpoints. No private keys live here — write paths
are entirely client-side via the SDK's PTB builders.

## Run locally

```bash
cd api
npm install
npm run dev          # auto-reload
# or
npm start            # single run
```

Server binds to `0.0.0.0:8787` by default. Override with `PORT` and `HOST`.
RPC URL comes from `deployments/testnet.json#network`; override with
`WICK_API_RPC=https://...`.

```bash
npm run smoke        # hits every endpoint of a running server
```

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health`                         | Liveness; returns network + package id |
| `GET` | `/deployment`                     | Full deployment manifest |
| `GET` | `/markets?collateral_type=<T>`    | All `MarketCreated` markets, optionally filtered by collateral type |
| `GET` | `/markets/:id`                    | Single market detail |
| `GET` | `/positions/:address`             | All `Position` + `LpPosition` objects owned by `address` |
| `GET` | `/oracles`                        | Every `MockOracle` known to the deployment |
| `GET` | `/oracles/by-asset?asset=<key>`   | Find an oracle by asset key (e.g. `BTC/USD`) |

Errors return `{ "error": "<message>" }` with appropriate 4xx/5xx codes.
Address and object-id query params are validated server-side.

## Why no write endpoints

By design. Writes need user signing and the API has no key material; the
SDK's `buildBuyTx`, `buildRedeemWinnerTx`, etc. return `Transaction`
objects the client signs and submits directly. This keeps the API stateless
and rules out an entire class of custody mistakes.

## Deploy

The server is a standard Node app (no native deps). Suitable for any
Node 22+ host: Fly, Railway, Render, raw VM with systemd. For Vercel,
adapt with `@vercel/node` runtime. Set `WICK_API_RPC` to a paid RPC
endpoint in production (the public Sui fullnode rate-limits aggressively).
