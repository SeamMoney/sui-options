#!/usr/bin/env node
/**
 * check-demo.mjs — whole-demo smoke gate for the SUPPORTING surfaces a judge
 * is sent to in DEMO.md (`/coach`, `/verify`, `/ride`, `/docs`), driven for
 * real with headless Chromium against a LIVE url. Complements `check:pro`
 * (which gates the /pro submission flow in depth) — run both for full
 * demo-day confidence.
 *
 * Proves, on production by default:
 *   - /coach   — the DeepBook desk loads: real chart, the pattern coach, and a
 *                live DeepBook element (BS quote / order-book depth), no errors.
 *   - /verify  — provable fairness works BOTH ways: clean run → PASS, "dishonest
 *                house" → FAIL (catches the tampered candle).
 *   - /ride    — the on-chain ride game loads with its funding CTA, no overflow.
 *   - /docs    — the docs load.
 *   - /pro     — the submission at least loads + goes interactive (depth: check:pro).
 *
 * Usage:
 *   node scripts/check-demo.mjs                         # production
 *   node scripts/check-demo.mjs http://localhost:4173   # a local preview
 *
 * Exit code is non-zero if any surface fails. Needs Chromium
 * (`npx playwright install chromium`).
 */
// Playwright drives a real browser; it isn't a repo dependency (it pulls ~100MB
// of browser binaries). Resolve it at runtime — `playwright` or the lighter
// `playwright-core` — and if it's absent, print how to enable this gate instead
// of a raw stack trace.
let chromium, devices;
try {
  ({ chromium, devices } = await import("playwright"));
} catch {
  try {
    ({ chromium, devices } = await import("playwright-core"));
  } catch {
    console.error(
      "check:demo needs Playwright (it drives a real browser), which isn't bundled.\n" +
        "Enable it once:\n" +
        "    npm i -D playwright && npx playwright install chromium\n" +
        "then re-run:  npm run check:demo\n" +
        "(Or use the no-browser gate: `npm run smoke:demo`.)",
    );
    process.exit(2);
  }
}

const BASE = (process.argv[2] || process.env.PRO_URL || "https://wick-markets.vercel.app").replace(/\/$/, "");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  const tag = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ""}`);
}

console.log(`\nWick demo smoke — ${BASE}\n`);
const browser = await chromium.launch();

async function newPage(mobile = false) {
  const ctx = mobile
    ? await browser.newContext({ ...devices["iPhone 13"] })
    : await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return { page, ctx, errors };
}

try {
  // ── /coach — the DeepBook desk ───────────────────────────────────────────
  {
    const { page, ctx, errors } = await newPage();
    await page.goto(`${BASE}/coach`, { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForTimeout(8000);
    const chart = await page.evaluate(() => document.querySelectorAll("svg").length > 0);
    const txt = await page.evaluate(() => document.body.innerText);
    // The provenance link is the one DEMO.md tells judges to click ("the pair")
    // to verify the real on-chain pool — gate it so it can't silently vanish.
    const provLink = await page.evaluate(() =>
      [...document.querySelectorAll("a")].some(
        (a) => /DeepBook ↗/i.test(a.textContent || "") && /suiscan\.xyz\/mainnet\/object\//.test(a.href),
      ),
    );
    // Each distinct desk panel DEMO.md promises, gated separately so a
    // regression in any one is caught (not masked by a loose "book" match).
    const parts = {
      coach: /PATTERN COACH/i.test(txt),
      quote: /CALL/i.test(txt) && /PUT/i.test(txt),
      book: /DEEPBOOK BOOK|spread|24h/i.test(txt),
      fills: /RECENT FILLS|ago/i.test(txt),
    };
    const ok = chart && provLink && Object.values(parts).every(Boolean) && errors.length === 0;
    check(
      "/coach desk: chart + coach + BS quote + order book + fills + verifiable pool link",
      ok,
      `chart=${chart} ${Object.entries(parts).map(([k, v]) => `${k}=${v}`).join(" ")} prov=${provLink} errors=${errors.length}`,
    );
    await ctx.close();
  }

  // ── /verify — provable fairness, both ways ───────────────────────────────
  {
    const { page, ctx, errors } = await newPage();
    await page.goto(`${BASE}/verify`, { waitUntil: "networkidle", timeout: 40000 });
    await page.waitForTimeout(1200);
    await page.getByText(/Run verification/i).first().click().catch(() => {});
    await page.waitForTimeout(2500);
    const pass = /PASS\s*—\s*fair|✓\s*PASS/i.test(await page.evaluate(() => document.body.innerText));
    const cb = page.locator('input[type=checkbox]').first();
    if (await cb.count()) {
      await cb.check().catch(() => {});
      await page.waitForTimeout(300);
      await page.getByText(/Run verification|Re-run/i).first().click().catch(() => {});
      await page.waitForTimeout(2500);
    }
    const fail = /FAIL\s*—\s*the chain lied|MISMATCH/i.test(await page.evaluate(() => document.body.innerText));
    check("/verify proves fairness both ways (PASS clean, FAIL tampered)", pass && fail && errors.length === 0, `pass=${pass} fail=${fail} errors=${errors.length}`);
    await ctx.close();
  }

  // ── /ride — the on-chain game funding gate, mobile ───────────────────────
  {
    const { page, ctx, errors } = await newPage(true);
    await page.goto(`${BASE}/ride`, { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForTimeout(6000);
    const o = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
      funds: /free funds|faucet|PLAY BALANCE/i.test(document.body.innerText),
    }));
    check("/ride loads on mobile (funding CTA, no overflow)", o.funds && o.sw <= o.cw + 2 && errors.length === 0, `funds=${o.funds} overflow=${o.sw - o.cw} errors=${errors.length}`);
    await ctx.close();
  }

  // ── /docs ────────────────────────────────────────────────────────────────
  {
    const { page, ctx, errors } = await newPage();
    await page.goto(`${BASE}/docs`, { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForTimeout(3500);
    const len = await page.evaluate(() => document.body.innerText.trim().length);
    check("/docs loads", len > 200 && errors.length === 0, `len=${len} errors=${errors.length}`);
    await ctx.close();
  }

  // ── /pro — the submission at least goes interactive ──────────────────────
  {
    const { page, ctx, errors } = await newPage();
    await page.goto(`${BASE}/pro`, { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForTimeout(6000);
    const up = (await page.locator('button:has-text("UP")').count()) > 0;
    check("/pro loads (run check:pro for the full flow)", up && errors.length === 0, `up=${up} errors=${errors.length}`);
    await ctx.close();
  }
} catch (err) {
  check("ran the smoke without throwing", false, String(err).slice(0, 120));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} surfaces healthy.\n`);
process.exit(failed.length === 0 ? 0 : 1);
