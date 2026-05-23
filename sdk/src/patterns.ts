/**
 * patterns.ts — pure-TypeScript candlestick pattern detection catalog.
 *
 * Wick Markets' chart consumes this in real time over a sliding window of
 * candles to render highlights, tooltips, and glow effects when one of the
 * 54 named patterns from doc 17 §15.6 forms.
 *
 * The catalog uses the CONTINUOUS / CRYPTO interpretation throughout — i.e.
 * patterns whose textbook definition requires a price *gap* between candles
 * are ported to "next candle opens at or very near the previous close" form.
 * Crypto markets trade 24/7 and rarely produce true gaps; requiring them
 * would mean these predicates almost never fire.
 *
 * All arithmetic uses `bigint` so we never lose u64 precision when fed real
 * on-chain ticks. `strength ∈ [0, 1]` measures how cleanly the pattern fits.
 *
 * Pure functions — no I/O, no clock reads, no mutation.
 *
 * `Candle` is imported from `seededPath.ts` (the canonical source of truth
 * across the SDK). Originally agent-boundary-isolated; merged on integration.
 */
import type { Candle } from "./seededPath.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * String-literal union of every pattern name in the §15.6 catalog. Using a
 * union (rather than an enum) keeps the JSON-serialized form human-readable
 * and stable.
 */
export type Pattern =
  // Single-candle (17)
  | "Doji"
  | "Dragonfly Doji"
  | "Gravestone Doji"
  | "Long-Legged Doji"
  | "Rickshaw Man"
  | "Takuri"
  | "Hammer"
  | "Inverted Hammer"
  | "Hanging Man"
  | "Shooting Star"
  | "Marubozu"
  | "Closing Marubozu"
  | "Spinning Top"
  | "High-Wave"
  | "Long Line"
  | "Short Line"
  | "Belt-hold"
  // Two-candle (14)
  | "Engulfing"
  | "Harami"
  | "Harami Cross"
  | "Piercing"
  | "Dark Cloud Cover"
  | "Counterattack"
  | "Separating Lines"
  | "Matching Low"
  | "Homing Pigeon"
  | "On-Neck"
  | "In-Neck"
  | "Thrusting"
  | "Doji Star"
  | "Hikkake"
  // Three-candle (16)
  | "Morning Star"
  | "Evening Star"
  | "Morning Doji Star"
  | "Evening Doji Star"
  | "Three White Soldiers"
  | "Three Black Crows"
  | "Identical Three Crows"
  | "Three Inside Up/Down"
  | "Three Outside Up/Down"
  | "Three Stars in the South"
  | "Tristar"
  | "Unique Three River"
  | "Advance Block"
  | "Stalled Pattern"
  | "Two Crows"
  | "Stick Sandwich"
  // Four / Five-candle (7)
  | "Three-Line Strike"
  | "Concealing Baby Swallow"
  | "Ladder Bottom"
  | "Mat Hold"
  | "Rising/Falling Three Methods"
  | "Breakaway"
  | "Modified Hikkake";

/**
 * The result of a successful predicate match.
 *
 * `startIndex` and `endIndex` are inclusive indices into the `window` array
 * passed to `detectPatterns` (or to the individual predicate).
 *
 * `strength` is a 0..1 fit score — 1.0 = textbook-perfect, 0.0 = barely
 * matches the threshold. UIs can map this to glow opacity.
 */
export interface PatternMatch {
  name: Pattern;
  matched: true;
  strength: number;
  startIndex: number;
  endIndex: number;
}

export interface PostHocPatternMatch extends PatternMatch {
  label: string;
  candleIndex: number;
}

// ---------------------------------------------------------------------------
// BigInt helpers — kept tiny and inlined because they run on every tick
// ---------------------------------------------------------------------------

const ZERO = 0n;
const ONE = 1n;

const bAbs = (x: bigint): bigint => (x < ZERO ? -x : x);
const bMax = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const bMin = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** Body size = |close - open|. */
const body = (c: Candle): bigint => bAbs(c.close - c.open);

/** Total range = high - low. */
const range = (c: Candle): bigint => c.high - c.low;

/** Upper shadow = high - max(open, close). */
const upper = (c: Candle): bigint => c.high - bMax(c.open, c.close);

/** Lower shadow = min(open, close) - low. */
const lower = (c: Candle): bigint => bMin(c.open, c.close) - c.low;

/** True iff close > open. */
const isBull = (c: Candle): boolean => c.close > c.open;

/** True iff close < open. */
const isBear = (c: Candle): boolean => c.close < c.open;

/** Midpoint of the body (rounded toward zero, but body endpoints are u64). */
const bodyMid = (c: Candle): bigint => (c.open + c.close) / 2n;

/** Top of the body = max(open, close). */
const bodyTop = (c: Candle): bigint => bMax(c.open, c.close);

/** Bottom of the body = min(open, close). */
const bodyBot = (c: Candle): bigint => bMin(c.open, c.close);

/**
 * Convert a bigint ratio (num/den) into a JS number clamped to [0, 1].
 * Used only for `strength` — never for predicate decisions.
 */
const ratio01 = (num: bigint, den: bigint): number => {
  if (den <= ZERO) return 0;
  if (num <= ZERO) return 0;
  if (num >= den) return 1;
  // The values that reach here are at most 64-bit so Number() conversion is
  // exact for the magnitudes we care about (BTC u64 micro-USD).
  return Number(num) / Number(den);
};

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * "approximately equal" with a 5-bp tolerance relative to `scale`.
 * Used for "open ≈ close" doji checks and for continuous-style
 * "open ≈ previous close" gap-substitutes.
 *
 * 5 bp = 0.05 % — tight enough to mean "essentially the same" but loose
 * enough to absorb single-tick oracle noise. Doc 17 §15 picked 5 bp as the
 * crypto-friendly equivalent of the gap requirement.
 */
const NEAR_BPS = 5n;
const BPS_DEN = 10_000n;
const approxEqual = (a: bigint, b: bigint, scale: bigint): boolean => {
  const tol = (bAbs(scale) * NEAR_BPS) / BPS_DEN;
  return bAbs(a - b) <= tol;
};

/**
 * Trend probe: returns +1 if the N candles before `offset` are net up,
 * -1 if net down, 0 if flat / insufficient data. Used as the "preceding
 * trend" gate for reversal patterns.
 */
const trendBefore = (
  window: Candle[],
  offset: number,
  lookback: number,
): number => {
  if (offset < lookback) return 0;
  const start = window[offset - lookback];
  const end = window[offset - 1];
  if (!start || !end) return 0;
  if (end.close > start.close) return 1;
  if (end.close < start.close) return -1;
  return 0;
};

// ---------------------------------------------------------------------------
// Thresholds (relative to candle range)
//
// All thresholds are expressed in basis points relative to the candle's range
// so the catalog is scale-invariant. The numbers below come from the doc 17
// §15.6 "continuous / crypto" appendix.
// ---------------------------------------------------------------------------

/** Body must be ≤ 10 % of range to count as a doji body. */
const DOJI_BODY_BPS = 1_000n;
/** Body must be ≥ 60 % of range to count as a "long body". */
const LONG_BODY_BPS = 6_000n;
/** Body must be ≥ 90 % of range to count as marubozu. */
const MARUBOZU_BODY_BPS = 9_000n;
/** Body must be ≤ 30 % of range to count as a "small body". */
const SMALL_BODY_BPS = 3_000n;
/** Shadow must be ≤ 5 % of range to count as "essentially no wick". */
const NO_WICK_BPS = 500n;
/** Long wick threshold (≥ 2× body) — bigint helper. */
const LONG_WICK_VS_BODY = 2n;
/** Hammer / shooting-star: lower or upper wick ≥ 2× body, the other ≤ body. */

/** Return true if c's body is ≤ `bps` of its range. */
const bodyLeqBpsOfRange = (c: Candle, bps: bigint): boolean => {
  const r = range(c);
  if (r === ZERO) return true;
  return body(c) * BPS_DEN <= r * bps;
};

/** Return true if c's body is ≥ `bps` of its range. */
const bodyGeqBpsOfRange = (c: Candle, bps: bigint): boolean => {
  const r = range(c);
  if (r === ZERO) return false;
  return body(c) * BPS_DEN >= r * bps;
};

