# Wick Markets

> Short-dated **touch / no-touch** options on Sui, settled by an oracle-observed price crossing. Tagline: *Options for the next candle.*

Prediction markets ask where BTC ends. **Wick asks whether BTC wicks into a level.**

| | |
|---|---|
| Network | Sui **testnet** (do not use on mainnet) |
| Package | `0x031ff2b0a394ac4933e90314ca49ce197d5f0690b9f2cd8f22c3abc640c2e7d7` |
| Status  | Hackathon MVP. Working end-to-end (Move + keeper + frontend) on testnet. |
| Surface | Touch / No-Touch only. Range / Breakout / Vol-Burst are post-MVP. |

## What works today

| Layer | What it does | How it's verified |
|---|---|---|
| **Move package** (`move/`) | `create_market`, `buy_touch`, `buy_no_touch`, two-way CPMM swaps, `redeem_complete_set`, `mark_hit`, `settle_expired`, `redeem_winner`, `redeem_lp` | 40 Move tests pass (`sui move test`); collateral invariant asserted after every state mutation; full-conservation property scenario proves the vault drains to exactly 0 once winners + LPs redeem |
| **Keeper bot** (`keeper/`) | Polls every `MarketCreated` event, fetches each market + its oracle, calls `mark_hit` when oracle has crossed and `settle_expired` when past expiry. Permissionless on the Move side. | Ran end-to-end on testnet — auto-settled both a HIT path (oracle moved across barrier) and an EXPIRED path |
| **Multi-actor demo** (`scripts/demo.sh`) | Two real testnet wallets exchange real SUI through the protocol; prints a P&L table that asserts conservation (`bob_payout + alice_lp_claim == seed + bet`) | Both HIT and EXPIRED paths run, conservation holds exactly to the mist |
| **Frontend** (`frontend/`) | Vite + React + Sui dApp Kit. Live-reads markets via `MarketCreated` events; a connected wallet can submit `buy_touch` / `buy_no_touch` PTBs. Falls back to stub data when no live markets exist. | Type-checks clean; dev server up at `http://localhost:5173`; live + stub modes are visually distinguished in the top bar |

## Integrating: SDK + API

**`@wick/sdk`** is the canonical surface for any TypeScript integration.
Frontend, keeper, and API all consume it. Zero React deps; PTB builders
have no signer attached so the SDK works the same in browser, Node, and
service-account contexts. See `sdk/README.md`.

```ts
import { WickClient, buildBuyTx } from "@wick/sdk";

const wick = new WickClient({ sui, deployment });
const markets = await wick.listMarkets({ collateralType: "0x2::sui::SUI" });

const tx = buildBuyTx({
  packageId, collateralType, sender,
  marketId: markets[0].id,
  side: "TOUCH",
  riskMist: 100_000n,
});
// caller signs + executes (dApp Kit, Ed25519Keypair, or CLI)
```

**`@wick/api`** is a Fastify HTTP service for non-TS clients. Read-only
by design — writes are user-side via the SDK. See `api/README.md`.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health`                       | liveness |
| `GET` | `/deployment`                   | full manifest |
| `GET` | `/markets?collateral_type=<T>`  | every market, optionally filtered |
| `GET` | `/markets/:id`                  | single market |
| `GET` | `/positions/:address`           | open Positions + LP shares |
| `GET` | `/oracles`                      | every MockOracle |
| `GET` | `/oracles/by-asset?asset=<key>` | find an oracle by asset key |

## What is stubbed and *would* need to change before mainnet

These are honest, not a list of "future ideas." The protocol is production-shaped, but a few load-bearing components are stubbed for the hackathon demo:

- **`MockOracle`** is a shared object whose `set_price` is **permissionless** (anyone can move the price). This is correct for a hackathon demo — the keeper, the demo script, and the test bench all need to drive the price. **For mainnet, replace `wick::oracle_adapter::MockOracle` with a Pyth (or Switchboard) adapter** that exposes the same `barrier_crossed` / `get_price` API but reads from a real feed. The Move package's call sites do not change — `mark_hit` only depends on `oracle_adapter::barrier_crossed`.
- **The upgrade capability is held by the publisher key alone** (`0xfad7…9455`). On mainnet this should be transferred to a multisig (or burned for an immutable deployment). The package is on `compatible` upgrade policy, so a future upgrade cannot remove or change the signature of any existing public function.
- **The keeper key** (`keeper/.keeper-key.json`) is generated locally and self-funded. The keeper is permissionless — anyone can run their own — but in production you'd run a redundant fleet rather than a single bot.
- **No fee accrual / treasury.** CPMM fees are taken on input and stay in the AMM reserves, where LPs collect them on `redeem_lp`. There is no protocol-level fee or DAO treasury. Add at most a `protocol_fee_bps` field on the `Market` struct + a `treasury` shared object; do not rewrite the AMM.
- **No slippage protection on user-side `buy_touch` / `buy_no_touch`.** The CPMM is small enough that adversarial pre-trades could move the price. Add a `min_position_amount` parameter at the call site before mainnet.

## Conservation invariant — load-bearing

After every state transition in `move/`:

```
ACTIVE   →  collateral_vault == total_touch_supply == total_no_touch_supply
HIT      →  collateral_vault == total_touch_supply
EXPIRED  →  collateral_vault == total_no_touch_supply
```

Proven by `move/tests/invariants.move` (asserted after every step in every other test) and by the `scenario_d_full_conservation_with_lp_claim` scenario (proves the vault drains to exactly 0 after all winners + LP redeem). The `scripts/demo.sh` then proves the same property on testnet with real SUI.

## Repository layout

```
move/            Sui Move package (40 tests pass)
sdk/             @wick/sdk — TS SDK (WickClient + PTB builders)
api/             @wick/api — Fastify HTTP service (read-only)
keeper/          wick-keeper — permissionless TS settlement bot
bots/            wick-bots — personality-driven testnet trading bots (organic activity)
frontend/        Vite + React trading UI
scripts/         Bash deploy + multi-actor demo + market seeder
deployments/     Live testnet manifest + history of upgrades
```

This repo is an **npm workspace**. A single `npm install` from the root installs
all four TS packages (sdk, api, keeper, frontend) with `@mysten/sui` hoisted
once to the root `node_modules`.

## Run it locally

Prerequisites: `sui` CLI configured for testnet, a funded address, Node 22+.

```bash
# 0. install all workspaces
npm install

