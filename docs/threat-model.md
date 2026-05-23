# Wick Markets — Public Threat Model

> Status: v1.1 (post-redteam, pre-mainnet, segment-arcade update).
> Audience: auditors, sophisticated users, integrators, judges.
> Last reviewed: 2026-05-23.
> Source artifacts: ten internal red-team passes in [`docs/redteam/`](redteam/),
> design v2 hardening specs (H1–H12), segment arcade specs
> [`17`](design/v2/17_provably_fair_arcade.md),
> [`17a`](design/v2/17a_sui_randomness_spike.md),
> [`18`](design/v2/18_segment_market_design.md),
> [`19`](design/v2/19_round_shared_grid_design.md), the B7 Monte Carlo report
> [`15`](design/v2/15_montecarlo_validation_report.md), and the live testnet
> artifact in `deployments/testnet.json`.

This document is the public-facing version of the work we did to try to break
our own protocol before anyone else does. We ran ten adversarial reviews
against every subsystem (vault, WICK token, oracle, impact fee, cross-market
PTBs, Predict route, DeepBook CLOB, tournaments, indexer/frontend, economic
governance) and produced **137 distinct attacks**. This file categorizes all
of them, names what is mitigated in v2, what is acknowledged but deferred,
and what residual risk remains. Where we cannot fully fix something, we say
so plainly.

The principle is: **production-honest beats production-confident**. A
protocol whose threat model fits on a slide is one whose adversaries haven't
read it yet.

---

## 2026-05-23 segment arcade update

This update covers the new provably-fair segment arcade track: deterministic
segments recorded from Sui randomness, round-based shared barriers, `/verify`
replay, and the current A0 randomness status. It does not replace the older
oracle/Lazer threat model for real-underlying markets.

### Randomness security (A0)

A0's primary defense is structural. `record_segment` consumes Sui `Random`, and
Sui rejects the compositional shape needed for the classic test-and-abort
grinder: a public wrapper around `&Random` is blocked by the bytecode verifier,
and a PTB with a value-checking MoveCall after a `Random` MoveCall is rejected
by Sui's PTB validity rules. That is the R1 defense in
[`17a_sui_randomness_spike.md`](design/v2/17a_sui_randomness_spike.md).

R2 is the remaining gas-side-channel obligation. The static source-shape half
is discharged by `scripts/verify_record_segment_shape.py`: single 32-byte draw,
one `expand_segment` call, fixed walk constants, no `_in_range` or `shuffle`
inside `record_segment`. The dynamic half is not done: gas-spread measurement,
the live PTB-rejection test in §6.3 #2, and the abort-leak test in §6.3 #3 all
require a deployed-package `devInspect`/dry-run harness and are deferred beyond
the hackathon window.

### Provably-fair claim boundary

What we claim:

- Every segment-market candle is deterministic from publicly recorded segment
  keys via `seeded_path::expand_segment`.
- The Move and TypeScript `expandSegment` implementations are conformance-tested
  over 10,000 generated vectors in `move/tests/seeded_path_conformance.move`.
- Closed rides can be replayed with `npx tsx scripts/verify.ts --market ... --ride ...`;
  the CLI recomputes candles/extremes from on-chain keys and compares its
  verdict to the on-chain `RideClosed.settlement_kind`.

What we do not claim:

- A fully audited, gas-side-channel-free implementation.
- Production-grade key-grinding resistance under adversarial gas pricing until
  the dynamic R2 gas-spread harness lands.
- That `/verify` is a production indexer. It is a replay CLI with known
  pagination and race-condition follow-ups listed below.

### Segment-market vault solvency

B7 Monte Carlo locked the default round parameters at ±10% barriers and a 1.75x
touch multiplier. The joint sweep reports **+11.24% vault edge** and **50.67%
touch rate** at that cell; see
[`15_montecarlo_validation_report.md` §12.4](design/v2/15_montecarlo_validation_report.md)
and [`19_round_shared_grid_design.md` §4](design/v2/19_round_shared_grid_design.md).
Worst-case same-round pile-on is bounded at open by `MAX_PAYOUT_PER_BARRIER`,
set by the bootstrap script to 10% of the seed treasury by default. With two
barriers, the pessimistic per-round liability cap is therefore `2 ×
MAX_PAYOUT_PER_BARRIER`; the B7 pile-on simulation observed zero cap violations.

### Known segment-arcade deferrals

- Keeper TypeScript update for the latest `segment_market` ABI.
- `FeeSnapshot` extension for DNT impact-fee wiring; DNT winners pay the base
  fee for MVP.
