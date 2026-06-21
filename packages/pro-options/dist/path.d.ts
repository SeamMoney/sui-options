export interface PathParams {
    seed: number;
    /** Number of price steps (path length is steps + 1, including the start). */
    steps: number;
    startPrice: number;
    /** Annualized drift (synthetic markets usually ~0). */
    driftAnnual: number;
    /** Annualized volatility (the market's "personality": Calm 0.3 … Volatile 1.2). */
    sigmaAnnual: number;
    /** Wall-clock milliseconds per step (sets dt for GBM). */
    stepMs: number;
    /**
     * BS "years" per real second (accelerated clock). Omit for real-time. A
     * synthetic round uses a large value so ~60s of wall-clock produces a full,
     * lively chart and option premiums with real time value.
     */
    yearsPerSecond?: number;
    /** Per-step rug probability in basis points (0 = no rug). */
    rugChanceBps?: number;
    /** Fractional down-jump applied on a rug (e.g. 0.06 = −6%). */
    rugDownPct?: number;
}
/** A 32-bit LCG (Numerical Recipes constants) — small, fast, fully deterministic. */
export declare function makeRng(seed: number): () => number;
/** Generate the full price path. Returns prices[0..steps] (length steps + 1). */
export declare function generatePath(params: PathParams): number[];
export interface Candle {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
}
/**
 * Group a price path into OHLC candles for charting. `stepsPerCandle` price
 * steps make one candle; `candleSeconds` is the candle's wall-clock width.
 */
export declare function pathToCandles(prices: number[], stepsPerCandle: number, startTimeSec: number, candleSeconds: number): Candle[];
//# sourceMappingURL=path.d.ts.map