# Wick Markets — Agent Context

Source of truth for any AI coding agent (Claude Code, Codex CLI, Cursor, Aider, …) working in this repo. Read this before touching any other file.

## What Wick is

Short-dated **touch / no-touch** binary options on oracle-observed price barriers, on Sui, composing with DeepBook Predict.

One-liner: *Prediction markets ask where BTC ends. Wick asks whether BTC wicks into a level.*

Working name: **Wick Markets**. Tagline: *Options for the next candle.*

## Tech stack — pinned, do not propose alternatives

- **`move/`** — Sui Move package
- **`frontend/`** — Vite + React + TypeScript + Sui wallet adapter
- **`keeper/`** — TypeScript keeper bot (poll → `mark_hit` / `settle_expired`)
- **`scripts/`** — bash deploy and smoke-test scripts

## MVP scope — Touch / No-Touch only

Do **not** write code for any of these unless the user explicitly says we're past MVP:

- Range / Breakout
- First Touch
- Vol Burst
- D stablecoin collateral
- Aptos / Decibel adapter (lives in `/Users/maxmohammadi/aptos-prop-amm`, not here)
- Generic token factory
- Leveraged positions
- Multi-market vault
- Advanced option pricing models

If a task seems to require any of the above, stop and ask.

## The collateral invariant — load-bearing

After every state transition in `move/`:

```
collateral_vault == total_touch_supply == total_no_touch_supply
```

Any function that mutates supplies or the vault must preserve this. The invariant test suite (`move/tests/invariants.move`) must pass before any commit. Bugs here are direct loss-of-funds.

## Safety properties the Move package must enforce

- A market cannot settle both ways (HIT and EXPIRED are mutually exclusive)
- Settlement is idempotent — repeat calls are no-ops or revert, never re-mutate
- Repeated `redeem_winner` cannot double-pay
- Losing side cannot redeem
- `redeem_complete_set` cannot bypass settlement rules

## Object model — architectural decision, do not change without discussion

Use **dynamic Sui objects**, not a new `Coin<T>` per market.

- `Market<phantom C>` — `key`-only, holds `Balance<C>` collateral vault, AMM reserves, supply totals, status
- `Position` — `key, store`, points at a market by `ID`, has `side` and `amount`
- `LpPosition` — `key, store`, points at a market by `ID`, has `shares`

See `docs/architecture.md` for full struct definitions.

## Lifecycle

```
create → trade ↔ swap ↔ redeem_complete_set → (mark_hit | settle_expired) → redeem_winner
```

Touch is **oracle-observed**. The product definition is "price as observed by the oracle crossed the barrier" — not "any off-chain exchange tick." This must be honest in the README, the UI, and the threat model.

## Darbitex / Desnet / D — reference only, never imported

**Do not import or vendor** these repos into `sui-options`. They are reference patterns:

- **Desnet** — paired-claim collateral accounting (idea, not code)
- **Darbitex Sui AMM** — Sui object patterns, integer CPMM math (idea, not code)
- **D** — immutable Sui/Aptos deploy pattern (idea, not code, post-MVP)

If a familiar pattern from one of them comes to mind, transcribe the *idea* and rewrite cleanly for Wick. Add a brief comment explaining the choice. See `docs/darbitex-boundary.md`.

## Trader-facing copy

Avoid math language. Use market phrases: *touch, no touch, breakout, range, wick, sweep, max loss, payout, time left.*

## Verification gate — required before any commit

Run from the repo root:

```bash
./scripts/agent-preflight.sh
```

It checks branch, worktree, `sui move test`, frontend `tsc --noEmit`, keeper `tsc --noEmit`. **Do not commit if preflight fails.** Period.

## Sibling workspaces — do not bleed into them

- `/Users/maxmohammadi/aptos-prop-amm` — separate Aptos research workspace (Decibel, D, Aptos AMM patterns)

## Hackathon notes

- Demo on Sui **testnet**, never mainnet
- Use DeepBook Predict testnet for live BTC/SUI/APT prices and sensible barrier defaults
- Demo script: `docs/hackathon-plan.md` § Demo Script — keep it runnable end-to-end at all times
- Day-by-day milestones: `docs/hackathon-plan.md`
- Granular agent-sized tasks: `TASKS.md`