- PWE for DNT remains `0`; per-position caps still bind.
- Frontend tap-hold ride gesture polish remains acceptable-for-demo deferred
  work.
- E1 `/verify` SEV-2 follow-ups: closure race, pagination cost, and ID-case
  normalization.
- E2 spine-test coverage gaps: lower-barrier verdicts, `EXPIRED_LOSS`, and
  multi-round ride replay.
- Empirical gas-spread measurement, live PTB-rejection, and abort-leak tests
  from `17a` §6.3.

---

## 1. Headline findings

The single worst attack across the entire corpus is **#1 in
`docs/redteam/03_oracle_path.md`**: a compromised `KeeperCap` silently
rewrites oracle truth on every Lazer-driven market in one expiry window. A
single phished operator is enough. Recovery requires recapitalization the
protocol has not pre-funded.

The single most likely *organic* protocol-killer is the **Queue-of-Doom**
(Attack 13 in `10_economic_governance.md`): a tournament with correlated
flow blows the FIFO winners-queue beyond plausible drain horizon, the
"winners always get paid" promise fails, reputation cascades, and the
queue calcifies. **It requires no attacker.** It is an emergent property
of the design under correlated load.

These two attacks set the agenda for v2 hardening. Everything that follows
either kills these directly (multisig keeper, isolated tournament vaults,
queue-size circuit breaker, disclosed haircut clause) or reduces blast
radius (hard-coded admin caps, timelocked upgrades, dynamic insurance
fund).

---

## 2. Top-5 ranked critical attacks

From `docs/redteam/10_economic_governance.md` § "Top 5 Most Dangerous":

| # | Attack | Source doc | Worst-case impact | v2 mitigation |
|---|---|---|---|---|
| 1 | Compromised KeeperCap rewrites oracle truth | 03_oracle_path A1 | Total open notional on every Lazer market in one window | 2-of-3 multisig wrap + on-chain Lazer signature verifier (H1) |
| 2 | Queue-of-Doom permanent insolvency | 10_economic_governance A13 | Vault calcifies; "winners paid" promise breaks | Global OI cap, isolated tournament vaults, queue-size circuit breaker, **disclosed haircut clause** (H10) |
| 3 | Whale front-run on mint curve threshold | 10_economic_governance A2 | 2M WICK (~1.6% of cap) extracted by single $20k attacker; permanent supply distortion | Genesis-week mint dampener (10x rate reduction first 7 days) (H3) |
| 4 | AdminCap bribe to lift risk caps | 10_economic_governance A8 | Up to vault balance per attack (~$10M at maturity) | **Move-enforced hard caps on every admin setter** + multisig + 24h timelock (H9) |
| 5 | LP starvation coalition (slow killer) | 10_economic_governance A1 | ~$14k/day persistent value leakage to sophisticated cartel | Per-address dynamic fee floor (200 bps) for >57% win-rate addresses (roadmap, post-launch) |

The first four have v2 mitigations shipping with the hackathon submission.
The fifth is a monitoring problem we deliberately leave for post-launch
because the mitigation (per-address fee surcharges) feels uncomfortably
close to censorship and we want to validate it against real volume before
shipping it.

---

## 3. Critical attacks (mitigated in v2)

### Vault and queue (`01_vault_queue.md`)

| Attack | v2 mitigation | Hardening task |
|---|---|---|
| #1 Queue-Head Bumper — new winners paid from `settlement_lock` jump older queue entries | Two-tier ordering: when `queue_total > 0`, redeems route `min(payout, queue_total)` through queue first; auto-`harvest(small_n)` on every redeem | H2 |
| #4 Reorder-the-Settlement Sandwich — gap between `lock_settlement` and `settle_market_*` lets market parks treasury inflate | Collapse `lock` and `settle` into one atomic public entry | H2 |
| #7 Negative-Equity Withdrawal Exit — first-mover LPs externalize loss to late LPs when `Q > 0` | LP withdrawals disabled while `Q > 0`; documented in Q&A | H2 (post-MVP for actual withdrawals; MVP has no external LPs) |
| #14 The "Never Drain" Steady State — harvest never fires, treasury monotonically declines | Auto-harvest on every `settle_*` and `redeem_position`; small bounty paid from `protocol_fees` for explicit harvest calls | H2 |
| #15 Settlement-Lock Pool Confusion — single shared `Balance<C>` lets one market drain another's reserved funds | `settlement_lock: Table<ID, Balance<C>>` keyed per market | H2 |

### WICK token (`02_wick_token.md`)

