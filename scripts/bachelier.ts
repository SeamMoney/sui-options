/**
 * Pure TypeScript port of Move `wick::ride_pricing::bachelier_cashout_factor`
 * (move/sources/ride_pricing.move) — integer-exact, including the 33-entry
 * 2·Φ(−z) lookup and linear interpolation. Used by the payout "money audit" to
 * reproduce the chain's CASHOUT payout to the satoshi.
 *
 *   z      = |barrier − spot| / (σ · √seconds_remaining)
 *   factor = 2·Φ(−z)   in 1e9 fixed-point
 *
 * Every operation mirrors the Move integer arithmetic (u128 intermediates via
 * bigint, truncating division) so the result is bit-identical to on-chain.
 */
export const FACTOR_SCALE = 1_000_000_000n;
const Z_STEP_BPS = 1_000n;
const Z_TABLE_LEN = 33n;

// 2·Φ(−z) in 1e9 fixed-point for z = 0.0 .. 3.2 step 0.1 (verbatim from Move).
const PHI_NEG_TABLE: bigint[] = [
  1_000_000_000n, 920_344_300n, 841_480_900n, 764_177_300n, 689_157_500n,
  617_075_100n, 548_506_100n, 483_945_200n, 423_711_400n, 368_120_000n,
  317_310_500n, 271_332_400n, 230_139_500n, 193_601_100n, 161_513_400n,
  133_614_400n, 109_598_600n, 89_131_900n, 71_860_700n, 57_432_900n,
  45_500_300n, 35_728_700n, 27_806_700n, 21_447_900n, 16_395_100n,
  12_419_300n, 9_322_400n, 6_933_900n, 5_110_300n, 3_731_700n,
  2_699_800n, 1_935_000n, 1_374_200n,
];

function phiNegTable(idx: bigint): bigint {
  return idx >= Z_TABLE_LEN ? 0n : PHI_NEG_TABLE[Number(idx)]!;
}

/** Integer square root via Newton's method — mirrors Move `isqrt_u64`. */
export function isqrtU64(n: bigint): bigint {
  if (n === 0n) return 0n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

function phiNegInterp(zBps: bigint): bigint {
  const loIdx = zBps / Z_STEP_BPS;
  if (loIdx >= Z_TABLE_LEN - 1n) return phiNegTable(Z_TABLE_LEN - 1n);
  const loVal = phiNegTable(loIdx);
  const hiVal = phiNegTable(loIdx + 1n);
  const frac = zBps - loIdx * Z_STEP_BPS;
  const delta = loVal - hiVal; // table is monotonically decreasing
  return loVal - (delta * frac) / Z_STEP_BPS;
}

/** Bachelier cashout factor in 1e9 fixed-point — bit-identical to Move. */
export function bachelierCashoutFactor(
  spot: bigint,
  barrier: bigint,
  sigmaBpsPerSqrtSec: bigint,
  secondsRemaining: bigint,
): bigint {
  if (secondsRemaining === 0n) return 0n;
  if (sigmaBpsPerSqrtSec === 0n) return spot === barrier ? FACTOR_SCALE : 0n;
  const dist = spot > barrier ? spot - barrier : barrier - spot;
  if (dist === 0n) return FACTOR_SCALE;
  const sqrtSec = isqrtU64(secondsRemaining);
  if (sqrtSec === 0n) return 0n;
  const sigmaTotalX10000 = barrier * sigmaBpsPerSqrtSec * sqrtSec;
  if (sigmaTotalX10000 === 0n) return 0n;
  const zBps = (dist * 10_000n * 10_000n) / sigmaTotalX10000;
  const cap = Z_STEP_BPS * (Z_TABLE_LEN - 1n);
  const zBpsCapped = zBps > cap ? cap : zBps;
  return phiNegInterp(zBpsCapped);
}

/** Whichever of (upper, lower) is closer to spot — Move `nearer_barrier`. */
export function nearerBarrier(spot: bigint, upper: bigint, lower: bigint): bigint {
  const distUp = upper > spot ? upper - spot : 0n;
  const distDn = spot > lower ? spot - lower : 0n;
  return distUp <= distDn ? upper : lower;
}

/**
 * The full CASHOUT payout, mirroring `decide_settlement`'s CASHOUT branch:
 *   raw      = stake_paid · factor / FACTOR_SCALE
 *   spread   = raw · (10000 − cashout_spread_bps) / 10000
 *   payout   = min(spread, stake_paid)
 */
export function cashoutPayout(
  stakePaid: bigint,
  spot: bigint,
  upperBarrier: bigint,
  lowerBarrier: bigint,
  sigmaBpsPerSqrtSec: bigint,
  cashoutSpreadBps: bigint,
  secondsRemaining: bigint,
): bigint {
  const barrier = nearerBarrier(spot, upperBarrier, lowerBarrier);
  const factor = bachelierCashoutFactor(spot, barrier, sigmaBpsPerSqrtSec, secondsRemaining);
  const raw = (stakePaid * factor) / FACTOR_SCALE;
  const afterSpread = (raw * (10_000n - cashoutSpreadBps)) / 10_000n;
  return afterSpread > stakePaid ? stakePaid : afterSpread;
}
