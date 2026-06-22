/**
 * The independent (engine-free) recomputation of a Wick Pro round's commit:
 * `SHA-256(`${seed}:${paramsJson}`)`. This is the trust-minimizing core of the
 * /pro commit-reveal fairness proof — it must NOT call any pro-options code, so a
 * judge can confirm the published commit binds the revealed path using only the
 * Node standard library. Extracted from verify-fairness.ts so the exact commit
 * FORMAT is lockable by a golden SHA-256 vector + a fast engine-conformance unit
 * test (verify-fairness.test.ts), the /pro analogue of the /ride seeded-path /
 * rug-roll / Bachelier golden vectors.
 */
import { createHash } from "node:crypto";

export function independentCommit(seed: number, paramsJson: string): string {
  return createHash("sha256").update(`${seed}:${paramsJson}`).digest("hex");
}
