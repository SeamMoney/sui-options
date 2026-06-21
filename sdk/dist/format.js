/** SUI display helpers. 1 SUI = 1e9 MIST. */
export const MIST_PER_SUI = 1000000000n;
export function mistToSui(mist) {
    const m = typeof mist === "bigint" ? Number(mist) : mist;
    return m / 1e9;
}
export function suiToMist(sui) {
    return BigInt(Math.round(sui * 1e9));
}
export function shortAddr(addr, prefix = 4, suffix = 4) {
    if (addr.length <= prefix + suffix + 2)
        return addr;
    return `${addr.slice(0, 2 + prefix)}…${addr.slice(-suffix)}`;
}
/** Implied TOUCH price in [0, 1] from CPMM reserves. */
export function impliedTouchPrice(touchReserve, noTouchReserve) {
    const total = touchReserve + noTouchReserve;
    return total === 0 ? 0.5 : noTouchReserve / total;
}
/**
 * CPMM output amount with fee on input — mirrors wick::cpmm_out exactly.
 * Returns floor(out_res * in_eff / (in_res + in_eff)).
 */
export function cpmmOut(inAmount, inReserve, outReserve, feeBps) {
    if (inAmount <= 0)
        return 0;
    const inEff = (inAmount * (10_000 - feeBps)) / 10_000;
    return Math.floor((outReserve * inEff) / (inReserve + inEff));
}
//# sourceMappingURL=format.js.map