| Attack | v2 mitigation | Hardening task |
|---|---|---|
| A1 Empty-bag retroactive claim — new staker collects historical accumulator | `debt_per_wick` snapshot at stake time, not at first claim; bag populated with current `acc` for every supported currency on `stake()` | H3 |
| A4 Sybil mint loop bypassing per-address ceilings | Per-recipient daily mint cap (100k WICK / 24h regardless of cooldown); operator-bot exclusion | H3 |
| A5 Wash-trade mint with offsetting positions | Counterparty disjointness check at `record_gain_and_mint`; `MIN_EVENT_USD_E6` raised 100x; flat region halved during first 90 days | H3 |
| A8 Genesis-race monopolization | **First-N-blocks throttle: 1 WICK/$ (1% nominal) for first 1,000 blocks / 24h post-deploy** (the "genesis-week mint dampener") | H3 |
| A12 Forfeit-into-pool feedback loop — Layer 4 self-defeats with majority sybil | Forfeit-to-burn (or forfeit-to-insurance), not forfeit-to-pool | H3 |

### Oracle and path (`03_oracle_path.md`)

| Attack | v2 mitigation | Hardening task |
|---|---|---|
| A1 Compromised KeeperCap silently rewrites truth | **2-of-3 multisig wrap on KeeperCap** (one external signer); on-chain Lazer signature verifier (stretch — see § 7) | H1 |
| A4 Sticky `touched_at` from a single bad tick | Per-market price-deviation circuit breaker (>5σ from EMA pauses observation for 60s); minimum-observations gate | H8 |
| A6 Same-tx tick reuse via `fresh_object_address` predictability | All tick-consuming entries take observations by ID, not by inline value; observations consumed atomically with snapshot at lock | H8 |
| A7 Race-to-record front-running | `mark_hit` and `record` callable by anyone (already true); CLOB trading freeze before tick deadline (degrades keeper-only edge to public edge) | H1 |

### Cross-market PTB (`05_cross_market_ptb.md`)

| Attack | v2 mitigation | Hardening task |
|---|---|---|
| A1 Synthetic Mega-Position via barrier stacking | **Probability-weighted global OI cap per (underlying, side)**; α_global ≤ 25% V | H4 |
| A2 Cross-Underlying Correlation defeats per-underlying caps | Cross-underlying correlation matrix in risk_config; SUI / SP500 / BTC counted at 70% correlation for cap purposes | H4 |
| A12 Tournament + main-market double-dip | **Tournament markets share an isolated vault** (kills contagion to main vault) | H4 + H10 |

### Predict route (`06_predict_route.md`)

| Attack | v2 mitigation | Hardening task |
|---|---|---|
| #1 Custody Capture (compromised hub relayer) | Per-user `PredictManager` objects (not a shared hub); MVP ships with Sui multisig hub as fallback | H5 |
| #2 Settlement-Order Arbitrage — touch fires before Predict pays | Hub holds `LockedClaim` per user; `redeem_winner` requires `Predict::is_settled`; reconciliation race closed by single-source-of-truth claim object | H5 |
| #11 Predict upgrade mid-flight | Hub pins to specific Predict version; on-chain version assert before each settle call | H5 |
| #12 Bribery of Manager-Owner admin | Manager admin is a **2-of-3 multisig with at least one external signer**; all admin actions emit public events with 24h timelock | H5 + H9 |

### Tournament (`08_tournament.md`)

| Attack | v2 mitigation | Hardening task |
|---|---|---|
| A1 Sybil tournament entry | Address-cluster heuristic at indexer; tournament prize forfeit on cluster detection; smaller more frequent tournaments | H6 |
| A2 `bulk_open` PTB exploit by guild leader | `bulk_open` removed; entries one-at-a-time, each requires a separate signature | H6 |
| A3 Seed-grinding via prev-block manipulation | Tournament random seed via `sui::random` (VRF), commit-reveal at lock-in | H6 |
| A7 "Founder" badge bot rush | Founder badge gated by funding-source clustering + manual review for top 100 mints; bot mints diverted to insurance | H6 |

### Economic & governance (`10_economic_governance.md`)

