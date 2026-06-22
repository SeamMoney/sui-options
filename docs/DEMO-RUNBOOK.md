# Wick — presenter runbook (live demo / video recording)

A tight, sequenced script for *demoing* Wick (DEMO.md is the judge's self-serve
guide; this is for the person at the keyboard). Target: **~3 minutes**. Every
URL and command below is verified working. Have two things open before you start:
a phone-sized browser on **`/pro`** and a terminal in the repo.

> **Pre-flight (30s before, off-camera):** `npm run smoke:demo` → "demo is live & green".
> If it isn't, see *Fallbacks* — you can run the entire fairness story offline.

---

## Act 1 — the hook (45s) · `wick-markets.vercel.app/pro`

1. Open **`/pro`** on a phone frame. Point at the header: **`● DEEPBOOK LIVE`**, the
   live price, and the **σ**. Say: *"This price is a real on-chain DeepBook v3 mid,
   not a mock — volatility computed from the live trade tape."*
2. Tap **▲ UP**. One big **P&L** number starts ticking off the real mid. Say:
   *"I just bought a 60-second at-the-money call, priced by a real Black-Scholes
   engine. The number I'm watching is the number I'll be paid."*
3. Tap **CLOSE** (or let it auto-settle). The settled figure equals the last live
   number. Say: *"Settlement-consistent — watch == paid, by construction."*
4. Toggle **BTC** (XBTC/USDC ~$64k) to show it's multi-asset and really live.

## Act 2 — the depth (45s) · `/coach`

5. Open **`/coach`** — the live DeepBook desk: the **CandleVision** pattern coach,
   a Black-Scholes quote (Δ, break-even, payoff hockey-stick), and the **real
   order book** (resting bids/asks, depth, 24h volume, streaming fills).
   Say: *"The CLOB it marks against, laid bare — click the pair to open the actual
   pool on Suiscan."*

## Act 3 — the proof: trust nothing (60s)

This is the differentiator. Pick **one** of these — both are bulletproof:

- **On-chain ride** · `/verify` — replay a closed ride from its on-chain keys;
  flip **"dishonest house"** and watch the verifier catch a tampered candle. Then
  in the terminal: `npm run verify:fairness` (honest PASS) · `:tamper` (caught).
- **/pro round, in the judge's own browser** — terminal: `npm run play -- --seed 4242`
  prints `{ commit, seed, paramsJson }`. Open **`scripts/verify-pro.html`**, paste
  the three values → **HONEST ✓**. Say: *"That SHA-256 ran in your browser. No
  server, no trust — the price path was committed before the bet."*

**The one-liner that proves everything:** `npm run judge` → **PASS — 7/7**
(live demo · ride fairness honest+tamper+rug · live P&L==settlement · /pro
commit-reveal honest+forged-caught), ~20s, no wallet, no browser.

## Act 4 — the close (15s)

Say: *"Real options math, a real on-chain CLOB price, provable fairness on both
games, and a vault that's solvent on testnet right now — all checkable without
trusting us. Options for the next candle."*

---

## Fallbacks (if something hiccups on camera)

| If… | Do this |
|---|---|
| DeepBook feed is slow / `/pro` chart sparse | switch asset (SUI↔BTC↔DEEP); the seeded history still renders. Or pivot to Act 3 (offline proofs). |
| A route shows a crash screen | known stale-deploy issue on mistyped/extra paths — use the exact URLs above (`/pro`, `/coach`, `/ride`, `/verify`); they work. |
| No network at all | the whole fairness story runs offline: `npm run verify:offline`, `npm run play -- --seed 4242` + `scripts/verify-pro.html`. |
| Faucet rate-limited (90s/recipient) | wait, or use a fresh address; `npm run smoke:ride` mints its own burner. |

## Links to have ready
- Play: `wick-markets.vercel.app/pro` · Desk: `/coach` · Ride: `/ride` · Verify: `/verify`
- Package (v4.26): [`0x1fdf7847…815924`](https://suiscan.xyz/testnet/object/0x1fdf784743d82c000e84154506e21daedc45bf241818fef6b28635e99e815924)
