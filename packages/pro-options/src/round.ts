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

export function roundPhase(cfg: RoundConfig, nowMs: number): RoundPhase {
  const t = nowMs - cfg.startedAtMs;
  if (t < cfg.lobbyMs) return "lobby";
  if (t < cfg.lobbyMs + cfg.liveMs) return "live";
  if (t < cfg.lobbyMs + cfg.liveMs + cfg.settleMs) return "settle";
  return "results";
}

/** Wall-clock ms at which the live reveal starts. */
export function liveStartMs(cfg: RoundConfig): number {
  return cfg.startedAtMs + cfg.lobbyMs;
}

/** Milliseconds remaining in the current phase (0 once past `results`). */
export function phaseRemainingMs(cfg: RoundConfig, nowMs: number): number {
  const t = nowMs - cfg.startedAtMs;
  const lobbyEnd = cfg.lobbyMs;
  const liveEnd = lobbyEnd + cfg.liveMs;
  const settleEnd = liveEnd + cfg.settleMs;
  if (t < lobbyEnd) return lobbyEnd - t;
  if (t < liveEnd) return liveEnd - t;
  if (t < settleEnd) return settleEnd - t;
  return 0;
}

/**
 * Reveal progress during the live phase: how many of `totalSteps` price steps
 * should be visible at `nowMs`. 0 in the lobby, `totalSteps` once live ends.
 */
export function revealedSteps(cfg: RoundConfig, nowMs: number, totalSteps: number): number {
  const intoLive = nowMs - liveStartMs(cfg);
  if (intoLive <= 0) return 0;
  if (intoLive >= cfg.liveMs) return totalSteps;
  return Math.floor((intoLive / cfg.liveMs) * totalSteps);
}

/**
 * Fairness commitment over the seed + params. FNV-1a 32-bit — a deterministic
 * placeholder; the on-chain/production commit uses SHA-256. Same input ⇒ same
 * commit, which is all the off-chain prototype needs to wire the flow.
 */
export function commit(seed: number, paramsJson: string): string {
  const input = `${seed}:${paramsJson}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
