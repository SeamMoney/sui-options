# Demo-day operations runbook

How to keep the **live testnet demo green** while judges are evaluating. This is
the operational complement to `v4.26_deploy_runbook.md` (which covers *deploying*).
Everything here is read-only monitoring plus two recovery actions; no redeploys.

Addresses are authoritative in `deployments/testnet.json` — read them from there,
not from this file (it can lag a redeploy). The live rug market and the faucet
wallet are surfaced by the health commands below.

---

## 1. Pre-judging checklist (run once, cold)

```bash
npm run judge          # 7/7 provable-fairness proofs (~30s) — the headline
npm run check:all      # full demo-health gate (~3-4 min) — site, routes, P&L,
                       #   fairness, rug honesty, DeepBook, vault, chart, faucet
npm run smoke:ride     # live end-to-end: fund a burner → play → settle → verify
```

All three green ⇒ the demo is judge-ready. `npm run rides:recent` prints one
closed ride of each outcome with a paste-ready `audit:ride` command, so a judge
can audit any settlement (touch win / cashout / MARKET HALT / expiry) themselves.

---

## 2. Continuous monitoring (during judging)

Two silent-failure probes — a frozen chart and a drained faucet both leave the
site *up* (so `smoke:demo` stays green) while the demo is actually broken:

```bash
npm run check:chart-live      # the /ride chart is MOVING (head segment fresh)
npm run check:faucet-runway   # the faucet wallet can still fund judges
```

Both are also wired into `check:all`. Exit 0 = healthy; exit 1 = act (below).

---

## 3. Failure responses

### Chart FROZEN — `check:chart-live` fails ("chart FROZEN")
The cranker (chart-keeper) stopped, so judges see a flatlined `/ride` chart.
Restart the supervisor (it self-heals and restarts the sentinel on crash):

```bash
export WICK_FAUCET_PRIVATE_KEY=suiprivkey1...   # or rely on the active CLI key
npm run chart:keep
```

Burn rate ≈ 30 SUI/hour (always-active sentinel). Ctrl+C stops it cleanly
(it closes its in-flight ride first). Re-run `check:chart-live` to confirm the
head segment is fresh again.

### Faucet LOW — `check:faucet-runway` fails ("faucet LOW")
The faucet wallet (the TUSD `TreasuryCap` owner — the failure message prints its
address) is low on SUI; the next judge gets a 503 at "Get free funds". Send SUI
to that wallet. TUSD itself is minted on demand (no balance limit); only the SUI
gas runs down. Each `/api/faucet` drip is 2 SUI, and the always-active sentinel
(if running) also burns from this wallet — so keep a comfortable buffer.

### Site DOWN — `npm run smoke:demo` fails
The static site failed to load — a Vercel deploy issue, not on-chain. Check the
latest Vercel deployment for `wick-markets`; the on-chain state is unaffected.

---

## 4. Notes

- **RPC**: all clients default to PublicNode and fall back to the Mysten
  fullnode; the health probes have a 20s per-call timeout, so a stuck endpoint
  surfaces as a clear failure rather than a hang.
- **Audits are version-robust**: the verifiers derive each market's type-origin
  package from the market object, so a package upgrade (e.g. v4.26 `0x1fdf`)
  doesn't break `audit:ride` / `rides:recent`.
- **Don't compute house edge from live history** — it's polluted by autoplay /
  smoke rides. The house edge is proven by the per-round rug audit
  (`npm run check:rugs`) and the calibration sims, not by realized outcomes.
- **`check:rugs` is thorough, not fast.** It cryptographically audits *every*
  round (no FAKED and no SUPPRESSED halt), so its runtime scales with the round
  count (~1-2s/round → several minutes on a long-lived market). It prints
  progress round-by-round, so a long run is working, not hung. For a quick
  spot-check, bound it: `npm run check:rugs -- --max-rounds 50` audits the most
  recent 50 rounds. `check:all` includes the full (unbounded) sweep, so budget a
  few minutes for it on a mature market.
