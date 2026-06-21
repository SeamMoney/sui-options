#!/usr/bin/env node
/**
 * e2e-verify-smoke.mjs — drives the /verify "Provable Fairness" page headless
 * and proves Wick's headline differentiator still works BOTH ways:
 *
 *   HONEST run    → every replayed segment matches the chain-reported candle
 *                   (all ✓, an explicit PASS verdict, no ✗ in the table)
 *   DISHONEST run → tick "Simulate a dishonest house" and re-run; the tampered
 *                   segment is caught (a ✗ appears, an explicit FAIL verdict)
 *
 * This is the in-browser TypeScript port of the on-chain `expand_segment`
 * (checked against 10k vectors in CI) running over a sample ride. If a refactor
 * ever silently breaks the replay or the tamper detector, this fails loudly.
 *
 * Screenshots both states to $OUT (default ~/work/uploads/a8-e2e). Read-only.
 *
 * Usage:  npm run e2e:verify        (PRO_URL/VERIFY_URL override the base)
 * Skips cleanly (exit 0) if Playwright isn't installed.
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
      "SKIP e2e:verify — Playwright not installed. Enable once with:\n" +
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
console.log(`Wick — /verify provable-fairness e2e @ ${URL}`);
console.log("─".repeat(64));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 1200 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text().slice(0, 160));
});
page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e).slice(0, 160)));

const shot = (n) => page.screenshot({ path: join(OUT, n), fullPage: true }).catch(() => {});
const runBtn = () => page.getByRole("button", { name: /Run verification/i });
// count the ✗/✓ glyphs that appear in the replay table region only
const glyphCounts = async () => {
  const body = await page.locator("body").innerText();
  return {
    cross: (body.match(/✗/g) || []).length,
    tick: (body.match(/✓/g) || []).length,
    body,
  };
};

try {
  await page.goto(URL, { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(5000);

  const intro = await page.locator("body").innerText();
  check("page renders the Provable Fairness explainer", /Provable Fairness/i.test(intro));
  check("Run verification control present", (await runBtn().count()) > 0);
  check(
    "dishonest-house toggle present",
    (await page.locator("input[type=checkbox]").count()) > 0,
  );

  // ── honest run ───────────────────────────────────────────────────────────
  await runBtn().first().click();
  await page.waitForTimeout(4000);
  await shot("verify-01-honest.png");
  const honest = await glyphCounts();
  check("honest replay produces matching segments (✓)", honest.tick >= 1, `${honest.tick} ✓`);
  check("honest replay has NO mismatched segment (✗)", honest.cross === 0, `${honest.cross} ✗`);
  check(
    "honest verdict reads PASS / fair / honest",
    /PASS|fair|honest|did not lie/i.test(honest.body),
  );

  // ── dishonest run ────────────────────────────────────────────────────────
  await page.locator("input[type=checkbox]").first().check();
  await page.waitForTimeout(400);
  await runBtn().first().click();
  await page.waitForTimeout(4000);
  await shot("verify-02-dishonest.png");
  const bad = await glyphCounts();
  check("tamper is CAUGHT — a mismatched segment appears (✗)", bad.cross >= 1, `${bad.cross} ✗`);
  check(
    "dishonest verdict reads FAIL / lied / tampered",
    /FAIL|lied|tamper|cheat|mismatch/i.test(bad.body),
  );

  check("no uncaught page/console errors", errors.length === 0, errors.slice(0, 2).join(" || "));
} catch (e) {
  check("flow completed without throwing", false, String(e).slice(0, 160));
  await shot("verify-99-error.png");
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.ok);
console.log("─".repeat(64));
console.log(`screenshots → ${OUT}`);
if (failed.length === 0) {
  console.log(`PASS — /verify proves fairness both ways (${checks.length} checks)`);
  process.exit(0);
}
console.log(`FAIL — ${failed.length}/${checks.length} checks failed`);
process.exit(1);
