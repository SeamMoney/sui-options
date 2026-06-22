/**
 * Cold-gate guard: every relative link in the judge-facing docs must resolve to
 * a real file in the repo.
 *
 * The README/DEMO/CONTRACT_INTERFACE/etc. link heavily to other repo files —
 * design specs, move/SAFETY.md, sdk sources, the architecture diagrams. A fleet
 * edit that moves or renames a target (or a typo'd path) turns one of these into
 * a 404 the moment a judge clicks it on GitHub, with no other test noticing.
 * This walks each doc's markdown links and asserts the local targets exist
 * (external http/mailto/# anchors are skipped — we can't reach the network in
 * the cold gate, and pure anchors are in-page).
 *
 * Run:  npx tsx --test scripts/doc-links.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The judge-facing docs (the ones a judge actually reads + clicks through).
const DOCS = [
  "README.md",
  "DEMO.md",
  "AGENTS.md",
  "CONTRACT_INTERFACE.md",
  "docs/provable-fairness.md",
];

/** Extract local link targets from markdown `[text](target)` syntax. */
function localLinkTargets(md: string): string[] {
  const out: string[] = [];
  const re = /\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    // Strip an optional `"title"` and any `#anchor`, keep the path token.
    const path = m[1].trim().split(/\s+/)[0]!.split("#")[0]!;
    if (!path) continue; // pure in-page anchor
    if (/^(https?:|mailto:|tel:)/i.test(path)) continue; // external
    out.push(path);
  }
  return out;
}

for (const doc of DOCS) {
  test(`every relative link in ${doc} resolves to a real file`, () => {
    const docPath = join(REPO_ROOT, doc);
    assert.ok(existsSync(docPath), `${doc} itself must exist`);
    const md = readFileSync(docPath, "utf8");
    const baseDir = dirname(docPath);
    const broken = localLinkTargets(md).filter((link) => !existsSync(resolve(baseDir, link)));
    assert.deepEqual(broken, [], `broken relative links in ${doc}:\n  ${broken.join("\n  ")}`);
  });
}
