# 03 — Mode Architecture, Onboarding, Progressive Disclosure

> **Status:** opinionated v1. Sibling specs (`01_degen_*`, `02_pro_*`) own the
> two modes themselves; this document owns the *shell* that holds them, the
> *onboarding* that gets users to the right one, and the *ladder* that grows
> a Degen into a Pro.

> **Anchors:** `frontend/src/App.tsx` (current 2-pane shell),
> `docs/design/v2/09_events_indexer_v2.md` § 3 (session keys),
> `docs/design/v2/10_demo_script_v2.md` (onboarding QR flow), AGENTS.md
> (trader-facing copy rules).

---

## 0. The thesis in one paragraph

Wick is two products fused at the spine: an arcade tap-game for people who
heard about it on TikTok, and a defined-risk options terminal for people who
already trade. The same Move package, the same TS SDK, the same indexer
serve both. The shell's job is to **route a user to the mode that fits their
intent within 5 seconds, never trap them there, and let them grow without
re-onboarding**. Modes are not skins on the same UI — they are different
information architectures over a shared state model. The boundary between
"shared" and "mode-private" is the load-bearing decision in this doc.

---

## 1. Mode detection and default rules — picked, justified

### 1.1 The decision

A new user lands in **Degen** if they're on a touch device or a viewport
narrower than 1024px, **Pro** otherwise. We override that default in two
cases:

1. The URL carries an explicit `?mode=` param (deep links, see §7).
2. The user has a stored preference in `localStorage` from a prior session.

**Heuristic order, first hit wins:**

```
1. URL ?mode=degen|pro            → use it (and persist)
2. localStorage.wick.mode         → use it
3. (touch === true) || (vw < 1024px) → degen
4. otherwise                       → pro
```

### 1.2 Why viewport, not referrer

Referrer-based routing (TikTok → Degen, Twitter → Pro) is a tempting
heuristic but it's brittle: in-app browsers strip referrers, the same
person opens the same link from three apps a week, and we'd be optimising
for our acquisition channel rather than the user's actual context. The
viewport is the user's actual context. If they're on a 13" laptop they
get the terminal. If they're on a phone they get the arcade. We don't
need a model for that.

Touch + width is good enough. iPad in landscape (1180px, touch) lands
in Pro by the rule above and that's the right call — an iPad in landscape
is closer to a laptop than to a phone, and Pro mode degrades gracefully
to touch where it has to (the trade panel still works with thumbs).

### 1.3 Why not "always Degen" as a default

The instinct in onboarding work is "default to the simplest thing." For
Wick that would mean every desktop user lands in the arcade and has to
discover Pro themselves. That's wrong because **the desktop user's
self-image is "I'm not a casual"** — they want to feel that the product
respects their seriousness, especially when the product is a derivative.
A pro who lands in Degen first will bounce because the product reads as
unserious. A casual who lands in Pro will bounce because the product
reads as inscrutable. Viewport is the cheapest signal that aligns with
self-image.

### 1.4 Why not "always Pro" as a default

Inverse argument. A mobile user who lands on the chain table on a 5"
screen will close the tab. The Degen surfaces (one-tap arcade card,
big TOUCH/NO-TOUCH buttons, payoff bars) are also the surfaces that
work on a phone. Defaulting Pro on mobile would be choosing brand
posture over user success.

---

## 2. Onboarding flow — wireframed, screen by screen, mode-aware

The onboarding is **three steps in both modes**, but the framing of each
step changes. The contract: a brand-new wallet should be in their first
trade in under 60 seconds, in either mode.

### 2.1 The three steps (shared)

```
STEP 1: Connect           "who are you"
STEP 2: Approve session    "stop signing every tap"
STEP 3: Faucet drip        "here's some testnet ammo"
```

Wallet connect happens **before** the first trade attempt, never inline
on the first tap. We tried inline-connect on the trade panel in an
earlier sketch; it conflated two cognitive loads and the drop-off was
brutal. Three short, sequenced screens beat one long modal.

### 2.2 Degen onboarding (mobile)

