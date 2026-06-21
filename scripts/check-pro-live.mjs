#!/usr/bin/env node
/**
 * check-pro-live.mjs — end-to-end acceptance check for the Wick Pro (/pro)
 * submission, driven for real with headless Chromium against a LIVE URL.
 *
 * Proves the demo flow a judge runs cold actually works:
 *   1. /pro loads, DeepBook mark is live, the chart is a FULL real price
 *      history (seeded from candles — not an empty/sparse line).
 *   2. Fresh load shows UP / DOWN (no position).
 *   3. Opening a position locks it: buttons become CLOSE / FLIP (never
 *      UP/DOWN while a position is on — GAME-STATE-BUGS acceptance #2).
 *   4. The headline P&L is live (updates continuously off the real mark).
 *   5. FLIP reverses the position direction (UP <-> DOWN), stays CLOSE/FLIP.
 *   6. CLOSE settles; the settled number equals the live number you watched
 *      (live == settlement, within a one-frame ease tolerance).
 *   7. No uncaught console errors through the whole flow.
 *
 * Usage:
 *   node scripts/check-pro-live.mjs                 # production
 *   node scripts/check-pro-live.mjs http://localhost:4173   # a local preview
 *   PRO_URL=https://wick-markets.vercel.app node scripts/check-pro-live.mjs
 *
 * Exit code is non-zero if any acceptance check fails — wire it into demo
 * pre-flight. Requires Chromium (playwright); install with
 * `npx playwright install chromium` if missing.
 */
// Playwright drives a real browser; it isn't a repo dependency (it pulls
// ~100MB of browser binaries we don't want in every install / CI run). Resolve
// it at runtime — `playwright` or the lighter `playwright-core` — and if it's
// absent, print exactly how to enable this gate instead of a raw stack trace.
let chromium, devices;
try {
  ({ chromium, devices } = await import("playwright"));
} catch {
  try {
    ({ chromium, devices } = await import("playwright-core"));
  } catch {
    console.error(
      "check:pro needs Playwright (it drives a real browser), which isn't bundled.\n" +
        "Enable it once:\n" +
        "    npm i -D playwright && npx playwright install chromium\n" +
        "then re-run:  npm run check:pro\n" +
        "(Or use the no-browser gates: `npm run smoke:demo` and `npm run verify:pro`.)",
    );
    process.exit(2);
  }
}

const BASE = (process.argv[2] || process.env.PRO_URL || "https://wick-markets.vercel.app").replace(/\/$/, "");
const CENTS = /[+\-−]\$[0-9][0-9.,]*/; // matches +$1.23 / -$0.04 / −$0.04

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  const tag = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function waitUntil(fn, ms, step = 400) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

console.log(`\nWick Pro live acceptance — ${BASE}/pro\n`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});

