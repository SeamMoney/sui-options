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

export type HostEvent =
  | { type: "phase"; phase: RoundPhase; prev: RoundPhase | null; nowMs: number }
  | { type: "reveal-step"; revealed: number; spot: number; nowMs: number }
  | { type: "settled"; positions: OptionPosition[]; nowMs: number }
  | { type: "reveal-seed"; seed: number; verified: boolean; nowMs: number };

export type HostListener = (event: HostEvent) => void;

export interface StartOptions {
  /** Wall-clock provider (defaults to Date.now). */
  now?: () => number;
  /** Tick interval in ms (default 100). */
  intervalMs?: number;
}

export class RoundHost {
  private readonly listeners = new Set<HostListener>();
  private lastPhase: RoundPhase | null = null;
  private lastRevealed = -1;
  private seedRevealed = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(readonly engine: RoundEngine) {}

  /** Subscribe; returns an unsubscribe fn. */
  on(listener: HostListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: HostEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Advance the round to `nowMs`, emitting any state changes. Idempotent per ms. */
  tick(nowMs: number): void {
    const phase = this.engine.phase(nowMs);
    if (phase !== this.lastPhase) {
      this.emit({ type: "phase", phase, prev: this.lastPhase, nowMs });
      this.lastPhase = phase;
    }

    const revealed = this.engine.revealedCount(nowMs);
    if (revealed !== this.lastRevealed) {
      this.emit({ type: "reveal-step", revealed, spot: this.engine.spotAt(nowMs), nowMs });
      this.lastRevealed = revealed;
    }

    const settled = this.engine.settleExpired(nowMs);
    if (settled.length) this.emit({ type: "settled", positions: settled, nowMs });

    if (!this.seedRevealed && (phase === "settle" || phase === "results")) {
      const swept = this.engine.settleAll();
      if (swept.length) this.emit({ type: "settled", positions: swept, nowMs });
      const { seed, verified } = this.engine.reveal();
      this.emit({ type: "reveal-seed", seed, verified, nowMs });
      this.seedRevealed = true;
    }
  }

  /** Self-driven loop (node/server). Browser UIs should drive `tick` from rAF instead. */
  start(opts: StartOptions = {}): void {
    if (this.timer) return;
    const now = opts.now ?? (() => Date.now());
    const intervalMs = opts.intervalMs ?? 100;
    this.timer = setInterval(() => this.tick(now()), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
