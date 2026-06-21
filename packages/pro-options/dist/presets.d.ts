/**
 * Market presets — each synthetic market's "personality" plus the round/engine
 * knobs to build a RoundEngine from it. Personality = sigma + accelerated clock
 * (yearsPerSecond) + rug + spread. See docs/design/v2/28–29.
 */
import type { RoundEngineConfig } from "./engine";
export interface MarketPreset {
    id: string;
    label: string;
    blurb: string;
    startPrice: number;
    sigmaAnnual: number;
    driftAnnual: number;
    /** Accelerated clock: BS years per real second. */
    yearsPerSecond: number;
    rugChanceBps: number;
    rugDownPct: number;
    /** House spread (vig), basis points. */
    spreadBps: number;
}
export declare const MARKET_PRESETS: MarketPreset[];
export declare function presetById(id: string): MarketPreset | undefined;
export interface BuildRoundOpts {
    preset: MarketPreset;
    seed: number;
    startedAtMs: number;
    lobbyMs?: number;
    liveMs?: number;
    settleMs?: number;
    steps?: number;
    stepMs?: number;
}
/** Build a RoundEngineConfig from a preset + per-round seed/timing. */
export declare function roundConfigFromPreset(opts: BuildRoundOpts): RoundEngineConfig;
//# sourceMappingURL=presets.d.ts.map