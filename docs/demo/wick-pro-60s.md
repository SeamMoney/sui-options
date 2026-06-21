# Wick Pro — the 60-second judge demo

The sui-options submission is **Wick Pro**: one-tap Black-Scholes options on a
**live DeepBook mark**, with a **live P&L that equals settlement to the cent**.
This is the runbook for the demo. It is verified green on production.

## Open it

**[wick-markets.vercel.app/pro](https://wick-markets.vercel.app/pro)** — best on a phone (a tidy centered frame on desktop). No wallet, no sign-in, no faucet. It plays immediately.

Deep-link straight to an asset: **`/pro?asset=XBTC_USDC`** (Bitcoin), `?asset=SUI_USDC`, `?asset=DEEP_USDC`. The selected asset is written to the URL, so it's shareable and survives a refresh.

## The 60 seconds

1. **"This is a real on-chain price."** Top-left shows the live **DeepBook mid**
   for the chosen pool (**SUI / BTC / DEEP**, switchable up top) and **σ N%** —
   realized vol from the live trade tape. The green dot reads `DeepBook live`;
   the pair label (e.g. `SUI/USDC ↗`) links to the real pool on Suiscan. The
   price flashes green/red on each tick. Premiums are Black-Scholes off this
   real mark, not a synthetic feed.
2. **Tap UP (or DOWN).** A call (or put) opens at-the-money. The buttons flip
   to **CLOSE / FLIP** — never UP/DOWN while you hold a position. An entry
   marker drops on the chart; on a phone you feel a haptic tap.
3. **"Watch the P&L."** One big number glides at **60fps** off the real mid as
   it moves — green up, red down, with the % return. The timer reddens and
   pulses in the final 5 seconds.
4. **Tap CLOSE.** You bank **exactly the number that was on screen** — the live
   read and the settlement are the same formula on the same inputs.
   - Or **let it ride to 60s**: it auto-settles to the same live number you
     were watching, with a celebratory flash + pop on a win. (Or tap **FLIP**
     to reverse your bet in one tap — your current leg is booked, not lost.)
   - A running **session P&L** (e.g. `+$0.37 · 1W/0L`) shows the loop adding up.
5. **"The coach is reading the real tape."** The CandleVision pattern panel
   (bottom-left) detects setups — Marubozu, Engulfing, Piercing Line — on the
   same live DeepBook candles, with LONG/SHORT/confidence. Tap `DeepBook live`
   to open the full **/coach** order-book desk (keeps your asset).

## The one-line pitch

> Most prediction/options games show a **fake** "live P&L" — a heuristic that
> doesn't match what you're actually paid. Wick Pro's live P&L **is** the
> settlement: same Black-Scholes mark-to-close, same inputs, proven byte-exact
> in CI. What you watch is what you get.

## Certify it's live (anytime, ~5s, no browser)

```bash
npm run smoke:demo     # routes 200 · faucets alive · DeepBook mark reachable (curl, ~5s)
npm run verify:pro     # proves "what you watch == what you're paid" on LIVE DeepBook data
npm run check:pro      # drives the real /pro flow headless: mark live, UP/DOWN→CLOSE/FLIP,
                       #   live==settlement, no console errors (needs Chromium)
```

`verify:pro` pulls the **real DeepBook mark + realized σ**, opens real
Black-Scholes calls/puts, and asserts the **watched** live P&L (`unrealizedPnl`)
equals the **paid** settlement (`sellToClose`) across a sweep of exit prices ×
exit times — to `1e-9`, every time. It's the Wick Pro analogue of
`scripts/verify.ts` (which proves the Ride game's provable fairness). The
guarantee is also locked deterministically by conformance tests in
`packages/pro-options` (`npm run test:pro-options`): `settlementPnlAtSpot` and
`engine.livePnl(atExpiry)` equal the realized settlement at every spot, both
sides, ITM/OTM.

## Notes

- The provably-fair, commit–reveal **synthetic** variant lives at
  [`/pro-sim`](https://wick-markets.vercel.app/pro-sim) (no network dependency —
  a reliable fallback if the DeepBook indexer is ever unreachable).
- Verified end-to-end on the production deploy (headless, iPhone viewport):
  live mark + σ, UP/DOWN→CLOSE/FLIP button states, 60fps glide, CLOSE banks the
  on-screen number, full 60s auto-settle matches the last live value, FLIP books
  the leg, coach renders, all 3 pools (SUI/BTC/DEEP) with exact match, rapid
  FLIP, desktop centered, `?asset=` refresh-stable — all green, zero console
  errors.
