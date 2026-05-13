# 09 v2 — Event Schema, Indexer & Off-Chain Stack (HARDENED)

> Status: **v2 hardened spec.** Supersedes `docs/design/09_events_indexer.md` for any code shipped after 2026-05-12. v1 stays canonical for the work-in-progress until each subsystem migrates.
>
> Ingests the v1 design and the 20-attack red team in `docs/redteam/09_indexer_frontend.md`. Every attack from A1–A20 is traced to a concrete control in §7.
>
> Anchors: `wick_oracle`, `path_observation`, `random_walk_driver`, `pull_oracle_driver`, `vault`, `market`, `wick` (existing); `predict_driver`, `wick_token`, `martingaler_queue`, `fee_router`, `risk_config`, `position_token`, `lp_token`, `tournament`, **`session_key_cap`** (planned).
>
> Off-chain: `keeper/`, `api/` (Fastify), `indexer/` (new), `frontend/` (Vite+React+TS).
>
> Storage: Postgres 16 + TimescaleDB (Neon on Vercel) + Redis (Upstash on Vercel) for hot pubsub + transactional outbox.

---

## 1. Threat-driven design principles (carry through every section)

1. **Chain is the source of truth.** Off-chain is a cache. Every claim of state must be reproducible from `suix_queryEvents` over the canonical package id.
2. **Publish-then-commit is wrong.** Use a transactional outbox: project → write → enqueue publish in the same SQL tx; a separate worker drains the outbox to Redis. This closes A16.
3. **Parameterised everything.** No raw SQL path exists. Drizzle/Kysely + JSON-schema-validated route inputs. Closes A14.
4. **Sanitise at the indexer boundary.** No string from on-chain reaches the API without passing `sanitizeBadgeText` / `sanitizeMarketName` / `assertWhitelistedTypeTag`. Closes A6+A7.
5. **Explicit canonical-domain hardening.** SRI on every script tag, pinned CSP, signed SSE payloads, bundle-scan for env leaks. Closes A3, A6, A13, A15, A19.
6. **Session keys are an on-chain capability, not a SDK convenience.** Caps, scopes, nonces, per-counterparty limits enforced in Move. Closes A4, A5, A17.
7. **Tournament prizes settle by on-chain rank-proof, not by API claim race.** Closes A12.

---

## 2. Event schema v2

Everything from v1 §2 stands; the v2 additions are listed here. The full type tag (`${packageId}::${module}::${struct}`) is the only valid projector dispatch key — see §4.4.

### 2.1 Cross-cutting additive fields

Every event struct gains the following two implicit fields when surfaced through the indexer (added by the projector, not on-chain):

- `canonical_package_id: Hex32` — the package id the indexer recognises this event under, written from the deployments allow-list. Anything that doesn't match an allow-listed id is **rejected and logged**, never projected (closes A7).
- `event_id: "{tx_digest}:{event_seq}"` — the only safe at-least-once cursor key.

### 2.2 Session-key events (NEW domain)

```move
public struct SessionKeyCreated has copy, drop {
    cap_id: ID,
    owner: address,
    session_pubkey: vector<u8>,           // 32-byte ed25519
    expiry_ms: u64,                        // hard cap: now + 24h, validated on-chain
    allowed_entry_signatures: vector<vector<u8>>, // hashes of `${pkg}::${mod}::${fn}`
    allowed_market_kinds: vector<u8>,     // 0=touch_no_touch only (MVP)
    max_stake_per_market: u64,
    max_total_stake: u64,
    max_loss_per_session: u64,
    max_per_counterparty_24h: u64,        // A4 fix
    initial_nonce: u64,                   // monotonic, A17 fix
    created_at_ms: u64,
}

public struct SessionKeyUsed has copy, drop {
    cap_id: ID,
    nonce: u64,                           // strictly > previous on-chain nonce
    market_id: ID,
    counterparty_address: Option<address>, // settled or AMM (None for AMM)
    side: u8,
    stake: u64,
    used_at_ms: u64,
}

public struct SessionKeyRevoked has copy, drop {
    cap_id: ID,
    revoked_at_ms: u64,
    reason: u8,                           // 0=user, 1=expired, 2=cap_breach, 3=admin
}
```

### 2.3 Updated `MarketSettled` (settlement state captured explicitly)

```move
public struct MarketSettled has copy, drop {
    market_id: ID,
    oracle_id: ID,
    settlement_price: u64,
    touched: bool,
    settled_at_ms: u64,
    final_vault_balance: u64,
    settlement_state: u8,                  // 0=normal, 1=cancelled, 2=oracle_failure_refund
    settlement_root: vector<u8>,           // SHA256 over (market_id, all touched_at events)
    settlement_proof_height: u64,          // checkpoint at which settlement was decided
}
```

The `settlement_root` is the merkle/hash root that anchors the rank-proof flow in §9. Indexer mirrors it into `markets.settlement_root` and refuses to mark any position redeemable until it has this row.

### 2.4 `BadgeAwarded` with canonical-package marker

```move
public struct BadgeAwarded has copy, drop {
    user: address,
    badge_kind: u8,
    awarded_at_ms: u64,
    source_event_digest: vector<u8>,
    canonical_package_marker: vector<u8>, // == sha256("wick-canonical-v2" || package_id)
    badge_name_id: u32,                   // INTEGER ID, never freeform string
    badge_template_version: u8,
}
```

