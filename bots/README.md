# wick-bots — testnet trading bots

> ⚠️ **LEGACY — does not run against the current package.** These bots drive the
> retired **v1 touch/no-touch *trade*** model (`wick::create_market`, `buy`,
> `swap`), which no longer exists on-chain. `npm run bots:run` will fail at
> submit time (no such entry function). To animate the **live v4** chart for a
> demo, use `npm run chart:keep` (the supervised v4 sentinel) instead. Kept for
> reference / a future rewrite onto the segment-ride model.

Personality-driven bots that create organic-looking activity on Wick markets.
Each bot is its own keypair with its own bias; together they buy, swap, and
periodically open fresh markets, while the keeper bot settles the markets when
they hit or expire.

The bots are **not** market participants in any economic sense — they're a
testnet stress / demo harness. Don't run them on mainnet.

## Roster

| Personality | Trades | Creates | Bias |
|---|---|---|---|
| `bull`       | TOUCH always                     | yes (TOUCH ABOVE markets) | leans long |
| `bear`       | NO_TOUCH always                  | yes (TOUCH BELOW markets) | leans short |
| `contrarian` | side with the larger reserve     | no                        | fades the crowd |
| `drunk`      | random coin flip                 | no                        | adds noise |

## Run it

```bash
# from repo root, after `npm install`:

# 0. make sure your sui CLI is on testnet and your *active* address is the
#    one you want to fund the bots from (the deployer / alice typically).
sui client switch --env testnet
sui client active-address
sui client gas    # confirm there's at least 2.5 SUI to spread across 4 bots

# 1. generate keys + auto-fund 0.5 SUI per bot from the active CLI address.
npm run bots:setup

# 2. one-shot tick (each bot does one pass and exits) — quick smoke test.
npm run bots:tick

# 3. long-running fleet — 4 bots, ~1 trade/second aggregate.
npm run bots:run
```

While running, separately run the keeper so settlements actually land:

```bash
npm run keeper:watch
```

## Tuning

All knobs are env vars, read by `bots/src/config.ts`:

| Var | Default | What |
|---|---|---|
| `WICK_BOTS_POLL_MS`        | `4000`        | per-bot wait between actions |
| `WICK_BOTS_JITTER_MS`      | `2000`        | ± jitter on the wait — keeps it un-robotic |
| `WICK_BOTS_RISK_MIN`       | `30000` mist  | min risk per trade |
| `WICK_BOTS_RISK_MAX`       | `120000` mist | max risk per trade (also clipped at 25% of the smaller AMM reserve) |
| `WICK_BOTS_GAS_BUDGET`     | `100000000` mist | gas budget per tx |
| `WICK_BOTS_FUND_PER_BOT`   | `500000000` mist (0.5 SUI) | initial top-up per bot |
| `WICK_BOTS_FUND_FLOOR`     | `50000000` mist (0.05 SUI) | refund threshold when calling `bots:fund` |
| `WICK_BOTS_CREATE_EVERY`   | `25`          | a creator-personality bot opens a fresh market every N ticks |
| `WICK_BOTS_EXPIRY_MIN_S`   | `240`         | min market expiry offset (4 min) |
| `WICK_BOTS_EXPIRY_MAX_S`   | `1800`        | max market expiry offset (30 min) |
| `WICK_BOTS_SEED_MIN`       | `200000` mist | min seed collateral when creating markets |
| `WICK_BOTS_SEED_MAX`       | `500000` mist | max seed collateral |
| `WICK_BOTS_FEE_BPS`        | `30`          | CPMM fee for newly created markets |
| `WICK_BOTS_KEY_DIR`        | `bots/.bot-keys` | where keypairs live (gitignored) |

To target ~1 aggregate trade/second with 4 bots, leave defaults
(`POLL=4000ms`, `JITTER=±2000ms` → each bot fires every 2–6s). Bump
`POLL_MS` for a slower demo.

## Top up later

```bash
npm run bots:balances     # see who's running low
npm run bots:fund         # send fresh SUI from active CLI address to any bot below floor
```

## Key safety

`bots/.bot-keys/` is gitignored. These are throwaway testnet keys; if you
nuke the directory you lose access to the SUI in those bots. That's fine —
generate fresh ones with `bots:setup`.
