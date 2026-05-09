# Product Spec

## Name

Working name: **Wick Markets**

Tagline:

```text
Options for the next candle.
```

## User Problem

Traders often want to express path-dependent views:

- BTC will wick into a level but may not hold it.
- SUI will not touch resistance before expiry.
- Price will sweep liquidity above the high.
- My perp liquidation level may get tagged.
- Volatility is coming, but I do not know final direction.

Prediction markets, perps, and vanilla options do not express these cleanly.

## Product Definition

Wick is a short-dated touch-options layer for Sui prediction and options infrastructure.

Users trade fixed-risk binary claims on whether an oracle-observed price barrier is touched before expiry.

## Initial Contract Type

### Touch / No-Touch

Parameters:

```text
asset: BTC | SUI | APT | ...
direction: ABOVE | BELOW
barrier_price
expiry_ms
collateral_asset
```

Resolution:

```text
TOUCH wins if price crosses the barrier before expiry.
NO_TOUCH wins if expiry arrives without a crossing.
```

Examples:

```text
BTC touches $100,000 before 12:05
SUI touches $3.30 before 14:30
APT touches $9.50 before the next 5-minute candle closes
```

## Later Contract Types

### Range / Breakout

```text
RANGE wins if price stays inside [lower, upper] until expiry.
BREAKOUT wins if price touches either boundary.
```

### First Touch

```text
UP_FIRST wins if upper barrier touches before lower barrier.
DOWN_FIRST wins if lower barrier touches before upper barrier.
```

### Vol Burst

```text
BURST wins if price moves more than X percent before expiry.
CALM wins if it does not.
```

## User Experience

Main actions:

- browse active markets
- create market
- buy TOUCH
- buy NO_TOUCH
- sell/swap position
- redeem winner
- redeem complete sets before settlement

Trader-facing copy should avoid math language. Use market phrases:

- touch
- no touch
- breakout
- range
- wick
- sweep
- max loss
- payout
- time left

## Differentiation

| Product | Wins If | Main Risk |
|---|---|---|
| Prediction market | condition true at expiry | fixed premium |
| Perp | price moves favorably while open | liquidation, funding |
| Vanilla option | price ends beyond strike | fixed premium |
| Wick touch market | price touches barrier before expiry | fixed premium |

Wick is path-dependent. That is the wedge.

## MVP Scope

Must ship:

- Sui Move package for Touch / No-Touch markets
- mock-oracle tests
- market create, trade, settle, redeem flows
- React frontend
- keeper script
- DeepBook Predict testnet display integration

Should not ship in MVP:

- D stablecoin collateral
- Aptos/Decibel adapter
- generic token factory
- leveraged positions
- multi-market vault
- advanced option pricing

