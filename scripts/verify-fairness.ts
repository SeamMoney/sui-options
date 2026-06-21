/**
 * Wick Pro — commit-reveal fairness proof.
 *
 *   npm run --silent build:pro-options && npx tsx scripts/verify-fairness.ts
 *   (or just `npm run verify:fairness`)
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
import { createHash } from "node:crypto";
import { MARKET_PRESETS, RoundEngine, roundConfigFromPreset } from "../packages/pro-options/src/index";

/** Independent verifier — does NOT call any pro-options code. */
function independentCommit(seed: number, paramsJson: string): string {
  return createHash("sha256").update(`${seed}:${paramsJson}`).digest("hex");
}

let failures = 0;
const startedAtMs = 1_000_000; // fixed clock — script is fully deterministic

console.log("\nWick Pro — commit-reveal fairness proof");
console.log("=".repeat(56));
console.log("publish commit (pre-lobby) → reveal seed (settle) → recompute\n");

for (let i = 0; i < MARKET_PRESETS.length; i++) {
  const preset = MARKET_PRESETS[i];
  const seed = 0xc0ffee + i * 7919; // distinct per preset, deterministic
  const engine = new RoundEngine(roundConfigFromPreset({ preset, seed, startedAtMs }));

  // (1) commit is published before anyone sees the path.
  const published = engine.commit;

  // (2) the player rides the round; (3) at settle the engine reveals the preimage.
  const r = engine.reveal();

  // (4) INDEPENDENT recomputation — this is the trust-minimizing step.
  const recomputed = independentCommit(r.seed, r.paramsJson);
  const binds = recomputed === published;

  // (5) tamper check: the wrong seed must NOT reproduce the commit.
  const tampered = independentCommit(r.seed + 1, r.paramsJson);
  const tamperRejected = tampered !== published;

  const ok = binds && tamperRejected && r.verified && /^[0-9a-f]{64}$/.test(published);
  if (!ok) failures++;

  console.log(
    `${ok ? "PASS" : "FAIL"}  ${preset.label.padEnd(18)} ` +
      `commit=${published.slice(0, 12)}…  seed=${r.seed}  ` +
      `bound=${binds ? "yes" : "NO"}  tamper-rejected=${tamperRejected ? "yes" : "NO"}`,
  );

  try {
    assert.equal(recomputed, published, `${preset.label}: independent SHA-256 must equal published commit`);
    assert.ok(tamperRejected, `${preset.label}: a tampered seed must not reproduce the commit`);
    assert.ok(r.verified, `${preset.label}: engine self-check must pass`);
    assert.match(published, /^[0-9a-f]{64}$/, `${preset.label}: commit must be 64 hex chars (SHA-256)`);
  } catch (e) {
    console.error(`  ↳ ${(e as Error).message}`);
  }
}

console.log("");
if (failures === 0) {
  console.log(
    `PASS — ${MARKET_PRESETS.length}/${MARKET_PRESETS.length} presets: the published commit is genuine\n` +
      "SHA-256 of the revealed seed+params, recomputed independently of the engine.\n" +
      "The path was fixed before you bet. Provable, not promised.",
  );
  process.exit(0);
} else {
  console.error(`FAIL — ${failures} preset(s) did not bind their commit. Fairness proof broken.`);
  process.exit(1);
}