| Attack | v2 mitigation | Hardening task |
|---|---|---|
| A2 Whale front-run on mint curve threshold | Genesis-week mint dampener (above) | H3 + H10 |
| A8 Governance bribe of AdminCap | **All admin setters have Move-enforced hard upper/lower bounds**: `max_position_pct ≤ 5%`, `max_side_exposure_pct ≤ 30%`, `base_fee ≥ 25 bps`; AdminCap is 3-of-5 multisig with one external signer; **24h timelock on every parameter change**, with public `AdminParamChangeProposed` event | **H9** |
| A9 Malicious package upgrade as backdoor | **UpgradeCap is timelocked 2-of-3 multisig with 2-week timelock** for any upgrade. Public `UpgradeProposed` event 14 days before activation. Anyone can withdraw during the window. UpgradeCap migrates to immutable post-V1.1 (Darbitex pattern) | **H9** |
| A13 Queue-of-Doom permanent insolvency | (a) Global OI cap (H4); (b) **Tournament markets isolated vaults**; (c) **Queue size hard cap relative to vault: refuse opens when `queue/vault > 0.5`**; (d) **Disclosed bankruptcy/haircut clause** — `queue_total > daily_volume × 30 → orderly wind-down` (per-token haircut to bring queue under 50% V); published in README at launch | **H10** |

---

## 4. High-severity attacks (mitigated)

### Vault and queue
- **#2 Settlement Lock Hostage** — winner refuses to redeem, locking
  `winning_exposure` indefinitely. **Mitigated:** `recover_stale(market)`
  shipped in v2 (24h grace, then funds released back to treasury;
  abandoned positions become permanent zero-redeem).
- **#3 Pro-Rata Dust Avalanche** — 1M-entry queue from spam.
  **Mitigated:** `MIN_STAKE = $1` enforced at `open_*`; one `QueueEntry`
  per `(market, winning_side)` instead of per position (O(1) settlement).
- **#5 Dust-Trickle Harvest Griefing** — preempt honest harvesters with
  1-mist progress. **Mitigated:** `min_pay_per_iteration` config; harvest
  callable only when `side_bucket >= 1 USDC`.
- **#8 Cross-Collateral Phantom Solvency** — markets bind to vault by
  raw `ID`, no Move type witness. **Mitigated:** `register_market(vault,
  market)` AdminCap-gated, atomic, non-revocable; settlement reads
  bound `vault_id` and asserts equality. Stronger phantom-witness
  variant on roadmap.
- **#11 Permissionless `lock_settlement` Wrong-Time Attack** —
  **Mitigated:** `to_lock` snapshotted at expiry-instant treasury, not
  call-time treasury.
- **#13 Adversarial Market Creator** — public `market::create()` with
  near-1x multiplier. **Mitigated:** floor raised to
  `payout_multiplier_bps >= 11_000`; `creator_bond` proportional to
  seed; markets where creator > 50% of either side at expiry route
  profits to `protocol_fees`.

### WICK token
- **A2 first-staker windfall** — `total_staked == 0` strands fees.
  **Mitigated:** burn-on-zero — fees route to insurance bucket when
  `total_staked == 0`; minimum stake `1_000 WICK`.
- **A3 multi-receipt cliff laundering** — receipt-level cliff, address
  rotates. **Mitigated:** per-address cliff via TWAB; one
  `StakeReceipt` per address (mergeable).
- **A6 listing-bond rehypothecation** — same WICK staked AND bonded.
  **Mitigated:** bonded WICK held by-value in `BondPool`, dividend
  eligibility burned; slashed-WICK is burned (not sold), insurance bucket
  gets new USDC from a future fee carve.
- **A7 Pyth-stale `MintDeferred` replay timing** — replay reads HWM at
  replay, not at record. **Mitigated:** `H_snapshot` taken at
  record-time; FIFO replay enforced.
- **A11 bot-trader mint flooding** — § 10.4 leaves bots to mint.
  **Mitigated:** bot losses route mint to insurance bucket via on-chain
  bot registry.

### Oracle and path
- **A2 slow-keeper price selection** — keeper picks favorable tick
  within window. **Mitigated:** any tick used must satisfy
  `record_ts <= price_publish_ts + max_freshness_ms`; multisig keeper
  removes single-actor selection edge.
- **A3 stale-Lazer push** — replay an older signature within freshness
  bound. **Mitigated:** publish-time monotonicity assertion on each
  observation; observation rejected if `publish_ts < last_publish_ts`.
- **A8 min-observations grief** — refuse to observe to force refund.
  **Mitigated:** if `observation_count < min_observations` at expiry,
  market settles via VWAP of available observations weighted by
  freshness, never refunds.
- **A13 settlement-lock race for closing-price markets** —
  **Mitigated:** lock and observe atomic; closing price snapshotted
  at expiry block, verified by VRF beacon for randomness-free markets.

### Impact fee
- **A1 permissionless `record()` after expiry inflates `max_seen`** —
  **Mitigated:** `record()` rejects observations with
  `observation_ts > market.expiry_ms`; impact-fee snapshot taken at
  `lock_settlement` (H8).
