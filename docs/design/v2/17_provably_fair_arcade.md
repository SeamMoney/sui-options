# 17 — Provably-fair random-walk arcade: build & test plan

**Status:** build contract for the random-walk degen mode. Supersedes the per-tick `random_walk_driver` model for arcade markets.
**Date:** 2026-05-22 (rev 4 — deep red-team: event-driven segments, the economics/moneyness dependency, `record_segment`-runs-the-walk, generative conformance, honest scope).
**Scope:** the random-walk arcade ("degen mode") — fast, *the* settlement price, provably fair, verifiable. Real-underlying (BTC/Pyth) markets are a separate track (§12).
**Owner:** source of truth for the arcade price layer. `random_walk_driver.move`, `ride_position.move`, `ride_pricing.move`, `useRideGesture.ts`, the cranker — if they drift from this, they are wrong.
**Rev history:** rev 1/2 used a hash-chain commit-reveal mechanism — **dropped** (it required a TEE to close operator-foreknowledge). rev 3 used wall-clock segments — **dropped** (a late crank stalled the chart). rev 4 is event-driven segments + commit-before-roll.

---

## 1. The problem

The `/ride` chart is a per-browser `Math.random()` walk, disconnected from on-chain settlement → riggable-feeling, incoherent (every user a different chart), dishonest (a visible touch ≠ a win). The random-walk degen mode **must be provably fair**. The chart must be: **fast, the actual settlement price, provably fair, verifiable.**

## 2. The mechanism — segment commit-before-roll

Roulette: you bet, *then* the wheel spins. We never hide a pre-existing price — we roll it *after* the player has committed.

- The market advances in **segments**. Each segment ≈ 6 candles at 65ms (~0.4s of play).
- A segment's randomness — `segment_key` — is a draw from Sui on-chain randomness (`sui::random`), recorded **at the moment the segment begins**, *after* every decision affecting it is locked.
- A segment's candles are a **deterministic public function** of `segment_key` + the carried walk state. Every client computes them; the chain computes them in `record_segment` and stores the extremes; settlement reads the extremes.
- A player's open/close commits at segment boundaries; within a segment they are locked. **Every decision is made before the randomness it is exposed to exists** — foreknowledge is structurally unexploitable, by anyone.

**Segments are events, not wall-clock windows** (rev-4 correction). Segment *k* exists when `record_segment(k)` lands — not at wall-time `k·400ms`. The keeper *targets* ~0.4s cadence; if it is slow, the game simply plays slower; nothing breaks and nothing is unfair. No "rounds" — the market is a continuous segment stream; a *ride* is the span of segments held.

## 3. What the player feels

Open the page → a candlestick chart flying at 65ms. Press and hold → PnL ticks, price wicks toward the barrier. Let go → cash out. **That is the whole experience** — identical to any fast chart-hold game. Segments are engine, not dashboard. A quick tap fires nothing (you must hold past one boundary) — the tap=no-op / hold=ride behaviour, native. The ~0.4s commit grid is invisible **only because open/close use optimistic UI** (§7 D2) — that is load-bearing, not polish.

## 4. Why it is provably fair — threat model

| Attack | Defeated by |
|---|---|
| Operator rigs / changes the path | The price is `sui::random` through a public function. The operator picks nothing. |
| Operator or player sees the future | A segment's randomness does not exist when decisions for it are made. |
| Selective stop / abort | `record_segment` / `open` / `close` / `settle` are all permissionless — anyone (the player) cranks. |
| **Grinding the per-segment draw** (test-and-abort) | See §6.1 — resolved, but **gated by a Sui-randomness spike** (A0). |
| Unverifiable | Anyone replays the on-chain `segment_key`s through the public function. |

Residual: trust in Sui's own randomness beacon — the universal Sui assumption. **No TEE, no Shelby, no trusted server, no hash-chain.**

## 5. The economics dependency — moneyness (READ THIS)

Making the price *honest* forces the *economics* to be honest. Today the fake chart hides this: "price looks near the barrier" is meaningless noise. The instant the price is real and deterministic, a bot opens a ride **only** when the price sits near the barrier — high touch-probability against a **fixed** `RideMarketCaps.multiplier_bps` = positive EV = the vault bleeds.

