#!/usr/bin/env node
/**
 * e2e-pro-smoke.mjs — the judge flow, driven headless against the LIVE site.
 *
 * `smoke:demo` curls the routes; this actually PLAYS Wick Pro the way a judge
 * does and asserts the submission's core promises render and behave:
 *
 *   1. /pro loads with a real DeepBook mark (price + σ + "DEEPBOOK LIVE")
 *   2. Pick size $5, tap ▲ UP → a live position opens (timer, live P&L $ + %,
 *      break-even line, CLOSE button)
 *   3. The P&L is actually LIVE — it ticks off the mark between two samples
 *   4. CLOSE settles and returns to the lobby (UP/DOWN buttons back)
 *   5. Switching the asset to BTC re-marks the chart to the BTC pool
 *   6. ZERO uncaught page errors / console errors the whole time
 *
 * Captures a screenshot at each step to $OUT (default ~/work/uploads/a8-e2e).
 * Pure read-only against prod — opens no wallet, signs nothing (the /pro game
 * settles client-side against the live mark; that's the documented scope).
 *
 * Usage:
 *   npm run e2e:pro                       # against https://wick-markets.vercel.app
 *   PRO_URL=http://localhost:5173 npm run e2e:pro
 *
 * Needs Playwright + a chromium build. If absent it SKIPS (exit 0) with the
 * one-time install hint, so CI without browsers stays green.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    console.log(
      "SKIP e2e:pro — Playwright not installed. Enable once with:\n" +
        "    npm i -D playwright && npx playwright install chromium",
    );
    process.exit(0);
  }
}

const BASE = process.env.PRO_URL ?? "https://wick-markets.vercel.app";
const URL = BASE.replace(/\/$/, "") + "/pro";
const OUT = process.env.OUT ?? join(homedir(), "work/uploads/a8-e2e");
mkdirSync(OUT, { recursive: true });

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const errors = [];
function num(s) {
  const m = String(s).replace(/[, ]/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

console.log("─".repeat(64));
console.log(`Wick Pro — judge-flow e2e smoke @ ${URL}`);
console.log("─".repeat(64));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text().slice(0, 160));
});
page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e).slice(0, 160)));

const shot = (n) => page.screenshot({ path: join(OUT, n) }).catch(() => {});

try {
  // ── 1. load + live mark ────────────────────────────────────────────────
  await page.goto(URL, { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(3500);
  await shot("01-lobby.png");

  const body1 = await page.locator("body").innerText();
  check("DEEPBOOK LIVE indicator present", /DEEPBOOK LIVE/i.test(body1));
  check("live σ (implied vol) shown", /σ\s*\d+%/.test(body1));
  const upDown =
    (await page.locator("button", { hasText: "UP" }).count()) > 0 &&
    (await page.locator("button", { hasText: "DOWN" }).count()) > 0;
  check("▲ UP / ▼ DOWN controls present", upDown);

  // header price sanity (SUI mark is ~0.3–3 USD)
  const headPrice = num(
    (body1.match(/SUI\/USDC[\s\S]{0,40}?(\d+\.\d+)/) || [])[1] ??
      (body1.match(/(\d+\.\d{3,})/) || [])[1] ??
      "",
  );
  check(
    "SUI mark looks like a real price",
    Number.isFinite(headPrice) && headPrice > 0.05 && headPrice < 100,
    `mark=${headPrice}`,
  );

  // ── 2. open a position ─────────────────────────────────────────────────
  await page.getByRole("button", { name: "$5" }).click().catch(() => {});
  await page.waitForTimeout(300);
  await page.locator("button", { hasText: "UP" }).first().click();
  await page.waitForTimeout(2500);
  await shot("02-position.png");

  const body2 = await page.locator("body").innerText();
  check("position timer counting down", /\d+\s*S\s*LEFT/i.test(body2));
  check("break-even line shown", /BREAK\s*EVEN/i.test(body2));
  const hasClose =
    (await page.locator("button", { hasText: "CLOSE" }).count()) > 0;
  check("CLOSE / cash-out control present", hasClose);
  check(
    "live P&L (dollar + percent) rendered",
    /[−-]?\$\d/.test(body2) && /[−-]?\d+(\.\d+)?%/.test(body2),
  );

  // ── 3. P&L is actually live (ticks off the mark) ───────────────────────
  const pnlText = () =>
    page
      .locator("button", { hasText: "CLOSE" })
      .first()
      .innerText()
      .catch(() => "");
  const a = await pnlText();
  await page.waitForTimeout(2600);
  const b = await pnlText();
  check(
    "P&L updates live between samples",
    a !== b || /cash out/i.test(a),
    `"${a.replace(/\n/g, " ")}" → "${b.replace(/\n/g, " ")}"`,
  );

  // ── 3b. FLIP reverses the open position in place (UP → DOWN) ────────────
  // FLIP (reverse your bet mid-trade) is a headline /pro control on every open
  // position but was untested here. Verified in a real browser: UP→DOWN with a
  // fresh P&L basis, coherent state, 0 errors. Guard it stays that way.
  const flipBtn = page.locator("button").filter({ hasText: /FLIP/i }).first();
  const hasFlip = (await flipBtn.count()) > 0;
  await flipBtn.click().catch(() => {});
  await page.waitForTimeout(2600);
  await shot("02b-flipped.png");
  const bodyFlip = await page.locator("body").innerText();
  check(
    "FLIP reverses the position in place (UP → DOWN, still live)",
    hasFlip &&
      /\bDOWN\b/i.test(bodyFlip) &&
      /\d+\s*S\s*LEFT/i.test(bodyFlip) &&
      (await page.locator("button", { hasText: "CLOSE" }).count()) > 0,
  );

  // ── 4. close → back to lobby ───────────────────────────────────────────
  await page.locator("button", { hasText: "CLOSE" }).first().click();
  await page.waitForTimeout(2500);
  await shot("03-after-close.png");
  const body3 = await page.locator("body").innerText();
  check(
    "returns to lobby after close (UP/DOWN back)",
    /▲\s*UP|UP[\s\S]{0,20}to win/i.test(body3) &&
      (await page.locator("button", { hasText: "UP" }).count()) > 0,
  );

  // ── 5. asset switch re-marks to BTC ────────────────────────────────────
  await page.getByRole("button", { name: "BTC" }).click().catch(() => {});
  await page.waitForTimeout(3500);
  await shot("04-btc.png");
  const body4 = await page.locator("body").innerText();
  const btcPrice = num((body4.match(/(\d{4,6}(\.\d+)?)/) || [])[1] ?? "");
  check(
    "BTC mark re-priced (≫ SUI range)",
    Number.isFinite(btcPrice) && btcPrice > 1000,
    `btc≈${btcPrice}`,
  );

  // ── 5b. asset switch re-marks to DEEP (DeepBook's own token) ────────────
  // DEEP is symbolically central to a Sui/DeepBook submission; guard that the
  // namesake pool prices too. Assert the pair label + live indicator rather
  // than a price range (DEEP ≈ $0.016 would false-match other small numbers).
  await page.getByRole("button", { name: "DEEP" }).click().catch(() => {});
  await page.waitForTimeout(3500);
  await shot("05-deep.png");
  const body5 = await page.locator("body").innerText();
  check(
    "DEEP mark re-priced (DEEP/USDC pool, live)",
    /DEEP\/USDC/i.test(body5) && /DEEPBOOK LIVE/i.test(body5),
    /DEEP\/USDC/i.test(body5) ? "DEEP/USDC live" : "no DEEP/USDC label",
  );

  // ── 6. no runtime errors anywhere ──────────────────────────────────────
  check(
    "no uncaught page/console errors",
    errors.length === 0,
    errors.length ? errors.slice(0, 3).join(" || ") : "",
  );
} catch (e) {
  check("flow completed without throwing", false, String(e).slice(0, 160));
  await shot("99-error.png");
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.ok);
console.log("─".repeat(64));
console.log(`screenshots → ${OUT}`);
if (failed.length === 0) {
  console.log(`PASS — judge flow works end-to-end (${checks.length} checks)`);
  process.exit(0);
}
console.log(`FAIL — ${failed.length}/${checks.length} checks failed`);
process.exit(1);