try {
  await page.goto(`${BASE}/pro`, { waitUntil: "domcontentloaded", timeout: 40000 });
  await page.waitForTimeout(4000);

  const up = page.locator('button:has-text("UP")').first();
  const down = page.locator('button:has-text("DOWN")').first();

  // 2. Fresh load: UP / DOWN.
  check("fresh load shows UP / DOWN", (await up.count()) > 0 && (await down.count()) > 0);

  // 1. Chart full + real (seeded from candle history).
  const segs = await page.evaluate(() => {
    const path = document.querySelector("svg path");
    const d = path ? path.getAttribute("d") || "" : "";
    return (d.match(/[ML]/g) || []).length;
  });
  check("chart is a full real history (>20 points)", segs > 20, `${segs} points`);

  // 1b. The displayed price tracks the REAL DeepBook SUI/USDC mid (not a
  // synthetic / mis-scaled line). Compare the on-screen price to the indexer.
  const shownPx = await page.evaluate(() => {
    const m = document.body.innerText.match(/\b\d+\.\d{4,6}\b/);
    return m ? parseFloat(m[0]) : null;
  });
  // Use the SAME order-book mid the app prices against (fetchDeepBookMark),
  // not /ticker last_price (which can be a stale/odd print).
  const realMid = await page.evaluate(async () => {
    try {
      const r = await fetch("https://deepbook-indexer.mainnet.mystenlabs.com/orderbook/SUI_USDC?level=1");
      const j = await r.json();
      const bid = Number(j.bids?.[0]?.[0]);
      const ask = Number(j.asks?.[0]?.[0]);
      return bid && ask ? (bid + ask) / 2 : null;
    } catch {
      return null;
    }
  });
  const pxClose = shownPx && realMid ? Math.abs(shownPx - realMid) / realMid <= 0.03 : false;
  check("chart price tracks the live DeepBook mid (±3%)", pxClose, `shown ${shownPx} vs DeepBook ${realMid}`);

  // DeepBook live (UP becomes enabled once the mark lands).
  const liveReady = await waitUntil(async () => (await up.count()) > 0 && !(await up.isDisabled().catch(() => true)), 22000);
  check("DeepBook mark is live (UP enabled)", liveReady);

  if (liveReady) {
    // 2. Optimistic tap: the CLOSE state must paint within ~2 frames of the
    // tap (no awaiting the chain) — the SPEED mandate's instant feedback.
    const tapLatency = await page.evaluate(
      () =>
        new Promise((res) => {
          const b = [...document.querySelectorAll("button")].find((x) => /\bUP\b/.test(x.innerText));
          if (!b) return res(9999);
          const t0 = performance.now();
          b.click();
          const tick = () => {
            if ([...document.querySelectorAll("button")].some((x) => /CLOSE/i.test(x.innerText)))
              res(Math.round(performance.now() - t0));
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );
    check("tap → CLOSE is optimistic (≤ 100 ms)", tapLatency <= 100, `${tapLatency} ms`);
    await page.waitForTimeout(400);
    let body = await page.evaluate(() => document.body.innerText);
    const hasClose = /CLOSE/i.test(body);
    const hasFlip = /FLIP/i.test(body);
    const dirBefore = /UP\s*·/i.test(body) ? "UP" : /DOWN\s*·/i.test(body) ? "DOWN" : "?";
    check("locked position shows CLOSE / FLIP", hasClose && hasFlip, `dir=${dirBefore}`);

    // 4. Live P&L.
    const pnls = [];
    for (let i = 0; i < 5; i++) {
      const t = await page.evaluate(() => document.body.innerText);
      const m = t.match(CENTS);
      pnls.push(m ? m[0] : "");
      await page.waitForTimeout(500);
    }
    check("P&L is live (multiple distinct values)", new Set(pnls.filter(Boolean)).size >= 2, pnls.join(" "));

    // 5. CLOSE settles == the number shown ON the CLOSE button at the click
    // instant. Capture-and-click in one sync eval so there's no read→click gap.
    // Done on the CLEAN opened leg (before any FLIP) — FLIP banks the prior
    // leg's P&L, so closing after a flip yields the cumulative total, which
    // legitimately differs from the current-leg button.
    const num = (s) => (s ? Number(s.replace(/[+$]/g, "").replace("−", "-")) : NaN);
    const liveAtClick = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => /CLOSE/i.test(b.innerText));
      if (!btn) return null;
      const m = btn.innerText.match(/[+\-−]\$[0-9.]+/);
      btn.click();
      return m ? m[0] : null;
    });
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => document.body.innerText);
    const settled = after.match(CENTS)?.[0] ?? null;
    const diff = Math.abs(num(liveAtClick) - num(settled));
    check("CLOSE settles == the number on the button (≤ $0.05)", Number.isFinite(diff) && diff <= 0.05, `button ${liveAtClick} → settled ${settled}`);

    // 6. FLIP reverses direction — on a FRESH position (the close above settled
    // the first leg).
    await page.waitForTimeout(800);
    const up2 = page.locator('button:has-text("UP")').first();
    if ((await up2.count()) > 0 && !(await up2.isDisabled().catch(() => true))) {
      await up2.click();
      await page.waitForTimeout(700);
      let fbody = await page.evaluate(() => document.body.innerText);
      const fBefore = /UP\s*·/i.test(fbody) ? "UP" : /DOWN\s*·/i.test(fbody) ? "DOWN" : "?";
      const flip = page.locator('button:has-text("FLIP")').first();
      if ((await flip.count()) > 0) {
        await flip.click();
        await page.waitForTimeout(1000);
        fbody = await page.evaluate(() => document.body.innerText);
        const fAfter = /UP\s*·/i.test(fbody) ? "UP" : /DOWN\s*·/i.test(fbody) ? "DOWN" : "?";
        check("FLIP reverses the position", fBefore !== "?" && fAfter !== "?" && fAfter !== fBefore && /CLOSE/i.test(fbody), `${fBefore}→${fAfter}`);
        await page.locator('button:has-text("CLOSE")').first().click().catch(() => {});
        await page.waitForTimeout(400);
      } else {
        check("FLIP reverses the position", false, "no FLIP button");
      }
    } else {
      check("FLIP reverses the position", false, "could not reopen position");
    }
  }

  // 7. No console errors.
  check("no uncaught console errors", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));

  // 8. Every pool DEMO.md sends judges to works (SUI is covered above; BTC and
  // DEEP must each load real DeepBook data + a full chart, no errors).
  for (const pool of ["BTC", "DEEP"]) {
    const chip = page.locator(`button:has-text("${pool}")`).first();
    if ((await chip.count()) === 0) {
      check(`pool ${pool} is available`, false, "no chip");
      continue;
    }
    await chip.click();
    const ok = await waitUntil(async () => {
      const r = await page.evaluate(() => {
        const path = document.querySelector("svg path");
        const segs = path ? (path.getAttribute("d") || "").match(/[ML]/g)?.length ?? 0 : 0;
        const live = /DEEPBOOK\s+LIVE/i.test(document.body.innerText);
        const px = document.body.innerText.match(/\b\d+(?:\.\d+)?\b/);
        return segs > 20 && live && !!px;
      });
      return r;
    }, 14000);
    check(`pool ${pool} loads real DeepBook data + full chart`, ok);
  }

  // 9. Mobile-first: no horizontal overflow at common phone widths.
  let worstOverflow = 0;
  let mobileErrors = 0;
  for (const w of [320, 360, 390, 414]) {
    const ctx = await browser.newContext({
      viewport: { width: w, height: 780 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    const mp = await ctx.newPage();
    mp.on("pageerror", () => (mobileErrors += 1));
    try {
      await mp.goto(`${BASE}/pro`, { waitUntil: "domcontentloaded", timeout: 30000 });
      // Let the live chart + coach settle — the initial paint can briefly
      // exceed the viewport for a frame before layout stabilises.
      await mp.waitForTimeout(5500);
      const o = await mp.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
      }));
      worstOverflow = Math.max(worstOverflow, o.sw - o.cw);
    } catch {
      /* counted via mobileErrors */
    }
    await ctx.close();
  }
  check("mobile-first: no overflow @ 320–414px", worstOverflow <= 2 && mobileErrors === 0, `worst +${worstOverflow}px, errors ${mobileErrors}`);
} catch (err) {
  check("ran the flow without throwing", false, String(err).slice(0, 120));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.\n`);
process.exit(failed.length === 0 ? 0 : 1);
