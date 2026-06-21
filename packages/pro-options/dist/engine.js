/**
 * RoundEngine — the headless spine of Pro Mode.
 *
 * Ties the primitives (path + Black-Scholes + option lifecycle + round clock)
 * into one playable round: generate & commit the path, run the lobby→live→settle
 * clock, quote/open/mark/sell/settle options against the progressively-revealed
 * price, and tally player vs house P&L. This is what the UI, the multiplayer
 * server, and the on-chain settlement all wrap. See docs/design/v2/28.
 */
import { SECONDS_PER_YEAR, quote as bsQuote } from "./black-scholes.js";
import { openOption, realizedPnl, sellToClose as sellPos, settleAtExpiry, settlementPnlAtSpot } from "./option.js";
import { generatePath } from "./path.js";
import { commit as commitFn, phaseRemainingMs, revealedSteps, roundPhase } from "./round.js";
export class RoundEngine {
    cfg;
    commit;
    path;
    positions = new Map();
    paramsJson;
    yps;
    constructor(cfg) {
        this.cfg = cfg;
        const { market, seed, steps, stepMs } = cfg;
        this.yps = cfg.yearsPerSecond ?? 1 / SECONDS_PER_YEAR;
        this.paramsJson = JSON.stringify({
            startPrice: market.startPrice,
            sigmaAnnual: market.sigmaAnnual,
            driftAnnual: market.driftAnnual,
            rugChanceBps: market.rugChanceBps ?? 0,
            rugDownPct: market.rugDownPct ?? 0,
            steps,
            stepMs,
            yearsPerSecond: this.yps,
        });
        this.path = generatePath({
            seed,
            steps,
            startPrice: market.startPrice,
            sigmaAnnual: market.sigmaAnnual,
            driftAnnual: market.driftAnnual,
            stepMs,
            yearsPerSecond: this.yps,
            rugChanceBps: market.rugChanceBps,
            rugDownPct: market.rugDownPct,
        });
        this.commit = commitFn(seed, this.paramsJson);
    }
    phase(nowMs) {
        return roundPhase(this.cfg.round, nowMs);
    }
    /** Milliseconds left in the current phase (for countdowns). */
    msLeftInPhase(nowMs) {
        return phaseRemainingMs(this.cfg.round, nowMs);
    }
    /** Spot visible at `nowMs` — revealed progressively during the live phase. */
    spotAt(nowMs) {
        const idx = revealedSteps(this.cfg.round, nowMs, this.cfg.steps);
        return this.path[Math.min(idx, this.cfg.steps)];
    }
    /** Total price steps in the round. */
    get steps() {
        return this.cfg.steps;
    }
    /** How many price steps are revealed at `nowMs` (0 in lobby, all once live ends). */
    revealedCount(nowMs) {
        return revealedSteps(this.cfg.round, nowMs, this.cfg.steps);
    }
    /** The revealed price prefix at `nowMs` (for charting). */
    revealedPath(nowMs) {
        const idx = Math.min(this.revealedCount(nowMs), this.cfg.steps);
        return this.path.slice(0, idx + 1);
    }
    /** Live BS quote for a prospective contract at `nowMs`. */
    quote(side, strike, expiryMs, nowMs) {
        const tauSeconds = Math.max(0, (expiryMs - nowMs) / 1000);
        return bsQuote({
            spot: this.spotAt(nowMs),
            strike,
            tauYears: tauSeconds * this.yps,
            sigma: this.cfg.market.sigmaAnnual,
            side,
        });
    }
    /** Open a long option at the current quote + buy-side spread. */
    open(order) {
        const q = this.quote(order.side, order.strike, order.expiryMs, order.nowMs);
        const pos = openOption({
            id: order.id,
            side: order.side,
            strike: order.strike,
            openedAtMs: order.nowMs,
            expiryMs: order.expiryMs,
            contracts: order.contracts,
            fairPremium: q.premium,
            spreadBps: this.cfg.spreadBps,
        });
        this.positions.set(pos.id, pos);
        return pos;
    }
    /** Sell an open position to close at the current mark (minus sell spread). */
    sellToClose(id, nowMs) {
        const pos = this.positions.get(id);
        if (!pos || pos.status !== "open")
            return pos ?? null;
        const closed = sellPos(pos, this.spotAt(nowMs), nowMs, this.cfg.market.sigmaAnnual, this.cfg.spreadBps, 0, this.yps);
        this.positions.set(id, closed);
        return closed;
    }
    /** Settle every open position whose expiry has passed, against the revealed path. */
    settleExpired(nowMs) {
        const settled = [];
        for (const pos of this.positions.values()) {
            if (pos.status === "open" && pos.expiryMs <= nowMs) {
                const done = settleAtExpiry(pos, this.spotAt(pos.expiryMs));
                this.positions.set(pos.id, done);
                settled.push(done);
            }
        }
        return settled;
    }
    /** End-of-round sweep: settle anything still open at its expiry. */
    settleAll() {
        const settled = [];
        for (const pos of this.positions.values()) {
            if (pos.status === "open") {
                const done = settleAtExpiry(pos, this.spotAt(pos.expiryMs));
                this.positions.set(pos.id, done);
                settled.push(done);
            }
        }
        return settled;
    }
    getPositions() {
        return [...this.positions.values()];
    }
    /**
     * Settlement-projected P&L for one position at the spot visible at `nowMs`
     * — "what you'd realize if the round settled now". Shares the settlement
     * formula (see `settlementPnlAtSpot`), so the live readout and the final
     * settlement always agree. Returns 0 for an unknown id.
     */
    livePnlOf(id, nowMs) {
        const pos = this.positions.get(id);
        if (!pos)
            return 0;
        return settlementPnlAtSpot(pos, this.spotAt(nowMs));
    }
    /**
     * Total settlement-projected P&L across the whole book at `nowMs`: open
     * positions marked to the intrinsic settlement at the current spot, closed
     * positions at their realized value. This is the ONE number the headline
     * "Live P&L" should show; at expiry it equals `playerPnl()` exactly because
     * both call the same intrinsic settlement on the same spot.
     */
    livePnl(nowMs) {
        const spot = this.spotAt(nowMs);
        let total = 0;
        for (const pos of this.positions.values())
            total += settlementPnlAtSpot(pos, spot);
        return total;
    }
    /** Total premium paid across the book — the natural denominator for a P&L %. */
    premiumAtRisk() {
        let total = 0;
        for (const pos of this.positions.values())
            total += pos.premiumPaid;
        return total;
    }
    /** Total realized P&L across all closed player positions. */
    playerPnl() {
        let total = 0;
        for (const pos of this.positions.values())
            total += realizedPnl(pos);
        return total;
    }
    /** The house is the counterparty: house P&L = −player P&L. */
    housePnl() {
        return -this.playerPnl();
    }
    /**
     * Reveal the commit-reveal preimage at settle: the `seed` and the exact
     * `paramsJson` that were hashed into `commit` before the lobby. Anyone — not
     * just this engine — can recompute `SHA-256(`${seed}:${paramsJson}`)` and
     * confirm it equals the published `commit`, proving the price path was fixed
     * in advance and never adjusted against the player. `verified` is the engine's
     * own self-check; `paramsJson` is what makes an *independent* check possible.
     */
    reveal() {
        const recomputed = commitFn(this.cfg.seed, this.paramsJson);
        return {
            seed: this.cfg.seed,
            paramsJson: this.paramsJson,
            commit: this.commit,
            verified: recomputed === this.commit,
        };
    }
}
//# sourceMappingURL=engine.js.map