Critical change vs v1: **`name` and `description` are not on-chain strings.** Move-side mints carry only a `badge_name_id` (`u32`) which the indexer maps to a hard-coded, sanitised template registry shipped with the frontend. Closes A6 at the source: there is no string field for an attacker to inject HTML into.

### 2.5 Tournament settlement events (rank-proof flow)

```move
public struct TournamentLocked has copy, drop {
    tournament_id: ID,
    locked_at_ms: u64,
    final_entry_count: u64,
    pnl_root: vector<u8>,                 // SHA256 root over (rank, address, pnl)
}

public struct TournamentPrizeClaimed has copy, drop {
    tournament_id: ID,
    rank: u32,
    address: address,
    prize: u64,
    claimed_at_ms: u64,
    nonce: u64,                           // == rank, only valid once
}
```

`TournamentSettled.winners/prizes` from v1 are deprecated — they made the API the prize ledger. v2 makes the **chain** the prize ledger via `TournamentPrizeClaimed`. See §9.

### 2.6 All other v1 events

Unchanged in shape but their projectors must use the full type tag and the `canonical_package_marker` check from §2.1.

---

## 3. Session-key spec v2

### 3.1 On-chain capability object

```move
module wick::session_key_cap {
    public struct SessionKeyCap has key, store {
        id: UID,
        owner: address,
        session_pubkey: vector<u8>,           // ed25519
        expiry_ms: u64,                        // hard-capped to now + 24h at create
        allowed_entry_sigs: VecSet<vector<u8>>,// sha256("${pkg}::${mod}::${fn}")
        allowed_market_kinds: VecSet<u8>,
        max_stake_per_market: u64,
        max_total_stake: u64,
        consumed_total_stake: u64,
        max_loss_per_session: u64,
        realised_loss: u64,
        max_per_counterparty_24h: u64,
        per_counterparty: Table<address, CounterpartyTally>,
        last_nonce: u64,                       // monotonic; signature must increment
        revoked: bool,
    }

    public struct CounterpartyTally has store, drop {
        cumulative_stake: u64,
        first_seen_ms: u64,                    // for 24h sliding window reset
    }
}
```

### 3.2 Restrictions enumerated (every check that runs on every use)

1. **Expiry**: `clock_ms <= cap.expiry_ms`. `expiry_ms` is hard-capped at `created_at + 24 * 60 * 60 * 1000` at create (validated in `create_session_key_cap`). Default UI-suggested lifetime: **5 minutes** (per A4 mitigation). Hard ceiling: 24h. Anything longer reverts on-chain.
2. **Function whitelist**: `sha256("${pkg}::${mod}::${entry_fn}") IN cap.allowed_entry_sigs`. Whitelist is set at create-time from a manifest of approved trade functions; no admin can mutate. Excludes `transfer_position`, `withdraw`, `redeem` (closes A5).
3. **Market kind**: caller must show that the market it's acting on has `market.kind IN cap.allowed_market_kinds`. MVP allows only `0 = touch_no_touch`.
4. **Per-trade stake cap**: `stake <= cap.max_stake_per_market`.
5. **Cumulative stake**: `cap.consumed_total_stake + stake <= cap.max_total_stake`.
6. **Per-counterparty 24h**: when the trade is matched against an identifiable counterparty `cp`, increment `cap.per_counterparty[cp].cumulative_stake` and assert `<= cap.max_per_counterparty_24h`. If `clock_ms - first_seen_ms > 24h`, reset the tally first. **This is the A4 fix: enforced in Move, not SDK.**
7. **Nonce**: signature payload commits to `(cap_id, next_nonce)` where `next_nonce > cap.last_nonce`. After verification, `cap.last_nonce := next_nonce`. **Signatures cannot be replayed across operations** (A17 fix).
8. **Realised-loss kill switch**: when a position settles a loss against this cap, `cap.realised_loss += loss`. If `cap.realised_loss > cap.max_loss_per_session`, mark `cap.revoked = true`.
9. **Revocation**: `revoke_session_key_cap(cap, owner_signer)` flips `revoked = true` instantly; takes precedence over all other checks.

### 3.3 Counterparty identification

When a trade clears against the AMM, `counterparty = None`. When a trade clears against a specific position (DeepBook CLOB match for option positions), `counterparty = position_owner`. Self-counterparty escape (A4) requires routing through an identifiable counterparty, so the per-counterparty cap is the load-bearing fix.

The cap defaults to `max_per_counterparty_24h = 5% of max_total_stake`. UI surfaces this as: **"You can lose at most 5% of your session budget against any single counterparty in 24 hours."**

### 3.4 Wallet popup decoded PTB summary (A5 fix)

The Wick SDK builds the PTB and **always** ships an out-of-band `decoded_summary` to Slush:

