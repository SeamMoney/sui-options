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

---

## Faucet — `api/faucet.ts` (Vercel serverless function)

Separate from the Fastify server above. Lives at `api/faucet.ts` at the
repo root so Vercel auto-detects it as a Node serverless function at
`/api/faucet` on every preview / production deploy. The Fastify server
in `api/src/` is excluded from Vercel via `.vercelignore` (it runs
elsewhere — Fly / Railway / etc.).

### What it does

POSTs from the frontend "Get test SUI" button (see
`frontend/src/components/wallet/FaucetButton.tsx`) drip a fixed amount
of testnet SUI from a pre-funded app wallet to the caller's address.
Exists because the public Sui faucet is heavily IP-rate-limited and
unreliable during demos.

```
POST /api/faucet
Content-Type: application/json
{ "recipient": "0x<64-hex Sui address>" }
```

Responses:

| Status | Body                                                       | Meaning                                |
|--------|------------------------------------------------------------|----------------------------------------|
| `200`  | `{ digest, amount_mist: "50000000", recipient }`           | Drip successful, tx confirmed onchain  |
| `400`  | `{ error: "recipient is not a valid Sui address" }`        | Validation failed                      |
| `405`  | `{ error: "method not allowed; use POST" }`                | Wrong HTTP verb                        |
| `429`  | `{ error: "rate-limited", retry_after_ms, cooldown_ms }`   | Per-recipient 5-min cooldown hit       |
| `502`  | `{ error: "transaction did not succeed on-chain", digest }`| Tx submitted but Move-aborted          |
| `503`  | `{ error: "faucet wallet is drained …", sender }`          | Source wallet below `DRIP + GAS_BUFFER`|

Fixed parameters (edit them in `api/faucet.ts`, not here):

- Drip amount: `50_000_000` MIST = **0.05 SUI** per request
- Gas buffer: `20_000_000` MIST (must remain in the source wallet)
- Per-recipient cooldown: **5 minutes** (in-process map; see *Limitations*)

### Required env var

**`WICK_FAUCET_PRIVATE_KEY`** — bech32-encoded Ed25519 secret key for the
faucet wallet (the kind that starts with `suiprivkey1…`). Never commit
this anywhere; it lives only in `.env.local` and in Vercel's env store.

> Current faucet wallet address: `0xc9179f15614b95517c7377e721b7a9d0d56eeaea1b9074b27e2c760cdb22c298`
> (testnet only — do **not** reuse on mainnet).

### Setting the env var locally

`vercel dev` reads `.env.local` from the project root, so put it there:

```bash
# from the repo root
echo 'WICK_FAUCET_PRIVATE_KEY=suiprivkey1…' > .env.local
```

A per-workspace `api/.env.local` is also picked up by `vercel dev` —
either location works; pick one and document it for your collaborators.

### Setting it on Vercel

Run these from the repo root (after `vercel link` if the project isn't
linked yet):

```bash
vercel env add WICK_FAUCET_PRIVATE_KEY production
vercel env add WICK_FAUCET_PRIVATE_KEY preview
vercel env add WICK_FAUCET_PRIVATE_KEY development
```

Each prompts for the value (paste the `suiprivkey1…` string). Vercel
encrypts it at rest. Trigger a fresh deploy after adding so the new
env var is baked into the function.

Verify:

```bash
vercel env ls
```

### Re-funding when the wallet drains

When `/api/faucet` starts returning `503 faucet wallet is drained`, the
source wallet ran below `DRIP + GAS_BUFFER` (≈ 0.07 SUI). Top it back
up by sending testnet SUI directly to the wallet address:

```
0xc9179f15614b95517c7377e721b7a9d0d56eeaea1b9074b27e2c760cdb22c298
```

Options:

- `sui client transfer-sui --to 0xc917…2c298 --amount 1000000000 --sui-coin-object-id <gas-coin> --gas-budget 10000000` from any wallet that already has testnet SUI
- The Sui public faucet — slow but free: `curl -X POST https://faucet.testnet.sui.io/v2/gas -H 'Content-Type: application/json' -d '{ "FixedAmountRequest": { "recipient": "0xc917…2c298" } }'`
- Drip from another personal testnet wallet via the Sui CLI