**Screen 0 — first paint (no auth).** The Arcade market is already
ticking. The user can watch the candle move for 5 seconds before any
modal appears. They tap a TOUCH/NO-TOUCH button to trigger onboarding.
*Don't gate the visual on connect.* The arcade is the hook.

**Screen 1 — Connect.** Bottom sheet (mobile native), 60% of viewport
height. Slush logo big, "Sign in with Slush" full-width button. Below:
two grey rows for Suiet and "Other wallets." No copy about
decentralisation or self-custody — that's noise. The headline is *"Your
account is your wallet — same one you'd use to pay for coffee."* That's
the right mental model for a Degen.

**Screen 2 — Session key.** This is the moment that breaks naive
onboarding flows. See §6. The bottom sheet replaces with: a single
sentence ("Approve once for tap-trading — no popups for the next
15 minutes"), a single illustration (a phone with a clock + a checkmark),
and a single button ("Approve session"). Beneath, in 11px grey: *"Limits:
0.5 SUI per tap, 10 SUI total, 15 minutes. Revoke anytime."* No mention
of cryptographic signatures, ed25519, nonces, ranges, or counterparty
caps. Those words live in the threat model. The Degen onboarding tells
the user the *promise*; the docs prove the promise.

**Screen 3 — Faucet drip.** Bottom sheet: "We sent you 5 SUI for the
arcade." Big checkmark. Auto-dismisses in 2 seconds. The user is now
back on the Arcade card, the TOUCH button glows, and tapping it executes
the trade with no further prompt. Total time from first tap to settled
trade: ~30s in the happy path.

**On second visit:** all of this is skipped. The wallet auto-reconnects,
the session key is checked (renew if expired), and the user lands
directly on whatever market they had open last.

### 2.3 Pro onboarding (desktop)

**Screen 0 — first paint (no auth).** The full Pro shell renders with
stub data (the existing `STUB_MARKETS` fixture) in place of live data.
Connect button is in the top bar; a thin banner along the top reads
*"Connect to trade — viewing demo data."* The user can scroll the
markets rail, hover the chart, and play with the trade panel slider —
all the payoff bars update — without connecting. *Let them tour the
terminal first.* Power users want to know what they're getting before
they commit to a wallet popup.

**Screen 1 — Connect.** Centered modal, 480px wide. Slush, Suiet, and
Sui Wallet listed inline. Copy: *"Connect a Sui wallet to place orders.
We never custody your funds."* No bottom sheet — Pro modals are modals.

**Screen 2 — Session key.** Pro users get a *more* technical version of
the same offer, not a less. Modal: *"Enable session signing for low-
friction trading."* Below: a small expandable panel (closed by default)
labeled *"Session limits and scope"* containing the actual caps:
`max_stake_per_market: 0.5 SUI`, `max_total_stake: 10 SUI`,
`expiry: 15 min`, `allowed_entry_fns: [buy_touch, buy_no_touch]`,
`max_per_counterparty_24h: 0.5 SUI`. This panel is what the threat
model promises a serious user can verify. They can also tick a box to
*not* enable session keys; in that case every trade gets a wallet popup,
which Pro users will grumble about but at least they had the choice.

**Screen 3 — Faucet drip.** Toast notification, top-right, persists for
5 seconds. Doesn't interrupt the workflow. The user is already in the
terminal.

### 2.4 Why this works

The Degen flow is bottom-sheet native and treats every screen as one
decision; the Pro flow is modal-native and stacks the technical detail
behind disclosures the user can choose to read. Same three steps, same
SDK calls, same on-chain effects. The framing is the only thing that
changes.

---

## 3. Toggle UX — where, when, how

### 3.1 The toggle lives in the user menu, not the top nav

A persistent prominent mode-toggle in the nav signals "you're in the
wrong mode" — which is exactly the wrong message. The mode is the
default; switching is the exception.

Top nav has: logo, market tabs (in Pro) or no tabs (in Degen), wallet
chip with avatar. Tapping the wallet chip opens a dropdown:

```
Wallet 0x12...ABCD   [copy]
Balance 47.8 SUI
─────────────────
Mode: Degen ▾        ← this is the toggle
Settings
Help
Disconnect
```

In Degen mode, the toggle reads "Mode: Arcade ▾" because *Arcade* is
the trader-facing word for it. In Pro mode it reads "Mode: Trader ▾".
Tapping it opens a small submenu with both options and a one-line
description of each. **No third "auto" option** — the auto-detection
runs once, on first paint, and after that the user has chosen.

### 3.2 First-trade discovery prompt

After a Degen user's first settled trade, a one-time, dismissible
toast appears: *"More controls? Switch to Trader mode anytime in your
wallet menu →"*. After a Pro user's first settled trade, no equivalent
toast — Pro users do not need to be told Degen exists.

### 3.3 Per-market override — no

We considered allowing per-market mode (e.g. always-Degen for Arcade,
always-Pro for BTC). It's tempting because the Arcade is genuinely a
casino and BTC is genuinely an instrument. But it makes the URL contract
muddier (see §7), it forces us to design four hybrid surfaces instead
of two, and a user who wants to play Arcade on a desktop can do so in
Pro without losing anything material — the trade panel still has the
big buttons. **One mode at a time, app-wide, per session.**

---

## 4. Progressive disclosure ladder — Degen → Pro nudges

The progressive disclosure question is "when do we tell a Degen user
that Pro exists?" The answer is *not* "after N trades" — that's a
Skinner-box framing and it converts at the wrong rate. The answer is
"when their behaviour reveals they would benefit from Pro."

### 4.1 The triggers (any one fires the nudge)

1. **Settled-trade count ≥ 10.** The user has commitment.
2. **Distinct markets traded ≥ 3.** The user is shopping, not just
   tapping the same Arcade card.
3. **Total stake-volume in 24h ≥ 50 SUI.** The user is sizing up.
4. **The user manually opens the position list and sorts it.** They're
   asking a question Pro mode answers.
5. **The user tries to use the limit-order surface in Degen** (which
   doesn't exist) — they tap the spot where they'd expect it. We
   instrument this absence-of-surface as a tap target with no action
   except logging.

When any of these fires, an in-context *banner* appears (not a modal).
Banner copy: *"You're trading like a pro. Want the chart, the order
book, and limit orders?"* with a single button: *"Try Trader mode."*
Dismissable forever with `[x]`.

### 4.2 The banner is one-shot, never recurring

If the user dismisses, we don't show it again. This is the load-bearing
discipline. Recurring nudges convert short-term and erode trust
long-term. A user who said "no" to Pro once has told us about their
preferences; we listen.

### 4.3 The ladder in the other direction (Pro → Degen)

Mostly nonexistent. A Pro user who's bored or distracted is not the
Wick team's problem to solve, and offering to dumb down their UI is
patronising. The one exception: a brand-new Pro user who hasn't placed
a trade in their first 90 seconds *might* see a one-time tooltip on
the trade panel — *"For one-tap mode, switch to Arcade in your wallet
menu."* Tooltip, not banner. Disappears on hover.

---

## 5. Cross-mode state sharing — what persists, what doesn't

The principle: **everything material to the user is shared; everything
ephemeral to the layout is not.** This is the table.

| State | Shared across modes? | Storage |
|---|---|---|
| Wallet connection (`connectedAddress`) | Yes | dapp-kit |
| Session key cap (`SessionKeyCap` object id) | Yes | sessionStorage (per-tab, per §6.6 of design 09) |
| Open positions | Yes | derived from chain |
| Realised + unrealised PnL | Yes | derived from chain |
| WICK token balance | Yes | derived from chain |
| Badges + achievement progress | Yes | derived from chain (badge IDs only) |
| Tournament entries + leaderboard rank | Yes | derived from chain + indexer |
| Watchlist / pinned markets | Yes | localStorage (see §7) |
| Mode preference itself | Yes | localStorage |
| Responsible-trading toggle | Yes | localStorage |
| Selected market (which one is "open") | **No** — per mode | URL state |
| Trade-panel draft state (slider position, side toggle, stake) | **No** — per mode | in-memory only |
| Chart timeframe + indicator settings | **No** — Pro only | localStorage scoped to Pro |
| Layout preferences (panel widths, collapsed rails) | **No** — Pro only | localStorage scoped to Pro |
| Onboarding-step completion | Yes | localStorage |

### 5.1 Why selected market is per-mode

Because the modes have different concepts of "selected." Degen has *one*
market on screen at a time; Pro has a *primary* market and a watchlist
in the rail. Carrying "selectedId" across mode boundaries would mean
switching from Pro (watching SP500 with an open chart) to Degen and
finding the Arcade card replaced by SP500, which is jarring. Better:
when you switch modes, each mode shows you whatever it'd show you on a
fresh visit *plus* honours the last-active market in that mode.

### 5.2 Why draft state is per-mode

If a user is mid-trade in Degen with the slider at 0.3 SUI and side
toggled to TOUCH, switching to Pro should *not* prefill the Pro trade
panel with those values. The Pro panel has different defaults, a
different scale (more decimals on the slider), and probably a different
market open. Discarding draft state on mode switch is the honest
choice. A confirm-before-switch ("you have unsubmitted draft, lose it?")
might be added if we see complaints. We won't add it pre-emptively.

### 5.3 What the user sees after switching modes mid-trade

Degen → Pro: the user lands on the Pro shell with the same market
selected (overriding Pro's last-active to honour intent), the trade
panel empty. A one-time toast: *"Your draft was discarded — Trader
mode uses different presets."*

Pro → Degen: same, mirror. The user lands on the Degen card for the
last-active Pro market (or Arcade if it doesn't exist in Degen — every
Pro market exists in Degen, but the inverse isn't true; see §11).

---

## 6. Session keys + wallet — one-signature flow shared

The session-key spec lives in `09_events_indexer_v2.md` § 3. Here we
spec the *user-facing* flow that wraps it. It is **identical across
modes** in mechanism; the framing differs.

### 6.1 The shared mechanism

1. User connects wallet → dapp-kit returns `connectedAddress`.
2. SDK checks `sessionStorage.wick.session_key` for an existing,
   unexpired cap. If present, skip to step 5.
3. SDK builds a `create_session_key_cap` PTB with conservative defaults
   (per § 3 of design 09): `lifetime_ms = 5min` (Pro can extend to
   max 24h via the disclosure panel; Degen is fixed at 5min and
   silently auto-renews on use), `allowed_entry_sigs = [buy_touch,
   buy_no_touch]`, `max_stake_per_market = 0.5 SUI`,
   `max_total_stake = 10 SUI`, `max_per_counterparty_24h = 0.5 SUI`,
   `max_loss_per_session = 5 SUI`.
4. Wallet popup with decoded-PTB summary (per § 3.4 of design 09).
   Single signature. Cap object created on-chain.
5. SDK derives an ephemeral keypair (the session key itself), stores
   the private key in `sessionStorage`, and uses it to sign every
   subsequent trade PTB. The cap object verifies the signature
   on-chain, no further wallet popups until expiry.

### 6.2 Auto-renewal in Degen

When a Degen session key has < 60s remaining, the SDK silently builds
a new `create_session_key_cap` PTB and surfaces it through the wallet
*on the next user-initiated tap*, not pre-emptively. The framing on
the resulting popup: *"Renewing your session — same limits, 15 more
minutes."* In Pro, the same renewal happens but the user can opt out
in the wallet-menu settings ("renew silently" toggle, default on).

### 6.3 What we tell the user the session key does

In Degen: *"Tap-trade for 15 minutes without popups."*
In Pro: *"Sign once, trade until expiry. Limits enforced on-chain."*
In the threat model link from both: the full A4–A17 mitigation chain.

We do not use the words *cryptographic*, *ed25519*, or *nonce* in any
on-screen string. Those words are *correct* and we do not lie about
them — they live in `wick.markets/threat-model` which is one tap from
both modes. They simply do not belong in the trade flow.

### 6.4 Revocation surface

In both modes: wallet menu → "Active session" row showing the time
remaining and a small "Revoke" button. One-tap revoke calls
`session_key_cap::revoke` and the next trade attempt re-runs the
onboarding flow's session-key step. This is **the same revocation
button in both modes** — same component, same code path.

---

## 7. Route + URL structure — deep links and sharing

### 7.1 The contract

Modes are URL-determined when an explicit `?mode=` param is present;
otherwise they're inferred from the §1 detection rules. The base path
is the *same* for both modes — the URL structure does not branch on
mode.

```
/                            → markets index
/m/:marketId                 → a specific market
/m/:marketId?mode=degen      → force Degen
/m/:marketId?mode=pro        → force Pro
/portfolio                   → positions + P&L (rendered per mode)
/leaderboard                 → leaderboard (rendered per mode)
/tournaments/:id             → tournament detail (per mode)
/threat-model                → static doc, no mode
/help                        → static doc, no mode
```

`/m/:marketId` is the canonical share-able URL. Markets are addressed
by their on-chain object ID (or a slug that maps to one — see §7.3).
The mode is *intentionally* not in the path because share-links should
respect the *receiver's* preference, not the sender's.

### 7.2 Deep-link mode resolution

1. URL has `?mode=`: honour it.
2. URL has no `?mode=`: run §1 detection (touch / viewport / saved
   pref).

A pro shares `/m/abc...123` from their desktop terminal. A friend opens
it on a phone and lands in Degen, on the same market, in the right
context. That's the right behaviour. If the pro wants to pin the mode,
they can append `?mode=pro`. We do not auto-append the sender's mode
because that would let viral share-links accidentally drag everyone
into the wrong context.

### 7.3 Slugs for memorable markets

`/m/btc-touch-67400` is friendlier than `/m/0x031f...e7d7`. The slug
maps to the object ID via the indexer's `markets.slug` column (unique).
Slugs are ASCII, lowercase, dash-separated, ≤ 64 chars, set at market
creation by the keeper or admin (never by users). Demo markets have
hand-picked slugs; programmatic markets get
`{collateral}-{kind}-{barrier}-{expiry_short}`.

### 7.4 Notifications and deep links

A push notification ("BTC touched! +0.42 SUI") deep-links to the
position-detail surface, *not* the trade panel. The position-detail
URL is `/m/:marketId#pos-:positionObjId`. The mode is whatever the
user is in (or whatever §1 picks if the app's been killed). The
*notification copy* is mode-aware (Degen: "Boom — you won 0.42 SUI 🟢";
Pro: "BTC-TOUCH-67400 settled +0.42 SUI"). Notification copy is one
of the very few places we treat the modes as having different *voices*
in addition to different layouts.

---

## 8. Frontend architecture — file structure and code-reuse boundary

### 8.1 The structure

```
frontend/src/
├── App.tsx                          # mode router + onboarding gate
├── main.tsx
├── modes/
│   ├── degen/
│   │   ├── DegenShell.tsx           # full-bleed mobile shell
│   │   ├── ArcadeCard.tsx           # the big TOUCH/NO-TOUCH card
│   │   ├── DegenTradePanel.tsx
│   │   ├── DegenPortfolio.tsx
│   │   └── onboarding/
│   │       ├── ConnectSheet.tsx
│   │       ├── SessionKeySheet.tsx
│   │       └── FaucetSheet.tsx
│   └── pro/
│       ├── ProShell.tsx             # the existing 2-pane App.tsx, refactored
│       ├── MarketsRail.tsx
│       ├── MarketHeader.tsx
│       ├── PriceChart.tsx
│       ├── ProTradePanel.tsx
│       ├── PortfolioPanel.tsx
│       └── onboarding/
│           ├── ConnectModal.tsx
│           ├── SessionKeyModal.tsx
│           └── FaucetToast.tsx
├── shared/
│   ├── PayoffBars.tsx               # used by both trade panels
│   ├── MarketBadge.tsx
│   ├── BarrierStrip.tsx
│   ├── TimerPill.tsx
│   ├── CountdownRing.tsx
│   ├── WalletMenu.tsx               # the dropdown with mode toggle
│   ├── ThreatModelBanner.tsx
│   └── DisclaimerStrip.tsx
├── components/ui/                   # shadcn primitives, mode-agnostic
├── hooks/
│   ├── useMode.ts                   # detection + persistence
│   ├── useSessionKey.ts
│   ├── useLiveMarkets.ts
│   ├── usePortfolio.ts
│   ├── useWalletBalance.ts
│   └── useOnboardingState.ts
├── lib/
│   ├── sui.ts
│   ├── transactions.ts              # PTB builders, mode-agnostic
│   ├── queries.ts
│   ├── format.ts
│   └── utils.ts
├── config/
│   └── deployment.json
└── fixtures/
    └── markets.ts
```

### 8.2 The reuse boundary

**Allowed shared:** any pure-presentational component whose *meaning*
is constant across modes (a payoff bar shows the same payoff in Degen
and Pro). Any data-shaped hook (markets, portfolio, balance) — these
are mode-agnostic by definition; the chain doesn't know about modes.
Any PTB builder. Any formatter, validator, or type.

**Forbidden shared:** any layout component, any onboarding screen, any
trade-panel composition, any chart configuration. The temptation to
build a `<TradePanel mode={mode}>` with branching JSX is real; resist
it. Two clean implementations diverge gracefully; one branched
implementation calcifies into a component that does neither well.

The discipline is: **shared components do not know about modes**. If
a shared component needs to behave differently in two modes, it's
not shared — it's two components that happen to share a name. Move
the divergence up into `modes/`.

### 8.3 Code-splitting

Each mode is its own dynamic-import boundary:

```ts
const DegenShell = lazy(() => import('./modes/degen/DegenShell'));
const ProShell = lazy(() => import('./modes/pro/ProShell'));
```

The detector in `useMode` runs synchronously on first paint, then the
chosen mode loads. Switching modes triggers the other chunk to load
on demand. The shared bundle (chain hooks, wallet adapter, shared
components) loads once and stays. Target gzipped sizes: shared bundle
≤ 180KB, Degen chunk ≤ 90KB, Pro chunk ≤ 220KB. Pro is heavier
because it includes lightweight-charts and the order-book renderer.

### 8.4 What we refactor from today

The current `App.tsx` is the seed of `ProShell.tsx`. We move it
verbatim into `modes/pro/ProShell.tsx`, then build a new
`modes/degen/DegenShell.tsx` from scratch. The top-level `App.tsx`
becomes a 30-line router that picks a shell. The existing components
under `components/market/*` either move into `modes/pro/` or get
promoted to `shared/` based on the §8.2 rule. The current
`PortfolioPanel` is shared today but should split — Degen's portfolio
view is a stack of position cards with big P&L numbers, Pro's is the
existing table.

---

## 9. Theming strategy — two design tokens, one component library

The brief says Degen is "glow-y casino" and Pro is "monospace IBKR."
Both ship in the same app and must not visually clash on mode-switch.

### 9.1 The shared anchors

Locked, do not vary across modes:

- `--color-touch: #22c55e` (green for the winning side)
- `--color-no-touch: #ef4444` (red for the losing side)
- `--color-warning: #f59e0b` (amber for time-sensitive states)
- Brand mark and wordmark: same SVG, same proportions, in both modes
- Geist font family: shared across both modes (Degen uses Geist Sans
  display weights; Pro uses Geist Mono for numerals)

### 9.2 The mode-specific tokens

Each mode owns a CSS custom-properties layer scoped to its shell root:

```css
.wick-mode-degen {
  --color-background: #0d0d10;
  --color-card: #1a1a20;
  --color-accent: #C5FF3D;     /* lime, for TOUCH glow */
  --color-text: #ffffff;
  --color-text-muted: rgba(255,255,255,0.65);
  --shadow-cta: 0 0 24px rgba(197,255,61,0.45);
  --radius-card: 24px;
  --font-display: 'Geist', system-ui, sans-serif;
  --font-numeric: 'Geist', system-ui, sans-serif;
  --type-scale-base: 17px;     /* mobile-readable */
}

.wick-mode-pro {
  --color-background: #0a0a0a;
  --color-card: #161616;
  --color-accent: #C5FF3D;     /* same anchor — different intensity */
  --color-text: rgba(255,255,255,0.92);
  --color-text-muted: rgba(255,255,255,0.55);
  --shadow-cta: none;
  --radius-card: 4px;
  --font-display: 'Geist', system-ui, sans-serif;
  --font-numeric: 'Geist Mono', ui-monospace, monospace;
  --type-scale-base: 13px;     /* dense terminal */
}
```

Same brand. Different intensity. **Degen uses glow, rounded corners,
and slightly larger type** to read as fun-and-tactile. **Pro uses
hairlines, sharp corners, and monospaced numerals** to read as serious
and information-dense. The lime accent appears in both — in Degen as
a glow on the CTA, in Pro as a thin underline on the active tab — and
that's how a returning user instinctively recognises both screens as
*the same product*.

### 9.3 Mode switch animation

Mode switch is a 220ms cross-fade. No layout slide, no glow burst, no
"loading" spinner. The new shell fades in over the old shell. This
keeps the perceived weight of the switch low — the user shouldn't feel
they've taken a flight, just changed rooms.

---

## 10. Notifications, deep links, help, disclosures — cross-mode story

### 10.1 Notifications

Push notifications go through the same SSE-derived event firehose in
both modes. The notification *copy* is mode-aware (see §7.4) but the
deep-link target and the underlying data are not. A user who flipped
to Pro mid-day and then went home and opened the push from Degen on
their phone lands on the right position regardless. The system reads
the user's mode preference from the URL or localStorage; it does not
remember "the position was opened in Pro, force Pro."

### 10.2 Help / docs

Help lives at `/help` and is a single static doc with mode-agnostic
language. Linked from both modes via the wallet menu. Includes:
*"What is a touch option?"*, *"How does settlement work?"*, *"What's
a session key?"*, *"How do I revoke?"* The help doc deliberately uses
trader-facing copy (touch, wick, sweep) rather than mode-specific
nicknames (tap-game, arcade) because help is a stable surface that
needs to make sense in both contexts.

### 10.3 Threat model

`/threat-model` is the production-honest doc per design v2. Both modes
link to it from:

- The wallet menu ("Verify the protocol")
- The session-key disclosure panel (in Pro, inline; in Degen, a small
  "How is this safe?" link below the approve button)
- The footer of every page (a single discreet "Verify" link, leading
  to the threat model). Mirrors the closer-slide right QR in the demo
  script.

### 10.4 Disclaimers

Three disclosures live in both modes:

1. **Testnet banner.** Top of viewport, single line, lime background.
   *"Testnet — funds aren't real. Not a financial product."* Same
   string, same colour, same position in both modes. Cannot be
   dismissed.
2. **Risk strip on first trade.** First trade attempt of every session
   triggers a one-line strip below the trade panel: *"Options can
   settle worthless. Max loss = your stake."* In Degen this is built
   into the bottom sheet. In Pro it's a strip above the bet button.
3. **Bankruptcy-clause acknowledgement.** First-ever trade for a
   wallet shows a one-time modal in both modes: *"In rare correlated-
   load conditions, payouts may be delayed or partially haircut. This
   is disclosed on-chain. [Read the clause]."* Single button,
   *"I understand."* Persisted forever per wallet (`localStorage` keyed
   by address; chain-attestation is post-MVP).

### 10.5 Compliance copy lives in `shared/`

Because we ship the same legal language in both modes, the components
that render disclosures are shared. They are the only *content-bearing*
shared components in the architecture — every other shared component
is presentational. This is fine: the law doesn't care about modes.

---

## 11. Implementation phases — order of work

The opinionated phasing.

### 11.1 Phase 0 — refactor (1–2 days)

Move the existing `App.tsx` into `modes/pro/ProShell.tsx` and build the
top-level mode router. No behavioural change. Add `useMode`,
`useSessionKey`, `useOnboardingState` as stubs. Verify the existing
demo flow still works in `?mode=pro`. **No Degen UI yet.** The Pro
mode is the existing product; we're making it accept a sibling.

### 11.2 Phase 1 — Degen MVP (1 week)

Build `DegenShell` with: Arcade card only, no markets rail (single
market on screen at a time, swipe between markets), big TOUCH/NO-TOUCH
buttons, payoff bars (reused from `shared/`), session-key onboarding
sheets, faucet sheet, mode toggle in wallet menu. Deliberately skip:
portfolio view, leaderboard, watchlist. **The Degen MVP is one screen
deep**, and the test is "can a brand-new user place a settled trade on
mobile in 60s." Until that test passes, no other Degen surface gets
built.

### 11.3 Phase 2 — Cross-mode plumbing (3–4 days)

`useMode` actually persists, `useSessionKey` shares across modes,
URL deep-links work in both, the §10 disclosures are uniformly
rendered, the wallet menu is a single shared component, the toggle
fires the cross-fade. The progressive disclosure ladder (§4) ships
here, instrumented but visually subtle. After Phase 2 the two modes
genuinely behave like one product with two skins.

### 11.4 Phase 3 — Degen depth (1 week)

Portfolio view (stacked cards), leaderboard surface (mobile-friendly),
tournament entry flow, badge surfacing, share-card generator (the
"I won 0.42 SUI" share image). Now the Degen mode has reason to come
back to.

### 11.5 Phase 4 — Pro polish (concurrent with Phase 3, 1 week)

Limit-order surface, position-table sort/filter, multi-market chart
overlay, layout-preference persistence, the technical session-key
disclosure panel from §2.3. Pro's "depth" is mostly already there in
the existing shell; this phase is the upgrade from "trader's view" to
"trader's terminal."

### 11.6 Why Pro first refactor, then Degen MVP, not the other way

The existing codebase *is* Pro mode in embryonic form. Moving it
sideways into a `modes/pro/` namespace while keeping it working is a
small risk. Building Degen first while Pro is still in the root would
require either sharing components that aren't ready to be shared, or
building Degen against scratch — both are wasteful. Refactor takes
two days; we get a clean canvas for Degen on day three.

### 11.7 Why not side-by-side from day 1

We considered building both shells in parallel from a clean start.
The argument against: the existing Pro shell has been validated by the
user (the v3 2-pane layout per `feedback_v3_layout_is_the_target.md`).
Throwing that validation away to start fresh would be expensive
without being better. Starting from the validated baseline and adding
a sibling is the right play.

---

## 12. Open questions for v2 of this spec

- **Tablet handling.** The §1 rule sends iPad-landscape to Pro and
  iPad-portrait to Degen. That is the right default but the trade
  panel in Pro on a touch device needs touch-target sizing review.
  Defer until we have an iPad in hand at the booth.
- **Mode-sticky push notifications.** The current spec routes
  notifications to the user's *current* mode. A user who only ever
  trades in Pro and gets a Degen-styled push because they happened to
  open the app on their phone last is mildly weird. We may want a
  secondary preference: "deliver pushes in [Pro / Degen / last-active]
  voice." Defer until users complain.
- **Per-market mode hints.** A reactive-honest version of the
  per-market mode toggle (§3.3): markets *suggest* a mode in their
  metadata (Arcade prefers Degen, BTC is mode-agnostic, the future
  Range market prefers Pro), and we display a one-time *hint* on entry
  if the user is in the non-suggested mode for that market. Tempting
  but adds another nudge surface; revisit after live usage data.
- **Onboarding completion analytics.** We need to instrument
  drop-off at each onboarding step in both modes. The instrumentation
  itself is mode-agnostic but the funnels should be reported separately.
  Spec this in `04_observability.md` (TBD).
- **Wallet-menu mode toggle on touch.** The Degen wallet menu being
  a dropdown inside a chip in the top bar may not be touch-friendly
  enough; it might need to become a bottom sheet on tap. UX-test on
  Phase 1.

---

*End of mode architecture spec. The decisions to remember: viewport-
detect default, persist in localStorage, toggle in the wallet menu,
share state via the chain (not the layout), one signature per session,
URL is mode-neutral by default, two modes are two implementations
with one shared primitives library, refactor Pro before building
Degen. The rest is detail.*