```ts
type DecodedPtb = {
  intent: 'trade' | 'redeem' | 'deposit' | 'create-session-key' | 'revoke-session-key',
  human_summary: string,         // "Buy TOUCH on BTC≥70k expiring in 28s, stake 1.5 SUI"
  calls: Array<{
    fn: string,                  // "wick::market::buy_touch"
    package: string,             // canonical package id, displayed
    canonical: boolean,          // true iff matches deployments/testnet.json
    args_decoded: Record<string, string | number>,
  }>,
  ownership_changes: Array<{from: string, to: string, asset: string}>, // any non-zero entry → red banner
  hash_to_compare: string,       // sha256 of the full PTB; UI shows the same hash
}
```

If `calls.canonical = false` for any call, the SDK refuses to send to the wallet (frontend-side). If `ownership_changes` includes a `transfer_position`, the SDK requires a separate, full master-key signature — never session-keyed.

---

## 4. Indexer architecture v2

### 4.1 Topology

```
+-----------+   poll      +---------+   pg COPY   +----------+   outbox    +---------+
| Fullnode  | <---------- | indexer | ----------> | Postgres | ----------> | Outbox  |
| RPC ×3    |   500ms     | (Node)  |   (txn)     |  + outbox|             | drainer |
+-----------+             +---------+              +----------+             +---------+
   |                                                    |                       |
   | quorum                                             |                       |
   v                                                    v                       v
[3-of-3 agree]                                  [reorg detector]         [Redis pubsub]
                                                                                |
                                                                                v
                                                                       [signed SSE → FE]
```

### 4.2 Polling and quorum (A2 fix)

Three independent fullnode RPCs (Mysten public + Triton + Shinami). Cursor advances only when ≥2 nodes return the **same set of `(tx_digest, event_seq)` pairs for a given checkpoint range**. If quorum cannot be reached within 5s, the indexer halts cursor advancement and pages on-call.

The cursor itself is now **double-keyed**: `(checkpoint_seq, last_event_id_within_checkpoint)`. `checkpoint_seq` is the primary monotonic key — never trust event-ID ordering across fullnodes (this is what made A2 possible in v1).

### 4.3 Reorg handling

Sui has BFT finality — checkpoints don't roll back. But the indexer guards anyway:

1. Each polled batch records `(checkpoint_seq, checkpoint_hash)` from `getCheckpoint`.
2. On every poll, the indexer fetches the hash for the last 4 finalised checkpoints and compares to its stored hashes.
3. **If any stored hash differs from the live hash for the same `checkpoint_seq`, the indexer:**
   - rolls back projector state for every event in that checkpoint and later (using `events.checkpoint` as the inverse-projection cursor),
   - re-fetches events for the affected range from quorum,
   - re-projects deterministically,
   - emits an `IndexerReorgDetected` admin event.
4. The 1-checkpoint safety buffer (v1 §4) stays. v2 adds a hash-equality check on every safe-cursor advance.

### 4.4 Idempotency and dispatch

- `events` table has `UNIQUE(tx_digest, event_seq)`. INSERT … ON CONFLICT DO NOTHING.
- Projectors dispatch on the **full type tag** `${packageId}::${module}::${struct}`. The package id MUST appear in the `deployments/testnet.json` allow-list. Suffix matching is forbidden (closes A7). CI rule (`scripts/check-projector-keys.sh`) greps the projector source for `endsWith` / `includes` against type tags and fails the build.
- Per-event projector functions are pure `(prevState, event) -> nextState` with `INSERT … ON CONFLICT DO UPDATE` semantics. Re-running a projector over an already-projected event MUST be a no-op.

### 4.5 Publish-then-commit fix — transactional outbox (A16 fix)

Inside the same Postgres transaction that writes to derived tables and advances the cursor, the indexer also writes to `events_outbox`:

```sql
CREATE TABLE events_outbox (
  outbox_id    bigserial PRIMARY KEY,
  channel      text NOT NULL,                -- e.g. 'wick:events:market:0xABC'
  payload      jsonb NOT NULL,
  signature    bytea NOT NULL,               -- ed25519 over (channel || payload)
  created_at   timestamptz DEFAULT now(),
  published_at timestamptz                   -- NULL until drained
);
CREATE INDEX events_outbox_pending ON events_outbox (outbox_id) WHERE published_at IS NULL;
```

A separate `outbox-drainer` process polls `WHERE published_at IS NULL ORDER BY outbox_id LIMIT 500`, publishes to Redis, then sets `published_at = now()`. If the drainer crashes, on restart it re-publishes all unpublished rows — pubsub subscribers dedupe on `(tx_digest, event_seq)` from the payload. **The atomicity of the project + outbox write means we cannot have a published-but-uncommitted state, nor a committed-but-unpublished state past the next drainer poll** (A16 closed).

### 4.6 Heartbeat + lag banner (defence-in-depth for A16)

- `/v1/health` exposes `cursor_lag_ms = now - last_safe_checkpoint_ts`.
- SSE channels emit a heartbeat frame every 5s with `latest_outbox_id`.
- Frontend banner if `cursor_lag_ms > 5000` or if heartbeat gap >10s — "Indexer behind chain. Refresh to verify."

### 4.7 Reproducibility

Same as v1 §9 plus a new mandatory check: **divergence checker** (see §11) runs every 60s in production for the first 30 days post-mainnet. Compares 50 sampled markets' on-chain object reads against the corresponding `markets`/`positions` rows; alarms on mismatch.

