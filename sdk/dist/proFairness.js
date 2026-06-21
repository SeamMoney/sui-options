/**
 * Wick Pro — commit-reveal verification primitive for integrators.
 *
 * Every /pro round publishes `commit = SHA-256(`${seed}:${paramsJson}`)` before
 * the lobby and reveals `{ seed, paramsJson }` at settle. These helpers let any
 * consumer (a dashboard, a bot, a watcher) recompute the digest and confirm a
 * round's price path was fixed in advance — the same guarantee as
 * `npm run verify:pro-fairness` and `POST /api/verify-pro`, but as a one-import
 * function.
 *
 * Independent by construction: it hashes with @noble/hashes (sync, browser+node,
 * no Web Crypto async), NOT with the round engine's own code — so verifying does
 * not trust the thing being verified.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
/** The canonical /pro commit: lowercase-hex SHA-256 of `${seed}:${paramsJson}`. */
export function proRoundCommit(seed, paramsJson) {
    return bytesToHex(sha256(utf8ToBytes(`${seed}:${paramsJson}`)));
}
/**
 * True iff the revealed `{ seed, paramsJson }` hash to `publishedCommit` — i.e.
 * the round was honest (the path was committed before the bet). Comparison is
 * case-insensitive on the published commit.
 */
export function verifyProRound(publishedCommit, seed, paramsJson) {
    if (typeof publishedCommit !== "string" || !/^[0-9a-fA-F]{64}$/.test(publishedCommit))
        return false;
    return proRoundCommit(seed, paramsJson) === publishedCommit.toLowerCase();
}
//# sourceMappingURL=proFairness.js.map