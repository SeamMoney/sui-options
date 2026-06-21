/**
 * In-browser provable-fairness replay — the "fairness is a function call" claim
 * made clickable.
 *
 * This is a thin, framework-free core that runs the SAME byte-identical seeded
 * path expansion the Move chain runs (`@wick/sdk` re-exports `seededPath.ts`,
 * which is checked against 10k vectors in CI), recomputes each segment's
 * high/low from its 32-byte on-chain key, compares them to the extrema the chain
 * reported, runs the touch predicate against the barrier, and derives the
 * settlement the ride *should* have received. If our verdict disagrees with the
 * chain's `RideClosed.settlement_kind`, or any extremum mismatches, the ride
 * FAILS verification.
 *
 * It is the exact logic of `scripts/verify.ts`, distilled to a pure function so
 * the UI and a node test can both drive it. No network, no React.
 */
import {
  expandSegment,
  newState,
  SETTLEMENT_ABORTED_REFUND,
  SETTLEMENT_CASHOUT,
  SETTLEMENT_EXPIRED_LOSS,
  SETTLEMENT_TOUCH_WIN,
} from "@wick/sdk";

/** Price fixed-point scale: on-chain prices are micro-units (1e6 == 1.00). */
export const PRICE_SCALE = 1_000_000n;

/** Format a micro-price bigint as a 2-decimal string (1_000_000_000n -> "1000.00"). */
export function formatPrice(v: bigint): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / PRICE_SCALE;
  const frac = (abs % PRICE_SCALE).toString().padStart(6, "0").slice(0, 2);
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/** One segment as the chain recorded it: the random key + the extrema it claims. */
export interface ChainSegment {
  k: number;
  /** 32-byte segment key committed on-chain inside `record_segment`. */
  key: Uint8Array;
  /** Chain-reported segment low (micro-price). */
  chainMin: bigint;
  /** Chain-reported segment high (micro-price). */
  chainMax: bigint;
}

export interface VerifyConfig {
  /** Round home / open price the walk starts from. */
  homePrice: bigint;
  /** Initial vol-regime seed (bootstrap default is 1_000_000). */
  volRegimeInit: bigint;
  /** Barrier price the ride was opened against (micro-price). */
  barrierPrice: bigint;
  /** true = upper barrier (touch from below), false = lower barrier. */
  barrierUpper: boolean;
  /** Anti-jitter deadband in bps applied to the effective barrier. */
  deadbandBps: bigint;
  /** First segment index the ride is live for (inclusive). */
  entrySegmentIndex: number;
  /** Segment index the ride scan ends at (exclusive). */
  scanEndExclusive: number;
  /** Segment index the ride's round ends at — used to split CASHOUT vs EXPIRED_LOSS. */
  rideRoundEnd: number;
  /** All segments, contiguous from k=0 (the walk must replay from the start). */
  segments: ChainSegment[];
  /** Settlement kind the chain emitted in `RideClosed`. */
  onchainSettlementKind: number;
}

export interface VerifyRow {
  k: number;
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  /** What the chain claimed for this segment's high. */
  chainHigh: bigint;
  /** What the chain claimed for this segment's low. */
  chainLow: bigint;
  barrier: bigint;
  touched: boolean;
  /** Our recomputed high/low equal the chain's claimed extrema. */
  extremaMatch: boolean;
}

export interface VerifyOutcome {
  rows: VerifyRow[];
  touched: boolean;
  allExtremaMatch: boolean;
  offchainKind: number;
  onchainKind: number;
  verdictMatch: boolean;
  /** PASS iff every in-range extremum matched AND our verdict matched the chain's. */
  pass: boolean;
}

/**
 * The barrier touch predicate, mirrored bit-for-bit from `scripts/verify.ts`
 * (`directionTouches`) and the Move `path_observation` deadband math.
 */
function directionTouches(
  min: bigint,
  max: bigint,
  barrier: bigint,
  deadbandBps: bigint,
  upper: boolean,
): boolean {
  if (upper) {
    const eff = barrier + (barrier * deadbandBps) / 10_000n;
    return max >= eff;
  }
  const margin = (barrier * deadbandBps) / 10_000n;
  const eff = margin >= barrier ? 0n : barrier - margin;
  return min <= eff;
}

/**
 * Derive the settlement the ride should have received, exactly as
 * `offchainSettlementKind` in `scripts/verify.ts` does. ABORTED_REFUND is taken
 * from the chain (an abort is an external event, not derivable from the path).
 */
function offchainSettlementKind(
  touched: boolean,
  cfg: VerifyConfig,
): number {
  if (cfg.onchainSettlementKind === SETTLEMENT_ABORTED_REFUND) {
    return SETTLEMENT_ABORTED_REFUND;
  }
  if (touched) return SETTLEMENT_TOUCH_WIN;
  if (cfg.scanEndExclusive >= cfg.rideRoundEnd) return SETTLEMENT_EXPIRED_LOSS;
  return SETTLEMENT_CASHOUT;
}

/**
 * Replay every segment from k=0 through the seeded-path expansion, compare the
 * recomputed extrema to the chain's claims, run the touch predicate over the
 * ride's range, and compare the derived settlement to the chain's.
 */
export function runVerification(cfg: VerifyConfig): VerifyOutcome {
  let state = newState(cfg.homePrice, cfg.volRegimeInit, cfg.homePrice);
  const rows: VerifyRow[] = [];
  let touched = false;
  let allExtremaMatch = true;

  // Segments must be processed in k order so the walk state carries forward.
  const ordered = [...cfg.segments].sort((a, b) => a.k - b.k);
  for (const seg of ordered) {
    const result = expandSegment(state, seg.key);
    const high = result.max;
    const low = result.min;
    const inRange =
      seg.k >= cfg.entrySegmentIndex && seg.k < cfg.scanEndExclusive;
    if (inRange) {
      const extremaMatch = high === seg.chainMax && low === seg.chainMin;
      const segTouched = directionTouches(
        low,
        high,
        cfg.barrierPrice,
        cfg.deadbandBps,
        cfg.barrierUpper,
      );
      allExtremaMatch = allExtremaMatch && extremaMatch;
      touched = touched || segTouched;
      rows.push({
        k: seg.k,
        open: result.candles[0]?.open ?? state.price,
        high,
        low,
        close: result.candles[result.candles.length - 1]?.close ?? result.newState.price,
        chainHigh: seg.chainMax,
        chainLow: seg.chainMin,
        barrier: cfg.barrierPrice,
        touched: segTouched,
        extremaMatch,
      });
    }
    state = result.newState;
  }

  const offchainKind = offchainSettlementKind(touched, cfg);
  const verdictMatch = offchainKind === cfg.onchainSettlementKind;
  const pass = allExtremaMatch && verdictMatch;
  return {
    rows,
    touched,
    allExtremaMatch,
    offchainKind,
    onchainKind: cfg.onchainSettlementKind,
    verdictMatch,
    pass,
  };
}