Once funded, the next call to `/api/faucet` succeeds without a redeploy
(the function reads the live balance every invocation).

### Limitations

- **Rate limit is best-effort.** The in-process `Map` keyed by recipient
  resets when Vercel cold-starts the function or routes traffic to a
  different region. A determined abuser can drain the wallet by spinning
  up many origins. For production, front this with Vercel KV / Upstash /
  Edge Config.
- **No address allow-list.** Anyone on the internet who knows the URL
  can drip. Fine for hackathon; revisit for any wider beta.
- **Public Sui RPC.** Uses `https://fullnode.testnet.sui.io:443`. Under
  load, swap to a paid RPC by editing `getClient()` in `api/faucet.ts`.

### Local testing

`vercel dev` (from the repo root, with `.env.local` populated):

```bash
# happy path
curl -X POST http://localhost:3000/api/faucet \
  -H 'Content-Type: application/json' \
  -d '{"recipient":"0xfad710377f820b10097f7ac445bc56e738db2bce712f898072061e0591049455"}'
# → 200 {"digest":"…","amount_mist":"50000000","recipient":"0xfad7…"}

# bad address
curl -X POST http://localhost:3000/api/faucet \
  -H 'Content-Type: application/json' \
  -d '{"recipient":"not-an-address"}'
# → 400 {"error":"recipient is not a valid Sui address"}

# repeat within 5 minutes
# → 429 {"error":"rate-limited","retry_after_ms":…,"cooldown_ms":300000}
```

---

## Sponsor — `api/sponsor.ts` (Vercel serverless function)

`POST /api/sponsor` co-signs allowlisted v3 SegmentMarket transactions so
the Wick sponsor wallet pays gas while the user remains the transaction
sender. The function targets Sui testnet only and reads the Wick package id
from `deployments/testnet.json`.

```
POST /api/sponsor
Content-Type: application/json
{
  "sender": "0x<64-hex Sui address>",
  "txBytes": "<base64 TransactionData>",
  "userSig": "<base64 serialized user signature>"
}
```

Responses:

| Status | Body | Meaning |
|---|---|---|
| `200` | `{ digest }` | Sponsored tx submitted and succeeded onchain |
| `400` | `{ error }` | Request body, address, or base64 validation failed |
| `403` | `{ error }` | Tx failed allowlist or gas-owner validation |
| `429` | `{ error, retry_after_ms, limit, window_ms }` | Sender exceeded 5 sponsored calls per minute |
| `503` | `{ error }` | Sponsor env, RPC, daily cap, or execution unavailable |

Allowlist semantics:

- Exactly one Move call is permitted.
- Target must be `segment_market_v3::record_segment`,
  `segment_market_v3::open_segment_ride`, or
  `segment_market_v3::close_segment_ride` on the configured testnet package.
- The market object argument must be a
  `segment_market_v3::SegmentMarketV3<...>` object from that same package.
- `tx.gas.owner` must equal the sponsor address derived from
  `WICK_SPONSOR_PRIVATE_KEY`.
- The only auxiliary command allowed is transferring the whitelisted Move
  call's own result back to `sender`; sponsor gas coins are never transferred
  to the user.

Required env vars:

- `WICK_SPONSOR_PRIVATE_KEY` - bech32 Ed25519 private key for the sponsor gas
  wallet (`suiprivkey1...`). Never expose this to the frontend.
- `WICK_SPONSOR_MAX_DAILY_MIST` - maximum sponsored gas spend per UTC day,
  tracked in process memory for v3.0. The counter resets at UTC midnight and
  returns `503` once the cap is reached.

Limitations:

- The rate limit and spend cap use module-scoped memory. They survive warm
  Vercel invocations only; v3.1 should back them with KV or Redis.
- The happy path requires a deployed `SegmentMarketV3`; until that exists on
  testnet, local smoke should use malformed or non-Wick transactions and expect
  `403`.