---

## 5. API security v2

### 5.1 Stack

Fastify 4 + `@fastify/helmet` + `@fastify/cors` + `@fastify/rate-limit` + `@fastify/jwt`. Drizzle ORM exclusively for queries. **No `pg.query` raw call sites are allowed; ESLint rule `no-restricted-imports` blocks `pg` direct usage outside the `db/` package.**

### 5.2 Parameterised queries (A14 fix)

- All queries go through Drizzle's typed query builder.
- Every route input is JSON-schema validated by Fastify before reaching a handler. Example for `/v1/leaderboard`:

  ```ts
  const querystring = {
    type: 'object',
    properties: { window: { type: 'string', enum: ['24h', '7d', '30d'] } },
    required: ['window'], additionalProperties: false,
  } as const;
  ```

- Postgres role split: `wick_api` is `SELECT`-only on derived tables, no DDL, no `pg_read_server_files`. `wick_indexer` has DML on the indexer-owned tables. `wick_admin` is human-only and not used at runtime.
- CI: `scripts/sqlmap-staging.sh` runs `sqlmap` against the staging API for every PR that touches `api/`.

### 5.3 JWT-authenticated SSE (A15 fix)

All SSE endpoints (`/v1/markets/:id/ticks/stream`, `/v1/leaderboard/stream`, `/v1/martingaler/:id/queue/stream`, `/v1/tournaments/:id/leaderboard/stream`) require `Authorization: Bearer <jwt>`. The JWT is issued by `POST /v1/auth/sign-in` after the user proves control of an address by signing a fresh server-issued nonce (Sui personal-message signing). Token TTL = 1h, sliding refresh on use. Anonymous clients get `401`.

### 5.4 Signed SSE payloads (A15 fix, layered with §5.3)

Every SSE frame carries an HMAC-SHA256 over `(event_type, event_id, payload_json)` with a key from Vercel env. The frontend SSE client verifies before dispatching to React state. Tampered payloads logged + dropped.

### 5.5 Rate limits and connection caps (A8, A10 fix)

- Per-IP: 60 req/min on REST, 3 concurrent SSE.
- Per-JWT: 600 req/min on REST, 6 concurrent SSE.
- Per-(IP, target-address) on `/v1/positions?owner=` and `/v1/users/:addr/*`: 10 req/min (A10).
- Server-side per-SSE-connection write-buffer cap of 64 KB; exceed → kill connection (A8).
- SSE fronted by Vercel Edge to absorb slow-loris.

### 5.6 CORS (A13 fix)

```ts
fastify.register(cors, {
  origin: (origin, cb) => {
    const allowed = [
      'https://wick.markets',
      'https://www.wick.markets',
      /^https:\/\/wick-markets-[a-z0-9-]+\.vercel\.app$/, // preview branches
    ];
    if (!origin || allowed.some(a => typeof a === 'string' ? a === origin : a.test(origin))) cb(null, true);
    else cb(new Error('CORS denied'), false);
  },
  credentials: true,
});
```

Wildcards are forbidden in production; CI fails the build if `Access-Control-Allow-Origin: *` is reachable from a credentialed route.

### 5.7 CSP and security headers

