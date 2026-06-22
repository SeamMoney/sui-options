#!/usr/bin/env tsx
/**
 * verify-pro-round — independently re-verify ONE /pro round from the terminal.
 *
 * `npm run play` prints a round's `commit`, the revealed `seed`, and its
 * `paramsJson`. This recomputes the commit from (seed, paramsJson) using the
 * SAME SHA-256 the engine commits with (`scripts/pro-commit.ts`, golden-locked
 * against the engine in CI) and confirms it equals the published commit —
 * proving the price path was sealed BEFORE the seed was revealed.
 *
 * It's the CLI-native twin of the /api/verify-pro browser page: a judge already
 * in the terminal running `play` can re-verify the exact round they saw without
 * switching to a browser, and pipe/script the result (exit 0 HONEST, 1 TAMPERED).
 *
 *   npm run verify:pro-round -- --commit <hex> --seed <n> --params '<paramsJson>'
 *
 * The three values are copied verbatim from `npm run play` output (quote the
 * paramsJson). Use the *revealed* seed `play` prints, not any --seed you passed in.
 */
import { pathToFileURL } from "node:url";
import { independentCommit } from "./pro-commit.js";

/**
 * Recompute the commit from (seed, paramsJson) and compare to the published one.
 * Pure + exported so the verdict logic is unit-testable without a subprocess.
 * The published commit is normalised (trim + lowercase) since it's pasted by hand.
 */
export function checkRound(
  commit: string,
  seed: number,
  paramsJson: string,
): { ok: boolean; recomputed: string; published: string } {
  // Trim paramsJson like the published commit: a trailing newline from a
  // line-copy of play's output must not false-MISMATCH. The engine's paramsJson
  // is compact JSON (no surrounding whitespace); internal tamper is untouched.
  const recomputed = independentCommit(seed, paramsJson.trim());
  const published = commit.trim().toLowerCase();
  return { ok: recomputed === published, recomputed, published };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function usage(): never {
  console.error(
    "usage: npm run verify:pro-round -- --commit <hex> --seed <n> --params '<paramsJson>'",
  );
  console.error(
    "  the three values are printed by 'npm run play' — copy the commit, the REVEALED seed, and the paramsJson (quote it).",
  );
  process.exit(2);
}

function main(): void {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      "usage: npm run verify:pro-round -- --commit <hex> --seed <n> --params '<paramsJson>'",
    );
    console.log(
      "  Independently re-hashes a /pro round's (seed, paramsJson) and checks it equals the published commit",
    );
    console.log(
      "  (proving the path was committed before the reveal). Get the three values from 'npm run play'.",
    );
    process.exit(0);
  }

  const commit = arg("--commit");
  const seedStr = arg("--seed");
  const params = arg("--params");
  if (!commit || !seedStr || params === undefined) usage();

  // Validate the commit is a 64-hex SHA-256 BEFORE comparing — mirrors the
  // browser (verify-pro.html) + server (api/verify-pro.ts) verifiers. Without
  // this, a typo'd or partially-copied commit falls through to a misleading
  // "TAMPERED" (false "house cheated") instead of a clear input error.
  if (!/^[0-9a-f]{64}$/i.test(commit.trim())) {
    console.error(
      `--commit must be a 64-char hex SHA-256 string (got ${commit.trim().length} chars). ` +
        `Copy the 'commit:' line 'npm run play' prints — a typo/partial copy looks like a tamper, it isn't one.`,
    );
    process.exit(2);
  }

  const seed = Number(seedStr);
  if (!Number.isFinite(seed)) {
    console.error(`--seed must be a number, got ${JSON.stringify(seedStr)}`);
    process.exit(2);
  }
  try {
    JSON.parse(params!);
  } catch {
    console.error(
      "--params is not valid JSON — paste the exact paramsJson 'npm run play' printed, single-quoted.",
    );
    process.exit(2);
  }

  const { ok, recomputed, published } = checkRound(commit!, seed, params!);
  console.log(`published commit : ${published}`);
  console.log(`recomputed       : ${recomputed}`);
  console.log("");
  if (ok) {
    console.log(
      "HONEST — commit = SHA-256(seed:paramsJson). The price path was sealed before the seed was revealed; the house could not have chosen it after seeing your bet.",
    );
    process.exit(0);
  } else {
    console.log(
      "TAMPERED — the recomputed commit does NOT match the published one. The revealed (seed, params) is not what was committed.",
    );
    process.exit(1);
  }
}

// Run only when invoked directly (not when imported by the test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