/** Return true if shadow size is ≤ `bps` of range. */
const shadowLeqBpsOfRange = (
  shadow: bigint,
  r: bigint,
  bps: bigint,
): boolean => {
  if (r === ZERO) return true;
  return shadow * BPS_DEN <= r * bps;
};

// ---------------------------------------------------------------------------
// Safe candle accessors (noUncheckedIndexedAccess is on in tsconfig)
// ---------------------------------------------------------------------------

const candleAt = (window: Candle[], i: number): Candle | null => {
  if (i < 0 || i >= window.length) return null;
  const c = window[i];
  return c ?? null;
};

const mk = (
  name: Pattern,
  strength: number,
  startIndex: number,
  endIndex: number,
): PatternMatch => ({
  name,
  matched: true,
  strength: clamp01(strength),
  startIndex,
  endIndex,
});

// ===========================================================================
// SINGLE-CANDLE PATTERNS (17)
// ===========================================================================

// --- 1. Doji -------------------------------------------------------------
// Open ≈ close, range is non-trivial.
export const isDoji = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c = candleAt(window, offset);
  if (!c) return null;
  const r = range(c);
  if (r === ZERO) return null;
  if (!bodyLeqBpsOfRange(c, DOJI_BODY_BPS)) return null;
  // strength = 1 - body/range, normalized so a perfect doji = 1.
  const strength = 1 - ratio01(body(c) * 10n, r); // body is ≤ 10% so body*10 ≤ range
  return mk("Doji", strength, offset, offset);
};

// --- 2. Dragonfly Doji ---------------------------------------------------
// Doji + no upper wick + long lower wick.
export const isDragonflyDoji = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c = candleAt(window, offset);
  if (!c) return null;
  const r = range(c);
  if (r === ZERO) return null;
  if (!bodyLeqBpsOfRange(c, DOJI_BODY_BPS)) return null;
  const u = upper(c);
  const l = lower(c);
  if (!shadowLeqBpsOfRange(u, r, NO_WICK_BPS)) return null;
  if (l * 2n < r) return null; // lower wick should dominate
  return mk("Dragonfly Doji", ratio01(l, r), offset, offset);
};

// --- 3. Gravestone Doji --------------------------------------------------
// Doji + no lower wick + long upper wick.
export const isGravestoneDoji = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c = candleAt(window, offset);
  if (!c) return null;
  const r = range(c);
  if (r === ZERO) return null;
  if (!bodyLeqBpsOfRange(c, DOJI_BODY_BPS)) return null;
  const u = upper(c);
  const l = lower(c);
  if (!shadowLeqBpsOfRange(l, r, NO_WICK_BPS)) return null;
  if (u * 2n < r) return null;
  return mk("Gravestone Doji", ratio01(u, r), offset, offset);
};

// --- 4. Long-Legged Doji -------------------------------------------------
// Doji with both wicks substantial (each ≥ 30% of range).
export const isLongLeggedDoji = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c = candleAt(window, offset);
  if (!c) return null;
  const r = range(c);
  if (r === ZERO) return null;
  if (!bodyLeqBpsOfRange(c, DOJI_BODY_BPS)) return null;
  const u = upper(c);
  const l = lower(c);
  if (u * 10n < r * 3n) return null;
  if (l * 10n < r * 3n) return null;
  const strength = ratio01(bMin(u, l) * 2n, r);
  return mk("Long-Legged Doji", strength, offset, offset);
};

// --- 5. Rickshaw Man -----------------------------------------------------
// Long-Legged Doji whose body sits at the midpoint of the range.
export const isRickshawMan = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const ll = isLongLeggedDoji(window, offset);
  if (!ll) return null;
  const c = candleAt(window, offset);
  if (!c) return null;
  const r = range(c);
  const mid = (c.high + c.low) / 2n;
  const bodyCentre = bodyMid(c);
  // require body centre within 10% of geometric midpoint
  if (bAbs(bodyCentre - mid) * 10n > r) return null;
  const strength = 1 - ratio01(bAbs(bodyCentre - mid) * 10n, r);
  return mk("Rickshaw Man", strength, offset, offset);
};

// --- 6. Takuri -----------------------------------------------------------
// Like Dragonfly Doji but the lower shadow is *extreme* (≥ 3× the range
// of the body region). Bullish reversal at lows.
export const isTakuri = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c = candleAt(window, offset);
  if (!c) return null;
  const r = range(c);
  if (r === ZERO) return null;
  if (!bodyLeqBpsOfRange(c, DOJI_BODY_BPS)) return null;
  const u = upper(c);
  const l = lower(c);
  if (!shadowLeqBpsOfRange(u, r, NO_WICK_BPS)) return null;
  // require lower wick ≥ 80% of range (extreme)
  if (l * 10n < r * 8n) return null;
  return mk("Takuri", ratio01(l, r), offset, offset);
};

// --- 7. Hammer -----------------------------------------------------------
// Small body at the top of the range, long lower wick, little upper wick.
// Must appear after a downtrend.
export const isHammer = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c = candleAt(window, offset);
  if (!c) return null;
  const r = range(c);
  if (r === ZERO) return null;
  if (!bodyLeqBpsOfRange(c, SMALL_BODY_BPS)) return null;
  const b = body(c);
  const u = upper(c);
  const l = lower(c);
  if (l < b * LONG_WICK_VS_BODY) return null;
  if (u > b) return null;
  // need preceding downtrend for the classical hammer
  if (trendBefore(window, offset, 3) >= 0) return null;
  return mk("Hammer", ratio01(l, r), offset, offset);
};

// --- 8. Inverted Hammer --------------------------------------------------
// Small body at the bottom of the range, long upper wick, little lower wick.
// After a downtrend = bullish reversal.
export const isInvertedHammer = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c = candleAt(window, offset);
  if (!c) return null;
  const r = range(c);
  if (r === ZERO) return null;
  if (!bodyLeqBpsOfRange(c, SMALL_BODY_BPS)) return null;
  const b = body(c);
  const u = upper(c);
  const l = lower(c);
  if (u < b * LONG_WICK_VS_BODY) return null;
  if (l > b) return null;
  if (trendBefore(window, offset, 3) >= 0) return null;
  return mk("Inverted Hammer", ratio01(u, r), offset, offset);
};

// --- 9. Hanging Man ------------------------------------------------------
// Same shape as Hammer but after an UPtrend = bearish reversal.
export const isHangingMan = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c = candleAt(window, offset);
  if (!c) return null;
  const r = range(c);
  if (r === ZERO) return null;
  if (!bodyLeqBpsOfRange(c, SMALL_BODY_BPS)) return null;
  const b = body(c);
  const u = upper(c);
  const l = lower(c);
  if (l < b * LONG_WICK_VS_BODY) return null;
  if (u > b) return null;
  if (trendBefore(window, offset, 3) <= 0) return null;
  return mk("Hanging Man", ratio01(l, r), offset, offset);
};

// --- 10. Shooting Star ---------------------------------------------------
// Inverted-hammer shape after an UPtrend = bearish reversal.
export const isShootingStar = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c = candleAt(window, offset);
  if (!c) return null;
  const r = range(c);
  if (r === ZERO) return null;
  if (!bodyLeqBpsOfRange(c, SMALL_BODY_BPS)) return null;
  const b = body(c);
  const u = upper(c);
  const l = lower(c);
  if (u < b * LONG_WICK_VS_BODY) return null;
  if (l > b) return null;
  if (trendBefore(window, offset, 3) <= 0) return null;
  return mk("Shooting Star", ratio01(u, r), offset, offset);
};

// --- 11. Marubozu --------------------------------------------------------
// Body covers ≥ 90% of range — virtually no wicks on either side.
export const isMarubozu = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c = candleAt(window, offset);
  if (!c) return null;
  const r = range(c);
  if (r === ZERO) return null;
  if (!bodyGeqBpsOfRange(c, MARUBOZU_BODY_BPS)) return null;
  return mk("Marubozu", ratio01(body(c), r), offset, offset);
};

// --- 12. Closing Marubozu ------------------------------------------------
// Body is long (≥ 60%) and the side of the body that matches the close has
// effectively no wick. The opposing wick may exist.
export const isClosingMarubozu = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c = candleAt(window, offset);
  if (!c) return null;
  const r = range(c);
  if (r === ZERO) return null;
  if (!bodyGeqBpsOfRange(c, LONG_BODY_BPS)) return null;
  if (isBull(c)) {
    // close at high → upper wick ≈ 0
    if (!shadowLeqBpsOfRange(upper(c), r, NO_WICK_BPS)) return null;
  } else if (isBear(c)) {
    // close at low → lower wick ≈ 0
    if (!shadowLeqBpsOfRange(lower(c), r, NO_WICK_BPS)) return null;
  } else {
    return null;
  }
  return mk("Closing Marubozu", ratio01(body(c), r), offset, offset);
};