`ride_pricing.move` already has the right tool — `bachelier_cashout_factor`: a Bachelier z-score `z = |barrier − spot| / (σ·√t)` that is 1.0 at the barrier and ~0 far away. **But it currently gates cash-out, not entry.** Under an honest price that is a hole.

**Required (Phase B4), one of:**
- **(a) Entry-relative barrier** — the ride's barrier is set ±X% from the *entry price* at the entry segment. Moneyness is then constant by construction; selection is impossible. Cleanest for the arcade.
- **(b) Moneyness-gated entry** — the entry multiplier (or stake rate) scales with the Bachelier z at entry, using the existing `ride_pricing` machinery.

This is a hard dependency on `14_ride_economics`, and the segment economics must be **re-validated by Monte Carlo** (B7). It is not optional and not deferrable — the provably-fair design *creates* this requirement.

## 6. Architecture specifics

### 6.1 The per-segment draw — grinding resistance
`record_segment(mkt, k, &Random, &Clock)` is an `entry` function (Sui requires this for `Random`). It asserts `k` is the next unrecorded segment, draws `sui::random`, runs the walk, stores — **with no value-dependent branch**, so it cannot be aborted *based on* the drawn value. The open threat is a PTB that wraps it (`record_segment` then read-and-abort). **A0 is a spike to confirm Sui blocks this** (entry-function outputs do not flow to later PTB commands; failed txs reveal no drawn value; dry-run yields no real randomness). **Fallback if A0 fails:** keeper commit-reveal — the keeper commits `H(nonce)` one segment ahead; `segment_key = H(nonce ‖ sui_random)`; the keeper is bound to `nonce` before the draw, so it cannot grind.

### 6.2 `record_segment` runs the walk
`record_segment` draws the key, runs `seeded_path::expand_segment` (6 candles of integer fixed-point math — cheap), and stores: `segment_key[k]`, the checkpointed `walk_state` after k, and the segment's `(min_price, max_price)`. **Settlement is then a cheap scan** of stored extremes over `[entry..exit]` for a barrier cross — no replay. Bonus: the Move walk runs in production every segment, so it is continuously exercised.

### 6.3 Smoothness — keeper pipelining + frontend rubber-banding
A naive crank-then-wait stalls the chart (Sui finality ~400ms ≈ the segment length). The keeper **pipelines** — submits `record_segment` continuously at the target cadence, never waiting for confirmation. The frontend renders the segment whose key just arrived, animating its 6 candles over the real inter-arrival interval, **rubber-banding** (slightly faster/slower) to absorb jitter. A sustained keeper outage = a visible stall → permissionless backup: the player's own client cranks (§7 D4).

### 6.4 Crank only while rides are open
`record_segment` every 0.4s forever = ~216k tx/day/market. The market **sleeps when no ride is open** — the first `open_ride` wakes it; cranking stops when the last ride settles. Cost tracks usage.

### 6.5 Per-segment stake
The ride currently accrues stake by wall-time (`stake_rate_micro_usd_per_sec`, `start_time_ms`). Event-driven segments have variable wall-time → **stake must accrue per segment** (a fixed stake per segment ridden). This is a real `ride_position.move` rework and touches escrow sizing, `crank_expired_ride`, and the vault payout path.

## 7. Implementation plan

Six phases, each with a hard gate; build order = dependency order.

### Phase A — deterministic walk + conformance harness
- **A0 (spike, gates everything):** confirm the Sui `Random` API and that `record_segment` is not test-and-abortable (§6.1); if not, adopt the commit-reveal fallback.
- **A1:** spec the walk in **integer fixed-point** — fixed scale, hash = `blake2b256` (Sui-native + `noble-hashes` in TS), defined byte→int endianness, defined rounding, defined overflow. Port the momentum + volatility-regime + fat-tail walk from `useRideGesture`.
- **A2:** Move `seeded_path::expand_segment(state, key) → (candles, new_state, min, max)`.
- **A3:** TS port `seededPath.ts` — **must use BigInt** (JS `number` cannot hold the u128/u256 intermediates).
- **A4:** generative differential conformance harness — TS generates 10k+ random `(key, state)` inputs + its outputs, code-gens a Move test asserting Move == TS byte-for-byte; CI runs it.