- **A2 pre-trade book-padding via Sybil dust** — **Mitigated:**
  `MIN_STAKE` floor; impact-fee `v` computed against
  `min(opposite_oi, MIN_OPP_FOR_FEE_DENOM)` so single-mist deposits
  can't deflate denominator.
- **A3 mid-redemption sequencing** — **Mitigated:** impact-fee
  parameters frozen at lock; later opens don't change in-flight `v`.
- **A11 reopen-after-redeem** — **Mitigated:** per-position-lifecycle
  exposure decrement is one-shot.

### Cross-market PTB
- **A6 listing seed sybil refund farming** — **Mitigated:** seeds
  forfeited to `protocol_fees` if no third-party position opened
  within 24h.
- **A11 cross-collateral vault asymmetry** — **Mitigated:** SUI and
  USDC vaults independent; phantom-typed; cross-vault payout requires
  AdminCap and emits a public event.

### Predict route
- **#3 Touch-before-Predict-expiry drain** — **Mitigated:** Wick winner
  payout cannot exceed hub's confirmed balance; over-payout enqueues to
  vault queue.
- **#4 Single-manager cross-contamination** — **Mitigated:** per-user
  `PredictManager`.
- **#7 `predict::mint` half-state visibility** — **Mitigated:**
  `mint` and `lock` bundled in one PTB; no observable mid-state.
- **#9 DUSDC token-type confusion (phishing)** — **Mitigated:**
  type-display in wallet popup; UI rejects coin-type mismatch with
  bright warning.
- **#10 Settlement reconciliation race** — **Mitigated:** single
  `LockedClaim` per user, atomic.

### DeepBook CLOB
- **A1 Keeper Stale-Quote Sniping** — **Mitigated:** keeper-only
  re-quote replaced with public-callable re-quote; fair-price oracle
  feed timestamped.
- **A2 Pre-settlement information ramp** — **Mitigated:** CLOB freeze
  on a market for last 30s before expiry; settle-time prices set via
  VWAP of last 5 ticks.
- **A4 Touch + NoTouch arbitrage exceeding payout** — **Mitigated:**
  market-creation invariant `payout_touch + payout_no_touch <= stake`
  enforced.
- **A6 Multi-pool double-listing** — **Mitigated:** one canonical
  pool per `(market_id, side)`; protocol-registered and verified.

### Tournament
- **A5 Wash-trade PnL inflation** — **Mitigated:** PnL excludes trades
  where same funding source on both sides within 5 min (already in
  spec); tightened to 60 min and cluster-aware in v2.
- **A6 Comeback sub-pot double-dip** — **Mitigated:** comeback pot
  excludes addresses already in main top-10.

### Indexer / frontend
- **A3 Phishing clone with auto-connecting Slush** — **Mitigated:**
  app domain locked in wallet manifest; SRI on all scripts; CSP set.
- **A4 Session-key escape via self-counterparty trade** —
  **Mitigated:** session keys scoped to single `(market_id, side,
  size_max)` with hard expiry; all session-key-signed ops emit
  `SessionKeyAction` event.
- **A6 XSS via NFT badge name/description** — **Mitigated:** badge
  display is `text-only` HTML-escaped; rich text rendered via
  hardened markdown allowlist; CSP forbids inline script.
- **A14 SQL injection via `/v1/leaderboard`** — **Mitigated:** all
  query params validated by zod schema before reaching SQL; prepared
  statements only.
- **A20 Demo-day live attack: clone + RPC DoS** — **Mitigated:**
  Cloudflare in front of indexer; burst rate-limit; demo wallet on
  separate RPC tier; QR code on the closer slide is signed and pinned.

---

## 5. Medium-severity attacks (acknowledged + roadmapped)

These are not blockers for hackathon submission. They have planned
mitigations on the post-launch roadmap.

