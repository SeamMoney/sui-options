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
import { chromium } from "playwright";

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

  // DeepBook live (UP becomes enabled once the mark lands).
  const liveReady = await waitUntil(async () => (await up.count()) > 0 && !(await up.isDisabled().catch(() => true)), 22000);
  check("DeepBook mark is live (UP enabled)", liveReady);

  if (liveReady) {
    // 3. Open -> CLOSE / FLIP, not UP/DOWN.
    await up.click();
    await page.waitForTimeout(500);
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

    // 5. FLIP reverses direction.
    const flip = page.locator('button:has-text("FLIP")').first();
    if ((await flip.count()) > 0) {
      await flip.click();
      await page.waitForTimeout(1000);
      body = await page.evaluate(() => document.body.innerText);
      const dirAfter = /UP\s*·/i.test(body) ? "UP" : /DOWN\s*·/i.test(body) ? "DOWN" : "?";
      check("FLIP reverses the position", dirBefore !== "?" && dirAfter !== "?" && dirAfter !== dirBefore && /CLOSE/i.test(body), `${dirBefore}→${dirAfter}`);
    } else {
      check("FLIP reverses the position", false, "no FLIP button");
    }

    // 6. CLOSE settles ~= live (within a one-frame ease cent).
    const liveBefore = (await page.evaluate(() => document.body.innerText)).match(CENTS)?.[0] ?? null;
    const close = page.locator('button:has-text("CLOSE"), button:has-text("Close")').first();
    if ((await close.count()) > 0) await close.click();
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => document.body.innerText);
    const settled = after.match(CENTS)?.[0] ?? null;
    const num = (s) => (s ? Number(s.replace(/[+$]/g, "").replace("−", "-")) : NaN);
    const diff = Math.abs(num(liveBefore) - num(settled));
    check("CLOSE settles ≈ live P&L (≤ $0.05)", Number.isFinite(diff) && diff <= 0.05, `live ${liveBefore} → settled ${settled}`);
  }

  // 7. No console errors.
  check("no uncaught console errors", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
} catch (err) {
  check("ran the flow without throwing", false, String(err).slice(0, 120));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.\n`);
process.exit(failed.length === 0 ? 0 : 1);
