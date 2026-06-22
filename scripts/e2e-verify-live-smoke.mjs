#!/usr/bin/env node
/**
 * e2e-verify-live-smoke.mjs — guards the one-click LIVE in-browser verifier on
 * /verify (shipped in the live-verify feature). The page's "Verify live
 * on-chain candles" button reads the busiest market's most recent candles
 * straight off the on-chain segment table and confirms each reproduces from its
 * key. This drives that button headless and asserts it lands on a PASS over
 * real segments — so a refactor that breaks the live path (or silently drops
 * the button) is caught before a judge clicks it.
 *
 * Read-only (it only reads chain state). Skips cleanly (exit 0) without
 * Playwright, like the sibling e2e smokes.
 *
 *   npm run e2e:verify-live        (VERIFY_URL / PRO_URL override the base)
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
      "SKIP e2e:verify-live — Playwright not installed. Enable once with:\n" +
        "    npm i -D playwright && npx playwright install chromium",
    );
    process.exit(0);
  }
}

const BASE = process.env.VERIFY_URL ?? process.env.PRO_URL ?? "https://wick-markets.vercel.app";
const URL = BASE.replace(/\/$/, "") + "/verify";
const OUT = process.env.OUT ?? join(homedir(), "work/uploads/a8-e2e");
mkdirSync(OUT, { recursive: true });

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

console.log("─".repeat(64));
console.log(`Wick — /verify LIVE-chain in-browser verifier e2e @ ${URL}`);
console.log("─".repeat(64));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 1200 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text().slice(0, 160));
});
page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e).slice(0, 160)));

try {
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2000);

  const btn = page.getByRole("button", { name: /Verify live on-chain candles/i });
  check("the live-verify button is present", (await btn.count()) > 0);

  await btn.first().click();
  // The button reads chain state (find busiest market + ~8 segment records),
  // so allow generous time; it ends in a LIVE verdict or a graceful error.
  await page
    .getByText(/LIVE — every candle reproduces|MISMATCH|Couldn’t reach the chain/i)
    .first()
    .waitFor({ timeout: 35000 })
    .catch(() => {});

  const body = await page.locator("body").innerText();
  const pass = /LIVE — every candle reproduces/.test(body);
  const reachErr = /Couldn’t reach the chain/.test(body);
  const segs = (body.match(/([\d,]+) segments recorded on-chain/) || [])[1];

  check(
    "clicking it verifies the live chain (PASS)",
    pass,
    pass ? `${segs ?? "?"} live segments reproduced` : reachErr ? "RPC unreachable (transient)" : "no verdict",
  );
  check("the live replay table renders chain hi/lo columns", /chain hi/i.test(body));

  // The live candle chart (#416) must render the replayed candles, not just the
  // table — bodies + wicks in an SVG, under the "live candles" caption.
  if (pass) {
    const candles = await page.evaluate(() => {
      if (!/live candles/i.test(document.body.innerText)) return 0;
      const svg = [...document.querySelectorAll("svg")].pop();
      return svg ? svg.querySelectorAll("rect").length : 0;
    });
    check("the live candle chart renders", candles > 0, `${candles} candle bodies drawn`);
  }

  // The "dishonest house" toggle must flip the SAME live verifier to FAIL —
  // proving it catches a lie on real data, not just always-PASS. Only meaningful
  // when the live PASS actually came back (skip on a transient RPC failure).
  if (pass) {
    await page.getByRole("checkbox").last().check().catch(() => {});
    await page.waitForTimeout(800);
    const tampered = await page.locator("body").innerText();
    check(
      "the dishonest-house toggle is caught on live data",
      /caught the tampered candle/.test(tampered),
      "verdict flips to ✗ when a fetched candle is forged",
    );
  }

  check("no uncaught page/console errors", errors.length === 0, `${errors.length} errors`);
  errors.slice(0, 5).forEach((e) => console.log(`      · ${e}`));

  await page.screenshot({ path: join(OUT, "verify-live.png"), fullPage: true }).catch(() => {});
} catch (err) {
  check("page loaded + verified", false, String(err).slice(0, 140));
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.ok);
console.log("─".repeat(64));
if (failed.length === 0) {
  console.log(`PASS — /verify proves the LIVE chain in-browser (${checks.length} checks)`);
  process.exit(0);
}
console.log(`FAIL — ${failed.length}/${checks.length} checks failed on /verify live mode`);
process.exit(1);