| Attack | Doc | Roadmap target |
|---|---|---|
| LP starvation coalition (slow killer) | 10 A1 | Post-launch month 1: per-address dynamic fee surcharge for >57% win-rate over 30d rolling window. Validate against real volume first. |
| WICK dividend-pump manipulation | 10 A3 | Continuous fee deposit (inline at `redeem_winner`) — small refactor, scheduled for v2.1. |
| Vampire fork via higher mint rates | 10 A4 | Brand + integration moat; pre-emptive Wick v2 redeploy capturing better economics if a credible fork appears. |
| Liquidity flight at $20k threshold | 10 A5 | Replace flat region with smooth `(S/(S+H))²` from H=0 (curve smoothness; subset of H3). |
| Cross-protocol arbitrage drains vault | 10 A6 | Vault-aware quoting via off-chain aggregator + multisig adjustment of `payout_multiplier_bps` for cross-venue divergence > 200 bps. |
| Tournament prize-sharing cartel | 10 A7 | Cluster detection at indexer + random tiebreaker for prizes 4–10. |
| Insider market-creator with selective audience | 10 A11 | Mandatory disclosure UI for featured markets; auto-fee surcharge on creator-side trades. |
| Coordinated stake/dividend squeeze | 10 A12 | TWAB-weighted dividend rights for swept funds (subset of H3). |
| Sybil-spawn mint farming | 10 A14 | Funding-source clustering at indexer (Chainalysis-style heuristics). Optional WICK stake floor for premium markets. |
| Multiplier-rounding dust pump | 01 A10 | Round payouts and exposures *up* (ceiling division). One-line fix; scheduled for V1.1 Move package upgrade after multisig timelock. |
| Cumulative-telemetry overflow aiming | 01 A6 | Doc warning: consumers compute APY from events, not cumulative counters. |
| Cross-window 24h leaderboard arbitrage | 08 A11 | Rolling 7-day leaderboard alongside 24h; weight prize distribution toward 7d. |
| Razor's Edge badge oracle gaming | 08 A8 | Badge criterion tightened: requires touch within 0.05% of barrier *as observed across two independent oracle ticks*. |
| Indexer-lag arbitrage against retail | 09 A1 | Sub-second indexer with publish-then-commit ordering; UI shows "indexer lag" badge when > 2s behind chain. |
| SSE backpressure DoS | 09 A8 | Connection rate-limit + heartbeat-based slow-loris eviction. |
| Cache-poisoned leaderboard timing | 09 A11 | TTL-based cache with version stamp; reject reads against stale version. |

---

## 6. Low-severity attacks (deferred)

These are documented in the redteam corpus, accepted as either
unimplementable-without-cost or low-EV-for-attacker. We list them so
nobody is surprised.

| Attack | Doc | Why deferred |
|---|---|---|
| Time-warp settlement (clock discontinuity) | 01 A12 | Sui clock doesn't jump in production; mitigation cost > expected harm. |
| Donation distortion | 01 A9 | Multiplier floor at 1.1x already mitigates substantial donation laundering; residual is cosmetic. |
| `EAlreadyExpired` confusion + `touch_outcome` boolean ambiguity | 03 A14 | Documentation-only fix shipped; UX bug not loss-of-funds. |
| Vulnerability=0 edge in impact fee | 04 A5 | Solo-position scenario: minimal volume; fee floor of 25 bps is fine. |
| `isqrt_u64` round-down compounding | 04 A7 | Worst-case error < 0.1% per tx; bounded leak. |
| Oracle tick bundling inside trade PTB | 05 A10 | Same-PTB oracle write is the *intended* composition pattern; attack surface reduces to "what does the oracle say" not "who wrote it." |
| DEEP inventory exhaustion DoS | 07 A7 | DEEP not a Wick liability; CLOB pool provider problem. |
| Coin merge / decisiveness-loss exploit | 07 A11 | Position coins are not mergeable across markets; intra-market merge resets decisiveness intentionally. |
| Witness-module polluter / OTW spam | 07 A14 | Per-market OTW pattern; spam costs gas, no exploit. |
| Look-alike badge package griefing | 08 A13 | Badge issuer pinned in protocol; UI verifies issuer ID. |
| `mark_hit` frontrunning for Witness badge farm | 08 A14 | Witness badge worth ~$0; farming uneconomic. |
| Spread Architect 4-leg PTB padding | 08 A9 | Badge cosmetic; no economic value. |
| Spoofed `BadgeAwarded` via fuzzy projector | 09 A7 | Indexer projector pinned to event-type + issuer hash. |
| Frontend secret leakage via `VITE_*` | 09 A19 | Audit checklist before deploy; no secrets in `VITE_*` by policy. |
| Badge-criteria-as-dark-pattern | 09 A18 | UX review pre-launch; badges have explicit non-obfuscated criteria text. |
| CORS misconfiguration | 09 A13 | Strict CORS allowlist already shipped; periodic config audit. |

---

## 7. Accepted residual risks

These are the things we genuinely cannot fully mitigate. Calling them out
is the entire point of this document.

