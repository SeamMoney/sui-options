# Wick Markets — 60-second judge guide

**The submission is Wick Pro:** one-tap Black-Scholes options priced off a **live DeepBook mark**.
Everything below is live on testnet — no install, no wallet needed to play.

> Quick health check: `npm run smoke:demo` (curl-only, ~5s) confirms the live demo is green.

---

## ▶ The 60-second path — [wick-markets.vercel.app/pro](https://wick-markets.vercel.app/pro)

1. **Open `/pro` on a phone.** The header shows a live price + `● DEEPBOOK LIVE` and a `σ` — that's
   the real DeepBook **SUI/USDC** mid (toggle **DEEP** for DEEP/USDC) with volatility computed from
   the live trade tape. The chart is seeded with real DeepBook candle history.
2. **Tap ▲ UP or ▼ DOWN.** You've bought a 60-second at-the-money call/put. The premium and the
   `±%` to win come from a real Black-Scholes engine (`@sui-options/pro-options`) using that live mid
   and σ.
3. **Watch the one big P&L.** It updates off the real DeepBook mid every tick (value **and** %). The
   `CLOSE` button always shows the same number — what you watch is what you get.
4. **CLOSE, or let it auto-settle at 60s.** The settled result equals the last live P&L you saw —
   **settlement-consistent pricing** (the live mark and settlement use the same formula + inputs).
5. A **CandleVision pattern coach** reads the same live tape and calls setups (Marubozu, doji, …) as
   they form.

**Why it's credible:** real options math · real on-chain CLOB price (DeepBook v3 indexer mid) · honest
live σ · settlement-consistent P&L · mobile-first. Not "trust us" — the price is a real market.

---

## Also worth a look

- **[/coach](https://wick-markets.vercel.app/coach)** — the CandleVision pattern coach standalone, on
  the live SUI/USDC DeepBook mark, beside a live Black-Scholes quote (CALL/PUT premium + Δ).
- **[/ride](https://wick-markets.vercel.app/ride)** — the original tap-hold touch/no-touch game.
  Real **on-chain** rides: one-tap faucet (free testnet SUI + TUSD, no wallet) → hold the chart →
  segments recorded on-chain from `sui::random`.
- **[/verify](https://wick-markets.vercel.app/verify)** — replay any closed ride live in your browser
  from its on-chain keys; toggle **"dishonest house"** to watch the verifier catch a tampered candle.
  Or one command: `npx tsx scripts/verify.ts --market <id> --ride <id>`.

## Proof points

- **DeepBook v3 mark** the options price against: `npm run check:deepbook` (live mid + σ → BS premium).
- **Move package** (v4.26, testnet): [`0x1fdf78474…815924` on Suiscan](https://suiscan.xyz/testnet/object/0x1fdf784743d82c000e84154506e21daedc45bf241818fef6b28635e99e815924).
- **553/553 Move tests** (incl. 10k seeded-path conformance vectors, TS↔Move byte-identical, enforced in CI).

> Honest scope: `/pro` settles client-side against the live DeepBook mark (no wallet, instant) — the
> on-chain pieces are the DeepBook price it reads, the `/ride` rides, and the `sui::random` fairness
> that `/verify` proves. We don't claim on-chain option settlement (that's the v3 roadmap).
