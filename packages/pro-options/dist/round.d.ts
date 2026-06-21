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
 * Fairness commitment over the seed + params. FNV-1a 32-bit — a deterministic
 * placeholder; the on-chain/production commit uses SHA-256. Same input ⇒ same
 * commit, which is all the off-chain prototype needs to wire the flow.
 */
export declare function commit(seed: number, paramsJson: string): string;
//# sourceMappingURL=round.d.ts.map