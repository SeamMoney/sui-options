/** SUI display helpers. 1 SUI = 1e9 MIST. */
export declare const MIST_PER_SUI = 1000000000n;
export declare function mistToSui(mist: bigint | number): number;
export declare function suiToMist(sui: number): bigint;
export declare function shortAddr(addr: string, prefix?: number, suffix?: number): string;
/** Implied TOUCH price in [0, 1] from CPMM reserves. */
export declare function impliedTouchPrice(touchReserve: number, noTouchReserve: number): number;
/**
 * CPMM output amount with fee on input — mirrors wick::cpmm_out exactly.
 * Returns floor(out_res * in_eff / (in_res + in_eff)).
 */
export declare function cpmmOut(inAmount: number, inReserve: number, outReserve: number, feeBps: number): number;
//# sourceMappingURL=format.d.ts.map