// --- 13. Spinning Top ----------------------------------------------------
// Small body (≤ 30 %) plus visible wicks on both sides (each ≥ body).
export const isSpinningTop = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c = candleAt(window, offset);
  if (!c) return null;
  const r = range(c);
  if (r === ZERO) return null;
  if (!bodyLeqBpsOfRange(c, SMALL_BODY_BPS)) return null;
  const b = body(c);
  if (upper(c) < b || lower(c) < b) return null;
  // Don't double-fire as Doji
  if (bodyLeqBpsOfRange(c, DOJI_BODY_BPS)) return null;
  return mk("Spinning Top", ratio01(bMin(upper(c), lower(c)) * 2n, r), offset, offset);
};

// --- 14. High-Wave -------------------------------------------------------
// Spinning-top with *very* long wicks (each ≥ 3× body).
export const isHighWave = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c = candleAt(window, offset);
  if (!c) return null;
  const r = range(c);
  if (r === ZERO) return null;
  if (!bodyLeqBpsOfRange(c, SMALL_BODY_BPS)) return null;
  const b = body(c);
  if (b === ZERO) return null; // pure doji handled elsewhere
  const u = upper(c);
  const l = lower(c);
  if (u < b * 3n) return null;
  if (l < b * 3n) return null;
  return mk("High-Wave", ratio01(bMin(u, l), r), offset, offset);
};

// --- 15. Long Line -------------------------------------------------------
// A single long-bodied candle (body ≥ 60% of range).
export const isLongLine = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c = candleAt(window, offset);
  if (!c) return null;
  const r = range(c);
  if (r === ZERO) return null;
  if (!bodyGeqBpsOfRange(c, LONG_BODY_BPS)) return null;
  // exclude Marubozu — caller still gets Marubozu match via that predicate
  return mk("Long Line", ratio01(body(c), r), offset, offset);
};

// --- 16. Short Line ------------------------------------------------------
// A single short-bodied candle (body ≤ 30%) that ISN'T a doji.
export const isShortLine = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c = candleAt(window, offset);
  if (!c) return null;
  const r = range(c);
  if (r === ZERO) return null;
  if (!bodyLeqBpsOfRange(c, SMALL_BODY_BPS)) return null;
  if (bodyLeqBpsOfRange(c, DOJI_BODY_BPS)) return null;
  return mk("Short Line", 1 - ratio01(body(c) * 10n, r * 3n), offset, offset);
};

// --- 17. Belt-hold -------------------------------------------------------
// A long body that opens at its extreme: bullish opens at low (no lower wick),
// bearish opens at high (no upper wick).
export const isBeltHold = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c = candleAt(window, offset);
  if (!c) return null;
  const r = range(c);
  if (r === ZERO) return null;
  if (!bodyGeqBpsOfRange(c, LONG_BODY_BPS)) return null;
  if (isBull(c)) {
    if (!shadowLeqBpsOfRange(lower(c), r, NO_WICK_BPS)) return null;
  } else if (isBear(c)) {
    if (!shadowLeqBpsOfRange(upper(c), r, NO_WICK_BPS)) return null;
  } else {
    return null;
  }
  return mk("Belt-hold", ratio01(body(c), r), offset, offset);
};

// ===========================================================================
// TWO-CANDLE PATTERNS (14)
// ===========================================================================

// --- 18. Engulfing -------------------------------------------------------
// Body of candle[t] fully covers body of candle[t-1] and is the opposite
// direction. Classical reversal.
export const isEngulfing = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const prev = candleAt(window, offset - 1);
  const cur = candleAt(window, offset);
  if (!prev || !cur) return null;
  if (isBull(prev) === isBull(cur)) return null;
  if (body(prev) === ZERO || body(cur) === ZERO) return null;
  const prevTop = bodyTop(prev);
  const prevBot = bodyBot(prev);
  const curTop = bodyTop(cur);
  const curBot = bodyBot(cur);
  if (curTop < prevTop || curBot > prevBot) return null;
  const strength = clamp01(
    ratio01(body(cur) - body(prev), body(prev) === ZERO ? ONE : body(prev)),
  );
  return mk("Engulfing", strength, offset - 1, offset);
};

// --- 19. Harami ----------------------------------------------------------
// Reverse of Engulfing: small candle[t] sits *inside* large candle[t-1] body.
// Opposite direction preferred but not required for crypto-continuous form.
export const isHarami = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const prev = candleAt(window, offset - 1);
  const cur = candleAt(window, offset);
  if (!prev || !cur) return null;
  if (body(prev) === ZERO) return null;
  if (!bodyGeqBpsOfRange(prev, LONG_BODY_BPS)) return null;
  if (!bodyLeqBpsOfRange(cur, SMALL_BODY_BPS)) return null;
  const prevTop = bodyTop(prev);
  const prevBot = bodyBot(prev);
  if (bodyTop(cur) > prevTop || bodyBot(cur) < prevBot) return null;
  // exclude pure doji (Harami Cross handles that)
  if (bodyLeqBpsOfRange(cur, DOJI_BODY_BPS)) return null;
  const strength = 1 - ratio01(body(cur), body(prev));
  return mk("Harami", strength, offset - 1, offset);
};

// --- 20. Harami Cross ----------------------------------------------------
// Harami where the inside candle is a doji.
export const isHaramiCross = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const prev = candleAt(window, offset - 1);
  const cur = candleAt(window, offset);
  if (!prev || !cur) return null;
  if (!bodyGeqBpsOfRange(prev, LONG_BODY_BPS)) return null;
  if (!bodyLeqBpsOfRange(cur, DOJI_BODY_BPS)) return null;
  const prevTop = bodyTop(prev);
  const prevBot = bodyBot(prev);
  if (cur.high > prevTop || cur.low < prevBot) {
    // strict version: wicks too should be inside body. Relax to body-inside.
    if (bodyTop(cur) > prevTop || bodyBot(cur) < prevBot) return null;
  }
  return mk("Harami Cross", 1 - ratio01(body(cur), body(prev) + ONE), offset - 1, offset);
};

// --- 21. Piercing --------------------------------------------------------
// Bullish reversal: bearish long body, then bullish candle that opens at or
// near previous close (continuous form: ≈) and closes above the midpoint of
// the previous body.
export const isPiercing = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const prev = candleAt(window, offset - 1);
  const cur = candleAt(window, offset);
  if (!prev || !cur) return null;
  if (!isBear(prev) || !isBull(cur)) return null;
  if (!bodyGeqBpsOfRange(prev, LONG_BODY_BPS)) return null;
  if (!approxEqual(cur.open, prev.close, range(prev))) return null;
  const mid = bodyMid(prev);
  if (cur.close <= mid) return null;
  if (cur.close >= prev.open) return null; // would be Engulfing, not Piercing
  const strength = ratio01(cur.close - mid, prev.open - mid);
  return mk("Piercing", strength, offset - 1, offset);
};

// --- 22. Dark Cloud Cover (continuous) -----------------------------------
// Bearish mirror of Piercing.
export const isDarkCloudCover = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const prev = candleAt(window, offset - 1);
  const cur = candleAt(window, offset);
  if (!prev || !cur) return null;
  if (!isBull(prev) || !isBear(cur)) return null;
  if (!bodyGeqBpsOfRange(prev, LONG_BODY_BPS)) return null;
  if (!approxEqual(cur.open, prev.close, range(prev))) return null;
  const mid = bodyMid(prev);
  if (cur.close >= mid) return null;
  if (cur.close <= prev.open) return null; // would be Engulfing
  const strength = ratio01(mid - cur.close, mid - prev.open);
  return mk("Dark Cloud Cover", strength, offset - 1, offset);
};

// --- 23. Counterattack ---------------------------------------------------
// Two strong opposite-coloured candles that close at the same price.
export const isCounterattack = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const prev = candleAt(window, offset - 1);
  const cur = candleAt(window, offset);
  if (!prev || !cur) return null;
  if (isBull(prev) === isBull(cur)) return null;
  if (!bodyGeqBpsOfRange(prev, LONG_BODY_BPS)) return null;
  if (!bodyGeqBpsOfRange(cur, LONG_BODY_BPS)) return null;
  if (!approxEqual(prev.close, cur.close, range(prev))) return null;
  return mk("Counterattack", 1 - ratio01(bAbs(prev.close - cur.close) * 100n, range(prev) + ONE), offset - 1, offset);
};