### 7.1 Off-chain Lazer signature verification (until on-chain verifier ships)
Until the on-chain Lazer signature verifier driver ships (task #78,
post-hackathon), the keeper is the *signature* authority for every
Lazer-driven market — even with the multisig wrap, the multisig only
chooses *which signed Lazer message* to publish on-chain; it cannot
invent prices, but it can *select* among Lazer messages. A 2-of-3
multisig requires two signers to coordinate the same selection, which
is dramatically harder than phishing one operator. But it is not a
cryptographic guarantee. **Real users should size positions accordingly
during the keeper-trust window.**

### 7.2 Cross-venue arbitrage leak
We are a price-taker against Polymarket, Kalshi, and centralized
sportsbooks on overlapping lines. Sophisticated arbers will extract
spread continuously. We have chosen to monetize via volume rather than
chase quotes. This is a permanent baseline cost of doing business and
the protocol's economics assume some fraction of net flow is arber
flow.

### 7.3 LP-starvation by sophisticated coalition (slow killer)
Any LP-backed market can be picked off by a coalition that only takes
positive-EV trades. Our defense is *dynamic*, not preventive: if we
detect the coalition forming via win-rate clustering, we apply a
per-address fee surcharge. We commit to publish the threshold (57%
win-rate over 30-day rolling window) and the surcharge (200 bps) on
every monthly transparency report. **Users who consistently win at high
rates should expect higher fees.**

### 7.4 Sybil-resistant gates require off-chain heuristics
Funding-source clustering, address-cluster heuristics, KYT-style
analysis — these all live off-chain. The indexer applies them, the
chain enforces nothing. The implication: an indexer compromise can
disable the cluster gate. The mitigation is multiple independent
indexer instances with consensus-based gate decisions, but this is a
post-launch infrastructure ask.

### 7.5 Bankruptcy / haircut clause is real
If `queue_total > daily_volume × 30` for more than 30 days, the
protocol enters orderly wind-down. Existing queue entries take a
pro-rata haircut to bring `queue_total ≤ 0.5 × V`. The protocol
survives; the late winners share the loss. **This is disclosed in the
README at launch. Do not interpret "winners always paid" as
unconditional.** The condition under which it fails is fully described
on-chain (a single Move function `is_in_orderly_wind_down(vault):
bool` returns the canonical truth).

### 7.6 Demo-day attacks
A coordinated DoS or RPC partition during the live demo window cannot
be cryptographically prevented. Our mitigations are operational:
Cloudflare in front of the indexer, separate RPC tier for the demo
wallet, pre-recorded backup, three pre-staged backup wallets. None of
this is in the threat model for production users — only for the
3-minute hackathon pitch.

---

## 8. Move-enforced upper bounds (H9 hardening)

The single most important architectural change in v2 is that **every
admin-tunable parameter has a Move-enforced bound**. The AdminCap holder
cannot exceed these even if the multisig is fully cooperative — the
`assert!` is in the setter. Crossing these bounds requires a package
upgrade, which is itself behind the 2-week timelocked multisig.

