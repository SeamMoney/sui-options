/**
 * Cross-surface conformance for the /pro commit — the basis of DEMO.md's
 * "N independent surfaces, one SHA-256, same answer" claim.
 *
 * The independent verifiers deliberately use DIFFERENT crypto implementations so
 * that verifying doesn't trust a shared library:
 *   - CLI  (verify:pro-round / pro-commit.ts):  node:crypto  createHash("sha256")
 *   - SDK  (@wick/sdk proFairness.ts):           @noble/hashes sha256 + utf8ToBytes
 *   - browser (/api/verify-pro):                 Web Crypto subtle.digest
 *
 * "Same answer" is only TRUE if these agree byte-for-byte. That's an assumption
 * about UTF-8 encoding + SHA-256 across three libraries — exactly the kind of
 * thing that silently drifts (e.g. a library hashing UTF-16, or normalising).
 * This pins the two we can run in-process (node:crypto vs @noble) against each
 * other AND against the golden vector, so a dependency bump can't quietly break
 * the multi-surface guarantee.
 *
 * Run:  npx tsx --test scripts/pro-commit-conformance.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { webcrypto } from "node:crypto";
import { independentCommit } from "./pro-commit.js";
import { proRoundCommit, verifyProRound } from "../sdk/src/proFairness.js";

// The golden vector locked in verify-fairness.test.ts (CLI side).
const GOLDEN_SEED = 12345;
const GOLDEN_PARAMS = "{}";
const GOLDEN_COMMIT = "f3941fc98b2dffa0efee7db98a8b0f7407c6979af7ba4dc351495485f41044bb";

const CASES: Array<[number, string]> = [
  [GOLDEN_SEED, GOLDEN_PARAMS],
  [0, ""],
  [424242, '{"startPrice":100,"sigmaAnnual":0.9}'],
  [999, '{"a":1,"b":[2,3],"c":"x","unicode":"αβγ→💥"}'],
  [4242, '{"startPrice":100,"sigmaAnnual":0.9,"driftAnnual":0,"rugChanceBps":80,"rugDownPct":0.05,"steps":90,"stepMs":1000,"yearsPerSecond":0.002}'],
];

test("SDK @noble proRoundCommit === CLI node:crypto independentCommit (same answer, different libs)", () => {
  for (const [seed, params] of CASES) {
    assert.equal(
      proRoundCommit(seed, params),
      independentCommit(seed, params),
      `the two independent SHA-256 implementations must agree for seed=${seed} params=${params}`,
    );
  }
});

test("the golden commit holds in BOTH implementations", () => {
  assert.equal(independentCommit(GOLDEN_SEED, GOLDEN_PARAMS), GOLDEN_COMMIT, "CLI (node:crypto)");
  assert.equal(proRoundCommit(GOLDEN_SEED, GOLDEN_PARAMS), GOLDEN_COMMIT, "SDK (@noble)");
});

test("SDK verifyProRound accepts a CLI-computed commit and rejects a tampered one (cross-surface)", () => {
  const seed = 424242;
  const params = '{"startPrice":100,"sigmaAnnual":0.9}';
  const commit = independentCommit(seed, params); // CLI computes
  assert.equal(verifyProRound(commit, seed, params), true, "SDK must accept the CLI's commit (HONEST)");
  assert.equal(verifyProRound(commit, seed + 1, params), false, "tampered seed → rejected");
  assert.equal(verifyProRound(commit.toUpperCase(), seed, params), true, "case-insensitive on the published commit");
});

test("browser Web Crypto (verify-pro.html / api page) === node:crypto + @noble (3rd surface)", async () => {
  // scripts/verify-pro.html (the README's LEAD verifier, '/verify in your
  // browser') computes the commit as:
  //   crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed + ":" + params))
  // (verify-pro.html:61-73). Node's webcrypto.subtle IS the same Web Crypto API
  // the browser runs, so it's a faithful in-process proxy. This closes the third
  // crypto implementation in the 'N surfaces, one SHA-256, same answer' claim —
  // a Web-Crypto-specific UTF-8/encoding divergence would silently break the
  // most-used judge verifier, and nothing tested it.
  const sha256HexWebCrypto = async (str: string): Promise<string> => {
    const buf = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return Buffer.from(buf).toString("hex");
  };
  for (const [seed, params] of CASES) {
    const browser = await sha256HexWebCrypto(`${seed}:${params}`); // exactly verify-pro.html's input
    assert.equal(
      browser,
      independentCommit(seed, params),
      `Web Crypto must agree with node:crypto for seed=${seed} params=${params}`,
    );
    assert.equal(browser, proRoundCommit(seed, params), "Web Crypto must also agree with @noble (SDK)");
  }
  // And the golden vector holds in Web Crypto too.
  assert.equal(await sha256HexWebCrypto(`${GOLDEN_SEED}:${GOLDEN_PARAMS}`), GOLDEN_COMMIT);
});
