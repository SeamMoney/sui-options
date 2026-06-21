/**
 * Round clock + fairness commitment for Pro Mode.
 *
 * Phases: lobby → live → settle → results. The Desk UI is shown in `lobby`
 * (deliberate option opens); the Live management UI is shown in `live`
 * (Sell-to-close on owned positions). See docs/design/v2/28 §5.
 */
export type RoundPhase = "lobby" | "live" | "settle" | "results";
export interface RoundConfig {
    startedAtMs: number;
    lobbyMs: number;
    liveMs: number;
    settleMs: number;
}
export declare function roundPhase(cfg: RoundConfig, nowMs: number): RoundPhase;
/** Wall-clock ms at which the live reveal starts. */
export declare function liveStartMs(cfg: RoundConfig): number;
/** Milliseconds remaining in the current phase (0 once past `results`). */
export declare function phaseRemainingMs(cfg: RoundConfig, nowMs: number): number;
/**
 * Reveal progress during the live phase: how many of `totalSteps` price steps
 * should be visible at `nowMs`. 0 in the lobby, `totalSteps` once live ends.
 */
export declare function revealedSteps(cfg: RoundConfig, nowMs: number, totalSteps: number): number;
/**
 * Fairness commitment over the seed + params: the full SHA-256 of
 * `${seed}:${paramsJson}`, as 64 lowercase hex chars. The engine publishes this
 * before the lobby and reveals the seed at settle, so anyone can recompute the
 * digest and confirm the streamed path was fixed in advance — a real
 * commit-reveal, not a toy hash.
 *
 * Implemented as a dependency-free, synchronous SHA-256 so the same code runs
 * in the browser and in Node without Web Crypto's async `subtle.digest`. The
 * digest matches `crypto.createHash("sha256").update(input).digest("hex")`.
 */
export declare function commit(seed: number, paramsJson: string): string;
//# sourceMappingURL=round.d.ts.map