Set on every API response and every frontend HTML response (matches the canonical-domain hardcoding from H7):

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'sha256-<hash>' ;            // SRI hashes per script
  style-src 'self' 'sha256-<hash>';
  img-src 'self' data: https://cdn.wick.markets;
  connect-src 'self'
              https://api.wick.markets
              https://fullnode.testnet.sui.io
              https://triton-sui-testnet.example
              https://shinami-sui-testnet.example;
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self';
  upgrade-insecure-requests;
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
Referrer-Policy: same-origin
Permissions-Policy: geolocation=(), microphone=(), camera=()
```

### 5.8 Bundle-secret lint (A19 fix)

CI step `scripts/check-vite-secrets.sh`:

```bash
grep -RE '(VITE_[A-Z_]+)\s*=\s*[^[:space:]]*(key=|secret|token|private)' .env* frontend/.env* && exit 1
grep -RE '(blastapi\.io|alchemy\.com|infura\.io)/[a-zA-Z0-9_-]+' frontend/dist/ && exit 1
```

All authenticated RPC routes through a server proxy on the API. The frontend never sees an RPC key.

---

## 6. Frontend security v2

### 6.1 Anti-phishing (A3, A20 fix)

- **Canonical domain pinned in code**: `CANONICAL_HOST = 'wick.markets'`. On boot, the app compares `window.location.host` to the canonical and renders a full-screen interstitial if mismatched ("You are not on the official Wick site").
- **Verified-domain registry**: submit `wick.markets` to the Sui ecosystem dApp registry and to the Slush "verified dApp" list pre-launch so wallet popups show a green check on the canonical and no badge on clones.
- **Defensive registrations**: `wick.markets`, `wick-markets.io`, `wick-markets.app`, `wick-markets.xyz`, `wíck.markets` (punycode) — all 301 to canonical or to a phishing-warning page.
- **Education shipped in-app**: a permanent footer link "Verify the URL" opens a modal showing canonical URL, package id, and PGP signature of the build manifest.

### 6.2 SRI on every script tag

The Vite build emits `dist/index.html` with `<script integrity="sha384-..." crossorigin="anonymous" src="...">` for every chunk. Build step fails if any script tag in the final HTML lacks an `integrity` attribute. CDN script loads (Sentry, etc.) are forbidden — vendored to first-party origin instead.

### 6.3 Decoded-PTB display (A5 fix, mirrors §3.4)

Before any wallet `signTransactionBlock` call, the UI shows a modal with the `DecodedPtb` summary. The modal shows `hash_to_compare` and instructs the user to verify it matches the hash in the Slush popup. If `ownership_changes` is non-empty the modal banner is red and the "Sign" button is greyed out for 3 seconds.

### 6.4 Sanitised rendering (A6 fix)

- `dangerouslySetInnerHTML` is forbidden by ESLint rule `react/no-danger`.
- All user-derived strings are rendered as React text nodes (auto-escaped).
- Badge names are looked up in a static `BADGE_TEMPLATES: Record<u32, {name: string, description: string, icon: string}>` shipped in the bundle (frontend never reads a string from on-chain badge metadata; A6 closed).
- Markdown rendering (if added) uses `markdown-it` with `html: false` and a strict allow-list.
- Tooltip libraries: `@radix-ui/react-tooltip` only (no innerHTML). Banned imports CI rule.

### 6.5 SSE client

Verifies HMAC signature on every frame before dispatching to React state. Drops + logs invalid frames. Reconnects with `Last-Event-ID` on backoff `[1, 2, 5, 10, 30] * 1000ms`. Banner on the leaderboard / chart if the connection has been down >5s.

### 6.6 Local storage discipline

No session keys or signatures in `localStorage`. Session-key signatures live in `sessionStorage` (per-tab) and are purged on `beforeunload`. Sensitive UI state never persisted to `IndexedDB` without an explicit user opt-in toggle (closes the leak surface in A6).

### 6.7 Responsible-trading mode (A18 fix)

Single toggle in Settings: "Responsible mode" hides badge nudges, leaderboard rank deltas, and "you're 1 trade away from X" prompts. Default off, but the onboarding wizard explains it and offers one-click enable.

---

## 7. Mitigated attack table — all 20

| ID | Attack | v2 control(s) |
|---|---|---|
| A1 | Indexer-lag arb against retail | §2.3 settlement_state + on-chain `MAX_QUOTE_STALENESS` revert in `buy_touch`; quote endpoint surfaces `last_oracle_observation_ms`; honesty about MEV in README |
| A2 | Reorg-lite via single-fullnode partition | §4.2 multi-RPC quorum; checkpoint-seq cursor; daily reconciliation; §4.3 reorg detector via stored checkpoint hashes |
| A3 | Phishing clone w/ auto-connecting Slush | §6.1 canonical-host check; verified dApp registry; defensive domain registrations; §6.2 SRI; §6.3 decoded-PTB display |
| A4 | Session-key escape via self-counterparty | §3.2 per-counterparty 24h cap (Move-side); per-session loss cap; 5-minute default lifetime, 24h hard cap; §3.3 counterparty identification |
| A5 | Wallet-prompt confusion via PTB blindness | §3.4 + §6.3 decoded-PTB display; entry-function whitelist on session keys excludes `transfer_position`; canonical-package check refuses non-Wick calls |
| A6 | XSS via NFT badge name/description | §2.4 badges carry `badge_name_id: u32` not strings; §6.4 static `BADGE_TEMPLATES` lookup; CSP; ESLint `react/no-danger` |
| A7 | Spoofed `BadgeAwarded` via fuzzy dispatch | §4.4 full type-tag dispatch; allow-listed package ids; CI grep rule against `endsWith`/`includes` on type tags |
| A8 | SSE backpressure DoS | §5.5 per-IP/JWT SSE caps, 64KB write-buffer cap, Vercel Edge fronting; dedicated SSE pod |
| A9 | Redis pubsub exhaustion via event spam | §4.5 outbox-then-drain (rate-limits naturally); per-channel pubsub (per-market topic); per-package events-per-minute budget; market allow-list before publish |
| A10 | IDOR-style aggregation on `/v1/positions?owner=` | §5.5 per-(IP, target-address) rate limit; opt-in `users.privacy_flag`; bucketed PnL ranges for anonymous; privacy banner on connect |
| A11 | Cache-poisoned leaderboard timing | §8 tournament-specific 1s leaderboard recompute; `Cache-Control: no-store` on tournament endpoints; UI binds to SSE during active tournaments |
| A12 | Tournament prize claim race | §9 on-chain rank-proof claim; `claimed = true` only on confirmed `TournamentPrizeClaimed`; UI three-state (`claimable/pending/claimed`) |
| A13 | CORS misconfiguration | §5.6 strict allow-list; CI fail on `*` with credentials |
| A14 | SQL injection via `/v1/leaderboard?window=` | §5.2 ORM-only, JSON-schema validated inputs, ESLint `no-restricted-imports` against `pg`; SELECT-only role; sqlmap CI |
| A15 | SSE injection of fake "tournament won" | §5.3 JWT-auth SSE; §5.4 HMAC-signed payloads; UI builds claim URLs from a hardcoded route, never embeds URL from event |
| A16 | Indexer-of-record drift (publish-then-commit) | §4.5 transactional outbox; §4.6 heartbeat + lag banner; §11 divergence checker |
| A17 | Replay of session-key signature | §3.2 per-cap monotonic nonce; signature payload commits to `(cap_id, nonce, fn_sig, args_hash)` |
| A18 | Badge-criteria-as-dark-pattern | §6.7 Responsible mode; only achieved badges shown; no "N trades away" prompts |
| A19 | Frontend secret leakage via `VITE_*` | §5.8 CI grep for `key=`/`secret`/`token` in `VITE_*` and in `dist/`; server-side RPC proxy |
| A20 | Demo-day live attack: clone + RPC DoS | §6.1 canonical interstitial; §10 demo-day pivot script; tethered hotspot, 60pt URL on closer slide, judge phone-check |

---

## 8. Move pseudocode — session-key cap and per-counterparty checks

```move
module wick::session_key_cap {

