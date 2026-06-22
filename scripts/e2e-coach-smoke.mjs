#!/usr/bin/env node
/**
 * e2e-coach-smoke.mjs — drives the /coach "DeepBook Desk" page headless and
 * asserts the live on-chain-mark desk renders the way a judge sees it:
 *
 *   - the live DeepBook SUI/USDC mark (a real price)
 *   - the CandleVision pattern coach calling a setup
 *   - a live Black-Scholes option quote (CALL + PUT premium, Δ, break-even)
 *   - the payoff-at-expiry diagram
 *   - asset toggle re-marks to BTC (≫ SUI range)
 *   - ZERO console/page errors
 *
 * This is the desk that backs the headline "the mark is a real on-chain CLOB"
 * claim, so a silent break here undercuts the whole credibility story.
 *
 * Screenshots to $OUT (default ~/work/uploads/a8-e2e). Read-only against prod.
 * Skips cleanly (exit 0) if Playwright isn't installed.
 *
 * Usage:  npm run e2e:coach     (COACH_URL/PRO_URL override the base)
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
      "SKIP e2e:coach — Playwright not installed. Enable once with:\n" +
        "    npm i -D playwright && npx playwright install chromium",
    );
    process.exit(0);
  }
}

const BASE = process.env.COACH_URL ?? process.env.PRO_URL ?? "https://wick-markets.vercel.app";
const URL = BASE.replace(/\/$/, "") + "/coach";
const OUT = process.env.OUT ?? join(homedir(), "work/uploads/a8-e2e");
mkdirSync(OUT, { recursive: true });

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function num(s) {
  const m = String(s).replace(/[, ]/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

console.log("─".repeat(64));
console.log(`Wick — /coach DeepBook desk e2e @ ${URL}`);
console.log("─".repeat(64));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text().slice(0, 160));
});
page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e).slice(0, 160)));
const shot = (n) => page.screenshot({ path: join(OUT, n), fullPage: true }).catch(() => {});

try {
  await page.goto(URL, { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(6000);
  await shot("coach-01-sui.png");
  const body = await page.locator("body").innerText();

  check("DeepBook Desk renders", /DeepBook Desk/i.test(body));
  check("live SUI/USDC DeepBook mark shown", /DEEPBOOK/i.test(body) && /0\.\d{3,}/.test(body));
  check("CandleVision pattern coach calling a setup", /PATTERN COACH/i.test(body) && /(Marubozu|Doji|Harami|Star|Kicking|Engulfing|Hammer|Cloud)/i.test(body));
  check(
    "live Black-Scholes quote (CALL + PUT + σ + Δ)",
    /CALL/i.test(body) && /PUT/i.test(body) && /σ\s*\d+%/.test(body) && /Δ/.test(body),
  );
  check("break-even move shown", /BREAK-?EVEN/i.test(body));
  check("payoff-at-expiry diagram present", /PAYOFF/i.test(body));

  // ── asset switch re-marks to BTC ──────────────────────────────────────────
  await page.getByRole("button", { name: "BTC" }).click().catch(() => {});
  await page.waitForTimeout(4500);
  await shot("coach-02-btc.png");
  const body2 = await page.locator("body").innerText();
  const btc = num((body2.match(/(\d{4,6}(\.\d+)?)/) || [])[1] ?? "");
  check("BTC mark re-priced (≫ SUI range)", Number.isFinite(btc) && btc > 1000, `btc≈${btc}`);

  // ── asset switch re-marks to DEEP (DeepBook's own token) ────────────────────
  await page.getByRole("button", { name: "DEEP" }).click().catch(() => {});
  await page.waitForTimeout(4500);
  await shot("coach-03-deep.png");
  const body3 = await page.locator("body").innerText();
  check(
    "DEEP desk re-marks to DEEP/USDC pool (live)",
    /DEEP\/USDC/i.test(body3) && /DEEPBOOK/i.test(body3),
    /DEEP\/USDC/i.test(body3) ? "DEEP/USDC live" : "no DEEP/USDC label",
  );

  check("no uncaught page/console errors", errors.length === 0, errors.slice(0, 2).join(" || "));
} catch (e) {
  check("flow completed without throwing", false, String(e).slice(0, 160));
  await shot("coach-99-error.png");
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.ok);
console.log("─".repeat(64));
console.log(`screenshots → ${OUT}`);
if (failed.length === 0) {
  console.log(`PASS — the DeepBook desk renders live (${checks.length} checks)`);
  process.exit(0);
}
console.log(`FAIL — ${failed.length}/${checks.length} checks failed`);
process.exit(1);
