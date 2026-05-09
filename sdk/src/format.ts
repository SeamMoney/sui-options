/** SUI display helpers. 1 SUI = 1e9 MIST. */
export const MIST_PER_SUI = 1_000_000_000n;

export function mistToSui(mist: bigint | number): number {
  const m = typeof mist === "bigint" ? Number(mist) : mist;
  return m / 1e9;
}

export function suiToMist(sui: number): bigint {
  return BigInt(Math.round(sui * 1e9));
}

export function shortAddr(addr: string, prefix = 4, suffix = 4): string {
  if (addr.length <= prefix + suffix + 2) return addr;
  return `${addr.slice(0, 2 + prefix)}…${addr.slice(-suffix)}`;
}

/** Implied TOUCH price in [0, 1] from CPMM reserves. */
export function impliedTouchPrice(
  touchReserve: number,
  noTouchReserve: number,
): number {
  const total = touchReserve + noTouchReserve;
  return total === 0 ? 0.5 : noTouchReserve / total;
}

/**
 * CPMM output amount with fee on input — mirrors wick::cpmm_out exactly.
 * Returns floor(out_res * in_eff / (in_res + in_eff)).
 */
export function cpmmOut(
  inAmount: number,
  inReserve: number,
  outReserve: number,
  feeBps: number,
): number {
  if (inAmount <= 0) return 0;
  const inEff = (inAmount * (10_000 - feeBps)) / 10_000;
  return Math.floor((outReserve * inEff) / (inReserve + inEff));
}
