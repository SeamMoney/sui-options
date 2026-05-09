# Darbitex Boundary

## What Darbitex Has To Do With Wick

Darbitex does not define the product.

The product is driven by Sui hackathon constraints and DeepBook Predict:

```text
Touch options on objective price markets.
```

Darbitex is useful only as prior art and reference material.

## Relevant Reference Patterns

### Desnet Opinion Markets

Useful:

- paired claim minting
- collateral vault
- complete-set redemption
- `x*y=k` market between two claim sides
- invariant-first design

Not useful for Wick:

- no expiry
- no objective settlement
- no oracle
- social-token-denominated collateral
- perpetual opinion semantics

Wick should not copy Desnet's product behavior.

### Darbitex Sui AMM

Useful:

- Sui object design
- pool events
- LP position object pattern
- integer CPMM math
- warning/disclosure style

Not useful for Wick:

- generic token-token AMM as the product
- flash loan routing
- normal spot liquidity pools

### D Stablecoin

Useful:

- example of Sui/Aptos cross-chain product discipline
- immutable package deployment pattern
- audit/tracking structure

Not useful for MVP:

- D collateral
- CDP troves
- stability pool integration

## Rule

Do not import or vendor Darbitex repos into `sui-options`.

If a pattern is used, rewrite cleanly for Wick and document the reason.