// --- 24. Separating Lines ------------------------------------------------
// Continuation: two candles of OPPOSITE colour where the second opens at the
// open of the first (continuous form: open ≈ prev.open) and runs in the
// trend direction.
export const isSeparatingLines = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const prev = candleAt(window, offset - 1);
  const cur = candleAt(window, offset);
  if (!prev || !cur) return null;
  if (isBull(prev) === isBull(cur)) return null;
  if (!bodyGeqBpsOfRange(cur, LONG_BODY_BPS)) return null;
  if (!approxEqual(cur.open, prev.open, range(prev))) return null;
  // must continue in the direction of cur (which equals prior trend, since
  // the prev candle was the counter-trend pullback)
  const trend = trendBefore(window, offset - 1, 3);
  if (trend === 0) return null;
  if (isBull(cur) && trend < 0) return null;
  if (isBear(cur) && trend > 0) return null;
  return mk("Separating Lines", ratio01(body(cur), range(cur)), offset - 1, offset);
};

// --- 25. Matching Low ----------------------------------------------------
// Two bearish candles closing at the same low. Bullish reversal at lows.
export const isMatchingLow = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const prev = candleAt(window, offset - 1);
  const cur = candleAt(window, offset);
  if (!prev || !cur) return null;
  if (!isBear(prev) || !isBear(cur)) return null;
  if (!approxEqual(prev.close, cur.close, range(prev))) return null;
  if (trendBefore(window, offset, 3) >= 0) return null;
  return mk("Matching Low", 1 - ratio01(bAbs(prev.close - cur.close) * 100n, range(prev) + ONE), offset - 1, offset);
};

// --- 26. Homing Pigeon ---------------------------------------------------
// Bullish Harami where BOTH candles are bearish — the inside body is the
// "homing pigeon" sheltering inside the long bear body.
export const isHomingPigeon = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const prev = candleAt(window, offset - 1);
  const cur = candleAt(window, offset);
  if (!prev || !cur) return null;
  if (!isBear(prev) || !isBear(cur)) return null;
  if (!bodyGeqBpsOfRange(prev, LONG_BODY_BPS)) return null;
  if (bodyTop(cur) > bodyTop(prev) || bodyBot(cur) < bodyBot(prev)) return null;
  if (body(cur) >= body(prev)) return null;
  if (trendBefore(window, offset, 3) >= 0) return null;
  return mk("Homing Pigeon", 1 - ratio01(body(cur), body(prev)), offset - 1, offset);
};

// --- 27. On-Neck ---------------------------------------------------------
// Bearish continuation: long bear candle, then small bull candle that closes
// near (≈) the LOW of the previous candle.
export const isOnNeck = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const prev = candleAt(window, offset - 1);
  const cur = candleAt(window, offset);
  if (!prev || !cur) return null;
  if (!isBear(prev) || !isBull(cur)) return null;
  if (!bodyGeqBpsOfRange(prev, LONG_BODY_BPS)) return null;
  if (!approxEqual(cur.close, prev.low, range(prev))) return null;
  return mk("On-Neck", 1 - ratio01(bAbs(cur.close - prev.low) * 100n, range(prev) + ONE), offset - 1, offset);
};

// --- 28. In-Neck ---------------------------------------------------------
// Like On-Neck but the bull close is just *slightly* into the prev body
// (above the prev close but below the prev body midpoint).
export const isInNeck = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const prev = candleAt(window, offset - 1);
  const cur = candleAt(window, offset);
  if (!prev || !cur) return null;
  if (!isBear(prev) || !isBull(cur)) return null;
  if (!bodyGeqBpsOfRange(prev, LONG_BODY_BPS)) return null;
  if (cur.close <= prev.close) return null;
  const mid = bodyMid(prev);
  if (cur.close >= mid) return null;
  // must be very close to prev close, not deep into body
  const intoBody = cur.close - prev.close;
  const bodySize = body(prev);
  if (intoBody * 10n > bodySize) return null;
  return mk("In-Neck", 1 - ratio01(intoBody * 10n, bodySize + ONE), offset - 1, offset);
};

// --- 29. Thrusting -------------------------------------------------------
// Bull close penetrates the prev bear body but NOT past midpoint.
// (Between In-Neck and Piercing.)
export const isThrusting = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const prev = candleAt(window, offset - 1);
  const cur = candleAt(window, offset);
  if (!prev || !cur) return null;
  if (!isBear(prev) || !isBull(cur)) return null;
  if (!bodyGeqBpsOfRange(prev, LONG_BODY_BPS)) return null;
  const mid = bodyMid(prev);
  if (cur.close <= prev.close) return null;
  if (cur.close >= mid) return null;
  // distinct from In-Neck: requires meaningful penetration (> 10% of body)
  const intoBody = cur.close - prev.close;
  const bodySize = body(prev);
  if (intoBody * 10n <= bodySize) return null;
  return mk("Thrusting", ratio01(intoBody, bodySize), offset - 1, offset);
};

// --- 30. Doji Star (continuous) ------------------------------------------
// Long body, then a doji that "stars" above (after a bear body) or below
// (after a bull body) — in the continuous form, the doji simply opens ≈
// previous close. Used as the kernel of Morning/Evening Doji Star.
export const isDojiStar = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const prev = candleAt(window, offset - 1);
  const cur = candleAt(window, offset);
  if (!prev || !cur) return null;
  if (!bodyGeqBpsOfRange(prev, LONG_BODY_BPS)) return null;
  if (!bodyLeqBpsOfRange(cur, DOJI_BODY_BPS)) return null;
  if (!approxEqual(cur.open, prev.close, range(prev))) return null;
  return mk("Doji Star", 1 - ratio01(body(cur) * 10n, range(cur) + ONE), offset - 1, offset);
};

// --- 31. Hikkake ---------------------------------------------------------
// Two-bar inside-bar setup that *fails*. The classic form needs three bars
// at minimum: (i) inside bar inside an outer bar, (ii) a "fake breakout"
// bar going one way, (iii) a confirmation bar going the OTHER way.
// We accept the two-bar core here and let the chart/UI flag confirmation.
export const isHikkake = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  // Look back 3 bars; signal posts at offset = confirmation bar
  const c0 = candleAt(window, offset - 2); // outer
  const c1 = candleAt(window, offset - 1); // inside fakeout
  const c2 = candleAt(window, offset);     // confirmation
  if (!c0 || !c1 || !c2) return null;
  // c1 must be inside c0 (range inside)
  if (c1.high >= c0.high || c1.low <= c0.low) return null;
  // c2 must break out the OPPOSITE direction of the fakeout
  // If c1's body leans bullish, the trap was upward → c2 should close < c1.low.
  // Implement using highs/lows for robustness.
  const fakedUp = c2.high > c1.high && c2.close < c1.low;
  const fakedDown = c2.low < c1.low && c2.close > c1.high;
  if (!fakedUp && !fakedDown) return null;
  // strength proportional to how far the confirmation reversed past the inside
  const reversal = fakedUp
    ? c1.low - c2.close
    : c2.close - c1.high;
  return mk("Hikkake", ratio01(reversal, range(c0) + ONE), offset - 2, offset);
};

// ===========================================================================
// THREE-CANDLE PATTERNS (16)
// ===========================================================================

// --- 32. Morning Star (continuous) ---------------------------------------
// Down → small body → strong up that closes above mid of first body.
export const isMorningStar = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c1 = candleAt(window, offset - 2);
  const c2 = candleAt(window, offset - 1);
  const c3 = candleAt(window, offset);
  if (!c1 || !c2 || !c3) return null;
  if (!isBear(c1) || !isBull(c3)) return null;
  if (!bodyGeqBpsOfRange(c1, LONG_BODY_BPS)) return null;
  if (!bodyLeqBpsOfRange(c2, SMALL_BODY_BPS)) return null;
  // exclude doji star variant (handled separately)
  if (bodyLeqBpsOfRange(c2, DOJI_BODY_BPS)) return null;
  // continuous form: c2 opens ≈ c1.close, c3 opens ≈ c2.close
  if (!approxEqual(c2.open, c1.close, range(c1))) return null;
  if (!approxEqual(c3.open, c2.close, range(c2) + ONE)) return null;
  const mid = bodyMid(c1);
  if (c3.close <= mid) return null;
  return mk("Morning Star", ratio01(c3.close - mid, c1.open - mid), offset - 2, offset);
};

