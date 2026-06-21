# Wick Pro — the 60-second judge demo

The sui-options submission is **Wick Pro**: one-tap Black-Scholes options on a
**live DeepBook mark**, with a **live P&L that equals settlement to the cent**.
This is the runbook for the demo. It is verified green on production.

## Open it

**[wick-markets.vercel.app/pro](https://wick-markets.vercel.app/pro)** — best on a phone. No wallet, no sign-in, no faucet. It plays immediately.

## The 60 seconds

1. **"This is the real SUI price."** Top-left shows the live **DeepBook mid**
   (SUI/USDC) and **σ N%** — the realized vol from the live trade tape. The
   green dot reads `DeepBook live`. Premiums are priced with Black-Scholes off
   this real mark, not a synthetic feed.
2. **Tap UP (or DOWN).** A call (or put) opens at-the-money. The buttons flip
   to **CLOSE / FLIP** — never UP/DOWN while you hold a position.
3. **"Watch the P&L."** One big number glides at **60fps** off the real mid as
   it moves. Green up, red down, with the % return.
4. **Tap CLOSE.** You bank **exactly the number that was on screen** — the live
   read and the settlement are the same formula on the same inputs.
   - Or **let it ride to 60s**: it auto-settles to the same live number you
     were watching. (Or tap **FLIP** to reverse your bet in one tap.)
5. **"The coach is reading the real tape."** The CandleVision pattern panel
   (bottom-right) detects setups — Marubozu, Engulfing, Piercing Line — on the
   same live DeepBook candles, with LONG/SHORT/confidence.

## The one-line pitch

> Most prediction/options games show a **fake** "live P&L" — a heuristic that
> doesn't match what you're actually paid. Wick Pro's live P&L **is** the
> settlement: same Black-Scholes mark-to-close, same inputs, proven byte-exact
> in CI. What you watch is what you get.

## Certify it's live (anytime, ~5s, no browser)

```bash
npm run smoke:demo     # routes 200 · faucets alive · DeepBook mark reachable
```

The live==settlement guarantee is locked by conformance tests in
`packages/pro-options` (`npm run test:pro-options`): `settlementPnlAtSpot` and
`engine.livePnl(atExpiry)` are asserted equal to the realized settlement at
every spot, both sides, ITM/OTM.

## Notes

- The provably-fair, commit–reveal **synthetic** variant lives at
  [`/pro-sim`](https://wick-markets.vercel.app/pro-sim) (no network dependency —
  a reliable fallback if the DeepBook indexer is ever unreachable).
- Verified end-to-end on the production deploy (headless, iPhone viewport):
  live mark + σ, UP/DOWN→CLOSE/FLIP button states, 60fps glide, CLOSE banks the
  on-screen number, full 60s auto-settle matches the last live value, coach
  renders, SUI↔DEEP pool switch, rapid FLIP — all green, zero console errors.