**The walk is two layers — keep them strictly separate.**
- *Entropy layer:* `segment_key` (perfect `sui::random`) is expanded by `keystream(key, n) = blake2b256(key ‖ le(n))` into an unlimited deterministic stream of uniform values. This is the "perfect randomness" — and it is the **only** thing that changes vs today.
- *Shaping layer:* the existing `useRideGesture` walk — momentum, volatility-regime, fat-tails, mean-reversion — is the **frozen spec for the look.** It is transcribed *verbatim*: only `Math.random()` → keystream draws, and floats → fixed-point. **Do not redesign it.** Every "pattern" the chart shows (trends, calm-vs-wild clustering, the occasional huge candle) comes entirely from this layer; randomness is just the fuel poured into it.

The walk state (`price, momentum, volRegime`) is checkpointed by `record_segment` and **carried across segments**, so trends and volatility clusters span a whole ride, not one 0.4s segment.

**Gate A:** conformance green on 10k+ vectors **and** the §14.3 visual-fidelity sign-off. *Nothing else starts until this passes.*

### Phase B — Move: segment market + settlement + economics
- **B1:** `segment_market.move` — `SegmentMarket` with event-driven segments, `Table` of keys / checkpointed states / extremes.
- **B2:** `record_segment` per §6.1–6.2 + crank-only-while-active (§6.4).
- **B3:** ride rework — per-segment stake (§6.5); `open_ride` entry = next segment; `close_ride` exit = current segment; `settle_ride` (permissionless) scans extremes; deadband from `path_observation`.
- **B4:** **the moneyness fix** (§5) — entry-relative barrier *or* moneyness-gated entry. Decision required.
- **B5:** abort/refund (1:1) if a held segment is never recorded past a deadline.
- **B6:** Move property tests (§8).
- **B7:** re-run `scripts/simulate_protocol.py` on the segment + moneyness model; update `15_montecarlo_validation_report.md`.

**Gate B:** `./scripts/agent-preflight.sh` green incl. invariant suite, **and** Monte Carlo shows a defensible vault edge.

### Phase C — the cranker
- **C1:** pipelined `record_segment` cranker (§6.3), crank-while-active, permissionless backup.

**Gate C:** sustains cadence on testnet; survives a kill (permissionless recovery).

### Phase D — frontend
- **D1:** render candles from on-chain keys via `seededPath.ts`; rubber-band animation; render at the latest key. Delete the `Math.random()` walk.
- **D2:** gesture → boundary commit + **optimistic UI** (load-bearing) — press → "starting…" → "RIDING" at the boundary (or fades = it was a tap); release → "cashing out…".
- **D3:** live PnL computed from the real deterministic candles — now honest, not a fiction.
- **D4:** client-side crank fallback if the keeper stalls.

**Gate D:** typecheck green; gesture QA; the rendered chart matches on-chain stored extremes.

### Phase E — verify + E2E + adversarial
- **E1:** `/verify` — replay on-chain keys, confirm candles + verdict. (CLI script for the hackathon; page later.)
- **E2:** E2E replay test (§8).
- **E3:** adversarial + resilience tests (§8).

**Gate E:** all pass on testnet.

### Phase F — deploy + smoke + honest threat-model doc.

## 8. Test plan

**Two spine tests — they *are* the proof of provable fairness:**
1. **Generative conformance** (Gate A) — Move `expand_segment` == TS `expand_segment`, byte-identical, 10k+ random vectors, in CI. Proof that the chart you watch is the price you settle against.
2. **E2E replay** (Gate E) — an independent off-chain replay of a real ride's on-chain `segment_key`s yields the *same* touch verdict as the on-chain `settle_ride`. Proof, automated, that settlement is honest.

**Move property tests (B6):** `record_segment` first-write-wins / no-skip / no-double-record / no-future; open cannot enter the current segment; settle replays correctly (hand-picked keys → known touch → `TOUCH_WIN`; known no-touch → loss); settle idempotent; settle blocked before the exit key exists; abort→refund on a missing segment; per-segment stake math; **the collateral invariant preserved throughout.**

**Economic test (B7):** Monte Carlo over 10k+ seeds — actual touch rate, realized house edge, vault solvency under per-segment stake + the moneyness fix. Gate B depends on it.

**Adversarial + resilience (E3):** the test-and-abort grinder; a stalled keeper → permissionless self-heal; the player cranking their own `record_segment` + `settle_ride`; concurrent opens vs `RideMarketCaps`; keeper killed mid-stream.

**Frontend (D):** unit test for the gesture→segment-boundary mapping; a live check that rendered candles match on-chain extremes.