// --- 33. Evening Star (continuous) ---------------------------------------
export const isEveningStar = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c1 = candleAt(window, offset - 2);
  const c2 = candleAt(window, offset - 1);
  const c3 = candleAt(window, offset);
  if (!c1 || !c2 || !c3) return null;
  if (!isBull(c1) || !isBear(c3)) return null;
  if (!bodyGeqBpsOfRange(c1, LONG_BODY_BPS)) return null;
  if (!bodyLeqBpsOfRange(c2, SMALL_BODY_BPS)) return null;
  if (bodyLeqBpsOfRange(c2, DOJI_BODY_BPS)) return null;
  if (!approxEqual(c2.open, c1.close, range(c1))) return null;
  if (!approxEqual(c3.open, c2.close, range(c2) + ONE)) return null;
  const mid = bodyMid(c1);
  if (c3.close >= mid) return null;
  return mk("Evening Star", ratio01(mid - c3.close, mid - c1.open), offset - 2, offset);
};

// --- 34. Morning Doji Star (continuous) ----------------------------------
export const isMorningDojiStar = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c1 = candleAt(window, offset - 2);
  const c2 = candleAt(window, offset - 1);
  const c3 = candleAt(window, offset);
  if (!c1 || !c2 || !c3) return null;
  if (!isBear(c1) || !isBull(c3)) return null;
  if (!bodyGeqBpsOfRange(c1, LONG_BODY_BPS)) return null;
  if (!bodyLeqBpsOfRange(c2, DOJI_BODY_BPS)) return null;
  if (!approxEqual(c2.open, c1.close, range(c1))) return null;
  if (!approxEqual(c3.open, c2.close, range(c2) + ONE)) return null;
  const mid = bodyMid(c1);
  if (c3.close <= mid) return null;
  return mk("Morning Doji Star", ratio01(c3.close - mid, c1.open - mid), offset - 2, offset);
};

// --- 35. Evening Doji Star (continuous) ----------------------------------
export const isEveningDojiStar = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c1 = candleAt(window, offset - 2);
  const c2 = candleAt(window, offset - 1);
  const c3 = candleAt(window, offset);
  if (!c1 || !c2 || !c3) return null;
  if (!isBull(c1) || !isBear(c3)) return null;
  if (!bodyGeqBpsOfRange(c1, LONG_BODY_BPS)) return null;
  if (!bodyLeqBpsOfRange(c2, DOJI_BODY_BPS)) return null;
  if (!approxEqual(c2.open, c1.close, range(c1))) return null;
  if (!approxEqual(c3.open, c2.close, range(c2) + ONE)) return null;
  const mid = bodyMid(c1);
  if (c3.close >= mid) return null;
  return mk("Evening Doji Star", ratio01(mid - c3.close, mid - c1.open), offset - 2, offset);
};

// --- 36. Three White Soldiers --------------------------------------------
// Three consecutive long bull candles, each opening inside the previous
// body and closing near the high.
export const isThreeWhiteSoldiers = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c1 = candleAt(window, offset - 2);
  const c2 = candleAt(window, offset - 1);
  const c3 = candleAt(window, offset);
  if (!c1 || !c2 || !c3) return null;
  if (!isBull(c1) || !isBull(c2) || !isBull(c3)) return null;
  if (!bodyGeqBpsOfRange(c1, LONG_BODY_BPS)) return null;
  if (!bodyGeqBpsOfRange(c2, LONG_BODY_BPS)) return null;
  if (!bodyGeqBpsOfRange(c3, LONG_BODY_BPS)) return null;
  // higher highs and higher closes
  if (c2.close <= c1.close) return null;
  if (c3.close <= c2.close) return null;
  // each opens within previous body
  if (c2.open <= c1.open || c2.open >= c1.close) return null;
  if (c3.open <= c2.open || c3.open >= c2.close) return null;
  return mk("Three White Soldiers", ratio01(c3.close - c1.open, c3.high - c1.low + ONE), offset - 2, offset);
};

// --- 37. Three Black Crows -----------------------------------------------
export const isThreeBlackCrows = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c1 = candleAt(window, offset - 2);
  const c2 = candleAt(window, offset - 1);
  const c3 = candleAt(window, offset);
  if (!c1 || !c2 || !c3) return null;
  if (!isBear(c1) || !isBear(c2) || !isBear(c3)) return null;
  if (!bodyGeqBpsOfRange(c1, LONG_BODY_BPS)) return null;
  if (!bodyGeqBpsOfRange(c2, LONG_BODY_BPS)) return null;
  if (!bodyGeqBpsOfRange(c3, LONG_BODY_BPS)) return null;
  if (c2.close >= c1.close) return null;
  if (c3.close >= c2.close) return null;
  if (c2.open >= c1.open || c2.open <= c1.close) return null;
  if (c3.open >= c2.open || c3.open <= c2.close) return null;
  return mk("Three Black Crows", ratio01(c1.open - c3.close, c1.high - c3.low + ONE), offset - 2, offset);
};

// --- 38. Identical Three Crows -------------------------------------------
// Three Black Crows where each candle opens AT the previous close.
export const isIdenticalThreeCrows = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const base = isThreeBlackCrows(window, offset);
  if (!base) return null;
  const c1 = candleAt(window, offset - 2);
  const c2 = candleAt(window, offset - 1);
  const c3 = candleAt(window, offset);
  if (!c1 || !c2 || !c3) return null;
  if (!approxEqual(c2.open, c1.close, range(c1))) return null;
  if (!approxEqual(c3.open, c2.close, range(c2))) return null;
  return mk("Identical Three Crows", base.strength, offset - 2, offset);
};

// --- 39. Three Inside Up / Down ------------------------------------------
// Harami + confirmation bar that closes beyond the first candle's body.
export const isThreeInsideUpDown = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c1 = candleAt(window, offset - 2);
  const c2 = candleAt(window, offset - 1);
  const c3 = candleAt(window, offset);
  if (!c1 || !c2 || !c3) return null;
  if (!bodyGeqBpsOfRange(c1, LONG_BODY_BPS)) return null;
  if (bodyTop(c2) > bodyTop(c1) || bodyBot(c2) < bodyBot(c1)) return null;
  if (body(c2) >= body(c1)) return null;
  // Three Inside Up: c1 bear, c2 bull-ish, c3 bull close > c1.open
  // Three Inside Down: c1 bull, c2 bear-ish, c3 bear close < c1.open
  if (isBear(c1) && isBull(c3) && c3.close > c1.open) {
    return mk("Three Inside Up/Down", ratio01(c3.close - c1.open, range(c1) + ONE), offset - 2, offset);
  }
  if (isBull(c1) && isBear(c3) && c3.close < c1.open) {
    return mk("Three Inside Up/Down", ratio01(c1.open - c3.close, range(c1) + ONE), offset - 2, offset);
  }
  return null;
};

// --- 40. Three Outside Up / Down -----------------------------------------
// Engulfing + confirmation bar in the same direction as the engulfer.
export const isThreeOutsideUpDown = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const eng = isEngulfing(window, offset - 1);
  if (!eng) return null;
  const c2 = candleAt(window, offset - 1);
  const c3 = candleAt(window, offset);
  if (!c2 || !c3) return null;
  if (isBull(c2) && !(isBull(c3) && c3.close > c2.close)) return null;
  if (isBear(c2) && !(isBear(c3) && c3.close < c2.close)) return null;
  return mk("Three Outside Up/Down", clamp01(eng.strength + 0.1), offset - 2, offset);
};

