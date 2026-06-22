# Wick Markets — Demo Script v2 (Production-Honest Edition)

> ⚠️ **Era note — read first.** This is the v2-era 3-minute *presentation* script
> (wallet-based `buy_touch` flow, Arcade + threat-model framing). The **shipped,
> judge-facing demo is now no-wallet**: **Wick Pro** ([`/pro`](https://wick-markets.vercel.app/pro))
> — one-tap Black-Scholes options off a live DeepBook mark — and the tap-hold
> **Ride** ([`/ride`](https://wick-markets.vercel.app/ride)). For the current
> runnable walkthrough use [`DEMO.md`](../../../DEMO.md) (the 60-second judge
> guide) and the [README](../../../README.md); treat the wallet/Arcade beats
> below as historical pitch context. The *thesis* (verify-it-yourself, production-
> honest) is unchanged and stronger than ever — see `npm run judge` / `npm run safety`.

> Sui DeepBook hackathon submission. v2 incorporates 9 hardening specs
> (H1–H12) and 137 redteam findings. Total runtime: 3:00.
>
> **The thesis change since v1:** the credibility multiplier is the
> threat model itself. We are not pitching "trust us." We are pitching
> "verify the multisig, read the threat model, see the on-chain
> wind-down clause." Papertrade does this. We are doing it harder.

---

## 0. What changed from v1

The v1 script (`docs/design/10_demo_script.md`) leads with a visceral
candle-wick moneyshot. v2 keeps that hook — the chart wicking through
the barrier with confetti is still the lead frame — but **the closer
pivots from "scan to play" to "scan to play *and* read our threat
model."** The new closing slide carries two QR codes side by side.

The narrative arc shifts from *spectacle → composition → invitation*
to *spectacle → composition → invitation + audit trail*. The spoken
runtime is unchanged. The screen real estate on the closer reflows.

Five new framing lines are inserted into Acts 2 and 3, each tagged
below as **[NEW]**. They are the specific phrases that turn three
hardening tasks (H1, H9, H10) into demo-day features.

---

## 1. The Hook (0:00 – 0:15)

Same as v1.

**Spoken (15s):**
> "Watch this candle. *(touch fires, confetti)* That just paid me.
> I'm Max — this is Wick Markets, touch options on Sui. Polymarket
> asks where BTC ends. Wick asks whether BTC wicks into a level —
> and we settle in 30 seconds, not 30 days. Let me show you."

**On screen during the hook:** the Markets rail with four cards —
`BTC-USD`, `SUI-USD`, `SP500`, `Arcade (Random Walk)`. Live tape
ticking on the right (the four personality bots producing organic
activity). New v2 detail: a small **"audited threat model"** badge
in the bottom-right corner of the layout, dim grey, doesn't compete
with the tape but is visible if a judge looks for it.

---

## 2. Three-Act Structure

### Act 1 — Problem + Product (0:00 – 0:45)

Same 30-second framing as v1. New v2 sentence inserted at the end:

> "Prediction markets are slow. Perps get rugged by a single wick. We
> built the in-between: short-dated, defined-risk, path-dependent. If
> the price *touches* your level any time in the round, you win the
> full payout — even if it falls back. That's the product. Four lines
> of code separate Wick from a parimutuel: a CPMM, paired claims, an
> oracle observation, and a barrier-crossed flag. Everything else is
> composition. **[NEW]** And before we shipped a line of it, we
> red-teamed our own design with ten adversarial agents and found 137
> attacks. The threat model is on the closer slide."

That last sentence is the credibility multiplier. Drop it like it's
nothing. Confidence sells the line.

### Act 2 — Live Demo (0:45 – 2:15)

90 seconds, four scenes. Same beats as v1; new lines in Scenes 3 + 4
(see § 3).

### Act 3 — Technical Wow (2:15 – 3:00)

45 seconds, four punches. v2 changes one of the four wows:
- 4.1 PTB composition — unchanged
- 4.2 Position objects — unchanged
- 4.3 Pluggable oracle — unchanged
- **4.4 [REVISED] Martingaler LP + fair-launch WICK + production-honest hardening** — see § 4.4

Closer (last 30s) — see § 5. Rewritten for v2 to incorporate the
threat-model QR.

---

## 3. Scene-by-Scene Live Demo

> **Always-works backup is built in.** The Arcade (random-walk)
> market ticks every 5 seconds in the contract itself — no external
> oracle, no RPC roulette. Lead with Arcade. Use BTC for the
> composition flex *after* you've already shown a working settlement.
> If BTC falls over, the demo is still complete.

### Scene 1 — Connect + Faucet (0:45 – 1:00, 15s)

Identical to v1. No changes.

### Scene 2 — Arcade Touch, the always-works moneyshot (1:00 – 1:30, 30s)

Identical to v1. The Arcade market is the load-bearing demo: random
walk inside the contract, no external dependency, confetti fires on
touch. This is the moment that buys you the rest of the pitch.

### Scene 3 — BTC Touch composing with DeepBook Predict (1:30 – 1:55, 25s)

Same beats as v1, with one new framing line.

**Presenter does:**
1. Use the slider to drop the barrier just above current price (~$67,400 on a $67,200 spot).
2. Click **TOUCH** → wallet popup. The PTB preview shows two move calls in one transaction — `wick::market::buy_touch` and `predict::oracle::observe`.
3. Approve. Position appears.

**Presenter says (v2):**
> "This is the BTC market. One Programmable Transaction Block. One
> signature. Two protocols touched atomically: my buy goes into Wick,
> and *in the same transaction*, Wick reads a fresh observation from
> DeepBook Predict's live testnet deployment. We don't wrap Predict
> — we *compose* with it. The barrier resolves against the same price
> stream their own markets settle on. **[NEW]** And the keeper that
> publishes those observations isn't *us* — it's a 2-of-3 multisig
> with one external signer. Even our own protocol team can't
> unilaterally rewrite oracle truth."

That last sentence is the H1 hardening becoming a feature. The judges
who care about oracle integrity (almost all of them) hear it. The
ones who don't notice it as marketing.

### Scene 4 — Position on DeepBook CLOB + WICK token mint (1:55 – 2:15, 20s)

Same beats as v1, with one new framing line at the end.

**Presenter does:**
1. Click **List on DeepBook → 0.55 SUI ask**. PTB fires. The drawer flips and shows "Live ask on DeepBook v3 BTC-TOUCH-67400 book."
2. Switch to the **Arcade** market still running. Tap **DOWN** on a market that's already wicked up. Watch it expire against you in 5 seconds.
3. The losing position card shows: **"You minted 1,240 WICK at curve rate 0.0021 SUI/WICK."**

**Presenter says (v2):**
> "Two more things. First — your touch position is a Sui object with
> `key, store`, so it's tradeable. One click and it's a live ask on
> the DeepBook v3 CLOB. The judges can see the order in their
> explorer. Second — losing isn't dead money. Every loss mints WICK,
> our LP claim token, on a fair-launch curve. No premine. No team
> allocation. The only way WICK gets minted is by losing on Wick.
> **[NEW]** And the curve is fair from day 1 — the genesis-week
> mint dampener makes sure the first $20k of cumulative loss can't
> get monopolized by a whale who happens to be watching the
> deployment block."

That last sentence is the H3 hardening becoming a feature. It's also
the polite version of "we read the redteam doc that flagged front-run
of the mint curve threshold and we shipped the dampener."

---

## 4. The Technical Wow (2:15 – 3:00)

Four highlights, ~10 seconds each. Don't read them — point at them
on screen.

### 4.1 Atomic multi-leg via Sui PTBs

(Same as v1.)

### 4.2 Position objects, not wrapped Coin types

(Same as v1.)

### 4.3 Pluggable oracle, identical Move call site

(Same as v1.)

### 4.4 Martingaler LP + fair-launch WICK + production-honest hardening (revised v2)

**The flex:** the LP starts empty. The first trader's loss seeds the
pool. WICK is minted *to the loser* at a curve rate that decays as
cumulative losses grow. Losers become long-term LPs. There is no
premine, no VC allocation, no token sale.

**The new v2 flex:** every admin parameter has a Move-enforced upper
bound. We can't grant ourselves a bigger position cap than 5% of the
vault. We can't drop the base fee below 25 bps. We can't lift the
side-exposure cap above 30%. The package upgrade key is a 2-of-3
multisig with a 2-week timelock. **The protocol's own team cannot
silently make it more dangerous.**

**Why it's hard:** most LP tokens require LPs. Most fair launches
require a launch event. The Martingaler curve does both jobs at
once. And most "narrow scope" admin caps are documentation, not
Move asserts. We made the asserts the source of truth.

**Why Sui:** fast finality + cheap object creation lets us mint a
`WICK` claim per losing position with no gas guilt. Move's
expression of bounds at the function-signature level lets us
*encode* the threat model into the type system, not just the prose.

**Spoken (10s):**
> "And the production-honest part: every admin tunable has a
> Move-enforced cap. The package upgrade key is multisig with a
> 2-week timelock. If the queue ever exceeds 30 days of volume, an
> on-chain function flips the protocol into orderly wind-down — and
> we say so on-chain, in advance. The threat model is on the QR."

This is where the H9 + H10 hardening becomes a structural argument.
Don't oversell — the *tone* is "of course we did this." That's how
you signal it's serious.

---

## 5. The Closer (2:30 – 3:00)

The v1 closer was a single QR pointing to the live Arcade market.
The v2 closer is **two QR codes side by side**, framed as a single
invitation. The visual changes; the spoken runtime does not.

### Closing slide layout (v2)

Dark slide. Top: the wordmark **WICK** in 200px Geist Sans, lime.
Below: one line — *"Touch options on Sui. Always on. Settle in 30
seconds. 137 attacks named, 10 hardening specs shipped."*

Center: two 350px QR codes, side by side, with a thin vertical
divider between them.

- **Left QR:** "Play" — resolves to the deployed app with the
  Arcade market open. Lime corner pixels.
- **Right QR:** "Verify" — resolves to the threat model in this
  repo (`docs/threat-model.md`). White corner pixels.

Below the QRs, two short labels in Geist Mono 24px:
- Left: `wick.markets/play`
- Right: `wick.markets/threat-model`

Bottom-left: testnet badge + package ID truncated.
Bottom-right: GitHub URL.

The "Verify" QR is the explicit signal. A judge who scans it lands
on a 4500-word document categorizing 137 named attacks. They will
not read it during the next pitch. They will read it on the plane
home. Either way: the *existence* of the document on the closer
slide is the credibility statement.

### Spoken closer (30s, revised v2)

> "Everything you just saw is live, on Sui testnet, in this repo.
> Forty Move tests. Full collateral conservation proven to the mist.
> Four oracle backends behind one call site. A real DeepBook
> Predict composition for BTC. A real CLOB listing for the Position
> object. And a real fair-launch token whose only mint path is
> losing on Wick. Two QR codes. Left one — scan, open Slush, hit
> the faucet, the Arcade is always running. Right one — our threat
> model. We red-teamed our own design and named 137 attacks; the
> v2 hardening covers every Critical and High. Read it on the plane
> home. Trade it now. I'll be at the booth. Thanks."

The "read it on the plane home" line is the call to action for
serious judges. The "trade it now" line is the call to action for
visceral judges. Both QRs serve both groups.

---

## 6. Backup Plans (revised v2)

The v1 backup plans cover RPC slowness, Predict pause, Pyth stale,
wallet exhaustion, frontend break, internet drop. v2 adds three
demo-day failure pivots that incorporate the indexer v2 brief and
the threat-model framing.

| Failure mode | Pivot |
|---|---|
| **Testnet RPC slow / 5s+ tx finality.** | Open with the Arcade scene only. Skip BTC, narrate from `/demo/btc-touch-fallback.mp4`. (Unchanged from v1.) |
| **Aslan's DeepBook Predict deployment is paused.** | Frontend detects this on load; BTC card shows `predict-paused` pill. Pivot Scene 3 to **SUI-USD** (Pyth Lazer-backed). (Unchanged from v1.) |
| **Pyth Lazer pushes are stale.** | SUI-USD greys out, "stale > 30s." Pivot to **SP500** (independent Lazer feed). (Unchanged from v1.) |
| **Demo wallet runs out of gas.** | Two backup wallets in demo controller; `Cmd+Shift+W` rotates. Faucet button live. (Unchanged from v1.) |
| **Chart panel doesn't load (frontend bug).** | Pivot to position-only narrative; show position card update from bot tape. (Unchanged from v1.) |
| **Slush wallet extension misbehaves.** | Backup: Suiet preinstalled. Backup-backup: WalletConnect QR from phone. (Unchanged from v1.) |
| **Internet drops entirely.** | Final fallback: `/demo/wick-3min-final.mp4` pre-staged in tab. Don't hit play unless wifi is verifiably down. (Unchanged from v1.) |
| **[NEW] Indexer goes down or lags > 5s.** | The Arcade chart is sourced directly from the chain via the SDK, not the indexer — Arcade is unaffected. The Markets rail's bot tape will pause. Acknowledge it: "the live tape is paused, our indexer's backed up, that's fine — Arcade reads on-chain." Don't try to debug live. The closer slide's right QR (threat model) explicitly mentions indexer-lag arbitrage as Attack A1 in `09_indexer_frontend.md`; if a judge asks, point to it. |
| **[NEW] Multisig keeper fails to publish a Lazer tick during the demo window.** | The price feed greys out for the affected market. Pivot to Arcade. Acknowledge it as a feature: "that's the multisig keeper refusing to publish — when only one of the three signers agrees, the truth doesn't update. That's working as designed." This is a *positive* failure mode for the production-honest framing. |
| **[NEW] Threat model QR fails to resolve (404 / DNS).** | Backup URL pre-printed on the closer slide as text below the QR (`wick.markets/threat-model` or, in worst case, `github.com/maxmohammadi/sui-options/blob/main/docs/threat-model.md`). The text URL is also valid; the QR is just convenient. Don't apologize. "Type it in" is fine. |

**Demo controller hotkeys (v2):**
- `1`–`4`: jump to scene 1–4 (unchanged)
- `B`: play the BTC fallback clip (unchanged)
- `R`: reset all positions and fund the wallet (unchanged)
- `Cmd+Shift+W`: rotate to next backup wallet (unchanged)
- **[NEW] `T`**: jump to the closer slide (when you've successfully
  burned a minute on a Q&A and need to land the QR on screen fast)
- **[NEW] `H`**: open the threat model in a side panel (for live Q&A
  that requires pointing at a specific attack)

---

## 7. Visual Storyboard — Six Screens (revised closer)

Screens 1–5 are unchanged from v1. Screen 6 (the closer) is rewritten.

### Screen 6 — Closer / dual-QR (v2)

Dark slide, `#0A0A0B` background. Lime accent `#C5FF3D`.

Top: **WICK** wordmark, 200px, Geist Sans, lime.

Sub-headline: *"Touch options on Sui. Always on. Settle in 30
seconds. 137 attacks named, 10 hardening specs shipped."* Geist Sans,
40px, white at 80% opacity.

Center: two QR codes side by side, 350px each, with a 1px lime
vertical divider between them.

- **Left QR (Play):** lime corner pixels, label below in Geist Mono
  24px: `wick.markets/play`. Sub-label: *"Arcade market. Always on.
  Faucet on the page."*
- **Right QR (Verify):** white corner pixels, label below in Geist
  Mono 24px: `wick.markets/threat-model`. Sub-label: *"137 attacks.
  10 hardenings. Multisig keeper. On-chain wind-down clause."*

Bottom-left: `testnet · package 0x031f…e7d7`.
Bottom-right: `github.com/maxmohammadi/sui-options`.

Negative space below the QRs is intentional. The slide should feel
*serious*, not crowded. The lime/white contrast on the QRs subtly
signals "fun thing on the left, sober thing on the right" — which is
exactly the protocol's two faces.

---

## 8. Questions Judges Will Ask (v2 additions)

The v1 questions Q1–Q8 are unchanged. v2 adds three new likely
questions arising from the production-honest framing.

### Q9 — "What's actually in the threat model? Is it real or marketing?"

> Real. We ran ten adversarial agents against ten subsystems — vault,
> WICK token, oracle, impact fee, cross-market PTBs, Predict route,
> DeepBook CLOB, tournaments, indexer/frontend, economic governance.
> Each pass produced 12–20 named attacks with severities, exploit
> walkthroughs, and proposed mitigations. 137 total. The headline
> finding is that the worst attacks aren't bugs — they're emergent
> properties of correlated load (the Queue-of-Doom) and bearer-cap
> custody (the keeper). v2 ships hard caps in Move, multisig wraps
> on the dangerous caps, a 2-week timelock on package upgrades, and
> a disclosed bankruptcy clause that fires automatically if the
> queue exceeds 30 days of volume. The threat model PDFs the corpus
> into a single audit-ready document. It's the right QR on the
> closer.

### Q10 — "What's the bankruptcy clause? Why disclose it?"

> The Martingaler vault tolerates negative equity by enqueuing
> winner obligations. Under correlated load — for example, every
> entrant in a tournament wins on the same side — the queue can
> grow beyond plausible drain horizon. The protocol stays nominally
> solvent but the "winners always paid" promise calcifies. We disclose
> the failure mode by hard rule: if the queue exceeds 30 days of
> daily volume, an on-chain function flips the vault into orderly
> wind-down. Existing queue entries take a pro-rata haircut to bring
> the queue to under 50% of vault. The protocol survives. Late
> winners share the loss. We say all of this in the README at launch
> and in the threat model now. Disclosing it converts product fraud
> into a product term. **If we ever can't pay, we say so on-chain,
> in advance.**

### Q11 — "Why a 2-of-3 multisig keeper if you don't have on-chain Lazer verification?"

> Because the perfect is the enemy of the good. On-chain Lazer
> signature verification is the right answer; it's task #78 on the
> roadmap, post-hackathon. Until that ships, the keeper has *some*
> trusted role — but a 2-of-3 multisig means an attacker has to
> phish two operators in separate jurisdictions to corrupt oracle
> truth, instead of one. That's not a cryptographic guarantee; it's
> a coordination cost. We disclose this in § 7.1 of the threat model
> as an accepted residual risk. Real users should size accordingly
> during the keeper-trust window. We commit to publishing the
> on-chain verifier within 90 days of mainnet launch.

---

## 9. Materials Checklist (v2 additions)

The v1 checklist (40+ items) is unchanged. v2 adds these.

**Threat model + closer slide:**
- [ ] `docs/threat-model.md` exists, current version, and the URL
  `wick.markets/threat-model` resolves to it (or a deployed render
  of it) on the demo machine and the backup phone.
- [ ] Closer slide rendered with both QRs at 350px each. Test scan
  with Slush (left QR) and Safari/Chrome on iOS + Android (right
  QR) at the actual projection screen distance from the audience.
- [ ] Backup URL printed as text below each QR in case the QR fails.
- [ ] PDF version of the threat model uploaded to a fast static host
  (Vercel, Netlify) so the right-QR resolution is < 1s.

**Multisig demo readiness:**
- [ ] Multisig keeper actually configured as 2-of-3 on testnet (not
  a single-key with a comment claiming multisig). The presenter
  must be able to point at the multisig object on the explorer
  during Q&A if asked.
- [ ] AdminCap multisig + UpgradeCap multisig configured on testnet.
- [ ] One pre-staged "AdminParamChangeProposed" event visible in the
  explorer for demo Q&A.

**Production-honest framing:**
- [ ] Presenter has practiced the "[NEW]" lines in Scenes 3, 4, and
  the closer at conversational pace. The lines must land *with*
  the visual, not *despite* it.
- [ ] Presenter has practiced the answers to Q9, Q10, Q11 once each.
  The bankruptcy-clause answer (Q10) is the one that wins serious
  judges. Don't ad-lib it.

---

## 10. Pitch Language Polish (v2 dictionary updates)

The v1 dictionary (10 don't/say pairs) is unchanged. v2 adds these.

### Don't say "audited." Say "red-teamed."

We have not been formally audited as of the hackathon submission.
External audits are scheduled for hackathon + 30 days. *Audited*
implies an external firm has signed off; *red-teamed* implies we
attacked our own design and shipped fixes for what we found. The
distinction matters. Use *red-teamed* until the audit reports are
public. Then use *audited by [firm], red-teamed internally*.

### Don't say "trust us." Say "verify the multisig."

Every time you would have said "we control the keeper" or "we hold
the AdminCap" in v1, replace it with "the keeper is multisig" or
"the AdminCap has Move-enforced bounds the team can't lift." The
production-honest framing does not work if you accidentally use
the trust-us frame. *Verify the multisig* is a complete sentence.

### Don't say "we never lose user funds." Say "if we ever can't pay, we say so on-chain, in advance."

The first claim is the kind of thing that turns into a Twitter
thread when it's broken. The second claim is the kind of thing that
turns into a customer when it isn't. The bankruptcy clause is
on-chain. The first sentence above is true. The second sentence is
*verifiable*.

### Don't say "WICK is fairly distributed." Say "the curve is fair from day 1, not just in expectation."

The genesis-week mint dampener (H3) means the early-trader premium
is real but bounded. *Fairly distributed* is asymptotic; *fair from
day 1* is structural. Use the structural framing.

### Don't say "we're not centralized." Say "even our own protocol team can't unilaterally rewrite oracle truth."

Concrete > abstract. The multisig keeper is a specific mechanical
fact. *Decentralized* is a direction; *can't unilaterally rewrite
oracle truth* is a property.

### Don't say "production-ready." Say "production-honest."

*Production-ready* is a status claim that audits decide. *Production-
honest* is a posture claim that the threat model demonstrates. The
posture is what we have today; the status comes after the audit.

### When the demo glitches and a judge looks worried, say "testnet" *or* "the threat model covers that."

For RPC flakes and wallet hiccups: *"testnet"* (per v1).

For anything that smells like a security concern (price greys out,
position doesn't appear, indexer lags): *"the threat model covers
that — section 7 if you want the residual risk, section 4 if you
want the mitigation."* Then keep going. The judges who care about
security will appreciate that you have an answer; the ones who
don't will appreciate that you're not flinching.

---

## 11. The 30-second elevator (v2)

If you only have 30 seconds with a judge — they're hurrying past, or
you're at a sponsor booth — here is the v2 compression.

> "Wick Markets. Touch options on Sui. Polymarket asks where BTC
> ends; Wick asks whether it wicks into a level — settled in 30
> seconds. We compose with DeepBook Predict atomically through PTBs,
> we list positions on the v3 CLOB for free, and the LP token only
> mints to losers — no premine. We red-teamed the design with ten
> adversarial agents, found 137 attacks, shipped hardening for every
> Critical and High. Multisig keeper. Move-enforced admin caps.
> Disclosed bankruptcy clause. Two QRs on our closer slide — one to
> play, one to read the threat model. Booth's over there."

That's 100 words at conversational pace. Memorize it. The closing
line — "two QRs on our closer slide" — is the one that gets the judge
to come find you when they want to talk seriously.

---

## 12. The credibility ladder (v2 framing for the team)

When you're explaining the v2 strategy to teammates or co-presenters,
this is the mental model.

**Rung 1: Spectacle.** The Arcade candle wicking. Confetti. Numbers
move. This buys 15 seconds of attention.

**Rung 2: Composition.** PTB with `wick::market::buy_touch` and
`predict::oracle::observe` in the same transaction. This buys 30
seconds of attention from the DeepBook judges.

**Rung 3: Open invitation.** QR on the closer, scan with Slush, play
on the Arcade. This buys you the judge holding a Wick position when
they walk to the next booth — they'll remember Wick, but it doesn't
necessarily make them advocate.

**Rung 4 (v2 only): Verifiability.** The second QR. The threat model.
The multisig list. The disclosed bankruptcy clause. *This is what
turns "I played with it" into "I'd recommend it."* This is the rung
that wins the judges who matter most — the ones who decide which
hackathon submissions get follow-on funding.

The Rung 4 framing only works if Rungs 1–3 already landed. Don't
lead with the threat model; close with it. The threat model is the
artifact that proves the spectacle has substance.

---

## 13. What gets cut if we run long

The 3-minute clock is real. If at any point you're > 10 seconds
behind the timing markers, here's the cut order (cut from the bottom).

1. First cut: Q&A buffer. The script targets 2:55, leaving 5
   seconds. If you blow that, no Q&A in the demo window.
2. Second cut: the second `[NEW]` framing line in Scene 4 (the
   "genesis-week mint dampener" line). It's the most easily droppable
   v2 addition because the WICK token framing still lands without it.
3. Third cut: the `[NEW]` line in Act 1 ("we red-teamed our own
   design with ten adversarial agents"). Painful to cut — it's the
   credibility hook for the closer — but the closer can carry the
   credibility on its own via the right QR.
4. Last cut: the `[NEW]` line in Scene 3 (the multisig keeper line).
   Don't cut this. If you're so behind that this is what's left to
   cut, abandon the BTC scene entirely and stay in Arcade.

The closer's dual-QR slide is **never cut**. Even if you have to
skip 30 seconds of the script, you land on that slide.

---

## 14. The signal we're sending

Every protocol team at this hackathon will say "we built X on Sui in
two weeks." Most will lead with features. Some will lead with the
team. A few will lead with the product. We are the only team leading
with **the production-honest threat model as a feature**.

The bet is that this differentiates us from a generic "we built a
DEX / a perp / a prediction market" pitch. Three months from now, no
judge will remember the names of the protocols whose closer slide
was a single QR to a marketing page. They will remember the protocol
whose closer slide was *two* QR codes, one of which led to a 4500-
word threat model.

That is the hackathon signal Papertrade sent. That is the signal
Wick is sending in v2.

---

*End of demo script v2. Total spoken time at conversational pace:
2:55. Buffer: 5 seconds. Use the buffer on Scene 2 (the moneyshot)
or on the Q10 (bankruptcy clause) answer if it comes up — never on
Act 1.*

*The closer slide is the artifact. The threat model is the proof.
The Arcade is the hook. In that order.*
