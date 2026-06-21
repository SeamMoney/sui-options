#!/usr/bin/env node
/**
 * check-routes-live.mjs — live smoke for EVERY route a judge visits, not just
 * /pro. `check:pro` deeply exercises the /pro game loop; this is the breadth
 * counterpart: it confirms the "Also worth a look" routes from DEMO.md actually
 * load, render real content, and throw no uncaught errors — so a broken /coach,
 * /ride, or /verify gets caught here instead of in front of a judge.
 *
 * For each route it asserts:
 *   1. HTTP 200.
 *   2. The page renders meaningful text (not a blank/error shell).
 *   3. A route-specific landmark string is present (the page is the right page).
 *   4. No uncaught console/page errors (benign favicon/asset/ResizeObserver
 *      noise is filtered).
 *
 * Streaming routes (/pro, /ride poll a live mark) never reach `networkidle`, so
 * we wait on `domcontentloaded` + a settle delay, never on network silence.
 *
 * Usage:
 *   node scripts/check-routes-live.mjs                       # production
 *   node scripts/check-routes-live.mjs http://localhost:4173 # a local preview
 *   BASE_URL=https://wick-markets.vercel.app node scripts/check-routes-live.mjs
 *
 * Exit non-zero if any route fails. Requires Chromium (Playwright); if it isn't
 * installed the gate skips gracefully (exit 0) with install instructions — so
 * it's safe to chain in check:all without making browserless envs red.
 */
let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    console.log(
      "check:routes needs Playwright (it drives a real browser), which isn't bundled.\n" +
        "Enable it once:  npm i -D playwright && npx playwright install chromium\n" +
        "Skipping the browser route-smoke (exit 0). The curl-only `npm run smoke:demo` still ran.",
    );
    process.exit(0);
  }
}

const BASE = (process.argv[2] || process.env.BASE_URL || "https://wick-markets.vercel.app").replace(/\/$/, "");

// route → at least one landmark string proving it's the right page.
const ROUTES = [
  { path: "/pro", landmarks: ["DEEPBOOK LIVE", "UP", "DOWN"] },
  { path: "/coach", landmarks: ["DeepBook Desk", "Wick Pro"] },
  { path: "/ride", landmarks: ["ONE TAP TO START", "free test funds", "Sign in"] },
  { path: "/verify", landmarks: ["Provable Fairness", "sui::random", "candle"] },
];

const BENIGN = /favicon|ResizeObserver|net::ERR_|Failed to load resource.*\.(png|ico|jpg|svg|woff2?)/i;

const browser = await chromium.launch();
let failures = 0;

console.log(`\nWick — live route smoke — ${BASE}\n`);

for (const route of ROUTES) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  let status = 0;
  try {
    const resp = await page.goto(BASE + route.path, { waitUntil: "domcontentloaded", timeout: 35000 });
    status = resp ? resp.status() : 0;
  } catch (e) {
    errors.push("nav: " + e.message);
  }

  // Poll for a landmark instead of a single fixed wait. Heavy streaming routes
  // (e.g. /ride: a p5 ride chart that also fetches the live mark before painting
  // its "ONE TAP TO START" CTA) can take >5s to render their text — a fixed wait
  // produced a flaky false FAIL with text=8b. Read the body every 750ms for up
  // to ~18s and stop as soon as a route landmark shows up.
  let text = "";
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(750);
    text = (await page.innerText("body").catch(() => "")).replace(/\s+/g, " ").trim();
    if (route.landmarks.some((l) => text.toLowerCase().includes(l.toLowerCase()))) break;
  }
  const realErrors = errors.filter((e) => !BENIGN.test(e));
  const landmarkHit = route.landmarks.find((l) => text.toLowerCase().includes(l.toLowerCase()));

  const ok = status === 200 && text.length > 60 && !!landmarkHit && realErrors.length === 0;
  if (!ok) failures++;

  const tag = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(
    `  [${tag}] ${route.path.padEnd(8)} status=${status} text=${text.length}b ` +
      `landmark=${landmarkHit ? `"${landmarkHit}"` : "MISSING"} errors=${realErrors.length}`,
  );
  realErrors.slice(0, 4).forEach((e) => console.log(`         • ${e.slice(0, 150)}`));

  await ctx.close();
}

await browser.close();

console.log("");
if (failures === 0) {
  console.log(`PASS — ${ROUTES.length}/${ROUTES.length} judge routes live, rendered, and error-free.`);
  process.exit(0);
} else {
  console.error(`FAIL — ${failures}/${ROUTES.length} route(s) need a look before the demo.`);
  process.exit(1);
}