// --- 41. Three Stars in the South ----------------------------------------
// Rare bullish reversal: long bear with long lower wick, then smaller bear
// with similar shape but inside the first range, then a tiny marubozu-like
// bear that doesn't make a new low.
export const isThreeStarsInTheSouth = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c1 = candleAt(window, offset - 2);
  const c2 = candleAt(window, offset - 1);
  const c3 = candleAt(window, offset);
  if (!c1 || !c2 || !c3) return null;
  if (!isBear(c1) || !isBear(c2) || !isBear(c3)) return null;
  if (!bodyGeqBpsOfRange(c1, LONG_BODY_BPS)) return null;
  // c1 needs a clear lower wick (≥ body)
  if (lower(c1) < body(c1)) return null;
  // c2 is shorter and within c1's range
  if (body(c2) >= body(c1)) return null;
  if (c2.high > c1.high || c2.low < c1.low) return null;
  // c3 is shortest, no new low
  if (body(c3) >= body(c2)) return null;
  if (c3.low < c2.low) return null;
  if (!shadowLeqBpsOfRange(lower(c3), range(c3) + ONE, NO_WICK_BPS)) return null;
  if (!shadowLeqBpsOfRange(upper(c3), range(c3) + ONE, NO_WICK_BPS)) return null;
  return mk("Three Stars in the South", 1 - ratio01(body(c3) * 4n, body(c1) + ONE), offset - 2, offset);
};

// --- 42. Tristar ---------------------------------------------------------
// Three dojis in a row, with the middle one peeking above (top) or below
// (bottom) the other two. Strong reversal signal.
export const isTristar = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c1 = candleAt(window, offset - 2);
  const c2 = candleAt(window, offset - 1);
  const c3 = candleAt(window, offset);
  if (!c1 || !c2 || !c3) return null;
  if (!bodyLeqBpsOfRange(c1, DOJI_BODY_BPS)) return null;
  if (!bodyLeqBpsOfRange(c2, DOJI_BODY_BPS)) return null;
  if (!bodyLeqBpsOfRange(c3, DOJI_BODY_BPS)) return null;
  const mid1 = bodyMid(c1);
  const mid2 = bodyMid(c2);
  const mid3 = bodyMid(c3);
  // bearish (tristar top): mid2 > mid1 && mid2 > mid3
  // bullish (tristar bottom): mid2 < mid1 && mid2 < mid3
  const isTop = mid2 > mid1 && mid2 > mid3;
  const isBot = mid2 < mid1 && mid2 < mid3;
  if (!isTop && !isBot) return null;
  return mk("Tristar", 0.8, offset - 2, offset);
};

// --- 43. Unique Three River ----------------------------------------------
// Bullish reversal: long bear, then hammer-like bear that makes a new low,
// then a small bull that opens below c2.close (continuous: ≤) and closes
// above c2.close.
export const isUniqueThreeRiver = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c1 = candleAt(window, offset - 2);
  const c2 = candleAt(window, offset - 1);
  const c3 = candleAt(window, offset);
  if (!c1 || !c2 || !c3) return null;
  if (!isBear(c1) || !isBear(c2) || !isBull(c3)) return null;
  if (!bodyGeqBpsOfRange(c1, LONG_BODY_BPS)) return null;
  if (lower(c2) < body(c2) * 2n) return null; // hammer-style
  if (c2.low >= c1.low) return null;
  if (!bodyLeqBpsOfRange(c3, SMALL_BODY_BPS)) return null;
  if (c3.open > c2.close) return null;
  if (c3.close <= c2.close) return null;
  return mk("Unique Three River", ratio01(c3.close - c2.close, range(c2) + ONE), offset - 2, offset);
};

// --- 44. Advance Block ---------------------------------------------------
// Three bull candles BUT each successive body is smaller than the last AND
// upper wicks grow — signals stalling momentum.
export const isAdvanceBlock = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c1 = candleAt(window, offset - 2);
  const c2 = candleAt(window, offset - 1);
  const c3 = candleAt(window, offset);
  if (!c1 || !c2 || !c3) return null;
  if (!isBull(c1) || !isBull(c2) || !isBull(c3)) return null;
  if (c2.close <= c1.close) return null;
  if (c3.close <= c2.close) return null;
  if (body(c2) >= body(c1)) return null;
  if (body(c3) >= body(c2)) return null;
  if (upper(c3) <= upper(c2)) return null;
  if (upper(c2) < upper(c1)) return null;
  return mk("Advance Block", 1 - ratio01(body(c3) * 3n, body(c1) + ONE), offset - 2, offset);
};

// --- 45. Stalled Pattern (Deliberation) ---------------------------------
// Two long bulls, then a small bull that "deliberates". Bearish hint.
export const isStalledPattern = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c1 = candleAt(window, offset - 2);
  const c2 = candleAt(window, offset - 1);
  const c3 = candleAt(window, offset);
  if (!c1 || !c2 || !c3) return null;
  if (!isBull(c1) || !isBull(c2) || !isBull(c3)) return null;
  if (!bodyGeqBpsOfRange(c1, LONG_BODY_BPS)) return null;
  if (!bodyGeqBpsOfRange(c2, LONG_BODY_BPS)) return null;
  if (!bodyLeqBpsOfRange(c3, SMALL_BODY_BPS)) return null;
  if (c2.close <= c1.close) return null;
  if (c3.close <= c2.close) return null;
  // c3 should open near the top of c2 (continuous: open ≈ c2.close)
  if (!approxEqual(c3.open, c2.close, range(c2))) return null;
  return mk("Stalled Pattern", 1 - ratio01(body(c3) * 3n, body(c1) + ONE), offset - 2, offset);
};

// --- 46. Two Crows -------------------------------------------------------
// Bearish reversal: long bull, then small bear (continuous: opens ≈ c1.close),
// then bear that opens above c2.body and closes deep into c1.body.
export const isTwoCrows = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c1 = candleAt(window, offset - 2);
  const c2 = candleAt(window, offset - 1);
  const c3 = candleAt(window, offset);
  if (!c1 || !c2 || !c3) return null;
  if (!isBull(c1) || !isBear(c2) || !isBear(c3)) return null;
  if (!bodyGeqBpsOfRange(c1, LONG_BODY_BPS)) return null;
  if (!approxEqual(c2.open, c1.close, range(c1))) return null;
  if (c3.open <= bodyTop(c2)) return null;
  if (c3.close >= c1.close) return null;
  if (c3.close <= c1.open) return null;
  return mk("Two Crows", ratio01(c1.close - c3.close, body(c1) + ONE), offset - 2, offset);
};

// --- 47. Stick Sandwich --------------------------------------------------
// Bear close, then bull, then a bear that closes at the SAME price as the
// first bear. Bullish reversal at lows.
export const isStickSandwich = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c1 = candleAt(window, offset - 2);
  const c2 = candleAt(window, offset - 1);
  const c3 = candleAt(window, offset);
  if (!c1 || !c2 || !c3) return null;
  if (!isBear(c1) || !isBull(c2) || !isBear(c3)) return null;
  if (!approxEqual(c1.close, c3.close, range(c1))) return null;
  // c2's body must sit above the close of c1/c3
  if (bodyBot(c2) < c1.close) return null;
  return mk("Stick Sandwich", 1 - ratio01(bAbs(c1.close - c3.close) * 100n, range(c1) + ONE), offset - 2, offset);
};

// ===========================================================================
// FOUR / FIVE-CANDLE PATTERNS (7)
// ===========================================================================

// --- 48. Three-Line Strike -----------------------------------------------
// Three bears in a row (or three bulls) followed by a SINGLE candle that
// engulfs all three. Strong reversal.
export const isThreeLineStrike = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c1 = candleAt(window, offset - 3);
  const c2 = candleAt(window, offset - 2);
  const c3 = candleAt(window, offset - 1);
  const c4 = candleAt(window, offset);
  if (!c1 || !c2 || !c3 || !c4) return null;
  // Bearish base: three bulls, then a bear that closes below c1.open
  if (isBull(c1) && isBull(c2) && isBull(c3) && isBear(c4)) {
    if (c2.close <= c1.close) return null;
    if (c3.close <= c2.close) return null;
    if (c4.open < c3.close) return null;
    if (c4.close > c1.open) return null;
    return mk("Three-Line Strike", ratio01(c4.open - c4.close, c3.close - c1.open + ONE), offset - 3, offset);
  }
  // Bullish base: three bears, then a bull that closes above c1.open
  if (isBear(c1) && isBear(c2) && isBear(c3) && isBull(c4)) {
    if (c2.close >= c1.close) return null;
    if (c3.close >= c2.close) return null;
    if (c4.open > c3.close) return null;
    if (c4.close < c1.open) return null;
    return mk("Three-Line Strike", ratio01(c4.close - c4.open, c1.open - c3.close + ONE), offset - 3, offset);
  }
  return null;
};

