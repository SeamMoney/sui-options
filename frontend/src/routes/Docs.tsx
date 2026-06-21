/**
 * Wick Docs — "Chaos Feed" Win95/brutalist design (from CodePen OPbpqPx by
 * dustindwayne, adapted). `/docs` = categorized card index; `/docs/<slug>` = a
 * full topic page with prev/next + a grouped jump menu (mobile-friendly).
 */
import { Fragment, type ReactNode } from "react";
import "./Docs.css";

type Category = "Start Here" | "Pro Options" | "Markets" | "Fairness & Economics" | "Other Products" | "Reference";

const CATEGORY_ORDER: Category[] = ["Start Here", "Pro Options", "Markets", "Fairness & Economics", "Other Products", "Reference"];

type Doc = {
  slug: string;
  exe: string;
  category: Category;
  tag: string;
  title: string;
  blurb: ReactNode;
  full: ReactNode;
};

const H = ({ children }: { children: ReactNode }) => <h2>{children}</h2>;

const DOCS: Doc[] = [
  // ── Start Here ────────────────────────────────────────────────────────
  {
    slug: "what-is-wick", exe: "WHAT_IS_WICK.EXE", category: "Start Here", tag: "intro", title: "What is Wick",
    blurb: <>Short-dated options on Sui — Pro Options (Black-Scholes calls &amp; puts on a live DeepBook mark), plus touch/no-touch, corridors, and rides.</>,
    full: <>
      <p>Wick is a markets app for <b>short-dated, high-frequency options</b> on the Sui blockchain. Where prediction markets ask <i>where</i> a price ends up, Wick asks whether price <b>wicks</b> into a level — and lets you trade that tick-by-tick.</p>
      <H>The surfaces</H>
      <ul>
        <li><b>Pro Options</b> — vanilla calls and puts priced with Black-Scholes off a <b>live DeepBook CLOB mark</b> (SUI/USDC, BTC, DEEP), with a provably-fair synthetic mode too. The main product.</li>
        <li><b>Touch / No-Touch + DNT</b> — single- and double-barrier exotics on oracle-observed price.</li>
        <li><b>Degen</b> — a tap-and-hold spot ride.</li>
      </ul>
      <p>One line: <code>options for the next candle</code>.</p>
    </>,
  },
  {
    slug: "options-101", exe: "OPTIONS_101.EXE", category: "Start Here", tag: "learn", title: "Options 101",
    blurb: <>New to options? Calls, puts, strike, expiry, premium — the whole vocabulary in two minutes.</>,
    full: <>
      <p>An <b>option</b> is a contract giving you the <i>right, but not the obligation</i>, to buy or sell an asset at a fixed price by a fixed date.</p>
      <H>Calls vs puts</H>
      <ul>
        <li>A <b>call</b> profits when price goes <b>up</b>. You're betting price ends above the strike.</li>
        <li>A <b>put</b> profits when price goes <b>down</b>. You're betting price ends below the strike.</li>
      </ul>
      <H>The four numbers</H>
      <ul>
        <li><b>Strike</b> — the price the option is measured against.</li>
        <li><b>Expiry</b> — when it settles.</li>
        <li><b>Premium</b> — what you pay to own it. For a buyer, this is your <b>max loss</b>.</li>
        <li><b>Intrinsic value</b> — what it's worth right now if it expired this instant. A call is <code>max(0, price − strike)</code>.</li>
      </ul>
      <H>In / at / out of the money</H>
      <p>A call is <b>ITM</b> when price &gt; strike, <b>ATM</b> at the strike, and <b>OTM</b> below it. An option that expires OTM is worth nothing — it <b>expires worthless</b>, and you lose only the premium.</p>
    </>,
  },
  {
    slug: "get-started", exe: "GET_STARTED.EXE", category: "Start Here", tag: "start", title: "Get Started",
    blurb: <>Connect a wallet, grab test funds, pick a market, play a round. Practice mode is play-money.</>,
    full: <>
      <H>Four steps</H>
      <ol>
        <li>Connect a wallet — or just sign in, and a session wallet is created for you.</li>
        <li>Grab test funds from the faucet.</li>
        <li>Pick a market personality and wait for the lobby.</li>
        <li>Open a couple of options at the Desk, then manage them live.</li>
      </ol>
      <p><b>Practice mode</b> runs the exact same engine with play money — no risk, all the reps. Use it to learn the flow before touching real funds.</p>
    </>,
  },

  // ── Pro Options ───────────────────────────────────────────────────────
  {
    slug: "pro-options", exe: "PRO_OPTIONS.EXE", category: "Pro Options", tag: "overview", title: "Pro Options Mode",
    blurb: <><code>Black-Scholes</code> calls &amp; puts on a live DeepBook mark. Settlement-consistent live P&amp;L, payoff curve + Greeks.</>,
    full: <>
      <p>Pro Options prices vanilla options off the <b>live DeepBook CLOB mark</b> (SUI/USDC, BTC, DEEP) — real Black-Scholes with the volatility taken from the live trade tape. Every contract is a real option — strike, expiry, premium — and the headline P&amp;L is <i>settlement-consistent</i> (what you watch is what you settle).</p>
      <H>The loop</H>
      <p>Pick a side — <b>UP</b> (call) or <b>DOWN</b> (put) — and a stake. Watch one big live P&amp;L tick off the real mark, then close (or let the 60-second option auto-settle). Fast, repeatable, defined-risk: your max loss is the premium.</p>
      <H>Provably-fair synthetic mode</H>
      <p>The same engine also runs on commit-reveal synthetic price paths (at <code>/pro-sim</code>) — short, endlessly repeatable rounds whose every candle is reproducible bit-for-bit from on-chain randomness. Verify any of them at <code>/verify</code>.</p>
    </>,
  },
  {
    slug: "the-round", exe: "THE_ROUND.EXE", category: "Pro Options", tag: "lifecycle", title: "How a Round Works",
    blurb: <>A market is committed, then <code>lobby → live → settle</code>. Bet on how the rest of the chart plays out.</>,
    full: <>
      <p>Every round runs on a clock with three phases:</p>
      <ul>
        <li><b>Lobby</b> — the market's opening setup is shown, and the keeper commits a hash of the entire price path. You browse the chain and open positions at the Desk.</li>
        <li><b>Live</b> — the rest of the chart streams out in real time. Everyone watches the same reveal; you manage your book.</li>
        <li><b>Settle</b> — options pay their intrinsic value against the committed path, and the seed is revealed so anyone can verify the round was fair.</li>
      </ul>
      <p>It's "Crash you can actually trade inside of" — a shared cliffhanger with real mid-round agency.</p>
    </>,
  },
  {
    slug: "desk-vs-live", exe: "DESK_VS_LIVE.EXE", category: "Pro Options", tag: "mechanics", title: "Desk vs Live",
    blurb: <>Open <b>deliberately</b> at the Desk. Manage <b>live</b> with one decision: hold or <code>Sell to close</code>.</>,
    full: <>
      <p>Opening an option and managing one have opposite cognitive loads, so they live in different modes.</p>
      <H>The Desk (lobby)</H>
      <p>The options desk: full chain, payoff curves, Greeks, strike and expiry selection. No time pressure — this is where you think and build a position.</p>
      <H>Live (the round)</H>
      <p>The management screen: your positions, live mark and P&amp;L, and one big <code>Sell to close</code> button — readable while candles fly. It's the cash-out you liked from degen, in honest options language.</p>
    </>,
  },
  {
    slug: "payoff-curves", exe: "PAYOFF.EXE", category: "Pro Options", tag: "learn", title: "Reading the Payoff Curve",
    blurb: <>The hockey-stick chart, decoded: breakeven, max loss, and the "today" vs "at-expiration" lines.</>,
    full: <>
      <p>The payoff curve shows your <b>profit or loss</b> (vertical axis) for every possible price at expiry (horizontal axis).</p>
      <H>What to look for</H>
      <ul>
        <li><b>Max loss</b> — the flat floor on a long option. It's just the premium you paid.</li>
        <li><b>Breakeven</b> — where the curve crosses $0. For a call that's <code>strike + premium</code>.</li>
        <li><b>The kink</b> — at the strike, where the option goes from worthless to gaining value.</li>
      </ul>
      <H>Two lines</H>
      <p>The <b>solid</b> line is value <i>at expiration</i> (pure intrinsic). The <b>dotted</b> line is value <i>today</i> — smoother, because there's still time value. As expiry approaches, the dotted line collapses onto the solid one.</p>
    </>,
  },
  {
    slug: "greeks", exe: "GREEKS.EXE", category: "Pro Options", tag: "learn", title: "The Greeks",
    blurb: <>Delta, Theta, Gamma, Vega — how your option reacts to price, time, and volatility.</>,
    full: <>
      <p>The Greeks measure how an option's value changes as the world moves. The panel shows four:</p>
      <ul>
        <li><b>Delta (Δ)</b> — how much the option moves per $1 of price. A 0.50 delta call gains ~$0.50 per $1 up. Also a rough probability of finishing ITM.</li>
        <li><b>Theta (Θ)</b> — time decay. How much value you bleed per day just from time passing. Negative for buyers.</li>
        <li><b>Gamma (Γ)</b> — how fast delta itself changes. High gamma = your exposure swings quickly near the strike.</li>
        <li><b>Vega</b> — sensitivity to implied volatility. More vol = more expensive options.</li>
      </ul>
    </>,
  },
  {
    slug: "pricing", exe: "PRICING.EXE", category: "Pro Options", tag: "tech", title: "Black-Scholes Pricing",
    blurb: <>Premiums, Greeks, marks and payoff curves from off-chain BS. On-chain <code>Bachelier</code> guardrails.</>,
    full: <>
      <p>The headline pricing engine is <b>Black-Scholes</b>, off-chain: premiums, the Greeks, live marks, and the payoff curve — full precision, the recognizable trading feel.</p>
      <H>Settlement is simpler</H>
      <p>A cash-settled option just pays <code>intrinsic</code> against the committed path — no pricing model needed at expiry. That's the key insight that keeps the system cheap and verifiable on-chain.</p>
      <H>On-chain trust</H>
      <p>An on-chain <b>Bachelier</b> bound keeps the off-chain quoter honest (a premium can't drift outside it), and serves as a fallback for fully-on-chain markets. Best of both: the BS experience, on-chain trust.</p>
    </>,
  },
  {
    slug: "sell-to-close", exe: "SELL_CLOSE.EXE", category: "Pro Options", tag: "mechanics", title: "Sell to Close",
    blurb: <>Bail early at the current mark instead of holding to expiry — and why it beats "exercising early".</>,
    full: <>
      <p>You're never locked in. At any point during the live round you can <b>Sell to close</b>: the vault buys your option back at its current <b>mark</b> (its live Black-Scholes value, minus the spread).</p>
      <H>Sell, don't exercise</H>
      <p>Selling at the mark is almost always better than exercising early, because the mark includes remaining <b>time value</b> that early exercise throws away. So Wick gives you a Sell button, not an early-exercise button — it's the strictly better version of the same instinct.</p>
    </>,
  },
  {
    slug: "expiry-settlement", exe: "SETTLE.EXE", category: "Pro Options", tag: "lifecycle", title: "Expiry & Settlement",
    blurb: <>At expiry your option pays its intrinsic value — or expires worthless. Cash-settled, idempotent.</>,
    full: <>
      <p>If you hold to expiry, the option is <b>cash-settled</b> against the realized price on the committed path:</p>
      <ul>
        <li><b>ITM</b> — you receive the intrinsic value (e.g. a $100 call with price at $107 pays $7 per contract).</li>
        <li><b>OTM</b> — it <b>expires worthless</b> and you lose only the premium.</li>
      </ul>
      <p>Settlement is idempotent and can be cranked by anyone — it can't pay twice, and the losing side can't redeem.</p>
    </>,
  },

  // ── Markets ───────────────────────────────────────────────────────────
  {
    slug: "markets", exe: "MARKETS.EXE", category: "Markets", tag: "overview", title: "Market Personalities",
    blurb: <><code>Calm</code> · <code>Volatile</code> · <code>Trending</code> · <code>Choppy</code> — pick your table.</>,
    full: <>
      <p>Each market is a personality — a different volatility, drift, rug risk, and clock speed:</p>
      <ul>
        <li><b>Calm</b> — low vol, gentle drift. Read the trend, no surprises.</li>
        <li><b>Volatile</b> — high vol with rug risk. Big swings, fast P&amp;L.</li>
        <li><b>Trending</b> — persistent drift. Momentum favors calls.</li>
        <li><b>Choppy</b> — whippy and directionless. Punishes over-commitment.</li>
      </ul>
      <p>Same engine, different parameters — so the skills transfer but every table feels distinct.</p>
    </>,
  },
  {
    slug: "synthetic-engine", exe: "SYNTH.EXE", category: "Markets", tag: "tech", title: "The Synthetic Engine",
    blurb: <>How the candles are made: a seeded geometric Brownian motion path with an occasional rug.</>,
    full: <>
      <p>Prices come from a <b>geometric Brownian motion</b> (the standard model for asset prices) driven by a market's vol and drift, plus a low-probability <b>rug</b> down-jump.</p>
      <H>Deterministic</H>
      <p>The whole path is generated from a single <b>seed</b>. Same seed + params ⇒ identical path, every time. That determinism is what makes commit-reveal fairness possible — and it means a round can be replayed and verified exactly.</p>
      <H>Not a real asset</H>
      <p>These prices are honest about being synthetic. There's no real BTC or NVDA behind them — just a fair, fast, reproducible market to trade on.</p>
    </>,
  },
  {
    slug: "accelerated-clock", exe: "CLOCK.EXE", category: "Markets", tag: "tech", title: "The Accelerated Clock",
    blurb: <>Why a 60-second round behaves like a month of trading: the years-per-second time-scale.</>,
    full: <>
      <p>Options need time to have value — but a real 30-second option on a real asset is worth almost nothing. So synthetic markets run on an <b>accelerated clock</b>.</p>
      <p>A tunable <code>years-per-second</code> factor compresses time: a ~60-second round can feel like a month or two of price action, so options have meaningful premiums and the chart actually moves. It's the dial that sets how fast and dangerous a market feels.</p>
    </>,
  },

  // ── Fairness & Economics ──────────────────────────────────────────────
  {
    slug: "fairness", exe: "FAIRNESS.EXE", category: "Fairness & Economics", tag: "trust", title: "Provable Fairness",
    blurb: <>Commit a hash of the path before the lobby, stream it live, reveal the seed at settle. Verify anytime.</>,
    full: <>
      <p>You can pre-generate a round's whole path, but players must never get the seed early — or they'd know the future. So:</p>
      <ol>
        <li>At lobby start the keeper publishes <code>commit = H(seed ‖ params)</code>.</li>
        <li>During live it streams the candles — everyone sees the same thing, no one sees ahead.</li>
        <li>At settle it reveals the <code>seed</code>; anyone recomputes the path and checks it matches both the commit and the streamed candles.</li>
      </ol>
      <p>If the reveal doesn't match the commit, the round was tampered with — and that's publicly detectable.</p>
    </>,
  },
  {
    slug: "house-edge", exe: "HOUSE_EDGE.EXE", category: "Fairness & Economics", tag: "economics", title: "House Edge",
    blurb: <>A transparent <code>spread</code> plus an occasional <code>rug</code> candle. Disclosed and Monte-Carlo'd.</>,
    full: <>
      <p>Wick is a house-banked game with a real, but <b>disclosed</b>, edge. It comes from two sources:</p>
      <ul>
        <li><b>Spread (the vig)</b> — every premium and every mark carries a transparent spread. This is the primary, legible edge.</li>
        <li><b>Mild rug</b> — a low-probability down-jump candle biases realized paths slightly against holders.</li>
      </ul>
      <p>The combined edge is measured by Monte-Carlo simulation and stated openly — there's no hidden vig. Skilled trading still matters; the edge is the table's cut, not a rigged outcome.</p>
    </>,
  },
  {
    slug: "implied-vol", exe: "IV.EXE", category: "Fairness & Economics", tag: "learn", title: "Implied Volatility",
    blurb: <>The IV slider, explained: how much movement is priced in, and why it changes premiums.</>,
    full: <>
      <p><b>Implied volatility (IV)</b> is the amount of future movement the market is pricing into an option. Higher IV ⇒ bigger expected swings ⇒ more expensive options (both calls and puts).</p>
      <p>On the Simulated Returns screen, the <b>IV slider</b> lets you stress-test: drag it up and watch the "today" payoff curve fatten as the option gets more valuable, drag it down and watch it collapse toward the at-expiration line. The 52-week low/high band shows where IV has actually traded.</p>
    </>,
  },

  // ── Other Products ────────────────────────────────────────────────────
  {
    slug: "touch-notouch", exe: "TOUCH.EXE", category: "Other Products", tag: "product", title: "Touch / No-Touch",
    blurb: <>Binary barrier options: will price <i>touch</i> a level before expiry, or not?</>,
    full: <>
      <p>The original Wick product. A <b>Touch</b> bet pays if price reaches a barrier at any point before expiry; <b>No-Touch</b> pays if it never does. <b>Double-No-Touch (DNT)</b> pays if price stays inside a corridor between two barriers.</p>
      <p>These are <i>oracle-observed</i>: the product definition is "price as observed by the oracle crossed the buffered, deadbanded barrier" — honest about what's being measured, not any off-chain exchange tick.</p>
    </>,
  },
  {
    slug: "degen", exe: "DEGEN.EXE", category: "Other Products", tag: "product", title: "Degen Mode",
    blurb: <>The tap-hold ride: long while you hold, sell when you let go. A pure spot primitive.</>,
    full: <>
      <p>Degen is a spot primitive: you're long while you hold the screen, and you sell the instant you let go. The gesture <i>is</i> the position — fast, tactile, all in the thumb.</p>
      <p>It's deliberately separate from Pro Options. Holding maps perfectly to spot exposure; it never mapped cleanly to a contract with a strike and an expiry — which is exactly why Pro Options exists as its own thing.</p>
    </>,
  },

  // ── Reference ─────────────────────────────────────────────────────────
  {
    slug: "glossary", exe: "GLOSSARY.EXE", category: "Reference", tag: "ref", title: "Glossary",
    blurb: <>Strike, premium, intrinsic, mark, spread, commit-reveal — the terms in one place.</>,
    full: <>
      <ul>
        <li><b>Strike</b> — the reference price of an option.</li>
        <li><b>Premium</b> — what you pay to buy an option; a buyer's max loss.</li>
        <li><b>Intrinsic value</b> — an option's value if it expired now.</li>
        <li><b>Mark</b> — an option's current fair value (used for Sell to close).</li>
        <li><b>Spread</b> — the house's transparent cut on premiums and marks.</li>
        <li><b>Commit-reveal</b> — hash-commit the path up front, reveal the seed after, so fairness is verifiable.</li>
        <li><b>Rug</b> — a rare down-jump candle that contributes to the house edge.</li>
        <li><b>Greeks</b> — Δ Θ Γ vega: an option's sensitivities to price, time, and vol.</li>
      </ul>
    </>,
  },
  {
    slug: "faq", exe: "FAQ.EXE", category: "Reference", tag: "ref", title: "FAQ",
    blurb: <>Is it fair? Is it real money? Can I lose more than I put in? Answered.</>,
    full: <>
      <H>Is it fair?</H>
      <p>Yes, provably — every round is hash-committed before you trade and the seed is revealed after for verification. The house edge is separate and disclosed.</p>
      <H>Can I lose more than I put in?</H>
      <p>No. As an option <i>buyer</i>, your max loss is the premium you paid. Full stop.</p>
      <H>Are these real assets?</H>
      <p>Yes — Pro Options prices off the <b>live DeepBook</b> on-chain CLOB mark for SUI/USDC, BTC and DEEP (real mid, real volatility). A provably-fair synthetic mode (<code>/pro-sim</code>) is also available for endlessly-repeatable reps. Touch/No-Touch trades oracle-observed price.</p>
      <H>Do I need real money?</H>
      <p>No — practice mode runs the exact engine with play money.</p>
    </>,
  },
];

function DocsGrid() {
  return (
    <div className="chaos-docs">
      {CATEGORY_ORDER.map((cat) => (
        <Fragment key={cat}>
          <div className="chaos-cat">{cat}</div>
          {DOCS.filter((d) => d.category === cat).map((d) => (
            <a className="feed-item" data-exe={d.exe} href={`/docs/${d.slug}`} key={d.slug}>
              <h3>{d.title}</h3>
              <h4 className="feed-source">{d.category}</h4>
              <span className="pub-date">{d.tag}</span>
              <p>{d.blurb}</p>
            </a>
          ))}
        </Fragment>
      ))}
    </div>
  );
}

function DocsTopic({ doc }: { doc: Doc }) {
  const i = DOCS.findIndex((d) => d.slug === doc.slug);
  const prev = DOCS[i - 1];
  const next = DOCS[i + 1];
  return (
    <div className="chaos-topic">
      <article className="chaos-window">
        <div className="chaos-titlebar">
          <span>{doc.exe}</span>
          <span className="chaos-winbtns" aria-hidden="true" />
        </div>
        <div className="chaos-content">
          <a className="chaos-back" href="/docs">◄ ALL DOCS</a>
          <h1>{doc.title}</h1>
          <div className="chaos-tagline">
            <span className="chaos-chip">{doc.category}</span>
            <span className="chaos-chip alt">{doc.tag}</span>
          </div>
          <div className="chaos-body">{doc.full}</div>

          <div className="chaos-prevnext">
            {prev ? <a className="chaos-back" href={`/docs/${prev.slug}`}>◄ {prev.title}</a> : <span />}
            {next ? <a className="chaos-back" href={`/docs/${next.slug}`}>{next.title} ►</a> : <span />}
          </div>

          <nav className="chaos-menu">
            <div className="chaos-menu-title">JUMP TO</div>
            {CATEGORY_ORDER.map((cat) => (
              <div className="chaos-menu-cat" key={cat}>
                <span className="chaos-menu-cat-name">{cat}</span>
                {DOCS.filter((d) => d.category === cat).map((d) => (
                  <a key={d.slug} href={`/docs/${d.slug}`} className={d.slug === doc.slug ? "active" : ""}>{d.title}</a>
                ))}
              </div>
            ))}
          </nav>
        </div>
      </article>
    </div>
  );
}

export function Docs({ path }: { path: string }) {
  const slug = path.startsWith("/docs/") ? path.slice("/docs/".length).replace(/\/$/, "") : "";
  const doc = slug ? DOCS.find((d) => d.slug === slug) : undefined;
  if (slug && doc) return <DocsTopic doc={doc} />;
  return <DocsGrid />;
}
