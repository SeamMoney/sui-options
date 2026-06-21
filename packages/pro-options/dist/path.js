/**
 * Deterministic synthetic price paths for Pro Mode rounds.
 *
 * A round's whole path is generated up front from a seed (so the keeper can
 * commit to its hash before the lobby and reveal the seed at settle — provable
 * fairness, see docs/design/v2/28). Same seed + params ⇒ identical path, which
 * is what makes the commit-reveal verifiable and these tests possible.
 *
 * Generation is GBM (geometric Brownian motion) with an optional low-probability
 * "rug" down-jump that biases realized paths against holders — the secondary,
 * disclosed house edge alongside the spread.
 */
import { SECONDS_PER_YEAR } from "./black-scholes.js";
/** A 32-bit LCG (Numerical Recipes constants) — small, fast, fully deterministic. */
export function makeRng(seed) {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(1664525, state) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}
/** Box-Muller standard-normal draw from a uniform RNG. */
function gaussian(rng) {
    let u = 0;
    let v = 0;
    while (u === 0)
        u = rng();
    while (v === 0)
        v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
/** Generate the full price path. Returns prices[0..steps] (length steps + 1). */
export function generatePath(params) {
    const { seed, steps, startPrice, driftAnnual, sigmaAnnual, stepMs } = params;
    const rugChance = (params.rugChanceBps ?? 0) / 10_000;
    const rugDown = params.rugDownPct ?? 0;
    const rng = makeRng(seed);
    const yearsPerSecond = params.yearsPerSecond ?? 1 / SECONDS_PER_YEAR;
    const dt = (stepMs / 1000) * yearsPerSecond;
    const drift = (driftAnnual - 0.5 * sigmaAnnual * sigmaAnnual) * dt;
    const vol = sigmaAnnual * Math.sqrt(dt);
    const prices = [startPrice];
    let price = startPrice;
    for (let i = 0; i < steps; i++) {
        price = price * Math.exp(drift + vol * gaussian(rng));
        if (rugChance > 0 && rng() < rugChance) {
            price = price * (1 - rugDown);
        }
        prices.push(price);
    }
    return prices;
}
/**
 * Group a price path into OHLC candles for charting. `stepsPerCandle` price
 * steps make one candle; `candleSeconds` is the candle's wall-clock width.
 */
export function pathToCandles(prices, stepsPerCandle, startTimeSec, candleSeconds) {
    const candles = [];
    for (let i = 0; i < prices.length; i += stepsPerCandle) {
        const slice = prices.slice(i, i + stepsPerCandle);
        if (slice.length === 0)
            break;
        const open = slice[0];
        const close = slice[slice.length - 1];
        let high = slice[0];
        let low = slice[0];
        for (const p of slice) {
            if (p > high)
                high = p;
            if (p < low)
                low = p;
        }
        candles.push({
            time: startTimeSec + (candles.length * candleSeconds),
            open,
            high,
            low,
            close,
        });
    }
    return candles;
}
//# sourceMappingURL=path.js.map