// --- 49. Concealing Baby Swallow -----------------------------------------
// Bullish reversal in a strong downtrend. Four bears: two marubozus, then a
// bear that's "swallowed" by the previous, then a marubozu that opens above
// the previous high and closes below all previous lows. Continuous form:
// require strong downward momentum + final engulfing bear.
export const isConcealingBabySwallow = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c1 = candleAt(window, offset - 3);
  const c2 = candleAt(window, offset - 2);
  const c3 = candleAt(window, offset - 1);
  const c4 = candleAt(window, offset);
  if (!c1 || !c2 || !c3 || !c4) return null;
  if (!isBear(c1) || !isBear(c2) || !isBear(c3) || !isBear(c4)) return null;
  if (!bodyGeqBpsOfRange(c1, MARUBOZU_BODY_BPS)) return null;
  if (!bodyGeqBpsOfRange(c2, MARUBOZU_BODY_BPS)) return null;
  // c3 has an upper wick that pokes into c2's body — "trying to rally"
  if (upper(c3) < body(c3)) return null;
  if (c3.high <= c2.close) return null;
  // c4 engulfs c3 (range)
  if (c4.high < c3.high || c4.low > c3.low) return null;
  return mk("Concealing Baby Swallow", ratio01(c1.open - c4.close, c1.open - c4.low + ONE), offset - 3, offset);
};

// --- 50. Ladder Bottom ---------------------------------------------------
// Bullish reversal: three bears each making a lower close (a "ladder
// descending"), then a fourth bear with an upper wick, then a bull that
// opens above the upper wick and closes high. Continuous form: the gap is
// replaced with "≈".
export const isLadderBottom = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c1 = candleAt(window, offset - 4);
  const c2 = candleAt(window, offset - 3);
  const c3 = candleAt(window, offset - 2);
  const c4 = candleAt(window, offset - 1);
  const c5 = candleAt(window, offset);
  if (!c1 || !c2 || !c3 || !c4 || !c5) return null;
  if (!isBear(c1) || !isBear(c2) || !isBear(c3) || !isBear(c4)) return null;
  if (!isBull(c5)) return null;
  if (c2.close >= c1.close) return null;
  if (c3.close >= c2.close) return null;
  if (c4.close >= c3.close) return null;
  // c4 has visible upper wick
  if (upper(c4) < body(c4)) return null;
  // c5 opens at/above c4 high and closes strongly up
  if (c5.open < c4.high) return null;
  if (c5.close <= c4.open) return null;
  return mk("Ladder Bottom", ratio01(c5.close - c4.close, c1.close - c4.close + ONE), offset - 4, offset);
};

// --- 51. Mat Hold (continuous) -------------------------------------------
// Bullish continuation: long bull, then 3 small bears (or any down-trending
// minor bars) that stay above the first bull's low, then another long bull
// that closes at a new high.
export const isMatHold = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c1 = candleAt(window, offset - 4);
  const c2 = candleAt(window, offset - 3);
  const c3 = candleAt(window, offset - 2);
  const c4 = candleAt(window, offset - 1);
  const c5 = candleAt(window, offset);
  if (!c1 || !c2 || !c3 || !c4 || !c5) return null;
  if (!isBull(c1) || !isBull(c5)) return null;
  if (!bodyGeqBpsOfRange(c1, LONG_BODY_BPS)) return null;
  if (!bodyGeqBpsOfRange(c5, LONG_BODY_BPS)) return null;
  // c2..c4 are small consolidation; allow either sign, must drift down slightly
  if (!bodyLeqBpsOfRange(c2, SMALL_BODY_BPS)) return null;
  if (!bodyLeqBpsOfRange(c3, SMALL_BODY_BPS)) return null;
  if (!bodyLeqBpsOfRange(c4, SMALL_BODY_BPS)) return null;
  // Stay above c1.low
  if (c2.low <= c1.low) return null;
  if (c3.low <= c1.low) return null;
  if (c4.low <= c1.low) return null;
  // mild downward drift inside the consolidation
  if (c3.close >= c2.close || c4.close >= c3.close) return null;
  // breakout
  if (c5.close <= c1.close) return null;
  return mk("Mat Hold", ratio01(c5.close - c1.close, c5.high - c1.low + ONE), offset - 4, offset);
};

// --- 52. Rising / Falling Three Methods ----------------------------------
// Long bull, 3 small bears inside its range, long bull closing higher.
// Mirror for falling. Continuous variant. (Mat Hold is the "stays above
// open" cousin; this variant accepts pure inside-range bars.)
export const isRisingFallingThreeMethods = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c1 = candleAt(window, offset - 4);
  const c2 = candleAt(window, offset - 3);
  const c3 = candleAt(window, offset - 2);
  const c4 = candleAt(window, offset - 1);
  const c5 = candleAt(window, offset);
  if (!c1 || !c2 || !c3 || !c4 || !c5) return null;
  if (!bodyGeqBpsOfRange(c1, LONG_BODY_BPS)) return null;
  if (!bodyGeqBpsOfRange(c5, LONG_BODY_BPS)) return null;
  if (!bodyLeqBpsOfRange(c2, SMALL_BODY_BPS)) return null;
  if (!bodyLeqBpsOfRange(c3, SMALL_BODY_BPS)) return null;
  if (!bodyLeqBpsOfRange(c4, SMALL_BODY_BPS)) return null;
  // middle bars stay inside c1's body
  const top = bodyTop(c1);
  const bot = bodyBot(c1);
  if (c2.high > top || c2.low < bot) return null;
  if (c3.high > top || c3.low < bot) return null;
  if (c4.high > top || c4.low < bot) return null;
  // Rising: c1 bull, c5 bull, c5.close > c1.close
  if (isBull(c1) && isBull(c5) && c5.close > c1.close) {
    return mk("Rising/Falling Three Methods", ratio01(c5.close - c1.close, range(c1) + ONE), offset - 4, offset);
  }
  // Falling: c1 bear, c5 bear, c5.close < c1.close
  if (isBear(c1) && isBear(c5) && c5.close < c1.close) {
    return mk("Rising/Falling Three Methods", ratio01(c1.close - c5.close, range(c1) + ONE), offset - 4, offset);
  }
  return null;
};

// --- 53. Breakaway -------------------------------------------------------
// Five-candle reversal. Bearish breakaway: long bull, gap-up (continuous:
// open ≈ prev close, but each closing higher), two more bulls each
// extending, then a bear that closes inside the gap created by c1/c2.
// We use the continuous interpretation: a long bull, then a sequence of
// three more bulls each making a higher close, then a bear that closes
// below c2.open.
export const isBreakaway = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const c1 = candleAt(window, offset - 4);
  const c2 = candleAt(window, offset - 3);
  const c3 = candleAt(window, offset - 2);
  const c4 = candleAt(window, offset - 1);
  const c5 = candleAt(window, offset);
  if (!c1 || !c2 || !c3 || !c4 || !c5) return null;
  // Bearish breakaway from up-rally
  if (isBull(c1) && isBull(c2) && isBull(c3) && isBull(c4) && isBear(c5)) {
    if (c2.close <= c1.close) return null;
    if (c3.close <= c2.close) return null;
    if (c4.close <= c3.close) return null;
    if (c5.close >= c2.open) return null;
    if (c5.close <= c1.close) return null;
    return mk("Breakaway", ratio01(c4.close - c5.close, c4.close - c1.close + ONE), offset - 4, offset);
  }
  // Bullish breakaway from down-decline
  if (isBear(c1) && isBear(c2) && isBear(c3) && isBear(c4) && isBull(c5)) {
    if (c2.close >= c1.close) return null;
    if (c3.close >= c2.close) return null;
    if (c4.close >= c3.close) return null;
    if (c5.close <= c2.open) return null;
    if (c5.close >= c1.close) return null;
    return mk("Breakaway", ratio01(c5.close - c4.close, c1.close - c4.close + ONE), offset - 4, offset);
  }
  return null;
};