    const E_EXPIRED: u64 = 1;
    const E_REVOKED: u64 = 2;
    const E_FN_NOT_ALLOWED: u64 = 3;
    const E_KIND_NOT_ALLOWED: u64 = 4;
    const E_STAKE_OVER_PER_TRADE: u64 = 5;
    const E_STAKE_OVER_TOTAL: u64 = 6;
    const E_LOSS_OVER: u64 = 7;
    const E_COUNTERPARTY_OVER: u64 = 8;
    const E_NONCE_REPLAY: u64 = 9;
    const E_LIFETIME_OVER_24H: u64 = 10;

    const MAX_LIFETIME_MS: u64 = 24 * 60 * 60 * 1000;
    const MS_24H: u64 = 24 * 60 * 60 * 1000;

    public fun create_session_key_cap(
        owner: &signer,
        session_pubkey: vector<u8>,
        lifetime_ms: u64,
        allowed_entry_sig_hashes: vector<vector<u8>>,
        allowed_market_kinds: vector<u8>,
        max_stake_per_market: u64,
        max_total_stake: u64,
        max_loss_per_session: u64,
        max_per_counterparty_24h: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ): SessionKeyCap {
        assert!(lifetime_ms <= MAX_LIFETIME_MS, E_LIFETIME_OVER_24H);
        let now = clock::timestamp_ms(clock);
        let cap = SessionKeyCap {
            id: object::new(ctx),
            owner: signer::address_of(owner),
            session_pubkey,
            expiry_ms: now + lifetime_ms,
            allowed_entry_sigs: vec_set::from_vec(allowed_entry_sig_hashes),
            allowed_market_kinds: vec_set::from_vec(allowed_market_kinds),
            max_stake_per_market,
            max_total_stake,
            consumed_total_stake: 0,
            max_loss_per_session,
            realised_loss: 0,
            max_per_counterparty_24h,
            per_counterparty: table::new(ctx),
            last_nonce: 0,
            revoked: false,
        };
        event::emit(SessionKeyCreated { /* fields... */ });
        cap
    }

    /// Called from inside every trade entry-fn that accepts a session key.
    public fun authorise_trade<C>(
        cap: &mut SessionKeyCap,
        signature: vector<u8>,
        nonce: u64,
        fn_sig_hash: vector<u8>,
        market: &Market<C>,
        stake: u64,
        counterparty: Option<address>,
        clock: &Clock,
    ) {
        let now = clock::timestamp_ms(clock);

        // 1. Lifecycle checks
        assert!(!cap.revoked, E_REVOKED);
        assert!(now <= cap.expiry_ms, E_EXPIRED);

        // 2. Nonce monotonicity (A17 fix)
        assert!(nonce > cap.last_nonce, E_NONCE_REPLAY);
        let payload = bcs::to_bytes(&(object::id(cap), nonce, fn_sig_hash, stake, counterparty));
        assert!(ed25519::verify(&signature, &cap.session_pubkey, &payload), E_NONCE_REPLAY);
        cap.last_nonce = nonce;

        // 3. Function whitelist (A5 fix)
        assert!(vec_set::contains(&cap.allowed_entry_sigs, &fn_sig_hash), E_FN_NOT_ALLOWED);

        // 4. Market-kind whitelist
        assert!(vec_set::contains(&cap.allowed_market_kinds, &market::kind(market)), E_KIND_NOT_ALLOWED);

        // 5. Per-trade and total stake caps
        assert!(stake <= cap.max_stake_per_market, E_STAKE_OVER_PER_TRADE);
        assert!(cap.consumed_total_stake + stake <= cap.max_total_stake, E_STAKE_OVER_TOTAL);
        cap.consumed_total_stake = cap.consumed_total_stake + stake;

        // 6. Per-counterparty 24h cap (A4 fix — load-bearing)
        if (option::is_some(&counterparty)) {
            let cp = *option::borrow(&counterparty);
            if (!table::contains(&cap.per_counterparty, cp)) {
                table::add(&mut cap.per_counterparty, cp,
                    CounterpartyTally { cumulative_stake: 0, first_seen_ms: now });
            };
            let tally = table::borrow_mut(&mut cap.per_counterparty, cp);
            // sliding 24h window reset
            if (now - tally.first_seen_ms > MS_24H) {
                tally.cumulative_stake = 0;
                tally.first_seen_ms = now;
            };
            assert!(tally.cumulative_stake + stake <= cap.max_per_counterparty_24h, E_COUNTERPARTY_OVER);
            tally.cumulative_stake = tally.cumulative_stake + stake;
        };

        event::emit(SessionKeyUsed {
            cap_id: object::id(cap), nonce, market_id: object::id(market),
            counterparty_address: counterparty, side: 0, stake, used_at_ms: now,
        });
    }

