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
| `200`  | `{ digest, amount_mist: "2000000000", recipient }`          | Drip successful, tx confirmed onchain  |
| `400`  | `{ error: "recipient is not a valid Sui address" }`        | Validation failed                      |
| `405`  | `{ error: "method not allowed; use POST" }`                | Wrong HTTP verb                        |
| `429`  | `{ error: "rate-limited", retry_after_ms, cooldown_ms }`   | Per-recipient 90s cooldown hit         |
| `502`  | `{ error: "transaction did not succeed on-chain", digest }`| Tx submitted but Move-aborted          |
| `503`  | `{ error: "faucet wallet is drained …", sender }`          | Source wallet below `DRIP + GAS_BUFFER`|

Fixed parameters (edit them in `api/faucet.ts`, not here):

- Drip amount: `2_000_000_000` MIST = **2.0 SUI** per request (covers a full multi-ride evaluation session; the v4 game cranks client-side at ~9M MIST/segment)
- Gas buffer: `20_000_000` MIST (must remain in the source wallet)
- Per-recipient cooldown: **90 seconds** (in-process map; see *Limitations*)

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
- **Public Sui RPC.** Defaults to `https://sui-testnet-rpc.publicnode.com`
  (PublicNode — the Mysten public fullnode throttles under load). Override
  with the `WICK_API_RPC` env var, or swap to a paid RPC.

### Local testing

`vercel dev` (from the repo root, with `.env.local` populated):

```bash
# happy path
curl -X POST http://localhost:3000/api/faucet \
  -H 'Content-Type: application/json' \
  -d '{"recipient":"0xfad710377f820b10097f7ac445bc56e738db2bce712f898072061e0591049455"}'
# → 200 {"digest":"…","amount_mist":"2000000000","recipient":"0xfad7…"}

# bad address
curl -X POST http://localhost:3000/api/faucet \
  -H 'Content-Type: application/json' \
  -d '{"recipient":"not-an-address"}'
# → 400 {"error":"recipient is not a valid Sui address"}

# repeat within 90 seconds
# → 429 {"error":"rate-limited","retry_after_ms":…,"cooldown_ms":90000}
```

---

## TUSD faucet — `api/faucet-tusd.ts` (Vercel serverless function)

The companion to `/api/faucet`. The SUI faucet hands out gas; this one mints
**TUSD** (the Wick testnet stablecoin) so a fresh wallet has something to *bet*.
Together they're the no-wallet cold-start a judge runs: `/api/faucet` for gas,
`/api/faucet-tusd` for stake, then play the on-chain ride.

The TUSD `TreasuryCap` is owned by the same wallet that drips SUI, so the
**same `WICK_FAUCET_PRIVATE_KEY`** signs both. The cap object id is read from
`deployments/testnet.json` at build time and embedded in the bundle.

```
POST /api/faucet-tusd
Content-Type: application/json
{ "recipient": "0x<64-hex Sui address>" }
```

Responses:

| Status | Body                                              | Meaning                              |
|--------|---------------------------------------------------|--------------------------------------|
| `200`  | `{ digest, amount_raw: "10000000", recipient }`   | Minted 10 TUSD, tx confirmed onchain |
| `400`  | `{ error: "recipient is not a valid Sui address" }`| Validation failed                    |
| `429`  | `{ error: "rate-limited", retry_after_ms }`        | Per-recipient 90s cooldown hit       |
| `500`  | `{ error: … }`                                     | Mint build/sign error                |
| `503`  | `{ error: … }`                                     | RPC/treasury unavailable             |

Fixed parameters (edit them in `api/faucet-tusd.ts`, not here):

- Drip amount: `10_000_000` raw = **10 TUSD** (6 decimals) — ~66 rides at $0.15 max stake
- Per-recipient cooldown: **90 seconds** (in-process map)

Same `WICK_FAUCET_PRIVATE_KEY` env var as the SUI faucet — see above. Defaults to
the PublicNode RPC, since both faucets are tapped together on every cold start and
the Mysten public fullnode throttles under that concurrent load.

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
- Target must be one of the public v3 router calls on `wick`:
  `record_segment_v3`, `open_segment_ride_v3`, `close_segment_ride_v3`,
  `crank_expired_segment_ride_v3`, or `abort_segment_ride_v3`.
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

---

## Verify Pro — `api/verify-pro.ts` (Vercel serverless function)

Verifies a **Wick Pro** round's commit-reveal from a URL — no clone, no CLI, no
wallet. Every `/pro` round publishes `commit = SHA-256(`${seed}:${paramsJson}`)`
before the lobby and reveals `{ seed, paramsJson }` at settle. This endpoint
recomputes the digest independently (`node:crypto`) and reports whether the
revealed preimage binds — the same guarantee as `npm run verify:pro-fairness`,
but over HTTP for a judge who'd rather paste three values than clone the repo.

```
POST /api/verify-pro
Content-Type: application/json
{ "commit": "<64-hex SHA-256>", "seed": 1337, "paramsJson": "<exact revealed params>" }
```

**Try it live** (a self-checking example — the commit is `sha256("1:test")`):

```bash
curl -s -X POST https://wick-markets.vercel.app/api/verify-pro \
  -H 'content-type: application/json' \
  -d '{"commit":"95800a04e5f0d6e79aac11fd3006d928108bc752f9d2f677a29de47dbefe7e0a","seed":1,"paramsJson":"test"}'
# → {"matches":true,"verdict":"HONEST …"}   (confirm yourself: printf '1:test' | sha256sum)
```

Or as a **clickable link** (GET, the same three values URL-encoded — read-only):

```
GET /api/verify-pro?commit=<64-hex>&seed=1337&paramsJson=%7B...%7D
```

Responses:

| Status | Body                                                                   | Meaning                              |
|--------|------------------------------------------------------------------------|--------------------------------------|
| `200`  | `{ matches: true,  recomputed, commit, verdict: "HONEST — …" }`        | the path was committed before the bet|
| `200`  | `{ matches: false, recomputed, commit, verdict: "MISMATCH — …" }`      | the reveal doesn't hash to the commit|
| `400`  | `{ error: "commit must be a 64-char lowercase hex SHA-256 string" }`   | bad/missing input                    |
| `405`  | `{ error: "method not allowed; use POST" }`                            | wrong HTTP verb                      |

> **No-server, no-install option:** `scripts/verify-pro.html` is a single self-contained page that
> runs the same SHA-256 check **client-side** (Web Crypto) — open it in any browser (even offline),
> paste the three values, get HONEST/MISMATCH. The most trust-minimized form: nothing is sent anywhere.

**Pure compute** — no network, no RPC, no key, no rate limit. It cannot time out
or leak. `handle()` is exported and unit-tested (`api-tests/verify-pro.test.ts`,
driven by a real pro-options round).