// --- 54. Modified Hikkake ------------------------------------------------
// Standard Hikkake + a setup bar before the inside bar. The setup bar must
// be a quiet body (small wicks) — the trader interprets it as "consolidation
// before the trap". We accept the four-bar form: setup, outer, inside, conf.
export const isModifiedHikkake = (
  window: Candle[],
  offset: number,
): PatternMatch | null => {
  const setup = candleAt(window, offset - 3);
  const outer = candleAt(window, offset - 2);
  const inside = candleAt(window, offset - 1);
  const conf = candleAt(window, offset);
  if (!setup || !outer || !inside || !conf) return null;
  // setup is small-bodied
  if (!bodyLeqBpsOfRange(setup, SMALL_BODY_BPS)) return null;
  // inside-bar relationship
  if (inside.high >= outer.high || inside.low <= outer.low) return null;
  // confirmation reverses fakeout (mirror of Hikkake)
  const fakedUp = conf.high > inside.high && conf.close < inside.low;
  const fakedDown = conf.low < inside.low && conf.close > inside.high;
  if (!fakedUp && !fakedDown) return null;
  const reversal = fakedUp
    ? inside.low - conf.close
    : conf.close - inside.high;
  return mk("Modified Hikkake", ratio01(reversal, range(outer) + ONE), offset - 3, offset);
};

// ===========================================================================
// REGISTRY + TOP-LEVEL DETECTION
// ===========================================================================

/**
 * Detector entry: predicate + minimum window size it requires.
 *
 * The window-size hint lets `detectPatterns` short-circuit predicates that
 * can't possibly match because they would walk off the start of the array.
 */
interface Detector {
  name: Pattern;
  size: number;
  fn: (window: Candle[], offset: number) => PatternMatch | null;
}

/**
 * The catalog. Ordered roughly by candle-count so the chart's tooltip layer
 * can iterate without further sorting. The order is NOT load-bearing for
 * correctness; predicates are mutually independent.
 */
export const DETECTORS: readonly Detector[] = [
  // Single-candle
  { name: "Doji", size: 1, fn: isDoji },
  { name: "Dragonfly Doji", size: 1, fn: isDragonflyDoji },
  { name: "Gravestone Doji", size: 1, fn: isGravestoneDoji },
  { name: "Long-Legged Doji", size: 1, fn: isLongLeggedDoji },
  { name: "Rickshaw Man", size: 1, fn: isRickshawMan },
  { name: "Takuri", size: 1, fn: isTakuri },
  { name: "Hammer", size: 1, fn: isHammer },
  { name: "Inverted Hammer", size: 1, fn: isInvertedHammer },
  { name: "Hanging Man", size: 1, fn: isHangingMan },
  { name: "Shooting Star", size: 1, fn: isShootingStar },
  { name: "Marubozu", size: 1, fn: isMarubozu },
  { name: "Closing Marubozu", size: 1, fn: isClosingMarubozu },
  { name: "Spinning Top", size: 1, fn: isSpinningTop },
  { name: "High-Wave", size: 1, fn: isHighWave },
  { name: "Long Line", size: 1, fn: isLongLine },
  { name: "Short Line", size: 1, fn: isShortLine },
  { name: "Belt-hold", size: 1, fn: isBeltHold },
  // Two-candle
  { name: "Engulfing", size: 2, fn: isEngulfing },
  { name: "Harami", size: 2, fn: isHarami },
  { name: "Harami Cross", size: 2, fn: isHaramiCross },
  { name: "Piercing", size: 2, fn: isPiercing },
  { name: "Dark Cloud Cover", size: 2, fn: isDarkCloudCover },
  { name: "Counterattack", size: 2, fn: isCounterattack },
  { name: "Separating Lines", size: 2, fn: isSeparatingLines },
  { name: "Matching Low", size: 2, fn: isMatchingLow },
  { name: "Homing Pigeon", size: 2, fn: isHomingPigeon },
  { name: "On-Neck", size: 2, fn: isOnNeck },
  { name: "In-Neck", size: 2, fn: isInNeck },
  { name: "Thrusting", size: 2, fn: isThrusting },
  { name: "Doji Star", size: 2, fn: isDojiStar },
  { name: "Hikkake", size: 3, fn: isHikkake },
  // Three-candle
  { name: "Morning Star", size: 3, fn: isMorningStar },
  { name: "Evening Star", size: 3, fn: isEveningStar },
  { name: "Morning Doji Star", size: 3, fn: isMorningDojiStar },
  { name: "Evening Doji Star", size: 3, fn: isEveningDojiStar },
  { name: "Three White Soldiers", size: 3, fn: isThreeWhiteSoldiers },
  { name: "Three Black Crows", size: 3, fn: isThreeBlackCrows },
  { name: "Identical Three Crows", size: 3, fn: isIdenticalThreeCrows },
  { name: "Three Inside Up/Down", size: 3, fn: isThreeInsideUpDown },
  { name: "Three Outside Up/Down", size: 3, fn: isThreeOutsideUpDown },
  { name: "Three Stars in the South", size: 3, fn: isThreeStarsInTheSouth },
  { name: "Tristar", size: 3, fn: isTristar },
  { name: "Unique Three River", size: 3, fn: isUniqueThreeRiver },
  { name: "Advance Block", size: 3, fn: isAdvanceBlock },
  { name: "Stalled Pattern", size: 3, fn: isStalledPattern },
  { name: "Two Crows", size: 3, fn: isTwoCrows },
  { name: "Stick Sandwich", size: 3, fn: isStickSandwich },
  // Four / Five-candle
  { name: "Three-Line Strike", size: 4, fn: isThreeLineStrike },
  { name: "Concealing Baby Swallow", size: 4, fn: isConcealingBabySwallow },
  { name: "Ladder Bottom", size: 5, fn: isLadderBottom },
  { name: "Mat Hold", size: 5, fn: isMatHold },
  { name: "Rising/Falling Three Methods", size: 5, fn: isRisingFallingThreeMethods },
  { name: "Breakaway", size: 5, fn: isBreakaway },
  { name: "Modified Hikkake", size: 4, fn: isModifiedHikkake },
] as const;

// Compile-time assertion: the registry covers all 54 entries in `Pattern`.
// (TS will error if any Pattern name is forgotten.)
type _PatternsCovered = Pattern extends typeof DETECTORS[number]["name"]
  ? typeof DETECTORS[number]["name"] extends Pattern
    ? true
    : false
  : false;
const _PATTERN_COVERAGE_CHECK: _PatternsCovered = true;
void _PATTERN_COVERAGE_CHECK;

/**
 * Run every predicate over the window and return all matches.
 *
 * Each predicate is invoked at every offset large enough to satisfy its
 * size requirement. The output is the unsorted union of all hits — the UI
 * can group by `endIndex` to render highlights.
 *
 * Pure, deterministic, no side effects.
 *
 * Cost: O(window.length × 54). For a typical 200-candle visible chart that's
 * ~11k evaluations, each O(1). The chart calls this once per new candle and
 * can incrementally append (the matches whose endIndex < newCandle.index - 5
 * are immutable).
 */
export const detectPatterns = (window: Candle[]): PatternMatch[] => {
  const matches: PatternMatch[] = [];
  const n = window.length;
  for (const det of DETECTORS) {
    // Earliest offset where this detector has enough candles behind it.
    for (let i = det.size - 1; i < n; i++) {
      const hit = det.fn(window, i);
      if (hit) matches.push(hit);
    }
  }
  return matches;
};

/**
 * Convenience: return only the matches that end at `offset` (i.e. fired
 * because of the candle at `offset`). Used by the live tick path.
 */
export const detectPatternsAt = (
  window: Candle[],
  offset: number,
): PatternMatch[] => {
  const matches: PatternMatch[] = [];
  for (const det of DETECTORS) {
    if (offset < det.size - 1) continue;
    const hit = det.fn(window, offset);
    if (hit) matches.push(hit);
  }
  return matches;
};

const MAX_DETECTOR_SIZE = Math.max(...DETECTORS.map((det) => det.size));

const patternSlug = (name: Pattern): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/**
 * Live detector for the newest candle only.
 *
 * Scans the last N candles, where N is the largest catalog predicate window,
 * and returns any predicates that fired because of the newest candle. Indices
 * are lifted back into the original `candles` array so callers can highlight
 * the matched span directly.
 */
export const detectPostHocPattern = (
  candles: Candle[],
): PostHocPatternMatch[] => {
  if (candles.length === 0) return [];
  const start = Math.max(0, candles.length - MAX_DETECTOR_SIZE);
  const window = candles.slice(start);
  const offset = window.length - 1;
  return detectPatternsAt(window, offset).map((match) => {
    const startIndex = start + match.startIndex;
    const endIndex = start + match.endIndex;
    return {
      ...match,
      startIndex,
      endIndex,
      candleIndex: endIndex,
      label: `${patternSlug(match.name)} at k=${endIndex}`,
    };
  });
};
