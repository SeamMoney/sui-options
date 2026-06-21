/**
 * RoundHost — the live runtime around RoundEngine.
 *
 * Turns the deterministic engine into a running game: on each `tick(nowMs)` it
 * detects phase transitions, advances the reveal, auto-settles expired options,
 * and (at settle) reveals + verifies the seed — emitting typed events. The same
 * host runs client-side (single-player) or server-side (multiplayer); only who
 * calls `tick` and who consumes events differs. See docs/design/v2/29.
 *
 * Driving it: call `tick(nowMs)` from a rAF/gsap loop (browser) or use
 * `start({ now, intervalMs })` for a self-driven setInterval loop (node/server).
 */
import type { RoundEngine } from "./engine";
import type { RoundPhase } from "./round";
import type { OptionPosition } from "./types";
export type HostEvent = {
    type: "phase";
    phase: RoundPhase;
    prev: RoundPhase | null;
    nowMs: number;
} | {
    type: "reveal-step";
    revealed: number;
    spot: number;
    nowMs: number;
} | {
    type: "settled";
    positions: OptionPosition[];
    nowMs: number;
} | {
    type: "reveal-seed";
    seed: number;
    paramsJson: string;
    commit: string;
    verified: boolean;
    nowMs: number;
};
export type HostListener = (event: HostEvent) => void;
export interface StartOptions {
    /** Wall-clock provider (defaults to Date.now). */
    now?: () => number;
    /** Tick interval in ms (default 100). */
    intervalMs?: number;
}
export declare class RoundHost {
    readonly engine: RoundEngine;
    private readonly listeners;
    private lastPhase;
    private lastRevealed;
    private seedRevealed;
    private timer;
    constructor(engine: RoundEngine);
    /** Subscribe; returns an unsubscribe fn. */
    on(listener: HostListener): () => void;
    private emit;
    /** Advance the round to `nowMs`, emitting any state changes. Idempotent per ms. */
    tick(nowMs: number): void;
    /** Self-driven loop (node/server). Browser UIs should drive `tick` from rAF instead. */
    start(opts?: StartOptions): void;
    stop(): void;
}
//# sourceMappingURL=host.d.ts.map