## 9. Honest scope & the hackathon fork

Realistic estimate with everything above: **~21–31 working days.** The hackathon is **29 days out** (June 20). **The full build does not fit with any safety margin** — and the determinism work (Phase A) is the kind of task that can blow up. You must choose:

1. **All-in full build** — the entire runway on this; high risk; if Phase A slips, there is no demo.
2. **Trimmed provably-fair** (~2.5–3 weeks, still tight) — a *simpler* walk (less volatility-clustering ⇒ far less fixed-point surface), ~1s segments (fewer txs, simpler), entry-relative barrier (B4 option (a) — also the simplest), `/verify` as a CLI. Genuinely provably-fair, less pretty.
3. **Demo current + one real PoC market** — keep today's working client-walk arcade for the live demo (it works, looks great), ship **one** genuinely-provably-fair on-chain market as proof-of-concept, present rev 4 as the roadmap. Lowest risk; the judges see a polished demo + a rigorous plan + a working PoC of the hard part.

Recommendation: **option 3** for the hackathon, then option 1/2 after. The provably-fair engine is the right long-term build; betting the whole submission on finishing it in 29 days is the wrong risk.

## 10. Parameters (defaults — joint-tune in `14_ride_economics`)

`segment ≈ 6 candles` · `candle_ms = 65` · barrier/vol/multiplier/deadband are a **joint** calibration (the walk's fat-tail magnitude vs the deadband decides how often a touch is "real") — not independent knobs.

## 11. Open decisions

1. **B4: entry-relative barrier vs moneyness-gated entry** — the §5 fix. Leaning entry-relative (simpler, kills selection structurally).
2. **Hackathon fork (§9)** — option 1, 2, or 3.
3. Segment length (≈0.4s vs ≈1s) — UX grain vs tx rate; both safe.
4. Abort deadline — how long a missing segment waits before a ride aborts-refunds.

## 12. Scope boundary

This is the **synthetic arcade**. Real-underlying options (BTC) are a separate track — no seed to commit; the price is the **free** Pyth on-chain feed; same vault + touch/no-touch/DNT settlement, different `OracleSource`. This plan fixes the **price**, not the **economics** beyond the §5 moneyness dependency — house edge and solvency remain the job of `14_ride_economics` / `15_montecarlo_validation_report`. The options engine (vault, settlement locks, collateral invariant, fees) does not change.

---

## 13. How this fits the whole codebase — one engine, a swappable price source

The provably-fair arcade is **not a second product bolted next to the options protocol.** It is the *same* options engine running on a synthetic, provably-fair `OracleSource`. That is the architecture's payoff — and the thing worth showing off.

### 13.1 The layered engine (22 Move modules)

```
  PRICE SOURCES  ── swappable; the ONLY layer the arcade adds to ──
  ┌────────────────────────┬───────────────────────────┬──────────────────────────┐
  │ pull_oracle_driver     │ random_walk_driver        │ segment_market + NEW     │
  │  real BTC/ETH (Pyth)   │  (legacy synthetic —       │ seeded_path   ◀ NEW      │
  │                        │   superseded for arcade)   │ provably-fair synthetic  │
  └───────────┬────────────┴────────────┬──────────────┴────────────┬─────────────┘
              └─────────────────────────┼───────────────────────────┘
                                        ▼
  ORACLE     wick_oracle · oracle_version_lock · usd_price_oracle · price_observation
                                        ▼
  BARRIER    path_observation   (buffer + deadband — the one touch-detector)  · probability
                                        ▼
  PRODUCTS   market<C> touch/no-touch  ·  DNT corridor  ·  ride_position
                                          (+ ride_pricing, ride_market_caps)
                                        ▼
  SETTLEMENT martingaler_vault<C> · vault · risk_config · global_exposure_registry
               (LP, settlement locks, abort pools, FIFO queue) · bot_registry · impact_fee
                                        ▼
  FEES/TOKEN fee_router ──▶ protocol / staker / insurance buckets ──▶ wick_staking ◀ WICK

  ROUTER     wick.move — public entrypoints; routes by OracleSource
```

Everything below the top layer is **shared by every market type.** A BTC touch option and an arcade ride traverse the *identical* path: oracle → `path_observation` deadband → product → `martingaler_vault` settlement → `fee_router` → `wick_staking`. The arcade's provably-fair work adds exactly **two new modules** at the top (`seeded_path`, `segment_market`) and lightly extends two (`wick.move` routing, `ride_position` per-segment stake). Twenty modules are reused untouched.

### 13.2 The OracleSource swap

`wick.move` already routes by oracle source — today `pull_oracle_driver` (real) and `random_walk_driver` (synthetic). The arcade adds `segment_market` as a third. A reader of `wick.move` sees one clean dispatch absorbing three very different price origins — a real Pyth feed, a legacy PRNG, provably-fair commit-before-roll — with **zero downstream duplication.** Flip the source and the same vault, the same deadband touch-detector, the same settlement, the same fee economy serve a real BTC option or a provably-fair ride. One abstraction, N implementations, the engine indifferent to which.

### 13.3 The shared cross-language core

`seeded_path` is the one place the system spans languages:
- **Move** (`seeded_path.move`) — for `record_segment` and settlement;
- **TypeScript** (`@wick/sdk` → `seededPath.ts`) — the SDK is the shared package; the frontend imports it to render the chart, `/verify` imports it to replay. One walk, one SDK home, three consumers.

The generative conformance test (§8) binds the two byte-for-byte. It is the codebase's most sophisticated single artifact — a deterministic function proven identical across a Move VM and a JS runtime — and it is *why* "the chart you watch == the price you settle" is a provable claim.

### 13.4 Phase-by-phase: new vs. extend vs. reuse

| Phase | NEW | EXTENDS | REUSES UNCHANGED |
|---|---|---|---|
| A | `seeded_path.move`, `@wick/sdk/seededPath.ts` | — | `probability.move` integer-math patterns; SDK layout |
| B | `segment_market.move` | `wick.move` (OracleSource variant), `ride_position.move` (per-segment stake), `ride_pricing` use (Bachelier at *entry*) | `path_observation`, `martingaler_vault`, `risk_config`, `global_exposure_registry`, `ride_market_caps`, `impact_fee`, `fee_router`, `usd_price_oracle` |
| C | cranker role | `keeper/` (already cranks pull markets + tournament) | keeper config, signer, retry/backoff |
| D | — | `useRideGesture.ts`, `useWickRide.ts`, `Ride.tsx` | `@wick/sdk` tx builders, burner-wallet session, optimistic-UI plumbing |
| E | `/verify` route + script | — | `@wick/sdk/seededPath.ts` |
| F | — | `docs/architecture.md` (add the arcade `OracleSource` + this diagram) | deploy scripts, preflight |

**Five genuinely new files.** The provably-fair arcade is small *because the engine was built right* — and that ratio (≈5 new : 20 reused) is the most legible signal of architectural maturity a judge can read.

### 13.5 On "impressive"

Judges reward **coherence**, not raw complexity. A pile of clever-but-disconnected modules reads as sprawl. What reads as mastery: a sophisticated system where one abstraction (`OracleSource`) cleanly absorbs three hard, different things, and a single deterministic function is *proven* identical across two languages. The arcade build is genuinely complex — but the complexity is concentrated in two new modules and one conformance proof, sitting inside an engine it does not perturb. Keep it that way: never duplicate engine logic into the arcade — every reuse is a point scored.

---

## 14. UX safeguards — the rebuild must improve the feel, not degrade it

This is a backend overhaul. It must not cost UX. So UX is a **gated acceptance criterion**, tested on a real phone, every relevant phase.

### 14.1 UX invariants — must not regress (gated at Phase D)
Concrete, measurable, on a physical phone:
- Press → visible "riding" response **≤ 100ms** (optimistic UI; same as today).
- Release → visible "cashing out" **≤ 100ms**.
- Live PnL ticks **≥ 12 fps** through a whole hold.
- The chart shows the **same candle liveliness** the current build was tuned to — big/small variety, volatility clustering.
- Under a healthy keeper: **zero visible chart stalls**.
- Tap = no-op; hold = ride; **no wallet popups**.

### 14.2 Baseline-and-compare
The current arcade is deployed and works — it is the **living reference.** Keep it live; A/B it against the new `/ride` on the same phone. The new build does not pass Phase D until it is **equal-or-better on every §14.1 invariant.**

### 14.3 The fixed-point walk must LOOK identical (extra Phase A gate)
The conformance test proves Move == TS. A *second* gate: the integer `seeded_path` walk must be visually indistinguishable from the float walk whose look was already signed off. Phase A ends with a side-by-side visual diff; **the owner approves the new walk's look before it is locked.**

### 14.4 The one genuine new failure mode — the stall
A network-fed chart can stall where a local `Math.random()` chart cannot. This is the only real UX regression risk; attack it directly: keeper pipelining + frontend buffer + rubber-banding + client-side crank fallback (§6.3, D4). Test it — simulate keeper jitter/outage and measure. Degraded state = a calm "syncing…", never a frozen, broken-looking chart. **Acceptance: under realistic keeper conditions the chart is as smooth as today's local walk.**

### 14.5 Optimistic UI is built first
D2's optimistic UI is the mechanism that makes the segment grid invisible. Build it as the **first** frontend task, not the last — every other D task is judged with it already in place.

### 14.6 The owner is the UX gate
The taste-checks that shaped the current arcade ("too slow", "taller candles", "this looks awesome now") become **formal sign-off gates**: at Phase A (walk look) and Phase D (gesture feel), the owner does the side-by-side and explicitly approves. No phase passes on the builder's say-so.

### 14.7 Where it gets genuinely better
By design, net-positive: the PnL becomes **honest** (computed from the real candles — no more "I touched but didn't win"); a stray tap is a clean no-op; the chart **is** the real settlement price, so the player can *trust* what they watch; `/verify` is a new moment of delight; and `seeded_path` is fully ours to tune — the chart can be *more* alive, not less (see §15).

---

## 15. Candlestick generation & detection — full design

The arcade chart must be *readable*: the player watches a hammer, an engulfing, three white soldiers form, with a **highlight / overlay / tooltip / glow** — and every part of it is **decentralised, fair, and a verifiable function of on-chain randomness.** Generation and detection are not two features; they are one pipeline. This is its complete design.

### 15.1 One pipeline, one fairness principle

The whole chart — price, patterns, labels, glow — is a **deterministic function of on-chain randomness.** Nothing is operator-chosen; nothing is "painted on top." Enforced structurally — every arrow below is a pure deterministic function:

```
sui::random ─▶ segment_key ─▶ expand_segment(state,key) ─▶ candles ─▶ detect(candles) ─▶ labels ─▶ display
  on-chain      on-chain       ├ momentum walk             pure       pure predicates    │     highlight
  beacon        (record_       ├ pattern FSM               OHLC       (patterns.ts)      │     overlay
                 segment)      └ shapers                   stream                        │     tooltip
                               Move + TS, byte-identical                                 │     glow
```

Because the seed is on-chain randomness and every step is a pure deterministic function: the candles are verifiable → the labels are verifiable → the glow is honest. Anyone replays `sui::random → … → labels` and gets the identical result. **That is what "decentralised and fair" means here — for the price *and* the patterns *and* the highlights, end to end.** `/verify` (Phase E) is exactly this replay.

### 15.2 Generation runs on-chain — patterns are part of the canonical price

`expand_segment` runs inside `record_segment` (Move) and byte-identically in TS — so the patterns are **part of the on-chain, canonical price**, not decoration a server adds. Three layers inside it:

1. **The momentum walk** — base walk (§7 A): price, `momentum`, `volRegime`, fat tails, integer fixed-point.
2. **The pattern FSM** — a state carried in the walk state: `NORMAL` or `FORMING{pattern, candles_left}`. Each `NORMAL` candle, the engine draws keystream entropy: with a small scheduled probability it enters `FORMING{p}`, where `p` is drawn from a **rarity-weighted distribution** (common patterns high weight, legendary low → rare patterns are rare *by construction*). While `FORMING`, the next 1–3 candles come from that pattern's shaper; then `NORMAL` resumes carrying the pattern's momentum legacy.
3. **The shapers** — one per hero pattern; each produces 1–3 candles whose OHLC *provably* satisfy the pattern predicate while staying continuous and entropy-varied.

### 15.3 A shaper, concretely (bullish engulfing — the template for all)

Inputs: prior close `P`, walk state, a keystream slice. Let `U` = a price unit scaled to current `volRegime` (the pattern is proportioned to the chart).

- **Candle 1 — small bearish:** `open = P` · `body₁ = entropy ∈ [0.3U, 0.8U]` · `close = P − body₁` · wicks `∈ [0, 0.3U]`.
- **Candle 2 — engulfing bullish:** `open = candle1.close` (continuity — opens exactly at prior close) · `body₂ = entropy ∈ [body₁ + 0.5U, body₁ + 2.5U]` · `close = open + body₂`.

Because `body₂ > body₁` by construction, `close > P` (= candle1.open) and `open ≤ candle1.close` — `isBullishEngulfing` holds **with margin, for every entropy draw.** No two engulfings are identical; the shape is guaranteed. Momentum legacy: `momentum := +k` (`k` = the tuned predictiveness knob, §15.9).

Every hero shaper follows this template — *entropy-drawn magnitudes inside ranges that guarantee the predicate*, continuity preserved, ~20–40 lines of integer fixed-point, byte-identical Move/TS. Within-candle sub-prices are a deterministic cosmetic interpolation hitting the candle's O/H/L/C (settlement reads only the H/L extremes — §6.2).

### 15.4 Detection — fair by construction, not by running on-chain

`@wick/sdk/patterns.ts` is the predicate catalog — the 54 live patterns (§15.6), each a pure function `isX(window) → { matched, strength }` (`strength` ∈ 0.0–1.0, how cleanly the candles fit — the `yacpd` idea). Detection runs **client-side**, every frame, on a sliding window — the glow must be instant.

Client-side detection is still **fully fair**, and here is the proof:

> The candles are a deterministic function of on-chain randomness (§15.1); the predicates are public deterministic functions; therefore **every label is a verifiable consequence of on-chain data.** The operator cannot invent, suppress, mistime, or fake a label — anyone re-runs `expand_segment` then `detect` on the on-chain `segment_key`s and gets the identical labels. `/verify` does exactly this.

So detection does **not** need to be on-chain to be decentralised and fair — it needs to be a *pure function of on-chain-derived data*, which it is.
- **Visual-only (hackathon):** client-side detection; honesty anchored to the chain; nothing extra on-chain.
- **Scoring (post-hackathon):** if a rare pattern ever pays a bonus, `settle_ride` re-checks *that one claimed predicate* on-chain over the claimed candle range — a single cheap predicate evaluation — so money never moves on an unverified label.

### 15.5 One predicate library; the generation↔detection consistency guarantee

`patterns.ts` holds each predicate **once**. Three consumers, one definition — so generation and detection *cannot* disagree: (1) **generation guard** — tests assert every shaper's output satisfies its predicate; (2) **client detection** — live labelling; (3) **verification** — `/verify` replay.

**The consistency constraint** (a real failure mode, designed out): a shaper could produce a "bullish engulfing" a fractionally-stricter detector never labels. Prevented by the shaper's built-in margin (the `+0.5U` in §15.3). **Enforced by test:** for every hero pattern, generate it across 10k+ entropy draws, run the detector, assert it is labelled **100%** of the time. Generation and detection are co-verified.

### 15.6 The pattern catalog (FINAL)

Candlestick patterns are a **closed, standardised set** — TA-Lib's 61 `CDL*` functions are the canonical complete list. Every library surveyed (`candlestick`, `deno-talib`, `tats`, `pandas-ta`, `ta-lib-R`, `mfg-charts`, `yacpd`) implements a *subset*; none has a pattern outside the 61. The chart is continuous (§15.7) → patterns use their **continuous / crypto-style definitions** (a Morning Star is still a Morning Star without a literal gap). Net live catalog: **54 of 61.** Detection-only; vendor the union of the surveyed TS libraries.

- **Single-candle (17):** Doji · Dragonfly Doji · Gravestone Doji · Long-Legged Doji · Rickshaw Man · Takuri · Hammer · Inverted Hammer · Hanging Man · Shooting Star · Marubozu · Closing Marubozu · Spinning Top · High-Wave · Long Line · Short Line · Belt-hold
- **Two-candle (14):** Engulfing · Harami · Harami Cross · Piercing · Dark Cloud Cover° · Counterattack · Separating Lines · Matching Low · Homing Pigeon · On-Neck · In-Neck · Thrusting · Doji Star° · Hikkake
- **Three-candle (16):** Morning Star° · Evening Star° · Morning Doji Star° · Evening Doji Star° · Three White Soldiers · Three Black Crows · Identical Three Crows · Three Inside Up/Down · Three Outside Up/Down · Three Stars in the South · Tristar · Unique Three River · Advance Block · Stalled Pattern · Two Crows · Stick Sandwich
- **Four/five-candle (7):** Three-Line Strike · Concealing Baby Swallow · Ladder Bottom · Mat Hold° · Rising/Falling Three Methods · Breakaway · Modified Hikkake

`°` = kept using its **continuous definition**. **Dropped (7) — the gap *is* the pattern, or redundant on a gapless chart:** Kicking · Kicking-by-Length · Tasuki Gap · Gap Side-by-Side White · Upside Gap Two Crows · Up/Downside Gap Three Methods · Abandoned Baby (on a gapless chart it simply *is* a Morning/Evening Doji Star). **Shaped (deliberately generated) hero set — 6:** doji, hammer, shooting star, bullish engulfing, bearish engulfing, three white soldiers / three black crows. Post-hackathon shapers: harami, the star families, marubozu, tweezers. Larger *chart* patterns (head-and-shoulders, triangles) are detect-only, post-hackathon.

### 15.7 The gap question — DECIDED (2026-05-22)

**The chart is continuous — no gap mechanism, no price jumps.** It is a *synthetic* chart, fully under our control; there is no real exchange-close to model, so a visible "hole" would be a meaningless artefact. We use the **continuous / crypto-style pattern definitions** — exactly how 24/7 crypto charts read these. Only the ~7 patterns whose entire identity *is* the gap are dropped (§15.6). No gap mechanism is built; no extra days are spent. **Net catalog: 54 of 61 — final.**

### 15.8 The client display pipeline — highlight / overlay / tooltip / glow

The frontend, each frame: compute candles via `seededPath.ts` → run `detect()` on the sliding window → render four layers per detected pattern:
- **Highlight** — the pattern's candle(s) tinted / outlined.
- **Overlay** — a bracket or box framing the pattern's candle span.
- **Tooltip** — tap/hover → the pattern name, a one-line meaning, and an honest reliability note ("a weak bullish signal — not a guarantee").
- **Glow** — the celebration, scaled by `rarity × strength` (§15.9), reusing the existing money-emoji / screen-shake FX layer.

Detection that fires *anywhere* — a deliberately shaped pattern or one that emerged organically from the momentum walk — gets the full treatment; the chart reads like a real TA terminal. A Phase D task, ~2–3 days.

### 15.9 Predictiveness, rarity & celebration

**Predictiveness — a bounded, validated knob.** If a pattern reliably preceded a move, reading it would be a free edge → vault bleed; if it preceded nothing, it would be a cosmetic lie. The honest, realistic answer: **patterns are *weakly* predictive.** Strength = the momentum legacy each shaper leaves (§15.3) — one knob per pattern, **Monte-Carlo-validated (B7) so even optimal pattern-reading stays inside the house edge.** Pattern-reading is a real *sub-edge skill* — it narrows the edge, never flips it; the arcade becomes skill-influenced, not pure chance. (Organically-emerged labelled patterns carry only the walk's natural autocorrelation, which the base-walk Monte Carlo covers — every label's predictiveness routes through the one bounded `momentum`.)

**Rarity & celebration.** Each pattern has a **rarity tier** — `common / uncommon / rare / legendary` — calibrated from a frequency histogram over many seeds (a by-product of B7). The celebration scales with `rarity × strength`: common → quiet label · uncommon/clean → soft candle glow · rare/high-strength → the chart lights up (glow, particle burst, sound, a bold "⚡ RARE — Three-Line Strike") · legendary → full fanfare. The variable-reward loop — mostly small, occasionally a big *earned* hit. Hackathon: **visual only**, zero economics impact. Post-hackathon: scoring bonuses (needs B7 re-validation) and a "pattern dex" collection meta.

### 15.10 Phasing, cost & acceptance

- **Detection catalog** — port the 54 predicates → `@wick/sdk/patterns.ts`: **~3–5 days**.
- **Generation** — pattern FSM + 6 hero shapers (Move + TS, byte-identical; conformance + the §15.5 consistency test): **~4–7 days**, inside Phases A/B.
- **Client display pipeline** (§15.8): **~2–3 days**, Phase D.
- Detect-only chart patterns and the scoring / dex layers: post-hackathon.

**Acceptance** (supersedes §14.3 for the arcade): the chart must look *as alive as today* **and** show recognisable, correctly-labelled patterns. A TA-literate reviewer confirms the labels are genuine and the unlabelled stretches still look organic, not canned.
