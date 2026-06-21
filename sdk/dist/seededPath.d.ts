export declare const CANDLES_PER_SEGMENT = 6;
export declare const TICKS_PER_CANDLE = 6;
export declare const DRAWS_PER_TICK = 7;
export declare const PATTERN_NONE = 0;
export declare const PATTERN_DOJI = 1;
export declare const PATTERN_HAMMER = 2;
export declare const PATTERN_SHOOTING_STAR = 3;
export declare const PATTERN_BULLISH_ENGULFING = 4;
export declare const PATTERN_BEARISH_ENGULFING = 5;
export declare const PATTERN_THREE_WHITE_SOLDIERS = 6;
export declare const PATTERN_NAME: Readonly<Record<number, string>>;
/** Sign-magnitude integer. `mag === 0n` is canonically non-negative. */
export interface Signed {
    readonly neg: boolean;
    readonly mag: bigint;
}
/** One OHLC candle, prices in micro-USD. */
export interface Candle {
    readonly open: bigint;
    readonly high: bigint;
    readonly low: bigint;
    readonly close: bigint;
}
export interface WalkState {
    price: bigint;
    momentum: Signed;
    volRegime: bigint;
    home: bigint;
    patternId: bigint;
    candlesRemaining: bigint;
}
export declare const REGIME_RANGE: 0;
export declare const REGIME_TREND_UP: 1;
export declare const REGIME_TREND_DOWN: 2;
export declare const REGIME_DRIFT_BPS_PER_SEG = 50n;
export type RegimeKind = typeof REGIME_RANGE | typeof REGIME_TREND_UP | typeof REGIME_TREND_DOWN;
export interface RegimeDrift {
    kind: RegimeKind;
    /** True if the drift is negative (shifting home down). */
    neg: boolean;
    /** Magnitude in bps per segment. 0 in RANGE. */
    magBps: bigint;
}
/**
 * Derive the per-round drift regime. Pure function — chain and client
 * call it independently and arrive at the same answer.
 *
 * @param marketId 32-byte Sui object id, hex string (with or without 0x).
 * @param roundIndex Current round index (u64).
 */
export declare function regimeDriftForRound(marketId: string, roundIndex: bigint): RegimeDrift;
/**
 * Apply cumulative drift to a baseline price. Mirrors
 * `apply_cumulative_drift` in segment_market_v4.move bit-for-bit.
 * Saturates at 1 to avoid underflow on extreme down trends.
 */
export declare function applyCumulativeDrift(baseline: bigint, drift: RegimeDrift, segOffset: bigint): bigint;
/** Human label for the regime — used by the chart corner badge. */
export declare const REGIME_LABEL: Readonly<Record<RegimeKind, string>>;
export type ArmedPatternPhase = "arming" | "firing" | "fired";
export interface ArmedPatternDetection {
    patternId: number;
    patternName: string;
    candlesRemaining: number;
    phase: ArmedPatternPhase;
}
export interface SegmentArmedPattern extends ArmedPatternDetection {
    candleIndex: number;
    patternCandleIndex: number;
    patternCandleCount: number;
}
/** Result of expanding one segment. */
export interface SegmentResult {
    candles: Candle[];
    newState: WalkState;
    min: bigint;
    max: bigint;
    armedPatterns: SegmentArmedPattern[];
}
export declare function detectArmedPattern(walkState: WalkState): ArmedPatternDetection | null;
export declare const sZero: () => Signed;
/** Canonical constructor: zero is always non-negative. */
export declare const sNew: (neg: boolean, mag: bigint) => Signed;
/** a + b */
export declare function sAdd(a: Signed, b: Signed): Signed;
/** a - b */
export declare const sSub: (a: Signed, b: Signed) => Signed;
/** (a.mag * mul / div) carrying a's sign. */
export declare const sMulDiv: (a: Signed, mul: bigint, div: bigint) => Signed;
/** Clamp |a| to at most maxMag. */
export declare const sClampMag: (a: Signed, maxMag: bigint) => Signed;
/**
 * One 64-bit keystream word — blake2b256(key ‖ le8(n)), low 8 bytes read
 * little-endian. Deterministic expansion of the on-chain `segment_key` into
 * an unbounded uniform stream. Returns a bigint in [0, 2^64).
 */
export declare function keystreamWord(key: Uint8Array, n: number): bigint;
/** A uniform draw in [0, 1_000_000). */
export declare const draw: (key: Uint8Array, n: number) => bigint;
/**
 * Expand one segment: 6 candles from the carried walk state and a 32-byte
 * segment_key. PURE and deterministic — the cross-language conformance
 * contract with Move `expand_segment`. The input `state` is not mutated.
 *
 * Per-candle dispatch (doc 17 §15.2):
 *   * FSM in FORMING: shapeDispatch produces one OHLC; `step()` does not run.
 *   * FSM in NORMAL : run `step()` 6 times then `fsmMaybeArm` decides whether
 *     the NEXT candle starts a pattern.
 */
export declare function expandSegment(state: WalkState, key: Uint8Array): SegmentResult;
/** A fresh walk state — zero momentum, FSM in NORMAL. */
export declare const newState: (price: bigint, volRegime: bigint, home: bigint) => WalkState;
/**
 * Build a WalkState with an explicit momentum — used by the conformance test.
 * FSM defaults to NORMAL; use `stateWithPattern` to force a starting FSM.
 */
export declare const stateWith: (price: bigint, momNeg: boolean, momMag: bigint, volRegime: bigint, home: bigint) => WalkState;
/**
 * Build a WalkState with an explicit momentum + an explicit FSM seed — used
 * by the §15.5 generation-guard test to force the FSM into FORMING{p}.
 */
export declare const stateWithPattern: (price: bigint, momNeg: boolean, momMag: bigint, volRegime: bigint, home: bigint, patternId: bigint, candlesRemaining: bigint) => WalkState;
//# sourceMappingURL=seededPath.d.ts.map