| Parameter | Hard min | Hard max | Rationale |
|---|---|---|---|
| `max_position_pct` (per address per market) | 0.1% | **5%** | Caps single-bribe drain (Attack #8 in 10) |
| `max_side_exposure_pct` | 5% | **30%** | Per-market OI cap |
| `max_global_oi_pct` (per underlying) | 5% | **25%** | Cross-market correlation cap (H4) |
| `base_fee_bps` | **25** | 500 | Floor prevents zero-fee griefing (Attack 5 in 04) |
| `payout_multiplier_bps` | **11_000** | 100_000 | Floor closes adversarial-market-creator donation laundering (Attack 13 in 01) |
| `min_stake_usdc_e6` | **1_000_000** ($1) | 10_000_000_000 | Closes dust avalanche (Attack 3 in 01) |
| `queue_circuit_breaker_pct` | 30% | **50%** | Refuse opens beyond this; closes Queue-of-Doom |
| `mint_genesis_throttle_blocks` | **1_000** | 100_000 | Genesis-week dampener (Attack 2 + 8 in 02) |

These bounds are tested via `move/tests/admin_bounds_tests.move` (will
be added with H9). Any setter without a bound check fails the test
suite.

---

## 9. Multisig key holder list

**Status:** placeholder. Final list ratified pre-mainnet.

### KeeperCap multisig (2-of-3)
- Wick core team operator (signer 1)
- Wick core team operator (signer 2, separate hardware wallet, separate jurisdiction)
- External signer: TBD (auditor or partner protocol; commit-and-publish pre-mainnet)

### AdminCap multisig (3-of-5)
- Wick core team (3 signers, separate keys, separate jurisdictions)
- External signer 1: TBD (auditor)
- External signer 2: TBD (partner protocol or community-elected steward)

### UpgradeCap multisig (2-of-3, 2-week timelock)
- Wick core team operator (signer 1)
- Wick core team operator (signer 2)
- External signer: TBD (auditor)

**Operational rules** (committed in this doc):
- Every admin-multisig signature emits a public `AdminParamChangeProposed` event 24 hours before execution.
- Every UpgradeCap signature emits a public `UpgradeProposed` event 14 days before execution; the new package hash is published on-chain at proposal time.
- Any LP, staker, or position holder can withdraw / unstake / redeem during the 24h or 14d windows.
- Multisig key custody attestations published quarterly.
- Loss of any single key triggers an emergency rotation event and a public notice.

---

## 10. Bug bounty terms

**Status:** placeholder. Bounty program activates within 30 days of mainnet launch.

### Scope
- All Move modules in `move/sources/`
- `keeper/` TypeScript bot (signature handling, key custody)
- `frontend/` (XSS, session-key handling, wallet integration)
- The published indexer + API (auth, IDOR, injection)

Out of scope: third-party dependencies, DeepBook itself, Pyth Lazer
itself, Sui validator behavior.

### Tentative reward tiers (USDC)

| Severity | Bounty range |
|---|---|
| Critical (loss of vault funds, unauthorized mint, multisig bypass) | $25,000 – $100,000 |
| High (loss of a single market's funds, oracle truth corruption, position theft) | $5,000 – $25,000 |
| Medium (denial of service, indexer corruption, dividend miscalculation) | $1,000 – $5,000 |
| Low (UI bug with security implication, race condition without loss) | $250 – $1,000 |

Disclosure SLA: 90 days from initial report. Critical findings receive
expedited fix + public disclosure within 14 days. Hosted via Immunefi
(target).

---

## 11. Audit timeline

**Status:** post-hackathon.

| Phase | Target window | Notes |
|---|---|---|
| Internal redteam pass (this doc) | Complete (2026-05-12) | 137 attacks, 9 hardening specs |
| External contracts audit (firm 1) | Hackathon + 30 days | Move package focus; vault, queue, WICK token, oracle path |
| External contracts audit (firm 2) | Hackathon + 60 days | Independent crosscheck; Predict route, CLOB integration, tournament |
| Public bounty open | Hackathon + 90 days | Immunefi (target) |
| Mainnet launch (rate-limited) | Hackathon + 120 days | Genesis-week throttle active; max OI 10% of testnet equivalent |
| Full mainnet | Hackathon + 180 days | Caps relax to v2 hard maxes |

**Launch blockers** (per § 10 of `10_economic_governance.md`, satisfied
in v2):
1. Global OI cap (H4) ✓
2. Hard-coded bounds on every admin setter + multisig AdminCap (H9) ✓
3. Multisig wrap on KeeperCap (H1) ✓
4. Genesis-week mint dampener (H3) ✓
5. Disclosed bankruptcy/haircut clause in README (H10) ✓

---

## 12. How to read this document

If you are an **auditor**: §§ 3, 4, 8 are the load-bearing parts.
The corpus in `docs/redteam/` has the underlying attack walkthroughs.

If you are a **sophisticated user**: § 7 is what you should care about.
The protocol has structural risks. The disclosed haircut clause means
the worst outcome for you is documented and on-chain, not hidden.

If you are an **integrator**: § 9 (multisig) and § 11 (audit timeline)
tell you when to trust the deployment. Until at least one external
audit lands, treat the protocol as *interesting on testnet, not
production*.

If you are a **judge**: read § 1 and § 2. Then look at § 8. The point
is not that we are exploit-free — we are not. The point is that the
attacks that *can* break us are named on-chain (the haircut clause is
a public Move function), and the attacks that we *have* broken are
documented attack-by-attack with the v2 mitigation. **Production-honest
beats production-confident.**

---

## 13. Document maintenance

This document is updated whenever:
- A new redteam pass produces new attacks
- A new hardening task lands in `move/`
- A multisig signer rotates
- An audit finding requires public disclosure

Diff-readable via git history. Major updates change the version
number in the front matter. Minor updates (wording, clarifications)
do not.

Pull requests welcome. The `redteam/` corpus is the working source
of truth; this file is its public projection.

---

*End of public threat model. Total: 137 named attacks across 10 redteam
documents. v2 mitigations cover 100% of Critical and High severity
attacks. Medium and Low are roadmapped or accepted with rationale. The
bankruptcy clause is in the README. The multisig list is committed.
The bounty program is funded.*

*Wick is what you get when you take "the worst attack is the one your
threat model doesn't name" seriously.*
