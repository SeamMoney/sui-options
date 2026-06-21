import { type RoundConfig, type RoundPhase } from "./round";
import type { OptionPosition, OptionQuote, OptionSide } from "./types";
/** A synthetic market's "personality". */
export interface MarketConfig {
    id: string;
    label: string;
    startPrice: number;
    sigmaAnnual: number;
    driftAnnual: number;
    rugChanceBps?: number;
    rugDownPct?: number;
}
export interface RoundEngineConfig {
    market: MarketConfig;
    round: RoundConfig;
    seed: number;
    /** Price steps revealed across the live phase. */
    steps: number;
    /** Wall-clock ms per price step (for GBM dt). */
    stepMs: number;
    /** House spread (vig), in basis points. */
    spreadBps: number;
    /**
     * BS "years" per real second — the accelerated clock. Omit for real-time.
     * Sized so a ~60s round has a lively chart and option premiums with real
     * time value (e.g. ~0.002 ≈ a 60s round feeling like ~1 trading month).
     */
    yearsPerSecond?: number;
}
export interface OpenOrder {
    id: string;
    side: OptionSide;
    strike: number;
    expiryMs: number;
    contracts: number;
    nowMs: number;
}
export declare class RoundEngine {
    private readonly cfg;
    readonly commit: string;
    private readonly path;
    private readonly positions;
    private readonly paramsJson;
    private readonly yps;
    constructor(cfg: RoundEngineConfig);
    phase(nowMs: number): RoundPhase;
    /** Milliseconds left in the current phase (for countdowns). */
    msLeftInPhase(nowMs: number): number;
    /** Spot visible at `nowMs` — revealed progressively during the live phase. */
    spotAt(nowMs: number): number;
    /** Total price steps in the round. */
    get steps(): number;
    /** How many price steps are revealed at `nowMs` (0 in lobby, all once live ends). */
    revealedCount(nowMs: number): number;
    /** The revealed price prefix at `nowMs` (for charting). */
    revealedPath(nowMs: number): number[];
    /** Live BS quote for a prospective contract at `nowMs`. */
    quote(side: OptionSide, strike: number, expiryMs: number, nowMs: number): OptionQuote;
    /** Open a long option at the current quote + buy-side spread. */
    open(order: OpenOrder): OptionPosition;
    /** Sell an open position to close at the current mark (minus sell spread). */
    sellToClose(id: string, nowMs: number): OptionPosition | null;
    /** Settle every open position whose expiry has passed, against the revealed path. */
    settleExpired(nowMs: number): OptionPosition[];
    /** End-of-round sweep: settle anything still open at its expiry. */
    settleAll(): OptionPosition[];
    getPositions(): OptionPosition[];
    /** Total realized P&L across all closed player positions. */
    playerPnl(): number;
    /** The house is the counterparty: house P&L = −player P&L. */
    housePnl(): number;
    /** Reveal the seed and verify the streamed path matched the commit. */
    reveal(): {
        seed: number;
        verified: boolean;
    };
}
//# sourceMappingURL=engine.d.ts.map