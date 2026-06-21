#!/usr/bin/env node
// Playwright drives a real browser; it isn't a repo dependency. Resolve it at
// runtime (`playwright` → `playwright-core`); if absent, say how to enable it.
let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    console.error(
      "candle-vision browser check needs Playwright. Enable it once:\n" +
        "    npm i -D playwright && npx playwright install chromium",
    );
    process.exit(2);
  }
}

const url = process.env.CANDLE_VISION_URL || "http://127.0.0.1:5173/candle-vision";
const backend = process.env.BROWSER_BACKEND || (process.env.LIGHTCONE ? "lightcone" : "local");
const screenshotPath = process.env.CANDLE_VISION_SCREENSHOT || "/tmp/candle-vision-browser-check.png";

let lightconeClient = null;
let lightconeSession = null;
let browser = null;

try {
  if (backend === "lightcone") {
    browser = await connectLightconeBrowser();
  } else {
    browser = await chromium.launch({ headless: true });
  }

  const context = browser.contexts()[0] || await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = context.pages()[0] || await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction(() => Boolean(document.querySelector("[data-cv-host]")), null, {
    timeout: 45_000,
  });

  await page.waitForTimeout(1_000);
  const before = await topPanelText(page);
  const panelCountBefore = await panelCount(page);

  await page.mouse.move(900, 450);
  await page.mouse.down();
  await page.mouse.move(650, 450, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(800);

  const after = await topPanelText(page);
  const panelCountAfter = await panelCount(page);
  await page.screenshot({ path: screenshotPath, fullPage: false });

  console.log(JSON.stringify({
    ok: true,
    backend,
    url,
    before,
    after,
    panelCountBefore,
    panelCountAfter,
    screenshotPath,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    backend,
    url,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (lightconeClient && lightconeSession?.id) {
    await lightconeClient.computers.delete(lightconeSession.id).catch(() => {});
  }
}

async function connectLightconeBrowser() {
  if (!process.env.TZAFON_API_KEY) {
    throw new Error("BROWSER_BACKEND=lightcone requires TZAFON_API_KEY.");
  }
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(url)) {
    throw new Error(
      "Lightcone cloud browsers cannot reach your local 127.0.0.1 app directly. Use a tunnel or set CANDLE_VISION_URL to a public preview URL.",
    );
  }

  let Lightcone;
  try {
    ({ default: Lightcone } = await import("@tzafon/lightcone"));
  } catch {
    throw new Error("Install Lightcone first: npm install -D @tzafon/lightcone");
  }

  lightconeClient = new Lightcone();
  lightconeSession = await lightconeClient.computers.create({ kind: "browser" });
  const cdpPath = lightconeSession.endpoints?.cdp;
  if (!cdpPath) throw new Error("Lightcone browser session did not return a CDP endpoint.");
  return chromium.connectOverCDP(`https://api.tzafon.ai${cdpPath}`, {
    headers: { Authorization: `Bearer ${process.env.TZAFON_API_KEY}` },
  });
}

async function topPanelText(page) {
  return page.$eval("[data-cv-panel]", (el) => el.textContent?.replace(/\s+/g, " ").trim());
}

async function panelCount(page) {
  return page.$$eval("[data-cv-panel]", (els) => els.length);
}
