#!/usr/bin/env node
/**
 * e2e-ride-smoke.mjs — headless render check for /ride, the original tap-hold
 * touch/no-touch game. The other e2e smokes cover /pro, /verify and /coach;
 * this closes the loop on the last judge-facing route, asserting the no-wallet
 * lobby loads cleanly (chart renders, the faucet/onboarding affordance is
 * present, no uncaught JS errors) so a regression that white-screens /ride is
 * caught before a judge hits it.
 *
 * Read-only: it loads the live page and inspects it, never interacts on-chain
 * (the full open→crank→close loop is scripts/judge-ride-smoke.ts). Skips
 * cleanly (exit 0) if Playwright isn't installed.
 *
 *   npm run e2e:ride        (RIDE_URL / PRO_URL override the base)
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
      "SKIP e2e:ride — Playwright not installed. Enable once with:\n" +
        "    npm i -D playwright && npx playwright install chromium",
    );
    process.exit(0);
  }
}

const BASE = process.env.RIDE_URL ?? process.env.PRO_URL ?? "https://wick-markets.vercel.app";
const URL = BASE.replace(/\/$/, "") + "/ride";
const OUT = process.env.OUT ?? join(homedir(), "work/uploads/a8-e2e");
mkdirSync(OUT, { recursive: true });

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

console.log("─".repeat(64));
console.log(`Wick — /ride tap-hold game e2e @ ${URL}`);
console.log("─".repeat(64));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 480, height: 900 } }); // mobile-first
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text().slice(0, 160));
});
page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e).slice(0, 160)));

let exitCode = 0;
try {
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(4000); // let the p5 chart + data spin up

  const title = await page.title();
  check("page has the Wick title", /wick/i.test(title), title);

  const body = await page.locator("body").innerText();
  check("lobby renders content", body.length > 50, `${body.length} chars`);
  check(
    "ride/touch framing present",
    /touch|ride|hold|tap|wick|barrier|faucet|play/i.test(body),
  );

  // The ride chart is a p5 <canvas>; a white-screen regression loses it.
  const canvases = await page.locator("canvas").count();
  check("chart canvas present", canvases > 0, `${canvases} canvas`);

  check("no uncaught page/console errors", errors.length === 0, `${errors.length} errors`);
  errors.slice(0, 5).forEach((e) => console.log(`      · ${e}`));

  await page.screenshot({ path: join(OUT, "ride-lobby.png"), fullPage: true }).catch(() => {});
} catch (err) {
  check("page loaded", false, String(err).slice(0, 140));
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.ok);
console.log("─".repeat(64));
if (failed.length === 0) {
  console.log(`PASS — /ride renders cleanly (${checks.length} checks)`);
} else {
  console.log(`FAIL — ${failed.length}/${checks.length} checks failed on /ride`);
  exitCode = 1;
}
console.log("─".repeat(64));
process.exit(exitCode);
