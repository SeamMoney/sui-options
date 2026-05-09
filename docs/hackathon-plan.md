# Sui Hackathon Plan

## Goal

Submit Wick Markets as a Sui DeFi hackathon project: a touch-options app composing with DeepBook Predict testnet market/oracle infrastructure.

## Judging Narrative

Wick is not another prediction market. It is a path-dependent options layer.

DeepBook Predict gives Sui binary and options primitives around final price. Wick adds a product traders already understand from real markets: touch/no-touch barriers.

The demo should make this obvious in one sentence:

```text
Prediction markets ask where BTC ends. Wick asks whether BTC wicks into a level.
```

## Build Priorities

1. Correct market lifecycle.
2. Clear frontend demo.
3. Real Sui testnet transactions.
4. Honest oracle story.
5. Good tests and threat model.

## Milestones

### Day 1: Core Move Model

- Create Sui Move package.
- Define market, position, LP position, status enums.
- Implement market creation with seed collateral.
- Implement mock oracle adapter.
- Add tests for create and invalid parameters.

### Day 2: Trading And Settlement

- Implement paired claim minting.
- Implement `buy_touch` and `buy_no_touch`.
- Implement CPMM swap between sides.
- Implement complete-set redemption.
- Implement `mark_hit`, `settle_expired`, and `redeem_winner`.
- Add invariant tests.

### Day 3: Frontend And Keeper

- Scaffold Vite React app.
- Build Markets, Trade, Create, Portfolio pages.
- Add Sui wallet integration.
- Build keeper script that watches price data and submits `mark_hit`.
- Add local/testnet smoke script.

### Day 4: DeepBook Predict Integration And Polish

- Read active DeepBook Predict testnet markets/prices for display.
- Wire market creation defaults around live BTC/SUI prices.
- Record demo.
- Write README, pitch, and threat model.
- Run final tests.

## Demo Script

1. Open app on Markets page.
2. Show BTC live price and active DeepBook Predict context.
3. Create a market: `BTC touches +0.5% in 5 minutes`.
4. Buy TOUCH.
5. Buy NO_TOUCH from another wallet or simulated account.
6. Show AMM price update.
7. Keeper marks hit if crossed, otherwise settle after expiry.
8. Redeem winning position.

## MVP Acceptance Criteria

- A user can create a touch market on Sui testnet.
- A user can buy either side.
- The market price moves after trades.
- Settlement resolves exactly one side.
- Winners can redeem collateral.
- Tests prove the collateral/supply invariant is preserved.
- README explains oracle limitations clearly.

## Risks

### Oracle Observation Risk

A market only recognizes touches seen by the oracle/indexed stream.

Mitigation:

- Define touch as oracle-observed.
- Show this in UI and README.
- Use short settlement windows and keeper monitoring.

### Keeper Failure

If no one calls `mark_hit`, a touched market may not settle correctly.

Mitigation:

- Keeper script for demo.
- Permissionless `mark_hit`.
- Later: indexer-backed proof or oracle history verification.

### Liquidity Fragmentation

Every barrier and expiry creates a new market.

Mitigation:

- MVP uses curated expiries and default barrier presets.
- Later, create LP vaults for common strikes.

### Adverse Selection

LPs selling near-barrier risk can be picked off.

Mitigation:

- Fees.
- Minimum barrier distance at creation.
- Limited expiries.
- Later, dynamic pricing or vault risk limits.