    /// Called from settlement when a position bound to this cap loses.
    public fun on_realised_loss(cap: &mut SessionKeyCap, loss: u64) {
        cap.realised_loss = cap.realised_loss + loss;
        if (cap.realised_loss > cap.max_loss_per_session) {
            cap.revoked = true;
            event::emit(SessionKeyRevoked {
                cap_id: object::id(cap), revoked_at_ms: 0, reason: 2 /* cap_breach */,
            });
        }
    }

    public fun revoke(cap: &mut SessionKeyCap, owner: &signer) {
        assert!(signer::address_of(owner) == cap.owner, E_REVOKED);
        cap.revoked = true;
        event::emit(SessionKeyRevoked {
            cap_id: object::id(cap), revoked_at_ms: 0, reason: 0 /* user */,
        });
    }
}
```

---

## 9. Tournament prize claim — on-chain rank-proof flow (A12 fix)

### 9.1 Why a rank-proof, not a winners-list

v1's `TournamentSettled.winners: vector<address>` invited a race: the API was the prize ledger, and 100 simultaneous claims hit the API while the on-chain `tournament::claim` was a scan over a vector. v2 makes the **chain authoritative for "who claimed what when"** and removes the API from the critical path.

### 9.2 Flow

1. **Lock.** When the tournament window closes, `tournament::lock(t)` computes a Merkle root over the sorted `(rank: u32, address, pnl: u64)` triples and emits `TournamentLocked { tournament_id, locked_at_ms, final_entry_count, pnl_root }`. The full sorted list is computed off-chain by the indexer (deterministic), published to the API, and pinned to Vercel Blob with the Merkle root anchored on-chain.

2. **Claim.** A winner constructs a Merkle proof of their `(rank, address, pnl)` leaf and calls:

   ```move
   public fun claim_prize(
       t: &mut Tournament,
       rank: u32,
       pnl: u64,
       proof: vector<vector<u8>>,
       ctx: &mut TxContext,
   ) {
       let claimer = tx_context::sender(ctx);
       assert!(t.locked, E_NOT_LOCKED);
       assert!(clock_ms(ctx) <= t.claim_deadline, E_DEADLINE);
       // Idempotency — bitmap of claimed ranks
       assert!(!bitset::contains(&t.claimed_ranks, rank), E_ALREADY_CLAIMED);

       let leaf = sha256(bcs::to_bytes(&(rank, claimer, pnl)));
       assert!(merkle::verify(&proof, &leaf, &t.pnl_root), E_BAD_PROOF);

       let prize = prize_for_rank(t, rank);                   // pure function of rank
       coin::transfer(coin::take(&mut t.prize_pool, prize), claimer);
       bitset::insert(&mut t.claimed_ranks, rank);

       event::emit(TournamentPrizeClaimed {
           tournament_id: object::id(t), rank, address: claimer,
           prize, claimed_at_ms: clock_ms(ctx), nonce: rank as u64,
       });
   }
   ```

3. **Indexer.** Marks `tournament_results.claimed = true` only on confirmed `TournamentPrizeClaimed`. The API surfaces three states: `claimable` (proof available, not yet claimed), `pending` (PTB submitted, not yet observed in events; auto-clears after 30s if no event), `claimed` (event observed). UI never grays the button optimistically.

4. **Server-side Redis lock** per `(tournament_id, address)` so a buggy double-tap on the UI doesn't submit two PTBs. Lock TTL = 60s, released on `TournamentPrizeClaimed` or expiry.

5. **Unclaimed prizes after `claim_deadline`** revert to `t.treasury` via `tournament::sweep_unclaimed`, which can be called by anyone but only after the deadline. Bitmap of `claimed_ranks` makes sweep O(N) over rank slots, no rescan of addresses.

This collapses the critical race to "did the chain accept the proof?" — there is no API claim-state to desync, and double-pay requires a Merkle collision (computationally infeasible) rather than an API timing window.

---

## 10. Demo-day failure pivots

For each failure mode, the on-stage script:

| Failure | Pivot script (verbatim) | Pre-staged backup |
|---|---|---|
| Pyth oracle stale | "Pyth has just gone stale on testnet — let me switch to a Wick-native SUI market, which uses our internal random-walk driver. Same UX, no external oracle dependency." | Random-walk SUI market created at start of demo, in left rail, kept open. |
| Aslan / oracle module paused | "We've paused Aslan — that's actually the safety circuit catching a stale feed working as designed. Watching it now flip back to a Wick-native market." | Random-walk SUI market in left rail. Talk track: "the pause is the feature." |
| RPC slow / rate-limited | "Public RPC is congested — we have a fallback to Triton. Switching now." | Triton RPC env var pre-set; one-click toggle in demo-mode UI banner. |
| Gas out / wallet empty | "I'll grab gas from the testnet faucet" → continue talking → use the **second pre-funded demo wallet** already connected in incognito tab. | Second wallet pre-funded with 100 SUI, second incognito tab open, signed in. |
| Chart pane dead (lightweight-charts crashed) | "Going to drop into the trade panel directly — the chart is decorative; the order book is the source of truth" — proceed without chart. | Trade panel works headless. Talk over it. |
| Wallet broken (Slush extension hung) | "Switching to a hardware-backed test wallet for the rest of the demo" — pull out **second laptop** with Sui CLI signing a pre-built PTB. | Second laptop, Sui CLI ready, PTB JSON files for each demo action staged on disk. |
| Wifi down | "We anticipated this — switching the demo to my hotspot, which we've been using as the backup all along." | Tethered hotspot already on, presenter laptop already on it. **Never use venue wifi.** |
| Phishing clone domain (A20) live | "Note the URL on the slide — `wick.markets`. If you scan the QR and land anywhere else, that's not us." | Closer slide has 60pt canonical URL; teammate phone-checks first three judges. |
| Indexer behind chain | UI lag-banner already says so. "The indexer is catching up — let me show the on-chain state directly via the explorer." | Sui explorer tab pinned with our package id. |
| API down entirely | "Going to demo from the explorer-direct view — the chain is the source of truth, the API is a convenience layer." | Sui explorer tab + pre-built CLI commands. |

Every pivot has a **single-sentence talk track** that frames the failure as an intentional design choice. **Practice each pivot once on the day-of dry run.** No pivot longer than 30 seconds.

---

## 11. Pre-mainnet checklist

Each item must be **green** in CI for at least 7 consecutive days before any mainnet deploy.

1. **Divergence checker.** A separate `divergence-checker` process samples 50 random markets every 60s, reads their on-chain state via 3 fullnodes (quorum), reads the corresponding `markets`/`positions`/`vault_state` rows, and compares. Any mismatch pages on-call and halts indexer cursor advancement until manually cleared. **Required: 30 days clean before mainnet.**
2. **Reorg simulation.** Run the indexer against a checkpoint range with one fullnode mocked to return a tampered hash. Verify the indexer detects, rolls back, and re-projects. Test passes deterministically.
3. **Outbox crash test.** Kill the indexer mid-batch (after Postgres commit, before drainer fires). Restart. Verify all unpublished outbox rows drain on restart, no events lost or doubled.
4. **Session-key fuzz.** 10k randomised attack scenarios over `authorise_trade`: replayed signatures, expired caps, over-stake, self-counterparty loops, sliding-window edge cases. All must abort with the correct error code.
5. **Tournament-claim race test.** 1000 simulated simultaneous claims against a settled tournament; assert each rank claimed exactly once, prize pool balances to zero, no double-pays.
6. **SQL injection sweep.** `sqlmap` run nightly against staging; zero findings for 30 consecutive days.
7. **CSP/SRI build gate.** `dist/index.html` has `integrity` on every script tag and the deployed CSP matches §5.7 byte-for-byte. Fail build on drift.
8. **Bundle-secret scan.** `scripts/check-vite-secrets.sh` clean. Build fails on a finding.
9. **Wallet popup decoded-PTB rendering review.** Manual UX review on Slush, Sui Wallet, Suiet — every demo PTB shows the human-readable summary and the hash matches the in-app display.
10. **Defensive domain registry.** All variants in §6.1 owned by Wick org and serving 301 to canonical or warning page.
11. **Verified-dApp registration.** `wick.markets` listed in the Sui ecosystem dApp registry with an icon and description; Slush shows the green check.
12. **External security audit.** Move modules and the off-chain stack reviewed by a third-party firm; all critical and high findings closed; medium/low findings tracked with explicit accept/fix notes.
13. **Load test.** 5k concurrent SSE clients, 60 events/s sustained, 5 minutes. p95 end-to-end latency ≤ 1.4s. No OOMs. No dropped frames at the SSE layer.
14. **Backup wallets, hotspot, second laptop.** Confirmed in the team's "demo-day kit" inventory. Tested 24h before any user-facing event.
15. **`/v1/health` SLO dashboard.** Cursor lag, last event age, RPC ping, outbox depth, drainer lag. Alerts wired to PagerDuty.

Mainnet deploy is gated on **all 15** items green. No exceptions; H7 owner signs off in writing.

---

## Open questions for v3

- **Predict driver event re-indexing:** do we mirror Predict's events, or only resolve via `oracle_id`? Decision needed before Predict-route markets ship.
- **Multi-collateral keying:** confirm `(market_id, collateral_type)` is the primary key on `vault_state` — currently `vault_id` is, which assumes one vault per `(market, coin)`.
- **Session-key UX defaults:** should the UI default to a 5-minute cap with no per-counterparty allowance against any single address? Conservative MVP seems right; revisit after first 90 days.
- **Tournament-leaderboard incremental compute:** §8 of v1 says "compute incrementally on every `PositionRedeemed`" — confirm Postgres can sustain this at 60+ events/s under a busy tournament. May need a Redis sorted-set live cache.
