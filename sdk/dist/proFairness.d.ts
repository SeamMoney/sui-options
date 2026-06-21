/** The canonical /pro commit: lowercase-hex SHA-256 of `${seed}:${paramsJson}`. */
export declare function proRoundCommit(seed: number, paramsJson: string): string;
/**
 * True iff the revealed `{ seed, paramsJson }` hash to `publishedCommit` — i.e.
 * the round was honest (the path was committed before the bet). Comparison is
 * case-insensitive on the published commit.
 */
export declare function verifyProRound(publishedCommit: string, seed: number, paramsJson: string): boolean;
//# sourceMappingURL=proFairness.d.ts.map