# 1. publish (or upgrade) the package
./scripts/deploy-testnet.sh

# 2. seed a few demo markets so the UI has live content
./scripts/seed-demo-markets.sh

# 3. run the multi-actor demo (two real wallets, real SUI, conservation P&L)
./scripts/demo.sh --hit       # HIT path (TOUCH wins)
./scripts/demo.sh --expired   # EXPIRED path (NO_TOUCH wins)

# 4. run the keeper (it auto-settles markets when conditions are met)
npm -w wick-keeper run setup-key
# fund the printed address with 0.1 SUI, then:
npm run keeper:watch          # poll forever; or `npm run keeper:tick` for one pass

# 5. run the API (HTTP read endpoints)
npm run dev:api               # serves on http://localhost:8787
curl http://localhost:8787/markets

# 6. run the frontend
npm run dev:frontend          # http://localhost:5173 — connect a Sui wallet

# 7. (optional) spin up the trading bot fleet so the UI shows organic activity
npm run bots:setup            # generate 4 bot keys + auto-fund 0.5 SUI each from the active CLI address
npm run bots:run              # 4 personality bots — bull / bear / contrarian / drunk — ~1 trade/sec
```

## Deploy to Vercel (testnet launch)

The frontend is a static SPA. The repo root has a `vercel.json` that builds
the SDK then the frontend, and serves SPA-style routing.

```bash
# from repo root, with the Vercel CLI installed
npx vercel              # preview
npx vercel --prod       # production
```

Or import the repo in the Vercel dashboard — it picks up `vercel.json`
automatically. The frontend reads its deployment manifest from
`frontend/src/config/deployment.json` (committed to the repo and synced
from `deployments/testnet.json` whenever the Move package is re-deployed).

The API service (`api/`) is a standard Node app — deploy to any Node 22+
host (Fly, Railway, Render, raw VM). See `api/README.md`.

## Threat model

These are the real attack surfaces, not theoretical ones. Each is annotated with what the code does today and what would have to change before mainnet.

| Attack | Where the code defends today | Mainnet hardening |
|---|---|---|
| **Double-payout on the winning side** | `redeem_winner` decrements `total_*_supply` and burns the Position UID, so a re-attempt of the same Position cannot be replayed (the object no longer exists). | No change needed — Sui's object model makes Position-replay impossible. |
| **Losing-side claim** | `redeem_winner` checks `pos.side` against the settled status and aborts with `E_LOSING_SIDE`. Same enum-check inside `redeem_lp` for completeness. | No change. |
| **Settle both ways** | `mark_hit` and `settle_expired` both require `status == ACTIVE` and clear it on success. Idempotent: a second call hits the guard. | No change. |
| **Settle past expiry** | `mark_hit` requires `now < expiry_ms`; `settle_expired` requires `now >= expiry_ms`. Conditions are mutually exclusive. | No change. |
| **Bypass settlement via `redeem_complete_set`** | `redeem_complete_set` requires equal TOUCH and NO_TOUCH amounts. After a swap, no user holds an equal pair (they got either TOUCH-heavy from `buy_touch` or NO_TOUCH-heavy). | No change. |
| **Oracle manipulation** | `MockOracle::set_price` is permissionless. **This is the load-bearing stub.** | Replace `wick::oracle_adapter::MockOracle` with a Pyth adapter. The product definition — "the oracle observed a crossing" — survives the swap unchanged. |
| **Upgrade-cap compromise** | Single-key publisher holds the cap. `compatible` upgrade policy prevents signature changes to existing public functions. | Transfer cap to a multisig, or burn it for immutability. |
| **CPMM front-running** | No slippage check; small reserves could be moved by an adversarial co-buyer. | Add `min_position_amount` parameter to `buy_touch` / `buy_no_touch` before mainnet. |
| **Stranded LP collateral** | `redeem_lp` (added in this branch) lets LPs claim the winning-side reserve after settlement. The losing-side reserve is correctly stranded — it represents zero-value losing claims. | No change for the V1 LP model. Multi-LP `add_lp` is a separate post-MVP feature. |
| **Reentrancy** | Move semantics: `&mut Market<C>` is exclusive within a single tx. There is no callback into user code from the protocol. | No change — Move's borrow checker rules out the EVM-style attack. |

Anything not in this table either (a) doesn't apply to a Sui Move + permissionless-keeper architecture, or (b) is a known stub explicitly called out in the "What is stubbed" section above.

## Sibling workspaces — do not bleed into them

- `/Users/maxmohammadi/aptos-prop-amm` — separate Aptos research workspace. Do not import from there.

See `AGENTS.md` for full agent context including the Darbitex / Desnet / D no-import rule and the MVP scope.
