#!/usr/bin/env node
/**
 * check:meta — a fast, no-browser gate on the static HTML config that's easy to
 * regress when many hands edit index.html, yet shapes every judge's very first
 * impression: the cold-load paint, the social share card, and the app icons.
 *
 * Locks:
 *   - FOUC fix: an inline dark background so a cold load never flashes white
 *   - Share card: OG/Twitter + <meta name=description> describe the DeepBook
 *     OPTIONS submission (not the old Ride-only "ride a barrier" pitch), point
 *     og:image at og.png and og:url at /pro
 *   - PWA manifest description matches (mentions DeepBook)
 *   - apple-touch-icon is the PNG iOS actually honours (not an SVG)
 *
 * Pure file reads — no network, no Playwright. Exit 0 = pass, 1 = a regression.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "frontend/index.html"), "utf8");
const manifest = readFileSync(join(root, "frontend/public/site.webmanifest"), "utf8");

const fails = [];
const ok = [];
function assert(cond, label) {
  (cond ? ok : fails).push(label);
}

// FOUC: an inline background applied before the CSS bundle (kills the white flash).
assert(/<style>[^<]*background-color\s*:\s*#[0-9a-f]{3,6}/i.test(html), "index.html: inline dark background (no white-flash FOUC)");

// Share card describes the DeepBook options submission, not the stale Ride pitch.
const descs = [...html.matchAll(/(?:name="description"|property="og:description"|name="twitter:description")\s*\n?\s*content="([^"]*)"/g)].map((m) => m[1]);
assert(descs.length >= 3, `index.html: 3 share descriptions present (found ${descs.length})`);
assert(descs.every((d) => /deepbook/i.test(d)), "index.html: every share description names DeepBook");
assert(!descs.some((d) => /ride a barrier tick-by-tick/i.test(d)), "index.html: no stale Ride-only share copy");
assert(/og:image"\s*content="[^"]*og\.png"/.test(html), "index.html: og:image → og.png");
assert(/og:url"\s*content="[^"]*\/pro"/.test(html), "index.html: og:url → /pro (the submission)");

// apple-touch-icon must be a PNG (iOS ignores SVG touch icons).
assert(/rel="apple-touch-icon"[^>]*href="[^"]*\.png"/.test(html), "index.html: apple-touch-icon is a PNG");

// Manifest description matches the share card.
assert(/"description"\s*:\s*"[^"]*deepbook/i.test(manifest), "site.webmanifest: description names DeepBook");

// No phantom commands: every `npm run X` a judge copy-pastes from README/DEMO must
// be a real script. #276 reverted `rides:recent` but left a dangling ref (#280) —
// this guard makes that class of "command not found" impossible to ship again.
const scripts = new Set(Object.keys(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts || {}));
const docText = ["README.md", "DEMO.md"].map((f) => readFileSync(join(root, f), "utf8")).join("\n");
const referenced = [...new Set([...docText.matchAll(/\bnpm run ([a-z0-9:_-]+)/g)].map((m) => m[1]))]
  .filter((s) => s !== "-w"); // `npm run -w <workspace>` is a flag, not a script name
const phantom = referenced.filter((s) => !scripts.has(s));
assert(phantom.length === 0, `README/DEMO npm scripts all exist${phantom.length ? ` (phantom: ${phantom.join(", ")})` : ""}`);

// Move-test-count consistency. The count is hardcoded in many doc spots (README
// CI badge + body + layout tree, DEMO, SAFETY) and has repeatedly drifted into
// self-contradiction when a test PR updated some but not all (574 vs 577 vs 584
// across #304/#306/#321/#323/#326). This guard doesn't know the absolute count
// (that needs a `sui move test` run) — it asserts every doc reference AGREES, so
// a partial update can't ship a set of numbers that disagree with each other.
const countDocs = ["README.md", "DEMO.md", "move/SAFETY.md"]
  .map((f) => readFileSync(join(root, f), "utf8"))
  .join("\n");
const countNums = [
  ...countDocs.matchAll(/move%20tests-(\d{3,4})/g), // CI badge
  ...countDocs.matchAll(/(\d{3,4})\s*\/\s*\d{3,4}\s*(?:Move\s+)?(?:tests|pass)/gi), // "584/584 Move tests" · "584 / 584 pass"
  ...countDocs.matchAll(/(\d{3,4})\s+Move tests/g), // "584 Move tests"
  ...countDocs.matchAll(/(\d{3,4})-test suite/g), // "584-test suite"
].map((m) => m[1]);
const distinctCounts = [...new Set(countNums)];
assert(
  distinctCounts.length <= 1,
  `Move test count agrees across all docs${distinctCounts.length > 1 ? ` (DISAGREE: ${distinctCounts.join(" vs ")} — update the badge, README body, layout tree, DEMO, and SAFETY together)` : ` (${distinctCounts[0] ?? "none found"})`}`,
);

for (const o of ok) console.log(`  ✓ ${o}`);
for (const f of fails) console.error(`  ✗ ${f}`);
if (fails.length) {
  console.error(`\nFAIL — ${fails.length} meta regression(s). The share card / cold-load is judge-facing; fix before shipping.`);
  process.exit(1);
}
console.log(`\nPASS — meta/share-card/cold-load gate (${ok.length} checks).`);
