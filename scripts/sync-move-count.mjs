#!/usr/bin/env node
/**
 * sync-move-count — rewrite the Move-test count in EVERY judge-facing doc to the
 * authoritative number in one shot, so a count bump can't leave a straggler.
 *
 * Why this exists: the count is hard-coded in ~8 spots across 4 files (README
 * badge + body + layout tree + the `sui move test` command comment, move/SAFETY.md,
 * deployments/ADDRESSES.md, docs/runbooks/v4.26_deploy_runbook.md). Every test PR
 * that updated only some of them left main RED on `check:doc-counts` / `check:meta`
 * (recurred #735, #744, …). Run this after adding/removing a Move test and all
 * docs move together.
 *
 * Authoritative count = the number of `#[test]` functions in move/sources +
 * move/tests — exactly what scripts/check-doc-counts.sh asserts the docs against
 * (it verified this static proxy == the `sui move test` total). No slow compile.
 *
 * Usage:
 *   node scripts/sync-move-count.mjs            # derive count from move/, rewrite docs
 *   node scripts/sync-move-count.mjs --check    # exit 1 if any doc would change (CI-style)
 *   node scripts/sync-move-count.mjs 695         # force a specific count
 *
 * Only digit groups inside an unambiguous count phrasing are touched — PR refs
 * like "(#694)" and 0x object ids never match (they lack the "/NNN", "Move tests",
 * "Total tests:", "passing", or "move%20tests-" context).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const forced = args.find((a) => /^\d{3,4}$/.test(a));

// Authoritative count: #[test] functions in move/ (matches check-doc-counts.sh).
function moveTestCount() {
  const out = execSync(
    `grep -rhoE '#\\[test\\]' move/sources move/tests 2>/dev/null | wc -l`,
    { cwd: root, encoding: "utf8" },
  );
  return parseInt(out.trim(), 10);
}

const N = forced ? parseInt(forced, 10) : moveTestCount();
if (!Number.isFinite(N) || N < 100) {
  console.error(`sync-move-count: refusing to use an implausible count (${N}). Aborting.`);
  process.exit(2);
}

// Each rule rewrites only the count digits inside a count-specific context.
const rules = [
  { re: /move%20tests-\d{3,4}%2F\d{3,4}/g, to: () => `move%20tests-${N}%2F${N}` }, // shields badge
  { re: /(\d{3,4})(\s*\/\s*)(\d{3,4})(\*{0,2}\s+(?:Move\s+)?tests)/g, to: (_m, _a, sep, _b, suf) => `${N}${sep}${N}${suf}` }, // "695 / 695 Move tests" + bolded "**695 / 695** Move tests" (README:250 main claim — the \*{0,2} keeps markdown bold from blocking the rewrite)
  { re: /(\d{3,4})(\s+Move tests)/g, to: (_m, _a, suf) => `${N}${suf}` }, // "695 Move tests"
  { re: /(Total tests:\s*)\d{3,4}(;\s*passed:\s*)\d{3,4}/g, to: (_m, a, b) => `${a}${N}${b}${N}` }, // runbook expect line
  { re: /(\d{3,4})\s*\/\s*(\d{3,4})(\s+passing)/g, to: (_m, _a, _b, suf) => `${N}/${N}${suf}` }, // SAFETY "695/695 passing"
  { re: /(#\s+)\d{3,4}\/\d{3,4}/g, to: (_m, a) => `${a}${N}/${N}` }, // README cmd comment "# 695/695"
];

const files = [
  "README.md",
  "move/SAFETY.md",
  "deployments/ADDRESSES.md",
  "docs/runbooks/v4.26_deploy_runbook.md",
];

let changedFiles = 0;
const changes = [];
for (const rel of files) {
  const path = join(root, rel);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    continue;
  }
  let next = text;
  for (const { re, to } of rules) next = next.replace(re, to);
  if (next !== text) {
    changedFiles++;
    changes.push(rel);
    if (!checkOnly) writeFileSync(path, next);
  }
}

if (checkOnly) {
  if (changedFiles > 0) {
    console.error(`✗ ${changedFiles} doc(s) out of sync with the ${N}-test source: ${changes.join(", ")}`);
    console.error(`  Run: npm run sync:count`);
    process.exit(1);
  }
  console.log(`✓ all docs already state the authoritative Move-test count: ${N}`);
  process.exit(0);
}

if (changedFiles === 0) console.log(`✓ docs already at ${N} — nothing to change.`);
else console.log(`✓ synced ${changedFiles} doc(s) to ${N} Move tests: ${changes.join(", ")}`);
