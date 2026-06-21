export class RoundHost {
    engine;
    listeners = new Set();
    lastPhase = null;
    lastRevealed = -1;
    seedRevealed = false;
    timer = null;
    constructor(engine) {
        this.engine = engine;
    }
    /** Subscribe; returns an unsubscribe fn. */
    on(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    emit(event) {
        for (const listener of this.listeners)
            listener(event);
    }
    /** Advance the round to `nowMs`, emitting any state changes. Idempotent per ms. */
    tick(nowMs) {
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
        if (settled.length)
            this.emit({ type: "settled", positions: settled, nowMs });
        if (!this.seedRevealed && (phase === "settle" || phase === "results")) {
            const swept = this.engine.settleAll();
            if (swept.length)
                this.emit({ type: "settled", positions: swept, nowMs });
            const { seed, paramsJson, commit, verified } = this.engine.reveal();
            this.emit({ type: "reveal-seed", seed, paramsJson, commit, verified, nowMs });
            this.seedRevealed = true;
        }
    }
    /** Self-driven loop (node/server). Browser UIs should drive `tick` from rAF instead. */
    start(opts = {}) {
        if (this.timer)
            return;
        const now = opts.now ?? (() => Date.now());
        const intervalMs = opts.intervalMs ?? 100;
        this.timer = setInterval(() => this.tick(now()), intervalMs);
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}
//# sourceMappingURL=host.js.map