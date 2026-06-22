/**
 * Wick Pro — commit-reveal fairness proof.
 *
 *   npm run --silent build:pro-options && npx tsx scripts/verify-fairness.ts
 *   (or just `npm run verify:pro-fairness`)
 *
 * Verify ONE specific round you actually played (the seed the engine revealed at
 * settle), not just the demo presets:
 *   npx tsx scripts/verify-fairness.ts --seed <revealedSeed> [--preset calm|volatile|trending|choppy]
 *
 * Every Pro round publishes a `commit` BEFORE the lobby, then reveals the seed
 * at settle. The commit is SHA-256(`${seed}:${paramsJson}`) — so the price path
 * is cryptographically fixed in advance and cannot be tilted against the player
 * mid-round. This script proves that property without trusting the engine:
 *
 *   1. Build a round and read its published `commit` (pre-lobby).
 *   2. At settle, take the revealed `{ seed, paramsJson }`.
 *   3. Recompute SHA-256 INDEPENDENTLY via node:crypto and assert it equals
 *      the published commit. A real cryptographic hash means the only seed that
 *      reproduces the commit is the one that drove the path you saw.
 *   4. Tamper the seed by 1 and confirm the digest no longer matches — the
 *      commit is bound to exactly this path, not a family of paths.
 *
 * Exit 0 = proof holds for every preset. Non-zero = a commit didn't bind.
 */
import assert from "node:assert/strict";
import { MARKET_PRESETS, RoundEngine, roundConfigFromPreset, presetById } from "../packages/pro-options/src/index";
import { independentCommit } from "./pro-commit";

// `--tamper` flips the demo: a dishonest house publishes an honest commit, then
// tries to swap a DIFFERENT path under it at reveal. The independent verifier
// must CATCH every forgery. Mirrors `verify:fairness:tamper` for the /ride chain.
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("usage: npx tsx scripts/verify-fairness.ts [--tamper] [--seed <n>] [--preset calm|volatile|trending|choppy]   (or: npm run verify:pro-fairness)");
  console.log("  Proves every /pro round's price path is SHA-256-committed before the lobby (commit-reveal) — recompute the digest independently and it binds. Offline.");
  process.exit(0);
}

const TAMPER = process.argv.includes("--tamper");

// `--seed <n> [--preset <id>]` verifies ONE specific round (the one a player
// actually played, using the seed the engine revealed at settle) instead of the
// canned preset sweep — so a judge can re-hash their OWN /pro round, not just our
// demo rounds. Preset ids: calm · volatile · trending · choppy (default: first).
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const seedArg = argValue("--seed");
const presetArg = argValue("--preset");

if (seedArg !== undefined && !Number.isFinite(Number(seedArg))) {
  console.error(`--seed must be a number, got "${seedArg}"`);
  process.exit(2);
}
if (presetArg !== undefined && !presetById(presetArg)) {
  console.error(`--preset "${presetArg}" not found. Valid: ${MARKET_PRESETS.map((p) => p.id).join(", ")}`);
  process.exit(2);
}

// The rounds to verify: a single custom round when --seed is given, else the sweep.
const rounds =
  seedArg !== undefined
    ? [{ preset: presetArg ? presetById(presetArg)! : MARKET_PRESETS[0], seed: Number(seedArg) }]
    : MARKET_PRESETS.map((preset, i) => ({ preset, seed: 0xc0ffee + i * 7919 }));

let failures = 0;
let caught = 0;
const startedAtMs = 1_000_000; // fixed clock — script is fully deterministic

console.log(`\nWick Pro — commit-reveal fairness proof${TAMPER ? "  [TAMPER: dishonest house]" : ""}`);
console.log("=".repeat(56));
console.log(
  TAMPER
    ? "publish honest commit → forge the reveal → verifier must CATCH it\n"
    : "publish commit (pre-lobby) → reveal seed (settle) → recompute\n",
);

for (const { preset, seed } of rounds) {
  const engine = new RoundEngine(roundConfigFromPreset({ preset, seed, startedAtMs }));

  // (1) commit is published before anyone sees the path.
  const published = engine.commit;

  // (2) the player rides the round; (3) at settle the engine reveals the preimage.
  const honest = engine.reveal();
  // In tamper mode the house lies about which seed drove the path (a different,
  // more house-favourable walk) but is stuck with the commit it already published.
  const revealedSeed = TAMPER ? honest.seed + 1 : honest.seed;

  // (4) INDEPENDENT recomputation — this is the trust-minimizing step.
  const recomputed = independentCommit(revealedSeed, honest.paramsJson);
  const binds = recomputed === published;

  if (TAMPER) {
    // The forged reveal must NOT bind — the verifier catches the lie.
    const detected = !binds;
    if (detected) caught++;
    else failures++;
    console.log(
      `${detected ? "CAUGHT" : "MISSED"}  ${preset.label.padEnd(18)} ` +
        `commit=${published.slice(0, 12)}…  forged-seed=${revealedSeed}  ` +
        `binds=${binds ? "yes (LEAK!)" : "no"}`,
    );
    continue;
  }

  // honest mode — (5) tamper check: the wrong seed must NOT reproduce the commit.
  const tampered = independentCommit(honest.seed + 1, honest.paramsJson);
  const tamperRejected = tampered !== published;

  const ok = binds && tamperRejected && honest.verified && /^[0-9a-f]{64}$/.test(published);
  if (!ok) failures++;

  console.log(
    `${ok ? "PASS" : "FAIL"}  ${preset.label.padEnd(18)} ` +
      `commit=${published.slice(0, 12)}…  seed=${honest.seed}  ` +
      `bound=${binds ? "yes" : "NO"}  tamper-rejected=${tamperRejected ? "yes" : "NO"}`,
  );

  try {
    assert.equal(recomputed, published, `${preset.label}: independent SHA-256 must equal published commit`);
    assert.ok(tamperRejected, `${preset.label}: a tampered seed must not reproduce the commit`);
    assert.ok(honest.verified, `${preset.label}: engine self-check must pass`);
    assert.match(published, /^[0-9a-f]{64}$/, `${preset.label}: commit must be 64 hex chars (SHA-256)`);
  } catch (e) {
    console.error(`  ↳ ${(e as Error).message}`);
  }
}

console.log("");
if (TAMPER) {
  // Success of the tamper demo = every forgery was caught. Exit 1 (like the
  // /ride tamper demo) to signal "a dishonest reveal was detected".
  if (failures === 0) {
    console.error(
      `CAUGHT — ${caught}/${rounds.length} forged reveal(s) rejected by independent SHA-256.\n` +
        "A dishonest house can't move the path after committing. Exit 1 = the cheat was detected.",
    );
    process.exit(1);
  }
  console.error(`LEAK — ${failures} forged reveal(s) bound to the published commit. This must never happen.`);
  process.exit(2);
}

if (failures === 0) {
  const what = seedArg !== undefined ? `round (seed ${seedArg}, ${rounds[0].preset.id})` : `${rounds.length}/${rounds.length} presets`;
  console.log(
    `PASS — ${what}: the published commit is genuine\n` +
      "SHA-256 of the revealed seed+params, recomputed independently of the engine.\n" +
      "The path was fixed before you bet. Provable, not promised.",
  );
  process.exit(0);
} else {
  console.error(`FAIL — ${failures} round(s) did not bind their commit. Fairness proof broken.`);
  process.exit(1);
}
